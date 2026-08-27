'use strict';
// The alert e-mail — layout "Severity Rail".
//
// One builder for BOTH e-mail call sites in engine/alerts.js: the rule
// dispatch and `sendVia('email')`, which the on-call chain delivers through.
// They used to carry two byte-identical copies of an `<h2>` plus a `<pre>`
// holding the same plaintext every other channel gets — so an escaping fix, a
// deep link or a header was something you could get right in one and miss in
// the other.
//
// It is deliberately NOT merged with `lib/subscribers.js`'s `brandedMail()`
// yet. That one renders in a STATUS PAGE's brand (accent, palette, logo) and
// is pinned by 149 checks in e2e-branding; this one renders in the severity of
// an event. The shared shell is worth extracting, but as its own change with
// that harness in front of it — not as a side effect of this one.
//
// Rules the layout follows, all of them for a reason a mail client taught
// somebody the hard way:
//
//  - TABLES, not flex or grid. Outlook on Windows renders through Word.
//  - INLINE styles only. `<style>` blocks are stripped by Gmail and others.
//  - LIGHT only, with explicit background AND foreground on every surface. A
//    dark-mode client that inverts a background we did not state would leave
//    dark text on dark. Stating both is what makes the inversion a no-op.
//  - NOTHING REMOTE, still. The severity is a coloured rail and the org is
//    initials on a coloured cell — both survive "block remote content", which
//    is the default in most clients for a sender nobody has replied to. An
//    org's UPLOADED avatar is deliberately not used here even though the
//    feature exists; `avatarCell` explains what was rendered and rejected.
//  - The header aligns by `valign` on its cells, never by a `vertical-align`
//    nudge. It used to carry a square pushed into place with `-3px`: a magic
//    number wrong at every size but the one it was typed at, which orphaned
//    the square onto its own line as soon as a long org name wrapped.
//  - The COLOUR is never the only carrier — the chip says "HIGH 62" in text
//    beside it, because ~4% of the men reading this cannot tell the rail from
//    the medium one.
const { escapeHtml } = require('../util');

// The rail, and the chip that repeats it in words. Rail colours are the
// product's own (web/src/format.ts SEV); the chip is a light-mode triple
// because a NOC palette on white does not have the contrast a mail needs.
const BANDS = [
  { at: 80, key: 'critical', rail: '#f85149', bg: '#ffebe9', fg: '#a40e26', bd: '#ffcecb' },
  { at: 60, key: 'high', rail: '#f0883e', bg: '#fff1e5', fg: '#953800', bd: '#f5c396' },
  { at: 40, key: 'medium', rail: '#e3b341', bg: '#fff8c5', fg: '#7d4e00', bd: '#eac54f' },
  { at: 20, key: 'low', rail: '#388bfd', bg: '#ddf4ff', fg: '#0550ae', bd: '#b6e3ff' },
  { at: -1, key: 'info', rail: '#8b949e', bg: '#f6f8fa', fg: '#57606a', bd: '#d0d7de' },
];
function band(severity) {
  const s = Number(severity);
  return BANDS.find((b) => (Number.isFinite(s) ? s : 0) >= b.at) || BANDS[BANDS.length - 1];
}

const INK = '#24292f';
const MUTED = '#8c959f';
const LABEL = '#57606a';
const LINE = '#eaeef2';
const PAPER = '#ffffff';
const DESK = '#f6f8fa';
const ACCENT = '#388bfd';
const HEX_RE = /^#[0-9a-f]{6}$/i;
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";

// An absolute instant, in UTC and SAID to be in UTC. There is no per-org
// timezone in this product, so the alternative is the SERVER's zone rendered
// without a label — which reads as the reader's own and is wrong by an hour
// twice a year even when they share it.
function absTime(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return null;
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())} ${M[d.getUTCMonth()]}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// "16m ago". The absolute time answers "when", this answers "how long has this
// been going on" — which is the question a reader actually has, and the one
// the mail could not answer at all before.
function relTime(ms, at) {
  const d = Number(at) - Number(ms);
  if (!Number.isFinite(d) || d < 0) return null;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m ago` : `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// A header value is attacker-influenced (a rule name, a device out of a log
// line). A bare CR or LF in one ENDS the header and starts another — that is
// header injection, and in a mail it can forge a Bcc. Strip the control range
// outright and cap the length; a header nobody reads is not worth a risk.
// The order matters and the first replace is not redundant: the control-range
// strip below would delete a CR/LF on its own, WELDING the words on either
// side into one ("evil" + "Bcc:" -> "evilBcc:"). Turning the break into a
// space first keeps the value readable, which is the whole point of a header
// a human reads in a filter rule.
function headerSafe(v, max = 120) {
  return String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The org avatar in the mail header — ALWAYS the initials, never the uploaded
 * image, and that is a measured decision rather than an omission.
 *
 * The org avatar feature has three surfaces: the workspace switcher, the
 * platform console and this. The first two render an org's uploaded logo
 * because a browser fetches it. A mail client does not: remote content is
 * blocked by default for a sender nobody has replied to, which is precisely
 * the first alert every new recipient gets.
 *
 * The obvious answer — an `<img>` over a coloured cell, with the initials as
 * its `alt` so a blocked image degrades to the default — was written, RENDERED
 * and rejected. Both failure states were photographed at 700px: a blocked
 * request and a 404 each produce a broken-image glyph WITH the alt text
 * spilling out of the 28px box. Chrome does that, Outlook draws a red cross,
 * and no styling of `alt` suppresses either. The claim "it degrades to the
 * default" was simply false, and only rendering it showed that.
 *
 * The technique that never breaks — the logo as a `background-image` on the
 * cell with the initials as real text inside it — fails the other way: when
 * the image DOES load, the initials sit on top of the logo, and no mail client
 * can be told to hide them conditionally.
 *
 * So the mail takes the half that cannot break. It is also the half that
 * matches the rest of this layout: nothing remote, nothing that renders empty
 * for a first reader. A tenant's logo is not lost — it is on every screen
 * where a browser can be relied on to fetch it.
 */
function avatarCell(avatar) {
  if (!avatar || !avatar.initials) return '';
  const size = 28;
  const bg = HEX_RE.test(avatar.color || '') ? avatar.color : ACCENT;
  return `<td width="${size}" valign="middle" style="width:${size}px;padding-right:10px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${size}"
style="width:${size}px;background:${bg};border-radius:6px"><tr><td align="center" valign="middle"
bgcolor="${bg}" style="background:${bg};border-radius:6px;height:${size}px;color:#ffffff;
font-family:${SANS};font-size:12px;font-weight:700;line-height:${size}px;text-align:center">${
  escapeHtml(avatar.initials)}</td></tr></table></td>`;
}

const btn = (label, url, primary) => `<td style="padding:0 10px 0 0">
<a href="${escapeHtml(url)}" style="font-family:${SANS};font-size:14px;font-weight:600;
text-decoration:none;display:inline-block;border-radius:6px;word-break:break-word;
max-width:100%;padding:${primary ? '11px 20px' : '10px 18px'};
${primary ? `background:${ACCENT};color:#ffffff;border:1px solid ${ACCENT}`
    : `background:${PAPER};color:#0969da;border:1px solid #d0d7de`}">${escapeHtml(label)}</a></td>`;

// `word-break` on the VALUE cell is not decoration. A fact value is a device
// name, an FQDN, a URL or an IPv6 address — none of which has a space in it,
// and a table cell holding one is as wide as the string. Measured at 390px
// with a real target URL: the mail scrolled sideways by 45px, which on a phone
// is the whole layout skewed. The h1 and the summary already carried this; the
// fact rows were written after them and did not.
function factRows(facts) {
  const rows = facts.filter((f) => f && f.value != null && f.value !== '');
  return rows.map((f, i) => {
    const last = i === rows.length - 1;
    const cell = `padding:9px 0;${last ? '' : `border-bottom:1px solid ${LINE};`}word-break:break-word;`;
    return `<tr><td style="${cell}color:${MUTED};width:42%;font-family:${SANS};font-size:13px">${
      escapeHtml(f.label)}</td><td style="${cell}color:${INK};font-family:${
      f.mono ? MONO : SANS};font-size:13px">${escapeHtml(f.value)}${
      f.hint ? ` <span style="color:${MUTED}">${escapeHtml(f.hint)}</span>` : ''}</td></tr>`;
  }).join('');
}

// A caller with nothing structured to say — the contact-method test, anything
// that only ever had a message — still gets the shell: rail, chip, brand, a
// text part and the headers. Its message renders as a block rather than as
// invented fact rows, because a layout must not claim a shape the caller did
// not pass. Newlines are the only formatting honoured, on purpose.
function bodyBlock(bodyText) {
  const t = String(bodyText || '').trim();
  if (!t) return '';
  return `<tr><td style="padding:20px 24px 0">
<div style="background:${DESK};border:1px solid ${LINE};border-radius:8px;padding:14px 16px;
font-family:${MONO};font-size:12.5px;color:${INK};line-height:1.6;white-space:pre-wrap;
word-break:break-word">${escapeHtml(t)}</div></td></tr>`;
}

/**
 * Build the whole mail.
 *
 * Returns `{ subject, html, text, headers }` — every part of it, so a caller
 * cannot render the body one way and the plaintext another. `text` is not a
 * nicety: a mail with no text/plain part scores as bulk with most filters, and
 * it is the only thing a terminal client, a screen reader in plain mode or a
 * watch notification ever shows.
 */
function build({
  subject = '', orgName = 'OpsCat', avatar = null, headline = '', summary = '', severity = 0, sevLabel = '',
  facts = [], bodyText = '', primary = null, secondary = null, footer = '', at = Date.now(),
  headers = {},
} = {}) {
  const b = band(severity);
  const chip = `${String(sevLabel || b.key).toUpperCase()} ${Number(severity) || 0}`;
  const stamp = absTime(at);
  // The preheader is the grey line a phone shows under the subject. Unset, the
  // client takes the first text it finds — which is the org name and the word
  // "Alert", i.e. nothing. It is the most-read part of the mail.
  const pre = (facts.length
    ? [summary, ...facts.filter((f) => f && f.value).map((f) => `${f.label}: ${f.value}`)]
    : [summary, ...String(bodyText).split('\n')]
  ).map((l) => String(l).trim()).filter(Boolean).join(' · ').slice(0, 160);

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${DESK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${
  escapeHtml(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
style="background:${DESK};padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
style="width:100%;max-width:600px;background:${PAPER};border:1px solid #d8dee4;border-radius:10px">
<tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:${b.rail};
border-radius:9px 9px 0 0">&nbsp;</td></tr>
<tr><td style="padding:20px 24px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${avatarCell(avatar)}<td valign="middle" style="font-family:${SANS};font-size:13px;color:${LABEL};word-break:break-word">
      <strong style="color:${INK}">${escapeHtml(orgName)}</strong>
      <span style="color:${MUTED}">&middot; Alert</span></td>
    <td align="right" valign="middle" style="font-family:${SANS};font-size:12px;color:${MUTED};
    white-space:nowrap;padding-left:12px">${stamp ? escapeHtml(stamp) : ''}</td>
  </tr></table>
  <div style="margin-top:16px"><span style="display:inline-block;background:${b.bg};color:${b.fg};
  border:1px solid ${b.bd};border-radius:999px;padding:7px 15px;font-family:${SANS};
  font-size:14px;font-weight:700;letter-spacing:.03em;line-height:1">${escapeHtml(chip)}</span></div>
  <h1 style="font-family:${MONO};font-size:21px;color:${INK};margin:12px 0 4px;
  font-weight:600;line-height:1.3;word-break:break-word">${escapeHtml(headline)}</h1>
  ${summary ? `<p style="font-family:${SANS};font-size:15px;color:${LABEL};margin:0;
  line-height:1.5;word-break:break-word">${escapeHtml(summary)}</p>` : ''}
</td></tr>
${facts.length ? `<tr><td style="padding:20px 24px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
  style="border-top:1px solid ${LINE}">${factRows(facts)}</table></td></tr>`
    : bodyBlock(bodyText)}
${primary || secondary ? `<tr><td style="padding:22px 24px 4px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${
  primary ? btn(primary.label, primary.url, true) : ''}${
  secondary ? btn(secondary.label, secondary.url, false) : ''}</tr></table></td></tr>` : ''}
<tr><td style="padding:20px 24px 0"><div style="height:1px;background:${LINE};font-size:0">&nbsp;</div></td></tr>
<tr><td style="padding:13px 24px 18px;font-family:${SANS};font-size:11px;color:${MUTED};
line-height:1.5;word-break:break-word">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;

  // In bodyText mode the caller's message is ALREADY the whole plaintext — it
  // is the same string every other channel receives — so the severity line is
  // not repeated on top of it. Adding one produced the message twice, which is
  // what a reader notices first and trusts least.
  const text = (facts.length ? [
    headline,
    summary,
    '',
    `Severity: ${severity}${sevLabel ? ` (${sevLabel})` : ''}`,
    ...facts.filter((f) => f && f.value != null && f.value !== '')
      .map((f) => `${f.label}: ${f.value}${f.hint ? ` ${f.hint}` : ''}`),
  ] : [
    String(bodyText).trim(),
  ]).concat([
    ...(primary ? ['', `${primary.label}: ${primary.url}`] : []),
    ...(secondary ? [`${secondary.label}: ${secondary.url}`] : []),
    ...(footer ? ['', footer] : []),
  ]).join('\n');

  const hdr = {
    // Keeps an out-of-office reply from answering a pager at 03:00, and keeps
    // the mail out of most "is this a newsletter" heuristics.
    'Auto-Submitted': 'auto-generated',
    'X-OpsCat-Severity': String(Number(severity) || 0),
  };
  if (sevLabel) hdr['X-OpsCat-Severity-Label'] = headerSafe(sevLabel, 20);
  for (const [k, v] of Object.entries(headers)) {
    const safe = headerSafe(v);
    if (safe) hdr[k] = safe;
  }
  return { subject, html, text, headers: hdr };
}

module.exports = { build, band, absTime, relTime, headerSafe };
