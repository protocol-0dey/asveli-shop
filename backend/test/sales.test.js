'use strict';
// Sales & marketing department for the AI manager (Argon) and the owner-away hand-over: roles, limits, reports, card audit, price plans.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

let T, owner, seller, wh;
const call = async (c, method, url, json) => { const r = await c.req(method, '/api/admin' + url, json === undefined ? {} : { json }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const ok = async (c, method, url, json, status) => { const r = await call(c, method, url, json); assert.ok(status ? r.s === status : r.s < 300, `${method} ${url} → ${r.s} ${JSON.stringify(r.j)}`); return r.j; };
const api = async (method, url, { token, json } = {}) => {
  const h = { Origin: 'http://localhost:5173' }; if (token) h.Authorization = 'Bearer ' + token; if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(T.base + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  let body = null; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
let n = 0;
async function product(extra, stock = 10) {
  n++;
  const p = await ok(owner, 'POST', '/m/products', { sku: 'MP-' + n, seller_id: seller.id, category: 'Электроника и Гаджеты', description: 'Test product for the marketplace tree.', price: 10000, ...extra }, 201);
  await ok(owner, 'POST', `/m/products/${p.id}/do/submit`, {}); await ok(owner, 'POST', `/m/products/${p.id}/do/approve`, {});
  if (stock) await ok(owner, 'POST', '/m/stock', { product_id: p.id, warehouse_id: wh.id, qty: stock }, 201);
  return p;
}
const slugOf = async id => (await ok(owner, 'GET', `/m/products/${id}`)).model_slug || `p-${id}`;
async function buyer(i) {
  return (await api('POST', '/api/store/auth/register', { json: { email: `buyer${i}@example.com`, password: 'longenough-pass-1', name: 'Anna Nowak', country: 'PL' } })).body.token;
}

before(async () => {
  T = await startServer({ SESSION_SECRET: 'test-session-secret-0123456789abcdef-xyz', DATA_ENCRYPTION_KEY: 'test-data-key-0123456789abcdef-0123456789', JOBS: '0', STORE_INDEX_TTL_MS: '1' });
  owner = new Client(T.adminBase); await owner.login('alice', 'correct-horse-battery');
  seller = await ok(owner, 'POST', '/m/sellers', { name: 'Tech Shop', country: 'PL', legal_name: 'Tech Shop Sp. z o.o.', tax_id: 'PL1234567890', passport_no: 'AB1234567', bank_iban: 'PL61109010140000071219812874', email: 'tech@example.com', address: 'ul. Prosta 1, Warszawa, PL' }, 201);
  for (const a of ['kyc_submit', 'kyc_approve', 'activate']) await ok(owner, 'POST', `/m/sellers/${seller.id}/do/${a}`, {});
  wh = await ok(owner, 'POST', '/m/warehouses', { name: 'Warszawa', country: 'PL', priority: 1 }, 201);
});
after(() => T && T.stop());

const agent = async (token, method, url, json) => {
  const res = await fetch(T.adminBase + '/api/admin' + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
  let j = null; try { j = await res.json(); } catch { /* empty */ } return { s: res.status, j };
};

test('the sales key works as the sales department; the owner hands over the store and takes it back; limits hold in every mode', async () => {
  const key = (await ok(owner, 'POST', '/apikeys', { name: 'Argon', role: 'sales_manager', days: 30 }, 201)).token;
  const p = await product({ title: 'Folia stretch 23 mic 1,5 kg transparentna', cost: 6000, price: 10000, competitor_price: 9500 });
  const draft = await ok(owner, 'POST', '/m/products', { sku: 'DRAFT-1', seller_id: seller.id, category: 'packaging', title: 'Karton klapowy 300x200x150', description: 'Mocny karton.', price: 500 }, 201);
  await ok(owner, 'POST', `/m/products/${draft.id}/do/submit`, {});

  // normal mode: sales department
  let me = await agent(key, 'GET', '/sales/me');
  assert.equal(me.s, 200); assert.equal(me.j.role, 'sales_manager'); assert.equal(me.j.owner_away, false);
  const dash = await agent(key, 'GET', '/sales/dashboard'); assert.equal(dash.s, 200); assert.ok(dash.j.queues.products_pending_review >= 1);
  const cards = await agent(key, 'GET', '/sales/cards?limit=5'); assert.equal(cards.s, 200); assert.ok(cards.j.items[0].issues.length > 0);
  assert.equal((await agent(key, 'POST', `/m/products/${draft.id}/do/approve`, {})).s, 403);          // approving needs the owner (or hand-over)
  assert.equal((await agent(key, 'PUT', '/delegate', { on: true })).s, 403);                         // an agent never hands the store to itself
  assert.equal((await agent(key, 'GET', '/delegate/report')).s, 403);

  // limits: never below cost, at most 15 % per edit, coupons at most 30 %
  let r = await agent(key, 'PATCH', `/m/products/${p.id}`, { price: 8000 }); assert.equal(r.s, 400); assert.equal(r.j.error, 'agent_price_step');
  r = await agent(key, 'PATCH', `/m/products/${p.id}`, { price: 9200 }); assert.equal(r.s, 200, JSON.stringify(r.j));
  const cheap = await product({ title: 'Taśma pakowa 48 mm', cost: 1000, price: 1100 });
  r = await agent(key, 'PATCH', `/m/products/${cheap.id}`, { price: 990 }); assert.equal(r.j.error, 'agent_below_cost');
  r = await agent(key, 'POST', '/m/coupons', { code: 'ARGON50', kind: 'percent', value: 5000, max_uses: 10 }); assert.equal(r.j.error, 'agent_discount_limit');
  r = await agent(key, 'POST', '/m/coupons', { code: 'ARGON10', kind: 'percent', value: 1000 }); assert.equal(r.s, 201, JSON.stringify(r.j));

  // price plan against competitors: dry run, then apply — the plan respects cost and the agent step
  const plan = await agent(key, 'POST', '/sales/prices/plan', { rule: 'competitor', ids: [p.id], undercut_pct: 1 });
  assert.equal(plan.s, 200); assert.equal(plan.j.dry, true); assert.equal(plan.j.changes[0].new_price, Math.round(9500 * 0.99));
  const done = await agent(key, 'POST', '/sales/prices/plan', { rule: 'competitor', ids: [p.id], undercut_pct: 1, apply: true });
  assert.equal(done.j.applied, 1, JSON.stringify(done.j));
  assert.equal((await ok(owner, 'GET', `/m/products/${p.id}`)).price, Math.round(9500 * 0.99));
  const st = await agent(key, 'GET', '/sales/stock'); assert.equal(st.s, 200); assert.ok(st.j.items.length >= 1);
  assert.equal((await agent(key, 'GET', '/sales/promo')).s, 200);

  // owner away: the same key now runs the store (approves products), still under the limits
  const on = await ok(owner, 'PUT', '/delegate', { on: true, hours: 48, price_pct: 10, discount_pct: 20, note: 'urlop' });
  assert.equal(on.on, true); assert.ok(on.until > Date.now() + 47 * 3600e3);
  me = await agent(key, 'GET', '/sales/me'); assert.equal(me.j.role, 'store_manager'); assert.equal(me.j.owner_away, true); assert.equal(me.j.limits.price_change_pct, 10);
  r = await agent(key, 'POST', `/m/products/${draft.id}/do/approve`, {}); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await agent(key, 'POST', '/m/coupons', { code: 'ARGON25', kind: 'percent', value: 2500 }); assert.equal(r.j.error, 'agent_discount_limit');
  assert.equal((await agent(key, 'PUT', '/delegate', { on: false })).s, 403);
  assert.equal((await agent(key, 'GET', '/m/payouts')).s, 403);                                        // money out stays with people
  const rep = await ok(owner, 'GET', '/delegate/report');
  assert.ok(rep.total >= 1 && rep.recent.every(x => x.actor.startsWith('api:')), JSON.stringify(rep).slice(0, 300));

  // owner is back
  await ok(owner, 'PUT', '/delegate', { on: false });
  me = await agent(key, 'GET', '/sales/me'); assert.equal(me.j.role, 'sales_manager');
  const d2 = await ok(owner, 'POST', '/m/products', { sku: 'DRAFT-2', seller_id: seller.id, category: 'packaging', title: 'Karton klapowy 400x300x200', description: 'Mocny karton.', price: 700 }, 201);
  await ok(owner, 'POST', `/m/products/${d2.id}/do/submit`, {});
  assert.equal((await agent(key, 'POST', `/m/products/${d2.id}/do/approve`, {})).s, 403);
});

test('sub-agents: the AI manager makes narrow helpers with a brief; no escalation, no nesting, revoked with their creator', async () => {
  const argon = (await ok(owner, 'POST', '/apikeys', { name: 'Argon2', role: 'sales_manager', days: 60 }, 201)).token;
  const list = await agent(argon, 'GET', '/agents'); assert.equal(list.s, 200);
  const allowed = list.j.roles.map(r => r.id);
  assert.ok(allowed.includes('copywriter') && allowed.includes('pricing_analyst') && !allowed.includes('support_l1'), JSON.stringify(allowed));   // support is outside sales_manager
  let r = await agent(argon, 'POST', '/agents', { name: 'Argon-Copy', role: 'copywriter', brief: 'Rewrite the 20 worst packaging cards. Facts only from the source, no claims.', days: 200 });
  assert.equal(r.j.error, 'invalid_days');
  r = await agent(argon, 'POST', '/agents', { name: 'Argon-Copy', role: 'copywriter', brief: 'short' }); assert.equal(r.j.error, 'brief_required');
  r = await agent(argon, 'POST', '/agents', { name: 'Argon-Boss', role: 'store_manager', brief: 'Try to get more rights than my creator has.' }); assert.equal(r.s, 403);
  r = await agent(argon, 'POST', '/agents', { name: 'Argon-Owner', role: 'owner', brief: 'Try to get more rights than my creator has.' }); assert.equal(r.s, 403);
  const copy = await agent(argon, 'POST', '/agents', { name: 'Argon-Copy', role: 'copywriter', brief: 'Rewrite the 20 worst packaging cards. Facts only from the source, no claims.' });
  assert.equal(copy.s, 201, JSON.stringify(copy.j)); assert.ok(copy.j.token && copy.j.expires_at <= Date.now() + 60 * 864e5 + 1000);

  // the helper reads its brief, works inside its role, cannot make helpers
  const me = await agent(copy.j.token, 'GET', '/agents/me');
  assert.equal(me.j.base_role, 'copywriter'); assert.match(me.j.brief, /worst packaging cards/); assert.equal(me.j.created_by, 'Argon2');
  assert.equal((await agent(copy.j.token, 'GET', '/sales/cards?limit=3')).s, 200);
  assert.equal((await agent(copy.j.token, 'POST', '/m/coupons', { code: 'COPY10', kind: 'percent', value: 1000 })).s, 403);
  assert.equal((await agent(copy.j.token, 'POST', '/agents', { name: 'Nested', role: 'analyst', brief: 'A helper of a helper must not exist.' })).s, 403);

  // owner away does not let the manager hand out store rights that outlive the hand-over
  await ok(owner, 'PUT', '/delegate', { on: true, hours: 2 });
  assert.ok(!(await agent(argon, 'GET', '/agents')).j.roles.some(x => x.id === 'support_l1'));
  await ok(owner, 'PUT', '/delegate', { on: false });

  // the owner sees every sub-agent; revoking the creator switches its helpers off
  const all = await ok(owner, 'GET', '/agents'); assert.ok(all.agents.some(a => a.name === 'Argon-Copy' && a.parent_id));
  const keysList = (await ok(owner, 'GET', '/apikeys')).keys; const argonId = keysList.find(k => k.name === 'Argon2').id;
  await ok(owner, 'DELETE', `/apikeys/${argonId}`);
  assert.equal((await agent(copy.j.token, 'GET', '/agents/me')).s, 401);
});
