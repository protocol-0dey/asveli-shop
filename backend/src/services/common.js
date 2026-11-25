'use strict';
const { db } = require('../db');
const { E } = require('../engine/errors');

const now = () => Date.now();
const day = 864e5;
const bps = (amount, rateBps) => Math.round(amount * rateBps / 10000);     // integer math only; rounds half up for positives

function event(kind, { ref_type = null, ref_id = null, seller_id = null, customer_id = null, amount = null, data = null } = {}) {
  db.prepare('INSERT INTO m_events(ts,kind,ref_type,ref_id,seller_id,customer_id,amount,data) VALUES(?,?,?,?,?,?,?,?)')
    .run(now(), kind, ref_type, ref_id, seller_id, customer_id, amount, data ? JSON.stringify(data).slice(0, 2000) : null);
}
// Double-entry-ish ledger: one signed row per money movement; balances are always SUM() of rows, never a mutable counter.
function ledger(kind, { seller_id = null, order_id = null, amount, note = null, by = 'system' }) {
  if (!Number.isSafeInteger(amount)) throw new Error('ledger amount must be integer');
  db.prepare('INSERT INTO m_ledger(kind,seller_id,order_id,amount,note,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
    .run(kind, seller_id, order_id, amount, note, now(), now(), by);
}
const SELLER_KINDS = "('sale','refund','payout','advance','advance_repay','adjustment')";
const sellerBalance = id => db.prepare(`SELECT COALESCE(SUM(amount),0) b FROM m_ledger WHERE seller_id=? AND kind IN ${SELLER_KINDS}`).get(id).b;
const pendingPayouts = id => db.prepare("SELECT COALESCE(SUM(amount),0) s FROM m_payouts WHERE seller_id=? AND status IN ('pending','approved')").get(id).s;

// Four-eyes: the person who prepared a money movement may not be the one who releases it. If nobody else could ever approve
// (a one-person company), the owner may approve their own item, but it is flagged and audited — never silent.
function fourEyes(row, user, permission, ROLES) {
  if (row.created_by !== user.username) return { solo: false };
  const others = db.prepare('SELECT role FROM users WHERE active=1 AND username<>?').all(user.username)
    .filter(u => ROLES[u.role] && ROLES[u.role].perms.some(p => p === '*' || p === permission || (p.endsWith('.*') && permission.startsWith(p.slice(0, -1)))));
  if (others.length) throw E.forbidden('four_eyes_required');
  return { solo: true };
}
const settingNum = (k, d) => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get('m.' + k); return r && Number.isFinite(Number(r.v)) ? Number(r.v) : d; };
module.exports = { now, day, bps, event, ledger, sellerBalance, pendingPayouts, fourEyes, settingNum };
