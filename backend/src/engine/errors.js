'use strict';
// Thrown by services/engine; http.js turns it into a clean JSON error (message is a stable machine code, never a stack).
class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const E = {
  bad: (code = 'bad_request', extra) => new HttpError(400, code, extra),
  forbidden: (code = 'forbidden') => new HttpError(403, code),
  notFound: (code = 'not_found') => new HttpError(404, code),
  conflict: (code = 'conflict', extra) => new HttpError(409, code, extra)
};
module.exports = { HttpError, E };
