'use strict';
// PUBLIC listener: the only thing nginx is allowed to proxy. It contains NO admin code paths at all:
// no admin API, no admin static files, no session handling.
const express = require('express');
const rateLimit = require('express-rate-limit');
const cfg = require('./config');
const { baseApp, finish } = require('./http');

const app = baseApp({ hsts: cfg.prod });
app.set('trust proxy', cfg.trustProxy);          // exactly one nginx hop for req.ip
app.use('/api/seller', express.json({ limit: '64kb' }));     // listings carry descriptions + image lists; the parser is skipped by the next line once the body is read
app.use(express.json({ limit: '8kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
// guard: count server errors; while the shop is in maintenance the shop/seller APIs answer 503 (health + status stay up)
const guard = require('./services/guard');
app.use((req, res, next) => { res.on('finish', () => { if (res.statusCode >= 500) guard.countError(); }); next(); });
app.get('/api/store/status', (req, res) => { const m = guard.maintenance(); res.set('Cache-Control', 'no-store').json({ maintenance: !!m, message: m ? 'Магазин временно закрыт на технические работы. Скоро вернёмся!' : null }); });
app.use(['/api/store', '/api/seller'], (req, res, next) => { const m = guard.maintenance(); if (!m) return next(); res.set('Retry-After', '600').status(503).json({ error: 'maintenance', message: 'Магазин временно закрыт на технические работы. Скоро вернёмся!' }); });
// product feeds for sales channels (Google Merchant / Meta / Pinterest / TikTok, Ceneo, CSV): secret token in the URL
app.get('/feeds/:token/:kind', (req, res) => {
  const feeds = require('./services/feeds');
  if (!feeds.okToken(req.params.token)) return res.status(404).json({ error: 'not_found' });
  const k = req.params.kind;
  res.set('Cache-Control', 'public, max-age=900').set('X-Robots-Tag', 'noindex');
  if (k === 'google.xml') return res.type('application/xml').send(feeds.google());
  if (k === 'ceneo.xml') return res.type('application/xml').send(feeds.ceneo());
  if (k === 'products.csv') return res.type('text/csv').send(feeds.csv());
  res.status(404).json({ error: 'not_found' });
});
app.use(require('./routes/public'));
require('./modules');                                          // table definitions only (no admin routes/sessions): the order service and the storefront share them
app.use(require('./routes/store'));
app.use(require('./routes/seller'));
finish(app);
module.exports = app;
