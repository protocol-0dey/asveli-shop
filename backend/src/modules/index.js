'use strict';
// Loads every module (each calls define() at require time), creates the tables, seeds defaults.
const registry = require('../engine/registry');
const mods = ['catalog', 'logistics', 'commerce', 'finance', 'marketing', 'support', 'security', 'analytics', 'store', 'ai', 'shopify', 'oauth', 'data', 'apikeys', 'guard', 'feeds', 'trust', 'marketplace', 'sales'].map(n => require('./' + n));
registry.migrate();
require('../store/schema');
require('../tenancy').apply();
require('../services/ai-settings').apply();                // DB-stored AI connection overrides the env defaults
require('../services/fraud').seed();
require('../services/categories').seed();                 // the default world category tree (once; editable in the admin)
const registerRoutes = (router, helpers) => { for (const m of mods) if (m.routes) m.routes(router, helpers); };
module.exports = { registerRoutes };
