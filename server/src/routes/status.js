'use strict';
// The public status page: HTML, JSON, Atom, branding assets, anonymous problem
// reports and e-mail subscriptions — for EVERY page an org has.
//
// Split out of routes/public.js when the status page became a first-class row
// (schema v18). It is mounted BEFORE public.js because a page on its own domain
// answers at that host's ROOT, and public.js owns `/` for the marketing site.
//
// The page ships no JavaScript. Every interactive bit is a plain form POST, so
// the CSP stays strict and the page renders in anything.
const express = require('express');
const { db, getOrgSetting } = require('../db');
const { now, sha256, RateLimiter, escapeHtml: esc } = require('../util');
const { clientIp } = require('../security');
const config = require('../config');
const pages = require('../lib/status-pages');
const branding = require('../lib/status-branding');
const subscribers = require('../lib/subscribers');
const { RANK: STATUS_RANK } = require('../lib/status-scale');

const router = express.Router();

const STATUS_LABEL = {
  operational: 'All Systems Operational', maintenance: 'Scheduled Maintenance in Progress',
  degraded: 'Degraded Performance', partial: 'Partial Outage', major: 'Major Outage',
};
const DOT = { operational: '#3fb950', maintenance: '#bc8cff', degraded: '#e3b341',
  partial: '#f0883e', major: '#f85149' };

// ---- the payload -------------------------------------------------------------

function statusData(page) {
  const orgId = page.org_id;
  const only = pages.componentIdsFor(page); // null = every component of the org
  const onlySet = only ? new Set(only) : null;
  const comps = db.prepare('SELECT * FROM components WHERE org_id = ? ORDER BY sort, id').all(orgId)
    .filter((c) => !onlySet || onlySet.has(c.id));
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

  // An incident belongs on this page when it touches one of the page's
  // components — or when it names no component at all, which is how an org-wide
  // announcement is expressed and therefore belongs everywhere.
  const compsOfIncident = db.prepare('SELECT component_id FROM incident_components WHERE incident_id = ?');
  const incidents = db.prepare(`SELECT * FROM incidents WHERE org_id = ? AND published = 1
    ORDER BY started_at DESC LIMIT 25`).all(orgId)
    .filter((i) => {
      if (!onlySet) return true;
      const linked = compsOfIncident.all(i.id).map((r) => r.component_id);
      return linked.length === 0 || linked.some((id) => onlySet.has(id));
    })
    .slice(0, 10)
    .map((i) => ({
      id: i.id, label: `INC-${2000 + i.id}`, title: i.title, status: i.status,
      startedAt: i.started_at, resolvedAt: i.resolved_at,
      updates: db.prepare(`SELECT ts, status, message FROM incident_updates
        WHERE incident_id = ? ORDER BY ts DESC LIMIT 10`).all(i.id),
    }));

  const data = {
    overall: worst, overallLabel: STATUS_LABEL[worst], components, incidents,
    // `org` is the page's display name. The key keeps its old spelling because
    // it is the public JSON contract and the vendor detector reads it.
    org: page.name, page: { slug: page.slug, name: page.name, isDefault: page.is_default === 1 },
    ts: now(), reportsEnabled: reportsEnabled(orgId),
  };
  data.components.forEach((c, i) => { c.id = comps[i].id; });
  if (getOrgSetting(orgId, 'status_reports_public', '0') === '1') {
    data.reports60m = db.prepare(
      'SELECT COUNT(*) c FROM status_reports WHERE org_id = ? AND ts >= ?').get(orgId, now() - 3600000).c;
  }
  return data;
}

function reportsEnabled(orgId) { return getOrgSetting(orgId, 'status_reports_enabled', '1') === '1'; }

// A page is servable when it exists, is published, and — if private — the
// visitor brought the link secret. All three fail the same way: 404, never 403.
// A 403 would confirm that a private page with that slug exists.
function servable(req, page) {
  return !!page && pages.published(page) && pages.canView(req, page);
}

// ---- reports (Downdetector-style) --------------------------------------------

const reportLimiter = new RateLimiter({ perMinute: 3, burst: 3 });
const insReport = db.prepare(
  'INSERT INTO status_reports (org_id, ts, component_id, message, ip_hash) VALUES (?, ?, ?, ?, ?)');
const lastReportFrom = db.prepare(
  'SELECT MAX(ts) t FROM status_reports WHERE org_id = ? AND ip_hash = ?');

// Accepts the status-page form (urlencoded) or JSON. The `website` field is a
// honeypot — humans never see it, bots fill it. Success and silent drops both
// answer alike so probing reveals nothing.
function handleReport(req, res, page, redirectTo) {
  const done = () => (redirectTo
    ? res.redirect(303, `${redirectTo || '/status'}?reported=1`)
    : res.json({ ok: true }));
  if (!servable(req, page) || !reportsEnabled(page.org_id)) {
    return redirectTo !== null
      ? res.redirect(303, redirectTo || '/status')
      : res.status(404).json({ error: 'not published' });
  }
  const b = req.body || {};
  const ip = clientIp(req);
  if (typeof b.website === 'string' && b.website.trim() !== '') return done(); // honeypot hit
  if (!reportLimiter.allow(`${page.org_id}|${ip}`)) return done();
  const ipHash = sha256(`${page.org_id}|${ip}`);
  const t = now();
  const last = lastReportFrom.get(page.org_id, ipHash).t;
  if (last && t - last < 10 * 60 * 1000) return done(); // one report per visitor per 10 min
  let componentId = null;
  const cid = parseInt(b.componentId, 10);
  if (Number.isFinite(cid)) {
    const comp = db.prepare('SELECT id FROM components WHERE id = ? AND org_id = ?').get(cid, page.org_id);
    const only = pages.componentIdsFor(page);
    if (comp && (!only || only.includes(comp.id))) componentId = comp.id;
  }
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 500) : null;
  insReport.run(page.org_id, t, componentId, message || null, ipHash);
  return done();
}

// ---- subscriptions -----------------------------------------------------------

const subLimiter = new RateLimiter({ perMinute: 3, burst: 3 });

// Same posture as the report form: honeypot, rate limit, and a UNIFORM answer —
// new, pending, already-confirmed and silently-dropped all look identical, so
// the form cannot be used to probe an address book.
function handleSubscribe(req, res, page, redirectTo) {
  const done = () => (redirectTo !== null
    ? res.redirect(303, `${redirectTo || '/status'}?subscribed=1`)
    : res.json({ ok: true }));
  if (!servable(req, page) || !subscribers.available(page)) {
    return redirectTo !== null
      ? res.redirect(303, redirectTo || '/status')
      : res.status(404).json({ error: 'not available' });
  }
  const b = req.body || {};
  if (typeof b.website === 'string' && b.website.trim() !== '') return done(); // honeypot hit
  if (!subLimiter.allow(`${page.org_id}|${clientIp(req)}`)) return done();
  subscribers.subscribe(page, b.email);
  return done();
}

// ---- the confirm / unsubscribe mini pages ------------------------------------

// Rendered in the PAGE's own colours, not in a fixed dark theme. A visitor who
// clicks a confirmation link from a light, logo-bearing status page and lands on
// a black OpsCat box has left the brand mid-flow — which is exactly what a
// status page is bought to avoid. The page is resolved from the token, so both
// halves of the flow can find it.
function miniPage(res, page, title, body, backUrl) {
  const b = page ? branding.brandingFor(page, pages.absoluteUrl(page)) : null;
  const p = b ? b.palette : branding.THEMES.dark;
  const accent = b ? b.accent : branding.DEFAULT_ACCENT;
  const ink = b ? b.accentInk : '#ffffff';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="${b ? b.theme : 'dark'}">
${b && b.faviconUrl ? `<link rel="icon" type="${esc(b.faviconMime)}" href="${esc(b.faviconUrl)}">` : ''}
<style>body{margin:0;background:${p.bg};color:${p.text};font:14px/1.5 Inter,system-ui,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:60px 20px}
.card{padding:20px;border:1px solid ${p.borderStrong};border-radius:8px;background:${p.surface}}
h1{font-size:16px;color:${p.heading};margin:0 0 10px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.brand img{height:28px;max-width:200px;object-fit:contain}
.brand .sq{width:24px;height:24px;border-radius:6px;background:${accent}}
.brand span{color:${p.heading};font-weight:600}
a{color:${accent};text-decoration:none}
button{background:${accent};color:${ink};border:none;border-radius:6px;padding:9px 18px;
font:600 13px Inter,system-ui,sans-serif;cursor:pointer}</style></head>
<body><div class="wrap">
${page ? `<div class="brand">${b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="">`
    : '<span class="sq"></span>'}<span>${esc(page.name)}</span></div>` : ''}
<div class="card"><h1>${esc(title)}</h1>${body}${
  backUrl ? `<p><a href="${esc(backUrl)}">← Back to the status page</a></p>` : ''}</div>
</div></body></html>`);
}

// ---- Atom feed ---------------------------------------------------------------

function statusFeed(req, res, page) {
  if (!servable(req, page)) return res.status(404).send('not published');
  const d = statusData(page);
  const pageUrl = pages.absoluteUrl(page);
  const iso = (ts) => new Date(ts).toISOString();
  const latest = d.incidents.reduce((m, i) =>
    Math.max(m, ...i.updates.map((u) => u.ts)), d.incidents.length ? 0 : d.ts);
  const entries = d.incidents.map((i) => {
    const upd = Math.max(i.startedAt || 0, ...i.updates.map((u) => u.ts));
    const content = i.updates.map((u) =>
      `<p><strong>${esc(u.status)}</strong> — ${esc(u.message)} <em>(${iso(u.ts)})</em></p>`).join('');
    return `  <entry>
    <id>${esc(pageUrl)}#inc-${i.id}</id>
    <title>${esc(`${i.label} — ${i.title} [${i.status}]`)}</title>
    <link href="${esc(pageUrl)}"/>
    <updated>${iso(upd)}</updated>
    <content type="html">${esc(content)}</content>
  </entry>`;
  }).join('\n');
  res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(d.org)} Status</title>
  <id>${esc(pageUrl)}</id>
  <link href="${esc(pageUrl)}"/>
  <link rel="self" href="${esc(`${pageUrl}/feed.xml`)}"/>
  <updated>${iso(latest || d.ts)}</updated>
${entries}
</feed>`);
}

// ---- assets ------------------------------------------------------------------

// Served same-origin so the page needs no CSP img-src entry, and only for a
// SERVABLE page: an unpublished or private page must not leak its org's logo
// either. Content-Disposition + nosniff keep a direct hit on this URL an image,
// never a document the browser would try to execute.
function sendAsset(req, res, page, kind) {
  if (!servable(req, page)) return res.status(404).send('not found');
  const effective = kind === 'favicon' && !branding.assetMeta(page.id, 'favicon') ? 'logo' : kind;
  const a = branding.getAsset(page.id, effective);
  if (!a) return res.status(404).send('not found');
  const etag = `W/"${page.id}-${kind}-${a.updated_at}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${kind}"`);
  res.send(a.bytes);
}

// ---- the page ----------------------------------------------------------------

function renderStatus(req, res, page) {
  if (!servable(req, page)) {
    return res.status(404).send('<h1>Status page not published</h1>');
  }
  pages.rememberAccess(req, res, page);
  const d = statusData(page);
  const reported = req.query.reported === '1';
  const subscribed = req.query.subscribed === '1';
  const canSubscribe = subscribers.available(page);
  // Every URL on the page derives from the page's own prefix — '' on a custom
  // domain, '/status' or '/status/<slug>' otherwise. A visitor who arrived on
  // status.acme.com must never be linked back to opscat.io.
  const base = pages.basePath(req, page);
  // `.json` appended to the page's OWN url — /status.json, /status/acme.json —
  // and the origin-level /summary.json alias when the page owns the whole host.
  const jsonUrl = base ? `${base}.json` : '/summary.json';
  const b = branding.brandingFor(page, base);
  const p = b.palette;
  const compRows = d.components.map((c) => {
    // An "up" day is deliberately the faintest thing on the page so outages
    // stand out; on the light theme that needs a darker green at lower alpha,
    // hence the palette variable rather than one literal for both themes.
    const cells = c.days.map((day) =>
      `<div title="${esc(day.day)}: ${esc(day.worst)}" style="flex:1;height:18px;border-radius:1px;background:${
        day.worst === 'operational' ? p.okStrip : DOT[day.worst] || '#e3b341'}"></div>`
    ).join('');
    return `<div class="comp">
      <div class="comp-head">
        <span class="dot" style="background:${DOT[c.status]};box-shadow:0 0 6px ${DOT[c.status]}"></span>
        <span class="name">${esc(c.name)}</span>
        <span class="grp">${esc(c.group)}</span>
        <span class="pct">${c.uptimePct}%</span>
      </div>
      <div class="strip">${cells || '<div class="hint">collecting data…</div>'}</div>
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
  // A private page is for the people who were given the link, not for a search
  // index. Both headers, because a crawler that never renders still reads one.
  if (page.visibility === 'private') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.org)} Status</title>
<meta name="color-scheme" content="${b.theme}">
${page.visibility === 'private' ? '<meta name="robots" content="noindex, nofollow">' : ''}
${b.faviconUrl ? `<link rel="icon" type="${esc(b.faviconMime)}" href="${esc(b.faviconUrl)}">` : ''}
<link rel="alternate" type="application/atom+xml" title="${esc(d.org)} status feed" href="${esc(`${base}/feed.xml`)}">
<style>
  :root{--bg:${p.bg};--surface:${p.surface};--border:${p.border};--border-strong:${p.borderStrong};
    --text:${p.text};--heading:${p.heading};--muted:${p.muted};--faint:${p.faint};
    --field:${p.field};--ok-strip:${p.okStrip};--accent:${b.accent};--accent-dark:${b.accentDark};
    --accent-ink:${b.accentInk}}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:40px 20px}
  h1{font-size:18px;color:var(--heading);display:flex;align-items:center;gap:10px;margin:0}
  .logo{width:26px;height:26px;border-radius:6px;
    background:linear-gradient(135deg,var(--accent),var(--accent-dark))}
  img.logo{width:auto;height:32px;max-width:220px;max-height:32px;border-radius:0;background:none;object-fit:contain}
  .tagline{color:var(--muted);font-size:13px;margin:10px 0 0}
  .banner{display:flex;align-items:center;gap:10px;padding:16px;border:1px solid var(--border-strong);
    border-radius:8px;background:var(--surface);margin:24px 0;font-weight:600;color:var(--heading)}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
  .comp{padding:12px 16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-bottom:10px}
  .comp-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .name{font-weight:600;color:var(--heading)}
  .grp{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted)}
  .pct{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted)}
  .strip{display:flex;gap:2px}
  h2{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:32px}
  .inc{padding:12px 16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-bottom:10px}
  .inc-head{font-weight:600;color:var(--heading);margin-bottom:6px}
  .mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted)}
  .upd{font-size:12px;color:var(--muted);padding:2px 0}
  .pill{font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:6px}
  .pill.ok{background:rgba(63,185,80,.12);color:#3fb950}
  .pill.warn{background:rgba(227,179,65,.12);color:#e3b341}
  footer{margin-top:40px;font-size:11px;color:var(--faint)}
  footer a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)}
  footer a:hover{color:var(--text);border-bottom-color:var(--border-strong)}
  details.report{margin-top:24px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
  details.report summary{cursor:pointer;padding:12px 16px;font-weight:600;color:var(--text);font-size:13px}
  .report-form{padding:0 16px 14px;display:flex;flex-direction:column;gap:8px}
  .report-form input,.report-form select,.report-form textarea{background:var(--field);color:var(--text);
    border:1px solid var(--border-strong);border-radius:6px;padding:8px 10px;font:12px Inter,system-ui,sans-serif;
    max-width:100%;box-sizing:border-box}
  .report-form textarea{min-height:64px;resize:vertical}
  .report-form button{align-self:flex-start;background:var(--accent);color:var(--accent-ink);border:none;
    border-radius:6px;padding:8px 16px;font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  .hint{font-size:11px;color:var(--muted)}
  .hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
  .thanks{padding:12px 16px;border:1px solid rgba(63,185,80,.35);border-radius:8px;
    background:rgba(63,185,80,.08);color:#3fb950;font-size:13px;font-weight:600;margin-top:24px}
  .rcount{margin-left:auto;font-size:11px;font-weight:500;color:var(--muted)}
${b.customCss ? `\n/* custom CSS (plan: status_css) */\n${b.customCss}\n` : ''}
</style></head><body><div class="wrap">
<h1>${b.logoUrl
    ? `<img class="logo" src="${esc(b.logoUrl)}" alt="${esc(d.org)}">`
    : '<span class="logo"></span>'}${esc(d.org)} Status</h1>
${b.description ? `<p class="tagline">${esc(b.description)}</p>` : ''}
<div class="banner"><span class="dot" style="background:${DOT[d.overall]};box-shadow:0 0 8px ${DOT[d.overall]}"></span>
${esc(d.overallLabel)}${Number.isFinite(d.reports60m) ? `<span class="rcount">${d.reports60m} user report${d.reports60m === 1 ? '' : 's'} in the last hour</span>` : ''}</div>
${compRows}
${incRows ? `<h2>Incidents</h2>${incRows}` : ''}
${reported ? '<div class="thanks">Thanks — your report has been recorded and our team can see it.</div>' : ''}
${subscribed ? '<div class="thanks">Almost done — check your inbox and click the confirmation link.</div>' : ''}
${canSubscribe && !subscribed ? `<details class="report"><summary>Get status updates by e-mail</summary>
<form class="report-form" method="post" action="${esc(`${base}/subscribe`)}">
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="email" name="email" required maxlength="200" placeholder="you@example.com">
<button type="submit">Subscribe</button>
<span class="hint">Double-opt-in — we send a confirmation link first. Unsubscribe in every mail.</span>
</form></details>` : ''}
${d.reportsEnabled && !reported ? `<details class="report"><summary>Something not working for you? Report a problem</summary>
<form class="report-form" method="post" action="${esc(`${base}/report`)}">
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<select name="componentId"><option value="">Affected service (optional)</option>
${d.components.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
<textarea name="message" maxlength="500" placeholder="What are you seeing? (optional)"></textarea>
<button type="submit">Send report</button>
</form></details>` : ''}
<footer>${b.hidePowered ? '' : 'Powered by OpsCat · '}Machine-readable: <a href="${esc(jsonUrl)}">${esc(jsonUrl)}</a> ·
<a href="${esc(`${base}/feed.xml`)}">Atom feed</a>${
  b.supportUrl ? ` · <a href="${esc(b.supportUrl)}" rel="noopener">Support</a>` : ''}${
  b.legalUrl ? ` · <a href="${esc(b.legalUrl)}" rel="noopener">Legal</a>` : ''} ·
${new Date(d.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC</footer>
</div></body></html>`);
}

// Machine-readable status: the SAME payload the HTML page renders, reachable by
// appending `.json` to the page's own URL (or `/summary.json` beside it).
// Consumers should never have to translate a page URL into a different endpoint
// with a slug parameter. `/summary.json` is the Instatus-shaped alias OpsCat's
// own vendor detector probes for (engine/vendor-feeds.js), so an OpsCat status
// page is auto-detectable by OpsCat and by anything following that convention.
function statusJson(req, res, page) {
  if (!servable(req, page)) return res.status(404).json({ error: 'not published' });
  res.json(statusData(page));
}

// ---- token-addressed flows (confirm / unsubscribe) ---------------------------

function pageOfResult(r) {
  return r && r.pageId ? pages.pageById(r.pageId) : null;
}

function handleConfirm(req, res) {
  const r = subscribers.confirm(req.query.token);
  if (!r) {
    return miniPage(res, subscribers.pageForToken(req.query.token), 'Link invalid or expired',
      '<p>This confirmation link is no longer valid. You can simply subscribe again on the status page.</p>');
  }
  const page = pageOfResult(r);
  miniPage(res, page, 'Subscription confirmed',
    '<p>You will now receive an e-mail whenever a published incident changes. Every mail carries an unsubscribe link.</p>',
    page ? pages.absoluteUrl(page) : null);
}

// Two-step on purpose: mail scanners GET every link, and a one-request GET
// unsubscribe would let a corporate link-checker silently remove its users.
function handleUnsubscribeForm(req, res) {
  const q = req.query;
  const page = q.token ? subscribers.pageForToken(q.token) : subscribers.pageForRowId(q.id);
  const fields = q.token
    ? `<input type="hidden" name="token" value="${esc(q.token)}">`
    : `<input type="hidden" name="id" value="${esc(q.id || '')}"><input type="hidden" name="sig" value="${esc(q.sig || '')}">`;
  miniPage(res, page, 'Unsubscribe from status updates',
    `<form method="post" action="/status/unsubscribe">${fields}
<p>No further status mails will be sent to your address.</p>
<button type="submit">Unsubscribe</button></form>`);
}

function handleUnsubscribe(req, res) {
  const b = req.body || {};
  const r = b.token ? subscribers.unsubscribe(b.token) : subscribers.unsubscribeById(b.id, b.sig);
  if (!r) return miniPage(res, null, 'Link invalid', '<p>This unsubscribe link is no longer valid.</p>');
  const page = pageOfResult(r);
  miniPage(res, page, 'Unsubscribed', '<p>Done — no further status mails will be sent.</p>',
    page ? pages.absoluteUrl(page) : null);
}

// ---- routes on a page's OWN domain -------------------------------------------
//
// A verified custom domain serves the page at that host's ROOT. These are
// mounted first and only fire when the Host resolves to a page, so opscat.io
// itself is untouched and public.js keeps `/` for the marketing site.
const domainRoutes = express.Router();
domainRoutes.get('/', (req, res) => renderStatus(req, res, req.statusPage));
domainRoutes.get(['/summary.json', '/status.json'], (req, res) => statusJson(req, res, req.statusPage));
domainRoutes.get('/feed.xml', (req, res) => statusFeed(req, res, req.statusPage));
domainRoutes.get('/logo', (req, res) => sendAsset(req, res, req.statusPage, 'logo'));
domainRoutes.get('/favicon', (req, res) => sendAsset(req, res, req.statusPage, 'favicon'));
domainRoutes.get('/favicon.ico', (req, res) => sendAsset(req, res, req.statusPage, 'favicon'));
domainRoutes.post('/report', (req, res) => handleReport(req, res, req.statusPage, '/'));
domainRoutes.post('/subscribe', (req, res) => handleSubscribe(req, res, req.statusPage, '/'));
domainRoutes.get('/confirm', handleConfirm);
domainRoutes.get('/unsubscribe', handleUnsubscribeForm);
domainRoutes.post('/unsubscribe', handleUnsubscribe);

router.use((req, res, next) => {
  const page = pages.pageByDomain(req.hostname || req.headers.host);
  if (!page) return next();
  req.statusPage = page;
  return domainRoutes(req, res, next);
});

// ---- the dedicated status host (status.<domain>/<slug>) -----------------------
//
// Same sub-router as a custom domain, one segment deeper: every page is addressed
// by slug here, the default one included. `/status/<slug>` on the app host keeps
// working — a status page URL is the kind of thing that ends up in a runbook, and
// retiring one to gain a nicer name is not a trade worth making.
if (config.statusHost) {
  router.use('/:slug', (req, res, next) => {
    if (!pages.onStatusHost(req)) return next();
    const page = pages.pageBySlug(req.params.slug);
    if (!page) return next();
    req.statusPage = page;
    return domainRoutes(req, res, next);
  });
  // A bare root on the status host has no page to name, so send it to the origin
  // org's default rather than 404 — that is the one page the host itself implies.
  router.get('/', (req, res, next) => {
    if (!pages.onStatusHost(req)) return next();
    const page = pages.resolvePage(req, null);
    if (!page) return next();
    return res.redirect(302, `/${encodeURIComponent(page.slug)}`);
  });
  // Everything else on this host is NOT a status page, and the status host serves
  // status pages. Falling through was the first shape and it put the whole
  // application on status.opscat.io/app — same code, same auth, and the session
  // cookie is host-only so it was a login screen rather than a leak, but a public
  // status hostname that also answers for the admin console is a surface nobody
  // asked for and a support question waiting to happen. Verified on the deployed
  // host before this existed: /app answered 200.
  router.use((req, res, next) => {
    if (!pages.onStatusHost(req)) return next();
    res.status(404).type('text/plain').send('not found');
  });
}

// ---- Caddy on-demand TLS ------------------------------------------------------
//
// Caddy asks this before issuing a certificate for a hostname it has never seen.
// Answering 200 for anything would turn the deployment into an open certificate
// mint (and burn the ACME rate limit), so it answers ONLY for a domain that is
// stored, DNS-verified, and on a plan that includes custom domains.
router.get('/api/public/tls-check', (req, res) => {
  const page = pages.pageByDomain(req.query.domain);
  if (!page) return res.status(404).send('unknown domain');
  res.status(200).send('ok');
});

// ---- routes under /status ----------------------------------------------------
// Order matters: the fixed segments must be registered before `/status/:slug`,
// which would otherwise swallow "confirm", "logo" and friends as slugs.

router.get('/api/status', (req, res) => {
  const page = req.query.org ? pages.pageBySlug(req.query.org) : pages.resolvePage(req, null);
  statusJson(req, res, page);
});
router.post('/api/status/report', (req, res) =>
  handleReport(req, res, req.query.org ? pages.pageBySlug(req.query.org) : pages.resolvePage(req, null), null));
router.post('/api/status/subscribe', (req, res) =>
  handleSubscribe(req, res, req.query.org ? pages.pageBySlug(req.query.org) : pages.resolvePage(req, null), null));

router.get('/status/confirm', handleConfirm);
router.get('/status/unsubscribe', handleUnsubscribeForm);
router.post('/status/unsubscribe', handleUnsubscribe);

router.get(['/status.json', '/summary.json'], (req, res) => statusJson(req, res, pages.resolvePage(req, null)));
router.get('/status/:slug.json', (req, res) => statusJson(req, res, pages.pageBySlug(req.params.slug)));
router.get('/status/feed.xml', (req, res) => statusFeed(req, res, pages.resolvePage(req, null)));
router.get('/status/logo', (req, res) => sendAsset(req, res, pages.resolvePage(req, null), 'logo'));
router.get('/status/favicon', (req, res) => sendAsset(req, res, pages.resolvePage(req, null), 'favicon'));
router.post('/status/report', (req, res) => handleReport(req, res, pages.resolvePage(req, null), '/status'));
router.post('/status/subscribe', (req, res) => handleSubscribe(req, res, pages.resolvePage(req, null), '/status'));

const slugPath = (req) => `/status/${encodeURIComponent(req.params.slug)}`;
router.get('/status/:slug/feed.xml', (req, res) => statusFeed(req, res, pages.pageBySlug(req.params.slug)));
router.get('/status/:slug/logo', (req, res) => sendAsset(req, res, pages.pageBySlug(req.params.slug), 'logo'));
router.get('/status/:slug/favicon', (req, res) => sendAsset(req, res, pages.pageBySlug(req.params.slug), 'favicon'));
router.post('/status/:slug/report', (req, res) =>
  handleReport(req, res, pages.pageBySlug(req.params.slug), slugPath(req)));
router.post('/status/:slug/subscribe', (req, res) =>
  handleSubscribe(req, res, pages.pageBySlug(req.params.slug), slugPath(req)));

router.get('/status', (req, res) => renderStatus(req, res, pages.resolvePage(req, null)));
router.get('/status/:slug', (req, res) => renderStatus(req, res, pages.pageBySlug(req.params.slug)));

module.exports = router;
module.exports.statusData = statusData;
