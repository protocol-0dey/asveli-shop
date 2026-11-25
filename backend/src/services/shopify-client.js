'use strict';
// Minimal Shopify Admin GraphQL client. The endpoint is always https://<shop>.myshopify.com/admin/api/<version>/graphql.json,
// built from a validated *.myshopify.com domain (never from a request), so the settings page cannot aim the server anywhere else.
// Auth: an Admin API access token (shpat_…, apps created in the Shopify admin before 2026) or the client-credentials grant of a
// Dev Dashboard app installed on the store (client ID + secret → 24 h token, refreshed automatically).
const settings = require('./shopify-settings');
const { HttpError, E } = require('../engine/errors');

const TEST_ENDPOINT = process.env.NODE_ENV === 'test' ? (process.env.SHOPIFY_TEST_ENDPOINT || '') : '';   // tests point at a fake Shopify; ignored outside NODE_ENV=test
const TIMEOUT = Number(process.env.SHOPIFY_TIMEOUT_MS) || 30000;
let cached = null;                                   // { key, token, exp } for the client-credentials grant
const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = c => TEST_ENDPOINT || `https://${c.domain}`;
const fail = (code, detail) => new HttpError(502, code, detail ? { detail: String(detail).slice(0, 300) } : undefined);

async function request(url, init) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT);
  try { return await fetch(url, { ...init, signal: ctl.signal, redirect: 'error' }); }
  catch (e) { throw fail(e.name === 'AbortError' ? 'shopify_timeout' : 'shopify_unreachable', e.cause ? e.cause.code || e.cause.message : e.message); }
  finally { clearTimeout(t); }
}

async function accessToken(c) {
  if (c.authMode === 'token') { if (!c.token) throw E.conflict('shopify_not_configured'); return c.token; }
  if (!c.clientId || !c.clientSecret) throw E.conflict('shopify_not_configured');
  const key = c.domain + '|' + c.clientId;
  if (cached && cached.key === key && cached.exp > Date.now() + 60e3) return cached.token;
  const res = await request(`${base(c)}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }).toString()
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw fail(res.status === 400 || res.status === 401 ? 'shopify_auth_failed' : 'shopify_token_failed', j.error_description || j.error || res.status);
  cached = { key, token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope || '' };
  return cached.token;
}
const forget = () => { cached = null; };

// One GraphQL call with retries for throttling (429 / THROTTLED) and transient 5xx. Returns `data`; userErrors are left to the caller.
async function gql(query, variables = {}, { tries = 5 } = {}) {
  const c = settings.current();
  if (!c.domain) throw E.conflict('shopify_not_configured');
  for (let attempt = 1; ; attempt++) {
    const token = await accessToken(c);
    const res = await request(`${base(c)}/admin/api/${c.apiVersion}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables })
    });
    if (res.status === 401 || res.status === 403) {
      if (c.authMode === 'client' && attempt === 1) { forget(); continue; }       // a revoked/expired client-credentials token: get a new one once
      const j = await res.json().catch(() => ({}));
      throw fail(res.status === 401 ? 'shopify_auth_failed' : 'shopify_forbidden', j.errors || res.status);
    }
    if (res.status === 404) throw fail('shopify_not_found', `API ${c.apiVersion} / ${c.domain}`);
    if ((res.status === 429 || res.status >= 500) && attempt < tries) { await sleep(Math.min(8000, (Number(res.headers.get('retry-after')) || 2 ** attempt * 0.5) * 1000)); continue; }
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw fail('shopify_http_' + res.status);
    if (j.errors && j.errors.length) {
      const throttled = j.errors.some(e => e.extensions && e.extensions.code === 'THROTTLED');
      if (throttled && attempt < tries) {
        const st = j.extensions && j.extensions.cost && j.extensions.cost.throttleStatus;
        const need = (j.extensions && j.extensions.cost && j.extensions.cost.requestedQueryCost) || 100;
        await sleep(st && st.restoreRate ? Math.min(10000, Math.ceil(Math.max(0, need - st.currentlyAvailable) / st.restoreRate) * 1000 + 250) : 2000);
        continue;
      }
      const denied = j.errors.find(e => e.extensions && e.extensions.code === 'ACCESS_DENIED');
      if (denied) throw fail('shopify_scope_missing', denied.message);
      throw fail('shopify_graphql_error', j.errors.map(e => e.message).join('; '));
    }
    return j.data;
  }
}
const scopes = () => (cached && cached.scope) || '';
module.exports = { gql, forget, scopes };
