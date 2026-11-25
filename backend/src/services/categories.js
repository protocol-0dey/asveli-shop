'use strict';
/* The category tree of a marketplace "of everything": shop categories (buy here), classifieds (contact the seller through Asveli),
   services / RFQ (describe the job, Asveli collects prices), partner categories (offers of partner shops). Each node can be restricted
   (B2B with a licence, e.g. alcohol for hotels) — such goods are never sold to consumers through the cart, only through a business request.
   Products are placed automatically: an explicit product.category_id wins; otherwise the most specific keyword match on the title, then
   the product's free-text category mapped through `match_names`. */
const { db } = require('../db');

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const list = s => String(s || '').split(',').map(x => norm(x).trim()).filter(Boolean);

let cache = null, cacheAt = 0;
function tree() {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  const rows = db.prepare('SELECT * FROM m_categories WHERE active=1 ORDER BY sort, id').all();
  const byId = new Map(rows.map(r => [r.id, { ...r, children: [], kw: list(r.keywords), names: list(r.match_names) }]));
  const roots = [];
  for (const n of byId.values()) { const p = n.parent_id && byId.get(n.parent_id); if (p) p.children.push(n); else roots.push(n); }
  const depth = n => { let d = 0, x = n; while (x.parent_id && byId.get(x.parent_id)) { d++; x = byId.get(x.parent_id); } return d; };
  for (const n of byId.values()) n.depth = depth(n);
  const bySlug = new Map([...byId.values()].map(n => [n.slug, n]));
  cache = { byId, bySlug, roots }; cacheAt = Date.now();
  return cache;
}
const invalidate = () => { cache = null; };
// a node and every node under it
function subtree(slugOrId) {
  const t = tree(), n = typeof slugOrId === 'number' ? t.byId.get(slugOrId) : t.bySlug.get(slugOrId);
  if (!n) return null;
  const out = new Set(), walk = x => { out.add(x.id); x.children.forEach(walk); }; walk(n);
  return out;
}
const nameIn = (n, lang) => (lang === 'en' && n.name_en) || (lang === 'pl' && n.name_pl) || n.name;
function path(id, lang) { const t = tree(), out = []; let x = t.byId.get(id); while (x) { out.unshift({ slug: x.slug, name: nameIn(x, lang) }); x = x.parent_id ? t.byId.get(x.parent_id) : null; } return out; }
// the kind / restriction that applies to a node: inherited from the nearest ancestor that sets it
function effective(id) {
  const t = tree(); let x = t.byId.get(id), kind = null, restricted = null;
  while (x) { if (!kind && x.kind && x.kind !== 'inherit') kind = x.kind; if (!restricted && x.restricted && x.restricted !== 'inherit') restricted = x.restricted; x = x.parent_id ? t.byId.get(x.parent_id) : null; }
  return { kind: kind || 'shop', restricted: restricted || 'none' };
}

function place(p) {
  const t = tree();
  if (p.category_id && t.byId.get(p.category_id)) return p.category_id;
  const bySlug = t.bySlug.get(norm(p.category).trim()); if (bySlug) return bySlug.id;   // the category given as an exact slug is a deliberate choice
  const title = ' ' + norm(p.title).replace(/[^a-z0-9а-яё]+/g, ' ') + ' ';
  let best = null, bestScore = 0;
  for (const n of t.byId.values()) {
    // title words never put a product into a restricted (licence-only) or non-shop (classifieds / RFQ / partner) node: a false match
    // there would hide an ordinary product from the cart. Those need an explicit choice or the product's own category name.
    const e = effective(n.id); if (e.kind !== 'shop' || e.restricted !== 'none') continue;
    for (const k of n.kw) {
    if (!title.includes(' ' + k + ' ') && !(k.length >= 5 && title.includes(k))) continue;
    const score = k.length * 10 + n.depth;                       // longer keyword = more specific; deeper node wins a tie
    if (score > bestScore) { bestScore = score; best = n.id; }
    }
  }
  if (best) return best;
  const c = norm(p.category).trim();
  for (const n of t.byId.values()) if (n.slug === c || n.names.includes(c) || norm(n.name) === c) return n.id;
  return null;
}

// public tree with product counts (a parent counts everything under it)
function publicTree(countsById, lang = 'ru') {
  const t = tree();
  const nameOf = n => nameIn(n, lang);
  const total = n => (countsById.get(n.id) || 0) + n.children.reduce((s, c) => s + total(c), 0);
  const view = n => { const e = effective(n.id); return { slug: n.slug, name: nameOf(n), icon: n.icon || null, kind: e.kind, restricted: e.restricted, count: total(n), children: n.children.map(view) }; };
  return t.roots.map(view);
}

/* ---------- default world tree (seeded once, editable in the admin) ---------- */
const SEED = [
  ['electronics', 'Электроника', 'Electronics', 'Elektronika', null, 'shop', '💻', '', 'электроника и гаджеты, electronics'],
  ['computers', 'Компьютеры и аксессуары', 'Computers & accessories', 'Komputery i akcesoria', 'electronics', null, '🖥', 'pc, computer, komputer', ''],
  ['keyboards', 'Клавиатуры', 'Keyboards', 'Klawiatury', 'computers', null, '⌨', 'keyboard, keyboards, klawiatura, клавиатура', ''],
  ['mice', 'Мыши', 'Mice', 'Myszy', 'computers', null, '🖱', 'mouse, mice, mysz, мышь, gaming mouse', ''],
  ['monitors', 'Мониторы', 'Monitors', 'Monitory', 'computers', null, '🖥', 'monitor, monitors, display screen', ''],
  ['memory-storage', 'Память и накопители', 'Memory & storage', 'Pamięć i dyski', 'computers', null, '💾', 'ram, ddr4, ddr5, ssd, hdd, microsd, microsdxc, sd card, flash drive, cd r, dvd r, thermal paste', ''],
  ['cables-adapters', 'Кабели и адаптеры', 'Cables & adapters', 'Kable i adaptery', 'computers', null, '🔌', 'cable, cord, adapter, displayport, hdmi, dvi, usb c, speaker wire', ''],
  ['laptop-bags', 'Сумки и рюкзаки для ноутбуков', 'Laptop bags & backpacks', 'Torby i plecaki na laptopa', 'computers', null, '🎒', 'laptop backpack, sleeve case, laptop bag, backpack', ''],
  ['phone-accessories', 'Телефоны и аксессуары', 'Phones & accessories', 'Telefony i akcesoria', 'electronics', null, '📱', 'iphone, phone case, screen protector, airpod, airpods, smart case, ipad', ''],
  ['chargers-power', 'Зарядки и питание', 'Chargers & power', 'Ładowarki i zasilanie', 'electronics', null, '🔋', 'charger, wall charger, power inverter, inverter, surge protector, power strip, batteries, battery, solar panel', ''],
  ['photo-video', 'Фото и видео', 'Photo & video', 'Foto i wideo', 'electronics', null, '📷', 'camera, tripod, lens, dslr, camera bag, camera backpack', ''],
  ['auto', 'Авто', 'Cars & auto', 'Motoryzacja', null, 'shop', '🚗', '', 'motoryzacja i flota'],
  ['cars', 'Автомобили — объявления', 'Cars — classifieds', 'Samochody — ogłoszenia', 'auto', 'classifieds', '🚙', '', ''],
  ['auto-parts', 'Автозапчасти', 'Car parts', 'Części samochodowe', 'auto', null, '⚙', 'brake, filter, spark plug, wiper', ''],
  ['auto-accessories', 'Автоаксессуары', 'Car accessories', 'Akcesoria samochodowe', 'auto', null, '🧰', 'dash cam, car seat cover, car seat, car charger', ''],
  ['e-mobility', 'Электротранспорт', 'E-mobility', 'Elektromobilność', null, 'shop', '🛴', '', ''],
  ['e-scooters', 'Электросамокаты', 'E-scooters', 'Hulajnogi elektryczne', 'e-mobility', null, '🛴', 'electric scooter, e scooter, hulajnoga', ''],
  ['e-bikes', 'Электровелосипеды', 'E-bikes', 'Rowery elektryczne', 'e-mobility', null, '🚲', 'e bike, ebike, electric bike, rower elektryczny', ''],
  ['home', 'Дом и мебель', 'Home & furniture', 'Dom i meble', null, 'shop', '🛋', '', 'дом, кухня и интерьер'],
  ['furniture', 'Мебель', 'Furniture', 'Meble', 'home', null, '🪑', 'sofa, chair, table, desk, bed frame, wardrobe', ''],
  ['kitchen', 'Кухня', 'Kitchen', 'Kuchnia', 'home', null, '🍳', 'kitchen, pan, pot, knife, bowl, rice dispenser, food storage container, mixing cups, measuring cups', ''],
  ['pets', 'Зоотовары', 'Pets', 'Zoologia', null, 'shop', '🐾', 'dog, cat, pet, puppy, parrot, aquarium', 'artykuły zoologiczne hurt'],
  ['building', 'Стройка и ремонт', 'Building & renovation', 'Budowa i remont', null, 'shop', '🏗', '', ''],
  ['building-materials', 'Стройматериалы', 'Building materials', 'Materiały budowlane', 'building', null, '🧱', 'cement, drywall, plywood, insulation, tiles, piana montazowa, silikon, klej montazowy, sealant', ''],
  ['construction-services', 'Строительные работы — запрос цены', 'Construction — request a quote', 'Prace budowlane — zapytanie o cenę', 'building', 'rfq', '📐', '', ''],
  ['packaging', 'Упаковка', 'Packaging', 'Opakowania', null, 'shop', '📦', 'folia stretch, kartony, karton klapowy, foliopaki, tasma pakowa, folia babelkowa, etykiety termiczne', 'opakowania, pakowanie i kartony'],
  ['bhp', 'BHP и мастерская', 'Workwear & workshop', 'BHP i warsztat', null, 'shop', '🦺', 'bhp, rekawice, polbuty robocze', 'bhp i warsztat'],
  ['office-b2b', 'Офис и B2B', 'Office & B2B', 'Biuro i B2B', null, 'shop', '🗂', '', 'artykuły biurowe b2b'],
  ['sport', 'Спорт и отдых', 'Sport & leisure', 'Sport i rekreacja', null, 'shop', '⚽', 'golf, fitness, yoga', 'sport, rekreacja i eventy'],
  ['fashion', 'Одежда и обувь', 'Fashion', 'Moda', null, 'shop', '👟', '', 'одежда и обувь'],
  ['food', 'Еда и напитки', 'Food & drinks', 'Żywność i napoje', null, 'shop', '🍽', '', ''],
  ['snacks', 'Снеки и чипсы', 'Snacks & chips', 'Przekąski i chipsy', 'food', null, '🥔', 'chips, crisps, snack, chipsy', ''],
  ['horeca', 'Опт для отелей и ресторанов (HoReCa)', 'Wholesale for hotels & restaurants (HoReCa)', 'Hurt dla HoReCa', 'food', null, '🏨', '', ''],
  ['wine-alcohol', 'Вино и алкоголь — только B2B по лицензии', 'Wine & spirits — B2B with licence only', 'Wino i alkohol — tylko B2B z koncesją', 'food', null, '🍷', 'wine, wino, vodka, wodka, whisky, beer, piwo, prosecco, champagne, szampan', ''],
  ['services', 'Услуги', 'Services', 'Usługi', null, 'rfq', '🤝', '', ''],
  ['rental', 'Аренда — техника, авто, оборудование', 'Rental — machines, cars, equipment', 'Wynajem — sprzęt, auta', 'services', null, '🔑', '', ''],
  ['logistics-services', 'Доставка и логистика', 'Delivery & logistics', 'Dostawa i logistyka', 'services', null, '🚚', '', ''],
  ['travel', 'Путешествия', 'Travel', 'Podróże', null, 'partner', '✈', '', ''],
  ['hotels', 'Отели — сравнение цен партнёров', 'Hotels — partner price comparison', 'Hotele — porównanie cen', 'travel', null, '🏨', '', '']
];
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM m_categories').get().n) { focus(); return 0; }
  const t = Date.now(), ids = new Map();
  const ins = db.prepare('INSERT INTO m_categories(slug,name,name_en,name_pl,parent_id,kind,restricted,icon,keywords,match_names,sort,active,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)');
  db.transaction(() => SEED.forEach(([slug, name, en, pl, parent, kind, icon, kw, names], i) => {
    const restricted = slug === 'wine-alcohol' ? 'b2b_licence' : 'inherit';
    ids.set(slug, Number(ins.run(slug, name, en, pl, parent ? ids.get(parent) : null, kind || 'inherit', restricted, icon, kw, names, i, t, t, 'seed').lastInsertRowid));
  }))();
  invalidate(); focus();
  return SEED.length;
}

/* ---------- launch focus: B2B supply first (packaging, warehouse, workwear, cleaning, office, HoReCa) ----------
   Applied once per version on top of the seeded tree, so an existing install gets it too. Adds the nodes the real catalogue needs,
   orders the roots and switches off verticals that wait for later (car classifieds, alcohol, hotels). The admin can switch them back on. */
const FOCUS_VERSION = 'b2b-v2';
const FOCUS_NODES = [
  ['warehouse', 'Склад и хозяйство', 'Warehouse & facility', 'Magazyn i utrzymanie', null, '🏭', 'paleta, palety, regal magazynowy, wozek paletowy, wozek platformowy, wozek magazynowy, drabina, ladder, hand truck, pallet', ''],
  ['storage', 'Хранение и организация', 'Storage & organisation', 'Przechowywanie i organizacja', 'warehouse', '🗄', 'organizer, storage box, storage bin, shelf, shelves, regal, pojemnik, hanger, hooks, rack', ''],
  ['tools', 'Инструменты и крепёж', 'Tools & fasteners', 'Narzędzia i mocowania', 'warehouse', '🔧', 'trampoline hook tool, drill, wrench, screwdriver, pliers, hammer, screws, bolts, nuts, wkretarka, wiertarka, klucz, mlotek, sruby, connector, bracket', ''],
  ['lighting-electric', 'Свет и электрика', 'Lighting & electrical', 'Oświetlenie i elektryka', 'warehouse', '💡', 'led bulb, led strip, light bulb, bulb, lamp, doorbell, extension cord, socket, switch, zarowka, lampa', ''],
  ['packaging-film', 'Плёнка и пузырчатая плёнка', 'Stretch & bubble film', 'Folie stretch i bąbelkowe', 'packaging', '🧻', 'folia stretch, folia babelkowa, stretch film, bubble wrap', ''],
  ['packaging-boxes', 'Коробки и конверты', 'Boxes & mailers', 'Kartony i koperty', 'packaging', '📦', 'kartony, karton klapowy, karton wysylkowy, pudelko, foliopak, foliopaki, koperta babelkowa, mailer, shipping box, to go boxes, containers with lids', ''],
  ['packaging-tape', 'Скотч и этикетки', 'Tape & labels', 'Taśmy i etykiety', 'packaging', '🏷', 'tasma pakowa, tasma, zaklejarka, dyspenser do tasmy, tape dispenser, etykiety, etykiety termiczne, packing tape, shipping labels, label', ''],
  ['bhp-gloves', 'Перчатки и защита', 'Gloves & protection', 'Rękawice i ochrona', 'bhp', '🧤', 'rekawice, ochronniki sluchu, nauszniki, stopery, gloves, nitrile, polmaska, polmaski, ffp2, ffp3, mask, respirator, goggles, okulary ochronne, earplugs', ''],
  ['bhp-workwear', 'Рабочая одежда и обувь', 'Workwear & safety shoes', 'Odzież i obuwie robocze', 'bhp', '🦺', 'kamizelka, kamizelka ostrzegawcza, spodnie robocze, kask, kask ochronny, kurtka robocza, ogrodniczki robocze, safety vest, high visibility, polbuty robocze, safety shoes, work boots, ubranie robocze', ''],
  ['cleaning', 'Химия и уборка', 'Cleaning & hygiene', 'Chemia i czystość', null, '🧴', 'detergent, cleaner, koncentrat, zmywacz, odtluszczacz, mydlo, mydlo w plynie, reczniki papierowe, hand soap, plyn do mycia, pasta bhp, mop, recznik papierowy, paper towel, toilet paper, papier toaletowy, disinfectant, dezynfekcja, trash bags, worki na smieci', 'chemia i czystość, chemia i utrzymanie czystości'],
  ['office-supplies', 'Канцелярия', 'Office supplies', 'Artykuły biurowe', 'office-b2b', '✏', 'pen, pens, pencil, pencil case, notebook, binder, stapler, paper a4, papier ksero, folder, marker, sticky notes, desk organizer', ''],
  ['office-tech', 'Техника для офиса', 'Office equipment', 'Sprzęt biurowy', 'office-b2b', '🖨', 'printer, toner, shredder, monitor stand, laptop stand, monitor arm, label printer, calculator', ''],
  ['horeca-equipment', 'Оборудование и посуда', 'Equipment & tableware', 'Sprzęt i zastawa', 'horeca', '🍽', 'toaster, blender, coffee maker, kettle, cutlery, plates, glasses, mug, tray, gastronomia', ''],
  ['horeca-food', 'Продукты оптом', 'Food wholesale', 'Żywność hurtowo', 'horeca', '🥩', 'beef, chicken meat, fish, milk, potatoes, pepper, ice cream, honey, soft drinks, coffee beans, mieso, mleko', ''],
  ['beauty', 'Красота и уход', 'Beauty & personal care', 'Uroda i pielęgnacja', null, '💄', 'shampoo, conditioner, hair, beard, face scrub, skin care, lipstick, makeup, mascara, nail polish, razor, shaving, perfume, lotion, serum, eyelash, moisturizer, cleanser, face wash, toothpaste, body oil, bath salt, foot file, callus, deodorant, sunscreen', ''],
  ['baby-kids', 'Дети', 'Baby & kids', 'Dziecko', null, '🧸', 'baby, newborn, infant, toddler, kids, diaper, toy, toys', ''],
  ['garden', 'Сад', 'Garden', 'Ogród', null, '🌱', 'garden, plant stand, planter, flower pot, shepherd hook, hose, lawn, ogrod', ''],
  ['gifts-jewelry', 'Подарки и украшения', 'Gifts & jewellery', 'Prezenty i biżuteria', 'fashion', '🎁', 'necklace, pendant, bracelet, earrings, ring, gift basket, gifts for women, gifts for men, jewelry', ''],
  ['home-decor', 'Декор и текстиль', 'Decor & textiles', 'Dekoracje i tekstylia', 'home', '🕯', 'candle, candles, photo frame, pillow, blanket, curtain, rug, vase, wall art, salt lamp, balloons, party decoration, halloween, preserved roses, artificial flowers', '']
];
// root order: the launch niche first, everything else after it
const FOCUS_ORDER = ['packaging', 'warehouse', 'bhp', 'cleaning', 'office-b2b', 'horeca', 'building', 'pets', 'auto', 'electronics', 'home', 'garden', 'beauty', 'baby-kids', 'sport', 'fashion', 'food', 'e-mobility', 'services', 'travel'];
const FOCUS_OFF = ['cars', 'wine-alcohol', 'travel', 'hotels'];
function focus() {
  const { getSetting, setSetting } = require('../db');
  if (getSetting('categories.focus') === FOCUS_VERSION) return false;
  const t = Date.now(), id = slug => (db.prepare('SELECT id FROM m_categories WHERE slug=?').get(slug) || {}).id;
  db.transaction(() => {
    const ins = db.prepare("INSERT INTO m_categories(slug,name,name_en,name_pl,parent_id,kind,restricted,icon,keywords,match_names,sort,active,created_at,updated_at,created_by) VALUES(?,?,?,?,?,'inherit','inherit',?,?,?,?,1,?,?,'seed')");
    FOCUS_NODES.forEach(([slug, name, en, pl, parent, icon, kw, names], i) => { if (!id(slug)) ins.run(slug, name, en, pl, parent ? id(parent) : null, icon, kw, names, 100 + i, t, t); else db.prepare("UPDATE m_categories SET keywords=? WHERE slug=? AND created_by='seed'").run(kw, slug); });
    // HoReCa becomes its own root (supplies for hotels and restaurants), not only food
    const h = id('horeca'); if (h) db.prepare("UPDATE m_categories SET parent_id=NULL, kind='shop', name='HoReCa — для отелей и ресторанов', name_en='HoReCa — hotels & restaurants', name_pl='HoReCa — hotele i restauracje', icon='🏨', updated_at=? WHERE id=?").run(t, h);
    const w = id('wine-alcohol'); if (w && h) db.prepare('UPDATE m_categories SET parent_id=? WHERE id=?').run(h, w);
    FOCUS_ORDER.forEach((slug, i) => db.prepare('UPDATE m_categories SET sort=?, updated_at=? WHERE slug=? AND parent_id IS NULL').run(i, t, slug));
    // generic name lists from the old free-text categories were unreliable (cosmetics filed under "fleet"): title keywords decide instead
    db.prepare("UPDATE m_categories SET match_names='' WHERE slug IN ('auto','home','pets','sport','office-b2b','electronics','fashion') AND created_by='seed'").run();
    db.prepare(`UPDATE m_categories SET active=0, updated_at=? WHERE slug IN (${FOCUS_OFF.map(() => '?').join(',')})`).run(t, ...FOCUS_OFF);
    setSetting('categories.focus', FOCUS_VERSION);
  })();
  invalidate();
  return true;
}

module.exports = { focus, FOCUS_VERSION, nameIn, tree, subtree, path, effective, place, publicTree, seed, invalidate, norm };
