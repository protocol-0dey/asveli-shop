'use strict';
const { pipeline } = require('stream');
const getStorage = require('./storage');
const parseRange = require('./storage/range');

const SAFE_INLINE = /^(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav))$/;

const contentDisposition = (type, name) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
};

// Streams a stored file to the client with HTTP Range support (video seeking, resumable downloads).
async function sendFile(req, res, file, { inline = false, cache = 'private, no-store', cors = false } = {}) {
  const range = parseRange(req.headers.range, file.size);
  if (range === 'invalid') { res.set('Content-Range', `bytes */${file.size}`); return res.status(416).end(); }
  const canInline = inline && SAFE_INLINE.test(file.mime);
  const { stream } = await getStorage().get(file.storage_key, range, file.size);
  const len = range ? range.end - range.start + 1 : file.size;
  res.status(range ? 206 : 200).set({
    'Content-Type': canInline ? file.mime : 'application/octet-stream',
    'Content-Length': String(len),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(canInline ? 'inline' : 'attachment', file.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': cache,
    'Cross-Origin-Resource-Policy': cors ? 'cross-origin' : 'same-origin'
  });
  if (range) res.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
  res.on('close', () => stream.destroy());                                    // client went away: stop reading from storage
  pipeline(stream, res, () => {});
}
module.exports = { sendFile, SAFE_INLINE };
