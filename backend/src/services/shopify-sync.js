'use strict';
/* Two-way product sync between this admin (m_products / m_stock) and the Shopify store.

   How a product is merged — a three-way merge per field, so nobody's edit is lost silently:
     base_local / base_shop  = what each side looked like right after the last successful sync (kept in m_shopify_links)
     changed here    = local value  ≠ base_local      changed in Shopify = Shopify value ≠ base_shop
     only here       → sent to Shopify               only in Shopify   → written here
     both, different → CONFLICT: that field is left alone on both sides until someone picks a version in the admin.
   Stock is merged as a delta: items sold in Shopify (Shopify available ≠ base) are taken off our warehouse stock, then our available
   quantity is sent back, so orders on either side never oversell.

   What goes live: only approved AND human-verified products become ACTIVE in Shopify (same rule as every other channel);
   delisted → ARCHIVED; everything else → DRAFT. A product published in the Shopify admin (DRAFT→ACTIVE there) counts as the owner's
   approval here too, after the compliance scan. Products created in the Shopify admin are imported under the configured seller. */
const { db, audit } = require('../db');
const cfg = require('../config');
const R = require('../engine/resource');
const { E, HttpError } = require('../engine/errors');
const settings = require('./shopify-settings');
const client = require('./shopify-client');
const compliance = require('./compliance');
const { event, now } = require('./common');

/* ---------------------------------------------------------------- storage */
db.exec(`
CREATE TABLE IF NOT EXISTS m_shopify_links(
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL UNIQUE REFERENCES m_products(id) ON DELETE CASCADE,
  shopify_id TEXT NOT NULL UNIQUE, variant_id TEXT, inventory_item_id TEXT, handle TEXT, multi INTEGER NOT NULL DEFAULT 0,
  opt_name TEXT, opt_value TEXT, base_local TEXT, base_shop TEXT, tr_hash TEXT,
  state TEXT NOT NULL DEFAULT 'ok', conflict TEXT, last_error TEXT, shop_updated_at TEXT,
  synced_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_m_shopify_links_state ON m_shopify_links(state);
CREATE TABLE IF NOT EXISTS m_shopify_log(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, by TEXT, ok INTEGER NOT NULL DEFAULT 1,
  pushed INTEGER DEFAULT 0, pulled INTEGER DEFAULT 0, imported INTEGER DEFAULT 0, created INTEGER DEFAULT 0, conflicts INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, note TEXT);
`);
const linkOf = pid => db.prepare('SELECT * FROM m_shopify_links WHERE product_id=?').get(pid);
const linkByShop = sid => db.prepare('SELECT * FROM m_shopify_links WHERE shopify_id=?').get(sid);
const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/* ---------------------------------------------------------------- GraphQL documents (checked against the 2026-10 Admin schema) */
const PRODUCT = `id legacyResourceId handle title descriptionHtml vendor productType status tags updatedAt
  seo { description } options { name values } media(first: 8) { nodes { ... on MediaImage { image { url } } } }
  variantsCount { count }
  variants(first: 1) { nodes { id sku price compareAtPrice selectedOptions { name value } barcodes(first: 1) { nodes { value } }
    inventoryItem { id tracked harmonizedSystemCode countryCodeOfOrigin measurement { weight { value unit } }
      inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } } }`;
const Q_SHOP = `{ shop { name currencyCode myshopifyDomain primaryDomain { url } } locations(first: 50) { nodes { id name isActive } } shopLocales { locale primary published } }`;
const Q_ONE = `query One($id: ID!, $loc: ID!) { product(id: $id) { ${PRODUCT} } }`;
const Q_PAGE = `query Page($first: Int!, $after: String, $q: String, $loc: ID!) { products(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
  pageInfo { hasNextPage endCursor } nodes { ${PRODUCT} } } }`;
const Q_LEVELS = `query Levels($ids: [ID!]!, $loc: ID!) { nodes(ids: $ids) { ... on ProductVariant { id product { id }
  inventoryItem { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } } } }`;
const M_SET = `mutation Set($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $loc: ID!) { productSet(input: $input, identifier: $identifier, synchronous: true) {
  product { ${PRODUCT} } userErrors { field message code } } }`;
const M_DELETE = `mutation Del($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }`;
const Q_TR = `query Tr($id: ID!) { translatableResource(resourceId: $id) { translatableContent { key digest locale } } }`;
const M_TR = `mutation TrReg($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { userErrors { field message } } }`;
const M_INV_SET = key => `mutation InvSet($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) @idempotent(key: "${key}") { userErrors { field message code } } }`;
const M_INV_ACT = key => `mutation InvAct($item: ID!, $loc: ID!, $qty: Int) { inventoryActivate(inventoryItemId: $item, locationId: $loc, available: $qty) @idempotent(key: "${key}") { userErrors { field message } } }`;
const NO_LOC = 'gid://shopify/Location/0';           // $loc is required by the fragment; an unknown id just returns no level

/* ---------------------------------------------------------------- shop info (cached for a few minutes) */
let shopCache = null;
async function shop(force) {
  if (!force && shopCache && shopCache.at > Date.now() - 5 * 60e3) return shopCache.v;
  const d = await client.gql(Q_SHOP);
  const v = { name: d.shop.name, currency: d.shop.currencyCode, domain: d.shop.myshopifyDomain, url: d.shop.primaryDomain && d.shop.primaryDomain.url,
    locations: d.locations.nodes.filter(l => l.isActive).map(l => ({ id: l.id, name: l.name })), locales: d.shopLocales };
  shopCache = { at: Date.now(), v };
  return v;
}
const resetCache = () => { shopCache = null; client.forget(); };

/* ---------------------------------------------------------------- money: integer cents here, decimal strings in Shopify */
async function rateOf(c) {
  const s = await shop();
  if (s.currency === cfg.currency) return 1;
  if (!c.rate) throw E.conflict('shopify_currency_rate_required', { shop_currency: s.currency, platform_currency: cfg.currency });
  return Number(c.rate);
}
const toShopMoney = (cents, rate) => (cents == null ? null : (Math.round(cents * rate) / 100).toFixed(2));
const fromShopMoney = (str, rate) => (str == null || str === '' ? null : Math.round(Math.round(Number(str) * 100) / rate));

/* ---------------------------------------------------------------- text ↔ html (our descriptions are plain text) */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const textToHtml = t => (t ? String(t).trim().split(/\n{2,}/).map(p => '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>').join('') : '');
function htmlToText(html) {
  if (!html) return '';
  return String(html).replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------------------------------------------------------- the two comparable views */
const FIELDS = ['title', 'description', 'vendor', 'category', 'price', 'compare_at', 'sku', 'barcode', 'weight', 'status', 'qty', 'images', 'seo', 'tags'];
/* Category in Shopify: product type = the root of our category tree (English name), tags cat-<slug> for every level
   (cat-packaging, cat-packaging-film…). The store's automatic collections select on those tags, so a product lands in
   the right collection as soon as it is synced. Other tags in Shopify (set by the merchant or apps) are kept. */
const cats = () => require('./categories');
function catPath(p) {
  try { const id = cats().place(p); return id ? cats().path(id, 'en') : []; } catch { return []; }
}
const catTags = p => catPath(p).map(x => 'cat-' + x.slug).sort();
const GRAMS = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };
function stockOf(pid, c) {
  const rows = db.prepare('SELECT id, warehouse_id, qty, reserved FROM m_stock WHERE product_id=?').all(pid);
  if (!rows.length) return { managed: false, available: null, rows };
  const pick = c.warehouseId ? rows.filter(r => r.warehouse_id === c.warehouseId) : rows;
  return { managed: pick.length > 0, available: pick.reduce((s, r) => s + Math.max(0, r.qty - r.reserved), 0), rows: pick };
}
const localStatus = p => (p.status === 'approved' && p.human_verified ? 'ACTIVE' : p.status === 'delisted' ? 'ARCHIVED' : 'DRAFT');
const publicImage = u => (/^https:\/\//.test(u) ? u : /^\/f\//.test(u) && /^https:\/\//.test(cfg.baseUrl) ? cfg.baseUrl + u : null);   // Shopify must be able to download it
function localView(p, c) {
  const st = stockOf(p.id, c), sel = p.seller_id ? db.prepare('SELECT name FROM m_sellers WHERE id=?').get(p.seller_id) : null;
  return {
    title: p.title, description: textToHtml(p.description || ''), vendor: p.brand || (sel && sel.name) || '', category: (catPath(p)[0] || {}).name || p.category || '', tags: catTags(p),
    price: p.price, compare_at: null, sku: p.sku || '', barcode: p.barcode || '', weight: p.weight_g == null ? null : Number(p.weight_g), status: localStatus(p), qty: st.managed ? st.available : null,
    images: j(p.images, []).filter(u => typeof u === 'string'), seo: p.seo_description || ''
  };
}
function shopView(n, rate) {
  const v = n.variants.nodes[0] || {}, inv = v.inventoryItem || {};
  const lvl = inv.inventoryLevel && inv.inventoryLevel.quantities ? inv.inventoryLevel.quantities.find(q => q.name === 'available') : null;
  return {
    title: n.title, description: n.descriptionHtml || '', vendor: n.vendor || '', category: n.productType || '', tags: (n.tags || []).filter(t => t.startsWith('cat-')).sort(),
    price: fromShopMoney(v.price, rate), compare_at: fromShopMoney(v.compareAtPrice, rate), sku: v.sku || '', barcode: (v.barcodes && v.barcodes.nodes[0] && v.barcodes.nodes[0].value) || '',
    weight: inv.measurement && inv.measurement.weight ? Math.round(inv.measurement.weight.value * (GRAMS[inv.measurement.weight.unit] || 1)) : null,
    status: n.status, qty: lvl ? lvl.quantity : null, images: n.media.nodes.map(m => m && m.image && m.image.url).filter(Boolean), seo: (n.seo && n.seo.description) || ''
  };
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ---------------------------------------------------------------- local → Shopify input */
function setInput(p, local, link, c, rate, { fields, create, shopTags = [] }) {
  const input = {};
  const want = k => create || fields.has(k);
  if (want('title')) input.title = local.title;
  if (want('description')) input.descriptionHtml = local.description;
  if (want('vendor')) input.vendor = local.vendor;
  if (want('category')) input.productType = local.category;
  if (want('status')) input.status = local.status;
  if (want('seo')) input.seo = { description: local.seo.slice(0, 320) };
  if (want('images')) { const urls = local.images.map(publicImage).filter(Boolean); input.files = urls.map(u => ({ originalSource: u, contentType: 'IMAGE' })); }
  if (create) input.tags = ['asveli', 'asveli-sku:' + p.sku, ...local.tags].filter(Boolean);
  else if (fields.has('tags')) input.tags = [...shopTags.filter(t => !t.startsWith('cat-')), ...local.tags];   // replace only our cat-* tags
  // the single variant: everything price/stock-related. Products with several variants in Shopify keep their variants (managed there).
  if (!link || !link.multi) {
    const variantChange = create || ['price', 'sku', 'barcode', 'weight', 'qty'].some(k => fields.has(k));
    if (variantChange) {
      const optName = (link && link.opt_name) || 'Title', optValue = (link && link.opt_value) || 'Default Title';
      if (create) input.productOptions = [{ name: optName, values: [{ name: optValue }] }];
      const v = { optionValues: [{ optionName: optName, name: optValue }], price: toShopMoney(local.price, rate), sku: local.sku,
        barcodes: local.barcode ? [{ value: local.barcode }] : [] };
      if (link && link.variant_id) v.id = link.variant_id;
      const digital = !!p.digital;
      v.inventoryItem = { tracked: !digital && local.qty != null && !!c.locationId, requiresShipping: !digital,
        ...(p.weight_g != null ? { measurement: { weight: { value: Number(p.weight_g), unit: 'GRAMS' } } } : {}),
        ...(p.hs_code ? { harmonizedSystemCode: p.hs_code } : {}), ...(p.origin_country ? { countryCodeOfOrigin: p.origin_country } : {}),
        ...(p.cost != null ? { cost: toShopMoney(p.cost, rate) } : {}) };
      // a new variant gets its stock right here; an existing one is set afterwards with compare-and-set (setQty), so a sale in Shopify
      // between our read and our write is never overwritten
      if (create && local.qty != null && c.locationId && !digital) v.inventoryQuantities = [{ locationId: c.locationId, name: 'available', quantity: local.qty }];
      input.variants = [v];
    }
  }
  return input;
}

/* ---------------------------------------------------------------- Shopify → local */
const internal = { source: 'shopify' };
function applyToLocal(p, shopNow, fields, c, by) {
  const body = {};
  for (const k of fields) {
    if (k === 'title' && shopNow.title) body.title = shopNow.title.slice(0, 200);
    if (k === 'description') body.description = htmlToText(shopNow.description).slice(0, 20000) || null;
    if (k === 'vendor') body.brand = shopNow.vendor ? shopNow.vendor.slice(0, 60) : null;
    if (k === 'category' && shopNow.category) body.category = shopNow.category.slice(0, 60);
    if (k === 'tags') {                                                       // a merchant moved the product in Shopify: the deepest known cat- tag wins
      const t = cats().tree(), n = shopNow.tags.map(x => t.bySlug.get(x.slice(4))).filter(Boolean).sort((a, b) => cats().path(b.id).length - cats().path(a.id).length)[0];
      if (n) body.category_id = n.id;
    }
    if (k === 'price' && shopNow.price != null && shopNow.price > 0) body.price = shopNow.price;
    if (k === 'sku' && /^[A-Za-z0-9._-]{1,64}$/.test(shopNow.sku)) body.sku = shopNow.sku;
    if (k === 'barcode') body.barcode = /^\d{8,14}$/.test(shopNow.barcode) ? shopNow.barcode : null;
    if (k === 'seo') body.seo_description = shopNow.seo || null;
    if (k === 'weight' && shopNow.weight != null && shopNow.weight <= 1e6) body.weight_g = shopNow.weight;
    if (k === 'images') body.images = shopNow.images.length ? JSON.stringify(shopNow.images.slice(0, 8)) : null;
    if (k === 'status') Object.assign(body, statusFromShop(p, shopNow, by));
  }
  if (Object.keys(body).length) R.update('products', p.id, null, body, null, { internal: true, ...internal });
  if (fields.has('qty') && shopNow.qty != null) applyStockDelta(p.id, shopNow.qty, c);
}
// Publishing in the Shopify admin = the owner's approval, but the compliance rules still apply.
function statusFromShop(p, shopNow, by) {
  if (shopNow.status === 'ACTIVE') {
    const { block } = compliance.scan({ ...p });
    if (block.length) throw new HttpError(409, 'compliance_block');
    return { status: 'approved', human_verified: true, verified_by: by || 'shopify-admin', moderation_note: null };
  }
  if (shopNow.status === 'ARCHIVED') return p.status === 'approved' ? { status: 'delisted' } : {};
  return p.status === 'approved' ? { status: 'draft' } : {};                   // unpublished in Shopify → back to draft here
}
// Shopify available moved from the last synced number (orders, manual edits there) → move our stock by the same delta.
function applyStockDelta(pid, shopQty, c) {
  const link = linkOf(pid), base = link ? j(link.base_shop, {}).qty : null;
  const st = stockOf(pid, c);
  if (base == null || !st.managed) return;
  let delta = shopQty - base; if (!delta) return;
  const rows = [...st.rows].sort((a, b) => (b.qty - b.reserved) - (a.qty - a.reserved));
  for (const r of rows) {
    if (!delta) break;
    const next = delta < 0 ? Math.max(r.reserved, r.qty + delta) : r.qty + delta;
    if (next !== r.qty) { R.update('stock', r.id, null, { qty: next }, null, { internal: true, ...internal }); delta -= next - r.qty; }
  }
  event('shopify_stock', { ref_type: 'product', ref_id: pid, amount: shopQty - base });
}

/* ---------------------------------------------------------------- one product */
function saveLink(pid, node, localAfter, shopAfter, extra = {}) {
  const v = node.variants.nodes[0] || {}, opt = (v.selectedOptions || [])[0] || {};
  const row = { shopify_id: node.id, variant_id: v.id || null, inventory_item_id: (v.inventoryItem && v.inventoryItem.id) || null, handle: node.handle,
    multi: node.variantsCount && node.variantsCount.count > 1 ? 1 : 0, opt_name: opt.name || null, opt_value: opt.value || null,
    base_local: JSON.stringify(localAfter), base_shop: JSON.stringify(shopAfter), shop_updated_at: node.updatedAt,
    state: extra.state || 'ok', conflict: extra.conflict ? JSON.stringify(extra.conflict) : null, last_error: extra.error || null, synced_at: now() };
  const ex = linkOf(pid);
  if (ex) db.prepare(`UPDATE m_shopify_links SET ${Object.keys(row).map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...Object.values(row), now(), ex.id);
  else db.prepare(`INSERT INTO m_shopify_links(product_id,${Object.keys(row).join(',')},created_at,updated_at) VALUES(?,${Object.keys(row).map(() => '?').join(',')},?,?)`).run(pid, ...Object.values(row), now(), now());
}
const markError = (pid, e) => { const code = e.code || e.message || 'error', detail = e.extra && e.extra.detail ? ': ' + e.extra.detail : '';
  db.prepare("UPDATE m_shopify_links SET state='error', last_error=?, updated_at=? WHERE product_id=?").run(String(code + detail).slice(0, 300), now(), pid); };

const uerr = list => new HttpError(422, 'shopify_rejected', { detail: list.map(e => `${(e.field || []).join('.')}: ${e.message}`).join('; ') });
async function setQty(pid, itemId, shopQty, qty, c) {
  if (!itemId || !c.locationId || qty == null) return false;
  const key = require('crypto').randomUUID();
  if (shopQty == null) {                                                // not stocked at this location yet
    const d = await client.gql(M_INV_ACT(key), { item: itemId, loc: c.locationId, qty });
    if (d.inventoryActivate.userErrors.length) throw uerr(d.inventoryActivate.userErrors);
    return true;
  }
  if (shopQty === qty) return true;
  const d = await client.gql(M_INV_SET(key), { input: { name: 'available', reason: 'correction', referenceDocumentUri: `asveli://product/${pid}`,
    quantities: [{ inventoryItemId: itemId, locationId: c.locationId, quantity: qty, changeFromQuantity: shopQty }] } });
  const ue = d.inventorySetQuantities.userErrors;
  if (ue.length) { if (ue.some(e => e.code === 'CHANGE_FROM_QUANTITY_STALE')) throw new HttpError(409, 'shopify_stock_changed'); throw uerr(ue); }
  return true;
}
async function runSet(input, identifier, c) {
  const d = await client.gql(M_SET, { input, identifier: identifier || null, loc: c.locationId || NO_LOC });
  const r = d.productSet;
  if (r.userErrors && r.userErrors.length) throw uerr(r.userErrors);
  return r.product;
}

/* Sync one product both ways. `node` = the product as just read from Shopify (saves a call during bulk runs).
   prefer: 'local' | 'shop' resolves a conflict by taking that side for every conflicting field. */
async function syncProduct(pid, { node, prefer, by } = {}) {
  const c = settings.current(); if (!c.enabled) throw E.conflict('shopify_not_configured');
  const rate = await rateOf(c);
  let p = db.prepare('SELECT * FROM m_products WHERE id=?').get(pid); if (!p) throw E.notFound();
  const link = linkOf(pid);
  try {
    if (!link) {                                                            // not in Shopify yet → create it there
      if (p.status === 'rejected') return { id: pid, action: 'skipped', reason: 'rejected' };
      const local = localView(p, c);
      const n = await runSet(setInput(p, local, null, c, rate, { fields: new Set(FIELDS), create: true }), null, c);
      saveLink(pid, n, local, shopView(n, rate));
      await pushTranslations(pid, c).catch(() => {});
      return { id: pid, action: 'created', shopify_id: n.id };
    }
    if (!node) {
      const d = await client.gql(Q_ONE, { id: link.shopify_id, loc: c.locationId || NO_LOC });
      node = d.product;
      if (!node) return goneInShopify(p, link, by);
    }
    // read our row again only now, after the network wait: an edit saved here while Shopify was answering must not be overwritten.
    // From here to applyToLocal nothing awaits, so the merge sees one consistent state of this product.
    p = db.prepare('SELECT * FROM m_products WHERE id=?').get(pid); if (!p) throw E.notFound();
    const baseL = j(link.base_local, {}), baseS = j(link.base_shop, {});
    const localNow = localView(p, c), shopNow = shopView(node, rate);
    const toShop = new Set(), toLocal = new Set(), conflict = {};
    for (const k of FIELDS) {
      if (k === 'compare_at') continue;
      if (k === 'tags' && !('tags' in baseS)) { if (!same(localNow.tags, shopNow.tags)) toShop.add(k); continue; }   // links made before category tags: our tree decides
      const lc = !same(localNow[k], baseL[k]), sc = !same(shopNow[k], baseS[k]);
      if (k === 'qty') { if (sc) toLocal.add(k); if (lc || sc) toShop.add(k); continue; }    // stock: delta in, then our total out
      if (lc && sc) {
        if (sameMeaning(k, localNow, shopNow)) continue;
        if (prefer === 'local') toShop.add(k); else if (prefer === 'shop') toLocal.add(k); else conflict[k] = { here: show(k, localNow[k]), shopify: show(k, shopNow[k]) };
      } else if (lc) toShop.add(k); else if (sc) toLocal.add(k);
    }
    if (link.multi) for (const k of ['price', 'sku', 'barcode', 'weight', 'qty']) { toShop.delete(k); }   // variants are managed in Shopify for multi-variant products
    if (toLocal.size) { applyToLocal(p, shopNow, toLocal, c, by); p = db.prepare('SELECT * FROM m_products WHERE id=?').get(pid); }
    let n = node;
    const localAfter = localView(p, c);
    if (toLocal.has('qty')) toShop.add('qty');
    const pushFields = new Set([...toShop].filter(k => k !== 'qty' || localAfter.qty != null));
    if (pushFields.size) n = await runSet(setInput(p, localAfter, link, c, rate, { fields: pushFields, shopTags: node.tags || [] }), { id: link.shopify_id }, c);
    const shopAfter = shopView(n, rate);
    if (pushFields.has('qty') && !link.multi && !p.digital) {
      const item = n.variants.nodes[0] && n.variants.nodes[0].inventoryItem;
      if (await setQty(pid, item && item.id, shopNow.qty, localAfter.qty, c)) shopAfter.qty = localAfter.qty;
    }
    // fields in conflict keep their old base on both sides, so they stay "changed on both sides" until resolved
    const bl = { ...localAfter }, bs = { ...shopAfter };
    for (const k of Object.keys(conflict)) { bl[k] = baseL[k]; bs[k] = baseS[k]; }
    const has = Object.keys(conflict).length > 0;
    saveLink(pid, n, bl, bs, has ? { state: 'conflict', conflict } : {});
    if (!has) await pushTranslations(pid, c).catch(() => {});
    return { id: pid, action: has ? 'conflict' : pushFields.size || toLocal.size ? 'synced' : 'unchanged', pushed: [...pushFields], pulled: [...toLocal], conflict: has ? conflict : undefined };
  } catch (e) {
    if (linkOf(pid)) markError(pid, e);
    throw e;
  }
}
const sameMeaning = (k, a, b) => (k === 'description' ? htmlToText(a.description) === htmlToText(b.description) : same(a[k], b[k]));
const show = (k, v) => (k === 'description' ? htmlToText(v).slice(0, 400) : k === 'images' ? (v || []).length + ' фото' : v);

function goneInShopify(p, link, by) {
  db.prepare('DELETE FROM m_shopify_links WHERE id=?').run(link.id);
  if (p.status === 'approved') R.update('products', p.id, null, { status: 'delisted', moderation_note: 'Удалён в Shopify' }, null, { internal: true, ...internal });
  event('shopify_deleted', { ref_type: 'product', ref_id: p.id });
  audit(null, 'shopify.gone', `#${p.id} ${link.shopify_id}`, by || 'shopify-sync');
  return { id: p.id, action: 'gone' };
}

/* ---------------------------------------------------------------- product created in the Shopify admin → here */
async function importNode(node, c, rate, by) {
  const shopNow = shopView(node, rate), v = node.variants.nodes[0] || {};
  // first connection of an existing catalogue: match by SKU, then by barcode, before creating anything
  let p = shopNow.sku ? db.prepare('SELECT * FROM m_products WHERE sku=?').get(shopNow.sku) : null;
  if (!p && shopNow.barcode) p = db.prepare('SELECT * FROM m_products WHERE barcode=?').get(shopNow.barcode);
  if (p && linkOf(p.id)) p = null;
  if (p) {
    // first connection of the same item on both sides: neither copy is assumed newer. Each side is its own base, so fields that differ
    // come up as conflicts on the next sync and the owner picks a version (nothing is overwritten silently).
    const local = localView(p, c), bl = { ...shopNow }, bs = { ...shopNow };
    for (const k of FIELDS) {
      if (same(local[k], shopNow[k]) || (k === 'description' && htmlToText(local[k]) === htmlToText(shopNow[k]))) continue;
      if (k === 'qty') { bl.qty = local.qty == null ? null : '\u0000base'; continue; }        // our warehouse is the stock master: its number is sent
      bl[k] = '\u0000base'; bs[k] = '\u0000base';
    }
    saveLink(p.id, node, bl, bs);
    return { id: p.id, action: 'linked' };
  }
  if (!c.importSellerId) return { action: 'needs_seller', shopify_id: node.id, title: node.title };
  if (!db.prepare('SELECT 1 FROM m_sellers WHERE id=?').get(c.importSellerId)) return { action: 'needs_seller', shopify_id: node.id, title: node.title };
  let sku = /^[A-Za-z0-9._-]{1,64}$/.test(shopNow.sku) ? shopNow.sku : 'SHOP-' + node.legacyResourceId;
  if (db.prepare('SELECT 1 FROM m_products WHERE sku=?').get(sku)) sku = ('SHOP-' + node.legacyResourceId).slice(0, 64);
  const catTag = (node.tags || []).filter(t => t.startsWith('cat-')).map(t => t.slice(4)).sort((a, b) => b.length - a.length)[0];   // our tree slug, when the product came with one
  const body = { seller_id: c.importSellerId, sku, title: (node.title || sku).slice(0, 200), category: (catTag || node.productType || 'Shopify').slice(0, 60),
    price: shopNow.price && shopNow.price > 0 ? shopNow.price : 0, description: htmlToText(node.descriptionHtml).slice(0, 20000) || null,
    brand: node.vendor ? node.vendor.slice(0, 60) : null, external_id: node.id, images: shopNow.images.length ? JSON.stringify(shopNow.images.slice(0, 8)) : null,
    seo_description: shopNow.seo || null, ...(/^\d{8,14}$/.test(shopNow.barcode) ? { barcode: shopNow.barcode } : {}) };
  if (node.status === 'ACTIVE' && !compliance.scan(body).block.length) Object.assign(body, { status: 'approved', human_verified: true, verified_by: by || 'shopify-admin' });
  else if (node.status === 'ARCHIVED') body.status = 'delisted';
  const created = R.create('products', null, body, null, { internal: true, ...internal });
  // stock: one row in the configured warehouse with Shopify's number, so later Shopify sales move it
  const qty = shopNow.qty;
  const tracked = !!(v.inventoryItem && v.inventoryItem.tracked);          // untracked in Shopify (subscriptions, services) → no stock here either, so it stays sellable
  if (qty != null && tracked && c.warehouseId && db.prepare('SELECT 1 FROM m_warehouses WHERE id=?').get(c.warehouseId))
    R.create('stock', null, { product_id: created.id, warehouse_id: c.warehouseId, qty: Math.max(0, qty) }, null, { internal: true, ...internal });
  const fresh = db.prepare('SELECT * FROM m_products WHERE id=?').get(created.id);
  const local = localView(fresh, c);
  saveLink(created.id, node, local, shopNow);
  event('shopify_import', { ref_type: 'product', ref_id: created.id });
  return { id: created.id, action: 'imported', multi: v && node.variantsCount && node.variantsCount.count > 1 };
}

/* ---------------------------------------------------------------- translations (verified only) → Shopify */
async function pushTranslations(pid, c) {
  if (!c.translations) return;
  const link = linkOf(pid); if (!link) return;
  const rows = db.prepare('SELECT lang, title, description FROM m_translations WHERE product_id=? AND human_verified=1 AND mock=0').all(pid);
  if (!rows.length) return;
  const s = await shop(), enabled = new Set(s.locales.filter(l => !l.primary).map(l => l.locale.toLowerCase().split('-')[0]));
  const use = rows.filter(r => enabled.has(r.lang));
  const hash = JSON.stringify(use); if (!use.length || hash === link.tr_hash) return;
  const d = await client.gql(Q_TR, { id: link.shopify_id });
  const dig = Object.fromEntries((d.translatableResource ? d.translatableResource.translatableContent : []).map(x => [x.key, x.digest]));
  const t = [];
  for (const r of use) {
    if (dig.title && r.title) t.push({ locale: r.lang, key: 'title', value: r.title, translatableContentDigest: dig.title });
    if (dig.body_html && r.description) t.push({ locale: r.lang, key: 'body_html', value: textToHtml(r.description), translatableContentDigest: dig.body_html });
  }
  if (!t.length) return;
  const out = await client.gql(M_TR, { id: link.shopify_id, t });
  if (out.translationsRegister.userErrors.length) throw new HttpError(422, 'shopify_rejected', { detail: out.translationsRegister.userErrors.map(e => e.message).join('; ') });
  db.prepare('UPDATE m_shopify_links SET tr_hash=? WHERE id=?').run(hash, link.id);
}

/* ---------------------------------------------------------------- bulk runs */
let chain = Promise.resolve(), running = null;
const serial = (label, fn) => { const run = chain.then(async () => { running = label; try { return await fn(); } finally { running = null; } }); chain = run.catch(() => {}); return run; };

function logRun(kind, by, s, note) {
  db.prepare('INSERT INTO m_shopify_log(ts,kind,by,ok,pushed,pulled,imported,created,conflicts,errors,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(now(), kind, by || 'system', s.errors ? 0 : 1, s.pushed, s.pulled, s.imported, s.created, s.conflicts, s.errors, note ? String(note).slice(0, 300) : null);
  db.prepare('DELETE FROM m_shopify_log WHERE id NOT IN (SELECT id FROM m_shopify_log ORDER BY id DESC LIMIT 500)').run();
}
const tally = () => ({ pushed: 0, pulled: 0, imported: 0, created: 0, conflicts: 0, errors: 0, unchanged: 0, needs_seller: 0, gone: 0, linked: 0, errors_list: [] });
function count(s, r) {
  if (!r) return;
  if (r.action === 'created') s.created++; else if (r.action === 'imported') s.imported++; else if (r.action === 'linked') s.linked++;
  else if (r.action === 'conflict') s.conflicts++; else if (r.action === 'needs_seller') s.needs_seller++; else if (r.action === 'gone') s.gone++;
  else if (r.action === 'unchanged') s.unchanged++;
  if (r.pushed && r.pushed.length) s.pushed++; if (r.pulled && r.pulled.length) s.pulled++;
}
const fail_ = (s, id, e) => { s.errors++; if (s.errors_list.length < 30) s.errors_list.push({ id, error: e.code || e.message, detail: e.extra && e.extra.detail }); };

async function* shopPages(q, c) {
  let after = null;
  for (let i = 0; i < 1000; i++) {
    const d = await client.gql(Q_PAGE, { first: 50, after, q: q || null, loc: c.locationId || NO_LOC });
    yield d.products.nodes;
    if (!d.products.pageInfo.hasNextPage) return;
    after = d.products.pageInfo.endCursor;
  }
}

/* full: every Shopify product + every local product, deletions detected.  incremental: Shopify products updated since the last run,
   live stock levels of linked variants, and local products changed since their last sync. */
function run({ full = false, by = 'system', pushOnly = false, pullOnly = false } = {}) {
  return serial(full ? 'full' : 'incremental', async () => {
    const c = settings.current(); if (!c.enabled) throw E.conflict('shopify_not_configured');
    const rate = await rateOf(c);
    const s = tally(), seen = new Set(), done = new Set(), startedAt = new Date().toISOString();
    if (!pushOnly) {
      const since = settings.state().cursor;
      const q = full || !since ? null : `updated_at:>'${since}'`;
      for await (const nodes of shopPages(q, c)) {
        for (const n of nodes) {
          seen.add(n.id);
          const l = linkByShop(n.id);
          try {
            if (l) { count(s, await syncProduct(l.product_id, { node: n, by })); done.add(l.product_id); }
            else { const r = await importNode(n, c, rate, by); count(s, r); if (r.id) done.add(r.id); }
          } catch (e) { fail_(s, l ? l.product_id : n.id, e); }
        }
      }
      if (!full) await pullLevels(c, s, done, by);
      if (full) for (const l of db.prepare('SELECT * FROM m_shopify_links').all()) {
        if (seen.has(l.shopify_id)) continue;
        const p = db.prepare('SELECT * FROM m_products WHERE id=?').get(l.product_id);
        if (p) { count(s, goneInShopify(p, l, by)); done.add(p.id); }
      }
      settings.setState({ cursor: startedAt });
    }
    if (!pullOnly && !require('./guard').maintenance()) {
      for (const p of db.prepare('SELECT * FROM m_products ORDER BY id').all()) {
        if (done.has(p.id)) continue;
        const l = linkOf(p.id);
        if (!l && p.status === 'rejected') continue;
        if (l && !full && l.state === 'conflict') continue;                     // waits for a decision in the admin
        if (l && !full && l.state !== 'error' && same(localView(p, c), withoutConflicts(l))) continue;   // nothing changed here since the last sync   // nothing changed here since the last sync
        try { count(s, await syncProduct(p.id, { by })); } catch (e) { fail_(s, p.id, e); }
      }
    }
    logRun(full ? 'full' : pushOnly ? 'push' : pullOnly ? 'pull' : 'incremental', by, s, s.needs_seller ? `${s.needs_seller} товар(ов) из Shopify ждут продавца для импорта` : s.errors_list[0] && `${s.errors_list[0].error}${s.errors_list[0].detail ? ': ' + s.errors_list[0].detail : ''}`);
    settings.setState({ last_run: now(), last_kind: full ? 'full' : 'incremental' });
    return s;
  });
}
const withoutConflicts = l => j(l.base_local, {});

// Inventory changes (sales in Shopify) do not touch a product's updatedAt, so the incremental run reads stock levels directly.
async function pullLevels(c, s, done, by) {
  if (!c.locationId) return;
  const links = db.prepare('SELECT * FROM m_shopify_links WHERE variant_id IS NOT NULL AND multi=0').all().filter(l => !done.has(l.product_id));
  for (let i = 0; i < links.length; i += 100) {
    const part = links.slice(i, i + 100);
    const d = await client.gql(Q_LEVELS, { ids: part.map(l => l.variant_id), loc: c.locationId });
    for (const v of d.nodes) {
      if (!v || !v.inventoryItem) continue;
      const l = part.find(x => x.variant_id === v.id); if (!l) continue;
      const lvl = v.inventoryItem.inventoryLevel && v.inventoryItem.inventoryLevel.quantities.find(q => q.name === 'available');
      if (!lvl || lvl.quantity === j(l.base_shop, {}).qty) continue;
      try { count(s, await syncProduct(l.product_id, { by })); done.add(l.product_id); } catch (e) { fail_(s, l.product_id, e); }
    }
  }
}

/* ---------------------------------------------------------------- auto-push after a change here (debounced, in the background) */
const queue = new Set(); let timer = null;
function enqueue(pid) {
  const c = settings.current(); if (!c.enabled || !c.autoPush || process.env.SHOPIFY_AUTOPUSH === '0') return;
  if (require('./guard').maintenance()) return;                    // shop closed by the guard: nothing (e.g. broken prices) is pushed to Shopify
  queue.add(pid); clearTimeout(timer);
  timer = setTimeout(() => { const ids = [...queue]; queue.clear();
    serial('auto', async () => { for (const id of ids) { try { await syncProduct(id, { by: 'auto' }); } catch (e) { if (!(e instanceof HttpError) || e.status >= 500) console.error('shopify auto-sync #' + id + ':', e.code || e.message); } } }).catch(() => {});
  }, Number(process.env.SHOPIFY_DEBOUNCE_MS) || 1500);
  if (timer.unref) timer.unref();
}
const pending = () => queue.size;

/* ---------------------------------------------------------------- single-product operations for the admin */
const one = (pid, opts) => serial('one', () => syncProduct(pid, opts));
function unlink(pid) { const l = linkOf(pid); if (!l) throw E.notFound('not_linked'); db.prepare('DELETE FROM m_shopify_links WHERE id=?').run(l.id); return { ok: true }; }
async function removeFromShop(pid, by) {
  return serial('delete', async () => {
    const l = linkOf(pid); if (!l) throw E.notFound('not_linked');
    const d = await client.gql(M_DELETE, { input: { id: l.shopify_id } });
    if (d.productDelete.userErrors.length && !/not.*found|does not exist/i.test(d.productDelete.userErrors[0].message)) throw new HttpError(422, 'shopify_rejected', { detail: d.productDelete.userErrors.map(e => e.message).join('; ') });
    db.prepare('DELETE FROM m_shopify_links WHERE id=?').run(l.id);
    event('shopify_deleted', { ref_type: 'product', ref_id: pid, data: { by } });
    return { ok: true, deleted: l.shopify_id };
  });
}

/* ---------------------------------------------------------------- background poll */
let pollTimer = null, lastFull = 0;
function startScheduler() {
  if (pollTimer || process.env.SHOPIFY_POLL === '0') return;
  const tick = async () => {
    const c = settings.current();
    if (c.enabled && c.pollMinutes > 0 && !running) {
      const st = settings.state(); const due = !st.last_run || Date.now() - st.last_run >= c.pollMinutes * 60e3 - 5e3;
      if (due) { const full = Date.now() - lastFull > 6 * 3600e3; try { await run({ full, by: 'schedule' }); if (full) lastFull = Date.now(); } catch (e) { console.error('shopify sync:', e.code || e.message); } }
    }
    pollTimer = setTimeout(tick, 60e3); if (pollTimer.unref) pollTimer.unref();
  };
  pollTimer = setTimeout(tick, 15e3); if (pollTimer.unref) pollTimer.unref();
}

/* ---------------------------------------------------------------- overview for the admin */
function overview() {
  const n = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    products: n('SELECT COUNT(*) c FROM m_products'), linked: n('SELECT COUNT(*) c FROM m_shopify_links'),
    not_linked: n("SELECT COUNT(*) c FROM m_products p WHERE p.status<>'rejected' AND NOT EXISTS (SELECT 1 FROM m_shopify_links l WHERE l.product_id=p.id)"),
    conflicts: n("SELECT COUNT(*) c FROM m_shopify_links WHERE state='conflict'"), errors: n("SELECT COUNT(*) c FROM m_shopify_links WHERE state='error'"),
    running, queued: pending(), state: settings.state(),
    log: db.prepare('SELECT * FROM m_shopify_log ORDER BY id DESC LIMIT 15').all()
  };
}
function links({ state, q, page = 1, limit = 50 } = {}) {
  const where = [], args = [];
  if (state === 'not_linked') {
    const rows = db.prepare(`SELECT p.id product_id, p.sku, p.title, p.status, p.price FROM m_products p WHERE p.status<>'rejected' AND NOT EXISTS (SELECT 1 FROM m_shopify_links l WHERE l.product_id=p.id) ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(limit, (page - 1) * limit);
    return { rows: rows.map(r => ({ ...r, state: 'not_linked' })), total: overview().not_linked };
  }
  if (state) { where.push('l.state=?'); args.push(state); }
  if (q) { where.push("(p.title LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')"); const like = '%' + String(q).slice(0, 80).replace(/[\\%_]/g, x => '\\' + x) + '%'; args.push(like, like); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM m_shopify_links l JOIN m_products p ON p.id=l.product_id${w}`).get(...args).c;
  const rows = db.prepare(`SELECT l.product_id, l.shopify_id, l.handle, l.state, l.conflict, l.last_error, l.multi, l.synced_at, p.sku, p.title, p.status, p.price
    FROM m_shopify_links l JOIN m_products p ON p.id=l.product_id${w} ORDER BY CASE l.state WHEN 'conflict' THEN 0 WHEN 'error' THEN 1 ELSE 2 END, l.synced_at DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
  return { total, rows: rows.map(r => ({ ...r, conflict: j(r.conflict, null), legacy_id: r.shopify_id.split('/').pop() })) };
}
const productState = pid => { const l = linkOf(pid); return l ? { linked: true, state: l.state, shopify_id: l.shopify_id, legacy_id: l.shopify_id.split('/').pop(), handle: l.handle, conflict: j(l.conflict, null), last_error: l.last_error, multi: !!l.multi, synced_at: l.synced_at } : { linked: false }; };

module.exports = { shop, resetCache, run, one, enqueue, unlink, removeFromShop, startScheduler, overview, links, productState, textToHtml, htmlToText, isBusy: () => running };
