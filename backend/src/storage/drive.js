'use strict';
const limitStream = require('./limit');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries metadata calls on quota / transient errors (never used for consumed upload streams).
async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const code = Number(e.code || (e.response && e.response.status));
      const reason = e.errors && e.errors[0] && e.errors[0].reason;
      const transient = [429, 500, 502, 503, 504].includes(code) || /rateLimitExceeded|userRateLimitExceeded/.test(reason || '');
      if (!transient || i >= tries - 1) throw e;
      await sleep(Math.min(8000, 400 * 2 ** i) + Math.random() * 250);
    }
  }
}

/**
 * Google Drive driver. Files are stored in ONE app-owned folder with random, meaningless names;
 * original names/permissions live only in our database. Nothing is ever shared publicly on Drive:
 * every byte is streamed through this server, so access control stays here.
 *
 * Auth = OAuth2 refresh token of the account that owns the 400 GB (scope drive.file = the app can
 * only see files it created itself). A service account would NOT work for a personal account's quota.
 */
class DriveStorage {
  constructor({ drive, folderName = 'asveli-storage', getSetting, setSetting }) {
    this.name = 'drive';
    this.drive = drive; this.folderName = folderName;
    this.getSetting = getSetting; this.setSetting = setSetting;
    this._folder = null;
  }
  static fromCredentials(cfg, settings) {
    const { drive: driveFactory, auth } = require('@googleapis/drive');
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken)
      throw new Error('Drive driver needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (run: npm run drive-token)');
    const oauth = new auth.OAuth2(cfg.clientId, cfg.clientSecret);
    oauth.setCredentials({ refresh_token: cfg.refreshToken });
    return new DriveStorage({ drive: driveFactory({ version: 'v3', auth: oauth }), folderName: cfg.folderName, ...settings });
  }

  async folderId() {
    if (this._folder) return this._folder;
    let id = this.getSetting('drive_folder_id');
    if (!id) {
      const q = `name='${this.folderName.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and trashed=false`;
      const found = await withRetry(() => this.drive.files.list({ q, fields: 'files(id)', pageSize: 1, spaces: 'drive' }));
      id = found.data.files && found.data.files[0] && found.data.files[0].id;
      if (!id) {
        const made = await withRetry(() => this.drive.files.create({ requestBody: { name: this.folderName, mimeType: FOLDER_MIME }, fields: 'id' }));
        id = made.data.id;
      }
      this.setSetting('drive_folder_id', id);
    }
    return (this._folder = id);
  }

  async put(stream, { maxBytes, mime } = {}) {
    const parents = [await this.folderId()];
    const counter = limitStream(maxBytes);
    stream.on('error', e => counter.destroy(e));
    counter.on('error', () => stream.resume());     // keep draining so the multipart parser can finish
    stream.pipe(counter);
    const res = await this.drive.files.create({
      requestBody: { name: require('crypto').randomBytes(16).toString('hex'), parents, mimeType: 'application/octet-stream' },
      media: { mimeType: 'application/octet-stream', body: counter },
      fields: 'id,size'
    });
    return { key: res.data.id, size: Number(res.data.size) || counter.bytes() };
  }

  async get(key, range) {
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
    const res = await withRetry(() => this.drive.files.get({ fileId: key, alt: 'media' }, { responseType: 'stream', headers }));
    return { stream: res.data };
  }

  async delete(key) {
    try { await withRetry(() => this.drive.files.delete({ fileId: key })); }
    catch (e) { if (Number(e.code) !== 404) throw e; }
  }

  async usage() {
    const r = await withRetry(() => this.drive.about.get({ fields: 'storageQuota' }));
    const q = r.data.storageQuota || {};
    return { used: Number(q.usage) || 0, limit: Number(q.limit) || null, scope: 'google-account' };
  }
}
module.exports = DriveStorage;
