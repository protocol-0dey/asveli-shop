'use strict';
/* MODULE 7 — Security & anti-fraud: tunable fraud rules, fraud flags (review queue), alerts. Staff/IAM lives in routes/staff.js. */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db } = require('../db');
const orders = require('../services/orders');
const { now } = require('../services/common');

define({
  name: 'fraud_rules', table: 'm_fraud_rules', label: 'Антифрод: правила', group: 'Безопасность', perm: 'fraud', create: false, title: 'rule',
  list: ['rule', 'enabled', 'threshold', 'window_h', 'score', 'note'],
  fields: [
    { k: 'rule', label: 'Правило', t: 'text', ro: true, unique: true },
    { k: 'enabled', label: 'Включено', t: 'bool', def: 1 },
    { k: 'threshold', label: 'Порог', t: 'int', min: 0, max: 1e9, def: 0 },
    { k: 'window_h', label: 'Окно, часов', t: 'int', min: 0, max: 720, def: 0 },
    { k: 'score', label: 'Баллы', t: 'int', min: 0, max: 100, def: 0 },
    { k: 'note', label: 'Описание', t: 'text', ro: true }
  ]
});

define({
  name: 'fraud_flags', table: 'm_fraud_flags', label: 'Антифрод: сигналы', group: 'Безопасность', perm: 'fraud', create: false, update: false,
  filters: ['status', 'rule', 'order_id', 'customer_id'], list: ['order_id', 'customer_id', 'rule', 'score', 'detail', 'status', 'created_at'],
  fields: [
    { k: 'order_id', label: 'Заказ', t: 'ref', ref: 'orders', req: true }, { k: 'customer_id', label: 'Покупатель', t: 'ref', ref: 'customers', req: true },
    { k: 'rule', label: 'Правило', t: 'text' }, { k: 'score', label: 'Баллы', t: 'int' }, { k: 'detail', label: 'Детали', t: 'text' },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['open', 'confirmed', 'dismissed'], def: 'open', ro: true }
  ],
  actions: {
    confirm: { perm: 'fraud.decide', label: 'Подтвердить фрод', confirm: true, run: ({ row, update, user, req }) => {
      if (row.status !== 'open') throw E.conflict('bad_state');
      const o = db.prepare('SELECT status FROM m_orders WHERE id=?').get(row.order_id);
      db.transaction(() => {
        db.prepare('UPDATE m_customers SET blocked=1, updated_at=? WHERE id=?').run(now(), row.customer_id);
        if (['held', 'confirmed'].includes(o.status)) orders.cancel(row.order_id, user, req);       // stock goes back on sale
      })();
      return update({ status: 'confirmed' }); } },
    dismiss: { perm: 'fraud.decide', label: 'Ложное срабатывание', run: ({ row, update }) => {
      if (row.status !== 'open') throw E.conflict('bad_state');
      const r = update({ status: 'dismissed' });
      const open = db.prepare("SELECT COUNT(*) n FROM m_fraud_flags WHERE order_id=? AND status='open'").get(row.order_id).n;
      if (!open) db.prepare("UPDATE m_orders SET status='confirmed', hold_reason=NULL, updated_at=? WHERE id=? AND status='held' AND (hold_reason IS NULL OR hold_reason NOT LIKE 'manual:%')").run(now(), row.order_id);
      return r; } }
  }
});

define({
  name: 'alerts', table: 'm_alerts', label: 'Алерты и аномалии', group: 'Безопасность', perm: 'alerts', create: false, update: false, title: 'title',
  filters: ['status', 'kind', 'severity'], search: ['title'], list: ['created_at', 'kind', 'severity', 'title', 'detail', 'status'],
  fields: [
    { k: 'kind', label: 'Тип', t: 'enum', vals: ['fraud', 'anomaly', 'stock', 'system'], req: true },
    { k: 'severity', label: 'Важность', t: 'enum', vals: ['low', 'medium', 'high'], req: true },
    { k: 'title', label: 'Заголовок', t: 'text', req: true }, { k: 'detail', label: 'Детали', t: 'text' },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['open', 'ack', 'dismissed'], def: 'open', ro: true },
    { k: 'dedupe', label: 'dedupe', t: 'text', unique: true, ro: true }
  ],
  actions: {
    ack: { perm: 'alerts.write', label: 'Принято', run: ({ row, update }) => { if (row.status !== 'open') throw E.conflict('bad_state'); return update({ status: 'ack' }); } },
    dismiss: { perm: 'alerts.write', label: 'Закрыть', run: ({ row, update }) => { if (row.status === 'dismissed') throw E.conflict('bad_state'); return update({ status: 'dismissed' }); } }
  }
});
