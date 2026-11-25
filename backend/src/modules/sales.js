'use strict';
/* Sales & marketing department: one place where a manager — a person or the AI manager (Argon) — sees how the shop sells
   and acts on it: card quality, prices against competitors, stock cover, slow movers to promote. Everything that changes
   data goes through the normal resource rules (R.update), so validators, price guards and the AI-agent limits apply.
   Also the owner's switch that hands the store to the AI manager while the owner is away (services/delegate). */
const { db, audit } = require('../db');
const { E } = require('../engine/errors');
const R = require('../engine/resource');
const delegate = require('../services/delegate');

const DAY = 864e5;
const int = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
const imgs = p => { try { const a = JSON.parse(p.images || '[]'); return Array.isArray(a) ? a.length : 0; } catch { return 0; } };
const SOLD = "SELECT oi.product_id, SUM(oi.qty - COALESCE(oi.returned_qty,0)) qty, SUM((oi.qty - COALESCE(oi.returned_qty,0)) * oi.unit_price) revenue FROM m_order_items oi JOIN m_orders o ON o.id=oi.order_id WHERE o.created_at>=? AND o.status NOT IN ('cancelled','refunded') GROUP BY oi.product_id";
const soldMap = days => new Map(db.prepare(SOLD).all(Date.now() - days * DAY).map(r => [r.product_id, r]));
const stockMap = () => new Map(db.prepare('SELECT product_id, SUM(qty) qty, SUM(reserved) reserved, MAX(reorder_level) reorder FROM m_stock GROUP BY product_id').all().map(r => [r.product_id, r]));

/* ---------- card quality: what to fix first ---------- */
function cardIssues(p) {
  const issues = [], text = p.description || p.seo_description || '';
  const t = (p.title || '').trim();
  if (t.length < 15) issues.push('title_short'); else if (t.length > 150) issues.push('title_long');
  if (/(.)\1{4,}|!!|\b(best|najlepszy|лучший|hit|super)\b/i.test(t)) issues.push('title_spammy');
  if (text.length < 80) issues.push('description_short'); else if (text.length < 300) issues.push('description_thin');
  const n = imgs(p); if (n === 0) issues.push('no_photos'); else if (n < 3) issues.push('few_photos');
  if (!p.category_id) issues.push('no_category');
  if (!p.brand) issues.push('no_brand');
  if (!p.barcode) issues.push('no_barcode');
  if (!p.manufacturer_name) issues.push('no_manufacturer');
  if (!p.safety_info) issues.push('no_safety_info');
  if (!(p.price > 0)) issues.push('no_price');
  if (p.cost != null && p.price < p.cost) issues.push('below_cost');
  if (p.competitor_price > 0 && p.price > p.competitor_price * 1.1) issues.push('pricier_than_competitor');
  return issues;
}
const WEIGHT = { no_price: 30, below_cost: 25, no_photos: 25, description_short: 20, title_short: 15, no_category: 15, title_spammy: 10, few_photos: 10,
  description_thin: 8, pricier_than_competitor: 8, no_manufacturer: 8, no_safety_info: 6, title_long: 5, no_brand: 4, no_barcode: 3 };
const score = issues => Math.max(0, 100 - issues.reduce((s, i) => s + (WEIGHT[i] || 5), 0));

function cardsAudit({ limit = 50, maxScore = 100, status } = {}) {
  const rows = db.prepare(`SELECT * FROM m_products WHERE status ${status ? '= ?' : "<> 'delisted'"}`).all(...(status ? [status] : []));
  const sold = soldMap(30), stock = stockMap();
  const items = rows.map(p => { const issues = cardIssues(p); return { id: p.id, sku: p.sku, title: p.title, status: p.status, price: p.price,
      score: score(issues), issues, sold_30d: sold.get(p.id)?.qty || 0, stock: (stock.get(p.id)?.qty || 0) - (stock.get(p.id)?.reserved || 0) }; })
    .filter(x => x.score <= maxScore)
    // worst first, and among equals the ones that sell or are in stock (fixing them pays first)
    .sort((a, b) => a.score - b.score || b.sold_30d - a.sold_30d || b.stock - a.stock);
  const buckets = { bad: items.filter(x => x.score < 50).length, fair: items.filter(x => x.score >= 50 && x.score < 80).length, good: items.filter(x => x.score >= 80).length };
  return { total: items.length, buckets, items: items.slice(0, limit) };
}

/* ---------- prices ---------- */
// best verified outside price for a product: its competitor_price, or the cheapest fresh external offer for its model
function outsidePrice(p) {
  let best = p.competitor_price > 0 ? p.competitor_price : null;
  try {
    const slug = p.model_slug || `p-${p.id}`;
    const x = db.prepare('SELECT MIN(price + COALESCE(shipping,0)) m FROM m_external_offers WHERE model_slug=? AND active=1 AND checked_at>=?').get(slug, Date.now() - 3 * DAY);
    if (x && x.m > 0 && (best == null || x.m < best)) best = x.m;
  } catch { /* table may be absent in old installs */ }
  return best;
}
function pricePlan(user, b) {
  const rule = b.rule;
  if (!['competitor', 'percent'].includes(rule)) throw E.bad('invalid_rule');
  let rows;
  if (Array.isArray(b.ids)) { if (!b.ids.length || b.ids.length > 1000 || b.ids.some(x => !Number.isSafeInteger(x))) throw E.bad('invalid_ids'); rows = db.prepare(`SELECT * FROM m_products WHERE id IN (${b.ids.map(() => '?').join(',')})`).all(...b.ids); }
  else if (b.category_id) rows = db.prepare('SELECT * FROM m_products WHERE category_id=? AND status=\'approved\'').all(Number(b.category_id));
  else if (rule === 'competitor') rows = db.prepare("SELECT * FROM m_products WHERE status='approved'").all();
  else throw E.bad('ids_or_category_required');
  const undercut = int(b.undercut_pct, 0, 30, 1), pct = rule === 'percent' ? Number(b.pct) : 0;
  if (rule === 'percent' && (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > 50)) throw E.bad('invalid_pct');
  const stepPct = user && user.apiKey ? delegate.state().price_pct : int(b.max_step_pct, 1, 50, 20);
  const out = [], skipped = [];
  for (const p of rows) {
    if (!(p.price > 0)) { skipped.push({ id: p.id, reason: 'no_price' }); continue; }
    let target;
    if (rule === 'competitor') {
      const o = outsidePrice(p); if (!o) { skipped.push({ id: p.id, reason: 'no_competitor_price' }); continue; }
      target = Math.round(o * (100 - undercut) / 100);
    } else target = Math.round(p.price * (100 + pct) / 100);
    const floor = Math.max(p.min_price || 0, p.cost || 0, 1), ceil = p.max_price || Infinity;
    const step = Math.floor(p.price * stepPct / 100);
    target = Math.min(Math.max(target, p.price - step), p.price + step);           // at most N % per run
    target = Math.min(Math.max(target, floor), ceil);                                 // never below cost / min, never above max
    if (target === p.price) { skipped.push({ id: p.id, reason: 'no_change' }); continue; }
    out.push({ id: p.id, sku: p.sku, title: p.title, old_price: p.price, new_price: target, change_pct: Math.round((target - p.price) * 1000 / p.price) / 10,
      floor, outside: rule === 'competitor' ? outsidePrice(p) : null });
  }
  return { rule, step_pct: stepPct, changes: out, skipped: skipped.slice(0, 200), skipped_count: skipped.length };
}
function applyPrices(user, req, changes) {
  const hist = db.prepare('INSERT INTO m_price_history(product_id,old_price,new_price,reason,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)');
  let applied = 0; const failed = [];
  for (const c of changes) {
    try {
      // a planned drop larger than the staff guard is confirmed by the plan itself; AI-agent limits still apply in the validator
      R.update('products', c.id, user, { price: c.new_price, price_confirm: true }, req);
      hist.run(c.id, c.old_price, c.new_price, 'sales plan', Date.now(), Date.now(), user.username);
      applied++;
    } catch (e) { failed.push({ id: c.id, error: e.code || e.message }); }
  }
  return { applied, failed };
}

/* ---------- stock cover ---------- */
function stockReport({ days = 30, coverDays = 14, limit = 100 } = {}) {
  const sold = soldMap(days), stock = stockMap();
  const rows = db.prepare("SELECT id, sku, title, price FROM m_products WHERE status='approved' AND COALESCE(digital,0)=0").all().map(p => {
    const s = stock.get(p.id) || { qty: 0, reserved: 0, reorder: 0 }, avail = (s.qty || 0) - (s.reserved || 0), q = sold.get(p.id)?.qty || 0;
    const perDay = q / days, cover = perDay > 0 ? Math.floor(avail / perDay) : null;
    return { id: p.id, sku: p.sku, title: p.title, available: avail, reorder_level: s.reorder || 0, sold: q, per_day: Math.round(perDay * 100) / 100, days_of_cover: cover,
      status: avail <= 0 ? (q > 0 ? 'out_selling' : 'out') : (cover != null && cover < coverDays) || (s.reorder && avail <= s.reorder) ? 'low' : q === 0 ? 'not_selling' : 'ok' };
  });
  const order = { out_selling: 0, low: 1, out: 2, not_selling: 3, ok: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9));
  const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { days, cover_days: coverDays, counts, items: rows.slice(0, limit) };
}

/* ---------- promotion ideas (never applied by themselves) ---------- */
function promoSuggest({ limit = 20 } = {}) {
  const sold30 = soldMap(30), sold90 = soldMap(90), stock = stockMap(), old = Date.now() - 30 * DAY;
  const ps = db.prepare("SELECT * FROM m_products WHERE status='approved'").all();
  const avail = p => (stock.get(p.id)?.qty || 0) - (stock.get(p.id)?.reserved || 0);
  const slow = ps.filter(p => avail(p) > 0 && !(sold30.get(p.id)?.qty) && p.created_at < old)
    .map(p => ({ id: p.id, sku: p.sku, title: p.title, price: p.price, available: avail(p), sold_90d: sold90.get(p.id)?.qty || 0,
      margin_pct: p.cost ? Math.round((p.price - p.cost) * 100 / p.price) : null, idea: p.cost && p.price > p.cost * 1.15 ? 'markdown' : 'bundle_or_ads' }))
    .sort((a, b) => b.available - a.available).slice(0, limit);
  const stars = ps.filter(p => (sold30.get(p.id)?.qty || 0) > 0 && avail(p) > 0)
    .map(p => ({ id: p.id, sku: p.sku, title: p.title, price: p.price, sold_30d: sold30.get(p.id).qty, revenue_30d: sold30.get(p.id).revenue, card_score: score(cardIssues(p)) }))
    .sort((a, b) => b.revenue_30d - a.revenue_30d).slice(0, limit);
  return { slow_movers: slow, best_sellers: stars,
    rules: ['Скидка показывается только от реальной прежней цены (самая низкая цена за 30 дней — Omnibus).', 'Никаких выдуманных счётчиков, отзывов и «последний товар».'] };
}

function dashboard() {
  const since = d => Date.now() - d * DAY;
  const sum = d => db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) revenue FROM m_orders WHERE created_at>=? AND status NOT IN ('cancelled','refunded')").get(since(d));
  const count = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch { return null; } };
  const cards = cardsAudit({ limit: 0 }), stock = stockReport({ limit: 0 });
  const top = [...soldMap(30).values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10)
    .map(r => ({ ...r, title: db.prepare('SELECT title FROM m_products WHERE id=?').get(r.product_id)?.title }));
  return {
    sales: { d1: sum(1), d7: sum(7), d30: sum(30) }, top_30d: top,
    cards: cards.buckets, stock: stock.counts,
    queues: {
      products_pending_review: count("SELECT COUNT(*) n FROM m_products WHERE status='pending_review'"),
      inquiries_open: count("SELECT COUNT(*) n FROM m_inquiries WHERE status='open'"),
      tickets_open: count("SELECT COUNT(*) n FROM m_tickets WHERE status NOT IN ('closed','resolved')"),
      orders_new: count("SELECT COUNT(*) n FROM m_orders WHERE status IN ('new','held')")
    },
    delegate: delegate.state()
  };
}

module.exports.routes = (r, h) => {
  r.get('/sales/me', h.need('sales.read'), (req, res) => {
    const s = delegate.state();
    res.json({ user: req.user.username, role: req.user.role, owner_away: !!req.user.delegate,
      mode: s.on ? { on: true, until: s.until, note: s.note } : { on: false }, limits: { price_change_pct: s.price_pct, discount_pct: s.discount_pct } });
  });
  r.get('/sales/dashboard', h.need('sales.read'), (_req, res) => res.json(dashboard()));
  r.get('/sales/cards', h.need('sales.read'), (req, res) => res.json(cardsAudit({ limit: int(req.query.limit, 1, 500, 50), maxScore: int(req.query.max_score, 0, 100, 100), status: typeof req.query.status === 'string' ? req.query.status : undefined })));
  r.post('/sales/prices/plan', h.need('pricing.read'), (req, res) => {
    const b = req.body || {}, plan = pricePlan(req.user, b);
    if (b.apply !== true) return res.json({ ...plan, applied: 0, dry: true });
    if (!require('../iam/permissions').can(req.user, 'pricing.write') || !require('../iam/permissions').can(req.user, 'products.write')) throw E.forbidden();
    const r2 = applyPrices(req.user, req, plan.changes);
    audit(req, 'sales.prices', `${plan.rule} applied ${r2.applied}/${plan.changes.length}`, req.user.username);
    res.json({ ...plan, ...r2, dry: false });
  });
  r.get('/sales/stock', h.need('sales.read'), (req, res) => res.json(stockReport({ days: int(req.query.days, 7, 180, 30), coverDays: int(req.query.cover_days, 1, 120, 14), limit: int(req.query.limit, 1, 1000, 100) })));
  r.get('/sales/promo', h.need('sales.read'), (req, res) => res.json(promoSuggest({ limit: int(req.query.limit, 1, 100, 20) })));

  // owner away: only a person with the owner's rights (keys are denied 'delegate.*')
  r.get('/delegate', h.need('delegate.manage'), (_req, res) => res.json(delegate.state()));
  r.put('/delegate', h.need('delegate.manage'), (req, res) => {
    const s = delegate.set(req.body, req.user.username);
    audit(req, 'delegate', s.on ? `ON until ${new Date(s.until).toISOString()} price±${s.price_pct}% discount≤${s.discount_pct}%` : 'OFF', req.user.username);
    res.json(s);
  });
  r.get('/delegate/report', h.need('delegate.manage'), (req, res) => res.json(delegate.report(req.query.since)));
};
module.exports.cardIssues = cardIssues;
