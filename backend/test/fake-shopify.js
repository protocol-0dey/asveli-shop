'use strict';
// A small in-memory Shopify Admin API (GraphQL 2026-10 subset + client-credentials token) for the sync tests. It answers the
// operations the adapter sends, by operation name, and keeps products/variants/inventory like Shopify does (cdn image URLs,
// updatedAt bumps, compare-and-set inventory with CHANGE_FROM_QUANTITY_STALE, userErrors).
const http = require('http');

function createFakeShopify({ currency = 'PLN', token = 'shpat_test_token_123456', clientId = 'abcdef0123456789abcdef', clientSecret = 'shpss_secret_value_1' } = {}) {
  const LOC = 'gid://shopify/Location/111';
  const st = { products: new Map(), seq: 1000, calls: [], tokens: new Set([token]), failNext: null, throttleNext: 0 };
  const iso = () => new Date(Date.now() + (st.seq++ % 1000)).toISOString();
  const pid = () => String(9000000 + st.seq++);
  const node = p => {
    const v = p.variant;
    return { id: p.id, legacyResourceId: p.id.split('/').pop(), handle: p.handle, title: p.title, descriptionHtml: p.descriptionHtml, vendor: p.vendor, productType: p.productType,
      status: p.status, tags: p.tags, updatedAt: p.updatedAt, seo: { description: p.seo || null }, options: [{ name: v.optName, values: [v.optValue] }],
      media: { nodes: p.media.map(url => ({ image: { url } })) }, variantsCount: { count: p.variants || 1 },
      variants: { nodes: [{ id: v.id, sku: v.sku, price: v.price, compareAtPrice: null, selectedOptions: [{ name: v.optName, value: v.optValue }], barcodes: { nodes: v.barcode ? [{ value: v.barcode }] : [] },
        inventoryItem: { id: v.item, tracked: v.tracked, harmonizedSystemCode: v.hs || null, countryCodeOfOrigin: v.origin || null, measurement: { weight: { value: v.weight || 0, unit: 'GRAMS' } },
          inventoryLevel: v.stocked ? { quantities: [{ name: 'available', quantity: v.qty }] } : null } }] } };
  };
  function add(fields = {}) {                                     // "a product created by hand in the Shopify admin"
    const id = 'gid://shopify/Product/' + pid();
    const p = { id, handle: (fields.title || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: 'Item', descriptionHtml: '', vendor: 'Asveli', productType: '', status: 'ACTIVE', tags: [], seo: null, media: [], variants: 1,
      ...fields, updatedAt: iso(),
      variant: { id: 'gid://shopify/ProductVariant/' + pid(), item: 'gid://shopify/InventoryItem/' + pid(), sku: '', price: '10.00', optName: 'Title', optValue: 'Default Title', tracked: false, stocked: false, qty: 0, ...(fields.variant || {}) } };
    st.products.set(id, p); return p;
  }
  const edit = (id, f) => { const p = st.products.get(id); Object.assign(p, f, { updatedAt: iso() }); return p; };
  const sell = (id, n) => { const p = st.products.get(id); p.variant.qty -= n; };      // an order in Shopify: stock moves, product.updatedAt does not

  function applySet(input, identifier) {
    let p;
    if (identifier && identifier.id) { p = st.products.get(identifier.id); if (!p) return { userErrors: [{ field: ['identifier'], message: 'Product does not exist', code: 'PRODUCT_DOES_NOT_EXIST' }] }; }
    else p = add({ title: input.title || 'Untitled' });
    for (const [k, to] of [['title', 'title'], ['descriptionHtml', 'descriptionHtml'], ['vendor', 'vendor'], ['productType', 'productType'], ['status', 'status'], ['tags', 'tags']]) if (input[k] !== undefined) p[to] = input[k];
    if (input.descriptionHtml !== undefined) p.descriptionHtml = String(input.descriptionHtml).replace(/<br>/g, '<br/>');   // Shopify normalises HTML a little
    if (input.seo) p.seo = input.seo.description;
    if (input.files) p.media = input.files.map(f => 'https://cdn.shopify.com/s/files/1/test/' + f.originalSource.split('/').pop());
    if (input.variants) {
      if (input.variants.length !== 1) return { userErrors: [{ field: ['variants'], message: 'test fake supports one variant', code: 'INVALID' }] };
      const v = input.variants[0];
      if (v.id && v.id !== p.variant.id) return { userErrors: [{ field: ['variants', '0', 'id'], message: 'Variant does not exist', code: 'INVALID' }] };
      if (!v.optionValues || !v.optionValues[0] || v.optionValues[0].name !== p.variant.optValue && identifier) return { userErrors: [{ field: ['variants', '0', 'optionValues'], message: 'Option value mismatch', code: 'INVALID' }] };
      if (v.price !== undefined) { if (!/^\d+\.\d{2}$/.test(v.price)) return { userErrors: [{ field: ['variants', '0', 'price'], message: 'bad money' }] }; p.variant.price = v.price; }
      if (v.sku !== undefined) p.variant.sku = v.sku;
      if (v.barcodes) p.variant.barcode = v.barcodes[0] ? v.barcodes[0].value : '';
      if (v.inventoryItem) { if (v.inventoryItem.tracked !== undefined) p.variant.tracked = v.inventoryItem.tracked; if (v.inventoryItem.measurement) p.variant.weight = v.inventoryItem.measurement.weight.value; if (v.inventoryItem.harmonizedSystemCode) p.variant.hs = v.inventoryItem.harmonizedSystemCode; }
      if (v.inventoryQuantities) {
        if (identifier) return { userErrors: [{ field: ['variants', '0', 'inventoryQuantities'], message: 'only at stocked locations on update (fake: never)' }] };
        for (const q of v.inventoryQuantities) if (q.locationId === LOC) { p.variant.stocked = true; p.variant.qty = q.quantity; }
      }
    }
    p.updatedAt = iso();
    return { product: node(p), userErrors: [] };
  }

  function gql(query, vars) {
    const op = (/^\s*(?:query|mutation)\s+(\w+)/.exec(query) || [])[1] || 'Anon';
    st.calls.push({ op, vars });
    if (st.failNext && st.failNext.op === op) { const f = st.failNext.reply; st.failNext = null; return f; }
    if (op === 'Anon' && /shop\s*\{/.test(query)) return { data: { shop: { name: 'Fake Asveli', currencyCode: currency, myshopifyDomain: 'fake.myshopify.com', primaryDomain: { url: 'https://asveli.test' } },
      locations: { nodes: [{ id: LOC, name: 'Main', isActive: true }] }, shopLocales: [{ locale: 'en', primary: true, published: true }, { locale: 'pl', primary: false, published: true }] } };
    if (op === 'One') { const p = st.products.get(vars.id); return { data: { product: p ? node(p) : null } }; }
    if (op === 'Page') {
      let list = [...st.products.values()];
      const m = vars.q && /updated_at:>'([^']+)'/.exec(vars.q); if (m) list = list.filter(p => p.updatedAt > m[1]);
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
      const start = vars.after ? Number(vars.after) : 0, page = list.slice(start, start + vars.first);
      return { data: { products: { nodes: page.map(node), pageInfo: { hasNextPage: start + vars.first < list.length, endCursor: String(start + vars.first) } } } };
    }
    if (op === 'Levels') return { data: { nodes: vars.ids.map(id => { const p = [...st.products.values()].find(x => x.variant.id === id); return p ? { id, product: { id: p.id }, inventoryItem: { inventoryLevel: p.variant.stocked ? { quantities: [{ name: 'available', quantity: p.variant.qty }] } : null } } : null; }) } };
    if (op === 'Set') return { data: { productSet: applySet(vars.input, vars.identifier) } };
    if (op === 'Del') { const ok = st.products.delete(vars.input.id); return { data: { productDelete: { deletedProductId: ok ? vars.input.id : null, userErrors: ok ? [] : [{ field: ['id'], message: 'Product does not exist' }] } } }; }
    if (op === 'InvSet') {
      if (!/@idempotent\(key: "[0-9a-f-]{36}"\)/.test(query)) return { errors: [{ message: 'idempotency key required', extensions: { code: 'BAD_REQUEST' } }] };
      const q = vars.input.quantities[0], p = [...st.products.values()].find(x => x.variant.item === q.inventoryItemId);
      if (!p || !p.variant.stocked) return { data: { inventorySetQuantities: { userErrors: [{ field: ['input'], message: 'not stocked', code: 'ITEM_NOT_STOCKED_AT_LOCATION' }] } } };
      if (q.changeFromQuantity !== p.variant.qty) return { data: { inventorySetQuantities: { userErrors: [{ field: ['input'], message: 'stale', code: 'CHANGE_FROM_QUANTITY_STALE' }] } } };
      p.variant.qty = q.quantity; return { data: { inventorySetQuantities: { userErrors: [] } } };
    }
    if (op === 'InvAct') { const p = [...st.products.values()].find(x => x.variant.item === vars.item); p.variant.stocked = true; p.variant.qty = vars.qty || 0; return { data: { inventoryActivate: { userErrors: [] } } }; }
    if (op === 'Tr') { st.tr = st.tr || {}; return { data: { translatableResource: { translatableContent: [{ key: 'title', digest: 'd-title', locale: 'en' }, { key: 'body_html', digest: 'd-body', locale: 'en' }] } } }; }
    if (op === 'TrReg') { st.tr = st.tr || {}; st.tr[vars.id] = vars.t; return { data: { translationsRegister: { userErrors: [] } } }; }
    return { errors: [{ message: 'unknown operation ' + op }] };
  }

  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/admin/oauth/access_token') {
        const f = new URLSearchParams(b);
        if (f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_client' })); }
        const t = 'shpca_' + Math.random().toString(36).slice(2); st.tokens.add(t);
        return res.end(JSON.stringify({ access_token: t, scope: 'read_products,write_products', expires_in: 86399 }));
      }
      if (!/^\/admin\/api\/20\d\d-\d\d\/graphql\.json$/.test(req.url)) { res.statusCode = 404; return res.end('{}'); }
      if (!st.tokens.has(req.headers['x-shopify-access-token'])) { res.statusCode = 401; return res.end(JSON.stringify({ errors: '[API] Invalid API key or access token' })); }
      if (st.throttleNext > 0) { st.throttleNext--; return res.end(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 9, restoreRate: 1000 } } } })); }
      const { query, variables } = JSON.parse(b);
      const out = JSON.stringify(gql(query, variables || {})), op = (/^\s*(?:query|mutation)\s+(\w+)/.exec(query) || [])[1];
      if (st.delay && st.delay.op === op) { const ms = st.delay.ms; st.delay = null; return setTimeout(() => res.end(out), ms); }   // a slow Shopify answer
      res.end(out);
    });
  });
  return { server, st, add, edit, sell, LOC, token, clientId, clientSecret, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))), close: () => server.close() };
}
module.exports = { createFakeShopify };
