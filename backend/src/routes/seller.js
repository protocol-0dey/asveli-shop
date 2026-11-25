'use strict';
// Seller Central API (public listener, seller bearer tokens). A seller sees and changes ONLY rows of their own seller_id — every query is scoped in SQL.
// Money and compliance stay with staff: KYC approval, product moderation, campaign activation, payout approval and stock receiving all happen in the admin panel.
const express = require('express');
const { db } = require('../db');
const R = require('../engine/resource');
const { E, HttpError } = require('../engine/errors');
const sec = require('../security');
const compliance = require('../services/compliance');
const C = require('../services/common');
const A = require('../store/auth');
const cat = require('../store/catalog');

const router = express.Router();
const { wrap } = A;
const CC = /^[A-Z]{2}$/;
const sellerOf = req => {
  const a = db.prepare('SELECT a.*, s.org_id FROM s_seller_accounts a JOIN m_sellers s ON s.id=a.seller_id WHERE a.id=?').get(req.sellerAccountId); if (!a || !a.org_id) throw new HttpError(401, 'auth_required');
  return { a, id: a.seller_id, org: a.org_id };   // org = tenant, id = workspace (store); both go into every query
};
const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const pid = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw E.bad('invalid_id'); return n; };

function mine(org, sellerId, productId) {
  const p = db.prepare('SELECT * FROM m_products WHERE id=? AND org_id=? AND seller_id=?').get(productId, org, sellerId);   // ownership in SQL: another seller's id simply "doesn't exist"
  if (!p) throw E.notFound(); return p;
}
function productView(p) {
  const st = db.prepare('SELECT COALESCE(SUM(qty),0) qty, COALESCE(SUM(reserved),0) reserved FROM m_stock WHERE product_id=?').get(p.id);
  const inbound = db.prepare("SELECT COALESCE(SUM(qty),0) n FROM m_inbound WHERE product_id=? AND status='requested'").get(p.id).n;
  return { id: p.id, sku: p.sku, title: p.title, category: p.category, description: p.description, brand: p.brand, model_slug: cat.modelSlugOf(p), images: cat.parseImages(p.images),
    price: p.price, cost: p.cost, min_price: p.min_price, max_price: p.max_price, competitor_price: p.competitor_price, auto_reprice: !!p.auto_reprice, weight_g: p.weight_g,
    hs_code: p.hs_code, origin_country: p.origin_country, digital: !!p.digital, digital_file: !!p.digital_file, status: p.status, moderation_note: p.moderation_note, compliance_flags: p.compliance_flags,
    barcode: p.barcode, external_id: p.external_id, sale_regions: trust.parseList(p.sale_regions), manufacturer_name: p.manufacturer_name, manufacturer_address: p.manufacturer_address,
    manufacturer_email: p.manufacturer_email, manufacturer_country: p.manufacturer_country, responsible_eu: trust.parseParty(p.responsible_eu), responsible_uk: trust.parseParty(p.responsible_uk),
    responsible_us: trust.parseParty(p.responsible_us), safety_info: p.safety_info, brand_proof: p.brand_proof, brand_proof_status: p.brand_proof_status,
    stock: { qty: st.qty, reserved: st.reserved, available: st.qty - st.reserved, inbound }, created_at: p.created_at };
}
const EDITABLE = ['title', 'category', 'description', 'brand', 'price', 'cost', 'min_price', 'max_price', 'auto_reprice', 'weight_g', 'hs_code', 'origin_country', 'model_slug', 'images', 'digital',
  'barcode', 'external_id', 'sale_regions', 'manufacturer_name', 'manufacturer_address', 'manufacturer_email', 'manufacturer_country', 'responsible_eu', 'responsible_uk', 'responsible_us', 'safety_info', 'brand_proof'];
const trust = require('../services/trust');
const PARTY = ['responsible_eu', 'responsible_uk', 'responsible_us'];
function pick(body, keys) {
  const out = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  if (Array.isArray(out.images)) out.images = JSON.stringify(out.images);          // the API takes an array, the column stores JSON
  if (Array.isArray(out.sale_regions)) out.sale_regions = out.sale_regions.join(',');
  for (const k of PARTY) if (out[k] && typeof out[k] === 'object') out[k] = JSON.stringify(out[k]);
  if (out.model_slug === '') out.model_slug = null;
  return out;
}

/* ---------- auth ---------- */
router.post('/api/seller/auth/register', A.authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const email = A.checkEmail(b.email), password = A.checkPassword(b.password);
  const name = typeof b.store_name === 'string' ? b.store_name.trim() : '', cc = typeof b.country === 'string' ? b.country.toUpperCase() : '';
  if (name.length < 2 || name.length > 120) throw E.bad('invalid_store_name');
  if (!CC.test(cc)) throw E.bad('invalid_country');
  const bi = sec.blindIndex(email);
  if (db.prepare('SELECT 1 FROM s_seller_accounts WHERE email_bi=?').get(bi)) throw E.conflict('email_taken');
  const hash = await sec.hashPassword(password);
  const id = db.transaction(() => {
    const s = R.create('sellers', null, { name, country: cc, email, origin: 'portal' }, req, { internal: true });   // starts as onboarding / kyc not_submitted: nothing can be sold yet; portal sellers are always trust-gated
    return Number(db.prepare('INSERT INTO s_seller_accounts(seller_id,email_bi,pass_hash,created_at) VALUES(?,?,?,?)').run(s.id, bi, hash, Date.now()).lastInsertRowid);
  })();
  res.status(201).json({ token: A.issue('seller', id) });
}));
router.post('/api/seller/auth/login', A.authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.email !== 'string' || typeof b.password !== 'string') throw E.bad('invalid');
  const row = await A.checkLogin('s_seller_accounts', sec.blindIndex(b.email), b.password);
  if (!row) throw new HttpError(401, 'invalid_credentials');
  res.json({ token: A.issue('seller', row.id) });
}));
router.post('/api/seller/auth/logout', wrap((req, res) => { const t = A.bearer(req); if (t) db.prepare('DELETE FROM s_tokens WHERE hash=?').run(sec.sha256(t)); res.status(204).end(); }));

/* ---------- account / KYC ---------- */
const IDENTITY = ['legal_name', 'tax_id', 'passport_no', 'bank_iban', 'registry_name', 'registration_no'];
function me(sellerId) {
  const s = db.prepare('SELECT * FROM m_sellers WHERE id=?').get(sellerId);
  const view = R.present(R.get('sellers'), s, null);                           // personal fields come back MASKED (iban •••• 1234), never in clear
  const strikes = db.prepare('SELECT level, reason, region, product_id, created_at FROM m_seller_strikes WHERE seller_id=? ORDER BY id DESC LIMIT 20').all(s.id);
  return {
    id: s.id, name: s.name, country: s.country, status: s.status, kyc_status: s.kyc_status, kyc_note: s.kyc_note, risk_tier: s.risk_tier, commission_bps: s.commission_bps,
    profile: { legal_name: view.legal_name, email: view.email, phone: view.phone, address: view.address, tax_id: view.tax_id, passport_no: view.passport_no, bank_iban: view.bank_iban,
      registry_name: s.registry_name, registration_no: s.registration_no, vat_no: s.vat_no, own_brands: s.own_brands },
    trust: { kyb: trust.sellerKyb(s), open_regions: trust.config().open_regions, blocked_regions: trust.parseList(s.blocked_regions), listing_ban_until: s.listing_ban_until || null,
      payouts_hold: !!s.payouts_hold, strikes },                               // every sanction comes with its reason (DSA statement of reasons)
    balance: C.sellerBalance(s.id), pending_payouts: C.pendingPayouts(s.id), currency: require('../config').currency
  };
}
router.get('/api/seller/me', A.seller, wrap((req, res) => res.json(me(sellerOf(req).id))));
router.put('/api/seller/profile', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), b = req.body || {}, s = db.prepare('SELECT kyc_status FROM m_sellers WHERE id=?').get(id);
  const data = {};
  for (const k of ['legal_name', 'phone', 'address', 'tax_id', 'passport_no', 'bank_iban', 'registry_name', 'registration_no', 'vat_no', 'own_brands']) if (b[k] !== undefined && b[k] !== '') data[k] = b[k];
  if (typeof b.name === 'string' && b.name.trim()) data.name = b.name.trim();
  if (['pending', 'approved'].includes(s.kyc_status) && IDENTITY.some(k => k in data)) throw E.conflict('kyc_locked');      // identity/bank data is frozen once verification started
  if (!Object.keys(data).length) throw E.bad('nothing_to_update');
  R.update('sellers', id, null, data, req, { internal: true });
  res.json(me(id));
}));
router.post('/api/seller/kyc/submit', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), row = db.prepare('SELECT * FROM m_sellers WHERE id=?').get(id);
  if (!['not_submitted', 'rejected'].includes(row.kyc_status)) throw E.conflict('bad_state');
  // DSA art. 30(1)(e): the seller declares they will only offer products that comply with the law — an explicit tick, recorded with its time
  if ((req.body || {}).self_certification !== true) throw E.bad('self_certification_required');
  for (const k of ['legal_name', 'tax_id', 'passport_no', 'bank_iban', 'phone', 'address']) if (!row[k]) throw E.bad('missing_' + k);
  R.update('sellers', id, null, { kyc_status: 'pending', kyc_note: null, self_cert_at: Date.now() }, req, { internal: true });
  res.json(me(id));
}));
// yearly: "my data is unchanged" (or update the profile first, which needs a new KYC round for identity fields)
router.post('/api/seller/kyc/recertify', A.seller, wrap((req, res) => {
  const { id } = sellerOf(req), row = db.prepare('SELECT * FROM m_sellers WHERE id=?').get(id);
  if (row.kyc_status !== 'approved') throw E.conflict('kyc_required');
  if ((req.body || {}).confirm_unchanged !== true || (req.body || {}).self_certification !== true) throw E.bad('confirmation_required');
  const t = Date.now();
  const patch = { self_cert_at: t, recert_due_at: t + trust.config().recert_days * 864e5 };
  if (row.status === 'suspended' && row.kyc_note === 'recertification overdue') { patch.status = 'active'; patch.kyc_note = null; }   // only the recert suspension lifts itself
  R.update('sellers', id, null, patch, req, { internal: true });
  res.json(me(id));
}));

/* ---------- catalogue ---------- */
router.get('/api/seller/warehouses', A.seller, wrap((_req, res) => res.json({ items: db.prepare('SELECT id, name, country FROM m_warehouses WHERE active=1 ORDER BY priority, id').all() })));
router.get('/api/seller/models', A.seller, wrap((req, res) => {       // find an existing product page to attach your offer to
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
  res.json({ items: cat.search({ q, limit: 10 }).items.map(m => ({ slug: m.slug, title: m.title, brand: m.brand, category: m.category, image: m.image, offers: m.offers })) });
}));
router.get('/api/seller/products', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), st = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = db.prepare(`SELECT * FROM m_products WHERE org_id=? AND seller_id=? ${st ? 'AND status=?' : ''} ORDER BY id DESC LIMIT 500`).all(...(st ? [org, id, st] : [org, id]));
  res.json({ items: rows.map(productView) });
}));
router.post('/api/seller/products', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), b = req.body || {};
  if (typeof b.sku !== 'string') throw E.bad('invalid_sku');
  const data = { ...pick(b, EDITABLE), sku: `${id}-${b.sku}`.slice(0, 64), seller_id: id };            // SKU is namespaced per seller: nobody can squat another seller's SKU
  const p = R.create('products', null, data, req, { internal: true });
  res.status(201).json(productView(db.prepare('SELECT * FROM m_products WHERE id=?').get(p.id)));
}));
router.patch('/api/seller/products/:id', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), p = mine(org, id, pid(req.params.id));
  if (['delisted'].includes(p.status)) throw E.conflict('bad_state');
  const data = pick(req.body || {}, EDITABLE);
  if (!Object.keys(data).length) throw E.bad('nothing_to_update');
  R.update('products', p.id, null, data, req, { internal: true });            // hooks run: price history, drastic price move / content change → back to moderation
  cat.invalidate();
  res.json(productView(db.prepare('SELECT * FROM m_products WHERE id=?').get(p.id)));
}));
router.post('/api/seller/products/:id/submit', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), p = mine(org, id, pid(req.params.id));
  if (!['draft', 'rejected'].includes(p.status)) throw E.conflict('bad_state');
  const s = db.prepare('SELECT * FROM m_sellers WHERE id=?').get(id);
  if (s.status !== 'active') throw E.conflict('seller_not_active');
  if (s.listing_ban_until && s.listing_ban_until > Date.now()) throw E.conflict('listing_ban', { until: s.listing_ban_until });
  if (trust.sellerKyb(s).recert_overdue) throw E.conflict('recertification_overdue');
  // the trust gate: no copied photos, at least one region with everything it needs. The answer says exactly what is missing where.
  const bad = trust.foreignImages(p.images);
  if (bad.length) throw E.conflict('foreign_photos', { photos: bad.slice(0, 8) });
  const st = trust.productRegions(p, s);
  if (!st.requested.length) throw E.conflict('no_sale_regions', { available: trust.config().open_regions });
  if (!st.ready.length) throw E.conflict('no_region_ready', { regions: st.regions });
  const { block, review } = compliance.scan(p);
  const patch = block.length ? { status: 'rejected', moderation_note: 'auto: запрещено', compliance_flags: 'ban: ' + block.join(', ').slice(0, 150) }
    : { status: 'pending_review', moderation_note: null, compliance_flags: review.length ? 'review: ' + review.join(', ').slice(0, 150) : null };
  R.update('products', p.id, null, patch, req, { internal: true });
  res.json(productView(db.prepare('SELECT * FROM m_products WHERE id=?').get(p.id)));
}));
/* ---------- messages from buyers (through the platform; no contact details either way) ---------- */
const inq = () => require('../services/inquiries');
router.get('/api/seller/inquiries', A.seller, wrap((req, res) => res.json({ items: inq().listFor('seller_id=?', [sellerOf(req).id], 'seller') })));
router.get('/api/seller/inquiries/:id', A.seller, wrap((req, res) => res.json(inq().view(inq().forSeller(sellerOf(req).id, req.params.id), 'seller'))));
router.post('/api/seller/inquiries/:id/messages', A.seller, wrap((req, res) => {
  const id = inq().forSeller(sellerOf(req).id, req.params.id); inq().addMessage(id, 'seller', (req.body || {}).body, 'seller'); res.status(201).json(inq().view(id, 'seller'));
}));
router.get('/api/seller/products/:id/readiness', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), p = mine(org, id, pid(req.params.id)), s = db.prepare('SELECT * FROM m_sellers WHERE id=?').get(id);
  res.json({ foreign_photos: trust.foreignImages(p.images), brand_proof_needed: trust.needsBrandProof(p, s), open_regions: trust.config().open_regions, ...trust.productRegions(p, s) });
}));
router.post('/api/seller/products/:id/delist', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), p = mine(org, id, pid(req.params.id));
  if (!['approved', 'pending_review'].includes(p.status)) throw E.conflict('bad_state');
  R.update('products', p.id, null, { status: 'delisted' }, req, { internal: true }); cat.invalidate();
  res.json(productView(db.prepare('SELECT * FROM m_products WHERE id=?').get(p.id)));
}));
// stock enters the platform only through an inbound shipment that staff receive in the admin panel
router.post('/api/seller/products/:id/inbound', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), p = mine(org, id, pid(req.params.id)), b = req.body || {};
  if (p.digital) throw E.conflict('digital_has_no_stock');
  R.create('inbound', null, { seller_id: id, product_id: p.id, warehouse_id: b.warehouse_id, qty: b.qty, ...(b.note ? { note: String(b.note).slice(0, 200) } : {}) }, req, { internal: true });
  res.status(201).json(productView(p));
}));
router.get('/api/seller/inbound', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req);
  res.json({ items: db.prepare(`SELECT i.id, i.product_id, p.title, i.warehouse_id, w.name warehouse, i.qty, i.status, i.created_at FROM m_inbound i JOIN m_products p ON p.id=i.product_id JOIN m_warehouses w ON w.id=i.warehouse_id
    WHERE i.org_id=? AND i.seller_id=? ORDER BY i.id DESC LIMIT 200`).all(org, id) });
}));

/* ---------- orders (no buyer personal data is ever exposed to sellers) ---------- */
router.get('/api/seller/orders', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = db.prepare(`SELECT o.code, o.status, o.country, o.created_at, i.product_id, p.title, i.qty, i.unit_price, i.commission, i.tax, i.returned_qty,
      (SELECT sh.status FROM m_shipments sh WHERE sh.order_id=o.id AND sh.warehouse_id=i.warehouse_id LIMIT 1) shipment
    FROM m_order_items i JOIN m_orders o ON o.id=i.order_id JOIN m_products p ON p.id=i.product_id
    WHERE i.org_id=? AND i.seller_id=? ${status ? 'AND o.status=?' : ''} ORDER BY o.id DESC LIMIT 300`).all(...(status ? [org, id, status] : [org, id]));
  res.json({ items: rows.map(r => ({ ...r, gross: r.unit_price * r.qty, net: r.unit_price * r.qty - r.commission })) });
}));

/* ---------- analytics ---------- */
router.get('/api/seller/analytics', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), days = int(req.query.days, 30, 7, 365), since = Date.now() - days * 864e5;
  const daily = db.prepare(`SELECT strftime('%Y-%m-%d', o.created_at/1000, 'unixepoch') d, COUNT(DISTINCT o.id) orders, SUM(i.qty) units, SUM(i.unit_price*i.qty) revenue
    FROM m_order_items i JOIN m_orders o ON o.id=i.order_id WHERE i.org_id=? AND i.seller_id=? AND o.created_at>? AND o.status NOT IN ('cancelled') GROUP BY d ORDER BY d`).all(org, id, since);
  const top = db.prepare(`SELECT p.id, p.title, SUM(i.qty) units, SUM(i.unit_price*i.qty) revenue,
      (SELECT COUNT(*) FROM s_views v WHERE v.product_id=p.id AND v.ts>?) views
    FROM m_order_items i JOIN m_orders o ON o.id=i.order_id JOIN m_products p ON p.id=i.product_id
    WHERE i.org_id=? AND i.seller_id=? AND o.created_at>? AND o.status NOT IN ('cancelled') GROUP BY p.id ORDER BY revenue DESC LIMIT 10`).all(since, org, id, since)
    .map(r => ({ ...r, conversion: r.views ? Math.round(r.units / r.views * 1000) / 10 : null }));
  const totals = daily.reduce((t, d) => ({ orders: t.orders + d.orders, units: t.units + d.units, revenue: t.revenue + d.revenue }), { orders: 0, units: 0, revenue: 0 });
  const rating = db.prepare("SELECT AVG(r.rating) a, COUNT(*) n FROM m_reviews r JOIN m_products p ON p.id=r.product_id WHERE p.org_id=? AND p.seller_id=? AND r.status='published'").get(org, id);
  const returns = db.prepare('SELECT COUNT(*) n FROM m_returns r JOIN m_products p ON p.id=r.product_id WHERE p.org_id=? AND p.seller_id=? AND r.created_at>?').get(org, id, since).n;
  const low = db.prepare(`SELECT p.id, p.title, COALESCE(SUM(st.qty - st.reserved),0) available FROM m_products p LEFT JOIN m_stock st ON st.product_id=p.id
    WHERE p.org_id=? AND p.seller_id=? AND p.status='approved' AND p.digital=0 GROUP BY p.id HAVING available <= 5 ORDER BY available LIMIT 10`).all(org, id);
  const sold30 = db.prepare("SELECT p.id, SUM(i.qty) q FROM m_order_items i JOIN m_orders o ON o.id=i.order_id JOIN m_products p ON p.id=i.product_id WHERE i.org_id=? AND i.seller_id=? AND o.created_at>? AND o.status<>'cancelled' GROUP BY p.id").all(org, id, Date.now() - 30 * 864e5);
  const velocity = new Map(sold30.map(r => [r.id, r.q / 30]));
  const forecast = low.map(l => ({ ...l, days_left: velocity.get(l.id) ? Math.floor(l.available / velocity.get(l.id)) : null }));   // simple sell-through forecast: stock ÷ average daily sales
  res.json({ days, totals, daily, top, rating: rating.n ? { avg: Math.round(rating.a * 10) / 10, count: rating.n } : null, returns, low_stock: forecast, currency: require('../config').currency });
}));

/* ---------- money (read-only except payout requests) ---------- */
router.get('/api/seller/finance', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req);
  res.json({ balance: C.sellerBalance(id), pending_payouts: C.pendingPayouts(id),
    ledger: db.prepare("SELECT id, kind, amount, note, created_at FROM m_ledger WHERE org_id=? AND seller_id=? AND kind IN ('sale','refund','payout','advance','advance_repay','adjustment') ORDER BY id DESC LIMIT 100").all(org, id),
    payouts: db.prepare('SELECT id, amount, status, repay, created_at FROM m_payouts WHERE org_id=? AND seller_id=? ORDER BY id DESC LIMIT 50').all(org, id) });
}));
router.post('/api/seller/payouts', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), b = req.body || {};
  if (db.prepare('SELECT payouts_hold FROM m_sellers WHERE id=?').get(id).payouts_hold) throw E.conflict('payouts_on_hold');   // sanction level 4: money waits for the returns window
  const p = R.create('payouts', null, { seller_id: id, amount: b.amount }, req, { internal: true });         // balance, KYC and bank account are re-checked by the payout rules; staff approve with two keys
  res.status(201).json({ id: p.id, status: p.status, amount: p.amount });
}));

/* ---------- advertising (drafts only: staff activate after the budget is confirmed) ---------- */
router.get('/api/seller/campaigns', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req);
  res.json({ items: db.prepare('SELECT c.*, p.title product FROM m_campaigns c LEFT JOIN m_products p ON p.id=c.product_id WHERE c.org_id=? AND c.seller_id=? ORDER BY c.id DESC LIMIT 100').all(org, id)
    .map(c => ({ id: c.id, name: c.name, product_id: c.product_id, product: c.product, budget: c.budget, cpc: c.cpc, spent: c.spent, impressions: c.impressions, clicks: c.clicks, orders: c.orders, revenue: c.revenue, status: c.status,
      ctr: c.impressions ? Math.round(c.clicks / c.impressions * 1000) / 10 : null, roas: c.spent ? Math.round(c.revenue * 100 / c.spent) / 100 : null })) });
}));
router.post('/api/seller/campaigns', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), b = req.body || {}, p = mine(org, id, pid(b.product_id));
  if (p.status !== 'approved') throw E.conflict('product_not_approved');
  const c = R.create('campaigns', null, { name: b.name, seller_id: id, product_id: p.id, budget: b.budget, cpc: b.cpc }, req, { internal: true });
  res.status(201).json({ id: c.id, status: c.status });
}));
router.post('/api/seller/campaigns/:id/pause', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), cid = pid(req.params.id);
  const c = db.prepare('SELECT * FROM m_campaigns WHERE id=? AND org_id=? AND seller_id=?').get(cid, org, id); if (!c) throw E.notFound();
  if (c.status !== 'active') throw E.conflict('bad_state');
  R.update('campaigns', cid, null, { status: 'paused' }, req, { internal: true });
  res.json({ id: cid, status: 'paused' });
}));
router.post('/api/seller/campaigns/:id/resume', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req), cid = pid(req.params.id);
  const c = db.prepare('SELECT * FROM m_campaigns WHERE id=? AND org_id=? AND seller_id=?').get(cid, org, id); if (!c) throw E.notFound();
  if (c.status !== 'paused' || c.spent >= c.budget) throw E.conflict('bad_state');
  R.update('campaigns', cid, null, { status: 'active' }, req, { internal: true });
  res.json({ id: cid, status: 'active' });
}));

router.get('/api/seller/reviews', A.seller, wrap((req, res) => {
  const { id, org } = sellerOf(req);
  res.json({ items: db.prepare("SELECT r.id, r.rating, r.body, r.created_at, p.title FROM m_reviews r JOIN m_products p ON p.id=r.product_id WHERE p.org_id=? AND p.seller_id=? AND r.status='published' ORDER BY r.id DESC LIMIT 100").all(org, id) });
}));

module.exports = router;
