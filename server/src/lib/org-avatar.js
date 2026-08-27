'use strict';
// The organisation's avatar — initials by default, an uploaded image if the org
// has one.
//
// An org used to have a NAME and nothing else, so every surface that wanted to
// show one drew its own placeholder: the workspace switcher had a fixed indigo
// gradient square (identical for every org, so it identified nothing), and the
// alert mail grew a blue square. Both were decoration pretending to be identity.
//
// ── Why the default is not stored ───────────────────────────────────────────
//
// Initials over a colour derived from the org id. Nothing is written, so the
// default cannot be missing, cannot need a migration for the orgs that already
// exist, and cannot drift between the app, the mail and the platform console —
// all three derive it from the same two functions. An org that uploads an image
// gets a row; deleting the row restores the default exactly.
//
// The colour is derived from the org ID rather than the NAME on purpose: an org
// that renames itself keeps the colour its people have learned to recognise in
// a switcher, and two orgs called "Acme" in the platform console do not collide.
const store = require('../db/shim');
const { getOrgSetting } = require('../db');
const config = require('../config');
const { now } = require('../util');
// The sniffing, the size cap and the base64 ceiling are the status page's, and
// they stay one implementation: a second copy is how "an SVG is refused" comes
// to be true of one upload route and not the other.
const branding = require('./status-branding');

// Six, and no red. Red is the critical severity everywhere else in this product
// (web/src/format.ts SEV), so an org whose avatar is red would read as an org
// that is on fire.
const PALETTE = ['#388bfd', '#bc8cff', '#3fb950', '#f0883e', '#38b6ff', '#e3b341'];

/**
 * Two characters, and deliberately NOT the rule the user avatar uses.
 *
 * `initials()` in web/src/format.ts takes the first letter of each word, which
 * is right for a person — nobody writes "Kl" for Klaus — and wrong for an org,
 * because the overwhelming majority of org names are ONE word ("OpsCat",
 * "webundco", "Acme"). That rule renders them as a single letter in a round
 * badge, which reads as an unfinished component rather than as identity. So: a
 * multi-word name takes one letter from each of the first two words, and a
 * single-word name takes its first two letters. Same convention every
 * workspace switcher the reader already uses has.
 *
 * Separators are treated as spaces, so "link11-gmbh" is two words. Punctuation
 * inside a word is dropped, so "ACME (staging)" gives "AS" — which is the
 * useful answer, since telling that org apart from plain "ACME" at a glance is
 * the entire job.
 *
 * A name with no letters or digits at all falls back to "?", because an empty
 * coloured square is indistinguishable from a bug.
 */
function initials(name) {
  const words = String(name || '').split(/[\s_\-./\\|,+]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1
    ? [...words[0]].slice(0, 2).join('')
    : words.slice(0, 2).map((w) => [...w][0]).join('');
  return letters.toUpperCase();
}

// FNV-1a over the id. Any stable hash does; what matters is that it is stable,
// that it lives in exactly one place, and that it is not `Math.random()` — a
// colour that changes per render is worse than no colour at all.
function colorOf(orgId) {
  const s = String(orgId || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/**
 * The name an avatar is derived from — resolved in ONE place, because the
 * product has two of them and they are not kept in sync.
 *
 * `organizations.name` is the row (what the workspace switcher shows, what
 * platform provisioning writes); `org_settings.org_name` is the field Settings
 * › General edits. Nothing writes one through to the other, so an org renamed
 * in Settings keeps the old name in the switcher — a real inconsistency, older
 * than this file and not this file's to fix.
 *
 * What it IS this file's to prevent is the avatar disagreeing with itself: the
 * mail resolving "Acme Inc." to AI while the switcher resolves "acme" to AC,
 * for one organisation, on one screen. So every caller derives the name here,
 * the setting wins where it is set, and the two-names problem stays exactly as
 * visible as it was instead of growing a third symptom.
 */
function displayName(orgId, rowName) {
  return getOrgSetting(orgId, 'org_name', '') || String(rowName || '') || 'Organization';
}

const qGet = store.prepare('SELECT mime, bytes, updated_at FROM org_assets WHERE org_id = ? AND kind = ?');
const qMeta = store.prepare('SELECT mime, updated_at, length(bytes) AS bytes FROM org_assets WHERE org_id = ? AND kind = ?');
const qPut = store.prepare(`INSERT INTO org_assets (org_id, kind, mime, bytes, updated_at)
  VALUES (?, 'avatar', ?, ?, ?)
  ON CONFLICT (org_id, kind) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes,
    updated_at = excluded.updated_at`);
const qDel = store.prepare("DELETE FROM org_assets WHERE org_id = ? AND kind = 'avatar'");

async function getAvatar(orgId) { return qGet.get(orgId, 'avatar'); }

/**
 * Every org that HAS an upload, as `org_id -> updated_at`, in one statement.
 *
 * The platform console lists up to 200 organisations; asking `avatarMeta` per
 * row would be 200 round trips for a column of 28px badges. Same reasoning and
 * same shape as `logs.countByOrg()` in routes/superadmin.js, which exists for
 * exactly this. An org missing from the map has no upload — which is not a
 * missing value, it is the initials default.
 */
async function metaByOrg() {
  const rows = await store.prepare("SELECT org_id, updated_at FROM org_assets WHERE kind = 'avatar'").all();
  return new Map(rows.map((r) => [String(r.org_id), Number(r.updated_at)]));
}
async function avatarMeta(orgId) { return qMeta.get(orgId, 'avatar'); }

async function putAvatar(orgId, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: 'empty upload' };
  if (buf.length > branding.MAX_ASSET_BYTES) return { ok: false, error: 'image larger than 512 KB' };
  // The declared type is a claim by the uploader; the bytes are the fact. An
  // SVG is refused whatever it calls itself for the same reason it is on a
  // status page: this endpoint is openable directly, so a scripted "image"
  // would execute on our own origin.
  const mime = branding.sniffMime(buf);
  if (!mime) return { ok: false, error: 'unsupported image format — use PNG, JPEG, WebP or ICO' };
  await qPut.run(orgId, mime, buf, now());
  return { ok: true, mime, bytes: buf.length };
}

async function deleteAvatar(orgId) { await qDel.run(orgId); }

/**
 * The URL the avatar is served from — same-origin for the app, absolute for a
 * mail, which has no origin of its own.
 *
 * `v=<updated_at>` is not decoration: the path is stable per org, so without it
 * a replaced logo keeps showing the old one out of every cache between us and
 * the reader — including the mail-image proxies, which cache far longer than a
 * browser and honour no header we can send.
 */
function avatarPath(orgId, updatedAt) {
  return `/org-avatar/${encodeURIComponent(orgId)}?v=${Number(updatedAt) || 0}`;
}
function avatarUrl(orgId, updatedAt) {
  return `${config.baseUrl}${avatarPath(orgId, updatedAt)}`;
}

/**
 * Everything a surface needs to render one, in one object, so no caller has to
 * remember that "no row" means initials rather than a broken image.
 *
 * `absolute` is for the mail. Everywhere else takes the relative path: it keeps
 * the app working behind a hostname the server has not been told about, which
 * `config.baseUrl` would otherwise get wrong.
 */
async function dtoFor(orgId, rowName, { absolute = false } = {}) {
  const meta = await avatarMeta(orgId);
  const name = displayName(orgId, rowName);
  return {
    name,
    initials: initials(name),
    color: colorOf(orgId),
    url: meta ? (absolute ? avatarUrl(orgId, meta.updated_at) : avatarPath(orgId, meta.updated_at)) : null,
    mime: meta ? meta.mime : null,
    bytes: meta ? Number(meta.bytes) : null,
  };
}

module.exports = {
  PALETTE, initials, colorOf, displayName, getAvatar, avatarMeta, metaByOrg, putAvatar, deleteAvatar,
  avatarPath, avatarUrl, dtoFor,
  MAX_ASSET_BYTES: branding.MAX_ASSET_BYTES, MAX_ASSET_B64_CHARS: branding.MAX_ASSET_B64_CHARS,
};
