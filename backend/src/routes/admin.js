'use strict';
const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const QRCode = require('qrcode');
const cfg = require('../config');
const { db, audit } = require('../db');
const sec = require('../security');
const auth = require('../auth');
const getStorage = require('../storage');
const { sendFile } = require('../serve');
const { can, permsOf, ROLES } = require('../iam/permissions');
const { E } = require('../engine/errors');

const router = express.Router();
const bad = (res, code = 400, error = 'bad_request') => res.status(code).json({ error });
const FILE_ID = /^[a-f0-9]{32}$/;

// Invisible / direction-override characters are removed ("invoice\u202Egnp.exe" would display as "invoiceexe.png"); path and shell-ish characters become "_".
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const safeName = n => String(n || 'file').normalize('NFC').replace(INVISIBLE, '').replace(/[\\/\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 180) || 'file';
const intParam = (v, def, min, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min ? Math.min(n, max) : def; };
const safeMime = m => (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(m) && m.length <= 100 ? m.toLowerCase() : 'application/octet-stream');

const publicFile = f => ({
  id: f.id, name: f.name, mime: f.mime, size: f.size, created_at: f.created_at, uploaded_by: f.uploaded_by,
  is_public: !!f.is_public, scope: f.scope,
  public_url: f.is_public ? `${cfg.baseUrl}/f/${f.public_slug}/${encodeURIComponent(f.name)}` : null
});

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/* ---- session ---- */
router.post('/auth/login', auth.login);
router.post('/auth/login2fa', auth.login2fa);
router.post('/auth/logout', auth.logout);

router.get('/me', auth.requireAuth, (req, res) =>
  res.json({ username: req.user.username, role: req.user.role, role_label: ROLES[req.user.role] ? ROLES[req.user.role].label : req.user.role, perms: permsOf(req.user),
    csrf: req.session.csrf, totp_enabled: !!req.user.totp_enabled, must_change_password: !!req.user.must_change_password,
    require_2fa: cfg.require2fa, storage: getStorage().name, sites: cfg.sites, currency: cfg.currency }));

/* everything below needs a fully authenticated session */
router.use(auth.requireAuth);

const need = perm => (req, _res, next) => (can(req.user, perm) ? next() : next(E.forbidden()));
// Gate: until a temporary password is replaced (and, when REQUIRE_2FA is on, 2FA is enabled) nothing but the account-security endpoints works.
router.use((req, res, next) => {
  if (req.path.startsWith('/security/')) return next();
  if (req.user.must_change_password) return bad(res, 403, 'password_change_required');
  if (cfg.require2fa && !req.user.totp_enabled) return bad(res, 403, '2fa_required');
  next();
});

/* ---- dashboard ---- */
let usageCache = { at: 0, v: null };
router.get('/stats', need('analytics.read'), async (_req, res, next) => {
  try {
    const week = Date.now() - 7 * 864e5;
    const bySite = Object.fromEntries(cfg.sites.map(s => [s, { total: 0, week: 0 }]));
    for (const r of db.prepare('SELECT site, COUNT(*) c, SUM(created_at>?) w FROM subscribers GROUP BY site').all(week))
      bySite[r.site] = { total: r.c, week: r.w || 0 };
    const f = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM files').get();
    if (Date.now() - usageCache.at > 60000) {
      try { usageCache = { at: Date.now(), v: await getStorage().usage() }; } catch (e) { usageCache = { at: Date.now(), v: { error: 'unavailable' } }; }
    }
    res.json({ subscribers: bySite, files: { count: f.c, bytes: f.s }, storage: { driver: getStorage().name, ...usageCache.v } });
  } catch (e) { next(e); }
});

/* ---- subscribers ---- */
function subQuery(q) {
  const where = [], args = [];
  if (q.site) { where.push('site=?'); args.push(String(q.site)); }
  if (q.q) { where.push("email LIKE ? ESCAPE '\\'"); args.push('%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 100) + '%'); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
router.get('/subscribers', need('subscribers.read'), (req, res) => {
  const { sql, args } = subQuery(req.query);
  const limit = intParam(req.query.limit, 50, 1, 200), offset = intParam(req.query.offset, 0, 0, 1e9);   // LIMIT -1 would mean "no limit" in SQLite
  const total = db.prepare(`SELECT COUNT(*) c FROM subscribers ${sql}`).get(...args).c;
  const rows = db.prepare(`SELECT id,email,site,lang,created_at FROM subscribers ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ total, rows });
});
router.get('/subscribers.csv', need('subscribers.read'), (req, res) => {
  const { sql, args } = subQuery(req.query);
  const cell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };   // CSV-injection safe
  const rows = db.prepare(`SELECT email,site,lang,created_at FROM subscribers ${sql} ORDER BY id`).all(...args);
  audit(req, 'export_subscribers', `${rows.length} rows`);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"' });
  res.send('\ufeffemail,site,lang,created_at\n' + rows.map(r => [r.email, r.site, r.lang, new Date(r.created_at).toISOString()].map(cell).join(',')).join('\n') + '\n');
});
router.delete('/subscribers/:id', need('subscribers.write'), auth.csrfGuard, (req, res) => {
  const id = Number(req.params.id); if (!Number.isInteger(id)) return bad(res);
  const r = db.prepare('DELETE FROM subscribers WHERE id=?').run(id);
  audit(req, 'delete_subscriber', String(id));
  res.json({ deleted: r.changes });
});

/* ---- files ---- */
const scopeOk = (user, scope) => (scope === 'general' ? can(user, 'files.read') : can(user, 'files.' + scope));
router.get('/files', need('files.read'), (req, res) =>
  res.json({ rows: db.prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT 500').all().filter(f => scopeOk(req.user, f.scope)).map(publicFile) }));

router.post('/files', need('files.write'), auth.csrfGuard, (req, res) => {
  const scope = req.query.scope === undefined ? 'general' : String(req.query.scope);
  if (!['general', 'kyc'].includes(scope)) return bad(res, 400, 'invalid_scope');
  if (scope !== 'general' && !can(req.user, 'files.' + scope)) return bad(res, 403, 'forbidden');
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return bad(res, 415, 'unsupported_media_type');
  let bb;
  try { bb = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 4, fieldSize: 1024, fileSize: cfg.maxUploadBytes + 1 } }); }
  catch { return bad(res); }
  let settled = false, gotFile = false, fileStream = null;
  const reply = (code, body) => { if (settled) return; settled = true; if (code >= 400) res.set('Connection', 'close'); res.status(code).json(body); };

  bb.on('file', (_field, stream, info) => {
    if (gotFile) { stream.resume(); return; }
    gotFile = true; fileStream = stream;
    const name = safeName(info.filename), mime = safeMime(info.mimeType);
    getStorage().put(stream, { maxBytes: cfg.maxUploadBytes, mime, name }).then(({ key, size }) => {
      const row = { id: crypto.randomBytes(16).toString('hex'), name, mime, size, storage_key: key, is_public: 0, public_slug: null,
        share_nonce: sec.token(12), uploaded_by: req.user.username, created_at: Date.now(), scope };
      db.prepare('INSERT INTO files(id,name,mime,size,storage_key,is_public,public_slug,share_nonce,uploaded_by,created_at,scope) VALUES(@id,@name,@mime,@size,@storage_key,@is_public,@public_slug,@share_nonce,@uploaded_by,@created_at,@scope)').run(row);
      audit(req, 'upload', `${name} (${size} B)`);
      reply(201, publicFile(row));
    }).catch(e => {
      if (e.code !== 'ABORTED') console.error('upload failed:', e.code || '', e.message);
      reply(e.code === 'LIMIT' ? 413 : 500, { error: e.code === 'LIMIT' ? 'file_too_large' : 'upload_failed' });
    });
  });
  bb.on('close', () => { if (!gotFile) reply(400, { error: 'no_file' }); });
  bb.on('error', () => reply(400, { error: 'bad_upload' }));
  // A client that disconnects mid-upload never ends the form, so without this the file stream would hang forever,
  // leaking a file descriptor and a partial blob (or a half-sent Drive upload). Destroying it makes put() clean up.
  req.on('close', () => {
    if (req.complete) return;
    const err = Object.assign(new Error('client aborted the upload'), { code: 'ABORTED' });
    if (fileStream && !fileStream.destroyed) fileStream.destroy(err);
    bb.destroy();
  });
  req.pipe(bb);
});

const loadFile = (req, res, next) => {
  if (!FILE_ID.test(req.params.id)) return bad(res, 404, 'not_found');
  req.file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!req.file || !can(req.user, 'files.read') || !scopeOk(req.user, req.file.scope)) return bad(res, 404, 'not_found');   // no access → looks like it doesn't exist
  next();
};
const sharable = (req, res, next) => (req.file.scope === 'general' ? next() : bad(res, 403, 'kyc_files_are_private'));    // identity documents can never get a public/shared link

router.get('/files/:id/download', loadFile, async (req, res, next) => {
  try { audit(req, 'download', req.file.name); await sendFile(req, res, req.file, { inline: false }); } catch (e) { next(e); }
});

router.patch('/files/:id', need('files.write'), auth.csrfGuard, loadFile, (req, res) => {
  const b = req.body || {}, f = req.file;
  if (typeof b.name === 'string') db.prepare('UPDATE files SET name=? WHERE id=?').run(safeName(b.name), f.id);
  if (typeof b.is_public === 'boolean' && f.scope !== 'general') return bad(res, 403, 'kyc_files_are_private');
  if (typeof b.is_public === 'boolean') {
    const slug = b.is_public ? (f.public_slug || sec.token(16)) : f.public_slug;
    db.prepare('UPDATE files SET is_public=?, public_slug=? WHERE id=?').run(b.is_public ? 1 : 0, slug, f.id);
    audit(req, b.is_public ? 'publish_file' : 'unpublish_file', f.name);
  }
  res.json(publicFile(db.prepare('SELECT * FROM files WHERE id=?').get(f.id)));
});

router.post('/files/:id/share', need('files.write'), auth.csrfGuard, loadFile, sharable, (req, res) => {
  const ttl = Math.min(Math.max(Number((req.body || {}).ttl) || 3600, 60), 30 * 86400);
  const exp = Date.now() + ttl * 1000;
  audit(req, 'create_share_link', `${req.file.name}, ${ttl}s`);
  res.json({ url: `${cfg.baseUrl}/s/${sec.signLink(req.file.id, req.file.share_nonce, exp)}`, expires_at: exp });
});
router.post('/files/:id/revoke', need('files.write'), auth.csrfGuard, loadFile, (req, res) => {       // new nonce → every old signed link dies
  db.prepare('UPDATE files SET share_nonce=? WHERE id=?').run(sec.token(12), req.file.id);
  audit(req, 'revoke_links', req.file.name); res.json({ ok: true });
});

router.delete('/files/:id', need('files.write'), auth.csrfGuard, loadFile, async (req, res, next) => {
  try {
    await getStorage().delete(req.file.storage_key);
    db.prepare('DELETE FROM files WHERE id=?').run(req.file.id);
    audit(req, 'delete_file', req.file.name); res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---- account security ---- */
router.post('/security/password', auth.csrfGuard, async (req, res) => {
  const { current, next: np } = req.body || {};
  if (typeof current !== 'string' || typeof np !== 'string' || np.length < 12 || np.length > 256 || np.toLowerCase().includes(req.user.username) || np === current) return bad(res, 400, 'weak_password');
  if (!(await sec.verifyPassword(current, req.user.pass_hash))) { audit(req, 'password_change_failed'); return bad(res, 401, 'invalid_credentials'); }
  db.prepare('UPDATE users SET pass_hash=?, must_change_password=0 WHERE id=?').run(await sec.hashPassword(np), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND id_hash<>?').run(req.user.id, req.sessionId);   // sign out everywhere else
  audit(req, 'password_changed'); res.json({ ok: true });
});

router.post('/security/2fa/setup', auth.csrfGuard, async (req, res) => {
  if (req.user.totp_enabled) return bad(res, 409, 'already_enabled');
  const secret = sec.newTotpSecret();
  db.prepare('UPDATE users SET totp_secret_enc=? WHERE id=?').run(sec.encrypt(secret), req.user.id);
  const uri = sec.totpUri(secret, req.user.username);
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});
router.post('/security/2fa/enable', auth.csrfGuard, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u.totp_secret_enc || u.totp_enabled) return bad(res, 409, 'not_in_setup');
  const step = sec.totpVerify(sec.decrypt(u.totp_secret_enc), (req.body || {}).code, 0);
  if (step === null) return bad(res, 401, 'invalid_code');
  db.prepare('UPDATE users SET totp_enabled=1, totp_last=? WHERE id=?').run(step, u.id);
  audit(req, '2fa_enabled'); res.json({ ok: true });
});
router.post('/security/2fa/disable', auth.csrfGuard, async (req, res) => {
  const { password, code } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u.totp_enabled) return bad(res, 409, 'not_enabled');
  const step = typeof password === 'string' && (await sec.verifyPassword(password, u.pass_hash)) ? sec.totpVerify(sec.decrypt(u.totp_secret_enc), code, u.totp_last) : null;
  if (step === null) { audit(req, '2fa_disable_failed'); return bad(res, 401, 'invalid_credentials'); }
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret_enc=NULL, totp_last=0 WHERE id=?').run(u.id);
  audit(req, '2fa_disabled'); res.json({ ok: true });
});

/* ---- audit log ---- */
router.get('/audit', need('audit.read'), (req, res) => {
  const limit = intParam(req.query.limit, 100, 1, 500);
  res.json({ rows: db.prepare('SELECT ts,user,ip,action,detail FROM audit ORDER BY id DESC LIMIT ?').all(limit) });
});

router.use(require('./staff'));
router.use(require('./modules'));

module.exports = router;
