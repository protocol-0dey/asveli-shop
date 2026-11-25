'use strict';
// Shopify connection settings: edited in the admin (Интеграции → Shopify), owner only, no code or .env change needed.
// Secrets (Admin API token or the app's client secret) are sealed with DATA_ENCRYPTION_KEY, are write-only (never sent back to the
// browser, only "••••1234"), and every change is audited without the secret value. Env values are the defaults.
const env = process.env;
const { getSetting, setSetting } = require('../db');
const sec = require('../security');
const { E } = require('../engine/errors');

const KEY = 'shopify.config';
const AAD = { token: 'settings:shopify.token', secret: 'settings:shopify.client_secret' };
const DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const VERSION = /^20\d\d-(01|04|07|10)$/;
const DEFAULT_VERSION = '2026-10';

const ENV = {
  domain: (env.SHOPIFY_STORE_DOMAIN || '').trim().toLowerCase(),
  apiVersion: env.SHOPIFY_API_VERSION || DEFAULT_VERSION,
  token: env.SHOPIFY_ADMIN_TOKEN || '',
  clientId: env.SHOPIFY_CLIENT_ID || '',
  clientSecret: env.SHOPIFY_CLIENT_SECRET || ''
};

function stored() { try { return JSON.parse(getSetting(KEY) || '{}') || {}; } catch { return {}; } }
const open = (blob, aad) => { try { return sec.open(blob, aad); } catch { return ''; } };     // unreadable (data key changed) → "no secret", never a crash

// The effective configuration used by the client and the sync engine. Server-side only: it contains the secrets.
function current() {
  const st = stored();
  const domain = st.domain || ENV.domain;
  const token = st.token ? open(st.token, AAD.token) : (st.domain ? '' : ENV.token);
  const clientId = st.clientId !== undefined ? st.clientId : ENV.clientId;
  const clientSecret = st.clientSecret ? open(st.clientSecret, AAD.secret) : (st.clientId !== undefined ? '' : ENV.clientSecret);
  const authMode = st.authMode || (token ? 'token' : clientId ? 'client' : 'token');
  return {
    domain, apiVersion: st.apiVersion || ENV.apiVersion, authMode, token, clientId, clientSecret,
    locationId: st.locationId || '',                   // Shopify location that receives our stock numbers
    warehouseId: st.warehouseId || null,               // our warehouse whose stock is sent (null = sum of all warehouses)
    importSellerId: st.importSellerId || null,         // products created in the Shopify admin are imported under this seller
    rate: st.rate || '',                               // 1 unit of PLATFORM_CURRENCY = rate units of the shop currency (only when they differ)
    autoPush: st.autoPush !== false,                   // a change saved here is sent to Shopify automatically
    pollMinutes: Number.isInteger(st.pollMinutes) ? st.pollMinutes : 5,   // how often changes made in the Shopify admin are pulled (0 = only by hand)
    translations: st.translations !== false,           // verified translations (pl/ru/de) are registered as Shopify translations
    enabled: !!domain && (authMode === 'token' ? !!token : !!(clientId && clientSecret))
  };
}

const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw E.bad('invalid_' + name); return n; };
const secret = (v, name) => { if (typeof v !== 'string' || v.length < 8 || v.length > 400 || /[\s\u0000-\u001f]/.test(v)) throw E.bad('invalid_' + name); return v; };

function save(patch) {
  const st = stored(), next = { ...st };
  if (patch.domain !== undefined) {
    let d = String(patch.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (d && !d.includes('.')) d += '.myshopify.com';                    // "asveli-x" → "asveli-x.myshopify.com"
    if (d && !DOMAIN.test(d)) throw E.bad('invalid_shop_domain');       // only *.myshopify.com: the API host is never taken from free text (no SSRF)
    if (d !== (st.domain || '')) { next.domain = d; delete next.locationId; }
  }
  if (patch.apiVersion !== undefined) { if (patch.apiVersion && !VERSION.test(patch.apiVersion)) throw E.bad('invalid_api_version'); next.apiVersion = patch.apiVersion || undefined; }
  if (patch.authMode !== undefined) { if (!['token', 'client'].includes(patch.authMode)) throw E.bad('invalid_auth_mode'); next.authMode = patch.authMode; }
  if (patch.token) { next.token = sec.seal(secret(patch.token, 'token'), AAD.token); next.token_hint = patch.token.slice(-4); }
  if (patch.clientId !== undefined) { if (patch.clientId && !/^[A-Za-z0-9]{16,64}$/.test(patch.clientId)) throw E.bad('invalid_client_id'); next.clientId = patch.clientId; }
  if (patch.clientSecret) { next.clientSecret = sec.seal(secret(patch.clientSecret, 'client_secret'), AAD.secret); next.secret_hint = patch.clientSecret.slice(-4); }
  if (patch.locationId !== undefined) { if (patch.locationId && !/^gid:\/\/shopify\/Location\/\d{1,20}$/.test(patch.locationId)) throw E.bad('invalid_location'); next.locationId = patch.locationId; }
  if (patch.warehouseId !== undefined) next.warehouseId = patch.warehouseId === null || patch.warehouseId === '' ? null : int(patch.warehouseId, 1, 1e12, 'warehouse');
  if (patch.importSellerId !== undefined) next.importSellerId = patch.importSellerId === null || patch.importSellerId === '' ? null : int(patch.importSellerId, 1, 1e12, 'seller');
  if (patch.rate !== undefined) {
    const r = String(patch.rate).trim().replace(',', '.');
    if (r && (!/^\d{1,6}(\.\d{1,6})?$/.test(r) || Number(r) <= 0)) throw E.bad('invalid_rate');
    next.rate = r;
  }
  if (patch.autoPush !== undefined) next.autoPush = !!patch.autoPush;
  if (patch.translations !== undefined) next.translations = !!patch.translations;
  if (patch.pollMinutes !== undefined) next.pollMinutes = int(patch.pollMinutes, 0, 1440, 'poll_minutes');
  setSetting(KEY, JSON.stringify(next));
  return view();
}
function clearSecrets() { const st = stored(); for (const k of ['token', 'token_hint', 'clientSecret', 'secret_hint']) delete st[k]; setSetting(KEY, JSON.stringify(st)); return view(); }
// Small non-secret state the sync engine keeps next to the settings (last pull cursor etc.)
const STATE = 'shopify.state';
const state = () => { try { return JSON.parse(getSetting(STATE) || '{}') || {}; } catch { return {}; } };
const setState = patch => setSetting(STATE, JSON.stringify({ ...state(), ...patch }));

function view() {
  const c = current(), st = stored();
  const hint = (blob, h, envVal) => (blob ? '••••' + (h || '') : envVal ? '(из окружения сервера)' : null);
  return {
    domain: c.domain, apiVersion: c.apiVersion, authMode: c.authMode, clientId: c.clientId,
    token_hint: hint(st.token, st.token_hint, !st.domain && ENV.token), secret_hint: hint(st.clientSecret, st.secret_hint, st.clientId === undefined && ENV.clientSecret),
    has_token: !!c.token, has_secret: !!c.clientSecret,
    locationId: c.locationId, warehouseId: c.warehouseId, importSellerId: c.importSellerId, rate: c.rate,
    autoPush: c.autoPush, pollMinutes: c.pollMinutes, translations: c.translations, enabled: c.enabled, default_version: DEFAULT_VERSION
  };
}
module.exports = { current, save, clearSecrets, view, state, setState, DOMAIN };
