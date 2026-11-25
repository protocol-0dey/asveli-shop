'use strict';
/* Personal data: sealed (AES-GCM, bound to table/column/row) at rest, masked on every normal read.
   Showing the real value is a separate, audited, rate-limited, password-confirmed action ("reveal"). */
const sec = require('../security');

const mask = {
  email:    v => { const [u, d = ''] = String(v).split('@'); return `${u.slice(0, 1)}***@${d}`; },
  phone:    v => { const x = String(v).replace(/\D/g, ''); return `••• ••• ${x.slice(-2)}`; },
  passport: v => `•••••${String(v).slice(-2)}`,
  iban:     v => { const x = String(v).replace(/\s/g, ''); return `${x.slice(0, 4)} •••• ${x.slice(-4)}`; },
  taxid:    v => `•••${String(v).slice(-3)}`,
  address:  v => String(v).split(',').slice(-1)[0].trim().replace(/^/, '•••, '),   // only the last part (city/country) stays visible
  name:     v => String(v).split(/\s+/).map((w, i) => (i === 0 ? w : w.slice(0, 1) + '.')).join(' '),
  generic:  () => '••••••'
};
const maskValue = (kind, v) => (v == null || v === '' ? null : (mask[kind] || mask.generic)(v));
const aad = (table, col, id) => `${table}.${col}.${id}`;

module.exports = { maskValue, aad, seal: sec.seal, open: sec.open, blindIndex: sec.blindIndex };
