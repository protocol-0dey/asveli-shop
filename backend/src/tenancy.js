'use strict';
// Multi-tenancy. Tenant = organisation (m_orgs); a "workspace" is a store of that organisation (m_sellers row, seller_id).
// Every tenant-owned table (any table with a seller_id column) also carries org_id, and the DATABASE keeps the two consistent:
//   * on insert org_id is filled from the seller; an explicit org_id that disagrees with the seller is rejected;
//   * org_id and seller_id can never be moved to another organisation afterwards.
// Application queries additionally filter by org_id (see routes/seller.js), so a bug in one layer is not enough to leak a row.
const { db } = require('./db');

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
const SKIP = new Set(['m_sellers']);

function tenantTables() {
  const out = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'm\\_%' ESCAPE '\\' OR name='s_seller_accounts')").all()) {
    if (SKIP.has(name) || !IDENT.test(name)) continue;
    if (db.prepare(`PRAGMA table_info(${name})`).all().some(c => c.name === 'seller_id')) out.push(name);
  }
  return out;
}

function apply() {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tn_sellers_org_ai AFTER INSERT ON m_sellers WHEN NEW.org_id IS NULL BEGIN
      INSERT INTO m_orgs(name, created_at, updated_at, created_by) VALUES(NEW.name, NEW.created_at, NEW.updated_at, 'tenancy');
      UPDATE m_sellers SET org_id = last_insert_rowid() WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS tn_sellers_org_bu BEFORE UPDATE OF org_id ON m_sellers
      WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id BEGIN SELECT RAISE(ABORT, 'tenant_immutable'); END;`);
  // legacy rows (created before orgs existed): one organisation per store
  for (const s of db.prepare('SELECT id, name FROM m_sellers WHERE org_id IS NULL').all()) {
    const o = db.prepare("INSERT INTO m_orgs(name, created_at, updated_at, created_by) VALUES(?,?,?,'tenancy')").run(s.name, Date.now(), Date.now());
    db.prepare('UPDATE m_sellers SET org_id=? WHERE id=?').run(o.lastInsertRowid, s.id);
  }
  const done = [];
  for (const t of tenantTables()) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'org_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN org_id INTEGER REFERENCES m_orgs(id)`);
    db.exec(`UPDATE ${t} SET org_id=(SELECT org_id FROM m_sellers WHERE m_sellers.id=${t}.seller_id) WHERE org_id IS NULL AND seller_id IS NOT NULL`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS ix_${t}_org ON ${t}(org_id, seller_id);
      CREATE TRIGGER IF NOT EXISTS tn_${t}_bi BEFORE INSERT ON ${t}
        WHEN NEW.seller_id IS NOT NULL AND NEW.org_id IS NOT NULL AND NEW.org_id IS NOT (SELECT org_id FROM m_sellers WHERE id=NEW.seller_id)
        BEGIN SELECT RAISE(ABORT, 'tenant_mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS tn_${t}_ai AFTER INSERT ON ${t}
        WHEN NEW.org_id IS NULL AND NEW.seller_id IS NOT NULL
        BEGIN UPDATE ${t} SET org_id=(SELECT org_id FROM m_sellers WHERE id=NEW.seller_id) WHERE rowid=NEW.rowid; END;
      CREATE TRIGGER IF NOT EXISTS tn_${t}_bu BEFORE UPDATE OF org_id, seller_id ON ${t}
        WHEN (OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id)
          OR (OLD.org_id IS NULL AND NEW.org_id IS NOT NULL AND NEW.org_id IS NOT (SELECT org_id FROM m_sellers WHERE id=NEW.seller_id))
          OR (OLD.org_id IS NOT NULL AND NEW.seller_id IS NOT OLD.seller_id AND NEW.seller_id IS NOT NULL
              AND (SELECT org_id FROM m_sellers WHERE id=NEW.seller_id) IS NOT OLD.org_id)
        BEGIN SELECT RAISE(ABORT, 'tenant_immutable'); END;`);
    done.push(t);
  }
  return done;
}
module.exports = { apply, tenantTables };
