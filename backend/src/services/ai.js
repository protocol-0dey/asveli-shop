'use strict';
/* AI layer. One small interface, four providers (chosen at runtime in the admin: AI → Подключения, or by env):
     mock    deterministic and offline: demo mode and tests; every output is marked as such in the UI
     gemini  Google Gemini API: one call reads the product photo + evidence and returns the card JSON; embeddings; image generation/editing
     openai  OpenAI or any OpenAI-compatible server (set a base URL: vLLM, llama-server, OpenRouter, Ollama /v1)
     ollama  native Ollama API
   Rules that do not depend on the provider:
   - endpoints and keys come from the server's settings/env only (a request can never point the server at a URL: no SSRF);
   - the model may not self-certify: confidence is capped by how complete the INPUT is, and every fact must cite an evidence
     item we supplied (a photo counts as evidence of type 'vision'). A fact that cites something else is dropped (anti-hallucination);
   - output is plain text, length-capped, control characters stripped; the UI renders it with textContent only;
   - every call is counted (quota per day) and logged to m_ai_calls for the monitoring page. */
const crypto = require('crypto');
const { ai: cfg } = require('../config');
const { db } = require('../db');
const { E, HttpError } = require('../engine/errors');
const { clean } = require('../engine/fields');

db.exec(`
CREATE TABLE IF NOT EXISTS m_ai_calls(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS ix_ai_calls_ts ON m_ai_calls(ts);
CREATE TABLE IF NOT EXISTS m_embeddings(product_id INTEGER PRIMARY KEY, hash TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, updated_at INTEGER NOT NULL);`);

const DAY = 864e5;
// card languages the shop can translate into (ISO 639-1 → name the model understands)
const LANGS = { en: 'English', pl: 'Polish', de: 'German', ru: 'Russian', uk: 'Ukrainian', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', cs: 'Czech', sk: 'Slovak',
  lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', ro: 'Romanian', hu: 'Hungarian', bg: 'Bulgarian', hr: 'Croatian', sl: 'Slovenian', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', el: 'Greek', tr: 'Turkish', ja: 'Japanese', zh: 'Chinese (Simplified)', ko: 'Korean', ar: 'Arabic' };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const txt = (v, max) => (typeof v === 'string' ? clean(v).slice(0, max) : '');
const isMock = () => cfg.provider === 'mock';

/* ---------- quota + usage log ---------- */
function usageToday() { return db.prepare('SELECT COUNT(*) c FROM m_ai_calls WHERE ts>?').get(Date.now() - DAY).c; }
let inflight = 0;                    // calls started but not yet logged: concurrent workers must not all slip under the limit
function reserve() { if (usageToday() + inflight >= cfg.dailyLimit) throw new HttpError(429, 'ai_quota'); inflight++; }
async function tracked(kind, fn) {
  needConfigured();
  reserve();
  const t0 = Date.now();
  try { const r = await fn(); db.prepare('INSERT INTO m_ai_calls(ts,kind,provider,ok,ms) VALUES(?,?,?,1,?)').run(Date.now(), kind, cfg.provider, Date.now() - t0); return r; }
  catch (e) { db.prepare('INSERT INTO m_ai_calls(ts,kind,provider,ok,ms,note) VALUES(?,?,?,0,?,?)').run(Date.now(), kind, cfg.provider, Date.now() - t0, String(e.message).slice(0, 120)); throw e instanceof HttpError ? e : new HttpError(502, 'ai_failed'); }
  finally { inflight--; }
}

/* ---------- HTTP to the configured provider ---------- */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com', OPENAI_BASE = 'https://api.openai.com/v1';
const base = () => cfg.baseUrl || (cfg.provider === 'gemini' ? GEMINI_BASE : cfg.provider === 'openai' ? OPENAI_BASE : '');
const configured = () => isMock() || (cfg.provider === 'gemini' ? !!cfg.apiKey : cfg.provider === 'openai' ? !!(cfg.apiKey || cfg.baseUrl) : !!cfg.baseUrl);
const needConfigured = () => { if (!configured()) throw new HttpError(503, 'ai_not_configured'); };
const catalog = require('./ai-catalog');
const svc = () => catalog.serviceOf(cfg) || {};
const authHeaders = () => ({ ...(!cfg.apiKey ? {} : cfg.provider === 'gemini' ? { 'x-goog-api-key': cfg.apiKey } : { Authorization: 'Bearer ' + cfg.apiKey }),
  ...(svc().id === 'openrouter' ? { 'X-Title': 'Asveli Admin' } : {}) });
const redact = m => String(m).split(cfg.apiKey || '\u0000').join('***').slice(0, 200);
async function post(path, body) {
  const res = await fetch(base() + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body)
  });
  const text = await res.text();
  if (text.length > 16e6) throw new Error('ai_response_too_large');
  if (!res.ok) { let d = ''; try { const e = JSON.parse(text).error; d = typeof e === 'string' ? e : (e?.message || ''); } catch { /* not json */ } throw Object.assign(new Error('ai_http_' + res.status), { detail: redact(d) }); }
  try { return JSON.parse(text); } catch { throw new Error('ai_bad_json'); }
}
const extractJson = s => { try { return JSON.parse(s); } catch { /* model wrapped it in prose/fences */ } const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) throw new Error('ai_bad_json'); return JSON.parse(s.slice(a, b + 1)); };
const geminiPath = (model, method) => `/v1beta/models/${encodeURIComponent(model)}:${method}`;
function geminiText(r) {
  if (r.promptFeedback?.blockReason) throw new Error('ai_blocked');
  const parts = r.candidates?.[0]?.content?.parts || [];
  return parts.map(x => (typeof x.text === 'string' ? x.text : '')).join('');
}

// `photo` = { mime, b64 } of the product picture: the model reads it together with the evidence in the SAME call.
async function chatJson(system, user, { photo = null } = {}) {
  if (cfg.provider === 'gemini') {
    const parts = [{ text: user }]; if (photo) parts.push({ inlineData: { mimeType: photo.mime, data: photo.b64 } });
    const r = await post(geminiPath(cfg.model, 'generateContent'), { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
    return extractJson(geminiText(r));
  }
  if (cfg.provider === 'openai') {
    const content = photo ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:${photo.mime};base64,${photo.b64}` } }] : user;
    const body = { model: cfg.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
    let r;
    if (svc().noJsonMode) r = await post('/chat/completions', body);
    else {
      try { r = await post('/chat/completions', { ...body, response_format: { type: 'json_object' } }); }
      catch (e) { if (e.message !== 'ai_http_400' && e.message !== 'ai_http_422') throw e; r = await post('/chat/completions', body); }   // some models reject JSON mode: ask in plain text, parse the JSON out
    }
    return extractJson(String(r.choices?.[0]?.message?.content ?? ''));
  }
  const r = await post('/api/chat', { model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user, ...(photo ? { images: [photo.b64] } : {}) }] });
  return extractJson(String(r.message?.content ?? ''));
}
const GEMINI_DIM = 768;                 // gemini-embedding-001 can truncate its vectors; 768 keeps the index small, quality loss is negligible for catalogue search

/* ---------- embeddings ---------- */
const DIM = 256;
const tokens = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
function mockEmbed(text) {            // hashed words + character trigrams: crude, but related word forms land close together
  const v = new Float32Array(DIM);
  for (const w of tokens(text)) {
    const grams = [w, ...(w.length > 3 ? Array.from({ length: w.length - 2 }, (_, i) => w.slice(i, i + 3)) : [])];
    for (const g of grams) { const h = crypto.createHash('md5').update(g).digest(); v[h.readUInt16BE(0) % DIM] += (h[2] & 1 ? 1 : -1) * (g === w ? 1.5 : 1); }
  }
  return norm(v);
}
function norm(v) { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / s); }
const localEmbed = () => isMock() || cfg.embedModel === 'local' || !cfg.embedModel;
const embedName = () => (localEmbed() ? 'mock-hash-256' : cfg.embedModel);
async function embed(texts, { query = false } = {}) {
  if (localEmbed()) return texts.map(mockEmbed);   // built-in index: providers without an embeddings API still get semantic search
  let r;
  if (cfg.provider === 'gemini') {
    r = [];
    for (let i = 0; i < texts.length; i += 100) {           // batchEmbedContents accepts at most 100 items
      const chunk = texts.slice(i, i + 100);
      const out = await post(geminiPath(cfg.embedModel, 'batchEmbedContents'), { requests: chunk.map(t => ({ model: 'models/' + cfg.embedModel, content: { parts: [{ text: t }] }, taskType: query ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: GEMINI_DIM })) });
      for (const e of out.embeddings || []) r.push(e.values);
    }
  } else r = cfg.provider === 'openai' ? (await post('/embeddings', { model: cfg.embedModel, input: texts })).data.map(d => d.embedding)
    : (await post('/api/embed', { model: cfg.embedModel, input: texts })).embeddings;
  if (!Array.isArray(r) || r.length !== texts.length || r.some(v => !Array.isArray(v) || !v.length)) throw new Error('ai_bad_embeddings');
  return r.map(a => norm(Float32Array.from(a)));
}

const productText = p => [p.title, p.brand, p.category, p.seo_description || p.description].filter(Boolean).join(' | ').slice(0, 2000);

// Delta indexing: only products whose content hash changed are embedded; batches are length-sorted to minimise padding.
async function indexProducts({ ids = null, batch = 64 } = {}) {
  const rows = ids ? db.prepare(`SELECT * FROM m_products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : db.prepare('SELECT * FROM m_products').all();
  const have = new Map(db.prepare('SELECT product_id, hash, model FROM m_embeddings').all().map(r => [r.product_id, r]));
  const model = embedName();
  const todo = rows.map(p => ({ id: p.id, text: productText(p) })).map(x => ({ ...x, hash: sha(model + '|' + x.text) }))
    .filter(x => !have.get(x.id) || have.get(x.id).hash !== x.hash).sort((a, b) => a.text.length - b.text.length);
  const up = db.prepare('INSERT INTO m_embeddings(product_id,hash,model,dim,vec,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET hash=excluded.hash, model=excluded.model, dim=excluded.dim, vec=excluded.vec, updated_at=excluded.updated_at');
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const vecs = await tracked('embed', () => embed(part.map(x => x.text)));
    db.transaction(() => part.forEach((x, j) => up.run(x.id, x.hash, model, vecs[j].length, Buffer.from(vecs[j].buffer), Date.now())))();
  }
  return { indexed: todo.length, skipped: rows.length - todo.length, model };
}

// Hybrid search: dense cosine + lexical overlap, fused by reciprocal rank. An exact SKU/barcode hit always ranks first
// (vector search is bad at part numbers).
async function search(q, { limit = 20, onlyApproved = false } = {}) {
  q = txt(q, 200); if (!q) return [];
  const model = embedName();
  const [qv] = await tracked('search', () => embed([q], { query: true }));
  const prods = new Map(db.prepare(`SELECT id, sku, barcode, title, brand, category, price, status, human_verified, description, seo_description FROM m_products${onlyApproved ? " WHERE status='approved'" : ''}`).all().map(p => [p.id, p]));
  const dense = [];
  for (const r of db.prepare('SELECT product_id, dim, vec FROM m_embeddings WHERE model=?').all(model)) {
    if (!prods.has(r.product_id) || r.dim !== qv.length) continue;
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim); let s = 0; for (let i = 0; i < r.dim; i++) s += v[i] * qv[i];
    dense.push([r.product_id, s]);
  }
  dense.sort((a, b) => b[1] - a[1]);
  const qt = new Set(tokens(q)); const lex = [];
  for (const p of prods.values()) {
    const pt = tokens(productText(p)); if (!pt.length) continue;
    let hit = 0; for (const t of pt) if (qt.has(t)) hit++;
    if (hit) lex.push([p.id, hit / Math.sqrt(pt.length)]);
  }
  lex.sort((a, b) => b[1] - a[1]);
  const fused = new Map(), add = (list, w) => list.slice(0, 200).forEach(([id], i) => fused.set(id, (fused.get(id) || 0) + w / (60 + i + 1)));
  add(dense, 1); add(lex, 1);
  const exact = new Set([...prods.values()].filter(p => p.sku.toLowerCase() === q.toLowerCase() || (p.barcode && p.barcode === q)).map(p => p.id));
  for (const id of exact) fused.set(id, 1);
  const dmap = new Map(dense);
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(limit, 50)).map(([id, score]) => {
    const p = prods.get(id); return { id, sku: p.sku, title: p.title, brand: p.brand, category: p.category, price: p.price, status: p.status, human_verified: p.human_verified, score: Math.round(score * 1e4) / 1e4, similarity: dmap.has(id) ? Math.round(dmap.get(id) * 1000) / 1000 : null, exact: exact.has(id) };
  });
}

/* ---------- card generation ---------- */
const PRODUCT_FACTS = [['brand', 'Бренд'], ['category', 'Категория'], ['weight_g', 'Вес, г'], ['hs_code', 'HS-код'], ['origin_country', 'Страна происхождения'], ['barcode', 'Штрихкод']];
function parseSources(p) { try { const a = JSON.parse(p.data_sources || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
const external = p => parseSources(p).filter(s => s && s.source_type !== 'manual');

// Everything the model is allowed to cite. A fact must point at one of these by index.
function evidenceOf(p) {
  const ev = [];
  for (const [k, label] of PRODUCT_FACTS) if (p[k] != null && p[k] !== '') ev.push({ text: `${label}: ${p[k]}`, source_type: 'manual', source_ref: 'field:' + k });
  if (p.description) ev.push({ text: txt(p.description, 300), source_type: 'manual', source_ref: 'field:description' });
  for (const s of parseSources(p)) if (s && typeof s.fact === 'string') ev.push({ text: txt(s.fact, 300), source_type: s.source_type, source_ref: s.source_ref || s.source_url || null });
  return ev;
}
// 0..100: how much solid input we have. The confidence of a card can never exceed this.
function completeness(p) {
  let c = 10;
  if (p.category) c += 5; if (p.brand) c += 15;
  if (p.description) c += p.description.length >= 150 ? 30 : p.description.length >= 40 ? 20 : 8;
  try { if (JSON.parse(p.images || '[]').length) c += 10; } catch { /* none */ }
  if (p.barcode) c += 10; if (p.weight_g && p.weight_g !== 500) c += 5; if (p.hs_code || p.origin_country) c += 5;
  c += Math.min(external(p).length * 10, 20);
  return Math.min(c, 100);
}

const TONES = { neutral: 'ясный и деловой', premium: 'премиальный минимализм', sport: 'энергичный, драйвовый', friendly: 'тёплый и дружелюбный' };
function mockCard(p, brand, ev) {
  const tone = brand?.tone || 'neutral', lead = { premium: 'Сдержанный дизайн, внимание к деталям.', sport: 'Создан для движения и нагрузок.', friendly: 'Удобная вещь на каждый день.', neutral: 'Практичный выбор для повседневного использования.' }[tone] || '';
  const bullets = ev.filter(e => e.source_type !== 'manual' || /^field:(brand|category|hs_code|origin_country|weight_g)/.test(e.source_ref)).slice(0, 5).map(e => e.text);
  const body = txt(p.description, 600) || `${p.title}${p.brand ? ' от ' + p.brand : ''}.`;
  return { title: txt(p.title, 120), seo_description: `${lead} ${body}`.trim(), bullets, keywords: [...new Set(tokens([p.title, p.brand, p.category].join(' ')))].slice(0, 8), facts: ev.map((e, i) => ({ text: e.text, source_index: i })), confidence: 100 };
}

const SYSTEM = (brand) => `Ты редактор карточек интернет-магазина. Отвечай ТОЛЬКО JSON вида {"title": str, "seo_description": str, "bullets": [str], "keywords": [str], "facts": [{"text": str, "source_index": int}], "confidence": 0-100}.
Правила: используй только факты из списка evidence; каждый факт в "facts" обязан ссылаться на source_index из evidence; ничего не выдумывай (размеры, материалы, сертификаты, которых нет в evidence). Язык — русский.
Если приложено фото, оно тоже считается источником: факты о нём ссылайся на пункт evidence с пометкой «Фото товара».
Тон: ${TONES[brand?.tone] || TONES.neutral}.${brand?.banned_words ? ' Запрещённые слова: ' + brand.banned_words + '.' : ''}`;

function validateCard(o, ev, p, brand) {
  if (!o || typeof o !== 'object') throw new Error('ai_bad_card');
  const flags = [];
  const title = txt(o.title, 120) || txt(p.title, 120);
  const seo = txt(o.seo_description, 2000); if (!seo) throw new Error('ai_bad_card');
  const bullets = (Array.isArray(o.bullets) ? o.bullets : []).map(b => txt(b, 140)).filter(Boolean).slice(0, 6);
  const keywords = (Array.isArray(o.keywords) ? o.keywords : []).map(k => txt(k, 40)).filter(Boolean).slice(0, 12);
  const sources = []; let dropped = 0;
  for (const f of (Array.isArray(o.facts) ? o.facts : []).slice(0, 30)) {
    const e = Number.isInteger(f?.source_index) ? ev[f.source_index] : null, t = txt(f?.text, 300);
    if (!e || !t) { dropped++; continue; }
    sources.push({ fact: t, source_type: e.source_type, source_ref: e.source_ref });
  }
  if (dropped) flags.push(`unsupported_facts:${dropped}`);
  if (!sources.length) flags.push('no_sources');
  let conf = Math.max(0, Math.min(100, Math.round(Number(o.confidence)))); if (!Number.isFinite(conf)) conf = 0;
  conf = Math.min(conf, completeness(p)) - dropped * 10 - (sources.length ? 0 : 20);
  const banned = String(brand?.banned_words || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const hay = (title + ' ' + seo + ' ' + bullets.join(' ')).toLowerCase();
  const hit = banned.filter(w => hay.includes(w)); if (hit.length) { flags.push('banned_words:' + hit.join('|').slice(0, 60)); conf = Math.min(conf, 60); }
  return { title, seo_description: seo, bullets, keywords, data_sources: sources, confidence: Math.max(0, Math.min(100, conf)), flags };
}

async function generateCard(p, { brand = null, note = null } = {}) {
  const ev = evidenceOf(p);
  const photo = !isMock() && cfg.provider !== 'ollama' ? await photoOf(p).catch(() => null) : null;
  if (photo) ev.push({ text: 'Фото товара приложено к запросу: опиши только то, что на нём действительно видно (цвет, форма, материал, комплектация)', source_type: 'vision', source_ref: 'image:' + photo.ref });
  const raw = await tracked('card', async () => isMock() ? mockCard(p, brand, ev)
    : chatJson(SYSTEM(brand), JSON.stringify({ product: { title: p.title, brand: p.brand, category: p.category }, evidence: ev.map((e, i) => ({ source_index: i, text: e.text })), editor_note: note ? txt(note, 300) : undefined }), { photo }));
  let card; try { card = validateCard(raw, ev, p, brand); } catch { throw new HttpError(502, 'ai_failed'); }      // garbage from the model is a provider failure, not a server bug
  card.mock = isMock();
  return card;
}

async function localize(p, lang) {
  const names = LANGS; if (!names[lang]) throw E.bad('invalid_lang');
  const src = { title: p.title, description: p.seo_description || p.description || '' };
  const r = await tracked('localize', async () => isMock() ? { title: `[${lang.toUpperCase()}·mock] ${src.title}`, description: `[${lang.toUpperCase()}·mock] ${src.description}` }
    : chatJson(`Translate and localise the online-shop product card into ${names[lang]}. Rewrite for local search habits and units; do not add facts. Reply ONLY JSON {"title": str, "description": str}.`, JSON.stringify(src)));
  const title = txt(r?.title, 200), description = txt(r?.description, 4000); if (!title) throw new HttpError(502, 'ai_failed');
  return { title, description, mock: isMock() };
}

/* ---------- canvas images ---------- */
function mockSvg(prompt) {      // abstract, text-free, derived from a hash of the prompt: no user text ever enters the markup
  const h = crypto.createHash('sha256').update(prompt).digest(); const hue = h[0] * 360 / 255 | 0;
  const shapes = Array.from({ length: 5 }, (_, i) => { const x = 20 + h[1 + i * 3] % 200, y = 30 + h[2 + i * 3] % 260, r = 18 + h[3 + i * 3] % 70, o = (0.25 + (h[4 + i] % 50) / 100).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${(hue + i * 37) % 360} 70% ${45 + i * 6}%)" opacity="${o}"/>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 18%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 32%)"/></linearGradient></defs><rect width="240" height="300" fill="url(#g)"/>${shapes}</svg>`;
}
const IMG_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const magicOk = (buf, mime) => IMG_TYPES[mime] && IMG_TYPES[mime].every((b, i) => buf[i] === b);
// A generated picture is stored like any uploaded file (private, in the configured storage) and referenced by id: results stay small.
async function saveGenerated(buf, mime) {
  if (!buf.length || buf.length > 12 * 1024 * 1024 || !magicOk(buf, mime)) throw new Error('ai_bad_image');
  const { Readable } = require('stream'), sec = require('../security');
  const { key, size } = await require('../storage')().put(Readable.from([buf]), { maxBytes: 12 * 1024 * 1024 });
  const id = crypto.randomBytes(16).toString('hex'), ext = mime.split('/')[1];
  db.prepare('INSERT INTO files(id,name,mime,size,storage_key,is_public,public_slug,share_nonce,uploaded_by,created_at,scope) VALUES(?,?,?,?,?,0,NULL,?,?,?,?)')
    .run(id, `ai-${id.slice(0, 8)}.${ext}`, mime, size, key, sec.token(12), 'ai', Date.now(), 'general');
  return id;
}
// ref = { mime, b64 }: an existing product photo to EDIT (cut out the background, relight …) instead of painting from scratch.
async function image(prompt, { ref = null } = {}) {
  prompt = txt(prompt, 1000);
  if (isMock() || cfg.provider === 'ollama') return tracked('image', async () => ({ kind: 'svg', data: mockSvg(prompt), mock: true }));
  return tracked('image', async () => {
    if (cfg.provider === 'gemini') {
      const parts = [{ text: prompt }]; if (ref) parts.push({ inlineData: { mimeType: ref.mime, data: ref.b64 } });
      const r = await post(geminiPath(cfg.imageModel, 'generateContent'), { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
      const p = (r.candidates?.[0]?.content?.parts || []).find(x => x.inlineData?.data);
      if (!p) throw new Error(r.promptFeedback?.blockReason ? 'ai_blocked' : 'ai_no_image');
      return { kind: 'file', data: await saveGenerated(Buffer.from(p.inlineData.data, 'base64'), p.inlineData.mimeType || 'image/png'), mock: false };
    }
    if (cfg.imageUrl) {                                                           // legacy: a separate OpenAI-style image endpoint from env
      const res = await fetch(cfg.imageUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs), headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ prompt, n: 1, size: '1024x1024' }) });
      if (!res.ok) throw new Error('ai_http_' + res.status);
      const url = (await res.json()).data?.[0]?.url;
      if (typeof url !== 'string' || !/^https:\/\/[^\s"'<>]{1,500}$/.test(url)) throw new Error('ai_bad_image');
      return { kind: 'url', data: url, mock: false };
    }
    const r = await post('/images/generations', { model: cfg.imageModel, prompt, n: 1, size: '1024x1024' });
    const b64 = r.data?.[0]?.b64_json; if (typeof b64 !== 'string') throw new Error('ai_no_image');
    return { kind: 'file', data: await saveGenerated(Buffer.from(b64, 'base64'), 'image/png'), mock: false };
  });
}

// The product's first picture, when it is one of OUR stored public files (never fetched from a URL: no SSRF). ≤ 4 MB, PNG/JPEG/WEBP.
async function photoOf(p) {
  let list = []; try { list = JSON.parse(p.images || '[]'); } catch { /* none */ }
  const m = (Array.isArray(list) ? list : []).map(u => /^\/f\/([A-Za-z0-9_-]{22})\//.exec(String(u))).find(Boolean); if (!m) return null;
  const f = db.prepare("SELECT * FROM files WHERE public_slug=? AND is_public=1 AND scope='general'").get(m[1]);
  if (!f || !IMG_TYPES[f.mime] || f.size > 4 * 1024 * 1024) return null;
  const chunks = []; const { stream } = await require('../storage')().get(f.storage_key);
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks); if (!magicOk(buf, f.mime)) return null;
  return { mime: f.mime, b64: buf.toString('base64'), ref: m[1] };
}

// "Проверить подключение": one tiny chat call and one embedding call with real timings. The real reason is shown to the operator
// (the key is redacted); each call still counts against the daily quota and is logged on the monitoring page.
async function probe() {
  const steps = [];
  const run = async (name, fn) => {
    const t0 = Date.now(); let inner = null;
    try { await tracked('test', async () => { try { return await fn(); } catch (e) { inner = e; throw e; } }); steps.push({ name, ok: true, ms: Date.now() - t0 }); }
    catch (e) { const x = inner || e; steps.push({ name, ok: false, ms: Date.now() - t0, error: String(x.code || x.message).slice(0, 80), detail: x.detail || null }); }
  };
  if (!configured()) return { ok: false, provider: cfg.provider, steps: [{ name: 'config', ok: false, ms: 0, error: 'ai_not_configured', detail: null }] };
  await run('chat', () => (isMock() ? true : chatJson('Reply ONLY with the JSON {"ok": true}.', 'ping')));
  await run('embeddings', () => embed(['ping']));
  return { ok: steps.every(x => x.ok), provider: cfg.provider, model: cfg.model, steps };
}

function stats() {
  const since = Date.now() - DAY;
  const by = db.prepare('SELECT kind, COUNT(*) calls, SUM(1-ok) failed, CAST(AVG(ms) AS INT) avg_ms FROM m_ai_calls WHERE ts>? GROUP BY kind').all(since);
  const recent = db.prepare('SELECT ts, kind, provider, ms, note FROM m_ai_calls WHERE ok=0 ORDER BY id DESC LIMIT 10').all();
  return { provider: cfg.provider, model: isMock() ? 'mock' : cfg.model, configured: configured(), has_key: !!cfg.apiKey, used_24h: usageToday(), limit: cfg.dailyLimit, by_kind: by, recent_errors: recent };
}

/* ---------- model lists (Подключения AI → «Выбрать модель») ---------- */
// For a catalog service the address is fixed; for Ollama / custom it is the saved, SSRF-checked base URL.
async function listModels(serviceId, key) {
  const s = catalog.byId(serviceId); if (!s) throw E.bad('invalid_service');
  if (s.models) return s.models.map(id => ({ id, free: s.id === 'github' }));
  const base = s.base ? s.base.replace(/\/+$/, '') : cfg.baseUrl; if (!base && s.kind !== 'mock') throw E.bad('base_url_required');
  if (s.kind === 'mock') return [{ id: 'mock', free: true }];
  const headers = s.kind === 'gemini' ? (key ? { 'x-goog-api-key': key } : {}) : key ? { Authorization: 'Bearer ' + key } : {};
  const url = s.kind === 'gemini' ? `${base}/v1beta/models?pageSize=200` : s.kind === 'ollama' ? `${base}/api/tags` : `${base}/models`;
  const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const t = await res.text(); if (t.length > 8e6) throw new Error('ai_response_too_large');
  if (!res.ok) { let d = ''; try { const e = JSON.parse(t).error; d = typeof e === 'string' ? e : e?.message || ''; } catch { /* not json */ } throw Object.assign(new HttpError(502, 'models_failed'), { extra: { detail: String(d).split(key || '\u0000').join('***').slice(0, 160) || 'HTTP ' + res.status } }); }
  let j; try { j = JSON.parse(t); } catch { throw new HttpError(502, 'models_failed'); }
  let out;
  if (s.kind === 'gemini') out = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName, free: true, vision: true }));
  else if (s.kind === 'ollama') out = (j.models || []).map(m => ({ id: m.name, free: true }));
  else out = (j.data || j.models || []).map(m => ({ id: m.id, label: m.name && m.name !== m.id ? m.name : undefined,
    free: (m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : false) || /:free$/.test(m.id) || undefined,
    vision: m.architecture ? (m.architecture.input_modalities || []).includes('image') : undefined, ctx: m.context_length || undefined }));
  return out.filter(m => typeof m.id === 'string' && /^[A-Za-z0-9._:\/-]{1,80}$/.test(m.id)).sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0) || a.id.localeCompare(b.id)).slice(0, 400);
}

/* ---------- web search (competitor prices) ---------- */
const searchCapable = () => !isMock() && !!svc().search && configured();
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
// one call with live web access; returns the model's text plus the pages the PROVIDER says it actually used
async function webJson(system, user) {
  const kind = svc().search;
  if (kind === 'gemini') {
    const r = await post(geminiPath(cfg.model, 'generateContent'), { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1 } });
    const g = r.candidates?.[0]?.groundingMetadata || {};
    const used = (g.groundingChunks || []).map(c => c.web || {}).map(w => ({ url: w.uri, domain: String(w.title || hostOf(w.uri)).toLowerCase().replace(/^www\./, '') }));
    return { json: extractJson(geminiText(r)), used };
  }
  const body = kind === 'openai' ? { model: cfg.searchModel || 'gpt-4o-mini-search-preview', web_search_options: {}, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
    : { model: /:online$/.test(cfg.model) ? cfg.model : cfg.model + ':online', temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const r = await post('/chat/completions', body);
  const m = r.choices?.[0]?.message || {};
  const used = (m.annotations || []).filter(a => a.type === 'url_citation' && a.url_citation).map(a => ({ url: a.url_citation.url, domain: hostOf(a.url_citation.url) }));
  return { json: extractJson(String(m.content ?? '')), used };
}
const PLATFORMS = ['Amazon', 'Allegro', 'eBay', 'AliExpress', 'Temu', 'Kaufland', 'Empik', 'Ceneo', 'Idealo', 'OLX', 'Etsy', 'Zalando', 'MediaMarkt', 'Otto', 'Cdiscount', 'Bol.com', 'Walmart'];
// Finds offers of the SAME product on other marketplaces. Every offer keeps its link; it counts as "verified" only when the
// provider reports that exact site among the pages it really opened (the model's own word is not enough).
async function competitorSearch(p, { platforms = PLATFORMS, country = null } = {}) {
  if (isMock()) return { offers: [], mock: true, note: 'demo_no_web' };
  if (!searchCapable()) throw new HttpError(409, 'ai_no_web_search');
  const ids = [p.brand && 'brand: ' + p.brand, p.barcode && 'EAN/GTIN: ' + p.barcode, p.external_id && 'supplier id: ' + p.external_id, p.model_slug && 'model: ' + p.model_slug].filter(Boolean).join('; ');
  const sys = 'You are a price analyst. Search the web NOW for current offers of exactly this product (same model; same size/capacity where it matters) on these marketplaces: ' + platforms.join(', ') +
    '. Prefer exact matches by EAN or model number. Never invent offers, prices or links: include only offers you actually saw on a page, with that page URL. Reply ONLY JSON {"offers":[{"platform":str,"title":str,"price":number,"currency":"ISO 4217","url":"https://…","seller":str|null,"in_stock":bool|null,"match":"exact"|"similar"}]} (max 15 offers, price incl. VAT, without shipping).';
  const user = JSON.stringify({ product: p.title, ids, category: p.category, our_price: p.price / 100, buyer_country: country || undefined });
  const { json, used } = await tracked('competitors', () => webJson(sys, user));
  const domains = new Set(used.map(u => u.domain).filter(Boolean)), urls = new Set(used.map(u => u.url));
  const offers = (Array.isArray(json?.offers) ? json.offers : []).slice(0, 15).map(o => {
    const url = typeof o.url === 'string' && /^https:\/\/[^\s"'<>]{4,500}$/.test(o.url) ? o.url : null, price = Number(o.price), cur = String(o.currency || '').toUpperCase();
    if (!url || !Number.isFinite(price) || price <= 0 || price > 1e7 || !/^[A-Z]{3}$/.test(cur)) return null;
    const h = hostOf(url), verified = urls.has(url) || [...domains].some(d => d && (h === d || h.endsWith('.' + d) || d.endsWith('.' + h)));
    return { platform: txt(o.platform, 40) || h, title: txt(o.title, 200), price: Math.round(price * 100), currency: cur, url, seller: txt(o.seller, 80) || null,
      in_stock: typeof o.in_stock === 'boolean' ? o.in_stock : null, match: o.match === 'exact' ? 'exact' : 'similar', verified };
  }).filter(Boolean);
  return { offers, mock: false, sources: used.length };
}

/* ---------- product analysis: description + price + story ---------- */
// price suggestion = rules first (never below cost + minimum margin; competitors' verified exact offers in OUR currency), the model only reasons inside them
async function analyze(p, { offers = [], currency = 'PLN', minMarginPct = 10, brand = null } = {}) {
  const ev = evidenceOf(p);
  const comp = offers.filter(o => o.verified && o.match === 'exact' && o.currency === currency).map(o => o.price).sort((a, b) => a - b);
  const median = comp.length ? comp[Math.floor((comp.length - 1) / 2)] : null;
  const floor = p.cost != null ? Math.round(p.cost * (100 + minMarginPct) / 100) : null;
  const basis = { cost: p.cost ?? null, markup_pct: p.markup_pct ?? null, competitor_median: median, competitor_min: comp[0] ?? null, offers_used: comp.length, floor };
  let r;
  if (isMock()) {
    const target = median ? Math.round(median * 0.98) : p.cost != null ? Math.round(p.cost * (100 + (p.markup_pct ?? 35)) / 100) : p.price;
    r = { description: `${txt(p.title, 120)}${p.brand ? ' от ' + p.brand : ''}. ${txt(p.description || p.seo_description || '', 500)}`.trim(),
      story: `[демо] История товара появится, когда подключите AI-модель. Сейчас текст собран из полей карточки.`, bullets: ev.slice(0, 4).map(e => e.text),
      price: target, reasoning: median ? 'чуть ниже медианы проверенных цен конкурентов' : p.cost != null ? 'закупка + наценка' : 'текущая цена (нет данных о закупке и конкурентах)' };
  } else {
    const sys = `Ты аналитик и редактор интернет-магазина. По фактам из evidence (и только по ним) подготовь: "description" — продающее описание 600–1200 знаков; "story" — короткую историю товара для страницы (кому и для чего он, как им пользуются), 300–600 знаков;
"bullets" — 3–6 преимуществ; "price" — рекомендуемая цена в ${currency} (число) и "reasoning" — 1–2 предложения почему. Ничего не выдумывай: без несуществующих сертификатов, наград, истории бренда, гарантий и сравнений «лучший/№1». Если фактов мало — пиши короче.
Ответ ТОЛЬКО JSON {"description": str, "story": str, "bullets": [str], "price": number, "reasoning": str}.${brand?.tone ? ' Тон: ' + (TONES[brand.tone] || TONES.neutral) + '.' : ''}${brand?.banned_words ? ' Запрещённые слова: ' + brand.banned_words + '.' : ''}`;
    const user = JSON.stringify({ product: { title: p.title, brand: p.brand, category: p.category, current_price: p.price / 100 }, evidence: ev.map(e => e.text),
      pricing: { cost: basis.cost != null ? basis.cost / 100 : null, wanted_markup_pct: basis.markup_pct, competitor_median: median != null ? median / 100 : null, competitor_min: basis.competitor_min != null ? basis.competitor_min / 100 : null, competitor_offers: comp.length, never_below: floor != null ? floor / 100 : null } });
    const photo = cfg.provider !== 'ollama' ? await photoOf(p).catch(() => null) : null;
    const o = await tracked('analyze', () => chatJson(sys, user, { photo }));
    r = { description: txt(o?.description, 3000), story: txt(o?.story, 1500), bullets: (Array.isArray(o?.bullets) ? o.bullets : []).map(b => txt(b, 160)).filter(Boolean).slice(0, 6),
      price: Math.round(Number(o?.price) * 100), reasoning: txt(o?.reasoning, 400) };
    if (!r.description) throw new HttpError(502, 'ai_failed');
  }
  const flags = [];
  if (!Number.isFinite(r.price) || r.price <= 0) { r.price = p.price; flags.push('no_price_suggestion'); }
  if (floor != null && r.price < floor) { r.price = floor; flags.push('raised_to_floor'); }          // never below cost + minimum margin
  if (median && r.price > median * 1.5) flags.push('far_above_competitors');
  return { description: r.description, story: r.story, bullets: r.bullets, price: { suggested: r.price, current: p.price, reasoning: r.reasoning, basis }, flags, mock: isMock() };
}

/* ---------- automatic check of a generated card («Проверить все») ---------- */
// Hard rules first; then a second, independent model pass that checks the text against the evidence. Demo mode never auto-approves.
const PROMISES = /(najlepsz|best\b|лучш|№\s*1|nr\s*1|#1\b|gwarantowan|guaranteed|гарантир|leczy|cures|лечит|100\s*%\s*(natural|naturaln|натурал))/i;
async function verifyCard(p, { minConfidence = 60 } = {}) {
  const issues = [];
  if (!p.title || p.title.length < 3) issues.push('нет названия');
  if (!p.seo_description || p.seo_description.length < 80) issues.push('описание короче 80 знаков');
  if (!(p.price > 0)) issues.push('цена не задана или равна нулю');
  if (p.cost != null && p.price < p.cost) issues.push('цена ниже закупочной');
  if (p.ai_flags && /unsupported_facts|no_sources|banned_words/.test(p.ai_flags)) issues.push('замечания AI: ' + p.ai_flags);
  if ((p.ai_confidence ?? 0) < minConfidence) issues.push(`уверенность AI ${p.ai_confidence ?? 0}% ниже ${minConfidence}%`);
  if (PROMISES.test((p.title || '') + ' ' + (p.seo_description || ''))) issues.push('рекламные обещания (лучший/гарантия/лечит) — нужна проверка человеком');
  if (issues.length) return { ok: false, issues, by: 'rules' };
  if (isMock()) return { ok: false, issues: ['демо-режим AI: автоматически подтверждать нельзя, подключите модель'], by: 'rules', mock: true };
  const ev = evidenceOf(p);
  const o = await tracked('verify', () => chatJson('Ты строгий проверяющий карточек магазина. Сравни текст карточки с evidence. Найди: утверждения, которых нет в evidence; ошибки (размеры, материалы, количество); рекламные обещания; ошибки языка. Ответ ТОЛЬКО JSON {"ok": bool, "issues": [str]}. ok=true только если проблем нет.',
    JSON.stringify({ card: { title: p.title, description: p.seo_description }, evidence: ev.map(e => e.text) })));
  const list = (Array.isArray(o?.issues) ? o.issues : []).map(x => txt(x, 200)).filter(Boolean).slice(0, 6);
  return { ok: o?.ok === true && !list.length, issues: list, by: 'ai' };
}

// one JSON call for a job that has its own offline fallback (mock mode): counted against the daily quota like every other call
const json = (kind, system, user, mock) => tracked(kind, async () => isMock() ? mock() : chatJson(system, user));
module.exports = { json, LANGS, PLATFORMS, listModels, analyze, competitorSearch, verifyCard, searchCapable, probe, configured, photoOf, generateCard, localize, indexProducts, search, image, completeness, stats, evidenceOf, validateCard, parseSources, cfg, isMock };
