'use strict';
const { db } = require('../db');
const { bps, now, event } = require('./common');

// Rule-based dynamic pricing (not ML): undercut the competitor price by `undercutBps`, but never leave [max(min_price, cost), max_price]
// and never move a price by more than `maxStepBps` (default 20%) in one run, so a bad competitor feed can't wreck the catalogue.
function run({ dry = true, undercutBps = 100, maxStepBps = 2000, by = 'repricer' } = {}) {
  const changes = [];
  const upd = db.prepare('UPDATE m_products SET price=?, updated_at=? WHERE id=?');
  const hist = db.prepare('INSERT INTO m_price_history(product_id,old_price,new_price,reason,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const p of db.prepare("SELECT * FROM m_products WHERE auto_reprice=1 AND status='approved' AND competitor_price>0 AND min_price IS NOT NULL AND max_price IS NOT NULL").all()) {
      const floor = Math.max(p.min_price, p.cost || 0), ceil = p.max_price;
      if (floor > ceil) continue;
      let target = p.competitor_price - bps(p.competitor_price, undercutBps);
      const step = bps(p.price, maxStepBps);
      target = Math.min(Math.max(target, p.price - step), p.price + step);
      target = Math.min(Math.max(target, floor), ceil);
      if (target === p.price) continue;
      changes.push({ product_id: p.id, sku: p.sku, old_price: p.price, new_price: target });
      if (!dry) {
        upd.run(target, now(), p.id);
        hist.run(p.id, p.price, target, 'repricer', now(), now(), by);
        event('price_change', { ref_type: 'product', ref_id: p.id, seller_id: p.seller_id, amount: target - p.price });
      }
    }
  })();
  return { dry, changes };
}
module.exports = { run };
