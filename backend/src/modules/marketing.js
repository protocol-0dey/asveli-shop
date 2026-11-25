'use strict';
/* MODULE 4 — Marketing, ads & SEO: ad campaigns with budgets, coupons, loyalty tiers, customer cohorts → personalised banners, SEO pages. */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db } = require('../db');
const { now } = require('../services/common');
const pers = require('../services/personalization');

define({
  name: 'campaigns', table: 'm_campaigns', label: 'Рекламные кампании', group: 'Маркетинг и SEO', perm: 'campaigns', title: 'name',
  search: ['name'], filters: ['status', 'seller_id'], list: ['name', 'seller_id', 'product_id', 'budget', 'spent', 'clicks', 'orders', 'revenue', 'status'],
  fields: [
    { k: 'name', label: 'Название', t: 'text', req: true, max: 100 },
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers' },
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products' },
    { k: 'budget', label: 'Бюджет (центы)', t: 'money', req: true, min: 1 },
    { k: 'cpc', label: 'Цена клика (центы)', t: 'money', req: true, min: 1 },
    { k: 'starts_at', label: 'Старт', t: 'date' }, { k: 'ends_at', label: 'Конец', t: 'date' },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['draft', 'active', 'paused', 'ended'], def: 'draft', ro: true },
    { k: 'spent', label: 'Потрачено', t: 'money', def: 0, ro: true },
    { k: 'impressions', label: 'Показы', t: 'int', def: 0, ro: true }, { k: 'clicks', label: 'Клики', t: 'int', def: 0, ro: true },
    { k: 'orders', label: 'Заказы', t: 'int', def: 0, ro: true }, { k: 'revenue', label: 'Выручка', t: 'money', def: 0, ro: true }
  ],
  present: (out) => { out.roas = out.spent > 0 ? Math.round(out.revenue * 100 / out.spent) / 100 : null; },
  validate: (data, _u, before) => { const s = k => (k in data ? data[k] : before && before[k]); if (s('starts_at') && s('ends_at') && s('ends_at') < s('starts_at')) throw E.bad('invalid_dates'); },
  actions: {
    activate: { perm: 'campaigns.write', label: 'Запустить', run: ({ row, update }) => {
      if (!['draft', 'paused'].includes(row.status)) throw E.conflict('bad_state');
      if (row.spent >= row.budget) throw E.conflict('budget_exhausted');
      if (row.product_id && db.prepare('SELECT status FROM m_products WHERE id=?').get(row.product_id).status !== 'approved') throw E.conflict('product_not_approved');
      return update({ status: 'active' }); } },
    pause: { perm: 'campaigns.write', label: 'Пауза', run: ({ row, update }) => { if (row.status !== 'active') throw E.conflict('bad_state'); return update({ status: 'paused' }); } },
    end: { perm: 'campaigns.write', label: 'Завершить', confirm: true, run: ({ row, update }) => { if (row.status === 'ended') throw E.conflict('bad_state'); return update({ status: 'ended' }); } },
    // statistics ingestion (the storefront's ad server reports counters here); spend = clicks × CPC, never above budget
    record: { perm: 'campaigns.write', label: 'Внести статистику', fields: ['impressions', 'clicks', 'orders', 'revenue'].map(k => ({ k, t: 'int', label: k })), run: ({ row, body, update }) => {
      if (row.status !== 'active') throw E.conflict('bad_state');
      const n = k => { const v = body[k] ?? 0; if (!Number.isSafeInteger(v) || v < 0 || v > 1e9) throw E.bad('invalid_' + k); return v; };
      const d = { impressions: n('impressions'), clicks: n('clicks'), orders: n('orders'), revenue: n('revenue') };
      const spent = Math.min(row.budget, row.spent + d.clicks * row.cpc);
      return update({ impressions: row.impressions + d.impressions, clicks: row.clicks + d.clicks, orders: row.orders + d.orders, revenue: row.revenue + d.revenue, spent, status: spent >= row.budget ? 'ended' : 'active' }); } }
  }
});

define({
  name: 'coupons', table: 'm_coupons', label: 'Купоны и акции', group: 'Маркетинг и SEO', perm: 'coupons', title: 'code',
  search: ['code'], filters: ['active', 'kind'], list: ['code', 'kind', 'value', 'min_order', 'used', 'max_uses', 'ends_at', 'active'],
  fields: [
    { k: 'code', label: 'Код', t: 'text', req: true, unique: true, max: 30, pattern: /^[A-Z0-9_-]{2,30}$/ },
    { k: 'kind', label: 'Тип', t: 'enum', vals: ['percent', 'fixed'], req: true },
    { k: 'value', label: 'Значение (percent → bps; fixed → центы)', t: 'int', req: true, min: 1, max: 1e9 },
    { k: 'min_order', label: 'Мин. сумма заказа', t: 'money', def: 0 },
    { k: 'max_uses', label: 'Макс. использований (0 = без лимита)', t: 'int', min: 0, max: 1e9, def: 0 },
    { k: 'per_customer', label: 'На покупателя', t: 'int', min: 1, max: 1000, def: 1 },
    { k: 'used', label: 'Использовано', t: 'int', def: 0, ro: true },
    { k: 'starts_at', label: 'Старт', t: 'date' }, { k: 'ends_at', label: 'Конец', t: 'date' },
    { k: 'active', label: 'Активен', t: 'bool', def: 1 }
  ],
  validate: (data, user, before) => {
    const s = k => (k in data ? data[k] : before && before[k]);
    { const g = require('../services/delegate').checkAgentCoupon(user, s('kind'), s('value')); if (g) throw E.bad(g); }   // AI agents: discount cap set by the owner
    if (s('kind') === 'percent' && s('value') > 9000) throw E.bad('percent_too_high');     // 90% cap: a typo must not give away the shop
    if (s('kind') === 'fixed' && s('value') > 50000) throw E.bad('fixed_too_high');         // fixed coupons are capped at 500.00
    if (((s('kind') === 'percent' && s('value') > 3000) || s('kind') === 'fixed') && !s('max_uses')) throw E.bad('max_uses_required');   // big discounts must be limited in number
  }
});
define({
  name: 'coupon_uses', table: 'm_coupon_uses', label: 'Использования купонов', group: 'Маркетинг и SEO', perm: 'coupons', create: false, update: false,
  filters: ['coupon_id', 'customer_id'], list: ['coupon_id', 'customer_id', 'order_id', 'amount', 'created_at'],
  fields: [{ k: 'coupon_id', t: 'ref', ref: 'coupons', req: true, label: 'Купон' }, { k: 'customer_id', t: 'ref', ref: 'customers', req: true, label: 'Покупатель' },
    { k: 'order_id', t: 'ref', ref: 'orders', label: 'Заказ' }, { k: 'amount', t: 'money', label: 'Скидка' }]
});

define({
  name: 'loyalty_tiers', table: 'm_loyalty_tiers', label: 'Программа лояльности', group: 'Маркетинг и SEO', perm: 'loyalty', title: 'name', remove: true,
  list: ['name', 'min_spent', 'points_mult', 'active'],
  fields: [
    { k: 'name', label: 'Уровень', t: 'text', req: true, unique: true, max: 30 },
    { k: 'min_spent', label: 'От суммы покупок (центы)', t: 'money', req: true },
    { k: 'points_mult', label: 'Множитель баллов, % (100 = ×1)', t: 'int', min: 100, max: 1000, def: 100 },
    { k: 'active', label: 'Активен', t: 'bool', def: 1 }
  ]
});

define({
  name: 'segments', table: 'm_segments', label: 'Сегменты (когорты)', group: 'Маркетинг и SEO', perm: 'segments', title: 'name', remove: true,
  list: ['name', 'field', 'op', 'value', 'active'],
  fields: [
    { k: 'name', label: 'Название', t: 'text', req: true, max: 80 },
    { k: 'field', label: 'Показатель', t: 'enum', vals: ['total_spent', 'orders_count', 'country', 'loyalty_tier', 'days_since_last_order'], req: true },
    { k: 'op', label: 'Условие', t: 'enum', vals: ['gte', 'lte', 'eq'], req: true },
    { k: 'value', label: 'Значение', t: 'text', req: true, max: 40 },
    { k: 'active', label: 'Активен', t: 'bool', def: 1 }
  ],
  validate: (data, _u, before) => {
    const s = k => (k in data ? data[k] : before && before[k]);
    if (s('field') === 'country' || s('field') === 'loyalty_tier') { if (s('op') !== 'eq') throw E.bad('text_fields_need_eq'); }
    else if (!Number.isFinite(Number(s('value')))) throw E.bad('invalid_value');
  }
});

define({
  name: 'banners', table: 'm_banners', label: 'Баннеры витрины', group: 'Маркетинг и SEO', perm: 'banners', title: 'title', remove: true,
  filters: ['placement', 'active', 'segment_id'], list: ['title', 'placement', 'segment_id', 'priority', 'active', 'starts_at', 'ends_at'],
  fields: [
    { k: 'title', label: 'Заголовок', t: 'text', req: true, max: 100 },
    { k: 'text', label: 'Текст', t: 'text', max: 300 },
    { k: 'link', label: 'Ссылка (/путь или https://…)', t: 'text', max: 300, pattern: /^(\/[^\s]*|https:\/\/[^\s]+)$/ },
    { k: 'placement', label: 'Место', t: 'enum', vals: ['home_top', 'home_mid', 'cart', 'category'], req: true },
    { k: 'segment_id', label: 'Сегмент (пусто = всем)', t: 'ref', ref: 'segments' },
    { k: 'priority', label: 'Приоритет (меньше = выше)', t: 'int', min: 0, max: 1000, def: 100 },
    { k: 'starts_at', label: 'Старт', t: 'date' }, { k: 'ends_at', label: 'Конец', t: 'date' },
    { k: 'active', label: 'Активен', t: 'bool', def: 1 }
  ]
});

define({
  name: 'seo_pages', table: 'm_seo_pages', label: 'SEO-страницы', group: 'Маркетинг и SEO', perm: 'seo', title: 'path', remove: true,
  search: ['path', 'title_tag'], list: ['path', 'title_tag', 'noindex'],
  fields: [
    { k: 'path', label: 'Путь', t: 'text', req: true, unique: true, max: 200, pattern: /^\/[A-Za-z0-9\/_.-]*$/ },
    { k: 'title_tag', label: 'Title', t: 'text', max: 120 },
    { k: 'meta_description', label: 'Meta description', t: 'text', max: 300 },
    { k: 'canonical', label: 'Canonical URL', t: 'text', max: 300, pattern: /^https:\/\/[^\s]+$/ },
    { k: 'noindex', label: 'noindex', t: 'bool', def: 0 }
  ]
});

module.exports.routes = (r, h) => {
  r.get('/personalization/preview', h.need('segments.read'), h.need('customers.read'), (req, res) => {
    const out = pers.forCustomer(h.id(req.query.customer_id)); if (!out) throw E.notFound(); res.json(out);
  });
  r.get('/segments/:id/size', h.need('segments.read'), (req, res) => { const n = pers.members(h.id(req.params.id)); if (n === null) throw E.notFound(); res.json({ members: n === 0 ? 0 : n < 10 ? '<10' : Math.floor(n / 10) * 10 }); });   // bucketed: no probing of single customers
  r.get('/seo/audit', h.need('seo.read'), (_req, res) => {
    const pages = db.prepare('SELECT * FROM m_seo_pages').all(), seen = new Map(), issues = [];
    for (const p of pages) {
      const add = (code) => issues.push({ path: p.path, issue: code });
      if (!p.title_tag) add('missing_title'); else { if (p.title_tag.length > 60) add('title_too_long'); if (p.title_tag.length < 10) add('title_too_short'); seen.set(p.title_tag, [...(seen.get(p.title_tag) || []), p.path]); }
      if (!p.meta_description) add('missing_meta_description'); else if (p.meta_description.length > 160) add('meta_too_long');
      if (!p.canonical && !p.noindex) add('missing_canonical');
    }
    for (const [t, paths] of seen) if (paths.length > 1) for (const path of paths) issues.push({ path, issue: 'duplicate_title' });
    res.json({ pages: pages.length, issues });
  });
};
