'use strict';
/* Commerce core: customers (personal data sealed + masked), orders, order lines. Orders are created by the order service
   (routing, tax, split, coupon, fraud) — a storefront or a manual back-office order both go through it. */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db } = require('../db');
const orders = require('../services/orders');
const { now } = require('../services/common');

define({
  name: 'customers', table: 'm_customers', label: 'Покупатели', group: 'Заказы', perm: 'customers', title: 'code',
  search: ['code'], filters: ['blocked', 'country', 'loyalty_tier'], list: ['code', 'name', 'email', 'country', 'orders_count', 'total_spent', 'loyalty_tier', 'blocked'],
  afterCreate: id => db.prepare('UPDATE m_customers SET code=? WHERE id=?').run('C-' + id, id),
  fields: [
    { k: 'code', label: 'Код', t: 'text', ro: true },
    { k: 'name', label: 'Имя', t: 'pii', pii: 'name' },
    { k: 'email', label: 'E-mail', t: 'pii', pii: 'email', blind: true, req: true },
    { k: 'phone', label: 'Телефон', t: 'pii', pii: 'phone' },
    { k: 'address', label: 'Адрес', t: 'pii', pii: 'address', blind: true },
    { k: 'passport_no', label: 'Документ (если требуется)', t: 'pii', pii: 'passport' },
    { k: 'country', label: 'Страна (ISO-2)', t: 'text', req: true, pattern: /^[A-Z]{2}$/, max: 2 },
    // Cards: ONLY brand + last4 (what a payment provider returns). A full card number is never stored — that stays at the PSP (PCI-DSS).
    { k: 'card_brand', label: 'Карта: бренд', t: 'text', max: 20, pattern: /^[A-Za-z ]+$/ },
    { k: 'card_last4', label: 'Карта: последние 4', t: 'text', max: 4, pattern: /^\d{4}$/ },
    { k: 'orders_count', label: 'Заказов', t: 'int', def: 0, ro: true },
    { k: 'total_spent', label: 'Потрачено', t: 'money', def: 0, ro: true },
    { k: 'loyalty_points', label: 'Баллы', t: 'int', def: 0, ro: true },
    { k: 'loyalty_tier', label: 'Уровень', t: 'text', ro: true },
    { k: 'last_order_at', label: 'Последний заказ', t: 'date', ro: true },
    { k: 'blocked', label: 'Заблокирован', t: 'bool', def: 0, ro: true }
  ],
  actions: {
    block: { perm: 'fraud.decide', label: 'Заблокировать', confirm: true, run: ({ update }) => update({ blocked: 1 }) },
    unblock: { perm: 'fraud.decide', label: 'Разблокировать', confirm: true, run: ({ update }) => update({ blocked: 0 }) },
    adjust_points: { perm: 'loyalty.write', label: 'Баллы ±', fields: [{ k: 'delta', t: 'int', label: 'Изменение (±)', req: true }], run: ({ row, body, update }) => {
      if (!Number.isSafeInteger(body.delta) || Math.abs(body.delta) > 1e6 || row.loyalty_points + body.delta < 0) throw E.bad('invalid_delta');
      return update({ loyalty_points: row.loyalty_points + body.delta }); } }
  }
});

define({
  name: 'orders', table: 'm_orders', label: 'Заказы', group: 'Заказы', perm: 'orders', title: 'code', create: false,
  filters: ['status', 'customer_id', 'country'], search: ['code'], list: ['code', 'customer_id', 'country', 'status', 'total', 'fraud_score', 'created_at'],
  afterCreate: id => db.prepare('UPDATE m_orders SET code=? WHERE id=?').run('O-' + id, id),
  fields: [
    { k: 'code', label: 'Номер', t: 'text', ro: true },
    { k: 'customer_id', label: 'Покупатель', t: 'ref', ref: 'customers', req: true },
    { k: 'country', label: 'Доставка в', t: 'text', req: true, ro: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['new', 'held', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'], def: 'new', ro: true },
    { k: 'subtotal', label: 'Товары', t: 'money', ro: true, def: 0 },
    { k: 'discount', label: 'Скидка', t: 'money', ro: true, def: 0 },
    { k: 'tax', label: 'Налог', t: 'money', ro: true, def: 0 },
    { k: 'shipping', label: 'Доставка', t: 'money', ro: true, def: 0 },
    { k: 'total', label: 'Итого', t: 'money', ro: true, def: 0 },
    { k: 'coupon_code', label: 'Купон', t: 'text', ro: true },
    { k: 'fraud_score', label: 'Fraud score', t: 'int', ro: true, def: 0, min: 0, max: 100 },
    { k: 'hold_reason', label: 'Причина hold', t: 'text', ro: true },
    { k: 'settled_at', label: 'Расчёт проведён', t: 'date', ro: true }
  ],
  actions: {
    cancel: { perm: 'orders.write', label: 'Отменить', confirm: true, run: ({ row, user, req }) => { orders.cancel(row.id, user, req); } },
    hold: { perm: 'orders.hold', label: 'Заморозить', confirm: true, fields: [{ k: 'reason', t: 'text', label: 'Причина', req: true }], run: ({ row, body, update }) => {
      if (!['confirmed', 'new'].includes(row.status)) throw E.conflict('bad_state');
      if (typeof body.reason !== 'string' || !body.reason.trim()) throw E.bad('required_reason');
      return update({ status: 'held', hold_reason: 'manual: ' + body.reason.trim().slice(0, 100) }); } },
    release: { perm: 'orders.hold', label: 'Снять заморозку', confirm: true, run: ({ row, update }) => {
      if (row.status !== 'held') throw E.conflict('bad_state');
      db.prepare("UPDATE m_fraud_flags SET status='dismissed', updated_at=? WHERE order_id=? AND status='open'").run(now(), row.id);
      const r = update({ status: 'confirmed', hold_reason: null });
      orders.fulfillDigital(row.id);
      return r; } },
    refund_full: { perm: 'orders.write', label: 'Полный возврат', confirm: true, run: ({ row, user, req }) => { if (user && user.apiKey) throw E.forbidden('agent_no_refund'); return { refunded: orders.refundFull(row.id, user, req) }; } }
  }
});

define({
  name: 'order_items', table: 'm_order_items', label: 'Позиции заказов', group: 'Заказы', perm: 'orders', create: false, update: false,
  filters: ['order_id', 'seller_id', 'product_id'], list: ['order_id', 'product_id', 'seller_id', 'qty', 'unit_price', 'commission', 'tax', 'returned_qty'],
  fields: [
    { k: 'order_id', t: 'ref', ref: 'orders', req: true, label: 'Заказ' }, { k: 'product_id', t: 'ref', ref: 'products', req: true, label: 'Товар' },
    { k: 'seller_id', t: 'ref', ref: 'sellers', req: true, label: 'Продавец' }, { k: 'warehouse_id', t: 'ref', ref: 'warehouses', req: true, label: 'Склад' },
    { k: 'qty', t: 'int', label: 'Кол-во' }, { k: 'unit_price', t: 'money', label: 'Цена' }, { k: 'discount', t: 'money', label: 'Скидка' },
    { k: 'tax', t: 'money', label: 'Налог' }, { k: 'commission', t: 'money', label: 'Комиссия' }, { k: 'returned_qty', t: 'int', label: 'Возвращено', ro: true }
  ]
});

// manual / API order entry (a storefront would call this same service)
module.exports.routes = (r, h) => {
  r.post('/orders/create', h.need('orders.write'), (req, res) => res.status(201).json(orders.createOrder(req.body, req.user, req)));
};
