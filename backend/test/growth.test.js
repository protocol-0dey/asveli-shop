'use strict';
// New admin features: purchase price + markup, price guard + automatic maintenance, AI service catalog + model list + OpenRouter sign-in,
// AI analysis, competitor prices (only search-confirmed offers count), «Проверить все», translate-all, API keys + MCP for agents,
// carrier catalog + tariff guard + coverage, product feeds.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, Client } = require('./helpers');

let T, owner, fake, seller, n = 0, mode = {};
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const mk = extra => ok(owner, 'POST', '/m/products', { sku: 'G-' + (++n), title: 'Kubek ceramiczny ' + n, seller_id: seller.id, category: 'home', price: 4999, description: 'Kubek z ceramiki, 330 ml, biały, można myć w zmywarce. Wysokość 10 cm.', brand: 'Asveli', barcode: '590123456789' + (n % 10), ...extra }, 201);
const rawDb = () => new Database(path.join(T.dataDir, 'asveli.db'));

// one fake provider for everything OpenAI-compatible: /models, /chat/completions (incl. ":online" web search), OpenRouter key exchange
function fakeProvider() {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const send = (o, s = 200) => { res.statusCode = s; res.end(JSON.stringify(o)); };
      if (req.url === '/models') return send({ data: [{ id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama free', pricing: { prompt: '0', completion: '0' } }, { id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { input_modalities: ['text', 'image'] } }] });
      if (req.url === '/api/v1/auth/keys') { const j = JSON.parse(b); return j.code === 'good-code' && j.code_verifier && j.code_challenge_method === 'S256' ? send({ key: 'sk-or-v1-fake-key-from-oauth-000' }) : send({ error: 'bad' }, 403); }
      if (req.url === '/chat/completions') {
        const j = JSON.parse(b), sys = j.messages[0].content;
        if (/:online$/.test(j.model)) return send({ choices: [{ message: { content: JSON.stringify({ offers: [
          { platform: 'Allegro', title: 'Kubek ceramiczny 330 ml', price: 45.5, currency: 'EUR', url: 'https://allegro.pl/oferta/kubek-1', match: 'exact' },
          { platform: 'Amazon', title: 'Ceramic mug', price: 52, currency: 'EUR', url: 'https://www.amazon.de/dp/B000', match: 'exact' },
          { platform: 'Made up', title: 'Ghost offer', price: 1, currency: 'EUR', url: 'https://ghost.example/x', match: 'exact' }] }),
          annotations: [{ type: 'url_citation', url_citation: { url: 'https://allegro.pl/oferta/kubek-1', title: 'allegro' } }, { type: 'url_citation', url_citation: { url: 'https://www.amazon.de/dp/B000', title: 'amazon' } }] } }] });
        if (/строгий проверяющий/.test(sys)) return send({ choices: [{ message: { content: JSON.stringify(mode.verify || { ok: true, issues: [] }) } }] });
        if (/аналитик и редактор/.test(sys)) return send({ choices: [{ message: { content: JSON.stringify({ description: 'Biały kubek z ceramiki, 330 ml. Można myć w zmywarce.', story: 'Na poranną kawę.', bullets: ['330 ml'], price: 47.99, reasoning: 'nieco poniżej mediany' }) } }] });
        if (/Translate and localise/.test(sys)) { const src = JSON.parse(j.messages[1].content); return send({ choices: [{ message: { content: JSON.stringify({ title: 'T:' + src.title, description: 'D' }) } }] }); }
        return send({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] });
      }
      send({ error: 'not_found' }, 404);
    });
  });
}

before(async () => {
  fake = fakeProvider(); await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  T = await startServer({ AI_PROVIDER: 'mock', AI_ALLOW_PRIVATE_HOSTS: '1', AI_DAILY_LIMIT: '5000', AI_CATALOG_TEST_BASE: base, OPENROUTER_TEST_BASE: base, PLATFORM_CURRENCY: 'EUR', STORE_ORIGINS: 'https://asveli.example' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  seller = await ok(owner, 'POST', '/m/sellers', { name: 'G Shop', country: 'PL', legal_name: 'Jan Kowalski', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'g.shop@example.com', address: 'ul. Prosta 1, Warszawa, PL', commission_bps: 1000 }, 201);
  for (const a of ['kyc_submit', 'kyc_approve', 'activate']) await ok(owner, 'POST', `/m/sellers/${seller.id}/do/${a}`, {});
});
after(() => { if (T) T.stop(); if (fake) fake.close(); });

test('purchase price, supplier and markup: price follows cost + markup; the breakdown is shown with every product', async () => {
  const p = await mk({ cost: 2000, supplier_name: 'Hurtownia Kraków', supplier_url: 'https://hurt.example/kubek', markup_pct: 150, price_from_markup: true });
  assert.equal(p.price, 5000); assert.equal(p.profit, 3000); assert.equal(p.markup_actual_pct, 150); assert.equal(p.margin_pct, 60);
  const p2 = await ok(owner, 'PATCH', `/m/products/${p.id}`, { cost: 2400 }); assert.equal(p2.price, 6000);          // cost changes → price follows
  assert.equal((await call(owner, 'PATCH', `/m/products/${p.id}`, { cost: null })).j.error, 'markup_needs_cost');
  const list = await ok(owner, 'GET', '/m/products?limit=5'); assert.ok(list.rows.some(r => r.id === p.id && r.supplier_name === 'Hurtownia Kraków' && r.profit === 3600));
});

test('price guard: no zero prices and no ≥50 % cuts by hand without confirmation; a zero price in the data closes the shop', async () => {
  const p = await mk({ price: 10000 });
  assert.equal((await call(owner, 'PATCH', `/m/products/${p.id}`, { price: 0 })).j.error, 'price_guard');
  const cut = await call(owner, 'PATCH', `/m/products/${p.id}`, { price: 3000 }); assert.equal(cut.j.error, 'price_guard'); assert.equal(cut.j.min_allowed, 5000);
  assert.equal((await ok(owner, 'PATCH', `/m/products/${p.id}`, { price: 3000, price_confirm: true })).price, 3000);
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).price_confirm, 0, 'the confirmation is one-shot');
  // something (a bug, a bad import, an attacker with DB access) puts an approved product at 0 → incident → maintenance
  await ok(owner, 'POST', `/m/products/${p.id}/do/submit`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  const x = rawDb(); x.prepare('UPDATE m_products SET price=0 WHERE id=?').run(p.id); x.close();
  const s = await ok(owner, 'POST', '/guard/scan');
  assert.equal(s.maintenance, true); assert.equal(s.rule, 'price_zero'); assert.match(s.reason, /Цена 0/);
  const shop = await fetch(T.base + '/api/store/catalog'); assert.equal(shop.status, 503); assert.equal((await shop.json()).error, 'maintenance');
  assert.equal((await (await fetch(T.base + '/api/store/status')).json()).maintenance, true);
  assert.equal((await fetch(T.base + '/api/health')).status, 200, 'health stays up');
  // fixing the price does NOT reopen the shop by itself; a person does
  const y = rawDb(); y.prepare('UPDATE m_products SET price=10000 WHERE id=?').run(p.id); y.close();
  assert.equal((await ok(owner, 'POST', '/guard/scan')).maintenance, true);
  const open = await ok(owner, 'POST', '/guard/maintenance', { on: false }); assert.equal(open.maintenance, false); assert.equal(open.lifted_by, 'alice');
  assert.notEqual((await fetch(T.base + '/api/store/catalog')).status, 503);
});

test('AI service catalog: pick a service, models come from the live list (free ones first), keys are kept per service', async () => {
  const v0 = await ok(owner, 'GET', '/ai/settings'); assert.ok(v0.services.length >= 10); assert.ok(v0.services.find(s => s.id === 'openrouter').oauth);
  const m = await ok(owner, 'POST', '/ai/settings/models', { service: 'groq', apiKey: 'gsk_test_key_12345' });
  assert.equal(m.models[0].id, 'meta-llama/llama-3.3-70b-instruct:free'); assert.equal(m.models[0].free, true);
  let v = await ok(owner, 'PUT', '/ai/settings', { service: 'groq', apiKey: 'gsk_test_key_12345', model: 'meta-llama/llama-3.3-70b-instruct:free' });
  assert.equal(v.service, 'groq'); assert.equal(v.provider, 'openai'); assert.equal(v.embedModel, 'local'); assert.equal(v.has_key, true); assert.ok(!JSON.stringify(v).includes('gsk_test_key_12345'));
  assert.equal((await ok(owner, 'POST', '/ai/settings/test')).ok, true, 'chat via the service + built-in local search');
  v = await ok(owner, 'PUT', '/ai/settings', { service: 'mistral' }); assert.equal(v.has_key, false, 'another service does not inherit the key');
  v = await ok(owner, 'PUT', '/ai/settings', { service: 'groq' }); assert.equal(v.has_key, true, 'switching back restores the parked key');
  assert.equal((await call(owner, 'PUT', '/ai/settings', { service: 'nope' })).j.error, 'invalid_service');
});

test('OpenRouter one-click sign-in: PKCE, single-use state bound to the user; the key is saved and never shown', async () => {
  const st = await ok(owner, 'POST', '/ai/oauth/openrouter/start', { origin: T.adminBase.replace('localhost', 'localhost') });
  const u = new URL(st.url); assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.ok(u.searchParams.get('callback_url').startsWith(T.adminBase + '/admin/?or_state='));
  assert.equal((await call(owner, 'POST', '/ai/oauth/openrouter/start', { origin: 'https://evil.example/x' })).j.error, 'invalid_origin');
  assert.equal((await call(owner, 'POST', '/ai/oauth/openrouter/exchange', { state: st.state, code: 'bad-code' })).j.error, 'oauth_exchange_failed');
  assert.equal((await call(owner, 'POST', '/ai/oauth/openrouter/exchange', { state: st.state, code: 'good-code' })).j.error, 'oauth_state_invalid', 'state is single-use');
  const st2 = await ok(owner, 'POST', '/ai/oauth/openrouter/start', { origin: T.adminBase });
  const v = await ok(owner, 'POST', '/ai/oauth/openrouter/exchange', { state: st2.state, code: 'good-code' });
  assert.equal(v.service, 'openrouter'); assert.equal(v.has_key, true); assert.ok(!JSON.stringify(v).includes('fake-key-from-oauth'));
});

test('competitor prices: offers keep their links; only search-confirmed exact offers in our currency set competitor_price', async () => {
  await ok(owner, 'PUT', '/ai/settings', { service: 'openrouter', model: 'openai/gpt-4o-mini' });
  const p = await mk({ price: 4999, cost: 2500 });
  const r = await ok(owner, 'POST', `/m/products/${p.id}/do/competitors`);
  assert.equal(r.offers.length, 3);
  const ghost = r.offers.find(o => o.url.includes('ghost')); assert.equal(ghost.verified, false, 'a link the search never opened is not trusted');
  assert.equal(r.min, 4550); assert.equal(r.count_verified, 2);
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).competitor_price, 4550);
  const all = await ok(owner, 'GET', '/ai/competitors'); assert.equal(all.web, true); assert.ok(all.rows.find(x => x.id === p.id).verified === 2);
  // analysis uses those prices and never goes below cost + 10 %
  const a = JSON.parse((await ok(owner, 'POST', `/m/products/${p.id}/do/ai_analyze`)).ai_analysis);
  assert.equal(a.price.suggested, 4799); assert.equal(a.price.basis.competitor_median, 4550); assert.match(a.description, /ceramiki/);
  const applied = await ok(owner, 'POST', `/m/products/${p.id}/do/ai_apply`, { parts: 'description,story,price' });
  assert.equal(applied.price, 4799); assert.equal(applied.story, 'Na poranną kawę.'); assert.equal(applied.ai_status, 'generated'); assert.equal(applied.human_verified, 0, 'new text goes to the check queue');
});

test('«Проверить все»: cards without problems are confirmed automatically, the rest stay with reasons', async () => {
  const good = await mk({}), bad = await mk({});
  const x = rawDb();
  x.prepare("UPDATE m_products SET ai_status='generated', ai_confidence=90, seo_description=? WHERE id=?").run('Biały kubek z ceramiki o pojemności 330 ml. Można myć w zmywarce, wysokość 10 cm. Prosty kształt.', good.id);
  x.prepare("UPDATE m_products SET ai_status='generated', ai_confidence=90, seo_description=? WHERE id=?").run('Najlepszy kubek na świecie, gwarantowany cud dla każdego domu i biura, bez konkurencji.', bad.id);
  x.close();
  const r = await ok(owner, 'POST', '/ai/review/auto', { limit: 50 });
  const g = r.items.find(i => i.id === good.id), b = r.items.find(i => i.id === bad.id);
  assert.equal(g.ok, true); assert.equal(b.ok, false); assert.match(b.issues.join(' '), /обещания/);
  const gp = await ok(owner, 'GET', `/m/products/${good.id}`); assert.equal(gp.human_verified, 1); assert.match(gp.verified_by, /^AI-проверка · alice/);
  assert.match((await ok(owner, 'GET', `/m/products/${bad.id}`)).ai_flags, /автопроверка/);
});

test('translate everything: all cards × all shop languages, re-done only when the source text changes', async () => {
  let v = await ok(owner, 'PUT', '/ai/i18n', { langs: ['pl', 'en', 'de', 'uk'], source: 'pl' });
  assert.ok(v.pending >= 3);
  let r; do { r = await ok(owner, 'POST', '/ai/translate/all', { limit: 100 }); } while (r.left && r.done);
  assert.equal(r.left, 0);
  const tr = await ok(owner, 'GET', '/m/translations?limit=100&lang=uk'); assert.ok(tr.rows.length >= 1 && tr.rows.every(t => t.title.startsWith('T:')));
  const some = tr.rows[0];
  await ok(owner, 'PATCH', `/m/products/${some.product_id}`, { title: 'Nowy tytuł kubka' });
  v = await ok(owner, 'GET', '/ai/i18n'); assert.equal(v.pending, 3, 'only the changed card, in 3 target languages');
  assert.equal((await call(owner, 'PUT', '/ai/i18n', { langs: ['xx'] })).j.error, 'invalid_langs');
});

test('API keys + MCP: an agent works through the admin with its role; secrets, staff and revoked keys are refused', async () => {
  const k = await ok(owner, 'POST', '/apikeys', { name: 'Antigravity', role: 'catalog_manager', days: 30 }, 201);
  assert.match(k.token, /^asv_/); assert.ok(!JSON.stringify(await ok(owner, 'GET', '/apikeys')).includes(k.token), 'shown once, stored as a hash');
  const mcp = (body, token = k.token) => fetch(T.adminBase + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const init = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'asveli-admin');
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = (await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools;
  assert.ok(tools.find(t => t.name === 'update_record') && tools.find(t => t.name === 'check_all_cards'));
  const p = await mk({});
  const upd = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_record', arguments: { resource: 'products', id: p.id, fields: { supplier_name: 'Agent Supplier' } } } })).json();
  assert.equal(upd.result.isError, false); assert.equal(JSON.parse(upd.result.content[0].text).supplier_name, 'Agent Supplier');
  const guard = await (await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_record', arguments: { resource: 'products', id: p.id, fields: { price: 0 } } } })).json();
  assert.equal(guard.result.isError, true); assert.match(guard.result.content[0].text, /price_guard/, 'the price guard applies to agents too');
  const secret = await (await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'admin_api', arguments: { method: 'GET', path: '/ai/settings' } } })).json();
  assert.equal(secret.result.isError, true); assert.match(secret.result.content[0].text, /403/);
  const staff = await (await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'admin_api', arguments: { method: 'GET', path: '/staff' } } })).json();
  assert.equal(staff.error.code, -32602);
  // REST with the same key; no cookie → no CSRF token needed
  const rest = await fetch(T.adminBase + '/api/admin/m/products?limit=1', { headers: { Authorization: 'Bearer ' + k.token } }); assert.equal(rest.status, 200);
  assert.equal((await fetch(T.adminBase + '/api/admin/apikeys', { headers: { Authorization: 'Bearer ' + k.token } })).status, 403, 'a key cannot manage keys');
  const owner_key = await ok(owner, 'POST', '/apikeys', { name: 'Owner agent', role: 'owner' }, 201);
  assert.equal((await fetch(T.adminBase + '/api/admin/data/settings', { headers: { Authorization: 'Bearer ' + owner_key.token } })).status, 403, 'even an owner-role key gets no secrets');
  const audit = await ok(owner, 'GET', '/audit'); assert.ok(JSON.stringify(audit).includes('api:Antigravity'));
  await ok(owner, 'DELETE', '/apikeys/' + k.id);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).status, 401);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, 'asv_' + 'x'.repeat(43))).status, 401);
});

test('logistics: carriers from the catalog start switched off; a carrier without a tariff cannot be switched on; coverage shows gaps', async () => {
  let s = await ok(owner, 'GET', '/logistics/setup'); assert.ok(s.catalog.find(c => c.id === 'inpost'));
  const c = await ok(owner, 'POST', '/logistics/carriers/preset', { id: 'inpost' }, 201);
  assert.equal(c.active, 0); assert.match(c.tracking_url, /inpost\.pl/);
  assert.equal((await call(owner, 'PATCH', `/m/carriers/${c.id}`, { active: true })).j.error, 'carrier_needs_tariff');
  await ok(owner, 'POST', '/m/warehouses', { name: 'Kraków', country: 'PL', priority: 1, ships_to: 'PL' }, 201);
  await ok(owner, 'PATCH', `/m/carriers/${c.id}`, { base_cost: 1299, per_kg_cost: 100, active: true });
  s = await ok(owner, 'GET', '/logistics/setup');
  const pl = s.coverage.find(x => x.country === 'PL'), de = s.coverage.find(x => x.country === 'DE');
  assert.equal(pl.status, 'ok'); assert.equal(pl.carrier.cost_1kg, 1399); assert.equal(de.status, 'no_warehouse');
  assert.equal((await call(owner, 'POST', '/logistics/carriers/preset', { id: 'inpost' })).s, 409);
});

test('product feeds: Google / Ceneo / CSV behind a secret URL, only products on sale', async () => {
  const p = await mk({ title: 'Kubek & spodek <b>', price: 3999 });
  await ok(owner, 'POST', `/m/products/${p.id}/do/submit`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  const v = await ok(owner, 'PUT', '/feeds', { link_base: 'https://asveli.com' });
  assert.equal((await fetch(`${T.base}/feeds/wrong-token-000000000000/google.xml`)).status, 404);
  const g = await (await fetch(`${T.base}/feeds/${v.token}/google.xml`)).text();
  assert.match(g, /<g:price>39\.99 EUR<\/g:price>/); assert.match(g, /Kubek &amp; spodek &lt;b&gt;/); assert.match(g, /https:\/\/asveli\.com\/p\//);
  const ce = await (await fetch(`${T.base}/feeds/${v.token}/ceneo.xml`)).text(); assert.match(ce, /price="39\.99"/);
  const csv = await (await fetch(`${T.base}/feeds/${v.token}/products.csv`)).text(); assert.match(csv.split('\n')[0], /^id,title/);
  const old = v.token, r = await ok(owner, 'POST', '/feeds/rotate'); assert.notEqual(r.token, old);
  assert.equal((await fetch(`${T.base}/feeds/${old}/google.xml`)).status, 404);
});
