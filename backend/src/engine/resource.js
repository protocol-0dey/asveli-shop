'use strict';
const { db, audit } = require('../db');
const { resources } = require('./registry');
const { coerce, isPii } = require('./fields');
const { E } = require('./errors');
const { can } = require('../iam/permissions');
const pii = require('../iam/pii');
const sec = require('../security');

const get = name => { const s = resources.get(name); if (!s) throw E.notFound('unknown_resource'); return s; };
const like = q => '%' + String(q).replace(/[\\%_]/g, c => '\\' + c) + '%';
const colsOf = s => ['id', ...s.fields.map(f => f.k), 'created_at', 'updated_at', 'created_by'];

function need(user, perm) { if (!can(user, perm)) throw E.forbidden(); }
const rowFilter = (s, user) => (s.rowFilter ? s.rowFilter(user) : null);

// What a client may see: PII fields are masked here, always. Sealed blobs and blind indexes never leave the server.
function present(s, row, user) {
  const out = { id: row.id, created_at: row.created_at, updated_at: row.updated_at, created_by: row.created_by };
  for (const f of s.fields) {
    if (isPii(f)) { out[f.k] = row[f.k] == null ? null : pii.maskValue(f.pii || 'generic', safeOpen(s, f, row)); continue; }
    out[f.k] = row[f.k];
    if (f.t === 'ref') out[f.k + '__label'] = row[f.k + '__label'] ?? null;
  }
  if (s.present) s.present(out, row, user);
  return out;
}
function safeOpen(s, f, row) { try { return pii.open(row[f.k], pii.aad(s.table, f.k, row.id)); } catch { return ''; } }

function selectSql(s) {
  const extra = s.fields.filter(f => f.t === 'ref').map(f => {
    const t = get(f.ref); return t.title ? `, (SELECT ${t.title} FROM ${t.table} WHERE id = r.${f.k}) AS ${f.k}__label` : '';
  }).join('');
  return `SELECT r.*${extra} FROM ${s.table} r`;
}

function list(name, user, query = {}) {
  const s = get(name); need(user, s.perm + '.read');
  const where = [], args = [];
  const rf = rowFilter(s, user); if (rf) { where.push(rf.sql); args.push(...rf.args); }
  for (const k of s.filters) {
    if (query[k] === undefined || query[k] === '') continue;
    const f = s.fields.find(x => x.k === k);
    let v = String(query[k]);
    if (['int', 'money', 'bps', 'ref', 'bool'].includes(f.t)) { v = Number(v === 'true' ? 1 : v === 'false' ? 0 : v); if (!Number.isSafeInteger(v)) throw E.bad('invalid_filter'); }
    else if (f.t === 'enum' && !f.vals.includes(v)) throw E.bad('invalid_filter');
    where.push(`r.${k} = ?`); args.push(v);
  }
  if (query.q) {
    const q = String(query.q).slice(0, 100), ors = [];
    for (const k of s.search) { ors.push(`r.${k} LIKE ? ESCAPE '\\'`); args.push(like(q)); }
    for (const f of s.fields.filter(x => x.blind)) { ors.push(`r.${f.k}_bi = ?`); args.push(pii.blindIndex(q)); }   // exact lookup by e-mail/phone without decrypting anything
    if (/^\d{1,12}$/.test(q)) { ors.push('r.id = ?'); args.push(Number(q)); }
    if (ors.length) where.push('(' + ors.join(' OR ') + ')'); else where.push('0');
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200), page = Math.max(parseInt(query.page, 10) || 1, 1);
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sortKey = colsOf(s).includes(query.sort) && !s.fields.find(f => f.k === query.sort && isPii(f)) ? query.sort : null;
  const order = sortKey ? `r.${sortKey} ${query.dir === 'asc' ? 'ASC' : 'DESC'}` : s.sort.replace(/\b(\w+)\b/, 'r.$1');
  const total = db.prepare(`SELECT COUNT(*) c FROM ${s.table} r${w}`).get(...args).c;
  const rows = db.prepare(`${selectSql(s)}${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
  return { total, page, limit, rows: rows.map(r => present(s, r, user)) };
}

function raw(s, id, user) {
  const rf = user ? rowFilter(s, user) : null;
  const row = db.prepare(`${selectSql(s)} WHERE r.id = ?${rf ? ' AND ' + rf.sql : ''}`).get(id, ...(rf ? rf.args : []));
  if (!row) throw E.notFound();
  return row;
}
const getOne = (name, id, user) => { const s = get(name); need(user, s.perm + '.read'); return present(s, raw(s, id, user), user); };

// Validates + normalises a payload; `internal` lets services write read-only (ro) fields.
function build(s, body, { partial, internal, user }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.bad('invalid_body');
  const known = new Set(s.fields.map(f => f.k));
  for (const k of Object.keys(body)) if (!known.has(k)) throw E.bad('unknown_field');
  const data = {};
  for (const f of s.fields) {
    if (f.ro && !internal) { if (body[f.k] !== undefined) throw E.bad('read_only_' + f.k); if (!partial && f.def !== undefined) data[f.k] = f.def; continue; }
    if (body[f.k] === undefined) { if (!partial) { if (f.def !== undefined) data[f.k] = f.def; else if (f.req) throw E.bad('required_' + f.k); } continue; }
    if (!internal && f.perm && !can(user, f.perm)) throw E.forbidden('field_forbidden_' + f.k);          // some fields need their own right (risk tier, commission…)
    if (!internal && partial && f.immutable) throw E.bad('immutable_' + f.k);
    data[f.k] = coerce(f, body[f.k]);
    if (f.t === 'ref' && data[f.k] != null) {
      if (!db.prepare(`SELECT 1 FROM ${get(f.ref).table} WHERE id=?`).get(data[f.k])) throw E.bad('invalid_' + f.k);
    }
  }
  return data;
}

function writeRow(s, id, data, now) {
  const sets = [], args = [];
  for (const [k, v] of Object.entries(data)) {
    const f = s.fields.find(x => x.k === k);
    if (isPii(f)) {
      sets.push(`${k} = ?`); args.push(v == null ? null : pii.seal(v, pii.aad(s.table, k, id)));
      if (f.blind) { sets.push(`${k}_bi = ?`); args.push(v == null ? null : pii.blindIndex(v)); }
    } else { sets.push(`${k} = ?`); args.push(v); }
  }
  sets.push('updated_at = ?'); args.push(now);
  db.prepare(`UPDATE ${s.table} SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}
const wrapDb = fn => { try { return fn(); } catch (e) {
  if (e && /UNIQUE constraint/.test(e.message || '')) throw E.conflict('duplicate');
  if (e && /FOREIGN KEY constraint/.test(e.message || '')) throw E.conflict('in_use');
  throw e; } };

function create(name, user, body, req, opts = {}) {
  const internal = !!opts.internal;
  const s = get(name); if (!internal) { need(user, s.perm + '.write'); if (!s.create) throw E.forbidden('create_disabled'); }
  const data = build(s, body, { partial: false, internal, user });
  if (s.validate) s.validate(data, user, null, internal);
  const now = Date.now();
  const id = wrapDb(() => db.transaction(() => {
    const plain = {}, piiData = {};
    for (const [k, v] of Object.entries(data)) (isPii(s.fields.find(f => f.k === k)) ? piiData : plain)[k] = v;
    const keys = Object.keys(plain);
    const r = db.prepare(`INSERT INTO ${s.table}(${[...keys, 'created_at', 'updated_at', 'created_by'].join(',')}) VALUES(${[...keys, 'x', 'y', 'z'].map(() => '?').join(',')})`)
      .run(...keys.map(k => plain[k]), now, now, user ? user.username : 'system');
    const rid = Number(r.lastInsertRowid);
    if (Object.keys(piiData).length) writeRow(s, rid, piiData, now);           // sealed after we know the row id (it is part of the AAD)
    if (s.afterCreate) s.afterCreate(rid, data, user, opts);
    return rid;
  })());
  if (!internal) audit(req, `${s.name}.create`, `#${id}`, user && user.username);
  return present(s, raw(s, id), user);
}

function update(name, id, user, body, req, opts = {}) {
  const internal = !!opts.internal;
  const s = get(name); if (!internal) { need(user, s.perm + '.write'); if (!s.update) throw E.forbidden('update_disabled'); }
  const before = raw(s, id, internal ? null : user);
  if (s.lockedWhen && !internal && s.lockedWhen(before)) throw E.conflict('locked');
  const data = build(s, body, { partial: true, internal, user });
  if (!Object.keys(data).length) throw E.bad('nothing_to_update');
  if (s.validate) s.validate(data, user, before, internal);
  wrapDb(() => db.transaction(() => { writeRow(s, id, data, Date.now()); if (s.afterUpdate) s.afterUpdate(id, data, before, user, internal, opts); })());
  if (!internal) audit(req, `${s.name}.update`, `#${id} ${Object.keys(data).join(',')}`, user && user.username);   // field NAMES only, never values (they may be personal data)
  return present(s, raw(s, id), user);
}

function remove(name, id, user, req) {
  const s = get(name); need(user, s.perm + '.delete'); if (!s.remove) throw E.forbidden('delete_disabled');
  raw(s, id, user);
  wrapDb(() => db.prepare(`DELETE FROM ${s.table} WHERE id=?`).run(id));
  audit(req, `${s.name}.delete`, `#${id}`, user.username);
  return { ok: true };
}

async function runAction(name, id, action, user, body, req) {
  const s = get(name), a = s.actions[action];
  if (!a || !Object.prototype.hasOwnProperty.call(s.actions, action)) throw E.notFound('unknown_action');
  need(user, a.perm);
  const row = raw(s, id, user);
  const result = await a.run({ row, body: body || {}, user, req, update: (data) => update(name, id, user, data, req, { internal: true }) });
  audit(req, `${s.name}.${action}`, `#${id}`, user.username);
  return result === undefined ? present(s, raw(s, id), user) : result;
}

// Showing a personal value in clear: permission + password re-entry + hourly cap + audit row. Returns the plaintext once.
async function reveal(name, id, field, user, password, req, cfg) {
  const s = get(name); need(user, s.perm + '.read'); need(user, 'pii.reveal');
  const f = s.fields.find(x => x.k === field && isPii(x)); if (!f) throw E.bad('not_pii_field');
  const row = raw(s, id, user);
  const fails = db.prepare("SELECT COUNT(*) c FROM audit WHERE user=? AND action='pii.reveal_denied' AND ts>?").get(user.username, Date.now() - 15 * 60e3).c;
  if (fails >= 5) throw new (require('./errors').HttpError)(429, 'too_many_reveals');          // a hijacked session cannot brute-force the password here
  const used = db.prepare('SELECT COUNT(*) c FROM reveals WHERE user_id=? AND ts>?').get(user.id, Date.now() - 3600e3).c;
  if (used >= cfg.revealRateLimit) { audit(req, 'pii.reveal_limited', `${s.name}#${id}.${field}`, user.username); throw new (require('./errors').HttpError)(429, 'too_many_reveals'); }
  const u = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(user.id);
  if (typeof password !== 'string' || !(await sec.verifyPassword(password, u.pass_hash))) { audit(req, 'pii.reveal_denied', `${s.name}#${id}.${field}`, user.username); throw E.forbidden('password_required'); }
  db.prepare('INSERT INTO reveals(ts,user_id,res,row_id,field) VALUES(?,?,?,?,?)').run(Date.now(), user.id, s.name, id, field);
  audit(req, 'pii.reveal', `${s.name}#${id}.${field}`, user.username);
  return { value: row[field] == null ? null : safeOpen(s, f, row) };
}

function options(name, user, q) {
  const s = get(name); need(user, s.perm + '.read');
  if (!s.title) throw E.bad('no_title');
  const rf = rowFilter(s, user);
  const where = [rf ? rf.sql : '1=1']; const args = rf ? [...rf.args] : [];
  if (q) { where.push(`${s.title} LIKE ? ESCAPE '\\'`); args.push(like(String(q).slice(0, 60))); }
  return db.prepare(`SELECT id, ${s.title} AS label FROM ${s.table} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 30`).all(...args);
}

// Schema description for the UI: only what this user may see.
function meta(user) {
  const out = [];
  for (const s of resources.values()) {
    if (!can(user, s.perm + '.read')) continue;
    out.push({
      name: s.name, label: s.label, group: s.group, title: s.title, list: s.list || s.fields.filter(f => !isPii(f) && f.t !== 'longtext').slice(0, 6).map(f => f.k),
      search: s.search.length > 0 || s.fields.some(f => f.blind), filters: s.filters,
      can: { create: s.create && can(user, s.perm + '.write'), update: s.update && can(user, s.perm + '.write'), remove: s.remove && can(user, s.perm + '.delete'), reveal: can(user, 'pii.reveal') },
      fields: s.fields.map(f => ({ k: f.k, label: f.label || f.k, t: f.t, req: !!f.req, ro: !!f.ro, vals: f.vals, ref: f.ref, pii: f.pii, max: f.max, min: f.min, hint: f.hint, fmt: f.fmt })),
      actions: Object.entries(s.actions).filter(([, a]) => can(user, a.perm)).map(([k, a]) => ({ k, label: a.label || k, confirm: !!a.confirm, fields: a.fields || [] }))
    });
  }
  return out;
}
module.exports = { get, list, getOne, create, update, remove, runAction, reveal, options, meta, raw, present, need };
