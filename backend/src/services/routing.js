'use strict';
const { db } = require('../db');
const { E } = require('../engine/errors');

const csv = v => (v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Order routing: for one order line pick the warehouse that (1) is active, (2) ships to the destination, (3) holds enough free stock
// for the WHOLE line, preferring a warehouse in the destination country, then by priority number (lower first), then most free stock.
// A line is never split across warehouses (MVP rule) — if no single warehouse can serve it the order is rejected as out_of_stock.
function pickWarehouse(productId, qty, country) {
  const rows = db.prepare(`SELECT w.id, w.country, w.priority, w.ships_to, s.id stock_id, (s.qty - s.reserved) free
    FROM m_stock s JOIN m_warehouses w ON w.id = s.warehouse_id
    WHERE s.product_id = ? AND w.active = 1 AND (s.qty - s.reserved) >= ?`).all(productId, qty);
  const ok = rows.filter(w => { const t = csv(w.ships_to); return !t.length || t.includes(country); });
  ok.sort((a, b) => (a.country === country ? 0 : 1) - (b.country === country ? 0 : 1) || a.priority - b.priority || b.free - a.free);
  return ok[0] || null;
}

// Cheapest active carrier that serves the destination: base + per_kg × ceil(kg).
function pickCarrier(country, weightG) {
  const kg = Math.max(1, Math.ceil(weightG / 1000));
  const cs = db.prepare('SELECT * FROM m_carriers WHERE active=1').all()
    .filter(c => { const t = csv(c.countries); return !t.length || t.includes(country); })
    .map(c => ({ ...c, cost: c.base_cost + c.per_kg_cost * kg }))
    .sort((a, b) => a.cost - b.cost || a.id - b.id);
  return cs[0] || null;
}
function releaseReservation(orderId) {
  for (const it of db.prepare('SELECT product_id, warehouse_id, qty FROM m_order_items WHERE order_id=?').all(orderId))
    db.prepare('UPDATE m_stock SET reserved = MAX(0, reserved - ?) WHERE product_id=? AND warehouse_id=?').run(it.qty, it.product_id, it.warehouse_id);
}
// Store policy: delivery is free for the buyer on every order, even a single item (setting store.free_shipping or env STORE_FREE_SHIPPING; on unless '0').
// The carrier is still picked and its cost kept on the shipment for the platform's own accounting.
const freeShipping = () => { let v; try { v = require('../db').getSetting('store.free_shipping'); } catch { /* no db */ } return (v ?? process.env.STORE_FREE_SHIPPING ?? '1') !== '0'; };
const buyerShipping = cost => (freeShipping() ? 0 : cost);
module.exports = { pickWarehouse, pickCarrier, releaseReservation, csv, E, freeShipping, buyerShipping };
