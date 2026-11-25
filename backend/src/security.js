'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const cfg = require('./config');
const scrypt = promisify(crypto.scrypt);

/* ---------- helpers ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
// constant-time string compare that tolerates different lengths
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/* ---------- passwords: scrypt ---------- */
const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return ['scrypt', N, R, P, salt.toString('base64'), h.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, n, r, p, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(h, 'base64');
    const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
    return crypto.timingSafeEqual(got, want);
  } catch { return false; }
}
// verified against when the username does not exist, so timing doesn't reveal valid usernames
let dummy;
const dummyHash = async () => dummy || (dummy = await hashPassword(crypto.randomBytes(12).toString('hex')));

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest();
  const o = h[19] & 15;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));
// returns the matched time-step (so the caller can reject replays) or null
function totpVerify(secretB32, code, lastStep = 0, now = Date.now()) {
  code = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const key = b32decode(secretB32), step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s > lastStep && safeEq(hotp(key, s), code)) return s;
  }
  return null;
}
const totpUri = (secret, user) =>
  `otpauth://totp/Asveli:${encodeURIComponent(user)}?secret=${secret}&issuer=Asveli&algorithm=SHA1&digits=6&period=30`;

/* ---------- encrypt TOTP secrets at rest: AES-256-GCM ---------- */
function encrypt(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cfg.keys.totp, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, ct] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cfg.keys.totp, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/* ---------- generic sealing for personal data (AES-256-GCM, bound to table/column/row via AAD) ---------- */
function seal(plain, aad = '') {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cfg.keys.data, iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function open(blob, aad = '') {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !ct) throw new Error('bad_sealed');
  const d = crypto.createDecipheriv('aes-256-gcm', cfg.keys.data, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(String(aad))); d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
// deterministic keyed hash: lets us look up/dedupe an e-mail or phone without storing it in clear
const blindIndex = v => crypto.createHmac('sha256', cfg.keys.blind).update(String(v).trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 32);

/* ---------- signed, expiring share links (like S3 presigned URLs) ---------- */
const sig = (id, nonce, exp) => crypto.createHmac('sha256', cfg.keys.links).update(`${id}.${nonce}.${exp}`).digest('base64url');
const signLink = (id, nonce, exp) => `${id}.${exp}.${sig(id, nonce, exp)}`;
function parseLink(t) {
  const m = /^([a-f0-9]{32})\.(\d{10,13})\.([A-Za-z0-9_-]{43})$/.exec(String(t));
  return m ? { id: m[1], exp: Number(m[2]), sig: m[3] } : null;
}
const checkLink = (parsed, nonce) => parsed.exp > Date.now() && safeEq(parsed.sig, sig(parsed.id, nonce, parsed.exp));

module.exports = {
  sha256, token, safeEq, hashPassword, verifyPassword, dummyHash,
  b32encode, b32decode, hotp, newTotpSecret, totpVerify, totpUri, encrypt, decrypt,
  signLink, parseLink, checkLink, seal, open, blindIndex
};
