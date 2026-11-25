'use strict';
// "Sign in with Google / GitHub / Amazon" for buyers: provider apps are configured in the admin (Интеграции → Вход покупателей), owner only.
// Client secrets are sealed with DATA_ENCRYPTION_KEY, write-only (never sent back, only "••••1234") and never written to the audit log.
// Env values are the defaults: OAUTH_GOOGLE_ID / OAUTH_GOOGLE_SECRET, OAUTH_GITHUB_ID / …_SECRET, OAUTH_AMAZON_ID / …_SECRET, STORE_URL.
const env = process.env;
const cfg = require('../config');
const { getSetting, setSetting } = require('../db');
const sec = require('../security');
const { E } = require('../engine/errors');

const PROVIDERS = {
  google: { name: 'Google', console: 'https://console.cloud.google.com/apis/credentials' },
  github: { name: 'GitHub', console: 'https://github.com/settings/developers' },
  amazon: { name: 'Amazon', console: 'https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html' }
};
const KEY = 'oauth.config';
const aad = p => 'settings:oauth.' + p + '.secret';
const stored = () => { try { return JSON.parse(getSetting(KEY) || '{}') || {}; } catch { return {}; } };
const open = (blob, a) => { try { return sec.open(blob, a); } catch { return ''; } };

// the shop the buyer is sent back to after signing in: must be one of STORE_ORIGINS (no open redirect)
function storeUrl(st = stored()) {
  const want = (st.storeUrl || env.STORE_URL || '').replace(/\/+$/, '');
  return want && cfg.storeOrigins.includes(want) ? want : cfg.storeOrigins[0] || '';
}
const redirectUri = p => `${cfg.baseUrl}/api/store/oauth/${p}/callback`;

function provider(p) {
  if (!PROVIDERS[p]) return null;
  const st = stored(), s = st[p] || {}, up = p.toUpperCase();
  const clientId = s.clientId !== undefined ? s.clientId : env[`OAUTH_${up}_ID`] || '';
  const clientSecret = s.secret ? open(s.secret, aad(p)) : (s.clientId !== undefined ? '' : env[`OAUTH_${up}_SECRET`] || '');
  const enabled = s.enabled !== undefined ? !!s.enabled : !!(clientId && clientSecret);
  return { id: p, name: PROVIDERS[p].name, clientId, clientSecret, enabled: enabled && !!clientId && !!clientSecret, redirectUri: redirectUri(p) };
}
const enabledList = () => Object.keys(PROVIDERS).map(provider).filter(x => x.enabled).map(x => ({ id: x.id, name: x.name }));

function save(patch) {
  const st = stored();
  for (const p of Object.keys(PROVIDERS)) {
    const b = patch[p]; if (!b || typeof b !== 'object') continue;
    const s = { ...(st[p] || {}) };
    if (b.clientId !== undefined) { const v = String(b.clientId).trim(); if (v && !/^[A-Za-z0-9._\-]{6,200}$/.test(v)) throw E.bad('invalid_client_id'); s.clientId = v; }
    if (b.clientSecret) { const v = String(b.clientSecret).trim(); if (v.length < 8 || v.length > 400 || /[\s\u0000-\u001f]/.test(v)) throw E.bad('invalid_client_secret'); s.secret = sec.seal(v, aad(p)); s.hint = v.slice(-4); }
    if (b.enabled !== undefined) s.enabled = !!b.enabled;
    st[p] = s;
  }
  if (patch.storeUrl !== undefined) {
    const v = String(patch.storeUrl).trim().replace(/\/+$/, '');
    if (v && !cfg.storeOrigins.includes(v)) throw E.bad('store_url_not_allowed');       // only a shop listed in STORE_ORIGINS
    st.storeUrl = v;
  }
  setSetting(KEY, JSON.stringify(st));
  return view();
}
function clearSecret(p) { if (!PROVIDERS[p]) throw E.notFound(); const st = stored(); if (st[p]) { delete st[p].secret; delete st[p].hint; } setSetting(KEY, JSON.stringify(st)); return view(); }

function view() {
  const st = stored();
  return {
    store_url: storeUrl(st), store_origins: cfg.storeOrigins, public_base: cfg.baseUrl,
    providers: Object.keys(PROVIDERS).map(p => {
      const x = provider(p), s = st[p] || {}, up = p.toUpperCase();
      return { id: p, name: x.name, console: PROVIDERS[p].console, clientId: x.clientId, enabled: x.enabled, configured_enabled: s.enabled !== undefined ? !!s.enabled : null,
        has_secret: !!x.clientSecret, secret_hint: s.secret ? '••••' + (s.hint || '') : env[`OAUTH_${up}_SECRET`] && s.clientId === undefined ? '(из окружения сервера)' : null, redirect_uri: x.redirectUri };
    })
  };
}
module.exports = { PROVIDERS, provider, enabledList, storeUrl, save, clearSecret, view };
