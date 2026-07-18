'use strict';
// Unauthenticated surface: health check + public status page (JSON + HTML).
const express = require('express');
const { db, getOrgSetting } = require('../db');
const { now } = require('../util');

const router = express.Router();

router.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'opscat', ts: now() });
});

function resolveOrg(slugOrNull) {
  if (!slugOrNull) return db.prepare('SELECT * FROM organizations WHERE id = 1').get();
  return db.prepare('SELECT * FROM organizations WHERE slug = ?').get(String(slugOrNull).toLowerCase());
}

const STATUS_RANK = { operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };
const STATUS_LABEL = {
  operational: 'All Systems Operational', maintenance: 'Scheduled Maintenance in Progress',
  degraded: 'Degraded Performance', partial: 'Partial Outage', major: 'Major Outage',
};

function statusData(orgId) {
  const comps = db.prepare('SELECT * FROM components WHERE org_id = ? ORDER BY sort, id').all(orgId);
  const since = new Date(now() - 45 * 86400000).toISOString().slice(0, 10);
  const ids = comps.map((c) => c.id);
  const days = ids.length
    ? db.prepare(`SELECT * FROM component_days WHERE day >= ? AND component_id IN (${ids.map(() => '?').join(',')})`)
        .all(since, ...ids)
    : [];
  const byComp = new Map();
  for (const d of days) {
    if (!byComp.has(d.component_id)) byComp.set(d.component_id, []);
    byComp.get(d.component_id).push(d);
  }
  let worst = 'operational';
  const components = comps.map((c) => {
    if (STATUS_RANK[c.status] > STATUS_RANK[worst]) worst = c.status;
    const cd = (byComp.get(c.id) || []).sort((a, b) => a.day.localeCompare(b.day));
    const totalDown = cd.reduce((a, d) => a + d.down_seconds, 0);
    const totalSecs = Math.max(1, cd.length) * 86400;
    return {
      name: c.name, group: c.grp, status: c.status,
      uptimePct: (100 - (totalDown / totalSecs) * 100).toFixed(2),
      days: cd.map((d) => ({ day: d.day, worst: d.worst })),
    };
  });
  const incidents = db.prepare(`SELECT * FROM incidents WHERE org_id = ? AND published = 1
    ORDER BY started_at DESC LIMIT 10`).all(orgId).map((i) => ({
      label: `INC-${2000 + i.id}`, title: i.title, status: i.status,
      startedAt: i.started_at, resolvedAt: i.resolved_at,
      updates: db.prepare(`SELECT ts, status, message FROM incident_updates
        WHERE incident_id = ? ORDER BY ts DESC LIMIT 10`).all(i.id),
    }));
  return { overall: worst, overallLabel: STATUS_LABEL[worst], components, incidents,
    org: getOrgSetting(orgId, 'org_name', 'OpsCat'), ts: now() };
}

function published(orgId) { return getOrgSetting(orgId, 'status_published', '1') === '1'; }

router.get('/api/status', (req, res) => {
  const org = resolveOrg(req.query.org);
  if (!org || !published(org.id)) return res.status(404).json({ error: 'not published' });
  res.json(statusData(org.id));
});

const DOT = { operational: '#3fb950', maintenance: '#bc8cff', degraded: '#e3b341',
  partial: '#f0883e', major: '#f85149' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderStatus(req, res, org) {
  if (!org || !published(org.id)) {
    return res.status(404).send('<h1>Status page not published</h1>');
  }
  const d = statusData(org.id);
  const compRows = d.components.map((c) => {
    const cells = c.days.map((day) =>
      `<div title="${esc(day.day)}: ${esc(day.worst)}" style="flex:1;height:18px;border-radius:1px;background:${
        day.worst === 'operational' ? 'rgba(63,185,80,.55)' : DOT[day.worst] || '#e3b341'}"></div>`
    ).join('');
    return `<div class="comp">
      <div class="comp-head">
        <span class="dot" style="background:${DOT[c.status]};box-shadow:0 0 6px ${DOT[c.status]}"></span>
        <span class="name">${esc(c.name)}</span>
        <span class="grp">${esc(c.group)}</span>
        <span class="pct">${c.uptimePct}%</span>
      </div>
      <div class="strip">${cells || '<div style="color:#8b949e;font-size:11px">collecting data…</div>'}</div>
    </div>`;
  }).join('');
  const incRows = d.incidents.map((i) => `
    <div class="inc">
      <div class="inc-head"><span class="mono">${esc(i.label)}</span> ${esc(i.title)}
        <span class="pill ${i.status === 'resolved' ? 'ok' : 'warn'}">${esc(i.status)}</span></div>
      ${i.updates.map((u) => `<div class="upd"><span class="mono">${
        new Date(u.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC</span> — ${esc(u.message)}</div>`).join('')}
    </div>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.org)} Status</title>
<style>
  body{margin:0;background:#0b0e14;color:#c9d1d9;font:14px/1.5 Inter,system-ui,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:40px 20px}
  h1{font-size:18px;color:#f0f6fc;display:flex;align-items:center;gap:10px}
  .logo{width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,#6366f1,#4338ca)}
  .banner{display:flex;align-items:center;gap:10px;padding:16px;border:1px solid #30363d;
    border-radius:8px;background:#161b22;margin:24px 0;font-weight:600;color:#f0f6fc}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
  .comp{padding:12px 16px;border:1px solid #21262d;border-radius:8px;background:#161b22;margin-bottom:10px}
  .comp-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .name{font-weight:600;color:#f0f6fc}
  .grp{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b949e}
  .pct{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:12px;color:#8b949e}
  .strip{display:flex;gap:2px}
  h2{font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-top:32px}
  .inc{padding:12px 16px;border:1px solid #21262d;border-radius:8px;background:#161b22;margin-bottom:10px}
  .inc-head{font-weight:600;color:#f0f6fc;margin-bottom:6px}
  .mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b949e}
  .upd{font-size:12px;color:#8b949e;padding:2px 0}
  .pill{font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:6px}
  .pill.ok{background:rgba(63,185,80,.12);color:#3fb950}
  .pill.warn{background:rgba(227,179,65,.12);color:#e3b341}
  footer{margin-top:40px;font-size:11px;color:#484f58}
</style></head><body><div class="wrap">
<h1><span class="logo"></span>${esc(d.org)} Status</h1>
<div class="banner"><span class="dot" style="background:${DOT[d.overall]};box-shadow:0 0 8px ${DOT[d.overall]}"></span>
${esc(d.overallLabel)}</div>
${compRows}
${incRows ? `<h2>Incidents</h2>${incRows}` : ''}
<footer>Powered by OpsCat · ${new Date(d.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC</footer>
</div></body></html>`);
}

router.get('/status', (req, res) => renderStatus(req, res, resolveOrg(null)));
router.get('/status/:slug', (req, res) => renderStatus(req, res, resolveOrg(req.params.slug)));

module.exports = router;
