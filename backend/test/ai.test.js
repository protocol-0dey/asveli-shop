'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, Client } = require('./helpers');

const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let T, owner, seller, fake, fakeReply;
const NEWPW = 'brand-new-long-password-77';
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
async function staff(username, role) {
  const j = await ok(owner, 'POST', '/staff', { username: 'u_' + username, role }, 201);
  const c = new Client(T.adminBase); await c.login('u_' + username, j.temp_password);
  await ok(c, 'POST', '/security/password', { current: j.temp_password, next: NEWPW }); return c;
}
let n = 0;
const mkProduct = async (extra = {}) => ok(owner, 'POST', '/m/products', { sku: 'T-' + (++n), title: 'Test item ' + n, seller_id: seller.id, category: 'toys', price: 10000, ...extra }, 201);
const approve = async p => { await ok(owner, 'POST', `/m/products/${p.id}/do/submit`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {}); };
const gen = (id, note) => call(owner, 'POST', `/m/products/${id}/do/ai_generate`, note ? { note } : {});

before(async () => {
  // a tiny OpenAI-compatible server, so the "real provider" code path is exercised without any network
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeReply) } }] }));
      if (req.url.endsWith('/embeddings')) {                                                // deterministic bag-of-words vectors
        const input = JSON.parse(b).input, vec = t => { const v = new Array(64).fill(0); for (const w of (String(t).toLowerCase().match(/[a-z0-9]{2,}/g) || [])) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64; v[h] += 1; } return v; };
        return res.end(JSON.stringify({ data: input.map(t => ({ embedding: vec(t) })) }));
      }
      if (req.url.endsWith('/images/generations')) return res.end(JSON.stringify({ data: [{ b64_json: PNG1 }] }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fakeReply = { title: 'x', seo_description: 'x', bullets: [], keywords: [], facts: [], confidence: 100 };
  T = await startServer({ AI_PROVIDER: 'openai', AI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, AI_DAILY_LIMIT: '5000' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  seller = await ok(owner, 'POST', '/m/sellers', { name: 'AI Shop', country: 'PL', legal_name: 'Jan Kowalski', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'ai.shop@example.com', address: 'ul. Prosta 1, Warszawa, PL', commission_bps: 1000 }, 201);
  for (const a of ['kyc_submit', 'kyc_approve', 'activate']) await ok(owner, 'POST', `/m/sellers/${seller.id}/do/${a}`, {});     // the real onboarding path: only active sellers can list
});
after(() => { if (T) T.stop(); if (fake) fake.close(); });

test('product identifiers and evidence are validated; AI fields cannot be set from a payload', async () => {
  const bad = (extra, code) => call(owner, 'POST', '/m/products', { sku: 'B-' + (++n), title: 'b', seller_id: seller.id, category: 'a', price: 100, ...extra }).then(r => { assert.equal(r.s, 400); assert.equal(r.j.error, code); });
  await bad({ barcode: '12ab' }, 'invalid_barcode');
  await bad({ data_sources: JSON.stringify([{ fact: 'f', source_type: 'url', source_ref: 'http://insecure.example/x' }]) }, 'invalid_data_sources');
  await bad({ data_sources: JSON.stringify([{ fact: 'f', source_type: 'url', source_ref: 'javascript:alert(1)' }]) }, 'invalid_data_sources');
  await bad({ data_sources: JSON.stringify([{ fact: 'f', source_type: 'telepathy' }]) }, 'invalid_data_sources');
  await bad({ human_verified: true }, 'read_only_human_verified');
  await bad({ ai_confidence: 100 }, 'read_only_ai_confidence');
  const p = await mkProduct({ barcode: '5901234567890', data_sources: JSON.stringify([{ fact: 'Кожа', source_type: 'url', source_ref: 'https://supplier.example/item/1' }]) });
  assert.equal(p.barcode, '5901234567890'); assert.equal(p.human_verified, 0); assert.equal(p.ai_status, 'none');
});

test('anti-hallucination: a fact citing evidence we never supplied is dropped, and the model cannot self-certify', async () => {
  const p = await mkProduct({ description: 'Short.' });                       // thin input → low completeness cap
  fakeReply = { title: 'Nice item', seo_description: 'A very nice item with a certificate of authenticity.', bullets: ['One'], keywords: ['nice'], confidence: 100,
    facts: [{ text: 'Category: toys', source_index: 0 }, { text: 'Certified by ISO 9001', source_index: 99 }, { text: 'Made of gold', source_index: -1 }] };
  const r = await gen(p.id); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.ai_status, 'generated'); assert.equal(r.j.human_verified, 0);
  assert.match(r.j.ai_flags, /unsupported_facts:2/);
  const src = JSON.parse(r.j.data_sources); assert.equal(src.length, 1); assert.equal(src[0].source_ref, 'field:category');
  assert.ok(r.j.ai_confidence <= 100 - 20 - 5, `confidence ${r.j.ai_confidence} must be capped by input completeness and lowered by the dropped facts`);
  assert.ok(r.j.ai_confidence < 100);
});

test('a card with no supported facts at all is flagged and scores low', async () => {
  const p = await mkProduct({ description: 'x'.repeat(200), brand: 'Acme' });
  fakeReply = { title: 'T', seo_description: 'Text without evidence', bullets: [], keywords: [], confidence: 100, facts: [] };
  const r = await gen(p.id); assert.match(r.j.ai_flags, /no_sources/); assert.ok(r.j.ai_confidence <= 70);
});

test('brand kit: banned words cap confidence; model failure marks the product failed and is not a 500', async () => {
  const kit = await ok(owner, 'POST', '/m/brand_kits', { name: 'Calm', tone: 'premium', banned_words: 'best ever, miracle' }, 201);
  await ok(owner, 'POST', `/m/brand_kits/${kit.id}/do/activate`, {});
  const p = await mkProduct({ description: 'y'.repeat(200), brand: 'Acme' });
  fakeReply = { title: 'The best ever item', seo_description: 'A miracle product', bullets: [], keywords: [], confidence: 95, facts: [{ text: 'Brand: Acme', source_index: 0 }] };
  const r = await gen(p.id); assert.match(r.j.ai_flags, /banned_words/); assert.ok(r.j.ai_confidence <= 60);
  fakeReply = 'not a card';                                                   // garbage from the model
  const f = await gen(p.id); assert.equal(f.s, 502); assert.equal(f.j.error, 'ai_failed');
  assert.equal((await ok(owner, 'GET', '/m/products/' + p.id)).ai_status, 'failed');
});

test('a live product stays on sale while its new card waits for a human; editing content un-verifies', async () => {
  const p = await mkProduct({ description: 'z'.repeat(200), brand: 'Acme' }); await approve(p);
  fakeReply = { title: 'Rewritten title', seo_description: 'Fresh description', bullets: [], keywords: [], confidence: 90, facts: [{ text: 'Brand: Acme', source_index: 0 }] };
  let r = await gen(p.id); assert.equal(r.j.status, 'approved'); assert.equal(r.j.title, p.title); assert.equal(r.j.seo_description, 'Fresh description');
  assert.equal((await call(owner, 'POST', `/m/products/${p.id}/do/unverify`, {})).s, 409);                   // nothing to un-verify yet
  r = await ok(owner, 'POST', `/m/products/${p.id}/do/verify`, {}); assert.equal(r.human_verified, 1); assert.equal(r.verified_by, 'alice');
  r = await ok(owner, 'PATCH', '/m/products/' + p.id, { seo_description: 'Edited by hand' }); assert.equal(r.human_verified, 0);   // a plain edit voids the previous check
  assert.equal((await call(owner, 'POST', `/m/products/${p.id}/do/verify`, {})).s, 200);
  const e = await ok(owner, 'POST', `/m/products/${p.id}/do/ai_edit`, { seo_description: 'Reviewer text' }); assert.equal(e.human_verified, 1); assert.equal(e.seo_description, 'Reviewer text');
  const q = await call(owner, 'POST', `/m/products/${p.id}/do/ai_reject`, {}); assert.equal(q.j.error, 'required_note');
});

test('review queue: least confident first, filtered by threshold; roles are respected', async () => {
  fakeReply = { title: 'T', seo_description: 'queue text', bullets: [], keywords: [], confidence: 100, facts: [{ text: 'Category: toys', source_index: 0 }] };
  for (const d of ['', 'v'.repeat(60), 'v'.repeat(200)]) await gen((await mkProduct(d ? { description: d, brand: 'Acme' } : {})).id);
  const q = await ok(owner, 'GET', '/ai/review/queue?max_conf=101&limit=100');
  const confs = q.rows.map(r => r.ai_confidence); assert.ok(confs.length >= 3);
  assert.deepEqual(confs, [...confs].sort((a, b) => a - b)); assert.ok(Array.isArray(q.rows[0].data_sources));
  assert.ok((await ok(owner, 'GET', '/ai/review/queue?max_conf=0')).rows.length === 0);
  const mod = await staff('mod', 'moderator'), l1 = await staff('l1', 'support_l1'), ana = await staff('ana', 'analyst');
  assert.equal((await call(mod, 'GET', '/ai/review/queue')).s, 200);
  assert.equal((await call(mod, 'POST', '/ai/batch', { kind: 'card', scope: 'unverified' })).s, 403);       // reviewing is not generating
  assert.equal((await call(mod, 'POST', '/ai/index')).s, 403);
  const row = q.rows[0];
  assert.equal((await call(mod, 'POST', `/m/products/${row.id}/do/verify`, {})).s, 200);
  assert.equal((await call(l1, 'GET', '/ai/overview')).s, 403); assert.equal((await call(l1, 'GET', '/ai/review/queue')).s, 403);
  assert.equal((await call(ana, 'GET', '/ai/overview')).s, 200); assert.equal((await call(ana, 'POST', `/m/products/${q.rows[1].id}/do/verify`, {})).s, 403);
  const nav = (await call(l1, 'GET', '/meta')).j.resources.map(r => r.name); assert.ok(!nav.includes('channels') && !nav.includes('brand_kits'));
});

test('batch generation records a job; the daily quota stops it cleanly instead of failing', async () => {
  for (let i = 0; i < 4; i++) await mkProduct({ description: 'w'.repeat(120), brand: 'Acme' });
  fakeReply = { title: 'T', seo_description: 'Batch text', bullets: [], keywords: [], confidence: 80, facts: [{ text: 'Brand: Acme', source_index: 0 }] };
  const r = await ok(owner, 'POST', '/ai/batch', { kind: 'card', scope: 'unverified', limit: 3 });
  assert.equal(r.done, 3); assert.equal(r.failed, 0); assert.equal(r.job.kind, 'card'); assert.equal(r.job.status, 'done');
  assert.equal((await call(owner, 'POST', '/ai/batch', { kind: 'card', scope: 'everything' })).j.error, 'invalid_scope');
  assert.equal((await call(owner, 'POST', '/ai/batch', { kind: 'card', ids: ['1'] })).j.error, 'invalid_ids');
  assert.equal((await call(owner, 'POST', '/ai/batch', { kind: 'localize', scope: 'verified', lang: 'xx' })).j.error, 'invalid_lang');
  const mon = await ok(owner, 'GET', '/ai/monitor'); assert.equal(mon.provider, 'openai'); assert.equal(mon.limit, 5000); assert.ok(mon.used_24h > 0);
  assert.ok(mon.by_kind.some(k => k.kind === 'card' && k.calls >= 3));
});

test('daily quota: calls over the limit get 429, and a batch stops cleanly with a partial job instead of failing', async () => {
  const T2 = await startServer({ AI_PROVIDER: 'openai', AI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, AI_DAILY_LIMIT: '2' });
  try {
    const o = new Client(T2.adminBase); await o.login('alice', 'correct-horse-battery');
    const sel = await ok(o, 'POST', '/m/sellers', { name: 'Q Shop', country: 'PL', legal_name: 'Jan Kowalski', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'q.shop@example.com', address: 'ul. Prosta 1, Warszawa, PL', commission_bps: 1000 }, 201);
    const ids = []; for (let i = 0; i < 4; i++) ids.push((await ok(o, 'POST', '/m/products', { sku: 'Q-' + i, title: 'q' + i, seller_id: sel.id, category: 'a', price: 100, description: 'd'.repeat(100) }, 201)).id);
    fakeReply = { title: 'T', seo_description: 'text', bullets: [], keywords: [], confidence: 80, facts: [{ text: 'Category: a', source_index: 0 }] };
    const b = await ok(o, 'POST', '/ai/batch', { kind: 'card', ids }); assert.equal(b.stopped, 'ai_quota'); assert.equal(b.done, 2); assert.notEqual(b.job.status, 'done');
    const over = await call(o, 'POST', `/m/products/${ids[3]}/do/ai_generate`, {}); assert.equal(over.s, 429); assert.equal(over.j.error, 'ai_quota');
    assert.equal((await ok(o, 'GET', '/ai/monitor')).used_24h, 2);
  } finally { T2.stop(); }
});

test('supplier CSV import: rows validated one by one, sources must be https, big files pass the body limit, SSRF is impossible by design', async () => {
  const csv = ['sku,title,category,price,cost,brand,barcode,source_url', 'IMP-1,Wallet,Accessories,39.90,18.5,Nordvik,5901234567890,https://supplier.example/i/1', 'IMP-2,Bad price,Accessories,abc,,,,', 'IMP-3,Bad url,Accessories,10,,,,http://internal.local/x', 'IMP-1,Duplicate,Accessories,5,,,,'].join('\n');
  const r = await ok(owner, 'POST', '/ai/import', { seller_id: seller.id, csv });
  assert.equal(r.imported, 1); assert.equal(r.failed, 3);
  assert.deepEqual(r.errors.map(e => e.error).sort(), ['duplicate', 'invalid_data_sources', 'invalid_price'].sort());
  const row = (await ok(owner, 'GET', '/m/products?q=IMP-1')).rows[0]; assert.equal(row.price, 3990); assert.equal(row.status, 'draft'); assert.equal(JSON.parse(row.data_sources)[0].source_type, 'url');
  const big = ['sku,title,category,price,description'].concat(Array.from({ length: 300 }, (_, i) => `BIG-${i},Item ${i},Toys,1.00,"${'d'.repeat(250)}"`)).join('\n');
  assert.ok(big.length > 64 * 1024); const rb = await ok(owner, 'POST', '/ai/import', { seller_id: seller.id, csv: big }); assert.equal(rb.imported, 300);
  assert.equal((await call(owner, 'POST', '/ai/import', { seller_id: seller.id, csv: 'sku,title\nA,B' })).j.error, 'csv_missing_category');
  assert.equal((await call(owner, 'POST', '/ai/import', { seller_id: seller.id, csv: 'sku,title,category,price\n' + Array.from({ length: 501 }, (_, i) => `R${i},t,c,1`).join('\n') })).j.error, 'too_many_rows');
  const mod = await staff('imp', 'moderator'); assert.equal((await call(mod, 'POST', '/ai/import', { seller_id: seller.id, csv })).s, 403);
});

test('search: delta indexing re-embeds only what changed; an exact SKU always ranks first', async () => {
  const a = await ok(owner, 'POST', '/ai/index'); assert.ok(a.indexed > 0);
  const b = await ok(owner, 'POST', '/ai/index'); assert.equal(b.indexed, 0); assert.equal(b.skipped, a.indexed + a.skipped);
  const p = await mkProduct({ title: 'Warm fleece running jacket', category: 'sport', description: 'Thermal fleece layer for autumn runs' });
  const c = await ok(owner, 'POST', '/ai/index'); assert.equal(c.indexed, 1);
  const r = await ok(owner, 'GET', '/ai/search?q=' + encodeURIComponent('fleece jacket for autumn running'));
  assert.equal(r.rows[0].id, p.id);
  const s = await ok(owner, 'GET', '/ai/search?q=' + encodeURIComponent(p.sku)); assert.equal(s.rows[0].id, p.id); assert.equal(s.rows[0].exact, true);
  assert.equal((await call(owner, 'GET', '/ai/search?q=')).s, 400);
});

test('canvas: graph is validated (tree, no cycles, bounded); run produces one image per node', async () => {
  const node = (id, type = 'prompt', x = 0) => ({ id, type, label: id, prompt: 'p ' + id, x, y: 0 });
  const mk = g => call(owner, 'POST', '/m/canvases', { title: 'c' + (++n), graph: JSON.stringify(g) });
  assert.equal((await mk({ nodes: [node('a'), node('b', 'style')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })).j.error, 'graph_cycle');
  assert.equal((await mk({ nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }] })).j.error, 'invalid_graph');   // two parents
  assert.equal((await mk({ nodes: [node('a'), node('a')], edges: [] })).j.error, 'invalid_graph');
  assert.equal((await mk({ nodes: [node('a', 'evil')], edges: [] })).j.error, 'invalid_graph');
  assert.equal((await mk({ nodes: [{ ...node('a'), prompt: 'x'.repeat(501) }], edges: [] })).j.error, 'invalid_graph');
  assert.equal((await mk({ nodes: Array.from({ length: 31 }, (_, i) => node('n' + i)), edges: [] })).j.error, 'invalid_graph');
  const c = await mk({ nodes: [node('a'), node('b', 'style', 300), node('c', 'angle', 300)], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] }); assert.equal(c.s, 201);
  const r = await ok(owner, 'POST', `/m/canvases/${c.j.id}/do/run`, {}); const res = JSON.parse(r.results);
  assert.deepEqual(Object.keys(res).sort(), ['a', 'b', 'c']); assert.equal(res.b.kind, 'file'); assert.ok(res.b.prompt.startsWith('p a. Style: p b'));
  assert.match(res.a.data, /^[a-f0-9]{32}$/);                                         // a generated picture is a stored private file, referenced by id
  const dl = await owner.req('GET', '/api/admin/files/' + res.a.data + '/download'); assert.equal(dl.status, 200); assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  assert.equal((await call(owner, 'PATCH', '/m/canvases/' + c.j.id, { results: '{}' })).j.error, 'read_only_results');
});

test('A/B test: no verdict without data, z-test picks a winner, a tie stays "none"', async () => {
  const p = await mkProduct(); const t = await ok(owner, 'POST', '/m/ab_tests', { product_id: p.id, name: 'cover' }, 201);
  assert.equal((await call(owner, 'POST', `/m/ab_tests/${t.id}/do/decide`, {})).j.error, 'not_enough_data');
  assert.equal((await call(owner, 'POST', `/m/ab_tests/${t.id}/do/add_stats`, { a_views: 10, a_clicks: 11 })).j.error, 'clicks_exceed_views');
  await ok(owner, 'POST', `/m/ab_tests/${t.id}/do/add_stats`, { a_views: 1000, a_clicks: 50, b_views: 1000, b_clicks: 90 });
  const d = await ok(owner, 'POST', `/m/ab_tests/${t.id}/do/decide`, {}); assert.equal(d.winner, 'b'); assert.equal(d.status, 'done');
  const t2 = await ok(owner, 'POST', '/m/ab_tests', { product_id: p.id, name: 'tie' }, 201);
  await ok(owner, 'POST', `/m/ab_tests/${t2.id}/do/add_stats`, { a_views: 500, a_clicks: 50, b_views: 500, b_clicks: 52 });
  assert.equal((await ok(owner, 'POST', `/m/ab_tests/${t2.id}/do/decide`, {})).winner, 'none');
  assert.equal((await call(owner, 'POST', `/m/ab_tests/${t.id}/do/add_stats`, { a_views: 1 })).j.error, 'bad_state');
});

test('channels: keys are sealed and masked; only approved AND verified products are synced; sync is flagged as simulated', async () => {
  const good = await mkProduct({ description: 'g'.repeat(150), brand: 'Acme' }), unverified = await mkProduct({ description: 'u'.repeat(150), brand: 'Acme' });
  for (const p of [good, unverified]) await approve(p);
  fakeReply = { title: 'T', seo_description: 'ok', bullets: [], keywords: [], confidence: 90, facts: [{ text: 'Brand: Acme', source_index: 0 }] };
  await gen(good.id); await ok(owner, 'POST', `/m/products/${good.id}/do/verify`, {});
  const ch = await ok(owner, 'POST', '/m/channels', { kind: 'allegro', name: 'Allegro', shop_url: 'https://allegro.pl/u/x', api_key: 'super-secret-token-123', status: 'active' }, 201);
  assert.ok(!JSON.stringify(ch).includes('super-secret-token-123')); assert.notEqual(ch.api_key, 'super-secret-token-123');
  assert.equal((await call(owner, 'POST', '/m/channels', { kind: 'allegro', name: 'x', shop_url: 'http://plain.example' })).j.error, 'invalid_shop_url');
  const s = await ok(owner, 'POST', `/m/channels/${ch.id}/do/sync`, {}); assert.equal(s.simulated, true); assert.ok(s.pushed >= 1); assert.ok(s.skipped_unverified >= 1);
  const l = (await ok(owner, 'GET', `/m/channel_listings?channel_id=${ch.id}&limit=200`)).rows.map(r => r.product_id);
  assert.ok(l.includes(good.id) && !l.includes(unverified.id));
  const draft = await ok(owner, 'POST', '/m/channels', { kind: 'shopify', name: 'Shopify' }, 201); assert.equal((await call(owner, 'POST', `/m/channels/${draft.id}/do/sync`, {})).j.error, 'bad_state');
  const mod = await staff('chm', 'moderator'); assert.equal((await call(mod, 'GET', '/m/channels')).s, 403);
});

test('markdown robot: needs a floor, steps down gently, never below floor/cost, one step per interval; elasticity and price deviation work', async () => {
  const wh = await ok(owner, 'POST', '/m/warehouses', { name: 'W', country: 'PL', priority: 1 }, 201);
  const mk = async (extra) => { const p = await mkProduct({ price: 10000, cost: 6000, ...extra }); await approve(p); await ok(owner, 'POST', '/m/stock', { product_id: p.id, warehouse_id: wh.id, qty: 50 }, 201); return p; };
  const withFloor = await mk({ min_price: 9600 }), noFloor = await mk({});
  let r = await ok(owner, 'POST', '/pricing/markdown', { dry: true });
  const mine = r.changes.find(c => c.product_id === withFloor.id); assert.equal(mine.new_price, 9600); assert.equal(mine.at_floor, true);       // −5% would be 9500; floor wins
  assert.ok(!r.changes.some(c => c.product_id === noFloor.id));                                                                              // no floor → untouched
  assert.equal((await ok(owner, 'GET', '/m/products/' + withFloor.id)).price, 10000);                                                          // dry run changes nothing
  r = await ok(owner, 'POST', '/pricing/markdown', { dry: false }); assert.ok(r.changes.some(c => c.product_id === withFloor.id));
  assert.equal((await ok(owner, 'GET', '/m/products/' + withFloor.id)).price, 9600);
  assert.ok((await ok(owner, 'GET', '/m/price_history?product_id=' + withFloor.id)).rows.some(x => x.reason === 'markdown'));
  r = await ok(owner, 'POST', '/pricing/markdown', { dry: false }); assert.ok(!r.changes.some(c => c.product_id === withFloor.id));            // too soon / already at floor
  const mk2 = await call(owner, 'POST', '/pricing/markdown', { step_bps: 999999 }); assert.equal(mk2.s, 200);                                    // clamped, not trusted
  const el = await ok(owner, 'GET', `/pricing/elasticity?product_id=${withFloor.id}&elasticity=-2`); assert.equal(el.rows.length, 6); assert.equal(el.rows.find(x => x.delta_pct === 0).price, 9600);
  assert.equal((await call(owner, 'GET', `/pricing/elasticity?product_id=${withFloor.id}&elasticity=abc`)).s, 400);
  for (const [i, price] of [10000, 10200, 9800, 1000].entries()) await mkProduct({ model_slug: 'dev-model', price, sku: 'DEV-' + i }).then(approve);
  const dev = await ok(owner, 'GET', '/compliance/price-deviation?pct=50'); assert.ok(dev.rows.some(x => x.price === 1000 && x.by === 'model'));
  const fin = await staff('fin', 'finance'); assert.equal((await call(fin, 'POST', '/pricing/markdown', { dry: true })).s, 200);
  const mod = await staff('prm', 'moderator'); assert.equal((await call(mod, 'POST', '/pricing/markdown', {})).s, 403);
});

test('function map: exactly 35 entries with honest statuses; the AI endpoints do not exist on the public listener', async () => {
  const { rows } = await ok(owner, 'GET', '/ai/functions'); assert.equal(rows.length, 35);
  assert.deepEqual(rows.map(r => r.n), Array.from({ length: 35 }, (_, i) => i + 1));
  assert.ok(rows.every(r => ['ready', 'new', 'sim'].includes(r.status) && r.title && r.nav));
  for (const p of ['/api/admin/ai/overview', '/api/admin/ai/functions', '/api/admin/ai/import', '/api/admin/pricing/markdown', '/api/ai/overview']) {
    for (const m of ['GET', 'POST']) { const r = await fetch(T.base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined }); assert.ok([400, 404].includes(r.status), `${m} ${p} → ${r.status} on the public port`); }
  }
});
