'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const limitStream = require('./limit');

// Development / fallback driver: stores blobs on local disk under DATA_DIR/blobs.
class LocalStorage {
  constructor(dataDir) {
    this.name = 'local';
    this.dir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  _path(key) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('bad storage key');
    return path.join(this.dir, key);
  }
  async put(stream, { maxBytes } = {}) {
    const key = crypto.randomBytes(16).toString('hex');
    const file = this._path(key), counter = limitStream(maxBytes);
    try { await pipeline(stream, counter, fs.createWriteStream(file, { mode: 0o600 })); }
    catch (e) { await fsp.rm(file, { force: true }); throw e; }
    return { key, size: counter.bytes() };
  }
  async get(key, range, size) {
    const opts = range ? { start: range.start, end: range.end } : {};
    return { stream: fs.createReadStream(this._path(key), opts) };
  }
  async delete(key) { await fsp.rm(this._path(key), { force: true }); }
  async usage() {
    try { const s = await fsp.statfs(this.dir); const limit = s.blocks * s.bsize; return { used: limit - s.bavail * s.bsize, limit, scope: 'disk' }; }
    catch { return { used: null, limit: null, scope: 'disk' }; }
  }
}
module.exports = LocalStorage;
