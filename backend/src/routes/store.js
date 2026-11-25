'use strict';
// PUBLIC storefront API for buyers: catalogue, search, product pages, accounts, cart quote, checkout, orders, reviews.
// Admin code is not involved: orders go through the order service in-process, never through the admin HTTP API.
const express = require('express');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { db, audit } = require('../db');
const R = require('../engine/resource');
const { E, HttpError } = require('../engine/errors');
const sec = require('../security');
const orders = require('../services/orders');
const pers = require('../services/personalization');
const A = require('../store/auth');
const cat = require('../store/catalog');
const co = require('../store/checkout');

const router = express.Router();
const { wrap } = A;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const LANGS = ['en', 'pl', 'de', 'ru'];
const intq = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });

function cors(req, res, next) {
  const o = req.headers.origin;
  if (o && (cfg.storeOrigins.includes(o) || cfg.publicOrigins.includes(o))) { res.set('Access-Control-Allow-Origin', o); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS').set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Anon-Id, Idempotency-Key').set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
router.use(['/api/store', '/api/seller'], cors);

/* ---------- catalogue ---------- */
router.get('/api/store/config', (_req, res) => {
  const countries = db.prepare('SELECT country FROM m_tax_rates WHERE active=1 ORDER BY country').all().map(r => r.country);
  res.json({ currency: cfg.currency, languages: LANGS, countries: countries.length ? countries : ['PL', 'DE', 'FR', 'ES', 'IT', 'NL', 'CZ', 'LT', 'US', 'GB'], payments: co.PAYMENTS });
});

function anonBanners() {
  const t = Date.now();
  return db.prepare('SELECT * FROM m_banners WHERE active=1 AND segment_id IS NULL ORDER BY priority ASC, id DESC').all()
    .filter(b => (!b.starts_at || t >= b.starts_at) && (!b.ends_at || t <= b.ends_at)).map(b => ({ id: b.id, placement: b.placement, title: b.title, text: b.text, link: b.link }));
}
router.get('/api/store/home', A.buyerOptional, wrap((req, res) => {
  const v = cat.viewerKey(req);
  let banners = anonBanners(), segments = [];
  if (req.accountId) {
    const a = db.prepare('SELECT customer_id FROM s_accounts WHERE id=?').get(req.accountId);
    const p = a && pers.forCustomer(a.customer_id);
    if (p) { banners = p.banners; segments = p.segments.map(s => s.name); }
  }
  const fy = cat.forYou(v, 12);
  res.set('Cache-Control', 'private, no-store');
  res.json({ banners, segments, continue: cat.recentlyViewed(v, 10), for_you: fy, trending: cat.trending(12), new: cat.newArrivals(12), deals: cat.deals(12), categories: cat.categories(), sponsored: cat.sponsored(null, 2) });
}));

router.get('/api/store/categories', (_req, res) => res.json({ categories: cat.categories() }));
router.get('/api/store/categories/tree', (req, res) => { const l = typeof req.query.lang === 'string' && LANGS.includes(req.query.lang) ? req.query.lang : 'ru'; res.json({ tree: cat.categoryTree(l) }); });

router.get('/api/store/search', A.buyerOptional, wrap((req, res) => {
  const q = req.query, str = k => (typeof q[k] === 'string' ? q[k].slice(0, 100) : '');
  const num = k => { const n = Number(q[k]); return q[k] !== undefined && q[k] !== '' && Number.isFinite(n) ? Math.round(n) : null; };
  const cc = str('country').toUpperCase(), lang = LANGS.includes(str('lang')) ? str('lang') : 'ru';
  const out = cat.search({ q: str('q'), category: str('category') || null, cat: /^[a-z0-9][a-z0-9-]{0,59}$/.test(str('cat')) ? str('cat') : null, brands: str('brand') ? str('brand').split(',').slice(0, 10) : [], min: num('min'), max: num('max'), rating: num('rating'),
    inStock: q.in_stock === '1', deals: q.deals === '1', sort: str('sort'), page: intq(q.page, 1, 1, 500), limit: intq(q.limit, 24, 1, 60),
    delivery: [2, 7, 30].includes(num('delivery')) ? num('delivery') : null, kind: ['shop', 'classifieds', 'rfq', 'partner'].includes(str('kind')) ? str('kind') : null,
    country: /^[A-Z]{2}$/.test(cc) ? cc : 'PL', lang });
  const toks = cat.words(str('q'));
  out.sponsored = out.page === 1 ? cat.sponsored(m => (!toks.length || toks.every(t => m.tTitle.some(w => w.includes(t)) || m.tBrand.some(w => w.includes(t)) || m.tCat.some(w => w.includes(t)))) && (!q.category || m.category === q.category), 2) : [];
  res.json(out);
}));
router.get('/api/store/suggest', (req, res) => res.json({ items: cat.suggest(typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : '', 8) }));

function country(req) { const c = typeof req.query.country === 'string' ? req.query.country.toUpperCase() : ''; return /^[A-Z]{2}$/.test(c) ? c : 'PL'; }
function reviewSummary(m) {
  const ids = m.offers.map(o => o.id);
  const rows = db.prepare(`SELECT rating, COUNT(*) n FROM m_reviews WHERE status='published' AND product_id IN (${ids.map(() => '?').join(',')}) GROUP BY rating`).all(...ids);
  const hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let n = 0, sum = 0;
  for (const r of rows) { hist[r.rating] = r.n; n += r.n; sum += r.rating * r.n; }
  return { count: n, avg: n ? Math.round(sum / n * 10) / 10 : null, histogram: hist };
}
router.get('/api/store/models/:slug', A.buyerOptional, wrap((req, res) => {
  if (!SLUG.test(req.params.slug)) throw E.notFound();
  const m = cat.findModel(req.params.slug); if (!m) throw E.notFound();
  const offers = cat.offersFor(m, country(req));
  const seo = db.prepare('SELECT title_tag, meta_description, canonical, noindex FROM m_seo_pages WHERE path=?').get('/p/' + m.slug) || null;
  // offers of other shops / marketplaces: only with a recently checked price, only those that deliver to the buyer's country
  // Amazon's Associates rules want a displayed price no older than 24 h; other sources: 3 days
  const cc = country(req), now = Date.now(), fresh = now - 3 * 864e5, maxAge = x => (/amazon/i.test(x.source_name) || /(^|\.)amazon\./i.test(hostOf(x.url)) ? 864e5 : 3 * 864e5);
  const other = db.prepare('SELECT id, source_name, source_kind, url, price, shipping, delivery_days, ships_to, mode, affiliate, checked_at FROM m_external_offers WHERE model_slug=? AND active=1 AND checked_at>=? ORDER BY price + COALESCE(shipping,0) LIMIT 20').all(m.slug, fresh)
    .filter(x => now - x.checked_at <= maxAge(x) && (!x.ships_to || x.ships_to.split(',').map(c => c.trim().toUpperCase()).includes(cc)))
    .map(({ ships_to, ...x }) => ({ ...x, affiliate: !!x.affiliate, landed: x.price + (x.shipping || 0) }));
  res.json({ ...cat.card(m), description: m.description, images: m.images, offers: offers, buybox: offers.find(o => o.buybox) || null, reviews_summary: reviewSummary(m), other_offers: other,
    category_path: m.category_id ? require('../services/categories').path(m.category_id, typeof req.query.lang === 'string' ? req.query.lang : undefined) : [],
    also_bought: cat.alsoBought(m.slug, 8), seo, currency: cfg.currency, digital: m.offers.every(o => o.digital) });
}));
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
router.get('/api/store/models/:slug/reviews', wrap((req, res) => {
  if (!SLUG.test(req.params.slug)) throw E.notFound();
  const m = cat.findModel(req.params.slug); if (!m) throw E.notFound();
  const ids = m.offers.map(o => o.id), page = intq(req.query.page, 1, 1, 200), limit = 10;
  const rows = db.prepare(`SELECT r.id, r.rating, r.body, r.created_at, r.customer_id, r.product_id FROM m_reviews r WHERE r.status='published' AND r.product_id IN (${ids.map(() => '?').join(',')})
    ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...ids, limit, (page - 1) * limit);
  const items = rows.map(r => {
    const c = r.customer_id ? db.prepare('SELECT * FROM m_customers WHERE id=?').get(r.customer_id) : null;
    const name = c ? co.openPii(c, 'name') : null;
    const verified = !!(c && db.prepare("SELECT 1 FROM m_order_items i JOIN m_orders o ON o.id=i.order_id WHERE o.customer_id=? AND i.product_id=? AND o.status IN ('delivered','refunded')").get(c.id, r.product_id));
    return { id: r.id, rating: r.rating, body: r.body, created_at: r.created_at, author: name ? name.split(/\s+/).map((w, i) => (i ? w[0] + '.' : w)).join(' ') : 'Customer', verified };   // only first name + initial is ever public
  });
  res.json({ summary: reviewSummary(m), page, items });
}));
// «Сообщить о нарушении» on every listing: anyone (signed in or not) can report a counterfeit / unsafe / illegal offer.
// Stored for moderators; the reporter's e-mail (optional) is encrypted. Tight rate limit, no echo of the content.
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });
router.post('/api/store/report', reportLimiter, A.buyerOptional, wrap((req, res) => {
  const b = req.body || {}, pidn = Number(b.product_id);
  if (!Number.isSafeInteger(pidn) || pidn < 1 || !cat.findByProduct(pidn)) throw E.bad('invalid_product');
  const REASONS = ['counterfeit', 'unsafe', 'illegal', 'misleading', 'ip', 'other'], KINDS = ['buyer', 'brand_owner', 'authority', 'other'];
  if (!REASONS.includes(b.reason)) throw E.bad('invalid_reason');
  const details = typeof b.details === 'string' ? b.details.trim().slice(0, 2000) : '';
  if (details.length < 10) throw E.bad('details_too_short');
  const email = typeof b.email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(b.email.trim()) ? b.email.trim() : null;
  const r = R.create('reports', null, { product_id: pidn, reason: b.reason, reporter_kind: KINDS.includes(b.reporter_kind) ? b.reporter_kind : 'buyer', details, reporter_email: email }, req, { internal: true });
  res.status(201).json({ id: r.id, status: 'open' });
}));
/* ---------- conversations through Asveli: contact a seller, B2B order, order via Asveli, request a quote ---------- */
const inq = () => require('../services/inquiries');
const inquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });
router.post('/api/store/inquiries', inquiryLimiter, A.buyer, wrap((req, res) => res.status(201).json(inq().create(req.accountId, req.body || {}, req))));
router.get('/api/store/inquiries', A.buyer, wrap((req, res) => res.json({ items: inq().listFor('account_id=?', [req.accountId], 'buyer') })));
router.get('/api/store/inquiries/:id', A.buyer, wrap((req, res) => res.json(inq().view(inq().forBuyer(req.accountId, req.params.id), 'buyer'))));
router.post('/api/store/inquiries/:id/messages', inquiryLimiter, A.buyer, wrap((req, res) => {
  const id = inq().forBuyer(req.accountId, req.params.id); inq().addMessage(id, 'buyer', (req.body || {}).body, 'buyer'); res.status(201).json(inq().view(id, 'buyer'));
}));
router.post('/api/store/models/:slug/reviews', writeLimiter, A.buyer, wrap((req, res) => {
  const m = SLUG.test(req.params.slug) && cat.findModel(req.params.slug); if (!m) throw E.notFound();
  const b = req.body || {}, { c } = co.accountCustomer(req.accountId);
  if (!Number.isSafeInteger(b.rating) || b.rating < 1 || b.rating > 5) throw E.bad('invalid_rating');
  if (typeof b.body !== 'string' || b.body.trim().length < 5 || b.body.length > 3000) throw E.bad('invalid_body');
  const offerIds = m.offers.map(o => o.id);
  // only people who actually received the item may review it (verified purchase) → the review base can't be stuffed by sellers or bots
  const bought = db.prepare(`SELECT i.product_id FROM m_order_items i JOIN m_orders o ON o.id=i.order_id WHERE o.customer_id=? AND o.status='delivered' AND i.product_id IN (${offerIds.map(() => '?').join(',')}) LIMIT 1`).get(c.id, ...offerIds);
  if (!bought) throw E.conflict('purchase_required');
  if (db.prepare('SELECT 1 FROM m_reviews WHERE customer_id=? AND product_id=?').get(c.id, bought.product_id)) throw E.conflict('already_reviewed');
  const r = R.create('reviews', null, { product_id: bought.product_id, customer_id: c.id, rating: b.rating, body: b.body.trim() }, req, { internal: true });
  const flagged = db.prepare('SELECT flag FROM m_reviews WHERE id=?').get(r.id).flag;       // auto-flags (links, banned words, duplicates) → human moderation; clean verified reviews go live
  if (!flagged) R.update('reviews', r.id, null, { status: 'published' }, req, { internal: true });
  cat.invalidate();
  res.status(201).json({ ok: true, status: flagged ? 'pending' : 'published' });
}));

/* ---------- behaviour tracking (drives personalisation; pseudonymous until login) ---------- */
router.post('/api/store/track', A.buyerOptional, wrap((req, res) => {
  const b = req.body || {}, v = cat.viewerKey(req);
  if (!Number.isSafeInteger(b.product_id) || b.type !== 'view') throw E.bad('invalid');
  if ((v.account || v.anon) && cat.findByProduct(b.product_id)) {
    const dup = db.prepare(`SELECT 1 FROM s_views WHERE product_id=? AND ${v.account ? 'account_id=?' : 'anon=?'} AND ts>?`).get(b.product_id, v.account || v.anon, Date.now() - 10 * 60e3);
    if (!dup) db.prepare('INSERT INTO s_views(account_id,anon,product_id,ts) VALUES(?,?,?,?)').run(v.account, v.anon, b.product_id, Date.now());
  }
  res.status(204).end();
}));

/* ---------- ads: sponsored slots (campaigns are created/approved in Seller Central + admin; budget is enforced here) ---------- */
router.post('/api/store/ads/impressions', wrap((req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? [...new Set(req.body.ids.filter(Number.isSafeInteger))].slice(0, 10) : [];
  if (ids.length) db.prepare(`UPDATE m_campaigns SET impressions = impressions + 1 WHERE status='active' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  res.status(204).end();
}));
router.post('/api/store/ads/:id/click', A.buyerOptional, wrap((req, res) => {
  const id = Number(req.params.id); if (!Number.isSafeInteger(id)) throw E.notFound();
  const who = sec.sha256((req.accountId ? 'a' + req.accountId : req.ip || '') + '|' + (req.headers['user-agent'] || '')).slice(0, 16);
  if (db.prepare('SELECT 1 FROM s_ad_events WHERE campaign_id=? AND who=? AND kind=\'click\' AND ts>?').get(id, who, Date.now() - 30 * 60e3)) return res.status(204).end();   // one billable click per viewer per 30 min (click-fraud guard)
  db.transaction(() => {
    const r = db.prepare(`UPDATE m_campaigns SET clicks = clicks + 1, spent = MIN(budget, spent + cpc), status = CASE WHEN spent + cpc >= budget THEN 'ended' ELSE status END, updated_at=?
      WHERE id=? AND status='active' AND spent < budget`).run(Date.now(), id);
    if (r.changes) db.prepare('INSERT INTO s_ad_events(campaign_id,kind,who,ts) VALUES(?,?,?,?)').run(id, 'click', who, Date.now());
  })();
  res.status(204).end();
}));

router.get('/api/store/seo', (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path.slice(0, 200) : '';
  res.json(db.prepare('SELECT title_tag, meta_description, canonical, noindex FROM m_seo_pages WHERE path=?').get(p) || {});
});

/* ---------- accounts ---------- */
const mergeAnon = (req, accountId) => { const a = req.headers['x-anon-id']; if (/^[A-Za-z0-9_-]{16,64}$/.test(a || '')) db.prepare('UPDATE s_views SET account_id=?, anon=NULL WHERE anon=?').run(accountId, a); };
router.post('/api/store/auth/register', A.authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const email = A.checkEmail(b.email), password = A.checkPassword(b.password);
  const name = co.clean(b.name, 80), cc = typeof b.country === 'string' ? b.country.toUpperCase() : '', lang = LANGS.includes(b.lang) ? b.lang : 'en';
  if (!name) throw E.bad('invalid_name');
  if (!/^[A-Z]{2}$/.test(cc)) throw E.bad('invalid_country');
  const bi = sec.blindIndex(email);
  if (db.prepare('SELECT 1 FROM s_accounts WHERE email_bi=?').get(bi)) throw E.conflict('email_taken');
  const hash = await sec.hashPassword(password);
  const id = db.transaction(() => {
    const c = R.create('customers', null, { name, email, country: cc }, req, { internal: true });
    return Number(db.prepare('INSERT INTO s_accounts(customer_id,email_bi,pass_hash,lang,created_at) VALUES(?,?,?,?,?)').run(c.id, bi, hash, lang, Date.now()).lastInsertRowid);
  })();
  mergeAnon(req, id);
  res.status(201).json({ token: A.issue('buyer', id), profile: co.profile(id) });
}));
router.post('/api/store/auth/login', A.authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.email !== 'string' || typeof b.password !== 'string') throw E.bad('invalid');
  const row = await A.checkLogin('s_accounts', sec.blindIndex(b.email), b.password);
  if (!row) throw new HttpError(401, 'invalid_credentials');
  mergeAnon(req, row.id);
  res.json({ token: A.issue('buyer', row.id), profile: co.profile(row.id) });
}));
// Sign in with Google / GitHub / Amazon (store/oauth.js)
require('../store/oauth')(router, { A, co, wrap, mergeAnonId: (anon, accountId) => db.prepare('UPDATE s_views SET account_id=?, anon=NULL WHERE anon=?').run(accountId, anon) });
router.post('/api/store/auth/logout', wrap((req, res) => { const t = A.bearer(req); if (t) db.prepare('DELETE FROM s_tokens WHERE hash=?').run(sec.sha256(t)); res.status(204).end(); }));

router.get('/api/store/me', A.buyer, wrap((req, res) => res.json(co.profile(req.accountId))));
router.patch('/api/store/me', A.buyer, wrap((req, res) => {
  const b = req.body || {}, { a, c } = co.accountCustomer(req.accountId), patch = {};
  if (b.name !== undefined) { const n = co.clean(b.name, 80); if (!n) throw E.bad('invalid_name'); patch.name = n; }
  if (b.phone !== undefined) { const p = co.clean(b.phone, 30); if (p && !/^[+\d][\d\s()-]{5,29}$/.test(p)) throw E.bad('invalid_phone'); patch.phone = p || null; }
  if (b.country !== undefined) { if (!/^[A-Z]{2}$/.test(String(b.country).toUpperCase())) throw E.bad('invalid_country'); patch.country = String(b.country).toUpperCase(); }
  if (b.address) { const ad = co.validateAddress(b.address); patch.address = `${ad.line1}, ${ad.postal} ${ad.city}, ${ad.country}`; if (!patch.name) patch.name = ad.name; if (ad.phone) patch.phone = ad.phone; }
  if (Object.keys(patch).length) R.update('customers', c.id, null, patch, req, { internal: true });
  if (b.lang !== undefined && LANGS.includes(b.lang)) db.prepare('UPDATE s_accounts SET lang=? WHERE id=?').run(b.lang, a.id);
  res.json(co.profile(req.accountId));
}));
router.post('/api/store/me/password', A.authLimiter, A.buyer, wrap(async (req, res) => {
  const b = req.body || {}, { a } = co.accountCustomer(req.accountId);
  // an account made with Google/GitHub/Amazon has no password yet: the first one is set without "current" (the buyer is signed in)
  if (a.password_set !== 0 && (typeof b.current !== 'string' || !(await sec.verifyPassword(b.current, a.pass_hash)))) throw new HttpError(403, 'invalid_credentials');
  db.prepare('UPDATE s_accounts SET pass_hash=?, password_set=1 WHERE id=?').run(await sec.hashPassword(A.checkPassword(b.next)), a.id);
  A.revoke('buyer', a.id);                                                         // every other device is signed out
  res.json({ token: A.issue('buyer', a.id) });
}));
// GDPR: export everything we hold about the buyer, and erase the personal data (financial records stay, anonymised, as the law requires)
router.get('/api/store/me/export', A.buyer, wrap((req, res) => {
  const { c } = co.accountCustomer(req.accountId);
  res.set('Content-Disposition', 'attachment; filename="asveli-my-data.json"');
  res.json({ exported_at: new Date().toISOString(), profile: co.profile(req.accountId), orders: co.ordersOf(req.accountId),
    reviews: db.prepare('SELECT product_id, rating, body, status, created_at FROM m_reviews WHERE customer_id=?').all(c.id),
    views: db.prepare('SELECT product_id, ts FROM s_views WHERE account_id=?').all(req.accountId) });
}));
router.delete('/api/store/me', A.authLimiter, A.buyer, wrap(async (req, res) => {
  const { a, c } = co.accountCustomer(req.accountId);
  if (a.password_set === 0) { if ((req.body || {}).confirm !== 'DELETE') throw new HttpError(403, 'confirm_required'); }   // no password to re-enter: an explicit confirmation instead
  else if (typeof (req.body || {}).password !== 'string' || !(await sec.verifyPassword(req.body.password, a.pass_hash))) throw new HttpError(403, 'invalid_credentials');
  const open = db.prepare("SELECT 1 FROM m_orders WHERE customer_id=? AND status IN ('new','held','confirmed','shipped')").get(c.id);
  if (open) throw E.conflict('open_orders');
  db.transaction(() => {
    db.prepare('DELETE FROM s_views WHERE account_id=?').run(a.id);
    A.revoke('buyer', a.id);
    db.prepare('DELETE FROM s_accounts WHERE id=?').run(a.id);
    db.prepare("UPDATE m_customers SET name=NULL, email=NULL, email_bi=NULL, phone=NULL, address=NULL, address_bi=NULL, passport_no=NULL, card_brand=NULL, card_last4=NULL, blocked=1, updated_at=? WHERE id=?").run(Date.now(), c.id);
    db.prepare('UPDATE m_reviews SET customer_id=NULL WHERE customer_id=?').run(c.id);
  })();
  audit(req, 'store.account_erased', `customer #${c.id}`, 'buyer');
  res.status(204).end();
}));

/* ---------- cart & checkout ---------- */
router.post('/api/store/quote', A.buyerOptional, wrap((req, res) => {
  const b = req.body || {};
  const cid = req.accountId ? co.accountCustomer(req.accountId).c.id : 0;
  res.json(co.quote({ items: b.items, country: typeof b.country === 'string' ? b.country.toUpperCase() : '', coupon: b.coupon || null, customerId: cid }));
}));
router.post('/api/store/checkout', writeLimiter, A.buyer, wrap((req, res) => res.status(201).json(co.place(req.accountId, req.body, req, req.headers['idempotency-key']))));
// 1-Click: saved address + saved payment method, one request. Same antifraud, same price check.
router.post('/api/store/checkout/one-click', writeLimiter, A.buyer, wrap((req, res) => {
  const b = req.body || {}, { c } = co.accountCustomer(req.accountId), a = co.readAddress(c);
  if (!a) throw E.conflict('address_required');
  const name = co.openPii(c, 'name'), phone = co.openPii(c, 'phone');
  const body = { items: [{ product_id: b.product_id, qty: b.qty || 1 }], address: { ...a, name: name || 'Customer', phone: phone || '' }, payment: b.payment, expected_total: b.expected_total, save_address: false };
  res.status(201).json(co.place(req.accountId, body, req, req.headers['idempotency-key']));
}));

router.get('/api/store/orders', A.buyer, wrap((req, res) => res.json({ orders: co.ordersOf(req.accountId) })));
router.get('/api/store/orders/:code', A.buyer, wrap((req, res) => res.json(co.orderView(co.orderOf(req.accountId, req.params.code)))));
router.post('/api/store/orders/:code/cancel', writeLimiter, A.buyer, wrap((req, res) => {
  const o = co.orderOf(req.accountId, req.params.code), v = co.orderView(o);
  if (!v.can_cancel) throw E.conflict('not_cancellable');
  orders.cancel(o.id, null, req); cat.invalidate();
  res.json(co.orderView(db.prepare('SELECT * FROM m_orders WHERE id=?').get(o.id)));
}));
router.post('/api/store/orders/:code/return', writeLimiter, A.buyer, wrap((req, res) => {
  const o = co.orderOf(req.accountId, req.params.code), b = req.body || {};
  if (!Number.isSafeInteger(b.product_id) || !Number.isSafeInteger(b.qty)) throw E.bad('invalid');
  if (!db.prepare('SELECT 1 FROM m_order_items WHERE order_id=? AND product_id=?').get(o.id, b.product_id)) throw E.notFound();
  const note = b.note ? co.clean(b.note, 200) : undefined;
  R.create('returns', null, { order_id: o.id, product_id: b.product_id, qty: b.qty, reason: b.reason, ...(note ? { note } : {}) }, req, { internal: true });   // validated by the returns rules (delivered, quantity left)
  res.status(201).json(co.orderView(o));
}));

module.exports = router;
