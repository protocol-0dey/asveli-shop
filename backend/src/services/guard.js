'use strict';
/* Guard: watches for things that must never happen in a live shop and, when one does, closes the shop for "технические работы"
   before buyers can exploit it. Rules (all switchable in the admin → Безопасность → Защита магазина):
     price_zero      a product on sale costs 0 (or less)                                → incident
     price_crash     ≥ N products lost ≥ X % of their price within 10 minutes           → incident
     order_zero      an order with a total of 0 was placed (non-digital, no 100 % coupon) → incident
     error_spike     the public API answered ≥ N server errors (5xx) within a minute    → incident
     login_attack    ≥ N failed admin logins within 10 minutes                           → alert only
   An incident = a critical alert + (if auto_maintenance is on) maintenance mode: the shop API answers 503 «технические работы»,
   pushing to Shopify stops, the owner sees a red banner. Only a person lifts maintenance (button in the admin) — never a timer.
   At write time the price guard also refuses a staff/API edit that sets a price to 0 or cuts it by ≥ X % (unless confirmed). */
const { db, getSetting, setSetting } = require('../db');

const CFG_KEY = 'guard.config', ST_KEY = 'guard.state';
const DEFAULTS = { auto_maintenance: true, price_zero: true, price_crash: true, crash_pct: 50, crash_count: 3, order_zero: true, error_spike: true, error_count: 30, login_attack: true, login_count: 20, edit_drop_pct: 50 };
const config = () => { try { return { ...DEFAULTS, ...JSON.parse(getSetting(CFG_KEY) || '{}') }; } catch { return { ...DEFAULTS }; } };
const state = () => { try { return { maintenance: false, ...JSON.parse(getSetting(ST_KEY) || '{}') }; } catch { return { maintenance: false }; } };
let cache = null, cacheAt = 0;
// hot path (every public request): read from memory, refreshed every 2 s
function maintenance() { if (!cache || Date.now() - cacheAt > 2000) { cache = state(); cacheAt = Date.now(); } return cache.maintenance ? cache : null; }

function saveConfig(b) {
  const c = config(), out = { ...c };
  for (const k of Object.keys(DEFAULTS)) {
    if (b[k] === undefined) continue;
    if (typeof DEFAULTS[k] === 'boolean') out[k] = !!b[k];
    else { const n = Number(b[k]); const [lo, hi] = { crash_pct: [10, 95], crash_count: [1, 1000], error_count: [5, 10000], login_count: [5, 10000], edit_drop_pct: [10, 99] }[k]; if (!Number.isInteger(n) || n < lo || n > hi) throw Object.assign(new Error('invalid_' + k), { code: 'invalid_' + k }); out[k] = n; }
  }
  setSetting(CFG_KEY, JSON.stringify(out)); return out;
}
function alert(kind, severity, title, detail, dedupe) {
  const now = Date.now();
  return db.prepare("INSERT OR IGNORE INTO m_alerts(kind,severity,title,detail,status,dedupe,created_at,updated_at,created_by) VALUES(?,?,?,?,'open',?,?,?,'guard')")
    .run(kind, severity, String(title).slice(0, 150), String(detail || '').slice(0, 250), dedupe, now, now).changes;
}
function setMaintenance(on, { reason = null, by = 'auto', rule = null } = {}) {
  const s = state();
  if (on && s.maintenance) return s;                               // already closed: keep the FIRST reason
  const next = on ? { maintenance: true, reason: String(reason || 'технические работы').slice(0, 200), rule, by, since: Date.now() } : { maintenance: false, lifted_by: by, lifted_at: Date.now(), last: s.maintenance ? { reason: s.reason, rule: s.rule, since: s.since } : s.last };
  setSetting(ST_KEY, JSON.stringify(next)); cache = next; cacheAt = Date.now();
  shopifyFlag(on).then(r => note({ shopify_flag: r })).catch(e => note({ shopify_flag: 'error: ' + String(e.message || e).slice(0, 120) }));
  return next;
}
// best effort: a shop metafield the Shopify theme reads to show its own maintenance page (asveli.maintenance = true/false)
function note(extra) { const s = state(); setSetting(ST_KEY, JSON.stringify({ ...s, ...extra })); cache = null; }
async function shopifyFlag(on) {
  const st = require('./shopify-settings'); if (!st.current().enabled) return 'not_connected';
  const client = require('./shopify-client');
  const shop = await client.gql('{ shop { id } }');
  const r = await client.gql('mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }', { m: [{ ownerId: shop.shop.id, namespace: 'asveli', key: 'maintenance', type: 'boolean', value: on ? 'true' : 'false' }] });
  const ue = r && r.metafieldsSet && r.metafieldsSet.userErrors; if (ue && ue.length) throw new Error(ue[0].message);
  return 'ok';
}
function incident(rule, title, detail, dedupe) {
  const c = config();
  const created = alert('guard', 'critical', title, detail, 'guard:' + dedupe);
  if (created && c.auto_maintenance) setMaintenance(true, { reason: title, rule, by: 'auto' });
  return created;
}

/* ---------- write-time price guard (products.validate) ---------- */
// returns an error code or null; `confirmed` = the person ticked «да, я уверен» for a big cut
function checkPriceEdit(before, price, { internal, confirmed, digital }) {
  if (internal) return null;
  if (!(price > 0) && !digital) return 'price_guard';
  const c = config();
  if (before && before.price > 0 && price < before.price * (100 - c.edit_drop_pct) / 100 && !confirmed) return 'price_guard';
  return null;
}

/* ---------- live counters ---------- */
const errs = [];                                                   // timestamps of public 5xx answers (last minute)
function countError() { const now = Date.now(); errs.push(now); while (errs.length && errs[0] < now - 60e3) errs.shift(); const c = config(); if (c.error_spike && errs.length >= c.error_count) incident('error_spike', `Всплеск ошибок сервера: ${errs.length} за минуту`, 'публичный API отвечает 5xx', 'errors:' + Math.floor(now / 600e3)); }

/* ---------- periodic scan ---------- */
function scan() {
  const c = config(), now = Date.now(); let n = 0;
  if (c.price_zero) {
    const z = db.prepare("SELECT id, title, price FROM m_products WHERE status='approved' AND price<=0 AND COALESCE(digital,0)=0").all();
    if (z.length) n += incident('price_zero', `Цена 0 у ${z.length} товар(ов) в продаже`, z.slice(0, 5).map(p => `#${p.id} ${p.title}`).join(', '), 'zero:' + z.map(p => p.id).slice(0, 20).join(','));
  }
  if (c.price_crash) {
    const crash = db.prepare('SELECT DISTINCT product_id FROM m_price_history WHERE created_at>? AND old_price>0 AND new_price*100 <= old_price*(100-?)').all(now - 10 * 60e3, c.crash_pct);
    if (crash.length >= c.crash_count) n += incident('price_crash', `Цены упали на ≥${c.crash_pct}% у ${crash.length} товаров за 10 минут`, 'товары: ' + crash.slice(0, 10).map(x => '#' + x.product_id).join(', '), 'crash:' + Math.floor(now / 600e3));
  }
  if (c.order_zero) {
    try {
      const o = db.prepare("SELECT id FROM m_orders WHERE created_at>? AND total<=0 AND status<>'cancelled'").all(now - 60 * 60e3);
      if (o.length) n += incident('order_zero', `Заказ на сумму 0: ${o.map(x => '#' + x.id).join(', ')}`, 'проверьте цены и купоны', 'order0:' + o.map(x => x.id).join(','));
    } catch { /* orders table shape differs: rule skipped */ }
  }
  if (c.login_attack) {
    const f = db.prepare("SELECT COUNT(*) n FROM audit WHERE ts>? AND action IN ('login_failed','login_failed_unknown','login_blocked_locked')").get(now - 10 * 60e3).n;
    if (f >= c.login_count) n += alert('guard', 'high', `Подбор пароля в админку: ${f} неудачных входов за 10 минут`, 'проверьте журнал действий', 'guard:login:' + Math.floor(now / 600e3));
  }
  return n;
}
let timer = null;
function start() { if (timer) return; timer = setInterval(() => { try { scan(); } catch (e) { console.error('guard scan:', e.message); } }, 60e3); timer.unref(); setTimeout(() => { try { scan(); } catch { /* next tick */ } }, 5000).unref(); }
function status() {
  const s = state();
  return { ...s, config: config(), incidents: db.prepare("SELECT id, title, detail, created_at, status FROM m_alerts WHERE kind='guard' ORDER BY id DESC LIMIT 20").all() };
}
module.exports = { maintenance, setMaintenance, saveConfig, config, status, scan, start, incident, checkPriceEdit, countError, DEFAULTS };
