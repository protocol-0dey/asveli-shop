'use strict';
const { db } = require('../db');
const { bps, now, event, day } = require('./common');

// Markdown robot: a product that sits in stock and does not sell gets a small step-down (default −5% every 3 days) until it moves.
// Guardrails: only products with an explicit floor (min_price), never below max(min_price, cost), one step per `everyDays`,
// and every change is written to price history with reason 'markdown'. Dry-run by default.
function run({ dry = true, stepBps = 500, everyDays = 3, minStock = 20, days = 30, maxUnits = 2, by = 'markdown-robot' } = {}) {
  const changes = [];
  const stock = db.prepare('SELECT COALESCE(SUM(qty-reserved),0) s FROM m_stock WHERE product_id=?');
  const sold = db.prepare("SELECT COALESCE(SUM(i.qty),0) u FROM m_order_items i JOIN m_orders o ON o.id=i.order_id WHERE i.product_id=? AND o.created_at>? AND o.status<>'cancelled'");
  const last = db.prepare("SELECT MAX(created_at) t FROM m_price_history WHERE product_id=? AND reason='markdown'");
  const upd = db.prepare('UPDATE m_products SET price=?, updated_at=? WHERE id=?');
  const hist = db.prepare('INSERT INTO m_price_history(product_id,old_price,new_price,reason,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const p of db.prepare("SELECT * FROM m_products WHERE status='approved' AND min_price IS NOT NULL AND digital=0").all()) {
      const free = stock.get(p.id).s, units = sold.get(p.id, now() - days * day).u;
      if (free < minStock || units > maxUnits) continue;
      const t = last.get(p.id).t; if (t && now() - t < everyDays * day) continue;
      const floor = Math.max(p.min_price, p.cost || 0);
      const target = Math.max(p.price - bps(p.price, stepBps), floor);
      if (target >= p.price) continue;
      changes.push({ product_id: p.id, sku: p.sku, old_price: p.price, new_price: target, stock: free, sold: units, at_floor: target === floor });
      if (!dry) { upd.run(target, now(), p.id); hist.run(p.id, p.price, target, 'markdown', now(), now(), by); event('price_change', { ref_type: 'product', ref_id: p.id, seller_id: p.seller_id, amount: target - p.price }); }
    }
  })();
  return { dry, changes };
}
module.exports = { run };
