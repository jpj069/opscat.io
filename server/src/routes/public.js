'use strict';
// Unauthenticated surface that is NOT the status page: health check and the
// public vendor-status grid. The status page moved to routes/status.js when it
// became a first-class row (schema v18) — it needs to answer at the ROOT of a
// customer's own domain, and this file owns `/` for the marketing site.
const express = require('express');
const { db, getOrgSetting, getSetting } = require('../db');
const { now, sha256, RateLimiter, clampInt } = require('../util');
const { clientIp } = require('../security');
const config = require('../config');

const router = express.Router();

router.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'opscat', ts: now() });
});

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
  const since = new Date(t - 45 * 86400000).toISOString().slice(0, 10);
  const byVendorDays = new Map();
  for (const d of db.prepare(`SELECT d.vendor_id, d.day, d.worst, d.down_seconds
      FROM vendor_days d JOIN vendors v ON v.id = d.vendor_id
      WHERE v.org_id = 1 AND d.day >= ? ORDER BY d.day`).all(since)) {
    if (!byVendorDays.has(d.vendor_id)) byVendorDays.set(d.vendor_id, []);
    byVendorDays.get(d.vendor_id).push(d);
  }
  const vendors = db.prepare(`SELECT v.id, v.slug, v.name, v.status, v.page_url, v.last_checked_at,
      (SELECT COUNT(*) FROM vendor_incidents i WHERE i.vendor_id = v.id AND i.resolved_at IS NULL) AS active
    FROM vendors v WHERE v.org_id = 1 AND v.enabled = 1
      AND v.slug NOT LIKE 'custom-%' ORDER BY v.name`).all()
    .map((v) => {
      const days = byVendorDays.get(v.id) || [];
      const totalDown = days.reduce((a, d) => a + d.down_seconds, 0);
      const totalSecs = Math.max(1, days.length) * 86400;
      return { slug: v.slug, name: v.name, status: v.status,
        activeIncidents: v.active, userReports60m: reports.get(v.slug) || 0,
        uptimePct: (100 - (totalDown / totalSecs) * 100).toFixed(2),
        days: days.map((d) => ({ day: d.day, worst: d.worst })),
        pageUrl: v.page_url, lastCheckedAt: v.last_checked_at };
    });
  const counts = {
    total: vendors.length,
    green: vendors.filter((v) => v.status === 'operational').length,
    warn: vendors.filter((v) => ['degraded', 'partial', 'maintenance'].includes(v.status)).length,
    red: vendors.filter((v) => v.status === 'major').length,
  };
  const disrupted = vendors.filter((v) => ['degraded', 'partial', 'major'].includes(v.status)).length;
  gridCache = { ts: t, data: { updatedAt: t, total: vendors.length, disrupted, counts, vendors } };
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

const GRID_FILTERS = {
  all: () => true,
  green: (v) => v.status === 'operational',
  warn: (v) => ['degraded', 'partial', 'maintenance'].includes(v.status),
  red: (v) => v.status === 'major',
};

function reportForm(v) {
  // the /vendor-grid/report route exists on every host; the handler redirects
  // back to the right page for the grid host vs the main domain
  return `<form method="post" action="/vendor-grid/report" class="rep">
    <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
    <input type="hidden" name="slug" value="${esc(v.slug)}">
    <button type="submit" title="Report: down for me too">${
      v.userReports60m ? `⚠ ${v.userReports60m}` : 'report'}</button>
  </form>`;
}

function heatStrip(days) {
  const pad = Math.max(0, 45 - days.length);
  const cells = Array.from({ length: pad }).map(() =>
    '<i title="no data yet — monitoring started recently" style="background:#21262d;opacity:.5"></i>').join('')
    + days.map((day) => `<i title="${esc(day.day)}: ${esc(day.worst)}" style="background:${
      day.worst === 'operational' ? 'rgba(63,185,80,.55)' : GRID_DOT[day.worst] || '#e3b341'}"></i>`).join('');
  return `<span class="strip">${cells}</span>`;
}

function renderVendorGrid(req, res) {
  if (!gridPublished()) return res.status(404).send('<h1>Not published</h1>');
  const d = gridData();
  const reported = req.query.reported === '1';
  const view = req.query.view === 'list' ? 'list' : 'grid';
  const filter = GRID_FILTERS[req.query.f] ? req.query.f : 'all';
  const shown = d.vendors.filter(GRID_FILTERS[filter]);
  const href = (f, v) => `?f=${f}&view=${v}`;
  const pills = [
    ['all', `all ${d.counts.total}`, '#8b949e'],
    ['green', `operational ${d.counts.green}`, '#3fb950'],
    ['warn', `degraded ${d.counts.warn}`, '#f0883e'],
    ['red', `down ${d.counts.red}`, '#f85149'],
  ].map(([f, label, color]) => `<a class="pill ${filter === f ? 'on' : ''}" style="--pc:${color}"
    href="${href(f, view)}">${label}</a>`).join('');
  const toggle = `<span class="views">${
    [['grid', 'Grid'], ['list', 'List']].map(([vw, label]) =>
      `<a class="${view === vw ? 'on' : ''}" href="${href(filter, vw)}">${label}</a>`).join('')}</span>`;

  const body = view === 'grid'
    ? `<div class="grid">${shown.map((v) => `<div class="v">
        <div class="vtop">
          <a class="vlink" href="${esc(v.pageUrl || '#')}" target="_blank" rel="noreferrer">
            <span class="dot" style="background:${GRID_DOT[v.status] || GRID_DOT.unknown}"></span>
            <span class="vn">${esc(v.name)}</span>
            <span class="vs" style="color:${GRID_DOT[v.status] || GRID_DOT.unknown}">${esc(v.status)}${
              v.activeIncidents ? ` · ${v.activeIncidents} inc` : ''}</span>
          </a>
          ${reportForm(v)}
        </div>
        ${heatStrip(v.days)}
      </div>`).join('')}</div>`
    : `<div class="list">${shown.map((v) => `<div class="lr">
        <a class="vlink" href="${esc(v.pageUrl || '#')}" target="_blank" rel="noreferrer">
          <span class="dot" style="background:${GRID_DOT[v.status] || GRID_DOT.unknown}"></span>
          <span class="vn">${esc(v.name)}</span>
        </a>
        ${heatStrip(v.days)}
        <span class="pct" title="uptime, last 45 days">${v.uptimePct}%</span>
        <span class="vs" style="color:${GRID_DOT[v.status] || GRID_DOT.unknown}">${esc(v.status)}</span>
        ${reportForm(v)}
      </div>`).join('')}</div>`;
  const rows = body;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpsCat Radar — live status of ${d.total} cloud services</title>
<meta name="description" content="Live status of ${d.total} cloud &amp; SaaS services, aggregated from their official status pages. Powered by OpsCat.">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png">
<style>
  body{margin:0;background:#0b0e14;color:#c9d1d9;font:14px/1.5 Inter,system-ui,sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:40px 20px}
  h1{font-size:20px;color:#f0f6fc;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .logo{width:26px;height:26px;border-radius:6px}
  .sub{font-size:13px;color:#8b949e;margin:6px 0 24px}
  .sub b{color:${d.disrupted ? '#f0883e' : '#3fb950'}}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
  .v{display:flex;flex-direction:column;gap:7px;padding:8px 10px;border:1px solid #21262d;border-radius:8px;
     background:#161b22}
  .v:hover{border-color:#30363d}
  .vtop{display:flex;align-items:center;gap:8px}
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
  .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .pill{font:600 11px Inter,system-ui,sans-serif;color:var(--pc);text-decoration:none;
     border:1px solid #30363d;border-radius:14px;padding:4px 12px;background:#161b22}
  .pill.on{border-color:var(--pc);background:color-mix(in srgb,var(--pc) 12%,transparent)}
  .views{margin-left:auto;display:flex;border:1px solid #30363d;border-radius:6px;overflow:hidden}
  .views a{font:600 11px Inter,system-ui,sans-serif;color:#8b949e;text-decoration:none;padding:4px 12px}
  .views a.on{background:#21262d;color:#f0f6fc}
  .list{display:flex;flex-direction:column;gap:6px}
  .lr{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid #21262d;
     border-radius:8px;background:#161b22}
  .lr .vlink{flex:0 0 190px;min-width:0}
  .lr .vs{margin-left:0;flex:0 0 90px;text-align:right}
  .strip{flex:1;display:flex;gap:2px;height:12px;min-width:120px}
  .lr .strip{height:16px}
  .strip i{flex:1;border-radius:1px}
  .pct{font-family:'JetBrains Mono',monospace;font-size:11px;color:#c9d1d9;flex:0 0 62px;text-align:right}
  @media (max-width:640px){.lr .vlink{flex-basis:110px}.lr .vs{display:none}}
  footer{margin-top:32px;font-size:11px;color:#484f58}
  footer a{color:#58a6ff;text-decoration:none}
</style></head><body><div class="wrap">
<h1><img class="logo" src="/brand/opscat-mark-dark-64.png" alt="OpsCat">OpsCat Radar</h1>
<div class="sub">Live status of <b>${d.total}</b> cloud &amp; SaaS services — ${
    d.disrupted ? `<b>${d.disrupted} with issues right now</b>` : '<b>all operational</b>'}.
  Aggregated from the vendors' official status pages, refreshed continuously.
  Something down that the vendor hasn't acknowledged yet? Hit “report”.</div>
${reported ? '<div class="thanks">Thanks — your report has been counted.</div>' : ''}
<div class="bar">${pills}${toggle}</div>
${rows}
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
