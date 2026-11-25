'use strict';
// "Marketplace of everything": category tree with automatic placement, subtree search, delivery-speed and price-band filters,
// offers of other shops under a product, conversations through the platform (contact seller, B2B licence orders, broker orders, RFQ).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

let T, owner, seller, wh;
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const api = async (method, url, { token, json } = {}) => {
  const h = { Origin: 'http://localhost:5173' }; if (token) h.Authorization = 'Bearer ' + token; if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(T.base + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  let body = null; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
let n = 0;
async function product(extra, stock = 10) {
  n++;
  const p = await ok(owner, 'POST', '/m/products', { sku: 'MP-' + n, seller_id: seller.id, category: 'Электроника и Гаджеты', description: 'Test product for the marketplace tree.', price: 10000, ...extra }, 201);
  await ok(owner, 'POST', `/m/products/${p.id}/do/submit`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  if (stock) await ok(owner, 'POST', '/m/stock', { product_id: p.id, warehouse_id: wh.id, qty: stock }, 201);
  return p;
}
const slugOf = async id => (await ok(owner, 'GET', `/m/products/${id}`)).model_slug || `p-${id}`;
async function buyer(i) {
  return (await api('POST', '/api/store/auth/register', { json: { email: `buyer${i}@example.com`, password: 'longenough-pass-1', name: 'Anna Nowak', country: 'PL' } })).body.token;
}

before(async () => {
  T = await startServer({ SESSION_SECRET: 'test-session-secret-0123456789abcdef-xyz', DATA_ENCRYPTION_KEY: 'test-data-key-0123456789abcdef-0123456789', JOBS: '0', STORE_INDEX_TTL_MS: '1' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  seller = await ok(owner, 'POST', '/m/sellers', { name: 'Tech Shop', country: 'PL', legal_name: 'Tech Shop Sp. z o.o.', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'tech@example.com', address: 'ul. Prosta 1, Warszawa, PL' }, 201);
  for (const a of ['kyc_submit', 'kyc_approve', 'activate']) await ok(owner, 'POST', `/m/sellers/${seller.id}/do/${a}`, {});
  wh = await ok(owner, 'POST', '/m/warehouses', { name: 'Warszawa', country: 'PL', priority: 1 }, 201);
});
after(() => { if (T) T.stop(); });

test('a default world tree exists; products sort themselves into subcategories by their title', async () => {
  const tree = (await api('GET', '/api/store/categories/tree')).body.tree;
  const el = tree.find(x => x.slug === 'electronics'); assert.ok(el);
  const comp = el.children.find(x => x.slug === 'computers'); assert.ok(comp.children.some(x => x.slug === 'keyboards') && comp.children.some(x => x.slug === 'mice'));
  // launch focus: B2B supply comes first; car classifieds, alcohol and hotels are switched off until the admin turns them on
  assert.deepEqual(tree.slice(0, 6).map(x => x.slug), ['packaging', 'warehouse', 'bhp', 'cleaning', 'office-b2b', 'horeca']);
  assert.ok(!tree.find(x => x.slug === 'travel') && !tree.find(x => x.slug === 'auto').children.some(x => x.slug === 'cars'));
  const all = (await ok(owner, 'GET', '/m/categories?limit=200')).rows;
  for (const slug of ['cars', 'wine-alcohol']) await ok(owner, 'PATCH', `/m/categories/${all.find(c => c.slug === slug).id}`, { active: true });
  const t2 = (await api('GET', '/api/store/categories/tree')).body.tree;
  assert.equal(t2.find(x => x.slug === 'auto').children.find(x => x.slug === 'cars').kind, 'classifieds');
  assert.equal(t2.find(x => x.slug === 'horeca').children.find(x => x.slug === 'wine-alcohol').restricted, 'b2b_licence');
  const kb = await product({ title: 'Razer Huntsman Mini Gaming Keyboard' }), ms = await product({ title: 'Logitech G305 Wireless Gaming Mouse' });
  const r = (await api('GET', '/api/store/search?cat=computers')).body;           // the parent shows both children
  const slugs = r.items.map(i => i.slug);
  assert.ok(slugs.includes(await slugOf(kb.id)) && slugs.includes(await slugOf(ms.id)));
  assert.equal((await api('GET', '/api/store/search?cat=keyboards')).body.items.length, 1);
  assert.equal(r.category.slug, 'computers'); assert.equal(r.category.path[0].slug, 'electronics');
  assert.ok(r.facets.tree.length >= 1);
});

test('price bands and delivery speed are filters; out-of-stock pages drop out of "delivered within a week"', async () => {
  const cheap = await product({ title: 'USB C cable braided 2m', price: 1990 }), dear = await product({ title: 'DisplayPort cable 8K', price: 30000 });
  const none = await product({ title: 'HDMI cable 4K long', price: 4990 }, 0);
  const all = (await api('GET', '/api/store/search?cat=cables-adapters')).body;
  assert.equal(all.total, 3);
  assert.ok(all.facets.price_bands.some(b => b.min === 0 && b.max === 2500 && b.count === 1));
  const band = (await api('GET', '/api/store/search?cat=cables-adapters&min=0&max=2499')).body; assert.equal(band.total, 1);
  const fast = (await api('GET', '/api/store/search?cat=cables-adapters&delivery=7&country=PL')).body;
  const s = fast.items.map(i => i.slug);
  assert.ok(s.includes(await slugOf(cheap.id)) && s.includes(await slugOf(dear.id)) && !s.includes(await slugOf(none.id)));
  const sorted = (await api('GET', '/api/store/search?cat=cables-adapters&sort=price_asc')).body.items.map(i => i.price_from);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b));
});

test('offers of other shops appear under the product only with a fresh price and for countries they deliver to', async () => {
  const p = await product({ title: 'Mechanical keyboard 75 percent' }), slug = await slugOf(p.id);
  const fresh = new Date().toISOString().slice(0, 10), old = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
  await ok(owner, 'POST', '/m/external_offers', { model_slug: slug, source_name: 'Partner Shop', url: 'https://partner.example/kb', price: 9500, shipping: 500, delivery_days: 3, mode: 'broker', checked_at: fresh }, 201);
  await ok(owner, 'POST', '/m/external_offers', { model_slug: slug, source_name: 'Stale Shop', url: 'https://stale.example/kb', price: 100, checked_at: old }, 201);
  const twoDays = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);   // fine for a shop, too old for Amazon (24 h rule)
  await ok(owner, 'POST', '/m/external_offers', { model_slug: slug, source_name: 'Amazon.de', url: 'https://www.amazon.de/dp/X', price: 50, affiliate: true, checked_at: twoDays }, 201);
  await ok(owner, 'POST', '/m/external_offers', { model_slug: slug, source_name: 'Small Shop', url: 'https://small.example/kb', price: 12000, checked_at: twoDays }, 201);
  await ok(owner, 'POST', '/m/external_offers', { model_slug: slug, source_name: 'US Only', url: 'https://us.example/kb', price: 8000, ships_to: 'US', affiliate: true, checked_at: fresh }, 201);
  const pl = (await api('GET', `/api/store/models/${slug}?country=PL`)).body;
  assert.deepEqual(pl.other_offers.map(o => o.source_name), ['Partner Shop', 'Small Shop']);
  assert.equal(pl.other_offers[0].landed, 10000);
  const us = (await api('GET', `/api/store/models/${slug}?country=US`)).body;
  assert.ok(us.other_offers.some(o => o.source_name === 'US Only' && o.affiliate === true));
  // ordering through Asveli (broker) opens a conversation with the Asveli team
  const tok = await buyer(1);
  const q = await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'broker_order', external_offer_id: pl.other_offers[0].id, quantity: '20 szt.', message: 'Please order 20 pieces for our office.' } });
  assert.equal(q.status, 201, JSON.stringify(q.body)); assert.equal(q.body.with, 'ASVELI');
});

test('classifieds: no cart, «contact the seller» goes through the platform both ways without contact details', async () => {
  const car = await product({ title: 'Toyota Corolla 2019 1.8 Hybrid', category_id: null, category: 'cars' }, 0);
  const slug = await slugOf(car.id);
  assert.equal((await api('GET', `/api/store/models/${slug}`)).body.kind, 'classifieds');
  const tok = await buyer(2);
  const quote = (await api('POST', '/api/store/quote', { token: tok, json: { items: [{ product_id: car.id, qty: 1 }], country: 'PL' } })).body;
  assert.ok(quote.issues.some(i => i.code === 'contact_only'));
  assert.equal((await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'contact_seller', product_id: car.id, message: 'short' } })).body.error, 'message_too_short');
  const q = (await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'contact_seller', product_id: car.id, message: 'Is the car still available? Can I see it on Saturday?' } })).body;
  assert.equal(q.with, 'Tech Shop');
  // the seller answers from Seller Central; the buyer is shown by first name only
  const st = (await api('POST', '/api/seller/auth/register', { json: { email: 'other@example.com', password: 'longenough-pass-1', store_name: 'Other', country: 'PL' } })).body.token;
  assert.equal((await api('GET', `/api/seller/inquiries/${q.id}`, { token: st })).status, 404, "another store can't read it");
  // give the admin-created store a Seller Central login (same password as the account above)
  const raw = require('better-sqlite3')(require('path').join(T.dataDir, 'asveli.db'));
  const acc = raw.prepare('SELECT * FROM s_seller_accounts WHERE id=(SELECT MAX(id) FROM s_seller_accounts)').get();
  raw.prepare("UPDATE s_seller_accounts SET email_bi='moved' WHERE id=?").run(acc.id);
  raw.prepare('INSERT INTO s_seller_accounts(seller_id,email_bi,pass_hash,created_at) VALUES(?,?,?,?)').run(seller.id, acc.email_bi, acc.pass_hash, Date.now()); raw.close();
  const own = (await api('POST', '/api/seller/auth/login', { json: { email: 'other@example.com', password: 'longenough-pass-1' } })).body.token;
  const seen = (await api('GET', `/api/seller/inquiries/${q.id}`, { token: own })).body;
  assert.equal(seen.buyer, 'Anna'); assert.ok(!JSON.stringify(seen).includes('buyer2@example.com'));
  await api('POST', `/api/seller/inquiries/${q.id}/messages`, { token: own, json: { body: 'Yes, Saturday at 10:00 works.' } });
  const mine = (await api('GET', `/api/store/inquiries/${q.id}`, { token: tok })).body;
  assert.equal(mine.status, 'answered'); assert.equal(mine.messages.at(-1).author, 'seller');
  const other = await buyer(3);
  assert.equal((await api('GET', `/api/store/inquiries/${q.id}`, { token: other })).status, 404);
});

test('licence-only goods (alcohol for hotels) are never in the cart; a business request needs company, VAT and licence', async () => {
  const wine = await product({ title: 'Wino czerwone Rioja Reserva 2018 0.75 l karton 6 szt.', category: 'wine-alcohol' });   // licence-only nodes need an explicit category
  const cooler = await product({ title: 'Golf bag beer cooler with ice pack' });
  assert.notEqual((await api('GET', `/api/store/models/${await slugOf(cooler.id)}`)).body.restricted, 'b2b_licence', 'a title word never makes a product licence-only');
  const slug = await slugOf(wine.id);
  assert.equal((await api('GET', `/api/store/models/${slug}`)).body.restricted, 'b2b_licence');
  const tok = await buyer(4);
  const quote = (await api('POST', '/api/store/quote', { token: tok, json: { items: [{ product_id: wine.id, qty: 1 }], country: 'PL' } })).body;
  assert.ok(quote.issues.some(i => i.code === 'b2b_only'));
  assert.equal((await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'b2b_order', product_id: wine.id, message: 'We need 30 cartons for our hotel.' } })).body.error, 'b2b_details_required');
  const ok2 = await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'b2b_order', product_id: wine.id, company: 'Hotel Bristol Sp. z o.o.', vat_no: 'PL5250000001', licence_no: 'ZEZW/123/2025', quantity: '30 kartonów', message: 'We need 30 cartons for our hotel.' } });
  assert.equal(ok2.status, 201);
});

test('request for quote: a construction job goes to the Asveli team, staff answer from the admin', async () => {
  const tok = await buyer(5);
  assert.equal((await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'rfq', category: 'keyboards', message: 'Build me a keyboard factory please.' } })).body.error, 'invalid_category');
  const q = (await api('POST', '/api/store/inquiries', { token: tok, json: { kind: 'rfq', category: 'construction-services', subject: 'Garage 6x4 m', location: 'Pruszków', budget: 8000000, deadline: '2027-04-01', message: 'Concrete garage 6x4 m with a flat roof, foundation included.' } })).body;
  assert.equal(q.with, 'ASVELI'); assert.equal(q.subject, 'Garage 6x4 m');
  await ok(owner, 'POST', `/m/inquiries/${q.id}/do/reply`, { body: 'We asked 3 contractors; quotes by Friday.' });
  const mine = (await api('GET', '/api/store/inquiries', { token: tok })).body.items;
  assert.equal(mine[0].last.author, 'staff'); assert.equal(mine[0].status, 'answered');
});

test('AI placement files unplaced products into shop nodes only, never overwrites a person\'s choice, and can run dry', async () => {
  const a = await product({ title: 'Folia stretch 23 mic 1,5 kg transparentna', category: 'X' }), b = await product({ title: 'Rękawice nitrylowe czarne 100 szt.', category: 'X' });
  const c = await product({ title: 'Zzqx unknown widget', category: 'X' });
  const manual = await product({ title: 'Folia stretch 17 mic', category: 'X' });
  const mine = (await ok(owner, 'GET', '/m/categories?limit=200')).rows.find(x => x.slug === 'office-supplies');
  await ok(owner, 'PATCH', `/m/products/${manual.id}`, { category_id: mine.id });
  const dry = await ok(owner, 'POST', '/catalog/autocat', { dry: true, limit: 1000 });
  assert.equal(dry.dry, true); assert.equal((await ok(owner, 'GET', `/m/products/${a.id}`)).category_id, null);
  const r = await ok(owner, 'POST', '/catalog/autocat', { limit: 1000 });
  assert.ok(r.mock && r.placed >= 2, JSON.stringify(r));
  const get = async id => ok(owner, 'GET', `/m/products/${id}`), slugOfCat = id => (all => all.find(x => x.id === id)?.slug);
  const cats = (await ok(owner, 'GET', '/m/categories?limit=200')).rows, cs = id => cats.find(x => x.id === id)?.slug;
  const pa = await get(a.id), pb = await get(b.id), pc = await get(c.id), pm = await get(manual.id);
  assert.equal(cs(pa.category_id), 'packaging-film'); assert.equal(pa.category_source, 'ai');
  assert.equal(cs(pb.category_id), 'bhp-gloves');
  assert.equal(pc.category_id, null);                                       // nothing fits: left for a person, not guessed
  assert.equal(cs(pm.category_id), 'office-supplies'); assert.equal(pm.category_source, 'manual');
  void slugOfCat;
  // the storefront sees the AI placement at once
  const r2 = (await api('GET', '/api/store/search?cat=packaging')).body;
  assert.ok(r2.items.some(i => i.slug === `p-${a.id}` || i.title.startsWith('Folia stretch 23')));
});

test('delivery is free for the buyer on every order, even one item; a Shopify product CSV imports as is', async () => {
  const p = await product({ title: 'Taśma pakowa brązowa 48 mm x 66 m' }, 5);
  const tok = await buyer(9);
  const q = (await api('POST', '/api/store/quote', { token: tok, json: { items: [{ product_id: p.id, qty: 1 }], country: 'PL' } })).body;
  assert.equal(q.shipping, 0, JSON.stringify(q));
  const csv = [
    'Handle,Title,Body (HTML),Vendor,Type,Tags,Variant SKU,Variant Grams,Variant Price,Variant Barcode,Image Src',
    'folia-23,Folia stretch 23 mic 1.5 kg,<p>Folia do <b>palet</b></p>,PolPack,Packaging,"b2b, cat-packaging, cat-packaging-film",FS-23,1500,39.90,5901234123457,https://cdn.example/a.jpg',
    'folia-23,,,,,,,,,,https://cdn.example/b.jpg',
    'rekawice-l,Rękawice nitrylowe L 100 szt.,,Safe,,,RN-L,400,"34,90",,'
  ].join('\n');
  const r = await ok(owner, 'POST', '/ai/import', { seller_id: seller.id, csv });
  assert.equal(r.imported, 2, JSON.stringify(r));
  const rows = (await ok(owner, 'GET', '/m/products?q=FS-23')).rows; const f = rows.find(x => x.sku === 'FS-23');
  assert.ok(f, JSON.stringify(rows.map(x => x.sku)));
  assert.equal(f.price, 3990); assert.equal(f.weight_g, 1500); assert.equal(f.category, 'packaging-film');
  assert.deepEqual(JSON.parse(f.images), ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  assert.ok(!/</.test(f.description));
});

test('an agent can import a large Shopify CSV through MCP (bodies above 64 KB)', async () => {
  const k = await ok(owner, 'POST', '/apikeys', { name: 'Argon', role: 'catalog_manager', days: 30 }, 201);
  const lines = ['Handle,Title,Body (HTML),Vendor,Type,Tags,Variant SKU,Variant Grams,Variant Price,Variant Barcode,Image Src'];
  for (let i = 0; i < 300; i++) lines.push(`big-${i},Karton klapowy ${i} 300x200x150 mm,<p>${'Mocny karton pięciowarstwowy. '.repeat(8)}</p>,Box,,cat-packaging-boxes,BIG-${i},300,4.${String(i % 100).padStart(2, '0')},,`);
  const csv = lines.join('\n'); assert.ok(csv.length > 70000);
  const res = await fetch(T.adminBase + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + k.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'admin_api', arguments: { method: 'POST', path: '/ai/import', body: { seller_id: seller.id, csv } } } }) });
  assert.equal(res.status, 200); const j = await res.json();
  assert.ok(!j.error && !j.result.isError, JSON.stringify(j).slice(0, 400));
  assert.match(j.result.content[0].text, /"imported":\s*300/);
});
