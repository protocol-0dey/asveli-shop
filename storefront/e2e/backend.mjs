// Starts a throw-away, seeded backend for the E2E run (own DATA_DIR, never touches real data).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.env.BACKEND_DIR || '../backend');
const port = process.env.API_PORT || '3400';
const env = { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'asv-e2e-')), PORT: port, ADMIN_PORT: String(Number(port) + 1), NODE_ENV: 'development', STORAGE_DRIVER: 'local',
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdef-0123', DATA_ENCRYPTION_KEY: 'e2e-data-key-0123456789abcdef-0123456789', ALLOWED_ORIGINS: 'http://localhost:5174', STORE_AUTH_RATE_LIMIT: '1000' };
const seed = spawnSync('node', ['scripts/seed-demo.js'], { cwd: root, env, encoding: 'utf8' });
if (seed.status) { console.error(seed.stderr || seed.stdout); process.exit(1); }
const child = spawn('node', ['src/server.js'], { cwd: root, env, stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child.kill('SIGTERM'); process.exit(0); });
child.on('exit', c => process.exit(c ?? 0));
