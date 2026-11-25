'use strict';
// Storefront tables + additive migrations. Runs after the admin registry has created the m_* tables.
const { db } = require('../db');

const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
const addCol = (t, c, def) => { if (!hasCol(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };

// existing databases (created before the storefront existed) get the new product columns
addCol('m_products', 'model_slug', 'TEXT');
addCol('m_products', 'brand', 'TEXT');
addCol('m_products', 'images', 'TEXT');
addCol('m_products', 'digital', 'INTEGER DEFAULT 0');
addCol('m_products', 'digital_file', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS s_accounts(                 -- buyer accounts (login); personal data lives in m_customers (sealed)
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL UNIQUE REFERENCES m_customers(id),
  email_bi TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, lang TEXT,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS s_seller_accounts(          -- seller logins (Seller Central); the business record is m_sellers
  id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL UNIQUE REFERENCES m_sellers(id),
  email_bi TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS s_tokens(                   -- opaque bearer tokens; only the SHA-256 is stored
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_s_tokens_exp ON s_tokens(expires_at);
CREATE TABLE IF NOT EXISTS s_views(                    -- browsing history → personalised storefront (pseudonymous anon id until login)
  id INTEGER PRIMARY KEY, account_id INTEGER, anon TEXT, product_id INTEGER NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_s_views_acc ON s_views(account_id, ts);
CREATE INDEX IF NOT EXISTS ix_s_views_anon ON s_views(anon, ts);
CREATE INDEX IF NOT EXISTS ix_s_views_prod ON s_views(product_id, ts);
CREATE TABLE IF NOT EXISTS s_idem(                     -- checkout idempotency: a double click never makes two orders
  key TEXT NOT NULL, account_id INTEGER NOT NULL, order_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(key, account_id));
CREATE TABLE IF NOT EXISTS s_models(                   -- optional curated model data (title/brand/description/images of the shared product page)
  slug TEXT PRIMARY KEY, title TEXT NOT NULL, brand TEXT, category TEXT, description TEXT, images TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS s_ad_events(                -- ad impressions/clicks (aggregated into m_campaigns by the ad service)
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, kind TEXT NOT NULL, who TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_s_ad_who ON s_ad_events(campaign_id, who, ts);
`);
db.exec('CREATE INDEX IF NOT EXISTS ix_m_products_model ON m_products(model_slug)');
