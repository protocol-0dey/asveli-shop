'use strict';
const cfg = require('./config');
const { db, audit } = require('./db');
const sec = require('./security');

const COOKIE = cfg.cookieSecure ? '__Host-asveli_sid' : 'asveli_sid';
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

function parseCookies(header) {
  const out = Object.create(null);                      // no prototype: a cookie named "__proto__"/"constructor" can't collide
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}
function setCookie(res, value, maxAgeSec) {
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${cfg.cookieSecure ? '; Secure' : ''}`);
}

function createSession(req, res, userId, pending) {
  const t = sec.token(32), now = Date.now(), csrf = sec.token(24);
  db.prepare('INSERT INTO sessions(id_hash,user_id,csrf,pending,created_at,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?,?)')
    .run(sec.sha256(t), userId, csrf, pending ? 1 : 0, now, now, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
  setCookie(res, t, Math.floor((pending ? cfg.pendingMs : cfg.absoluteMs) / 1000));
  return csrf;
}
function destroySession(req, res) {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.sessionId);
  setCookie(res, '', 0);
}

// Loads session + user into req (never throws). Pending (2FA not finished) sessions are loaded separately.
function loadSession(req, _res, next) {
  req.user = null; req.session = null; req.sessionId = null;
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (!t && req.headers.authorization) {                       // a program / AI agent with an admin API key (no cookie, so no CSRF exposure)
    const u = require('./iam/apikeys').resolve(req.headers.authorization, req.ip);
    if (u) { req.user = u; req.apiKey = u.apiKey; req.session = { pending: 0, csrf: null, api: true }; }
    return next();
  }
  if (!t || t.length > 100) return next();
  const id = sec.sha256(t), now = Date.now();
  const s = db.prepare('SELECT * FROM sessions WHERE id_hash=?').get(id);
  if (!s) return next();
  const ttl = s.pending ? cfg.pendingMs : cfg.absoluteMs;
  if (now - s.created_at > ttl || (!s.pending && now - s.last_seen > cfg.idleMs)) {
    db.prepare('DELETE FROM sessions WHERE id_hash=?').run(id); return next();
  }
  if (now - s.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen=? WHERE id_hash=?').run(now, id);
  req.sessionId = id; req.session = s;
  req.user = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) || null;
  if (req.user && !req.user.active) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id); req.user = null; req.session = null; }   // deactivated staff lose access immediately
  next();
}

const requireAuth = (req, res, next) =>
  req.user && req.session && !req.session.pending ? next() : res.status(401).json({ error: 'unauthorized' });

// Only loopback-style Host headers (plus ADMIN_ALLOWED_HOSTS) are served. A page on evil.com whose DNS name is
// re-pointed to 127.0.0.1 ("DNS rebinding") still sends "Host: evil.com", so it gets nothing.
const hostOf = h => String(h || '').toLowerCase().replace(/:\d+$/, '');
function hostGuard(req, res, next) {
  if (!cfg.adminHosts.has(hostOf(req.headers.host))) return res.status(421).type('text/plain').send('Misdirected request');
  next();
}

// CSRF: SameSite=Strict cookie + same-origin check (Origin must equal this server's own Host, port included) +
// Fetch-Metadata + per-session token header on every state-changing call. SameSite alone is not enough here:
// http://localhost:8080 and http://localhost:3001 are the same *site*, so another local app could otherwise ride the cookie.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.apiKey && !req.headers.cookie) return next();        // bearer keys are not sent by browsers on their own: CSRF does not apply
  let sameOrigin = false;
  try { sameOrigin = !!req.headers.origin && new URL(req.headers.origin).host === String(req.headers.host).toLowerCase(); } catch { /* malformed Origin */ }
  const fetchSite = req.headers['sec-fetch-site'];
  if (!sameOrigin || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) return res.status(403).json({ error: 'bad_origin' });
  if (req.path.startsWith('/auth/login')) return next();            // no session yet; Origin check above still applies
  const h = req.headers['x-csrf-token'];
  if (!req.session || !h || !sec.safeEq(h, req.session.csrf)) return res.status(403).json({ error: 'bad_csrf' });
  next();
}

function ipAllow(req, res, next) {
  if (!cfg.adminIpAllow.length) return next();
  const ip = String(req.ip).replace(/^::ffff:/, '');
  return cfg.adminIpAllow.includes(ip) ? next() : res.status(404).end();
}

// Atomic: the counter is incremented inside SQLite, not computed from a (possibly stale) copy of the user row,
// so a burst of parallel guesses cannot all see "failed = 0" and dodge the lockout.
function registerFailure(user, req, what) {
  const row = db.prepare('UPDATE users SET failed = failed + 1 WHERE id=? RETURNING failed').get(user.id);
  if (row && row.failed >= MAX_FAILS) {
    db.prepare('UPDATE users SET failed=0, locked_until=? WHERE id=?').run(Date.now() + LOCK_MS, user.id);
    audit(req, 'account_locked', user.username);
  }
  audit(req, what, null, user.username);
}
const lockedNow = id => (db.prepare('SELECT locked_until FROM users WHERE id=?').get(id) || {}).locked_until > Date.now();

// ---------- route handlers ----------
async function login(req, res) {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256)
    return res.status(400).json({ error: 'bad_request' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username.trim().toLowerCase());
  const ok = await sec.verifyPassword(password, user ? user.pass_hash : await sec.dummyHash());
  // Re-check the lock AFTER the slow hash: requests that were already in flight when the account got locked must not
  // be allowed to succeed (or even to reveal that their guess was right).
  if (user && lockedNow(user.id)) { audit(req, 'login_blocked_locked', username.slice(0, 64)); return res.status(429).json({ error: 'locked' }); }
  if (!user || !ok) {
    if (user) registerFailure(user, req, 'login_failed'); else audit(req, 'login_failed_unknown', username.slice(0, 64));
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!user.active) { audit(req, 'login_inactive', null, user.username); return res.status(401).json({ error: 'invalid_credentials' }); }   // same answer as a wrong password
  db.prepare('DELETE FROM sessions WHERE user_id=? AND pending=1').run(user.id);
  if (user.totp_enabled) { createSession(req, res, user.id, true); return res.json({ needs2fa: true }); }
  db.prepare('UPDATE users SET failed=0, last_login=? WHERE id=?').run(Date.now(), user.id);
  const csrf = createSession(req, res, user.id, false);
  audit(req, 'login', null, user.username);
  res.json({ ok: true, csrf });
}

async function login2fa(req, res) {
  if (!req.user || !req.session || !req.session.pending) return res.status(401).json({ error: 'unauthorized' });
  // Everything below runs synchronously on a FRESH row (no await between read and write), and the update is a
  // compare-and-set, so one TOTP code can never be redeemed twice, even by simultaneous requests.
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user || user.locked_until > Date.now()) return res.status(429).json({ error: 'locked' });
  let step = null;
  try { step = sec.totpVerify(sec.decrypt(user.totp_secret_enc), (req.body || {}).code, user.totp_last); } catch { /* corrupt secret */ }
  if (step !== null && db.prepare('UPDATE users SET totp_last=?, failed=0, last_login=? WHERE id=? AND totp_last<?').run(step, Date.now(), user.id, step).changes !== 1) step = null;
  if (step === null) { registerFailure(user, req, 'login_2fa_failed'); return res.status(401).json({ error: 'invalid_code' }); }
  db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.sessionId);       // new id after privilege change
  const csrf = createSession(req, res, user.id, false);
  audit(req, 'login', '2fa', user.username);
  res.json({ ok: true, csrf });
}

function logout(req, res) { audit(req, 'logout', null); destroySession(req, res); res.json({ ok: true }); }
function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE created_at<? OR (pending=0 AND last_seen<?)').run(now - cfg.absoluteMs, now - cfg.idleMs);
}

module.exports = { loadSession, requireAuth, hostGuard, csrfGuard, ipAllow, login, login2fa, logout, cleanup, createSession };
