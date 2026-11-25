'use strict';
const { db } = require('../db');
const { now, event } = require('./common');

const DEFAULTS = [
  ['mass_buyout', 60, 24, 60, 'Покупатель скупает ≥ threshold% остатка товара за window_h часов (≥3 шт.)'],
  ['competitor_link', 0, 24, 70, 'Покупатель связан (адрес/e-mail) с ДРУГИМ продавцом и покупает у конкурента'],
  ['velocity', 5, 1, 40, 'Больше threshold заказов за window_h часов'],
  ['high_value_new', 100000, 0, 30, 'Новый покупатель (нет доставленных заказов) с заказом ≥ threshold (центы)'],
  ['country_mismatch', 0, 0, 15, 'Страна доставки ≠ страна покупателя'],
  ['hold_threshold', 60, 0, 0, 'Суммарный балл ≥ threshold → заказ уходит в hold']
];
function seed() {
  const ins = db.prepare('INSERT OR IGNORE INTO m_fraud_rules(rule,enabled,threshold,window_h,score,note,created_at,updated_at,created_by) VALUES(?,1,?,?,?,?,?,?,?)');
  for (const [r, t, w, s, n] of DEFAULTS) ins.run(r, t, w, s, n, now(), now(), 'system');
}
const rules = () => Object.fromEntries(db.prepare('SELECT * FROM m_fraud_rules WHERE enabled=1').all().map(r => [r.rule, r]));

// Behavioural scoring of an order that is about to be created. Pure rules (transparent + tunable by staff), no ML.
function assess({ customer, country, lines, total }) {
  const R = rules(), flags = [];
  const add = (rule, detail) => flags.push({ rule, score: R[rule].score, detail: detail.slice(0, 250) });

  if (R.mass_buyout) {
    const since = now() - R.mass_buyout.window_h * 36e5;
    for (const l of lines) {
      const before = db.prepare(`SELECT COALESCE(SUM(i.qty),0) q FROM m_order_items i JOIN m_orders o ON o.id=i.order_id
        WHERE o.customer_id=? AND i.product_id=? AND o.status<>'cancelled' AND o.created_at>?`).get(customer.id, l.product_id, since).q;
      const onHand = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM m_stock WHERE product_id=?').get(l.product_id).q;
      const cumulative = before + l.qty, pool = onHand + before;
      if (cumulative >= 3 && pool > 0 && cumulative * 100 >= R.mass_buyout.threshold * pool) {
        add('mass_buyout', `product #${l.product_id}: ${cumulative} of ${pool} units (${Math.round(cumulative * 100 / pool)}%) in ${R.mass_buyout.window_h}h`);
        break;
      }
    }
  }
  if (R.competitor_link && (customer.address_bi || customer.email_bi)) {
    for (const l of lines) {
      const link = db.prepare('SELECT id FROM m_sellers WHERE id<>? AND ((address_bi IS NOT NULL AND address_bi=?) OR (email_bi IS NOT NULL AND email_bi=?)) LIMIT 1')
        .get(l.seller_id, customer.address_bi || '-', customer.email_bi || '-');
      if (link) { add('competitor_link', `buyer is linked to seller #${link.id} and buys from seller #${l.seller_id}`); break; }
    }
  }
  if (R.velocity) {
    const n = db.prepare("SELECT COUNT(*) n FROM m_orders WHERE customer_id=? AND created_at>? AND status<>'cancelled'").get(customer.id, now() - R.velocity.window_h * 36e5).n;
    if (n + 1 > R.velocity.threshold) add('velocity', `${n + 1} orders in ${R.velocity.window_h}h`);
  }
  if (R.high_value_new && total >= R.high_value_new.threshold && customer.orders_count === 0) add('high_value_new', `first order of ${total} minor units`);
  if (R.country_mismatch && customer.country && customer.country !== country) add('country_mismatch', `ship-to ${country}, customer ${customer.country}`);

  const score = Math.min(100, flags.reduce((s, f) => s + f.score, 0));
  const hold = score >= ((R.hold_threshold || { threshold: 60 }).threshold);
  return { score, flags, hold };
}

function record(orderId, customerId, result) {
  for (const f of result.flags)
    db.prepare('INSERT INTO m_fraud_flags(order_id,customer_id,rule,score,detail,status,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(orderId, customerId, f.rule, f.score, f.detail, 'open', now(), now(), 'system');
  if (result.hold) {
    db.prepare("INSERT OR IGNORE INTO m_alerts(kind,severity,title,detail,status,dedupe,created_at,updated_at,created_by) VALUES('fraud','high',?,?,'open',?,?,?,'system')")
      .run(`Заказ #${orderId} задержан (score ${result.score})`, result.flags.map(f => f.rule).join(', '), `fraud:${orderId}`, now(), now());
    event('order_held', { ref_type: 'order', ref_id: orderId, customer_id: customerId, amount: result.score });
  }
}
module.exports = { assess, record, seed, DEFAULTS };
