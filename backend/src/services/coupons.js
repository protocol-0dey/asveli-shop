'use strict';
const { db } = require('../db');
const { E } = require('../engine/errors');
const { bps, now } = require('./common');

// Validates a coupon for this customer/subtotal and returns the discount. Does NOT consume it (see redeem()).
function quote(code, customerId, subtotal) {
  if (code == null || code === '') return null;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{2,30}$/.test(code)) throw E.bad('invalid_coupon');
  const c = db.prepare('SELECT * FROM m_coupons WHERE code=?').get(code.toUpperCase());
  if (!c || !c.active) throw E.bad('invalid_coupon');
  const t = now();
  if ((c.starts_at && t < c.starts_at) || (c.ends_at && t > c.ends_at)) throw E.bad('coupon_expired');
  if (c.max_uses > 0 && c.used >= c.max_uses) throw E.bad('coupon_exhausted');
  if (subtotal < c.min_order) throw E.bad('coupon_min_order');
  const mine = db.prepare('SELECT COUNT(*) n FROM m_coupon_uses WHERE coupon_id=? AND customer_id=?').get(c.id, customerId).n;
  if (mine >= c.per_customer) throw E.bad('coupon_already_used');
  const discount = Math.min(subtotal, c.kind === 'percent' ? bps(subtotal, c.value) : c.value);
  return { id: c.id, code: c.code, discount };
}
// Atomic consume: the WHERE clause re-checks max_uses so two simultaneous orders cannot both take the last use.
function redeem(q, customerId, orderId) {
  if (!q) return;
  const r = db.prepare('UPDATE m_coupons SET used = used + 1 WHERE id=? AND (max_uses=0 OR used < max_uses)').run(q.id);
  if (r.changes !== 1) throw E.bad('coupon_exhausted');
  db.prepare('INSERT INTO m_coupon_uses(coupon_id,customer_id,order_id,amount,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run(q.id, customerId, orderId, q.discount, now(), now(), 'system');
}
module.exports = { quote, redeem };
