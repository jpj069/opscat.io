# API contract — schema-first routes

The HTTP contract is generated from the code that enforces it. There is no
hand-maintained endpoint list, because a hand-maintained list is a second source
of truth and starts disagreeing with the server the day it is merged.

- **Spec:** `GET /openapi.json`
- **Reference:** `GET /docs` — server-rendered, no external script
- **Agent entry point:** `GET /llms.txt`, and the spec is an MCP resource (`opscat://openapi`)
- **Registration:** `server/src/lib/route-schema.js`
- **Generator:** `server/src/lib/openapi.js`
- **Schemas:** `server/src/schemas/`

## The problem this solves

One `events` row had **three** public descriptions, none aware of the others:

| Where | Shape |
|---|---|
| `routes/ops.js` `publicEvent()` | 12 fields |
| `mcp/tools.js` `eventShape` | 9 fields, declared separately |
| `mcp/tools.js` handlers | the same 9-field mapping written by hand **twice** |

Plus `sdk/js/index.js` — 352 hand-written lines describing the same `/v1/ingest`
payloads a fourth time. Renaming a column meant finding four places, and nothing
could tell you which one you missed.

`schemas/domain.js` is now the single description; the MCP projection is
**derived** from the REST one with `.pick()`. Verified: renaming a field there
makes `mcp/tools.js` fail to load with `Unrecognized key`. That guarantee is
load-time only because tools.js reads `.shape` at module scope — zod validates a
pick lazily, so do not "simplify" that access away.

## One object, three consumers

1. **Validates the request** — a payload the spec calls invalid is rejected.
2. **Produces the OpenAPI entry** — `z.toJSONSchema`, `io:"input"` for requests
   and `io:"output"` for responses.
3. **Feeds the MCP tools** — same object, so the two surfaces cannot diverge.

## Converting an existing route

**The schema must not change what the route accepts.** `/v1` is an open surface
with foreign clients — Alertmanager, Sentry, the SDK, whatever a customer wired
up two years ago. A schema stricter than the handler was rejects traffic that
used to work: that is an outage, not a cleanup.

So where the existing code is lenient, the schema is lenient. `severity` is the
clearest case: `clampInt(v, 0, 100, 50)` accepts anything and falls back to 50,
so the schema accepts anything and the clamp stays in the handler. Tightening is
a separate, per-route decision with its own reasoning.

`/api` was converted under the same rule, stated as: **the schema describes, the
handler keeps deciding.** A field the handler already validates is declared
`z.unknown()` and documented with `.meta({type, enum, minimum, …})`, which lands
in the spec while the runtime keeps accepting exactly what it accepted before.
Re-expressing `clampInt(limit, 1, 500, 200)` as a zod constraint would turn
`?limit=9999` from "500 rows" into a 400 — a behaviour change wearing the
clothes of a cleanup.

Two details of `z.unknown()` are worth knowing, because they do the work here:

| Declaration | Runtime | In the spec |
|---|---|---|
| `z.unknown()` | rejects `undefined`, accepts any type | listed in `required` |
| `z.unknown().optional()` | accepts anything, including absent | optional |

So a field the handler requires is `z.unknown()` — the request that was a 400
is still a 400, only the message sharpens — and `.meta()` carries the shape a
caller should send.

The direction is what makes this honest. A server more forgiving than its spec
costs nobody anything; a spec promising something the server rejects is the lie
this exists to remove. Responses are the same asymmetry mirrored: a response
schema wider than reality under-promises, a narrower one lies, so anything
uncertain is `.nullable()`.

Steps:

1. Put the shapes in `server/src/schemas/`, `.describe()` the non-obvious fields.
2. Register with `createRouteRegistrar`; return the body, throw `ApiProblem` for
   errors. Auth middleware goes in `middleware: []` — the registrar does not
   authenticate, it validates.
3. `npm run check:api` — the baseline drops; commit `.api-schema-baseline.json`.
4. `npm test` — the e2e suite is the proof the conversion changed nothing.

Order by value: `/v1` first (that is what an SDK or the MCP would be generated
from), then the Bearer-capable operations API. Done: `/v1` (13), `/api` (30),
`/api/oncall` (33) and the public status JSON (6). Next:
`admin.js`/`superadmin.js` — 86 routes, but internal, so the lowest return.

## The baseline will never reach zero, and that is correct

`npm run check:api` counts routes that are not registered. Some of them never
can be, and reading a non-zero number as unfinished work would be wrong.

The registrar describes **one JSON body per request**. A route that answers
something else is left raw, with a comment saying why:

| Route | Answers |
|---|---|
| `GET /api/stream` | `text/event-stream`, held open |
| `GET /v1/agents/update` | the bundled agent JavaScript |
| `GET /status`, `/status/:slug` | the status page, HTML |
| `GET /status/feed.xml` | RSS |
| `GET /status/logo`, `/favicon` | binary |
| `GET /status/confirm`, `/status/unsubscribe` | the mini-pages, HTML |
| `POST /status/report`, `/status/subscribe` | a 303 back to the form |
| `GET /api/public/tls-check` | `ok` as plain text, for Caddy |

`status.js` is the clearest case: 22 raw routes, of which only 6 were ever
convertible. The other 16 are permanent, and a schema for any of them would be
a fiction.

So the ratchet is a **ceiling that only moves down**, not a countdown to zero.
It exists to make an unconverted route visible, not to demand conversion of a
route that cannot have a JSON schema.

## The SDK is checked against the schemas, not generated from them

`sdk/js` describes the `/v1/ingest` payloads a second time and nothing connected
it to the server. Tighten a field in `schemas/ingest.js` and the SDK keeps
compiling, keeps shipping, and starts collecting 400s from a server it was never
run against.

`server/e2e-sdk-contract.js` closes that by driving the **real** client with a
capturing `fetch` and parsing what it actually puts on the wire against the
server's own schemas. It tests the shipped code, not a sample of it — which is
how it covers the beacon path sending a bare array rather than `{logs:[…]}`.

Two things it deliberately does not do:

- **It does not generate the SDK.** `sdk/js` is a smart client: in-memory queue,
  drop-oldest, batching, backoff, never-throw-into-user-code, a beacon for page
  unload. No OpenAPI generator produces any of that, so replacing it with a
  generated thin wrapper would trade real behaviour for a tidier lineage.
- **It does not force the SDK's types to equal the server's.** The direction is
  the point: the server accepts anything for `severity` because `clampInt()`
  falls back to 50, while the SDK advertises `severity?: number` because that is
  what a caller should send. **The SDK may be narrower than the server. It must
  never be wider** — that is the assertion.

It cannot prove the `.d.ts` is exhaustive (TypeScript types are erased, so
nothing at runtime can enumerate them). It proves every shape the client emits is
one the server takes.

## More than one success, still exactly one contract

`POST /api/oncall/alerts` answers **201** (a new alert is ringing), **200** (one
was already live for this subject, returned instead of a twin) or **202** (a
maintenance window or the policy's support hours suppressed it). Three
outcomes, three meanings, all real.

The registrar's original rule — one 2xx in `responses`, taken as the status —
made that route unconvertible. The rule was there so "spec says 201, code sends
200" could not happen, and dropping it would have cost exactly that. So it was
widened rather than removed: declare every 2xx, name the default in
`successStatus`, and return `withStatus(202, body)` for the others.

```js
successStatus: 201,
responses: { 201: AlertSchema, 200: AlertSchema, 202: AlertSuppressed, 400: ErrorResponse },
…
if (r.suppressed) return withStatus(202, { suppressed: r.suppressed });
return r.already ? withStatus(200, view) : view;
```

The guarantee survives intact, and is arguably stronger: the status must be one
of the declared keys, and the body is validated against **that** status's schema
rather than the default one. What is ruled out is not "more than one outcome",
it is an undeclared one. Deliberately a tagged return rather than a
`res.status(...)` call — going through `res` is the escape hatch, which skips
validation entirely, and a route with three success shapes is where an
unvalidated one is worth least.

Measured, not asserted: instrumenting the registrar shows the suite hitting all
three of that route's codes, and both of `POST /api/oncall/me/push`.

## Every registered route is exercised

Response validation throws in dev and test, so a wrong schema is a failing test
— but only for a route something actually calls. That was measured rather than
assumed: instrumenting the registrar and running the whole suite showed **20 of
43** registered routes exercised. The other 23 had schemas nothing had ever
compared to a real response.

`server/e2e-contract.js` closes that gap and keeps it closed. It DISCOVERS
routes instead of listing them — it walks `registeredRoutes()` and calls every
session-authenticated GET that takes no path parameter, then covers the write
verbs, the `/v1` ingest surface and `/api/events/:id` by hand. A route added
later is swept up without anyone remembering the file exists.

Three details that are load-bearing:

- **The sweep runs twice**, before and after the fixtures. A list endpoint is at
  its most dangerous empty — that is where a `.nullable()` nobody needed and a
  missing one nobody noticed look identical.
- **`covered >= 10` is a floor, not a list.** A harness that silently covers
  nothing (a route module stops being required, the registry is empty) would
  otherwise print "N/N checks passed" while testing nothing — the
  permanently-green failure `e2e-lib.js` exists to prevent.
- **The uncovered list is derived from what the harness actually called**, not
  hand-maintained, so it cannot go stale.

Re-measured after each conversion: **81 of 82**. The one exception is
`POST /api/oncall/me/methods/:id/test`, whose 2xx needs a real mail or SMS
transport that a hermetic suite deliberately does not have — so the harness
asserts its DECLARED ERROR instead and says so, rather than a green check
implying the success path was tested.

The mechanism itself was verified by breaking one schema on purpose:
`GET /api/cases` then failed with
`response does not match schema … 0.incident: expected string, received null`.

## What it guarantees, and what it does not

| Drift | Closed? | By what |
|---|---|---|
| Request shape | **Yes, structurally** | the same object rejects the request |
| Route exists / does not | **Yes** | only registered routes are in the spec |
| Success status code | **Yes** | taken from the single 2xx in `responses` |
| Response shape | **Yes, if you run the tests** | dev/test throw on mismatch, prod logs (`OPSCAT_VALIDATE_RESPONSES=1` to throw) |
| REST ↔ MCP shapes | **Yes, where derived** | `.pick()` from one schema |
| A field on the wire the spec does NOT describe | **Not structurally** | zod strips unknown keys rather than rejecting them, so validation passes. Measured instead — see below |
| Field semantics | No | `.describe()` moves the prose into the schema, but it is still prose |
| Rate limits, side effects, idempotency | No | route `description` |
| Response shape, per route | **Yes, 81 of 82** | `e2e-contract.js` calls every registered route; the registrar throws on a mismatch |
| SDK ↔ server | **Yes, for the shapes it emits** | `e2e-sdk-contract.js` parses the real client's output with the server schemas |
| Not-yet-migrated routes | — | absent from the spec; counted by `npm run check:api` |

The spec is **incomplete while the migration runs, and always true**. An
incomplete document that can be trusted beats a complete one that cannot.

### The one hole, and how it is watched

Response validation catches a field that is missing or wrongly typed. It does
NOT catch an **extra** one: a `z.object` strips unknown keys instead of
rejecting them, so a route that grows a field its schema does not mention keeps
passing while the spec quietly under-describes the wire.

That is not hypothetical — it happened here. `db/log-store.js` added `source` to
every log row, and `LogLineSchema` did not have it. Nothing failed.

So it is measured rather than assumed: instrumenting the registrar to diff each
response's top-level keys against its schema and running the whole suite reports
**zero** undescribed keys across all 82 routes. Re-run it after a merge that
touches response shapes:

```js
// in the wrapper, before the safeParse — see git history for the full snippet
const extra = Object.keys(sample).filter((k) => !known.includes(k));
```

Making response objects strict would close it structurally and is the obvious
follow-up; it was not done blind, because a strict schema turns every field
added anywhere into an immediate test failure and that is a decision to take
deliberately rather than as a side effect of a merge.

## Where the contract is linked

Link it, never copy it — every copy is a new thing that can rot.

| Where | What |
|---|---|
| `GET /openapi.json` | the spec |
| `GET /docs` | rendered reference |
| `GET /llms.txt` | agent entry point; generated, so it cannot describe an endpoint this instance does not serve |
| `opscat://openapi` | MCP resource — an agent reads the REST contract without anyone pasting a URL |
| `docs/API.md` | the *why*: auth model, tenancy, conventions. Endpoint detail belongs in the spec |
