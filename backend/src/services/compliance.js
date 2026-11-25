'use strict';
const { db } = require('../db');
// Rule-based product screening (banned/regulated terms, restricted categories). It is a first filter for human moderators,
// not a legal guarantee: terms come from compliance_rules, which staff maintain.
function scan(p) {
  const text = `${p.title || ''} ${p.description || ''} ${p.seo_description || ''} ${p.category || ''}`.toLowerCase();
  const block = [], review = [];
  for (const r of db.prepare('SELECT term, kind FROM m_compliance_rules WHERE active=1').all()) {
    const t = r.term.toLowerCase();
    const hit = r.kind === 'category' ? (p.category || '').toLowerCase() === t : text.includes(t);
    if (hit) (r.kind === 'ban' ? block : review).push(r.term);
  }
  return { block, review };
}
module.exports = { scan };
