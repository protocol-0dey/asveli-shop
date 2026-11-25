'use strict';
const { db, audit } = require('../db');
const R = require('../engine/resource');
const { E } = require('../engine/errors');
const { bps, now, event, ledger } = require('./common');
const routing = require('./routing');
const coupons = require('./coupons');
const fraud = require('./fraud');

const taxRate = country => (db.prepare('SELECT rate_bps FROM m_tax_rates WHERE country=? AND active=1').get(country) || { rate_bps: 0 }).rate_bps;

/* Creates an order: stock check + reservation, routing to warehouses, coupon, tax, commission split, shipping, fraud scoring.
   Everything runs in ONE SQLite transaction, so two simultaneous orders can never reserve the same last unit. */
function createOrder(input, user, req) {
  if (!input || typeof input !== 'object') throw E.bad('invalid_body');
  const { customer_id, country, items, coupon_code } = input;
  if (!Number.isSafeInteger(customer_id)) throw E.bad('invalid_customer_id');
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) throw E.bad('invalid_country');
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw E.bad('invalid_items');

  const merged = new Map();
  for (const it of items) {
    if (!it || !Number.isSafeInteger(it.product_id) || !Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 1000) throw E.bad('invalid_items');
    merged.set(it.product_id, (merged.get(it.product_id) || 0) + it.qty);
  }
  const tx = db.transaction(() => {
    const cust = db.prepare('SELECT * FROM m_customers WHERE id=?').get(customer_id);
    if (!cust) throw E.bad('invalid_customer_id');
    if (cust.blocked) throw E.conflict('customer_blocked');

    const lines = [];
    for (const [pid, qty] of merged) {
      const p = db.prepare('SELECT * FROM m_products WHERE id=?').get(pid);
      if (!p || p.status !== 'approved') throw E.conflict('product_unavailable', { product_id: pid });
      const seller = db.prepare('SELECT id, status, commission_bps FROM m_sellers WHERE id=?').get(p.seller_id);
      if (!seller || seller.status !== 'active') throw E.conflict('seller_unavailable', { product_id: pid });
      if (p.digital) {                                                    // digital goods: no warehouse, no stock, no shipment; delivered instantly
        if (!p.digital_file) throw E.conflict('product_unavailable', { product_id: pid });
        lines.push({ product_id: pid, seller_id: p.seller_id, qty, unit_price: p.price, weight_g: 0, warehouse_id: null, digital: true, commission_bps: seller.commission_bps });
        continue;
      }
      const wh = routing.pickWarehouse(pid, qty, country);
      if (!wh) throw E.conflict('out_of_stock', { product_id: pid });
      lines.push({ product_id: pid, seller_id: p.seller_id, qty, unit_price: p.price, weight_g: p.weight_g, warehouse_id: wh.id, commission_bps: seller.commission_bps });
    }
    const subtotal = lines.reduce((s, l) => s + l.unit_price * l.qty, 0);
    const q = coupons.quote(coupon_code, cust.id, subtotal);
    const discount = q ? q.discount : 0;

    // spread the discount over lines proportionally; the rounding remainder goes to the last line so the parts always sum to the whole
    let left = discount;
    lines.forEach((l, i) => {
      l.gross = l.unit_price * l.qty;
      l.discount = i === lines.length - 1 ? left : Math.min(left, Math.floor(discount * l.gross / subtotal));
      left -= l.discount;
    });
    const rate = taxRate(country);
    for (const l of lines) { l.tax = bps(l.gross - l.discount, rate); l.commission = bps(l.gross, l.commission_bps); }

    const byWh = new Map();
    for (const l of lines) { if (l.digital) continue; const g = byWh.get(l.warehouse_id) || { weight: 0 }; g.weight += l.weight_g * l.qty; byWh.set(l.warehouse_id, g); }
    let shipping = 0;
    for (const [wid, g] of byWh) { const c = routing.pickCarrier(country, g.weight); g.carrier = c; g.cost = c ? c.cost : 0; shipping += routing.buyerShipping(g.cost); byWh.set(wid, g); }

    const tax = lines.reduce((s, l) => s + l.tax, 0), total = subtotal - discount + tax + shipping;
    const risk = fraud.assess({ customer: cust, country, lines, total });

    const order = R.create('orders', null, {
      customer_id: cust.id, country, status: risk.hold ? 'held' : 'confirmed', subtotal, discount, tax, shipping, total,
      coupon_code: q ? q.code : null, fraud_score: risk.score, hold_reason: risk.hold ? risk.flags.map(f => f.rule).join(',') : null
    }, req, { internal: true });
    db.prepare('UPDATE m_orders SET created_by=? WHERE id=?').run(user ? user.username : 'system', order.id);

    const ins = db.prepare('INSERT INTO m_order_items(order_id,product_id,seller_id,warehouse_id,qty,unit_price,discount,tax,commission,returned_qty,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)');
    for (const l of lines) {
      ins.run(order.id, l.product_id, l.seller_id, l.warehouse_id, l.qty, l.unit_price, l.discount, l.tax, l.commission, now(), now(), 'system');
      if (!l.digital) {
        const r = db.prepare('UPDATE m_stock SET reserved = reserved + ?, updated_at=? WHERE product_id=? AND warehouse_id=? AND (qty - reserved) >= ?').run(l.qty, now(), l.product_id, l.warehouse_id, l.qty);
        if (r.changes !== 1) throw E.conflict('out_of_stock', { product_id: l.product_id });
      }
      event('order_item', { ref_type: 'product', ref_id: l.product_id, seller_id: l.seller_id, customer_id: cust.id, amount: l.gross, data: { qty: l.qty, order: order.id } });
    }
    for (const [wid, g] of byWh)
      R.create('shipments', null, { order_id: order.id, warehouse_id: wid, carrier_id: g.carrier ? g.carrier.id : null, cost: g.cost }, req, { internal: true });
    coupons.redeem(q, cust.id, order.id);
    fraud.record(order.id, cust.id, risk);
    event('order', { ref_type: 'order', ref_id: order.id, customer_id: cust.id, amount: total });
    // an order that contains only digital goods is fulfilled on the spot (a held order waits for the fraud decision first)
    if (!risk.hold && lines.every(l => l.digital)) { setOrder(order.id, { status: 'delivered' }); settle(order.id); }
    return order.id;
  });
  const id = tx();
  audit(req, 'order.create', `#${id}`, user && user.username);
  return R.present(R.get('orders'), R.raw(R.get('orders'), id), user);
}

// digital-only order that was held by antifraud and has just been released: no warehouse will ever ship it, so deliver it now
function fulfillDigital(orderId) {
  const items = db.prepare('SELECT product_id FROM m_order_items WHERE order_id=?').all(orderId);
  const hasShipment = db.prepare('SELECT 1 FROM m_shipments WHERE order_id=?').get(orderId);
  const o = db.prepare('SELECT status, settled_at FROM m_orders WHERE id=?').get(orderId);
  if (hasShipment || !items.length || o.status !== 'confirmed' || o.settled_at) return false;
  if (!items.every(i => (db.prepare('SELECT digital FROM m_products WHERE id=?').get(i.product_id) || {}).digital)) return false;
  setOrder(orderId, { status: 'delivered' }); settle(orderId); return true;
}
const setOrder = (id, data) => R.update('orders', id, null, data, null, { internal: true });

function shipShipment(id, tracking, user, req) {
  db.transaction(() => {
    const sh = db.prepare('SELECT * FROM m_shipments WHERE id=?').get(id);
    const o = db.prepare('SELECT status FROM m_orders WHERE id=?').get(sh.order_id);
    if (!['confirmed', 'shipped'].includes(o.status)) throw E.conflict('order_not_shippable');      // held / cancelled orders can't leave the warehouse
    for (const it of db.prepare('SELECT product_id, qty FROM m_order_items WHERE order_id=? AND warehouse_id=?').all(sh.order_id, sh.warehouse_id)) {
      const r = db.prepare('UPDATE m_stock SET qty = qty - ?, reserved = reserved - ?, updated_at=? WHERE product_id=? AND warehouse_id=? AND qty >= ? AND reserved >= ?')
        .run(it.qty, it.qty, now(), it.product_id, sh.warehouse_id, it.qty, it.qty);
      if (r.changes !== 1) throw E.conflict('stock_inconsistent');
    }
    R.update('shipments', id, null, { status: 'in_transit', tracking_no: tracking, shipped_at: now() }, req, { internal: true });
    setOrder(sh.order_id, { status: 'shipped' });
  })();
  audit(req, 'shipment.ship', `#${id}`, user.username);
  return R.present(R.get('shipments'), R.raw(R.get('shipments'), id), user);
}

function deliverShipment(id, user, req) {
  db.transaction(() => {
    const sh = db.prepare('SELECT * FROM m_shipments WHERE id=?').get(id);
    if (db.prepare('SELECT status FROM m_orders WHERE id=?').get(sh.order_id).status !== 'shipped') throw E.conflict('order_not_shippable');
    R.update('shipments', id, null, { status: 'delivered' }, req, { internal: true });
    const open = db.prepare("SELECT COUNT(*) n FROM m_shipments WHERE order_id=? AND status<>'delivered'").get(sh.order_id).n;
    if (!open) { setOrder(sh.order_id, { status: 'delivered' }); settle(sh.order_id); }
  })();
  audit(req, 'shipment.deliver', `#${id}`, user.username);
  return R.present(R.get('shipments'), R.raw(R.get('shipments'), id), user);
}

// Delivery releases the money: payment split into seller net / platform commission / tax liability, and customer loyalty is updated.
function settle(orderId) {
  const o = db.prepare('SELECT * FROM m_orders WHERE id=?').get(orderId);
  if (o.settled_at) throw E.conflict('already_settled');                                 // money is released exactly once per order
  db.prepare('UPDATE m_orders SET settled_at=? WHERE id=?').run(now(), orderId);
  for (const it of db.prepare('SELECT * FROM m_order_items WHERE order_id=?').all(orderId)) {
    const gross = it.unit_price * it.qty;
    ledger('sale', { seller_id: it.seller_id, order_id: orderId, amount: gross - it.commission, note: `item ${it.product_id}` });
    ledger('commission', { order_id: orderId, amount: it.commission });
    if (it.tax) ledger('tax', { order_id: orderId, amount: it.tax });
    if (it.discount) ledger('discount', { order_id: orderId, amount: -it.discount, note: 'platform-funded' });
  }
  const c = db.prepare('SELECT * FROM m_customers WHERE id=?').get(o.customer_id);
  const spent = c.total_spent + o.total;
  const tier = db.prepare('SELECT * FROM m_loyalty_tiers WHERE active=1 AND min_spent<=? ORDER BY min_spent DESC LIMIT 1').get(spent);
  const mult = tier ? tier.points_mult : 100;
  R.update('customers', c.id, null, {
    total_spent: spent, orders_count: c.orders_count + 1, loyalty_tier: tier ? tier.name : null,
    loyalty_points: c.loyalty_points + Math.floor(Math.floor(o.total / 100) * mult / 100), last_order_at: now()
  }, null, { internal: true });
}

function cancel(orderId, user, req) {
  db.transaction(() => {
    const o = db.prepare('SELECT status FROM m_orders WHERE id=?').get(orderId);
    if (!['new', 'held', 'confirmed'].includes(o.status)) throw E.conflict('bad_state');
    routing.releaseReservation(orderId);
    setOrder(orderId, { status: 'cancelled', hold_reason: null });
    db.prepare("UPDATE m_shipments SET status='failed', updated_at=? WHERE order_id=? AND status='pending'").run(now(), orderId);
    db.prepare("UPDATE m_fraud_flags SET status='dismissed', updated_at=? WHERE order_id=? AND status='open'").run(now(), orderId);
    event('order_cancelled', { ref_type: 'order', ref_id: orderId });
  })();
  audit(req, 'order.cancel', `#${orderId}`, user && user.username);
}

// Refund of `qty` units of one order line (used by returns and by full refund). Reverses seller net, commission, tax and discount pro rata.
function refundLine(it, qty, who, req) {
  const part = v => Math.round(v * (it.returned_qty + qty) / it.qty) - Math.round(v * it.returned_qty / it.qty);   // cumulative rounding: the parts always add up to the whole
  const gross = it.unit_price * qty, commission = part(it.commission), tax = part(it.tax), disc = part(it.discount);
  const customerRefund = gross - disc + tax;
  db.transaction(() => {
    ledger('refund', { seller_id: it.seller_id, order_id: it.order_id, amount: -(gross - commission), note: `return ${qty}×${it.product_id}`, by: who });
    ledger('commission', { order_id: it.order_id, amount: -commission, by: who });
    if (tax) ledger('tax', { order_id: it.order_id, amount: -tax, by: who });
    if (disc) ledger('discount', { order_id: it.order_id, amount: disc, by: who });
    db.prepare('UPDATE m_order_items SET returned_qty = returned_qty + ?, updated_at=? WHERE id=?').run(qty, now(), it.id);
    event('refund', { ref_type: 'order', ref_id: it.order_id, seller_id: it.seller_id, customer_id: (db.prepare('SELECT customer_id c FROM m_orders WHERE id=?').get(it.order_id) || {}).c, amount: customerRefund });
    const left = db.prepare('SELECT COUNT(*) n FROM m_order_items WHERE order_id=? AND returned_qty < qty').get(it.order_id).n;
    if (!left) setOrder(it.order_id, { status: 'refunded' });
  })();
  return customerRefund;
}
function refundReturn(ret, user, req) {
  const it = db.prepare('SELECT * FROM m_order_items WHERE order_id=? AND product_id=?').get(ret.order_id, ret.product_id);
  if (!it || it.returned_qty + ret.qty > it.qty) throw E.conflict('qty_exceeds_order');
  const amount = refundLine(it, ret.qty, user.username, req);
  R.update('returns', ret.id, null, { status: 'refunded', refund_amount: amount }, req, { internal: true });
  return R.present(R.get('returns'), R.raw(R.get('returns'), ret.id), user);
}
function refundFull(orderId, user, req) {
  const o = db.prepare('SELECT status FROM m_orders WHERE id=?').get(orderId);
  if (o.status !== 'delivered') throw E.conflict('bad_state');
  let sum = 0;
  for (const it of db.prepare('SELECT * FROM m_order_items WHERE order_id=? AND returned_qty < qty').all(orderId)) sum += refundLine(it, it.qty - it.returned_qty, user.username, req);
  return sum;
}
module.exports = { fulfillDigital, createOrder, shipShipment, deliverShipment, cancel, refundReturn, refundFull, refundLine, taxRate, settle };
