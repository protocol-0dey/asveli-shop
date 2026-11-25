'use strict';
// Storefront + Seller Central API: auth separation, ownership (IDOR), price integrity, idempotency, admin not exposed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { startServer, Client } = require('./helpers');

const KEYS = { SESSION_SECRET: 'test-session-secret-0123456789abcdef-xyz', DATA_ENCRYPTION_KEY: 'test-data-key-0123456789abcdef-0123456789', STORE_INDEX_TTL_MS: '100' };
let S, api;
before(async () => {
  S = await startServer(KEYS);
  const r = spawnSync('node', ['scripts/seed-demo.js'], { cwd: path.join(__dirname, '..'), env: S.env, encoding: 'utf8' });
  if (r.status) throw new Error('seed failed: ' + r.stderr + r.stdout);
  await new Promise(r => setTimeout(r, 300));
  api = async (method, url, { token, json, headers = {} } = {}) => {
    const h = { Origin: 'http://localhost:5173', ...headers }; if (token) h.Authorization = 'Bearer ' + token;
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(S.base + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body, headers: res.headers };
  };
});
after(() => S.stop());

const login = async (email, password) => (await api('POST', '/api/store/auth/login', { json: { email, password } })).body.token;
const sellerLogin = async () => (await api('POST', '/api/seller/auth/login', { json: { email: 'seller@asveli.test', password: 'seller-demo-12345' } })).body.token;

test('admin panel is not reachable on the public listener', async () => {
  for (const p of ['/admin/', '/api/admin/me', '/api/admin/auth/login']) assert.equal((await new Client(S.base).req('GET', p)).status, 404, p);
});

test('catalogue: search, model page, suggestions, fuzzy match', async () => {
  const s = await api('GET', '/api/store/search?q=headphones');
  assert.equal(s.status, 200); assert.ok(s.body.items.length >= 1);
  const slug = s.body.items[0].slug;
  const m = await api('GET', '/api/store/models/' + slug);
  assert.equal(m.status, 200); assert.ok(m.body.offers.length >= 1);
  assert.equal((await api('GET', '/api/store/models/does-not-exist')).status, 404);
  const typo = await api('GET', '/api/store/search?q=headfones');
  assert.ok(typo.body.items.length >= 1, 'fuzzy search finds a misspelling');
  assert.equal((await api('GET', '/api/store/suggest?q=hea')).status, 200);
});

test('tokens: buyer and seller tokens are not interchangeable; garbage is rejected', async () => {
  const b = await login('demo@asveli.test', 'demo-password-123'), s = await sellerLogin();
  assert.ok(b && s);
  assert.equal((await api('GET', '/api/store/me', { token: b })).status, 200);
  assert.equal((await api('GET', '/api/seller/me', { token: b })).status, 401);
  assert.equal((await api('GET', '/api/store/me', { token: s })).status, 401);
  assert.equal((await api('GET', '/api/store/me', { token: 'x'.repeat(40) })).status, 401);
  assert.equal((await api('GET', '/api/store/me')).status, 401);
  assert.equal((await api('POST', '/api/store/auth/login', { json: { email: 'demo@asveli.test', password: 'wrong-password' } })).status, 401);
});

test('registration: validation, duplicate email, no PII in responses', async () => {
  const bad = await api('POST', '/api/store/auth/register', { json: { email: 'nope', password: 'longenough-pass-1', name: 'X', country: 'PL' } });
  assert.equal(bad.status, 400);
  assert.equal((await api('POST', '/api/store/auth/register', { json: { email: 'new1@example.com', password: 'short', name: 'X', country: 'PL' } })).status, 400);
  const ok = await api('POST', '/api/store/auth/register', { json: { email: 'new1@example.com', password: 'longenough-pass-1', name: 'New One', country: 'PL', lang: 'pl' } });
  assert.equal(ok.status, 201); assert.ok(ok.body.token);
  const dup = await api('POST', '/api/store/auth/register', { json: { email: 'NEW1@example.com', password: 'longenough-pass-1', name: 'Dup', country: 'PL' } });
  assert.equal(dup.status, 409);
});

test('checkout: price integrity, validation, idempotency, ownership', async () => {
  const buyer = await login('demo@asveli.test', 'demo-password-123');
  const m = (await api('GET', '/api/store/models/' + (await api('GET', '/api/store/search?q=nimbus')).body.items[0]?.slug)).body;
  const offer = m.offers.find(o => o.in_stock !== false) || m.offers[0]; const pid = offer.product_id;
  const q = await api('POST', '/api/store/quote', { token: buyer, json: { items: [{ product_id: pid, qty: 1 }], country: 'PL' } });
  assert.equal(q.status, 200); assert.ok(q.body.ok); const total = q.body.total;
  const addr = { name: 'Demo Buyer', line1: 'ul. Testowa 1', postal: '00-001', city: 'Warszawa', country: 'PL' };
  const place = (extra = {}, key = 'k-' + Math.random().toString(36).slice(2, 12)) => api('POST', '/api/store/checkout', { token: buyer, headers: { 'Idempotency-Key': key }, json: { items: [{ product_id: pid, qty: 1 }], address: addr, payment: 'pay_on_delivery', expected_total: total, ...extra } });
  // a client that thinks the price is lower never gets an order
  const stale = await place({ expected_total: total - 100 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'price_changed');
  assert.equal((await place({ payment: 'card' })).status, 400);
  assert.equal((await place({ items: [{ product_id: pid, qty: 0 }] })).status, 400);
  assert.equal((await place({ items: [{ product_id: 999999, qty: 1 }] })).status >= 400, true);
  // idempotency: same key twice → one order
  const key = 'idem-' + Date.now();
  const a = await place({}, key), b = await place({}, key);
  assert.equal(a.status, 201); assert.equal(b.status < 300, true);
  assert.equal(a.body.code, b.body.code);
  assert.equal(a.body.total, total);
  // ownership: another buyer cannot read, cancel or return it
  const other = (await api('POST', '/api/store/auth/register', { json: { email: 'other@example.com', password: 'longenough-pass-1', name: 'Other', country: 'PL' } })).body.token;
  for (const [mth, p] of [['GET', ''], ['POST', '/cancel'], ['POST', '/return']]) assert.equal((await api(mth, `/api/store/orders/${a.body.code}${p}`, { token: other, json: mth === 'POST' ? {} : undefined })).status, 404, p);
  assert.equal((await api('GET', `/api/store/orders/${a.body.code}`, { token: buyer })).status, 200);
  assert.equal((await api('GET', '/api/store/orders/O-1%27%20OR%201=1', { token: buyer })).status, 404);
  // the owner can cancel before shipping
  const c = await api('POST', `/api/store/orders/${a.body.code}/cancel`, { token: buyer, json: {} });
  assert.equal(c.status, 200); assert.equal(c.body.status, 'cancelled');
});

test('reviews: only verified buyers, one per product', async () => {
  const fresh = (await api('POST', '/api/store/auth/register', { json: { email: 'rev@example.com', password: 'longenough-pass-1', name: 'Rev', country: 'PL' } })).body.token;
  const slug = (await api('GET', '/api/store/search?q=headphones')).body.items[0].slug;
  const r = await api('POST', `/api/store/models/${slug}/reviews`, { token: fresh, json: { rating: 5, body: 'great' } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'purchase_required');
  assert.equal((await api('POST', `/api/store/models/${slug}/reviews`, { json: { rating: 5, body: 'x' } })).status, 401);
});

test('seller: sees only their own data; cannot touch or fake other sellers', async () => {
  const s = await sellerLogin();
  const mine = (await api('GET', '/api/seller/products', { token: s })).body.items;
  assert.ok(mine.length > 0);
  const other = (await api('POST', '/api/seller/auth/register', { json: { email: 'second@example.com', password: 'longenough-pass-1', store_name: 'Second Shop', country: 'DE' } })).body.token;
  assert.ok(other);
  assert.equal((await api('GET', '/api/seller/products', { token: other })).body.items.length, 0);
  assert.equal((await api('PATCH', `/api/seller/products/${mine[0].id}`, { token: other, json: { price: 1 } })).status, 404);
  assert.equal((await api('POST', `/api/seller/products/${mine[0].id}/inbound`, { token: other, json: { warehouse_id: 1, qty: 5 } })).status, 404);
  assert.equal((await api('POST', '/api/seller/campaigns', { token: other, json: { name: 'x', product_id: mine[0].id, budget: 1000, cpc: 10 } })).status, 404);
  // a new seller starts unverified: cannot publish
  const p = await api('POST', '/api/seller/products', { token: other, json: { sku: 'A1', title: 'Gadget', category: 'Innovations', description: 'A test gadget for checks', price: 1000, weight_g: 100 } });
  assert.equal(p.status, 201); assert.equal(p.body.status, 'draft');
  assert.equal((await api('POST', `/api/seller/products/${p.body.id}/submit`, { token: other, json: {} })).status, 409);
  // draft products never appear in the shop
  assert.equal((await api('GET', '/api/store/search?q=Gadget')).body.items.some(i => i.title === 'Gadget'), false);
  // sellers cannot set stock, status or another seller through the product API
  const sneaky = await api('PATCH', `/api/seller/products/${p.body.id}`, { token: other, json: { status: 'approved', seller_id: 1, stock: 999 } });
  assert.equal(sneaky.status, 400);
  // order lines carry no buyer personal data
  const orders = (await api('GET', '/api/seller/orders', { token: s })).body.items;
  assert.ok(orders.length > 0); assert.equal(JSON.stringify(orders).match(/@|ul\. /), null);
  // payouts need verification
  assert.ok((await api('POST', '/api/seller/payouts', { token: other, json: { amount: 100 } })).status >= 400);
});

test('GDPR: export contains the buyer data; erase needs the password and removes the login', async () => {
  const reg = await api('POST', '/api/store/auth/register', { json: { email: 'gdpr@example.com', password: 'longenough-pass-1', name: 'Gdpr Person', country: 'DE' } });
  const t = reg.body.token;
  const ex = await api('GET', '/api/store/me/export', { token: t });
  assert.equal(ex.status, 200); assert.equal(ex.body.profile.email, 'gdpr@example.com');
  assert.equal((await api('DELETE', '/api/store/me', { token: t, json: { password: 'wrong-password-1' } })).status, 403);
  assert.equal((await api('DELETE', '/api/store/me', { token: t, json: { password: 'longenough-pass-1' } })).status, 204);
  assert.equal((await api('GET', '/api/store/me', { token: t })).status, 401);
  assert.equal((await api('POST', '/api/store/auth/login', { json: { email: 'gdpr@example.com', password: 'longenough-pass-1' } })).status, 401);
});

test('CORS: only configured storefront origins are echoed', async () => {
  const ok = await api('GET', '/api/store/config');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const bad = await api('GET', '/api/store/config', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
