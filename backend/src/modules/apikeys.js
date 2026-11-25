'use strict';
/* MODULE — «API и AI-агенты»: admin API keys for programs and AI agents (Antigravity, Claude, Cursor…) + the MCP endpoint (/mcp).
   Owner only (`secrets.apikeys`; API keys themselves can never manage keys). */
const { audit } = require('../db');
const { E } = require('../engine/errors');
const keys = require('../iam/apikeys');
const { ROLES } = require('../iam/permissions');

module.exports.routes = (r, h) => {
  r.get('/apikeys', h.need('secrets.apikeys'), (req, res) => res.json({ keys: keys.list(), roles: Object.entries(ROLES).map(([id, x]) => ({ id, label: x.label })),
    tools: require('../routes/mcp').TOOLS.map(t => ({ name: t.name, description: t.description })) }));
  r.post('/apikeys', h.need('secrets.apikeys'), (req, res) => {
    const b = req.body || {};
    const k = keys.create({ name: b.name, role: b.role, days: b.days }, req.user.username);
    audit(req, 'apikey.create', `#${k.id} ${k.name} role=${k.role}`, req.user.username);
    res.status(201).json(k);
  });
  r.delete('/apikeys/:id', h.need('secrets.apikeys'), (req, res) => {
    const id = Number(req.params.id); if (!Number.isSafeInteger(id)) throw E.notFound();
    const k = keys.revoke(id); audit(req, 'apikey.revoke', `#${id} ${k.name}`, req.user.username); res.json(k);
  });
};

/* ---------- sub-agents: keys the AI manager makes for its own helpers (copywriter, pricing analyst, card checker, ads, stock…) ----------
   Rules: a sub-agent's role must fit inside the creator's own role (its base role: the owner-away hand-over does not count);
   a sub-agent can't make sub-agents; at most 10 active per creator; at most 90 days and never longer than the creator's key;
   revoking the creator revokes them all. The owner sees and revokes every one in «API и AI-агенты». */
const { match } = require('../iam/permissions');
const MAX_CHILDREN = 10;
const SUB_ROLES = ['copywriter', 'pricing_analyst', 'content_checker', 'ads_manager', 'stock_keeper', 'marketing', 'analyst', 'catalog_manager', 'support_l1'];
const fits = (child, parent) => !!ROLES[child] && !!ROLES[parent] && ROLES[child].perms.every(p => ROLES[parent].perms.some(q => match(q, p)));
const allowedFor = user => SUB_ROLES.filter(r => fits(r, user.apiKey ? user.baseRole : user.role));
const view = k => ({ ...k, brief: k.brief });

const prev = module.exports.routes;
module.exports.routes = (r, h) => {
  prev(r, h);
  // who am I: an agent reads its own job description (brief) and rights
  r.get('/agents/me', h.need('sales.read'), (req, res) => {
    if (!req.user.apiKey) return res.json({ user: req.user.username, role: req.user.role, agent: false });
    const k = keys.raw(req.user.apiKey), p = k.parent_id ? keys.raw(k.parent_id) : null;
    res.json({ agent: true, name: k.name, role: req.user.role, base_role: k.role, role_label: ROLES[k.role].label, perms: ROLES[req.user.role].perms,
      brief: k.brief || null, created_by: p ? p.name : k.created_by, expires_at: k.expires_at });
  });
  r.get('/agents', h.need('agents.read'), (req, res) => {
    const rows = req.user.apiKey ? keys.children(req.user.apiKey) : keys.list().filter(k => k.parent_id);
    res.json({ agents: rows.map(view), roles: allowedFor(req.user).map(id => ({ id, label: ROLES[id].label, perms: ROLES[id].perms })), max: MAX_CHILDREN });
  });
  r.post('/agents', h.need('agents.write'), (req, res) => {
    if (!req.user.apiKey) throw E.bad('use_apikeys_page');                      // people create keys in «API и AI-агенты»
    if (req.user.parentKey) throw E.forbidden('subagent_cannot_create');         // one level only
    const b = req.body || {};
    if (!allowedFor(req.user).includes(b.role)) throw E.forbidden('role_not_allowed');
    const active = keys.children(req.user.apiKey).filter(k => !k.revoked && !k.expired).length;
    if (active >= MAX_CHILDREN) throw E.conflict('too_many_agents');
    const days = b.days == null ? 30 : Number(b.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw E.bad('invalid_days');
    const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
    if (brief.length < 20) throw E.bad('brief_required');                       // every helper gets a written job description
    const k = keys.create({ name: b.name, role: b.role, days, parent_id: req.user.apiKey, brief }, req.user.username);
    audit(req, 'agent.create', `#${k.id} ${k.name} role=${k.role} parent=#${req.user.apiKey}`, req.user.username);
    res.status(201).json(k);
  });
  r.delete('/agents/:id', h.need('agents.write'), (req, res) => {
    const id = Number(req.params.id), k = Number.isSafeInteger(id) ? keys.raw(id) : null;
    if (!k || !k.parent_id || (req.user.apiKey && k.parent_id !== req.user.apiKey)) throw E.notFound();     // an agent revokes only its own helpers
    const out = keys.revoke(id); audit(req, 'agent.revoke', `#${id} ${k.name}`, req.user.username); res.json(out);
  });
};
