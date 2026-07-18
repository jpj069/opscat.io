'use strict';
/**
 * @opscat/sdk — dependency-free JavaScript client for the OpsCat ingest API.
 *
 * Works in Node >= 18 and modern browsers (uses the global `fetch`).
 * CommonJS module with default-import interop:
 *
 *   const OpsCat = require('@opscat/sdk');      // CJS
 *   import OpsCat from '@opscat/sdk';           // ESM (default)
 *
 * The client keeps an in-memory queue, ships logs in batches to
 * POST {endpoint}/v1/ingest/logs and events to POST {endpoint}/v1/ingest/events,
 * retries transient failures with backoff, and never throws into user code.
 */

// --- environment helpers ---------------------------------------------------
var GLOBAL = (typeof globalThis !== 'undefined') ? globalThis
  : (typeof self !== 'undefined') ? self
  : (typeof window !== 'undefined') ? window
  : (typeof global !== 'undefined') ? global
  : {};

var IS_NODE = (typeof process !== 'undefined') && !!(process.versions && process.versions.node);
var IS_BROWSER = (typeof window !== 'undefined') && (typeof document !== 'undefined');

// Original stderr writer captured at load time, before any console patching,
// so the default error reporter can never recurse into a captured console.
var _stderr = (function () {
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    var fn = console.error.bind(console);
    return function () { try { fn.apply(null, arguments); } catch (e) { /* ignore */ } };
  }
  return function () {};
})();

function defaultDevice() {
  try {
    if (IS_NODE) return require('os').hostname();
  } catch (e) { /* ignore */ }
  return IS_BROWSER ? 'browser' : 'app';
}

function sleep(ms) {
  return new Promise(function (resolve) {
    var t = setTimeout(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

// Syslog severities used by the level helpers.
var LEVELS = { debug: 7, info: 6, warn: 4, error: 3, critical: 2 };

// --- client ----------------------------------------------------------------
function OpsCat(options) {
  if (!(this instanceof OpsCat)) return new OpsCat(options);
  options = options || {};

  this.endpoint = String(options.endpoint || '').replace(/\/+$/, '');
  this.apiKey = options.apiKey || '';
  this.device = options.device || defaultDevice();
  this.flushIntervalMs = options.flushIntervalMs != null ? options.flushIntervalMs : 3000;
  this.maxBatch = clamp(options.maxBatch != null ? options.maxBatch : 100, 1, 500);
  this.maxQueue = options.maxQueue != null ? options.maxQueue : 5000;
  this.timeoutMs = options.timeoutMs != null ? options.timeoutMs : 15000;
  this.retryDelays = options.retryDelays || [1000, 4000, 10000]; // backoff between retries
  this.onError = typeof options.onError === 'function'
    ? options.onError
    : function (err) { _stderr('[opscat]', (err && err.message) || err); };

  this._fetch = options.fetch || (GLOBAL.fetch ? GLOBAL.fetch.bind(GLOBAL) : null);
  this._logs = [];      // queued log entries → batched to /v1/ingest/logs
  this._events = [];    // queued events → sent one-per-request to /v1/ingest/events
  this._closed = false;
  this._dropWarned = false;
  this._immediate = null;
  this._timer = null;
  this._origConsole = null;

  if (!this.endpoint) this._report(new Error('opscat: no endpoint configured'));
  if (!this.apiKey) this._report(new Error('opscat: no apiKey configured'));
  if (!this._fetch) this._report(new Error('opscat: global fetch unavailable (Node >= 18 or a browser required)'));

  // periodic flush timer — unref'ed so it never keeps a Node process alive
  if (this.flushIntervalMs > 0) {
    this._timer = setInterval(this._tick.bind(this), this.flushIntervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  // browser: best-effort flush when the page is hidden / unloaded
  if (IS_BROWSER) {
    var self = this;
    this._onVisibility = function () { if (document.visibilityState === 'hidden') self._flushBeacon(); };
    this._onPageHide = function () { self._flushBeacon(); };
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('pagehide', this._onPageHide);
  }
}

// --- public API ------------------------------------------------------------

OpsCat.prototype.log = function (line, opts) {
  opts = opts || {};
  try {
    if (this._closed) return;
    var entry = {
      ts: Date.now(),
      device: opts.device || this.device,
      line: String(line == null ? '' : line),
    };
    var sev = Number.isInteger(opts.sev) ? opts.sev : 6;
    entry.sev = clamp(sev, 0, 7);
    if (opts.meta !== undefined) entry.meta = opts.meta;
    if (Number.isFinite(opts.ts)) entry.ts = opts.ts;
    this._enqueue(entry, false);
  } catch (e) { this._report(e); }
};

OpsCat.prototype.debug = function (msg, meta) { this.log(msg, { sev: LEVELS.debug, meta: meta }); };
OpsCat.prototype.info = function (msg, meta) { this.log(msg, { sev: LEVELS.info, meta: meta }); };
OpsCat.prototype.warn = function (msg, meta) { this.log(msg, { sev: LEVELS.warn, meta: meta }); };
OpsCat.prototype.error = function (msg, meta) { this.log(msg, { sev: LEVELS.error, meta: meta }); };
OpsCat.prototype.critical = function (msg, meta) { this.log(msg, { sev: LEVELS.critical, meta: meta }); };

/**
 * Send a direct event to POST /v1/ingest/events.
 * @param {{name:string, severity?:number, device?:string, target?:string, description?:string, ip?:string, ts?:number}} ev
 */
OpsCat.prototype.event = function (ev) {
  ev = ev || {};
  try {
    if (this._closed) return;
    if (!ev.name) { this._report(new Error('opscat.event() requires a name')); return; }
    var item = {
      name: String(ev.name),
      device: ev.device || this.device,
      severity: Number.isFinite(ev.severity) ? clamp(Math.round(ev.severity), 0, 100) : 50,
    };
    if (ev.target != null) item.target = String(ev.target);
    if (ev.description != null) item.description = String(ev.description);
    if (ev.ip != null) item.ip = String(ev.ip);
    if (Number.isFinite(ev.ts)) item.ts = ev.ts;
    this._enqueue(item, true);
  } catch (e) { this._report(e); }
};

/**
 * Patch console.{debug,log,info,warn,error} to also ship to OpsCat while
 * preserving the original console behavior. Returns a function that restores
 * the original console methods.
 */
OpsCat.prototype.captureConsole = function (targetConsole) {
  var con = targetConsole || (typeof console !== 'undefined' ? console : null);
  if (!con || this._origConsole) return function () {};
  var self = this;
  var map = { debug: LEVELS.debug, log: LEVELS.info, info: LEVELS.info, warn: LEVELS.warn, error: LEVELS.error };
  var orig = {};
  Object.keys(map).forEach(function (method) {
    if (typeof con[method] !== 'function') return;
    orig[method] = con[method];
    con[method] = function () {
      try { orig[method].apply(con, arguments); } catch (e) { /* ignore */ }
      try { self.log(formatArgs(arguments), { sev: map[method] }); } catch (e) { /* ignore */ }
    };
  });
  this._origConsole = { con: con, orig: orig };
  return function () { self.restoreConsole(); };
};

OpsCat.prototype.restoreConsole = function () {
  if (!this._origConsole) return;
  var con = this._origConsole.con;
  var orig = this._origConsole.orig;
  Object.keys(orig).forEach(function (method) { con[method] = orig[method]; });
  this._origConsole = null;
};

/** Force-send everything currently queued. Never rejects. */
OpsCat.prototype.flush = function () {
  var self = this;
  var jobs = [];
  while (self._logs.length) {
    var batch = self._logs.splice(0, self.maxBatch);
    jobs.push(self._send('/v1/ingest/logs', { logs: batch }));
  }
  while (self._events.length) {
    jobs.push(self._send('/v1/ingest/events', self._events.shift()));
  }
  return Promise.all(jobs).then(function () {}, function () {});
};

/** Flush and stop timers / listeners. */
OpsCat.prototype.close = function () {
  this._closed = true;
  if (this._timer) { clearInterval(this._timer); this._timer = null; }
  if (this._immediate) { clearTimeout(this._immediate); this._immediate = null; }
  if (IS_BROWSER) {
    try { document.removeEventListener('visibilitychange', this._onVisibility); } catch (e) { /* ignore */ }
    try { window.removeEventListener('pagehide', this._onPageHide); } catch (e) { /* ignore */ }
  }
  this.restoreConsole();
  return this.flush();
};

// --- internals -------------------------------------------------------------

OpsCat.prototype._tick = function () {
  var self = this;
  this.flush().catch(function (e) { self._report(e); });
};

OpsCat.prototype._enqueue = function (item, isEvent) {
  var total = this._logs.length + this._events.length;
  if (total >= this.maxQueue) {
    // drop oldest (prefer logs, then events) and warn exactly once
    if (this._logs.length) this._logs.shift();
    else this._events.shift();
    if (!this._dropWarned) {
      this._dropWarned = true;
      this._report(new Error('opscat: queue full (' + this.maxQueue + '); dropping oldest entries'));
    }
  }
  if (isEvent) this._events.push(item);
  else this._logs.push(item);

  if ((this._logs.length + this._events.length) >= this.maxBatch) this._scheduleImmediate();
};

OpsCat.prototype._scheduleImmediate = function () {
  if (this._immediate || this._closed) return;
  var self = this;
  this._immediate = setTimeout(function () {
    self._immediate = null;
    self.flush().catch(function (e) { self._report(e); });
  }, 0);
  if (this._immediate && typeof this._immediate.unref === 'function') this._immediate.unref();
};

/** POST a JSON body with retry/backoff. Never throws. */
OpsCat.prototype._send = function (path, body) {
  var self = this;
  var url = this.endpoint + path;
  var payload = JSON.stringify(body);

  function attempt(i) {
    return self._fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + self.apiKey },
      body: payload,
    }).then(function (res) {
      if (res.ok) return; // 2xx — done
      if (res.status >= 400 && res.status < 500) {
        // client error: do NOT retry, report and drop
        return readError(res).then(function (msg) {
          self._report(new Error('opscat: HTTP ' + res.status + ' ' + msg + ' (not retried)'));
        });
      }
      // 5xx — retryable
      throw new Error('opscat: HTTP ' + res.status + ' (server error)');
    }).catch(function (err) {
      // retry on network error or 5xx if budget remains
      if (i < self.retryDelays.length) {
        return sleep(self.retryDelays[i]).then(function () { return attempt(i + 1); });
      }
      self._report(err instanceof Error ? err : new Error(String(err)));
    });
  }

  return attempt(0);
};

OpsCat.prototype._fetchWithTimeout = function (url, opts) {
  if (!this._fetch) return Promise.reject(new Error('opscat: no fetch available'));
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var to = null;
  if (ctrl) {
    opts = Object.assign({}, opts, { signal: ctrl.signal });
    to = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, this.timeoutMs);
    if (to && typeof to.unref === 'function') to.unref();
  }
  var p = this._fetch(url, opts);
  if (to) p = p.then(function (r) { clearTimeout(to); return r; }, function (e) { clearTimeout(to); throw e; });
  return p;
};

/** Best-effort synchronous flush on page unload using sendBeacon. */
OpsCat.prototype._flushBeacon = function () {
  try {
    if (this._logs.length) {
      var logs = this._logs.splice(0, this._logs.length);
      // server accepts a bare JSON array for logs; chunk to the 500/batch cap
      for (var i = 0; i < logs.length; i += 500) {
        this._beacon('/v1/ingest/logs', logs.slice(i, i + 500));
      }
    }
    var events = this._events.splice(0, this._events.length);
    for (var j = 0; j < events.length; j++) this._beacon('/v1/ingest/events', events[j]);
  } catch (e) { this._report(e); }
};

OpsCat.prototype._beacon = function (path, payload) {
  // sendBeacon cannot set an Authorization header, so the key rides in ?key=
  var url = this.endpoint + path + '?key=' + encodeURIComponent(this.apiKey);
  var json = JSON.stringify(payload);
  var sent = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      var blob = (typeof Blob !== 'undefined')
        ? new Blob([json], { type: 'application/json' })
        : json;
      sent = navigator.sendBeacon(url, blob);
    }
  } catch (e) { sent = false; }
  if (!sent && this._fetch) {
    try {
      this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }
};

OpsCat.prototype._report = function (err) {
  try { this.onError(err instanceof Error ? err : new Error(String(err))); } catch (e) { /* swallow */ }
};

// --- small helpers ---------------------------------------------------------
function clamp(n, min, max) { n = Number(n); if (!Number.isFinite(n)) n = min; return Math.min(max, Math.max(min, n)); }

function readError(res) {
  return res.text().then(function (t) {
    try { var j = JSON.parse(t); return j.error || t; } catch (e) { return t || res.statusText || ''; }
  }, function () { return res.statusText || ''; });
}

function formatArgs(args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (typeof a === 'string') { parts.push(a); continue; }
    if (a instanceof Error) { parts.push(a.stack || (a.name + ': ' + a.message)); continue; }
    try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
  }
  return parts.join(' ');
}

// CommonJS export + default-interop for `import OpsCat from '@opscat/sdk'`.
module.exports = OpsCat;
module.exports.OpsCat = OpsCat;
module.exports.default = OpsCat;
