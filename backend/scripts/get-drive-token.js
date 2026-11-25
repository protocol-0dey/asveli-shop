'use strict';
// One-time helper: obtains a Google OAuth refresh token for the account that owns your Drive storage.
// Usage: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-drive-token.js
const http = require('http');
const crypto = require('crypto');
const { auth } = require('@googleapis/drive');

const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (OAuth client of type "Desktop app").'); process.exit(1); }

const PORT = 53682, redirect = `http://127.0.0.1:${PORT}/callback`;
const client = new auth.OAuth2(id, secret, redirect);
const state = crypto.randomBytes(16).toString('hex');
const { codeVerifier, codeChallenge } = (() => { const v = crypto.randomBytes(48).toString('base64url'); return { codeVerifier: v, codeChallenge: crypto.createHash('sha256').update(v).digest('base64url') }; })();

const url = client.generateAuthUrl({
  access_type: 'offline', prompt: 'consent', state,
  scope: ['https://www.googleapis.com/auth/drive.file'],      // least privilege: only files this app creates
  code_challenge: codeChallenge, code_challenge_method: 'S256'
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
  if (u.searchParams.get('state') !== state) { res.writeHead(400).end('state mismatch'); return; }
  try {
    const { tokens } = await client.getToken({ code: u.searchParams.get('code'), codeVerifier });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Done. You can close this tab and return to the terminal.');
    if (!tokens.refresh_token) console.error('\nNo refresh_token returned. Revoke the app at https://myaccount.google.com/permissions and run this again.');
    else console.log('\nPut this into .env:\n\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  } catch (e) { res.writeHead(500).end('error'); console.error(e.message); }
  server.close();
});
server.listen(PORT, '127.0.0.1', () => console.log('Open this URL in a browser (sign in with the Google account that has the 400 GB):\n\n' + url + '\n'));
