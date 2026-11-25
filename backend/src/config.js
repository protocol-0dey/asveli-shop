'use strict';
const path = require('path');
const crypto = require('crypto');
const env = process.env;

const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const fatal = msg => { console.error('FATAL: ' + msg); process.exit(1); };
const prod = env.NODE_ENV === 'production';

/* ---- two separate listeners -------------------------------------------------------------
   PUBLIC  (PORT, behind nginx):  /api/subscribe, /f/<slug>, /s/<signed>, /api/health
   ADMIN   (ADMIN_PORT):          panel + admin API. Bound to loopback ONLY. It is never proxied
                                  by nginx and never exposed by Docker; you reach it through an
                                  SSH tunnel (or a VPN interface you explicitly allow). */
const port = Number(env.PORT) || 3000;
const adminPort = Number(env.ADMIN_PORT) || 3001;
const adminHost = env.ADMIN_HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

if (adminPort === port) fatal('ADMIN_PORT must differ from PORT: the admin panel must not share the public listener.');
if (!LOOPBACK.has(adminHost) && env.ADMIN_ALLOW_NONLOOPBACK !== '1')
  fatal(`ADMIN_HOST=${adminHost} would expose the admin panel beyond this machine. Use 127.0.0.1 (default) and an SSH tunnel.\n` +
        'Only inside Docker (where the host side is published on 127.0.0.1 in docker-compose.yml) set ADMIN_ALLOW_NONLOOPBACK=1.');

let secret = env.SESSION_SECRET || '';
if (secret.length < 32) {
  if (prod) fatal('SESSION_SECRET must be set (min 32 chars). Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  secret = crypto.randomBytes(32).toString('hex');           // dev: ephemeral, sessions die on restart
}
if (prod && !env.PUBLIC_BASE_URL) fatal('PUBLIC_BASE_URL must be set in production, e.g. https://api.asveli.com (it is used for public/shared file links).');

// Data key for PII at rest (card/passport/phone/address…). Separate from SESSION_SECRET so that rotating sessions never makes data unreadable.
let dataSecret = env.DATA_ENCRYPTION_KEY || '';
if (dataSecret.length < 32) {
  if (prod) fatal('DATA_ENCRYPTION_KEY must be set (min 32 chars) — it encrypts personal data at rest. Back it up: without it that data cannot be recovered.\n  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  dataSecret = secret;                                        // dev/test only
}
const key = (label, from = secret) => Buffer.from(crypto.hkdfSync('sha256', from, 'asveli-backend-v1', label, 32));

// AI layer: the provider is pluggable and can be changed at runtime in the admin (AI → Подключения); env values are the defaults.
// 'mock' (default) is deterministic and offline; 'gemini' = Google Gemini API; 'openai' = OpenAI or any OpenAI-compatible server (set a base URL);
// 'ollama' = native Ollama API. Endpoints come ONLY from env/settings (never from a request → no SSRF).
const AI_PRESETS = {
  mock:   { model: 'mock', embedModel: 'mock', imageModel: '' },
  gemini: { model: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', imageModel: 'gemini-2.5-flash-image' },
  openai: { model: 'gpt-4o-mini', embedModel: 'text-embedding-3-small', imageModel: 'gpt-image-1' },
  ollama: { model: 'qwen2.5:7b-instruct', embedModel: 'bge-m3', imageModel: '' }
};
const ai = {
  provider: env.AI_PROVIDER || 'mock',
  baseUrl: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: env.AI_API_KEY || '',
  model: env.AI_MODEL || '',
  embedModel: env.AI_EMBED_MODEL || '',
  imageModel: env.AI_IMAGE_MODEL || '',
  imageUrl: (env.AI_IMAGE_URL || '').replace(/\/+$/, ''),
  timeoutMs: Number(env.AI_TIMEOUT_MS) || 60000,
  dailyLimit: Number(env.AI_DAILY_LIMIT) || 2000,
  reviewConfidence: Number(env.AI_REVIEW_CONFIDENCE) || 85,
  allowPrivateHosts: env.AI_ALLOW_PRIVATE_HOSTS === '1'      // local Ollama / test servers; off by default so a settings page can never aim the server at the internal network
};
if (!AI_PRESETS[ai.provider]) fatal('AI_PROVIDER must be mock, gemini, openai or ollama.');
for (const k of ['model', 'embedModel', 'imageModel']) ai[k] = ai[k] || AI_PRESETS[ai.provider][k];

module.exports = {
  ai, AI_PRESETS,
  prod,
  port, host: env.HOST || '127.0.0.1',
  adminPort, adminHost,
  // Host-header allow-list for the admin listener (blocks DNS-rebinding: evil.com resolving to 127.0.0.1).
  adminHosts: new Set(['localhost', '127.0.0.1', '[::1]', ...list(env.ADMIN_ALLOWED_HOSTS).map(h => h.toLowerCase())]),
  adminIpAllow: list(env.ADMIN_IP_ALLOWLIST),                // optional extra filter by client IP (useful only with a VPN)
  dataDir: path.resolve(env.DATA_DIR || './data'),
  trustProxy: env.TRUST_PROXY === undefined ? 1 : Number(env.TRUST_PROXY),   // public listener only (one nginx hop)
  storeOrigins: [...list(env.STORE_ORIGINS), ...(prod ? [] : ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'])],   // browsers allowed to call /api/store and /api/seller
  publicOrigins: list(env.ALLOWED_ORIGINS),                  // the coming-soon sites allowed to POST /api/subscribe
  sites: list(env.SITES || 'asveli.pl,asveli.eu,asveli.com,asveli.shop'),
  baseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  // The admin listener is plain HTTP on loopback (an SSH tunnel provides the encryption). Set COOKIE_SECURE=1 only if
  // you front it with your own TLS (e.g. a VPN reverse proxy).
  cookieSecure: bool(env.COOKIE_SECURE, false),
  idleMs: 60 * 60 * 1000,
  absoluteMs: 12 * 60 * 60 * 1000,
  pendingMs: 5 * 60 * 1000,
  storageDriver: env.STORAGE_DRIVER || 'local',
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 1024) * 1024 * 1024,
  drive: {
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN, folderName: env.DRIVE_FOLDER_NAME || 'asveli-storage'
  },
  require2fa: bool(env.REQUIRE_2FA, prod),                  // staff without 2FA may not use business modules (production default: on)
  currency: (env.PLATFORM_CURRENCY || 'EUR').toUpperCase(),  // single platform currency; all money is integer minor units (cents)
  revealRateLimit: Number(env.REVEAL_RATE_LIMIT) || 20,      // PII reveals per user per hour
  keys: { links: key('share-links'), totp: key('totp-encryption'), data: key('pii-data', dataSecret), blind: key('pii-blind-index', dataSecret) }
};
