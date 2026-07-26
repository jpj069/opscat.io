'use strict';
// Unauthenticated surface: health check + public status page (JSON + HTML)
// + anonymous "report a problem" submissions (rate-limited, honeypot-guarded).
const express = require('express');
const { db, getOrgSetting, getSetting } = require('../db');
const { now, sha256, RateLimiter, clampInt } = require('../util');
const { clientIp } = require('../security');
const config = require('../config');

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
  const data = { overall: worst, overallLabel: STATUS_LABEL[worst], components, incidents,
    org: getOrgSetting(orgId, 'org_name', 'OpsCat'), ts: now(),
    reportsEnabled: reportsEnabled(orgId) };
  // ids are needed by the report form's component picker
  data.components.forEach((c, i) => { c.id = comps[i].id; });
  if (getOrgSetting(orgId, 'status_reports_public', '0') === '1') {
    data.reports60m = db.prepare(
      'SELECT COUNT(*) c FROM status_reports WHERE org_id = ? AND ts >= ?').get(orgId, now() - 3600000).c;
  }
  return data;
}

function reportsEnabled(orgId) { return getOrgSetting(orgId, 'status_reports_enabled', '1') === '1'; }

function published(orgId) { return getOrgSetting(orgId, 'status_published', '1') === '1'; }

router.get('/api/status', (req, res) => {
  const org = resolveOrg(req.query.org);
  if (!org || !published(org.id)) return res.status(404).json({ error: 'not published' });
  res.json(statusData(org.id));
});

// ---- user problem reports (Downdetector-style) -------------------------------

const reportLimiter = new RateLimiter({ perMinute: 3, burst: 3 });
const insReport = db.prepare(
  'INSERT INTO status_reports (org_id, ts, component_id, message, ip_hash) VALUES (?, ?, ?, ?, ?)');
const lastReportFrom = db.prepare(
  'SELECT MAX(ts) t FROM status_reports WHERE org_id = ? AND ip_hash = ?');

// Accepts the status-page form (urlencoded) or JSON. The `website` field is a
// honeypot — humans never see it, bots fill it. Success and silent drops both
// answer alike so probing reveals nothing.
function handleReport(req, res, org, redirectTo) {
  const done = () => (redirectTo
    ? res.redirect(303, `${redirectTo}?reported=1`)
    : res.json({ ok: true }));
  if (!org || !published(org.id) || !reportsEnabled(org.id)) {
    return redirectTo ? res.redirect(303, redirectTo || '/status') : res.status(404).json({ error: 'not published' });
  }
  const b = req.body || {};
  const ip = clientIp(req);
  if (typeof b.website === 'string' && b.website.trim() !== '') return done(); // honeypot hit
  if (!reportLimiter.allow(`${org.id}|${ip}`)) return done();
  const ipHash = sha256(`${org.id}|${ip}`);
  const t = now();
  const last = lastReportFrom.get(org.id, ipHash).t;
  if (last && t - last < 10 * 60 * 1000) return done(); // one report per visitor per 10 min
  let componentId = null;
  const cid = parseInt(b.componentId, 10);
  if (Number.isFinite(cid)) {
    const comp = db.prepare('SELECT id FROM components WHERE id = ? AND org_id = ?').get(cid, org.id);
    if (comp) componentId = comp.id;
  }
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 500) : null;
  insReport.run(org.id, t, componentId, message || null, ipHash);
  return done();
}

router.post('/api/status/report', (req, res) => handleReport(req, res, resolveOrg(req.query.org), null));
router.post('/status/report', (req, res) => handleReport(req, res, resolveOrg(null), '/status'));
router.post('/status/:slug/report', (req, res) =>
  handleReport(req, res, resolveOrg(req.params.slug), `/status/${encodeURIComponent(req.params.slug)}`));

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
  const reported = req.query.reported === '1';
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
  details.report{margin-top:24px;border:1px solid #21262d;border-radius:8px;background:#161b22}
  details.report summary{cursor:pointer;padding:12px 16px;font-weight:600;color:#c9d1d9;font-size:13px}
  .report-form{padding:0 16px 14px;display:flex;flex-direction:column;gap:8px}
  .report-form select,.report-form textarea{background:#0b0e14;color:#c9d1d9;border:1px solid #30363d;
    border-radius:6px;padding:8px 10px;font:12px Inter,system-ui,sans-serif}
  .report-form textarea{min-height:64px;resize:vertical}
  .report-form button{align-self:flex-start;background:#238636;color:#fff;border:none;border-radius:6px;
    padding:8px 16px;font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  .hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
  .thanks{padding:12px 16px;border:1px solid rgba(63,185,80,.35);border-radius:8px;
    background:rgba(63,185,80,.08);color:#3fb950;font-size:13px;font-weight:600;margin-top:24px}
  .rcount{margin-left:auto;font-size:11px;font-weight:500;color:#8b949e}
</style></head><body><div class="wrap">
<h1><span class="logo"></span>${esc(d.org)} Status</h1>
<div class="banner"><span class="dot" style="background:${DOT[d.overall]};box-shadow:0 0 8px ${DOT[d.overall]}"></span>
${esc(d.overallLabel)}${Number.isFinite(d.reports60m) ? `<span class="rcount">${d.reports60m} user report${d.reports60m === 1 ? '' : 's'} in the last hour</span>` : ''}</div>
${compRows}
${incRows ? `<h2>Incidents</h2>${incRows}` : ''}
${reported ? '<div class="thanks">Thanks — your report has been recorded and our team can see it.</div>' : ''}
${d.reportsEnabled && !reported ? `<details class="report"><summary>Something not working for you? Report a problem</summary>
<form class="report-form" method="post" action="${esc(req.path)}/report">
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<select name="componentId"><option value="">Affected service (optional)</option>
${d.components.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
<textarea name="message" maxlength="500" placeholder="What are you seeing? (optional)"></textarea>
<button type="submit">Send report</button>
</form></details>` : ''}
<footer>Powered by OpsCat · ${new Date(d.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC</footer>
</div></body></html>`);
}

router.get('/status', (req, res) => renderStatus(req, res, resolveOrg(null)));
router.get('/status/:slug', (req, res) => renderStatus(req, res, resolveOrg(req.params.slug)));

// ---- public vendor-status grid (marketing / community output) ----------------
// Aggregated live status of every vendor the platform org (org 1) monitors.
// Off by default: publish with setting vendor_grid_published=1 (or env
// OPSCAT_GRID_PUBLISHED=1). Served as JSON, as /vendor-grid, and as the front
// page on config.gridHost (e.g. radar.opscat.io — plain Caddy vhost).

function gridPublished() {
  return (getSetting('vendor_grid_published') || process.env.OPSCAT_GRID_PUBLISHED || '0') === '1';
}

let gridCache = { ts: 0, data: null };
function gridData() {
  const t = now();
  if (gridCache.data && t - gridCache.ts < 60000) return gridCache.data;
  const reports = new Map(db.prepare(
    'SELECT slug, COUNT(*) c FROM vendor_reports WHERE ts >= ? GROUP BY slug').all(t - 3600000)
    .map((r) => [r.slug, r.c]));
  const vendors = db.prepare(`SELECT v.slug, v.name, v.status, v.page_url, v.last_checked_at,
      (SELECT COUNT(*) FROM vendor_incidents i WHERE i.vendor_id = v.id AND i.resolved_at IS NULL) AS active
    FROM vendors v WHERE v.org_id = 1 AND v.enabled = 1
      AND v.slug NOT LIKE 'custom-%' ORDER BY v.name`).all()
    .map((v) => ({ slug: v.slug, name: v.name, status: v.status,
      activeIncidents: v.active, userReports60m: reports.get(v.slug) || 0,
      pageUrl: v.page_url, lastCheckedAt: v.last_checked_at }));
  const disrupted = vendors.filter((v) => ['degraded', 'partial', 'major'].includes(v.status)).length;
  gridCache = { ts: t, data: { updatedAt: t, total: vendors.length, disrupted, vendors } };
  return gridCache.data;
}

// community signal: anonymous "down for me too" reports on grid vendors
const gridReportLimiter = new RateLimiter({ perMinute: 4, burst: 4 });
const insVendorReport = db.prepare('INSERT INTO vendor_reports (slug, ts, ip_hash) VALUES (?, ?, ?)');
const lastVendorReport = db.prepare(
  'SELECT MAX(ts) t FROM vendor_reports WHERE slug = ? AND ip_hash = ?');

function handleGridReport(req, res) {
  const back = (req.hostname || '').toLowerCase() === config.gridHost ? '/' : '/vendor-grid';
  const redirect = req.is('application/json') ? null : back;
  const done = () => (redirect ? res.redirect(303, `${redirect}?reported=1`) : res.json({ ok: true }));
  if (!gridPublished()) return res.status(404).json({ error: 'not published' });
  const b = req.body || {};
  if (typeof b.website === 'string' && b.website.trim() !== '') return done(); // honeypot
  const slug = typeof b.slug === 'string' ? b.slug.slice(0, 80) : '';
  const known = gridData().vendors.some((v) => v.slug === slug);
  if (!known) return done(); // silently ignore unknown slugs
  const ip = clientIp(req);
  if (!gridReportLimiter.allow(ip)) return done();
  const ipHash = sha256(`grid|${ip}`);
  const t = now();
  const last = lastVendorReport.get(slug, ipHash).t;
  if (last && t - last < 60 * 60 * 1000) return done(); // one report per visitor per vendor per hour
  insVendorReport.run(slug, t, ipHash);
  gridCache.ts = 0; // reflect the new count on the next render
  return done();
}

router.post('/api/public/vendor-grid/report', handleGridReport);
router.post('/vendor-grid/report', handleGridReport);

router.get('/api/public/vendor-grid', (req, res) => {
  if (!gridPublished()) return res.status(404).json({ error: 'not published' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(gridData());
});

const GRID_DOT = { operational: '#3fb950', maintenance: '#bc8cff', degraded: '#e3b341',
  partial: '#f0883e', major: '#f85149', unknown: '#8b949e' };

function renderVendorGrid(req, res) {
  if (!gridPublished()) return res.status(404).send('<h1>Not published</h1>');
  const d = gridData();
  const reported = req.query.reported === '1';
  const reportAction = ((req.hostname || '').toLowerCase() === config.gridHost ? '' : '/vendor-grid') + '/report';
  const rows = d.vendors.map((v) => `<div class="v">
    <a class="vlink" href="${esc(v.pageUrl || '#')}" target="_blank" rel="noreferrer">
      <span class="dot" style="background:${GRID_DOT[v.status] || GRID_DOT.unknown}"></span>
      <span class="vn">${esc(v.name)}</span>
      <span class="vs" style="color:${GRID_DOT[v.status] || GRID_DOT.unknown}">${esc(v.status)}${
        v.activeIncidents ? ` · ${v.activeIncidents} inc` : ''}</span>
    </a>
    <form method="post" action="${esc(reportAction)}" class="rep">
      <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="slug" value="${esc(v.slug)}">
      <button type="submit" title="Report: down for me too">${
        v.userReports60m ? `⚠ ${v.userReports60m}` : 'report'}</button>
    </form>
  </div>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpsCat Radar — live status of ${d.total} cloud services</title>
<meta name="description" content="Live status of ${d.total} cloud &amp; SaaS services, aggregated from their official status pages. Powered by OpsCat.">
<style>
  body{margin:0;background:#0b0e14;color:#c9d1d9;font:14px/1.5 Inter,system-ui,sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:40px 20px}
  h1{font-size:20px;color:#f0f6fc;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .logo{width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,#6366f1,#4338ca)}
  .sub{font-size:13px;color:#8b949e;margin:6px 0 24px}
  .sub b{color:${d.disrupted ? '#f0883e' : '#3fb950'}}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
  .v{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #21262d;border-radius:8px;
     background:#161b22}
  .v:hover{border-color:#30363d}
  .vlink{display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-decoration:none;color:inherit}
  .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
  .vn{font-weight:600;color:#f0f6fc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vs{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:10px;flex-shrink:0}
  .rep{margin:0;flex-shrink:0}
  .rep button{background:transparent;border:1px solid #30363d;border-radius:5px;color:#8b949e;
     font:10px 'JetBrains Mono',monospace;padding:2px 7px;cursor:pointer}
  .rep button:hover{color:#e3b341;border-color:#e3b341}
  .hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
  .thanks{padding:10px 14px;border:1px solid rgba(63,185,80,.35);border-radius:8px;
     background:rgba(63,185,80,.08);color:#3fb950;font-size:12px;font-weight:600;margin-bottom:16px}
  footer{margin-top:32px;font-size:11px;color:#484f58}
  footer a{color:#58a6ff;text-decoration:none}
</style></head><body><div class="wrap">
<h1><span class="logo"></span>OpsCat Radar</h1>
<div class="sub">Live status of <b>${d.total}</b> cloud &amp; SaaS services — ${
    d.disrupted ? `<b>${d.disrupted} with issues right now</b>` : '<b>all operational</b>'}.
  Aggregated from the vendors' official status pages, refreshed continuously.
  Something down that the vendor hasn't acknowledged yet? Hit “report”.</div>
${reported ? '<div class="thanks">Thanks — your report has been counted.</div>' : ''}
<div class="grid">${rows}</div>
<footer>Data is republished from each vendor's official public status page — all trademarks belong to their owners.
Monitor your own supply chain with <a href="https://opscat.io" rel="noreferrer">OpsCat</a> ·
JSON: <a href="/api/public/vendor-grid">/api/public/vendor-grid</a> ·
Updated ${new Date(d.updatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC</footer>
</div></body></html>`);
}

router.get('/vendor-grid', renderVendorGrid);
// the grid subdomain serves the grid as its front page
router.get('/', (req, res, next) => {
  if ((req.hostname || '').toLowerCase() !== config.gridHost) return next();
  renderVendorGrid(req, res);
});

module.exports = router;
