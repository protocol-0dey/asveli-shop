'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'asveli-unit-'));
const sec = require('../src/security');
const parseRange = require('../src/storage/range');
const DriveStorage = require('../src/storage/drive');

test('TOTP matches RFC 6238 test vector', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(sec.hotp(key, Math.floor(59 / 30)), '287082');                // T=59s → 94287082 → last 6 digits
  assert.equal(sec.hotp(key, Math.floor(1111111109 / 30)), '081804');
  assert.deepEqual(sec.b32decode(sec.b32encode(key)), key);
  const secret = sec.b32encode(key);
  assert.equal(sec.totpVerify(secret, '287082', 0, 59000), Math.floor(59 / 30));
  assert.equal(sec.totpVerify(secret, '287082', Math.floor(59 / 30), 59000), null);   // replay blocked
  assert.equal(sec.totpVerify(secret, 'abc123', 0, 59000), null);
});

test('password hashing', async () => {
  const h = await sec.hashPassword('s3cret-passphrase');
  assert.ok(await sec.verifyPassword('s3cret-passphrase', h));
  assert.ok(!(await sec.verifyPassword('s3cret-passphrasX', h)));
  assert.ok(!(await sec.verifyPassword('x', 'garbage')));
});

test('secrets encryption round-trip and tamper detection', () => {
  const blob = sec.encrypt('JBSWY3DPEHPK3PXP');
  assert.equal(sec.decrypt(blob), 'JBSWY3DPEHPK3PXP');
  const parts = blob.split('.'); parts[2] = Buffer.from('xxxxxxxxxxxxxxxxxx').toString('base64');
  assert.throws(() => sec.decrypt(parts.join('.')));
});

test('signed links: format, expiry, nonce binding', () => {
  const id = 'a'.repeat(32), exp = Date.now() + 60000;
  const t = sec.signLink(id, 'n1', exp), p = sec.parseLink(t);
  assert.ok(sec.checkLink(p, 'n1'));
  assert.ok(!sec.checkLink(p, 'n2'));
  assert.ok(!sec.checkLink(sec.parseLink(sec.signLink(id, 'n1', Date.now() - 1)), 'n1'));
  assert.equal(sec.parseLink('garbage'), null);
});

test('range parser', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=5-2', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6']) assert.equal(parseRange(bad, 100), 'invalid');
});

test('Drive driver against a fake Drive client', async () => {
  const calls = []; const store = new Map(); let folder = null;
  const fake = {
    files: {
      list: async a => { calls.push(['list', a.q]); return { data: { files: [] } }; },
      create: async a => {
        if (a.requestBody.mimeType === 'application/vnd.google-apps.folder') { folder = 'F1'; calls.push(['mkdir', a.requestBody.name]); return { data: { id: 'F1' } }; }
        const chunks = []; for await (const c of a.media.body) chunks.push(c);
        const buf = Buffer.concat(chunks); const id = 'ID' + store.size; store.set(id, buf);
        calls.push(['create', a.requestBody.parents, a.requestBody.name]); return { data: { id, size: String(buf.length) } };
      },
      get: async (a, o) => { calls.push(['get', a.fileId, o.headers.Range]); const b = store.get(a.fileId); const m = /bytes=(\d+)-(\d+)/.exec(o.headers.Range || ''); return { data: Readable.from([m ? b.subarray(+m[1], +m[2] + 1) : b]) }; },
      delete: async a => { calls.push(['delete', a.fileId]); if (!store.has(a.fileId)) throw Object.assign(new Error('nf'), { code: 404 }); store.delete(a.fileId); }
    },
    about: { get: async () => ({ data: { storageQuota: { usage: '1000', limit: String(400 * 1024 ** 3) } } }) }
  };
  const settings = new Map();
  const d = new DriveStorage({ drive: fake, folderName: 'asveli-storage', getSetting: k => settings.get(k), setSetting: (k, v) => settings.set(k, v) });
  const { key, size } = await d.put(Readable.from([Buffer.from('hello '), Buffer.from('drive')]), { maxBytes: 100 });
  assert.equal(size, 11); assert.equal(settings.get('drive_folder_id'), 'F1');
  const created = calls.find(c => c[0] === 'create'); assert.deepEqual(created[1], ['F1']); assert.match(created[2], /^[a-f0-9]{32}$/, 'Drive file name is random, not the user filename');
  const chunk = []; for await (const c of (await d.get(key, { start: 2, end: 6 })).stream) chunk.push(c);
  assert.equal(Buffer.concat(chunk).toString(), 'llo d'); assert.equal(calls.find(c => c[0] === 'get')[2], 'bytes=2-6');
  assert.deepEqual(await d.usage(), { used: 1000, limit: 400 * 1024 ** 3, scope: 'google-account' });
  await assert.rejects(d.put(Readable.from([Buffer.alloc(200)]), { maxBytes: 100 }), e => e.code === 'LIMIT');
  await d.delete(key); await d.delete(key);                                 // second delete: 404 tolerated
});
