'use strict';
const { E } = require('./errors');

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;
const clean = s => s.normalize('NFC').replace(CTRL, '').trim();
const isRef = f => f.t === 'ref';
const isPii = f => f.t === 'pii';

const SQL_TYPE = { text: 'TEXT', longtext: 'TEXT', int: 'INTEGER', money: 'INTEGER', bps: 'INTEGER', bool: 'INTEGER', enum: 'TEXT', ref: 'INTEGER', date: 'INTEGER', pii: 'TEXT' };
const DEFAULT_RANGE = { int: [-1e12, 1e12], money: [0, 1e12], bps: [0, 10000], ref: [1, Number.MAX_SAFE_INTEGER] };

// Turns untrusted client input into a value that is safe to bind. Throws E.bad('invalid_<field>') — never echoes the input.
function coerce(f, v) {
  const bad = () => E.bad('invalid_' + f.k);
  if (v === undefined) return undefined;
  if (v === null || v === '') { if (f.req) throw E.bad('required_' + f.k); return null; }
  switch (f.t) {
    case 'text': case 'longtext': case 'pii': {
      if (typeof v !== 'string') throw bad();
      const s = clean(v), max = f.max || (f.t === 'longtext' ? 5000 : f.t === 'pii' ? 300 : 200);
      if (!s) { if (f.req) throw E.bad('required_' + f.k); return null; }
      if (s.length > max || s.length < (f.minLen || 0)) throw bad();
      if (f.pattern && !f.pattern.test(s)) throw bad();
      return s;
    }
    case 'int': case 'money': case 'bps': case 'ref': {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad();
      const [lo, hi] = DEFAULT_RANGE[f.t];
      if (v < (f.min ?? lo) || v > (f.max ?? hi)) throw bad();
      return v;
    }
    case 'bool': if (typeof v !== 'boolean') throw bad(); return v ? 1 : 0;
    case 'enum': if (typeof v !== 'string' || !f.vals.includes(v)) throw bad(); return v;
    case 'date': {
      const ms = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : NaN);
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 4102444800000) throw bad();
      return ms;
    }
    default: throw bad();
  }
}
module.exports = { coerce, clean, isRef, isPii, SQL_TYPE };
