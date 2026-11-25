'use strict';
/* MODULE — buyer sign-in with Google / GitHub / Amazon: provider apps (client ID + secret) and the shop address. Owner only (`secrets.oauth`).
   The login flow itself runs on the PUBLIC listener (src/store/oauth.js); this is only its configuration. */
const { audit, db } = require('../db');
const { E } = require('../engine/errors');
const settings = require('../services/oauth-settings');

module.exports.routes = (r, h) => {
  r.get('/oauth/settings', h.need('secrets.oauth'), (req, res) => res.json({ ...settings.view(), stats: stats() }));
  r.put('/oauth/settings', h.need('secrets.oauth'), (req, res) => {
    const b = req.body || {}, patch = {};
    for (const k of [...Object.keys(settings.PROVIDERS), 'storeUrl']) if (b[k] !== undefined) patch[k] = b[k];
    if (!Object.keys(patch).length) throw E.bad('nothing_to_update');
    const v = settings.save(patch);
    const log = Object.entries(patch).map(([k, x]) => (k === 'storeUrl' ? `storeUrl=${x}` : `${k}:${Object.keys(x || {}).map(f => (f === 'clientSecret' ? 'secret=(changed)' : `${f}=${String(x[f]).slice(0, 60)}`)).join(',')}`)).join('; ');
    audit(req, 'oauth.settings', log, req.user.username);                       // secrets never reach the log
    res.json({ ...v, stats: stats() });
  });
  r.delete('/oauth/settings/:p/secret', h.need('secrets.oauth'), (req, res) => { const v = settings.clearSecret(req.params.p); audit(req, 'oauth.settings', `${req.params.p}:secret=(removed)`, req.user.username); res.json({ ...v, stats: stats() }); });
};
function stats() {
  try { return db.prepare('SELECT provider, COUNT(*) n FROM s_identities GROUP BY provider').all(); } catch { return []; }
}
