'use strict';
// Admin/management API: users, API keys, settings, SNMP targets, agents,
// status page components. RBAC enforced per route group.
const express = require('express');
const crypto = require('crypto');
const { db, getOrgSetting, setOrgSetting,
  getMembership, addMembership, removeMembership, listMemberships } = require('../db');
const config = require('../config');
const { now, sha256, hashPassword, isEmail, isStr, optStr, clampInt, httpError, encrypt } = require('../util');
const sec = require('../security');
const pipelineEngine = require('../engine/pipeline');

const plans = require('../plans');

const router = express.Router();
router.use(sec.requireSession);

// Returns true if allowed; otherwise sends a 402 and returns false.
function withinPlan(req, res, resource) {
  const lim = plans.checkLimit(req.orgId, req.org.plan, resource);
  if (!lim.ok) {
    httpError(res, 402, `plan limit reached (${lim.used}/${lim.limit} ${resource}) — upgrade your plan to add more`);
    return false;
  }
  return true;
}

const ROLES = ['admin', 'cto', 'lead', 'analyst'];
const COLORS = ['#bc8cff', '#38b6ff', '#3fb950', '#f0883e', '#e3b341', '#f85149'];

// ---- users (admin) ----
// "Users in this org" = members (memberships is the authority). Role is per-org
// (from the membership); active is a global per-user flag.
// GET is lead+ (email/role/last-seen enumeration); assignee pickers use /api/team.
router.get('/users', sec.requireRole('lead'), (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.email, u.name, m.role, u.color, u.active, u.last_seen_at
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.id`)
    .all(req.orgId).map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, color: u.color,
      active: !!u.active, lastSeenAt: u.last_seen_at })));
});

// Add a member: an existing OpsCat account is attached to this org (multi-org);
// an unknown e-mail creates a brand-new user whose home org is this one.
router.post('/users', sec.requireRole('admin'), (req, res) => {
  const { email, name, role } = req.body || {};
  if (!isEmail(email)) return httpError(res, 400, 'valid email required');
  if (!ROLES.includes(role)) return httpError(res, 400, 'bad role');
  const existing = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    if (getMembership(existing.id, req.orgId)) return httpError(res, 409, 'user already in this organization');
    if (!withinPlan(req, res, 'users')) return undefined;
    addMembership(existing.id, req.orgId, role);
    sec.audit(req.user.id, 'member_add', `${email} (${role})`, req.orgId);
    return res.json({ id: existing.id, added: true });
  }
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  if (!withinPlan(req, res, 'users')) return undefined;
  const password = crypto.randomBytes(12).toString('base64url');
  const { salt, hash } = hashPassword(password);
  const color = COLORS[listMemberships(req.user.id).length % COLORS.length];
  const info = db.prepare(`INSERT INTO users (org_id, email, name, role, pass_salt, pass_hash, color, active,
    must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`)
    .run(req.orgId, email.toLowerCase(), name, role, salt, hash, color, now());
  addMembership(info.lastInsertRowid, req.orgId, role);
  sec.audit(req.user.id, 'user_create', `${email} (${role})`, req.orgId);
  // initial password returned once to the creating admin
  res.json({ id: info.lastInsertRowid, initialPassword: password });
});

router.patch('/users/:id', sec.requireRole('admin'), (req, res) => {
  // target must be a member of the acting org
  const mem = getMembership(req.params.id, req.orgId);
  const u = mem && db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return httpError(res, 404, 'user not found');
  const b = req.body || {};
  if (b.role && !ROLES.includes(b.role)) return httpError(res, 400, 'bad role');

  // remove the user FROM THIS ORG (delete the membership); the account lives on
  // in its other orgs. Deactivating globally is a separate action (active:false).
  if (b.remove === true) {
    if (u.id === req.user.id) return httpError(res, 400, 'cannot remove yourself');
    const others = listMemberships(u.id).filter((m) => m.org_id !== req.orgId);
    if (others.length === 0) return httpError(res, 400, 'user belongs only to this org — deactivate instead');
    removeMembership(u.id, req.orgId);
    if (u.org_id === req.orgId) db.prepare('UPDATE users SET org_id = ? WHERE id = ?').run(others[0].org_id, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND active_org_id = ?').run(u.id, req.orgId);
    sec.audit(req.user.id, 'member_remove', u.email, req.orgId);
    return res.json({ ok: true, removed: true });
  }

  if (u.id === req.user.id && b.active === false) return httpError(res, 400, 'cannot deactivate yourself');
  if (u.id === req.user.id && b.role && b.role !== 'admin') {
    return httpError(res, 400, 'cannot demote yourself');
  }
  // role is per-org → update the membership; name/active are global user fields
  if (b.role) addMembership(u.id, req.orgId, b.role);
  db.prepare('UPDATE users SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?')
    .run(isStr(b.name, 100) ? b.name : null,
      typeof b.active === 'boolean' ? (b.active ? 1 : 0) : null, u.id);
  if (b.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  if (b.resetPassword === true) {
    const password = crypto.randomBytes(12).toString('base64url');
    const { salt, hash } = hashPassword(password);
    db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(salt, hash, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    sec.audit(req.user.id, 'user_password_reset', u.email, req.orgId);
    return res.json({ ok: true, initialPassword: password });
  }
  sec.audit(req.user.id, 'user_update', u.email, req.orgId);
  res.json({ ok: true });
});

// ---- API keys (lead+) ----
router.get('/apikeys', sec.requireRole('lead'), (req, res) => {
  res.json(db.prepare(`SELECT id, name, prefix, scopes, active, created_at, last_used_at
    FROM api_keys WHERE org_id = ? ORDER BY id`).all(req.orgId)
    .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes.split(','),
      active: !!k.active, createdAt: k.created_at, lastUsedAt: k.last_used_at })));
});

router.post('/apikeys', sec.requireRole('lead'), (req, res) => {
  const { name, scopes } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  const allowed = ['ingest', 'agent', 'probe'];
  const sc = (Array.isArray(scopes) ? scopes : ['ingest']).filter((s) => allowed.includes(s));
  if (!sc.length) return httpError(res, 400, 'at least one valid scope required');
  if (!withinPlan(req, res, 'apiKeys')) return undefined;
  const key = 'ock_' + crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, active, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(req.orgId, name, key.slice(0, 12), sha256(key), sc.join(','), req.user.id, now());
  sec.audit(req.user.id, 'apikey_create', name, req.orgId);
  res.json({ key, note: 'store this key now — it is not retrievable later' });
});

router.patch('/apikeys/:id', sec.requireRole('lead'), (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!k) return httpError(res, 404, 'key not found');
  if (typeof req.body?.active === 'boolean') {
    db.prepare('UPDATE api_keys SET active = ? WHERE id = ? AND org_id = ?').run(req.body.active ? 1 : 0, k.id, req.orgId);
  }
  sec.audit(req.user.id, 'apikey_update', k.name, req.orgId);
  res.json({ ok: true });
});

// ---- settings (admin; safe subset readable by all sessions) ----
const PUBLIC_SETTINGS = ['org_name', 'backend_label', 'status_published', 'retention_logs_days', 'onboarding_done'];
const ADMIN_SETTINGS = [...PUBLIC_SETTINGS, 'onboarding_role', 'onboarding_goal', 'onboarding_source',
  'alert_email_from', 'auth_email_from', 'teams_webhook_url', 'telegram_bot_token', 'pushover_token', 'classifiers'];

router.get('/settings', (req, res) => {
  const keys = req.user.role === 'admin' ? ADMIN_SETTINGS : PUBLIC_SETTINGS;
  const out = {};
  for (const k of keys) out[k] = getOrgSetting(req.orgId, k, '');
  res.json(out);
});

router.patch('/settings', sec.requireRole('admin'), (req, res) => {
  const b = req.body || {};
  for (const [k, v] of Object.entries(b)) {
    if (!ADMIN_SETTINGS.includes(k)) return httpError(res, 400, `unknown setting ${k}`);
    if (typeof v !== 'string' || v.length > 10000) return httpError(res, 400, `bad value for ${k}`);
  }
  if (b.classifiers) {
    try {
      const arr = JSON.parse(b.classifiers);
      if (!Array.isArray(arr)) throw new Error();
      for (const c of arr) new RegExp(c.pattern, c.flags || 'i');
    } catch { return httpError(res, 400, 'classifiers must be a JSON array of valid patterns'); }
  }
  for (const [k, v] of Object.entries(b)) setOrgSetting(req.orgId, k, v);
  if (b.classifiers) pipelineEngine.loadClassifiers();
  sec.audit(req.user.id, 'settings_update', Object.keys(b).join(','), req.orgId);
  res.json({ ok: true });
});

// ---- SNMP targets (lead+) ----
router.get('/snmp/targets', sec.requireRole('lead'), (req, res) => {
  res.json(db.prepare(`SELECT id, name, host, port, version, oids, interval_s, enabled,
    last_status, last_seen_at, v3_user, v3_level FROM snmp_targets WHERE org_id = ? ORDER BY id`).all(req.orgId)
    .map((t) => ({ id: t.id, name: t.name, host: t.host, port: t.port, version: t.version,
      oids: JSON.parse(t.oids || '[]'), intervalS: t.interval_s, enabled: !!t.enabled,
      lastStatus: t.last_status, lastSeenAt: t.last_seen_at,
      v3User: t.v3_user, v3Level: t.v3_level })));
});

const V3_LEVELS = ['noAuthNoPriv', 'authNoPriv', 'authPriv'];

router.post('/snmp/targets', sec.requireRole('lead'), (req, res) => {
  const { name, host, port, version, community, oids, intervalS,
    v3User, v3Level, v3AuthProtocol, v3AuthKey, v3PrivProtocol, v3PrivKey } = req.body || {};
  if (!isStr(name, 100) || !isStr(host, 255)) return httpError(res, 400, 'name and host required');
  const ver = version === '3' ? '3' : '2c';
  const v3 = { user: null, level: null, authProto: null, authKeyEnc: null, privProto: null, privKeyEnc: null };
  if (ver === '2c') {
    if (!isStr(community, 200)) return httpError(res, 400, 'community required');
  } else {
    if (!isStr(v3User, 100)) return httpError(res, 400, 'v3User required');
    if (!V3_LEVELS.includes(v3Level)) return httpError(res, 400, 'bad v3Level');
    v3.user = v3User; v3.level = v3Level;
    if (v3Level !== 'noAuthNoPriv') {
      if (!isStr(v3AuthKey, 200) || v3AuthKey.length < 8) return httpError(res, 400, 'v3AuthKey required (min 8 chars)');
      v3.authProto = v3AuthProtocol === 'sha' ? 'sha' : 'md5';
      v3.authKeyEnc = encrypt(v3AuthKey, config.secret);
    }
    if (v3Level === 'authPriv') {
      if (!isStr(v3PrivKey, 200) || v3PrivKey.length < 8) return httpError(res, 400, 'v3PrivKey required (min 8 chars)');
      v3.privProto = v3PrivProtocol === 'aes' ? 'aes' : 'des';
      v3.privKeyEnc = encrypt(v3PrivKey, config.secret);
    }
  }
  if (!withinPlan(req, res, 'snmpTargets')) return undefined;
  let oidsJson = '[]';
  if (Array.isArray(oids)) {
    const clean = oids.filter((o) => o && /^[0-9.]+$/.test(o.oid) && isStr(o.label, 100)).slice(0, 48);
    oidsJson = JSON.stringify(clean);
  }
  const info = db.prepare(`INSERT INTO snmp_targets (org_id, name, host, port, version, community_enc, oids,
    interval_s, enabled, v3_user, v3_level, v3_auth_protocol, v3_auth_key_enc, v3_priv_protocol, v3_priv_key_enc,
    created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.orgId, name, host, clampInt(port, 1, 65535, 161), ver,
      encrypt(ver === '2c' ? community : '', config.secret), oidsJson, clampInt(intervalS, 15, 3600, 60),
      v3.user, v3.level, v3.authProto, v3.authKeyEnc, v3.privProto, v3.privKeyEnc, now());
  sec.audit(req.user.id, 'snmp_target_create', `${name} (${host}, v${ver})`, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/snmp/targets/:id', sec.requireRole('lead'), (req, res) => {
  const t = db.prepare('SELECT * FROM snmp_targets WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!t) return httpError(res, 404, 'target not found');
  const b = req.body || {};
  db.prepare(`UPDATE snmp_targets SET name = COALESCE(?, name), host = COALESCE(?, host),
      enabled = COALESCE(?, enabled), interval_s = COALESCE(?, interval_s),
      community_enc = COALESCE(?, community_enc) WHERE id = ? AND org_id = ?`)
    .run(isStr(b.name, 100) ? b.name : null, isStr(b.host, 255) ? b.host : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      Number.isFinite(b.intervalS) ? clampInt(b.intervalS, 15, 3600, 60) : null,
      isStr(b.community, 200) ? encrypt(b.community, config.secret) : null, t.id, req.orgId);
  sec.audit(req.user.id, 'snmp_target_update', t.name, req.orgId);
  res.json({ ok: true });
});

router.delete('/snmp/targets/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM snmp_targets WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'snmp_target_delete', `target ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- agents management ----
router.get('/agents', (req, res) => {
  const t = now();
  res.json(db.prepare(`SELECT id, name, grp, hostname, platform, version, active, last_seen_at, created_at
    FROM agents WHERE org_id = ? ORDER BY grp, id`).all(req.orgId)
    .map((a) => ({ id: a.id, name: a.name, group: a.grp, hostname: a.hostname, platform: a.platform,
      version: a.version, active: !!a.active, lastSeenAt: a.last_seen_at,
      online: !!a.last_seen_at && t - a.last_seen_at < 3 * 60 * 1000 })));
});

router.post('/agents', sec.requireRole('lead'), (req, res) => {
  const { name, group } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  if (db.prepare('SELECT id FROM agents WHERE name = ?').get(name)) {
    return httpError(res, 409, 'agent name already exists');
  }
  if (!withinPlan(req, res, 'agents')) return undefined;
  const token = 'oca_' + crypto.randomBytes(24).toString('hex');
  const info = db.prepare('INSERT INTO agents (org_id, name, grp, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.orgId, name, isStr(group, 100) ? group : 'default', sha256(token), now());
  sec.audit(req.user.id, 'agent_create', name, req.orgId);
  res.json({ id: info.lastInsertRowid, token, note: 'store this token now — it is not retrievable later' });
});

router.get('/agents/:id/metrics', (req, res) => {
  const hours = clampInt(req.query.hours, 1, 168, 24);
  // confirm the agent belongs to this org before returning its (org-less) metrics
  const agent = db.prepare('SELECT id FROM agents WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!agent) return httpError(res, 404, 'agent not found');
  const rows = db.prepare(`SELECT ts, cpu_pct, load1, mem_used, mem_total, disk_used, disk_total,
    net_rx, net_tx FROM agent_metrics WHERE agent_id = ? AND ts >= ? ORDER BY ts`)
    .all(req.params.id, now() - hours * 3600000);
  res.json(rows);
});

router.delete('/agents/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM agents WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'agent_delete', `agent ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- status page components (lead+ to modify) ----
router.get('/components', (req, res) => {
  const comps = db.prepare('SELECT * FROM components WHERE org_id = ? ORDER BY sort, id').all(req.orgId);
  const since = new Date(now() - 45 * 86400000).toISOString().slice(0, 10);
  const days = db.prepare(`SELECT cd.* FROM component_days cd
    JOIN components c ON c.id = cd.component_id
    WHERE cd.day >= ? AND c.org_id = ?`).all(since, req.orgId);
  const byComp = new Map();
  for (const d of days) {
    if (!byComp.has(d.component_id)) byComp.set(d.component_id, []);
    byComp.get(d.component_id).push(d);
  }
  res.json(comps.map((c) => {
    const cd = (byComp.get(c.id) || []).sort((a, b) => a.day.localeCompare(b.day));
    const totalDown = cd.reduce((a, d) => a + d.down_seconds, 0);
    const totalSecs = Math.max(1, cd.length) * 86400;
    return {
      id: c.id, name: c.name, group: c.grp, status: c.status,
      uptimePct: (100 - (totalDown / totalSecs) * 100).toFixed(2),
      days: cd.map((d) => ({ day: d.day, worst: d.worst })),
    };
  }));
});

router.post('/components', sec.requireRole('lead'), (req, res) => {
  const { name, group } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  const info = db.prepare(`INSERT INTO components (org_id, name, grp, status, sort, created_at)
    VALUES (?, ?, ?, 'operational', (SELECT COALESCE(MAX(sort), 0) + 1 FROM components WHERE org_id = ?), ?)`)
    .run(req.orgId, name, isStr(group, 100) ? group : 'Core', req.orgId, now());
  sec.audit(req.user.id, 'component_create', name, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/components/:id', sec.requireRole('lead'), (req, res) => {
  const c = db.prepare('SELECT * FROM components WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!c) return httpError(res, 404, 'component not found');
  const b = req.body || {};
  const statuses = ['operational', 'degraded', 'partial', 'major', 'maintenance'];
  if (b.status && !statuses.includes(b.status)) return httpError(res, 400, 'bad status');
  db.prepare(`UPDATE components SET name = COALESCE(?, name), grp = COALESCE(?, grp),
      status = COALESCE(?, status) WHERE id = ? AND org_id = ?`)
    .run(isStr(b.name, 100) ? b.name : null, isStr(b.group, 100) ? b.group : null,
      b.status || null, c.id, req.orgId);
  sec.audit(req.user.id, 'component_status', `${c.name} → ${b.status || c.status}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/components/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM components WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'component_delete', `component ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- system info (admin) ----
router.get('/system', sec.requireRole('admin'), (req, res) => {
  const fs = require('fs');
  let dbSize = 0;
  try { dbSize = fs.statSync(config.dbFile).size; } catch { /* noop */ }
  res.json({
    uptimeS: Math.floor(process.uptime()),
    dbSizeBytes: dbSize,
    counts: {
      logs: db.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ?').get(req.orgId).c,
      events: db.prepare('SELECT COUNT(*) c FROM events WHERE org_id = ?').get(req.orgId).c,
      cases: db.prepare('SELECT COUNT(*) c FROM cases WHERE org_id = ?').get(req.orgId).c,
      users: db.prepare('SELECT COUNT(*) c FROM memberships WHERE org_id = ?').get(req.orgId).c,
    },
    node: process.version,
  });
});

router.get('/audit', sec.requireRole('admin'), (req, res) => {
  res.json(db.prepare(`SELECT a.ts, a.action, a.detail, u.email FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? ORDER BY a.ts DESC LIMIT 200`).all(req.orgId));
});

module.exports = router;
