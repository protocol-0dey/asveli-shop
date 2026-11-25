'use strict';
const cfg = require('./config');
const auth = require('./auth');
const { db } = require('./db');
const publicApp = require('./public-app');
const adminApp = require('./admin-app');

function listen(app, host, port, label, timeouts) {
  const server = app.listen(port, host);
  server.on('listening', () => console.log(`${label} listening on ${host}:${port}`));
  server.on('error', e => { console.error(`FATAL: cannot listen on ${host}:${port} (${label}): ${e.message}`); process.exit(1); });
  Object.assign(server, timeouts);
  return server;
}

if (require.main === module) {
  // public: small JSON bodies only → short timeouts. admin: large uploads allowed, slow-header clients not.
  const pub = listen(publicApp, cfg.host, cfg.port, 'public API', { requestTimeout: 60000, headersTimeout: 15000, keepAliveTimeout: 65000 });
  const adm = listen(adminApp, cfg.adminHost, cfg.adminPort, 'admin panel (internal)', { requestTimeout: 0, headersTimeout: 30000, keepAliveTimeout: 65000 });
  console.log(`storage=${cfg.storageDriver} · prod=${cfg.prod} · admin: http://localhost:${cfg.adminPort}/admin/ (not reachable from outside; use an SSH tunnel)`);
  setInterval(auth.cleanup, 10 * 60 * 1000).unref();
  auth.cleanup();
  if (process.env.JOBS !== '0') {                               // background rules: anomaly scan + SLA auto-escalation
    const jobs = () => { try { require('./services/anomalies').scan(); require('./modules/support').autoEscalate(); } catch (e) { console.error('job failed:', e.message); } };
    setInterval(jobs, 15 * 60 * 1000).unref();
  }
  require('./services/shopify-sync').startScheduler();       // pulls changes made in the Shopify admin every few minutes (when connected)
  require('./services/guard').start();                                           // anomaly watch → automatic maintenance mode
  if (process.env.JOBS !== '0') require('./services/trust').start();             // yearly seller re-certification watch
  require('./services/mirror').start();                                          // live copy into the external SQL database (when switched on)
  if (process.env.JOBS !== '0') require('./services/backup').service().start();
  if (process.env.JOBS !== '0') require('./services/i18n').start();                                      // auto-translation of cards (when switched on)                          // scheduled encrypted backups (when switched on)
  const stop = () => { pub.close(); adm.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { publicApp, adminApp };
