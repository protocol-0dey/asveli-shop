'use strict';
/* MODULE — «Маркетплейс всего»: the category tree (shop / classifieds / services-RFQ / partner), offers of other shops and marketplaces
   shown under a product, and buyer ⇄ seller ⇄ Asveli conversations (contact a seller, request a quote, order through Asveli as a broker,
   B2B order for licence-only goods). Buyers never see a seller's e-mail and sellers never see a buyer's: messages go through the platform. */
const { define } = require('../engine/registry');
const { db } = require('../db');
const { E } = require('../engine/errors');
const cats = require('../services/categories');
const now = () => Date.now();

define({
  name: 'categories', table: 'm_categories', label: 'Категории (дерево)', group: 'Продавцы и каталог', perm: 'products', title: 'name',
  search: ['name', 'slug'], filters: ['kind', 'restricted', 'parent_id', 'active'], list: ['name', 'slug', 'parent_id', 'kind', 'restricted', 'active'], sort: 'sort, id',
  fields: [
    { k: 'slug', label: 'Адрес (slug)', t: 'text', req: true, max: 60, unique: true, pattern: /^[a-z0-9][a-z0-9-]*$/ },
    { k: 'name', label: 'Название (RU)', t: 'text', req: true, max: 80 },
    { k: 'name_en', label: 'Название (EN)', t: 'text', max: 80 },
    { k: 'name_pl', label: 'Название (PL)', t: 'text', max: 80 },
    { k: 'parent_id', label: 'Родительская категория', t: 'ref', ref: 'categories' },
    { k: 'kind', label: 'Тип', t: 'enum', vals: ['inherit', 'shop', 'classifieds', 'rfq', 'partner'], def: 'inherit', hint: 'shop — покупка в корзине · classifieds — объявления, «Связаться» · rfq — запрос цены · partner — предложения партнёров' },
    { k: 'restricted', label: 'Ограничение', t: 'enum', vals: ['inherit', 'none', 'b2b_licence'], def: 'inherit', hint: 'b2b_licence — только бизнес-покупатели с лицензией (алкоголь и т. п.), без корзины' },
    { k: 'icon', label: 'Значок', t: 'text', max: 8 },
    { k: 'keywords', label: 'Слова в названии товара для авто-сортировки', t: 'text', max: 600 },
    { k: 'match_names', label: 'Старые названия категорий товаров (через запятую)', t: 'text', max: 400 },
    { k: 'sort', label: 'Порядок', t: 'int', def: 0, min: 0, max: 100000 },
    { k: 'active', label: 'Показывать', t: 'bool', def: 1 }
  ],
  validate: (data, _u, before) => {
    if (before && data.parent_id != null) {                                   // no loops: a node can't move under itself
      let x = data.parent_id, guard = 0;
      while (x && guard++ < 50) { if (x === before.id) throw E.bad('category_loop'); x = (db.prepare('SELECT parent_id FROM m_categories WHERE id=?').get(x) || {}).parent_id; }
    }
  },
  afterCreate: () => { cats.invalidate(); require('../store/catalog').invalidate(); },
  afterUpdate: () => { cats.invalidate(); require('../store/catalog').invalidate(); }
});

// offers of other shops / marketplaces for the same product (from partner feeds or entered by staff). Shown under the product with the
// date the price was checked; a stale price is hidden. mode 'link' = buyer goes to the partner (affiliate link, marked as such);
// mode 'broker' = buyer orders through Asveli and the team buys from the partner (B2B, commission).
define({
  name: 'external_offers', table: 'm_external_offers', label: 'Предложения других магазинов', group: 'Продавцы и каталог', perm: 'products', title: 'source_name',
  search: ['source_name', 'model_slug'], filters: ['mode', 'active', 'source_kind'], list: ['model_slug', 'source_name', 'price', 'mode', 'checked_at', 'active'],
  fields: [
    { k: 'model_slug', label: 'Товар (slug карточки)', t: 'text', req: true, max: 80, pattern: /^[a-z0-9][a-z0-9-]*$/, index: true },
    { k: 'source_name', label: 'Магазин / маркетплейс', t: 'text', req: true, max: 80 },
    { k: 'source_kind', label: 'Тип источника', t: 'enum', vals: ['shop', 'marketplace', 'manufacturer'], def: 'shop' },
    { k: 'url', label: 'Ссылка на предложение', t: 'text', req: true, max: 500, pattern: /^https:\/\/[^\s"'<>]+$/ },
    { k: 'price', label: 'Цена (центы)', t: 'money', req: true },
    { k: 'shipping', label: 'Доставка (центы)', t: 'money' },
    { k: 'delivery_days', label: 'Срок доставки, дней', t: 'int', min: 0, max: 120 },
    { k: 'ships_to', label: 'Доставляет в страны (ISO-2 через запятую, пусто = везде)', t: 'text', max: 200 },
    { k: 'mode', label: 'Как заказать', t: 'enum', vals: ['link', 'broker'], def: 'link' },
    { k: 'affiliate', label: 'Партнёрская ссылка (помечается покупателю)', t: 'bool', def: 0 },
    { k: 'commission_bps', label: 'Комиссия Asveli, bps', t: 'bps', def: 0 },
    { k: 'checked_at', label: 'Цена проверена', t: 'date', req: true },
    { k: 'active', label: 'Показывать', t: 'bool', def: 1 }
  ],
  afterCreate: () => require('../store/catalog').invalidate(), afterUpdate: () => require('../store/catalog').invalidate()
});

define({
  name: 'inquiries', table: 'm_inquiries', label: 'Обращения и запросы цены', group: 'Продажи', perm: 'orders', title: 'subject', create: false,
  search: ['subject', 'company'], filters: ['kind', 'status', 'seller_id', 'category_id'], list: ['kind', 'subject', 'seller_id', 'status', 'last_message_at'],
  fields: [
    { k: 'kind', label: 'Тип', t: 'enum', vals: ['contact_seller', 'b2b_order', 'broker_order', 'rfq'], req: true, immutable: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['open', 'answered', 'in_progress', 'closed'], def: 'open' },
    { k: 'account_id', label: 'Аккаунт покупателя', t: 'int', ro: true },
    { k: 'seller_id', label: 'Продавец (пусто = команда Asveli)', t: 'ref', ref: 'sellers', immutable: true },
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', immutable: true },
    { k: 'external_offer_id', label: 'Предложение партнёра', t: 'ref', ref: 'external_offers', immutable: true },
    { k: 'category_id', label: 'Категория', t: 'ref', ref: 'categories', immutable: true },
    { k: 'subject', label: 'Тема', t: 'text', max: 160, req: true },
    { k: 'quantity', label: 'Количество / объём', t: 'text', max: 80 },
    { k: 'location', label: 'Где', t: 'text', max: 160 },
    { k: 'deadline', label: 'Срок', t: 'date' },
    { k: 'budget', label: 'Бюджет (центы)', t: 'money' },
    { k: 'company', label: 'Компания', t: 'text', max: 160 },
    { k: 'vat_no', label: 'VAT', t: 'text', max: 20 },
    { k: 'licence_no', label: 'Номер лицензии (алкоголь и т. п.)', t: 'text', max: 60 },
    { k: 'last_message_at', label: 'Последнее сообщение', t: 'date', ro: true }
  ],
  actions: {
    reply: { perm: 'orders.write', label: 'Ответить от Asveli', fields: [{ k: 'body', t: 'longtext', label: 'Сообщение', req: true }], run: ({ row, body, user }) => {
      addMessage(row.id, 'staff', body.body, user && user.username); return undefined; } },
    in_progress: { perm: 'orders.write', label: 'В работе', run: ({ update }) => update({ status: 'in_progress' }) },
    close: { perm: 'orders.write', label: 'Закрыть', confirm: true, run: ({ update }) => update({ status: 'closed' }) }
  }
});
define({
  name: 'inquiry_messages', table: 'm_inquiry_messages', label: 'Сообщения обращений', group: 'Продажи', perm: 'orders', title: 'body', create: false, update: false,
  filters: ['inquiry_id', 'author'], list: ['inquiry_id', 'author', 'body'],
  fields: [
    { k: 'inquiry_id', label: 'Обращение', t: 'ref', ref: 'inquiries', req: true },
    { k: 'author', label: 'Автор', t: 'enum', vals: ['buyer', 'seller', 'staff'], req: true },
    { k: 'body', label: 'Текст', t: 'longtext', max: 2000, req: true }
  ]
});

const clean = s => (typeof s === 'string' ? s.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '');
function addMessage(inquiryId, author, text, by) {
  const body = clean(text);
  if (body.length < 2 || body.length > 2000) throw E.bad('invalid_message');
  const t = now();
  db.prepare('INSERT INTO m_inquiry_messages(inquiry_id,author,body,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?)').run(inquiryId, author, body, t, t, by || author);
  const status = author === 'buyer' ? 'open' : 'answered';
  db.prepare("UPDATE m_inquiries SET last_message_at=?, updated_at=?, status=CASE WHEN status='closed' AND ?='buyer' THEN 'open' WHEN status='in_progress' AND ?<>'buyer' THEN 'in_progress' ELSE ? END WHERE id=?")
    .run(t, t, author, author, status, inquiryId);
}

module.exports.addMessage = addMessage;
module.exports.clean = clean;
module.exports.seed = () => cats.seed();

// AI placement of the catalogue in the tree (admin). dry=1 shows the answer without saving.
module.exports.routes = (r, h) => {
  r.post('/catalog/autocat', h.need('products.write'), h.wrap(async (req, res) => {
    const b = req.body || {};
    const out = await require('../services/autocat').run({ limit: b.limit, all: !!b.all, dry: !!b.dry });
    require('../db').audit(req, 'catalog.autocat', `placed ${out.placed}/${out.checked}${out.dry ? ' (dry)' : ''}`, req.user.username);
    res.json(out);
  }));
  r.post('/catalog/focus', h.need('products.write'), (_req, res) => res.json({ applied: cats.focus(), version: cats.FOCUS_VERSION }));
};
