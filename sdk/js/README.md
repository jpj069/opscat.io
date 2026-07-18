# @opscat/sdk

Dependency-free JavaScript client for the [OpsCat](https://opscat.io) ingest API.
Ships application logs and events to your OpsCat server with in-memory batching,
retry/backoff, and zero runtime dependencies.

- Works in **Node.js ≥ 18** and **modern browsers** (uses the global `fetch`).
- CommonJS module with default-import interop (`require` and `import` both work).
- Never throws into your code — transport problems surface via `onError`.
- Timers are `unref()`-ed in Node, so the SDK never keeps your process alive.
- In the browser, flushes on `visibilitychange`/`pagehide` via `navigator.sendBeacon`.

## Install

```bash
npm install @opscat/sdk
```

## Quick start (Node)

```js
const OpsCat = require('@opscat/sdk');
// or: import OpsCat from '@opscat/sdk';

const opscat = new OpsCat({
  endpoint: 'https://opscat.io',
  apiKey: process.env.OPSCAT_API_KEY, // "ock_..."
  device: 'checkout-api',             // default device/service name
  flushIntervalMs: 3000,              // auto-flush cadence (default 3000)
  maxBatch: 100,                      // logs per batch, 1..500 (default 100)
  onError: (err) => console.error('opscat transport error:', err.message),
});

opscat.info('service started', { port: 3000 });
opscat.log('something happened');                 // sev 6 (info) by default
opscat.warn('slow query', { ms: 1200 });
opscat.error('boom', { requestId: 'abc123' });

// override device / severity / metadata per call
opscat.log('cross-service note', { sev: 2, device: 'billing', meta: { tenant: 42 } });

// direct event (goes to /v1/ingest/events, severity is 0..100)
opscat.event({
  name: 'deploy_finished',
  severity: 20,
  target: 'v2.3.1',
  description: 'checkout-api deployed to prod',
});

// on shutdown, flush the queue and stop the timer
process.on('SIGTERM', async () => { await opscat.close(); process.exit(0); });
```

## Severity levels

Helper methods map to syslog severities used by OpsCat's ingest API:

| Method | syslog `sev` |
|--------|--------------|
| `debug`    | 7 |
| `info` / `log` | 6 |
| `warn`     | 4 |
| `error`    | 3 |
| `critical` | 2 |

`event()` uses OpsCat's **0–100** event severity scale (default `50`), not syslog.

## Browser usage

```html
<script type="module">
  import OpsCat from 'https://your-cdn/opscat-sdk/index.js';

  const opscat = new OpsCat({
    endpoint: 'https://opscat.io',
    apiKey: 'ock_public_ingest_key',
    device: 'web-app',
  });

  window.addEventListener('error', (e) => {
    opscat.error(e.message, { file: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    opscat.error('unhandledrejection: ' + (e.reason && e.reason.message || e.reason));
  });
</script>
```

When the tab is hidden or the page unloads, the SDK flushes the queue with
`navigator.sendBeacon` (falling back to a `keepalive` fetch). The beacon sends a
bare JSON array with the key as a `?key=` query parameter, both of which the
OpsCat ingest API accepts.

> Note: the API key is visible to the browser. Use a key scoped to `ingest`
> only, and consider a per-site rate limit.

## Express middleware example

```js
const express = require('express');
const OpsCat = require('@opscat/sdk');

const opscat = new OpsCat({
  endpoint: process.env.OPSCAT_URL,
  apiKey: process.env.OPSCAT_API_KEY,
  device: 'api-gateway',
});

const app = express();

// request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const sev = res.statusCode >= 500 ? 3 : res.statusCode >= 400 ? 4 : 6;
    opscat.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`, {
      sev,
      meta: { method: req.method, path: req.path, status: res.statusCode, ms },
    });
  });
  next();
});

// error handler
app.use((err, req, res, next) => {
  opscat.error(`unhandled: ${err.message}`, { path: req.path, stack: err.stack });
  res.status(500).json({ error: 'internal error' });
});

app.listen(3000);
```

## Console-capture example

Mirror everything written to `console.*` into OpsCat while keeping the normal
console output:

```js
const OpsCat = require('@opscat/sdk');

const opscat = new OpsCat({
  endpoint: process.env.OPSCAT_URL,
  apiKey: process.env.OPSCAT_API_KEY,
  device: 'worker-1',
});

const restore = opscat.captureConsole(); // patches console.{debug,log,info,warn,error}

console.log('hello');        // prints AND ships as sev 6
console.warn('disk at 82%'); // prints AND ships as sev 4
console.error('job failed'); // prints AND ships as sev 3

// later, if you want the original console back:
restore(); // or opscat.restoreConsole();
```

## API

### `new OpsCat(options)`

| Option | Default | Description |
|--------|---------|-------------|
| `endpoint` | — | Base URL, e.g. `https://opscat.io` (required). |
| `apiKey` | — | Ingest API key / Bearer token (required). |
| `device` | hostname / `browser` | Default device/service name. |
| `flushIntervalMs` | `3000` | Auto-flush cadence. `0` disables the timer. |
| `maxBatch` | `100` | Log entries per batch (clamped to 1..500). |
| `maxQueue` | `5000` | Queue cap; oldest entries are dropped (one warning via `onError`). |
| `timeoutMs` | `15000` | Per-request timeout. |
| `retryDelays` | `[1000, 4000, 10000]` | Backoff (ms) between retries. |
| `onError` | logs to stderr | Called on any transport/queue error. |
| `fetch` | global `fetch` | Custom fetch implementation. |

### Methods

- `log(line, opts?)` — queue a log line. `opts`: `{ sev?, device?, meta?, ts? }`.
- `debug|info|warn|error|critical(msg, meta?)` — level helpers.
- `event(ev)` — queue a direct event. `ev`: `{ name, severity?, device?, target?, description?, ip?, ts? }`.
- `captureConsole(targetConsole?)` — patch `console.*`; returns a restore fn.
- `restoreConsole()` — undo `captureConsole()`.
- `flush()` — force-send the queue; resolves when done, never rejects.
- `close()` — flush, stop timers, remove browser listeners.

## Delivery semantics

- **Batching:** log lines are sent to `POST /v1/ingest/logs` in batches of up to
  `maxBatch`, every `flushIntervalMs` or immediately once the queue reaches
  `maxBatch`. Events go to `POST /v1/ingest/events`, one request each.
- **Retries:** network errors and `5xx` responses are retried with backoff
  (`retryDelays`, default 1s / 4s / 10s). `4xx` responses are **not** retried —
  they are reported via `onError` and the batch is dropped.
- **Backpressure:** when the queue exceeds `maxQueue`, the oldest entries are
  dropped and a single warning is delivered to `onError`.
- **Never throws:** all failures are routed to `onError`; your call sites never
  see an exception from the SDK.

## License

MIT
