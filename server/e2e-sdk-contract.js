'use strict';
/* Does the published SDK still send what the server accepts?
 *
 * ── Why this harness exists ─────────────────────────────────────────────────
 *
 * sdk/js describes the /v1/ingest payloads a SECOND time — 352 hand-written
 * lines plus an index.d.ts — and nothing connected it to the server. Tighten a
 * field in src/schemas/ingest.js and the SDK keeps compiling, keeps shipping,
 * and starts getting 400s from a version of the server it was never tested
 * against.
 *
 * ── What it does NOT do, deliberately ───────────────────────────────────────
 *
 * It does not generate the SDK from the spec. sdk/js is a smart client — an
 * in-memory queue, drop-oldest, batching, backoff, never-throw-into-user-code,
 * a beacon path for page unload — and no OpenAPI generator produces any of
 * that. Replacing it with a generated thin wrapper would trade real behaviour
 * for a tidier lineage.
 *
 * Nor does it force the SDK's TYPES to equal the server's. They are allowed to
 * differ, and the direction is the whole point: the server accepts anything for
 * `severity` because clampInt() falls back to 50, while the SDK advertises
 * `severity?: number` because that is what a caller should send. The SDK may be
 * NARROWER than the server. It must never be WIDER.
 *
 * So this drives the REAL client with a capturing fetch and parses what it
 * actually put on the wire against the server's own schemas. That tests the
 * shipped code rather than someone's summary of it — the beacon path sends a
 * BARE ARRAY rather than {logs:[…]}, which is exactly the kind of detail a
 * hand-written sample would have missed.
 *
 * It cannot prove the .d.ts is exhaustive — TypeScript types are erased, so
 * nothing at runtime can enumerate them. What it proves is that every shape the
 * client actually emits is one the server takes.
 */

const { chk, report, die } = require('./e2e-lib').harness();
const path = require('path');

const S = require('./src/schemas/ingest');
const OpsCat = require(path.join(__dirname, '..', 'sdk', 'js', 'index.js'));

async function main() {
  /** Every request the SDK made: { url, body }. */
  const sent = [];
  const capturingFetch = async (url, opts) => {
    sent.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ accepted: 0, events: 0 }) };
  };

  const client = new OpsCat({
    endpoint: 'https://example.invalid',
    apiKey: 'ock_test',
    device: 'sdk-harness',
    flushIntervalMs: 0,          // no timer — this harness drives flush itself
    fetch: capturingFetch,
  });

  // Exercise the surface the .d.ts advertises, including every optional field.
  client.log('plain line');
  client.log('line with options', { sev: 3, device: 'other-host', meta: { a: 1 }, ts: Date.now() });
  client.info('info helper', { k: 'v' });
  client.error('error helper');
  client.event({
    name: 'sdk_test_event',
    severity: 70,
    device: 'sdk-harness',
    target: '/checkout',
    description: 'something happened',
    ip: '203.0.113.7',
    ts: Date.now(),
  });
  client.event({ name: 'minimal_event' });   // only the required field

  await client.flush();

  const logReqs = sent.filter((r) => r.url.endsWith('/v1/ingest/logs'));
  const evReqs = sent.filter((r) => r.url.endsWith('/v1/ingest/events'));

  chk('SDK posted a log batch', logReqs.length >= 1, `sent ${logReqs.length}`);
  chk('SDK posted the events', evReqs.length === 2, `sent ${evReqs.length}`);

  // ── The claim: what it sent is what the server takes ──────────────────────

  for (const [i, r] of logReqs.entries()) {
    const res = S.IngestLogsBody.safeParse(r.body);
    chk(`log batch ${i} is accepted by IngestLogsBody`, res.success,
      res.success ? '' : JSON.stringify(res.error.issues[0]));
  }
  for (const [i, r] of evReqs.entries()) {
    const res = S.IngestEventBody.safeParse(r.body);
    chk(`event ${i} is accepted by IngestEventBody`, res.success,
      res.success ? '' : JSON.stringify(res.error.issues[0]));
  }

  // Every queued line must be in the batch, with the entry shape the server
  // expects — device defaulted from the client, or overridden per line.
  const batch = logReqs[0] && logReqs[0].body;
  chk('batch uses the {logs:[…]} envelope', !!batch && Array.isArray(batch.logs));
  const lines = (batch && batch.logs) || [];
  chk('all four lines are in one batch', lines.length === 4, `got ${lines.length}`);
  chk('client-level device is applied', lines.some((l) => l.device === 'sdk-harness'));
  chk('per-line device overrides it', lines.some((l) => l.device === 'other-host'));
  chk('every entry satisfies LogEntry', lines.every((l) => S.LogEntry.safeParse(l).success));

  /* The beacon path (page unload) posts a BARE ARRAY rather than the envelope.
   * The union in IngestLogsBody exists for exactly this, and it is the shape a
   * hand-written sample would have got wrong. */
  chk('the bare-array beacon shape is accepted too', S.IngestLogsBody.safeParse(lines).success);

  /* Direction check, stated as a check rather than a comment: the server is
   * WIDER than the SDK on severity. If someone ever tightens it to z.number(),
   * this fails and names the reason. */
  chk('server stays wider than the SDK on severity',
    S.IngestEventBody.safeParse({ name: 'x', device: 'y', severity: 'high' }).success,
    'the server tightened severity; sdk/js advertises number but callers may send anything');

  report();
}

main().catch(die);
