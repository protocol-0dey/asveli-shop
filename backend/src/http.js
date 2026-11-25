'use strict';
const express = require('express');
const helmet = require('helmet');

// Shared hardening for both listeners.
function baseApp({ hsts }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: {
      defaultSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], fontSrc: ["'self'"], baseUri: ["'none'"], formAction: ["'self'"],
      frameAncestors: ["'none'"], objectSrc: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: hsts ? { maxAge: 63072000, includeSubDomains: true, preload: false } : false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use((_req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'); next(); });
  return app;
}

function finish(app) {
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, _req, res, _next) => {
    if (err && typeof err.status === 'number' && err.code && err.constructor.name === 'HttpError') return res.status(err.status).json({ error: err.code, ...(err.extra || {}) });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
    console.error('unhandled:', err);                      // details stay in the server log only
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });
  return app;
}
module.exports = { baseApp, finish };
