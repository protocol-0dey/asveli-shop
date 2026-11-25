'use strict';
const { Transform } = require('stream');
// Aborts the pipeline as soon as more than maxBytes pass through; also counts bytes.
module.exports = function limitStream(maxBytes) {
  let size = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) return cb(Object.assign(new Error('file too large'), { code: 'LIMIT' }));
      cb(null, chunk);
    }
  });
  t.bytes = () => size;
  return t;
};
