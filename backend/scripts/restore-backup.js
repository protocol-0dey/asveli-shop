#!/usr/bin/env node
'use strict';
/* Restore an encrypted Asveli backup (.asvb) into a plain SQLite file.
   node scripts/restore-backup.js <backup.asvb> <out.db>
   • backup made WITH a backup passphrase:  BACKUP_PASSPHRASE='…' node scripts/restore-backup.js …   (works on any machine)
   • backup made WITHOUT one: run it on a machine with the same .env (DATA_ENCRYPTION_KEY) as the server that made it.
   Then, to put it back into service: stop the server, move data/asveli.db (+ -wal, -shm) aside, copy <out.db> to data/asveli.db, start the server. */
const fs = require('fs');
const path = require('path');
const { decryptFile, readHeader, check } = require('../src/services/backup');

(async () => {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('usage: node scripts/restore-backup.js <backup.asvb> <out.db>'); process.exit(2); }
  if (fs.existsSync(out)) { console.error(`refusing to overwrite ${out}`); process.exit(2); }
  const h = readHeader(src), secrets = {};
  if (h.mode === 'P') { secrets.passphrase = process.env.BACKUP_PASSPHRASE; if (!secrets.passphrase) { console.error('this backup is protected by a passphrase: set BACKUP_PASSPHRASE'); process.exit(2); } }
  else { secrets.serverKey = require('../src/config').keys.data; }
  await decryptFile(path.resolve(src), path.resolve(out), secrets);
  const c = check(out);
  console.log(`restored → ${out}\nintegrity: ${c.integrity} · tables: ${c.tables} · rows: ${c.rows}`);
  if (c.integrity !== 'ok') process.exit(1);
})().catch(e => { console.error('restore failed:', e.message === 'wrong_key_or_damaged' ? 'wrong passphrase/key, or the file is damaged' : e.message); process.exit(1); });
