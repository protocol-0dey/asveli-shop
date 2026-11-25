'use strict';
const { db } = require('../db');
const { SQL_TYPE, isPii } = require('./fields');

const resources = new Map();       // name -> spec
const pages = [];                  // custom (non-CRUD) views contributed by modules: {id,label,group,perm}

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
function define(spec) {
  if (!IDENT.test(spec.name) || !IDENT.test(spec.table)) throw new Error('bad identifier ' + spec.name);
  for (const f of spec.fields) {
    if (!IDENT.test(f.k)) throw new Error('bad column ' + f.k);
    if (f.t === 'enum' && !f.vals) throw new Error('enum needs vals ' + f.k);
    if (f.t === 'ref' && !f.ref) throw new Error('ref needs target ' + f.k);
    if (isPii(f) && f.k === spec.title) throw new Error('title must not be PII');
  }
  resources.set(spec.name, Object.assign({ perm: spec.name, create: true, update: true, remove: false, search: [], filters: [], sort: 'id DESC', actions: {}, group: 'misc' }, spec));
}
// Tables are derived from the schema (identifiers come from code, never from requests).
function migrate() {
  for (const s of resources.values()) {
    const cols = s.fields.map(f => {
      const ref = f.t === 'ref' ? ` REFERENCES ${resources.get(f.ref).table}(id) ON DELETE RESTRICT` : '';
      const dflt = f.def !== undefined ? ` DEFAULT ${typeof f.def === 'number' ? f.def : `'${String(f.def).replace(/'/g, "''")}'`}` : '';
      const nn = f.notNull ? ' NOT NULL' : '';
      return `${f.k} ${SQL_TYPE[f.t]}${nn}${dflt}${ref}` + (f.blind ? `, ${f.k}_bi TEXT` : '');
    });
    db.exec(`CREATE TABLE IF NOT EXISTS ${s.table}(id INTEGER PRIMARY KEY, ${cols.join(', ')}, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT)`);
    // Additive migration: a new field on an existing deployment becomes an ALTER TABLE ADD COLUMN (never drops/renames anything).
    const have = new Set(db.prepare(`PRAGMA table_info(${s.table})`).all().map(c => c.name));
    for (const f of s.fields) {
      if (!have.has(f.k)) db.exec(`ALTER TABLE ${s.table} ADD COLUMN ${f.k} ${SQL_TYPE[f.t]}${f.def !== undefined ? ` DEFAULT ${typeof f.def === 'number' ? f.def : `'${String(f.def).replace(/'/g, "''")}'`}` : ''}`);
      if (f.blind && !have.has(f.k + '_bi')) db.exec(`ALTER TABLE ${s.table} ADD COLUMN ${f.k}_bi TEXT`);
    }
    for (const f of s.fields) {
      if (f.unique) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${s.table}_${f.k} ON ${s.table}(${f.blind ? f.k + '_bi' : f.k})`);
      else if (f.index || f.t === 'ref' || f.t === 'enum') db.exec(`CREATE INDEX IF NOT EXISTS ix_${s.table}_${f.k} ON ${s.table}(${f.k})`);
      if (f.blind && !f.unique) db.exec(`CREATE INDEX IF NOT EXISTS ix_${s.table}_${f.k}_bi ON ${s.table}(${f.k}_bi)`);
    }
    for (const sql of s.sql || []) db.exec(sql);               // extra constraints/indexes declared by the module
  }
}
module.exports = { resources, pages, define, migrate };
