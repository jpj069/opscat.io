# OpsCat — Architecture

OpsCat is an infrastructure ops platform for NOC/SRE teams: log ingestion,
event correlation, case management, incidents + public status page,
synthetic monitoring (multi-location), server agents, and SNMP polling.

## High-level design (v1 — single node, scale-ready)

```
                        ┌────────────────────────────────────────────┐
 Internet ── 443 ─────► │ Caddy (TLS, HTTP/2, gzip, security headers)│
                        └───────────────┬────────────────────────────┘
                                        │ internal docker network (app:3000)
                        ┌───────────────▼────────────────────────────┐
                        │ opscat-server (Node 22, Express 5)         │
                        │  • REST API  /api/*   (session auth, RBAC) │
                        │  • Ingest    /v1/*    (API-key auth)       │
                        │  • Public    /status  (status page)        │
                        │  • SSE       /api/stream (live logs/events)│
                        │  • Engines (in-process schedulers):        │
                        │     pipeline · alerts · synthetics ·       │
                        │     snmp · vendors · retention             │
                        └───────────────┬────────────────────────────┘
                                        │
                        ┌───────────────▼───────────────┐
                        │ SQLite (WAL) on docker volume │
                        └───────────────────────────────┘

 Feeders:  @opscat/sdk (apps) ── HTTPS ──► /v1/ingest/logs
           opscat-agent (servers) ───────► /v1/agents/* (+ probe mode ► /v1/synthetics/report)
           Sentry / generic webhooks ────► /v1/integrations/*
           SNMP devices ◄─ poller (v2c) ─ engine/snmp
```

### Why these choices

| Decision | Rationale |
|---|---|
| Express 5 + Node 22 | Tiny footprint on the 2-vCPU VPS, and async handlers forward rejections to the error middleware on their own. Upgraded from 4 in one line: path-to-regexp v8 needs NAMED wildcards, so the SPA catch-all is `/app/*splat`, not `/app/*` — a bare `*` throws at registration. Nothing else in the codebase used the removed APIs (`req.param()`, `app.del()`, `res.sendfile()`, `res.json(obj, status)`) or mutated `req.query`, which is a getter now. |
| SQLite (better-sqlite3, WAL) | Zero-ops, extremely fast for this write pattern (batched transactional inserts). One file → trivial backup. The storage layer is isolated in `server/src/db.js` + plain SQL, so a later Postgres/ClickHouse move is mechanical. |
| In-process schedulers | No queue infra needed at this load. Engine modules are already isolated so they can be split into separate probe/worker processes when scaling out. |
| API-key ingest, session UI auth | Open "drop your logs here" endpoints stay decoupled from human auth. Keys are hashed (SHA-256) — plaintext is shown once at creation. |
| SSE (not WebSocket) | One-directional live streams (logs/events) through Caddy with zero extra dependencies. |

## Data flow: log → event → case → alert

1. `POST /v1/ingest/logs` (SDK, syslog shippers, curl) — batch of lines, API key scoped `ingest`.
2. Pipeline classifies each line (regex classifiers; per-org custom rules from the
   Pipeline admin page run before the built-ins) → severity score 0–100. Hourly
   `ingest_stats` counters (lines/bytes/event hits) feed the Pipeline throughput
   charts and the cloud plans' daily ingest allowance.
3. Lines scoring ≥ 20 are aggregated into **events**, deduped by `(name, device, target)`:
   hits counter + per-minute buckets (sparklines), first/last seen.
4. Events scoring ≥ 60 auto-open a **case** (C-1xxx). Analysts assign/close/downgrade in the UI.
5. The **alert engine** matches new/escalated events against **rules**
   (trigger name, min severity, cooldown) → notifications via **Resend e-mail** or
   **Teams/webhook**, all recorded in `notifications`.
6. The **automation engine** (`engine/automations.js`, Automation page) matches the
   same events against per-org automations: lifecycle auto-close (a clear event
   finishes its raise event and closes the case), case auto-assign, outbound
   webhooks. One run per event dedupe key and cooldown; every run is written to
   `audit_log` (`automation_run`, system actor) so automated decisions stay auditable.

AI features call the org's LLM through `server/src/llm.js` (OpenAI-compatible
chat completions): org override (Settings → AI) → platform default (super-admin
console) → off. Keys are AES-256-GCM-encrypted at rest and never returned by any API.

## Synthetics

- `synthetic_locations`: the built-in local probe (this VPS, `NBG`) plus any number of
  **remote probes** — the same lightweight agent script run with `--probe` and a probe key.
- Check types: `http`, `icmp` (ping), `dns`, `tcp`, `traceroute`. Results keep latency,
  jitter, loss, and hop data (traceroute) per location.
- Failing checks feed the pipeline as events (`synthetic_check_failed`), so alert rules
  and the status page react automatically.

## Reputation (`engine/reputation.js`, `routes/reputation.js`, page `Reputation.tsx`)

Blocklist monitoring for the org's sending assets. **Its own feature, its own top-level
page, its own API** (`/api/reputation/*`) **and its own storage** — three tables, with
the split between them carrying the design:

| Table | Holds | Retention |
|---|---|---|
| `reputation_assets` | the monitored IP or domain | — |
| `reputation_runs` | one row per lookup (a time series) | pruned like every sample table |
| `reputation_listings` | one row per **episode** of being listed, with `first_seen` / `resolved_at` | **kept** |

The first version stored an asset as a `synthetic_checks` row of type `reputation` and
its verdicts in `synthetic_results.meta`, to inherit the scheduler. That reuse was a
mistake, and migration v11 undoes it. Three things went wrong, in rising order of cost:

- **Fifteen `type != 'reputation'` guards** across six files. A row type that has to be
  filtered out of nearly every query against its own table is not a member of that table,
  and each guard was a place the next feature could forget.
- **A forged-event path.** `recordResult` decided "this is a listing" from `meta`, which
  arrives from `POST /v1/synthetics/report` — so a probe key could raise a severity-85
  event and open a case against any check. That needed a gate; now the listing decision
  lives entirely inside the engine and there is no input to gate.
- **A model that could not answer the first question.** "Since when are we listed?" is
  what anyone asks after a listing, and it is the evidence a delisting request is argued
  with. A listing is a *state with a lifecycle*; `synthetic_results` is a table of
  *samples*, pruned after 30 days. It could express neither the start date nor the
  duration, and losing that history was silent.

What the reuse actually bought was a ~20-line scheduler; the event pipeline, alert rules,
cases and status page all hang off `pipeline.ingestEvent()`, which is an import, not a
storage layout. The `type` CHECK on `synthetic_checks` deliberately still permits
`reputation`: narrowing it means rebuilding a table that six figures of
`synthetic_results` rows reference, and a permitted value that is never written again
costs nothing.

Assets surface as their own `kind` in the `/api/assets` aggregate.

It is the one check that does not test reachability. A listed server answers perfectly well; it just stops being delivered, so
a listing raises its own event (`reputation_listed`) rather than
`synthetic_check_failed`, which would send whoever is on call hunting for an outage.

- **Target is used verbatim.** An IPv4/IPv6 target is reversed and queried against 31 IP
  blocklists; a domain goes to 8 RHSBLs. A domain is deliberately *not* resolved to its
  A record first — that would check the website instead of the mail sender. Targets are
  stored normalised (lower-cased, no trailing root dot) and de-duplicated on their
  *canonical* key, so `MAIL.Example.com.` and `2001:0db8::1` cannot be added twice under
  different spellings.
- **Severity comes from the list, not from the fact of listing.** Zones are tiered
  `critical` (85) / `standard` (65) / `informational` (30). Informational listings —
  UCEPROTECT L2/L3 and friends, which list whole ASNs, so a clean sender is caught by a
  noisy neighbour — are recorded and displayed but never flip the check or alert. Without
  that split the feature generates enough noise to get muted within a fortnight.
- **"No answer" is not "clean".** Every zone gets a positive control (the test entry
  RFC 5782 §5 mandates — `127.0.0.2` listed) **and a negative control**, and failing
  either means *unavailable*, never clean; the verdict is cached for an hour. The
  negative control is `127.0.0.1` for IP zones, and for RHSBLs — which have no
  standardised test entry — a random name under `.invalid`, a TLD RFC 2606 reserves so
  no conforming list can have an opinion about it. Both kinds need one: a wildcard or
  NXDOMAIN-hijacking resolver answers *every* query, so without a negative control every
  zone "lists" every target and the whole mail estate pages at severity 85. Shipping the
  IP half alone left exactly that hole open for domains. This
  matters: Spamhaus answers plain NXDOMAIN to queries arriving via large public
  resolvers, and a retired list (SORBS) answers NXDOMAIN forever — both are
  indistinguishable from a clean verdict otherwise. If no `critical` zone is reachable
  the check fails outright rather than reporting a pass it cannot back up.
- **Spamhaus PBL is a policy statement**, not an accusation — `127.0.0.10/11` mean "this
  range should not send mail directly". Surfaced separately; never alerts.
- **Resolver**: the host's own by default, which is the point — DNSBLs refuse or
  rate-limit large public resolvers. Override with `OPSCAT_REPUTATION_DNS`
  (comma-separated) when the host resolver is unfit.
- **Cadence**: interval floor **1h**, ceiling 24h, default 6h. The floor is the feature's
  own, not the plan's — one IP asset is ~93 queries on a cold canary cache (31 zones plus
  both controls each) and 31 warm, against lists that rate-limit per source IP, so a plan
  that permits 15s HTTP checks must not be able to turn a handful of assets into a flood
  that gets the whole host refused. "Run all checks" (`POST /api/synthetics/run`, MCP
  `opscat_run_checks` — both analyst-reachable) cannot reach reputation at all any more:
  v10 needed an explicit filter to keep that button from flooding the lists, v11 simply
  does not have the assets in that table. The per-asset
  `POST /api/reputation/assets/:id/run` is lead-only.
- **A finding outranks a partial outage.** If some zones answered and one of them listed
  the asset the status is `listed`, not `unknown`, and the incompleteness rides along in
  the `error` field — reporting `unknown` there would contradict the alert the on-call
  just received. Coverage is reported **per kind**
  (`{ip:{queried,total,unavailable}, domain:{…}}`) because the denominators differ; one
  merged number made a domain-only org look catastrophic.
- **Server-local, and the trust boundary is now structural.** A DNSBL answer does not
  vary by vantage point the way latency does, and agents ship no runner for it. In v10
  that was enforced by two guards, because probe-supplied `meta` decided what counted as
  a listing — without them a probe key could post a forged "clean" over a real listing or
  raise a `reputation_listed` event against any check. `engine/reputation.js` is now the
  only writer of runs and listings, and it acts on evidence it gathered itself, so the
  guards are gone rather than merely satisfied.
- **Delisting is observable.** Because a listing has a lifecycle, the engine can tell
  "gone" from "never there" and raises `reputation_cleared` (severity 20, below the
  alerting floor) when the last actionable episode closes — a clear event a `close_event`
  automation can use to finish the raise and close its case. A listing is only ever
  resolved by a zone that **answered that run**: a zone that refused, timed out or failed
  its canary has told us nothing, and reading its silence as a delisting would erase a
  live finding every time the resolver has a bad day.

## SNMP

`engine/snmp.js` polls targets (v2c) on their interval for standard OIDs
(sysUpTime, ifOperStatus, custom OID list per target). Unreachable targets and
down interfaces generate pipeline events. Community strings are encrypted at rest
(AES-256-GCM with `OPSCAT_SECRET`).

## Vendor monitoring (supply chain)

`engine/vendors.js` polls the **official status feeds** of third-party services an
org depends on (status-page aggregation, like StatusGator/IsDown but self-hosted):

- Feed adapters in `engine/vendor-feeds.js`: Atlassian **Statuspage**
  (`/api/v2/summary.json` — also covers **incident.io** pages, which expose a
  Statuspage-compatible shim on their canonical host), **Instatus**
  (`/summary.json`), **Slack**'s status API, Google's dashboards (**gcp** — Cloud,
  Workspace + Firebase `incidents.json`), the **AWS** public health feed (UTF-16
  BOM handled), **Heroku** (`/api/v4/current-status`), **status.io**
  (`api.status.io/1.0/status/<pageId>`, e.g. GitLab) and a generic **RSS/Atom**
  fallback — native `fetch` + hand-rolled parsing, zero new dependencies.
- A bundled catalog (`server/src/data/vendor-catalog.json`, 220+ validated vendors
  with feed URLs + product domains — cross-checked against top-SaaS rankings like
  Okta's Businesses at Work) plus custom feeds (https-only, SSRF-guarded like
  synthetic checks, redirects re-validated per hop).
- Each unique feed URL is fetched **once per tick** and fanned out to every
  subscribed org (ETag/Last-Modified caching) — polling load on the cloud instance
  is independent of the org count; a self-hosted community instance polls the same
  vendor feeds directly with the same code.
- Vendor state mirrors into `vendors` / `vendor_components` / `vendor_incidents`;
  new incidents raise `vendor_incident` pipeline events (severity by impact:
  major/critical page, minor stays informational), recovery raises
  `vendor_recovered` — alert rules, cases, SSE and the Monitor react automatically.
- A vendor can be mapped onto an **own status-page component**: the vendor's state
  then drives that component's status, uptime history and the public status page.
- **Public vendor grid** (marketing/community output): the live status of every
  vendor org 1 monitors, as JSON (`/api/public/vendor-grid`, 60 s cache) and as a
  server-rendered page (`/vendor-grid`, front page on `radar.opscat.io`). Off by
  default; publish via `vendor_grid_published=1` / `OPSCAT_GRID_PUBLISHED=1`. Seed
  org 1 with `POST /api/vendors/subscribe-catalog`. Only curated catalog vendors
  appear — org-created custom vendors are never exposed publicly.

## User problem reports (status page)

The public status page carries a "Report a problem" form (plain HTML POST — the
page ships no JS, so CSP stays strict): optional component + free-text message,
no account needed. Guards: honeypot field, per-IP token bucket (3/min), one
report per visitor per 10 minutes; only a salted IP hash is stored
(`status_reports`, pruned after 30 days). `engine/reports.js` checks every
minute: ≥ `status_reports_threshold` (default 5) reports within 15 minutes raise
a `user_reports_spike` pipeline event — frequently the earliest outage signal,
before synthetic checks or agents notice. Org settings: `status_reports_enabled`
(default on), `status_reports_public` (show the last-hour count on the page,
default off), `status_reports_threshold`. Ops see recent reports on the Status
Page admin screen.

## Security

- Passwords: scrypt (node:crypto), per-user salt, constant-time compare.
- Sessions: 32-byte random ids, HttpOnly + Secure + SameSite=Lax cookies, server-side store, idle + absolute expiry.
- CSRF: state-changing `/api` routes require `X-OpsCat-CSRF` header (double-submit token issued at login).
- RBAC: `admin > cto > lead > analyst` — enforced per route.
- API keys / probe keys / agent tokens stored hashed; scopes enforced (`ingest`, `probe`, `agent`).
- Rate limits (in-memory token buckets): auth 10/min/IP, ingest 600 req/min/key, API 300/min/session.
- App container publishes **no host port**; only Caddy is reachable from outside (fixes the previous `0.0.0.0:3000` exposure).
- Security headers via Caddy + app (CSP for the UI, no-sniff, frame-deny, HSTS).
- Secrets only via environment (`OPSCAT_SECRET`, `RESEND_API_KEY`); never logged, never committed.

## Multi-tenancy & editions

- Every tenant table carries `org_id` (`organizations` is the root); **all** queries
  are scoped by it. `requireSession` resolves the caller's org (`req.orgId`);
  API keys, agent tokens and probe keys are org-bound, and the SSE stream plus the
  ingest pipeline (event dedupe) operate per org. A missing `org_id` filter is a
  security bug (see CONTRIBUTING.md).
- A **user can belong to several orgs**: `memberships(user_id, org_id, role)` is the
  authority for org membership and carries a role *per org*. `requireSession` reads the
  session's active org (`sessions.active_org_id`, default the user's home `users.org_id`),
  validates the membership, and sets `req.user.role` from it. The **switcher is a
  Cloud-edition feature**: the top-bar UI renders only in cloud and
  `POST /api/auth/switch-org` `403`s in community (which is single-org anyway).
  `GET /api/auth/orgs` (session context) stays in both. Cloud users can self-serve a new
  org (`POST /api/orgs`) or attach an existing account to an org (admin users API).
  `users.org_id` stays the home/default org.
- **First-run onboarding**: a freshly-created cloud org is seeded with
  `org_settings.onboarding_done = '0'`. On login the app renders a full-screen setup flow
  (`web/src/pages/Onboarding.tsx`) instead of the shell for that org's admin — it performs
  real actions through the normal APIs (ingest key, a synthetic check, an alert rule,
  teammates), captures personalization answers (`onboarding_role/goal/source`, the last
  only asked on a user's first org) and flips the flag to `'1'` on finish/skip. Existing
  orgs and the CE have no `'0'` flag, so they never see it. The flow is
  responsive: below 720px the step rail is replaced by a compact dot-stepper header
  (`.onb-*` classes in `web/src/tokens.css`).
- `OPSCAT_EDITION` selects the runtime edition (`server/src/edition.js`):
  `community` (default — single organization, no limits) or `cloud` (multi-tenant
  SaaS: plan limits from `server/src/plans.js` enforced with `402`, Stripe billing,
  self-service signup + Google OAuth, super-admin console). Enterprise modules live
  in `server/src/ee/**` and the EE routes (`billing`, `superadmin`, `oauth`), loaded
  via guarded `require` — the community tree runs without them (`docs/OPEN-CORE.md`).
- Super-admins (`users.is_super_admin`) operate across organizations and may target
  one explicitly via `?org=` / `X-OpsCat-Org` (no membership required — this is distinct
  from the membership-based switcher normal users get).
- Public status pages are per-org: `/status` (default org) and `/status/:slug`.

## Scaling / HA path (documented now, executed when load demands)

Current: 1 VPS ≈ everything. The seams are already cut so each step below is isolated:

1. **Vertical**: bigger VPS; SQLite WAL handles tens of GB and thousands of writes/s.
2. **Split storage**: swap `db.js` for Postgres (metadata) + ClickHouse (logs/metrics time series).
   All SQL lives in the storage layer; ingest/report queries are the only hot spots.
3. **Split roles**: run engines (`synthetics`, `snmp`, `alerts`) as separate worker
   processes/containers (`node src/worker.js synthetics` — modules take no HTTP deps).
4. **Scale ingest horizontally**: stateless API nodes behind LB (Caddy/HAProxy),
   sticky-free (sessions in DB), queue (Redis/NATS) between ingest and pipeline.
5. **True HA**: 2+ app nodes in different DCs, Postgres with streaming replica + automatic
   failover, floating IP / DNS failover, remote probes already independent by design.
   Status page can be hosted separately (static export) so it survives platform outages.

## Frontend mobile layout

The app shell is a drawer + single column below 720px (`.shell-rail`, `tokens.css`).
The recurring failure mode is not the shell but **toolbars that cannot wrap**: a flex
item's `min-width: auto` refuses to shrink below its content, and a `<select>` takes
the width of its longest option — so one long check target or org name pushes a whole
page sideways. The invariants:

- `PageHeader` (`web/src/ui.tsx`) is THE page header: title + actions, wrapping. Other
  toolbars use `.row row-wrap`; plain `.row` deliberately stays nowrap because table
  cells use it for avatar/label pairs.
- Form controls carry `min-width: 0; max-width: 100%` globally — they always shrink.
  Give a control an explicit width/flex when it should be bigger.
- Horizontal scrolling happens ONLY in `.tbl-scroll` (`TableScroll`), never on `.card`
  or `.page`: `overflow-x` forces `overflow-y: auto` too, and a flex child that hides
  overflow can collapse below its content height.
- Known exception: the Classic terminal view keeps its fixed character grid and is ~2px
  wider than a 390px viewport. Making it genuinely phone-friendly means a pan
  container (min-width + one horizontal scroller) — a product decision, not done.

## Frontend typography (the --t-* scale)

Font sizes used to live as raw numbers in ~360 inline `style={{ fontSize: 11 }}` props.
That is unreachable by a media query, which is why the app read "text tiny, fields huge"
on a phone: 62 of 83 visible text elements on Settings were <=12px (29 of them <=10px)
right next to a 16px input — 16px being the floor below which iOS Safari zooms the page
on focus and never zooms back. The fields could not come down, so the text had to go up.

The scale is seven custom properties in `tokens.css`, mapped into Tailwind via
`@theme inline` so `text-sm` and `var(--t-sm)` are the same value:

| token | desktop | <=720px | Tailwind |
|---|---|---|---|
| `--t-2xs` | 9px | 11px | `text-2xs` |
| `--t-xs` | 10px | 12px | `text-xs` |
| `--t-sm` | 11px | 13px | `text-sm` |
| `--t-base` | 12px | 14px | `text-base` |
| `--t-md` | 13px | 15px | `text-md` |
| `--t-lg` | 14px | 16px | `text-lg` |
| `--t-xl` | 16px | 18px | `text-xl` |

Desktop keeps the dense NOC values unchanged; only the phone column moves. Rules:

- **Text at or below 16px reads from the scale** — a `text-*` class or `var(--t-*)`,
  never a literal. A literal cannot follow the phone column. Display sizes above 16px
  (page headings, the big metric numbers) may stay literal: they are already legible at
  arm's length, and a scale entry per heading buys nothing.
- **Never a `fontSize` in an inline style on an `input`/`select`/`textarea`.** Inline
  styles beat every stylesheet, so such a control keeps its desktop size on a phone and
  triggers the iOS zoom. Density belongs in the padding.
- The 16px phone floor for form controls is therefore **unlayered** at the very bottom
  of `tokens.css` — inside `@layer components` a stray `text-sm` utility on an input
  would outrank it, because Tailwind's utilities sit in a later layer.
- Two parsing traps this file already hit: custom properties need a **selector**
  (`--t-sm: 13px` bare inside `@media` is invalid, and error recovery swallows the
  following rule too), and Tailwind's `text-*` utilities set font-size **and**
  line-height — hence the `--text-*--line-height: 1.5` companions in `@theme`.
- Exception: `Classic.tsx` is a fixed-cell terminal skin whose character grid only lines
  up at one size; it deliberately does not ride the scale.

## Frontend scroll architecture (why phones scroll the document)

Desktop is a classic app shell: `html, body, #root` are exactly window-height, the shell
owns the viewport (`.shell`) and the page scrolls **inside** it (`.page`). On phones that
same structure costs real screen space, so **below 720px the DOCUMENT scrolls instead**.

iOS Safari collapses its bottom toolbar into the small floating pill **only when the root
scroller moves**. With an inner scroller it never sees a page-scroll gesture, so the
toolbar stays fully expanded forever — and because `height: 100%` means the *visible*
area, the page visibly ends at it. Measured on an iPhone 16 / iOS 18.7 (Safari 26.5.2)
via `100svh` vs `100lvh`: **695 px instead of 735 px**, i.e. 40 px permanently blocked.
The marketing site never had the problem because it has no `height: 100%` at all.

The mobile block in `tokens.css` therefore drops `height: 100%` from `html, body, #root`
and `.shell`, and makes `.shell-top` `position: sticky`. Two consequences worth knowing:

- **Never put `overflow-x: hidden` on `.page`.** Next to `overflow-y: visible` CSS
  computes it to `auto`, which turns `.page` back into a scroll container and silently
  undoes all of this. Sideways overflow is prevented structurally (see § Frontend mobile
  layout), not with a clamp.
- **Layout that phones must override belongs in a class, not inline.** A media query
  cannot beat an inline style — hence `.shell`, `.shell-main`, `.shell-top`,
  `.shell-body`, `.screen-center` instead of the inline styles App.tsx used to carry.

Pages come in three shapes:

| Class | Desktop | Phone |
|---|---|---|
| `.page` | fills, scrolls inside | flows into the document |
| `.page-fill` + `.fill-scroll` | fills, inner scroller (Logs) | flows into the document |
| `.page-console` | fills, inner scroller | keeps its own `calc(100svh - 48px)` window |

`.page-console` is for surfaces that have no meaning as an endlessly growing document —
the Classic terminal, the Monitor split view, the Incidents master/detail. They keep their
own window on phones, and Safari's toolbar consequently stays expanded **there** — an
accepted trade for those three. `svh` (not `dvh`/`vh`) so nothing is ever cut off behind
the toolbar.

**Known accepted defect:** pulling past the top rubber-bands the document, and the strip
exposed above it takes the **`body`** background, not the topbar's — so a fast upward
swipe flashes a hairline of page colour. Verified on the device that this is not the
sticky header (it also happens with a static header), not fixable from inside the document
(a pseudo-element above the header paints in the wrong place), and not fixable via
`html { background: … }` (WebKit does not use it there — the flash stayed at the top while
the bottom went clean). The only cures are `overscroll-behavior-y: none`, which also
removes pull-to-refresh, or giving the topbar the page background, which costs its
contrast — a shadow cannot substitute in dark mode. Left as is deliberately.

## Frontend dropdowns (Select / MultiSelect)

`web/src/Select.tsx` is THE dropdown; the native `<select>` stays only where the option
list is short, static and part of a plain form. Three problems drove it: a native select
is sized by its **longest option** (data dictates layout width), it cannot be searched or
hold multiple values, and on a phone iOS replaces it with its own wheel.

What it must not lose is the one thing the native control does well: it never triggers
the iOS focus-zoom. The component keeps that by never putting a sub-16px text field on
screen — the trigger is a button (buttons cannot be typed into, so iOS never zooms) and
the only real input, the search box, is a full 16px inside the panel.

- **Phone (≤720px): bottom sheet, search in the FOOTER**, options above it. Search at the
  top vanishes behind the keyboard the instant you type: `position: fixed` anchors to the
  *layout* viewport and iOS does not shrink that for the keyboard. Hence `--kb`, measured
  from `visualViewport` (`innerHeight − vv.height − vv.offsetTop`) and re-measured after
  the keyboard animation. Verified on a real iPhone before the component was written.
  Option rows are 44px; swiping the sheet down closes it (the grab handle promises that
  gesture, so it has to work).
- **Desktop: an anchored popover in a portal** — `position: fixed` from the trigger's
  rect, so no clipping ancestor (`.tbl-scroll`, a card) can cut it off; flips upward when
  there is no room below.
- **Search appears at ≥13 options** (`searchable="auto"`). 13, not 10, so a month or
  hour picker does not get a search box it does not need. Override with
  `searchable={true|false}`.
- **MultiSelect** shows pills in the trigger up to 5 selections; beyond that the trigger
  goes compact (one pill + "+N more") and the full set lives in an overview that opens
  **upward** over the trigger — an overview that pushed the form down would move the very
  field the user is looking at. Two pills already need three lines at 390px, which is why
  "compact" means one.
- **a11y:** trigger is `role="combobox"` + `aria-expanded`, panel is `role="listbox"` with
  `aria-selected` / `aria-activedescendant`; arrows move the highlight, Enter picks,
  Escape closes (handler on `document` — after a drag the focus is outside the panel),
  and focus returns to the trigger on close.

## Frontend loading states (skeletons)

Every async surface in the UI renders a **skeleton placeholder**, never a "loading…"
label. The rule that keeps those placeholders from going stale: **a skeleton is
derived, never hand-drawn.**

- **Data convention:** `null` = still loading, `[]` = loaded and empty, values = loaded.
  Fetch state therefore needs no extra boolean; a page keeps its `useState<T[] | null>`.
  Live SSE data has no null phase, so `state.tsx` exposes `eventsLoading` / `logsLoading`
  for the first fetch per org (Monitor/Classic/Dashboard read them).
- **Tables:** `<TableSkeleton cols={THE_SAME_GRID_CONST} />` takes the exact
  `gridTemplateColumns` string the head and rows use and reuses `.tbl-row`, so column
  count, widths, row height and borders come from the real layout. Add or reorder a
  column → the placeholder follows on its own. Consequence: every table keeps its grid
  template in **one** constant (`COLS`, `RULE_COLS`, `ORG_GRID`, …) — never inline it
  twice.
- **Self-placeholdering atoms:** `KpiCard`, `StackedArea`, `LineChart` and `HBars` render
  their own placeholder when handed `null` (chart placeholders keep the chart's height,
  so nothing jumps when data lands). Pages pass `ana?.volume ?? null` and are done —
  Dashboard/Analytics render their real structure from the first paint instead of
  swapping in a separate loading screen.
- **Page-local shapes** compose the page's own row component (e.g. Settings'
  `FormSkeleton` builds on the real `Row`) and wrap it in `<Busy>` for the
  `role="status"` + screen-reader label.
- **Generic shapes** (`Skeleton`, `TextSkeleton`, `ListSkeleton`, `CardsSkeleton`,
  `BarsSkeleton`, `ChartSkeleton`) are deliberately field-agnostic — they stand in for
  content without claiming to mirror specific fields, so they cannot drift either.
- **Motion:** one shimmer defined once (`.skel` in `tokens.css`), disabled under
  `prefers-reduced-motion`. The Classic terminal view keeps its text-only idiom.
- **Guard:** `web/scripts/check-loading-states.mjs` (runs in `npm run build`, therefore
  in the Docker build and the deploy) fails on any new ad-hoc `loading…` text outside
  `ui.tsx`. A deliberate text-only case opts out with a `skeleton-exempt` comment.

## Repository layout

```
server/    Express API + engines (server/src/ee/** = Enterprise Edition, EE)
web/       React + Vite UI (built into server/public at docker build; UI icons come
           from lucide-react, brand marks are inline SVGs in web/src/icons.tsx —
           no unicode-glyph icons, no emojis; loading states = skeletons from
           web/src/ui.tsx, guarded by web/scripts/check-loading-states.mjs)
sdk/js/    @opscat/sdk — dependency-free log SDK (Node + browser)
agent/     opscat-agent.js — dependency-free server agent (+ --probe mode)
marketing/ static marketing site served at opscat.io/ (private repo only)
deploy/    sensor fleet provisioning — cloud-init, provider APIs, Terraform
scripts/   publish-community.sh — filtered sync to the public repo
docs/      this file, API.md, OPEN-CORE.md, OPERATIONS.md, SENSORS.md
```
