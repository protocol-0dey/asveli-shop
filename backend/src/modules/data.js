'use strict';
/* MODULE — "Данные и бэкапы" (owner only: `secrets.data`).
   • External SQL mirror: PostgreSQL / MySQL / MariaDB receives a live copy of every table (services/mirror.js).
   • Encrypted backups: scheduled + on demand, kept locally and optionally uploaded to S3-compatible storage (services/backup.js).
   Connection URLs, passphrases and keys never leave the server and never reach the audit log. */
const fs = require('fs');
const { audit } = require('../db');
const { E } = require('../engine/errors');
const settings = require('../services/data-settings');
const mirror = require('../services/mirror');
const backup = require('../services/backup');

const P = 'secrets.data';
const clean = e => String(e && e.message || e).replace(/(postgres(ql)?|mysql|mariadb):\/\/\S+/g, '(url)').slice(0, 300);
function full() {
  const b = backup.service();
  return { ...settings.view(), mirror_status: mirror.status(), backups: b.list(30).map(pub), last_backup: b.last() ? pub(b.last()) : null, backup_running: b.busy() };
}
const pub = r => ({ name: r.name, ts: r.ts, size: r.size, sha256: r.sha256, mode: r.mode, trigger: r.trigger, by: r.by_user, local: !!r.local, s3: r.s3_status, error: r.error, ms: r.ms });

module.exports.routes = (r, h) => {
  r.get('/data/settings', h.need(P), (req, res) => res.json(full()));
  r.put('/data/settings', h.need(P), h.wrap(async (req, res) => {
    const b = req.body || {}, patch = {};
    if (b.mirror && typeof b.mirror === 'object') patch.mirror = b.mirror;
    if (b.backup && typeof b.backup === 'object') patch.backup = b.backup;
    if (!patch.mirror && !patch.backup) throw E.bad('nothing_to_update');
    const before = settings.mirror();
    if (patch.mirror && patch.mirror.enabled && (patch.mirror.url || !before.url)) {      // switching on (or to a new database): prove it works first
      const t = { ...before, ...patch.mirror, url: patch.mirror.url || before.url, schema: patch.mirror.schema || before.schema, prefix: patch.mirror.prefix ?? before.prefix, ssl: patch.mirror.ssl || before.ssl };
      if (!t.url) throw E.bad('mirror_url_required');
      settings.parseUrl(t.url);
      try { await mirror.test(t); } catch (e) { throw E.bad('mirror_connect_failed', { detail: clean(e) }); }
    }
    settings.save(patch);
    const after = settings.mirror();
    const moved = ['url', 'schema', 'prefix', 'ssl'].some(k => before[k] !== after[k]) || before.exclude.join() !== after.exclude.join();
    if (!after.enabled && before.enabled) mirror.off();
    else if (after.enabled && (!before.enabled || moved)) mirror.fullResync();
    const log = [];
    if (patch.mirror) log.push('mirror:' + Object.keys(patch.mirror).map(k => (k === 'url' ? 'url=(changed)' : `${k}=${String(patch.mirror[k]).slice(0, 60)}`)).join(','));
    if (patch.backup) log.push('backup:' + Object.keys(patch.backup).map(k => (k === 'passphrase' ? 'passphrase=(changed)' : k === 's3' ? 's3:' + Object.keys(patch.backup.s3 || {}).map(f => (f === 'secret' ? 'secret=(changed)' : `${f}=${String(patch.backup.s3[f]).slice(0, 60)}`)).join('/') : `${k}=${patch.backup[k]}`)).join(','));
    audit(req, 'data.settings', log.join('; '), req.user.username);
    mirror.tick().catch(() => {});
    res.json(full());
  }));
  r.delete('/data/mirror/url', h.need(P), (req, res) => { settings.clearMirrorUrl(); mirror.off(); audit(req, 'data.settings', 'mirror:url=(removed)', req.user.username); res.json(full()); });

  /* ---------- mirror ---------- */
  r.post('/data/mirror/test', h.need(P), h.wrap(async (req, res) => {
    const b = req.body || {}, cur = settings.mirror();
    const t = { url: b.url || cur.url, ssl: b.ssl || cur.ssl, schema: b.schema || cur.schema, prefix: b.prefix ?? cur.prefix };
    if (!t.url) throw E.bad('mirror_url_required');
    settings.parseUrl(t.url);
    if (!settings.IDENT.test(t.schema) || (t.prefix && !/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(t.prefix)) || !['off', 'require', 'no-verify'].includes(t.ssl)) throw E.bad('invalid_settings');
    try { res.json(await mirror.test(t)); } catch (e) { throw E.bad('mirror_connect_failed', { detail: clean(e) }); }
  }));
  r.post('/data/mirror/resync', h.need(P), h.wrap(async (req, res) => {
    if (!settings.mirror().enabled) throw E.bad('mirror_off');
    mirror.fullResync(); audit(req, 'data.mirror.resync', null, req.user.username);
    mirror.tick().catch(() => {});
    res.json(full());
  }));
  r.get('/data/mirror/compare', h.need(P), h.wrap(async (req, res) => res.json({ tables: await mirror.compare(), status: mirror.status() })));

  /* ---------- backups ---------- */
  r.post('/data/backups/run', h.need(P), h.wrap(async (req, res) => {
    try { await backup.service().run('manual', req.user.username); }
    catch (e) { if (e.code === 'backup_running') throw E.conflict('backup_running'); throw E.bad('backup_failed', { detail: clean(e) }); }
    audit(req, 'data.backup.run', null, req.user.username);
    res.json(full());
  }));
  r.get('/data/backups/:name/download', h.need(P), (req, res) => {
    const x = backup.service().fileOf(req.params.name); if (!x) throw E.notFound();
    audit(req, 'data.backup.download', x.row.name, req.user.username);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${x.row.name}"`);
    res.setHeader('Content-Length', fs.statSync(x.file).size);
    fs.createReadStream(x.file).pipe(res);
  });
  r.post('/data/backups/:name/verify', h.need(P), h.wrap(async (req, res) => {
    const v = await backup.service().verify(req.params.name); if (!v) throw E.notFound();
    audit(req, 'data.backup.verify', `${req.params.name} ok=${v.ok}`, req.user.username);
    res.json(v);
  }));
  r.delete('/data/backups/:name', h.need(P), (req, res) => {
    if (!backup.service().remove(req.params.name)) throw E.notFound();
    audit(req, 'data.backup.delete', req.params.name, req.user.username);
    res.json(full());
  });
  r.post('/data/backups/s3-test', h.need(P), h.wrap(async (req, res) => {
    try { res.json(await backup.service().testS3()); } catch (e) { throw E.bad('s3_failed', { detail: clean(e) }); }
  }));
};
