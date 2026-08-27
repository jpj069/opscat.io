'use strict';
/**
 * Syslog wire formats: framing and parsing, as pure functions.
 *
 * ── Why this is a library and not part of the collector ──────────────────────
 *
 * The collector runs in the customer's network and the server needs the same
 * answers — for the config preview, for the harness, and for anything that ever
 * has to explain what a line was understood as. A parser that exists twice
 * drifts, and the copy that drifts is the one running where nobody can look at
 * it. So: one module, no sockets, no state beyond what a caller hands in.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not truncate to the pipeline's limits (8192 for a line, 100 for a
 * device). `engine/pipeline.js` owns those and applies them to every ingest
 * path; repeating them here would be a second place to change them and a
 * different answer the day one moves. What this module caps is the FRAME, which
 * is a memory bound on unauthenticated network input and belongs at the wire.
 *
 * References: RFC 5424 (syslog), RFC 3164 (BSD syslog, "the old one"),
 * RFC 6587 §3.4.1 (octet counting) and §3.4.2 (non-transparent / LF framing).
 */

/** Hard bound on a single frame. A syslog message is not a file transfer, and
 *  this is the only thing standing between a hostile sender and unbounded
 *  buffering in a process that has not authenticated anyone yet. */
const MAX_FRAME = 64 * 1024;

/** Longest plausible octet-count prefix. Ten digits is a 9.9 GB message; a
 *  sender that writes more than that is not octet-counting, it is desynced. */
const MAX_LEN_DIGITS = 10;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6,
  Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Syslog severity of a line nobody told us about. 6 = informational. */
const DEFAULT_SEV = 6;

// ── PRI ─────────────────────────────────────────────────────────────────────

/**
 * `<190>rest` → { facility: 23, severity: 6, rest: 'rest' }.
 *
 * facility is `pri >> 3` and severity is `pri & 7`. Swapping the two is the
 * single most likely mistake in this file and it is not visible in the output:
 * both are small integers, and a line that should be `critical` merely looks
 * like the wrong facility to anyone reading it later.
 *
 * @param {string} s
 * @returns {{facility:number, severity:number, rest:string}|null}
 */
function parsePri(s) {
  if (typeof s !== 'string' || s.charCodeAt(0) !== 60 /* < */) return null;
  const end = s.indexOf('>', 1);
  if (end < 2 || end > 4) return null;               // '<0>' .. '<191>'
  const digits = s.slice(1, end);
  if (!/^[0-9]{1,3}$/.test(digits)) return null;
  const pri = Number(digits);
  if (pri > 191) return null;                        // 23 facilities x 8 severities
  return { facility: pri >> 3, severity: pri & 7, rest: s.slice(end + 1) };
}

// ── RFC 5424 ────────────────────────────────────────────────────────────────

const NIL = '-';
const nil = (v) => (v === NIL || v === '' ? null : v);

/**
 * Parse the structured-data section, starting at `i`.
 * Returns the raw text, a map of SD-ID → params, and where the section ended.
 * @param {string} s @param {number} i
 */
function parseSd(s, i) {
  /** @type {Record<string, Record<string, string>>} */
  const params = {};
  if (s[i] === NIL) return { sd: null, params, end: i + 1 };
  if (s[i] !== '[') return null;
  const start = i;
  while (s[i] === '[') {
    i += 1;
    const idStart = i;
    while (i < s.length && s[i] !== ' ' && s[i] !== ']') i += 1;
    const id = s.slice(idStart, i);
    if (!id) return null;
    const kv = {};
    while (s[i] === ' ') {
      i += 1;
      const kStart = i;
      while (i < s.length && s[i] !== '=' && s[i] !== ']') i += 1;
      if (s[i] !== '=') return null;
      const key = s.slice(kStart, i);
      i += 1;
      if (s[i] !== '"') return null;
      i += 1;
      let val = '';
      // Inside a PARAM-VALUE only `"`, `\` and `]` are escaped (RFC 5424 §6.3.3),
      // and a backslash before anything else is a literal backslash.
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\' || s[i + 1] === ']')) {
          val += s[i + 1]; i += 2;
        } else { val += s[i]; i += 1; }
      }
      if (s[i] !== '"') return null;                 // unterminated value
      i += 1;
      kv[key] = val;
    }
    if (s[i] !== ']') return null;
    i += 1;
    params[id] = Object.assign(params[id] || {}, kv);
  }
  return { sd: s.slice(start, i), params, end: i };
}

/**
 * `<PRI>1 TIMESTAMP HOST APP PROCID MSGID SD [MSG]`
 * @param {string} line
 * @returns {{severity:number, facility:number, ts:number|null, host:string|null,
 *   app:string|null, procid:string|null, msgid:string|null, sd:string|null,
 *   params:Record<string,Record<string,string>>, msg:string}|null}
 */
function parse5424(line) {
  const pri = parsePri(line);
  if (!pri) return null;
  const s = pri.rest;
  if (s[0] !== '1' || s[1] !== ' ') return null;     // VERSION is 1, and only 1
  const parts = [];
  let i = 2;
  for (let f = 0; f < 5; f += 1) {                   // ts host app procid msgid
    const sp = s.indexOf(' ', i);
    if (sp < 0) return null;
    parts.push(s.slice(i, sp));
    i = sp + 1;
  }
  const sd = parseSd(s, i);
  if (!sd) return null;
  i = sd.end;
  if (i < s.length && s[i] !== ' ') return null;     // SD must be followed by SP or end
  let msg = i < s.length ? s.slice(i + 1) : '';
  if (msg.charCodeAt(0) === 0xfeff) msg = msg.slice(1);  // decoded UTF-8 BOM
  const tsRaw = nil(parts[0]);
  const ts = tsRaw ? Date.parse(tsRaw) : NaN;
  return {
    severity: pri.severity, facility: pri.facility,
    ts: Number.isFinite(ts) ? ts : null,
    host: nil(parts[1]), app: nil(parts[2]), procid: nil(parts[3]), msgid: nil(parts[4]),
    sd: sd.sd, params: sd.params, msg,
  };
}

// ── RFC 3164 ────────────────────────────────────────────────────────────────

/**
 * `<PRI>Mmm d hh:mm:ss HOST TAG: MSG`
 *
 * The timestamp carries NO YEAR, so one has to be inferred against a reference
 * instant. Taking the reference's year unconditionally is wrong for exactly one
 * week a year: on 1 January a line stamped `Dec 31 23:59:58` becomes a
 * timestamp eleven months in the future, which the pipeline then rejects as
 * implausible and silently rewrites to "now". Hence the look-back below.
 *
 * @param {string} line @param {number} [ref] reference instant, ms
 */
function parse3164(line, ref = Date.now()) {
  const pri = parsePri(line);
  if (!pri) return null;
  const s = pri.rest;
  const m = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) /.exec(s);
  if (!m || !(m[1] in MONTHS)) return null;
  const refDate = new Date(ref);
  let ts = Date.UTC(refDate.getUTCFullYear(), MONTHS[m[1]], Number(m[2]),
    Number(m[3]), Number(m[4]), Number(m[5]));
  // More than a day ahead of the reference ⇒ it is last year's December.
  if (ts > ref + 24 * 3600 * 1000) ts = Date.UTC(refDate.getUTCFullYear() - 1,
    MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  const after = s.slice(m[0].length);
  const sp = after.indexOf(' ');
  if (sp < 0) return null;
  const host = after.slice(0, sp);
  const rest = after.slice(sp + 1);
  // TAG is up to 32 alphanumerics, optionally `[pid]`, terminated by `:` or space.
  const tm = /^([A-Za-z0-9_./-]{1,32})(\[\d{1,10}\])?: ?/.exec(rest);
  return {
    severity: pri.severity, facility: pri.facility, ts, host: host || null,
    app: tm ? tm[1] : null,
    procid: tm && tm[2] ? tm[2].slice(1, -1) : null,
    msgid: null, sd: null, params: {},
    msg: tm ? rest.slice(tm[0].length) : rest,
  };
}

// ── the one entry point a caller should need ────────────────────────────────

/**
 * RFC 5424, else RFC 3164, else the raw line.
 *
 * A line that parses as neither is NOT an error and is never dropped: an
 * appliance that writes something of its own is exactly the kind of device the
 * customer bought this product to watch. It becomes a line at the default
 * severity, with `format: 'raw'` so a reader can see why it has no metadata.
 *
 * @param {string} line @param {{ref?:number}} [opts]
 */
function parse(input, opts = {}) {
  const ref = opts.ref === undefined ? Date.now() : opts.ref;
  /* Trailing CR/LF/NUL is FRAMING that came along for the ride, and it belongs
   * to none of the three formats below. Three senders produce it and all three
   * are correct:
   *
   *   * a UDP datagram — the message is the datagram, and plenty of devices
   *     terminate it anyway;
   *   * RFC 6587 octet counting, whose length legitimately COVERS the trailing
   *     newline, so the framer hands it over intact;
   *   * LF framing from a sender that uses CRLF, which leaves the CR behind.
   *
   * Stripping it here rather than at each socket is the difference between one
   * rule and three. It matters more than it looks: the character is invisible
   * in every UI, and two devices sending the same line with and without it
   * become two different dedupe keys and two different Scout templates. Found
   * by `e2e-tunnel`, on the UDP path, where the datagram carried its own LF.
   *
   * Only the END is touched. Leading whitespace is content — a forwarded stack
   * trace's `    at Foo.bar` is the same lesson the app-name separator taught. */
  const line = String(input).replace(/[\r\n\0]+$/, '');
  const p5 = parse5424(line);
  if (p5) return Object.assign(p5, { format: 'rfc5424' });
  const p3 = parse3164(line, ref);
  if (p3) return Object.assign(p3, { format: 'rfc3164' });
  const pri = parsePri(line);
  return {
    severity: pri ? pri.severity : DEFAULT_SEV,
    facility: pri ? pri.facility : null,
    ts: null, host: null, app: null, procid: null, msgid: null,
    sd: null, params: {}, msg: pri ? pri.rest : line, format: 'raw',
  };
}

/**
 * A parsed message as `/v1/ingest/logs` wants it.
 *
 * `device` falls back to the peer address, because a host field is optional in
 * both formats and a line attributed to "unknown" is a line nobody can find
 * again. `sev` is the syslog severity unchanged — the pipeline's SYSLOG_FLOOR
 * already speaks this scale, which is why nothing is mapped here.
 *
 * @param {ReturnType<parse>} p
 * @param {{peer?:string, prefix?:string, raw?:string}} [ctx]
 */
function toIngestEntry(p, ctx = {}) {
  const host = p.host || ctx.peer || 'unknown';
  const device = (ctx.prefix || '') + host;
  const meta = { format: p.format };
  if (p.facility !== null && p.facility !== undefined) meta.facility = p.facility;
  if (p.app) meta.app = p.app;
  if (ctx.peer) meta.peer = ctx.peer;
  /* `${app}: ${msg}` would produce TWO spaces for most real senders, and that is
   * not a cosmetic detail — it is what a live rsyslog relay actually emits.
   * rsyslog's `%msg%` keeps the space that separated the tag from the text, so a
   * forwarded RFC 5424 message arrives as APP-NAME=`kernel`, MSG=` interface
   * down`. Found by running a real relay against the collector; no fixture in
   * the harness had a leading space, so nothing caught it.
   *
   * The separator is therefore added only when the message does not already
   * bring one. Stripping instead would be wrong: a forwarded Java stack trace's
   * continuation line is `    at Foo.bar`, and its indentation is content. */
  const body = p.app && p.format !== 'raw'
    ? `${p.app}:${p.msg.startsWith(' ') ? '' : ' '}${p.msg}`
    : p.msg;
  return {
    device,
    line: body,
    sev: p.severity,
    ts: p.ts === null ? undefined : p.ts,
    meta,
  };
}

/** Read one param out of parsed structured data, e.g. sdParam(p, 'opscat@59321', 'token'). */
function sdParam(p, sdId, key) {
  const el = p && p.params ? p.params[sdId] : null;
  return el && typeof el[key] === 'string' ? el[key] : null;
}

// ── TCP framing ─────────────────────────────────────────────────────────────

/**
 * Turns a TCP byte stream into messages.
 *
 * Two framings exist and both are in the wild:
 *   octet counting (RFC 6587 §3.4.1)  `123 <190>1 2026-…`
 *   LF-delimited   (RFC 6587 §3.4.2)  `<190>1 2026-…\n`
 *
 * The mode is decided from the FIRST byte of the connection and then LOCKED. It
 * cannot be re-sniffed per message: a message whose payload happens to begin
 * with a digit would flip a per-message sniffer into octet mode, and from there
 * every subsequent boundary is wrong — a desync that looks like corrupted data
 * rather than like a bug.
 *
 * `push()` is the only method that matters and it is written for the case that
 * breaks naive implementations: a frame arriving in pieces. Nothing may assume
 * that one `data` event is one message, or even one whole length prefix.
 */
class Framer {
  /** @param {{maxFrame?:number}} [opts] */
  constructor(opts = {}) {
    this.buf = '';
    this.mode = null;                 // 'octet' | 'lf', locked on first byte
    this.maxFrame = opts.maxFrame || MAX_FRAME;
    this.truncated = 0;               // frames cut to maxFrame — counted, never silent
    this.error = null;                // set once; the caller closes the connection
  }

  /**
   * @param {string|Buffer} chunk
   * @returns {string[]} complete messages, in arrival order (possibly empty)
   */
  push(chunk) {
    if (this.error) return [];
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.mode === null) {
      const c = this.buf[0];
      if (c === undefined) return [];
      this.mode = c >= '0' && c <= '9' ? 'octet' : 'lf';
    }
    return this.mode === 'octet' ? this._octet() : this._lf();
  }

  _lf() {
    const out = [];
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let msg = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (msg.endsWith('\r')) msg = msg.slice(0, -1);
      if (msg) out.push(msg);
    }
    // An unterminated remainder larger than the cap is a sender that will never
    // send the newline. Cut it loose rather than buffering it forever.
    if (this.buf.length > this.maxFrame) {
      out.push(this.buf.slice(0, this.maxFrame));
      this.truncated += 1;
      this.buf = '';
    }
    return out;
  }

  _octet() {
    const out = [];
    for (;;) {
      const sp = this.buf.indexOf(' ');
      if (sp < 0) {
        if (this.buf.length > MAX_LEN_DIGITS) this.error = 'octet-counted frame without a length';
        return out;
      }
      const digits = this.buf.slice(0, sp);
      if (!/^[0-9]{1,10}$/.test(digits)) { this.error = 'invalid octet count'; return out; }
      const len = Number(digits);
      if (len > this.maxFrame) { this.error = `frame of ${len} exceeds ${this.maxFrame}`; return out; }
      if (this.buf.length < sp + 1 + len) return out;          // the rest is still in flight
      out.push(this.buf.slice(sp + 1, sp + 1 + len));
      this.buf = this.buf.slice(sp + 1 + len);
    }
  }
}

/**
 * The same lookup, but matching an SD-ID by its NAME and ignoring the private
 * enterprise number after the `@`.
 *
 * RFC 5424 §7.2 makes a custom SD-ID `name@<PEN>`, so `[opscat@32473 …]` and
 * `[opscat@59321 …]` are two spellings of one element as far as a reader is
 * concerned — and which number we own is a fact about a registry application,
 * not about the message. Matching the exact string would mean that the day the
 * PEN we print changes, every relay already configured stops being understood,
 * with no error anywhere: the token would simply not be found and the lines
 * would arrive unattributed.
 *
 * Same reasoning as the credential namespace's rule that no auth guard may test
 * a prefix (`lib/tokens.js`): what we hand out may be re-spelled, so nothing
 * that has to keep working may depend on the spelling.
 *
 * @param {*} p a parsed message
 * @param {string} name the SD-ID's name part, e.g. `opscat`
 * @param {string} key the parameter to read
 * @returns {string|null}
 */
function sdParamAny(p, name, key) {
  if (!p || !p.params) return null;
  const at = `${name}@`;
  for (const id of Object.keys(p.params)) {
    if (id !== name && !id.startsWith(at)) continue;
    const v = p.params[id][key];
    if (typeof v === 'string') return v;
  }
  return null;
}

module.exports = {
  MAX_FRAME, DEFAULT_SEV,
  parsePri, parse5424, parse3164, parseSd, parse, toIngestEntry, sdParam, sdParamAny, Framer,
};
