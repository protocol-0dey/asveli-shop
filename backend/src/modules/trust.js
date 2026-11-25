'use strict';
/* MODULE — «Доверие и безопасность»: sanctions log, buyer/brand/authority reports, and the marketplace-wide trust settings
   (which regions are open, whether the house catalogue is gated too). Rules themselves live in services/trust.js. */
const { define } = require('../engine/registry');
const { audit } = require('../db');
const { E } = require('../engine/errors');
const trust = require('../services/trust');

define({
  name: 'seller_strikes', table: 'm_seller_strikes', label: 'Нарушения продавцов', group: 'Продавцы и каталог', perm: 'sellers', title: 'reason',
  create: false, update: false, filters: ['seller_id', 'level', 'region'], list: ['seller_id', 'level', 'reason', 'region', 'product_id'],
  fields: [
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers', req: true },
    { k: 'level', label: 'Уровень (1–4)', t: 'int', min: 1, max: 4, req: true },
    { k: 'reason', label: 'Причина', t: 'text', req: true, max: 200 },
    { k: 'region', label: 'Регион', t: 'text', max: 4 },
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products' }
  ]
});

// what a buyer, a brand owner or an authority reports about a listing (DSA notice & action; INFORM asks for a report channel on listings)
define({
  name: 'reports', table: 'm_reports', label: 'Жалобы на товары', group: 'Продавцы и каталог', perm: 'products', title: 'reason',
  create: false, filters: ['status', 'reason', 'reporter_kind'], list: ['product_id', 'reason', 'reporter_kind', 'status'],
  fields: [
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true, immutable: true },
    { k: 'reason', label: 'Причина', t: 'enum', vals: ['counterfeit', 'unsafe', 'illegal', 'misleading', 'ip', 'other'], req: true, immutable: true },
    { k: 'reporter_kind', label: 'Кто сообщил', t: 'enum', vals: ['buyer', 'brand_owner', 'authority', 'other'], def: 'buyer', immutable: true },
    { k: 'details', label: 'Описание', t: 'longtext', max: 2000, immutable: true },
    { k: 'reporter_email', label: 'E-mail для ответа', t: 'pii', pii: 'email' },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['open', 'reviewing', 'actioned', 'dismissed'], def: 'open' },
    { k: 'resolution', label: 'Решение (что сделано)', t: 'text', max: 300 }
  ]
});

module.exports.routes = (r, h) => {
  r.get('/trust/config', h.need('sellers.read'), (_req, res) => res.json({ ...trust.config(), regions: Object.fromEntries(Object.entries(trust.REGIONS).map(([k, v]) => [k, { label: v.label, rule: v.rule }])) }));
  r.put('/trust/config', h.need('sellers.kyc'), (req, res) => {
    let c; try { c = trust.saveConfig(req.body || {}); } catch (e) { throw E.bad(e.code || 'invalid_config'); }
    audit(req, 'trust.config', JSON.stringify(c).slice(0, 250), req.user.username);
    res.json(c);
  });
  r.post('/trust/recert-scan', h.need('sellers.kyc'), (_req, res) => res.json(trust.recertScan()));
};
