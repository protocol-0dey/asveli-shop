'use strict';
// Admin API keys — for programs and AI agents (Antigravity, Claude, Cursor, scripts) that manage the shop through the REST API
// (/api/admin/...) or the MCP endpoint (/mcp). A key acts with the permissions of the ROLE chosen when it was created, minus
// everything secret: keys can never read or change secrets (API keys, passwords, payment/AI settings), staff accounts or
// account security, and cannot reveal personal data. Only the SHA-256 of a key is stored; the key itself is shown once.
const crypto = require('crypto');
const { db } = require('../db');
const { ROLES } = require('./permissions');
const { E } = require('../engine/errors');

db.exec(`CREATE TABLE IF NOT EXISTS x_api_keys(id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, last_used INTEGER, last_ip TEXT, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER)`);
// sub-agents: a key made by another key (the AI manager) — parent_id, and a written brief (its job description)
for (const col of ['parent_id INTEGER', 'brief TEXT']) { try { db.exec(`ALTER TABLE x_api_keys ADD COLUMN ${col}`); } catch { /* exists */ } }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = /^asv_[A-Za-z0-9_-]{43}$/;

function create({ name, role, days, parent_id = null, brief = null }, by) {
  name = String(name || '').trim();
  if (!/^[\p{L}\p{N} ._-]{2,60}$/u.test(name)) throw E.bad('invalid_key_name');
  if (!ROLES[role]) throw E.bad('invalid_role');
  const d = days == null || days === '' ? null : Number(days);
  if (d != null && (!Number.isInteger(d) || d < 1 || d > 3650)) throw E.bad('invalid_days');
  const token = 'asv_' + crypto.randomBytes(32).toString('base64url');
  let exp = d ? Date.now() + d * 864e5 : null;
  if (parent_id) { const p = db.prepare('SELECT expires_at FROM x_api_keys WHERE id=?').get(parent_id); if (p && p.expires_at && (!exp || exp > p.expires_at)) exp = p.expires_at; }   // never outlives its parent
  const r = db.prepare('INSERT INTO x_api_keys(name,prefix,hash,role,created_by,created_at,expires_at,parent_id,brief) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(name, token.slice(0, 10), sha(token), role, by, Date.now(), exp, parent_id, brief ? String(brief).slice(0, 4000) : null);
  return { ...get(Number(r.lastInsertRowid)), token };          // the only time the key is ever returned
}
const pub = k => k && ({ id: k.id, name: k.name, prefix: k.prefix, role: k.role, role_label: ROLES[k.role] ? ROLES[k.role].label : k.role, created_by: k.created_by, created_at: k.created_at,
  parent_id: k.parent_id || null, brief: k.brief || null,
  expires_at: k.expires_at, last_used: k.last_used, last_ip: k.last_ip, uses: k.uses, revoked: !!k.revoked_at, expired: !!k.expires_at && k.expires_at < Date.now() });
const get = id => pub(db.prepare('SELECT * FROM x_api_keys WHERE id=?').get(id));
const list = () => db.prepare('SELECT * FROM x_api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC').all().map(pub);
// revoking a key also revokes the sub-agents it made
function revoke(id) {
  const now = Date.now(), r = db.prepare('UPDATE x_api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, id); if (!r.changes) throw E.notFound();
  db.prepare('UPDATE x_api_keys SET revoked_at=? WHERE parent_id=? AND revoked_at IS NULL').run(now, id);
  return get(id);
}
const children = parentId => db.prepare('SELECT * FROM x_api_keys WHERE parent_id=? ORDER BY revoked_at IS NOT NULL, created_at DESC').all(parentId).map(pub);
const raw = id => db.prepare('SELECT * FROM x_api_keys WHERE id=?').get(id);

// Authorization: Bearer asv_… → a user-like object for the RBAC layer, or null
function resolve(header, ip) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || '')); if (!m || !TOKEN.test(m[1])) return null;
  const k = db.prepare('SELECT * FROM x_api_keys WHERE hash=?').get(sha(m[1]));
  if (!k || k.revoked_at || (k.expires_at && k.expires_at < Date.now()) || !ROLES[k.role]) return null;
  if (k.parent_id) { const p = db.prepare('SELECT revoked_at, expires_at FROM x_api_keys WHERE id=?').get(k.parent_id); if (!p || p.revoked_at || (p.expires_at && p.expires_at < Date.now())) return null; }   // a sub-agent lives only while its parent does
  const now = Date.now();
  if (!k.last_used || now - k.last_used > 30000 || k.last_ip !== ip) db.prepare('UPDATE x_api_keys SET last_used=?, last_ip=?, uses=uses+1 WHERE id=?').run(now, ip || null, k.id);
  else db.prepare('UPDATE x_api_keys SET uses=uses+1 WHERE id=?').run(k.id);
  // owner away: the sales department key runs the store until the mode ends (services/delegate)
  const role = k.role === 'sales_manager' && require('../services/delegate').active() ? 'store_manager' : k.role;
  return { id: -k.id, username: 'api:' + k.name, role, active: 1, totp_enabled: 1, must_change_password: 0, apiKey: k.id, baseRole: k.role, parentKey: k.parent_id || null, delegate: role !== k.role };
}
module.exports = { create, list, get, revoke, resolve, children, raw };
