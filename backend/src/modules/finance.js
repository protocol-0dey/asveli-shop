'use strict';
/* MODULE 3 — Finance & pricing: tax rates, ledger (the single source of truth for money), payouts with four-eyes approval,
   seller advances (lending), dynamic repricer. All amounts are integer minor units (cents). */
const { define } = require('../engine/registry');
const { E } = require('../engine/errors');
const { db, audit } = require('../db');
const { ROLES } = require('../iam/permissions');
const C = require('../services/common');
const repricer = require('../services/repricer');

define({
  name: 'tax_rates', table: 'm_tax_rates', label: 'Налоги (VAT)', group: 'Финансы и цены', perm: 'tax', title: 'country',
  filters: ['active'], list: ['country', 'name', 'rate_bps', 'active'],
  fields: [
    { k: 'country', label: 'Страна (ISO-2)', t: 'text', req: true, unique: true, pattern: /^[A-Z]{2}$/, max: 2 },
    { k: 'name', label: 'Название', t: 'text', def: 'VAT', max: 30 },
    { k: 'rate_bps', label: 'Ставка, bps (2300 = 23%)', t: 'bps', req: true },
    { k: 'active', label: 'Активна', t: 'bool', def: 1 }
  ]
});

define({
  name: 'ledger', table: 'm_ledger', label: 'Книга проводок', group: 'Финансы и цены', perm: 'ledger', create: false, update: false,
  filters: ['kind', 'seller_id', 'order_id'], search: ['note'], list: ['id', 'created_at', 'kind', 'seller_id', 'order_id', 'amount', 'note'],
  fields: [
    { k: 'kind', label: 'Тип', t: 'enum', vals: ['sale', 'commission', 'tax', 'discount', 'refund', 'payout', 'advance', 'advance_repay', 'adjustment'], req: true },
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers' },
    { k: 'order_id', label: 'Заказ', t: 'ref', ref: 'orders' },
    { k: 'amount', label: 'Сумма (±)', t: 'int', fmt: 'money', req: true },
    { k: 'note', label: 'Заметка', t: 'text' }
  ]
});

define({
  name: 'payouts', table: 'm_payouts', label: 'Выплаты продавцам', group: 'Финансы и цены', perm: 'payouts', update: false,
  filters: ['status', 'seller_id'], list: ['id', 'seller_id', 'amount', 'repay', 'status', 'created_by', 'approved_by', 'created_at'],
  fields: [
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers', req: true },
    { k: 'amount', label: 'Сумма (центы)', t: 'money', req: true, min: 1 },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['pending', 'approved', 'paid', 'rejected'], def: 'pending', ro: true },
    { k: 'repay', label: 'Удержано в счёт аванса', t: 'money', def: 0, ro: true },
    { k: 'approved_by', label: 'Одобрил', t: 'text', ro: true },
    { k: 'note', label: 'Заметка', t: 'text' }
  ],
  present: (out, row) => { out.net = row.amount - row.repay; },
  validate: (data, _u, before) => {
    if (before) return;
    const s = db.prepare('SELECT status, kyc_status, bank_iban FROM m_sellers WHERE id=?').get(data.seller_id);
    if (!s || s.status !== 'active' || s.kyc_status !== 'approved') throw E.conflict('seller_not_payable');
    if (!s.bank_iban) throw E.conflict('no_bank_account');
    const free = C.sellerBalance(data.seller_id) - C.pendingPayouts(data.seller_id);
    if (data.amount > free) throw E.conflict('insufficient_balance', { available: Math.max(0, free) });
  },
  actions: {
    approve: { perm: 'payouts.approve', label: 'Одобрить', confirm: true, run: ({ row, user, req, update }) => {
      if (row.status !== 'pending') throw E.conflict('bad_state');
      const { solo } = C.fourEyes(row, user, 'payouts.approve', ROLES);        // creator ≠ approver
      if (solo) audit(req, 'payout.solo_approval', `#${row.id}`, user.username);
      return update({ status: 'approved', approved_by: user.username }); } },
    reject: { perm: 'payouts.approve', label: 'Отклонить', confirm: true, run: ({ row, update }) => {
      if (!['pending', 'approved'].includes(row.status)) throw E.conflict('bad_state'); return update({ status: 'rejected' }); } },
    mark_paid: { perm: 'payouts.approve', label: 'Отметить выплаченной', confirm: true, run: ({ row, user, update }) => {
      if (row.status !== 'approved') throw E.conflict('bad_state');
      return db.transaction(() => {
        if (C.sellerBalance(row.seller_id) < row.amount) throw E.conflict('insufficient_balance');
        let repay = 0;
        const adv = db.prepare("SELECT * FROM m_advances WHERE seller_id=? AND status='active'").get(row.seller_id);
        if (adv) {                                                                // the advance is recovered automatically out of each payout
          const owed = adv.principal + C.bps(adv.principal, adv.fee_bps) - adv.repaid;
          repay = Math.min(owed, C.bps(row.amount, adv.repay_bps));
          if (repay > 0) {
            C.ledger('advance_repay', { seller_id: row.seller_id, amount: -repay, note: `advance #${adv.id}`, by: user.username });
            const repaid = adv.repaid + repay;
            db.prepare('UPDATE m_advances SET repaid=?, status=?, updated_at=? WHERE id=?').run(repaid, repaid >= adv.principal + C.bps(adv.principal, adv.fee_bps) ? 'closed' : 'active', C.now(), adv.id);
          }
        }
        C.ledger('payout', { seller_id: row.seller_id, amount: -(row.amount - repay), note: `payout #${row.id}`, by: user.username });
        return update({ status: 'paid', repay });
      })(); } }
  }
});

define({
  name: 'advances', table: 'm_advances', label: 'Авансы продавцам (кредит)', group: 'Финансы и цены', perm: 'advances', update: false,
  filters: ['status', 'seller_id'], list: ['id', 'seller_id', 'principal', 'fee_bps', 'repay_bps', 'repaid', 'status', 'created_by'],
  fields: [
    { k: 'seller_id', label: 'Продавец', t: 'ref', ref: 'sellers', req: true },
    { k: 'principal', label: 'Сумма аванса', t: 'money', req: true, min: 1 },
    { k: 'fee_bps', label: 'Комиссия за аванс, bps', t: 'bps', req: true },
    { k: 'repay_bps', label: 'Доля каждой выплаты на погашение, bps', t: 'bps', def: 3000, min: 500 },
    { k: 'status', label: 'Статус', t: 'enum', vals: ['requested', 'active', 'closed', 'rejected'], def: 'requested', ro: true },
    { k: 'repaid', label: 'Погашено', t: 'money', def: 0, ro: true },
    { k: 'approved_by', label: 'Одобрил', t: 'text', ro: true }
  ],
  present: (out, row) => { out.owed = row.principal + C.bps(row.principal, row.fee_bps); },
  validate: (data, _u, before) => { if (before) return; const e = eligibility(data.seller_id); if (!e.eligible) throw E.conflict(e.reason, { limit: e.limit }); if (data.principal > e.limit) throw E.conflict('exceeds_limit', { limit: e.limit }); },
  actions: {
    approve: { perm: 'advances.approve', label: 'Одобрить и выдать', confirm: true, run: ({ row, user, req, update }) => {
      if (row.status !== 'requested') throw E.conflict('bad_state');
      const { solo } = C.fourEyes(row, user, 'advances.approve', ROLES);
      if (solo) audit(req, 'advance.solo_approval', `#${row.id}`, user.username);
      return db.transaction(() => { C.ledger('advance', { seller_id: row.seller_id, amount: row.principal, note: `advance #${row.id}`, by: user.username }); return update({ status: 'active', approved_by: user.username }); })(); } },
    reject: { perm: 'advances.approve', label: 'Отклонить', confirm: true, run: ({ row, update }) => { if (row.status !== 'requested') throw E.conflict('bad_state'); return update({ status: 'rejected' }); } }
  }
});

// Rule-based eligibility (transparent, not a credit model): active + KYC-approved + not high risk + no open advance;
// limit = 30% of net sales of the last 90 days.
function eligibility(sellerId) {
  const s = db.prepare('SELECT status, kyc_status, risk_tier FROM m_sellers WHERE id=?').get(sellerId);
  if (!s || s.status !== 'active' || s.kyc_status !== 'approved') return { eligible: false, reason: 'seller_not_eligible', limit: 0 };
  if (s.risk_tier === 'high') return { eligible: false, reason: 'risk_too_high', limit: 0 };
  if (db.prepare("SELECT 1 FROM m_advances WHERE seller_id=? AND status IN ('requested','active')").get(sellerId)) return { eligible: false, reason: 'open_advance_exists', limit: 0 };
  const net = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM m_ledger WHERE seller_id=? AND kind IN ('sale','refund') AND created_at>?").get(sellerId, C.now() - 90 * C.day).n;
  const limit = Math.max(0, C.bps(net, 3000));
  return { eligible: limit > 0, reason: limit > 0 ? null : 'no_sales_history', limit };
}

module.exports.routes = (r, h) => {
  r.get('/finance/eligibility/:seller_id', h.need('advances.read'), (req, res) => res.json(eligibility(h.id(req.params.seller_id))));
  r.get('/finance/balance/:seller_id', h.need('ledger.read'), (req, res) => {
    const id = h.id(req.params.seller_id);
    res.json({ balance: C.sellerBalance(id), pending_payouts: C.pendingPayouts(id), available: C.sellerBalance(id) - C.pendingPayouts(id) });
  });
  // POST /pricing/run {dry, undercut_bps}: dry-run by default so the effect can be reviewed before prices change
  r.post('/pricing/run', h.need('pricing.write'), (req, res) => {
    const b = req.body || {};
    const undercut = b.undercut_bps === undefined ? 100 : b.undercut_bps;
    if (!Number.isSafeInteger(undercut) || undercut < 0 || undercut > 2000 || (b.dry !== undefined && typeof b.dry !== 'boolean')) throw E.bad('invalid_params');
    const out = repricer.run({ dry: b.dry !== false, undercutBps: undercut, by: req.user.username });
    audit(req, out.dry ? 'pricing.dry_run' : 'pricing.run', `${out.changes.length} changes`);
    res.json(out);
  });
};
