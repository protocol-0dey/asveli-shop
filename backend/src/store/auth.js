'use strict';
// Buyer + seller authentication for the PUBLIC listener. Opaque 256-bit bearer tokens (SHA-256 stored), scrypt passwords,
// account lockout, constant-ish timing for unknown e-mails. Separate from staff sessions: a buyer/seller token can never reach the admin listener.
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const sec = require('../security');
const { E } = require('../engine/errors');

const TTL = 30 * 24 * 3600e3;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const wrap = fn => (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: Number(process.env.STORE_AUTH_RATE_LIMIT) || 30, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });

function checkEmail(v) { if (typeof v !== 'string' || !EMAIL.test(v.trim())) throw E.bad('invalid_email'); return v.trim().toLowerCase(); }
function checkPassword(v) { if (typeof v !== 'string' || v.length < 10 || v.length > 200) throw E.bad('weak_password'); return v; }   // ≥10 chars; scrypt makes length the main defence

function issue(kind, subjectId) {
  const t = sec.token(32), now = Date.now();
  db.prepare('INSERT INTO s_tokens(hash,kind,subject_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(sec.sha256(t), kind, subjectId, now, now + TTL);
  return t;
}
const revoke = (kind, subjectId) => db.prepare('DELETE FROM s_tokens WHERE kind=? AND subject_id=?').run(kind, subjectId);
function bearer(req) { const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || ''); return m ? m[1] : null; }
function lookup(kind, req) {
  const t = bearer(req); if (!t) return null;
  const r = db.prepare('SELECT subject_id, expires_at FROM s_tokens WHERE hash=? AND kind=?').get(sec.sha256(t), kind);
  return r && r.expires_at > Date.now() ? r.subject_id : null;
}

// returns the login row or null (and burns the same CPU for unknown e-mails)
async function checkLogin(table, emailBi, password) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE email_bi=?`).get(emailBi);
  if (!row) { await sec.verifyPassword(password, await sec.dummyHash()); return null; }
  if (row.locked_until > Date.now()) throw new (require('../engine/errors').HttpError)(429, 'account_locked');
  const ok = await sec.verifyPassword(password, row.pass_hash);
  if (!ok) {
    // atomic counter: parallel guesses cannot dodge the lock
    db.prepare(`UPDATE ${table} SET failed = failed + 1, locked_until = CASE WHEN failed + 1 >= 5 THEN ? ELSE locked_until END WHERE id=?`).run(Date.now() + 15 * 60e3, row.id);
    return null;
  }
  db.prepare(`UPDATE ${table} SET failed=0, locked_until=0 WHERE id=?`).run(row.id);
  return row;
}

const buyer = (req, _res, next) => { const id = lookup('buyer', req); if (!id) return next(new (require('../engine/errors').HttpError)(401, 'auth_required')); req.accountId = id; next(); };
const buyerOptional = (req, _res, next) => { req.accountId = lookup('buyer', req); next(); };
const seller = (req, _res, next) => { const id = lookup('seller', req); if (!id) return next(new (require('../engine/errors').HttpError)(401, 'auth_required')); req.sellerAccountId = id; next(); };
const cleanup = () => db.prepare('DELETE FROM s_tokens WHERE expires_at < ?').run(Date.now());

module.exports = { wrap, authLimiter, checkEmail, checkPassword, issue, revoke, lookup, checkLogin, buyer, buyerOptional, seller, cleanup, bearer };
