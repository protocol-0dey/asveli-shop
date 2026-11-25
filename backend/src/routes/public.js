'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { db, audit } = require('../db');
const sec = require('../security');
const { sendFile } = require('../serve');

const router = express.Router();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: Number(process.env.SUBSCRIBE_RATE_LIMIT) || 12, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } });

// CORS: only the coming-soon sites on the allow-list may call the subscribe endpoint from a browser.
function cors(req, res, next) {
  const o = req.headers.origin;
  if (o && cfg.publicOrigins.includes(o)) { res.set('Access-Control-Allow-Origin', o); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS').set('Access-Control-Allow-Headers', 'Content-Type').set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

router.get('/api/health', (_req, res) => res.json({ ok: true }));

router.options('/api/subscribe', cors);
router.post('/api/subscribe', cors, limiter, (req, res) => {
  const o = req.headers.origin;
  if (!o || !cfg.publicOrigins.includes(o)) return res.status(403).json({ error: 'forbidden_origin' });
  const b = req.body || {};
  if (b.company) return res.json({ ok: true });                              // honeypot filled → pretend success
  if (typeof b.email !== 'string' || typeof b.site !== 'string') return res.status(422).json({ error: 'invalid' });   // no array/object coercion
  const email = b.email.trim().toLowerCase(), site = b.site, lang = typeof b.lang === 'string' ? b.lang.slice(0, 2).toLowerCase() : '';
  let originHost = ''; try { originHost = new URL(o).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* unreachable: o is in the allow-list */ }
  // A page may only subscribe people to its OWN site, otherwise any allowed origin could pollute the other lists.
  if (!EMAIL.test(email) || !cfg.sites.includes(site) || originHost !== site) return res.status(422).json({ error: 'invalid' });
  db.prepare('INSERT OR IGNORE INTO subscribers(email,site,lang,created_at) VALUES(?,?,?,?)').run(email, site, lang || null, Date.now());
  res.json({ ok: true });                                                    // same answer for new/duplicate → no email enumeration
});

// Public files (explicitly published in the admin panel). Unguessable slug; safe media types render inline.
router.get('/f/:slug/:name?', async (req, res, next) => {
  try {
    if (!/^[A-Za-z0-9_-]{22}$/.test(req.params.slug)) return res.status(404).end();
    const f = db.prepare('SELECT * FROM files WHERE public_slug=? AND is_public=1 AND scope=\'general\'').get(req.params.slug);
    if (!f) return res.status(404).end();
    await sendFile(req, res, f, { inline: true, cache: 'public, max-age=3600', cors: true });
  } catch (e) { next(e); }
});

// Signed, expiring links (the S3 "presigned URL" idea): /s/<fileId>.<expiry>.<signature>
router.get('/s/:token', async (req, res, next) => {
  try {
    const p = sec.parseLink(req.params.token);
    const f = p && db.prepare('SELECT * FROM files WHERE id=? AND scope=\'general\'').get(p.id);
    if (!f || !sec.checkLink(p, f.share_nonce)) return res.status(404).end();
    await sendFile(req, res, f, { inline: false, cache: 'private, no-store' });
  } catch (e) { next(e); }
});

module.exports = router;
