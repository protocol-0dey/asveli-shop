'use strict';
// Trust & safety for a global marketplace: seller KYB + self-certification, per-region product readiness (GPSR responsible person,
// manufacturer, own photos, brand proof), region-aware storefront and checkout, buyer reports, sanctions ladder, yearly re-certification.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
let n = 0;
// a portal seller that has passed KYB and been activated by staff
async function verifiedSeller(country = 'PL') {
  n++;
  const token = (await api('POST', '/api/seller/auth/register', { json: { email: `trust${n}@example.com`, password: 'longenough-pass-1', store_name: 'Trust Shop ' + n, country } })).body.token;
  const p = await api('PUT', '/api/seller/profile', { token, json: { legal_name: 'Trust Shop Sp. z o.o.', phone: '+48500100200', address: 'ul. Prosta 1, 00-001 Warszawa, PL', tax_id: 'PL5250000000',
    passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', registry_name: 'KRS', registration_no: '0000123456', vat_no: 'PL5250000000', own_brands: 'TrustBrand' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await api('POST', '/api/seller/kyc/submit', { token, json: {} })).body.error, 'self_certification_required');
  assert.equal((await api('POST', '/api/seller/kyc/submit', { token, json: { self_certification: true } })).status, 200);
  const id = (await api('GET', '/api/seller/me', { token })).body.id;
  await ok(owner, 'POST', `/m/sellers/${id}/do/kyc_approve`, {});
  await ok(owner, 'POST', `/m/sellers/${id}/do/activate`, {});
  return { token, id };
}
const base = sku => ({ sku, title: 'Folia stretch 23 mic', category: 'Opakowania', description: 'Folia stretch do owijania palet, 23 mikrony.', price: 3890, weight_g: 3000,
  images: ['https://cdn.example.com/folia.jpg'], barcode: '5901234123457', manufacturer_name: 'Guangzhou Pack Co.', manufacturer_address: '1 Industrial Rd, Guangzhou, CN',
  manufacturer_email: 'export@gzpack.example', manufacturer_country: 'CN' });
const RESP = { name: 'EU Rep GmbH', address: 'Hauptstr. 1, 10115 Berlin, DE', email: 'gpsr@eurep.example' };

before(async () => {
  T = await startServer({ SESSION_SECRET: 'test-session-secret-0123456789abcdef-xyz', DATA_ENCRYPTION_KEY: 'test-data-key-0123456789abcdef-0123456789', JOBS: '0' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  raw = new Database(path.join(T.dataDir, 'asveli.db'));
});
after(() => { if (raw) raw.close(); if (T) T.stop(); });

test('a portal seller must self-certify; approval starts the yearly re-certification clock', async () => {
  const { token } = await verifiedSeller();
  const me = (await api('GET', '/api/seller/me', { token })).body;
  assert.equal(me.trust.kyb.verified, true);
  assert.ok(me.trust.kyb.recert_due_at > Date.now() + 360 * 864e5);
  assert.deepEqual(me.trust.open_regions, ['EU']);
});

test('a listing is held back until one region has everything it needs, and the error says what is missing', async () => {
  const { token, id } = await verifiedSeller('CN');                       // seller AND manufacturer outside the EU → an EU responsible person is required
  const p = (await api('POST', '/api/seller/products', { token, json: base('F1') })).body;
  let r = await api('POST', `/api/seller/products/${p.id}/submit`, { token, json: {} });
  assert.equal(r.body.error, 'no_sale_regions');
  await api('PATCH', `/api/seller/products/${p.id}`, { token, json: { sale_regions: ['EU', 'US'] } });
  r = await api('POST', `/api/seller/products/${p.id}/submit`, { token, json: {} });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'no_region_ready');
  assert.ok(r.body.regions.EU.missing.includes('responsible_eu'), 'a Chinese manufacturer needs an EU responsible person');
  assert.ok(r.body.regions.US.missing.includes('region_closed'), 'the US is not opened by staff yet');
  // copied marketplace photos are refused outright
  await api('PATCH', `/api/seller/products/${p.id}`, { token, json: { images: ['https://m.media-amazon.com/images/I/61P2FgyWC1L._AC_SL1500_.jpg'] } });
  r = await api('POST', `/api/seller/products/${p.id}/submit`, { token, json: {} });
  assert.equal(r.body.error, 'foreign_photos');
  await api('PATCH', `/api/seller/products/${p.id}`, { token, json: { images: ['https://cdn.example.com/folia.jpg'], responsible_eu: RESP } });
  const ready = (await api('GET', `/api/seller/products/${p.id}/readiness`, { token })).body;
  assert.deepEqual(ready.ready, ['EU']);
  r = await api('POST', `/api/seller/products/${p.id}/submit`, { token, json: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'pending_review');
  await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  // the storefront: sold to Germany (EU) with the trader and GPSR blocks, not sold to the US
  const slug = (await api('GET', '/api/seller/products', { token })).body.items.find(x => x.id === p.id).model_slug;
  const de = (await api('GET', `/api/store/models/${slug}?country=DE`)).body.offers.find(o => o.product_id === p.id);
  assert.equal(de.sold_in_country, true);
  assert.equal(de.seller.trader.name, 'Trust Shop Sp. z o.o.');
  assert.equal(de.seller.trader.registration_no, '0000123456');
  assert.equal(de.product_safety.responsible_person.name, 'EU Rep GmbH');
  assert.equal(de.product_safety.manufacturer.name, 'Guangzhou Pack Co.');
  const us = (await api('GET', `/api/store/models/${slug}?country=US`)).body.offers.find(o => o.product_id === p.id);
  assert.equal(us.sold_in_country, false); assert.equal(us.ships_to_country, false);
  const q = (await api('POST', '/api/store/quote', { json: { items: [{ product_id: p.id, qty: 1 }], country: 'US' } })).body;
  assert.ok(q.issues.some(i => i.code === 'not_sold_in_country'));
  assert.ok(id);
});

test("someone else's brand needs a verified proof; the seller's own brand does not", async () => {
  const { token } = await verifiedSeller();
  const mk = async (sku, brand) => (await api('POST', '/api/seller/products', { token, json: { ...base(sku), brand, sale_regions: 'EU', responsible_eu: RESP } })).body;
  const own = await mk('B1', 'TrustBrand'), other = await mk('B2', 'Razer');
  assert.equal((await api('POST', `/api/seller/products/${own.id}/submit`, { token, json: {} })).status, 200);
  let r = await api('POST', `/api/seller/products/${other.id}/submit`, { token, json: {} });
  assert.ok(r.body.regions.EU.missing.includes('brand_proof'));
  await api('PATCH', `/api/seller/products/${other.id}`, { token, json: { brand_proof: 'https://docs.example.com/razer-distributor.pdf' } });
  r = await api('POST', `/api/seller/products/${other.id}/submit`, { token, json: {} });
  assert.ok(r.body.regions.EU.missing.includes('brand_proof_unverified'));
  await ok(owner, 'POST', `/m/products/${other.id}/do/brand_proof_verify`, {});
  assert.equal((await api('POST', `/api/seller/products/${other.id}/submit`, { token, json: {} })).status, 200);
});

test('anyone can report a listing; staff see it, the e-mail stays encrypted', async () => {
  const { token } = await verifiedSeller();
  const p = (await api('POST', '/api/seller/products', { token, json: { ...base('R1'), sale_regions: 'EU', responsible_eu: RESP } })).body;
  await api('POST', `/api/seller/products/${p.id}/submit`, { token, json: {} });
  await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  assert.equal((await api('POST', '/api/store/report', { json: { product_id: p.id, reason: 'counterfeit', details: 'short' } })).body.error, 'details_too_short');
  const r = await api('POST', '/api/store/report', { json: { product_id: p.id, reason: 'counterfeit', details: 'The logo is wrong and the box has no CE mark.', email: 'buyer@example.com' } });
  assert.equal(r.status, 201);
  const row = raw.prepare('SELECT * FROM m_reports WHERE id=?').get(r.body.id);
  assert.equal(row.status, 'open'); assert.ok(!String(row.reporter_email).includes('buyer@example.com'), 'stored encrypted');
  const list = await ok(owner, 'GET', '/m/reports');
  assert.ok(list.rows.some(x => x.id === r.body.id));
});

test('sanctions ladder: region stop hides the offer there, level 4 blocks the account and holds payouts', async () => {
  const { token, id } = await verifiedSeller();
  const p = (await api('POST', '/api/seller/products', { token, json: { ...base('S1'), sale_regions: 'EU', responsible_eu: RESP } })).body;
  await api('POST', `/api/seller/products/${p.id}/submit`, { token, json: {} });
  await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  assert.equal((await call(owner, 'POST', `/m/sellers/${id}/do/strike`, { level: '3', reason: 'no CE documents' })).j.error, 'region_required');
  await ok(owner, 'POST', `/m/sellers/${id}/do/strike`, { level: '3', reason: 'no CE documents', region: 'EU' });
  const q = (await api('POST', '/api/store/quote', { json: { items: [{ product_id: p.id, qty: 1 }], country: 'DE' } })).body;
  assert.ok(q.issues.some(i => i.code === 'not_sold_in_country'), 'blocked in the EU');
  const me = (await api('GET', '/api/seller/me', { token })).body;
  assert.deepEqual(me.trust.blocked_regions, ['EU']); assert.equal(me.trust.strikes[0].reason, 'no CE documents');
  await ok(owner, 'POST', `/m/sellers/${id}/do/strike`, { level: '4', reason: 'counterfeit confirmed' });
  assert.equal(raw.prepare('SELECT status, payouts_hold FROM m_sellers WHERE id=?').get(id).payouts_hold, 1);
  assert.equal(raw.prepare('SELECT status FROM m_products WHERE id=?').get(p.id).status, 'delisted');
});

test('an overdue yearly re-certification suspends a portal seller; re-certifying lifts it', async () => {
  const { token, id } = await verifiedSeller();
  raw.prepare('UPDATE m_sellers SET recert_due_at=? WHERE id=?').run(Date.now() - 2 * 864e5, id);
  let s = await ok(owner, 'POST', '/trust/recert-scan', {});
  assert.equal(raw.prepare('SELECT status FROM m_sellers WHERE id=?').get(id).status, 'active', 'warned inside the grace period');
  assert.ok(s.warned >= 1);
  raw.prepare('UPDATE m_sellers SET recert_due_at=? WHERE id=?').run(Date.now() - 30 * 864e5, id);
  s = await ok(owner, 'POST', '/trust/recert-scan', {});
  assert.equal(raw.prepare('SELECT status FROM m_sellers WHERE id=?').get(id).status, 'suspended');
  assert.equal((await api('POST', '/api/seller/kyc/recertify', { token, json: { confirm_unchanged: true } })).body.error, 'confirmation_required');
  assert.equal((await api('POST', '/api/seller/kyc/recertify', { token, json: { confirm_unchanged: true, self_certification: true } })).status, 200);
  assert.equal(raw.prepare('SELECT status FROM m_sellers WHERE id=?').get(id).status, 'active');
});

test('opening a region is a staff setting; the house catalogue stays ungated unless switched on', async () => {
  assert.equal((await call(owner, 'PUT', '/trust/config', { open_regions: ['EU', 'XX'] })).s, 400);
  const c = await ok(owner, 'PUT', '/trust/config', { open_regions: ['EU', 'UK'] });
  assert.deepEqual(c.open_regions, ['EU', 'UK']);
  const cfg = await ok(owner, 'GET', '/trust/config');
  assert.equal(cfg.enforce_all, false); assert.ok(cfg.regions.US);
});
