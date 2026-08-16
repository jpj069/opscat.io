'use strict';
// Idempotent bootstrap: default organization, first super-admin user, default
// components, synthetic checks and a sane alert rule. Run at boot — safe to re-run.
const crypto = require('crypto');
const { db, getOrgSetting, setOrgSetting, addMembership } = require('../db');
const { now, hashPassword, newId, DEFAULT_ORG_ID } = require('../util');

function seed({ log = console.log } = {}) {
  const t = now();

  // --- default organization (migration also ensures this; belt & suspenders) ---
  if (db.prepare('SELECT COUNT(*) AS c FROM organizations').get().c === 0) {
    db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
      VALUES (?, 'OpsCat', 'default', 'enterprise', 'active', ?)`).run(DEFAULT_ORG_ID, t);
    log('[seed] created default organization');
  }

  // --- first user: platform super-admin + owner of the default org ---
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  let adminCredentials = null;
  if (userCount === 0) {
    const email = (process.env.OPSCAT_ADMIN_EMAIL || 'admin@opscat.io').toLowerCase();
    const password = process.env.OPSCAT_ADMIN_PASSWORD ||
      crypto.randomBytes(12).toString('base64url');
    const { salt, hash } = hashPassword(password);
    // The id is minted here rather than read back from lastInsertRowid — a TEXT
    // primary key has no rowid to read back.
    const userId = newId();
    db.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
      VALUES (?, ?, ?, ?, 'admin', 1, ?, ?, '#f0883e', 1, 1, ?)`)
      .run(userId, DEFAULT_ORG_ID, email, process.env.OPSCAT_ADMIN_NAME || 'OpsCat Admin', salt, hash, t);
    addMembership(userId, DEFAULT_ORG_ID, 'admin');
    adminCredentials = { email, password };
    log(`[seed] created super-admin ${email} — initial password: ${password}`);
    log('[seed] the password must be changed on first login.');
  }

  // --- status page components (default org) ---
  if (db.prepare('SELECT COUNT(*) AS c FROM components WHERE org_id = ?').get(DEFAULT_ORG_ID).c === 0) {
    const ins = db.prepare('INSERT INTO components (org_id, name, grp, status, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    [['Platform API', 'Platform', 0], ['Web App', 'Platform', 1],
     ['Log Ingest', 'Ingest', 2], ['Synthetics Network', 'Monitoring', 3],
    ].forEach(([name, grp, sort]) => ins.run(DEFAULT_ORG_ID, name, grp, 'operational', sort, t));
    log('[seed] created default status page components');
  }

  // --- default synthetic checks (default org) ---
  if (db.prepare('SELECT COUNT(*) AS c FROM synthetic_checks WHERE org_id = ?').get(DEFAULT_ORG_ID).c === 0) {
    const ins = db.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s, timeout_ms, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`);
    ins.run(DEFAULT_ORG_ID, 'http', 'https://opscat.io/api/health', 60, 5000, t);
    ins.run(DEFAULT_ORG_ID, 'icmp', 'opscat.io', 60, 5000, t);
    ins.run(DEFAULT_ORG_ID, 'dns', 'opscat.io', 300, 4000, t);
    ins.run(DEFAULT_ORG_ID, 'traceroute', 'opscat.io', 900, 30000, t);
    log('[seed] created default synthetic checks');
  }

  // --- default alert rule (e-mail to admin) ---
  if (db.prepare('SELECT COUNT(*) AS c FROM alert_rules WHERE org_id = ?').get(DEFAULT_ORG_ID).c === 0) {
    const adminEmail = db.prepare("SELECT email FROM users WHERE org_id = ? AND role = 'admin' ORDER BY created_at LIMIT 1")
      .get(DEFAULT_ORG_ID);
    db.prepare(`INSERT INTO alert_rules (org_id, name, enabled, channel, trigger_name, severity_min, cooldown_m,
      recipients, created_at) VALUES (?, 'Critical → E-Mail', 1, 'email', NULL, 80, 30, ?, ?)`)
      .run(DEFAULT_ORG_ID, JSON.stringify(adminEmail ? [adminEmail.email] : []), t);
    log('[seed] created default alert rule');
  }

  // --- default org settings ---
  const seedSetting = (key, val) => {
    if (!getOrgSetting(DEFAULT_ORG_ID, key)) setOrgSetting(DEFAULT_ORG_ID, key, val);
  };
  seedSetting('org_name', 'OpsCat');
  seedSetting('backend_label', 'nbg1 · PRIMARY');
  seedSetting('status_published', '1');
  seedSetting('alert_email_from', process.env.OPSCAT_ALERT_FROM || 'OpsCat Alerts <onboarding@resend.dev>');
  seedSetting('auth_email_from', process.env.OPSCAT_AUTH_FROM || process.env.OPSCAT_ALERT_FROM ||
    'OpsCat <onboarding@resend.dev>');
  seedSetting('retention_logs_days', '7');

  return adminCredentials;
}

if (require.main === module) seed();
module.exports = { seed };
