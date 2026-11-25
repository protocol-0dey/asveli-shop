'use strict';
/* External SQL mirror: every write to the shop's SQLite database is copied to the owner's PostgreSQL or MySQL/MariaDB.
   How: SQLite triggers on every mirrored table record (table, primary key) into x_changes (same transaction as the write, so nothing
   is ever missed, even if the external DB is down). A background worker reads x_changes in order, looks up the CURRENT row and
   upserts it remotely (or deletes it if it is gone), then forgets the processed changes. Re-applying is harmless (idempotent),
   so a crash between "applied remotely" and "forgotten locally" only causes a repeat, never a loss.
   The main database stays the source of truth: the mirror is a one-way, near-real-time copy (seconds of lag) for reporting,
   BI tools and disaster recovery. Never write into the mirror — the next sync overwrites it. */
const { db } = require('../db');
const settings = require('./data-settings');

db.exec(`
CREATE TABLE IF NOT EXISTS x_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS x_mirror_state(k TEXT PRIMARY KEY, v TEXT);
`);
const st = {
  get: k => (db.prepare('SELECT v FROM x_mirror_state WHERE k=?').get(k) || {}).v,
  set: (k, v) => db.prepare('INSERT INTO x_mirror_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v == null ? null : String(v))
};
const q = s => '"' + s + '"';                                  // SQLite identifiers (names are validated against IDENT first)
const TP = 'xm_';                                              // our triggers' name prefix

/* ---------- which tables, and their shape ---------- */
function localTables(m) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'x\\_%' ESCAPE '\\' ORDER BY name").all()
    .map(r => r.name).filter(n => settings.IDENT.test(n) && !m.exclude.includes(n));
}
function shape(t) {
  const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all().filter(c => settings.IDENT.test(c.name));
  const pk = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
  return { cols: cols.map(c => ({ name: c.name, type: kind(c.type), pk: c.pk > 0 })), pk };
}
function kind(decl) {                                          // SQLite type affinity rules, simplified
  const d = String(decl || '').toUpperCase();
  if (d.includes('INT')) return 'int';
  if (/REAL|FLOA|DOUB/.test(d)) return 'real';
  if (d.includes('BLOB')) return 'blob';
  return 'text';
}

/* ---------- triggers (installed only while the mirror is on) ---------- */
let sig = '';
function ensureTriggers(m, force) {
  const tables = localTables(m).filter(t => shape(t).pk.length);
  const s = tables.join(',') + '|' + m.exclude.join(',');
  if (s === sig && !force) return tables;
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'xm\\_%' ESCAPE '\\'").all().map(r => r.name));
  const want = new Set(), added = [];
  db.transaction(() => {
    for (const t of tables) {
      const pk = shape(t).pk, arr = p => `json_array(${pk.map(c => `${p}.${q(c)}`).join(',')})`, names = ['i', 'u', 'd'].map(x => `${TP}${t}_${x}`);
      names.forEach(n => want.add(n));
      if (names.every(n => have.has(n))) continue;
      names.forEach(n => db.exec(`DROP TRIGGER IF EXISTS ${q(n)}`));
      db.exec(`CREATE TRIGGER ${q(names[0])} AFTER INSERT ON ${q(t)} BEGIN INSERT INTO x_changes(tbl,pk) VALUES('${t}', ${arr('NEW')}); END;
        CREATE TRIGGER ${q(names[1])} AFTER UPDATE ON ${q(t)} BEGIN
          INSERT INTO x_changes(tbl,pk) SELECT '${t}', ${arr('OLD')} WHERE ${arr('OLD')} IS NOT ${arr('NEW')};
          INSERT INTO x_changes(tbl,pk) VALUES('${t}', ${arr('NEW')}); END;
        CREATE TRIGGER ${q(names[2])} AFTER DELETE ON ${q(t)} BEGIN INSERT INTO x_changes(tbl,pk) VALUES('${t}', ${arr('OLD')}); END;`);
      added.push(t);
    }
    for (const n of have) if (!want.has(n)) db.exec(`DROP TRIGGER IF EXISTS ${q(n)}`);
  })();
  if (added.length) queue(added);                              // a table that just got covered: copy what it already holds
  sig = s;
  return tables;
}
function dropTriggers() {
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'xm\\_%' ESCAPE '\\'").all()) db.exec(`DROP TRIGGER IF EXISTS ${q(r.name)}`);
  sig = '';
}
const queued = () => { try { return JSON.parse(st.get('copy_queue') || '[]'); } catch { return []; } };
function queue(tables) { st.set('copy_queue', JSON.stringify([...new Set([...queued(), ...tables])])); }

/* ---------- the external database ---------- */
function makeDriver(m) {
  const u = settings.parseUrl(m.url);
  const ssl = m.ssl === 'off' ? false : { rejectUnauthorized: m.ssl === 'require' };
  if (u.type === 'postgres') {
    const { Pool } = require('pg');
    const pool = new Pool({ host: u.host, port: u.port, user: u.user, password: u.password, database: u.database, ssl, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 120000 });
    pool.on('error', () => { /* a dropped idle connection: the next query reconnects */ });
    const Q = s => '"' + s + '"', T = t => `${Q(m.schema)}.${Q(m.prefix + t)}`;
    const TYPE = { int: 'BIGINT', real: 'DOUBLE PRECISION', blob: 'BYTEA', text: 'TEXT' };
    return {
      type: 'postgres', T,
      query: async (sql, p) => (await pool.query(sql, p)).rows,
      tx: async fn => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(async (s, p) => (await c.query(s, p)).rows); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } },
      ph: i => '$' + i,
      prepare: async run => { await run(`CREATE SCHEMA IF NOT EXISTS ${Q(m.schema)}`); },
      columns: async (run, t) => new Set((await run('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [m.schema, m.prefix + t])).map(r => r.column_name)),
      create: (t, s) => `CREATE TABLE IF NOT EXISTS ${T(t)} (${s.cols.map(c => `${Q(c.name)} ${TYPE[c.type]}`).join(', ')}, PRIMARY KEY (${s.pk.map(Q).join(', ')}))`,
      addCol: (t, c) => `ALTER TABLE ${T(t)} ADD COLUMN IF NOT EXISTS ${Q(c.name)} ${TYPE[c.type]}`,
      upsert: (t, cols, pk, n) => {
        let i = 0; const rows = Array.from({ length: n }, () => '(' + cols.map(() => '$' + ++i).join(',') + ')').join(',');
        const upd = cols.filter(c => !pk.includes(c));
        return `INSERT INTO ${T(t)} (${cols.map(Q).join(',')}) VALUES ${rows} ON CONFLICT (${pk.map(Q).join(',')}) ` + (upd.length ? `DO UPDATE SET ${upd.map(c => `${Q(c)}=EXCLUDED.${Q(c)}`).join(',')}` : 'DO NOTHING');
      },
      del: (t, pk) => `DELETE FROM ${T(t)} WHERE ${pk.map((c, i) => `${Q(c)}=$${i + 1}`).join(' AND ')}`,
      clear: t => `DELETE FROM ${T(t)}`,
      count: t => `SELECT COUNT(*) AS n FROM ${T(t)}`,
      close: () => pool.end().catch(() => {})
    };
  }
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ host: u.host, port: u.port, user: u.user, password: u.password, database: u.database, ssl: ssl || undefined, connectionLimit: 2, connectTimeout: 10000, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true });
  const Q = s => '`' + s + '`', T = t => Q(m.prefix + t);
  const TYPE = { int: 'BIGINT', real: 'DOUBLE', blob: 'LONGBLOB', text: 'LONGTEXT' }, PKTYPE = { int: 'BIGINT', real: 'DOUBLE', blob: 'VARBINARY(255)', text: 'VARCHAR(191)' };
  return {
    type: 'mysql', T,
    query: async (sql, p) => (await pool.query(sql, p))[0],
    tx: async fn => { const c = await pool.getConnection(); try { await c.beginTransaction(); const r = await fn(async (s, p) => (await c.query(s, p))[0]); await c.commit(); return r; } catch (e) { await c.rollback().catch(() => {}); throw e; } finally { c.release(); } },
    ph: () => '?',
    prepare: async () => {},
    columns: async (run, t) => new Set((await run('SELECT column_name AS c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=?', [m.prefix + t])).map(r => r.c)),
    create: (t, s) => `CREATE TABLE IF NOT EXISTS ${T(t)} (${s.cols.map(c => `${Q(c.name)} ${(c.pk ? PKTYPE : TYPE)[c.type]}${c.pk ? ' NOT NULL' : ''}`).join(', ')}, PRIMARY KEY (${s.pk.map(Q).join(', ')})) DEFAULT CHARSET=utf8mb4`,
    addCol: (t, c) => `ALTER TABLE ${T(t)} ADD COLUMN ${Q(c.name)} ${TYPE[c.type]}`,
    upsert: (t, cols, pk, n) => {
      const rows = Array.from({ length: n }, () => '(' + cols.map(() => '?').join(',') + ')').join(',');
      const upd = cols.filter(c => !pk.includes(c));
      return upd.length ? `INSERT INTO ${T(t)} (${cols.map(Q).join(',')}) VALUES ${rows} ON DUPLICATE KEY UPDATE ${upd.map(c => `${Q(c)}=VALUES(${Q(c)})`).join(',')}`
        : `INSERT IGNORE INTO ${T(t)} (${cols.map(Q).join(',')}) VALUES ${rows}`;
    },
    del: (t, pk) => `DELETE FROM ${T(t)} WHERE ${pk.map(c => `${Q(c)}=?`).join(' AND ')}`,
    clear: t => `DELETE FROM ${T(t)}`,
    count: t => `SELECT COUNT(*) AS n FROM ${T(t)}`,
    close: () => pool.end().catch(() => {})
  };
}
let drv = null, drvKey = '';
function driver(m) {
  const k = [m.url, m.ssl, m.schema, m.prefix].join('\u0000');
  if (!drv || drvKey !== k) { if (drv) drv.close(); drv = makeDriver(m); drvKey = k; known.clear(); }
  return drv;
}
function reset() { if (drv) drv.close(); drv = null; drvKey = ''; known.clear(); sig = ''; }

// remote table exists with every local column (new local columns are added remotely; nothing is ever dropped there)
const known = new Map();
async function ensureRemote(d, run, t) {
  const s = shape(t), k = s.cols.map(c => c.name + ':' + c.type).join(',');
  if (known.get(t) === k) return s;
  await d.prepare(run);
  let have = await d.columns(run, t);
  if (!have.size) { await run(d.create(t, s)); have = new Set(s.cols.map(c => c.name)); }
  for (const c of s.cols) if (!have.has(c.name)) await run(d.addCol(t, c));
  known.set(t, k);
  return s;
}
function val(v, type) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (type === 'int' && typeof v === 'string' && v !== '' && !/^-?\d+$/.test(v)) return null;   // SQLite lets text into an INTEGER column; a strict DB does not
  if (type === 'real' && typeof v === 'string' && !Number.isFinite(Number(v))) return null;
  if (type === 'text' && Buffer.isBuffer(v)) return v.toString('base64');
  if (type === 'blob' && typeof v === 'string') return Buffer.from(v);
  return v;
}
async function upsertRows(d, run, t, s, rows) {
  const cols = s.cols.map(c => c.name), per = Math.max(1, Math.floor(1000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    await run(d.upsert(t, cols, s.pk, part.length), part.flatMap(r => s.cols.map(c => val(r[c.name], c.type))));
  }
}

/* ---------- copying ---------- */
const CHUNK = 500;
async function copyTable(d, t) {
  let n = 0;
  await d.tx(async run => {
    const s = await ensureRemote(d, run, t);
    await run(d.clear(t));                                     // a full copy replaces what the mirror had (removes rows deleted while it was off)
    let last = null;
    const has = db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name='rowid'`).get();
    if (has) throw new Error(`table ${t} has a column named rowid`);
    for (;;) {
      const rows = db.prepare(`SELECT rowid AS __r, * FROM ${q(t)} ${last === null ? '' : 'WHERE rowid > ?'} ORDER BY rowid LIMIT ${CHUNK}`).all(...(last === null ? [] : [last]));
      if (!rows.length) break;
      last = rows[rows.length - 1].__r;
      await upsertRows(d, run, t, s, rows);
      n += rows.length; st.set('copied_rows', Number(st.get('copied_rows') || 0) + rows.length);
    }
  });
  return n;
}
async function drain(d, m, maxBatches = 20) {
  let applied = 0;
  for (let b = 0; b < maxBatches; b++) {
    const cursor = Number(st.get('cursor') || 0);
    const ch = db.prepare('SELECT id, tbl, pk FROM x_changes WHERE id > ? ORDER BY id LIMIT 1000').all(cursor);
    if (!ch.length) break;
    const by = new Map();                                      // table → Map(pk json → pk values): repeated edits of one row collapse into one write
    for (const c of ch) { if (m.exclude.includes(c.tbl) || !settings.IDENT.test(c.tbl)) continue; if (!by.has(c.tbl)) by.set(c.tbl, new Map()); by.get(c.tbl).set(c.pk, c.pk); }
    await d.tx(async run => {
      for (const [t, pks] of by) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) continue;   // the table itself was dropped
        const s = await ensureRemote(d, run, t);
        const get = db.prepare(`SELECT * FROM ${q(t)} WHERE ${s.pk.map(c => `${q(c)} IS ?`).join(' AND ')}`);
        const up = [];
        for (const pkJson of pks.keys()) {
          let key; try { key = JSON.parse(pkJson); } catch { continue; }
          if (!Array.isArray(key) || key.length !== s.pk.length) continue;
          const row = get.get(...key);
          if (row) up.push(row); else await run(d.del(t, s.pk), key.map((v, i) => val(v, s.cols.find(c => c.name === s.pk[i]).type)));
        }
        if (up.length) await upsertRows(d, run, t, s, up);
      }
    });
    const top = ch[ch.length - 1].id;
    db.transaction(() => { st.set('cursor', top); db.prepare('DELETE FROM x_changes WHERE id <= ?').run(top); })();
    applied += ch.length;
  }
  if (applied) st.set('applied_total', Number(st.get('applied_total') || 0) + applied);
  return applied;
}

/* ---------- the worker ---------- */
let running = false, timer = null, delay = 3000, copying = null;
async function tick() {
  if (running) return; running = true;
  try {
    const m = settings.mirror();
    if (!m.enabled) { if (sig || db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name LIKE 'xm\\_%' ESCAPE '\\'").get()) off(); return; }
    ensureTriggers(m);
    const d = driver(m);
    for (const t of queued()) {
      if (m.exclude.includes(t) || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) { st.set('copy_queue', JSON.stringify(queued().filter(x => x !== t))); continue; }
      copying = t; await copyTable(d, t); copying = null;
      st.set('copy_queue', JSON.stringify(queued().filter(x => x !== t)));
    }
    await drain(d, m);
    st.set('last_ok', Date.now()); st.set('last_error', ''); delay = 3000;
  } catch (e) {
    copying = null;
    st.set('last_error', String(e && e.message || e).replace(/postgres(ql)?:\/\/[^\s]+|mysql:\/\/[^\s]+/g, '(url)').slice(0, 300)); st.set('last_error_at', Date.now());
    delay = Math.min(delay * 2, 60000);                        // the external DB is down: back off, changes keep queueing safely
  } finally { running = false; }
}
function off() { dropTriggers(); db.prepare('DELETE FROM x_changes').run(); st.set('cursor', 0); st.set('copy_queue', '[]'); reset(); }
function start() {
  if (timer) return;
  const loop = async () => { await tick(); timer = setTimeout(loop, delay); timer.unref(); };
  timer = setTimeout(loop, 1000); timer.unref();
}
// (re)connect from scratch: used when the target changes or the owner asks for a full re-copy
function fullResync() {
  const m = settings.mirror(); if (!m.enabled) return;
  reset(); delay = 3000; ensureTriggers(m, true);
  queue(localTables(m).filter(t => shape(t).pk.length));
  st.set('copied_rows', 0);
}
async function runNow() { await tick(); }

function status() {
  const m = settings.mirror(), cursor = Number(st.get('cursor') || 0);
  const tables = m.enabled ? localTables(m) : [];
  return {
    enabled: m.enabled, type: m.type, hint: m.hint,
    pending: db.prepare('SELECT COUNT(*) n FROM x_changes WHERE id > ?').get(cursor).n,
    copy_queue: queued(), copying, copied_rows: Number(st.get('copied_rows') || 0), applied_total: Number(st.get('applied_total') || 0),
    last_ok: Number(st.get('last_ok') || 0) || null, last_error: st.get('last_error') || null, last_error_at: Number(st.get('last_error_at') || 0) || null,
    tables: tables.length, skipped_no_pk: tables.filter(t => !shape(t).pk.length)
  };
}
// table by table: rows here vs rows in the mirror (exact once the queue is empty)
async function compare() {
  const m = settings.mirror(); if (!m.enabled) return [];
  const d = driver(m), out = [];
  for (const t of localTables(m)) {
    const local = db.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n;
    let remote = null; try { remote = Number((await d.query(d.count(t)))[0].n); } catch { remote = null; }
    out.push({ table: t, local, remote });
  }
  return out;
}
// probe a connection without saving anything: connect, create + drop a scratch table
async function test(m) {
  const d = makeDriver(m), t0 = Date.now();
  try {
    const name = '_asveli_probe_' + Date.now();
    await d.tx(async run => { await d.prepare(run); await run(d.create(name, { cols: [{ name: 'id', type: 'int', pk: true }, { name: 'v', type: 'text' }], pk: ['id'] })); await run(d.upsert(name, ['id', 'v'], ['id'], 1), [1, 'ok']); await run(`DROP TABLE ${d.T(name)}`); });
    const ver = (await d.query('SELECT VERSION() AS v'))[0];
    return { ok: true, ms: Date.now() - t0, type: d.type, version: String(ver.v || ver.version || '').slice(0, 120) };
  } finally { d.close(); }
}
module.exports = { start, tick: runNow, status, compare, test, fullResync, off, reset };
