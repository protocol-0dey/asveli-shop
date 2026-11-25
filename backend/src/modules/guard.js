'use strict';
/* MODULE — «Защита магазина»: anomaly rules + maintenance mode (services/guard.js). Status is visible to every signed-in staff member
   (the red banner); changing rules or opening/closing the shop needs `guard.write` (owner, security admin). */
const { audit } = require('../db');
const { E } = require('../engine/errors');
const guard = require('../services/guard');

module.exports.routes = (r, h) => {
  r.get('/guard/status', (req, res) => res.json(guard.status()));
  r.put('/guard/config', h.need('guard.write'), (req, res) => {
    let c; try { c = guard.saveConfig(req.body || {}); } catch (e) { throw E.bad(e.code || 'invalid_config'); }
    audit(req, 'guard.config', Object.entries(req.body || {}).map(([k, v]) => `${k}=${v}`).join(',').slice(0, 250), req.user.username);
    res.json(guard.status());
  });
  r.post('/guard/maintenance', h.need('guard.write'), (req, res) => {
    const b = req.body || {}, on = !!b.on;
    guard.setMaintenance(on, { reason: typeof b.reason === 'string' ? b.reason : null, by: req.user.username, rule: 'manual' });
    audit(req, on ? 'guard.maintenance.on' : 'guard.maintenance.off', b.reason ? String(b.reason).slice(0, 200) : null, req.user.username);
    res.json(guard.status());
  });
  r.post('/guard/scan', h.need('guard.write'), (req, res) => { const n = guard.scan(); res.json({ created: n, ...guard.status() }); });
};
