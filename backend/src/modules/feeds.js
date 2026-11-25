'use strict';
// MODULE — product feeds for sales channels (services/feeds.js). Settings need `channels.write`.
const { audit } = require('../db');
const { E } = require('../engine/errors');
const feeds = require('../services/feeds');
module.exports.routes = (r, h) => {
  r.get('/feeds', h.need('channels.read'), (req, res) => res.json(feeds.view()));
  r.put('/feeds', h.need('channels.write'), (req, res) => { try { feeds.save(req.body || {}); } catch (e) { throw E.bad(e.code || 'invalid'); } audit(req, 'feeds.settings', null, req.user.username); res.json(feeds.view()); });
  r.post('/feeds/rotate', h.need('channels.write'), (req, res) => { feeds.rotate(); audit(req, 'feeds.rotate', null, req.user.username); res.json(feeds.view()); });
};
