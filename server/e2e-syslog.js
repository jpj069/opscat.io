'use strict';
/* Syslog wire formats: framing and parsing.
 *
 * Boots no server, needs no port and no database.  cd server && node e2e-syslog.js
 *
 * ── Why this exists before a single socket does ─────────────────────────────
 *
 * The collector's job splits cleanly in two: understanding bytes, and moving
 * them. Only the first half has right answers that can be written down, and it
 * is also the half whose mistakes are INVISIBLE downstream — a line parsed with
 * facility and severity swapped is still a line, still ingested, still
 * searchable, and merely wrong about how urgent it was. Nothing further down
 * the pipeline can contradict it, because by then the wire format is gone.
 *
 * So the parser gets its harness first, and the listener is written against a
 * library that is already known to be right.
 *
 * ── The three failure modes it is actually built around ─────────────────────
 *
 * 1. `pri >> 3` and `pri & 7` swapped. Both are small integers, both look
 *    plausible in a debugger, and the product's whole severity ladder hangs off
 *    the second one (`SYSLOG_FLOOR` in engine/pipeline.js turns severity 0 into
 *    a score of 92, i.e. a case). Checked as a round trip against that table
 *    rather than as an isolated number, because the isolated number is exactly
 *    what a swap keeps looking correct as.
 *
 * 2. A frame split across TCP segments. `push()` is written against the case
 *    that one `data` event is neither one message nor one whole length prefix.
 *    Every octet-counting bug ever written passes a test that hands it a whole
 *    frame in one call, so the checks below feed the same bytes ONE AT A TIME
 *    and demand the identical result.
 *
 * 3. The year that RFC 3164 does not carry. Taking the current year is right
 *    for 51 weeks and wrong in the one that matters: on 1 January a line
 *    stamped `Dec 31 23:59:58` lands eleven months in the future, the pipeline
 *    rejects it as implausible and silently rewrites it to "now" — so the
 *    symptom is not an error, it is a New Year's Eve that has no logs.
 */
const { chk, report, die } = require('./e2e-lib').harness();
const sl = require('./src/lib/syslog');

// The floor table this parser feeds. Copied deliberately: if pipeline.js changes
// it, this harness should be re-read, not silently follow.
const SYSLOG_FLOOR = [92, 88, 82, 55, 35, 15, 0, 0];

// ── 1. PRI ──────────────────────────────────────────────────────────────────
function pri() {
  const p = sl.parsePri('<190>rest');
  chk('PRI splits into facility and severity', p && p.facility === 23 && p.severity === 6,
    JSON.stringify(p));
  chk('PRI keeps the remainder', p && p.rest === 'rest');

  // 191 = facility 23, severity 7. If the two were swapped this would still be
  // two small numbers, which is why the pair is asserted and not one of them.
  const hi = sl.parsePri('<191>x');
  chk('the top of the range is facility 23 / severity 7', hi && hi.facility === 23 && hi.severity === 7);
  const lo = sl.parsePri('<0>x');
  chk('<0> is kernel/emergency, not null', lo && lo.facility === 0 && lo.severity === 0);

  chk('a local7.debug line is severity 7', sl.parsePri('<191>x').severity === 7);
  chk('a local0.crit line is severity 2', sl.parsePri('<130>x').severity === 2);

  chk('192 is out of range and refused', sl.parsePri('<192>x') === null);
  chk('a non-numeric PRI is refused', sl.parsePri('<abc>x') === null);
  chk('an empty PRI is refused', sl.parsePri('<>x') === null);
  chk('an unterminated PRI is refused', sl.parsePri('<190 no close') === null);
  chk('a line without a PRI is refused', sl.parsePri('plain text') === null);
  chk('a non-string is refused rather than throwing', sl.parsePri(null) === null);
}

// ── 2. RFC 5424 ─────────────────────────────────────────────────────────────
function rfc5424() {
  const line = '<165>1 2026-08-20T14:31:02.123Z fw-fra-01 sshd 4711 ID47 '
    + '[opscat@59321 token="ocl_deadbeef"] Failed password for root';
  const p = sl.parse5424(line);
  chk('a full RFC 5424 message parses', !!p);
  chk('  … severity', p && p.severity === 5);
  chk('  … timestamp becomes epoch ms',
    p && p.ts === Date.parse('2026-08-20T14:31:02.123Z'), p && String(p.ts));
  chk('  … hostname', p && p.host === 'fw-fra-01');
  chk('  … app-name', p && p.app === 'sshd');
  chk('  … procid', p && p.procid === '4711');
  chk('  … msgid', p && p.msgid === 'ID47');
  chk('  … message body', p && p.msg === 'Failed password for root');
  chk('  … structured data is addressable',
    sl.sdParam(p, 'opscat@59321', 'token') === 'ocl_deadbeef');

  const niled = sl.parse5424('<34>1 2026-08-20T14:31:02Z - - - - - just a message');
  chk('NILVALUE fields become null, not the string "-"',
    niled && niled.host === null && niled.app === null && niled.procid === null
    && niled.msgid === null && niled.sd === null, JSON.stringify(niled));
  chk('a NILVALUE-heavy message still carries its text', niled && niled.msg === 'just a message');

  const noMsg = sl.parse5424('<34>1 2026-08-20T14:31:02Z host app - - -');
  chk('a message with no MSG at all parses to an empty body', noMsg && noMsg.msg === '');

  const bom = sl.parse5424('<34>1 2026-08-20T14:31:02Z h a - - - ﻿with a BOM');
  chk('the UTF-8 BOM is stripped from MSG', bom && bom.msg === 'with a BOM', bom && bom.msg);

  // Escaping inside a param value is where a hand-rolled SD parser goes wrong,
  // and a token is exactly the kind of value that contains one of these.
  const esc = sl.parse5424('<34>1 - - - - - [x@1 k="a\\"b" j="c\\]d" l="e\\\\f"] m');
  chk('an escaped quote inside structured data', sl.sdParam(esc, 'x@1', 'k') === 'a"b');
  chk('an escaped bracket inside structured data', sl.sdParam(esc, 'x@1', 'j') === 'c]d');
  chk('an escaped backslash inside structured data', sl.sdParam(esc, 'x@1', 'l') === 'e\\f');
  chk('a message following structured data is not swallowed by it', esc && esc.msg === 'm');

  const two = sl.parse5424('<34>1 - - - - - [a@1 x="1"][b@2 y="2"] body');
  chk('two structured-data elements both parse',
    sl.sdParam(two, 'a@1', 'x') === '1' && sl.sdParam(two, 'b@2', 'y') === '2');

  /* The managed gateway reads the tenant's key out of `[opscat@<PEN> …]`, and
   * the PEN is a fact about a registry application rather than about the
   * message: ours is applied for and not yet assigned, so what we print today
   * and what we print next month differ. Matching the exact SD-ID would mean
   * every relay configured before the assignment silently stops being
   * understood — no error, no rejected message, just lines arriving with nobody
   * to attribute them to. `sdParamAny` matches the NAME and ignores the number,
   * which is the same rule `lib/tokens.js` states for credential prefixes: what
   * we hand out may be re-spelled, so nothing that must keep working may depend
   * on the spelling. */
  const pen0 = sl.parse5424('<34>1 - - - - - [opscat@0 token="ocl_one"] body');
  const pen32 = sl.parse5424('<34>1 - - - - - [opscat@32473 token="ocl_two"] body');
  chk('the placeholder enterprise number resolves',
    sl.sdParamAny(pen0, 'opscat', 'token') === 'ocl_one');
  chk('a different enterprise number resolves identically',
    sl.sdParamAny(pen32, 'opscat', 'token') === 'ocl_two');
  chk('the exact-match lookup would NOT have found the second one',
    sl.sdParam(pen32, 'opscat@0', 'token') === null);
  chk('another vendor\'s element with our parameter name is not ours',
    sl.sdParamAny(sl.parse5424('<34>1 - - - - - [logtail@11993 token="x"] b'), 'opscat', 'token') === null);
  chk('a name that merely starts the same is not ours',
    sl.sdParamAny(sl.parse5424('<34>1 - - - - - [opscatx@0 token="x"] b'), 'opscat', 'token') === null);
  chk('ours is found beside somebody else\'s',
    sl.sdParamAny(sl.parse5424('<34>1 - - - - - [origin sw="x"][opscat@9 token="ocl_three"] b'),
      'opscat', 'token') === 'ocl_three');
  chk('a missing parameter is null rather than undefined',
    sl.sdParamAny(pen0, 'opscat', 'nope') === null);
  chk('a message with no structured data at all is null',
    sl.sdParamAny(sl.parse5424('<34>1 - - - - - - b'), 'opscat', 'token') === null);

  /* Trailing framing, which belongs to no format and reaches `parse` from three
   * correct senders: a UDP datagram that terminates itself, an RFC 6587 frame
   * whose octet count legitimately covers the newline, and an LF-framed sender
   * that uses CRLF. Found by `e2e-tunnel` — the stored line was
   * `"…marker\n"`, which is invisible in every UI and silently makes two
   * senders of the same line into two dedupe keys and two Scout templates. */
  const term = (raw) => sl.toIngestEntry(sl.parse(raw)).line;
  chk('a trailing newline is not part of the message',
    term('<134>1 2026-08-23T15:00:00Z h a - - - hello\n') === 'a: hello');
  chk('...nor a CRLF', term('<134>1 2026-08-23T15:00:00Z h a - - - hello\r\n') === 'a: hello');
  chk('...nor a trailing NUL', term('<134>1 2026-08-23T15:00:00Z h a - - - hello\0') === 'a: hello');
  chk('...nor several of them', term('<134>1 2026-08-23T15:00:00Z h a - - - hello\r\n\r\n') === 'a: hello');
  chk('the same holds for RFC 3164', term('<13>Aug 23 15:00:00 h tag: hi\n') === 'tag: hi');
  chk('...and for a line nothing can parse', term('unparsable line\n') === 'unparsable line');
  /* Only the END. A forwarded stack trace's continuation line is indented, and
   * that indentation is content — the same lesson the app-name separator
   * taught, learned from a live relay. */
  chk('leading whitespace is content and survives',
    term('<134>1 - - a - - -     at Foo.bar\n').endsWith(':    at Foo.bar'),
    JSON.stringify(term('<134>1 - - a - - -     at Foo.bar\n')));
  chk('a message that is ONLY a newline collapses to empty rather than to a stray line',
    term('<134>1 - - a - - - \n') === 'a: ');

  chk('an unterminated param value is refused, not half-parsed',
    sl.parse5424('<34>1 - - - - - [x@1 k="unterminated] m') === null);
  chk('version 2 is refused (there is no version 2)',
    sl.parse5424('<34>2 - - - - - m') === null);
  chk('a truncated header is refused', sl.parse5424('<34>1 - -') === null);
  // Guarded rather than dereferenced: without the `!!ts &&` a regression that
  // makes this return null kills the RUN with a TypeError instead of failing the
  // one check it is about, and a harness that dies reports nothing at all.
  const ts = sl.parse5424('<34>1 not-a-date h a - - - m');
  chk('an unparsable timestamp yields null rather than NaN', !!ts && ts.ts === null);
  chk('  … and the rest of the message is still parsed', !!ts && ts.msg === 'm');
}

// ── 3. RFC 3164 ─────────────────────────────────────────────────────────────
function rfc3164() {
  const ref = Date.parse('2026-08-20T12:00:00Z');
  const p = sl.parse3164('<34>Aug 20 09:47:14 core-sw-01 sshd[1234]: Failed password', ref);
  chk('a BSD-syslog line parses', !!p);
  chk('  … severity survives', p && p.severity === 2);
  chk('  … hostname', p && p.host === 'core-sw-01');
  chk('  … tag becomes app-name', p && p.app === 'sshd');
  chk('  … the bracketed pid becomes procid', p && p.procid === '1234');
  chk('  … the colon and its space are not part of the message',
    p && p.msg === 'Failed password', p && JSON.stringify(p.msg));
  chk('  … the year is taken from the reference instant',
    p && p.ts === Date.parse('2026-08-20T09:47:14Z'), p && new Date(p.ts).toISOString());

  // Day 1..9 is SPACE-padded in RFC 3164, which is a second space in the format
  // and the most common reason a regex written from the prose fails.
  const pad = sl.parse3164('<34>Aug  3 01:02:03 h app: m', ref);
  chk('a single-digit day is space-padded and still parses',
    pad && pad.ts === Date.parse('2026-08-03T01:02:03Z'), pad && String(pad.ts));

  const noTag = sl.parse3164('<34>Aug 20 09:47:14 host just a message', ref);
  chk('a line with no tag keeps its whole text',
    noTag && noTag.app === null && noTag.msg === 'just a message', noTag && noTag.msg);

  // THE new-year check. Reference is 1 Jan, the line is from 31 Dec.
  const ny = sl.parse3164('<34>Dec 31 23:59:58 h app: m', Date.parse('2027-01-01T00:00:04Z'));
  chk('a December line read on 1 January belongs to LAST year',
    ny && ny.ts === Date.parse('2026-12-31T23:59:58Z'), ny && new Date(ny.ts).toISOString());
  chk('  … and is in the past, which is what the pipeline requires',
    ny && ny.ts < Date.parse('2027-01-01T00:00:04Z'));

  // The converse must not over-correct: an ordinary line minutes old stays put.
  const same = sl.parse3164('<34>Aug 20 11:59:00 h app: m', ref);
  chk('an ordinary recent line is not pushed back a year',
    same && same.ts === Date.parse('2026-08-20T11:59:00Z'));

  chk('a month that does not exist is refused',
    sl.parse3164('<34>Foo 20 09:47:14 h app: m', ref) === null);
  chk('an RFC 5424 line is not mis-parsed as RFC 3164',
    sl.parse3164('<34>1 2026-08-20T14:31:02Z h a - - - m', ref) === null);
}

// ── 4. the fallback chain ───────────────────────────────────────────────────
function fallback() {
  const ref = Date.parse('2026-08-20T12:00:00Z');
  chk('a 5424 line is recognised as such',
    sl.parse('<34>1 2026-08-20T14:31:02Z h a - - - m', { ref }).format === 'rfc5424');
  chk('a 3164 line is recognised as such',
    sl.parse('<34>Aug 20 09:47:14 h app: m', { ref }).format === 'rfc3164');

  // A device that writes its own thing must not be dropped — that device is the
  // reason the customer runs a central relay in the first place.
  const raw = sl.parse('SOMETHING ENTIRELY OF ITS OWN', { ref });
  chk('an unparsable line is kept, not discarded', raw.format === 'raw' && raw.msg === 'SOMETHING ENTIRELY OF ITS OWN');
  chk('  … at the default severity', raw.severity === 6);
  chk('  … with no invented timestamp', raw.ts === null);

  const priOnly = sl.parse('<28>a line with a PRI and nothing else standard', { ref });
  chk('a PRI without a known body still yields its severity',
    priOnly.format === 'raw' && priOnly.severity === 4, JSON.stringify(priOnly.severity));
  chk('  … and the PRI is not left in the text',
    priOnly.msg === 'a line with a PRI and nothing else standard');
}

// ── 5. the shape the ingest endpoint takes ──────────────────────────────────
function ingestShape() {
  const ref = Date.parse('2026-08-20T12:00:00Z');
  const p = sl.parse('<165>1 2026-08-20T14:31:02Z fw-fra-01 sshd - - - denied', { ref });
  const e = sl.toIngestEntry(p, { peer: '10.0.0.9' });
  chk('device comes from the syslog hostname, not the peer', e.device === 'fw-fra-01');
  chk('the app name is kept in front of the line', e.line === 'sshd: denied');
  chk('severity passes through unmapped', e.sev === 5);
  chk('the timestamp passes through', e.ts === Date.parse('2026-08-20T14:31:02Z'));
  chk('the peer is recorded in meta for support questions', e.meta.peer === '10.0.0.9');

  // A hostname is optional in BOTH formats. Falling back to "unknown" would put
  // every such device in one bucket; the peer address at least identifies a box.
  const anon = sl.toIngestEntry(sl.parse('no pri, no host', { ref }), { peer: '10.0.0.9' });
  chk('a line with no hostname falls back to the peer address', anon.device === '10.0.0.9');
  const nothing = sl.toIngestEntry(sl.parse('no pri, no host', { ref }), {});
  chk('with neither, the device is "unknown" rather than empty', nothing.device === 'unknown');

  /* The separator between app-name and message, which a live relay got wrong
   * and no fixture here did. rsyslog forwards `kernel: interface down` as
   * APP-NAME=`kernel` with MSG=` interface down` — its `%msg%` keeps the space
   * that separated the tag — so composing `${app}: ${msg}` yields TWO. Found by
   * pointing a real rsyslog at the collector, not by reading the code. */
  const relayed = sl.parse('<187>1 2026-08-22T06:59:00Z core-sw-01 kernel - - -  interface Gi0/1 down');
  chk('a relay-style message keeps exactly one space after the app name',
    sl.toIngestEntry(relayed).line === 'kernel: interface Gi0/1 down',
    JSON.stringify(sl.toIngestEntry(relayed).line));
  const tight = sl.parse('<187>1 2026-08-22T06:59:00Z core-sw-01 kernel - - - interface Gi0/1 down');
  chk('… and a message without one gets a separator, not a missing space',
    sl.toIngestEntry(tight).line === 'kernel: interface Gi0/1 down');
  /* And the reason the fix adds rather than strips: indentation is CONTENT.
   * A forwarded stack trace's continuation line is the case that a naive
   * `trimStart()` would quietly flatten. */
  const trace = sl.parse('<187>1 2026-08-22T06:59:00Z h java - - -     at Foo.bar(Foo.java:42)');
  chk('an indented continuation line keeps its indentation',
    sl.toIngestEntry(trace).line === 'java:    at Foo.bar(Foo.java:42)',
    JSON.stringify(sl.toIngestEntry(trace).line));

  chk('a per-endpoint prefix is applied to the device',
    sl.toIngestEntry(sl.parse('<34>1 - h a - - - m'), { prefix: 'fra-' }).device === 'fra-h');

  chk('an unknown timestamp is omitted so the pipeline stamps arrival time',
    sl.toIngestEntry(sl.parse('raw', { ref })).ts === undefined);

  // The round trip that a facility/severity swap cannot survive: an emergency
  // line has to reach the floor that opens a case.
  const emerg = sl.parse('<0>1 - h a - - - the box is on fire');
  chk('an emergency line maps onto the score floor that opens a case',
    SYSLOG_FLOOR[sl.toIngestEntry(emerg).sev] === 92);
  const dbg = sl.parse('<191>1 - h a - - - chatty');
  chk('a debug line maps onto a floor of zero',
    SYSLOG_FLOOR[sl.toIngestEntry(dbg).sev] === 0);
  chk('every severity 0..7 indexes the floor table',
    [0, 1, 2, 3, 4, 5, 6, 7].every((s) => Number.isInteger(SYSLOG_FLOOR[s])));
}

// ── 6. TCP framing ──────────────────────────────────────────────────────────
function framing() {
  const M1 = '<190>1 2026-08-20T14:31:02Z h a - - - first';
  const M2 = '<190>1 2026-08-20T14:31:03Z h a - - - second';

  const lf = new sl.Framer();
  chk('LF framing: one message per line', JSON.stringify(lf.push(`${M1}\n${M2}\n`)) === JSON.stringify([M1, M2]));
  const crlf = new sl.Framer();
  chk('LF framing: a CRLF sender is handled', JSON.stringify(crlf.push(`${M1}\r\n`)) === JSON.stringify([M1]));
  const partial = new sl.Framer();
  chk('LF framing: an unterminated line yields nothing yet', partial.push('<190>1 par').length === 0);
  chk('LF framing: … and completes on the next chunk',
    JSON.stringify(partial.push('tial\n')) === JSON.stringify(['<190>1 partial']));
  const blank = new sl.Framer();
  chk('LF framing: empty lines are not emitted as messages',
    JSON.stringify(blank.push(`${M1}\n\n\n${M2}\n`)) === JSON.stringify([M1, M2]));

  const oct = new sl.Framer();
  const frame = (m) => `${Buffer.byteLength(m)} ${m}`;
  chk('octet counting: one whole frame',
    JSON.stringify(oct.push(frame(M1))) === JSON.stringify([M1]));
  chk('octet counting: two frames in one chunk',
    JSON.stringify(oct.push(frame(M1) + frame(M2))) === JSON.stringify([M1, M2]));

  // THE check this file exists for. Same bytes, one octet at a time: neither the
  // length prefix nor the payload arrives whole, and the result must be identical.
  const drip = new sl.Framer();
  const bytes = frame(M1) + frame(M2);
  const got = [];
  for (const ch of bytes) got.push(...drip.push(ch));
  chk('octet counting: a frame split across every possible boundary still reassembles',
    JSON.stringify(got) === JSON.stringify([M1, M2]), JSON.stringify(got));

  const dripLf = new sl.Framer();
  const got2 = [];
  for (const ch of `${M1}\n${M2}\n`) got2.push(...dripLf.push(ch));
  chk('LF framing: the same, byte by byte', JSON.stringify(got2) === JSON.stringify([M1, M2]));

  // Mode locking. A payload beginning with a digit must not flip an established
  // LF connection into octet counting — that desync looks like data corruption.
  const locked = new sl.Framer();
  locked.push(`${M1}\n`);
  chk('framing mode is decided once and locked',
    JSON.stringify(locked.push('404 not found\n')) === JSON.stringify(['404 not found']),
    JSON.stringify(locked.mode));

  const octLock = new sl.Framer();
  octLock.push(frame(M1));
  chk('an octet-counted connection stays octet-counted', octLock.mode === 'octet');

  // Memory bounds on unauthenticated input.
  const huge = new sl.Framer({ maxFrame: 64 });
  huge.push('99999 ');
  chk('an octet count above the cap is a protocol error, not an allocation',
    huge.error !== null, String(huge.error));
  chk('  … and the framer stops emitting once it has errored', huge.push('x').length === 0);

  const junk = new sl.Framer();
  junk.push('12345678901234567890');
  chk('a length prefix that never ends is refused', junk.error !== null);

  const runaway = new sl.Framer({ maxFrame: 32 });
  const out = runaway.push('x'.repeat(100));
  chk('an LF sender that never sends a newline is cut loose rather than buffered',
    out.length === 1 && out[0].length === 32 && runaway.truncated === 1,
    JSON.stringify({ n: out.length, t: runaway.truncated }));
  chk('  … and the truncation is counted, never silent', runaway.truncated === 1);

  const empty = new sl.Framer();
  chk('an empty chunk decides nothing and emits nothing',
    empty.push('').length === 0 && empty.mode === null);
}

// ── 7. end to end, as the collector will use it ─────────────────────────────
function endToEnd() {
  const wire = [
    '<134>1 2026-08-20T14:31:02Z fw-fra-01 firewall - - - deny tcp 10.0.0.1 -> 8.8.8.8',
    '<0>Aug 20 14:31:03 core-sw-01 kernel: thermal shutdown imminent',
    'a proprietary appliance line',
  ];
  const f = new sl.Framer();
  const msgs = f.push(wire.map((m) => `${Buffer.byteLength(m)} ${m}`).join(''));
  chk('three mixed-format messages frame out of one stream', msgs.length === 3);

  const entries = msgs.map((m) => sl.toIngestEntry(sl.parse(m), { peer: '10.0.0.9' }));
  chk('every message becomes an ingest entry — none is dropped', entries.length === 3);
  chk('the RFC 5424 device is its own hostname', entries[0].device === 'fw-fra-01');
  chk('the RFC 3164 device is its own hostname', entries[1].device === 'core-sw-01');
  chk('the unparsable one falls back to the peer', entries[2].device === '10.0.0.9');
  chk('the emergency line keeps severity 0 through the whole chain', entries[1].sev === 0);
  chk('  … which is the one that opens a case', SYSLOG_FLOOR[entries[1].sev] === 92);
  chk('every entry carries a non-empty line', entries.every((e) => e.line.length > 0));
  chk('every entry carries a severity the pipeline accepts',
    entries.every((e) => Number.isInteger(e.sev) && e.sev >= 0 && e.sev <= 7));
}

try {
  pri();
  rfc5424();
  rfc3164();
  fallback();
  ingestShape();
  framing();
  endToEnd();
  report();
} catch (e) {
  die(e);
}
