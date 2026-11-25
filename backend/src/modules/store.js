'use strict';
/* MODULE 8 — Storefront support: inbound shipments. A seller announces "I am sending N units of product X to warehouse W";
   stock only becomes sellable when staff RECEIVE it (nobody can create phantom stock from the public API). */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db } = require('../db');
const { event, now } = require('../services/common');

define({
  name: 'inbound', table: 'm_inbound', label: 'Приёмка товара (inbound)', group: 'Логистика', perm: 'inbound', title: 'id',
  filters: ['status', 'seller_id', 'warehouse_id', 'product_id'], list: ['seller_id', 'product_id', 'warehouse_id', 'qty', 'status', 'created_at'],
  fields: [
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers', req: true, immutable: true },
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true, immutable: true },
    { k: 'warehouse_id', label: 'Склад', t: 'ref', ref: 'warehouses', req: true, immutable: true },
    { k: 'qty', label: 'Кол-во', t: 'int', min: 1, max: 1e6, req: true, immutable: true },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['requested', 'received', 'rejected'], def: 'requested', ro: true },
    { k: 'note', label: 'Заметка', t: 'text', max: 200 }
  ],
  validate: (data, _u, before) => {
    if (before) return;
    const p = db.prepare('SELECT seller_id FROM m_products WHERE id=?').get(data.product_id);
    if (!p || p.seller_id !== data.seller_id) throw E.bad('product_not_of_seller');
    if (!db.prepare('SELECT 1 FROM m_warehouses WHERE id=? AND active=1').get(data.warehouse_id)) throw E.bad('invalid_warehouse_id');
  },
  actions: {
    receive: { perm: 'inbound.write', label: 'Принять на склад', confirm: true, fields: [{ k: 'qty', t: 'int', label: 'Фактически принято (пусто = как заявлено)' }], run: ({ row, body, update }) => {
      if (row.status !== 'requested') throw E.conflict('bad_state');
      const qty = body.qty == null ? row.qty : body.qty;
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1e6) throw E.bad('invalid_qty');
      db.transaction(() => {
        db.prepare(`INSERT INTO m_stock(product_id,warehouse_id,qty,reserved,refurb_qty,reorder_level,created_at,updated_at,created_by) VALUES(?,?,0,0,0,0,?,?,'system')
          ON CONFLICT(product_id,warehouse_id) DO NOTHING`).run(row.product_id, row.warehouse_id, now(), now());
        db.prepare('UPDATE m_stock SET qty = qty + ?, updated_at=? WHERE product_id=? AND warehouse_id=?').run(qty, now(), row.product_id, row.warehouse_id);
        event('stock_adjust', { ref_type: 'inbound', ref_id: row.id, seller_id: row.seller_id, amount: qty });
      })();
      return update({ status: 'received', note: qty === row.qty ? row.note : `принято ${qty} из ${row.qty}` }); } },
    reject: { perm: 'inbound.write', label: 'Отклонить', confirm: true, run: ({ row, update }) => { if (row.status !== 'requested') throw E.conflict('bad_state'); return update({ status: 'rejected' }); } }
  }
});
