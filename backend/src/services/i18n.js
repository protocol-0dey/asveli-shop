'use strict';
// Card translations on autopilot: the shop's languages are chosen once; "Перевести всё" (or the background worker, when "auto" is on)
// translates every card that has no translation yet or whose source text changed since (tracked by a hash of title + description).
// Translations a human already approved are re-done only when the source text really changed — and then lose the approval.
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const R = require('../engine/resource');
const { HttpError, E } = require('../engine/errors');
const ai = require('./ai');

const KEY = 'i18n.config';
const stored = () => { try { return { langs: ['en', 'pl', 'de'], source: 'pl', auto: false, ...JSON.parse(getSetting(KEY) || '{}') }; } catch { return { langs: ['en', 'pl', 'de'], source: 'pl', auto: false }; } };
const srcText = p => ({ title: p.title, description: p.seo_description || p.description || '' });
const hashOf = p => crypto.createHash('sha256').update(JSON.stringify(srcText(p))).digest('hex').slice(0, 24);

function save(b) {
  const c = stored();
  if (b.langs !== undefined) { if (!Array.isArray(b.langs) || !b.langs.length || b.langs.length > 30 || b.langs.some(l => !ai.LANGS[l])) throw E.bad('invalid_langs'); c.langs = [...new Set(b.langs)]; }
  if (b.source !== undefined) { if (!ai.LANGS[b.source]) throw E.bad('invalid_lang'); c.source = b.source; }
  if (b.auto !== undefined) c.auto = !!b.auto;
  setSetting(KEY, JSON.stringify(c));
  return view();
}
// every (product, language) pair that needs work
function pending() {
  const c = stored(), langs = c.langs.filter(l => l !== c.source);
  const have = new Map(db.prepare('SELECT id, product_id, lang, src_hash FROM m_translations').all().map(t => [t.product_id + ':' + t.lang, t]));
  const out = [];
  for (const p of db.prepare("SELECT id, title, description, seo_description FROM m_products WHERE status<>'delisted' ORDER BY id").all()) {
    const hsh = hashOf(p);
    for (const l of langs) { const t = have.get(p.id + ':' + l); if (!t || t.src_hash !== hsh) out.push({ product_id: p.id, lang: l, existing: t ? t.id : null, hash: hsh }); }
  }
  return out;
}
function view() {
  const c = stored(), langs = c.langs.filter(l => l !== c.source), products = db.prepare("SELECT COUNT(*) n FROM m_products WHERE status<>'delisted'").get().n;
  return { langs: c.langs, source: c.source, auto: c.auto, total: products * langs.length, pending: pending().length, verified: db.prepare('SELECT COUNT(*) n FROM m_translations WHERE human_verified=1').get().n, mock: ai.isMock() };
}
let running = false;
async function run(user, req, limit = 20) {
  if (running) throw new HttpError(409, 'translate_running');
  running = true;
  try {
    const todo = pending().slice(0, limit); let done = 0, failed = 0, i = 0, stop = null;
    const worker = async () => {
      while (i < todo.length && !stop) {
        const x = todo[i++];
        try {
          const p = db.prepare('SELECT * FROM m_products WHERE id=?').get(x.product_id); if (!p) continue;
          const t = await ai.localize(p, x.lang);
          const body = { title: t.title, description: t.description || null, mock: t.mock, src_hash: x.hash };
          if (x.existing) R.update('translations', x.existing, user, { ...body, human_verified: false }, req, { internal: true });
          else R.create('translations', user, { product_id: x.product_id, lang: x.lang, ...body }, req, { internal: true });
          done++;
        } catch (e) { failed++; if (e instanceof HttpError && ['ai_quota', 'ai_not_configured'].includes(e.code)) stop = e.code; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return { done, failed, stopped: stop, left: pending().length };
  } finally { running = false; }
}
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(async () => {
    const c = stored(); if (!c.auto || ai.isMock() || !ai.configured() || running) return;
    try { await run(null, null, 10); } catch (e) { if (e.code !== 'translate_running') console.error('auto-translate:', e.message); }
  }, 3 * 60e3); timer.unref();
}
module.exports = { view, save, run, pending, start, hashOf };
