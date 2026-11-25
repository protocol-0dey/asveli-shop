'use strict';
/* MODULE 2 — Logistics & fulfillment: warehouses (WMS-lite), carriers + rates, shipments, returns (incl. refurbished). */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db } = require('../db');
const { event, now } = require('../services/common');
const orders = require('../services/orders');

const CCS = /^[A-Za-z]{2}(,\s*[A-Za-z]{2})*$/;

define({
  name: 'warehouses', table: 'm_warehouses', label: 'Склады', group: 'Логистика', perm: 'warehouses', title: 'name',
  search: ['name', 'country'], filters: ['active', 'country'], list: ['name', 'country', 'priority', 'ships_to', 'active'],
  fields: [
    { k: 'name', label: 'Название', t: 'text', req: true, max: 80 },
    { k: 'country', label: 'Страна (ISO-2)', t: 'text', req: true, pattern: /^[A-Z]{2}$/, max: 2 },
    { k: 'priority', label: 'Приоритет (меньше = раньше)', t: 'int', min: 0, max: 1000, def: 100 },
    { k: 'ships_to', label: 'Куда отправляет (ISO-2 через запятую, пусто = везде)', t: 'text', pattern: CCS, max: 200 },
    { k: 'active', label: 'Активен', t: 'bool', def: 1 }
  ]
});

define({
  name: 'carriers', table: 'm_carriers', label: 'Перевозчики', group: 'Логистика', perm: 'carriers', title: 'name',
  search: ['name', 'code'], filters: ['active'], list: ['name', 'code', 'base_cost', 'per_kg_cost', 'countries', 'active'],
  fields: [
    { k: 'name', label: 'Название', t: 'text', req: true, max: 60 },
    { k: 'code', label: 'Код', t: 'text', req: true, max: 20, unique: true, pattern: /^[a-z0-9_-]+$/ },
    { k: 'base_cost', label: 'Базовая цена (центы)', t: 'money', def: 0 },
    { k: 'per_kg_cost', label: 'За кг (центы)', t: 'money', def: 0 },
    { k: 'countries', label: 'Страны назначения (пусто = все)', t: 'text', pattern: CCS, max: 200 },
    { k: 'tracking_url', label: 'URL трекинга (используйте {id})', t: 'text', max: 200, pattern: /^https:\/\/[^\s{}]*(\{id\})?[^\s{}]*$/ },
    { k: 'free_ok', label: 'Бесплатная доставка (осознанно, тариф 0)', t: 'bool', def: 0 },
    { k: 'active', label: 'Активен', t: 'bool', def: 1 }
  ],
  // a switched-on carrier with no price would make every routed order ship for free: only allowed when that is intended
  validate: (data, _u, before) => {
    const v = k => (k in data ? data[k] : before ? before[k] : undefined);
    if (v('active') !== false && v('active') !== 0 && !v('base_cost') && !v('per_kg_cost') && !v('free_ok')) throw E.bad('carrier_needs_tariff');
  }
});

define({
  name: 'shipments', table: 'm_shipments', label: 'Отправления', group: 'Логистика', perm: 'shipments', create: false, update: false,
  filters: ['status', 'warehouse_id', 'carrier_id', 'order_id'], list: ['order_id', 'warehouse_id', 'carrier_id', 'tracking_no', 'status', 'cost'],
  fields: [
    { k: 'order_id', label: 'Заказ', t: 'ref', ref: 'orders', req: true },
    { k: 'warehouse_id', label: 'Склад', t: 'ref', ref: 'warehouses', req: true },
    { k: 'carrier_id', label: 'Перевозчик', t: 'ref', ref: 'carriers' },
    { k: 'tracking_no', label: 'Трек-номер', t: 'text', max: 60, pattern: /^[A-Za-z0-9-]+$/ },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['pending', 'in_transit', 'delivered', 'failed'], def: 'pending', ro: true },
    { k: 'cost', label: 'Стоимость', t: 'money', def: 0, ro: true },
    { k: 'shipped_at', label: 'Отправлено', t: 'date', ro: true }
  ],
  actions: {
    ship: { perm: 'shipments.write', label: 'Отправить', fields: [{ k: 'tracking_no', t: 'text', label: 'Трек-номер', req: true }], run: ({ row, body, user, req }) => {
      if (row.status !== 'pending') throw E.conflict('bad_state');
      const t = typeof body.tracking_no === 'string' ? body.tracking_no.trim() : '';
      if (!/^[A-Za-z0-9-]{3,60}$/.test(t)) throw E.bad('invalid_tracking_no');
      return orders.shipShipment(row.id, t, user, req); } },
    deliver: { perm: 'shipments.write', label: 'Доставлено', run: ({ row, user, req }) => {
      if (row.status !== 'in_transit') throw E.conflict('bad_state');
      return orders.deliverShipment(row.id, user, req); } },
    fail: { perm: 'shipments.write', label: 'Не доставлено', confirm: true, run: ({ row, update }) => {
      if (row.status !== 'in_transit') throw E.conflict('bad_state'); return update({ status: 'failed' }); } }
  }
});

define({
  name: 'returns', table: 'm_returns', label: 'Возвраты', group: 'Логистика', perm: 'returns', title: 'id',
  filters: ['status', 'order_id'], list: ['order_id', 'product_id', 'qty', 'reason', 'status', 'disposition', 'refund_amount'],
  fields: [
    { k: 'order_id', label: 'Заказ', t: 'ref', ref: 'orders', req: true, immutable: true },
    { k: 'product_id', label: 'Товар', t: 'ref', ref: 'products', req: true, immutable: true },
    { k: 'qty', label: 'Кол-во', t: 'int', min: 1, max: 1000, req: true, immutable: true },
    { k: 'reason', label: 'Причина', t: 'enum', vals: ['defective', 'not_as_described', 'changed_mind', 'damaged_in_transit', 'other'], req: true },
    { k: 'note', label: 'Комментарий', t: 'text' },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['requested', 'approved', 'received', 'refunded', 'rejected'], def: 'requested', ro: true },
    { k: 'disposition', label: 'Куда списан товар', t: 'enum', vals: ['none', 'restock', 'refurbished', 'scrap'], def: 'none', ro: true },
    { k: 'refund_amount', label: 'Возврат денег', t: 'money', def: 0, ro: true }
  ],
  validate: (data, _u, before) => {
    if (before) return;
    const it = db.prepare('SELECT qty, returned_qty FROM m_order_items WHERE order_id=? AND product_id=?').get(data.order_id, data.product_id);
    const o = db.prepare('SELECT status FROM m_orders WHERE id=?').get(data.order_id);
    if (!it || !o || o.status !== 'delivered') throw E.conflict('not_returnable');
    const open = db.prepare("SELECT COALESCE(SUM(qty),0) n FROM m_returns WHERE order_id=? AND product_id=? AND status IN ('requested','approved','received')").get(data.order_id, data.product_id).n;
    if (it.returned_qty + open + data.qty > it.qty) throw E.conflict('qty_exceeds_order');
  },
  actions: {
    approve: { perm: 'returns.write', label: 'Одобрить', run: ({ row, update }) => { if (row.status !== 'requested') throw E.conflict('bad_state'); return update({ status: 'approved' }); } },
    reject: { perm: 'returns.write', label: 'Отклонить', confirm: true, run: ({ row, update }) => { if (row.status !== 'requested') throw E.conflict('bad_state'); return update({ status: 'rejected' }); } },
    receive: { perm: 'returns.write', label: 'Принять на складе', fields: [
      { k: 'disposition', t: 'enum', vals: ['restock', 'refurbished', 'scrap'], label: 'Решение', req: true },
      { k: 'warehouse_id', t: 'ref', ref: 'warehouses', label: 'Склад', req: true }], run: ({ row, body, update }) => {
      if (row.status !== 'approved') throw E.conflict('bad_state');
      if (!['restock', 'refurbished', 'scrap'].includes(body.disposition)) throw E.bad('invalid_disposition');
      if (!Number.isSafeInteger(body.warehouse_id) || !db.prepare('SELECT 1 FROM m_warehouses WHERE id=?').get(body.warehouse_id)) throw E.bad('invalid_warehouse_id');
      db.transaction(() => {
        const col = body.disposition === 'restock' ? 'qty' : body.disposition === 'refurbished' ? 'refurb_qty' : null;
        if (col) {                                                        // restock → sellable stock; refurbished → separate bucket (sold as "refurbished")
          db.prepare(`INSERT INTO m_stock(product_id,warehouse_id,qty,reserved,refurb_qty,reorder_level,created_at,updated_at,created_by) VALUES(?,?,0,0,0,0,?,?,'system')
            ON CONFLICT(product_id,warehouse_id) DO NOTHING`).run(row.product_id, body.warehouse_id, now(), now());
          db.prepare(`UPDATE m_stock SET ${col} = ${col} + ?, updated_at=? WHERE product_id=? AND warehouse_id=?`).run(row.qty, now(), row.product_id, body.warehouse_id);
        }
      })();
      event('return_received', { ref_type: 'return', ref_id: row.id, amount: row.qty, data: { disposition: body.disposition } });
      return update({ status: 'received', disposition: body.disposition }); } },
    refund: { perm: 'orders.write', label: 'Вернуть деньги', confirm: true, run: ({ row, user, req }) => { if (user && user.apiKey) throw E.forbidden('agent_no_refund');   // returning money is a person's decision
      if (row.status !== 'received') throw E.conflict('bad_state');
      return orders.refundReturn(row, user, req); } }
  }
});

/* ------------------------------------------------------------------ setup page: carrier catalog + coverage */
const catalog = require('../services/carrier-catalog');
const routing = require('../services/routing');
const R = require('../engine/resource');
function coverage() {
  const ws = db.prepare('SELECT * FROM m_warehouses WHERE active=1 ORDER BY priority, id').all();
  const cs = db.prepare('SELECT * FROM m_carriers').all();
  const csv = routing.csv;
  return [...catalog.EU, ...catalog.OTHER].map(cc => {
    const w = ws.filter(x => { const t = csv(x.ships_to); return !t.length || t.includes(cc); }).sort((a, b) => (a.country === cc ? 0 : 1) - (b.country === cc ? 0 : 1) || a.priority - b.priority)[0] || null;
    const serving = cs.filter(c => { const t = csv(c.countries); return !t.length || t.includes(cc); });
    const active = serving.filter(c => c.active && (c.base_cost > 0 || c.per_kg_cost > 0));
    const best = active.map(c => ({ ...c, c1: c.base_cost + c.per_kg_cost, c5: c.base_cost + c.per_kg_cost * 5 })).sort((a, b) => a.c1 - b.c1)[0] || null;
    const free = serving.filter(c => c.active && !c.base_cost && !c.per_kg_cost);
    return { country: cc, eu: catalog.EU.includes(cc), warehouse: w ? { id: w.id, name: w.name, country: w.country } : null, carrier: best ? { id: best.id, name: best.name, cost_1kg: best.c1, cost_5kg: best.c5 } : null,
      inactive: serving.filter(c => !c.active).length, zero_price: free.map(c => c.name),
      status: !w ? 'no_warehouse' : free.length && !best ? 'zero_price' : !best ? (serving.length ? 'no_tariff' : 'no_carrier') : 'ok' };
  });
}
module.exports.routes = (r, h) => {
  r.get('/logistics/setup', h.need('carriers.read'), (req, res) => {
    const have = new Set(db.prepare('SELECT code FROM m_carriers').all().map(x => x.code));
    res.json({ catalog: catalog.CATALOG.map(c => ({ ...c, added: have.has(c.id) })), coverage: coverage(),
      warehouses: db.prepare('SELECT id, name, country, ships_to, priority, active FROM m_warehouses ORDER BY priority, id').all(),
      carriers: db.prepare('SELECT id, name, code, base_cost, per_kg_cost, countries, tracking_url, active FROM m_carriers ORDER BY active DESC, name').all() });
  });
  // add a carrier from the catalog: switched OFF until a tariff is entered
  r.post('/logistics/carriers/preset', h.need('carriers.write'), (req, res) => {
    const c = catalog.byId(String((req.body || {}).id || '')); if (!c) throw E.bad('unknown_carrier');
    if (db.prepare('SELECT 1 FROM m_carriers WHERE code=?').get(c.id)) throw E.conflict('duplicate');
    const row = R.create('carriers', req.user, { name: c.name, code: c.id, base_cost: 0, per_kg_cost: 0, countries: c.countries || null, tracking_url: c.tracking, active: false }, req);
    res.status(201).json(row);
  });
};
