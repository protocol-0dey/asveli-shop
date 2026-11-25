'use strict';
// Buyer sign-in with Google / GitHub / Amazon against fake providers: PKCE, single-use state and codes, account creation,
// safe linking by verified e-mail only, linking from the account page, unlinking rules, password-less accounts, admin settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { startServer, Client } = require('./helpers');

const SHOP = 'https://shop.test';
let T, owner, P, base;
const codes = new Map();                                   // code → { challenge, profile, emails }
const b64u = b => b.toString('base64url');

function fakeProviders() {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const send = (o, s = 200) => { res.statusCode = s; res.end(JSON.stringify(o)); };
      const m = /^\/(google|github|amazon)\/(token|userinfo|profile|api\/user|api\/user\/emails)$/.exec(req.url);
      if (!m) return send({ error: 'not_found' }, 404);
      const [, p, kind] = m;
      if (kind === 'token') {
        const f = new URLSearchParams(b), c = codes.get(f.get('code'));
        if (f.get('client_id') !== p + '-client-id-123' || f.get('client_secret') !== p + '-secret-value-xyz') return send({ error: 'invalid_client' }, 401);
        if (!c || c.p !== p) return send({ error: 'invalid_grant' }, 400);
        if (b64u(crypto.createHash('sha256').update(f.get('code_verifier') || '').digest()) !== c.challenge) return send({ error: 'invalid_grant', error_description: 'PKCE verifier mismatch' }, 400);
        if (!f.get('redirect_uri').endsWith(`/api/store/oauth/${p}/callback`)) return send({ error: 'redirect_uri_mismatch' }, 400);
        codes.delete(f.get('code')); const at = 'at-' + crypto.randomBytes(8).toString('hex'); codes.set(at, c);
        return send({ access_token: at, token_type: 'bearer' });
      }
      const c = codes.get((req.headers.authorization || '').replace('Bearer ', ''));
      if (!c) return send({ message: 'Bad credentials' }, 401);
      if (kind === 'api/user/emails') return send(c.emails);
      return send(c.profile);
    });
  });
}

const call = async (c, method, url, json) => { const r = await c.req(method, url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const pub = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
const buyer = token => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
const frag = loc => Object.fromEntries(new URLSearchParams(new URL(loc).hash.slice(1)));

// the whole browser round trip: start → (user approves at the provider) → callback → shop
async function signIn(p, profile, { emails, next = '/cart', startQuery = '', approve = true } = {}) {
  const r1 = await pub(`/api/store/oauth/${p}/start?next=${encodeURIComponent(next)}&lang=pl&country=PL${startQuery}`);
  assert.equal(r1.status, 302);
  const to = new URL(r1.headers.get('location'));
  if (to.origin === SHOP) return { error: frag(to.href).error };
  const q = to.searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.ok(q.get('state').length >= 43); assert.equal(q.get('client_id'), p + '-client-id-123');
  assert.equal(q.get('redirect_uri'), `${base}/api/store/oauth/${p}/callback`);
  let back;
  if (approve) { const code = 'c-' + crypto.randomBytes(8).toString('hex'); codes.set(code, { p, challenge: q.get('code_challenge'), profile, emails }); back = `code=${code}&state=${q.get('state')}`; }
  else back = `error=access_denied&state=${q.get('state')}`;
  const r2 = await pub(`/api/store/oauth/${p}/callback?${back}`);
  assert.equal(r2.status, 302);
  const loc = r2.headers.get('location'); assert.ok(loc.startsWith(SHOP + '/login/callback#'), loc);
  return { ...frag(loc), state: q.get('state'), back };
}
const exchange = async code => { const r = await pub('/api/store/oauth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SHOP }, body: JSON.stringify({ code }) }); return { s: r.status, j: await r.json() }; };

before(async () => {
  P = fakeProviders(); await new Promise(r => P.listen(0, '127.0.0.1', r));
  T = await startServer({ OAUTH_TEST_BASE: `http://127.0.0.1:${P.address().port}`, STORE_ORIGINS: SHOP, STORE_AUTH_RATE_LIMIT: '1000' });
  base = T.base;
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
});
after(() => { if (T) T.stop(); if (P) P.close(); });

test('admin: owner configures providers; secrets are write-only; the shop address must be an allowed origin', async () => {
  assert.deepEqual((await (await pub('/api/store/oauth/providers')).json()).providers, []);
  assert.equal((await signIn('google', {})).error, 'disabled');
  const bad = await call(owner, 'PUT', '/api/admin/oauth/settings', { storeUrl: 'https://evil.example' }); assert.equal(bad.j.error, 'store_url_not_allowed');
  const v = await ok(owner, 'PUT', '/api/admin/oauth/settings', { storeUrl: SHOP, google: { clientId: 'google-client-id-123', clientSecret: 'google-secret-value-xyz' },
    github: { clientId: 'github-client-id-123', clientSecret: 'github-secret-value-xyz' }, amazon: { clientId: 'amazon-client-id-123', clientSecret: 'amazon-secret-value-xyz' } });
  assert.ok(!JSON.stringify(v).includes('secret-value-xyz')); assert.equal(v.providers[0].secret_hint, '••••-xyz');
  assert.equal(v.providers[0].redirect_uri, `${base}/api/store/oauth/google/callback`);
  assert.deepEqual((await (await pub('/api/store/oauth/providers')).json()).providers.map(x => x.id), ['google', 'github', 'amazon']);
  const j = await ok(owner, 'POST', '/api/admin/staff', { username: 'u_cm', role: 'catalog_manager' }, 201);
  const cm = new Client(T.adminBase); await cm.login('u_cm', j.temp_password); await ok(cm, 'POST', '/api/admin/security/password', { current: j.temp_password, next: 'brand-new-long-password-77' });
  assert.equal((await call(cm, 'GET', '/api/admin/oauth/settings')).s, 403);
});

test('Google: a new buyer gets an account, codes and state are single-use, the redirect target is safe', async () => {
  const r = await signIn('google', { sub: 'g-1', email: 'Anna@Example.com', email_verified: true, name: 'Anna Nowak' });
  assert.equal(r.next, '/cart'); assert.ok(r.code);
  const x = await exchange(r.code); assert.equal(x.s, 200); assert.equal(x.j.created, true);
  assert.equal(x.j.profile.email, 'anna@example.com'); assert.equal(x.j.profile.name, 'Anna Nowak'); assert.equal(x.j.profile.country, 'PL'); assert.equal(x.j.profile.password_set, false);
  assert.equal((await exchange(r.code)).s, 401, 'a login code works once');
  const me = await (await pub('/api/store/me', { headers: buyer(x.j.token) })).json(); assert.equal(me.email, 'anna@example.com');
  const replay = await pub(`/api/store/oauth/google/callback?${r.back}`); assert.equal(frag(replay.headers.get('location')).error, 'expired', 'state is single-use');
  const again = await signIn('google', { sub: 'g-1', email: 'anna@example.com', email_verified: true });
  const y = await exchange(again.code); assert.equal(y.j.created, false); assert.equal(y.j.profile.id, x.j.profile.id);
  const evil = await signIn('google', { sub: 'g-1', email: 'anna@example.com', email_verified: true }, { next: '//evil.example/x' }); assert.equal(evil.next, '/');
});

test('GitHub: links to an existing password account only by a verified e-mail', async () => {
  const reg = await (await pub('/api/store/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'jan@example.com', password: 'long-password-01', name: 'Jan', country: 'PL' }) })).json();
  const unverified = await signIn('github', { id: 501, login: 'mallory' }, { emails: [{ email: 'jan@example.com', primary: true, verified: false }] });
  assert.equal(unverified.error, 'oauth_email_required', 'GitHub without a verified e-mail cannot sign in');
  const r = await signIn('github', { id: 777, login: 'jan-dev', name: 'Jan D' }, { emails: [{ email: 'other@x.dev', primary: false, verified: true }, { email: 'jan@example.com', primary: true, verified: true }] });
  assert.equal(r.linked, 'github');
  const x = await exchange(r.code); assert.equal(x.j.profile.id, reg.profile.id); assert.equal(x.j.created, false); assert.equal(x.j.profile.password_set, true);
});

test('Google with an unverified e-mail never takes over an existing account', async () => {
  await pub('/api/store/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'eve.target@example.com', password: 'long-password-02', name: 'Eve', country: 'DE' }) });
  const r = await signIn('google', { sub: 'g-attacker', email: 'eve.target@example.com', email_verified: false });
  assert.equal(r.error, 'oauth_email_unverified'); assert.equal(r.code, undefined);
});

test('Amazon: cancelling at Amazon comes back as "cancelled"; approving creates the account', async () => {
  assert.equal((await signIn('amazon', {}, { approve: false })).error, 'cancelled');
  const r = await signIn('amazon', { user_id: 'amzn1.account.AAA', email: 'buyer@amazon.test', name: 'Bob' });
  const x = await exchange(r.code); assert.equal(x.j.created, true); assert.equal(x.j.profile.name, 'Bob');
});

test('account page: connect another provider with a ticket; the last sign-in method cannot be removed; first password needs no current one', async () => {
  const r = await signIn('google', { sub: 'g-solo', email: 'solo@example.com', email_verified: true, name: 'Solo' });
  const { j: { token } } = await exchange(r.code);
  let ids = await (await pub('/api/store/me/identities', { headers: buyer(token) })).json();
  assert.deepEqual(ids.identities.map(i => i.provider), ['google']); assert.equal(ids.password_set, false);
  const del = await pub('/api/store/me/identities/google', { method: 'DELETE', headers: buyer(token) }); assert.equal(del.status, 409); assert.equal((await del.json()).error, 'last_sign_in_method');
  const t = await (await pub('/api/store/me/identities/amazon/ticket', { method: 'POST', headers: buyer(token), body: '{}' })).json();
  const ticket = new URL(t.url).searchParams.get('ticket');
  const linked = await signIn('amazon', { user_id: 'amzn1.account.SOLO', email: 'different@amazon.test', name: 'Solo' }, { startQuery: '&ticket=' + ticket });
  assert.equal(linked.linked, 'amazon');
  ids = await (await pub('/api/store/me/identities', { headers: buyer(token) })).json(); assert.deepEqual(ids.identities.map(i => i.provider).sort(), ['amazon', 'google']);
  assert.equal((await signIn('amazon', {}, { startQuery: '&ticket=' + ticket })).error, 'expired', 'a link ticket is single-use');
  const pw = await pub('/api/store/me/password', { method: 'POST', headers: buyer(token), body: JSON.stringify({ next: 'my-first-password-1' }) }); assert.equal(pw.status, 200);
  const tok2 = (await pw.json()).token;
  const login = await pub('/api/store/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'solo@example.com', password: 'my-first-password-1' }) }); assert.equal(login.status, 200);
  assert.equal((await pub('/api/store/me/password', { method: 'POST', headers: buyer(tok2), body: JSON.stringify({ next: 'another-password-2' }) })).status, 403, 'now the current password is required');
  for (const p of ['google', 'amazon']) assert.equal((await pub('/api/store/me/identities/' + p, { method: 'DELETE', headers: buyer(tok2) })).status, 204);
});

test('a password-less account is deleted with an explicit confirmation', async () => {
  const r = await signIn('google', { sub: 'g-bye', email: 'bye@example.com', email_verified: true });
  const { j: { token } } = await exchange(r.code);
  const no = await pub('/api/store/me', { method: 'DELETE', headers: buyer(token), body: '{}' }); assert.equal(no.status, 403); assert.equal((await no.json()).error, 'confirm_required');
  assert.equal((await pub('/api/store/me', { method: 'DELETE', headers: buyer(token), body: JSON.stringify({ confirm: 'DELETE' }) })).status, 204);
  const again = await signIn('google', { sub: 'g-bye', email: 'bye@example.com', email_verified: true });
  assert.equal((await exchange(again.code)).j.created, true, 'the identity went with the account');
});
