'use strict';
const { db } = require('../db');
const { now, day } = require('./common');

const iso = t => new Date(t).toISOString().slice(0, 10);
const stats = a => { const m = a.reduce((s, x) => s + x, 0) / (a.length || 1); return { m, sd: Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length || 1)) }; };
function alert(kind, severity, title, detail, dedupe) {
  return db.prepare("INSERT OR IGNORE INTO m_alerts(kind,severity,title,detail,status,dedupe,created_at,updated_at,created_by) VALUES(?,?,?,?,'open',?,?,?,'system')")
    .run(kind, severity, title.slice(0, 150), (detail || '').slice(0, 250), dedupe, now(), now()).changes;
}
// Statistical + threshold checks over the event stream. Transparent rules (3σ, ×N spikes), no ML. Idempotent: every alert has a dedupe key.
function scan() {
  let created = 0;
  const t0 = new Date(); t0.setUTCHours(0, 0, 0, 0);
  const today = t0.getTime(), yday = today - day;

  // 1) yesterday's order count vs. the previous 14 days (±3σ)
  const perDay = db.prepare("SELECT CAST((created_at - ?) / ? AS INTEGER) d, COUNT(*) n FROM m_orders WHERE created_at >= ? AND created_at < ? AND status<>'cancelled' GROUP BY d")
    .all(today, day, today - 15 * day, today);
  const byIdx = new Map(perDay.map(r => [Math.floor(r.d), r.n]));
  const hist = []; for (let i = 2; i <= 15; i++) hist.push(byIdx.get(-i) || 0);
  const y = byIdx.get(-1) || 0, { m, sd } = stats(hist);
  if (m >= 3 && Math.abs(y - m) > 3 * Math.max(sd, 1)) created += alert('anomaly', y > m ? 'medium' : 'high', `Заказов за ${iso(yday)}: ${y} (норма ≈ ${m.toFixed(1)})`, `σ=${sd.toFixed(1)}`, `orders:${iso(yday)}`);

  // 2) price crashed by ≥ 50% in the last 24 h
  for (const h of db.prepare('SELECT * FROM m_price_history WHERE created_at>? AND old_price>0 AND new_price*2 < old_price').all(now() - day))
    created += alert('anomaly', 'high', `Цена товара #${h.product_id} упала ${h.old_price} → ${h.new_price}`, `reason: ${h.reason}`, `price:${h.id}`);

  // 3) refunds in last 24h vs 14-day daily average
  const ref24 = db.prepare("SELECT COUNT(*) n FROM m_events WHERE kind='refund' AND ts>?").get(now() - day).n;
  const refPrev = db.prepare("SELECT COUNT(*) n FROM m_events WHERE kind='refund' AND ts>? AND ts<=?").get(now() - 15 * day, now() - day).n / 14;
  if (ref24 >= 5 && ref24 > 3 * Math.max(refPrev, 1)) created += alert('anomaly', 'high', `Всплеск возвратов: ${ref24} за сутки`, `среднее ${refPrev.toFixed(1)}/день`, `refunds:${iso(now())}`);

  // 4) seller sales volume ×5 above own average
  for (const s of db.prepare("SELECT seller_id, SUM(amount) a FROM m_events WHERE kind='order_item' AND ts>? GROUP BY seller_id").all(now() - day)) {
    const avg = (db.prepare("SELECT COALESCE(SUM(amount),0) a FROM m_events WHERE kind='order_item' AND seller_id=? AND ts>? AND ts<=?").get(s.seller_id, now() - 15 * day, now() - day).a) / 14;
    if (s.a > 5 * Math.max(avg, 1000) && s.a > 50000) created += alert('anomaly', 'medium', `Продажи продавца #${s.seller_id} ×${(s.a / Math.max(avg, 1)).toFixed(1)} к норме`, `${s.a} за 24ч`, `seller:${s.seller_id}:${iso(now())}`);
  }
  // 5) low stock
  for (const r of db.prepare('SELECT id, product_id, warehouse_id, qty - reserved free, reorder_level FROM m_stock WHERE reorder_level > 0 AND qty - reserved <= reorder_level').all())
    created += alert('stock', 'low', `Остаток товара #${r.product_id} на складе #${r.warehouse_id}: ${r.free}`, `порог ${r.reorder_level}`, `stock:${r.id}:${iso(now())}`);
  return { created };
}
module.exports = { scan };
