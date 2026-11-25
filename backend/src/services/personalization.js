'use strict';
const { db } = require('../db');
const { now, day } = require('./common');

// One condition per segment (MVP): field OP value, evaluated on the customer's own aggregates. No personal data (name, e-mail…) is involved.
function metric(c, field) {
  switch (field) {
    case 'total_spent': return c.total_spent;
    case 'orders_count': return c.orders_count;
    case 'country': return c.country;
    case 'loyalty_tier': return c.loyalty_tier || '';
    case 'days_since_last_order': return c.last_order_at ? Math.floor((now() - c.last_order_at) / day) : 99999;
    default: return null;
  }
}
function matches(c, seg) {
  const m = metric(c, seg.field); if (m === null) return false;
  if (typeof m === 'string') return seg.op === 'eq' && m.toLowerCase() === String(seg.value).toLowerCase();
  const v = Number(seg.value); if (!Number.isFinite(v)) return false;
  return seg.op === 'gte' ? m >= v : seg.op === 'lte' ? m <= v : m === v;
}
function forCustomer(customerId) {
  const c = db.prepare('SELECT * FROM m_customers WHERE id=?').get(customerId); if (!c) return null;
  const segments = db.prepare('SELECT * FROM m_segments WHERE active=1').all().filter(s => matches(c, s));
  const ids = new Set(segments.map(s => s.id)), t = now();
  const banners = db.prepare('SELECT * FROM m_banners WHERE active=1 ORDER BY priority ASC, id DESC').all()
    .filter(b => (!b.segment_id || ids.has(b.segment_id)) && (!b.starts_at || t >= b.starts_at) && (!b.ends_at || t <= b.ends_at))
    .map(b => ({ id: b.id, placement: b.placement, title: b.title, text: b.text, link: b.link, segment_id: b.segment_id }));
  return { segments: segments.map(s => ({ id: s.id, name: s.name })), banners };
}
function members(segId) {
  const seg = db.prepare('SELECT * FROM m_segments WHERE id=?').get(segId); if (!seg) return null;
  return db.prepare('SELECT * FROM m_customers').all().filter(c => matches(c, seg)).length;
}
module.exports = { matches, forCustomer, members };
