'use strict';
/* Checkout for the storefront: quotes (read-only price calculation) and order placement through the SAME order service the back-office uses
   (warehouse routing, tax, commission split, coupon, antifraud — all in one SQLite transaction). */
const { db } = require('../db');
const cfg = require('../config');
const R = require('../engine/resource');
const { E } = require('../engine/errors');
const pii = require('../iam/pii');
const sec = require('../security');
const routing = require('../services/routing');
const coupons = require('../services/coupons');
const orders = require('../services/orders');
const { bps, event } = require('../services/common');
const cat = require('./catalog');

const CC = /^[A-Z]{2}$/;

function parseItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw E.bad('invalid_items');
  const merged = new Map();
  for (const it of items) {
    if (!it || !Number.isSafeInteger(it.product_id) || !Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 100) throw E.bad('invalid_items');
    merged.set(it.product_id, (merged.get(it.product_id) || 0) + it.qty);
  }
  return merged;
}

// Price calculation without touching stock. Problems are reported per line (the cart UI shows them) instead of failing the whole request.
function quote({ items, country, coupon, customerId = 0 }) {
  if (typeof country !== 'string' || !CC.test(country)) throw E.bad('invalid_country');
  const merged = parseItems(items), ix = cat.index(), issues = [], lines = [];
  for (const [pid, qty] of merged) {
    const m = ix.byProduct.get(pid), o = m && m.offers.find(x => x.id === pid);
    if (!o) { issues.push({ product_id: pid, code: 'unavailable' }); continue; }
    const line = { product_id: pid, slug: m.slug, title: m.title, image: m.images[0] || null, seller: o.seller_name, seller_id: o.seller_id, qty, unit_price: o.price, line_total: o.price * qty, digital: o.digital, weight_g: o.weight_g || 0 };
    if ((m.kind || 'shop') !== 'shop') { issues.push({ product_id: pid, code: 'contact_only' }); line.unavailable = true; lines.push(line); continue; }        // classifieds / services: «Связаться», not the cart
    if (m.restricted === 'b2b_licence') { issues.push({ product_id: pid, code: 'b2b_only' }); line.unavailable = true; lines.push(line); continue; }    // licence-only goods (alcohol…): business request only
    if (!cat.sellable(o, country)) { issues.push({ product_id: pid, code: 'not_sold_in_country', country }); line.unavailable = true; lines.push(line); continue; }   // region rules: this listing lacks what the buyer's region requires
    if (o.digital) { lines.push(line); continue; }
    const wh = routing.pickWarehouse(pid, qty, country);
    if (!wh) { const any = routing.pickWarehouse(pid, 1, country); issues.push({ product_id: pid, code: any ? 'insufficient_stock' : 'out_of_stock', available: o.free > 0 ? Math.min(o.free, 100) : 0 }); line.unavailable = true; }
    else line.warehouse_id = wh.id;
    lines.push(line);
  }
  const ok = lines.filter(l => !l.unavailable);
  const subtotal = ok.reduce((s, l) => s + l.line_total, 0);
  let discount = 0, coupon_info = null, coupon_error = null;
  if (coupon && subtotal > 0) { try { const q = coupons.quote(coupon, customerId, subtotal); discount = q.discount; coupon_info = { code: q.code, discount }; } catch (e) { coupon_error = e.code || 'invalid_coupon'; } }
  const rate = orders.taxRate(country);
  // same proportional split as the order service, so the quote equals the final price to the cent
  let left = discount, tax = 0;
  ok.forEach((l, i) => { const d = i === ok.length - 1 ? left : Math.min(left, Math.floor(discount * l.line_total / subtotal)); left -= d; tax += bps(l.line_total - d, rate); });
  const byWh = new Map();
  for (const l of ok) if (!l.digital) byWh.set(l.warehouse_id, (byWh.get(l.warehouse_id) || 0) + l.weight_g * l.qty);
  let shipping = 0;
  for (const w of byWh.values()) { const c = routing.pickCarrier(country, w); if (!c) { issues.push({ code: 'no_carrier' }); break; } shipping += routing.buyerShipping(c.cost); }
  const total = subtotal - discount + tax + shipping;
  return { currency: cfg.currency, country, lines: lines.map(({ weight_g, warehouse_id, ...l }) => l), subtotal, discount, tax, tax_rate_bps: rate, shipping, total, shipments: byWh.size, coupon: coupon_info, coupon_error, issues, ok: !issues.length && ok.length > 0 };
}

/* ---------- accounts ⇄ customers ---------- */
function accountCustomer(accountId) {
  const a = db.prepare('SELECT * FROM s_accounts WHERE id=?').get(accountId); if (!a) throw E.notFound('account_not_found');
  const c = db.prepare('SELECT * FROM m_customers WHERE id=?').get(a.customer_id);
  return { a, c };
}
const openPii = (row, col) => { if (!row[col]) return null; try { return pii.open(row[col], pii.aad('m_customers', col, row.id)); } catch { return null; } };
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function readAddress(c) {
  const raw = openPii(c, 'address'); if (!raw) return null;
  const parts = raw.split(', '), country = parts.pop(), pc = (parts.pop() || '').split(' ');
  return { line1: parts.join(', '), postal: pc.shift() || '', city: pc.join(' '), country: CC.test(country) ? country : c.country };
}
function validateAddress(a) {
  if (!a || typeof a !== 'object') throw E.bad('invalid_address');
  const out = { name: clean(a.name, 80), phone: clean(a.phone, 30), line1: clean(a.line1, 120).replace(/,/g, ' '), postal: clean(a.postal, 12).replace(/\s/g, ''), city: clean(a.city, 60).replace(/,/g, ' '), country: typeof a.country === 'string' ? a.country.toUpperCase() : '' };
  for (const k of ['name', 'line1', 'postal', 'city']) if (!out[k]) throw E.bad('invalid_address_' + k);
  if (!CC.test(out.country)) throw E.bad('invalid_address_country');
  if (out.phone && !/^[+\d][\d\s()-]{5,29}$/.test(out.phone)) throw E.bad('invalid_phone');
  return out;
}
const formatAddress = a => `${a.line1}, ${a.postal} ${a.city}, ${a.country}`;
function saveAddress(customerId, a, req) {
  R.update('customers', customerId, null, { name: a.name, address: formatAddress(a), ...(a.phone ? { phone: a.phone } : {}) }, req, { internal: true });
}

function profile(accountId) {
  const { a, c } = accountCustomer(accountId);
  return { id: a.id, password_set: a.password_set !== 0, email: openPii(c, 'email'), name: openPii(c, 'name'), phone: openPii(c, 'phone'), country: c.country, lang: a.lang, address: readAddress(c),
    loyalty: { tier: c.loyalty_tier, points: c.loyalty_points, orders: c.orders_count, spent: c.total_spent }, currency: cfg.currency };
}

/* ---------- orders ---------- */
function orderView(o) {
  const items = db.prepare(`SELECT i.*, p.title, p.model_slug, p.images, p.digital, p.digital_file, p.id pid, s.name seller_name FROM m_order_items i
    JOIN m_products p ON p.id=i.product_id JOIN m_sellers s ON s.id=i.seller_id WHERE i.order_id=?`).all(o.id);
  const ships = db.prepare(`SELECT sh.id, sh.status, sh.tracking_no, sh.shipped_at, c.name carrier, c.tracking_url FROM m_shipments sh LEFT JOIN m_carriers c ON c.id=sh.carrier_id WHERE sh.order_id=? ORDER BY sh.id`).all(o.id);
  const returns = db.prepare('SELECT id, product_id, qty, reason, status, refund_amount FROM m_returns WHERE order_id=?').all(o.id);
  return {
    code: o.code, status: o.status, created_at: o.created_at, country: o.country, currency: cfg.currency,
    subtotal: o.subtotal, discount: o.discount, tax: o.tax, shipping: o.shipping, total: o.total, coupon: o.coupon_code,
    items: items.map(i => {
      const img = cat.parseImages(i.images)[0] || null, view = { product_id: i.pid, slug: cat.modelSlugOf({ id: i.pid, model_slug: i.model_slug }), title: i.title, image: img, qty: i.qty, unit_price: i.unit_price, seller: i.seller_name, returned_qty: i.returned_qty, digital: !!i.digital };
      if (i.digital && ['delivered'].includes(o.status) && i.digital_file) {
        const f = db.prepare("SELECT id, share_nonce, name FROM files WHERE id=? AND scope='general'").get(i.digital_file);
        if (f) view.download = { name: f.name, url: `${cfg.baseUrl}/s/${sec.signLink(f.id, f.share_nonce, Date.now() + 24 * 3600e3)}`, expires_in_h: 24 };   // short-lived signed link, minted per view
      }
      return view;
    }),
    shipments: ships.map(s => ({ id: s.id, status: s.status, carrier: s.carrier, tracking_no: s.tracking_no, shipped_at: s.shipped_at,
      tracking_url: s.tracking_url && s.tracking_no ? s.tracking_url.replace('{id}', encodeURIComponent(s.tracking_no)) : null })),
    returns, can_cancel: ['new', 'held', 'confirmed'].includes(o.status) && !ships.some(s => s.status !== 'pending'), can_return: o.status === 'delivered'
  };
}
function ordersOf(accountId) {
  const { c } = accountCustomer(accountId);
  return db.prepare('SELECT * FROM m_orders WHERE customer_id=? ORDER BY id DESC LIMIT 100').all(c.id).map(orderView);
}
function orderOf(accountId, code) {
  const { c } = accountCustomer(accountId);
  if (typeof code !== 'string' || !/^O-\d{1,12}$/.test(code)) throw E.notFound();
  const o = db.prepare('SELECT * FROM m_orders WHERE code=? AND customer_id=?').get(code, c.id);   // ownership enforced in SQL: no IDOR
  if (!o) throw E.notFound();
  return o;
}

const PAYMENTS = ['pay_on_delivery', 'bank_transfer'];     // no payment provider is connected: money does not move here, the method is recorded for the back-office
function place(accountId, body, req, idemKey) {
  if (!body || typeof body !== 'object') throw E.bad('invalid_body');
  const { a, c } = accountCustomer(accountId);
  if (c.blocked) throw E.conflict('customer_blocked');
  if (idemKey) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(idemKey)) throw E.bad('invalid_idempotency_key');
    const prev = db.prepare('SELECT order_id FROM s_idem WHERE key=? AND account_id=?').get(idemKey, a.id);
    if (prev) return orderView(db.prepare('SELECT * FROM m_orders WHERE id=?').get(prev.order_id));
  }
  const payment = body.payment || 'pay_on_delivery';
  if (!PAYMENTS.includes(payment)) throw E.bad('invalid_payment');
  const addr = validateAddress(body.address);
  const q = quote({ items: body.items, country: addr.country, coupon: body.coupon, customerId: c.id });
  if (body.coupon && q.coupon_error) throw E.bad(q.coupon_error);
  if (q.issues.length) throw E.conflict('cart_issues', { issues: q.issues });
  if (body.expected_total != null && body.expected_total !== q.total) throw E.conflict('price_changed', { total: q.total });   // the price the buyer saw must be the price they pay
  if (body.save_address !== false || !c.address) saveAddress(c.id, addr, req);
  const created = orders.createOrder({ customer_id: c.id, country: addr.country, items: [...parseItems(body.items)].map(([product_id, qty]) => ({ product_id, qty })), coupon_code: body.coupon || null }, null, req);
  const o = db.prepare('SELECT * FROM m_orders WHERE id=?').get(created.id);
  event('checkout', { ref_type: 'order', ref_id: o.id, customer_id: c.id, amount: o.total, data: { payment } });
  if (idemKey) db.prepare('INSERT OR IGNORE INTO s_idem(key,account_id,order_id,created_at) VALUES(?,?,?,?)').run(idemKey, a.id, o.id, Date.now());
  cat.invalidate();
  return orderView(o);
}

module.exports = { quote, place, profile, saveAddress, validateAddress, readAddress, openPii, accountCustomer, orderView, ordersOf, orderOf, clean, PAYMENTS, parseItems };
