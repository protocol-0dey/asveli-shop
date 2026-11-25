'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
const db = new Database(path.join(cfg.dataDir, 'asveli.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE TABLE IF NOT EXISTS subscribers(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL, site TEXT NOT NULL, lang TEXT, created_at INTEGER NOT NULL,
  UNIQUE(email, site));
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  storage_key TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, public_slug TEXT UNIQUE,
  share_nonce TEXT NOT NULL, uploaded_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT, ip TEXT, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_sub_site ON subscribers(site, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
`);

/* ---- additive migrations (safe to run on every start; existing admins become 'owner') ---- */
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
const addCol = (t, c, def) => { if (!hasCol(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('users', 'role', "TEXT NOT NULL DEFAULT 'owner'");
addCol('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
addCol('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'last_login', 'INTEGER');
addCol('files', 'scope', "TEXT NOT NULL DEFAULT 'general'");   // 'general' | 'kyc' | 'finance' … gates who may see the file
db.exec(`
CREATE TABLE IF NOT EXISTS m_events(                           -- append-only business events (orders, price changes, refunds…): feeds analytics + fraud
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref_type TEXT, ref_id INTEGER, seller_id INTEGER, customer_id INTEGER, amount INTEGER, data TEXT);
CREATE INDEX IF NOT EXISTS idx_ev_kind_ts ON m_events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_ev_cust ON m_events(customer_id, ts);
CREATE TABLE IF NOT EXISTS reveals(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER NOT NULL, res TEXT, row_id INTEGER, field TEXT);
CREATE INDEX IF NOT EXISTS idx_rev_user ON reveals(user_id, ts);
`);

const getSetting = k => (db.prepare('SELECT v FROM settings WHERE k=?').get(k) || {}).v;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);

function audit(req, action, detail, who) {
  try {
    db.prepare('INSERT INTO audit(ts,user,ip,action,detail) VALUES(?,?,?,?,?)')
      .run(Date.now(), who || (req && req.user ? req.user.username : null), req ? req.ip : null, action, detail ? String(detail).slice(0, 300) : null);
  } catch (e) { console.error('audit failed', e.message); }
}

module.exports = { db, getSetting, setSetting, audit };
