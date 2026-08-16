'use strict';
// Status pages: resolution, access and the plan gates around them.
//
// A page is addressable three ways, in this order of specificity:
//   1. its own verified domain      status.acme.com          (plan: status_domain)
//   2. its slug                     /status/<slug>
//   3. the origin default           /status                  (org 1's default page)
// The default page of an org carries that ORG's slug, which is what keeps every
// pre-v18 URL working after the page became a row of its own.
//
// Three plan gates live here rather than at the call sites, because all three
// have to behave the same way on a DOWNGRADE: the stored intent survives and the
// GATE decides at request time. Clearing the setting when a plan changes would
// destroy a customer's configuration on a billing event and silently fail to
// restore it on the way back up.
const crypto = require('crypto');
const { db } = require('../db');
const { now } = require('../util');
const config = require('../config');
const plans = require('../plans');

const q = {
  byId: db.prepare('SELECT * FROM status_pages WHERE id = ?'),
  byIdOrg: db.prepare('SELECT * FROM status_pages WHERE id = ? AND org_id = ?'),
  bySlug: db.prepare('SELECT * FROM status_pages WHERE slug = ?'),
  byDomain: db.prepare('SELECT * FROM status_pages WHERE domain = ? AND domain_verified_at IS NOT NULL'),
  defaultOf: db.prepare('SELECT * FROM status_pages WHERE org_id = ? AND is_default = 1'),
  listOf: db.prepare('SELECT * FROM status_pages WHERE org_id = ? ORDER BY is_default DESC, name, id'),
  countOf: db.prepare('SELECT COUNT(*) c FROM status_pages WHERE org_id = ?'),
  compsOf: db.prepare('SELECT component_id FROM status_page_components WHERE page_id = ?'),
  orgPlan: db.prepare('SELECT plan FROM organizations WHERE id = ?'),
  pagesForComponents: db.prepare('SELECT DISTINCT page_id FROM status_page_components WHERE component_id = ?'),
};

const planOf = (orgId) => (q.orgPlan.get(orgId) || {}).plan || 'free';
const hasFeature = (orgId, f) => plans.hasFeature(planOf(orgId), f);

// ---- resolution --------------------------------------------------------------

const pageById = (id, orgId) => (orgId === undefined ? q.byId.get(id) : q.byIdOrg.get(id, orgId)) || null;

/**
 * The org's default page, created on first ask if it is missing.
 *
 * Lazy rather than "created wherever an org is created": orgs are minted in
 * three places (the seed, EE provisioning, self-service signup) and migration
 * v18 only backfilled the ones that existed when it ran. Every org that appears
 * afterwards would otherwise have a status page that 404s until someone noticed
 * — a failure mode nothing in the code would point at. Doing it here means the
 * invariant "an org has a default page" holds by construction.
 */
function defaultPage(orgId) {
  const found = q.defaultOf.get(orgId);
  if (found) return found;
  const org = db.prepare('SELECT id, slug FROM organizations WHERE id = ?').get(orgId);
  if (!org) return null;
  const name = db.prepare("SELECT value FROM org_settings WHERE org_id = ? AND key = 'org_name'").get(orgId);
  const published = db.prepare("SELECT value FROM org_settings WHERE org_id = ? AND key = 'status_published'").get(orgId);
  const ins = db.prepare(`INSERT INTO status_pages (org_id, slug, name, is_default, published, created_at)
    VALUES (?, ?, ?, 1, ?, ?)`);
  // The org's slug is the natural one, but it is only UNIQUE among orgs — a
  // custom page could have claimed it. Falling back keeps the page reachable
  // instead of throwing on a name collision nobody can see coming.
  const wanted = org.slug || `org-${orgId}`;
  const pub = !published || published.value === '1' ? 1 : 0;
  try { ins.run(orgId, wanted, name ? name.value : 'Status', pub, now()); }
  catch { ins.run(orgId, `${wanted}-${orgId}`, name ? name.value : 'Status', pub, now()); }
  return q.defaultOf.get(orgId);
}
const listPages = (orgId) => q.listOf.all(orgId);
const pageCount = (orgId) => q.countOf.get(orgId).c;

// The Host header, minus any port, lowercased. Express gives us req.hostname
// already stripped, but this is also called with raw values (Caddy's TLS ask
// endpoint passes the name as a query parameter).
function normalizeHost(raw) {
  return String(raw || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

// A custom domain only resolves while the plan still carries the feature. On a
// downgrade the domain stays configured and simply stops answering — which is
// the honest behaviour: we cannot keep serving a paid hostname for free, and
// deleting it would make the upgrade path a re-setup.
function pageByDomain(host) {
  const h = normalizeHost(host);
  if (!h) return null;
  const p = q.byDomain.get(h);
  if (!p) return null;
  return hasFeature(p.org_id, 'status_domain') ? p : null;
}

const pageBySlug = (slug) => q.bySlug.get(String(slug || '').toLowerCase()) || null;

// The page a request is for, or null. `slug` is the :slug segment when the route
// had one. A request arriving on a custom domain wins over everything else.
function resolvePage(req, slug) {
  const byDomain = pageByDomain(req.hostname || req.headers.host);
  if (byDomain) return byDomain;
  if (slug) return pageBySlug(slug);
  const org = db.prepare('SELECT id FROM organizations WHERE id = 1').get();
  return org ? defaultPage(org.id) : null;
}

// True when the request came in on this page's own domain — the URLs the page
// prints have to stay on whichever host the visitor is actually using, or a
// custom-domain visitor gets bounced back to opscat.io by every link.
function onOwnDomain(req, page) {
  return !!(page.domain && normalizeHost(req.hostname || req.headers.host) === page.domain);
}

// The path prefix every URL on the page is built from. On a custom domain the
// page lives at the ROOT of that host, so the prefix is empty.
function basePath(req, page) {
  if (onOwnDomain(req, page)) return '';
  return page.is_default ? '/status' : `/status/${encodeURIComponent(page.slug)}`;
}

// Absolute URL, for mails and feeds — those leave the request context, so they
// prefer the custom domain whenever there is a usable one.
function absoluteUrl(page) {
  if (page.domain && page.domain_verified_at && hasFeature(page.org_id, 'status_domain')) {
    return `https://${page.domain}`;
  }
  return page.is_default ? `${config.baseUrl}/status`
    : `${config.baseUrl}/status/${encodeURIComponent(page.slug)}`;
}

// ---- visibility --------------------------------------------------------------

const published = (page) => !!page && page.published === 1;

// A private page is reachable with its link secret: `?k=<token>`, which is then
// remembered in a cookie so the links ON the page keep working without carrying
// the secret through every href (and without it ending up in a referrer).
//
// This is a shared-link model, not per-person authentication: everyone with the
// link is the audience. That is the honest scope — an allowlist of confirmed
// addresses would reuse the subscriber double-opt-in machinery and is a separate
// feature. It is documented as such, and the page is always noindex.
function cookieName(page) { return `sp${page.id}`; }

function canView(req, page) {
  if (page.visibility !== 'private') return true;
  if (!page.access_token) return false;
  const supplied = req.query?.k || readCookie(req, cookieName(page));
  if (typeof supplied !== 'string' || supplied.length !== page.access_token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(page.access_token));
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Called once a private page has been opened with a valid `?k=` so the visitor
// does not have to keep it in the URL.
function rememberAccess(req, res, page) {
  if (page.visibility !== 'private' || !req.query?.k) return;
  res.setHeader('Set-Cookie', `${cookieName(page)}=${encodeURIComponent(page.access_token)}`
    + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax'
    + (config.baseUrl.startsWith('https') ? '; Secure' : ''));
}

const newAccessToken = () => crypto.randomBytes(24).toString('base64url');

// ---- component scope ---------------------------------------------------------

// The component ids a page shows, or null for "all of the org's". No rows means
// all: the default page never has to be backfilled when a component is added,
// which is also why a subset page stores its selection positively.
function componentIdsFor(page) {
  const rows = q.compsOf.all(page.id);
  return rows.length ? rows.map((r) => r.component_id) : null;
}

// Every page of an org that shows at least one of these components — the pages
// whose subscribers an incident concerns. An incident with NO components is an
// org-wide announcement and goes to every page.
function pagesForIncidentComponents(orgId, componentIds) {
  const all = listPages(orgId);
  if (!componentIds || !componentIds.length) return all;
  const wanted = new Set(componentIds);
  return all.filter((p) => {
    const ids = componentIdsFor(p);
    return ids === null || ids.some((id) => wanted.has(id));
  });
}

// ---- gated settings ----------------------------------------------------------

// Both resolved at RENDER time, never by clearing the column on downgrade.
const whitelabel = (page) => page.hide_powered === 1 && hasFeature(page.org_id, 'status_whitelabel');
const customCss = (page) => (hasFeature(page.org_id, 'status_css') ? page.custom_css || '' : '');

module.exports = {
  q,
  planOf, hasFeature,
  pageById, defaultPage, listPages, pageCount, pageBySlug, pageByDomain, resolvePage,
  normalizeHost, onOwnDomain, basePath, absoluteUrl,
  published, canView, rememberAccess, newAccessToken, readCookie,
  componentIdsFor, pagesForIncidentComponents,
  whitelabel, customCss,
  now,
};
