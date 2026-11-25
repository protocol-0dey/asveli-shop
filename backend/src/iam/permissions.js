'use strict';
/* Role-based access control. Deny by default: a permission must be granted explicitly by the user's role.
   "x.*" grants every "x.something"; "*" (owner only) grants everything. Roles live in code (reviewable, versioned), not in the DB. */
const READ_ONLY_BASE = ['analytics.read'];
const L1 = ['tickets.read', 'tickets.write', 'orders.read', 'customers.read', 'reviews.read', 'products.read'];
const L2 = [...L1, 'tickets.l2', 'returns.*', 'disputes.read', 'disputes.write', 'reviews.moderate', 'shipments.read'];

// 'secrets.*' (API keys, provider settings) is deliberately NOT part of any role except owner's '*': no 'ai.*' or 'channels.*' wildcard can reach it.
const ROLES = {
  owner:            { label: 'Owner',                 perms: ['*'] },
  security_admin:   { label: 'Security admin',        perms: ['audit.read', 'staff.read', 'fraud.*', 'alerts.*', 'sessions.read', 'guard.*'] },
  catalog_manager:  { label: 'Catalog manager',       perms: ['ai.*', 'brand.*', 'channels.*', 'shopify.*', 'sellers.read', 'sellers.write', 'products.read', 'products.write', 'stock.*', 'inbound.*', 'compliance.read', 'orders.read', 'files.read', 'files.write'] },
  kyc_officer:      { label: 'KYC / onboarding',      perms: ['sellers.*', 'files.read', 'files.write', 'files.kyc', 'compliance.*', 'pii.reveal'] },
  moderator:        { label: 'Content moderator',     perms: ['ai.read', 'ai.review', 'brand.read', 'products.read', 'products.moderate', 'reviews.read', 'reviews.moderate', 'compliance.read', 'sellers.read', 'customers.read'] },
  logistics:        { label: 'Logistics',             perms: ['shopify.read', 'warehouses.*', 'stock.*', 'inbound.*', 'shipments.*', 'carriers.*', 'returns.*', 'orders.read', 'products.read'] },
  finance:          { label: 'Finance',               perms: ['payouts.read', 'payouts.write', 'tax.*', 'pricing.*', 'sellers.commission', 'advances.*', 'ledger.read', 'orders.read', 'sellers.read', 'analytics.read'] },
  finance_approver: { label: 'Finance approver',      perms: ['payouts.read', 'payouts.approve', 'advances.read', 'advances.approve', 'ledger.read'] },
  marketing:        { label: 'Marketing / SEO',       perms: ['abtests.*', 'ai.read', 'campaigns.*', 'coupons.*', 'loyalty.*', 'segments.*', 'banners.*', 'seo.*', 'subscribers.read', 'products.read', 'analytics.read'] },
  analyst:          { label: 'Analyst',               perms: [...READ_ONLY_BASE, 'ai.read', 'shopify.read', 'abtests.read', 'orders.read', 'products.read', 'sellers.read', 'alerts.read', 'pricing.read'] },
  support_l1:       { label: 'Support L1',            perms: L1 },
  support_l2:       { label: 'Support L2',            perms: L2 },
  support_l3:       { label: 'Support L3 / arbitration', perms: [...L2, 'tickets.l3', 'disputes.decide', 'orders.write'] },
  fraud_analyst:    { label: 'Fraud analyst',         perms: ['fraud.*', 'alerts.*', 'orders.read', 'orders.hold', 'customers.read', 'sellers.read', 'pii.reveal'] }
};
// Sales & marketing department for an AI manager (Argon): catalogue, card writing, prices, stock, promotions, SEO, analytics.
// store_manager is what that key becomes while the owner hands over the store (services/delegate): + moderation, orders,
// shipments, returns, customer tickets. Neither has payouts, ledger, tax, commissions, KYC, fraud decisions or disputes decisions;
// keys never get secrets/staff/security/PII (KEY_DENY) and never refund money (refund actions refuse API keys).
const uniq = a => [...new Set(a)];
ROLES.sales_manager = { label: 'Sales & marketing (AI manager)', perms: uniq([...ROLES.catalog_manager.perms, ...ROLES.marketing.perms, 'pricing.*', 'sales.*', 'reviews.read', 'alerts.read', 'agents.*']) };
// narrow roles for sub-agents the AI manager creates (each must fit inside its creator's own role — checked in modules/apikeys)
ROLES.copywriter = { label: 'Sub-agent: copywriter (cards, SEO)', perms: ['products.read', 'products.write', 'ai.read', 'ai.run', 'brand.read', 'seo.*', 'sales.read'] };
ROLES.pricing_analyst = { label: 'Sub-agent: pricing analyst', perms: ['products.read', 'pricing.read', 'analytics.read', 'sales.read'] };
ROLES.content_checker = { label: 'Sub-agent: card checker', perms: ['products.read', 'ai.read', 'ai.review', 'compliance.read', 'sales.read'] };
ROLES.ads_manager = { label: 'Sub-agent: ads & promotions', perms: ['campaigns.*', 'coupons.*', 'banners.*', 'segments.read', 'abtests.*', 'products.read', 'analytics.read', 'sales.read'] };
ROLES.stock_keeper = { label: 'Sub-agent: stock', perms: ['stock.*', 'inbound.*', 'products.read', 'sales.read'] };
ROLES.store_manager = { label: 'Store manager (owner away)', perms: uniq([...ROLES.sales_manager.perms, 'products.moderate', 'reviews.*', 'orders.read', 'orders.write', 'orders.hold',
  'customers.read', 'tickets.read', 'tickets.write', 'tickets.l2', 'shipments.*', 'returns.*', 'warehouses.read', 'carriers.read', 'disputes.read']) };
const ROLE_NAMES = Object.keys(ROLES);

function match(pattern, perm) {
  if (pattern === '*' || pattern === perm) return true;
  return pattern.endsWith('.*') && perm.startsWith(pattern.slice(0, -1));
}
// API keys (programs / AI agents) never get secrets, staff management, account security or personal-data reveal, whatever their role
const KEY_DENY = ['secrets.', 'staff.', 'security.', 'pii.reveal', 'sessions.', 'apikeys.', 'delegate.'];   // an agent can't hand the store to itself
const can = (user, perm) => !!user && user.active !== 0 && !!ROLES[user.role] && !(user.apiKey && KEY_DENY.some(d => perm === d || perm.startsWith(d))) && ROLES[user.role].perms.some(p => match(p, perm));
const permsOf = user => (ROLES[user.role] ? ROLES[user.role].perms : []);

module.exports = { ROLES, ROLE_NAMES, can, permsOf, match };
