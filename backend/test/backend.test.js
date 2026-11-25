'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, Client } = require('./helpers');

let S; before(async () => { S = await startServer(); }); after(() => S.stop());
const ADMIN = '/api/admin';
const png = n => { const b = crypto.randomBytes(n); return new Blob([b], { type: 'image/png' }); };
const upload = (c, blob, name = 'pic.png') => { const fd = new FormData(); fd.append('file', blob, name); return c.req('POST', ADMIN + '/files', { body: fd }); };

test('basics: health, 404, security headers', async () => {
  const c = new Client(S.base);
  assert.equal((await c.req('GET', '/api/health')).status, 200);
  const r = await c.req('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const a = await new Client(S.adminBase).req('GET', '/admin/');
  assert.equal(a.status, 200); assert.match(await a.text(), /Asveli/);
});

test('public subscribe: CORS allow-list, validation, dedupe, honeypot', async () => {
  const c = new Client(S.base);
  const sub = (o, body) => c.req('POST', '/api/subscribe', { origin: o, json: body });
  assert.equal((await sub('https://evil.example', { email: 'a@b.co', site: 'asveli.pl' })).status, 403);
  assert.equal((await sub('https://asveli.pl', { email: 'not-an-email', site: 'asveli.pl' })).status, 422);
  assert.equal((await sub('https://asveli.pl', { email: 'a@b.co', site: 'unknown.site' })).status, 422);
  const ok = await sub('https://asveli.pl', { email: 'User@Example.com', site: 'asveli.pl', lang: 'pl' });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://asveli.pl');
  assert.equal((await sub('https://asveli.pl', { email: 'user@example.com', site: 'asveli.pl' })).status, 200);   // duplicate, same answer
  assert.equal((await sub('https://asveli.shop', { email: 'bot@x.io', site: 'asveli.shop', company: 'spam' })).status, 200);  // honeypot ignored
  const pre = await c.req('OPTIONS', '/api/subscribe', { origin: 'https://asveli.pl' });
  assert.equal(pre.status, 204);
});

test('admin auth: gating, wrong password, CSRF and Origin checks', async () => {
  const c = new Client(S.adminBase);
  assert.equal((await c.req('GET', ADMIN + '/me')).status, 401);
  assert.equal((await c.req('GET', ADMIN + '/subscribers')).status, 401);
  assert.equal((await c.login('alice', 'wrong-password-here')).r.status, 401);
  assert.equal((await c.login('nobody', 'whatever-long-password')).r.status, 401);
  const { r, j } = await c.login('alice', 'correct-horse-battery');
  assert.equal(r.status, 200); assert.ok(j.csrf);
  assert.match(c.cookie, /^asveli_sid=/);
  const me = await (await c.req('GET', ADMIN + '/me')).json(); assert.equal(me.username, 'alice');
  // state-changing calls
  assert.equal((await c.req('DELETE', ADMIN + '/subscribers/1', { csrf: false })).status, 403);             // no CSRF token
  assert.equal((await c.req('DELETE', ADMIN + '/subscribers/1', { origin: 'https://evil.example' })).status, 403); // wrong Origin
  assert.equal((await c.req('DELETE', ADMIN + '/subscribers/1', { origin: null })).status, 403);            // missing Origin
  const subs = await (await c.req('GET', ADMIN + '/subscribers')).json();
  assert.equal(subs.total, 1);                                                                              // only one real subscriber stored
  assert.equal(subs.rows[0].email, 'user@example.com');
  const csv = await (await c.req('GET', ADMIN + '/subscribers.csv')).text();
  assert.match(csv, /user@example\.com/);
  await c.req('POST', ADMIN + '/auth/logout');
  assert.equal((await c.req('GET', ADMIN + '/me')).status, 401);
});

test('cookie flags', async () => {
  const res = await fetch(S.adminBase + ADMIN + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: S.adminBase }, body: JSON.stringify({ username: 'alice', password: 'correct-horse-battery' }) });
  const sc = res.headers.getSetCookie()[0];
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
});

test('account lockout after 5 failures', async () => {
  const c = new Client(S.adminBase);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('bob', 'bad-password-' + i)).r.status, 401);
  assert.equal((await c.login('bob', 'another-long-password')).r.status, 429);       // correct password still refused while locked
});

test('files: upload, list, range download, share links, revoke, public, limits', async () => {
  const c = new Client(S.adminBase); await c.login('alice', 'correct-horse-battery');
  const data = crypto.randomBytes(300 * 1024);
  const up = await upload(c, new Blob([data], { type: 'image/png' }), '../../etc/passwd.png');
  assert.equal(up.status, 201); const f = await up.json();
  assert.ok(!/[\/\\]/.test(f.name), 'filename sanitized: ' + f.name);
  assert.equal(f.size, data.length);

  const full = await c.req('GET', `${ADMIN}/files/${f.id}/download`);
  assert.equal(full.status, 200); assert.match(full.headers.get('content-disposition'), /^attachment/);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));
  const part = await c.req('GET', `${ADMIN}/files/${f.id}/download`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 10-19/${data.length}`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(data.subarray(10, 20)));
  const tail = await c.req('GET', `${ADMIN}/files/${f.id}/download`, { headers: { Range: 'bytes=-5' } });
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(data.subarray(data.length - 5)));
  assert.equal((await c.req('GET', `${ADMIN}/files/${f.id}/download`, { headers: { Range: 'bytes=999999-' } })).status, 416);

  // signed link
  const link = await (await c.req('POST', `${ADMIN}/files/${f.id}/share`, { json: { ttl: 600 } })).json();
  const path = new URL(link.url).pathname;
  const anon = new Client(S.base);
  const viaLink = await anon.req('GET', path); assert.equal(viaLink.status, 200);
  assert.ok(Buffer.from(await viaLink.arrayBuffer()).equals(data));
  const tampered = path.slice(0, -2) + (path.endsWith('aa') ? 'bb' : 'aa');
  assert.equal((await anon.req('GET', tampered)).status, 404);
  await c.req('POST', `${ADMIN}/files/${f.id}/revoke`, { json: {} });
  assert.equal((await anon.req('GET', path)).status, 404, 'revoked link must stop working');
  const expired = await (await c.req('POST', `${ADMIN}/files/${f.id}/share`, { json: { ttl: 60 } })).json();   // valid now…
  assert.equal((await anon.req('GET', new URL(expired.url).pathname)).status, 200);

  // public publishing: anonymous access only after toggle
  assert.equal((await anon.req('GET', '/f/AAAAAAAAAAAAAAAAAAAAAA/x.png')).status, 404);
  const pub = await (await c.req('PATCH', `${ADMIN}/files/${f.id}`, { json: { is_public: true } })).json();
  assert.ok(pub.public_url);
  const pr = await anon.req('GET', new URL(pub.public_url).pathname);
  assert.equal(pr.status, 200); assert.equal(pr.headers.get('content-type'), 'image/png'); assert.match(pr.headers.get('content-disposition'), /^inline/);
  assert.equal(pr.headers.get('cross-origin-resource-policy'), 'cross-origin');
  await c.req('PATCH', `${ADMIN}/files/${f.id}`, { json: { is_public: false } });
  assert.equal((await anon.req('GET', new URL(pub.public_url).pathname)).status, 404);

  // dangerous type is never rendered inline even if published
  const html = await (await upload(c, new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html')).json();
  const hp = await (await c.req('PATCH', `${ADMIN}/files/${html.id}`, { json: { is_public: true } })).json();
  const hr = await anon.req('GET', new URL(hp.public_url).pathname);
  assert.equal(hr.headers.get('content-type'), 'application/octet-stream'); assert.match(hr.headers.get('content-disposition'), /^attachment/);

  // size limit (MAX_UPLOAD_MB=1)
  const big = await upload(c, png(1.5 * 1024 * 1024), 'big.png');
  assert.equal(big.status, 413);
  assert.equal((await c.req('GET', ADMIN + '/files')).status, 200);
  assert.equal((await (await c.req('GET', ADMIN + '/files')).json()).rows.length, 2, 'rejected upload must not leave a row');

  assert.equal((await c.req('DELETE', `${ADMIN}/files/${f.id}`)).status, 200);
  assert.equal((await c.req('GET', `${ADMIN}/files/${f.id}/download`)).status, 404);
  assert.equal((await c.req('GET', `${ADMIN}/files/..%2f..%2fetc/download`)).status, 404);
});

test('2FA: setup, enable, login flow, replay protection, disable', async () => {
  const sec = require('../src/security');
  const c = new Client(S.adminBase); await c.login('alice', 'correct-horse-battery');
  const setup = await (await c.req('POST', ADMIN + '/security/2fa/setup', { json: {} })).json();
  assert.match(setup.qr, /^data:image\/png;base64,/);
  assert.equal((await c.req('POST', ADMIN + '/security/2fa/enable', { json: { code: '000000' } })).status, 401);
  const code = () => sec.hotp(sec.b32decode(setup.secret), Math.floor(Date.now() / 30000));
  const c1 = code();
  assert.equal((await c.req('POST', ADMIN + '/security/2fa/enable', { json: { code: c1 } })).status, 200);
  await c.req('POST', ADMIN + '/auth/logout', { json: {} });

  const c2 = new Client(S.adminBase);
  const step1 = await c2.login('alice', 'correct-horse-battery');
  assert.equal(step1.j.needs2fa, true); assert.equal(step1.j.csrf, undefined);
  assert.equal((await c2.req('GET', ADMIN + '/me')).status, 401, 'pending session must not grant access');
  assert.equal((await c2.req('GET', ADMIN + '/files')).status, 401);
  const replay = await c2.req('POST', ADMIN + '/auth/login2fa', { json: { code: c1 } });
  assert.equal(replay.status, 401, 'the code used to enable 2FA cannot be replayed');
  // next step's code
  const next = sec.hotp(sec.b32decode(setup.secret), Math.floor(Date.now() / 30000) + 1);
  const ok = await c2.req('POST', ADMIN + '/auth/login2fa', { json: { code: next } });
  assert.equal(ok.status, 200); c2.csrf = (await ok.json()).csrf;
  assert.equal((await c2.req('GET', ADMIN + '/me')).status, 200);
  const audit = await (await c2.req('GET', ADMIN + '/audit')).json();
  assert.ok(audit.rows.some(r => r.action === 'login'));
});

test('password change: validation, closes other sessions, old password dead', async () => {
  const a = new Client(S.adminBase), b = new Client(S.adminBase);
  await a.login('carol', 'long-secret-phrase-001'); await b.login('carol', 'long-secret-phrase-001');
  assert.equal((await a.req('POST', ADMIN + '/security/password', { json: { current: 'nope-nope-nope', next: 'brand-new-password-2' } })).status, 401);
  assert.equal((await a.req('POST', ADMIN + '/security/password', { json: { current: 'long-secret-phrase-001', next: 'short' } })).status, 400);
  assert.equal((await a.req('POST', ADMIN + '/security/password', { json: { current: 'long-secret-phrase-001', next: 'brand-new-password-2' } })).status, 200);
  assert.equal((await a.req('GET', ADMIN + '/me')).status, 200, 'current session survives');
  assert.equal((await b.req('GET', ADMIN + '/me')).status, 401, 'other sessions are closed');
  assert.equal((await new Client(S.adminBase).login('carol', 'long-secret-phrase-001')).r.status, 401);
  assert.equal((await new Client(S.adminBase).login('carol', 'brand-new-password-2')).r.status, 200);
});
