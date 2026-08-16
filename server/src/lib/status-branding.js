'use strict';
// Status-page branding: the customer's identity on the one surface of OpsCat
// their own customers ever look at. Scoped to a PAGE since schema v18 — an
// audience-specific page may well carry a different logo than the public one.
//
// PRICING SHAPE (see plans.js): identity — logo, favicon, accent, light/dark,
// description, links — is ungated on every plan including Free. Only DISTANCE
// from OpsCat is paid: `status_whitelabel` (business+) hides the footer,
// `status_css` (business+) allows arbitrary CSS, `status_domain` (pro+) serves
// the page on the customer's own hostname. All three are resolved at RENDER
// time in lib/status-pages.js, so a downgrade never destroys configuration.
//
// Everything here is rendered into a server-built HTML string, so validation is
// not cosmetic — it is the injection boundary:
//   * the accent lands inside a <style> block, where HTML-escaping buys nothing.
//     It is therefore matched against a strict hex pattern and falls back to the
//     default on anything else. Never relax this into "escape it".
//   * links land in href=. Only http/https survive, so `javascript:` cannot.
//   * custom CSS lands in that same <style> block, so it may not contain a
//     closing tag — see sanitizeCss.
//   * text lands in the document body and is escaped by the caller (public.js).
const { db } = require('../db');
const { now } = require('../util');
const pages = require('./status-pages');

const DEFAULT_ACCENT = '#6366f1';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_CSS_BYTES = 20 * 1024;

// Raster only. An uploaded SVG is a script-bearing document: harmless inside an
// <img>, but /status/logo can also be opened directly, and then the browser
// executes it on the status page's own origin. Refusing the format removes the
// whole class of problem — and a logo is a PNG everywhere else in this industry
// anyway (Statuspage's own guidance is a 320x100 PNG).
const MAGIC = [
  { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/x-icon', test: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
];
const MAX_ASSET_BYTES = 512 * 1024;

// The declared content type is a claim by the uploader; the bytes are the fact.
// Sniffing means a .png that is really something else cannot be stored and then
// served back with an image content type.
function sniffMime(buf) {
  for (const m of MAGIC) if (m.test(buf)) return m.mime;
  return null;
}

function accentOf(page) {
  return HEX_RE.test(page.accent || '') ? page.accent.toLowerCase() : DEFAULT_ACCENT;
}

function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : '';
}

/**
 * Custom CSS is injected into the page's own <style> block, so the ONE thing it
 * must not contain is a closing tag: `</style><script>…` would otherwise turn a
 * stylesheet field into stored XSS on the status page's origin. Everything else
 * is allowed on purpose — this is a styling escape hatch, and a customer who
 * breaks their own layout can undo it.
 *
 * Rejected rather than stripped: silently deleting part of what someone typed
 * leaves them debugging CSS that is not the CSS they wrote.
 */
function cssProblem(css) {
  if (typeof css !== 'string') return 'custom CSS must be a string';
  if (Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) return 'custom CSS is limited to 20 KB';
  if (/<\/\s*style/i.test(css)) return 'custom CSS may not contain a closing </style> tag';
  return null;
}

// Relative luminance (WCAG) — decides whether text on the accent button is
// white or near-black. A brand colour may be anything from navy to lime, and a
// fixed white label is unreadable on the light half of that range.
function readableOn(hex) {
  const v = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2);
  return lum > 0.45 ? '#0b0e14' : '#ffffff';
}

// Darken a hex colour by `f` (0..1), for the fallback logo's gradient. Computed
// here rather than with CSS color-mix() on purpose: the status page is the one
// surface whose visitors we do not choose, and a browser without color-mix would
// drop the whole gradient and render an invisible square.
function shade(hex, f) {
  const ch = (i) => Math.round(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) * (1 - f));
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`;
}

// Two palettes, same variable names — the page's CSS is written once against
// these and never branches on the theme itself.
const THEMES = {
  dark: {
    bg: '#0b0e14', surface: '#161b22', border: '#21262d', borderStrong: '#30363d',
    text: '#c9d1d9', heading: '#f0f6fc', muted: '#8b949e', faint: '#484f58',
    field: '#0b0e14', okStrip: 'rgba(63,185,80,.55)',
  },
  light: {
    bg: '#ffffff', surface: '#f6f8fa', border: '#d8dee4', borderStrong: '#d0d7de',
    text: '#32383f', heading: '#1f2328', muted: '#59636e', faint: '#818b98',
    field: '#ffffff', okStrip: 'rgba(31,136,61,.45)',
  },
};

const assetMetaStmt = db.prepare('SELECT mime, updated_at FROM status_assets WHERE page_id = ? AND kind = ?');
const assetStmt = db.prepare('SELECT mime, bytes, updated_at FROM status_assets WHERE page_id = ? AND kind = ?');
const upsertStmt = db.prepare(`INSERT INTO status_assets (page_id, kind, mime, bytes, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(page_id, kind) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes,
    updated_at = excluded.updated_at`);
const delStmt = db.prepare('DELETE FROM status_assets WHERE page_id = ? AND kind = ?');

function getAsset(pageId, kind) { return assetStmt.get(pageId, kind) || null; }
function assetMeta(pageId, kind) { return assetMetaStmt.get(pageId, kind) || null; }

// Returns {ok:true} or {ok:false, error} — the caller turns it into a 400.
function putAsset(pageId, kind, buf) {
  if (!['logo', 'favicon'].includes(kind)) return { ok: false, error: 'unknown asset kind' };
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: 'empty upload' };
  if (buf.length > MAX_ASSET_BYTES) return { ok: false, error: 'image larger than 512 KB' };
  const mime = sniffMime(buf);
  if (!mime) return { ok: false, error: 'unsupported image format — use PNG, JPEG, WebP or ICO' };
  upsertStmt.run(pageId, kind, mime, buf, now());
  return { ok: true, mime, bytes: buf.length };
}

function deleteAsset(pageId, kind) { delStmt.run(pageId, kind); }

// Everything the renderer needs, already validated. `logoUrl`/`faviconUrl` are
// URL paths (or ''), not bytes — the page links to them, it does not inline
// them. `base` is the page's own path prefix, which is '' on a custom domain.
function brandingFor(page, base) {
  const themeKey = page.theme === 'light' ? 'light' : 'dark';
  const accent = accentOf(page);
  const logo = assetMeta(page.id, 'logo');
  // A favicon nobody uploaded falls back to the logo — same brand, and it saves
  // every customer a second upload of the same file at a different size.
  const favicon = assetMeta(page.id, 'favicon') || logo;
  const stamp = (a) => (a ? `?v=${a.updated_at}` : '');
  return {
    theme: themeKey,
    palette: THEMES[themeKey],
    accent,
    accentDark: shade(accent, 0.35),
    accentInk: readableOn(accent),
    logoUrl: logo ? `${base}/logo${stamp(logo)}` : '',
    faviconUrl: favicon ? `${base}/favicon${stamp(favicon)}` : '',
    faviconMime: favicon ? favicon.mime : '',
    description: String(page.description || '').slice(0, 300),
    supportUrl: safeUrl(page.support_url),
    legalUrl: safeUrl(page.legal_url),
    hidePowered: pages.whitelabel(page),
    customCss: pages.customCss(page),
  };
}

module.exports = {
  DEFAULT_ACCENT, HEX_RE, MAX_ASSET_BYTES, MAX_CSS_BYTES, THEMES,
  accentOf, safeUrl, readableOn, shade, sniffMime, cssProblem,
  getAsset, assetMeta, putAsset, deleteAsset, brandingFor,
};
