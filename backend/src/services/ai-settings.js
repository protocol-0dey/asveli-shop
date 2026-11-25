'use strict';
// Runtime AI connection settings: edited in the admin (AI → Подключения), no code or env change needed.
// The API key is sealed (AES-256-GCM, DATA_ENCRYPTION_KEY) in the settings table, is write-only (never sent back to any client, only
// "••••1234"), and only roles with `ai.settings` (owner) can touch it. Every change is audited without the key value.
const dns = require('dns').promises, net = require('net');
const { ai: cfg, AI_PRESETS } = require('../config');
const { getSetting, setSetting } = require('../db');
const sec = require('../security');
const { E } = require('../engine/errors');
const catalog = require('./ai-catalog');

const KEY = 'ai.config', AAD = 'settings:ai.api_key';
const ENV = { ...cfg };                                       // what env says; settings override it, "reset" returns to it
const FIELDS = ['service', 'provider', 'baseUrl', 'model', 'embedModel', 'imageModel', 'timeoutMs', 'dailyLimit', 'reviewConfidence'];

function stored() { try { return JSON.parse(getSetting(KEY) || '{}') || {}; } catch { return {}; } }
function apply() {
  const st = stored();
  Object.assign(cfg, ENV); cfg.service = null;
  for (const f of FIELDS) if (st[f] !== undefined && st[f] !== null && st[f] !== '') cfg[f] = st[f];
  if (st.provider && st.provider !== ENV.provider) { cfg.baseUrl = st.baseUrl || ''; for (const k of ['model', 'embedModel', 'imageModel']) cfg[k] = st[k] || AI_PRESETS[st.provider][k]; }
  for (const k of ['model', 'embedModel', 'imageModel']) cfg[k] = cfg[k] || AI_PRESETS[cfg.provider][k];
  cfg.apiKey = ENV.apiKey;
  if (st.key) { try { cfg.apiKey = sec.open(st.key, AAD); } catch { cfg.apiKey = ''; } }     // unreadable (data key changed) → treated as "no key", never a crash
  return cfg;
}

const isPrivateIp = ip => {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    // the URL parser rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1, so mapped addresses are decoded from hex; any other "::…" (compatible, loopback, unspecified) and NAT64 are reserved
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    if (l.startsWith('::ffff:') && l.includes('.')) return isPrivateIp(l.slice(7));
    return l.startsWith('::') || l.startsWith('64:ff9b') || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
// A base URL typed into a web form is the classic SSRF vector. https only, no credentials, and the host must not resolve to a private/loopback/metadata address
// (unless the operator set AI_ALLOW_PRIVATE_HOSTS=1 in the server env, e.g. for Ollama on the same machine).
async function checkBaseUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw E.bad('invalid_base_url'); }
  if (raw.length > 200 || u.username || u.password || u.search || u.hash) throw E.bad('invalid_base_url');
  if (cfg.allowPrivateHosts ? !['http:', 'https:'].includes(u.protocol) : u.protocol !== 'https:') throw E.bad('base_url_must_be_https');
  if (!cfg.allowPrivateHosts) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addrs; try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch { throw E.bad('base_url_unresolvable'); }
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw E.bad('base_url_private_host');
  }
  return raw.replace(/\/+$/, '');
}

const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw E.bad('invalid_' + name); return n; };
const word = (v, name, max = 80) => { if (typeof v !== 'string' || !/^[A-Za-z0-9._:\/-]{1,80}$/.test(v) || v.length > max) throw E.bad('invalid_' + name); return v; };

async function save(patch) {
  const st = stored(), next = { ...st };
  // a ready-made service from the catalog: fixed address, sensible default models; each service remembers its own key
  if (patch.service !== undefined) {
    const svc = catalog.byId(patch.service); if (!svc) throw E.bad('invalid_service');
    const was = catalog.serviceOf({ ...cfg, ...st }).id;
    next.service = svc.id; next.provider = svc.kind;
    if (svc.base) next.baseUrl = svc.kind === 'gemini' ? '' : svc.base; else if (svc.id !== was) next.baseUrl = '';
    if (svc.id !== was) {
      for (const k of ['model', 'embedModel', 'imageModel']) if (patch[k] === undefined) next[k] = svc[k];
      next.keys = { ...(st.keys || {}) };
      if (st.key) next.keys[was] = { key: st.key, hint: st.key_hint };              // park the old service's key
      const k = next.keys[svc.id]; if (k) { next.key = k.key; next.key_hint = k.hint; } else { delete next.key; delete next.key_hint; }
    }
    delete patch.provider;
    if (svc.base && svc.kind !== 'gemini') delete patch.baseUrl;                         // the catalog address is fixed
  }
  if (patch.provider !== undefined) { if (!AI_PRESETS[patch.provider]) throw E.bad('invalid_provider'); next.provider = patch.provider; if (patch.service === undefined) delete next.service; }
  const provider = next.provider || cfg.provider;
  for (const k of ['model', 'embedModel', 'imageModel']) if (patch[k] !== undefined) next[k] = patch[k] === '' ? '' : word(patch[k], k);
  const fixed = next.service && catalog.byId(next.service) && catalog.byId(next.service).base;
  if (patch.baseUrl !== undefined && !fixed && !(provider === 'gemini' && !cfg.allowPrivateHosts)) next.baseUrl = patch.baseUrl === '' ? '' : await checkBaseUrl(String(patch.baseUrl));
  if (provider === 'gemini' && !cfg.allowPrivateHosts) next.baseUrl = '';            // Gemini has one fixed official host
  if (provider === 'mock') next.baseUrl = '';
  if (patch.timeoutMs !== undefined) next.timeoutMs = int(patch.timeoutMs, 3000, 180000, 'timeout');
  if (patch.dailyLimit !== undefined) next.dailyLimit = int(patch.dailyLimit, 1, 1e6, 'daily_limit');
  if (patch.reviewConfidence !== undefined) next.reviewConfidence = int(patch.reviewConfidence, 1, 100, 'review_confidence');
  if (patch.apiKey !== undefined && patch.apiKey !== '') {
    if (typeof patch.apiKey !== 'string' || patch.apiKey.length < 8 || patch.apiKey.length > 400 || /[\s\u0000-\u001f]/.test(patch.apiKey)) throw E.bad('invalid_api_key');
    next.key = sec.seal(patch.apiKey, AAD); next.key_hint = patch.apiKey.slice(-4);
    if (next.service) next.keys = { ...(next.keys || {}), [next.service]: { key: next.key, hint: next.key_hint } };
  }
  setSetting(KEY, JSON.stringify(next));
  apply();
}
function clearKey() { const st = stored(); if (st.keys && st.service) delete st.keys[st.service]; delete st.key; delete st.key_hint; setSetting(KEY, JSON.stringify(st)); apply(); }
function reset() { setSetting(KEY, '{}'); apply(); }

function view() {
  const st = stored();
  return {
    service: catalog.serviceOf({ ...cfg, service: st.service }).id, services: catalog.pub(), saved_keys: Object.keys(st.keys || {}).concat(st.key && st.service ? [st.service] : []).filter((x, i, a) => a.indexOf(x) === i),
    provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, embedModel: cfg.embedModel, imageModel: cfg.imageModel,
    timeoutMs: cfg.timeoutMs, dailyLimit: cfg.dailyLimit, reviewConfidence: cfg.reviewConfidence,
    has_key: !!cfg.apiKey, key_hint: st.key ? '••••' + (st.key_hint || '') : (ENV.apiKey ? '(из окружения сервера)' : null), key_source: st.key ? 'settings' : ENV.apiKey ? 'env' : null,
    base_url_editable: cfg.provider !== 'gemini' || cfg.allowPrivateHosts, allow_private_hosts: cfg.allowPrivateHosts,
    presets: Object.fromEntries(Object.entries(AI_PRESETS).map(([k, v]) => [k, { ...v, needs_key: k === 'gemini' || k === 'openai', needs_url: k === 'ollama' }])),
    overridden: Object.keys(st).filter(k => !['key', 'key_hint', 'keys'].includes(k))
  };
}
// the saved key of a catalog service (the active one or one parked earlier); used to list its models without retyping the key
function keyFor(service) {
  const st = stored();
  if ((st.service || catalog.serviceOf(cfg).id) === service) return cfg.apiKey || '';
  const k = (st.keys || {})[service]; if (!k) return '';
  try { return sec.open(k.key, AAD); } catch { return ''; }
}
module.exports = { keyFor, apply, save, clearKey, reset, view, checkBaseUrl, isPrivateIp };
