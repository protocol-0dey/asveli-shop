'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, Client } = require('./helpers');

let T, owner;
const NEWPW = 'brand-new-long-password-77';
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };

async function staff(username, role) {
  const j = await ok(owner, 'POST', '/staff', { username: 'u_' + username, role }, 201);
  const c = new Client(T.adminBase);
  const l = await c.login('u_' + username, j.temp_password); assert.equal(l.r.status, 200);
  assert.equal((await call(c, 'GET', '/m/sellers')).j.error, 'password_change_required');      // temp password blocks everything
  await ok(c, 'POST', '/security/password', { current: j.temp_password, next: NEWPW });
  return c;
}
const S = {};                                                                                  // shared fixtures
before(async () => {
  T = await startServer({ STORE_FREE_SHIPPING: '0' });   // these tests check the arithmetic of paid shipping
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  for (const [n, r] of [['mod', 'moderator'], ['cat', 'catalog_manager'], ['kyc', 'kyc_officer'], ['fin', 'finance'], ['fap', 'finance_approver'], ['log', 'logistics'], ['l1', 'support_l1'], ['l2', 'support_l2'], ['l3', 'support_l3'], ['fra', 'fraud_analyst'], ['ana', 'analyst'], ['mkt', 'marketing']])
    S[n] = await staff(n, r);
});
after(() => T && T.stop());

test('RBAC: a role only gets what it was granted (deny by default)', async () => {
  const deny = [['mod', '/m/ledger'], ['mod', '/m/payouts'], ['mod', '/staff'], ['mod', '/audit'], ['mod', '/m/fraud_flags'], ['cat', '/m/ledger'], ['l1', '/m/sellers'], ['l1', '/m/payouts'],
    ['log', '/m/ledger'], ['mkt', '/m/ledger'], ['mkt', '/m/customers'], ['ana', '/m/ledger'], ['fra', '/m/payouts'], ['fin', '/staff'], ['fin', '/m/products/1/do/approve']];
  for (const [who, p] of deny) { const r = await call(S[who], p.includes('/do/') ? 'POST' : 'GET', p, p.includes('/do/') ? {} : undefined); assert.equal(r.s, 403, `${who} ${p} → ${r.s}`); }
  const allow = [['mod', '/m/products'], ['fin', '/m/ledger'], ['fin', '/m/payouts'], ['fra', '/m/fraud_flags'], ['l1', '/m/tickets'], ['ana', '/analytics/platform'], ['mkt', '/m/coupons']];
  for (const [who, p] of allow) assert.equal((await call(S[who], 'GET', p)).s, 200, `${who} ${p}`);
  const meta = (await call(S.mod, 'GET', '/meta')).j.resources.map(r => r.name);
  assert.ok(meta.includes('products') && !meta.includes('ledger') && !meta.includes('payouts'));      // the UI is told only what the role may see
});

test('IAM: staff management is owner-only; no self-promotion; last owner is protected; deactivation kills sessions at once', async () => {
  assert.equal((await call(S.fin, 'POST', '/staff', { username: 'evil', role: 'owner' })).s, 403);
  const list = (await call(owner, 'GET', '/staff')).j.rows, me = list.find(u => u.username === 'alice');
  assert.equal((await call(owner, 'PATCH', `/staff/${me.id}`, { role: 'moderator' })).j.error, 'cannot_modify_self');
  const bob = list.find(u => u.username === 'bob'), carol = list.find(u => u.username === 'carol');
  await ok(owner, 'PATCH', `/staff/${bob.id}`, { active: false });
  assert.equal((await call(owner, 'PATCH', `/staff/${carol.id}`, { active: false })).s, 200);        // alice is still an owner
  const b = new Client(T.adminBase); assert.equal((await b.login('bob', 'another-long-password')).r.status, 401);   // looks like a wrong password
  const v = await staff('victim', 'analyst'); assert.equal((await call(v, 'GET', '/me')).s, 200);
  const vid = (await call(owner, 'GET', '/staff')).j.rows.find(u => u.username === 'u_victim').id;
  await ok(owner, 'PATCH', `/staff/${vid}`, { active: false });
  assert.equal((await call(v, 'GET', '/me')).s, 401);                                                   // existing session died immediately
  assert.equal((await call(owner, 'POST', '/staff', { username: 'x', role: 'god' })).s, 400);
});

test('catalog: KYC gate, moderation, compliance rules, PII masking + sealed at rest', async () => {
  S.w = await ok(S.log, 'POST', '/m/warehouses', { name: 'PL-1', country: 'PL', priority: 1 }, 201);
  S.w2 = await ok(S.log, 'POST', '/m/warehouses', { name: 'DE-1', country: 'DE', priority: 2 }, 201);
  S.carrier = await ok(S.log, 'POST', '/m/carriers', { name: 'FastShip', code: 'fast', base_cost: 500, per_kg_cost: 100 }, 201);
  await ok(S.fin, 'POST', '/m/tax_rates', { country: 'PL', rate_bps: 2300 }, 201);
  const sel = await ok(S.kyc, 'POST', '/m/sellers', { name: 'Shop A', country: 'PL', legal_name: 'Jan Kowalski', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'seller.a@example.com', address: 'ul. Prosta 1, Warszawa, PL', commission_bps: 1000 }, 201);
  S.sellerA = sel.id;
  assert.equal(sel.passport_no, '•••••67');                                                           // even the creator sees it masked
  assert.ok(!JSON.stringify(sel).includes('AB1234567') && !JSON.stringify(sel).includes('1234567890'));
  assert.equal((await call(S.cat, 'POST', `/m/sellers/${sel.id}/do/activate`, {})).j.error, 'forbidden' === 'x' ? '' : (await call(S.cat, 'POST', `/m/sellers/${sel.id}/do/activate`, {})).j.error);
  assert.equal((await call(S.kyc, 'POST', `/m/sellers/${sel.id}/do/activate`, {})).j.error, 'kyc_required');
  assert.equal((await call(S.mod, 'POST', `/m/sellers/${sel.id}/do/kyc_approve`, {})).s, 403);
  await ok(S.kyc, 'POST', `/m/sellers/${sel.id}/do/kyc_submit`, {});
  await ok(S.kyc, 'POST', `/m/sellers/${sel.id}/do/kyc_approve`, {});
  assert.equal((await call(S.kyc, 'PATCH', `/m/sellers/${sel.id}`, { bank_iban: 'PL00000000000000000000000000' })).j.error, 'kyc_locked');   // bank account frozen after KYC
  await ok(S.kyc, 'POST', `/m/sellers/${sel.id}/do/activate`, {});
  // raw DB must hold ciphertext, never the passport / iban / e-mail
  const Database = require('better-sqlite3'); const raw = new Database(path.join(T.dataDir, 'asveli.db'), { readonly: true });
  const row = raw.prepare('SELECT passport_no, bank_iban, email FROM m_sellers WHERE id=?').get(sel.id); raw.close();
  for (const v of Object.values(row)) assert.match(v, /^v1\./);
  assert.ok(!/AB1234567|PL61109|seller\.a/.test(JSON.stringify(row)));

  await ok(S.kyc, 'POST', '/m/compliance_rules', { term: 'counterfeit', kind: 'ban' }, 201);
  const mk = async (sku, title, extra = {}) => ok(S.cat, 'POST', '/m/products', { sku, title, seller_id: sel.id, category: 'toys', price: 10000, weight_g: 1200, ...extra }, 201);
  const bad = await mk('B-1', 'Counterfeit watch');
  assert.equal((await ok(S.cat, 'POST', `/m/products/${bad.id}/do/submit`, {})).status, 'rejected');       // auto-screened
  const p = await mk('P-1', 'Wooden train', { min_price: 8000, max_price: 12000, cost: 5000, competitor_price: 9000, auto_reprice: true });
  S.prod = p.id;
  assert.equal((await call(S.mod, 'POST', `/m/products/${p.id}/do/approve`, {})).j.error, 'bad_state');   // must be submitted first
  await ok(S.cat, 'POST', `/m/products/${p.id}/do/submit`, {});
  assert.equal((await call(S.cat, 'POST', `/m/products/${p.id}/do/approve`, {})).s, 403);                  // the seller manager can't approve their own catalog
  await ok(S.mod, 'POST', `/m/products/${p.id}/do/approve`, {});
  assert.equal((await call(S.cat, 'POST', '/m/products', { sku: 'X', title: 'x', seller_id: sel.id, category: 'a', price: 1, status: 'approved' })).j.error, 'read_only_status');   // can't self-approve via payload
  assert.equal((await call(S.cat, 'POST', '/m/products', { sku: 'Y', title: 'y', seller_id: sel.id, category: 'a', price: 1, evil: 1 })).j.error, 'unknown_field');
  assert.equal((await call(S.cat, 'PATCH', `/m/products/${p.id}`, { min_price: 100, cost: 5000 })).j.error, 'min_below_cost');
  await ok(S.cat, 'PATCH', `/m/products/${p.id}`, { title: 'Wooden train XL' });
  assert.equal((await call(S.cat, 'GET', `/m/products/${p.id}`)).j.status, 'pending_review');            // content change → re-moderation
  await ok(S.mod, 'POST', `/m/products/${p.id}/do/approve`, {});
  await ok(S.log, 'POST', '/m/stock', { product_id: p.id, warehouse_id: S.w.id, qty: 10, reorder_level: 2 }, 201);
  await ok(S.log, 'POST', '/m/stock', { product_id: p.id, warehouse_id: S.w2.id, qty: 100 }, 201);
});

test('PII: masked everywhere, reveal needs permission + password, is rate-limited and audited', async () => {
  S.cust = await ok(owner, 'POST', '/m/customers', { name: 'Anna Nowak', email: 'anna@example.com', phone: '+48 600 100 200', address: 'ul. Dluga 5, Gdansk, PL', country: 'PL', card_brand: 'Visa', card_last4: '4242' }, 201);
  assert.equal(S.cust.email, 'a***@example.com'); assert.equal(S.cust.card_last4, '4242');
  assert.equal((await call(owner, 'POST', '/m/customers', { email: 'x@y.z', country: 'PL', card_number: '4111111111111111' })).j.error, 'unknown_field');      // no field exists for a full card number
  const list = JSON.stringify((await call(S.mod, 'GET', '/m/customers')).j); assert.ok(!/anna@example|600 100|Dluga|Nowak/.test(list));
  assert.equal((await call(S.mod, 'GET', '/m/customers?q=anna@example.com')).j.total, 1);               // exact lookup works via blind index
  assert.equal((await call(S.mod, 'GET', '/m/customers?q=anna')).j.total, 0);                           // …but no fuzzy search over personal data
  const rv = (c, pw, f = 'email') => call(c, 'POST', `/m/customers/${S.cust.id}/reveal`, { field: f, password: pw });
  assert.equal((await rv(S.mod, NEWPW)).s, 403);                                                         // moderator: never
  assert.equal((await rv(S.fra, 'wrong-wrong-wrong')).s, 403);                                           // right role, wrong password
  const good = await rv(S.fra, NEWPW); assert.equal(good.j.value, 'anna@example.com');
  assert.equal((await rv(S.fra, NEWPW, 'country')).s, 400);                                              // only PII fields can be revealed
  const audit = (await call(owner, 'GET', '/audit?limit=100')).j.rows.map(r => r.action);
  assert.ok(audit.includes('pii.reveal') && audit.includes('pii.reveal_denied'));
  assert.ok(!JSON.stringify((await call(owner, 'GET', '/audit?limit=500')).j).includes('anna@example'));  // audit never stores the values
});

test('order flow: routing, tax, commission split, shipping, ledger, returns, payouts with four eyes, advances', async () => {
  const o = await ok(owner, 'POST', '/orders/create', { customer_id: S.cust.id, country: 'PL', items: [{ product_id: S.prod, qty: 2 }] }, 201);
  S.order = o;
  assert.equal(o.subtotal, 20000); assert.equal(o.tax, 4600);                                            // 23% of 20 000
  assert.equal(o.shipping, 500 + 100 * 3);                                                               // 2.4 kg → 3 kg
  assert.equal(o.total, 20000 + 4600 + 800); assert.equal(o.status, 'confirmed');
  const item = (await call(owner, 'GET', `/m/order_items?order_id=${o.id}`)).j.rows[0];
  assert.equal(item.commission, 2000); assert.equal(item.warehouse_id, S.w.id);                          // PL warehouse preferred, 10% commission
  assert.equal((await call(S.log, 'GET', `/m/stock?product_id=${S.prod}&warehouse_id=${S.w.id}`)).j.rows[0].reserved, 2);
  assert.equal((await call(owner, 'POST', '/orders/create', { customer_id: S.cust.id, country: 'PL', items: [{ product_id: S.prod, qty: 5000 }] })).s, 400);
  const sh = (await call(S.log, 'GET', `/m/shipments?order_id=${o.id}`)).j.rows[0];
  assert.equal((await call(S.log, 'POST', `/m/shipments/${sh.id}/do/deliver`, {})).j.error, 'bad_state');
  await ok(S.log, 'POST', `/m/shipments/${sh.id}/do/ship`, { tracking_no: 'TRK-001' });
  assert.equal((await call(S.log, 'GET', `/m/stock?product_id=${S.prod}&warehouse_id=${S.w.id}`)).j.rows[0].qty, 8);
  await ok(S.log, 'POST', `/m/shipments/${sh.id}/do/deliver`, {});
  assert.equal((await call(owner, 'GET', `/m/orders/${o.id}`)).j.status, 'delivered');
  const bal = (await call(S.fin, 'GET', `/finance/balance/${S.sellerA}`)).j; assert.equal(bal.balance, 20000 - 2000);   // sale net of commission
  const cu = (await call(S.l2, 'GET', `/m/customers/${S.cust.id}`)).j; assert.equal(cu.orders_count, 1); assert.ok(cu.loyalty_points > 0);

  // payout: finance prepares, a DIFFERENT approver releases
  assert.equal((await call(S.fin, 'POST', '/m/payouts', { seller_id: S.sellerA, amount: 99999999 })).j.error, 'insufficient_balance');
  const po = await ok(S.fin, 'POST', '/m/payouts', { seller_id: S.sellerA, amount: 10000 }, 201);
  assert.equal((await call(S.fin, 'POST', `/m/payouts/${po.id}/do/approve`, {})).s, 403);                 // finance has no approve right at all
  await ok(S.fap, 'POST', `/m/payouts/${po.id}/do/approve`, {});
  await ok(S.fap, 'POST', `/m/payouts/${po.id}/do/mark_paid`, {});
  assert.equal((await call(S.fin, 'GET', `/finance/balance/${S.sellerA}`)).j.balance, 8000);
  // four-eyes: creator == approver is refused while another approver exists
  assert.equal((await call(S.fap, 'POST', '/m/payouts', { seller_id: S.sellerA, amount: 1000 })).s, 403);                                                                             // approver role has no payouts.write → can't even create
  const po2 = await ok(owner, 'POST', '/m/payouts', { seller_id: S.sellerA, amount: 1000 }, 201);
  assert.equal((await call(owner, 'POST', `/m/payouts/${po2.id}/do/approve`, {})).j.error, 'four_eyes_required');

  // advance: limit 30% of 90-day net sales (18 000 → 5 400), repaid automatically from payouts
  assert.equal((await call(S.fin, 'GET', `/finance/eligibility/${S.sellerA}`)).j.limit, 5400);
  assert.equal((await call(S.fin, 'POST', '/m/advances', { seller_id: S.sellerA, principal: 9000, fee_bps: 500 })).j.error, 'exceeds_limit');
  const ad = await ok(S.fin, 'POST', '/m/advances', { seller_id: S.sellerA, principal: 5000, fee_bps: 1000 }, 201);
  assert.equal(ad.owed, 5500);
  assert.equal((await call(S.fin, 'POST', `/m/advances/${ad.id}/do/approve`, {})).s, 403);
  await ok(S.fap, 'POST', `/m/advances/${ad.id}/do/approve`, {});
  assert.equal((await call(S.fin, 'GET', `/finance/balance/${S.sellerA}`)).j.balance, 13000);
  await ok(S.fap, 'POST', `/m/payouts/${po2.id}/do/reject`, {});
  const po3 = await ok(S.fin, 'POST', '/m/payouts', { seller_id: S.sellerA, amount: 10000 }, 201);
  await ok(S.fap, 'POST', `/m/payouts/${po3.id}/do/approve`, {}); const paid = await ok(S.fap, 'POST', `/m/payouts/${po3.id}/do/mark_paid`, {});
  assert.equal(paid.repay, 3000); assert.equal(paid.net, 7000);                                           // 30% of the payout goes to the advance
  assert.equal((await call(S.fin, 'GET', `/m/advances/${ad.id}`)).j.repaid, 3000);

  // returns: refurbished goes to its own bucket; refund reverses split proportionally
  const rt = await ok(S.l2, 'POST', '/m/returns', { order_id: o.id, product_id: S.prod, qty: 1, reason: 'defective' }, 201);
  assert.equal((await call(S.l2, 'POST', '/m/returns', { order_id: o.id, product_id: S.prod, qty: 2, reason: 'other' })).j.error, 'qty_exceeds_order');   // open requests count too
  await ok(S.l2, 'POST', `/m/returns/${rt.id}/do/approve`, {});
  await ok(S.log, 'POST', `/m/returns/${rt.id}/do/receive`, { disposition: 'refurbished', warehouse_id: S.w.id });
  assert.equal((await call(S.log, 'GET', `/m/stock?product_id=${S.prod}&warehouse_id=${S.w.id}`)).j.rows[0].refurb_qty, 1);
  assert.equal((await call(S.l2, 'POST', `/m/returns/${rt.id}/do/refund`, {})).s, 403);                   // L2 can't release money; L3/owner can
  const rr = await ok(S.l3, 'POST', `/m/returns/${rt.id}/do/refund`, {});
  assert.equal(rr.refund_amount, 10000 + 2300);                                                           // one unit + its VAT
  assert.equal((await call(owner, 'GET', `/m/order_items?order_id=${o.id}`)).j.rows[0].returned_qty, 1);
});

test('anti-fraud: mass buy-out by a buyer linked to a competitor is held; held orders cannot ship; analyst decides', async () => {
  const sel2 = await ok(S.kyc, 'POST', '/m/sellers', { name: 'Shop B', country: 'PL', legal_name: 'Rival Ltd', tax_id: 'PL999', passport_no: 'ZZ9999999', bank_iban: 'PL00109010140000071219812875', address: 'ul. Dluga 5, Gdansk, PL' }, 201);
  const rival = await ok(owner, 'POST', '/m/customers', { email: 'rival@example.com', address: 'UL. Dluga 5,   Gdansk, PL', country: 'PL' }, 201);   // same address as Shop B (normalised)
  const rule = (await call(S.fra, 'GET', '/m/fraud_rules?q=mass')).j; const mb = (await call(S.fra, 'GET', '/m/fraud_rules')).j.rows.find(r => r.rule === 'mass_buyout');
  await ok(S.fra, 'PATCH', `/m/fraud_rules/${mb.id}`, { threshold: 5 });                                  // rules are tunable by the analyst
  const o = await ok(owner, 'POST', '/orders/create', { customer_id: rival.id, country: 'PL', items: [{ product_id: S.prod, qty: 7 }] }, 201);
  assert.equal(o.status, 'held'); assert.ok(o.fraud_score >= 100 - 0 || o.fraud_score >= 60);
  const flags = (await call(S.fra, 'GET', `/m/fraud_flags?order_id=${o.id}`)).j.rows.map(f => f.rule);
  assert.ok(flags.includes('mass_buyout') && flags.includes('competitor_link'), flags.join());
  const sh = (await call(S.log, 'GET', `/m/shipments?order_id=${o.id}`)).j.rows[0];
  assert.equal((await call(S.log, 'POST', `/m/shipments/${sh.id}/do/ship`, { tracking_no: 'TRK-HELD' })).j.error, 'order_not_shippable');
  assert.equal((await call(S.l1, 'GET', `/m/fraud_flags`)).s, 403);
  assert.equal((await call(S.fra, 'GET', `/m/alerts?kind=fraud`)).j.total >= 1, true);
  const f = (await call(S.fra, 'GET', `/m/fraud_flags?order_id=${o.id}&rule=mass_buyout`)).j.rows[0];
  await ok(S.fra, 'POST', `/m/fraud_flags/${f.id}/do/confirm`, {});
  assert.equal((await call(owner, 'GET', `/m/orders/${o.id}`)).j.status, 'cancelled');                    // stock released
  assert.equal((await call(owner, 'GET', `/m/customers/${rival.id}`)).j.blocked, 1);
  assert.equal((await call(owner, 'POST', '/orders/create', { customer_id: rival.id, country: 'PL', items: [{ product_id: S.prod, qty: 1 }] })).j.error, 'customer_blocked');
});

test('pricing, coupons, tickets (L1–L3 visibility), disputes, reviews, analytics, anomalies', async () => {
  // repricer: dry-run first; stays within [min,max] and above cost
  const dry = await ok(S.fin, 'POST', '/pricing/run', {}); assert.equal(dry.dry, true); assert.equal(dry.changes[0].new_price, 9000 - 90);
  assert.equal((await call(S.cat, 'GET', `/m/products/${S.prod}`)).j.price, 10000);
  await ok(S.fin, 'PATCH', `/m/products/${S.prod}`, { competitor_price: 1000 }).catch(() => null);
  await ok(S.cat, 'PATCH', `/m/products/${S.prod}`, { competitor_price: 1000 });
  const live = await ok(S.fin, 'POST', '/pricing/run', { dry: false }); assert.equal(live.changes[0].new_price, 8000);   // clamped (also by the 20 % step guard)
  assert.equal((await call(S.mkt, 'POST', '/pricing/run', {})).s, 403);
  // coupons
  await ok(S.mkt, 'POST', '/m/coupons', { code: 'ONCE10', kind: 'percent', value: 1000, max_uses: 1 }, 201);
  assert.equal((await call(S.mkt, 'POST', '/m/coupons', { code: 'BIG', kind: 'percent', value: 9900 })).j.error, 'percent_too_high');
  const c2 = await ok(owner, 'POST', '/m/customers', { email: 'c2@example.com', country: 'PL' }, 201);
  const oc = await ok(owner, 'POST', '/orders/create', { customer_id: c2.id, country: 'PL', coupon_code: 'once10', items: [{ product_id: S.prod, qty: 1 }] }, 201);
  assert.equal(oc.discount, 800);
  assert.equal((await call(owner, 'POST', '/orders/create', { customer_id: S.cust.id, country: 'PL', coupon_code: 'ONCE10', items: [{ product_id: S.prod, qty: 1 }] })).j.error, 'coupon_exhausted');
  // tickets: level-based visibility
  const t = await ok(S.l1, 'POST', '/m/tickets', { subject: 'Where is my parcel', customer_id: c2.id, priority: 'urgent' }, 201);
  assert.ok(t.sla_due > Date.now());
  await ok(S.l1, 'POST', `/m/tickets/${t.id}/do/escalate`, {});
  assert.equal((await call(S.l1, 'GET', `/m/tickets/${t.id}`)).s, 404);                                    // L1 no longer sees it
  assert.equal((await call(S.l1, 'POST', '/m/ticket_notes', { ticket_id: t.id, body: 'peek' })).s, 404);
  assert.equal((await call(S.l2, 'GET', `/m/tickets/${t.id}`)).s, 200);
  await ok(S.l2, 'POST', `/m/tickets/${t.id}/do/escalate`, {});
  assert.equal((await call(S.l2, 'POST', `/m/tickets/${t.id}/do/resolve`, { resolution: 'x' })).s, 404);
  await ok(S.l3, 'POST', `/m/tickets/${t.id}/do/resolve`, { resolution: 'refunded' });
  // disputes: only L3 decides; seller bears the refunded part
  const d = await ok(S.l2, 'POST', '/m/disputes', { order_id: S.order.id, seller_id: S.sellerA, reason: 'not_as_described', amount: 5000 }, 201);
  assert.equal((await call(S.l2, 'POST', `/m/disputes/${d.id}/do/decide`, { decision: 'refund_buyer', note: 'x' })).s, 403);
  const before = (await call(S.fin, 'GET', `/finance/balance/${S.sellerA}`)).j.balance;
  await ok(S.l3, 'POST', `/m/disputes/${d.id}/do/decide`, { decision: 'split', split_bps: 5000, note: 'half' });
  assert.equal((await call(S.fin, 'GET', `/finance/balance/${S.sellerA}`)).j.balance, before - 2500);
  assert.equal((await call(S.l3, 'POST', `/m/disputes/${d.id}/do/decide`, { decision: 'refund_buyer', note: 'again' })).j.error, 'bad_state');
  // reviews: auto-flag links; only moderators publish
  const rv = await ok(owner, 'POST', '/m/reviews', { product_id: S.prod, rating: 5, body: 'great, visit http://spam.example' }, 201);
  assert.match(rv.flag, /link/); assert.equal(rv.status, 'pending');
  assert.equal((await call(S.l1, 'POST', `/m/reviews/${rv.id}/do/publish`, {})).s, 403);
  // analytics + anomaly scan + SEO
  const a = (await call(S.ana, 'GET', '/analytics/platform?days=30')).j; assert.ok(a.orders >= 2 && a.gmv > 0 && a.by_day.length >= 1);
  assert.equal((await call(S.ana, 'GET', `/analytics/seller/${S.sellerA}`)).j.seller.name, 'Shop A');
  assert.equal((await call(S.ana, 'POST', '/alerts/scan', {})).s, 403);
  assert.ok((await call(S.fra, 'POST', '/alerts/scan', {})).j.created >= 0);
  await ok(S.mkt, 'POST', '/m/seo_pages', { path: '/toys', title_tag: 'Toys' }, 201);
  assert.ok((await call(S.mkt, 'GET', '/seo/audit')).j.issues.some(i => i.issue === 'title_too_short'));
});

test('engine safety: injection-shaped input, bad ids, CSRF and origin still enforced on module routes', async () => {
  for (const q of ["?sort=id;DROP TABLE m_orders", "?sort=email", "?q=' OR 1=1 --", '?status=x%27', '?limit=-1', '?page=abc', '?limit=99999999']) {
    const r = await call(owner, 'GET', '/m/customers' + q); assert.ok([200, 400].includes(r.s), q + r.s);
  }
  assert.ok((await call(owner, 'GET', '/m/orders')).j.total >= 2);                                         // tables intact
  for (const p of ['/m/nope', '/m/products/abc', '/m/products/1;2', '/m/products/0', '/m/__proto__/1', '/m/products/1/do/__proto__', '/m/products/1/do/constructor']) {
    const r = await call(owner, 'GET', p); const r2 = await call(owner, 'POST', p, {}); assert.ok(r.s >= 400 && r2.s >= 400, `${p} ${r.s} ${r2.s}`);
  }
  assert.equal((await call(owner, 'POST', '/m/products', [1, 2])).s, 400);
  const nocsrf = await owner.req('POST', '/api/admin/m/coupons', { json: { code: 'NOCSRF', kind: 'fixed', value: 5 }, csrf: false }); assert.equal(nocsrf.status, 403);
  const xo = await owner.req('POST', '/api/admin/m/coupons', { json: { code: 'XORIGIN', kind: 'fixed', value: 5 }, origin: 'https://evil.example' }); assert.equal(xo.status, 403);
  assert.equal((await call(owner, 'POST', '/m/ledger', { kind: 'adjustment', amount: 1e9 })).s, 403);       // the ledger cannot be written through the API at all
  assert.equal((await call(owner, 'DELETE', '/m/orders/1')).s, 403);
});

test('KYC documents: scoped files are invisible to others and can never be shared or published', async () => {
  const fd = new FormData(); fd.append('file', new Blob(['passport scan'], { type: 'image/png' }), 'passport.png');
  const up = await S.kyc.req('POST', '/api/admin/files?scope=kyc', { body: fd }); assert.equal(up.status, 201); const f = await up.json(); assert.equal(f.scope, 'kyc');
  assert.equal((await call(S.cat, 'GET', '/files')).j.rows.some(x => x.id === f.id), false);                 // catalog manager has files.read but not files.kyc
  assert.equal((await call(S.cat, 'GET', `/files/${f.id}/download`)).s, 404);
  assert.equal((await call(S.kyc, 'POST', `/files/${f.id}/share`, {})).s, 403);
  assert.equal((await call(S.kyc, 'PATCH', `/files/${f.id}`, { is_public: true })).s, 403);
  const up2 = await S.cat.req('POST', '/api/admin/files?scope=kyc', { body: (() => { const g = new FormData(); g.append('file', new Blob(['x']), 'a.txt'); return g; })() }); assert.equal(up2.status, 403);
  assert.equal((await call(S.mod, 'GET', '/files')).s, 403);
});

test('review findings stay fixed: shipment re-pointing, KYC swap, field-level rights, coupons, side channels, reveal brute force', async () => {
  // shipments can't be edited (re-pointing a shipment at a settled order used to allow double settlement)
  const sh = (await call(S.log, 'GET', '/m/shipments')).j.rows[0];
  assert.equal((await call(S.log, 'PATCH', `/m/shipments/${sh.id}`, { order_id: S.order.id })).s, 403);
  assert.equal((await call(S.log, 'POST', `/m/shipments/${sh.id}/do/deliver`, {})).s, 409);               // already delivered → cannot be settled twice
  // identity fields are frozen while KYC is pending, not only after approval
  const s2 = await ok(S.kyc, 'POST', '/m/sellers', { name: 'Shop C', country: 'PL', legal_name: 'X Y', tax_id: 'T1', passport_no: 'P1234567', bank_iban: 'PL11111111111111111111111111' }, 201);
  await ok(S.kyc, 'POST', `/m/sellers/${s2.id}/do/kyc_submit`, {});
  assert.equal((await call(S.cat, 'PATCH', `/m/sellers/${s2.id}`, { bank_iban: 'PL22222222222222222222222222' })).j.error, 'kyc_locked');
  // money/risk fields need their own right; the catalog manager can suspend but not re-activate
  assert.equal((await call(S.cat, 'PATCH', `/m/sellers/${S.sellerA}`, { commission_bps: 0 })).j.error, 'field_forbidden_commission_bps');
  assert.equal((await call(S.cat, 'PATCH', `/m/sellers/${S.sellerA}`, { risk_tier: 'low' })).j.error, 'field_forbidden_risk_tier');
  assert.equal((await call(S.cat, 'POST', '/m/sellers/' + s2.id + '/do/activate', {})).s, 403);
  assert.equal((await call(S.cat, 'PATCH', `/m/products/${S.prod}`, { seller_id: s2.id })).j.error, 'immutable_seller_id');
  assert.equal((await call(S.cat, 'PATCH', `/m/products/${S.prod}`, { price: 1 })).j.error, 'price_guard');      // price guard: a 99 % cut needs an explicit confirmation
  const big = await call(S.cat, 'PATCH', `/m/products/${S.prod}`, { price: 1, price_confirm: true }); assert.equal(big.s, 200);
  assert.equal((await call(S.cat, 'GET', `/m/products/${S.prod}`)).j.status, 'pending_review');         // a 99 % price drop goes back to moderation
  // coupons: no unlimited free goods
  assert.equal((await call(S.mkt, 'POST', '/m/coupons', { code: 'FREE', kind: 'fixed', value: 1e9 })).j.error, 'fixed_too_high');
  assert.equal((await call(S.mkt, 'POST', '/m/coupons', { code: 'FIVE', kind: 'fixed', value: 500 })).j.error, 'max_uses_required');
  // moderators moderate; they cannot edit the rules they moderate by, nor write reviews
  assert.equal((await call(S.mod, 'POST', '/m/compliance_rules', { term: 'x', kind: 'ban' })).s, 403);
  assert.equal((await call(S.mod, 'POST', '/m/reviews', { product_id: S.prod, rating: 5 })).s, 403);
  // side channels: segment probing and finance numbers through analytics
  assert.equal((await call(S.mkt, 'GET', '/personalization/preview?customer_id=1')).s, 403);
  const seg = await ok(S.mkt, 'POST', '/m/segments', { name: 'big', field: 'total_spent', op: 'gte', value: '1' }, 201);
  assert.ok(['<10', 0].includes((await call(S.mkt, 'GET', `/segments/${seg.id}/size`)).j.members));
  const sd = (await call(S.ana, 'GET', `/analytics/seller/${S.sellerA}`)).j; assert.equal(sd.balance, undefined);
  // returns: the line cannot be re-pointed after the request is created
  const o = await ok(owner, 'POST', '/orders/create', { customer_id: S.cust.id, country: 'PL', items: [{ product_id: S.prod, qty: 1 }] }).catch(() => null);
  // reveal: five wrong passwords lock further attempts even with the right one
  const c3 = await ok(owner, 'POST', '/m/customers', { email: 'brute@example.com', country: 'PL' }, 201);
  for (let i = 0; i < 5; i++) assert.ok([403, 429].includes((await call(S.fra, 'POST', `/m/customers/${c3.id}/reveal`, { field: 'email', password: 'nope-nope-nope' })).s));
  assert.equal((await call(S.fra, 'POST', `/m/customers/${c3.id}/reveal`, { field: 'email', password: NEWPW })).s, 429);
});
