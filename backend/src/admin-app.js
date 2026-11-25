'use strict';
// ADMIN listener: bound to loopback only (see server.js / config.js). Reached through an SSH tunnel.
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const cfg = require('./config');
const auth = require('./auth');
const { baseApp, finish } = require('./http');

const app = baseApp({ hsts: false });            // plain HTTP on loopback; HSTS would be meaningless (and harmful for localhost)
app.set('trust proxy', false);                   // no proxy in front: req.ip is the real socket address

app.use(auth.hostGuard);                         // 1st: wrong Host header (DNS rebinding) → 421, nothing else runs
app.use(auth.ipAllow);
app.use('/api/admin/ai/import', express.json({ limit: '1100kb' }));
app.use('/mcp', express.json({ limit: '1200kb' }));   // agents send the same CSV through MCP (tools/call → admin_api → /ai/import)   // pasted supplier CSV (≤1 MB of text); the next parser skips an already-read body
app.use(express.json({ limit: '64kb' }));
app.use(auth.loadSession);

app.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT) || 12, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });
app.use('/api/admin/auth/login', loginLimiter);

// programs / AI agents with an API key: no login, account-security or staff endpoints
app.use('/api/admin', (req, res, next) => (req.apiKey && /^\/(auth|security|staff)(\/|$)/.test(req.path) ? res.status(403).json({ error: 'not_for_api_keys' }) : next()));
app.use('/mcp', require('./routes/mcp'));
app.use('/api/admin', (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : auth.csrfGuard(req, res, next)), require('./routes/admin'));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin'), {
  index: 'index.html', maxAge: 0, etag: true, setHeaders: res => res.set('Cache-Control', 'no-cache') }));
app.get('/', (_req, res) => res.redirect(302, '/admin/'));
finish(app);
module.exports = app;
