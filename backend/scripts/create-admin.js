'use strict';
// Usage: node --env-file=.env scripts/create-admin.js <username> [--reset]
const readline = require('readline');
const { db, audit } = require('../src/db');
const { hashPassword } = require('../src/security');

const username = (process.argv[2] || '').trim().toLowerCase();
const reset = process.argv.includes('--reset');
const { ROLE_NAMES } = require('../src/iam/permissions');
const roleArg = (process.argv.find(a => a.startsWith('--role=')) || '--role=owner').slice(7);
if (!ROLE_NAMES.includes(roleArg)) { console.error('Unknown role. Available: ' + ROLE_NAMES.join(', ')); process.exit(1); }
if (!/^[a-z0-9._-]{3,32}$/.test(username)) { console.error('Usage: create-admin.js <username 3-32 chars [a-z0-9._-]> [--reset] [--role=owner|...]'); process.exit(1); }

function ask(q) {                                      // password prompt without echo
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}
(async () => {
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists && !reset) { console.error(`User "${username}" exists. Use --reset to change the password.`); process.exit(1); }
  const p1 = process.env.ADMIN_PASSWORD || await ask('New password (min 12 chars): ');
  if (!process.env.ADMIN_PASSWORD && p1 !== await ask('Repeat password: ')) { console.error('Passwords differ.'); process.exit(1); }
  if (p1.length < 12 || p1.toLowerCase().includes(username)) { console.error('Password must be ≥12 chars and must not contain the username.'); process.exit(1); }
  const hash = await hashPassword(p1);
  if (exists) {
    db.prepare('UPDATE users SET pass_hash=?, failed=0, locked_until=0 WHERE id=?').run(hash, exists.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(exists.id);
    audit(null, 'cli_password_reset', username, 'cli');
  } else {
    db.prepare('INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)').run(username, hash, roleArg, Date.now());
    audit(null, 'cli_admin_created', `${username} (${roleArg})`, 'cli');
  }
  console.log(exists ? 'Password updated, all sessions closed.' : `User "${username}" (${roleArg}) created. Enable 2FA after the first login (Security tab).`);
})();
