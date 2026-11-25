'use strict';
/* Conversations that go THROUGH the platform: contact a seller (classifieds, questions), B2B order of licence-only goods, order through
   Asveli as a broker (partner offer), request for quote (construction, rental, logistics…). Contact details are never exchanged by the
   platform: the buyer sees the shop name, the seller sees the buyer's first name only. */
const { db } = require('../db');
const { E } = require('../engine/errors');
const R = require('../engine/resource');
const cats = require('./categories');
const cat = () => require('../store/catalog');
const { addMessage, clean } = require('../modules/marketplace');

const KINDS = ['contact_seller', 'b2b_order', 'broker_order', 'rfq'];
const str = (v, max) => { const s = clean(v); return s ? s.slice(0, max) : null; };

function create(accountId, b, req) {
  if (!KINDS.includes(b.kind)) throw E.bad('invalid_kind');
  const message = clean(b.message);
  if (message.length < 10 || message.length > 2000) throw E.bad('message_too_short');
  const data = { kind: b.kind, account_id: accountId, quantity: str(b.quantity, 80), location: str(b.location, 160), company: str(b.company, 160), vat_no: str(b.vat_no, 20), licence_no: str(b.licence_no, 60) };
  if (b.deadline) data.deadline = b.deadline;
  if (b.budget != null && b.budget !== '') data.budget = b.budget;
  if (b.kind === 'contact_seller' || b.kind === 'b2b_order') {
    const pid = Number(b.product_id), m = Number.isSafeInteger(pid) && cat().findByProduct(pid);
    if (!m) throw E.bad('invalid_product');
    const o = m.offers.find(x => x.id === pid);
    data.product_id = pid; data.seller_id = o.seller_id; data.subject = m.title.slice(0, 160); data.category_id = m.category_id || null;
    if (b.kind === 'b2b_order') {
      if (m.restricted !== 'b2b_licence') throw E.bad('not_b2b_product');
      if (!data.company || !data.vat_no || !data.licence_no) throw E.bad('b2b_details_required');   // licence-only goods: business, VAT and licence number
    }
  } else if (b.kind === 'broker_order') {
    const x = db.prepare("SELECT * FROM m_external_offers WHERE id=? AND active=1 AND mode='broker'").get(Number(b.external_offer_id));
    if (!x) throw E.bad('invalid_offer');
    data.external_offer_id = x.id; data.subject = `${x.source_name}: ${x.model_slug}`.slice(0, 160);
  } else {                                                                     // rfq: addressed to the Asveli team
    const n = typeof b.category === 'string' && cats.tree().bySlug.get(b.category);
    if (!n || cats.effective(n.id).kind !== 'rfq') throw E.bad('invalid_category');
    data.category_id = n.id; data.subject = (str(b.subject, 160) || n.name);
  }
  const row = R.create('inquiries', null, data, req, { internal: true });
  addMessage(row.id, 'buyer', message, 'buyer');
  return view(row.id, 'buyer');
}

function firstName(accountId) {
  try {
    const a = db.prepare('SELECT customer_id FROM s_accounts WHERE id=?').get(accountId); if (!a) return null;
    const c = db.prepare('SELECT * FROM m_customers WHERE id=?').get(a.customer_id);
    const n = require('../store/checkout').openPii(c, 'name');
    return n ? n.split(/\s+/)[0] : null;
  } catch { return null; }
}
function view(id, as) {
  const q = db.prepare('SELECT * FROM m_inquiries WHERE id=?').get(id);
  const seller = q.seller_id ? db.prepare('SELECT name FROM m_sellers WHERE id=?').get(q.seller_id) : null;
  const msgs = db.prepare('SELECT author, body, created_at FROM m_inquiry_messages WHERE inquiry_id=? ORDER BY id').all(id);
  const m = q.product_id ? cat().findByProduct(q.product_id) : null;
  return { id: q.id, kind: q.kind, status: q.status, subject: q.subject, created_at: q.created_at, last_message_at: q.last_message_at,
    quantity: q.quantity, location: q.location, deadline: q.deadline, budget: q.budget, company: q.company, vat_no: q.vat_no, licence_no: q.licence_no,
    product: m ? { slug: m.slug, title: m.title, image: m.images[0] || null } : null,
    with: seller ? seller.name : 'ASVELI',                                    // who answers
    buyer: as === 'seller' ? (firstName(q.account_id) || 'Buyer') : undefined,
    messages: msgs.map(x => ({ author: x.author, body: x.body, at: x.created_at })) };
}
const listFor = (where, args, as) => db.prepare(`SELECT id FROM m_inquiries WHERE ${where} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 100`).all(...args).map(r => {
  const v = view(r.id, as); return { id: v.id, kind: v.kind, status: v.status, subject: v.subject, with: v.with, buyer: v.buyer, product: v.product, last_message_at: v.last_message_at, last: v.messages.at(-1) || null };
});
// ownership is part of every query: a buyer sees only their account's rows, a seller only rows addressed to their store
const forBuyer = (accountId, id) => { const q = db.prepare('SELECT id FROM m_inquiries WHERE id=? AND account_id=?').get(Number(id), accountId); if (!q) throw E.notFound(); return q.id; };
const forSeller = (sellerId, id) => { const q = db.prepare('SELECT id FROM m_inquiries WHERE id=? AND seller_id=?').get(Number(id), sellerId); if (!q) throw E.notFound(); return q.id; };

module.exports = { create, view, listFor, forBuyer, forSeller, addMessage, KINDS };
