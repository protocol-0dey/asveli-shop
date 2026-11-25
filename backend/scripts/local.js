'use strict';
/* Run the Asveli admin on this computer with one command:   npm run local   (or start-local.sh / start-local.bat)
   1st run: creates .env.local with fresh secrets, installs nothing by itself except via `npm ci` if node_modules is missing,
   asks for the owner's login and password, then starts the server and opens http://localhost:3001/admin/ in the browser.
   Data stays in ./data-local on this computer. The panel listens on 127.0.0.1 only: nobody else on the network can open it. */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), readline = require('readline');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..'), ENV = path.join(ROOT, '.env.local');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 20 || (maj === 20 && min < 6)) { console.error(`Нужен Node.js 20.6 или новее (сейчас ${process.versions.node}). Скачайте LTS: https://nodejs.org`); process.exit(1); }

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3'))) {
  console.log('Первый запуск: устанавливаю зависимости (npm ci)…');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status) process.exit(r.status || 1);
}

const rnd = () => crypto.randomBytes(48).toString('base64url');
if (!fs.existsSync(ENV)) {
  fs.writeFileSync(ENV, [
    '# Asveli — локальная админка. Создано автоматически. Не публикуйте этот файл.',
    '# DATA_ENCRYPTION_KEY шифрует ключи и личные данные в базе: СДЕЛАЙТЕ КОПИЮ этого файла вместе с папкой data-local.',
    'NODE_ENV=development', 'PORT=3000', 'ADMIN_PORT=3001', 'DATA_DIR=./data-local', 'STORAGE_DRIVER=local',
    `SESSION_SECRET=${rnd()}`, `DATA_ENCRYPTION_KEY=${rnd()}`,
    'PLATFORM_CURRENCY=PLN', 'REQUIRE_2FA=0', 'AI_PROVIDER=mock',
    '# Shopify подключается в самой админке: Интеграции → Shopify. Можно и здесь:',
    '# SHOPIFY_STORE_DOMAIN=asveli.myshopify.com', '# SHOPIFY_CLIENT_ID=', '# SHOPIFY_CLIENT_SECRET=', ''
  ].join('\n'), { mode: 0o600 });
  console.log('Создан .env.local с новыми секретами.');
}
const envArgs = ['--env-file=' + ENV];
const envVars = Object.fromEntries(fs.readFileSync(ENV, 'utf8').split(/\r?\n/).filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const port = envVars.ADMIN_PORT || '3001';

function hasUsers() {
  const r = spawnSync(process.execPath, [...envArgs, '-e', "const {db}=require('./src/db');process.stdout.write(String(db.prepare('SELECT COUNT(*) c FROM users').get().c))"], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 && Number(r.stdout) > 0;
}
const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a.trim()); }); });

(async () => {
  if (!hasUsers()) {
    console.log('\nСоздаём владельца админки (полный доступ).');
    let u = '';
    while (!/^[a-z0-9._-]{3,32}$/.test(u)) u = (await ask('Логин (латиница, 3–32 символа): ')).toLowerCase();
    const r = spawnSync(process.execPath, [...envArgs, 'scripts/create-admin.js', u, '--role=owner'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status) process.exit(r.status || 1);
  }
  const url = `http://localhost:${port}/admin/`;
  const srv = spawn(process.execPath, [...envArgs, 'src/server.js'], { cwd: ROOT, stdio: 'inherit' });
  setTimeout(() => {
    console.log(`\n  Админка: ${url}\n  Остановить: Ctrl+C\n`);
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser: the address is printed above */ }
  }, 1500);
  const stop = () => srv.kill('SIGTERM');
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  srv.on('exit', code => process.exit(code || 0));
})();
