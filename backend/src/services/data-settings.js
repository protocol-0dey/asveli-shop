'use strict';
// "Данные и бэкапы" settings (owner only, `secrets.data`): the external SQL mirror and the backup schedule / S3 destination.
// Passwords (DB connection URL, backup passphrase, S3 secret key) are sealed with DATA_ENCRYPTION_KEY, write-only, never logged.
const { getSetting, setSetting } = require('../db');
const sec = require('../security');
const { E } = require('../engine/errors');

const KEY = 'data.config';
const AAD = { url: 'settings:data.mirror.url', pass: 'settings:data.backup.passphrase', s3: 'settings:data.backup.s3secret' };
// never mirrored: admin staff accounts (password hashes, 2FA secrets), login sessions / one-time tokens (short-lived secrets, useless in a copy) and the mirror's own bookkeeping
const ALWAYS_EXCLUDED = ['users', 'sessions', 's_tokens', 's_oauth_states', 's_oauth_codes', 's_idem', 'x_changes', 'x_mirror_state'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const stored = () => { try { return JSON.parse(getSetting(KEY) || '{}') || {}; } catch { return {}; } };
const open = (blob, aad) => { try { return blob ? sec.open(blob, aad) : ''; } catch { return ''; } };

function parseUrl(u) {
  let x; try { x = new URL(u); } catch { throw E.bad('invalid_db_url'); }
  const proto = x.protocol.replace(':', '');
  const type = { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql' }[proto];
  if (!type || !x.hostname || !x.pathname || x.pathname === '/') throw E.bad('invalid_db_url');
  return { type, host: x.hostname, port: Number(x.port) || (type === 'postgres' ? 5432 : 3306), user: decodeURIComponent(x.username), password: decodeURIComponent(x.password),
    database: decodeURIComponent(x.pathname.slice(1)), hint: `${proto}://${x.username ? decodeURIComponent(x.username) + (x.password ? ':••••' : '') + '@' : ''}${x.host}${x.pathname}` };
}

function mirror(st = stored()) {
  const m = st.mirror || {}, url = open(m.url, AAD.url);
  return { enabled: !!m.enabled && !!url, url, type: m.type || null, hint: m.hint || null, schema: m.schema || 'public', prefix: m.prefix || '', ssl: m.ssl || 'off',
    exclude: [...new Set([...(m.exclude || []), ...ALWAYS_EXCLUDED])], userExclude: m.exclude || [] };
}
function backup(st = stored()) {
  const b = st.backup || {}, s3 = b.s3 || {};
  return { enabled: !!b.enabled, everyHours: b.everyHours || 24, keepLocal: b.keepLocal || 14, passphrase: open(b.passphrase, AAD.pass),
    s3: { enabled: !!s3.enabled, endpoint: s3.endpoint || '', region: s3.region || 'auto', bucket: s3.bucket || '', prefix: s3.prefix || 'asveli/', accessKeyId: s3.accessKeyId || '', secret: open(s3.secret, AAD.s3) } };
}

function save(patch) {
  const st = stored();
  if (patch.mirror) {
    const p = patch.mirror, m = { ...(st.mirror || {}) };
    if (p.url !== undefined && p.url !== '') { const u = parseUrl(String(p.url).trim()); m.url = sec.seal(String(p.url).trim(), AAD.url); m.type = u.type; m.hint = u.hint; }
    if (p.schema !== undefined) { if (!IDENT.test(p.schema)) throw E.bad('invalid_schema'); m.schema = p.schema; }
    if (p.prefix !== undefined) { if (p.prefix && !/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(p.prefix)) throw E.bad('invalid_prefix'); m.prefix = p.prefix; }
    if (p.ssl !== undefined) { if (!['off', 'require', 'no-verify'].includes(p.ssl)) throw E.bad('invalid_ssl'); m.ssl = p.ssl; }
    if (p.exclude !== undefined) { const ex = (Array.isArray(p.exclude) ? p.exclude : String(p.exclude).split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean); if (ex.some(x => !IDENT.test(x))) throw E.bad('invalid_table_name'); m.exclude = [...new Set(ex)].slice(0, 200); }
    if (p.enabled !== undefined) { if (p.enabled && !m.url) throw E.bad('mirror_url_required'); m.enabled = !!p.enabled; }
    st.mirror = m;
  }
  if (patch.backup) {
    const p = patch.backup, b = { ...(st.backup || {}) }, s3 = { ...(b.s3 || {}) };
    if (p.enabled !== undefined) b.enabled = !!p.enabled;
    if (p.everyHours !== undefined) { const n = Number(p.everyHours); if (!Number.isInteger(n) || n < 1 || n > 24 * 7) throw E.bad('invalid_interval'); b.everyHours = n; }
    if (p.keepLocal !== undefined) { const n = Number(p.keepLocal); if (!Number.isInteger(n) || n < 1 || n > 365) throw E.bad('invalid_keep'); b.keepLocal = n; }
    if (p.passphrase !== undefined && p.passphrase !== '') { const v = String(p.passphrase); if (v.length < 12 || v.length > 200) throw E.bad('weak_passphrase'); b.passphrase = sec.seal(v, AAD.pass); }
    if (p.clearPassphrase) delete b.passphrase;
    const q = p.s3 || {};
    if (q.endpoint !== undefined) { const v = String(q.endpoint).trim().replace(/\/+$/, ''); if (v) { let x; try { x = new URL(v); } catch { throw E.bad('invalid_s3_endpoint'); } if (x.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && x.protocol === 'http:')) throw E.bad('invalid_s3_endpoint'); } s3.endpoint = v; }
    if (q.region !== undefined) { if (!/^[a-z0-9-]{2,30}$/.test(q.region)) throw E.bad('invalid_s3_region'); s3.region = q.region; }
    if (q.bucket !== undefined) { if (q.bucket && !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(q.bucket)) throw E.bad('invalid_s3_bucket'); s3.bucket = q.bucket; }
    if (q.prefix !== undefined) { if (!/^[A-Za-z0-9._\-/]{0,100}$/.test(q.prefix)) throw E.bad('invalid_s3_prefix'); s3.prefix = q.prefix; }
    if (q.accessKeyId !== undefined) { if (q.accessKeyId && !/^[A-Za-z0-9+/=_-]{8,128}$/.test(q.accessKeyId)) throw E.bad('invalid_s3_key'); s3.accessKeyId = q.accessKeyId; }
    if (q.secret) { const v = String(q.secret).trim(); if (v.length < 8 || v.length > 200 || /\s/.test(v)) throw E.bad('invalid_s3_secret'); s3.secret = sec.seal(v, AAD.s3); s3.hint = v.slice(-4); }
    if (q.enabled !== undefined) { if (q.enabled && !(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secret)) throw E.bad('s3_incomplete'); s3.enabled = !!q.enabled; }
    b.s3 = s3; st.backup = b;
  }
  setSetting(KEY, JSON.stringify(st));
}
function clearMirrorUrl() { const st = stored(); if (st.mirror) { delete st.mirror.url; delete st.mirror.hint; st.mirror.enabled = false; } setSetting(KEY, JSON.stringify(st)); }

function view() {
  const st = stored(), m = mirror(st), b = backup(st), s3 = (st.backup || {}).s3 || {};
  return {
    mirror: { enabled: m.enabled, configured: !!m.url, type: m.type, hint: m.hint, schema: m.schema, prefix: m.prefix, ssl: m.ssl, exclude: m.userExclude, always_excluded: ALWAYS_EXCLUDED },
    backup: { enabled: b.enabled, everyHours: b.everyHours, keepLocal: b.keepLocal, has_passphrase: !!b.passphrase,
      s3: { enabled: b.s3.enabled, endpoint: b.s3.endpoint, region: b.s3.region, bucket: b.s3.bucket, prefix: b.s3.prefix, accessKeyId: b.s3.accessKeyId, secret_hint: s3.secret ? '••••' + (s3.hint || '') : null } }
  };
}
module.exports = { mirror, backup, save, clearMirrorUrl, view, parseUrl, ALWAYS_EXCLUDED, IDENT };
