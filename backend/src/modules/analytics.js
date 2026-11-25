'use strict';
/* MODULE 5 — Analytics & BI: platform dashboard, per-seller dashboard, anomaly scan. Read-only aggregates over orders/ledger/events. */
const { db, audit } = require('../db');
const { E } = require('../engine/errors');
const { can } = require('../iam/permissions');
const C = require('../services/common');
const anomalies = require('../services/anomalies');

const daysParam = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : 30; };

module.exports.routes = (r, h) => {
  r.get('/analytics/platform', h.need('analytics.read'), (req, res) => {
    const days = daysParam(req.query.days), since = C.now() - days * C.day;
    const o = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) gmv FROM m_orders WHERE created_at>? AND status NOT IN ('cancelled')").get(since);
    const refunds = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM m_events WHERE kind='refund' AND ts>?").get(since);
    const take = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM m_ledger WHERE kind='commission' AND created_at>?").get(since).s;
    res.json({
      days, orders: o.n, gmv: o.gmv, aov: o.n ? Math.round(o.gmv / o.n) : 0, refunds: refunds.n, refunded_amount: refunds.s, commission: take,
      take_rate_bps: o.gmv ? Math.round(take * 10000 / o.gmv) : 0,
      new_customers: db.prepare('SELECT COUNT(*) n FROM m_customers WHERE created_at>?').get(since).n,
      held_orders: db.prepare("SELECT COUNT(*) n FROM m_orders WHERE status='held'").get().n,
      by_day: db.prepare("SELECT date(created_at/1000,'unixepoch') d, COUNT(*) orders, SUM(total) gmv FROM m_orders WHERE created_at>? AND status<>'cancelled' GROUP BY d ORDER BY d").all(since),
      by_country: db.prepare("SELECT country, COUNT(*) orders, SUM(total) gmv FROM m_orders WHERE created_at>? AND status<>'cancelled' GROUP BY country ORDER BY gmv DESC LIMIT 15").all(since),
      top_sellers: db.prepare("SELECT s.id, s.name, SUM(e.amount) gmv FROM m_events e JOIN m_sellers s ON s.id=e.seller_id WHERE e.kind='order_item' AND e.ts>? GROUP BY s.id ORDER BY gmv DESC LIMIT 10").all(since),
      top_products: db.prepare("SELECT p.id, p.title, SUM(e.amount) gmv FROM m_events e JOIN m_products p ON p.id=e.ref_id WHERE e.kind='order_item' AND e.ts>? GROUP BY p.id ORDER BY gmv DESC LIMIT 10").all(since),
      open_alerts: db.prepare("SELECT COUNT(*) n FROM m_alerts WHERE status='open'").get().n
    });
  });
  r.get('/analytics/seller/:id', h.need('analytics.read'), (req, res) => {
    const id = h.id(req.params.id), days = daysParam(req.query.days), since = C.now() - days * C.day;
    const s = db.prepare('SELECT id, name, country, status, kyc_status, risk_tier FROM m_sellers WHERE id=?').get(id); if (!s) throw E.notFound();
    const sales = db.prepare("SELECT COUNT(DISTINCT i.order_id) orders, COALESCE(SUM(i.qty),0) units, COALESCE(SUM(i.unit_price*i.qty),0) gross, COALESCE(SUM(i.returned_qty),0) returned FROM m_order_items i JOIN m_orders o ON o.id=i.order_id WHERE i.seller_id=? AND o.created_at>? AND o.status<>'cancelled'").get(id, since);
    const camp = db.prepare('SELECT COALESCE(SUM(spent),0) spent, COALESCE(SUM(revenue),0) revenue FROM m_campaigns WHERE seller_id=?').get(id);
    res.json({
      seller: s, days, ...sales, return_rate_bps: sales.units ? Math.round(sales.returned * 10000 / sales.units) : 0,
      ...(can(req.user, 'ledger.read') ? { balance: C.sellerBalance(id), pending_payouts: C.pendingPayouts(id) } : {}), ads: camp,
      products: db.prepare("SELECT status, COUNT(*) n FROM m_products WHERE seller_id=? GROUP BY status").all(id),
      low_stock: db.prepare('SELECT p.id, p.title, st.warehouse_id, st.qty - st.reserved free, st.reorder_level FROM m_stock st JOIN m_products p ON p.id=st.product_id WHERE p.seller_id=? AND st.reorder_level>0 AND st.qty - st.reserved <= st.reorder_level LIMIT 20').all(id)
    });
  });
  r.post('/alerts/scan', h.need('alerts.write'), (req, res) => { const out = anomalies.scan(); audit(req, 'anomaly_scan', `${out.created} new`); res.json(out); });
};
