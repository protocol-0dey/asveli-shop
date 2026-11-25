'use strict';
// Direct API providers (Gemini) and the runtime "AI → Подключения" settings: key handling, RBAC, SSRF guard, one-pass photo+evidence card.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, Client } = require('./helpers');

const KEY = 'AIzaSy-test-key-0123456789';
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let T, S2, owner, mgr, fake, raw, seen, badKey = false;
const call = async (c, m, u, json) => { const r = await c.req(m, '/api/admin' + u, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, m, u, json, st) => { const r = await call(c, m, u, json); assert.ok(st ? r.s === st : r.s < 300, `${m} ${u} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const vec = t => { const v = new Array(768).fill(0); for (const w of (String(t).toLowerCase().match(/[a-z0-9]{2,}/g) || [])) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 768] += 1; } return v; };

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const body = b ? JSON.parse(b) : {}; seen = { url: req.url, key: req.headers['x-goog-api-key'], auth: req.headers.authorization, body };
      if (badKey || req.headers['x-goog-api-key'] !== KEY) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'API key not valid: ' + (req.headers['x-goog-api-key'] || '') } })); }
      if (req.url.includes('gemini-2.5-flash-image:generateContent')) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG1 } }] } }] }));
      if (req.url.includes(':generateContent')) {
        let msg = {}; try { msg = JSON.parse(body.contents[0].parts[0].text); } catch { /* probe ping */ } const vi = (msg.evidence || []).find(e => String(e.text).startsWith('Фото товара'));
        const card = { title: 'Кожаный кошелёк', seo_description: 'Кошелёк из кожи тёмно-коричневого цвета.', bullets: ['Кожа'], keywords: ['кошелёк'], facts: vi ? [{ text: 'Тёмно-коричневый цвет', source_index: vi.source_index }] : [], confidence: 100 };
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(card) }] } }] }));
      }
      if (req.url.includes(':batchEmbedContents')) return res.end(JSON.stringify({ embeddings: body.requests.map(r => ({ values: vec(r.content.parts[0].text) })) }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  T = await startServer({ AI_PROVIDER: 'mock', AI_ALLOW_PRIVATE_HOSTS: '1', AI_DAILY_LIMIT: '5000' });
  S2 = await startServer({ AI_PROVIDER: 'mock', AI_DAILY_LIMIT: '5000' });                 // production-like: private hosts NOT allowed
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  raw = new Database(path.join(T.dataDir, 'asveli.db'), { readonly: true });
  const pw = 'brand-new-long-password-77', st = await ok(owner, 'POST', '/staff', { username: 'u_mgr', role: 'catalog_manager' }, 201);
  mgr = new Client(T.adminBase); await mgr.login('u_mgr', st.temp_password); await ok(mgr, 'POST', '/security/password', { current: st.temp_password, next: pw });
});
after(() => { if (raw) raw.close(); if (T) T.stop(); if (S2) S2.stop(); if (fake) fake.close(); });

const connect = () => ok(owner, 'PUT', '/ai/settings', { provider: 'gemini', baseUrl: `http://127.0.0.1:${fake.address().port}`, apiKey: KEY });

test('settings are owner-only; the key is write-only and never leaves the server', async () => {
  assert.equal((await call(mgr, 'GET', '/ai/settings')).s, 403);                                   // catalog_manager has ai.* but not secrets.ai
  assert.equal((await call(mgr, 'PUT', '/ai/settings', { provider: 'gemini', apiKey: KEY })).s, 403);
  assert.equal((await call(mgr, 'POST', '/ai/settings/test')).s, 403);
  const v0 = await ok(owner, 'GET', '/ai/settings'); assert.equal(v0.provider, 'mock'); assert.equal(v0.has_key, false);
  const v = await connect();
  assert.equal(v.provider, 'gemini'); assert.equal(v.has_key, true); assert.equal(v.key_hint, '••••6789'); assert.equal(v.model, 'gemini-2.5-flash');
  for (const body of [JSON.stringify(v), JSON.stringify(await ok(owner, 'GET', '/ai/settings')), JSON.stringify(await ok(owner, 'GET', '/ai/monitor'))]) assert.ok(!body.includes(KEY));
  const stored = raw.prepare("SELECT v FROM settings WHERE k='ai.config'").get().v;
  assert.ok(!stored.includes(KEY), 'sealed at rest');
  const audits = raw.prepare("SELECT detail FROM audit WHERE action='ai.settings'").all().map(a => a.detail).join('\n');
  assert.match(audits, /apiKey=\(changed\)/); assert.ok(!audits.includes(KEY));
});

test('validation: provider, numbers, key shape; empty patch is rejected', async () => {
  const bad = async (b, code) => { const r = await call(owner, 'PUT', '/ai/settings', b); assert.equal(r.s, 400, JSON.stringify(b)); assert.equal(r.j.error, code); };
  await bad({}, 'nothing_to_update'); await bad({ provider: 'skynet' }, 'invalid_provider'); await bad({ timeoutMs: 5 }, 'invalid_timeout');
  await bad({ dailyLimit: 0 }, 'invalid_daily_limit'); await bad({ reviewConfidence: 101 }, 'invalid_review_confidence');
  await bad({ apiKey: 'short' }, 'invalid_api_key'); await bad({ apiKey: 'has space in it 123456' }, 'invalid_api_key'); await bad({ model: 'x; rm -rf' }, 'invalid_model');
});

test('"Проверить подключение" calls the real endpoints with the key in the header (never the URL) and reports timings', async () => {
  await connect();
  const r = await ok(owner, 'POST', '/ai/settings/test'); assert.equal(r.ok, true); assert.deepEqual(r.steps.map(s => s.name), ['chat', 'embeddings']);
  assert.ok(r.steps.every(s => s.ok && s.ms >= 0));
  assert.equal(seen.key, KEY); assert.ok(!seen.url.includes(KEY) && !seen.url.includes('key='));
});

test('a rejected key is reported with the provider message, key redacted', async () => {
  await ok(owner, 'PUT', '/ai/settings', { apiKey: 'AIzaSy-WRONG-key-000000' });
  const r = await ok(owner, 'POST', '/ai/settings/test'); assert.equal(r.ok, false);
  assert.equal(r.steps[0].error, 'ai_http_400'); assert.match(r.steps[0].detail, /API key not valid/); assert.ok(!JSON.stringify(r).includes('WRONG-key-000000'));
  await ok(owner, 'PUT', '/ai/settings', { apiKey: KEY });
});

test('one pass: product photo + evidence go to Gemini together; a fact citing the photo is stored as source "vision"', async () => {
  await connect();
  const seller = await ok(owner, 'POST', '/m/sellers', { name: 'Photo Shop', country: 'PL', legal_name: 'Jan K', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874' }, 201);
  for (const a of ['kyc_submit', 'kyc_approve', 'activate']) await ok(owner, 'POST', `/m/sellers/${seller.id}/do/${a}`, {});
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from(PNG1, 'base64')], { type: 'image/png' }), 'wallet.png');
  const up = await (await owner.req('POST', '/api/admin/files', { body: fd })).json();
  const pub = await ok(owner, 'PATCH', '/files/' + up.id, { is_public: true });
  const slug = pub.public_slug || pub.slug || new URL(pub.url || pub.public_url, 'http://x').pathname.split('/')[2];
  const p = await ok(owner, 'POST', '/m/products', { sku: 'PH-1', title: 'Wallet', seller_id: seller.id, category: 'bags', brand: 'Acme', description: 'Leather wallet, dark brown, with six card slots and a coin pocket.', price: 5000, images: JSON.stringify([`/f/${slug}/wallet.png`]) }, 201);
  const r = await ok(owner, 'POST', `/m/products/${p.id}/do/ai_generate`, {});
  const part = seen.body.contents[0].parts; assert.equal(part.length, 2); assert.equal(part[1].inlineData.mimeType, 'image/png');
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json'); assert.ok(seen.body.systemInstruction.parts[0].text.length > 50);
  const src = JSON.parse(r.data_sources); assert.ok(src.some(s => s.source_type === 'vision' && /image:/.test(s.source_ref)), JSON.stringify(src));
  assert.equal(r.human_verified, 0);                                                                // the model never verifies itself
});

test('embeddings: documents and queries use the right Gemini task types; hybrid search works', async () => {
  const seller = (await ok(owner, 'GET', '/m/sellers')).rows[0];
  const mk = (sku, title) => ok(owner, 'POST', '/m/products', { sku, title, seller_id: seller.id, category: 'misc', price: 100 }, 201);
  await mk('GE-1', 'Leather wallet brown'); await mk('GE-2', 'Garden hose green');
  await ok(owner, 'POST', '/ai/index', {}); assert.equal(seen.body.requests[0].taskType, 'RETRIEVAL_DOCUMENT'); assert.equal(seen.body.requests[0].outputDimensionality, 768);
  const f = await ok(owner, 'GET', '/ai/search?q=' + encodeURIComponent('leather wallet'));
  assert.equal(seen.body.requests[0].taskType, 'RETRIEVAL_QUERY'); assert.equal(f.rows[0].sku, 'GE-1');
});

test('canvas: Gemini image model output is stored as a private file', async () => {
  const g = { nodes: [{ id: 'a', type: 'prompt', label: 'a', prompt: 'wallet on marble', x: 0, y: 0 }], edges: [] };
  const c = await ok(owner, 'POST', '/m/canvases', { title: 'gem', graph: JSON.stringify(g) }, 201);
  const r = await ok(owner, 'POST', `/m/canvases/${c.id}/do/run`, {}); const res = JSON.parse(r.results);
  assert.equal(res.a.kind, 'file'); assert.match(res.a.data, /^[a-f0-9]{32}$/); assert.ok(seen.url.includes('gemini-2.5-flash-image:generateContent'));
  assert.deepEqual(seen.body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
});

test('not configured → clear 503 instead of a crash; removing the key / reset work', async () => {
  await ok(owner, 'PUT', '/ai/settings', { provider: 'openai', baseUrl: '' });
  const v = await ok(owner, 'DELETE', '/ai/settings/key'); assert.equal(v.has_key, false);
  const seller = (await ok(owner, 'GET', '/m/sellers')).rows[0];
  const p = await ok(owner, 'POST', '/m/products', { sku: 'NC-1', title: 'x', seller_id: seller.id, category: 'a', price: 100 }, 201);
  const r = await call(owner, 'POST', `/m/products/${p.id}/do/ai_generate`, {}); assert.equal(r.s, 503); assert.equal(r.j.error, 'ai_not_configured');
  const t = await ok(owner, 'POST', '/ai/settings/test'); assert.equal(t.ok, false); assert.equal(t.steps[0].error, 'ai_not_configured');
  const back = await ok(owner, 'POST', '/ai/settings/reset', {}); assert.equal(back.provider, 'mock');
  assert.equal((await call(owner, 'POST', `/m/products/${p.id}/do/ai_generate`, {})).s, 200);       // mock works again
});

test('settings survive a restart conceptually: stored JSON is re-applied (provider/model/limits) and key is unsealed', async () => {
  await ok(owner, 'PUT', '/ai/settings', { provider: 'gemini', baseUrl: `http://127.0.0.1:${fake.address().port}`, apiKey: KEY, model: 'gemini-2.5-pro', dailyLimit: 321, reviewConfidence: 70 });
  const v = await ok(owner, 'GET', '/ai/settings'); assert.equal(v.model, 'gemini-2.5-pro'); assert.equal(v.dailyLimit, 321); assert.equal(v.reviewConfidence, 70);
  assert.equal((await ok(owner, 'GET', '/ai/monitor')).limit, 321);
  await ok(owner, 'POST', '/ai/settings/reset', {});
});

test('SSRF guard (production-like server): only public https base URLs are accepted from the settings form', async () => {
  const o = new Client(S2.adminBase); await o.login('alice', 'correct-horse-battery');
  const bad = async (url, code) => { const r = await call(o, 'PUT', '/ai/settings', { provider: 'openai', baseUrl: url }); assert.equal(r.s, 400, url); assert.equal(r.j.error, code, url); };
  await bad('http://api.example.com/v1', 'base_url_must_be_https'); await bad('https://127.0.0.1/v1', 'base_url_private_host'); await bad('https://localhost/v1', 'base_url_private_host');
  await bad('https://169.254.169.254/latest', 'base_url_private_host'); await bad('https://10.0.0.5', 'base_url_private_host'); await bad('https://[::1]/v1', 'base_url_private_host');
  await bad('https://[::ffff:127.0.0.1]/v1', 'base_url_private_host'); await bad('https://u:p@api.example.com/v1', 'invalid_base_url'); await bad('https://api.example.com/v1?x=1', 'invalid_base_url'); await bad('not a url', 'invalid_base_url');
  const g = await ok(o, 'PUT', '/ai/settings', { provider: 'gemini', baseUrl: 'https://evil.example.com', apiKey: KEY });
  assert.equal(g.baseUrl, '', 'Gemini always uses the official host'); assert.equal(g.base_url_editable, false);
});
