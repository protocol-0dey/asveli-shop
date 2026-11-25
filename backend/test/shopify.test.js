'use strict';
// Two-way Shopify sync against an in-memory Shopify (test/fake-shopify.js): create, edit here → Shopify, edit in Shopify → here,
// conflicts, stock deltas from Shopify sales, imports, deletions, currency conversion, auth modes, permissions, secrets.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');
const { createFakeShopify } = require('./fake-shopify');

let T, owner, F, seller, wh;
const NEWPW = 'brand-new-long-password-77';
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const wait = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
const mkProduct = (extra = {}) => ok(owner, 'POST', '/m/products', { sku: 'SH-' + (++n), title: 'Lamp ' + n, seller_id: seller.id, category: 'Lighting', price: 12900, description: 'Warm light.\n\nTwo modes.', ...extra }, 201);
const live = async p => { await ok(owner, 'POST', `/m/products/${p.id}/do/submit`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {}); };
const shopOf = async id => { const s = await ok(owner, 'GET', `/shopify/product/${id}`); return s.linked ? F.st.products.get(s.shopify_id) : null; };
const sync = (mode = 'incremental') => ok(owner, 'POST', '/shopify/sync', { mode });

before(async () => {
  F = createFakeShopify({ currency: 'PLN' });
  const endpoint = await F.listen();
  T = await startServer({ SHOPIFY_TEST_ENDPOINT: endpoint, PLATFORM_CURRENCY: 'PLN', SHOPIFY_DEBOUNCE_MS: '60', SHOPIFY_POLL: '0' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  seller = await ok(owner, 'POST', '/m/sellers', { name: 'Lumen', country: 'PL', legal_name: 'Jan Kowalski', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'l@example.com', address: 'ul. Prosta 1' }, 201);
  for (const a of ['kyc_submit', 'kyc_approve', 'activate']) await ok(owner, 'POST', `/m/sellers/${seller.id}/do/${a}`, {});
  wh = await ok(owner, 'POST', '/m/warehouses', { name: 'PL-1', country: 'PL', priority: 1 }, 201);
});
after(() => { if (T) T.stop(); if (F) F.close(); });

test('settings: only *.myshopify.com, secrets are write-only and never logged', async () => {
  assert.equal((await call(owner, 'PUT', '/shopify/settings', { domain: 'evil.example.com' })).j.error, 'invalid_shop_domain');
  assert.equal((await call(owner, 'PUT', '/shopify/settings', { domain: 'http://169.254.169.254/' })).j.error, 'invalid_shop_domain');
  assert.equal((await call(owner, 'PUT', '/shopify/settings', { authMode: 'magic' })).j.error, 'invalid_auth_mode');
  assert.equal((await call(owner, 'POST', '/shopify/sync', {})).j.error, 'shopify_not_configured');
  const v = await ok(owner, 'PUT', '/shopify/settings', { domain: 'fake', authMode: 'token', token: F.token });
  assert.equal(v.domain, 'fake.myshopify.com'); assert.equal(v.enabled, true);
  assert.equal(v.token_hint, '••••3456'); assert.ok(!JSON.stringify(v).includes(F.token));
  const t = await ok(owner, 'POST', '/shopify/test');
  assert.equal(t.shop.name, 'Fake Asveli'); assert.equal(t.shop.currency, 'PLN'); assert.equal(t.currency_match, true); assert.equal(t.location_ok, false);
  await ok(owner, 'PUT', '/shopify/settings', { locationId: t.shop.locations[0].id, warehouseId: wh.id, importSellerId: seller.id });
  const audit = await ok(owner, 'GET', '/audit?limit=100').catch(() => null);
  if (audit && audit.rows) assert.ok(!JSON.stringify(audit.rows).includes(F.token), 'token must never be written to the audit log');
});

test('staff without the right cannot read secrets or run the sync', async () => {
  const j = await ok(owner, 'POST', '/staff', { username: 'u_mod', role: 'moderator' }, 201);
  const c = new Client(T.adminBase); await c.login('u_mod', j.temp_password); await ok(c, 'POST', '/security/password', { current: j.temp_password, next: NEWPW });
  assert.equal((await call(c, 'GET', '/shopify/settings')).s, 403);
  assert.equal((await call(c, 'POST', '/shopify/sync', {})).s, 403);
  const j2 = await ok(owner, 'POST', '/staff', { username: 'u_cat', role: 'catalog_manager' }, 201);
  const cm = new Client(T.adminBase); await cm.login('u_cat', j2.temp_password); await ok(cm, 'POST', '/security/password', { current: j2.temp_password, next: NEWPW });
  assert.equal((await call(cm, 'GET', '/shopify/settings')).s, 403, 'a catalog manager runs the sync but never sees the token');
  assert.equal((await call(cm, 'GET', '/shopify/overview')).s, 200);
});

test('a product created here appears in Shopify as DRAFT; approved + verified becomes ACTIVE with price, stock, images', async () => {
  const p = await mkProduct({ barcode: '5901234567890', images: JSON.stringify(['https://img.example/lamp.jpg']), weight_g: 800 });
  await ok(owner, 'POST', '/m/stock', { product_id: p.id, warehouse_id: wh.id, qty: 40 }, 201);
  await sync('push');
  let s = await shopOf(p.id);
  assert.ok(s, 'created in Shopify'); assert.equal(s.status, 'DRAFT'); assert.equal(s.variant.price, '129.00'); assert.equal(s.variant.sku, p.sku);
  assert.equal(s.variant.barcode, '5901234567890'); assert.equal(s.variant.qty, 40); assert.equal(s.variant.tracked, true);
  assert.match(s.descriptionHtml, /^<p>Warm light\.<\/p><p>Two modes\.<\/p>$/); assert.deepEqual(s.media, ['https://cdn.shopify.com/s/files/1/test/lamp.jpg']);
  assert.ok(s.tags.includes('asveli'));
  await live(p);                                                    // approved, but not human-verified yet → still DRAFT
  await wait(300); s = await shopOf(p.id); assert.equal(s.status, 'DRAFT');
  await ok(owner, 'POST', `/m/products/${p.id}/do/ai_generate`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/verify`, {});
  await wait(400); s = await shopOf(p.id); assert.equal(s.status, 'ACTIVE', 'approved + human-verified → live in Shopify');
  await ok(owner, 'PATCH', `/m/products/${p.id}`, { weight_g: 900 });                // auto-push (debounced) of an edit
  await wait(400); assert.equal((await shopOf(p.id)).variant.weight, 900);
  // unpublished in the Shopify admin → draft here; published again there → approved + verified here (owner's decision)
  F.edit(s.id, { status: 'DRAFT' }); await sync('pull');
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).status, 'draft');
  F.edit(s.id, { status: 'ACTIVE' }); await sync('pull');
  const back = await ok(owner, 'GET', `/m/products/${p.id}`); assert.equal(back.status, 'approved'); assert.equal(back.human_verified, 1);
});

test('edits in the Shopify admin come back here without re-moderation; images become Shopify CDN links', async () => {
  const p = await mkProduct(); await live(p); await sync('push');
  const s = await shopOf(p.id);
  F.edit(s.id, { title: 'Lamp (edited in Shopify)', descriptionHtml: '<p>New <b>copy</b>.</p><ul><li>One</li></ul>', variant: { ...s.variant, price: '99.90' }, media: ['https://cdn.shopify.com/a.jpg'] });
  const out = await sync('incremental'); assert.equal(out.errors, 0, JSON.stringify(out.errors_list));
  const after = await ok(owner, 'GET', `/m/products/${p.id}`);
  assert.equal(after.title, 'Lamp (edited in Shopify)'); assert.equal(after.price, 9990); assert.equal(after.description, 'New copy.\n\n• One');
  assert.deepEqual(JSON.parse(after.images), ['https://cdn.shopify.com/a.jpg']);
  assert.notEqual(after.status, 'pending_review', 'an owner edit in Shopify does not send the product back to moderation');
  const hist = await ok(owner, 'GET', `/m/price_history?product_id=${p.id}`);
  assert.ok(hist.rows.some(r => r.reason === 'shopify' && r.new_price === 9990));
  const again = await sync('incremental');
  assert.equal(again.pushed + again.pulled, 0, 'a second run finds nothing to do');
});

test('editing the same field on both sides is a conflict: nothing is overwritten until someone picks a version', async () => {
  const p = await mkProduct(); await sync('push');
  const s = await shopOf(p.id);
  F.edit(s.id, { title: 'Title from Shopify' });
  await ok(owner, 'PATCH', `/m/products/${p.id}`, { title: 'Title from admin', category: 'Lamps' });   // category only changed here → still pushed
  await wait(400);
  let st = await ok(owner, 'GET', `/shopify/product/${p.id}`);
  assert.equal(st.state, 'conflict'); assert.deepEqual(st.conflict.title, { here: 'Title from admin', shopify: 'Title from Shopify' });
  assert.equal(F.st.products.get(s.id).title, 'Title from Shopify'); assert.equal(F.st.products.get(s.id).productType, 'Lamps');
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).title, 'Title from admin');
  const list = await ok(owner, 'GET', '/shopify/links?state=conflict'); assert.ok(list.rows.some(r => r.product_id === p.id));
  await ok(owner, 'POST', `/shopify/product/${p.id}/sync`, { prefer: 'shop' });
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).title, 'Title from Shopify');
  st = await ok(owner, 'GET', `/shopify/product/${p.id}`); assert.equal(st.state, 'ok');
  // and the other way round
  F.edit(s.id, { title: 'S2' }); await ok(owner, 'PATCH', `/m/products/${p.id}`, { title: 'A2' }); await wait(400);
  await ok(owner, 'POST', `/shopify/product/${p.id}/sync`, { prefer: 'local' });
  assert.equal(F.st.products.get(s.id).title, 'A2');
});

test('an edit saved here while Shopify is still answering is never overwritten', async () => {
  const p = await mkProduct(); await sync('push');
  const s = await shopOf(p.id);
  F.edit(s.id, { title: 'Shopify title' });
  F.st.delay = { op: 'One', ms: 400 };
  const running = call(owner, 'POST', `/shopify/product/${p.id}/sync`, {});
  await wait(150);
  await ok(owner, 'PATCH', `/m/products/${p.id}`, { title: 'Admin title (saved mid-sync)' });
  await running; await wait(400);
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).title, 'Admin title (saved mid-sync)');
  assert.equal((await ok(owner, 'GET', `/shopify/product/${p.id}`)).state, 'conflict');
});

test('stock: a sale in Shopify is taken off our warehouse, our changes go out with compare-and-set', async () => {
  const p = await mkProduct(); const stock = await ok(owner, 'POST', '/m/stock', { product_id: p.id, warehouse_id: wh.id, qty: 10 }, 201);
  await sync('push');
  const s = await shopOf(p.id); assert.equal(s.variant.qty, 10);
  F.sell(s.id, 3);                                                                 // product.updatedAt does not move on a sale
  await sync('incremental');
  assert.equal((await ok(owner, 'GET', `/m/stock/${stock.id}`)).qty, 7);
  assert.equal(F.st.products.get(s.id).variant.qty, 7);
  await ok(owner, 'POST', `/m/stock/${stock.id}/do/adjust`, { delta: 5 }); await wait(400);
  assert.equal(F.st.products.get(s.id).variant.qty, 12);
  const inv = F.st.calls.filter(c => c.op === 'InvSet').pop(); assert.equal(inv.vars.input.quantities[0].changeFromQuantity, 7);
  // a sale racing our write: Shopify refuses the stale write, nothing is overwritten, the next run reconciles
  F.sell(s.id, 1); await ok(owner, 'POST', `/m/stock/${stock.id}/do/adjust`, { delta: 1 }); await wait(400);
  await sync('incremental');
  assert.equal((await ok(owner, 'GET', `/m/stock/${stock.id}`)).qty, 12, '12 + 1 (here) − 1 (sold in Shopify)');
  assert.equal(F.st.products.get(s.id).variant.qty, 12);
});

test('products made in the Shopify admin are imported; existing SKUs are linked and differences become conflicts', async () => {
  const fresh = F.add({ title: 'Desk fan', productType: 'Climate', status: 'ACTIVE', descriptionHtml: '<p>Quiet.</p>', variant: { sku: 'FAN-1', price: '149.00', tracked: true, stocked: true, qty: 6 } });
  const local = await mkProduct({ sku: 'MATCH-1', title: 'Old name here' });
  const twin = F.add({ title: 'New name in Shopify', variant: { sku: 'MATCH-1', price: '129.00' } });
  const out = await sync('incremental');
  assert.ok(out.imported >= 1 && out.linked >= 1, JSON.stringify(out));
  const links = await ok(owner, 'GET', '/shopify/links?q=FAN-1');
  const imp = await ok(owner, 'GET', `/m/products/${links.rows[0].product_id}`);
  assert.equal(imp.title, 'Desk fan'); assert.equal(imp.price, 14900); assert.equal(imp.status, 'approved'); assert.equal(imp.human_verified, 1);
  assert.equal(imp.seller_id, seller.id); assert.equal(imp.stock_qty, 6); assert.equal(imp.external_id, fresh.id);
  assert.equal(F.st.products.get(fresh.id).status, 'ACTIVE', 'an imported live product stays live');
  await sync('incremental');
  const st = await ok(owner, 'GET', `/shopify/product/${local.id}`);
  assert.equal(st.shopify_id, twin.id); assert.equal(st.state, 'conflict'); assert.ok(st.conflict.title);
  assert.equal(F.st.products.get(twin.id).title, 'New name in Shopify', 'first connection never overwrites silently');
});

test('a product deleted in Shopify is delisted here on the full run; deleting from the admin needs a confirmation', async () => {
  const p = await mkProduct(); await live(p); await sync('push');
  const s = await shopOf(p.id); F.st.products.delete(s.id);
  await sync('full');
  const after = await ok(owner, 'GET', `/m/products/${p.id}`); assert.equal(after.status, 'delisted');
  assert.equal((await ok(owner, 'GET', `/shopify/product/${p.id}`)).linked, false);
  const q = await mkProduct(); await sync('push'); const s2 = await shopOf(q.id);
  assert.equal((await call(owner, 'POST', `/shopify/product/${q.id}/delete`, {})).j.error, 'confirm_required');
  await ok(owner, 'POST', `/shopify/product/${q.id}/delete`, { confirm: 'DELETE' });
  assert.equal(F.st.products.has(s2.id), false);
});

test('verified translations are registered in Shopify for published shop languages; demo translations never are', async () => {
  const p = await mkProduct(); await sync('push');
  const s = await shopOf(p.id);
  const b = await call(owner, 'POST', '/ai/batch', { kind: 'localize', ids: [p.id], lang: 'pl' });          // mock provider → a demo translation
  assert.equal(b.s, 200, JSON.stringify(b.j));
  const row = (await ok(owner, 'GET', `/m/translations?product_id=${p.id}`)).rows[0];
  assert.equal((await call(owner, 'POST', `/m/translations/${row.id}/do/approve`, {})).j.error, 'mock_translation');
  await ok(owner, 'POST', `/shopify/product/${p.id}/sync`, {});
  assert.ok(!F.st.tr || !F.st.tr[s.id], 'a demo translation is not sent');
  // a real, human-checked translation (as written by a translator) goes out with Shopify's content digests
  const Database = require('better-sqlite3'), path = require('path');
  const d = new Database(path.join(T.dataDir, 'asveli.db'));
  d.prepare("UPDATE m_translations SET title='Lampa', description='Ciepłe światło.', mock=0, human_verified=1 WHERE id=?").run(row.id); d.close();
  await ok(owner, 'POST', `/shopify/product/${p.id}/sync`, {});
  const sent = F.st.tr[s.id];
  assert.deepEqual(sent.map(t => [t.locale, t.key, t.value, t.translatableContentDigest]), [['pl', 'title', 'Lampa', 'd-title'], ['pl', 'body_html', '<p>Ciepłe światło.</p>', 'd-body']]);
  const calls = F.st.calls.length; await ok(owner, 'POST', `/shopify/product/${p.id}/sync`, {});
  assert.ok(!F.st.calls.slice(calls).some(c => c.op === 'TrReg'), 'unchanged translations are not re-sent');
});

test('currency: a different shop currency needs an explicit rate, then prices are converted both ways', async () => {
  const F2 = createFakeShopify({ currency: 'PLN' }); const ep = await F2.listen();
  const T2 = await startServer({ SHOPIFY_TEST_ENDPOINT: ep, PLATFORM_CURRENCY: 'EUR', SHOPIFY_DEBOUNCE_MS: '60', SHOPIFY_POLL: '0' });
  try {
    const o = new Client(T2.adminBase); await o.login('alice', 'correct-horse-battery');
    const sl = await ok(o, 'POST', '/m/sellers', { name: 'EUR shop', country: 'DE' }, 201);
    await ok(o, 'PUT', '/shopify/settings', { domain: 'fake.myshopify.com', authMode: 'client', clientId: F2.clientId, clientSecret: F2.clientSecret });
    const t = await ok(o, 'POST', '/shopify/test'); assert.equal(t.rate_needed, true);
    const p = await ok(o, 'POST', '/m/products', { sku: 'EU-1', title: 'Euro lamp', seller_id: sl.id, category: 'x', price: 1000 }, 201);
    const r = await call(o, 'POST', '/shopify/sync', { mode: 'push' });
    assert.equal(r.j.error, 'shopify_currency_rate_required'); assert.equal(r.j.shop_currency, 'PLN');
    assert.equal((await call(o, 'PUT', '/shopify/settings', { rate: 'abc' })).j.error, 'invalid_rate');
    await ok(o, 'PUT', '/shopify/settings', { rate: '4,25' });
    await ok(o, 'POST', '/shopify/sync', { mode: 'push' });
    const st = await ok(o, 'GET', `/shopify/product/${p.id}`); const sp = F2.st.products.get(st.shopify_id);
    assert.equal(sp.variant.price, '42.50');
    F2.edit(sp.id, { variant: { ...sp.variant, price: '85.00' } });
    await ok(o, 'POST', '/shopify/sync', { mode: 'pull' });
    assert.equal((await ok(o, 'GET', `/m/products/${p.id}`)).price, 2000);
    assert.ok(F2.st.calls.length > 0 && [...F2.st.tokens].some(x => x.startsWith('shpca_')), 'client-credentials token was used');
  } finally { T2.stop(); F2.close(); }
});

test('Shopify errors are reported per product, throttling is retried', async () => {
  F.st.throttleNext = 2;
  const p = await mkProduct(); const out = await sync('push');
  assert.ok((await ok(owner, 'GET', `/shopify/product/${p.id}`)).linked, 'retried after THROTTLED');
  const q = await mkProduct(); await sync('push');
  F.st.failNext = { op: 'Set', reply: { data: { productSet: { product: null, userErrors: [{ field: ['input', 'title'], message: 'Title is too long', code: 'INVALID' }] } } } };
  F.edit((await shopOf(q.id)).id, {});
  await ok(owner, 'PATCH', `/m/products/${q.id}`, { title: 'x'.repeat(10) }); await wait(400);
  const st = await ok(owner, 'GET', `/shopify/product/${q.id}`);
  assert.equal(st.state, 'error'); assert.match(st.last_error, /Title is too long/);
  const ov = await ok(owner, 'GET', '/shopify/overview'); assert.ok(ov.errors >= 1); assert.ok(ov.log.length >= 1); void out;
});

test('moving to another Shopify store forgets the old links (nothing gets delisted) and the next push creates everything there', async () => {
  const p = await mkProduct(); await live(p); await sync('push');
  const oldId = (await ok(owner, 'GET', `/shopify/product/${p.id}`)).shopify_id; assert.ok(oldId);
  const cur = await ok(owner, 'GET', '/shopify/settings');
  const v = await ok(owner, 'PUT', '/shopify/settings', { domain: 'asveli-moved-' + Date.now() + '.myshopify.com' });
  assert.ok(v.links_reset >= 1);
  assert.equal((await ok(owner, 'GET', `/shopify/product/${p.id}`)).linked, false);
  await sync('full');
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).status, 'approved', 'not delisted as "deleted in Shopify"');
  assert.equal((await ok(owner, 'GET', `/shopify/product/${p.id}`)).linked, true, 'linked again in the new store (the fake keeps one catalogue, so it may match by SKU)');
  await ok(owner, 'PUT', '/shopify/settings', { domain: cur.domain });
});

test('category tags: a product placed in our tree reaches Shopify with cat-* tags and the root as product type; merchant tags stay', async () => {
  const p = await mkProduct({ title: 'Folia stretch 23 mic 1,5 kg transparentna', sku: 'CAT-FOLIA' });
  await sync('push');
  let s = await shopOf(p.id);
  assert.ok(s.tags.includes('cat-packaging') && s.tags.includes('cat-packaging-film'), JSON.stringify(s.tags));
  assert.equal(s.productType, 'Packaging');
  // a person moves it to office supplies here; a merchant tag set in Shopify survives the re-sync
  s.tags.push('promo-black-friday');
  const office = (await ok(owner, 'GET', '/m/categories?limit=300')).rows.find(x => x.slug === 'office-supplies');
  await ok(owner, 'PATCH', `/m/products/${p.id}`, { category_id: office.id });
  await sync('push'); await wait(300);
  s = await shopOf(p.id);
  assert.ok(s.tags.includes('cat-office-b2b') && s.tags.includes('cat-office-supplies') && !s.tags.includes('cat-packaging'), JSON.stringify(s.tags));
  assert.ok(s.tags.includes('promo-black-friday') && s.tags.includes('asveli'));
});
