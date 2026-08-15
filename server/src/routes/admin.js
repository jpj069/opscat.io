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
const automationEngine = require('../engine/automations');
const scoutEngine = require('../engine/scout');
const llm = require('../llm');
const voice = require('../voice');
const statusScale = require('../lib/status-scale');

const plans = require('../plans');
const invites = require('../lib/invites');

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
  // `pending` = invited but never activated. Derived from an OUTSTANDING invite
  // token rather than from an empty pass_hash alone: an SSO account has no
  // password either and is not pending, and an expired link is not either — it
  // needs re-inviting, which is exactly what the admin has to be able to see.
  res.json(db.prepare(`SELECT u.id, u.email, u.name, m.role, u.color, u.active, u.last_seen_at,
      (u.pass_hash = '' AND u.auth_provider = 'password' AND EXISTS (
         SELECT 1 FROM login_tokens t WHERE t.user_id = u.id AND t.purpose = 'invite'
           AND t.used_at IS NULL AND t.expires_at > ?)) AS pending
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.id`)
    .all(now(), req.orgId).map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, color: u.color,
      active: !!u.active, lastSeenAt: u.last_seen_at, pending: !!u.pending })));
});

// Add a member: an existing OpsCat account is attached to this org (multi-org);
// an unknown e-mail creates a brand-new user whose home org is this one.
//
// With a mail transport the new account is created WITHOUT a password and gets an
// activation link (see lib/invites.js). Without one — community, air-gapped — it
// falls back to the one-time password the admin has to hand over, and only then
// does `must_change_password` come into play.
router.post('/users', sec.requireRole('admin'), async (req, res) => {
  const { email, name, role, manual } = req.body || {};
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
  const color = COLORS[listMemberships(req.user.id).length % COLORS.length];
  // `manual` is the deliberate escape hatch — a colleague whose mailbox is not
  // reachable yet, a shared NOC account, an air-gapped instance. It is a choice
  // the admin has to make on purpose; it is never the default where mail works.
  const byLink = invites.mailConfigured() && manual !== true;
  // A link-invited account starts with NO password: '' is a real state now, and
  // the login route refuses it for every password (see auth.js).
  const password = byLink ? null : crypto.randomBytes(12).toString('base64url');
  const { salt, hash } = password ? hashPassword(password) : { salt: '', hash: '' };
  const info = db.prepare(`INSERT INTO users (org_id, email, name, role, pass_salt, pass_hash, color, active,
    must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(req.orgId, email.toLowerCase(), name, role, salt, hash, color, byLink ? 0 : 1, now());
  const id = info.lastInsertRowid;
  addMembership(id, req.orgId, role);
  sec.audit(req.user.id, 'user_create', `${email} (${role})`, req.orgId);

  if (!byLink) return res.json({ id, initialPassword: password });

  try {
    await invites.sendInviteLink({ id, email: email.toLowerCase() },
      { kind: 'invite', orgName: req.org.name, invitedBy: req.user.name });
    sec.audit(req.user.id, 'user_invited', email, req.orgId);
    return res.json({ id, invited: true, email: email.toLowerCase() });
  } catch (e) {
    // The account exists but the invitation did not arrive — do not leave the
    // colleague with no way in. Issue the fallback password and say what happened.
    console.error('invite mail failed:', e.message);
    const fallback = crypto.randomBytes(12).toString('base64url');
    const f = hashPassword(fallback);
    db.prepare(`UPDATE users SET pass_salt = ?, pass_hash = ?, must_change_password = 1
      WHERE id = ?`).run(f.salt, f.hash, id);
    return res.json({ id, initialPassword: fallback, mailFailed: true });
  }
});

router.patch('/users/:id', sec.requireRole('admin'), async (req, res) => {
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
  // Same split as the invitation: a reset link when mail works, a one-time
  // password only when it does not. Sessions die either way — that is the point
  // of a reset — so a mail failure must still leave a usable credential behind.
  if (b.resetPassword === true) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    sec.audit(req.user.id, 'user_password_reset', u.email, req.orgId);
    if (invites.mailConfigured()) {
      invites.clearPassword(u.id);
      try {
        await invites.sendInviteLink(u, { kind: 'reset', invitedBy: req.user.name });
        return res.json({ ok: true, invited: true, email: u.email });
      } catch (e) {
        console.error('reset mail failed:', e.message);
      }
    }
    const password = crypto.randomBytes(12).toString('base64url');
    const { salt, hash } = hashPassword(password);
    db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(salt, hash, u.id);
    return res.json({ ok: true, initialPassword: password,
      mailFailed: invites.mailConfigured() || undefined });
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
  const { name, scopes, role } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  // `api` lets the key drive the full operations REST API (see security.js
  // requireSessionOrToken), so it also carries the ROLE it acts with.
  const allowed = ['ingest', 'agent', 'probe', 'api'];
  const sc = (Array.isArray(scopes) ? scopes : ['ingest']).filter((s) => allowed.includes(s));
  if (!sc.length) return httpError(res, 400, 'at least one valid scope required');
  // A key must never outrank the person minting it, or `lead` could hand out an
  // `admin` credential and escalate through it.
  const wanted = sec.ROLE_RANK[role] ? role : 'analyst';
  if (sec.ROLE_RANK[wanted] > sec.ROLE_RANK[req.user.role]) {
    return httpError(res, 403, 'cannot grant a key a higher role than your own');
  }
  if (!withinPlan(req, res, 'apiKeys')) return undefined;
  const key = 'ock_' + crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, role, active, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(req.orgId, name, key.slice(0, 12), sha256(key), sc.join(','), wanted, req.user.id, now());
  sec.audit(req.user.id, 'apikey_create', `${name} scopes=${sc.join('+')} role=${wanted}`, req.orgId);
  res.json({ key, note: 'store this key now — it is not retrievable later' });
});

// ── authorized MCP clients (OAuth grants) ─────────────────────────────────
// A user manages their OWN connections: these are grants they personally
// authorized, not org-wide configuration, so this is not role-gated.
router.get('/connections', (req, res) => {
  const oauth = require('../lib/oauth');
  res.json(oauth.listGrants(req.user.id)
    .filter((g) => g.orgId === req.orgId)
    .map((g) => ({
      clientId: g.clientId,
      name: g.client ? g.client.name : g.clientId,
      scopes: g.scopes,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
    })));
});

router.delete('/connections/:clientId', (req, res) => {
  const oauth = require('../lib/oauth');
  const removed = oauth.revokeGrant(String(req.params.clientId), req.user.id, req.orgId);
  if (!removed) return httpError(res, 404, 'connection not found');
  sec.audit(req.user.id, 'mcp.revoke', `client=${req.params.clientId}`, req.orgId);
  res.json({ ok: true });
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
  'alert_email_from', 'auth_email_from', 'teams_webhook_url', 'telegram_bot_token', 'pushover_token', 'classifiers',
  'status_reports_enabled', 'status_reports_public', 'status_reports_threshold',
  'status_subscribers_enabled'];

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
  if (b.classifiers) pipelineEngine.loadClassifiers(req.orgId);
  sec.audit(req.user.id, 'settings_update', Object.keys(b).join(','), req.orgId);
  res.json({ ok: true });
});

// ---- log pipeline: throughput + classifiers ----

// Ingest throughput from the hourly ingest_stats counters. 24h keeps hour
// buckets; 7d/30d aggregate into days. Gaps are zero-filled for the charts.
router.get('/pipeline/stats', (req, res) => {
  const range = ['24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '24h';
  const days = { '24h': 1, '7d': 7, '30d': 30 }[range];
  const step = days === 1 ? 3600000 : 86400000;
  const t = now();
  const since = Math.floor((t - days * 86400000) / step) * step + step;
  const rows = db.prepare(`SELECT bucket, lines, bytes, events FROM ingest_stats
    WHERE org_id = ? AND bucket >= ? ORDER BY bucket`).all(req.orgId, since);
  const byBucket = new Map();
  const totals = { lines: 0, bytes: 0, events: 0 };
  for (const r of rows) {
    const b = Math.floor(r.bucket / step) * step;
    const acc = byBucket.get(b) || { lines: 0, bytes: 0, events: 0 };
    acc.lines += r.lines; acc.bytes += r.bytes; acc.events += r.events;
    byBucket.set(b, acc);
    totals.lines += r.lines; totals.bytes += r.bytes; totals.events += r.events;
  }
  const buckets = [];
  for (let b = since; b <= t; b += step) {
    buckets.push({ bucket: b, ...(byBucket.get(b) || { lines: 0, bytes: 0, events: 0 }) });
  }
  res.json({ range, step, buckets, totals });
});

router.get('/pipeline/classifiers', (req, res) => {
  res.json(pipelineEngine.listClassifiers(req.orgId));
});

const CLASSIFIER_NAME_RE = /^[\w.:-]{1,50}$/;
router.put('/pipeline/classifiers', sec.requireRole('admin'), (req, res) => {
  const arr = req.body?.classifiers;
  if (!Array.isArray(arr) || arr.length > 100) {
    return httpError(res, 400, 'expected {classifiers:[...]} with at most 100 rules');
  }
  const cleaned = [];
  for (const c of arr) {
    if (!isStr(c?.pattern, 300)) return httpError(res, 400, 'each rule needs a pattern (max 300 chars)');
    const flags = c.flags == null || c.flags === '' ? 'i' : String(c.flags);
    if (!/^[imsu]{0,4}$/.test(flags)) return httpError(res, 400, `invalid regex flags "${flags}" (allowed: imsu)`);
    try { new RegExp(c.pattern, flags); } catch (e) { return httpError(res, 400, `invalid pattern: ${e.message}`); }
    if (!isStr(c.name, 50) || !CLASSIFIER_NAME_RE.test(c.name)) {
      return httpError(res, 400, 'each rule needs a name (letters, digits, . : _ -)');
    }
    const severity = clampInt(c.severity, 0, 100, -1);
    if (severity < 0) return httpError(res, 400, 'each rule needs a severity between 0 and 100');
    const targetGroup = c.targetGroup == null || c.targetGroup === '' ? null : clampInt(c.targetGroup, 1, 9, 0);
    if (targetGroup === 0) return httpError(res, 400, 'targetGroup must be a capture group number 1-9');
    cleaned.push({ pattern: c.pattern, flags, name: c.name, severity, ...(targetGroup ? { targetGroup } : {}) });
  }
  setOrgSetting(req.orgId, 'classifiers', JSON.stringify(cleaned));
  pipelineEngine.loadClassifiers(req.orgId);
  sec.audit(req.user.id, 'classifiers_update', `${cleaned.length} rules`, req.orgId);
  res.json({ ok: true, count: cleaned.length });
});

// Dry-run a sample line through this org's classifier chain (nothing is stored).
router.post('/pipeline/test', (req, res) => {
  const line = req.body?.line;
  if (!isStr(line, 8192)) return httpError(res, 400, 'expected {line} (max 8192 chars)');
  const sev = clampInt(req.body?.sev, 0, 7, 6);
  const match = pipelineEngine.classify(line, sev, req.orgId);
  res.json({
    match: match ? { name: match.name, severity: match.severity, target: match.target,
      source: match.source, pattern: match.pattern } : null,
    caseThreshold: pipelineEngine.CASE_THRESHOLD,
  });
});

// ---- Scout: rule suggestions mined from unclassified lines ----

const getScoutRow = db.prepare('SELECT * FROM scout_templates WHERE id = ? AND org_id = ?');

router.get('/scout', (req, res) => {
  const status = ['pending', 'approved', 'dismissed'].includes(req.query.status)
    ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT id, template, count, sample, status, suggestion, first_seen, last_seen
    FROM scout_templates WHERE org_id = ? AND status = ? ORDER BY count DESC LIMIT 200`)
    .all(req.orgId, status);
  res.json(rows.map((r) => {
    let suggestion = null;
    try { suggestion = r.suggestion ? JSON.parse(r.suggestion) : null; } catch { /* noop */ }
    return { id: r.id, template: r.template, count: r.count, sample: r.sample,
      status: r.status, suggestion, firstSeen: r.first_seen, lastSeen: r.last_seen };
  }));
});

const SCOUT_SYSTEM_PROMPT =
  'You classify masked syslog templates for a NOC monitoring system. Placeholders ' +
  'like <IP>, <NUM>, <*> stand for variable parts. Reply with a single JSON object, ' +
  'no prose: {"name": "<theme.meaning>", "severity": <0-100>, "skip": <true|false>, ' +
  '"reason": "<short justification>"}. The name is lowercase [a-z0-9._-], themed by ' +
  'the affected system, e.g. bgp.peer_down, disk.io_error, ssh.auth_fail. Severity ' +
  'bands: 80-100 critical (outage, corruption, security incident), 60-79 high, ' +
  '40-59 medium (degradation, suspicious), 20-39 low, 0-19 info. Set skip=true only ' +
  'for routine chatter with no operational subject.';

// Ask the org's LLM for a name/severity suggestion; stored on the row so the
// call happens once per template (admins can re-run it after model changes).
router.post('/scout/:id/suggest', sec.requireRole('admin'), async (req, res) => {
  const row = getScoutRow.get(req.params.id, req.orgId);
  if (!row) return httpError(res, 404, 'template not found');
  try {
    const reply = await llm.chat(req.orgId, [
      { role: 'system', content: SCOUT_SYSTEM_PROMPT },
      { role: 'user', content: `Template (seen ${row.count} times):\n${row.template}\n\nExample line:\n${row.sample || '-'}` },
    ], { maxTokens: 200, timeoutMs: 25000 });
    const jsonMatch = /\{[\s\S]*\}/.exec(reply);
    if (!jsonMatch) throw new Error('LLM reply carried no JSON object');
    const s = JSON.parse(jsonMatch[0]);
    const suggestion = {
      name: String(s.name || '').toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 50),
      severity: clampInt(s.severity, 0, 100, 30),
      skip: !!s.skip,
      reason: String(s.reason || '').slice(0, 300),
    };
    db.prepare('UPDATE scout_templates SET suggestion = ? WHERE id = ?')
      .run(JSON.stringify(suggestion), row.id);
    res.json({ ok: true, suggestion });
  } catch (e) {
    httpError(res, 502, String(e.message).slice(0, 300));
  }
});

// Approve: template becomes a real custom classifier rule (appended to the
// org's rule list, live reload). targetIndex picks which placeholder (1-based)
// is captured into the event target.
router.post('/scout/:id/approve', sec.requireRole('admin'), (req, res) => {
  const row = getScoutRow.get(req.params.id, req.orgId);
  if (!row) return httpError(res, 404, 'template not found');
  const name = req.body?.name;
  if (!isStr(name, 50) || !CLASSIFIER_NAME_RE.test(name)) {
    return httpError(res, 400, 'name required (letters, digits, . : _ -)');
  }
  const severity = clampInt(req.body?.severity, 0, 100, -1);
  if (severity < 0) return httpError(res, 400, 'severity 0-100 required');
  const targetIndex = clampInt(req.body?.targetIndex, 0, 9, 0);
  const { pattern, captureGroup } = scoutEngine.templateToPattern(row.template, targetIndex);
  if (pattern.length > 300) {
    return httpError(res, 400, 'generated pattern exceeds 300 chars — this template is too long for a rule');
  }
  const custom = pipelineEngine.listClassifiers(req.orgId).custom;
  if (custom.length >= 100) return httpError(res, 400, 'rule limit reached (100) — remove rules first');
  custom.push({ pattern, flags: 'i', name, severity, ...(captureGroup ? { targetGroup: captureGroup } : {}) });
  setOrgSetting(req.orgId, 'classifiers', JSON.stringify(custom));
  pipelineEngine.loadClassifiers(req.orgId);
  db.prepare("UPDATE scout_templates SET status = 'approved' WHERE id = ?").run(row.id);
  sec.audit(req.user.id, 'scout_approve', `${name} (sev ${severity}) ← ${row.template.slice(0, 120)}`, req.orgId);
  res.json({ ok: true, pattern, name, severity });
});

router.post('/scout/:id/dismiss', sec.requireRole('admin'), (req, res) => {
  const row = getScoutRow.get(req.params.id, req.orgId);
  if (!row) return httpError(res, 404, 'template not found');
  db.prepare("UPDATE scout_templates SET status = 'dismissed' WHERE id = ?").run(row.id);
  sec.audit(req.user.id, 'scout_dismiss', row.template.slice(0, 120), req.orgId);
  res.json({ ok: true });
});

// ---- automations (lead+ to modify) ----
// Trigger: {event: '<name>'|'*', severityMin?: 0-100}. Actions (1-5):
//   {type:'close_event', raiseEvent:'<name>', matchTarget?:bool}
//   {type:'assign_case', userId:<id>}
//   {type:'webhook', url:'https://...'}
const AUTOMATION_NAME_RE = /^[\w.:\- ]{1,80}$/;

function validateAutomation(b, res) {
  if (!isStr(b.name, 80) || !AUTOMATION_NAME_RE.test(b.name)) {
    return httpError(res, 400, 'name required (letters, digits, . : - _ and spaces)');
  }
  const trig = b.trigger;
  if (!trig || typeof trig !== 'object') return httpError(res, 400, 'trigger required');
  if (!isStr(trig.event, 100)) return httpError(res, 400, "trigger.event required ('*' = any event)");
  const severityMin = clampInt(trig.severityMin, 0, 100, 0);
  const actions = b.actions;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 5) {
    return httpError(res, 400, 'between 1 and 5 actions required');
  }
  const cleanActions = [];
  for (const a of actions) {
    if (a?.type === 'close_event') {
      if (!isStr(a.raiseEvent, 100)) return httpError(res, 400, 'close_event needs raiseEvent (the event name it resolves)');
      cleanActions.push({ type: 'close_event', raiseEvent: a.raiseEvent, matchTarget: a.matchTarget !== false });
    } else if (a?.type === 'assign_case') {
      const userId = clampInt(a.userId, 1, 1e9, 0);
      if (!userId) return httpError(res, 400, 'assign_case needs userId');
      cleanActions.push({ type: 'assign_case', userId });
    } else if (a?.type === 'webhook') {
      if (!isStr(a.url, 500) || !/^https?:\/\//.test(a.url)) return httpError(res, 400, 'webhook needs an http(s) url');
      cleanActions.push({ type: 'webhook', url: a.url });
    } else {
      return httpError(res, 400, `unknown action type ${String(a?.type).slice(0, 40)}`);
    }
  }
  return { name: b.name, trigger: { event: trig.event, severityMin }, actions: cleanActions,
    cooldownM: clampInt(b.cooldownM, 0, 1440, 15), enabled: b.enabled !== false };
}

router.get('/automations', (req, res) => {
  res.json(db.prepare('SELECT * FROM automations WHERE org_id = ? ORDER BY id').all(req.orgId)
    .map((a) => {
      let trigger = null, actions = [];
      try { trigger = JSON.parse(a.trigger_json); actions = JSON.parse(a.actions_json); } catch { /* invalid */ }
      return { id: a.id, name: a.name, enabled: !!a.enabled, trigger, actions,
        cooldownM: a.cooldown_m, createdAt: a.created_at };
    }));
});

// recent runs (from the audit trail; system actor)
router.get('/automations/runs', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50);
  res.json(db.prepare(`SELECT ts, detail FROM audit_log
    WHERE org_id = ? AND action = 'automation_run' ORDER BY ts DESC LIMIT ?`).all(req.orgId, limit));
});

router.post('/automations', sec.requireRole('lead'), (req, res) => {
  const v = validateAutomation(req.body || {}, res);
  if (!v) return undefined;
  const info = db.prepare(`INSERT INTO automations (org_id, name, enabled, trigger_json, actions_json,
    cooldown_m, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.orgId, v.name, v.enabled ? 1 : 0, JSON.stringify(v.trigger), JSON.stringify(v.actions),
      v.cooldownM, req.user.id, now());
  automationEngine.invalidate(req.orgId);
  sec.audit(req.user.id, 'automation_create', v.name, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/automations/:id', sec.requireRole('lead'), (req, res) => {
  const a = db.prepare('SELECT * FROM automations WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!a) return httpError(res, 404, 'automation not found');
  const b = req.body || {};
  // toggle-only PATCH keeps the stored definition untouched
  if (Object.keys(b).length === 1 && typeof b.enabled === 'boolean') {
    db.prepare('UPDATE automations SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, a.id);
  } else {
    const v = validateAutomation(b, res);
    if (!v) return undefined;
    db.prepare(`UPDATE automations SET name = ?, enabled = ?, trigger_json = ?, actions_json = ?,
      cooldown_m = ? WHERE id = ?`)
      .run(v.name, v.enabled ? 1 : 0, JSON.stringify(v.trigger), JSON.stringify(v.actions), v.cooldownM, a.id);
  }
  automationEngine.invalidate(req.orgId);
  sec.audit(req.user.id, 'automation_update', a.name, req.orgId);
  res.json({ ok: true });
});

router.delete('/automations/:id', sec.requireRole('lead'), (req, res) => {
  const a = db.prepare('SELECT name FROM automations WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!a) return httpError(res, 404, 'automation not found');
  db.prepare('DELETE FROM automations WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  automationEngine.invalidate(req.orgId);
  sec.audit(req.user.id, 'automation_delete', a.name, req.orgId);
  res.json({ ok: true });
});

// ---- AI / LLM endpoint (admin) ----
// Org-level override of the platform default. OpenAI-compatible: base URL is
// the API root (e.g. https://openrouter.ai/api/v1). The key is stored
// encrypted and never returned — GET only reports hasKey.

router.get('/ai', sec.requireRole('admin'), (req, res) => {
  res.json(llm.statusFor(req.orgId));
});

router.put('/ai', sec.requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.baseUrl !== undefined) {
    const v = String(b.baseUrl).trim();
    if (v && !/^https?:\/\/[^\s]{1,300}$/.test(v)) return httpError(res, 400, 'baseUrl must be an http(s) URL');
    patch.baseUrl = v;
  }
  if (b.model !== undefined) {
    if (!isStr(b.model, 200) && b.model !== '') return httpError(res, 400, 'bad model');
    patch.model = String(b.model);
  }
  if (b.apiKey !== undefined) {
    if (typeof b.apiKey !== 'string' || b.apiKey.length > 500) return httpError(res, 400, 'bad apiKey');
    patch.apiKey = b.apiKey; // '' clears the stored key
  }
  llm.saveOrgConfig(req.orgId, patch);
  sec.audit(req.user.id, 'ai_config_update',
    Object.keys(patch).map((k) => (k === 'apiKey' ? 'apiKey(hidden)' : k)).join(','), req.orgId);
  res.json({ ok: true, ...llm.statusFor(req.orgId) });
});

// Fire a one-line prompt at the effective endpoint (org override or platform
// default) so admins can verify their config. Nothing is stored.
router.post('/ai/test', sec.requireRole('admin'), async (req, res) => {
  const t0 = Date.now();
  try {
    const reply = await llm.chat(req.orgId,
      [{ role: 'user', content: 'Reply with the single word: ok' }],
      { maxTokens: 8, timeoutMs: 20000 });
    const status = llm.statusFor(req.orgId);
    res.json({ ok: true, source: status.effectiveSource, model: status.effectiveModel,
      latencyMs: Date.now() - t0, reply: reply.slice(0, 100) });
  } catch (e) {
    httpError(res, 502, String(e.message).slice(0, 300));
  }
});

// ---- Voice / STT endpoint (admin) — Bridge transcription (docs/BRIDGE.md) --
// Org-level override of the platform default. OpenAI-compatible transcription
// API: base URL is the API root (e.g. https://api.openai.com/v1); the Bridge
// posts speech chunks against /audio/transcriptions. Key stored encrypted,
// GET only reports hasKey — same contract as the AI endpoint above.

router.get('/voice', sec.requireRole('admin'), (req, res) => {
  res.json(voice.statusFor(req.orgId));
});

router.put('/voice', sec.requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.baseUrl !== undefined) {
    const v = String(b.baseUrl).trim();
    if (v && !/^https?:\/\/[^\s]{1,300}$/.test(v)) return httpError(res, 400, 'baseUrl must be an http(s) URL');
    patch.baseUrl = v;
  }
  if (b.model !== undefined) {
    if (!isStr(b.model, 200) && b.model !== '') return httpError(res, 400, 'bad model');
    patch.model = String(b.model);
  }
  if (b.apiKey !== undefined) {
    if (typeof b.apiKey !== 'string' || b.apiKey.length > 500) return httpError(res, 400, 'bad apiKey');
    patch.apiKey = b.apiKey; // '' clears the stored key
  }
  voice.saveOrgConfig(req.orgId, patch);
  sec.audit(req.user.id, 'voice_config_update',
    Object.keys(patch).map((k) => (k === 'apiKey' ? 'apiKey(hidden)' : k)).join(','), req.orgId);
  res.json({ ok: true, ...voice.statusFor(req.orgId) });
});

// Round-trip a synthesized 0.6s test tone through the effective voice
// endpoint so admins can verify base URL + key + model. A tone transcribes to
// (near-)empty text — the call succeeding is the verification.
router.post('/voice/test', sec.requireRole('admin'), async (req, res) => {
  const t0 = Date.now();
  try {
    const text = await voice.transcribe(req.orgId, voice.testWav(), 'audio/wav', { timeoutMs: 20000 });
    const status = voice.statusFor(req.orgId);
    res.json({ ok: true, source: status.effectiveSource, model: status.effectiveModel,
      latencyMs: Date.now() - t0, text: text.slice(0, 100) });
  } catch (e) {
    httpError(res, 502, String(e.message).slice(0, 300));
  }
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
  res.json(db.prepare(`SELECT id, name, grp, hostname, platform, version, active, auto_update,
    last_seen_at, created_at FROM agents WHERE org_id = ? ORDER BY grp, id`).all(req.orgId)
    .map((a) => ({ id: a.id, name: a.name, group: a.grp, hostname: a.hostname, platform: a.platform,
      version: a.version, active: !!a.active, autoUpdate: !!a.auto_update, lastSeenAt: a.last_seen_at,
      online: !!a.last_seen_at && t - a.last_seen_at < 3 * 60 * 1000 })));
});

router.post('/agents', sec.requireRole('lead'), (req, res) => {
  const { name, group, autoUpdate } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  if (db.prepare('SELECT id FROM agents WHERE name = ?').get(name)) {
    return httpError(res, 409, 'agent name already exists');
  }
  if (!withinPlan(req, res, 'agents')) return undefined;
  const token = 'oca_' + crypto.randomBytes(24).toString('hex');
  const info = db.prepare(`INSERT INTO agents (org_id, name, grp, token_hash, auto_update, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.orgId, name, isStr(group, 100) ? group : 'default', sha256(token),
      autoUpdate === false ? 0 : 1, now());
  sec.audit(req.user.id, 'agent_create', name, req.orgId);
  res.json({ id: info.lastInsertRowid, token, note: 'store this token now — it is not retrievable later' });
});

router.patch('/agents/:id', sec.requireRole('lead'), (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!a) return httpError(res, 404, 'agent not found');
  const b = req.body || {};
  db.prepare('UPDATE agents SET auto_update = COALESCE(?, auto_update) WHERE id = ? AND org_id = ?')
    .run(typeof b.autoUpdate === 'boolean' ? (b.autoUpdate ? 1 : 0) : null, a.id, req.orgId);
  sec.audit(req.user.id, 'agent_update', a.name, req.orgId);
  res.json({ ok: true });
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
  const comps = db.prepare(`SELECT c.*, co.user_id AS owner_user_id FROM components c
    LEFT JOIN component_owners co ON co.component_id = c.id
    WHERE c.org_id = ? ORDER BY c.sort, c.id`).all(req.orgId);
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
      ownerId: c.owner_user_id || null,
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
  if (b.status && !statusScale.ORDER.includes(b.status)) return httpError(res, 400, 'bad status');
  db.prepare(`UPDATE components SET name = COALESCE(?, name), grp = COALESCE(?, grp),
      status = COALESCE(?, status) WHERE id = ? AND org_id = ?`)
    .run(isStr(b.name, 100) ? b.name : null, isStr(b.group, 100) ? b.group : null,
      b.status || null, c.id, req.orgId);
  // owner: an explicit null clears, a user id (org member) sets, absent = keep
  if ('ownerId' in b) {
    if (b.ownerId === null) {
      db.prepare('DELETE FROM component_owners WHERE component_id = ?').run(c.id);
    } else {
      const u = db.prepare(`SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.user_id = ? AND m.org_id = ? AND u.active = 1`).get(b.ownerId, req.orgId);
      if (!u) return httpError(res, 400, 'owner must be a member of this organization');
      db.prepare(`INSERT INTO component_owners (component_id, user_id) VALUES (?, ?)
        ON CONFLICT(component_id) DO UPDATE SET user_id = excluded.user_id`).run(c.id, u.id);
    }
  }
  sec.audit(req.user.id, 'component_status', `${c.name} → ${b.status || c.status}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/components/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM components WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'component_delete', `component ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- status-page subscribers (lead+: addresses are PII, same gate as users) --
const subscribersLib = require('../lib/subscribers');

router.get('/status-subscribers', sec.requireRole('lead'), (req, res) => {
  res.json({ available: subscribersLib.available(req.orgId),
    enabled: subscribersLib.enabled(req.orgId), ...subscribersLib.adminList(req.orgId) });
});

router.delete('/status-subscribers/:id', sec.requireRole('lead'), (req, res) => {
  if (!subscribersLib.adminDelete(req.orgId, Number(req.params.id))) {
    return httpError(res, 404, 'subscriber not found');
  }
  sec.audit(req.user.id, 'status_subscriber_delete', `subscriber ${req.params.id}`, req.orgId);
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
