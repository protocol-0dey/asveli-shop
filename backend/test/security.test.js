'use strict';
// Attack-style tests. Each test describes the attack in its name; a failure means a real weakness.
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';   // lets the test forge/inspect signed links
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'asveli-sec-cfg-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'), net = require('net'), os = require('os'), fs = require('fs'), path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const sec = require('../src/security');
const { startServer, Client } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const ADMIN = '/api/admin';
const PW = { alice: 'correct-horse-battery', bob: 'another-long-password', carol: 'long-secret-phrase-001' };

let S;
before(async () => { S = await startServer(); });
after(() => S.stop());

/* ---------- helpers ---------- */
function raw(port, { method = 'GET', path: p = '/', headers = {}, body, host = '127.0.0.1' } = {}) {
  headers = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: p, headers, setHost: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const adminClient = async (user = 'alice', S_ = S) => { const c = new Client(S_.adminBase); const r = await c.login(user, PW[user]); assert.equal(r.r.status, 200); return c; };
const upload = (c, data, name, type = 'image/png') => { const fd = new FormData(); fd.append('file', new Blob([data], { type }), name); return c.req('POST', ADMIN + '/files', { body: fd }); };
const listeners = port => {
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of t.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/); if (c.length < 4 || c[3] !== '0A') continue;
      const [addr, hex] = c[1].split(':'); if (parseInt(hex, 16) === port) out.push(addr);
    }
  }
  return out;
};
const LOOPBACK_HEX = new Set(['0100007F', '00000000000000000000000001000000']);
const probe = (host, port) => new Promise(resolve => {
  const s = net.connect({ host, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve('connected'); });
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  s.on('error', e => resolve(e.code || 'error'));
});
const cfgCheck = env => spawnSync('node', ['-e', "require('./src/config')"], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

/* =====================================================================================
   1. ADMIN IS NOT REACHABLE FROM OUTSIDE
   ===================================================================================== */
test('ISOLATION: the public listener has no admin surface at all (even with a valid admin session)', async () => {
  const c = await adminClient();
  assert.equal((await c.req('GET', ADMIN + '/me')).status, 200, 'sanity: admin listener works');
  const paths = ['/', '/admin', '/admin/', '/admin/index.html', '/admin/admin.js', '/admin/logo.svg', '/api/admin', '/api/admin/me', '/api/admin/files',
    '/api/admin/subscribers.csv', '/api/admin/audit', '/%61dmin/', '/api/%61dmin/me', '//admin/', '/ADMIN/', '/admin%2f', '/api/admin%2fme',
    '/api/admin/../admin/', '/.env', '/package.json', '/src/config.js', '/data/asveli.db', '/admin/..%2f..%2fsrc%2fconfig.js'];
  for (const p of paths) for (const withCookie of [false, true]) {
    const r = await raw(S.port, { path: p, headers: { Host: `localhost:${S.port}`, ...(withCookie ? { Cookie: c.cookie } : {}) } });
    assert.ok([400, 404].includes(r.status), `${p} (cookie=${withCookie}) → ${r.status} (admin reachable on the public port!)`);
    assert.ok(!/asveli|SESSION_SECRET|<html/i.test(r.body), `${p} leaked content`);
  }
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const r = await raw(S.port, { method: m, path: '/api/admin/auth/login', headers: { Host: `localhost:${S.port}`, Origin: 'https://evil.example', 'Content-Type': 'application/json', Cookie: c.cookie, 'Content-Length': '2' }, body: '{}' });
    assert.equal(r.status, 404, `${m} /api/admin/auth/login on public port`);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
});

test('ISOLATION: both listeners are bound to loopback only (not 0.0.0.0, not the LAN/public IP)', async () => {
  for (const [name, port] of [['admin', S.adminPort], ['public', S.port]]) {
    const l = listeners(port);
    assert.ok(l.length > 0, `${name} port ${port}: no LISTEN socket found`);
    for (const a of l) assert.ok(LOOPBACK_HEX.has(a), `${name} port ${port} listens on non-loopback address ${a}`);
  }
  const ext = Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address);
  for (const ip of ext) for (const port of [S.adminPort, S.port]) {
    const r = await probe(ip, port);
    assert.notEqual(r, 'connected', `${ip}:${port} accepted a connection from the non-loopback interface`);
  }
  if (!ext.length) console.log('  (no non-loopback interface in this sandbox: verified via /proc/net/tcp only)');
});

test('ISOLATION: Host-header guard on the admin listener (DNS-rebinding)', async () => {
  const good = h => raw(S.adminPort, { path: '/admin/', headers: { Host: h } });
  for (const h of [`localhost:${S.adminPort}`, `127.0.0.1:${S.adminPort}`, `[::1]:${S.adminPort}`, 'LOCALHOST']) assert.equal((await good(h)).status, 200, h);
  for (const h of ['evil.example', `evil.example:${S.adminPort}`, `localhost.evil.example:${S.adminPort}`, `127.0.0.1.evil.example`, 'api.asveli.com', '', '0.0.0.0', 'localhost@evil.example'])
    assert.equal((await good(h)).status, 421, `Host "${h}" must be rejected`);
  const r = await raw(S.adminPort, { method: 'POST', path: ADMIN + '/auth/login', headers: { Host: 'evil.example', Origin: 'http://evil.example', 'Content-Type': 'application/json', 'Content-Length': '2' }, body: '{}' });
  assert.equal(r.status, 421, 'API too, not only static files');
});

test('ISOLATION: unsafe configuration refuses to start (fail closed)', () => {
  const base = { NODE_ENV: 'development' };
  let r = cfgCheck({ ...base, ADMIN_HOST: '0.0.0.0' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /expose the admin panel/);
  for (const h of ['::', '192.168.1.5', '10.0.0.2']) assert.notEqual(cfgCheck({ ...base, ADMIN_HOST: h }).status, 0, 'ADMIN_HOST=' + h);
  assert.equal(cfgCheck({ ...base, ADMIN_HOST: '0.0.0.0', ADMIN_ALLOW_NONLOOPBACK: '1' }).status, 0, 'explicit opt-in (Docker) works');
  assert.equal(cfgCheck({ ...base, ADMIN_HOST: '::1' }).status, 0);
  r = cfgCheck({ ...base, PORT: '4000', ADMIN_PORT: '4000' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /must differ/);
  r = cfgCheck({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://api.example.com' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /SESSION_SECRET/);
  r = cfgCheck({ NODE_ENV: 'production', SESSION_SECRET: 'short' });
  assert.notEqual(r.status, 0);
  r = cfgCheck({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /PUBLIC_BASE_URL/);
  r = cfgCheck({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://api.example.com' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /DATA_ENCRYPTION_KEY/);          // personal data must never be encrypted with a throw-away key
  assert.equal(cfgCheck({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEY: 'd'.repeat(40), PUBLIC_BASE_URL: 'https://api.example.com' }).status, 0);
});

test('ISOLATION: optional ADMIN_IP_ALLOWLIST hides the panel from other client IPs', async () => {
  const T = await startServer({ ADMIN_IP_ALLOWLIST: '203.0.113.7' });
  try {
    assert.equal((await raw(T.adminPort, { path: '/admin/', headers: { Host: 'localhost' } })).status, 404);
    assert.equal((await raw(T.adminPort, { path: ADMIN + '/me', headers: { Host: 'localhost' } })).status, 404);
  } finally { T.stop(); }
});

test('ISOLATION: deployment files never publish or proxy the admin port', () => {
  const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const compose = rd('docker-compose.yml');
  const ports = [...compose.matchAll(/^\s*-\s*["']?([\d.:]+)["']?\s*(?:#.*)?$/gm)].map(m => m[1]).filter(v => /:\d+$/.test(v));
  assert.ok(ports.length >= 2, 'compose should publish the public and the admin port: ' + ports);
  for (const p of ports) assert.ok(p.startsWith('127.0.0.1:'), `docker-compose publishes "${p}" on all interfaces`);
  assert.ok(ports.some(p => p.endsWith(':3001')), 'admin port published (loopback) for the SSH tunnel');
  assert.match(compose, /ADMIN_ALLOW_NONLOOPBACK/);
  assert.ok(!/EXPOSE\s+3001/.test(rd('Dockerfile')), 'Dockerfile must not EXPOSE the admin port');
  for (const f of fs.readdirSync(path.join(ROOT, 'deploy')).filter(n => n.endsWith('.conf'))) {
    const t = rd('deploy/' + f);
    assert.ok(!/3001/.test(t.replace(/#.*$/gm, '')), `${f} must not reference the admin port`);
  }
  const https = rd('deploy/nginx-10-https.conf');
  assert.match(https, /location\s+~\*?\s+\^\/\(admin\|api\/admin\)[^{]*\{\s*return 404;/, 'nginx must answer 404 for /admin and /api/admin');
  assert.ok(!/ADMIN_ORIGIN/.test(rd('.env.example')), 'stale ADMIN_ORIGIN setting');
});

/* =====================================================================================
   2. CSRF / CORS / sessions
   ===================================================================================== */
test('CSRF: cross-origin, same-site-other-port, null origin and Fetch-Metadata are all rejected', async () => {
  const c = await adminClient();
  const ok = (extra = {}) => raw(S.adminPort, { method: 'DELETE', path: ADMIN + '/subscribers/999999', headers: { Host: `localhost:${S.adminPort}`, Cookie: c.cookie, 'X-CSRF-Token': c.csrf, Origin: `http://localhost:${S.adminPort}`, ...extra } });
  assert.equal((await ok()).status, 200, 'sanity: legit request passes');
  for (const origin of ['https://evil.example', 'null', `http://localhost:${S.adminPort + 5}`, `http://localhost.evil.example:${S.adminPort}`, `http://localhost:${S.adminPort}.evil.example`, 'http://localhost', 'not a url', `http://127.0.0.1:${S.adminPort}`])
    assert.equal((await ok({ Origin: origin })).status, 403, `Origin ${origin}`);
  assert.equal((await ok({ Origin: undefined })).status, 403, 'no Origin');
  assert.equal((await ok({ 'Sec-Fetch-Site': 'same-site' })).status, 403, 'Sec-Fetch-Site: same-site');
  assert.equal((await ok({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await ok({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await ok({ 'X-CSRF-Token': 'wrong' })).status, 403, 'bad token');
  assert.equal((await ok({ 'X-CSRF-Token': undefined })).status, 403, 'no token');
  const login = await raw(S.adminPort, { method: 'POST', path: ADMIN + '/auth/login', headers: { Host: `localhost:${S.adminPort}`, Origin: 'https://evil.example', 'Content-Type': 'application/json', 'Content-Length': '2' }, body: '{}' });
  assert.equal(login.status, 403, 'login CSRF (forcing a victim into the attacker account)');
});

test('CORS: the admin listener never opens itself to other origins', async () => {
  const c = await adminClient();
  for (const [m, p] of [['GET', ADMIN + '/me'], ['OPTIONS', ADMIN + '/files'], ['POST', ADMIN + '/auth/login'], ['GET', '/admin/']]) {
    const r = await raw(S.adminPort, { method: m, path: p, headers: { Host: `localhost:${S.adminPort}`, Origin: 'https://evil.example', Cookie: c.cookie, 'Access-Control-Request-Method': 'POST', 'Content-Length': m === 'POST' ? '2' : undefined, 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.headers['access-control-allow-origin'], undefined, `${m} ${p}`);
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
  }
});

test('SESSIONS: fixation, logout, idle and absolute expiry, pending-2FA sessions', async () => {
  const c = new Client(S.adminBase);
  c.cookie = 'asveli_sid=attacker-chosen-value';
  const { j } = await c.login('carol', PW.carol); assert.ok(j.csrf);
  assert.ok(!c.cookie.includes('attacker-chosen-value'), 'session id must be regenerated on login');
  const old = new Client(S.adminBase); old.cookie = 'asveli_sid=attacker-chosen-value';
  assert.equal((await old.req('GET', ADMIN + '/me')).status, 401);
  assert.equal((await c.req('GET', ADMIN + '/me')).status, 200);

  const db = new Database(path.join(S.dataDir, 'asveli.db'));
  try {
    db.prepare('UPDATE sessions SET last_seen = last_seen - ?').run(2 * 3600 * 1000);
    assert.equal((await c.req('GET', ADMIN + '/me')).status, 401, 'idle timeout (1h)');
    const c2 = await adminClient('carol');
    db.prepare('UPDATE sessions SET created_at = created_at - ?').run(13 * 3600 * 1000);
    assert.equal((await c2.req('GET', ADMIN + '/me')).status, 401, 'absolute timeout (12h)');
    const left = db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)').get('carol').n;
    assert.ok(left <= 1, 'expired sessions are deleted');
  } finally { db.close(); }

  const c3 = await adminClient('carol'); const stolen = c3.cookie;
  await c3.req('POST', ADMIN + '/auth/logout', { json: {} });
  const replay = new Client(S.adminBase); replay.cookie = stolen;
  assert.equal((await replay.req('GET', ADMIN + '/me')).status, 401, 'logout must invalidate the token server-side');
  const raw1 = await fetch(S.adminBase + ADMIN + '/me', { headers: { Cookie: 'asveli_sid=' + 'A'.repeat(5000) } });
  assert.equal(raw1.status, 401);
});

/* =====================================================================================
   3. Login hardening
   ===================================================================================== */
test('LOGIN: type confusion, injection strings and enumeration', async () => {
  const post = body => new Client(S.adminBase).req('POST', ADMIN + '/auth/login', { json: body });
  for (const b of [{ username: { $ne: 1 }, password: { $ne: 1 } }, { username: ['alice'], password: 'x' }, { username: 'alice', password: null }, { username: 'alice' }, {}, { username: 'a'.repeat(5000), password: 'x' }, { username: 'alice', password: 'p'.repeat(100000) }, { __proto__: { admin: true }, username: 'alice', password: 'x' }])
    assert.ok([400, 401, 413].includes((await post(b)).status), JSON.stringify(b).slice(0, 60));
  for (const u of ["' OR '1'='1", "alice'--", 'alice" OR "1"="1', "'; DROP TABLE users;--", 'alice\u0000'])
    assert.equal((await post({ username: u, password: 'whatever-long-password' })).status, 401, u);
  const unknown = await post({ username: 'nobody-here', password: 'whatever-long-password' });
  const wrong = await post({ username: 'alice', password: 'whatever-long-password' });
  assert.equal(unknown.status, wrong.status);
  assert.deepEqual(await unknown.json(), await wrong.json(), 'unknown user and wrong password must be indistinguishable');
  assert.equal((await adminClient('alice').then(c => c.req('GET', ADMIN + '/me'))).status, 200, 'users table survived the injection attempts');
  const bad = await new Client(S.adminBase).req('POST', ADMIN + '/auth/login', { body: '{"username": ', headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400); assert.ok(!/at \w+.*\.js|node_modules/.test(await bad.text()), 'no stack traces');
});

test('LOGIN: parallel password guesses cannot outrun the account lockout', async () => {
  const T = await startServer({ LOGIN_RATE_LIMIT: '1000' });
  try {
    const guess = i => fetch(T.adminBase + ADMIN + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: T.adminBase }, body: JSON.stringify({ username: 'bob', password: 'guess-number-' + i }) }).then(r => r.status);
    const codes = await Promise.all(Array.from({ length: 30 }, (_, i) => guess(i)));
    assert.ok(codes.filter(x => x === 401).length <= 5 + 2, 'far more than 5 guesses were evaluated: ' + codes.join(','));
    const right = await new Client(T.adminBase).login('bob', PW.bob);
    assert.equal(right.r.status, 429, 'the account must be locked after the burst (right password still refused)');
  } finally { T.stop(); }
});

test('LOGIN: per-IP login rate limit', async () => {
  const T = await startServer({ LOGIN_RATE_LIMIT: '5' });
  try {
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await new Client(T.adminBase).login('user' + i, 'some-long-password')).r.status);
    assert.ok(codes.includes(429), 'rate limit never kicked in: ' + codes);
    assert.equal(codes.slice(0, 5).includes(429), false);
  } finally { T.stop(); }
});

test('2FA: one code can be used exactly once, even when submitted concurrently', async () => {
  const T = await startServer();
  try {
    const c = await adminClient('alice', T);
    const setup = await (await c.req('POST', ADMIN + '/security/2fa/setup', { json: {} })).json();
    const key = sec.b32decode(setup.secret), step = () => Math.floor(Date.now() / 30000);
    assert.equal((await c.req('POST', ADMIN + '/security/2fa/enable', { json: { code: sec.hotp(key, step()) } })).status, 200);
    await c.req('POST', ADMIN + '/auth/logout', { json: {} });
    const p = new Client(T.adminBase); const s1 = await p.login('alice', PW.alice); assert.equal(s1.j.needs2fa, true);
    const code = sec.hotp(key, step() + 1);
    const fire = () => fetch(T.adminBase + ADMIN + '/auth/login2fa', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: T.adminBase, Cookie: p.cookie }, body: JSON.stringify({ code }) }).then(r => r.status);
    const res = await Promise.all([fire(), fire(), fire(), fire()]);
    assert.equal(res.filter(x => x === 200).length, 1, 'same TOTP code accepted more than once: ' + res.join(','));
  } finally { T.stop(); }
});

/* =====================================================================================
   4. Public endpoint abuse
   ===================================================================================== */
test('PUBLIC: subscribe — CORS, origin↔site binding, body limits, malformed input', async () => {
  const T = await startServer({ SUBSCRIBE_RATE_LIMIT: '10000' });
  try {
    const sub = (origin, body, extra = {}) => raw(T.port, { method: 'POST', path: '/api/subscribe', headers: { Host: 'localhost', 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await sub('null', { email: 'a@b.co', site: 'asveli.pl' })).status, 403);
    assert.equal((await sub(undefined, { email: 'a@b.co', site: 'asveli.pl' })).status, 403, 'non-browser clients without Origin');
    assert.equal((await sub('https://asveli.pl.evil.example', { email: 'a@b.co', site: 'asveli.pl' })).status, 403);
    const ok = await sub('https://asveli.pl', { email: 'a@b.co', site: 'asveli.pl' });
    assert.equal(ok.status, 200); assert.equal(ok.headers['access-control-allow-origin'], 'https://asveli.pl'); assert.notEqual(ok.headers['access-control-allow-origin'], '*');
    assert.equal((await sub('https://asveli.pl', { email: 'c@d.co', site: 'asveli.shop' })).status, 422, 'a page may only subscribe people to its own site');
    assert.equal((await sub('https://asveli.pl', 'x'.repeat(20000))).status, 413);
    assert.equal((await sub('https://asveli.pl', '{"email":')).status, 400);
    assert.equal((await sub('https://asveli.pl', '{"__proto__":{"polluted":true},"email":"p@q.co","site":"asveli.pl"}')).status, 200);
    assert.equal(({}).polluted, undefined);
    for (const e of ['a@b', '@b.co', 'a b@c.co', 'a@b.co\r\nBcc: x@y.z', '', null, 12, ['a@b.co'], { a: 1 }, 'a'.repeat(300) + '@b.co'])
      assert.equal((await sub('https://asveli.pl', { email: e, site: 'asveli.pl' })).status, 422, JSON.stringify(e).slice(0, 40));
    const big = await raw(T.port, { path: '/', headers: { Host: 'localhost', 'X-Big': 'a'.repeat(40000) } });
    assert.ok([400, 431].includes(big.status), 'oversized header: ' + big.status);
  } finally { T.stop(); }
});

test('PUBLIC: subscribe is rate limited per IP (default 12 per 10 minutes)', async () => {
  const T = await startServer();
  try {
    const codes = [];
    for (let i = 0; i < 16; i++) codes.push((await raw(T.port, { method: 'POST', path: '/api/subscribe', headers: { Host: 'localhost', Origin: 'https://asveli.pl', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `r${i}@x.io`, site: 'asveli.pl' }) })).status);
    assert.deepEqual(codes.slice(0, 12), Array(12).fill(200)); assert.ok(codes.slice(12).every(c => c === 429), 'not rate limited: ' + codes);
  } finally { T.stop(); }
});

test('PUBLIC: HSTS on the public listener in production, never on the admin one; share links use PUBLIC_BASE_URL', async () => {
  const T = await startServer({ NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(48), DATA_ENCRYPTION_KEY: 'q'.repeat(48), REQUIRE_2FA: '0', PUBLIC_BASE_URL: 'https://api.example.com' });
  try {
    const pub = await raw(T.port, { path: '/api/health', headers: { Host: 'api.example.com' } });
    assert.match(pub.headers['strict-transport-security'], /max-age=\d{7,}/);
    const adm = await raw(T.adminPort, { path: '/admin/', headers: { Host: 'localhost' } });
    assert.equal(adm.headers['strict-transport-security'], undefined);
    for (const r of [pub, adm]) {
      assert.match(r.headers['content-security-policy'], /default-src 'none'/); assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.equal(r.headers['x-powered-by'], undefined);
    }
    const c = await adminClient('alice', T);
    const f = await (await upload(c, crypto.randomBytes(100), 'a.png')).json();
    const link = await (await c.req('POST', `${ADMIN}/files/${f.id}/share`, { json: { ttl: 600 } })).json();
    assert.ok(link.url.startsWith('https://api.example.com/s/'), link.url);
    const ck = c.cookie; assert.match(ck, /^asveli_sid=/);
  } finally { T.stop(); }
});

/* =====================================================================================
   5. Injection and stored XSS data
   ===================================================================================== */
test('INJECTION: SQL in filters, CSV formula injection, hostile subscriber data, paging bounds', async () => {
  const c = await adminClient();
  const evil = ['=1+1@evil.io', '-2+3@evil.io', '+cmd@evil.io', '<img/src=x/onerror=alert(1)>@x.io', "o'brien@x.io", 'a%b_c@x.io'];
  for (const e of evil) assert.equal((await fetch(S.base + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://asveli.pl' }, body: JSON.stringify({ email: e, site: 'asveli.pl' }) })).status, 200, e);
  const seed = new Database(path.join(S.dataDir, 'asveli.db'));
  seed.transaction(() => {
    const a = seed.prepare('INSERT OR IGNORE INTO subscribers(email,site,lang,created_at) VALUES(?,?,?,?)'), b = seed.prepare('INSERT INTO audit(ts,user,ip,action,detail) VALUES(?,?,?,?,?)');
    for (let i = 0; i < 260; i++) a.run(`seed${i}@bulk.io`, 'asveli.eu', 'en', Date.now());
    for (let i = 0; i < 560; i++) b.run(Date.now(), 'seed', '127.0.0.1', 'seed', null);
  })(); seed.close();
  const total = (await (await c.req('GET', ADMIN + '/subscribers')).json()).total;
  assert.ok(total >= evil.length + 260);
  for (const q of ["' OR 1=1--", '%', '_', "'; DROP TABLE subscribers;--", '\\', 'a%b'])
    assert.equal((await c.req('GET', ADMIN + '/subscribers?q=' + encodeURIComponent(q))).status, 200, q);
  assert.equal((await (await c.req('GET', ADMIN + '/subscribers?q=' + encodeURIComponent("' OR 1=1--"))).json()).total, 0, 'quote must not widen the query');
  assert.equal((await (await c.req('GET', ADMIN + '/subscribers?site=' + encodeURIComponent("asveli.pl' OR '1'='1"))).json()).total, 0);
  assert.equal((await (await c.req('GET', ADMIN + '/subscribers')).json()).total, total, 'subscribers table intact');
  const csv = await (await c.req('GET', ADMIN + '/subscribers.csv')).text();
  for (const line of csv.split('\n').slice(1).filter(Boolean)) {
    const first = line.split(',')[0];
    assert.ok(!/^"[=+\-@]/.test(first), 'CSV formula injection: ' + first);
  }
  assert.match(csv, /"'=1\+1@evil\.io"/);
  for (const p of ['/subscribers', '/audit']) for (const lim of ['-1', '0', '999999', 'abc', '1e9', '-9999999999']) {
    const r = await (await c.req('GET', `${ADMIN}${p}?limit=${lim}&offset=-5`)).json();
    assert.ok(r.rows.length <= 500 && (lim !== '-1' || p === '/audit' || r.rows.length <= 200), `${p}?limit=${lim} returned ${r.rows.length} rows`);
    assert.ok(r.rows.length <= (p === '/audit' ? 500 : 200), `${p}?limit=${lim} not bounded: ${r.rows.length}`);
  }
});

/* =====================================================================================
   6. File handling
   ===================================================================================== */
test('FILES: hostile names, header injection, active content, ranges, traversal, forged links', async () => {
  const c = await adminClient();
  const anon = new Client(S.base);
  const data = crypto.randomBytes(5000);

  const spoof = await (await upload(c, data, 'invoice‮gnp.exe​.png')).json();
  assert.ok(!/[​-‏‪-‮⁦-⁩﻿]/.test(spoof.name), 'bidi/zero-width characters must be stripped from file names: ' + JSON.stringify(spoof.name));

  const f = await (await upload(c, data, 'photo.png')).json();
  const renamed = await (await c.req('PATCH', `${ADMIN}/files/${f.id}`, { json: { name: 'a"\r\nX-Evil: 1;\\.png' } })).json();
  const dl = await raw(S.adminPort, { path: `${ADMIN}/files/${f.id}/download`, headers: { Host: `localhost:${S.adminPort}`, Cookie: c.cookie } });
  assert.equal(dl.status, 200); assert.equal(dl.headers['x-evil'], undefined, 'header injection through the file name');
  assert.ok(!/[\r\n]/.test(dl.headers['content-disposition']), renamed.name);
  assert.match(dl.headers['content-disposition'], /^attachment/);
  const ru = await (await c.req('PATCH', `${ADMIN}/files/${f.id}`, { json: { name: 'Отчёт 2026.png' } })).json();
  assert.equal(ru.name, 'Отчёт 2026.png');
  const dl2 = await raw(S.adminPort, { path: `${ADMIN}/files/${f.id}/download`, headers: { Host: `localhost:${S.adminPort}`, Cookie: c.cookie } });
  assert.match(dl2.headers['content-disposition'], /filename\*=UTF-8''%D0%9E/);

  // active content is never rendered by the browser even when published
  for (const [name, type, body] of [['x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], ['x.html', 'text/html', '<script>alert(1)</script>'], ['x.js', 'application/javascript', 'alert(1)'], ['x.png', 'image/png', '<html><script>alert(1)</script></html>']]) {
    const u = await (await upload(c, Buffer.from(body), name, type)).json();
    const pub = await (await c.req('PATCH', `${ADMIN}/files/${u.id}`, { json: { is_public: true } })).json();
    const r = await anon.req('GET', new URL(pub.public_url).pathname);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
    assert.match(r.headers.get('content-security-policy'), /sandbox/, name);
    if (type !== 'image/png') { assert.equal(r.headers.get('content-type'), 'application/octet-stream', name); assert.match(r.headers.get('content-disposition'), /^attachment/, name); }
    else assert.equal(r.headers.get('content-type'), 'image/png');
  }

  // Range abuse never crashes the server and never over-reads
  for (const rg of ['bytes=0-0,2-3', 'bytes=-0', 'bytes=0-', 'bytes=99999999999999999999-', 'bytes=1-99999999999999999999', 'bytes=abc', 'bytes=--1', 'bytes=1-0', 'bytes=' + '0-0,'.repeat(2000), 'bytes=4999-', 'bytes=5000-', 'bytes=-99999'])
    {
      const r = await raw(S.adminPort, { path: `${ADMIN}/files/${f.id}/download`, headers: { Host: `localhost:${S.adminPort}`, Cookie: c.cookie, Range: rg } });
      assert.ok([200, 206, 400, 416, 431].includes(r.status), `${rg.slice(0, 40)} → ${r.status}`);
    }
  assert.equal((await raw(S.port, { path: '/api/health', headers: { Host: 'localhost' } })).status, 200, 'server alive after range fuzzing');

  // static traversal on the admin listener
  for (const p of ['/admin/..%2f..%2fsrc%2fconfig.js', '/admin/%2e%2e/%2e%2e/etc/passwd', '/admin/..%5c..%5cpackage.json', '/admin/%00', '/admin/.env', '/admin/../package.json', '/admin//..//..//etc/passwd', '/admin/%252e%252e/package.json'])
    {
      const r = await raw(S.adminPort, { path: p, headers: { Host: `localhost:${S.adminPort}` } });
      assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`); assert.ok(!/SESSION_SECRET|root:|"name": "asveli/.test(r.body), p);
    }
  for (const id of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', f.id + 'x', f.id.toUpperCase(), '0'.repeat(32), '%00'])
    assert.equal((await c.req('GET', `${ADMIN}/files/${id}/download`)).status, 404, id);

  // forged / expired / transplanted signed links
  const db = new Database(path.join(S.dataDir, 'asveli.db'), { readonly: true });
  const [a, b] = db.prepare('SELECT id, share_nonce FROM files WHERE name LIKE ? OR name LIKE ? ORDER BY created_at').all('Отчёт%', 'x.js').slice(0, 2); db.close();
  const good = sec.signLink(a.id, a.share_nonce, Date.now() + 60000);
  assert.equal((await anon.req('GET', '/s/' + good)).status, 200, 'sanity: a correctly signed link works');
  assert.equal((await anon.req('GET', '/s/' + sec.signLink(a.id, a.share_nonce, Date.now() - 1000))).status, 404, 'expired');
  const [id, exp, sig] = good.split('.');
  assert.equal((await anon.req('GET', `/s/${id}.${Number(exp) + 86400000 * 365}.${sig}`)).status, 404, 'extended expiry');
  assert.equal((await anon.req('GET', `/s/${b.id}.${exp}.${sig}`)).status, 404, 'signature transplanted to another file');
  assert.equal((await anon.req('GET', `/s/${id}.${exp}.${sig.slice(0, -1)}A`)).status, 404, 'flipped signature');
  assert.equal((await anon.req('GET', `/s/${id}.${exp}.`)).status, 404);
  assert.equal((await anon.req('GET', `/s/${sec.signLink(a.id, 'wrong-nonce', Date.now() + 60000)}`)).status, 404, 'nonce binding (revocation)');
});

test('FILES: rejected, oversized and aborted uploads leave no orphans; unauthenticated uploads are refused', async () => {
  const c = await adminClient();
  const blobs = () => fs.readdirSync(path.join(S.dataDir, 'blobs')).length;
  const rows = async () => (await (await c.req('GET', ADMIN + '/files')).json()).rows.length;
  const b0 = blobs(), r0 = await rows();
  assert.equal((await upload(c, crypto.randomBytes(1.6 * 1024 * 1024), 'big.png')).status, 413);
  assert.equal(blobs(), b0, 'oversized upload must not leave a blob'); assert.equal(await rows(), r0);

  const boundary = '----t' + crypto.randomBytes(6).toString('hex');
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`;
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: S.adminPort, method: 'POST', path: ADMIN + '/files', setHost: false, headers: {
      Host: `localhost:${S.adminPort}`, Origin: `http://localhost:${S.adminPort}`, Cookie: c.cookie, 'X-CSRF-Token': c.csrf,
      'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': String(5 * 1024 * 1024) } });
    req.on('error', () => resolve());
    req.write(head); req.write(crypto.randomBytes(200 * 1024));
    setTimeout(() => { req.destroy(); resolve(); }, 300);
  });
  await new Promise(r => setTimeout(r, 600));
  assert.equal(blobs(), b0, 'aborted upload must not leave a blob'); assert.equal(await rows(), r0);
  assert.equal((await raw(S.port, { path: '/api/health', headers: { Host: 'localhost' } })).status, 200);

  const anonUp = new Client(S.adminBase); const fd = new FormData(); fd.append('file', new Blob([Buffer.alloc(10)]), 'a.png');
  assert.ok([401, 403].includes((await anonUp.req('POST', ADMIN + '/files', { body: fd })).status));
  const noCsrf = new FormData(); noCsrf.append('file', new Blob([Buffer.alloc(10)]), 'a.png');
  assert.equal((await c.req('POST', ADMIN + '/files', { body: noCsrf, csrf: false })).status, 403);
  assert.equal(blobs(), b0);
  const two = new FormData(); two.append('file', new Blob([Buffer.alloc(10)]), 'one.png'); two.append('file', new Blob([Buffer.alloc(10)]), 'two.png');
  const tr = await c.req('POST', ADMIN + '/files', { body: two }); assert.equal(tr.status, 201);
  assert.equal(blobs(), b0 + 1, 'extra file parts are discarded, not stored');
  assert.equal((await c.req('POST', ADMIN + '/files', { json: { x: 1 } })).status, 415, 'non-multipart upload refused');
});

test('ROBUSTNESS: garbage requests never take the servers down', async () => {
  for (const port of [S.port, S.adminPort]) {
    for (const junk of ['GET / HTTP/1.1\r\nHost: localhost\r\nContent-Length: -1\r\n\r\n', 'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n0\r\n\r\n', '\x00\x01\x02\r\n\r\n', 'GET /' + 'A'.repeat(70000) + ' HTTP/1.1\r\nHost: localhost\r\n\r\n', 'GET / HTTP/9.9\r\n\r\n'])
      await new Promise(resolve => { const s = net.connect(port, '127.0.0.1', () => { s.write(junk); setTimeout(() => { s.destroy(); resolve(); }, 150); }); s.on('error', () => resolve()); s.on('data', () => {}); });
  }
  assert.equal((await raw(S.port, { path: '/api/health', headers: { Host: 'localhost' } })).status, 200);
  assert.equal((await raw(S.adminPort, { path: '/admin/', headers: { Host: 'localhost' } })).status, 200);
  assert.ok(!/TypeError|ReferenceError|Unhandled/.test(S.log()), 'server logged an unexpected crash:\n' + S.log().slice(0, 600));
});
