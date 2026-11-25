'use strict';
// Competitor offers found by the AI web search (services/ai.js → competitorSearch). One row per offer per check; the newest check
// of a product replaces the previous one. product.competitor_price (used by the repricer) is set ONLY from verified, exact,
// same-currency offers — an unconfirmed AI answer can never move a price.
const { db } = require('../db');
const cfg = require('../config');

db.exec(`CREATE TABLE IF NOT EXISTS m_competitor_offers(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, platform TEXT, title TEXT, price INTEGER NOT NULL, currency TEXT NOT NULL,
  url TEXT NOT NULL, seller TEXT, in_stock INTEGER, match TEXT, verified INTEGER NOT NULL DEFAULT 0, found_at INTEGER NOT NULL, provider TEXT);
CREATE INDEX IF NOT EXISTS ix_comp_product ON m_competitor_offers(product_id, found_at);`);

function store(productId, offers, provider) {
  const ts = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM m_competitor_offers WHERE product_id=?').run(productId);
    const ins = db.prepare('INSERT INTO m_competitor_offers(product_id,platform,title,price,currency,url,seller,in_stock,match,verified,found_at,provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const o of offers) ins.run(productId, o.platform, o.title, o.price, o.currency, o.url, o.seller, o.in_stock == null ? null : o.in_stock ? 1 : 0, o.match, o.verified ? 1 : 0, ts, provider);
    const best = offers.filter(o => o.verified && o.match === 'exact' && o.currency === cfg.currency).map(o => o.price).sort((a, b) => a - b)[0];
    db.prepare('UPDATE m_products SET competitor_price=?, competitor_checked_at=? WHERE id=?').run(best ?? null, ts, productId);
  })();
  return summary(productId);
}
const list = productId => db.prepare('SELECT * FROM m_competitor_offers WHERE product_id=? ORDER BY verified DESC, match=\'exact\' DESC, price ASC').all(productId)
  .map(r => ({ ...r, verified: !!r.verified, in_stock: r.in_stock == null ? null : !!r.in_stock }));
function summary(productId) {
  const p = db.prepare('SELECT id, title, price, cost, competitor_price, competitor_checked_at FROM m_products WHERE id=?').get(productId);
  const offers = list(productId), same = offers.filter(o => o.verified && o.match === 'exact' && o.currency === cfg.currency).map(o => o.price).sort((a, b) => a - b);
  const median = same.length ? same[Math.floor((same.length - 1) / 2)] : null;
  return { product: p, offers, currency: cfg.currency, min: same[0] ?? null, median, count_verified: same.length,
    position: median == null ? null : p.price < median * 0.97 ? 'cheaper' : p.price > median * 1.03 ? 'pricier' : 'same',
    diff_pct: median ? Math.round((p.price - median) / median * 1000) / 10 : null, checked_at: p.competitor_checked_at };
}
// whole-catalogue view: every product with its last check
function overview() {
  return db.prepare('SELECT id, sku, title, price, cost, competitor_price, competitor_checked_at FROM m_products WHERE status<>\'delisted\' ORDER BY competitor_checked_at IS NULL, competitor_checked_at DESC, id').all().map(p => {
    const offers = db.prepare('SELECT COUNT(*) n, SUM(verified) v FROM m_competitor_offers WHERE product_id=?').get(p.id);
    return { ...p, offers: offers.n, verified: offers.v || 0, diff_pct: p.competitor_price ? Math.round((p.price - p.competitor_price) / p.competitor_price * 1000) / 10 : null };
  });
}
module.exports = { store, list, summary, overview };
