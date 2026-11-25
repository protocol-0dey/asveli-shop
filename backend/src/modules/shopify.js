'use strict';
/* MODULE — Shopify: real two-way product sync with the Shopify store (replaces the simulated "shopify" channel).
   Settings (store, token / client secret, location, currency rate) are owner-only (`secrets.shopify`); running the sync needs
   `shopify.write`, deleting a product in Shopify needs `shopify.delete`. The engine is services/shopify-sync.js. */
const { audit, db } = require('../db');
const cfg = require('../config');
const { E } = require('../engine/errors');
const settings = require('../services/shopify-settings');
const sync = require('../services/shopify-sync');

const intParam = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

module.exports.routes = (r, h) => {
  /* ---------- connection (owner only: the secrets live here) ---------- */
  r.get('/shopify/settings', h.need('secrets.shopify'), (req, res) => res.json({ ...settings.view(), platform_currency: cfg.currency }));
  r.put('/shopify/settings', h.need('secrets.shopify'), h.wrap(async (req, res) => {
    const b = req.body || {}, keys = ['domain', 'apiVersion', 'authMode', 'token', 'clientId', 'clientSecret', 'locationId', 'warehouseId', 'importSellerId', 'rate', 'autoPush', 'pollMinutes', 'translations'];
    const patch = {}; for (const k of keys) if (b[k] !== undefined) patch[k] = b[k];
    if (!Object.keys(patch).length) throw E.bad('nothing_to_update');
    if (patch.warehouseId && !db.prepare('SELECT 1 FROM m_warehouses WHERE id=?').get(Number(patch.warehouseId))) throw E.bad('invalid_warehouse');
    if (patch.importSellerId && !db.prepare('SELECT 1 FROM m_sellers WHERE id=?').get(Number(patch.importSellerId))) throw E.bad('invalid_seller');
    const before = settings.current().domain;
    const view = settings.save(patch); sync.resetCache();
    // moved to ANOTHER Shopify store: the old product links point at products that don't exist there. Forget them (never treat them as
    // "deleted in Shopify", which would delist local products); the next sync creates every product in the new store.
    if (before && settings.current().domain !== before) {
      const n = db.prepare('DELETE FROM m_shopify_links').run().changes;
      audit(req, 'shopify.store_changed', `${before} → ${settings.current().domain}; links reset: ${n}`, req.user.username);
      view.links_reset = n;
    }
    audit(req, 'shopify.settings', Object.keys(patch).map(k => (['token', 'clientSecret'].includes(k) ? `${k}=(changed)` : `${k}=${String(patch[k]).slice(0, 60)}`)).join(', '), req.user.username);   // secrets never reach the log
    res.json({ ...view, platform_currency: cfg.currency });
  }));
  r.delete('/shopify/settings/secrets', h.need('secrets.shopify'), (req, res) => { const v = settings.clearSecrets(); sync.resetCache(); audit(req, 'shopify.settings', 'secrets=(removed)', req.user.username); res.json({ ...v, platform_currency: cfg.currency }); });
  r.post('/shopify/test', h.need('secrets.shopify'), h.wrap(async (req, res) => {
    sync.resetCache();
    const t0 = Date.now(), s = await sync.shop(true), c = settings.current();
    res.json({ ok: true, ms: Date.now() - t0, shop: s, platform_currency: cfg.currency, currency_match: s.currency === cfg.currency,
      rate_needed: s.currency !== cfg.currency && !c.rate, location_ok: !!c.locationId && s.locations.some(l => l.id === c.locationId) });
  }));

  /* ---------- status & runs ---------- */
  r.get('/shopify/overview', h.need('shopify.read'), (req, res) => { const c = settings.current(); res.json({ ...sync.overview(), enabled: c.enabled, domain: c.domain, autoPush: c.autoPush, pollMinutes: c.pollMinutes }); });
  r.get('/shopify/links', h.need('shopify.read'), (req, res) => {
    const st = req.query.state; if (st && !['ok', 'error', 'conflict', 'not_linked'].includes(st)) throw E.bad('invalid_state');
    res.json(sync.links({ state: st || null, q: req.query.q ? String(req.query.q) : null, page: intParam(req.query.page, 1, 1, 1e5), limit: intParam(req.query.limit, 50, 1, 200) }));
  });
  r.post('/shopify/sync', h.need('shopify.write'), h.wrap(async (req, res) => {
    const mode = (req.body || {}).mode || 'incremental';
    if (!['incremental', 'full', 'push', 'pull'].includes(mode)) throw E.bad('invalid_mode');
    if (sync.isBusy() && sync.isBusy() !== 'auto') throw E.conflict('shopify_sync_running');
    const out = await sync.run({ full: mode === 'full', pushOnly: mode === 'push', pullOnly: mode === 'pull', by: req.user.username });
    audit(req, 'shopify.sync', `${mode}: +${out.created} создано, ${out.imported} импорт, ${out.pushed}↑ ${out.pulled}↓, конфликтов ${out.conflicts}, ошибок ${out.errors}`, req.user.username);
    res.json(out);
  }));

  /* ---------- one product ---------- */
  r.get('/shopify/product/:id', h.need('shopify.read'), (req, res) => res.json({ ...sync.productState(h.id(req.params.id)), domain: settings.current().domain }));
  r.post('/shopify/product/:id/sync', h.need('shopify.write'), h.wrap(async (req, res) => {
    const id = h.id(req.params.id), prefer = (req.body || {}).prefer;
    if (prefer !== undefined && !['local', 'shop'].includes(prefer)) throw E.bad('invalid_prefer');
    if (!db.prepare('SELECT 1 FROM m_products WHERE id=?').get(id)) throw E.notFound();
    const out = await sync.one(id, { prefer, by: req.user.username });
    audit(req, 'shopify.product', `#${id} ${out.action}${prefer ? ' prefer=' + prefer : ''}`, req.user.username);
    res.json({ ...out, state: sync.productState(id) });
  }));
  r.post('/shopify/product/:id/unlink', h.need('shopify.write'), (req, res) => { const id = h.id(req.params.id); const out = sync.unlink(id); audit(req, 'shopify.unlink', `#${id}`, req.user.username); res.json(out); });
  r.post('/shopify/product/:id/delete', h.need('shopify.delete'), h.wrap(async (req, res) => {
    const id = h.id(req.params.id);
    if ((req.body || {}).confirm !== 'DELETE') throw E.bad('confirm_required');          // deleting in Shopify cannot be undone
    const out = await sync.removeFromShop(id, req.user.username);
    audit(req, 'shopify.delete', `#${id} ${out.deleted}`, req.user.username);
    res.json(out);
  }));
};
