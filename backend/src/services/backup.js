'use strict';
/* Encrypted backups of the whole shop database.
   1. SQLite online backup API (consistent snapshot while the shop keeps running)  2. gzip  3. AES-256-GCM.
   File format (.asvb): "ASVB" | version 1 | mode 'P' (passphrase, scrypt) or 'K' (server key DATA_ENCRYPTION_KEY, HKDF) | salt 16 | iv 12 | ciphertext | tag 16.
   The 34-byte header is authenticated too (AAD), so nothing in the file can be altered unnoticed.
   With a backup passphrase the file can be restored on ANY machine knowing only the passphrase (scripts/restore-backup.js);
   without one it needs this server's DATA_ENCRYPTION_KEY. Copies are kept locally (rotated) and optionally uploaded to S3-compatible storage. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('ASVB'), HEADER = 34, TAG = 16;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(mode, salt, { passphrase, serverKey }) {
  if (mode === 'P') { if (!passphrase) throw new Error('passphrase_required'); return crypto.scryptSync(passphrase, salt, 32, SCRYPT); }
  if (!serverKey) throw new Error('server_key_required');
  return Buffer.from(crypto.hkdfSync('sha256', serverKey, salt, 'asveli-backup-v1', 32));
}

// plain SQLite file → encrypted .asvb
async function encryptFile(src, dst, secrets) {
  const mode = secrets.passphrase ? 'P' : 'K', salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([1]), Buffer.from(mode), salt, iv]);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(mode, salt, secrets), iv); c.setAAD(header);
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), c,
    async function* frame(body) { yield header; for await (const chunk of body) yield chunk; yield c.getAuthTag(); },   // header | ciphertext | tag
    fs.createWriteStream(dst, { mode: 0o600 }));
  return mode;
}
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; if (size < HEADER + TAG) throw new Error('not_a_backup');
    const h = Buffer.alloc(HEADER), tag = Buffer.alloc(TAG);
    fs.readSync(fd, h, 0, HEADER, 0); fs.readSync(fd, tag, 0, TAG, size - TAG);
    if (!h.subarray(0, 4).equals(MAGIC) || h[4] !== 1 || !['P', 'K'].includes(String.fromCharCode(h[5]))) throw new Error('not_a_backup');
    return { header: h, mode: String.fromCharCode(h[5]), salt: h.subarray(6, 22), iv: h.subarray(22, 34), tag, size };
  } finally { fs.closeSync(fd); }
}
// encrypted .asvb → plain SQLite file. A wrong key/passphrase or a damaged file fails here (GCM tag), never silently.
async function decryptFile(file, dst, secrets) {
  const h = readHeader(file);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(h.mode, h.salt, secrets), h.iv); d.setAAD(h.header); d.setAuthTag(h.tag);
  const tmp = dst + '.part';
  try {
    await pipeline(fs.createReadStream(file, { start: HEADER, end: h.size - TAG - 1 }), d, zlib.createGunzip(), fs.createWriteStream(tmp, { mode: 0o600 }));
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(/auth|unable to authenticate/i.test(e.message) ? 'wrong_key_or_damaged' : e.message);
  }
  return h.mode;
}
function check(dbFile) {
  const Database = require('better-sqlite3');
  const x = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const ok = x.pragma('integrity_check', { simple: true });
    const tables = x.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const rows = tables.reduce((n, t) => n + x.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n, 0);
    return { integrity: ok, tables: tables.length, rows };
  } finally { x.close(); }
}

/* ---------- the server side (needs the app's db + settings) ---------- */
let svc = null;
function service() {
  if (svc) return svc;
  const cfg = require('../config');
  const { db } = require('../db');
  const settings = require('./data-settings');
  const s3 = require('./s3');
  const dir = path.join(cfg.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  db.exec(`CREATE TABLE IF NOT EXISTS x_backups(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, ts INTEGER NOT NULL, size INTEGER, sha256 TEXT, mode TEXT,
    trigger TEXT, by_user TEXT, local INTEGER NOT NULL DEFAULT 1, s3_status TEXT, s3_key TEXT, error TEXT, ms INTEGER)`);
  const NAME = /^asveli-\d{8}-\d{6}-[a-f0-9]{6}\.asvb$/;
  const secrets = () => ({ passphrase: settings.backup().passphrase, serverKey: cfg.keys.data });
  let busy = false;

  async function run(trigger = 'manual', by = null) {
    if (busy) throw Object.assign(new Error('backup_running'), { code: 'backup_running' });
    busy = true;
    const t0 = Date.now(), stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `asveli-${stamp}-${crypto.randomBytes(3).toString('hex')}.asvb`, file = path.join(dir, name), snap = path.join(dir, name + '.snapshot');
    const b = settings.backup();
    const row = db.prepare('INSERT INTO x_backups(name, ts, trigger, by_user) VALUES(?,?,?,?)').run(name, t0, trigger, by).lastInsertRowid;
    try {
      await db.backup(snap);                                   // consistent copy, the shop keeps serving meanwhile
      const mode = await encryptFile(snap, file + '.part', secrets());
      fs.renameSync(file + '.part', file);
      const size = fs.statSync(file).size, sum = crypto.createHash('sha256');
      for await (const d of fs.createReadStream(file)) sum.update(d);
      db.prepare('UPDATE x_backups SET size=?, sha256=?, mode=?, ms=? WHERE id=?').run(size, sum.digest('hex'), mode, Date.now() - t0, row);
      if (b.s3.enabled) {
        const key = (b.s3.prefix || '') + name;
        try { await s3.put(b.s3, key, file); db.prepare("UPDATE x_backups SET s3_status='ok', s3_key=? WHERE id=?").run(key, row); }
        catch (e) { db.prepare("UPDATE x_backups SET s3_status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), row); }
      }
      prune(b.keepLocal);
      return get(row);
    } catch (e) {
      fs.rmSync(file + '.part', { force: true }); fs.rmSync(file, { force: true });
      db.prepare('UPDATE x_backups SET error=?, local=0, ms=? WHERE id=?').run(String(e.message).slice(0, 300), Date.now() - t0, row);
      throw e;
    } finally { fs.rmSync(snap, { force: true }); busy = false; }
  }
  // keep the newest N good local copies; older files are deleted here (the S3 copies stay — use a lifecycle rule in the bucket to expire them)
  function prune(keep) {
    const rows = db.prepare('SELECT id, name FROM x_backups WHERE local=1 AND error IS NULL AND size IS NOT NULL ORDER BY ts DESC').all();
    for (const r of rows.slice(keep)) { fs.rmSync(path.join(dir, r.name), { force: true }); db.prepare('UPDATE x_backups SET local=0 WHERE id=?').run(r.id); }
  }
  const get = id => db.prepare('SELECT * FROM x_backups WHERE id=?').get(id);
  const list = (limit = 50) => db.prepare('SELECT * FROM x_backups ORDER BY ts DESC LIMIT ?').all(limit);
  function fileOf(name) {
    if (!NAME.test(String(name))) return null;
    const r = db.prepare('SELECT * FROM x_backups WHERE name=? AND local=1').get(name);
    const f = path.join(dir, name);
    return r && fs.existsSync(f) ? { row: r, file: f } : null;
  }
  async function verify(name) {
    const x = fileOf(name); if (!x) return null;
    const tmp = path.join(dir, `.verify-${crypto.randomBytes(4).toString('hex')}.db`);
    try { await decryptFile(x.file, tmp, secrets()); return { ok: true, ...check(tmp) }; }
    catch (e) { return { ok: false, error: e.message }; }
    finally { fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + '.part', { force: true }); }
  }
  function remove(name) { const x = fileOf(name); if (!x) return false; fs.rmSync(x.file, { force: true }); db.prepare('UPDATE x_backups SET local=0 WHERE id=?').run(x.row.id); return true; }
  async function testS3() {
    const b = settings.backup(); if (!(b.s3.endpoint && b.s3.bucket && b.s3.accessKeyId && b.s3.secret)) throw new Error('s3_incomplete');
    const key = (b.s3.prefix || '') + `.asveli-probe-${Date.now()}`, tmp = path.join(dir, '.probe');
    fs.writeFileSync(tmp, 'asveli backup probe ' + new Date().toISOString());
    try { const t0 = Date.now(); await s3.put(b.s3, key, tmp); await s3.del(b.s3, key).catch(() => {}); return { ok: true, ms: Date.now() - t0 }; }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  const last = () => db.prepare('SELECT * FROM x_backups WHERE error IS NULL AND size IS NOT NULL ORDER BY ts DESC LIMIT 1').get() || null;
  let timer = null;
  function start() {
    if (timer) return;
    for (const f of fs.readdirSync(dir)) if (/\.(part|snapshot)$|^\.verify-|^\.probe$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });   // leftovers of a crash
    const due = async () => {
      const b = settings.backup(); if (!b.enabled || busy) return;
      const l = last(); if (l && Date.now() - l.ts < b.everyHours * 3600e3) return;
      const failed = db.prepare("SELECT ts FROM x_backups WHERE error IS NOT NULL ORDER BY ts DESC LIMIT 1").get();
      if (failed && (!l || failed.ts > l.ts) && Date.now() - failed.ts < 30 * 60e3) return;     // retry a failure after 30 min, not every tick
      try { await run('schedule'); } catch (e) { console.error('backup failed:', e.message); }
    };
    timer = setInterval(due, 5 * 60e3); timer.unref();
    setTimeout(due, 30e3).unref();
  }
  svc = { run, list, get, fileOf, verify, remove, testS3, last, start, dir, busy: () => busy };
  return svc;
}
module.exports = { encryptFile, decryptFile, readHeader, check, service };
