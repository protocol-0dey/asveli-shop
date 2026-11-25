'use strict';
/* MODULE 6 — Support / CRM: tiered tickets (L1→L3, SLA, auto-escalation), dispute arbitration, review moderation. */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db } = require('../db');
const { can } = require('../iam/permissions');
const C = require('../services/common');
const compliance = require('../services/compliance');

const SLA_H = { urgent: 1, high: 4, normal: 24, low: 72 };
const slaFor = p => C.now() + (SLA_H[p] || 24) * 36e5;

// Which tickets a staff member may see: L1 → level 1 or their own; L2 → up to level 2 or their own; everyone else with ticket access → all.
function ticketFilter(user) {
  if (user.role === 'support_l1') return { sql: '(r.level <= 1 OR r.assignee = ?)', args: [user.username] };
  if (user.role === 'support_l2') return { sql: '(r.level <= 2 OR r.assignee = ?)', args: [user.username] };
  return null;
}
const levelPerm = lvl => (lvl >= 3 ? 'tickets.l3' : lvl === 2 ? 'tickets.l2' : 'tickets.write');

define({
  name: 'tickets', table: 'm_tickets', label: 'Тикеты', group: 'Поддержка', perm: 'tickets', title: 'subject',
  search: ['subject'], filters: ['status', 'level', 'priority', 'assignee', 'customer_id'], sort: 'id DESC',
  list: ['subject', 'customer_id', 'priority', 'level', 'status', 'assignee', 'sla_due'],
  rowFilter: ticketFilter,
  afterCreate: (id, data) => db.prepare('UPDATE m_tickets SET sla_due=? WHERE id=?').run(slaFor(data.priority), id),
  fields: [
    { k: 'subject', label: 'Тема', t: 'text', req: true, max: 150 },
    { k: 'customer_id', label: 'Покупатель', t: 'ref', ref: 'customers' },
    { k: 'order_id', label: 'Заказ', t: 'ref', ref: 'orders' },
    { k: 'channel', label: 'Канал', t: 'enum', vals: ['email', 'chat', 'phone', 'form'], def: 'email' },
    { k: 'priority', label: 'Приоритет', t: 'enum', vals: ['low', 'normal', 'high', 'urgent'], def: 'normal' },
    { k: 'body', label: 'Описание', t: 'longtext' },
    { k: 'level', label: 'Уровень (L1–L3)', t: 'int', min: 1, max: 3, def: 1, ro: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['open', 'pending', 'resolved', 'closed'], def: 'open', ro: true },
    { k: 'assignee', label: 'Ответственный', t: 'text', ro: true },
    { k: 'resolution', label: 'Решение', t: 'longtext', ro: true },
    { k: 'sla_due', label: 'SLA до', t: 'date', ro: true }
  ],
  actions: {
    take: { perm: 'tickets.write', label: 'Взять в работу', run: ({ row, user, update }) => {
      if (!can(user, levelPerm(row.level)) || ['resolved', 'closed'].includes(row.status)) throw E.forbidden();
      return update({ assignee: user.username, status: 'pending' }); } },
    escalate: { perm: 'tickets.write', label: 'Эскалировать', confirm: true, run: ({ row, update }) => {
      if (row.level >= 3 || ['resolved', 'closed'].includes(row.status)) throw E.conflict('bad_state');
      return update({ level: row.level + 1, assignee: null, status: 'open', sla_due: slaFor(row.priority) }); } },
    resolve: { perm: 'tickets.write', label: 'Решено', fields: [{ k: 'resolution', t: 'longtext', label: 'Решение', req: true }], run: ({ row, body, user, update }) => {
      if (!can(user, levelPerm(row.level))) throw E.forbidden();                       // an L1 agent cannot close an L3 case
      if (['resolved', 'closed'].includes(row.status)) throw E.conflict('bad_state');
      if (typeof body.resolution !== 'string' || !body.resolution.trim()) throw E.bad('required_resolution');
      return update({ status: 'resolved', resolution: body.resolution.trim().slice(0, 3000) }); } },
    close: { perm: 'tickets.write', label: 'Закрыть', run: ({ row, update }) => { if (row.status !== 'resolved') throw E.conflict('bad_state'); return update({ status: 'closed' }); } },
    reopen: { perm: 'tickets.write', label: 'Переоткрыть', run: ({ row, update }) => { if (!['resolved', 'closed'].includes(row.status)) throw E.conflict('bad_state'); return update({ status: 'open', sla_due: slaFor(row.priority) }); } }
  }
});
// background: tickets past their SLA move up one level automatically
function autoEscalate() {
  const t = C.now(), rows = db.prepare("SELECT id, level, priority FROM m_tickets WHERE status IN ('open','pending') AND level<3 AND sla_due IS NOT NULL AND sla_due<?").all(t);
  for (const r of rows) db.prepare("UPDATE m_tickets SET level=level+1, assignee=NULL, status='open', sla_due=?, updated_at=? WHERE id=?").run(slaFor(r.priority), t, r.id);
  return rows.length;
}

define({
  name: 'ticket_notes', table: 'm_ticket_notes', label: 'Заметки к тикетам', group: 'Поддержка', perm: 'tickets', update: false,
  filters: ['ticket_id'], list: ['ticket_id', 'body', 'created_by', 'created_at'], sort: 'id ASC',
  rowFilter: user => { const f = ticketFilter(user); return f ? { sql: `r.ticket_id IN (SELECT r.id FROM m_tickets r WHERE ${f.sql})`, args: f.args } : null; },
  fields: [{ k: 'ticket_id', label: 'Тикет', t: 'ref', ref: 'tickets', req: true }, { k: 'body', label: 'Заметка', t: 'longtext', req: true, max: 3000 }],
  validate: (data, user) => {
    const f = user ? ticketFilter(user) : null;
    const ok = db.prepare(`SELECT 1 FROM m_tickets r WHERE r.id=?${f ? ' AND ' + f.sql : ''}`).get(data.ticket_id, ...(f ? f.args : []));
    if (!ok) throw E.notFound();                                                         // a ticket you can't see doesn't exist for you
  }
});

define({
  name: 'disputes', table: 'm_disputes', label: 'Споры (арбитраж)', group: 'Поддержка', perm: 'disputes', update: false,
  filters: ['status', 'seller_id', 'order_id'], list: ['order_id', 'customer_id', 'seller_id', 'reason', 'amount', 'status', 'decision', 'decided_by'],
  fields: [
    { k: 'order_id', label: 'Заказ', t: 'ref', ref: 'orders', req: true },
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers', req: true },
    { k: 'reason', label: 'Причина', t: 'enum', vals: ['not_received', 'not_as_described', 'damaged', 'other'], req: true },
    { k: 'amount', label: 'Спорная сумма', t: 'money', req: true, min: 1 },
    { k: 'description', label: 'Суть', t: 'longtext' },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['open', 'evidence', 'decided'], def: 'open', ro: true },
    { k: 'decision', label: 'Решение', t: 'enum', vals: ['none', 'refund_buyer', 'release_seller', 'split'], def: 'none', ro: true },
    { k: 'split_bps', label: 'Доля покупателю, bps', t: 'bps', ro: true },
    { k: 'decision_note', label: 'Обоснование', t: 'text', ro: true },
    { k: 'decided_by', label: 'Решил', t: 'text', ro: true }
  ],
  validate: (data, _u, before) => {
    if (before) return;
    const o = db.prepare('SELECT total, status FROM m_orders WHERE id=?').get(data.order_id);
    if (!o || !['shipped', 'delivered'].includes(o.status)) throw E.conflict('order_not_disputable');
    if (data.amount > o.total) throw E.bad('amount_exceeds_order');
    if (!db.prepare('SELECT 1 FROM m_order_items WHERE order_id=? AND seller_id=?').get(data.order_id, data.seller_id)) throw E.bad('seller_not_in_order');
    if (db.prepare("SELECT 1 FROM m_disputes WHERE order_id=? AND seller_id=? AND status<>'decided'").get(data.order_id, data.seller_id)) throw E.conflict('dispute_exists');
  },
  actions: {
    request_evidence: { perm: 'disputes.read', label: 'Запросить доказательства', run: ({ row, update }) => { if (row.status !== 'open') throw E.conflict('bad_state'); return update({ status: 'evidence' }); } },
    decide: { perm: 'disputes.decide', label: 'Вынести решение', confirm: true, fields: [
      { k: 'decision', t: 'enum', vals: ['refund_buyer', 'release_seller', 'split'], label: 'Решение', req: true },
      { k: 'split_bps', t: 'bps', label: 'Доля покупателю (для split), bps' }, { k: 'note', t: 'text', label: 'Обоснование', req: true }], run: ({ row, body, user, update }) => {
      if (row.status === 'decided') throw E.conflict('bad_state');
      if (!['refund_buyer', 'release_seller', 'split'].includes(body.decision)) throw E.bad('invalid_decision');
      if (typeof body.note !== 'string' || !body.note.trim()) throw E.bad('required_note');
      let share = body.decision === 'refund_buyer' ? 10000 : 0;
      if (body.decision === 'split') { if (!Number.isSafeInteger(body.split_bps) || body.split_bps < 1 || body.split_bps > 9999) throw E.bad('invalid_split_bps'); share = body.split_bps; }
      const refund = C.bps(row.amount, share);
      return db.transaction(() => {
        // policy: the seller bears the refunded part in full (commission is not returned)
        if (refund > 0) { C.ledger('refund', { seller_id: row.seller_id, order_id: row.order_id, amount: -refund, note: `dispute #${row.id}`, by: user.username }); C.event('refund', { ref_type: 'dispute', ref_id: row.id, seller_id: row.seller_id, amount: refund }); }
        return update({ status: 'decided', decision: body.decision, split_bps: body.decision === 'split' ? share : null, decision_note: body.note.trim().slice(0, 200), decided_by: user.username });
      })(); } }
  }
});

define({
  name: 'reviews', table: 'm_reviews', label: 'Отзывы (модерация)', group: 'Поддержка', perm: 'reviews', update: false,
  filters: ['status', 'product_id', 'rating'], search: ['body'], list: ['product_id', 'rating', 'body', 'status', 'flag'],
  afterCreate: (id, data) => {
    const flags = [];
    if (/https?:\/\/|www\./i.test(data.body || '')) flags.push('link');
    if (compliance.scan({ title: data.body }).block.length) flags.push('banned_term');
    if (data.body && db.prepare("SELECT 1 FROM m_reviews WHERE body=? AND id<>? AND customer_id IS ?").get(data.body, id, data.customer_id ?? null)) flags.push('duplicate');
    if (flags.length) db.prepare('UPDATE m_reviews SET flag=? WHERE id=?').run(flags.join(','), id);
  },
  fields: [
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true },
    { k: 'customer_id', label: 'Покупатель', t: 'ref', ref: 'customers' },
    { k: 'rating', label: 'Оценка 1–5', t: 'int', min: 1, max: 5, req: true },
    { k: 'body', label: 'Текст', t: 'longtext', max: 3000 },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['pending', 'published', 'rejected'], def: 'pending', ro: true },
    { k: 'flag', label: 'Авто-флаг', t: 'text', ro: true }
  ],
  actions: {
    publish: { perm: 'reviews.moderate', label: 'Опубликовать', run: ({ row, update }) => { if (row.status === 'published') throw E.conflict('bad_state'); return update({ status: 'published' }); } },
    reject: { perm: 'reviews.moderate', label: 'Отклонить', confirm: true, run: ({ row, update }) => { if (row.status === 'rejected') throw E.conflict('bad_state'); return update({ status: 'rejected' }); } }
  }
});
module.exports.autoEscalate = autoEscalate;
