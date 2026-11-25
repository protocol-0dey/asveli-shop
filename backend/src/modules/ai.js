'use strict';
/* MODULE 10 — AI Studio & operations: brand kit, batch card generation, Human-in-the-Loop review queue, canvas, A/B tests,
   localisation, semantic search, channels, pricing robots, monitoring. Product-level AI actions live in catalog.js (products). */
const { define } = require('../engine/registry');
const R = require('../engine/resource');
const { E, HttpError } = require('../engine/errors');
const { db, audit } = require('../db');
const { can } = require('../iam/permissions');
const C = require('../services/common');
const ai = require('../services/ai');
const aiSettings = require('../services/ai-settings');
const markdown = require('../services/markdown');
const { clean } = require('../engine/fields');
const { FUNCTIONS } = require('./functions');
const competitors = require('../services/competitors');
const i18n = require('../services/i18n');
const orOauth = require('../services/openrouter-oauth');

/* ------------------------------------------------------------------ resources */
define({
  name: 'brand_kits', table: 'm_brand_kits', label: 'Brand Kit', group: 'AI Studio', perm: 'brand', title: 'name', remove: true,
  list: ['name', 'tone', 'primary_color', 'active'],
  fields: [
    { k: 'name', label: 'Название', t: 'text', req: true, max: 60 },
    { k: 'tone', label: 'Тон текстов', t: 'enum', vals: ['neutral', 'premium', 'sport', 'friendly'], def: 'neutral' },
    { k: 'banned_words', label: 'Запрещённые слова (через запятую)', t: 'text', max: 500 },
    { k: 'primary_color', label: 'Фирменный цвет', t: 'text', max: 7, pattern: /^#[0-9a-fA-F]{6}$/ },
    { k: 'active', label: 'Действует', t: 'bool', def: 0, ro: true }
  ],
  actions: {
    activate: { perm: 'brand.write', label: 'Сделать активным', run: ({ row, update }) => { db.prepare('UPDATE m_brand_kits SET active=0 WHERE active=1').run(); return update({ active: true }); } }
  }
});

define({
  name: 'ai_jobs', table: 'm_ai_jobs', label: 'Задания AI', group: 'AI Studio', perm: 'ai', title: 'id', create: false, update: false, sort: 'id DESC',
  list: ['kind', 'status', 'total', 'done_n', 'failed_n', 'note', 'created_at'],
  fields: [
    { k: 'kind', label: 'Тип', t: 'enum', vals: ['card', 'index', 'localize', 'import'], req: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['running', 'done', 'partial', 'failed'], def: 'running' },
    { k: 'total', label: 'Всего', t: 'int', def: 0, min: 0 }, { k: 'done_n', label: 'Готово', t: 'int', def: 0, min: 0 }, { k: 'failed_n', label: 'Ошибок', t: 'int', def: 0, min: 0 },
    { k: 'note', label: 'Заметка', t: 'text', max: 300 }
  ]
});

define({
  name: 'translations', table: 'm_translations', label: 'Переводы карточек', group: 'AI Studio', perm: 'ai', title: 'title', create: false, filters: ['lang', 'human_verified', 'product_id'],
  list: ['product_id', 'lang', 'title', 'mock', 'human_verified'], search: ['title'],
  sql: ['CREATE UNIQUE INDEX IF NOT EXISTS ux_m_translations_pl ON m_translations(product_id, lang)'],
  fields: [
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true },
    { k: 'lang', label: 'Язык', t: 'enum', vals: Object.keys(ai.LANGS), req: true },
    { k: 'title', label: 'Название', t: 'text', max: 200, req: true }, { k: 'description', label: 'Описание', t: 'longtext', max: 4000 },
    { k: 'mock', label: 'Демо-перевод', t: 'bool', def: 0 }, { k: 'src_hash', label: 'Версия исходного текста', t: 'text', max: 40, ro: true }, { k: 'human_verified', label: 'Проверено', t: 'bool', def: 0, ro: true }
  ],
  actions: { approve: { perm: 'ai.review', label: 'Подтвердить перевод', run: ({ row, update }) => { if (row.mock) throw E.conflict('mock_translation'); return update({ human_verified: true }); } } }
});

const NODE_TYPES = ['prompt', 'style', 'angle', 'crop', 'text'];
function parseGraph(raw) {
  let g; try { g = JSON.parse(raw); } catch { throw E.bad('invalid_graph'); }
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || g.nodes.length > 30 || g.edges.length > 60) throw E.bad('invalid_graph');
  const ids = new Set(), parent = new Map();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== 'string' || !/^[a-z0-9_]{1,20}$/.test(n.id) || ids.has(n.id) || !NODE_TYPES.includes(n.type)) throw E.bad('invalid_graph');
    if (typeof n.label !== 'string' || n.label.length > 40 || typeof n.prompt !== 'string' || n.prompt.length > 500) throw E.bad('invalid_graph');
    if (![n.x, n.y].every(v => Number.isFinite(v) && v >= 0 && v <= 5000)) throw E.bad('invalid_graph');
    ids.add(n.id);
  }
  for (const e of g.edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to || parent.has(e.to)) throw E.bad('invalid_graph');       // every node has at most one parent → a tree
    parent.set(e.to, e.from);
  }
  for (const id of ids) { let cur = id, hops = 0; while (parent.has(cur)) { cur = parent.get(cur); if (++hops > 40) throw E.bad('graph_cycle'); } }
  return { g, parent };
}
define({
  name: 'canvases', table: 'm_canvases', label: 'AI Canvas', group: 'AI Studio', perm: 'ai', title: 'title', remove: true, list: ['title', 'updated_at'], search: ['title'],
  fields: [
    { k: 'title', label: 'Название', t: 'text', req: true, max: 80 },
    { k: 'graph', label: 'Граф (JSON)', t: 'longtext', max: 30000, def: '{"nodes":[],"edges":[]}' },
    { k: 'results', label: 'Результаты', t: 'longtext', max: 2e6, ro: true }
  ],
  validate: (data) => { if ('graph' in data) parseGraph(data.graph); },
  actions: {
    run: { perm: 'ai.run', label: 'Сгенерировать варианты', run: async ({ row, update }) => {
      const { g, parent } = parseGraph(row.graph);
      const byId = new Map(g.nodes.map(n => [n.id, n]));
      const prefix = { prompt: '', style: 'Style: ', angle: 'Camera angle: ', crop: 'Crop: ', text: 'Overlay text: ' };
      const eff = id => { const n = byId.get(id), own = prefix[n.type] + n.prompt; return parent.has(id) ? eff(parent.get(id)) + '. ' + own : own; };
      const out = {};
      for (const n of g.nodes) { const img = await ai.image(eff(n.id)); out[n.id] = { kind: img.kind, data: img.data, mock: img.mock, prompt: eff(n.id).slice(0, 1500) }; }
      return update({ results: JSON.stringify(out) });
    } }
  }
});

define({
  name: 'ab_tests', table: 'm_ab_tests', label: 'A/B тесты обложки', group: 'AI Studio', perm: 'abtests', title: 'name', filters: ['status', 'product_id'],
  list: ['name', 'product_id', 'a_views', 'a_clicks', 'b_views', 'b_clicks', 'status', 'winner'],
  fields: [
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true, immutable: true },
    { k: 'name', label: 'Название теста', t: 'text', req: true, max: 80 },
    { k: 'a_label', label: 'Вариант A', t: 'text', max: 60, def: 'Белый фон' }, { k: 'b_label', label: 'Вариант B', t: 'text', max: 60, def: 'В интерьере' },
    { k: 'a_views', label: 'A: показы', t: 'int', def: 0, min: 0, ro: true }, { k: 'a_clicks', label: 'A: клики', t: 'int', def: 0, min: 0, ro: true },
    { k: 'b_views', label: 'B: показы', t: 'int', def: 0, min: 0, ro: true }, { k: 'b_clicks', label: 'B: клики', t: 'int', def: 0, min: 0, ro: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['running', 'done'], def: 'running', ro: true },
    { k: 'winner', label: 'Победитель', t: 'enum', vals: ['a', 'b', 'none'], ro: true },
    { k: 'result_note', label: 'Итог', t: 'text', ro: true, max: 200 }
  ],
  actions: {
    add_stats: { perm: 'abtests.write', label: 'Добавить статистику', fields: ['a_views', 'a_clicks', 'b_views', 'b_clicks'].map(k => ({ k, t: 'int', label: k })), run: ({ row, body, update }) => {
      if (row.status !== 'running') throw E.conflict('bad_state');
      const add = {}; for (const k of ['a_views', 'a_clicks', 'b_views', 'b_clicks']) { const v = body[k] ?? 0; if (!Number.isSafeInteger(v) || v < 0 || v > 1e9) throw E.bad('invalid_' + k); add[k] = row[k] + v; }
      if (add.a_clicks > add.a_views || add.b_clicks > add.b_views) throw E.bad('clicks_exceed_views');
      return update(add); } },
    decide: { perm: 'abtests.write', label: 'Определить победителя', confirm: true, run: ({ row, update }) => {
      if (row.status !== 'running') throw E.conflict('bad_state');
      const { a_views: na, a_clicks: ca, b_views: nb, b_clicks: cb } = row;
      if (na < 200 || nb < 200) throw E.conflict('not_enough_data');                    // no verdict from a handful of impressions
      const pa = ca / na, pb = cb / nb, p = (ca + cb) / (na + nb), se = Math.sqrt(p * (1 - p) * (1 / na + 1 / nb)), z = se ? (pb - pa) / se : 0;
      const winner = Math.abs(z) < 1.96 ? 'none' : z > 0 ? 'b' : 'a';
      return update({ status: 'done', winner, result_note: `CTR A ${(pa * 100).toFixed(2)}% · B ${(pb * 100).toFixed(2)}% · z=${z.toFixed(2)}${winner === 'none' ? ' · разница статистически не значима' : ''}` }); } }
  }
});

const KINDS = ['shopify', 'allegro', 'amazon', 'etsy', 'woocommerce', 'wildberries', 'other'];
define({
  name: 'channels', table: 'm_channels', label: 'Каналы продаж', group: 'Интеграции', perm: 'channels', title: 'name', remove: true,
  list: ['kind', 'name', 'status', 'last_sync'],
  fields: [
    { k: 'kind', label: 'Площадка', t: 'enum', vals: KINDS, req: true },
    { k: 'name', label: 'Название', t: 'text', req: true, max: 60 },
    { k: 'shop_url', label: 'Адрес магазина (https)', t: 'text', max: 200, pattern: /^https:\/\/[^\s"'<>]+$/ },
    { k: 'api_key', label: 'API-ключ (хранится зашифрованным)', t: 'pii', pii: 'generic', max: 300 },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['draft', 'active', 'paused'], def: 'draft' },
    { k: 'last_sync', label: 'Последняя синхронизация', t: 'date', ro: true }
  ],
  actions: {
    sync: { perm: 'channels.write', label: 'Синхронизировать', confirm: true, run: ({ row, update, user }) => {
      if (row.status !== 'active') throw E.conflict('bad_state');
      // Only approved AND human-verified products leave the platform. No outbound call is made here: a real adapter plugs in at `push`.
      const prods = db.prepare("SELECT id, human_verified FROM m_products WHERE status='approved'").all();
      let pushed = 0, skipped = 0;
      const up = db.prepare("INSERT INTO m_channel_listings(channel_id,product_id,status,created_at,updated_at,created_by) VALUES(?,?,'synced',?,?,?) ON CONFLICT(channel_id,product_id) DO UPDATE SET status='synced', last_error=NULL, updated_at=excluded.updated_at");
      db.transaction(() => { for (const p of prods) { if (!p.human_verified) { skipped++; continue; } up.run(row.id, p.id, C.now(), C.now(), user.username); pushed++; } })();
      update({ last_sync: C.now() });
      return { ok: true, pushed, skipped_unverified: skipped, simulated: true };
    } }
  }
});
define({
  name: 'channel_listings', table: 'm_channel_listings', label: 'Листинги в каналах', group: 'Интеграции', perm: 'channels', title: 'id', create: false, update: false, filters: ['channel_id', 'product_id', 'status'],
  list: ['channel_id', 'product_id', 'status', 'external_id', 'updated_at'],
  sql: ['CREATE UNIQUE INDEX IF NOT EXISTS ux_m_channel_listings ON m_channel_listings(channel_id, product_id)'],
  fields: [
    { k: 'channel_id', label: 'Канал', t: 'ref', ref: 'channels', req: true }, { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true },
    { k: 'external_id', label: 'ID в канале', t: 'text', max: 120 }, { k: 'status', label: 'Статус', t: 'enum', vals: ['pending', 'synced', 'error'], def: 'pending' },
    { k: 'last_error', label: 'Ошибка', t: 'text', max: 200 }
  ]
});

/* ------------------------------------------------------------------ helpers */
const intParam = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const safeJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const firstImage = p => { const a = safeJson(p.images || '[]', []); return Array.isArray(a) && typeof a[0] === 'string' ? a[0] : null; };
const stockOf = id => db.prepare('SELECT COALESCE(SUM(qty),0) qty, COALESCE(SUM(reserved),0) reserved FROM m_stock WHERE product_id=?').get(id);

function parseCsv(text) {                      // RFC 4180 subset: quotes, escaped quotes, CRLF
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = []; if (rows.length > 501) break; }
    else f += c;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
/* Shopify product CSV (Handle, Title, Body (HTML), Vendor, Type, Tags, Variant SKU, Variant Price, Variant Grams, Variant Barcode, Image Src…):
   one product per Handle — the first row carries the product, later rows add images. Category: the deepest "cat-<slug>" tag (our tree),
   else Type. Variants beyond the first are imported as their own products only when they have their own SKU. Other CSVs pass through. */
function fromShopifyCsv(rows) {
  const h = rows[0].map(x => clean(x).toLowerCase());
  if (!h.includes('handle') || !h.includes('variant price')) return { head: h, rows: rows.slice(1) };
  const at = (r, k) => { const i = h.indexOf(k); return i < 0 ? '' : String(r[i] ?? '').trim(); };
  const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 5000);
  const byHandle = new Map();
  for (const r of rows.slice(1)) {
    const handle = at(r, 'handle'); if (!handle) continue;
    let p = byHandle.get(handle);
    if (!p) { p = { handle, title: '', description: '', brand: '', category: '', images: [], variants: [] }; byHandle.set(handle, p); }
    if (at(r, 'title')) {
      p.title = at(r, 'title'); p.description = strip(at(r, 'body (html)')); p.brand = at(r, 'vendor').slice(0, 60);
      const tags = at(r, 'tags').split(',').map(t => t.trim()).filter(t => t.startsWith('cat-')).map(t => t.slice(4));
      p.category = tags.length ? tags[tags.length - 1] : at(r, 'type');
    }
    const img = at(r, 'image src'); if (img && !p.images.includes(img)) p.images.push(img);
    if (at(r, 'variant price')) p.variants.push({ sku: at(r, 'variant sku'), price: at(r, 'variant price'), grams: at(r, 'variant grams'), barcode: at(r, 'variant barcode').replace(/^'/, '') });
  }
  const head = ['sku', 'title', 'category', 'price', 'brand', 'description', 'barcode', 'weight_g', 'images'], out = [];
  for (const p of byHandle.values()) p.variants.forEach((v, i) => {
    if (i > 0 && !v.sku) return;
    out.push([v.sku || p.handle, p.title, p.category || 'Без категории', v.price, p.brand, p.description, v.barcode, String(Math.round(Number(v.grams) || 0) || ''), p.images.join(' ')]);
  });
  return { head, rows: out };
}
module.exports.fromShopifyCsv = fromShopifyCsv;

const toCents = s => { s = String(s ?? '').trim().replace(',', '.'); const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s); return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0) : null; };

function newJob(user, req, kind, total, note) {
  return R.create('ai_jobs', user, { kind, status: 'running', total, done_n: 0, failed_n: 0, note: note || null }, req, { internal: true });
}
const finishJob = (job, user, req, done, failed, extra = {}) =>
  R.update('ai_jobs', job.id, user, { done_n: done, failed_n: failed, status: failed === 0 ? 'done' : done === 0 ? 'failed' : 'partial', ...extra }, req, { internal: true });

/* ------------------------------------------------------------------ routes */
module.exports.routes = (r, h) => {
  r.get('/ai/overview', h.need('ai.read'), (req, res) => {
    const thr = ai.cfg.reviewConfidence, n = (sql, ...a) => db.prepare(sql).get(...a).c;
    const stock = db.prepare('SELECT COUNT(*) c FROM m_stock WHERE reorder_level>0 AND qty-reserved<=reorder_level').get().c;
    res.json({
      threshold: thr, provider: ai.cfg.provider,
      products: {
        total: n('SELECT COUNT(*) c FROM m_products'), verified: n('SELECT COUNT(*) c FROM m_products WHERE human_verified=1'),
        awaiting: n("SELECT COUNT(*) c FROM m_products WHERE ai_status='generated' AND human_verified=0"),
        low_confidence: n("SELECT COUNT(*) c FROM m_products WHERE ai_status='generated' AND human_verified=0 AND ai_confidence<?", thr),
        no_card: n("SELECT COUNT(*) c FROM m_products WHERE ai_status IN ('none','failed','rejected')")
      },
      stock: { low: stock, overstock: markdown.run({ dry: true }).changes.length },
      jobs: db.prepare('SELECT id, kind, status, total, done_n, failed_n, created_at FROM m_ai_jobs ORDER BY id DESC LIMIT 5').all(),
      usage: { used_24h: ai.stats().used_24h, limit: ai.cfg.dailyLimit }
    });
  });

  // Fast-audit queue: least confident first, so the human spends time where the AI is unsure.
  r.get('/ai/review/queue', h.need('ai.read'), (req, res) => {
    const thr = intParam(req.query.max_conf, 101, 0, 101), limit = intParam(req.query.limit, 20, 1, 100);
    const rows = db.prepare("SELECT * FROM m_products WHERE ai_status='generated' AND human_verified=0 AND ai_confidence<? ORDER BY ai_confidence ASC, id ASC LIMIT ?").all(thr, limit);
    const left = db.prepare("SELECT COUNT(*) c FROM m_products WHERE ai_status='generated' AND human_verified=0 AND ai_confidence<?").get(thr).c;
    res.json({ left, rows: rows.map(p => ({ id: p.id, sku: p.sku, barcode: p.barcode, title: p.title, brand: p.brand, category: p.category, price: p.price, status: p.status, seo_description: p.seo_description,
      data_sources: safeJson(p.data_sources || '[]', []), ai_confidence: p.ai_confidence, ai_flags: p.ai_flags, image: firstImage(p), stock: stockOf(p.id).qty, warehouse_location: p.warehouse_location })) });
  });

  // Batch card generation. Runs inline (bounded by `limit`), 3 at a time; the job row records what happened. A quota stop leaves a partial job.
  r.post('/ai/batch', h.need('ai.run'), h.wrap(async (req, res) => {
    const b = req.body || {}; const kind = b.kind;
    if (!['card', 'localize'].includes(kind)) throw E.bad('invalid_kind');
    const limit = intParam(b.limit, 50, 1, 200);
    let ids;
    if (Array.isArray(b.ids)) { if (b.ids.length > 200 || b.ids.some(x => !Number.isSafeInteger(x) || x < 1)) throw E.bad('invalid_ids'); ids = b.ids; }
    else if (b.scope === 'unverified') ids = db.prepare("SELECT id FROM m_products WHERE ai_status IN ('none','failed','rejected') AND status<>'delisted' ORDER BY id LIMIT ?").all(limit).map(x => x.id);
    else if (kind === 'localize' && b.scope === 'verified') ids = db.prepare("SELECT id FROM m_products WHERE human_verified=1 ORDER BY id LIMIT ?").all(limit).map(x => x.id);
    else throw E.bad('invalid_scope');
    const lang = b.lang; if (kind === 'localize' && !ai.LANGS[lang]) throw E.bad('invalid_lang');
    if (kind === 'card' && !can(req.user, 'products.read')) throw E.forbidden();
    const job = newJob(req.user, req, kind, ids.length, kind === 'localize' ? lang : null);
    let done = 0, failed = 0, stop = null, i = 0;
    const worker = async () => {
      while (i < ids.length && !stop) {
        const id = ids[i++];
        try {
          if (kind === 'card') await R.runAction('products', id, 'ai_generate', req.user, {}, req);
          else {
            const p = db.prepare('SELECT * FROM m_products WHERE id=?').get(id); if (!p) throw E.notFound();
            const t = await ai.localize(p, lang);
            const ex = db.prepare('SELECT id FROM m_translations WHERE product_id=? AND lang=?').get(id, lang);
            const body = { product_id: id, lang, title: t.title, description: t.description || null, mock: t.mock };
            if (ex) R.update('translations', ex.id, req.user, { title: body.title, description: body.description, mock: t.mock, human_verified: false }, req, { internal: true });
            else R.create('translations', req.user, body, req, { internal: true });
          }
          done++;
        } catch (e) { failed++; if (e instanceof HttpError && e.code === 'ai_quota') stop = 'ai_quota'; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const out = finishJob(job, req.user, req, done, failed + (stop ? ids.length - done - failed : 0), { note: stop ? 'остановлено: дневная квота AI' : (job.note || null) });
    audit(req, 'ai.batch', `${kind} ${done}/${ids.length}`, req.user.username);
    res.json({ job: out, done, failed, stopped: stop });
  }));

  r.post('/ai/index', h.need('ai.run'), h.wrap(async (req, res) => {
    const job = newJob(req.user, req, 'index', db.prepare('SELECT COUNT(*) c FROM m_products').get().c);
    try { const out = await ai.indexProducts(); finishJob(job, req.user, req, out.indexed + out.skipped, 0, { note: `новых/изменённых: ${out.indexed}, без изменений: ${out.skipped}` }); res.json(out); }
    catch (e) { finishJob(job, req.user, req, 0, 1, { note: String(e.code || e.message).slice(0, 100) }); throw e; }
  }));
  r.get('/ai/search', h.need('ai.read'), h.wrap(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 200); if (!q.trim()) throw E.bad('required_q');
    res.json({ q, provider: ai.cfg.provider, rows: await ai.search(q, { limit: intParam(req.query.limit, 20, 1, 50) }) });
  }));

  // Supplier catalogue import from pasted CSV (sku,title,category,price,cost,brand,description,barcode,source_url). We never fetch supplier URLs
  // server-side (SSRF); a URL is only recorded as the cited source of the row.
  r.post('/ai/import', h.need('products.write'), h.wrap(async (req, res) => {
    const b = req.body || {};
    if (!Number.isSafeInteger(b.seller_id) || b.seller_id < 1) throw E.bad('invalid_seller_id');
    if (typeof b.csv !== 'string' || !b.csv.trim() || b.csv.length > 1e6) throw E.bad('invalid_csv');
    const rows = parseCsv(b.csv); if (rows.length < 2) throw E.bad('csv_needs_header_and_rows');
    if (rows.length > 501) throw E.bad('too_many_rows');
    const { head, rows: data } = fromShopifyCsv(rows); rows.length = 0; rows.push(head, ...data);    // a Shopify product export is accepted as is
    for (const need of ['sku', 'title', 'category', 'price']) if (!head.includes(need)) throw E.bad('csv_missing_' + need);
    const job = newJob(req.user, req, 'import', rows.length - 1);
    const errors = []; let ok = 0;
    rows.slice(1).forEach((cells, ix) => {
      const get = k => { const i = head.indexOf(k); return i < 0 ? '' : clean(cells[i] || ''); };
      try {
        const price = toCents(get('price')); if (price == null) throw E.bad('invalid_price');
        const cost = get('cost') ? toCents(get('cost')) : null; if (get('cost') && cost == null) throw E.bad('invalid_cost');
        const url = get('source_url');
        const body = { seller_id: b.seller_id, sku: get('sku'), title: get('title'), category: get('category'), price };
        for (const k of ['brand', 'description']) if (get(k)) body[k] = get(k);
        if (/^\d{8,14}$/.test(get('barcode'))) body.barcode = get('barcode');
        if (/^\d{1,7}$/.test(get('weight_g'))) body.weight_g = Number(get('weight_g'));
        const imgs = get('images').split(' ').filter(u => /^https:\/\/\S+$/.test(u)).slice(0, 8); if (imgs.length) body.images = JSON.stringify(imgs);
        if (cost != null) body.cost = cost;
        if (url) body.data_sources = JSON.stringify([{ fact: 'Карточка у поставщика', source_type: 'url', source_ref: url }]);
        R.create('products', req.user, body, req); ok++;
      } catch (e) { errors.push({ row: ix + 2, error: e.code || e.message }); }
    });
    finishJob(job, req.user, req, ok, errors.length);
    res.json({ imported: ok, failed: errors.length, errors: errors.slice(0, 50), job_id: job.id });
  }));

  /* ---------- «Проверить все»: automatic check of the whole queue ---------- */
  // Each call checks up to `limit` cards (3 in parallel) and returns what is left; the page calls again until nothing is left.
  r.post('/ai/review/auto', h.need('ai.review'), h.wrap(async (req, res) => {
    const b = req.body || {}, limit = intParam(b.limit, 20, 1, 100), minConf = intParam(b.min_confidence, 60, 0, 100), skip = new Set(Array.isArray(b.skip) ? b.skip.filter(Number.isSafeInteger).slice(0, 5000) : []);
    const rows = db.prepare("SELECT * FROM m_products WHERE ai_status='generated' AND human_verified=0 ORDER BY ai_confidence DESC, id").all().filter(p => !skip.has(p.id)).slice(0, limit);
    const items = []; let i = 0, stop = null;
    const worker = async () => {
      while (i < rows.length && !stop) {
        const p = rows[i++];
        try {
          const v = await ai.verifyCard(p, { minConfidence: minConf });
          if (v.ok) {
            const patch = { human_verified: true, verified_by: 'AI-проверка · ' + req.user.username };
            if (p.status === 'pending_review' && can(req.user, 'products.moderate') && !require('../services/compliance').scan(p).block.length) patch.status = 'approved';
            R.update('products', p.id, req.user, patch, req, { internal: true });
          } else R.update('products', p.id, req.user, { ai_flags: ('автопроверка: ' + v.issues.join('; ')).slice(0, 300) }, req, { internal: true });
          items.push({ id: p.id, title: p.title, ok: v.ok, issues: v.issues, by: v.by });
        } catch (e) { if (e instanceof HttpError && e.code === 'ai_quota') stop = 'ai_quota'; items.push({ id: p.id, title: p.title, ok: false, issues: ['ошибка AI: ' + (e.code || e.message)], by: 'error' }); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const checkedIds = [...skip, ...items.map(x => x.id)];
    const left = db.prepare("SELECT id FROM m_products WHERE ai_status='generated' AND human_verified=0").all().filter(x => !checkedIds.includes(x.id)).length;
    audit(req, 'ai.review.auto', `passed ${items.filter(x => x.ok).length}/${items.length}`, req.user.username);
    res.json({ items, left, stopped: stop, mock: ai.isMock() });
  }));

  /* ---------- translations: every card into every shop language ---------- */
  r.get('/ai/i18n', h.need('ai.read'), (req, res) => res.json({ ...i18n.view(), langs_all: ai.LANGS }));
  r.put('/ai/i18n', h.need('ai.run'), (req, res) => { const v = i18n.save(req.body || {}); audit(req, 'ai.i18n', `langs=${v.langs.join(',')} auto=${v.auto}`, req.user.username); res.json({ ...v, langs_all: ai.LANGS }); });
  r.post('/ai/translate/all', h.need('ai.run'), h.wrap(async (req, res) => {
    const limit = intParam((req.body || {}).limit, 20, 1, 100);
    const r2 = await i18n.run(req.user, req, limit);
    audit(req, 'ai.translate.all', `${r2.done}/${r2.done + r2.failed}`, req.user.username);
    res.json({ ...r2, ...i18n.view() });
  }));

  /* ---------- competitor prices ---------- */
  r.get('/ai/competitors', h.need('pricing.read'), (req, res) => res.json({ rows: competitors.overview(), web: ai.searchCapable(), mock: ai.isMock(), provider: ai.cfg.provider, currency: require('../config').currency }));
  r.get('/ai/competitors/:id', h.need('pricing.read'), (req, res) => { const id = Number(req.params.id); if (!Number.isSafeInteger(id) || !db.prepare('SELECT 1 FROM m_products WHERE id=?').get(id)) throw E.notFound(); res.json(competitors.summary(id)); });
  r.post('/ai/competitors/run', h.need('pricing.read'), h.wrap(async (req, res) => {
    const b = req.body || {}, limit = intParam(b.limit, 5, 1, 30);
    let ids = Array.isArray(b.ids) ? b.ids.filter(Number.isSafeInteger).slice(0, 30)
      : db.prepare("SELECT id FROM m_products WHERE status<>'delisted' ORDER BY competitor_checked_at IS NOT NULL, competitor_checked_at, id").all().map(x => x.id);
    if (b.skip) { const s = new Set(b.skip); ids = ids.filter(x => !s.has(x)); }
    const todo = ids.slice(0, limit), out = []; let stop = null;
    for (const id of todo) {
      if (stop) break;
      try { out.push({ id, ...(await R.runAction('products', id, 'competitors', req.user, {}, req)) }); }
      catch (e) { out.push({ id, error: e.code || e.message }); if (e instanceof HttpError && ['ai_quota', 'ai_no_web_search', 'ai_not_configured'].includes(e.code)) stop = e.code; }
    }
    res.json({ results: out.map(x => ({ id: x.id, error: x.error, min: x.min, median: x.median, count_verified: x.count_verified, offers: x.offers ? x.offers.length : 0, mock: x.mock })), left: Math.max(0, ids.length - todo.length), stopped: stop });
  }));

  /* ---------- AI: models list + one-click OpenRouter sign-in ---------- */
  r.post('/ai/settings/models', h.need('secrets.ai'), h.wrap(async (req, res) => {
    const b = req.body || {}, service = String(b.service || aiSettings.view().service);
    const key = typeof b.apiKey === 'string' && b.apiKey ? b.apiKey.trim() : aiSettings.keyFor(service);
    res.json({ service, models: await ai.listModels(service, key) });
  }));
  r.post('/ai/oauth/openrouter/start', h.need('secrets.ai'), (req, res) => {
    const origin = String((req.body || {}).origin || '');
    if (!/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin)) throw E.bad('invalid_origin');
    const st = orOauth.start(req.user.id, origin);
    audit(req, 'ai.oauth.openrouter', 'start', req.user.username);
    res.json(st);
  });
  r.post('/ai/oauth/openrouter/exchange', h.need('secrets.ai'), h.wrap(async (req, res) => {
    const b = req.body || {};
    const key = await orOauth.exchange(req.user.id, String(b.state || ''), String(b.code || ''));
    await aiSettings.save({ service: 'openrouter', apiKey: key });
    audit(req, 'ai.settings', 'service=openrouter, apiKey=(from OpenRouter sign-in)', req.user.username);
    res.json(aiSettings.view());
  }));

  /* ---------- connection settings (owner only: the API key lives here) ---------- */
  r.get('/ai/settings', h.need('secrets.ai'), (req, res) => res.json(aiSettings.view()));
  r.put('/ai/settings', h.need('secrets.ai'), h.wrap(async (req, res) => {
    const b = req.body || {}, keys = ['service', 'provider', 'baseUrl', 'model', 'embedModel', 'imageModel', 'timeoutMs', 'dailyLimit', 'reviewConfidence', 'apiKey'];
    const patch = {}; for (const k of keys) if (b[k] !== undefined) patch[k] = b[k];
    if (!Object.keys(patch).length) throw E.bad('nothing_to_update');
    await aiSettings.save(patch);
    audit(req, 'ai.settings', Object.keys(patch).map(k => (k === 'apiKey' ? 'apiKey=(changed)' : `${k}=${String(patch[k]).slice(0, 60)}`)).join(', '), req.user.username);      // the key itself never reaches the log
    res.json(aiSettings.view());
  }));
  r.delete('/ai/settings/key', h.need('secrets.ai'), (req, res) => { aiSettings.clearKey(); audit(req, 'ai.settings', 'apiKey=(removed)', req.user.username); res.json(aiSettings.view()); });
  r.post('/ai/settings/reset', h.need('secrets.ai'), (req, res) => { aiSettings.reset(); audit(req, 'ai.settings', 'reset to env defaults', req.user.username); res.json(aiSettings.view()); });
  r.post('/ai/settings/test', h.need('secrets.ai'), h.wrap(async (req, res) => res.json(await ai.probe())));

  r.get('/ai/monitor', h.need('ai.read'), (req, res) => res.json(ai.stats()));
  r.get('/ai/functions', h.need('ai.read'), (req, res) => res.json({ rows: FUNCTIONS }));

  /* ---------- pricing robots ---------- */
  r.post('/pricing/markdown', h.need('pricing.write'), (req, res) => {
    const b = req.body || {};
    const out = markdown.run({ dry: b.dry !== false, stepBps: intParam(b.step_bps, 500, 100, 2000), everyDays: intParam(b.every_days, 3, 1, 30), minStock: intParam(b.min_stock, 20, 1, 1e6), days: intParam(b.days, 30, 7, 365), maxUnits: intParam(b.max_units, 2, 0, 1e6), by: req.user.username });
    if (!out.dry) audit(req, 'pricing.markdown', `${out.changes.length} prices`, req.user.username);
    res.json(out);
  });
  r.get('/pricing/elasticity', h.need('pricing.read'), (req, res) => {
    const id = h.id(req.query.product_id), p = db.prepare('SELECT * FROM m_products WHERE id=?').get(id); if (!p) throw E.notFound();
    const eps = Math.max(-5, Math.min(0, Number(req.query.elasticity ?? -1.5))); if (!Number.isFinite(eps)) throw E.bad('invalid_elasticity');
    const days = 30, units = db.prepare("SELECT COALESCE(SUM(i.qty),0) u FROM m_order_items i JOIN m_orders o ON o.id=i.order_id WHERE i.product_id=? AND o.created_at>? AND o.status<>'cancelled'").get(id, C.now() - days * C.day).u;
    const cost = p.cost || 0;
    const rows = [-20, -10, -5, 0, 5, 10].map(d => { const price = Math.round(p.price * (1 + d / 100)), u = Math.max(0, units * (1 + eps * d / 100)); return { delta_pct: d, price, units: Math.round(u * 10) / 10, revenue: Math.round(price * u), margin: Math.round((price - cost) * u), below_floor: p.min_price != null && price < Math.max(p.min_price, cost) }; });
    res.json({ product_id: id, sku: p.sku, model: 'constant_elasticity', elasticity: eps, baseline_units_30d: units, note: 'Оценка по простой модели с заданной эластичностью, а не прогноз по данным.', rows });
  });
  r.get('/compliance/price-deviation', h.need('compliance.read'), (req, res) => {
    const pct = intParam(req.query.pct, 50, 5, 95);
    const groups = new Map();
    for (const p of db.prepare("SELECT id, sku, title, price, category, model_slug, seller_id FROM m_products WHERE status IN ('approved','pending_review') AND digital=0").all()) {
      const k = p.model_slug ? 'm:' + p.model_slug : 'c:' + p.category; (groups.get(k) || groups.set(k, []).get(k)).push(p);
    }
    const rows = [];
    for (const [k, list] of groups) {
      if (list.length < 3) continue;
      const s = list.map(p => p.price).sort((a, b) => a - b), med = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
      for (const p of list) if (p.price * 100 < med * pct) rows.push({ id: p.id, sku: p.sku, title: p.title, price: p.price, group_median: med, ratio_pct: Math.round(p.price * 100 / med), group: k.slice(2), by: k[0] === 'm' ? 'model' : 'category' });
    }
    res.json({ pct, rows: rows.sort((a, b) => a.ratio_pct - b.ratio_pct).slice(0, 100) });
  });
};
