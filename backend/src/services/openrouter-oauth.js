'use strict';
// "Войти через OpenRouter": OAuth PKCE (https://openrouter.ai/docs/guides/overview/auth/oauth). The verifier never leaves the server;
// the browser only carries the one-time code back. State is single-use, bound to the admin user, valid 10 minutes.
const crypto = require('crypto');
const { E } = require('../engine/errors');

const BASE = process.env.NODE_ENV === 'test' && process.env.OPENROUTER_TEST_BASE ? process.env.OPENROUTER_TEST_BASE : 'https://openrouter.ai';
const pending = new Map();                                   // state → { user, verifier, exp }
const b64u = b => b.toString('base64url');

function start(userId, origin) {
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const state = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(48));
  pending.set(state, { user: userId, verifier, exp: Date.now() + 10 * 60e3 });
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const callback = `${origin}/admin/?or_state=${state}`;
  const q = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', state, key_label: 'Asveli Admin' });
  return { url: `${BASE}/auth?${q}`, state };
}
async function exchange(userId, state, code) {
  const p = pending.get(state); pending.delete(state);
  if (!p || p.user !== userId || p.exp < Date.now()) throw E.bad('oauth_state_invalid');
  if (!/^[A-Za-z0-9._-]{4,400}$/.test(code)) throw E.bad('oauth_code_invalid');
  const res = await fetch(`${BASE}/api/v1/auth/keys`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: 'S256' }) });
  let j = null; try { j = await res.json(); } catch { /* not json */ }
  if (!res.ok || !j || typeof j.key !== 'string' || j.key.length < 8) throw E.bad('oauth_exchange_failed', { detail: `HTTP ${res.status}` });
  return j.key;
}
module.exports = { start, exchange };
