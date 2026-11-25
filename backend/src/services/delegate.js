'use strict';
/* "Owner away" mode: the owner hands the running of the store to the AI manager (Argon) for a set time.
   - Argon's key has the role sales_manager (sales & marketing department: catalogue, cards, prices, stock, promotions, SEO, analytics).
   - While the mode is on, that key acts as store_manager: it may also approve products, moderate reviews, handle orders,
     shipments, returns and customer tickets.
   - Never, in any mode: money out (payouts, refunds approval, ledger), staff, keys, secrets, security, KYC decisions,
     personal-data reveal (KEY_DENY in iam/permissions and the store_manager role leave them out).
   - Limits for every AI agent (any API key), in every mode: a price never below cost, a price change of at most
     `price_pct` % per edit, coupons of at most `discount_pct` %. They are checked in the resource validators, so no tool can skip them.
   - The mode switches itself off at `until`. Only a person with the owner's rights can switch it on or off: keys never can. */
const { db, getSetting, setSetting } = require('../db');

const DEFAULTS = { on: false, until: null, since: null, by: null, price_pct: 15, discount_pct: 30, note: '' };
const KEY = 'delegate.state';

function state() {
  let s; try { s = { ...DEFAULTS, ...JSON.parse(getSetting(KEY) || '{}') }; } catch { s = { ...DEFAULTS }; }
  if (s.on && s.until && s.until < Date.now()) {                     // expired: switch off once, remember that it ran out by itself
    s = { ...s, on: false, ended_at: s.until, ended_by: 'expired' };
    setSetting(KEY, JSON.stringify(s));
  }
  return s;
}
const active = () => state().on;

const int = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
function set(body, by) {
  const cur = state(), b = body || {};
  const next = { ...cur,
    price_pct: int(b.price_pct ?? cur.price_pct, 1, 50, 15),
    discount_pct: int(b.discount_pct ?? cur.discount_pct, 0, 70, 30),
    note: typeof b.note === 'string' ? b.note.slice(0, 500) : cur.note };
  if (b.on === true) {
    const hours = int(b.hours, 1, 24 * 30, 72);                       // default 3 days, at most 30 days
    Object.assign(next, { on: true, since: Date.now(), until: Date.now() + hours * 3600e3, by, ended_at: null, ended_by: null });
  } else if (b.on === false && cur.on) Object.assign(next, { on: false, ended_at: Date.now(), ended_by: by });
  setSetting(KEY, JSON.stringify(next));
  return next;
}

// what the AI agents did since the mode was switched on (or since `since`): from the audit log, grouped
function report(since) {
  const s = state(), from = Number(since) || s.since || Date.now() - 864e5;
  const rows = db.prepare("SELECT ts AS at, user AS actor, action, detail FROM audit WHERE user LIKE 'api:%' AND ts>=? ORDER BY ts DESC LIMIT 1000").all(from);
  const by = {}; for (const r of rows) by[r.action] = (by[r.action] || 0) + 1;
  return { since: from, until: s.on ? s.until : (s.ended_at || null), on: s.on, total: rows.length,
    by_action: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([action, n]) => ({ action, n })), recent: rows.slice(0, 200) };
}

/* ---------- limits for AI agents ---------- */
// returns an error code or null
function checkAgentPrice(user, before, price) {
  if (!user || !user.apiKey || !before) return null;
  const s = state();
  if (before.cost != null && price < before.cost) return 'agent_below_cost';
  if (before.price > 0 && Math.abs(price - before.price) * 100 > before.price * s.price_pct) return 'agent_price_step';
  return null;
}
function checkAgentCoupon(user, kind, value) {
  if (!user || !user.apiKey) return null;
  if (kind === 'percent' && value > state().discount_pct * 100) return 'agent_discount_limit';     // value is in basis points
  return null;
}

module.exports = { state, active, set, report, checkAgentPrice, checkAgentCoupon, DEFAULTS };
