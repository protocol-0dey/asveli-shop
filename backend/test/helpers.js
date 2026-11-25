'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asveli-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000), adminPort = port + 1;
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), ADMIN_PORT: String(adminPort), ALLOWED_ORIGINS: 'https://asveli.pl,https://asveli.shop',
    MAX_UPLOAD_MB: '1', LOGIN_RATE_LIMIT: '100', NODE_ENV: 'test', ...extraEnv };
  const root = path.join(__dirname, '..');
  const mk = (u, pw) => { const r = spawnSync('node', ['scripts/create-admin.js', u], { cwd: root, env: { ...env, ADMIN_PASSWORD: pw }, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
  mk('alice', 'correct-horse-battery'); mk('bob', 'another-long-password'); mk('carol', 'long-secret-phrase-001');
  const child = spawn('node', ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stderr.on('data', d => { log += d; });
  const base = `http://localhost:${port}`, adminBase = `http://localhost:${adminPort}`;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/health'); const a = await fetch(adminBase + '/admin/'); if (r.ok && a.ok) break; } catch { /* wait */ } await new Promise(r => setTimeout(r, 100)); }
  return { base, adminBase, port, adminPort, env, dataDir, log: () => log, stop: () => { child.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, url, { json, body, headers = {}, origin = this.base, csrf = true } = {}) {
    const h = { ...headers }; if (origin) h.Origin = origin; if (this.cookie) h.Cookie = this.cookie;
    if (csrf && this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); this.cookie = v ? `${k}=${v}` : ''; }
    return res;
  }
  async login(u, p) { const r = await this.req('POST', '/api/admin/auth/login', { json: { username: u, password: p } }); const j = await r.json(); if (j.csrf) this.csrf = j.csrf; return { r, j }; }
}
module.exports = { startServer, Client };
