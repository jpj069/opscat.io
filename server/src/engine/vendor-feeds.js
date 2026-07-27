'use strict';
// Vendor status-feed adapters: fetch a third-party status page feed and
// normalize it to { status, components[], incidents[] }. Statuses share the
// components-table vocabulary (operational|degraded|partial|major|maintenance)
// plus 'unknown'. Adapters return only *active* incidents — the poller marks
// stored incidents resolved once they disappear from the feed.
const { assertPublicHost } = require('./synthetics');

const FEED_TYPES = ['statuspage', 'instatus', 'slack', 'gcp', 'aws', 'heroku', 'statusio', 'rss'];

const FETCH_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // statuspage summaries can be large (per-PoP components)
const MAX_REDIRECTS = 3;

// ---- fetch -------------------------------------------------------------------

// Some feeds (AWS public currentevents) are served UTF-16 with a BOM.
function decodeBody(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  }
  return buf.toString('utf8');
}

// Fetch with SSRF guard on every hop; redirects are followed manually so a 3xx
// into private address space is refused just like the initial URL.
async function fetchFeed(feedType, feedUrl, cache = {}) {
  let url = feedUrl;
  for (let hop = 0; ; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('feed url must be https');
    await assertPublicHost(parsed.hostname.replace(/^\[|\]$/g, ''));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      const headers = { 'User-Agent': 'OpsCat-VendorMonitor/1.0', Accept: 'application/json, application/xml, text/xml, */*' };
      if (cache.etag) headers['If-None-Match'] = cache.etag;
      if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
      resp = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers });
      // 304 first — it sits inside the 3xx range but is a cache hit, not a redirect
      if (resp.status === 304) {
        await resp.arrayBuffer().catch(() => {});
        return { notModified: true };
      }
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        await resp.arrayBuffer().catch(() => {});
        if (!loc || hop >= MAX_REDIRECTS) throw new Error(`too many redirects (${resp.status})`);
        url = new URL(loc, url).href;
        continue;
      }
      if (resp.status !== 200) {
        await resp.arrayBuffer().catch(() => {});
        throw new Error(`feed returned HTTP ${resp.status}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_BODY_BYTES) throw new Error('feed body too large');
      const body = decodeBody(buf);
      return {
        parsed: parse(feedType, body),
        etag: resp.headers.get('etag') || null,
        lastModified: resp.headers.get('last-modified') || null,
      };
    } finally { clearTimeout(timer); }
  }
}

// ---- normalization helpers ---------------------------------------------------

const IMPACT_RANK = { unknown: 1, maintenance: 1, minor: 2, degraded: 2, partial: 3, major: 4, critical: 5 };
const IMPACT_STATUS = { minor: 'degraded', degraded: 'degraded', partial: 'partial', major: 'major', critical: 'major', maintenance: 'maintenance' };

function worstImpact(incidents) {
  let worst = null;
  for (const i of incidents) {
    if (!worst || (IMPACT_RANK[i.impact] || 0) > (IMPACT_RANK[worst] || 0)) worst = i.impact;
  }
  return worst;
}

const ms = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const STATUS_RANK = { unknown: 0, operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };

function worstStatus(components) {
  let worst = 'operational';
  for (const c of components) {
    if ((STATUS_RANK[c.status] || 0) > STATUS_RANK[worst]) worst = c.status;
  }
  return worst;
}

// ---- adapters ----------------------------------------------------------------

// Atlassian Statuspage: /api/v2/summary.json
const SP_INDICATOR = { none: 'operational', minor: 'degraded', major: 'partial', critical: 'major', maintenance: 'maintenance' };
const SP_COMPONENT = { operational: 'operational', degraded_performance: 'degraded', partial_outage: 'partial', major_outage: 'major', under_maintenance: 'maintenance' };
const SP_IMPACT = { none: 'minor', minor: 'minor', major: 'major', critical: 'critical', maintenance: 'maintenance' };

function parseStatuspage(body) {
  const j = JSON.parse(body);
  if (!j.status || typeof j.status.indicator !== 'string') throw new Error('not a statuspage summary');
  const components = (j.components || [])
    .filter((c) => c && c.name && !c.group)
    .map((c) => ({ name: String(c.name).slice(0, 120), status: SP_COMPONENT[c.status] || 'unknown' }));
  const incidents = (j.incidents || []).map((i) => ({
    remoteId: String(i.id),
    title: String(i.name || 'incident').slice(0, 300),
    status: String(i.status || 'investigating').slice(0, 40),
    impact: SP_IMPACT[i.impact] || 'unknown',
    url: i.shortlink || null,
    startedAt: ms(i.started_at || i.created_at),
    updatedAt: ms(i.updated_at),
  }));
  for (const m of j.scheduled_maintenances || []) {
    if (m.status !== 'in_progress' && m.status !== 'verifying') continue;
    incidents.push({
      remoteId: String(m.id), title: String(m.name || 'maintenance').slice(0, 300),
      status: 'maintenance', impact: 'maintenance', url: m.shortlink || null,
      startedAt: ms(m.started_at || m.created_at), updatedAt: ms(m.updated_at),
    });
  }
  return { status: SP_INDICATOR[j.status.indicator] || 'unknown', components, incidents };
}

// Instatus: /summary.json
const IN_IMPACT = { MAJOROUTAGE: 'major', PARTIALOUTAGE: 'partial', DEGRADEDPERFORMANCE: 'degraded', OPERATIONAL: 'minor' };

function parseInstatus(body) {
  const j = JSON.parse(body);
  if (!j.page || typeof j.page.status !== 'string') throw new Error('not an instatus summary');
  const incidents = (j.activeIncidents || []).map((i) => ({
    remoteId: String(i.id),
    title: String(i.name || 'incident').slice(0, 300),
    status: String(i.status || 'INVESTIGATING').toLowerCase().slice(0, 40),
    impact: IN_IMPACT[i.impact] || 'unknown',
    url: i.url || null,
    startedAt: ms(i.started), updatedAt: ms(i.updated) || ms(i.started),
  }));
  for (const m of j.activeMaintenances || []) {
    incidents.push({
      remoteId: String(m.id), title: String(m.name || 'maintenance').slice(0, 300),
      status: 'maintenance', impact: 'maintenance', url: m.url || null,
      startedAt: ms(m.start), updatedAt: ms(m.updated) || ms(m.start),
    });
  }
  let status = 'unknown';
  if (j.page.status === 'UP') status = 'operational';
  else if (j.page.status === 'UNDERMAINTENANCE') status = 'maintenance';
  else if (j.page.status === 'HASISSUES') status = IMPACT_STATUS[worstImpact(incidents)] || 'degraded';
  return { status, components: [], incidents };
}

// Slack: /api/v2.0.0/current
const SLACK_IMPACT = { outage: 'major', incident: 'partial', notice: 'minor' };

function parseSlack(body) {
  const j = JSON.parse(body);
  if (typeof j.status !== 'string' || !Array.isArray(j.active_incidents)) throw new Error('not a slack status feed');
  const incidents = j.active_incidents.map((i) => ({
    remoteId: String(i.id),
    title: String(i.title || 'incident').slice(0, 300),
    status: String(i.status || 'active').slice(0, 40),
    impact: SLACK_IMPACT[i.type] || 'unknown',
    url: i.url || null,
    startedAt: ms(i.date_created), updatedAt: ms(i.date_updated) || ms(i.date_created),
  }));
  const status = j.status === 'ok' ? 'operational' : IMPACT_STATUS[worstImpact(incidents)] || 'degraded';
  return { status, components: [], incidents };
}

// Google status dashboards (Cloud + Workspace): /incidents.json
const GCP_IMPACT = { SERVICE_OUTAGE: 'major', SERVICE_DISRUPTION: 'partial', SERVICE_INFORMATION: 'minor' };

function parseGcp(body) {
  const j = JSON.parse(body);
  if (!Array.isArray(j)) throw new Error('not a google incidents feed');
  const incidents = j
    .filter((i) => i && i.begin && !i.end)
    .map((i) => ({
      remoteId: String(i.id),
      title: String(i.external_desc || 'incident').replace(/\s+/g, ' ').slice(0, 300),
      status: String((i.most_recent_update && i.most_recent_update.status) || 'active').toLowerCase().slice(0, 40),
      impact: GCP_IMPACT[i.status_impact] || 'unknown',
      url: i.uri ? `https://status.cloud.google.com${i.uri}` : null,
      startedAt: ms(i.begin), updatedAt: ms(i.modified) || ms(i.begin),
    }));
  const status = incidents.length === 0 ? 'operational' : IMPACT_STATUS[worstImpact(incidents)] || 'degraded';
  return { status, components: [], incidents };
}

// AWS public health feed: /public/currentevents (UTF-16 BOM handled upstream).
// Top-level status: "1" informational, "2" degradation, "3" disruption.
const AWS_IMPACT = { 1: 'minor', 2: 'partial', 3: 'major' };

function parseAws(body) {
  const j = JSON.parse(body);
  if (!Array.isArray(j)) throw new Error('not an aws currentevents feed');
  const incidents = j.map((e) => {
    const firstLog = Array.isArray(e.event_log) && e.event_log.length ? e.event_log[e.event_log.length - 1] : null;
    const lastLog = Array.isArray(e.event_log) && e.event_log.length ? e.event_log[0] : null;
    const started = (firstLog && firstLog.timestamp) || parseInt(e.date, 10);
    const updated = (lastLog && lastLog.timestamp) || started;
    return {
      remoteId: String(e.arn || `${e.service}-${e.date}`),
      title: `${e.service_name || e.service || 'AWS'}${e.region_name ? ` (${e.region_name})` : ''}: ${e.summary || 'event'}`.slice(0, 300),
      status: 'active',
      impact: AWS_IMPACT[parseInt(e.status, 10)] || 'unknown',
      url: 'https://health.aws.amazon.com/health/status',
      startedAt: Number.isFinite(started) ? started * 1000 : null,
      updatedAt: Number.isFinite(updated) ? updated * 1000 : null,
    };
  });
  const status = incidents.length === 0 ? 'operational' : IMPACT_STATUS[worstImpact(incidents)] || 'degraded';
  return { status, components: [], incidents };
}

// Heroku: /api/v4/current-status — systems are green/yellow/red/blue.
const HEROKU_SYSTEM = { green: 'operational', yellow: 'degraded', red: 'major', blue: 'maintenance' };

function parseHeroku(body) {
  const j = JSON.parse(body);
  if (!Array.isArray(j.status) || !j.status.every((s) => s && s.system)) throw new Error('not a heroku status feed');
  const components = j.status.map((s) => ({
    name: String(s.system).slice(0, 120), status: HEROKU_SYSTEM[s.status] || 'unknown',
  }));
  const incidents = (j.incidents || []).filter((i) => !i.resolved).map((i) => ({
    remoteId: String(i.id),
    title: String(i.title || 'incident').slice(0, 300),
    status: String(i.state || 'investigating').slice(0, 40),
    impact: 'unknown',
    url: i.full_url || null,
    startedAt: ms(i.created_at), updatedAt: ms(i.updated_at) || ms(i.created_at),
  }));
  return { status: worstStatus(components), components, incidents };
}

// status.io public API: https://api.status.io/1.0/status/<pageId>
const STATUSIO_CODE = { 100: 'operational', 200: 'maintenance', 300: 'degraded', 400: 'partial', 500: 'major', 600: 'major' };

function parseStatusio(body) {
  const j = JSON.parse(body);
  const r = j.result;
  if (!r || !r.status_overall || !Number.isFinite(r.status_overall.status_code)) {
    throw new Error('not a status.io feed');
  }
  const components = (r.status || [])
    .filter((c) => c && c.name)
    .map((c) => ({ name: String(c.name).slice(0, 120), status: STATUSIO_CODE[c.status_code] || 'unknown' }));
  const incidents = (r.incidents || []).map((i) => ({
    remoteId: String(i._id || i.id || i.name || 'incident').slice(0, 300),
    title: String(i.name || i.title || 'incident').slice(0, 300),
    status: String(i.current_status || i.status || 'active').toLowerCase().slice(0, 40),
    impact: 'unknown',
    url: i.shortlink || null,
    startedAt: ms(i.datetime_open), updatedAt: ms(i.datetime_updated) || ms(i.datetime_open),
  }));
  return { status: STATUSIO_CODE[r.status_overall.status_code] || 'unknown', components, incidents };
}

// Generic RSS/Atom fallback — no dependency, regex extraction. Feed items carry
// no machine-readable resolution state, so: items newer than 24h whose title
// does not read as resolved count as active incidents.
const RSS_RESOLVED_RE = /resolved|completed|restored|behoben|abgeschlossen/i;
const RSS_ACTIVE_WINDOW_MS = 24 * 3600 * 1000;

function xmlText(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').trim();
}

function parseRss(body) {
  if (!/<(rss|feed)[\s>]/i.test(body)) throw new Error('not an rss/atom feed');
  const incidents = [];
  const blocks = body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks.slice(0, 30)) {
    const title = xmlText(block, 'title') || 'incident';
    const guid = xmlText(block, 'guid') || xmlText(block, 'id');
    const linkTag = /<link[^>]*href="([^"]+)"/i.exec(block);
    const link = (linkTag && linkTag[1]) || xmlText(block, 'link');
    const dateStr = xmlText(block, 'pubDate') || xmlText(block, 'updated') || xmlText(block, 'published');
    const ts = dateStr ? ms(dateStr) : null;
    if (!ts || Date.now() - ts > RSS_ACTIVE_WINDOW_MS) continue;
    if (RSS_RESOLVED_RE.test(title)) continue;
    incidents.push({
      remoteId: String(guid || link || title).slice(0, 300),
      title: title.slice(0, 300), status: 'active', impact: 'unknown',
      url: link || null, startedAt: ts, updatedAt: ts,
    });
  }
  return { status: incidents.length === 0 ? 'operational' : 'degraded', components: [], incidents };
}

const PARSERS = { statuspage: parseStatuspage, instatus: parseInstatus, slack: parseSlack, gcp: parseGcp, aws: parseAws, heroku: parseHeroku, statusio: parseStatusio, rss: parseRss };

function parse(feedType, body) {
  const parser = PARSERS[feedType];
  if (!parser) throw new Error(`unknown feed type ${feedType}`);
  return parser(body);
}

// ---- auto-detection -----------------------------------------------------------
// Given any status-page URL, find the machine-readable feed behind it: fetch the
// page (following redirects, SSRF-guarded per hop) to learn the canonical host,
// then probe the known feed endpoints in order of likelihood. Used by
// POST /api/vendors/detect and by catalog-discovery tooling.

async function fetchRaw(rawUrl, accept = '*/*') {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('url must be https');
    await assertPublicHost(parsed.hostname.replace(/^\[|\]$/g, ''));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, redirect: 'manual',
        headers: { 'User-Agent': 'OpsCat-VendorMonitor/1.0', Accept: accept } });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        await resp.arrayBuffer().catch(() => {});
        if (!loc || hop >= MAX_REDIRECTS) throw new Error(`too many redirects (${resp.status})`);
        url = new URL(loc, url).href;
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_BODY_BYTES) throw new Error('body too large');
      return { finalUrl: url, status: resp.status, body: decodeBody(buf) };
    } finally { clearTimeout(timer); }
  }
}

function pageName(feedType, body) {
  try {
    const j = JSON.parse(body);
    if (feedType === 'statuspage' && j.page && j.page.name) return String(j.page.name).slice(0, 120);
    if (feedType === 'instatus' && j.page && j.page.name) return String(j.page.name).slice(0, 120);
    if (feedType === 'statusio' && j.result && j.result.status_overall && j.result.status_overall.name) {
      return String(j.result.status_overall.name).slice(0, 120);
    }
  } catch { /* not json */ }
  return null;
}

async function detectFeed(pageUrl) {
  const url = /^https?:\/\//.test(pageUrl) ? pageUrl : `https://${pageUrl}`;
  const page = await fetchRaw(url, 'text/html, */*');
  const origin = new URL(page.finalUrl).origin;

  // probe the known JSON endpoints on the canonical origin, most common first
  const PROBES = [
    ['statuspage', `${origin}/api/v2/summary.json`],   // Atlassian Statuspage + incident.io shim
    ['instatus', `${origin}/summary.json`],
    ['heroku', `${origin}/api/v4/current-status`],
    ['slack', `${origin}/api/v2.0.0/current`],
    ['gcp', `${origin}/incidents.json`],
  ];
  for (const [feedType, feedUrl] of PROBES) {
    try {
      const r = await fetchRaw(feedUrl, 'application/json, */*');
      if (r.status !== 200) continue;
      const parsed = parse(feedType, r.body);
      return { feedType, feedUrl, pageUrl: origin, name: pageName(feedType, r.body), parsed };
    } catch { /* try next */ }
  }

  // status.io pages embed a 24-hex page id and load assets from status.io
  if (page.status === 200 && /status\.io/i.test(page.body)) {
    const id = /[a-f0-9]{24}/.exec(page.body);
    if (id) {
      try {
        const feedUrl = `https://api.status.io/1.0/status/${id[0]}`;
        const r = await fetchRaw(feedUrl, 'application/json');
        const parsed = parse('statusio', r.body);
        return { feedType: 'statusio', feedUrl, pageUrl: origin, name: pageName('statusio', r.body), parsed };
      } catch { /* fall through */ }
    }
  }

  // RSS/Atom fallback: <link rel="alternate"> from the page, then /history.rss
  const candidates = [];
  if (page.status === 200) {
    const link = /<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]*href="([^"]+)"/i.exec(page.body)
      || /<link[^>]*href="([^"]+)"[^>]+type="application\/(?:rss|atom)\+xml"/i.exec(page.body);
    if (link) candidates.push(new URL(link[1], page.finalUrl).href);
  }
  candidates.push(`${origin}/history.rss`);
  for (const feedUrl of candidates) {
    try {
      const r = await fetchRaw(feedUrl, 'application/xml, text/xml, */*');
      if (r.status !== 200) continue;
      const parsed = parse('rss', r.body);
      return { feedType: 'rss', feedUrl, pageUrl: origin, name: null, parsed };
    } catch { /* try next */ }
  }

  throw new Error('no supported status feed found on this page (Statuspage, Instatus, incident.io, status.io, Heroku, Google or RSS)');
}

module.exports = { FEED_TYPES, fetchFeed, parse, detectFeed };
