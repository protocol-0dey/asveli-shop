'use strict';
// Demo data for the storefront: warehouses, carriers, VAT, 4 sellers, ~25 products (some with several offers), stock, delivered orders, reviews, banners, coupons, campaigns.
//   node --env-file=.env scripts/seed-demo.js           (refuses to run if a catalogue already exists; add --force to add anyway)
// Everything goes through the same services the real flows use. DO NOT run this against production.
const { Readable } = require('stream');
const crypto = require('crypto');
const { db } = require('../src/db');
const R = require('../src/engine/resource');
require('../src/modules');
const sec = require('../src/security');
const orders = require('../src/services/orders');
const getStorage = require('../src/storage');
const cfg = require('../src/config');

const I = { internal: true };
const create = (res, body) => R.create(res, null, body, null, I);
const update = (res, id, body) => R.update(res, id, null, body, null, I);
const staff = { username: 'seed', role: 'owner', active: 1 };

async function main() {
  if (db.prepare('SELECT COUNT(*) n FROM m_products').get().n && !process.argv.includes('--force')) { console.log('Catalogue already exists — nothing seeded (use --force to add anyway).'); return; }
  if (cfg.prod) throw new Error('refusing to seed demo data with NODE_ENV=production');

  /* logistics + tax */
  const wh = {};
  for (const [k, name, country, prio] of [['pl', 'Warsaw Fulfilment Center', 'PL', 10], ['de', 'Berlin Hub', 'DE', 20], ['nl', 'Rotterdam Hub', 'NL', 30]]) wh[k] = create('warehouses', { name, country, priority: prio, ships_to: '', active: true }).id;
  create('carriers', { name: 'Asveli Express', code: 'asveli-express', base_cost: 590, per_kg_cost: 120, countries: '', tracking_url: 'https://asveli.com/track/{id}' });
  create('carriers', { name: 'Asveli Economy EU', code: 'asveli-eco', base_cost: 390, per_kg_cost: 90, countries: 'PL,DE,CZ,LT,NL,FR,ES,IT', tracking_url: 'https://asveli.com/track/{id}' });
  for (const [c, r, n] of [['PL', 2300, 'VAT'], ['DE', 1900, 'MwSt'], ['FR', 2000, 'TVA'], ['CZ', 2100, 'DPH'], ['NL', 2100, 'BTW'], ['LT', 2100, 'PVM'], ['ES', 2100, 'IVA'], ['IT', 2200, 'IVA'], ['GB', 2000, 'VAT'], ['US', 0, 'Sales tax']])
    db.prepare('INSERT OR IGNORE INTO m_tax_rates(country,name,rate_bps,active,created_at,updated_at,created_by) VALUES(?,?,?,1,?,?,?)').run(c, n, r, Date.now(), Date.now(), 'seed');

  /* sellers (verified + active, so the demo shop can sell) */
  const sellers = {};
  const mkSeller = (key, name, country, email, bps) => {
    const s = create('sellers', { name, country, email, legal_name: name + ' Sp. z o.o.', phone: '+48500100200', address: 'ul. Przykladowa 1, 00-001 Warszawa, ' + country, tax_id: 'PL' + crypto.randomInt(1e9, 9e9), passport_no: 'ZZ' + crypto.randomInt(1e6, 9e6), bank_iban: 'PL61109010140000071219812874', commission_bps: bps });
    update('sellers', s.id, { kyc_status: 'approved', status: 'active' });
    sellers[key] = s.id; return s.id;
  };
  mkSeller('direct', 'Asveli Direct', 'PL', 'direct@asveli.test', 800);
  mkSeller('nordic', 'Nordic Tech Hub', 'DE', 'nordic@asveli.test', 1200);
  mkSeller('warsaw', 'Warsaw Gadgets', 'PL', 'warsaw@asveli.test', 1500);
  mkSeller('euro', 'EuroHome Store', 'NL', 'euro@asveli.test', 1400);
  const demoSellerPw = 'seller-demo-12345';
  db.prepare('INSERT INTO s_seller_accounts(seller_id,email_bi,pass_hash,created_at) VALUES(?,?,?,?)').run(sellers.warsaw, sec.blindIndex('seller@asveli.test'), await sec.hashPassword(demoSellerPw), Date.now());

  /* catalogue: [model slug, title, brand, category, description, base price, weight g, offers [[seller, price delta %, stock]]] */
  const D = 'Demo product for the Asveli storefront.';
  const CAT = [
    ['aurora-smartwatch-s2', 'Aurora Smartwatch S2', 'Nordvik', 'Innovations', 'AMOLED display, 7-day battery, GPS, heart-rate and sleep tracking, water resistant to 50 m.', 14900, 80, [['direct', 0, 40], ['nordic', -4, 25], ['warsaw', -8, 6]]],
    ['pulse-wireless-charger', 'Pulse Wireless Charger Pad 15W', 'Voltio', 'Innovations', 'Qi2 fast charging pad with soft-glow ring and foreign-object detection.', 2900, 160, [['direct', 0, 120], ['warsaw', -10, 30]]],
    ['halo-ar-glasses', 'Halo AR Smart Glasses', 'Lumen', 'Innovations', 'Lightweight augmented-reality glasses with open-ear audio and 6-hour battery.', 24900, 85, [['nordic', 0, 12]]],
    ['orbit-4k-action-cam', 'Orbit 4K Action Camera', 'Nordvik', 'Innovations', '4K/60 stabilised action camera, waterproof to 12 m, dual screens.', 11900, 130, [['nordic', 0, 18], ['warsaw', -6, 9]]],
    ['nimbus-power-bank-20k', 'Nimbus Power Bank 20000 mAh', 'Voltio', 'Innovations', '65 W USB-C PD power bank that charges a laptop and two phones at once.', 3900, 430, [['direct', 0, 80], ['warsaw', -5, 40]]],
    ['echo-pro-anc-headphones', 'Echo Pro ANC Headphones', 'Sonara', 'Audio', 'Adaptive active noise cancelling, 40-hour battery, multipoint Bluetooth 5.3.', 17900, 260, [['direct', 0, 35], ['nordic', -3, 20], ['euro', 2, 8]]],
    ['drift-true-wireless-earbuds', 'Drift True Wireless Earbuds', 'Sonara', 'Audio', 'Compact earbuds with ANC, wireless charging case, IPX5.', 7900, 55, [['direct', 0, 90], ['warsaw', -9, 22]]],
    ['bassline-portable-speaker', 'Bassline Portable Speaker', 'Sonara', 'Audio', '360° sound, 20-hour playtime, IP67, stereo pairing.', 5900, 540, [['euro', 0, 30]]],
    ['vita-magnesium-120', 'Vita Daily Magnesium 120 capsules', 'Pureline', 'Wellness', 'Magnesium bisglycinate food supplement, 120 vegan capsules. Not a medicinal product.', 1900, 140, [['euro', 0, 200]]],
    ['zen-aroma-diffuser', 'Zen Aromatherapy Diffuser', 'Pureline', 'Wellness', 'Ultrasonic diffuser with 7 ambient light modes and auto shut-off.', 3400, 600, [['euro', 0, 45], ['direct', 3, 20]]],
    ['flexfit-band-set', 'FlexFit Resistance Band Set', 'Kinetic', 'Wellness', 'Five latex-free resistance bands, door anchor and carry bag.', 1800, 350, [['warsaw', 0, 150]]],
    ['hydra-smart-bottle', 'Hydra Smart Water Bottle 750 ml', 'Kinetic', 'Wellness', 'Insulated steel bottle with hydration reminder glow and 24-hour cold retention.', 3200, 420, [['direct', 0, 60], ['euro', -7, 30]]],
    ['calm-sleep-mask', 'Calm Sleep Mask Pro', 'Pureline', 'Wellness', 'Contoured 3D mask, blocks 100% light, memory-foam padding.', 1500, 60, [['euro', 0, 100]]],
    ['stratus-waterproof-jacket', 'Stratus Waterproof Jacket', 'Northfold', 'Style', 'Three-layer shell, taped seams, packable hood. Unisex fit.', 8900, 650, [['nordic', 0, 40], ['direct', 4, 25]]],
    ['aero-running-sneakers', 'Aero Running Sneakers', 'Kinetic', 'Style', 'Breathable knit upper, responsive foam midsole, 240 g (size 42).', 7400, 520, [['warsaw', 0, 60], ['direct', 5, 50], ['euro', -2, 5]]],
    ['slate-minimal-backpack', 'Slate Minimalist Backpack 22L', 'Northfold', 'Style', 'Water-repellent fabric, padded 16" laptop sleeve, hidden anti-theft pocket.', 5900, 780, [['nordic', 0, 35]]],
    ['lumen-quartz-watch', 'Lumen Quartz Watch', 'Chronos', 'Style', 'Sapphire glass, 40 mm steel case, 5 ATM, mesh strap.', 12900, 150, [['direct', 0, 14]]],
    ['cloud-merino-hoodie', 'Cloud Merino Hoodie', 'Northfold', 'Style', 'Midweight merino-blend hoodie, naturally odour-resistant.', 6900, 480, [['nordic', 0, 28], ['direct', 3, 12]]],
    ['mist-air-purifier', 'Mist HEPA Air Purifier', 'Pureline', 'Home', 'True HEPA H13, 40 m² room coverage, whisper-quiet night mode.', 12900, 3900, [['euro', 0, 20], ['direct', 4, 10], ['nordic', -2, 7]]],
    ['glow-led-strip-5m', 'Glow Smart LED Strip 5 m', 'Lumen', 'Home', 'RGBIC strip with app and voice control, music sync, cuttable.', 2400, 210, [['warsaw', 0, 140], ['direct', 4, 60]]],
    ['brew-coffee-scale', 'Brew Precision Coffee Scale', 'Chronos', 'Home', '0.1 g resolution, built-in timer, auto-tare, USB-C.', 3300, 480, [['euro', 0, 50]]],
    ['terra-pourover-set', 'Terra Ceramic Pour-over Set', 'Chronos', 'Home', 'Handmade ceramic dripper, server and two cups.', 4200, 1300, [['euro', 0, 25]]]
  ];
  const digital = [
    ['neon-city-wallpapers-4k', 'Neon City — 4K Wallpaper Pack', 'Asveli Studio', 'Digital', '40 original neon-city wallpapers in 4K for desktop and phone. Instant download.', 900, 'neon-city-wallpapers.txt'],
    ['lofi-focus-beats', 'Lo-Fi Focus Beats — Music Pack', 'Asveli Studio', 'Digital', '12 royalty-free lo-fi tracks for study and streaming. Instant download.', 1200, 'lofi-focus-beats.txt']
  ];
  const pidOf = {};
  for (const [slug, title, brand, category, description, price, weight, offers] of CAT) {
    for (const [sk, delta, qty] of offers) {
      const p = price + Math.round(price * delta / 100);
      const row = create('products', { sku: `${sellers[sk]}-${slug}`.slice(0, 64), title, seller_id: sellers[sk], category, description: description + ' ' + D, price: p, cost: Math.round(p * 0.62), min_price: Math.round(p * 0.8), max_price: Math.round(p * 1.2), weight_g: weight, brand, model_slug: slug, origin_country: 'CN', hs_code: '8517.62', auto_reprice: false });
      update('products', row.id, { status: 'approved' });
      const whs = [wh.pl, wh.de, wh.nl], ins = db.prepare('INSERT INTO m_stock(product_id,warehouse_id,qty,reserved,refurb_qty,reorder_level,created_at,updated_at,created_by) VALUES(?,?,?,0,0,5,?,?,?)');
      ins.run(row.id, whs[row.id % 3], qty, Date.now(), Date.now(), 'seed');
      if (qty > 30) ins.run(row.id, whs[(row.id + 1) % 3], Math.floor(qty / 3), Date.now(), Date.now(), 'seed');
      (pidOf[slug] = pidOf[slug] || []).push(row.id);
    }
  }
  for (const [slug, title, brand, category, description, price, fname] of digital) {      // digital goods: the file is attached by staff, here: a small text stand-in
    const { key, size } = await getStorage().put(Readable.from(Buffer.from(`Thank you for buying "${title}".\nThis is a demo file for the Asveli storefront.\n`)), { maxBytes: 1e6 });
    const fid = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO files(id,name,mime,size,storage_key,is_public,public_slug,share_nonce,uploaded_by,created_at,scope) VALUES(?,?,?,?,?,0,NULL,?,?,?,?)').run(fid, fname, 'text/plain', size, key, crypto.randomBytes(8).toString('hex'), 'seed', Date.now(), 'general');
    const row = create('products', { sku: `${sellers.direct}-${slug}`, title, seller_id: sellers.direct, category, description: description + ' ' + D, price, weight_g: 0, brand, model_slug: slug, digital: true, digital_file: fid });
    update('products', row.id, { status: 'approved' }); pidOf[slug] = [row.id];
  }

  /* buyers + history: delivered orders feed popularity, "bought together", reviews */
  const accounts = [];
  const mkBuyer = async (name, email, country) => {
    const c = create('customers', { name, email, country, address: `ul. Testowa ${accounts.length + 1}, 00-00${accounts.length + 1} Warszawa, ${country}`, phone: '+48600100200' });
    const id = Number(db.prepare('INSERT INTO s_accounts(customer_id,email_bi,pass_hash,lang,created_at) VALUES(?,?,?,?,?)').run(c.id, sec.blindIndex(email), await sec.hashPassword('demo-password-123'), 'en', Date.now()).lastInsertRowid);
    accounts.push({ id, customer: c.id, country }); return id;
  };
  await mkBuyer('Demo Buyer', 'demo@asveli.test', 'PL');
  const names = ['Anna Kowalska', 'Jan Nowak', 'Marta Zielinska', 'Piotr Wisniewski', 'Katarzyna Lewandowska', 'Tomasz Wojcik', 'Julia Schneider', 'Lukas Meyer', 'Eva Novak', 'Tim de Vries'];
  const ctry = ['PL', 'PL', 'PL', 'PL', 'PL', 'PL', 'DE', 'DE', 'CZ', 'NL'];
  for (let i = 0; i < names.length; i++) await mkBuyer(names[i], `buyer${i + 1}@example.com`, ctry[i]);

  // plausible baskets so that "customers also bought" has signal
  const slugs = Object.keys(pidOf);
  const baskets = [['aurora-smartwatch-s2', 'pulse-wireless-charger', 'nimbus-power-bank-20k'], ['echo-pro-anc-headphones', 'drift-true-wireless-earbuds'], ['hydra-smart-bottle', 'flexfit-band-set', 'calm-sleep-mask'],
    ['aero-running-sneakers', 'hydra-smart-bottle'], ['stratus-waterproof-jacket', 'slate-minimal-backpack'], ['mist-air-purifier', 'zen-aroma-diffuser'], ['brew-coffee-scale', 'terra-pourover-set'],
    ['orbit-4k-action-cam', 'nimbus-power-bank-20k'], ['glow-led-strip-5m', 'bassline-portable-speaker'], ['neon-city-wallpapers-4k', 'lofi-focus-beats'], ['lumen-quartz-watch'], ['cloud-merino-hoodie', 'aero-running-sneakers']];
  let orderN = 0; const delivered = [];
  for (let round = 0; round < 3; round++) {
    for (const [bi, basket] of baskets.entries()) {
      const acc = accounts[1 + ((bi + round * 3) % (accounts.length - 1))];
      const items = basket.filter(s => pidOf[s]).map(s => ({ product_id: pidOf[s][(bi + round) % pidOf[s].length], qty: 1 + ((bi + round) % 2) }));
      try {
        const o = orders.createOrder({ customer_id: acc.customer, country: acc.country, items }, staff, null); orderN++;
        if (o.status !== 'confirmed') continue;
        for (const sh of db.prepare('SELECT id FROM m_shipments WHERE order_id=?').all(o.id)) { orders.shipShipment(sh.id, 'AS' + crypto.randomInt(1e8, 9e8), staff, null); if (round < 2 || bi % 2) orders.deliverShipment(sh.id, staff, null); }
        delivered.push({ acc, items, order: o.id });
      } catch (e) { /* a basket may be unavailable for a destination: skip */ }
    }
  }
  const TEXTS = ['Great quality, arrived quickly and exactly as described.', 'Works perfectly. Packaging was solid and delivery was fast.', 'Good value for the price. Would buy again.', 'Very happy with this purchase, setup took two minutes.', 'Does the job. Slightly smaller than I expected but fine.', 'Excellent! Better than the more expensive alternatives I tried.', 'Solid build and nice design. Battery life is impressive.', 'Decent product, delivery took a bit longer than promised.'];
  let ri = 0;
  for (const d of delivered) {
    const o = db.prepare('SELECT status FROM m_orders WHERE id=?').get(d.order);
    if (o.status !== 'delivered') continue;
    for (const it of d.items) {
      const rating = [5, 5, 4, 5, 4, 3, 5, 4][ri % 8], r = create('reviews', { product_id: it.product_id, customer_id: d.acc.customer, rating, body: TEXTS[ri % TEXTS.length] });
      if (!db.prepare('SELECT flag FROM m_reviews WHERE id=?').get(r.id).flag) update('reviews', r.id, { status: 'published' }); ri++;
    }
  }

  /* marketing */
  const vip = create('segments', { name: 'Returning buyers', field: 'orders_count', op: 'gte', value: '2', active: true });
  create('banners', { title: 'Free worldwide shipping tracking on every order', text: 'Fast, tracked delivery to Poland, the EU and beyond.', link: '/search', placement: 'home_top', priority: 10, active: true });
  create('banners', { title: 'Welcome gift: 10% off your first order', text: 'Use code WELCOME10 at checkout.', link: '/search?deals=1', placement: 'home_top', priority: 20, active: true });
  create('banners', { title: 'Thank you for coming back — enjoy 5% off with LOYAL5', text: 'A little something for returning customers.', link: '/search', placement: 'home_top', segment_id: vip.id, priority: 5, active: true });
  create('coupons', { code: 'WELCOME10', kind: 'percent', value: 1000, min_order: 2000, max_uses: 0, per_customer: 1, active: true });
  create('coupons', { code: 'LOYAL5', kind: 'percent', value: 500, min_order: 0, max_uses: 0, per_customer: 5, active: true });
  for (const [name, slug, seller, budget, cpc] of [['Smartwatch launch', 'aurora-smartwatch-s2', 'direct', 20000, 25], ['Headphones push', 'echo-pro-anc-headphones', 'nordic', 15000, 20]]) {
    const camp = create('campaigns', { name, seller_id: sellers[seller], product_id: pidOf[slug][0], budget, cpc });
    update('campaigns', camp.id, { status: 'active' });
  }

  // spread the demo orders over the last four weeks so the dashboard chart has a shape
  db.prepare('UPDATE m_orders SET created_at = ? - ((id * 7) % 26) * 86400000 - ((id * 3) % 20) * 3600000').run(Date.now());
  db.prepare('UPDATE m_orders SET updated_at = created_at').run();

  /* AI layer demo: barcodes, generated cards (mock provider unless AI_PROVIDER is set), a few verified, brand kit, channel, canvas, A/B test */
  const ai = require('../src/services/ai');
  const owner = { username: 'seed', role: 'owner', active: 1 };
  const allP = db.prepare("SELECT id, sku FROM m_products WHERE digital=0 ORDER BY id").all();
  create('brand_kits', { name: 'Asveli — спокойный премиум', tone: 'premium', banned_words: 'лучший в мире, 100% гарантия, чудо', primary_color: '#2f6bff' });
  const kit = db.prepare('SELECT id FROM m_brand_kits ORDER BY id DESC LIMIT 1').get(); await R.runAction('brand_kits', kit.id, 'activate', owner, {}, null);
  allP.forEach((p, i) => { if (i % 2 === 0) update('products', p.id, { barcode: String(590123400000 + i * 17), warehouse_location: `A-${1 + i % 9}-${1 + i % 4}` }); });
  let made = 0;
  for (const [i, p] of allP.entries()) { if (i % 4 === 3) continue; try { await R.runAction('products', p.id, 'ai_generate', owner, {}, null); made++; } catch (e) { /* quota or provider error: skip */ } }
  for (const p of db.prepare("SELECT id FROM m_products WHERE ai_status='generated' ORDER BY ai_confidence DESC LIMIT 6").all()) await R.runAction('products', p.id, 'verify', owner, {}, null);
  await ai.indexProducts();
  const ch = create('channels', { kind: 'allegro', name: 'Allegro PL (demo)', shop_url: 'https://allegro.pl/uzytkownik/asveli', api_key: 'demo-not-a-real-key', status: 'active' });
  create('channels', { kind: 'shopify', name: 'Shopify EU (demo)', status: 'draft' });
  await R.runAction('channels', ch.id, 'sync', owner, {}, null);
  create('canvases', { title: 'Aurora Smartwatch — обложка', graph: JSON.stringify({ nodes: [
    { id: 'base', type: 'prompt', label: 'Base prompt', prompt: 'Smartwatch on a dark desk, soft studio light, realistic product photo', x: 40, y: 120 },
    { id: 'fantasy', type: 'style', label: 'Fantasy Style', prompt: 'glowing mist, ethereal, highly detailed', x: 420, y: 30 },
    { id: 'angle', type: 'angle', label: 'Camera Angle', prompt: 'low angle, shallow depth of field', x: 420, y: 470 }], edges: [{ from: 'base', to: 'fantasy' }, { from: 'base', to: 'angle' }] }) });
  const pw = db.prepare("SELECT id FROM m_products WHERE sku LIKE '%aurora-smartwatch-s2' LIMIT 1").get();
  if (pw) { const t = create('ab_tests', { product_id: pw.id, name: 'Обложка: белый фон vs интерьер' }); await R.runAction('ab_tests', t.id, 'add_stats', owner, { a_views: 1200, a_clicks: 66, b_views: 1180, b_clicks: 92 }, null); }
  console.log(`AI demo: ${made} cards generated, 6 verified, brand kit, 2 channels, canvas, A/B test.`);
  console.log(`Seeded: ${slugs.length} product pages, ${db.prepare('SELECT COUNT(*) n FROM m_products').get().n} offers, ${orderN} orders, ${ri} reviews.`);
  console.log('Demo buyer:  demo@asveli.test / demo-password-123');
  console.log('Demo seller: seller@asveli.test / ' + demoSellerPw);
}
main().then(() => { db.close(); }).catch(e => { console.error(e); process.exit(1); });
