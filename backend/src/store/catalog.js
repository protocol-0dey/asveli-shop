'use strict';
/* Storefront read model: models (single product pages) with offers from many sellers, Buy Box, search, recommendations.
   Built from the admin-managed tables (m_products / m_sellers / m_stock / m_reviews / m_events); cached in memory for a few seconds. */
const { db } = require('../db');
const cfg = require('../config');
const routing = require('../services/routing');
const trust = require('../services/trust');
const cats = require('../services/categories');

const TTL = Number(process.env.STORE_INDEX_TTL_MS) || 15000;
let cache = null, cacheAt = 0;
const invalidate = () => { cache = null; };

/* ---------- text helpers ---------- */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = s => norm(s).split(/[^a-z0-9Ѐ-ӿ]+/).filter(Boolean);
function lev(a, b, max) {                                   // bounded Levenshtein: stops early once the distance exceeds `max`
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const slugify = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
const modelSlugOf = p => (p.model_slug && p.model_slug.trim()) || `p-${p.id}`;
function parseImages(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.filter(u => typeof u === 'string').map(u => (u.startsWith('/f/') ? cfg.baseUrl + u : u)) : []; } catch { return []; } }

/* ---------- index ---------- */
function build() {
  const t = Date.now();
  const rows = db.prepare(`SELECT p.id, p.sku, p.title, p.category, p.description, p.price, p.weight_g, p.brand, p.images, p.digital, p.model_slug, p.seller_id,
      p.created_at, p.competitor_price, p.digital_file, s.name seller_name, s.country seller_country,
      p.category_id, p.barcode, p.external_id, p.sale_regions, p.manufacturer_name, p.manufacturer_address, p.manufacturer_email, p.manufacturer_country,
      p.responsible_eu, p.responsible_uk, p.responsible_us, p.safety_info, p.brand_proof, p.brand_proof_status,
      COALESCE((SELECT SUM(st.qty - st.reserved) FROM m_stock st JOIN m_warehouses w ON w.id = st.warehouse_id WHERE st.product_id = p.id AND w.active = 1), 0) free
    FROM m_products p JOIN m_sellers s ON s.id = p.seller_id WHERE p.status = 'approved' AND s.status = 'active'`).all();
  const rev = new Map(db.prepare("SELECT product_id, AVG(rating) avg, COUNT(*) n FROM m_reviews WHERE status='published' GROUP BY product_id").all().map(r => [r.product_id, r]));
  const sales = new Map(db.prepare("SELECT ref_id id, COUNT(*) n FROM m_events WHERE kind='order_item' AND ts > ? GROUP BY ref_id").all(t - 30 * 864e5).map(r => [r.id, r.n]));
  const views = new Map(db.prepare('SELECT product_id id, COUNT(*) n FROM s_views WHERE ts > ? GROUP BY product_id').all(t - 7 * 864e5).map(r => [r.id, r.n]));
  const curated = new Map(db.prepare('SELECT * FROM s_models').all().map(m => [m.slug, m]));
  const dropped = new Map(db.prepare('SELECT product_id id, MAX(old_price) was FROM m_price_history WHERE created_at > ? AND new_price < old_price GROUP BY product_id').all(t - 14 * 864e5).map(r => [r.id, r.was]));

  const sellerAgg = new Map();                               // seller reputation = review-weighted mean over all of their products
  for (const p of rows) { const r = rev.get(p.id); if (!r) continue; const a = sellerAgg.get(p.seller_id) || { sum: 0, n: 0 }; a.sum += r.avg * r.n; a.n += r.n; sellerAgg.set(p.seller_id, a); }
  const sellerRating = id => { const a = sellerAgg.get(id); return a ? { avg: Math.round(a.sum / a.n * 10) / 10, n: a.n } : { avg: null, n: 0 }; };

  // sellers of live offers, with the trader block buyers must see (DSA art. 30(7)) decrypted ONCE per rebuild
  const sellers = new Map(db.prepare("SELECT * FROM m_sellers WHERE status='active'").all().map(s => [s.id, { row: s, trader: trust.publicTrader(s) }]));
  const models = new Map(), byProduct = new Map();
  for (const p of rows.sort((a, b) => a.id - b.id)) {
    const slug = modelSlugOf(p);
    let m = models.get(slug);
    if (!m) {
      const c = curated.get(slug);
      m = { slug, title: c ? c.title : p.title, brand: (c && c.brand) || p.brand || null, category: (c && c.category) || p.category, description: (c && c.description) || p.description || '',
        images: c && c.images ? parseImages(c.images) : [], offers: [], created: p.created_at, sales: 0, views: 0, rsum: 0, rn: 0 };
      models.set(slug, m);
    }
    if (!m.images.length) m.images = parseImages(p.images);
    if (m.category_id === undefined) {                       // the tree node of the page: explicit choice, else title keywords, else the free-text category
      m.category_id = cats.place(p);
      const e = m.category_id ? cats.effective(m.category_id) : { kind: 'shop', restricted: 'none' };
      m.kind = e.kind; m.restricted = e.restricted; m.category_slug = m.category_id ? cats.tree().byId.get(m.category_id).slug : null;
    }
    const r = rev.get(p.id);
    const offer = { ...p, digital: !!p.digital, free: p.digital ? (p.digital_file ? 1e6 : 0) : p.free, rating: r ? r.avg : null, review_count: r ? r.n : 0, seller_rating: sellerRating(p.seller_id), was_price: dropped.get(p.id) || null };
    m.offers.push(offer); byProduct.set(p.id, m);
    m.sales += sales.get(p.id) || 0; m.views += views.get(p.id) || 0;
    if (r) { m.rsum += r.avg * r.n; m.rn += r.n; }
    m.created = Math.max(m.created, p.created_at);
  }
  for (const m of models.values()) {
    m.rating = m.rn ? Math.round(m.rsum / m.rn * 10) / 10 : null; m.reviews = m.rn;
    m.inStock = m.offers.some(o => o.free > 0);
    const live = m.offers.filter(o => o.free > 0), pool = live.length ? live : m.offers;
    m.priceFrom = Math.min(...pool.map(o => o.price)); m.priceTo = Math.max(...pool.map(o => o.price));
    m.deal = pool.some(o => o.was_price && o.price < o.was_price);
    m.tTitle = words(m.title); m.tBrand = words(m.brand); m.tCat = words(m.category); m.tDesc = new Set(words(m.description));
  }
  return { models, byProduct, at: t, sellerRating, sellers };
}
const index = () => { if (!cache || Date.now() - cacheAt > TTL) { cache = build(); cacheAt = Date.now(); } return cache; };

/* ---------- cards & offers ---------- */
function card(m) {
  const best = m.offers.filter(o => o.free > 0).sort((a, b) => a.price - b.price)[0] || m.offers[0];
  return {
    slug: m.slug, title: m.title, brand: m.brand, category: m.category, category_slug: m.category_slug || null, kind: m.kind || 'shop', restricted: m.restricted || 'none',
    image: m.images[0] || null, images: m.images.slice(0, 3),
    price_from: m.priceFrom, price_to: m.priceTo, offers: m.offers.length, rating: m.rating, reviews: m.reviews, in_stock: m.inStock, digital: m.offers.every(o => o.digital),
    product_id: best.id, was_price: m.deal ? (best.was_price || null) : null, currency: cfg.currency, is_new: Date.now() - m.created < 14 * 864e5
  };
}

function deliveryDays(o, country) {
  if (o.digital) return { min: 0, max: 0 };
  const wh = routing.pickWarehouse(o.id, 1, country);
  if (!wh) return null;
  return wh.country === country ? { min: 1, max: 2 } : { min: 3, max: 7 };
}
// Buy Box: the single offer behind the "Buy now" button. Score = price incl. shipping (55%) + seller reputation (25%) + delivery speed (20%).
// Out-of-stock offers can never win while an in-stock one exists. Everything is computed from live data — no seller can buy the box.
// can this offer be sold to a buyer in `country`? (region readiness for gated sellers, chosen regions for the house catalogue)
function sellable(o, country) { const s = index().sellers.get(o.seller_id); return !!s && trust.canSell(o, s.row, country); }
// what GPSR asks a listing to show: manufacturer, the responsible person for the buyer's region, identifier, warnings
function productSafety(o, country) {
  const reg = trust.regionOf(country), R = reg && trust.REGIONS[reg];
  return { manufacturer: o.manufacturer_name ? { name: o.manufacturer_name, address: o.manufacturer_address || null, email: o.manufacturer_email || null, country: o.manufacturer_country || null } : null,
    responsible_person: R && R.responsible ? trust.parseParty(o[R.responsible]) : null, identifier: o.barcode || o.external_id || null, safety_info: o.safety_info || null };
}
function offersFor(m, country) {
  const list = m.offers.map(o => {
    const wh = o.digital ? null : routing.pickWarehouse(o.id, 1, country);
    const carrier = o.digital ? null : routing.pickCarrier(country, o.weight_g || 500);
    const allowed = sellable(o, country);
    const ships = allowed && (o.digital || !!(wh && carrier));
    const sx = index().sellers.get(o.seller_id);
    const ship = o.digital ? 0 : carrier ? routing.buyerShipping(carrier.cost) : null;
    const d = deliveryDays(o, country);
    return { product_id: o.id, seller: { id: o.seller_id, name: o.seller_name, country: o.seller_country, rating: o.seller_rating.avg, reviews: o.seller_rating.n, trader: sx ? sx.trader : null },
      sold_in_country: allowed, product_safety: productSafety(o, country),
      price: o.price, shipping: ship, landed: ship == null ? null : o.price + ship, in_stock: o.free > 0, ships_to_country: ships, delivery: d,
      low_stock: o.free > 0 && o.free <= 5 ? o.free : null, digital: o.digital, condition: 'new', _w: wh };
  });
  const elig = list.filter(o => o.in_stock && o.ships_to_country);
  const pool = elig.length ? elig : list;
  const minLanded = Math.min(...pool.map(o => o.landed ?? o.price)) || 1;
  for (const o of list) {
    const priceScore = minLanded / ((o.landed ?? o.price) || 1);
    const rep = o.seller.rating == null ? 0.8 : o.seller.rating / 5;
    const speed = o.digital ? 1 : !o.delivery ? 0 : o.delivery.max <= 2 ? 1 : 0.6;
    o.score = Math.round((0.55 * priceScore + 0.25 * rep + 0.2 * speed) * 1000) / 1000;
  }
  const eligible = o => o.in_stock && o.ships_to_country;
  list.sort((a, b) => (eligible(b) - eligible(a)) || b.score - a.score || a.price - b.price);
  if (list.length && eligible(list[0])) list[0].buybox = true;
  for (const o of list) { delete o._w; o.buybox = !!o.buybox; }
  return list;
}

/* ---------- search ---------- */
function matchScore(m, toks) {
  let total = 0, matched = 0;
  for (const t of toks) {
    let best = 0;
    const consider = (arr, exact, prefix, fuzzy) => {
      for (const w of arr) {
        if (w === t) best = Math.max(best, exact);
        else if (t.length >= 2 && w.startsWith(t)) best = Math.max(best, prefix);
        else if (t.length >= 3 && w.includes(t)) best = Math.max(best, prefix * 0.5);
        else if (t.length >= 4) { const d = lev(t, w, t.length >= 7 ? 2 : 1); if (d <= (t.length >= 7 ? 2 : 1)) best = Math.max(best, fuzzy - d); }
      }
    };
    consider(m.tTitle, 10, 6, 4.5); consider(m.tBrand, 8, 5, 4); consider(m.tCat, 6, 4, 3);
    if (m.tDesc.has(t)) best = Math.max(best, 1.5);
    if (best > 0) matched++;
    total += best;
  }
  if (toks.length === 0) return 1;
  if (matched < Math.max(1, toks.length - (toks.length >= 4 ? 1 : 0))) return 0;      // every word must match (one slip is forgiven in long queries)
  return total;
}
function rank(m, base) {
  return base * (1 + 0.15 * Math.log1p(m.sales)) * (1 + 0.04 * (m.rating || 3.5)) * (1 + 0.02 * Math.log1p(m.views)) * (m.inStock ? 1 : 0.55);
}
// fastest delivery of a page to `country` (max days of its quickest in-stock offer that may be sold there); cached per country for a minute
const fastCache = new Map();
function fastestDays(m, country) {
  const key = country + ':' + m.slug, hit = fastCache.get(key);
  if (hit && Date.now() - hit.t < 60e3) return hit.d;
  let best = null;
  for (const o of m.offers) {
    if (!(o.free > 0) || !sellable(o, country)) continue;
    const d = deliveryDays(o, country); if (d && (best == null || d.max < best)) best = d.max;
  }
  if (fastCache.size > 50000) fastCache.clear();
  fastCache.set(key, { d: best, t: Date.now() });
  return best;
}
// price bands shown as quick filters: fixed, human steps (in cents of the shop currency)
const BAND_EDGES = [0, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
function search(p) {
  const ix = index(), toks = words(p.q || '').slice(0, 8);
  let rows = [];
  for (const m of ix.models.values()) { const s = matchScore(m, toks); if (s > 0) rows.push({ m, s: rank(m, s) }); }
  const inCat = p.cat ? cats.subtree(p.cat) : null;                    // a tree node includes everything under it (Компьютеры → Клавиатуры, Мыши…)
  const brands = (p.brands || []).map(b => b.toLowerCase());
  const country = p.country || 'PL';
  // facets are counted on the rows that pass every OTHER filter, so each list shows what you would get by clicking it
  const pass = (m, skip) =>
    (skip === 'cat' || ((!inCat || inCat.has(m.category_id)) && (!p.category || m.category === p.category))) &&
    (skip === 'brand' || !brands.length || (m.brand && brands.includes(m.brand.toLowerCase()))) &&
    (skip === 'price' || ((p.min == null || m.priceTo >= p.min) && (p.max == null || m.priceFrom <= p.max))) &&
    (!p.rating || (m.rating || 0) >= p.rating) && (!p.inStock || m.inStock) && (!p.deals || m.deal) && (!p.kind || (m.kind || 'shop') === p.kind) &&
    (skip === 'delivery' || !p.delivery || ((m.kind || 'shop') === 'shop' && (() => { const d = fastestDays(m, country); return d != null && d <= p.delivery; })()));
  const facets = { categories: {}, brands: {}, tree: new Map(), bands: BAND_EDGES.map((lo, i) => ({ min: lo, max: BAND_EDGES[i + 1] ?? null, count: 0 })) };
  let pmin = Infinity, pmax = 0;
  for (const { m } of rows) {
    if (pass(m, 'cat')) { facets.categories[m.category] = (facets.categories[m.category] || 0) + 1; if (m.category_id) facets.tree.set(m.category_id, (facets.tree.get(m.category_id) || 0) + 1); }
    if (pass(m, 'brand') && m.brand) facets.brands[m.brand] = (facets.brands[m.brand] || 0) + 1;
    if (pass(m, 'price')) { pmin = Math.min(pmin, m.priceFrom); pmax = Math.max(pmax, m.priceTo); for (const b of facets.bands) if (m.priceFrom >= b.min && (b.max == null || m.priceFrom < b.max)) b.count++; }
  }
  rows = rows.filter(({ m }) => pass(m, null));
  const sorters = {
    price_asc: (a, b) => a.m.priceFrom - b.m.priceFrom, price_desc: (a, b) => b.m.priceFrom - a.m.priceFrom,
    rating: (a, b) => (b.m.rating || 0) - (a.m.rating || 0) || b.m.reviews - a.m.reviews, popular: (a, b) => b.m.sales - a.m.sales || b.m.views - a.m.views,
    new: (a, b) => b.m.created - a.m.created,
    fast: (a, b) => (fastestDays(a.m, country) ?? 999) - (fastestDays(b.m, country) ?? 999) || a.m.priceFrom - b.m.priceFrom
  };
  rows.sort(sorters[p.sort] ? (a, b) => sorters[p.sort](a, b) || b.s - a.s : (a, b) => b.s - a.s || a.m.title.localeCompare(b.m.title));
  const limit = Math.min(Math.max(p.limit || 24, 1), 60), page = Math.max(p.page || 1, 1);
  const out = { total: rows.length, page, limit, items: rows.slice((page - 1) * limit, page * limit).map(r => card(r.m)),
    facets: { categories: Object.entries(facets.categories).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      brands: Object.entries(facets.brands).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })), price: rows.length || pmax ? { min: pmin === Infinity ? 0 : pmin, max: pmax } : { min: 0, max: 0 },
      tree: cats.publicTree(facets.tree, p.lang).filter(n => n.count > 0 || n.kind !== 'shop'), price_bands: facets.bands.filter(b => b.count > 0) } };
  if (inCat) { const t = cats.tree(), node = t.bySlug.get(p.cat); out.category = { slug: node.slug, name: cats.nameIn(node, p.lang), path: cats.path(node.id, p.lang), ...cats.effective(node.id) }; }
  if (!rows.length && toks.length) out.suggest = suggest(p.q, 3).map(s => s.text);           // "did you mean"
  return out;
}
function suggest(q, limit = 6) {
  const ix = index(), toks = words(q || ''); if (!toks.length) return [];
  const out = [], seen = new Set();
  const push = (text, type, slug, s) => { const k = type + text; if (!seen.has(k)) { seen.add(k); out.push({ text, type, slug: slug || null, s }); } };
  for (const m of ix.models.values()) {
    const s = matchScore(m, toks); if (s > 0) push(m.title, 'product', m.slug, rank(m, s));
  }
  const last = toks[toks.length - 1];
  for (const m of ix.models.values()) {
    for (const [txt, arr] of [[m.brand, m.tBrand], [m.category, m.tCat]]) if (txt && arr.some(w => w.startsWith(last) || (last.length >= 4 && lev(last, w, 1) <= 1))) push(txt, txt === m.brand ? 'brand' : 'category', null, 5);
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit).map(({ s, ...r }) => r);
}

/* ---------- recommendations ---------- */
function viewerKey(req) {
  const a = req.accountId, anon = /^[A-Za-z0-9_-]{16,64}$/.test(req.headers['x-anon-id'] || '') ? req.headers['x-anon-id'] : null;
  return { account: a || null, anon: a ? null : anon };
}
function history(v) {
  const since = Date.now() - 60 * 864e5, h = { viewed: [], bought: [] };
  if (v.account) {
    h.viewed = db.prepare('SELECT product_id id, MAX(ts) ts FROM s_views WHERE account_id=? AND ts>? GROUP BY product_id ORDER BY ts DESC LIMIT 60').all(v.account, since).map(r => r.id);
    h.bought = db.prepare(`SELECT DISTINCT i.product_id id FROM m_order_items i JOIN m_orders o ON o.id=i.order_id JOIN s_accounts a ON a.customer_id=o.customer_id
      WHERE a.id=? AND o.status NOT IN ('cancelled')`).all(v.account).map(r => r.id);
  } else if (v.anon) {
    h.viewed = db.prepare('SELECT product_id id, MAX(ts) ts FROM s_views WHERE anon=? AND ts>? GROUP BY product_id ORDER BY ts DESC LIMIT 60').all(v.anon, since).map(r => r.id);
  }
  return h;
}
function recentlyViewed(v, limit = 10) {
  const ix = index(), seen = new Set(), out = [];
  for (const id of history(v).viewed) { const m = ix.byProduct.get(id); if (m && !seen.has(m.slug)) { seen.add(m.slug); out.push(card(m)); } if (out.length >= limit) break; }
  return out;
}
function forYou(v, limit = 12) {
  const ix = index(), h = history(v), cat = new Map(), brand = new Map(), own = new Set();
  const add = (id, w) => { const m = ix.byProduct.get(id); if (!m) return; own.add(m.slug); cat.set(m.category, (cat.get(m.category) || 0) + w); if (m.brand) brand.set(m.brand, (brand.get(m.brand) || 0) + w); };
  h.viewed.forEach((id, i) => add(id, 1 - i / 120)); h.bought.forEach(id => add(id, 3));
  if (!cat.size) return { personal: false, items: trending(limit) };
  // item-to-item collaborative filtering: what did people who bought/viewed the same things buy?
  const ids = [...new Set([...h.bought, ...h.viewed.slice(0, 15)])];
  const co = new Map();
  if (ids.length) {
    const q = `SELECT b.product_id id, COUNT(DISTINCT a.order_id) c FROM m_order_items a JOIN m_order_items b ON a.order_id=b.order_id AND b.product_id<>a.product_id
      WHERE a.product_id IN (${ids.map(() => '?').join(',')}) GROUP BY b.product_id ORDER BY c DESC LIMIT 40`;
    for (const r of db.prepare(q).all(...ids)) { const m = ix.byProduct.get(r.id); if (m) co.set(m.slug, (co.get(m.slug) || 0) + r.c); }
  }
  const bought = new Set(h.bought.map(id => (ix.byProduct.get(id) || {}).slug));
  const scored = [...ix.models.values()].filter(m => !bought.has(m.slug) && m.inStock).map(m => ({
    m, s: (cat.get(m.category) || 0) * 1.0 + (m.brand ? (brand.get(m.brand) || 0) * 0.6 : 0) + (co.get(m.slug) || 0) * 1.5 + Math.log1p(m.sales) * 0.3 + (m.rating || 3.5) * 0.1 - (own.has(m.slug) ? 0.8 : 0)
  })).sort((a, b) => b.s - a.s);
  return { personal: true, items: scored.slice(0, limit).map(r => card(r.m)) };
}
function alsoBought(slug, limit = 8) {
  const ix = index(), m = ix.models.get(slug); if (!m) return [];
  const ids = m.offers.map(o => o.id);
  const rows = db.prepare(`SELECT b.product_id id, COUNT(DISTINCT a.order_id) c FROM m_order_items a JOIN m_order_items b ON a.order_id=b.order_id AND b.product_id<>a.product_id
    WHERE a.product_id IN (${ids.map(() => '?').join(',')}) GROUP BY b.product_id ORDER BY c DESC LIMIT 30`).all(...ids);
  const out = [], seen = new Set([slug]);
  for (const r of rows) { const x = ix.byProduct.get(r.id); if (x && !seen.has(x.slug)) { seen.add(x.slug); out.push(card(x)); } if (out.length >= limit) return out; }
  for (const x of [...ix.models.values()].filter(x => x.category === m.category && !seen.has(x.slug)).sort((a, b) => b.sales - a.sales)) { out.push(card(x)); if (out.length >= limit) break; }
  return out;
}
const trending = (limit = 12) => [...index().models.values()].filter(m => m.inStock).sort((a, b) => (b.sales * 3 + b.views) - (a.sales * 3 + a.views) || (b.rating || 0) - (a.rating || 0)).slice(0, limit).map(card);
const newArrivals = (limit = 12) => [...index().models.values()].filter(m => m.inStock).sort((a, b) => b.created - a.created).slice(0, limit).map(card);
const deals = (limit = 12) => [...index().models.values()].filter(m => m.deal && m.inStock).slice(0, limit).map(card);
function categoryTree(lang) {
  const counts = new Map();
  for (const m of index().models.values()) if (m.category_id) counts.set(m.category_id, (counts.get(m.category_id) || 0) + 1);
  return cats.publicTree(counts, lang);
}
function categories() {
  const c = {};
  for (const m of index().models.values()) { const x = c[m.category] || (c[m.category] = { name: m.category, count: 0, image: null }); x.count++; if (!x.image && m.images[0]) x.image = m.images[0]; }
  return Object.values(c).sort((a, b) => b.count - a.count);
}
// sponsored placement: active campaigns with budget left (the admin panel owns campaign lifecycle and budgets)
function sponsored(matchFn, limit = 2) {
  const ix = index(), t = Date.now(), out = [];
  const camps = db.prepare("SELECT id, product_id FROM m_campaigns WHERE status='active' AND spent < budget AND product_id IS NOT NULL AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>=?) ORDER BY (budget-spent) DESC").all(t, t);
  const seen = new Set();
  for (const c of camps) { const m = ix.byProduct.get(c.product_id); if (m && m.inStock && !seen.has(m.slug) && (!matchFn || matchFn(m))) { seen.add(m.slug); out.push({ ...card(m), campaign_id: c.id, sponsored: true }); } if (out.length >= limit) break; }
  return out;
}
const findModel = slug => index().models.get(slug) || null;
const findByProduct = id => index().byProduct.get(id) || null;

module.exports = { index, invalidate, card, offersFor, sellable, categoryTree, fastestDays, search, suggest, viewerKey, history, recentlyViewed, forYou, alsoBought, trending, newArrivals, deals, categories, sponsored, findModel, findByProduct, slugify, norm, words, parseImages, modelSlugOf };
