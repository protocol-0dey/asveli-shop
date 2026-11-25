'use strict';
// Multi-tenancy: org_id is kept consistent by the database itself, seller routes filter by it, and tenants cannot reach each other.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, Client } = require('./helpers');

let T, owner, raw;
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const api = async (method, url, { token, json } = {}) => {
  const h = { Origin: 'http://localhost:5173' }; if (token) h.Authorization = 'Bearer ' + token; if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(T.base + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  let body = null; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
const reg = async (n) => (await api('POST', '/api/seller/auth/register', { json: { email: `org${n}@example.com`, password: 'longenough-pass-1', store_name: 'Org Shop ' + n, country: 'PL' } })).body.token;
const sellerId = async t => (await api('GET', '/api/seller/me', { token: t })).body.id;

before(async () => {
  T = await startServer({ SESSION_SECRET: 'test-session-secret-0123456789abcdef-xyz', DATA_ENCRYPTION_KEY: 'test-data-key-0123456789abcdef-0123456789' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  const f = fs.readdirSync(T.dataDir).find(x => x === 'asveli.db');
  raw = new Database(path.join(T.dataDir, f));
});
after(() => { if (raw) raw.close(); if (T) T.stop(); });

test('every new store gets its own organisation; tenant tables carry a consistent org_id', async () => {
  const a = await reg(1), b = await reg(2), ia = await sellerId(a), ib = await sellerId(b);
  const oa = raw.prepare('SELECT org_id FROM m_sellers WHERE id=?').get(ia).org_id, ob = raw.prepare('SELECT org_id FROM m_sellers WHERE id=?').get(ib).org_id;
  assert.ok(oa && ob && oa !== ob);
  assert.equal(raw.prepare('SELECT org_id FROM s_seller_accounts WHERE seller_id=?').get(ia).org_id, oa);
  const p = await api('POST', '/api/seller/products', { token: a, json: { sku: 'T1', title: 'Org item', category: 'toys', description: 'A test item for tenancy', price: 1000, weight_g: 50 } });
  assert.equal(p.status, 201);
  assert.equal(raw.prepare('SELECT org_id FROM m_products WHERE id=?').get(p.body.id).org_id, oa, 'org_id is filled from the seller on insert');
});

test('database refuses a mismatching org_id and moving rows between tenants', async () => {
  const a = await reg(3), b = await reg(4), ia = await sellerId(a), ib = await sellerId(b);
  const oa = raw.prepare('SELECT org_id FROM m_sellers WHERE id=?').get(ia).org_id, ob = raw.prepare('SELECT org_id FROM m_sellers WHERE id=?').get(ib).org_id;
  const now = Date.now();
  const ins = (org, seller) => raw.prepare("INSERT INTO m_products(sku,title,seller_id,org_id,category,price,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run('RAW-' + Math.random(), 't', seller, org, 'c', 100, 'draft', now, now);
  assert.throws(() => ins(ob, ia), /tenant_mismatch/);                                   // row says tenant B, store belongs to A
  const id = Number(ins(oa, ia).lastInsertRowid);
  assert.throws(() => raw.prepare('UPDATE m_products SET org_id=? WHERE id=?').run(ob, id), /tenant_immutable/);
  assert.throws(() => raw.prepare('UPDATE m_products SET seller_id=? WHERE id=?').run(ib, id), /tenant_immutable/);
  assert.throws(() => raw.prepare('UPDATE m_sellers SET org_id=? WHERE id=?').run(ob, ia), /tenant_immutable/);
  raw.prepare('UPDATE m_products SET price=200 WHERE id=?').run(id);                      // ordinary edits still work
  // legacy-style row without org_id gets it from the seller
  const nul = Number(raw.prepare("INSERT INTO m_ledger(seller_id,kind,amount,created_at,updated_at) VALUES(?,?,?,?,?)").run(ia, 'adjustment', 1, now, now).lastInsertRowid);
  assert.equal(raw.prepare('SELECT org_id FROM m_ledger WHERE id=?').get(nul).org_id, oa);
});

test('two stores of ONE organisation share a tenant but a stranger sees neither', async () => {
  const org = await ok(owner, 'POST', '/m/orgs', { name: 'Holding' }, 201);
  const s1 = await ok(owner, 'POST', '/m/sellers', { name: 'Holding PL', country: 'PL', org_id: org.id }, 201);
  const s2 = await ok(owner, 'POST', '/m/sellers', { name: 'Holding DE', country: 'DE', org_id: org.id }, 201);
  assert.equal(raw.prepare('SELECT org_id FROM m_sellers WHERE id=?').get(s1.id).org_id, org.id);
  assert.equal(raw.prepare('SELECT org_id FROM m_sellers WHERE id=?').get(s2.id).org_id, org.id);
  const r = await call(owner, 'PATCH', `/m/sellers/${s1.id}`, { org_id: 1 }); assert.ok(r.s >= 400, 'org_id cannot be changed through the API');
  const stranger = await reg(5);
  assert.equal((await api('GET', '/api/seller/products', { token: stranger })).body.items.length, 0);
});

test('seller routes: foreign ids behave as non-existent, lists contain only own rows', async () => {
  const a = await reg(6), b = await reg(7);
  const pa = (await api('POST', '/api/seller/products', { token: a, json: { sku: 'X1', title: 'Mine', category: 'toys', description: 'Item of tenant six', price: 500, weight_g: 10 } })).body;
  assert.equal((await api('GET', '/api/seller/products', { token: b })).body.items.length, 0);
  for (const [m, u] of [['PATCH', `/api/seller/products/${pa.id}`], ['POST', `/api/seller/products/${pa.id}/submit`], ['POST', `/api/seller/products/${pa.id}/delist`]])
    assert.equal((await api(m, u, { token: b, json: { price: 1 } })).status, 404, u);
  assert.equal((await api('GET', '/api/seller/products', { token: a })).body.items.length, 1);
});

test('lint: every seller-route query on a tenant table is scoped by org_id', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/seller.js'), 'utf8');
  const TENANT = /\b(m_products|m_order_items|m_inbound|m_ledger|m_payouts|m_campaigns|m_advances)\b/;
  const ALLOW = [/FROM m_products WHERE id=\?'\)\.get\((p|id)\.id\)/, /FROM m_products WHERE id=\?'\)\.get\(p\.id\)/, /FROM m_stock/, /FROM m_inbound WHERE product_id=\?/];  // re-reads after mine(), child rows of an owned product
  const bad = [];
  for (const m of src.matchAll(/db\.prepare\((`[^`]*`|'[^']*'|"[^"]*")\)/g)) {
    const q = m[1]; if (!TENANT.test(q) || /org_id=\?/.test(q)) continue;
    if (ALLOW.some(r => r.test(src.slice(m.index, m.index + q.length + 40)))) continue;
    bad.push(q.slice(0, 90));
  }
  assert.deepEqual(bad, [], 'queries without org_id: ' + bad.join(' | '));
});
