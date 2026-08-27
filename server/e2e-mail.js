'use strict';
/* End-to-end check for the alert E-MAIL — layout "Severity Rail".
 *
 * Boots no server and needs no port: what is under test is a builder plus the
 * two call sites that use it, and both are reachable in-process. It does need
 * the throwaway database run-e2e.js provides, because `dispatch()` reads the
 * org's sender address and looks up the case behind the event.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The alert mail was two byte-identical copies of an `<h2>` plus a `<pre>`, in
 * one file, twenty lines apart. Nothing anywhere asserted on the BODY of a
 * mail this product sends: `e2e-alerts` deletes RESEND_API_KEY/SMTP_HOST from
 * the environment on purpose and drives ntfy, `e2e-subscribers` intercepts
 * Resend but asserts on the status-page mails. So every property below was
 * true of nothing and enforced by nobody.
 *
 * Three of the checks are for defects the layout change fixed, and they are
 * the ones to keep:
 *
 *  - ESCAPING. `ev.name` and `ev.device` come out of log lines and went into
 *    the subject heading raw; the body escaped `&` and `<` and nothing else.
 *    A device called `<img src=x onerror=…>` was markup in a mail sent to
 *    every recipient of the rule.
 *  - HEADER INJECTION. A rule name is typed by a `lead` and now reaches an
 *    e-mail header. A bare CR or LF in one ends the header and starts the
 *    next, which in a mail is a forged Bcc.
 *  - THE TEST FIRE. `routes/ops.js` fires a synthetic event with `id: 0`, so a
 *    deep link built without a guard is `?event=0` — a link to a record that
 *    does not exist, in the one mail whose entire job is to prove the channel
 *    works.
 *
 * And one check is about a REGRESSION rather than a bug: the SUBJECT must not
 * change. It is what every mail filter a customer has built points at.
 *
 *   cd server && node run-e2e.js mail
 */
const { chk, report, die } = require('./e2e-lib').harness();

process.env.OPSCAT_SECRET = 'e2e-mail-secret';
process.env.OPSCAT_BASE_URL = 'https://opscat.test';
// The mail transport is stubbed below, but an exported key would make
// `mailConfigured()` true for real on a developer's machine — and the first
// version of e2e-alerts sent live mail exactly that way.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const q = require('./src/db/shim');
const alertMail = require('./src/lib/alert-mail');

// ── 1. the builder, with no database in the picture ─────────────────────────

function builderChecks() {
  const base = {
    subject: '[OpsCat High] cpu on web', orgName: 'Acme', headline: 'host_cpu_high',
    summary: '98% on webundco', severity: 62, sevLabel: 'High',
    facts: [{ label: 'Device', value: 'webundco', mono: true }, { label: 'Hits', value: '10' }],
    primary: { label: 'Open case C-1010', url: 'https://opscat.test/app/cases?case=10' },
    footer: 'Sent because rule "x" matched.',
    at: Date.UTC(2026, 7, 27, 9, 47),
  };
  const m = alertMail.build(base);

  chk('the subject is handed back untouched', m.subject === base.subject, m.subject);
  chk('a text/plain part is built', typeof m.text === 'string' && m.text.length > 20);
  chk('the plaintext carries no markup', !/<[a-z/]/i.test(m.text), m.text.slice(0, 80));
  chk('the plaintext carries the destination URL as a URL', m.text.includes(base.primary.url));
  chk('the html carries the severity rail colour', m.html.includes('#f0883e'));
  chk('the chip repeats the severity IN WORDS beside the colour', m.html.includes('HIGH 62'));
  chk('a preheader is set rather than left to the client',
    /display:none[^>]*>98% on webundco/.test(m.html.replace(/\s+/g, ' ')), 'no preheader');

  // Remote images are blocked by default for an unknown sender, so a layout
  // that needs one is a layout that renders empty for most first readers.
  chk('the mail loads nothing remote', !/<img|url\(|background-image/i.test(m.html));
  // Gmail and others strip <style> blocks outright.
  chk('every style is inline', !/<style/i.test(m.html));
  // A client that inverts for dark mode flips what it was told. Stating both
  // sides on the same element is what makes the inversion harmless.
  chk('the card states background AND foreground',
    m.html.includes('background:#ffffff') && m.html.includes('color:#24292f'));

  // -- escaping: the whole reason the old <h2> was a defect
  const eviltxt = '<img src=x onerror=alert(1)>';
  const ev = alertMail.build({ ...base, headline: eviltxt, summary: eviltxt,
    facts: [{ label: 'Device', value: eviltxt }], footer: eviltxt });
  chk('a device name cannot become markup', !ev.html.includes('<img src=x'), 'raw <img> survived');
  chk('it is escaped, not dropped', ev.html.includes('&lt;img src=x'));
  chk('the headline is escaped too', !/<h1[^>]*><img/.test(ev.html));
  chk('a quote in a value cannot break out of an attribute',
    alertMail.build({ ...base, primary: { label: 'x" onmouseover="y', url: 'https://o.test/a' } })
      .html.includes('&quot;'));

  // The chip is the one thing a reader is meant to see before anything else,
  // so its size is a decision and not a default. 11px lost against a 21px
  // monospace headline directly under it.
  chk('the severity chip is set at a size that reads before the headline',
    m.html.includes('border-radius:999px;padding:7px 15px')
    && m.html.includes('font-size:14px;font-weight:700'), 'chip is not 14px at 7px/15px padding');
  // Alignment in the header is STRUCTURAL. It used to be a coloured square
  // nudged with `vertical-align:-3px` — a magic number that is wrong at every
  // size but the one it was typed at, and that orphaned the square onto its
  // own line when a long org name wrapped. There is no org avatar in this
  // product either (logos are per STATUS PAGE), so the square was decoration
  // pretending to be identity.
  chk('the header aligns by table cells, not by a nudge',
    (m.html.match(/valign="middle"/g) || []).length === 2 && !/vertical-align:-/.test(m.html),
    'header alignment is hand-tuned again');
  chk('the timestamp does not wrap away from its row', m.html.includes('white-space:nowrap'));

  // -- the org avatar in the header.
  // ALWAYS the initials, never the uploaded image, and the checks say so in
  // both directions because it is a decision somebody will want to revisit.
  // It was rendered the other way first — an <img> over the coloured cell with
  // the initials as its alt — and photographed: a blocked request AND a 404
  // each produce a broken-image glyph with the alt spilling out of the 28px
  // box. See lib/alert-mail.js `avatarCell` for the full reasoning.
  const noUp = alertMail.build({ ...base, avatar: { initials: 'OP', color: '#388bfd', url: null } });
  chk('the org is rendered as its initials', noUp.html.includes('>OP</td>'), 'no initials cell');
  chk('…on the org colour', noUp.html.includes('bgcolor="#388bfd"'));
  chk('…and the mail loads nothing at all', !/<img|url\(/i.test(noUp.html));
  const withUp = alertMail.build({ ...base,
    avatar: { initials: 'OP', color: '#3fb950', url: 'https://opscat.test/org-avatar/x?v=7' } });
  chk('an org WITH an upload still gets initials, not an image that may not load',
    !/<img/i.test(withUp.html) && withUp.html.includes('>OP</td>'), 'an image reached the mail');
  chk('…and the mail still loads nothing remote', !/src=|url\(/i.test(withUp.html));
  // The colour reaches a style attribute and a bgcolor, so it is exactly the
  // shape the status page's accent already had to be guarded against.
  const evilColor = alertMail.build({ ...base,
    avatar: { initials: 'OP', color: '#fff" onload="alert(1)', url: null } });
  chk('a non-hex colour is refused rather than interpolated into the markup',
    !evilColor.html.includes('onload='), 'a colour became an attribute');
  chk('initials are escaped like every other value',
    alertMail.build({ ...base, avatar: { initials: '<b', color: '#388bfd', url: null } }).html.includes('&lt;b'));
  chk('no avatar at all renders no cell, rather than an empty one',
    !alertMail.build({ ...base, avatar: null }).html.includes('bgcolor='));

  // -- wrapping. Found by MEASURING at 390px, not by reading the markup: a
  // fact value is a device name, an FQDN, a URL or an IPv6 address, none of
  // which has a space in it, so the cell is as wide as the string. A real
  // target URL pushed the mail 45px past a phone. This is a static proxy for
  // that measurement — the harness boots no browser — and it is the property
  // the fix rests on, so it is worth pinning where it can regress silently.
  const wrapped = alertMail.build({ ...base,
    facts: [{ label: 'Target', value: 'https://api-gateway-prod-eu-central-1.internal.example.com:8443/healthz' }] });
  const cells = wrapped.html.match(/<td style="padding:9px 0;[^"]*"/g) || [];
  chk('every fact cell may break a long token', cells.length === 2
    && cells.every((c) => c.includes('word-break:break-word')), cells.join(' | '));
  chk('so may the headline and the summary',
    (m.html.match(/word-break:break-word/g) || []).length >= 4);

  // -- the severity bands, at their boundaries
  chk('80 is critical', alertMail.band(80).key === 'critical');
  chk('79 is high', alertMail.band(79).key === 'high');
  chk('60 is high', alertMail.band(60).key === 'high');
  chk('59 is medium', alertMail.band(59).key === 'medium');
  chk('40 is medium', alertMail.band(40).key === 'medium');
  chk('20 is low', alertMail.band(20).key === 'low');
  chk('19 is info', alertMail.band(19).key === 'info');
  chk('0 is info', alertMail.band(0).key === 'info');
  chk('a garbage severity falls back rather than throwing',
    alertMail.band(undefined).key === 'info' && alertMail.band(NaN).key === 'info');

  // -- time, and the fact that it says which zone it is in
  chk('an absolute time names its zone', alertMail.absTime(Date.UTC(2026, 7, 27, 9, 31)) === '27 Aug, 09:31 UTC');
  chk('an unusable instant renders nothing, not "Invalid Date"', alertMail.absTime('nope') === null);
  const t0 = Date.UTC(2026, 7, 27, 9, 31);
  chk('a relative time is minutes under an hour', alertMail.relTime(t0, t0 + 16 * 60000) === '16m ago');
  chk('… hours and minutes above one', alertMail.relTime(t0, t0 + 125 * 60000) === '2h 5m ago');
  chk('… days above a day', alertMail.relTime(t0, t0 + 3 * 86400000) === '3d ago');
  chk('… and "just now" inside the first minute', alertMail.relTime(t0, t0 + 5000) === 'just now');
  chk('a future instant yields no relative time', alertMail.relTime(t0 + 60000, t0) === null);

  // -- empty everything: a builder that throws takes the alert with it
  const bare = alertMail.build({});
  chk('a mail with nothing in it still builds', typeof bare.html === 'string' && bare.html.length > 0);
  chk('an empty fact list renders no fact table', !bare.html.includes('border-top:1px solid #eaeef2'));
  const partial = alertMail.build({ ...base,
    facts: [{ label: 'Device', value: 'web' }, { label: 'Target', value: '' }, { label: 'Hits', value: null }] });
  chk('an empty fact is dropped, not rendered blank', !partial.html.includes('Target'));
  chk('… and the last SURVIVING row is the one without a rule under it',
    partial.html.split('Hits').length === 1 && (partial.html.match(/border-bottom:1px solid #eaeef2/g) || []).length === 0,
    'a dropped fact still ended the table');

  // -- headers
  chk('an autoresponder is told not to answer', m.headers['Auto-Submitted'] === 'auto-generated');
  chk('the severity is filterable without parsing the subject', m.headers['X-OpsCat-Severity'] === '62');
  chk('the severity label rides along', m.headers['X-OpsCat-Severity-Label'] === 'High');
  const inj = alertMail.build({ ...base,
    headers: { 'X-OpsCat-Rule': 'evil\r\nBcc: attacker@example.com' } });
  chk('a newline in a header value cannot start a second header',
    !/[\r\n]/.test(inj.headers['X-OpsCat-Rule']), JSON.stringify(inj.headers['X-OpsCat-Rule']));
  // Not `startsWith('evil')`: the control-range strip below the CR/LF replace
  // would remove a newline on its own, so that assertion holds with the
  // replace deleted and the two words silently WELDED into "evilBcc:". The
  // exact value is what makes the separator a tested decision rather than an
  // accident — measured, this is the one mutation the first draft survived.
  chk('… and what is left is the value with the break turned into a space',
    inj.headers['X-OpsCat-Rule'] === 'evil Bcc: attacker@example.com',
    JSON.stringify(inj.headers['X-OpsCat-Rule']));
  chk('a header value is capped', alertMail.headerSafe('x'.repeat(400)).length <= 120);
  chk('an empty header is omitted rather than sent blank',
    !('X-OpsCat-Rule' in alertMail.build({ ...base, headers: { 'X-OpsCat-Rule': '   ' } }).headers));

  // -- bodyText mode: a caller with nothing structured to say
  const plain = alertMail.build({ subject: 's', headline: '[OpsCat ALERT] C-1 cpu', severity: 62,
    sevLabel: 'High', bodyText: 'cpu on web\n\nSeverity: 62 (High)\nUrgency: high',
    primary: { label: 'Acknowledge this alert', url: 'https://opscat.test/a/tok' } });
  chk('a message with no facts still gets the shell', plain.html.includes('#f0883e') && plain.html.includes('HIGH 62'));
  chk('… renders the message as a block', plain.html.includes('white-space:pre-wrap'));
  chk('… and its plaintext is the caller\'s message, once',
    (plain.text.match(/Severity: 62 \(High\)/g) || []).length === 1, plain.text);
  chk('… with the acknowledgement as a real URL in the text part',
    plain.text.includes('Acknowledge this alert: https://opscat.test/a/tok'));
  chk('… and as a button in the html', plain.html.includes('href="https://opscat.test/a/tok"'));
}

// ── 2. the rule dispatch, through the real path ─────────────────────────────

async function dispatchChecks() {
  const dbMod = require('./src/db');
  await dbMod.init();
  await require('./src/engine/seed').seed({ log: () => {} });
  const org = await q.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get();

  // The transport is replaced on the module object, so everything above it —
  // alerts.js's sendEmail, the org's sender address, the builder — is real.
  const mailer = require('./src/mailer');
  const sent = [];
  mailer.sendMail = async (m) => { sent.push(m); };
  mailer.mailConfigured = () => true;
  const alerts = require('./src/engine/alerts');

  const t = Date.UTC(2026, 7, 27, 9, 47, 14);
  const first = t - 16 * 60000;
  const evId = await q.prepare(`INSERT INTO events
      (org_id, dedupe_key, name, device, ip, target, description, severity, hits, first_seen, last_seen)
    VALUES (?, 'k1', 'host_cpu_high', 'webundco', '10.0.4.12', NULL, '98% on webundco', 62, 10, ?, ?)`)
    .insert(org.id, first, t);
  const caseId = await q.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, opened_at)
    VALUES (?, ?, 'host_cpu_high', 'webundco', 62, ?)`).insert(org.id, evId, first);
  const ev = await q.prepare('SELECT * FROM events WHERE id = ?').get(evId);

  const rule = { id: 1, org_id: org.id, name: 'CPU critical -> NOC', channel: 'email',
    recipients: JSON.stringify(['noc@example.com']) };
  await alerts.dispatch(rule, ev);
  chk('the rule sent exactly one mail', sent.length === 1, String(sent.length));
  const m = sent[0];

  // THE regression check. Every mail filter a customer built points here.
  chk('the subject is unchanged from before the layout',
    m.subject === '[OpsCat High] host_cpu_high on webundco', m.subject);
  chk('it goes to the rule\'s recipients', JSON.stringify(m.to) === JSON.stringify(['noc@example.com']));
  chk('the transport is handed a text part', typeof m.text === 'string' && m.text.length > 20);
  chk('the transport is handed headers', m.headers && m.headers['Auto-Submitted'] === 'auto-generated');

  // -- the deep links: the defect this whole change started from
  chk('the primary link opens the CASE, not the list',
    m.html.includes(`https://opscat.test/app/cases?case=${caseId}`), 'no case deep link');
  chk('the event is reachable too', m.html.includes(`https://opscat.test/app/monitor?event=${evId}`));
  chk('the bare list link is gone', !/app\/monitor"/.test(m.html), 'still linking the list');
  chk('both links are in the plaintext as well',
    m.text.includes(`?case=${caseId}`) && m.text.includes(`?event=${evId}`));

  // -- the time that was in the row and in no mail
  chk('the mail says when the event was first seen', m.html.includes('First seen'));
  chk('… with the absolute instant', m.html.includes(alertMail.absTime(first)));
  chk('… and how long ago that was', m.html.includes('16m ago'));
  chk('the last-seen row is there because the two instants differ', m.html.includes('Last seen'));
  chk('the hit count survived', m.html.includes('>10<'));
  chk('the case label is a fact, not only a link', m.html.includes(`C-${1000 + caseId}`));

  // -- headers built from the rule
  chk('the rule is named in a header', m.headers['X-OpsCat-Rule'] === 'CPU critical -> NOC', m.headers['X-OpsCat-Rule']);
  chk('the case is named in a header', m.headers['X-OpsCat-Case'] === `C-${1000 + caseId}`);
  chk('mails about one case thread together',
    m.headers.References === `<opscat-case-${caseId}@opscat.test>`, m.headers.References);
  chk('the footer says which rule to go and change',
    m.html.includes('CPU critical -&gt; NOC') || m.html.includes('CPU critical -> NOC'));

  // -- a rule name is typed by a human and now reaches a header
  sent.length = 0;
  await alerts.dispatch({ ...rule, name: 'evil\r\nBcc: attacker@example.com' }, ev);
  chk('a rule name cannot inject a header',
    !/[\r\n]/.test(sent[0].headers['X-OpsCat-Rule']), JSON.stringify(sent[0].headers['X-OpsCat-Rule']));

  // -- a device out of a log line cannot be markup
  sent.length = 0;
  await alerts.dispatch(rule, { ...ev, device: '<img src=x onerror=alert(1)>' });
  chk('a device name out of a log line is escaped in the body',
    !sent[0].html.includes('<img src=x'), 'raw markup in the mail');
  chk('… and in the subject line', !sent[0].subject.includes('<script'), sent[0].subject);

  // -- the rule TEST: routes/ops.js fires id 0 with no case and no first_seen
  sent.length = 0;
  await alerts.dispatch(rule, { id: 0, name: 'TEST ALERT', device: 'opscat-test', ip: null,
    target: null, severity: 60, hits: 1, description: 'If you can read this, the channel works.',
    last_seen: t });
  chk('a test alert sends', sent.length === 1);
  chk('a test alert links no record that does not exist',
    !sent[0].html.includes('?event=0') && !sent[0].html.includes('?case=0'), 'linked id 0');
  chk('… it links the app instead', sent[0].html.includes('https://opscat.test/app/monitor'));
  chk('… and renders no First seen row it does not have', !sent[0].html.includes('First seen'));

  // -- an event whose two instants are equal must not repeat itself
  sent.length = 0;
  await alerts.dispatch(rule, { ...ev, hits: 1, first_seen: t, last_seen: t });
  chk('one hit renders First seen but not Last seen',
    sent[0].html.includes('First seen') && !sent[0].html.includes('Last seen'));

  // -- the severity rail follows the event, not a constant
  sent.length = 0;
  await alerts.dispatch(rule, { ...ev, severity: 92 });
  chk('a critical event gets the critical rail', sent[0].html.includes('#f85149'));
  chk('… and says so in words', sent[0].html.includes('CRITICAL 92'));
  chk('… and in the header', sent[0].headers['X-OpsCat-Severity'] === '92');

  // -- a rule with no recipients must refuse rather than send to nobody
  sent.length = 0;
  let refused = null;
  try { await alerts.dispatch({ ...rule, recipients: '[]' }, ev); } catch (e) { refused = e.message; }
  chk('a rule with no recipients is refused', /no e-mail recipients/.test(refused || ''), String(refused));
  chk('… and nothing was sent', sent.length === 0);

  // -- the avatar reaches the real dispatch
  const orgAvatar = require('./src/lib/org-avatar');
  sent.length = 0;
  await alerts.dispatch(rule, ev);
  const wantIni = orgAvatar.initials(orgAvatar.displayName(org.id, null));
  chk('a rule mail carries the org badge', sent[0].html.includes(`>${wantIni}</td>`), 'no initials in the mail');
  chk('…and loads nothing remote', !/<img/i.test(sent[0].html));

  // An org that HAS uploaded one still gets initials in the mail — the upload
  // is for the surfaces a browser fetches. If this check ever goes red, the
  // decision in lib/alert-mail.js `avatarCell` was reversed without reading it.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const put = await orgAvatar.putAvatar(org.id, Buffer.concat([png, Buffer.alloc(200, 7)]));
  chk('an avatar can be stored for the dispatch check', put.ok === true, JSON.stringify(put));
  sent.length = 0;
  await alerts.dispatch(rule, ev);
  chk('an uploaded avatar does NOT become a remote image in the mail',
    !/<img/i.test(sent[0].html), 'an <img> reached a mail');
  chk('…and the badge is still there', sent[0].html.includes(`>${wantIni}</td>`));
  await orgAvatar.deleteAvatar(org.id);

  // ── 3. the on-call chain's mail, same shell, its own content ─────────────
  sent.length = 0;
  await alerts.sendVia('email', 'oncall@example.com', {
    title: '[OpsCat ALERT] C-1010 host_cpu_high on webundco',
    text: 'host_cpu_high on webundco\n\nSeverity: 62 (High)\nUrgency: high',
    severity: 62, orgId: org.id,
    mail: {
      headline: 'host_cpu_high on webundco',
      facts: [{ label: 'Case', value: 'C-1010' }, { label: 'Urgency', value: 'high' },
        { label: 'Escalation', value: 'step 1' }],
      primary: { label: 'Acknowledge this alert', url: 'https://opscat.test/a/tok123' },
      secondary: { label: 'Open C-1010', url: 'https://opscat.test/app/cases' },
      footer: 'Acknowledging stops the escalation.',
    },
  });
  chk('the on-call mail uses the same shell', sent.length === 1 && sent[0].html.includes('HIGH 62'));
  chk('the acknowledgement is a button, not a URL inside a paragraph',
    sent[0].html.includes('href="https://opscat.test/a/tok123"'));
  chk('the escalation step is a fact', sent[0].html.includes('Escalation') && sent[0].html.includes('step 1'));
  chk('it carries a text part too', sent[0].text.includes('https://opscat.test/a/tok123'));
  chk('the mail warns that the link asks before acknowledging',
    /confirm|Acknowledging stops/.test(sent[0].html));

  // A caller that passes no `mail` still gets the shell rather than a <pre>.
  sent.length = 0;
  await alerts.sendVia('email', 'oncall@example.com', {
    title: '[OpsCat] test notification', text: 'This is a test from OpsCat.',
    severity: 40, orgId: org.id,
  });
  chk('a caller with only a message still gets the layout',
    sent[0].html.includes('MEDIUM 40') && sent[0].html.includes('This is a test from OpsCat.'));
  chk('… and no bare <pre> is left anywhere', !/<pre/i.test(sent[0].html));
}

async function main() {
  builderChecks();
  await dispatchChecks();
  report();
}

main().catch(die);
