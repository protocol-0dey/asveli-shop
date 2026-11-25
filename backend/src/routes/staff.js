'use strict';
const express = require('express');
const { db, audit } = require('../db');
const sec = require('../security');
const { ROLES, ROLE_NAMES, can } = require('../iam/permissions');
const { E } = require('../engine/errors');
const { helpers: { need, id, wrap } } = require('./modules');

const router = express.Router();
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, active: !!u.active, totp_enabled: !!u.totp_enabled, must_change_password: !!u.must_change_password, last_login: u.last_login, locked: u.locked_until > Date.now(), created_at: u.created_at });
const tempPassword = () => sec.token(18) + 'Aa1';                       // 24+ chars; shown once, must be changed at first login
const activeOwners = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").get().n;

router.get('/staff', need('staff.read'), wrap((_req, res) => res.json({ rows: db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser) })));
router.get('/staff/roles', need('staff.read'), (_req, res) => res.json({ roles: Object.entries(ROLES).map(([k, v]) => ({ role: k, label: v.label, perms: v.perms })) }));

router.post('/staff', need('staff.manage'), wrap(async (req, res) => {
  const { username, role } = req.body || {};
  if (typeof username !== 'string' || !/^[a-z0-9._-]{3,32}$/.test(username)) throw E.bad('invalid_username');
  if (!ROLE_NAMES.includes(role)) throw E.bad('invalid_role');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw E.conflict('duplicate');
  const pw = tempPassword();
  db.prepare('INSERT INTO users(username,pass_hash,role,active,must_change_password,created_at) VALUES(?,?,?,1,1,?)').run(username, await sec.hashPassword(pw), role, Date.now());
  audit(req, 'staff.create', `${username} (${role})`);
  res.status(201).json({ username, role, temp_password: pw });
}));

const target = req => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id(req.params.id)); if (!u) throw E.notFound();
  return u;
};
router.patch('/staff/:id', need('staff.manage'), wrap((req, res) => {
  const u = target(req), b = req.body || {};
  if (u.id === req.user.id) throw E.forbidden('cannot_modify_self');                 // nobody can promote themselves or lock themselves out by accident
  if (b.role !== undefined && !ROLE_NAMES.includes(b.role)) throw E.bad('invalid_role');
  if (b.active !== undefined && typeof b.active !== 'boolean') throw E.bad('invalid_active');
  const newRole = b.role ?? u.role, newActive = b.active ?? !!u.active;
  if (u.role === 'owner' && u.active && (newRole !== 'owner' || !newActive) && activeOwners() <= 1) throw E.conflict('last_owner');
  db.prepare('UPDATE users SET role=?, active=? WHERE id=?').run(newRole, newActive ? 1 : 0, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);                      // rights changed → old sessions die immediately
  audit(req, 'staff.update', `${u.username}: role ${u.role}→${newRole}, active ${!!u.active}→${newActive}`);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
}));
router.post('/staff/:id/reset-password', need('staff.manage'), wrap(async (req, res) => {
  const u = target(req); if (u.id === req.user.id) throw E.forbidden('cannot_modify_self');
  const pw = tempPassword();
  db.prepare('UPDATE users SET pass_hash=?, must_change_password=1, failed=0, locked_until=0 WHERE id=?').run(await sec.hashPassword(pw), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(req, 'staff.reset_password', u.username);
  res.json({ username: u.username, temp_password: pw });
}));
router.post('/staff/:id/reset-2fa', need('staff.manage'), wrap((req, res) => {
  const u = target(req); if (u.id === req.user.id) throw E.forbidden('cannot_modify_self');
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret_enc=NULL, totp_last=0 WHERE id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(req, 'staff.reset_2fa', u.username); res.json({ ok: true });
}));
router.post('/staff/:id/unlock', need('staff.manage'), wrap((req, res) => {
  const u = target(req); db.prepare('UPDATE users SET failed=0, locked_until=0 WHERE id=?').run(u.id);
  audit(req, 'staff.unlock', u.username); res.json({ ok: true });
}));

router.get('/sessions', need('sessions.read'), wrap((_req, res) => res.json({ rows: db.prepare(
  'SELECT substr(s.id_hash,1,16) ref, u.username, u.role, s.ip, s.ua, s.created_at, s.last_seen, s.pending FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.last_seen DESC LIMIT 200').all() })));
router.delete('/sessions/:ref', need('staff.manage'), wrap((req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.ref)) throw E.bad('invalid_ref');
  const r = db.prepare('DELETE FROM sessions WHERE substr(id_hash,1,16)=? AND id_hash<>?').run(req.params.ref, req.sessionId);
  audit(req, 'session.revoke', req.params.ref); res.json({ revoked: r.changes });
}));
module.exports = router;
