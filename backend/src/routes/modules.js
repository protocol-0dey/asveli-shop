'use strict';
const express = require('express');
const cfg = require('../config');
const R = require('../engine/resource');
const { E } = require('../engine/errors');
const { can } = require('../iam/permissions');
const { registerRoutes } = require('../modules');

const router = express.Router();
const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
const id = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1 || !/^\d{1,15}$/.test(String(v))) throw E.bad('invalid_id'); return n; };
const need = perm => (req, _res, next) => (can(req.user, perm) ? next() : next(E.forbidden()));
const wrap = fn => (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };
const helpers = { need, id, wrap };
const resName = req => { if (!IDENT.test(req.params.res)) throw E.notFound('unknown_resource'); return req.params.res; };

router.get('/meta', wrap((req, res) => res.json({ resources: R.meta(req.user), currency: cfg.currency })));

router.get('/m/:res', wrap((req, res) => res.json(R.list(resName(req), req.user, req.query))));
router.get('/m/:res/options', wrap((req, res) => res.json({ rows: R.options(resName(req), req.user, req.query.q) })));
router.get('/m/:res/:id', wrap((req, res) => res.json(R.getOne(resName(req), id(req.params.id), req.user))));
router.post('/m/:res', wrap((req, res) => res.status(201).json(R.create(resName(req), req.user, req.body, req))));
router.patch('/m/:res/:id', wrap((req, res) => res.json(R.update(resName(req), id(req.params.id), req.user, req.body, req))));
router.delete('/m/:res/:id', wrap((req, res) => res.json(R.remove(resName(req), id(req.params.id), req.user, req))));
router.post('/m/:res/:id/reveal', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.field !== 'string') throw E.bad('invalid_field');
  res.json(await R.reveal(resName(req), id(req.params.id), b.field, req.user, b.password, req, cfg));
}));
router.post('/m/:res/:id/do/:action', wrap(async (req, res) => {
  if (!/^[a-z_]{1,30}$/.test(req.params.action)) throw E.notFound('unknown_action');
  res.json(await R.runAction(resName(req), id(req.params.id), req.params.action, req.user, req.body, req));
}));

registerRoutes(router, helpers);
module.exports = router;
module.exports.helpers = helpers;
