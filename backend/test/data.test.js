'use strict';
// "Данные и бэкапы": live mirror into real PostgreSQL and MariaDB (skipped when they are not running), encrypted backups,
// restore script, S3 upload with an independently verified SigV4 signature, retention, owner-only access.
// Local test DBs: PG_TEST_URL (default postgres://postgres:pw@127.0.0.1:55432/mirror), MYSQL_TEST_URL (default mysql://asv:asvpass@127.0.0.1:53306/mirror).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { startServer, Client } = require('./helpers');

const PG = process.env.PG_TEST_URL || 'postgres://postgres:topsecretpw@127.0.0.1:55432/mirror';
const MY = process.env.MYSQL_TEST_URL || 'mysql://asv:asvpass@127.0.0.1:53306/mirror';
const SCHEMA = 'asv_t' + crypto.randomBytes(3).toString('hex');
let T, owner, S3, s3objects = new Map(), s3bad = 0;

const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 150)); } };
const synced = () => until(async () => { const v = await ok(owner, 'GET', '/data/settings'); const s = v.mirror_status; return !s.pending && !s.copy_queue.length && s.last_ok && !s.copying ? v : null; });
async function reachable(url) {
  try {
    if (url.startsWith('postgres')) { const { Client: C } = require('pg'); const c = new C({ connectionString: url, connectionTimeoutMillis: 2000 }); await c.connect(); await c.end(); }
    else { const m = require('mysql2/promise'); const c = await m.createConnection({ uri: url, connectTimeout: 2000 }); await c.end(); }
    return true;
  } catch { return false; }
}

// fake S3: checks the AWS SigV4 signature from scratch (independent of the code under test) and stores objects
function fakeS3(secret, region) {
  const sha = b => crypto.createHash('sha256').update(b).digest('hex'), hm = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  return http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks), a = req.headers.authorization || '';
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(a);
      const fail = (s, code) => { s3bad++; res.statusCode = s; res.end(`<Error><Code>${code}</Code></Error>`); };
      if (!m || m[3] !== region) return fail(403, 'AuthorizationHeaderMalformed');
      const names = m[4].split(';');
      if (!names.includes('host') || !names.includes('x-amz-date') || !names.includes('x-amz-content-sha256')) return fail(403, 'AccessDenied');
      const hash = req.headers['x-amz-content-sha256'];
      if (req.method === 'PUT' && hash !== sha(body)) return fail(400, 'XAmzContentSHA256Mismatch');
      const canon = [req.method, req.url, '', names.map(h => `${h}:${String(req.headers[h]).trim()}\n`).join(''), m[4], hash].join('\n');
      const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${m[2]}/${region}/s3/aws4_request`, sha(canon)].join('\n');
      const k = hm(hm(hm(hm('AWS4' + secret, m[2]), region), 's3'), 'aws4_request');
      if (crypto.createHmac('sha256', k).update(toSign).digest('hex') !== m[5]) return fail(403, 'SignatureDoesNotMatch');
      if (req.method === 'PUT') s3objects.set(decodeURIComponent(req.url), body);
      if (req.method === 'DELETE') s3objects.delete(decodeURIComponent(req.url));
      res.statusCode = req.method === 'DELETE' ? 204 : 200; res.setHeader('ETag', '"' + crypto.createHash('md5').update(body).digest('hex') + '"'); res.end();
    });
  });
}

before(async () => {
  S3 = fakeS3('s3-secret-key-0123456789', 'eu-central-1'); await new Promise(r => S3.listen(0, '127.0.0.1', r));
  T = await startServer({});
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
});
after(async () => {
  if (T) T.stop(); if (S3) S3.close();
  if (await reachable(PG)) { const { Client: C } = require('pg'); const c = new C({ connectionString: PG }); await c.connect(); await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); await c.end(); }
  if (await reachable(MY)) { const m = require('mysql2/promise'); const c = await m.createConnection({ uri: MY }); const [r] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'tx\\_%'"); for (const x of r) await c.query(`DROP TABLE \`${x.t}\``); await c.end(); }
});

test('owner only; bad URLs and unreachable databases are refused before anything is switched on', async () => {
  const j = await ok(owner, 'POST', '/staff', { username: 'u_cat', role: 'catalog_manager' }, 201);
  const cat = new Client(T.adminBase); await cat.login('u_cat', j.temp_password);
  await ok(cat, 'POST', '/security/password', { current: j.temp_password, next: 'brand-new-long-password-77' });
  assert.equal((await call(cat, 'GET', '/data/settings')).s, 403);
  assert.equal((await call(cat, 'POST', '/data/backups/run')).s, 403);
  assert.equal((await call(owner, 'PUT', '/data/settings', { mirror: { url: 'ftp://x/y', enabled: true } })).j.error, 'invalid_db_url');
  const r = await call(owner, 'PUT', '/data/settings', { mirror: { url: 'postgres://u:secretpw@127.0.0.1:1/db', enabled: true } });
  assert.equal(r.j.error, 'mirror_connect_failed'); assert.ok(!JSON.stringify(r.j).includes('secretpw'));
  const v = await ok(owner, 'GET', '/data/settings');
  assert.equal(v.mirror.enabled, false); assert.equal(v.mirror.configured, false);
});

test('PostgreSQL mirror: existing rows are copied, then inserts / updates / deletes follow within seconds', async t => {
  if (!(await reachable(PG))) return t.skip('PostgreSQL not running');
  const w1 = await ok(owner, 'POST', '/m/warehouses', { name: 'Before-1', country: 'PL', priority: 1 }, 201);
  const tested = await ok(owner, 'POST', '/data/mirror/test', { url: PG, schema: SCHEMA });
  assert.equal(tested.ok, true); assert.equal(tested.type, 'postgres');
  const v = await ok(owner, 'PUT', '/data/settings', { mirror: { url: PG, schema: SCHEMA, enabled: true } });
  assert.equal(v.mirror.enabled, true); const pw = decodeURIComponent(new URL(PG).password); assert.ok(pw.length >= 2 && !JSON.stringify(v).includes(':' + pw + '@'), 'the DB password is never sent back');
  assert.equal(v.mirror.hint, PG.replace(/:[^:@/]+@/, ':••••@'));
  await synced();
  const { Client: C } = require('pg'); const pg = new C({ connectionString: PG }); await pg.connect();
  try {
    const rows = async () => (await pg.query(`SELECT id, name, priority FROM "${SCHEMA}"."m_warehouses" ORDER BY id`)).rows;
    assert.deepEqual((await rows()).map(r => r.name), ['Before-1']);
    const w2 = await ok(owner, 'POST', '/m/warehouses', { name: 'After-2', country: 'DE', priority: 2 }, 201);
    await ok(owner, 'PATCH', `/m/warehouses/${w1.id}`, { name: 'Renamed-1' });
    await synced();
    assert.deepEqual((await rows()).map(r => r.name), ['Renamed-1', 'After-2']);
    const kit = await ok(owner, 'POST', '/m/brand_kits', { name: 'Kit to delete' }, 201);
    await synced();
    const kits = async () => (await pg.query(`SELECT name FROM "${SCHEMA}"."m_brand_kits" WHERE id=$1`, [kit.id])).rows.length;
    assert.equal(await kits(), 1);
    await ok(owner, 'DELETE', `/m/brand_kits/${kit.id}`);
    await synced();
    assert.equal(await kits(), 0);
    assert.ok(w2.id);
    // audit log is mirrored too; login sessions never are
    assert.ok(Number((await pg.query(`SELECT COUNT(*) n FROM "${SCHEMA}"."audit" WHERE action='data.settings'`)).rows[0].n) >= 1);
    assert.equal((await pg.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='sessions'", [SCHEMA])).rows.length, 0);
    // counts match table by table
    const cmp = await ok(owner, 'GET', '/data/mirror/compare');
    const wh = cmp.tables.find(x => x.table === 'm_warehouses'); assert.equal(wh.local, wh.remote);
    assert.ok(cmp.tables.every(x => x.remote === null || x.table === 'audit' || x.local === x.remote), JSON.stringify(cmp.tables.filter(x => x.local !== x.remote)));
    // the external DB goes down: writes keep working, changes queue up and arrive after it is back
    await pg.query(`ALTER SCHEMA "${SCHEMA}" RENAME TO "${SCHEMA}_off"`);
    await ok(owner, 'POST', '/m/warehouses', { name: 'While-down', country: 'PL', priority: 3 }, 201);
    await until(async () => (await ok(owner, 'GET', '/data/settings')).mirror_status.last_error);
    await pg.query(`ALTER SCHEMA "${SCHEMA}_off" RENAME TO "${SCHEMA}"`);
    await synced();
    assert.deepEqual((await rows()).map(r => r.name), ['Renamed-1', 'After-2', 'While-down']);
  } finally { await pg.end(); }
});

test('MySQL / MariaDB mirror with a table prefix; switching target re-copies everything; off removes the triggers', async t => {
  if (!(await reachable(MY))) return t.skip('MySQL/MariaDB not running');
  await ok(owner, 'PUT', '/data/settings', { mirror: { url: MY, prefix: 'tx_', enabled: true } });
  await synced();
  const m = require('mysql2/promise'); const my = await m.createConnection({ uri: MY });
  try {
    const [r] = await my.query('SELECT name FROM `tx_m_warehouses` ORDER BY id');
    const local = (await ok(owner, 'GET', '/m/warehouses')).items || (await ok(owner, 'GET', '/m/warehouses')).rows;
    assert.ok(r.length >= 1); if (Array.isArray(local)) assert.equal(r.length, local.length);
    await ok(owner, 'POST', '/m/warehouses', { name: 'My-Ü-ż-日本', country: 'PL', priority: 9 }, 201);   // utf8mb4 round trip
    await synced();
    const [r2] = await my.query("SELECT name FROM `tx_m_warehouses` WHERE priority=9");
    assert.equal(r2[0].name, 'My-Ü-ż-日本');
  } finally { await my.end(); }
  await ok(owner, 'PUT', '/data/settings', { mirror: { enabled: false } });
  await until(async () => { const x = new Database(path.join(T.dataDir, 'asveli.db'), { readonly: true }); try { return !x.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name LIKE 'xm_%'").get(); } finally { x.close(); } });
});

test('backups: encrypted with a passphrase, verified, downloadable, restorable anywhere; wrong passphrase fails', async () => {
  assert.equal((await call(owner, 'PUT', '/data/settings', { backup: { passphrase: 'short' } })).j.error, 'weak_passphrase');
  await ok(owner, 'POST', '/m/warehouses', { name: 'Backup-WH', country: 'PL', priority: 5 }, 201);   // something to find in the restored copy
  const pass = 'correct horse battery staple 42';
  let v = await ok(owner, 'PUT', '/data/settings', { backup: { passphrase: pass, keepLocal: 2 } });
  assert.equal(v.backup.has_passphrase, true); assert.ok(!JSON.stringify(v).includes(pass));
  v = await ok(owner, 'POST', '/data/backups/run');
  const b = v.backups[0]; assert.equal(b.mode, 'P'); assert.equal(b.local, true); assert.ok(b.size > 100);
  const ver = await ok(owner, 'POST', `/data/backups/${b.name}/verify`); assert.equal(ver.ok, true); assert.equal(ver.integrity, 'ok'); assert.ok(ver.tables > 40);
  const r = await owner.req('GET', `/api/admin/data/backups/${b.name}/download`); assert.equal(r.status, 200);
  const bytes = Buffer.from(await r.arrayBuffer()); assert.equal(bytes.subarray(0, 4).toString(), 'ASVB');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), b.sha256);
  assert.ok(!bytes.includes(Buffer.from('SQLite format 3')) && !bytes.includes(Buffer.from('m_warehouses')), 'nothing readable in the file');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-restore-')), f = path.join(dir, b.name); fs.writeFileSync(f, bytes);
  const root = path.join(__dirname, '..');
  const bad = spawnSync('node', ['scripts/restore-backup.js', f, path.join(dir, 'x.db')], { cwd: root, env: { PATH: process.env.PATH, BACKUP_PASSPHRASE: 'wrong passphrase here' }, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /wrong passphrase/);
  const good = spawnSync('node', ['scripts/restore-backup.js', f, path.join(dir, 'ok.db')], { cwd: root, env: { PATH: process.env.PATH, BACKUP_PASSPHRASE: pass }, encoding: 'utf8' });   // no server env at all
  assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /integrity: ok/);
  const x = new Database(path.join(dir, 'ok.db'), { readonly: true });
  assert.ok(x.prepare("SELECT COUNT(*) n FROM m_warehouses").get().n >= 1); x.close();
  fs.rmSync(dir, { recursive: true, force: true });
  // tampering is detected
  const local = path.join(T.dataDir, 'backups', b.name), orig = fs.readFileSync(local), evil = Buffer.from(orig); evil[200] ^= 1; fs.writeFileSync(local, evil);
  const ver2 = await ok(owner, 'POST', `/data/backups/${b.name}/verify`); assert.equal(ver2.ok, false); assert.equal(ver2.error, 'wrong_key_or_damaged');
  fs.writeFileSync(local, orig);
  // bad names never reach the file system
  assert.equal((await call(owner, 'GET', '/data/backups/..%2F..%2Fasveli.db/download')).s, 404);
});

test('backups without a passphrase use the server key; retention keeps the newest N; S3 upload is signed (SigV4)', async () => {
  const s3 = { endpoint: `http://127.0.0.1:${S3.address().port}`, region: 'eu-central-1', bucket: 'asveli-backups', prefix: 'shop/', accessKeyId: 'AKIATESTKEY0001' };
  assert.equal((await call(owner, 'PUT', '/data/settings', { backup: { s3: { ...s3, enabled: true } } })).j.error, 's3_incomplete');
  await ok(owner, 'PUT', '/data/settings', { backup: { clearPassphrase: true, s3: { ...s3, secret: 's3-secret-key-0123456789', enabled: true } } });
  const probe = await ok(owner, 'POST', '/data/backups/s3-test'); assert.equal(probe.ok, true); assert.equal(s3bad, 0);
  let v; for (let i = 0; i < 3; i++) v = await ok(owner, 'POST', '/data/backups/run');
  assert.equal(v.backups[0].mode, 'K'); assert.equal(v.backups[0].s3, 'ok'); assert.equal(s3bad, 0);
  const local = v.backups.filter(b => b.local); assert.equal(local.length, 2, 'keepLocal=2');
  assert.equal(fs.readdirSync(path.join(T.dataDir, 'backups')).filter(f => f.endsWith('.asvb')).length, 2);
  const newest = v.backups[0], stored = s3objects.get(`/asveli-backups/shop/${newest.name}`);
  assert.ok(stored); assert.equal(crypto.createHash('sha256').update(stored).digest('hex'), newest.sha256);
  assert.equal((await ok(owner, 'POST', `/data/backups/${newest.name}/verify`)).ok, true);
  // a wrong S3 secret is reported, the local copy still exists
  await ok(owner, 'PUT', '/data/settings', { backup: { s3: { secret: 'wrong-secret-000000' } } });
  v = await ok(owner, 'POST', '/data/backups/run');
  assert.equal(v.backups[0].s3, 'failed'); assert.match(v.backups[0].error, /SignatureDoesNotMatch/); assert.equal(v.backups[0].local, true);
  const audit = await ok(owner, 'GET', '/audit');
  const txt = JSON.stringify(audit); assert.ok(!txt.includes('s3-secret-key') && !txt.includes('wrong-secret'), 'secrets never reach the audit log');
});
