'use strict';
// Minimal S3-compatible client (AWS Signature V4): PUT / HEAD / DELETE of one object. Works with AWS S3, Cloudflare R2, Backblaze B2,
// Wasabi, MinIO, Hetzner, OVH… No SDK: one dependency less to trust. The endpoint comes only from the owner's settings (no SSRF from requests).
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function target(c, key) {
  const u = new URL(c.endpoint);
  const virtual = /\.amazonaws\.com$/.test(u.hostname) && !c.bucket.includes('.');   // AWS prefers virtual-hosted style; others take path style
  const host = virtual ? `${c.bucket}.${u.host}` : u.host;
  const path = (virtual ? '' : '/' + c.bucket) + '/' + key.split('/').map(enc).join('/');
  return { proto: u.protocol, host, path };
}
function sign(c, method, t, payloadHash, extra = {}) {
  const now = new Date(), amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  const headers = { host: t.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canon = [method, t.path, '', names.map(h => `${h}:${String(headers[h]).trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canon)].join('\n');
  const k = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac('AWS4' + c.secret, day), c.region));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${crypto.createHmac('sha256', k).update(toSign).digest('hex')}`;
  return headers;
}
function send(c, method, key, { file, size, hash } = {}) {
  const t = target(c, key), extra = file ? { 'content-length': size, 'content-type': 'application/octet-stream' } : {};
  const headers = sign(c, method, t, hash || sha(''), extra);
  const lib = t.proto === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: t.host.split(':')[0], port: t.host.split(':')[1] || undefined, method, path: t.path, headers, timeout: 300000 }, res => {
      let b = ''; res.on('data', d => { if (b.length < 4000) b += d; });
      res.on('end', () => (res.statusCode < 300 ? resolve({ status: res.statusCode, etag: res.headers.etag }) : reject(new Error(`S3 ${method} ${res.statusCode}: ${(/<Code>([^<]+)<\/Code>/.exec(b) || [, b.slice(0, 120)])[1]}`))));
    });
    req.on('timeout', () => req.destroy(new Error('S3 timeout')));
    req.on('error', reject);
    if (file) fs.createReadStream(file).pipe(req); else req.end();
  });
}
async function hashFile(file) { const h = crypto.createHash('sha256'); for await (const d of fs.createReadStream(file)) h.update(d); return h.digest('hex'); }
async function put(c, key, file) { const size = fs.statSync(file).size; return send(c, 'PUT', key, { file, size, hash: await hashFile(file) }); }
const head = (c, key) => send(c, 'HEAD', key);
const del = (c, key) => send(c, 'DELETE', key);
module.exports = { put, head, del, sign, target };
