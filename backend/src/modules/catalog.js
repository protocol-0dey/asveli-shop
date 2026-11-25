'use strict';
/* MODULE 1 — Sellers & catalog: seller onboarding/KYC, product moderation (PIM), stock, compliance rules. */
const { define } = require('../engine/registry');
const R = require('../engine/resource');
const { E } = require('../engine/errors');
const { db } = require('../db');
const compliance = require('../services/compliance');
const { event, now } = require('../services/common');
const { can } = require('../iam/permissions');
const ai = require('../services/ai');

const SRC_TYPES = ['url', 'pdf', 'vision', 'manual'];
const activeBrand = () => db.prepare('SELECT * FROM m_brand_kits WHERE active=1 ORDER BY id DESC LIMIT 1').get() || null;

const CC = /^[A-Z]{2}$/;
const shopifySync = () => require('../services/shopify-sync');
const trust = () => require('../services/trust');
const sellerRow = id => db.prepare('SELECT * FROM m_sellers WHERE id=?').get(id);
// the trust gate a moderator's approve shares with Seller Central's submit: copied photos and "no region ready" stop a gated seller's listing
function trustGate(p) {
  const s = sellerRow(p.seller_id); if (!s || !trust().enforced(s)) return null;
  if (trust().foreignImages(p.images).length) return 'foreign_photos';
  const st = trust().productRegions(p, s);
  if (!st.requested.length) return 'no_sale_regions';
  if (!st.ready.length) return 'no_region_ready';
  return null;
}
module.exports.trustGate = trustGate;
const competitors = () => require('../services/competitors');        // lazy: the sync engine needs the tables this module defines

define({
  name: 'orgs', table: 'm_orgs', label: 'Организации (тенанты)', group: 'Продавцы и каталог', perm: 'sellers', title: 'name',
  search: ['name'], list: ['name'], create: true, update: true,
  fields: [{ k: 'name', label: 'Организация', t: 'text', req: true, max: 120 }]
});

define({
  name: 'sellers', table: 'm_sellers', label: 'Продавцы', group: 'Продавцы и каталог', perm: 'sellers', title: 'name',
  search: ['name', 'country'], filters: ['kyc_status', 'status', 'risk_tier', 'country'],
  list: ['name', 'country', 'kyc_status', 'status', 'risk_tier', 'commission_bps'],
  fields: [
    { k: 'name', label: 'Название магазина', t: 'text', req: true, max: 120 },
    { k: 'country', label: 'Страна (ISO-2)', t: 'text', req: true, pattern: CC, max: 2 },
    { k: 'org_id', label: 'Организация (пусто = новая)', t: 'ref', ref: 'orgs', immutable: true },
    { k: 'legal_name', label: 'Юр. лицо / ФИО', t: 'pii', pii: 'name' },
    { k: 'email', label: 'E-mail', t: 'pii', pii: 'email', blind: true },
    { k: 'phone', label: 'Телефон', t: 'pii', pii: 'phone' },
    { k: 'address', label: 'Адрес', t: 'pii', pii: 'address', blind: true },
    { k: 'tax_id', label: 'Tax ID / VAT', t: 'pii', pii: 'taxid' },
    { k: 'passport_no', label: 'Паспорт директора', t: 'pii', pii: 'passport' },
    { k: 'bank_iban', label: 'IBAN для выплат', t: 'pii', pii: 'iban' },
    { k: 'commission_bps', label: 'Комиссия, bps (1500 = 15%)', t: 'bps', def: 1500, perm: 'sellers.commission' },
    { k: 'risk_tier', label: 'Риск', t: 'enum', vals: ['low', 'medium', 'high'], def: 'low', perm: 'sellers.risk' },
    { k: 'kyc_status', label: 'KYC', t: 'enum', vals: ['not_submitted', 'pending', 'approved', 'rejected'], def: 'not_submitted', ro: true },
    { k: 'kyc_note', label: 'Заметка KYC', t: 'text', ro: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['onboarding', 'active', 'suspended'], def: 'onboarding', ro: true },
    // ---- trust & safety (services/trust.js): DSA art. 30 / INFORM data, yearly re-certification, sanctions ----
    { k: 'origin', label: 'Откуда продавец', t: 'enum', vals: ['admin', 'portal'], def: 'admin', ro: true },
    { k: 'registry_name', label: 'Реестр компаний (KRS, Companies House…)', t: 'text', max: 80 },
    { k: 'registration_no', label: 'Номер в реестре', t: 'text', max: 40, pattern: /^[A-Za-z0-9 ./-]+$/ },
    { k: 'vat_no', label: 'VAT / налоговый номер для покупателей', t: 'text', max: 20, pattern: /^[A-Za-z0-9]+$/ },
    { k: 'own_brands', label: 'Собственные бренды (через запятую)', t: 'text', max: 300 },
    { k: 'self_cert_at', label: 'Самосертификация («продаю только законные товары»)', t: 'date', ro: true },
    { k: 'kyb_verified_at', label: 'Данные проверены', t: 'date', ro: true },
    { k: 'recert_due_at', label: 'Подтвердить данные до', t: 'date', ro: true },
    { k: 'strikes', label: 'Нарушений', t: 'int', def: 0, ro: true },
    { k: 'listing_ban_until', label: 'Запрет новых карточек до', t: 'date', ro: true },
    { k: 'blocked_regions', label: 'Продажи приостановлены в регионах', t: 'text', ro: true },
    { k: 'payouts_hold', label: 'Выплаты удержаны', t: 'bool', def: 0, ro: true }
  ],
  actions: {
    kyc_submit: { perm: 'sellers.write', label: 'Отправить на KYC', run: ({ row, update }) => {
      if (!['not_submitted', 'rejected'].includes(row.kyc_status)) throw E.conflict('bad_state');
      for (const k of ['legal_name', 'tax_id', 'passport_no', 'bank_iban']) if (!row[k]) throw E.bad('missing_' + k);
      return update({ kyc_status: 'pending', kyc_note: null }); } },
    kyc_approve: { perm: 'sellers.kyc', label: 'KYC: одобрить', confirm: true, run: ({ row, update }) => {
      if (row.kyc_status !== 'pending') throw E.conflict('bad_state');
      const t = Date.now();
      return update({ kyc_status: 'approved', kyc_note: null, kyb_verified_at: t, recert_due_at: t + trust().config().recert_days * 864e5 }); } },
    strike: { perm: 'sellers.kyc', label: 'Нарушение (санкция)', confirm: true, fields: [
      { k: 'level', t: 'enum', vals: ['1', '2', '3', '4'], label: '1 предупреждение · 2 запрет карточек 30 дн. · 3 стоп в регионе · 4 блокировка', req: true },
      { k: 'reason', t: 'text', label: 'Причина (увидит продавец)', req: true },
      { k: 'region', t: 'enum', vals: Object.keys(require('../services/trust').REGIONS), label: 'Регион (для уровня 3)' },
      { k: 'product_id', t: 'int', label: 'Товар (снять с продажи)' }], run: ({ row, body, user }) => {
      const level = Number(body.level);
      if (![1, 2, 3, 4].includes(level)) throw E.bad('invalid_level');
      if (typeof body.reason !== 'string' || body.reason.trim().length < 3) throw E.bad('required_reason');
      const pidv = body.product_id == null || body.product_id === '' ? null : Number(body.product_id);
      if (pidv != null && !db.prepare('SELECT 1 FROM m_products WHERE id=? AND seller_id=?').get(pidv, row.id)) throw E.bad('product_not_of_seller');
      let r; try { r = trust().strike({ sellerId: row.id, level, reason: body.reason.trim().slice(0, 200), region: body.region || null, productId: pidv, by: user && user.username }); }
      catch (e) { throw E.bad(e.code || 'invalid'); }
      event('seller_strike', { ref_type: 'seller', ref_id: row.id, seller_id: row.id, data: { level, region: r.blocked_regions ? body.region : null } });
      return undefined; } },
    kyc_reject: { perm: 'sellers.kyc', label: 'KYC: отклонить', confirm: true, fields: [{ k: 'note', t: 'text', label: 'Причина', req: true }], run: ({ row, body, update }) => {
      if (row.kyc_status !== 'pending') throw E.conflict('bad_state');
      if (typeof body.note !== 'string' || !body.note.trim()) throw E.bad('required_note');
      return update({ kyc_status: 'rejected', kyc_note: body.note.trim().slice(0, 200) }); } },
    activate: { perm: 'sellers.kyc', label: 'Активировать', run: ({ row, update }) => {
      if (row.kyc_status !== 'approved') throw E.conflict('kyc_required');            // no selling before identity is verified
      return update({ status: 'active' }); } },
    suspend: { perm: 'sellers.write', label: 'Заблокировать', confirm: true, run: ({ row, update }) => {
      const r = update({ status: 'suspended' });
      db.prepare("UPDATE m_products SET status='delisted', updated_at=? WHERE seller_id=? AND status IN ('approved','pending_review')").run(now(), row.id);   // listings vanish with the seller
      event('seller_suspended', { ref_type: 'seller', ref_id: row.id, seller_id: row.id });
      return r; } }
  },
  // once KYC is approved the identity fields are frozen: changing a bank account/passport requires a new KYC round
  lockedWhen: () => false,
  validate: (data, _u, before, internal) => {
    if (internal || !before) return;
    if (['pending', 'approved'].includes(before.kyc_status) && ['legal_name', 'tax_id', 'passport_no', 'bank_iban'].some(k => k in data)) throw E.conflict('kyc_locked');
  }
});

define({
  name: 'products', table: 'm_products', label: 'Товары', group: 'Продавцы и каталог', perm: 'products', title: 'title',
  search: ['title', 'sku', 'barcode', 'external_id', 'category'], filters: ['status', 'seller_id', 'category', 'human_verified', 'ai_status'],
  list: ['sku', 'title', 'supplier_name', 'cost', 'markup_pct', 'price', 'status', 'human_verified', 'ai_confidence'],
  fields: [
    { k: 'sku', label: 'SKU', t: 'text', req: true, max: 64, unique: true, pattern: /^[A-Za-z0-9._-]+$/ },
    { k: 'title', label: 'Название', t: 'text', req: true },
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers', req: true, immutable: true },
    { k: 'category', label: 'Категория', t: 'text', req: true, max: 60 },
    { k: 'category_id', label: 'Категория в дереве (пусто = автоматически по названию)', t: 'ref', ref: 'categories' },
    { k: 'category_source', label: 'Кто выбрал категорию', t: 'enum', vals: ['manual', 'ai'], def: 'manual', ro: true },
    { k: 'description', label: 'Описание', t: 'longtext' },
    { k: 'price', label: 'Цена (центы)', t: 'money', req: true },
    { k: 'cost', label: 'Закупочная цена (у поставщика)', t: 'money' },
    { k: 'supplier_name', label: 'Поставщик (у кого закупаем)', t: 'text', max: 120 },
    { k: 'supplier_sku', label: 'Артикул у поставщика', t: 'text', max: 80 },
    { k: 'supplier_url', label: 'Ссылка на товар у поставщика', t: 'text', max: 300, pattern: /^https:\/\/[^\s"'<>]+$/ },
    { k: 'markup_pct', label: 'Наценка, % (к закупочной цене)', t: 'int', min: 0, max: 5000 },
    { k: 'price_from_markup', label: 'Считать цену из закупки + наценки', t: 'bool', def: 0 },
    { k: 'price_confirm', label: 'Да, я уверен в резком снижении цены', t: 'bool', def: 0 },
    { k: 'min_price', label: 'Мин. цена (репрайсер)', t: 'money' },
    { k: 'max_price', label: 'Макс. цена (репрайсер)', t: 'money' },
    { k: 'competitor_price', label: 'Цена конкурента (мин., проверенная)', t: 'money' },
    { k: 'competitor_checked_at', label: 'Цены конкурентов проверены', t: 'date', ro: true },
    { k: 'story', label: 'История товара (для страницы)', t: 'longtext', max: 2000 },
    { k: 'ai_analysis', label: 'Последний AI-анализ (JSON)', t: 'longtext', max: 12000, ro: true },
    { k: 'auto_reprice', label: 'Автоцена', t: 'bool', def: 0 },
    { k: 'weight_g', label: 'Вес, г', t: 'int', min: 0, max: 1e6, def: 500 },
    { k: 'hs_code', label: 'HS-код', t: 'text', max: 12, pattern: /^[0-9.]+$/ },
    { k: 'origin_country', label: 'Страна происхождения', t: 'text', pattern: CC, max: 2 },
    // storefront fields: products with the same model_slug are offers of ONE product page (the "single detail page")
    { k: 'model_slug', label: 'Модель (slug единой карточки)', t: 'text', max: 80, pattern: /^[a-z0-9][a-z0-9-]*$/, index: true },
    { k: 'brand', label: 'Бренд', t: 'text', max: 60 },
    { k: 'images', label: 'Картинки (JSON-массив URL)', t: 'longtext', max: 2000 },
    { k: 'digital', label: 'Цифровой товар', t: 'bool', def: 0 },
    { k: 'digital_file', label: 'Файл цифрового товара (id)', t: 'text', max: 40, pattern: /^[a-f0-9]{32}$/ },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['draft', 'pending_review', 'approved', 'rejected', 'delisted'], def: 'draft', ro: true },
    { k: 'moderation_note', label: 'Заметка модератора', t: 'text', ro: true },
    { k: 'compliance_flags', label: 'Комплаенс', t: 'text', ro: true },
    // ---- identifiers, warehouse cell, AI card and its evidence (Human-in-the-Loop) ----
    { k: 'barcode', label: 'Штрихкод (EAN/UPC)', t: 'text', max: 14, pattern: /^\d{8,14}$/, index: true },
    { k: 'external_id', label: 'ID у поставщика / в канале', t: 'text', max: 120 },
    { k: 'warehouse_location', label: 'Ячейка склада', t: 'text', max: 40, pattern: /^[A-Za-z0-9._-]+$/ },
    { k: 'seo_description', label: 'SEO-описание', t: 'longtext', max: 4000 },
    { k: 'data_sources', label: 'Источники фактов (JSON)', t: 'longtext', max: 8000 },
    { k: 'ai_status', label: 'Статус AI', t: 'enum', vals: ['none', 'generated', 'failed', 'rejected'], def: 'none', ro: true },
    { k: 'ai_confidence', label: 'Уверенность AI, %', t: 'int', min: 0, max: 100, ro: true },
    { k: 'ai_flags', label: 'Замечания AI', t: 'text', ro: true, max: 300 },
    { k: 'human_verified', label: 'Проверено человеком', t: 'bool', def: 0, ro: true },
    { k: 'verified_by', label: 'Кто проверил', t: 'text', ro: true },
    // ---- where it may be sold, and what each region needs (services/trust.js) ----
    { k: 'sale_regions', label: 'Регионы продажи (EU, UK, US, CH, NO, CA через запятую)', t: 'text', max: 40, pattern: /^[A-Za-z]{2}(\s*,\s*[A-Za-z]{2})*$/ },
    { k: 'manufacturer_name', label: 'Производитель (название / марка)', t: 'text', max: 120 },
    { k: 'manufacturer_address', label: 'Адрес производителя', t: 'text', max: 200 },
    { k: 'manufacturer_email', label: 'E-mail производителя', t: 'text', max: 120, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    { k: 'manufacturer_country', label: 'Страна производителя', t: 'text', pattern: CC, max: 2 },
    { k: 'responsible_eu', label: 'Ответственное лицо в ЕС (JSON: name, address, email)', t: 'longtext', max: 600 },
    { k: 'responsible_uk', label: 'Ответственное лицо в Великобритании (JSON)', t: 'longtext', max: 600 },
    { k: 'responsible_us', label: 'Импортёр в США (JSON)', t: 'longtext', max: 600 },
    { k: 'safety_info', label: 'Предупреждения и безопасность (на языке покупателя)', t: 'longtext', max: 3000 },
    { k: 'brand_proof', label: 'Подтверждение бренда (ссылка на документ)', t: 'text', max: 300, pattern: /^(https:\/\/[^\s"'<>]+|\/f\/[A-Za-z0-9_-]{22}\/[^\s"'<>]*)$/ },
    { k: 'brand_proof_status', label: 'Бренд подтверждён', t: 'enum', vals: ['none', 'pending', 'verified', 'rejected'], def: 'none', ro: true }
  ],
  present: (out, row) => {
    const s = db.prepare('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(reserved),0) r FROM m_stock WHERE product_id=?').get(row.id); out.stock_qty = s.q; out.stock_reserved = s.r;
    // money breakdown shown next to every product: what we pay, what we add, what the buyer pays
    out.profit = row.cost != null ? row.price - row.cost : null;
    out.markup_actual_pct = row.cost ? Math.round((row.price - row.cost) / row.cost * 1000) / 10 : null;
    out.margin_pct = row.cost != null && row.price ? Math.round((row.price - row.cost) / row.price * 1000) / 10 : null;
  },
  validate: (data, user, before, internal) => {
    const v = k => (k in data ? data[k] : before ? before[k] : null);
    const confirmed = !!data.price_confirm; delete data.price_confirm;                    // a one-shot confirmation, never stored as "on"
    const min = v('min_price'), max = v('max_price'), cost = v('cost');
    // price = purchase price + markup, when the product is set to work that way (recomputed whenever cost or markup changes)
    if (v('price_from_markup') && ['cost', 'markup_pct', 'price_from_markup'].some(k => k in data)) {
      if (cost == null || v('markup_pct') == null) throw E.bad('markup_needs_cost');
      data.price = Math.round(cost * (100 + v('markup_pct')) / 100);
    }
    // price guard: a staff / API edit can't put a product at 0 or slash its price by ≥ N % without an explicit confirmation
    if ('price' in data) { const g = require('../services/guard').checkPriceEdit(before, data.price, { internal, confirmed, digital: !!v('digital') }); if (g) throw E.bad(g, { min_allowed: before && before.price ? Math.ceil(before.price * (100 - require('../services/guard').config().edit_drop_pct) / 100) : 1 }); }
    if ('price' in data && !internal) { const g = require('../services/delegate').checkAgentPrice(user, before, data.price); if (g) throw E.bad(g, { limit_pct: require('../services/delegate').state().price_pct }); }   // AI agents: never below cost, at most N % per edit
    if (min != null && max != null && min > max) throw E.bad('min_gt_max');
    if (min != null && cost != null && min < cost) throw E.bad('min_below_cost');        // the repricer must never sell below cost
    if ('images' in data && data.images) {                                               // images: JSON array of https URLs or our own /f/<slug>/… paths
      let a; try { a = JSON.parse(data.images); } catch { throw E.bad('invalid_images'); }
      if (!Array.isArray(a) || a.length > 8 || a.some(u => typeof u !== 'string' || !/^(https:\/\/[^\s"'<>]+|\/f\/[A-Za-z0-9_-]{22}\/[^\s"'<>]*)$/.test(u))) throw E.bad('invalid_images');
    }
    if (v('auto_reprice') && (min == null || max == null)) throw E.bad('reprice_needs_bounds');
    if ('sale_regions' in data && data.sale_regions) {
      const list = trust().parseList(data.sale_regions);
      if (list.some(r => !trust().REGIONS[r])) throw E.bad('invalid_sale_regions');
      data.sale_regions = [...new Set(list)].join(',');
    }
    for (const k of ['responsible_eu', 'responsible_uk', 'responsible_us']) if (k in data && data[k]) {
      const o = trust().parseParty(data[k]);
      if (!trust().partyOk(o)) throw E.bad('invalid_' + k);
      data[k] = JSON.stringify({ name: o.name.trim().slice(0, 120), address: o.address.trim().slice(0, 200), email: o.email.trim().slice(0, 120) });
    }
    if ('category_id' in data && (!before || data.category_id !== before.category_id)) data.category_source = 'manual';   // a person's choice is never overwritten by the AI job
    if ('brand_proof' in data && data.brand_proof && (!before || data.brand_proof !== before.brand_proof)) data.brand_proof_status = 'pending';   // a new document needs a new look
    if ('brand' in data && before && data.brand !== before.brand && before.brand_proof_status === 'verified') data.brand_proof_status = 'pending';
    if ('data_sources' in data && data.data_sources) {                                   // evidence: [{fact, source_type, source_ref}]; a URL source must be https
      let a; try { a = JSON.parse(data.data_sources); } catch { throw E.bad('invalid_data_sources'); }
      if (!Array.isArray(a) || a.length > 30 || a.some(x => !x || typeof x.fact !== 'string' || !x.fact || x.fact.length > 300 || !SRC_TYPES.includes(x.source_type)
        || (x.source_ref != null && (typeof x.source_ref !== 'string' || x.source_ref.length > 300)) || (x.source_type === 'url' && !/^https:\/\/[^\s"'<>]+$/.test(x.source_ref || '')))) throw E.bad('invalid_data_sources');
    }
  },
  afterCreate: (id, _data, _user, opts) => { if (!(opts && opts.source === 'shopify')) shopifySync().enqueue(id); },
  afterUpdate: (id, data, before, user, internal, opts) => {
    // an edit made by the owner in the Shopify admin (pulled by the sync) is already the owner's decision: no re-moderation, no
    // reset of the human check, and it is not pushed back. Only the price history records it.
    if (opts && opts.source === 'shopify') {
      if ('price' in data && data.price !== before.price)
        db.prepare('INSERT INTO m_price_history(product_id,old_price,new_price,reason,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run(id, before.price, data.price, 'shopify', now(), now(), 'shopify');
      return;
    }
    shopifySync().enqueue(id);
    // a person editing content through the plain form invalidates a previous human check; AI/review actions (internal) set the flag themselves
    if (!internal && before.human_verified && ['title', 'description', 'seo_description', 'data_sources'].some(k => k in data && data[k] !== before[k]))
      db.prepare('UPDATE m_products SET human_verified=0, verified_by=NULL WHERE id=?').run(id);
    if ('price' in data && data.price !== before.price && before.status === 'approved' && (data.price * 2 < before.price || data.price > before.price * 3))
      db.prepare("UPDATE m_products SET status='pending_review' WHERE id=?").run(id);         // a drastic price move needs a moderator again
    if ('price' in data && data.price !== before.price)
      db.prepare('INSERT INTO m_price_history(product_id,old_price,new_price,reason,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run(id, before.price, data.price, 'manual', now(), now(), 'staff');
    // changing listing content on a live product sends it back to moderation
    if (before.status === 'approved' && ['title', 'description', 'category'].some(k => k in data && data[k] !== before[k]))
      db.prepare("UPDATE m_products SET status='pending_review' WHERE id=?").run(id);
  },
  actions: {
    submit: { perm: 'products.write', label: 'На модерацию', run: ({ row, update }) => {
      if (!['draft', 'rejected'].includes(row.status)) throw E.conflict('bad_state');
      const seller = db.prepare('SELECT status, listing_ban_until FROM m_sellers WHERE id=?').get(row.seller_id);
      if (!seller || seller.status !== 'active') throw E.conflict('seller_not_active');
      if (seller.listing_ban_until && seller.listing_ban_until > Date.now()) throw E.conflict('listing_ban');
      const g = trustGate(row); if (g) throw E.conflict(g);
      const { block, review } = compliance.scan(row);
      if (block.length) return update({ status: 'rejected', moderation_note: 'auto: запрещено', compliance_flags: 'ban: ' + block.join(', ').slice(0, 150) });
      return update({ status: 'pending_review', moderation_note: null, compliance_flags: review.length ? 'review: ' + review.join(', ').slice(0, 150) : null }); } },
    approve: { perm: 'products.moderate', label: 'Одобрить', run: ({ row, update }) => {
      if (row.status !== 'pending_review') throw E.conflict('bad_state');
      const { block } = compliance.scan(row); if (block.length) throw E.conflict('compliance_block');   // re-checked: rules may have changed since submit
      const g = trustGate(row); if (g) throw E.conflict(g);                                             // gated seller: no region ready / copied photos
      return update({ status: 'approved', moderation_note: null }); } },
    brand_proof_verify: { perm: 'products.moderate', label: 'Бренд: документ подтверждён', confirm: true, run: ({ row, update }) => {
      if (!row.brand_proof) throw E.conflict('no_brand_proof');
      return update({ brand_proof_status: 'verified' }); } },
    brand_proof_reject: { perm: 'products.moderate', label: 'Бренд: документ отклонён', confirm: true, fields: [{ k: 'note', t: 'text', label: 'Причина', req: true }], run: ({ row, body, update }) => {
      if (typeof body.note !== 'string' || !body.note.trim()) throw E.bad('required_note');
      const patch = { brand_proof_status: 'rejected', moderation_note: ('бренд: ' + body.note.trim()).slice(0, 200) };
      if (['approved', 'pending_review'].includes(row.status) && trustGate({ ...row, brand_proof_status: 'rejected' })) patch.status = 'rejected';
      return update(patch); } },
    readiness: { perm: 'products.read', label: 'Где можно продавать', run: ({ row }) => {
      const s = sellerRow(row.seller_id);
      return { gated: trust().enforced(s), foreign_photos: trust().foreignImages(row.images), brand_proof_needed: trust().needsBrandProof(row, s), ...trust().productRegions(row, s) }; } },
    reject: { perm: 'products.moderate', label: 'Отклонить', confirm: true, fields: [{ k: 'note', t: 'text', label: 'Причина', req: true }], run: ({ row, body, update }) => {
      if (row.status !== 'pending_review') throw E.conflict('bad_state');
      if (typeof body.note !== 'string' || !body.note.trim()) throw E.bad('required_note');
      return update({ status: 'rejected', moderation_note: body.note.trim().slice(0, 200) }); } },
    delist: { perm: 'products.moderate', label: 'Снять с продажи', confirm: true, run: ({ row, update }) => {
      if (row.status !== 'approved') throw E.conflict('bad_state'); return update({ status: 'delisted' }); } },
    // ---- AI card + Human-in-the-Loop ----
    ai_generate: { perm: 'ai.run', label: 'Сгенерировать карточку', fields: [{ k: 'note', t: 'text', label: 'Что учесть / исправить' }], run: async ({ row, body, update }) => {
      if (row.status === 'delisted') throw E.conflict('bad_state');
      const note = typeof body.note === 'string' ? body.note.slice(0, 300) : null;
      let card; try { card = await ai.generateCard(row, { brand: activeBrand(), note }); } catch (e) { update({ ai_status: 'failed', ai_flags: String(e.code || e.message).slice(0, 100) }); throw e; }
      const flags = [...card.flags]; let conf = card.confidence;
      const { block } = compliance.scan({ ...row, title: card.title, description: card.seo_description });
      if (block.length) { flags.push('compliance:' + block.join('|').slice(0, 60)); conf = Math.min(conf, 40); }
      // a live product keeps its title and stays on sale while the new card waits for a human; only the description is replaced
      return update({ ...(row.status === 'approved' ? {} : { title: card.title }), seo_description: card.seo_description, data_sources: JSON.stringify(card.data_sources), ai_confidence: conf, ai_flags: flags.join('; ').slice(0, 300) || null, ai_status: 'generated', human_verified: false, verified_by: null });
    } },
    verify: { perm: 'ai.review', label: 'Подтвердить (проверено)', run: ({ row, user, update }) => {
      if (row.ai_status !== 'generated') throw E.conflict('bad_state');
      if (row.status === 'pending_review' && can(user, 'products.moderate')) { const { block } = compliance.scan(row); if (block.length) throw E.conflict('compliance_block'); update({ status: 'approved', moderation_note: null }); }
      return update({ human_verified: true, verified_by: user.username }); } },
    // ---- AI analysis: description + price + story; competitor prices from the web ----
    ai_analyze: { perm: 'ai.run', label: 'AI-анализ товара', run: async ({ row, update }) => {
      const offers = competitors().list(row.id);
      const a = await ai.analyze(row, { offers, currency: require('../config').currency, brand: activeBrand() });
      a.at = Date.now();
      return update({ ai_analysis: JSON.stringify(a) }); } },
    ai_apply: { perm: 'ai.review', label: 'Применить AI-анализ', fields: [{ k: 'parts', t: 'text', label: 'Что применить: description,story,price' }], run: ({ row, body, update }) => {
      let a; try { a = JSON.parse(row.ai_analysis || 'null'); } catch { a = null; }
      if (!a) throw E.conflict('no_analysis');
      const parts = new Set(String(body.parts || 'description,story,price').split(',').map(x => x.trim()));
      const patch = {};
      if (parts.has('description') && a.description) Object.assign(patch, { seo_description: a.description, ai_status: 'generated', human_verified: false, verified_by: null, ai_confidence: Math.min(row.ai_confidence ?? 70, ai.completeness(row)) });
      if (parts.has('story') && a.story) patch.story = a.story;
      if (parts.has('price') && a.price && a.price.suggested > 0) { patch.price = a.price.suggested; patch.price_from_markup = false; }
      if (!Object.keys(patch).length) throw E.bad('nothing_to_update');
      if ('price' in patch && patch.price !== row.price) db.prepare('INSERT INTO m_price_history(product_id,old_price,new_price,reason,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run(row.id, row.price, patch.price, 'ai_analysis', now(), now(), 'ai');
      return update(patch); } },
    competitors: { perm: 'pricing.read', label: 'Сравнить цены с конкурентами', run: async ({ row }) => {
      const r = await ai.competitorSearch(row);
      if (r.mock) return { ...competitors().summary(row.id), mock: true };
      return { ...competitors().store(row.id, r.offers, ai.cfg.provider + ':' + ai.cfg.model), sources: r.sources };
    } },
    unverify: { perm: 'ai.review', label: 'Снять отметку «проверено»', run: ({ row, update }) => { if (!row.human_verified) throw E.conflict('bad_state'); return update({ human_verified: false, verified_by: null }); } },
    ai_edit: { perm: 'ai.review', label: 'Исправить и подтвердить', fields: [{ k: 'title', t: 'text', label: 'Название' }, { k: 'seo_description', t: 'longtext', label: 'Описание' }], run: ({ row, body, user, update }) => {
      if (row.ai_status !== 'generated') throw E.conflict('bad_state');
      const d = {}; for (const k of ['title', 'seo_description']) if (typeof body[k] === 'string' && body[k].trim()) d[k] = body[k].trim();
      if (!Object.keys(d).length) throw E.bad('nothing_to_update');
      const { block } = compliance.scan({ ...row, title: d.title || row.title, description: d.seo_description || row.seo_description }); if (block.length) throw E.conflict('compliance_block');
      return update({ ...d, human_verified: true, verified_by: user.username }); } },
    ai_reject: { perm: 'ai.review', label: 'Отклонить карточку', confirm: true, fields: [{ k: 'note', t: 'text', label: 'Причина', req: true }], run: ({ row, body, update }) => {
      if (typeof body.note !== 'string' || !body.note.trim()) throw E.bad('required_note');
      if (row.ai_status !== 'generated') throw E.conflict('bad_state');
      return update({ ai_status: 'rejected', human_verified: false, verified_by: null, moderation_note: body.note.trim().slice(0, 200) }); } }
  }
});

define({
  name: 'price_history', table: 'm_price_history', label: 'История цен', group: 'Финансы и цены', perm: 'pricing', create: false, update: false,
  filters: ['product_id'], sort: 'id DESC', list: ['product_id', 'old_price', 'new_price', 'reason', 'created_at'],
  fields: [{ k: 'product_id', t: 'ref', ref: 'products', req: true }, { k: 'old_price', t: 'money' }, { k: 'new_price', t: 'money' }, { k: 'reason', t: 'text' }]
});

define({
  name: 'stock', table: 'm_stock', label: 'Остатки', group: 'Продавцы и каталог', perm: 'stock',
  filters: ['product_id', 'warehouse_id'], list: ['product_id', 'warehouse_id', 'qty', 'reserved', 'refurb_qty', 'reorder_level'],
  sql: ['CREATE UNIQUE INDEX IF NOT EXISTS ux_m_stock_pw ON m_stock(product_id, warehouse_id)'],
  fields: [
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true },
    { k: 'warehouse_id', label: 'Склад', t: 'ref', ref: 'warehouses', req: true },
    { k: 'qty', label: 'На складе', t: 'int', min: 0, max: 1e7, def: 0 },
    { k: 'reserved', label: 'В резерве', t: 'int', def: 0, ro: true },
    { k: 'refurb_qty', label: 'Refurbished', t: 'int', def: 0, ro: true },
    { k: 'reorder_level', label: 'Порог дозаказа', t: 'int', min: 0, max: 1e6, def: 0 }
  ],
  validate: (data, _u, before) => { if (before && 'qty' in data && data.qty < before.reserved) throw E.conflict('below_reserved'); },
  afterCreate: (id, data, _u, opts) => { if (!(opts && opts.source === 'shopify')) shopifySync().enqueue(data.product_id); },
  afterUpdate: (id, data, before, _u, _i, opts) => {
    if ('qty' in data && data.qty !== before.qty) event('stock_adjust', { ref_type: 'stock', ref_id: id, amount: data.qty - before.qty, data: opts && opts.source === 'shopify' ? { source: 'shopify' } : null });
    if (!(opts && opts.source === 'shopify')) shopifySync().enqueue(before.product_id);
  },
  actions: {
    adjust: { perm: 'stock.write', label: 'Корректировка ±', fields: [{ k: 'delta', t: 'int', label: 'Изменение (±)', req: true }], run: ({ row, body, update }) => {
      if (!Number.isSafeInteger(body.delta) || Math.abs(body.delta) > 1e6 || body.delta === 0) throw E.bad('invalid_delta');
      const qty = row.qty + body.delta; if (qty < row.reserved) throw E.conflict('below_reserved');
      return update({ qty }); } }
  }
});

define({
  name: 'compliance_rules', table: 'm_compliance_rules', label: 'Комплаенс-правила', group: 'Продавцы и каталог', perm: 'compliance', remove: true, title: 'term',
  search: ['term'], filters: ['kind', 'active'], list: ['term', 'kind', 'active', 'note'],
  fields: [
    { k: 'term', label: 'Термин / категория', t: 'text', req: true, max: 80 },
    { k: 'kind', label: 'Действие', t: 'enum', vals: ['ban', 'review', 'category'], req: true, hint: 'ban = автоотказ, review = на ручную проверку, category = точная категория → ручная проверка' },
    { k: 'active', label: 'Активно', t: 'bool', def: 1 },
    { k: 'note', label: 'Заметка', t: 'text' }
  ]
});
