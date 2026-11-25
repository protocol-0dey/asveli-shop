'use strict';
/* Buyer sign-in with Google, GitHub and Amazon (OAuth 2.0 authorization code + PKCE, server-side).

   Browser → GET /api/store/oauth/:p/start  → provider's consent page → GET /api/store/oauth/:p/callback (this server)
   → the server exchanges the code with the provider (client secret never leaves the server), reads the verified e-mail,
   finds/links/creates the buyer account → redirects to the shop:  <STORE_URL>/login/callback#code=<one-time code>
   → the shop POSTs the code to /api/store/oauth/exchange and receives the normal buyer token.
   The long-lived token never travels in a URL; the one-time code lives 2 minutes, is single-use and is kept only as a hash.

   Account rules (takeover-safe): an identity (provider + provider user id) belongs to one account. A new identity is attached to an
   existing account by e-mail ONLY when the provider says the e-mail is verified. Linking a provider to a signed-in account uses a
   short single-use ticket issued to that account. */
const crypto = require('crypto');
const cfg = require('../config');
const { db, audit } = require('../db');
const R = require('../engine/resource');
const { E, HttpError } = require('../engine/errors');
const sec = require('../security');
const settings = require('../services/oauth-settings');

db.exec(`
CREATE TABLE IF NOT EXISTS s_identities(
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES s_accounts(id) ON DELETE CASCADE, provider TEXT NOT NULL, subject TEXT NOT NULL,
  email_bi TEXT, created_at INTEGER NOT NULL, last_login INTEGER, UNIQUE(provider, subject), UNIQUE(account_id, provider));
CREATE TABLE IF NOT EXISTS s_oauth_states(
  hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, next TEXT, lang TEXT, country TEXT, link_account INTEGER, anon TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS s_oauth_codes(
  hash TEXT PRIMARY KEY, account_id INTEGER, kind TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
if (!hasCol('s_accounts', 'password_set')) db.exec('ALTER TABLE s_accounts ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1');   // 0 = created with Google/GitHub/Amazon, no password yet

const TEST = process.env.NODE_ENV === 'test' ? (process.env.OAUTH_TEST_BASE || '').replace(/\/+$/, '') : '';   // fake providers in tests only
const EP = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email profile' },
  github: { auth: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user user:email' },
  amazon: { auth: 'https://www.amazon.com/ap/oa', token: 'https://api.amazon.com/auth/o2/token', scope: 'profile' }
};
const url = (p, kind) => (TEST ? `${TEST}/${p}/${kind}` : EP[p][kind]);
const API = {
  google: TEST ? `${TEST}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo',
  github: TEST ? `${TEST}/github/api` : 'https://api.github.com',
  amazon: TEST ? `${TEST}/amazon/profile` : 'https://api.amazon.com/user/profile'
};
const b64u = buf => buf.toString('base64url');
const LANGS = ['en', 'pl', 'de', 'ru'];
const safeNext = n => (typeof n === 'string' && /^\/(?!\/)[A-Za-z0-9\-._~%/?=&]{0,200}$/.test(n) ? n : '/');
const cleanup = () => { const t = Date.now(); db.prepare('DELETE FROM s_oauth_states WHERE expires_at<?').run(t); db.prepare('DELETE FROM s_oauth_codes WHERE expires_at<?').run(t); };

async function http(method, u, { form, headers = {} } = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(u, { method, signal: ctl.signal, redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'asveli-shop', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : undefined });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new HttpError(502, 'oauth_provider_error', { detail: (j && (j.error_description || j.error || j.message)) || String(res.status) });
    return j;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'oauth_provider_unreachable'); }
  finally { clearTimeout(t); }
}

// provider → { subject, email, verified, name }
async function profileOf(p, conf, code, verifier) {
  const tok = await http('POST', url(p, 'token'), { form: { grant_type: 'authorization_code', code, redirect_uri: conf.redirectUri, client_id: conf.clientId, client_secret: conf.clientSecret, code_verifier: verifier } });
  if (tok.error || !tok.access_token) throw new HttpError(502, 'oauth_provider_error', { detail: tok.error_description || tok.error || 'no access_token' });
  const auth = { Authorization: 'Bearer ' + tok.access_token };
  if (p === 'google') {
    const u = await http('GET', API.google, { headers: auth });
    return { subject: String(u.sub), email: u.email || null, verified: u.email_verified === true || u.email_verified === 'true', name: u.name || null };
  }
  if (p === 'github') {
    const u = await http('GET', API.github + '/user', { headers: auth });
    const emails = await http('GET', API.github + '/user/emails', { headers: auth });
    const best = Array.isArray(emails) ? (emails.find(e => e.primary && e.verified) || emails.find(e => e.verified)) : null;
    return { subject: String(u.id), email: best ? best.email : null, verified: !!best, name: u.name || u.login || null };
  }
  const u = await http('GET', API.amazon, { headers: auth });                     // Login with Amazon: e-mails are verified by Amazon
  return { subject: String(u.user_id), email: u.email || null, verified: !!u.email, name: u.name || null };
}

// find / link / create the buyer account for a provider identity
function resolve(p, prof, st, req) {
  if (!prof.subject || prof.subject.length > 200) throw new HttpError(502, 'oauth_provider_error', { detail: 'no user id' });
  const now = Date.now(), bi = prof.email ? sec.blindIndex(prof.email) : null;
  const ident = db.prepare('SELECT * FROM s_identities WHERE provider=? AND subject=?').get(p, prof.subject);
  if (st.link_account) {                                                         // a signed-in buyer adds this provider
    if (ident && ident.account_id !== st.link_account) throw E.conflict('identity_in_use');
    if (!ident) {
      if (db.prepare('SELECT 1 FROM s_identities WHERE account_id=? AND provider=?').get(st.link_account, p)) throw E.conflict('provider_already_linked');
      db.prepare('INSERT INTO s_identities(account_id,provider,subject,email_bi,created_at,last_login) VALUES(?,?,?,?,?,?)').run(st.link_account, p, prof.subject, bi, now, now);
    }
    audit(req, 'store.oauth_link', `${p} → account #${st.link_account}`, 'buyer');
    return { accountId: st.link_account, created: false, linked: true };
  }
  if (ident) { db.prepare('UPDATE s_identities SET last_login=? WHERE id=?').run(now, ident.id); return { accountId: ident.account_id, created: false }; }
  if (!prof.email || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(prof.email)) throw E.bad('oauth_email_required');
  const existing = db.prepare('SELECT * FROM s_accounts WHERE email_bi=?').get(bi);
  if (existing) {
    if (!prof.verified) throw E.conflict('oauth_email_unverified');               // never attach an unverified e-mail to someone's account
    if (db.prepare('SELECT 1 FROM s_identities WHERE account_id=? AND provider=?').get(existing.id, p)) throw E.conflict('provider_already_linked');
    db.prepare('INSERT INTO s_identities(account_id,provider,subject,email_bi,created_at,last_login) VALUES(?,?,?,?,?,?)').run(existing.id, p, prof.subject, bi, now, now);
    audit(req, 'store.oauth_link', `${p} → account #${existing.id} (verified e-mail)`, 'buyer');
    return { accountId: existing.id, created: false, linked: true };
  }
  const name = String(prof.name || prof.email.split('@')[0]).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) || 'Customer';
  const country = /^[A-Z]{2}$/.test(st.country || '') ? st.country : 'PL';
  const id = db.transaction(() => {
    const c = R.create('customers', null, { name, email: prof.email.trim().toLowerCase(), country }, req, { internal: true });
    const unusable = 'oauth$' + sec.token(32);                                   // no password yet: nothing can ever match this value
    const aid = Number(db.prepare('INSERT INTO s_accounts(customer_id,email_bi,pass_hash,lang,created_at,password_set) VALUES(?,?,?,?,?,0)').run(c.id, bi, unusable, LANGS.includes(st.lang) ? st.lang : 'en', now).lastInsertRowid);
    db.prepare('INSERT INTO s_identities(account_id,provider,subject,email_bi,created_at,last_login) VALUES(?,?,?,?,?,?)').run(aid, p, prof.subject, bi, now, now);
    return aid;
  })();
  audit(req, 'store.oauth_register', `${p} account #${id}`, 'buyer');
  return { accountId: id, created: true };
}

module.exports = function routes(router, { A, co, wrap, mergeAnonId }) {
  const shop = () => settings.storeUrl();
  const back = (res, frag) => {
    const s = shop(); if (!s) return res.status(500).json({ error: 'store_url_not_configured' });
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, `${s}/login/callback#${new URLSearchParams(frag).toString()}`);
  };
  const conf = p => { const c = settings.provider(p); if (!c || !c.enabled) throw E.notFound('oauth_provider_disabled'); return c; };

  router.get('/api/store/oauth/providers', (req, res) => res.json({ providers: settings.enabledList() }));

  // 1. browser navigation (not fetch): remember state + PKCE verifier, send the buyer to the provider
  router.get('/api/store/oauth/:p/start', A.authLimiter, wrap((req, res) => {
    const p = req.params.p, c = settings.provider(p); cleanup();
    if (!c || !c.enabled) return back(res, { error: 'disabled' });
    let link = null;
    if (req.query.ticket) {                                                       // "connect Google to my account" from the account page
      const t = db.prepare("SELECT * FROM s_oauth_codes WHERE hash=? AND kind='link'").get(sec.sha256(String(req.query.ticket)));
      if (!t || t.expires_at < Date.now()) return back(res, { error: 'expired' });
      db.prepare('DELETE FROM s_oauth_codes WHERE hash=?').run(t.hash); link = t.account_id;
    }
    const state = b64u(crypto.randomBytes(32)), verifier = b64u(crypto.randomBytes(48));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const anon = /^[A-Za-z0-9_-]{16,64}$/.test(String(req.query.anon || '')) ? String(req.query.anon) : null;
    db.prepare('INSERT INTO s_oauth_states(hash,provider,verifier,next,lang,country,link_account,anon,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(sec.sha256(state), p, verifier, safeNext(req.query.next), LANGS.includes(req.query.lang) ? req.query.lang : null,
        /^[A-Z]{2}$/.test(String(req.query.country || '')) ? String(req.query.country) : null, link, anon, Date.now() + 10 * 60e3);
    const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: EP[p].scope, state, code_challenge: challenge, code_challenge_method: 'S256' });
    if (p === 'google') { q.set('prompt', 'select_account'); q.set('access_type', 'online'); }
    if (p === 'github') q.set('allow_signup', 'true');
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    res.redirect(302, `${url(p, 'auth')}?${q}`);
  }));

  // 2. the provider sends the buyer back here
  router.get('/api/store/oauth/:p/callback', A.authLimiter, wrap(async (req, res) => {
    const p = req.params.p;
    if (!settings.PROVIDERS[p]) return res.status(404).json({ error: 'not_found' });
    const st = typeof req.query.state === 'string' ? db.prepare('SELECT * FROM s_oauth_states WHERE hash=? AND provider=?').get(sec.sha256(req.query.state), p) : null;
    if (st) db.prepare('DELETE FROM s_oauth_states WHERE hash=?').run(st.hash);   // single use, whatever happens next
    if (!st || st.expires_at < Date.now()) return back(res, { error: 'expired' });
    const next = st.next || '/';
    if (req.query.error) return back(res, { error: req.query.error === 'access_denied' ? 'cancelled' : 'provider', next });
    if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 2000) return back(res, { error: 'provider', next });
    try {
      const c = conf(p);
      const prof = await profileOf(p, c, req.query.code, st.verifier);
      const r = resolve(p, prof, st, req);
      const a = db.prepare('SELECT a.id, c.blocked FROM s_accounts a JOIN m_customers c ON c.id=a.customer_id WHERE a.id=?').get(r.accountId);
      if (!a || a.blocked) return back(res, { error: 'blocked', next });
      if (st.anon) mergeAnonId(st.anon, r.accountId);
      const code = b64u(crypto.randomBytes(32));
      db.prepare('INSERT INTO s_oauth_codes(hash,account_id,kind,created,expires_at) VALUES(?,?,?,?,?)').run(sec.sha256(code), r.accountId, 'login', r.created ? 1 : 0, Date.now() + 2 * 60e3);
      return back(res, { code, next, ...(r.linked ? { linked: p } : {}) });
    } catch (e) {
      const known = ['identity_in_use', 'provider_already_linked', 'oauth_email_unverified', 'oauth_email_required', 'oauth_provider_disabled'];
      if (!(e instanceof HttpError) || e.status >= 500) console.error('oauth callback', p, e.code || e.message, e.extra ? e.extra.detail : '');
      return back(res, { error: known.includes(e.code) ? e.code : 'provider', next });
    }
  }));

  // 3. the shop trades the one-time code for the normal buyer token
  router.post('/api/store/oauth/exchange', A.authLimiter, wrap((req, res) => {
    const code = (req.body || {}).code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw E.bad('invalid_code');
    const row = db.prepare("SELECT * FROM s_oauth_codes WHERE hash=? AND kind='login'").get(sec.sha256(code));
    if (row) db.prepare('DELETE FROM s_oauth_codes WHERE hash=?').run(row.hash);
    if (!row || row.expires_at < Date.now()) throw new HttpError(401, 'invalid_code');
    res.json({ token: A.issue('buyer', row.account_id), profile: co.profile(row.account_id), created: !!row.created });
  }));

  // signed-in buyer: which providers are connected, connect one more, disconnect one
  router.get('/api/store/me/identities', A.buyer, (req, res) => {
    const rows = db.prepare('SELECT provider, created_at, last_login FROM s_identities WHERE account_id=? ORDER BY id').all(req.accountId);
    const a = db.prepare('SELECT password_set FROM s_accounts WHERE id=?').get(req.accountId);
    res.json({ identities: rows, available: settings.enabledList(), password_set: !!(a && a.password_set) });
  });
  router.post('/api/store/me/identities/:p/ticket', A.authLimiter, A.buyer, wrap((req, res) => {
    const p = req.params.p; conf(p);
    if (db.prepare('SELECT 1 FROM s_identities WHERE account_id=? AND provider=?').get(req.accountId, p)) throw E.conflict('provider_already_linked');
    const t = b64u(crypto.randomBytes(32));
    db.prepare('INSERT INTO s_oauth_codes(hash,account_id,kind,expires_at) VALUES(?,?,?,?)').run(sec.sha256(t), req.accountId, 'link', Date.now() + 2 * 60e3);
    res.json({ url: `${cfg.baseUrl}/api/store/oauth/${p}/start?ticket=${t}&next=${encodeURIComponent('/account/profile')}` });
  }));
  router.delete('/api/store/me/identities/:p', A.authLimiter, A.buyer, wrap((req, res) => {
    const p = req.params.p; if (!settings.PROVIDERS[p]) throw E.notFound();
    const a = db.prepare('SELECT password_set FROM s_accounts WHERE id=?').get(req.accountId);
    const n = db.prepare('SELECT COUNT(*) c FROM s_identities WHERE account_id=?').get(req.accountId).c;
    if (!a.password_set && n <= 1) throw E.conflict('last_sign_in_method');       // set a password first, or the account could never be opened again
    const r = db.prepare('DELETE FROM s_identities WHERE account_id=? AND provider=?').run(req.accountId, p);
    if (!r.changes) throw E.notFound();
    audit(req, 'store.oauth_unlink', `${p} account #${req.accountId}`, 'buyer');
    res.status(204).end();
  }));
};
module.exports.resolve = resolve;
