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
                        │ PostgreSQL 16 (docker volume) │
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
| PostgreSQL 16 (node-postgres) | The only engine, in both editions (decision D6). Every statement in `server/src` goes through the async shim (`src/db/shim.js`); `src/schema.sql` is PostgreSQL DDL and is the only description of the shape. It replaced SQLite, which was genuinely good at this write pattern and gave a one-file backup — what it cost was a second SQL dialect over ~770 statements, with `int8`-as-string, `CAST` disagreements, case-sensitivity of `LIKE`, `lastInsertRowid` and a `withTx` serialisation lock all differing per engine, and no product benefit on the other side. See `docs/POSTGRES-MIGRATION-PLAN.md`. |
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
   **Microsoft Teams/webhook**, all recorded in `notifications`.
6. The **automation engine** (`engine/automations.js`, Automation page) matches the
   same events against per-org automations: lifecycle auto-close (a clear event
   finishes its raise event and closes the case), case auto-assign, outbound
   webhooks. One run per event dedupe key and cooldown; every run is written to
   `audit_log` (`automation_run`, system actor) so automated decisions stay auditable.
   The v2 rework — trigger/condition graph, incident contract, durable timers — is
   specified in `docs/AUTOMATION-V1.md`, the counterpart to `docs/INCIDENTS-V2.md`.
7. **On-Call** (`engine/oncall.js`, `engine/alert-chain.js`, `routes/oncall.js`,
   `routes/ack.js`, page `OnCall.tsx`) sits on the other side of that boundary — see
   `docs/ONCALL-V1.md`. Slices 1 and 2 are built: teams, schedules with rotation
   layers and overrides, the resolution function that answers "who has the duty" for
   any instant, and the alert chain — escalation policies, per-person contact methods
   and notification rules, acknowledgement, and cancellation when the subject closes.
   It is native rather than flow-driven because alerting a human is load-bearing — a
   chain that exists only because somebody drew it is a configuration, not a
   guarantee. Flows raise an alert and react to its outcome; they never contain the
   ladder.

   Three properties are worth knowing before touching it:

   - **Rotations are computed, never materialised.** Generating shift rows forward
     would run forever, need regenerating on every roster edit, and would disagree
     with the formula the moment one generation was missed. Only overrides are stored.
   - **The period is counted in the schedule's timezone.** A weekly handoff at 09:00
     Europe/Berlin stays 09:00 local across a DST change; fixed millisecond periods
     from a UTC anchor move it by an hour twice a year, into the middle of a shift.
     `engine/oncall.js` counts whole LOCAL calendar days and compares local wall time.
     `e2e-oncall.js` pins that with a CET anchor and a CEST handoff, because an
     autumn date would let the naive implementation pass.
   - **A gap is an event.** A schedule that resolves to nobody raises `oncall_gap`
     (severity 70), once per episode, re-armed when covered — a swallowed alert looks
     exactly like a quiet night otherwise. A schedule with no participants at all
     raises nothing: half-built is not broken.

   The timeline endpoint SAMPLES the resolver every 30 minutes and coalesces, rather
   than solving for boundaries: rotation period, layer restrictions and overrides
   interact, and a closed-form walk would be a second implementation that can
   disagree with the first.

   The **alert chain** (`engine/alert-chain.js`) adds four more, and every one of them
   is a failure mode whose symptom is silence:

   - **Targets resolve late, deliveries fan out early.** A step's targets are expanded
     to users at the moment the step BEGINS, never at alert creation, so a handover
     mid-escalation reaches whoever is on call now. Each user is then notified through
     their own rules in parallel, and the step timeout is ONE timer for the step.
   - **Nothing lives in `setTimeout`.** The escalation clock is a row in `alert_timers`
     driven by `lib/timers.js` — the shared mechanism `flow_waits` will adopt
     (ONCALL-V1 §9.3) — with a claim lease and a sweeper that picks up on boot whatever
     fell due while the process was down. `e2e-alerts.js` proves that with a SECOND
     process against the same database.
   - **Every terminal transition on a subject cancels its alerts.** That is what forced
     `lib/cases.js` into existence: eight write sites closed a case, and the ninth would
     have forgotten. An alert still ringing about a problem that resolved five minutes
     ago is the exact failure the module exists to prevent, and it arrives through the
     back door of a missed call site.
   - **"Nobody" and "unreachable" are events, not nulls.** A step whose schedule
     resolves to nobody raises `oncall_gap` and escalates IMMEDIATELY rather than
     waiting out its timeout for a person who does not exist; a step where every
     contact method of every target failed raises `alert_undeliverable` (severity 85);
     a policy that ran out of rungs raises `alert_exhausted` (85). A rule may not target
     a policy ON those three names — that loop would escalate itself forever, and the
     refusal is written to the notification log rather than being silent.

   Acknowledgement rides a single-use token (`/a/:token`, 32 random bytes, SHA-256 at
   rest, 24 h). **`GET` renders a button, `POST` performs it** — corporate mail scanners
   fetch every URL in a message, so an acknowledging GET would silence alerts before the
   human looked at their phone, silently, and only for the customers whose gateway does
   it. An ack writes `cases.acked_at`/`acked_by` and deliberately NOT
   `assigned_user_id`: acknowledging at 03:02 is a reflex, owning the case is a separate
   statement, and conflating them makes the person who only silenced their phone the
   owner in the statistics.

   A person's delivery plan has three tiers, each a fallback for the one above: their
   notification RULES for the alert's urgency, else every contact METHOD they have
   registered, else their ACCOUNT E-MAIL. The last tier is what keeps a fresh org from
   building a perfect ladder that reaches nobody.

   **The loud channels** (`lib/telephony.js`, `lib/webpush.js`, `routes/voice.js`) are
   an ADAPTER, never a vendor: three implementations — Twilio, Vonage, and a plain
   `webhook` for a self-hoster's own gateway — behind `sendSms` and `placeCall`. Which
   provider OpsCat runs itself is deliberately undecided, and the adapter is what keeps
   that reversible; the `webhook` implementation is what makes the loudest channel
   something the community edition can actually do. Four properties:

   - **A voice call speaks AND listens.** The provider is handed a callback URL, not a
     recording: `routes/voice.js` answers with TwiML or NCCO that reads the alert and
     then gathers a digit, and `1` acknowledges. Without the second half it is a
     robocall — the person is awake, knows something broke, and still has to find a
     laptop. **Fetching that call flow must not acknowledge**: the provider fetches it
     before the phone has rung, which makes it a mail scanner with a phone line.
   - **A number is ciphertext at rest and useless until verified.** AES-256-GCM with the
     app secret (the SNMP pattern), and an sms/voice method is never rung before a
     six-digit code — hashed, 15-minute TTL, five tries — has come back. A wrong number
     costs money on every escalation and wakes a stranger.
   - **The plan gate is at SEND time.** `sms`/`voice` are plan features from `pro` up,
     the only two in the whole module, and the line is drawn at MARGINAL COST rather
     than value. A contact method belongs to the person, not the org, so the number is
     stored once and each org checks its own plan when it tries to use it — with the
     refusal written to the notification log in the same words the screen shows.
   - **Every metered send reports a cost.** `notifications.cost_micros`, from the
     provider when it knows one (Vonage prices an SMS immediately; Twilio only after the
     call completes) and from the org's configured per-message figure when it does not.

   **The numbers** (`GET /api/oncall/analytics`, Analytics › On-Call) are four, and the
   third is the one that changes behaviour: MTTA (over acknowledged cases ONLY — the
   unacknowledged ones are reported beside it rather than averaged in as zero), the
   escalation and "reached nobody" rates, **out-of-hours load per person**, and alerts
   per schedule. Out-of-hours is folded in JS rather than in SQL: it is a question about
   each person's OWN local time, so `alert_attempts` go through the
   same `localParts` the rotation engine uses, and the response says which zone each
   person was counted in and where it came from. A rotation can look perfectly fair on a
   calendar and still land every single night on one name.

   Web Push is the free loud channel: `web-push` for RFC 8291 payload encryption, VAPID
   keys minted once into `settings` (regenerating them silently invalidates every
   browser), and a service worker that **caches nothing** — a NOC tool serving a stale
   dashboard is worse than one that fails to load. On iOS Safari delivers push only from
   a home-screen-installed app, which is a constraint the UI states rather than letting
   somebody discover through a permission prompt that never appears.

**Scout** (`engine/scout.js`, Pipeline → Scout tab) mines rule suggestions from
lines no classifier matched: variable parts are masked (`<IP>`, `<NUM>`, …),
identical/similar masked lines group into templates (a lightweight Drain), and
frequent templates surface for curation — AI-suggest a name/severity, approve
into a real classifier rule, or dismiss. Masking runs only for unmatched lines
and counts are buffered (5 s flush), so the ingest hot path stays cheap.

AI features call the org's LLM through `server/src/llm.js` (OpenAI-compatible
chat completions): org override (Settings → AI & Voice) → platform default (super-admin
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
| `reputation_listings` | one row per **episode** of being listed — `subject` + `zone` + `first_seen` / `resolved_at` | **kept** |

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
- **Resolver**: the `unbound` compose sidecar (`unbound/`), overridable with
  `OPSCAT_REPUTATION_DNS`. This is not a preference, it is the difference between the
  feature working and quietly not: DNSBLs refuse queries arriving through a large shared
  resolver, and *measured on the production host* every Spamhaus zone answered
  `127.255.255.254` ("use your own resolver") because the container resolves through
  `systemd-resolved` → the hoster's upstream. Queried **directly** against Spamhaus'
  authoritative servers from the same machine, the canary answered correctly — so the
  address was never the problem, only the middleman. A recursive resolver of our own
  fixes it; a different *public* resolver would not, since Quad9 and friends are refused
  for the same reason. The sidecar is never published to a host port (an open recursive
  resolver is a DNS-amplification reflector) and the app deliberately does **not**
  `depends_on` it: if it dies, Reputation degrades to `unknown`, which it reports
  honestly, rather than holding up the app. One trap worth knowing: unbound drops answers
  from private ranges as rebinding protection, and DNSBLs answer from `127.0.0.0/8` — so
  loopback is deliberately absent from `private-address` in `unbound.conf`. A second
  one cost a deploy: Node's `Resolver.setServers()` takes **addresses only**, so
  `OPSCAT_REPUTATION_DNS=unbound` (a compose service name) threw
  `ERR_INVALID_IP_ADDRESS` on every call — and a bare `catch` sent every lookup back to
  the refused host resolver without a word. Names are now resolved through the system
  resolver, cached with a 10-minute TTL so a sidecar restart onto a new container IP is
  picked up, and nothing about resolver selection fails quietly any more.
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
- **SPF discovery finds the assets.** `POST /api/reputation/discover` reads a domain's SPF
  record and proposes what to watch, because the address worth finding is the one nobody
  remembers — asking the operator to transcribe it just relocates the problem. Only
  mechanisms written **directly** in the record (`ip4`, `ip6`, `a`, `mx`) become
  candidates: an `include:` delegates to a provider whose shared pool is thousands of
  addresses they monitor themselves, and offering those would bury the eight that are
  actually the org's. Those are reported as *pools* with their lookup cost instead.
  `redirect=` is the exception — RFC 7208 §6.1 has it *replace* the record, so its
  mechanisms recurse as top-level. CIDR blocks wider than `/32` are reported as *ranges*,
  since DNSBLs answer about addresses, not networks.
- **The SPF lookup budget comes out of the same walk**, and it outranks every blocklist
  verdict: exceeding RFC 7208's limit of 10 DNS lookups is a **PermError**, which means SPF
  fails outright no matter how clean the addresses are. link11.com's own record needs 11.
  Discovery reports `lookups {used, limit, permerror}` and surfaces it in the picker,
  alongside the other things that walk turns up — a domain with no SPF at all, two SPF
  records (a PermError in itself), a deprecated `ptr`. Bounded by design: a lookup budget,
  a depth cap and a hard query ceiling, so a looping or hostile record cannot fan out.
- **A domain's mail servers are checked too.** The RHSBLs only ever answer about the
  domain NAME; the hosts its MX records point at are separate addresses on separate
  lists, and for a self-hosted mail server they are the org's own problem — a listed MX
  means inbound mail is being refused, which the domain's RHSBL verdict says nothing
  about. Findings ride on the same asset, distinguished by `subject` (`''` = the asset
  itself, otherwise `mail4.example.com [1.2.3.4]`), so "the domain is on DBL" and "its
  mail server is on ZEN" stay separate facts with separate lifecycles — including on the
  same zone at the same time, which is why the unique index spans
  `(asset_id, subject, zone)`. `subject` is `NOT NULL DEFAULT ''` on purpose: NULLs
  are DISTINCT in a unique index, so a nullable column would quietly permit
  several open episodes for the asset itself. Capped at 3 distinct addresses and
  de-duplicated (several MX names sharing one address is the norm) — each one is a full
  ~31-zone lookup, so an unbounded fan-out would be ~250 queries against lists that
  rate-limit per source IP.
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

## Status pages (and what they cost)

The status page is the only OpsCat surface a customer's *own* customers ever look
at, so its identity is theirs: logo, favicon, accent colour, light/dark,
description, support and legal links (`lib/status-branding.js`).

Since schema v18 it is also a **row** rather than an implicit per-org thing
(`lib/status-pages.js`). Three features forced that: a custom domain points at
one page, not at an org; an audience-specific page shows a subset of the
components; and a private page needs its own visibility. An org gets a default
page whose slug is the org's slug — which is what keeps every pre-v18 URL
working — and `defaultPage()` creates it lazily rather than at every one of the
three places an org can be minted, so the invariant "an org has a status page"
holds by construction instead of by everyone remembering.

A page resolves most-specific-first: **verified domain** → **slug** → the origin
default. Whichever way a visitor arrived, every URL the page prints is built from
that same prefix — a visitor on status.acme.com must never be linked back to
opscat.io.

**All of that is free on every plan, Free included, and that is a pricing
decision rather than an oversight.** A status page is public. A Free one wearing
a generic OpsCat mark does not pressure anyone into upgrading — it advertises us
badly, in front of the one audience that did not choose us. Competitors bear this
out: Better Stack ships branding in its free tier, and the tiers that do charge
for it charge for *distance from the vendor*, not for identity. So the paid flags
in `plans.js` are exactly the distance ones: `status_whitelabel` (business+,
hides the "Powered by OpsCat" footer), `status_domain` (pro+), `status_css`
(business+), `status_pages_multi` (enterprise). `statusSubscribers` is a limit
rather than a flag because it grows with the customer's own success.

Five decisions in these modules are load-bearing:

- **Validation is the injection boundary, not input hygiene.** The accent is
  emitted *inside a `<style>` block*, where HTML-escaping buys nothing — so it is
  matched against `#[0-9a-f]{6}` and falls back to the default on anything else,
  on write *and* on render. Never "escape it" instead. Links are checked for an
  http(s) scheme so `javascript:` cannot reach an `href`.
- **Uploads are typed by their bytes, and SVG is refused.** An SVG is a
  script-bearing document: harmless inside an `<img>`, but `/status/logo` can be
  opened directly, and then it executes on the status page's own origin. Refusing
  the format deletes the class of bug; a logo is a PNG everywhere else anyway.
  The declared content type is a claim, the magic bytes are the fact.
- **Every paid bit is gated at RENDER time, not by clearing the column on
  downgrade.** The org keeps its intent — footer hidden, CSS written, domain
  configured — the behaviour stops while the plan lacks the feature, and an
  upgrade restores all of it without anyone re-typing anything. Same reason the
  write is refused with a 403 rather than silently stored: an admin who flips a
  switch and sees nothing change blames the product, not their plan.
- **A custom domain is only served once DNS PROVES it.** Proof is a TXT record at
  `_opscat-challenge.<domain>`; the CNAME that routes traffic is deliberately not
  proof, because a dangling CNAME left by a former owner would hand the name to
  whoever asks next. The same verified-and-plan-covered check answers Caddy's
  on-demand-TLS `ask` endpoint (`/api/public/tls-check`) — answer that broadly
  and the deployment becomes an open certificate mint whose ACME rate limit is
  gone within an hour of the first bot finding it.
- **A private page 404s, it does not 403.** A 403 confirms that a page with that
  slug exists, which is exactly the fact a private page is hiding. It is a
  shared-link audience (everyone with the link is in, rotating revokes), not
  per-person auth — stated plainly here because the honest scope is smaller than
  the words "private page" suggest.

Assets are blobs in `status_assets` rather than files on disk — the database is
the only store the Docker deployment persists — and are served same-origin, so
they need no CSP `img-src` entry. They 404 while the page is unpublished: an
unpublished status page must not leak its org's logo either.

The admin preview (Status Page › Branding) renders from `resolved`, the *same*
object `brandingFor()` hands the public page, instead of re-deriving the palette
in the frontend. A preview that computes its own colours is a preview that
quietly stops matching the thing it previews.

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

## Boot sequence

`src/index.js` builds the Express app at require time and then runs an **async
`boot()`**, in this order, with `app.listen` LAST:

1. `db.init()` — applies `src/schema.sql`, which is idempotent (`CREATE … IF NOT
   EXISTS` throughout), so it creates a fresh install and leaves an existing database
   alone; then any migration file in `src/migrations/` numbered above the version the
   database carries; then the settings cache and `app_secret`.
2. `seed()` — default organization, first super-admin, default components, checks and
   alert rule. Idempotent.
3. The engines' `start()` timers.
4. `app.listen`.

**`/api/health` answering means the app is fully booted**, not merely that the port is
open — the e2e harnesses' `waitForServer()` is a stricter gate than it was.

### Changing the schema

`schema.sql` describes the databases that do not exist yet; a numbered file in
`src/migrations/` (`026-add-cases-owner.sql`, plain PostgreSQL, no wrapper) moves the
ones that do. Each runs in its own transaction and is recorded in `schema_migrations`;
a FRESH database is stamped at the highest number and runs none of them. Migrations are
one-way — a rollback of a schema change on a live database is a restore, not a script
nobody has run.

**Both are written in the same commit.** They describe different populations, so
nothing can detect a half-done change from one side: edit only the migration and every
fresh install is missing the column, edit only `schema.sql` and production never gets
it. `e2e-schema.js` guards what is mechanically checkable — that `schema.sql` applies
to an empty database and applies AGAIN (boot runs it every time, so a statement without
`IF NOT EXISTS` works exactly once and then kills every restart), that the numbering
rules hold, and that the loader actually applies and records a pending migration.

This replaced a 25-step migration ladder in `db.js` built from `PRAGMA user_version`
and table rebuilds through `sqlite_master`. It was SQLite's history and was never run
on Postgres, so it went with SQLite; `schema_migrations` keeps the number it recorded
(25) as the baseline, which is what makes an existing production database
indistinguishable from a fresh one.

## Scaling / HA path (documented now, executed when load demands)

Current: 1 VPS ≈ everything. The seams are already cut so each step below is isolated:

1. **Vertical**: bigger VPS; PostgreSQL handles this workload with room to spare — see
   the measurements in `docs/POSTGRES-MIGRATION-PLAN.md` § 0a.
2. **Split storage**: ClickHouse for the high-volume time series (logs, metrics,
   synthetic results), PostgreSQL keeping the metadata. All SQL lives in the storage
   layer; ingest/report queries are the only hot spots.
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

**A fixed pixel width inside a viewport-sized box is a promise the viewport cannot
keep.** The event slide-over is 520px on a desktop and `92vw` on a phone, and its hit
trend was drawn at a hard-coded `w={470}`: on a 390px phone the panel is 358px, so the
panel scrolled sideways by 132px onto blank space. `Spark` takes a `fluid` prop for
exactly this — it measures the box it is in (ResizeObserver) and draws at that width,
rather than stretching a `viewBox`, which would scale x and y differently and thin the
stroke while turning the last-point dot into an ellipse.

This class of bug is invisible to the per-route sweep, and that is worth understanding
before adding the next overlay: the sweep ignores anything inside a scroll container
(that is how `TableScroll` is allowed to exist), and `.slide-over` is one, because
`overflow-y: auto` makes the browser compute `overflow-x` to `auto` next to it. So a
panel is a scroller by accident, with no fade, no affordance and nothing out there to
find. `probe-mobile.mjs` therefore checks `.slide-over` separately: a panel is not a
table, and its content must fit its width.

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

### Form control primitives, and why width is a prop

`Input` (text-like), `Textarea` (multi-line) and `DateTime` (`datetime-local`) live in
`ui.tsx`; `Select`/`MultiSelect` in `Select.tsx`. There is no bare `<input>`/`<select>`/
`<textarea>` in a page.

`Input` draws its value at an **optical 14px** while telling Safari 16px — `.ctl` in
`tokens.css` applies `transform: scale(.875)` and compensates the layout box with
`width: calc(var(--ctl-w, 100%) / var(--ctl-s))` plus a negative margin. A transform
shrinks what is *painted*, not what is *measured*, so the zoom cannot fire while the
value stops towering over its 13px label.

That compensation is the reason **width is a prop**: only `width` sets `--ctl-w`. Given a
width through `style`, a `w-*` class or `flex`/`minWidth`, the element's layout box is set
by the utility while the compensation still divides 100% of the *parent* — the two
disagree and the control ends up wider than the space it was given. Measured on
`/app/settings` at 390px: three maintenance-window controls sized with
`style={{ flex: 1, minWidth: … }}` produced a `datetime-local` that overlapped its
neighbour by 6px and ran 8px past the card.

`DateTime` exists because `datetime-local` is the one input whose **intrinsic** width
matters — the browser sizes it to fit the locale's date+time ("05.08.2026, 09:21"), which
is wider than any layout guess. So the width lives in the primitive (190px), once, and
call sites override only through `width`.

`scripts/probe-mobile.mjs` hit-tests every `.ctl`/`.ctl-ta` against its parent box and
fails on a spill. It replaced a static lint rule that grepped for inline sizing: that rule
flagged 14 call sites and exactly one of them actually broke.

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

`web/src/Select.tsx` is THE dropdown, for **every** list. Three problems drove it: a
native select is sized by its **longest option** (data dictates layout width), it cannot
be searched or hold multiple values, and on a phone iOS replaces it with its own wheel.

It began as the answer for *data-fed* lists only, with a `NativeSelect` primitive kept
for short static ones (status, role, log level). **That split is gone** — the native
control's remaining advantages were narrow (no iOS focus zoom, the platform wheel) and
did not pay for a second dropdown with a different look, a different keyboard model and
a different panel. There is now no `NativeSelect` and no bare `<select>` in the app;
26 call sites were converted at once.

Two things that conversion has to preserve, both easy to lose:

- **The iOS focus-zoom immunity.** A `<select>` never triggers it. `Select` keeps that
  by never putting a sub-16px text field on screen — the trigger is a button (buttons
  cannot be typed into, so iOS never zooms) and the only real input, the search box, is
  a full 16px inside the panel.
- **Form validation.** A `<select required>` made the browser refuse the submit.
  `Select` is a button and takes part in no constraint validation, so every converted
  `required` needs its guard re-created in the submit handler — see the region picker
  in `SuperAdmin.tsx`, where dropping it would have posted an empty `providerRegion`.

- **Phone (≤720px): bottom sheet, search in the FOOTER**, options above it. Search at the
  top vanishes behind the keyboard the instant you type: `position: fixed` anchors to the
  *layout* viewport and iOS does not shrink that for the keyboard. Hence `--kb`, measured
  from `visualViewport` (`innerHeight − vv.height − vv.offsetTop`) and re-measured after
  the keyboard animation. Verified on a real iPhone before the component was written.
  Option rows are 44px; swiping the sheet down closes it (the grab handle promises that
  gesture, so it has to work).
- **Desktop: an anchored popover** — `position: fixed` from the trigger's rect, so no
  clipping ancestor (`.tbl-scroll`, a card) can cut it off; flips upward when there is no
  room below. It needs no portal: the panel lives in the **top layer** (below), which
  escapes every clipping and transformed ancestor by itself.
- **Search appears at ≥13 options** (`searchable="auto"`). 13, not 10, so a month or
  hour picker does not get a search box it does not need. Override with
  `searchable={true|false}`.
- **MultiSelect** shows pills in the trigger up to 5 selections; beyond that the trigger
  goes compact (one pill + "+N more") and the full set lives in an overview that opens
  **upward** over the trigger — an overview that pushed the form down would move the very
  field the user is looking at. Two pills already need three lines at 390px, which is why
  "compact" means one.
- **The panel swallows the click's DEFAULT ACTION** (`preventDefault` on the panel root
  and on the MultiSelect overview). `Field` (`ui.tsx`) is a `<label>` that *wraps* its
  control, and the panel is deliberately a DOM descendant of `.sel` (no portal, see the
  top layer below) — so a click in the panel is a click inside that label, whose default
  action is "fire a click at the labeled control", i.e. at the trigger. Measured in
  Chromium: picking an option gave the real click (`detail=1`) on `.sel-opt` and then a
  second *trusted* click with `detail=0` on `.sel-trigger`; `setOpen(false)` had already
  run, so the trigger read `open === false` and re-opened the panel. Symptom: picking did
  not close the picker, and clicking the scrim "did nothing" (it closed and re-opened in
  the same gesture). 22 pickers across 11 pages sit inside a `Field`. `stopPropagation`
  does **not** help — only `preventDefault` cancels an activation behavior.
- **a11y:** trigger is `role="combobox"` + `aria-expanded`, panel is `role="listbox"` with
  `aria-selected` / `aria-activedescendant`; arrows move the highlight, Enter picks,
  Escape closes (handler on `document` — after a drag the focus is outside the panel),
  and focus returns to the trigger on close.

## Frontend stacking (the top layer, and the --z-* scale under it)

The app used to order every floating surface by a number. It carried **19 z-index
values** (1, 2, 5, 30, 80, 90, 94, 95, 96, 100, 110, 111, 120, 200, 300, 9999) spread
across `tokens.css` and seven components, with nothing stating how they related — and
that is how a bottom sheet opened from inside a modal ended up **behind** it. Nothing
about that bug was visible in the markup: the sheet was in the DOM, at the right size,
at the right position. It was simply painted underneath, because `Select` portals to
`<body>` and is therefore a *sibling* of the modal, so JSX nesting bought it nothing and
only the number decided.

Two answers, layered:

**1. The named scale (`--z-sticky` … `--z-full` in `tokens.css`).** Every layer is a
token with a comment saying what it sits above; never a literal `z-index` at a call site.
It still governs the surfaces that stay in the page: the sticky table head, the shell
bar, the phone nav rail, the slide-over, the command palette.

**2. The browser's TOP LAYER, for anything that floats over a surface.** `Modal` is a
real `<dialog>` shown with `showModal()`; the `Select` panel and the hover tooltip use
the **Popover API** (`popover="manual"`, driven by `web/src/toplayer.ts`). The top layer
paints above every z-index in the document and orders by **"last opened wins"**.

That ordering *is* the rule the scale had to state by hand — "a picker sits above the
surface that opened it" — except a picker is by definition opened *later*, so the
platform enforces it and there is no number left to get wrong. It also removes the
portal: a top-layer element escapes every clipping and transformed ancestor on its own,
and staying a DOM descendant of the dialog is what keeps the panel **out of the inert
subtree** `showModal()` creates around everything else. `showModal()` additionally brings
`::backdrop`, Escape and a focus trap, none of which the old modal had.

Three constraints that are easy to get wrong:

- **Both surfaces convert together, or neither.** A browser with `showModal` but without
  the Popover API (Safari 16) would put the dialog in the top layer and leave the picker
  on `z-index: 130` — i.e. the original bug, in a browser nobody tests. `Modal` therefore
  gates `showModal()` on `HAS_POPOVER` and otherwise falls back to a flat `[open]` dialog
  ordered by `--z-modal`, drawing its own dim (`::backdrop` exists only for a *modal*
  dialog). `scripts/probe-overlays.mjs` checks that fallback with the Popover API deleted
  before load.
- **`popover="manual"`, not `"auto"`.** Auto brings light dismiss, which hides the
  popover on pointerdown; the trigger's own click handler then runs against state that
  already flipped and re-opens it. These panels bring their own scrim, Escape handler and
  React state — the only thing wanted from the platform is the layer.
- **The scrim rides up with the panel.** Both live inside one `.sel-layer` wrapper that
  is the popover. A scrim left behind in the page would dim everything *except* the modal
  it was opened from.
- **No transform on the way down to a modal's contents.** A transformed ancestor becomes
  the containing block for `position: fixed` inside it, which is what the picker's
  fallback path uses. `.modal-dialog` centres its panel with flex, not
  `translateX(-50%)`.

The `--z-modal` / `--z-picker` / `--z-tip` tokens stay in the scale as exactly that
fallback, and as the order those surfaces would take if they ever left the top layer.

## Frontend URL state (what belongs in the address bar)

Three kinds of app state are addressable, and they use three different parts of the URL
because they answer three different questions:

| state | where | written by |
|---|---|---|
| which page | `/app/<page>` | `setNav` (`state.tsx`) |
| which tab of that page | `/app/<page>/<tab>` | `useTab` (`state.tsx`) |
| which **overlay** is open on top | `?event=<id>`, `?node=<id>`, `?incident=<id>`, `?check=<id>`, `?vendor=<id>`, `?asset=<id>`, `?schedule=<id>`, `?alert=<id>`, `?page=<id>` | `setSelectedEvent` / `useOverlayParam` (`state.tsx`) |
| which **filter/window** a page shows | `?q=…&from=…&to=…`, `?sev=`, `?status=`, `?who=`, `?alerts=` | `useQueryState` (`state.tsx`) |

The filter row is the newest of the four and follows the same argument: "the four
minutes where ingest spiked" is a place, and a place has an address. It differs from the
other three in its history shape — it **replaces** rather than pushes, because a filter
is refined by typing and one entry per keystroke turns the back button into an undo
buffer for a text field. The entry worth having was already pushed by whoever navigated
there: `setNav('logs', '?from=…&to=…')` carries the filter INTO the page, which is how
Scout opens the lines behind a template and how the throughput chart opens the lines
under a dragged-over span. Both go through `setNav` rather than an `<a href>` so the
jump stays a SPA navigation.

`useOverlayParam`'s setter takes a second argument, `replace`, for a selection the
READER did not make. A master-detail page (Incidents) opens a row for you when it loads;
pushing that is a trap, because Back returns to "nothing selected", the page re-selects
at once and the button looks broken — there was no state worth going back to. The same
applies to re-asserting the open row after a mutation, which is a refresh rather than a
navigation. Everything the reader actually chose still pushes.

`scripts/probe-deeplinks.mjs` drives all four history properties (open pushes, switch
replaces, Back closes, a deep link stays put) in a real browser, because the address bar
looks right under all four even when the back button is broken. It found nothing on the
pass that introduced it, which is the point of writing it while the shapes were fresh.

The event slide-over is the overlay case. It is rendered by the shell, not by a page —
it floats over whatever is behind it — so it cannot own a path segment: the path already
says which page that is, and the tab segment is spoken for. A query parameter says the
right thing ("this page, plus this panel open") and survives a page that has tabs.

The history shape is the part that is easy to get wrong, so it is fixed in one place:

- **Opening pushes.** That is what makes the back button close the panel, which on a
  phone is the gesture people actually use — there is no visible × under a thumb.
- **Switching from one event to another replaces.** One history entry means "an event is
  open", not one per row a NOC operator clicks through during a shift.
- **Closing steps back** over the entry we pushed (`history.state.event` marks it as
  ours) instead of pushing a third entry, so open/close does not stack up pairs that
  the back button then has to walk through.
- **A deep link landed on has no entry of ours**, so closing it replaces instead —
  going "back" out of the app the reader just arrived in would be worse than useless.
- **Navigating away closes it.** `setNav` writes a URL without the parameter, so the
  state has to follow the URL, not outlive it.
- An id for an event that does not exist (finished, other org, typo) resolves to a 404,
  and the loader clears both the panel and the stale parameter.

The shape itself lives in **one function**, `writeOverlayParam`. An overlay opened from
a single page uses the `useOverlayParam(key)` hook (the fleet detail: `?node=4`); the
event slide-over keeps its place on the app context because three different screens
open it, but it writes its URL through the same function. Adding a second
implementation of "push on open, replace on switch, back on close" is how the two drift.

`scripts/probe-mobile.mjs` asserts the link exists after a row click — a deep link that
silently stops being written looks exactly like one that works.

## Event history (who did what)

A NOC handover starts with one question — *who touched this, and what did they say?* —
and until `event_timeline` existed the app could not answer it:

- **Notes were a single column.** `cases.note` is one TEXT field. Every "Add Note"
  ran `UPDATE cases SET note = ?`, so writing a second note destroyed the first, and
  nothing recorded who wrote either. The slide-over never displayed the column at all,
  so writing a note and losing one looked identical from the panel.
- **The audit log could not be queried back.** `sec.audit` stores the event as free
  text (`event 42 BGP_DOWN@core-01`), so "everything that happened to event 42" is a
  `LIKE` against a string with no index — where `event 4` also matches `event 42`.
  It stays what it is: the org-wide security log, not an object's history.

`event_timeline` (migration v17) is append-only: `event_id`, `ts`, `user_id`, `action`,
`detail`. `user_id NULL` means the platform acted, not a person. Three rules keep it
trustworthy:

- **Every writer records.** The panel (`POST /events/:id/action`), the Cases editor
  (`PATCH /cases/:id`) and the MCP tool `opscat_event_action` all append — an event's
  history must not have a hole where an agent or another screen acted. The MCP entries
  carry `[via <client>]` so the panel says a tool did it.
- **Only real changes.** A no-op is refused with 409 (already finished, already assigned
  to that user, severity at the floor) and a re-saved but untouched form records nothing.
  A history that fills with lines about clicks that changed nothing stops being read.
- **A derived entry states only what its source proves.** The opening `detected` line is
  derived from `events.first_seen`, so it is right for events that predate the table and
  needs no backfill — and it carries no severity, because `events.severity` is the
  *current* value and the line would have claimed "detected at severity 67" about an
  event that was detected at 92. The severity's history is the recorded `downgrade`
  entries (`"92 → 67"`), never an inference.

`cases.note` stays as the case's latest note (the Cases editor's field); the timeline is
the record. Nothing is lost any more, but the column is still last-write-wins by design.

## Page header (one band, every page)

`PageHeader` is a row whose height must not depend on whether the page has a CTA. It
used to: the row was sized by its tallest child, so a page with a button was 32px and
the same page on a tab without one was 24px — and the tab bar underneath jumped 8px as
you switched tabs (measured on `/app/platform/overview` vs `/app/platform/organizations`).
Synthetics had the opposite version of the same bug: it put its tab bar *inside* the
header's action slot, making that one header 44.5px and starting the page content 12px
lower than everywhere else in the app.

- `.page-head` reserves `--page-head-h` — the height of a default `.btn`, i.e. the
  tallest thing the action slot normally holds. With a CTA or without, the band is the
  same, so every page and every tab starts its content at the same y.
- The token is **32px on a desktop and 41px on a phone**, because the same button grows
  with the type scale. That was not a guess: the probe check below failed the moment the
  desktop number shipped alone.
- It lives in the *first* `:root` (next to the type scale), not the later one with the
  z-index tokens. The phone override is a `:root` of equal specificity, so it only wins
  over a definition that **precedes** it — put the token in the later block and the
  phone silently keeps the desktop value, with no visible symptom.
- The shape is title + actions, then `<Tabs>` **below**, never inside. `probe-mobile.mjs`
  compares the header height across routes and fails when they diverge.

## Table column widths

Every table is a CSS grid whose track list is one constant per table (~30 of them).
The components are shared; the widths were not, and the recurring failure is always the
same: a track list made almost entirely of FIXED tracks. The grid then cannot use the
width it is given, one flexible column absorbs all the slack, and the column with the
longest content truncates while there is free space on screen. The managed fleet shipped
as `minmax(120px,1fr) 110px 150px 92px 64px 70px 90px` — six fixed of seven — so
"Backed by" (`AWS eu-central-1 · standard`) was capped at 150px while "Location" grew
unbounded. Rebuilt from `COL`, the same table gives that column 344px.

- **Compose from `COL` (`ui.tsx`)**, which names tracks by what the column contains:
  `text`, `textWide`, `label`, `num`, `status`, `time`, `age`, `id`, `toggle`, `spark`,
  `tiny`, `actions`. Picking a width becomes "what goes in here?", a question with a
  right answer. **All 25 table grids in the app are composed from it** — there is no
  hand-picked pixel track list left to copy from.
- **At least one flexible track per grid.** `web/scripts/check-table-grids.mjs` runs in
  `npm run check:ui` (therefore in the build and the deploy) and fails on an all-fixed
  track list. Opt out with a `grid-exempt <NAME>: <why>` comment.
- **One definition, owned by the component.** `<TableScroll cols={GRID}>` sets
  `--tbl-cols` on the box it scrolls, and that box is the table's grid. The header and
  the rows are `grid-template-columns: subgrid` children of it, so they do not resolve
  tracks of their own at all — the arithmetic that produced the drift below simply has
  nowhere to happen. `@supports` guards the subgrid: an unsupported declaration is
  dropped, and a grid with no template stacks every cell into column one, which is a
  worse failure than the one it replaces — so both paths are spelled out, and the
  fallback reads the same `--tbl-cols`. `TableSkeleton` takes the track count from a
  context rather than a second copy of the constant; two tables cannot use it without
  a `TableScroll` (Logs' rows scroll vertically in their own box, so head and rows are
  not siblings) and those set `--tbl-cols` on their own wrapper — still one definition,
  just without the subgrid half.
- **No track sized by CONTENT.** `.tbl-head` and `.tbl-row` are separate CSS grids —
  each has its own `display: grid` in `tokens.css` — and share only the track *string*.
  An intrinsic track (`max-content`, `min-content`, `auto`, `fit-content`) therefore
  resolves against each element's own cells. `COL.actions` was `max-content`; measured on
  Platform › Organizations at 1990px that is 55px in the header (the word "ACTIONS") and
  272px in the row (a Select plus three buttons), and the 217px difference is absorbed by
  the flexible track, so the header's first column came out 217px wider and every label
  after it stood 217px right of its data. Five tables were affected (organizations 217px,
  rules 130px, status-page components 31px, synthetics 16px, super-admins 4px).
  `actions` is now three fixed sizes — `actions` 84px (one or two icon buttons),
  `actionsWide` 148px (short labelled buttons), `actionsBar` 312px (a control plus
  labelled buttons) — each measured against what the bar actually holds. The same check
  script rejects an intrinsic track in a grid constant **and in `COL` itself**.

  Two things about this are worth keeping: the shared constant was byte-identical
  throughout, so no amount of reading the source could reveal it — sharing the string is
  not sharing the geometry. And it only exists above the width where the grid has free
  space to distribute: at 1280px both elements sit at the flexible track's floor and the
  table looks perfect, which is exactly the width the change had been reviewed at.
  `scripts/probe-shots.mjs` now compares the head's and the first row's computed
  `gridTemplateColumns` at every width it shoots.
- **Fixed is for content with a ceiling** — a pill, a count, a timestamp. Never for a
  name, a URL, a description or anything joined out of several fields.
- **Give the slack to the column whose CONTENT is longest**, which is not always the one
  that looks most important. Three of the migrated tables had it backwards and only the
  measurement said so: Cases weighted "Root Cause" (a short phrase) over "Server" (an
  FQDN); Synthetics weighted the uptime heat bar (a flex element that looks the same at
  any width) over the check target; the audit log treated an action name like a short
  label. All three truncated a cell at 1440px until they were swapped.
- Four constants are deliberately **not** tables and carry a `grid-exempt` comment: the
  Classic terminal view (character cells, `8ch`), the live log stream (`max-content`, so
  the scroller sizes to the widest line), the slide-over's label/value layout, and the
  Component Lab's own skeleton demo.

## Managed fleet history

`node_timeline` records what happened to a managed sensor location: provisioned,
instance created (or the attempt failed), first probe check-in, visibility and tier
changes, teardown and whether the VM destroy succeeded. `user_id NULL` = the platform
acted, not a person.

It carries **no foreign key to `synthetic_locations` and no cascade**, which is
deliberate and is the one thing to preserve if this table is ever touched: teardown
DELETEs the location row — that is what revokes the probe key — and a history that
disappears with its subject is worthless exactly when it is wanted. "What did we do to
the location we tore down last week?" is a question you only ask afterwards. For the
same reason each row stores a denormalised `label` ("Frankfurt DE"): once the location
is gone there is nothing left to join a city name out of.

The detail slide-over (`?node=<id>`) is also where the facts that only ever existed in
the database finally surface — provider instance id, which platform credential paid for
it, agent version, provisioned-at. The list row deliberately does not carry them: a
fleet table with an instance id in it is unreadable, and this is the screen you open
when you need one.

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

## Cross-org access by a platform operator

A super-admin resolves into ANY organization by naming it — `?org=<uuid>` or the
`X-OpsCat-Org` header (`security.js`). Both doors are deliberate: the header is what
the platform console sends, and the query parameter is what makes a view shareable
("look at this tenant" pasted into a ticket), which a header cannot be.

The override skips the membership check and nothing else, so it used to leave no
trace on reads: writes call `sec.audit(...)` themselves and land in the target org's
trail, but looking through a customer's events, logs or settings was invisible. The
web server's access log was the accidental substitute — not an access record anyone
keeps, and not visible to the customer's own org.

Now entering a foreign org writes one `superadmin_org_access` row **in that org's**
audit trail. Three decisions in it:

- **Per entry, not per request.** Opening the Monitor fires a dozen calls; a row each
  would bury the record it exists to make readable. The de-duplication key is
  (session, target org) with a 30-minute TTL, so a session left open all day does not
  collapse into a single timestamp. The marker is in memory on purpose — it is a hint,
  not the record, and losing it on restart re-audits one access, which is the harmless
  direction to fail in.
- **The detail records `baseUrl + path`, never `originalUrl`.** A query string carries
  log search terms and filters — the customer's data — and an audit trail is the last
  place that should quietly accumulate it. It also names which door was used.
- **An org the operator belongs to is not cross-org.** That is ordinary work and
  already covered by `org_switch`.

Guarded by `e2e-crossorg.js`.

## Identity keys: users and organizations are UUIDs

`users.id` and `organizations.id` are `TEXT PRIMARY KEY NOT NULL` holding a v4
uuid, minted by the app (`util.newId`). Every column referencing them is TEXT too —
56 of them across 40 tables. Everything else (events, cases, checks, vendors,
incidents…) keeps its `INTEGER PRIMARY KEY AUTOINCREMENT`: those ids never leave
the tenant that owns them and are joined against constantly, where 1–2 bytes beat
36.

Four consequences worth knowing before touching this code:

- **There is no `lastInsertRowid`.** The shim refuses it outright; an insert mints
  its id first (`const id = newId()`) and names it, which also means the caller knows
  the id before the write — several call sites wanted that anyway. Use `stmt.insert()`
  (`RETURNING id`) for the integer-keyed tables.
- **`NOT NULL` on those two keys is documentation, not enforcement.** It is redundant
  under a PRIMARY KEY on this engine, and it is kept because it says what is meant. It
  was load-bearing on SQLite, which accepts NULL in a TEXT primary key and surfaces the
  failure as a foreign-key error somewhere else entirely.
- **The default organization has a FIXED id**, `DEFAULT_ORG_ID` in `util.js`
  (`00000000-0000-4000-8000-000000000001`). A dozen platform paths mean "the org" —
  the single-tenant community edition, the vendor grid, the default status page,
  every `orgId = …` parameter default. Those used to say `1`, which is exactly the
  magic number a uuid migration turns into a silent bug: an integer `1` now matches
  no row, and "no rows" is a legal answer everywhere. Naming it also keeps the
  migration deterministic — the old org 1 lands there on every install.
- **`ORDER BY id` no longer means "newest first"** for these two tables. Uuids do
  not count, so ordering by them is arbitrary; the platform org list orders by
  `created_at`.

The conversion from integer keys happened in migration 21, on SQLite, and both the
migration and the harness that verified it (`e2e-reputation.js` built a v10-era
database by hand and migrated it through) went with the ladder when SQLite was
removed. `schema.sql` declares these columns as `UUID` directly; there is no
pre-uuid database left anywhere to convert.

## Log retention (per org, ceiling per plan)

How long a tenant's log lines survive is `min(the org's own setting, the plan's
ceiling)` — `plans.retentionDaysFor(orgId)`, applied per organization by
`retention.pruneLogs()`.

The direction is the point. **Shortening is the org's own business** — "keep three days,
we do not want more of our customers' lines lying around" is a normal request, and a
GDPR-shaped one. **Lengthening is what the tier sells** (Free 7 · Pro 30 · Business 90 ·
Enterprise 365), so it cannot be a text field; the settings endpoint refuses an over-plan
value with a 400 that names the ceiling rather than clamping it silently. A field that
stores something other than what was typed is how the previous behaviour felt.

What it replaced, because the failure mode is worth remembering: the cleanup read
`getOrgSetting(1, 'retention_logs_days')` — **org 1's** setting — and then ran
`DELETE FROM logs WHERE ts < ?` with **no `org_id`**. On a single-tenant box that is
invisible. In the cloud it meant every tenant inherited our own org's 7 days, a Business
customer paying for 90 kept 7, a tenant changing the field saw it saved and nothing
happen, and `plans.retentionDays` was a per-plan number that no code path ever read while
the pricing page sold it. Guarded by `e2e-retention.js`.

Two adjacent numbers are deliberately NOT per plan: metrics (`agent_metrics`,
`agent_containers`) and check results (`synthetic_results`, `snmp_results`,
`reputation_runs`) age out at flat 30 days for everyone (`config.retentionMetricsDays` /
`retentionResultsDays`). They are fixed-size samples rather than customer content, and
the pricing page now names them as their own row instead of folding them into "log &
metric retention".

## Ingest throughput: why there are two counter tables

`ingest_stats` counts per HOUR and answers "how much did we take in". It cannot answer
the question a NOC actually sizes hardware on — *what burst does the ingest have to
survive* — because a 30-second spike of 5 000 lines/s divided over its hour reads as
~42 lines/s. Measured on a seeded burst: 16 lines/s from the minute counter against
0.27 lines/s from the same data averaged over the hour, a factor of 60.

So `ingest_minutes` counts per MINUTE, is written in the same transaction as the hourly
row, and is pruned to **48 hours** by `retention.js` — 1 440 rows per org per day, for a
number nobody reads back further than a day or two.

The consequence the UI has to carry: at 7d and 30d those counters do not span the range,
so `stats.peak.source` comes back as `'hour'` and the card says *"minute counters only
cover the last 48h"* instead of showing a per-second figure it cannot honestly compute.
An average wearing a per-second label is worse than an empty cell, because nobody
double-checks a number that looks precise.

## Classifier drafts and the dry run

A classifier rule is a piece of production behaviour: it renames events, changes their
severity and opens cases. So a rule is not born live.

- **`enabled: false` is a draft.** It is stored in the org's `classifiers` array like any
  other rule, listed in the UI and fully dry-runnable — `customClassifiersFor()` simply
  leaves it out when it compiles the chain. Only the literal `false` drafts a rule: a
  rule written before drafts existed has no `enabled` key at all and must keep
  classifying, so "absent" means live.
- **Scout proposes, a human enables.** Scout's action creates a draft (audited as
  `scout_draft`); switching it on is a separate, deliberate act under Classifiers. The
  button used to say "Approve" and the rule was live the same second — accurate about
  the write, misleading about the consequence. A rule added by hand starts as a draft
  too, so both routes into the chain go through the same three steps: write → dry run →
  switch on.
- **The dry run answers "what would this have done", not "does it match".** The single-
  line tester cannot show the failure that actually matters, which is *placement*: a new
  rule is appended last among the custom rules, and the chain is custom → builtin →
  syslog floor, first match wins. So `backtest()` classifies every scanned line with the
  chain as it stands today and splits the matches three ways — **shadowed** (an earlier
  custom rule wins, so the new rule never fires however well it matches), **takeover** (a
  builtin or the syslog floor owns the line today, it would be renamed), **fresh**
  (nothing classifies it today, genuinely new events). Plus the numbers a NOC actually
  budgets for: distinct events after dedupe, and cases at severity ≥ 60.
- **Bounded, and it says so.** Newest 20 000 lines, 2 s wall-clock — the pattern can come
  from a text field, and a pathological regex over the log table is a stalled request.
  Both limits are reported (`truncated`, `timedOut`) so a partial scan reads as a floor
  rather than a total.
- **The generated regex comes from the generator.** Scout's dialog shows the pattern the
  rule will have, and it is returned by the same server function that writes it
  (`templateToPattern()`), on the same request that just executed it. The alternative —
  re-implementing the 14-entry mask table in the browser — puts the preview and the rule
  in two places, and the copy that drifts is the one the admin was shown.

## Frontend charts (why an SVG is measured, not stretched)

`Spark`, `LineChart` and `StackedArea` (`web/src/ui.tsx`) all draw at the **measured
pixel width of the box they sit in** (`useBoxWidth`), never from a `viewBox` scaled to
`width="100%"`.

The `viewBox` version looks like the responsive answer and silently scales *everything*:
a 460×140 chart in an 1800px card is drawn at ~4×, so a 1.5px stroke lands at 6px, a
2px dot becomes 8px, an 8px axis label becomes 31px — and with no `height` the card
grows to 548px tall. That is precisely what the Pipeline throughput page looked like: a
full screen of blown-up line art. Measuring keeps every constant meaning what it says.

What the measured version has to get right, all of it found by measuring, none of it
visible in the diff:

- **The SVG may never widen its own box.** Until the observer fires the chart draws at
  its fallback width, and a 460px drawing inside a grid item (`min-width: auto` = its
  content) widens the track to 460px — the box then measures 460 and the chart stays
  wrong on a phone forever. `max-width: 100%` on the `<svg>` breaks that loop: clipped
  for one frame, never pushing the page sideways. Grid tracks holding charts use
  `minmax(min(320px, 100%), 1fr)` for the same reason.
- **Measure with a callback ref, not `useRef` + `useLayoutEffect`.** A chart returns its
  skeleton while data is `null`, so the render the effect fires on has no node — and it
  never fires again. The callback ref runs when the node actually attaches.
- **The axis gutter is derived from the widest label at the size it will really be
  drawn.** A fixed 46px gutter cut `176.6 KB` down to `76.6 KB`, which does not read as
  a clipped label — it reads as a chart whose middle gridline is larger than its top
  one. The label size is `--t-2xs`, which is 9px on desktop and **11px on a phone**, so
  the hook reads the resolved value off the box rather than assuming one; label widths
  are then arithmetic (JetBrains Mono advances 0.6em per character).
- **How many x-labels fit is the chart's decision**, not the caller's: 8 labels are
  comfortable in a 515px card and collide in a 308px one. Callers pass labels, the
  chart thins them (`fitLabels`) and clamps the first/last so they stay inside.
- **Axis maxima come from a fine "nice number" ladder** (1, 1.2, 1.5, 2, 2.5, 3, 4, 5,
  6, 8, 10 × 10ⁿ). With only 1/2/5/10 a peak of 5.1k pushes the axis to 10k and the
  whole series is drawn in the bottom half of the plot for nothing.
- **A NOC chart states its values.** `LineChart` carries a hover readout (`tips` gives
  the full label per point, `labels` is only the sparse axis) — a trend nobody can read
  a number off is decoration.

**Guard:** `web/scripts/check-charts.mjs` (part of `npm run check:ui`, therefore of the
build and the deploy) fails on an `<svg>` outside `ui.tsx` / `icons.tsx`, and on
`viewBox` + `width="100%"` / `preserveAspectRatio="none"` inside them. It is a *static*
rule on purpose: the defect exists only on a wide screen, so `probe-mobile.mjs` — which
measures a 390px phone, where the same viewBox scales down and nothing overflows — could
not have caught it. And unlike control sizing, which only the browser can judge, a scaled
viewBox is unconditionally wrong; there is no layout in which it means something else.
Opt out of either rule with a `chart-exempt` comment stating the reason.

## Errors the user can see (ErrorNote / FieldError)

There was no pattern — there were three lookalikes across ~99 call sites: a red
`<Card>`, a red `<div>`, a bare red `<span>`, in two different reds, none of them
announcing itself to a screen reader. A line of red prose next to a form field reads
as decoration, which is how "data (base64) required" appeared beside the logo picker
and looked like a caption.

- **`ErrorNote`** (`ui.tsx`) is the surface-level one: `role="alert"`, an icon, a
  tinted panel. Optional `onDismiss`.
- **`FieldError`** (`StatusPageAdmin.tsx`) is the one-line variant under a single
  control, for a value the server refused.
- **Neither is a toast, deliberately.** A toast leaves before the sentence is read
  and sits nowhere near the field to correct. Toasts are for things that SUCCEEDED
  and need no action.
- **A refused value keeps its draft.** The branding form used to revert to the stored
  value with nothing said — the accent snapped back to the default and the person was
  left guessing whether they had mistyped or the feature was broken. The save helper
  now takes the field name, reports under that control, and leaves the text alone so
  it can be fixed.

The ~99 legacy call sites are not swept yet; new work uses these two.

## Frontend form rows (FormRow / SwitchRow / CardNote / CopyField)

The geometry of a settings form — a fixed label column beside a bounded field,
stacking on a phone — has lived in `tokens.css` as `.form-row` for a long time. The
React wrapper around it did not: it was a page-local `Row` inside `Settings.tsx`. So
the class was shared and the component was not, and the second form to need this
layout — the status page's *Branding & pages* tab — grew its own instead. Measured on
the shipped page:

| Defect | Cause |
|--------|-------|
| ~280px of empty space in the page-picker card | `flex: '1 1 220px'` on a `Select` inside a **column**-flex `Field` — flex-grow then acts *vertically* |
| a 300-character description field stretched to 1160px next to 260px inputs | `Field` has no field-column cap; `.form-row-field` has `max-width: 420px` |
| the Logo/Favicon hint wrapped to three lines | a hand-rolled 120px label column beside `.form-row`'s 200px one |
| a toggle 900px from the label of the field above it | `justify-content: space-between` across the whole card instead of a field column |
| six cards holding one control each | no row primitive, so every setting became a card |

`FormRow`, `SwitchRow`, `CardNote` and `CopyField` now live in `ui.tsx` (and in the
Component Lab). `Settings.tsx` keeps `const Row = FormRow` — it names it ~90 times and
a rename would be diff noise — and its `ToggleRow` is now a thin binding of
`SwitchRow` to the settings draft.

Two rules the shapes encode:

- **A switch is a form field**, so it goes in the field column like everything else.
  `SwitchRow`'s `note` carries what a dimmed toggle cannot say on its own — *admin
  only*, *Business plan*. Without it a disabled switch reads as broken.
- **The geometry stays in `tokens.css`.** On a phone `.form-row` stacks the label
  above the field, and a media query cannot beat an inline style — so a call site
  passes `width` to the control, never `style={{ flex }}` to the row.

`CopyField` is the other half of the same story: a status page URL, a private link and
an ingest endpoint are all values that exist to be handed to somebody, and each had its
own read-only-input-plus-nothing. It copies on one click *and reports back*; a silent
button gets a second click, and the second click is what pastes twice.
`navigator.clipboard` is undefined outside a secure context, so it falls back to
selecting the text rather than failing silently.

## Status page components: what a "group" is

A component's group is a **label the component carries** (`components.grp`, `NOT NULL
DEFAULT 'Core'`), not a row in a table of its own. Groups are the distinct values in
use; the public page renders one heading per group. This is deliberate: "define a
group" and "put something in it" are one act, and a second entity would need its own
CRUD, ordering and rename story before it earned the extra join.

What was wrong was the **input**, not the model — the admin field was free text, so a
typo silently created a second group (`Core` beside `core`) and nothing showed you what
already existed. `GroupPicker` (`StatusPageAdmin.tsx`) is a `Select` over the groups in
use plus a *New group…* option that swaps in a text field; the same component sits in
the components table and in the add-component dialog. If ordering or a rename that
moves every member ever becomes worth having, that is the point at which a
`component_groups` table earns its keep — and not before.

## Settings page (six tabs, addressable)

`Settings.tsx` was one scroll of twelve unrelated cards — billing, platform fields,
five notification providers, two LLM endpoints, maintenance windows, API keys, OAuth
grants, agents, SNMP targets and system info — with nothing between them. It is now
one tab per job, via `<Tabs>` + `useTab` like every other tabbed page, so each half of
it has a URL:

| Tab | URL | Cards | Visible to |
|-----|-----|-------|-----------|
| General | `/app/settings/general` | Organization (name, backend label, log retention, status page published) · System | everyone; System admin-only |
| Notifications | `/app/settings/notifications` | Sender addresses · Channel credentials (Microsoft Teams / Telegram / Pushover) · Maintenance Windows | everyone; editing admin, windows lead+ |
| AI & Voice | `/app/settings/ai` | AI (chat endpoint) · Voice / Transcription (STT) | admin only — the tab is not rendered for anyone else |
| API & Access | `/app/settings/access` | API Keys · Connected apps (the caller's own MCP/OAuth grants) | keys lead+, connected apps everyone |
| Agents & SNMP | `/app/settings/collectors` | Agents · SNMP Targets | agents everyone (edit lead+), SNMP lead+ |
| Billing | `/app/settings/billing` | Plan & Billing (usage bars, upgrade, Stripe portal) | everyone; buying admin |

Three things fall out of the split and are easy to get wrong again:

- **One draft, two tabs.** General and Notifications both PATCH `/api/admin/settings`,
  so the draft lives in the page (`useSettingsDraft`) and both tabs render the same
  `SaveBar`. Switching tabs must not drop an edit, and one save has to write both;
  the bar says *Unsaved changes* so the shared draft is visible rather than implied.
- **Each tab fetches its own data**, on mount of the tab, not of the page. Opening
  Settings no longer fires six requests for cards nobody looked at.
- **Role gates decide the tab, not just the card.** The AI tab would be empty for
  non-admins (`/api/admin/ai` is `requireRole('admin')`), so it is not offered at all;
  cards that a role may only partly see still fall back on a 403 from their own fetch.

Stripe returns to `/app/settings/billing?billing=success|cancel` (`routes/billing.js`).
The tab has to be picked from that query **during render** — `useTab` normalises the URL
on mount and the query is gone by the first effect — which is what `billingReturnTab()`
does; the card then drops the query and keeps the tab.

## Build identity (what `/api/version` answers)

The deploy is `git pull && docker compose up -d --build` over SSH. For a long time
nothing the running instance served could name the commit it was built from, so
"is it deployed?" was answered two ways, both indirect: the GitHub job went green
(a fact about GitHub, not about the container), or the served
`assets/index-<hash>.js` matched a local `web/` build. The second one works — until
the change is **server-only**, and then the bundle is byte-identical and the
comparison confirms nothing while looking like it did.

So the image records what it was built from and the app reports it
(`server/src/version.js`, `GET /api/version`, same block on `/api/health`):

| Field | Source | Says |
|---|---|---|
| `commit` | `build-info.json` → `OPSCAT_COMMIT` → `git rev-parse` → `"unknown"` | which code |
| `builtAt` | `build-info.json` (`null` in a checkout) | when the image was built |
| `startedAt` | process start | when this container came up |
| `version` / `edition` | `package.json` / `edition.js` | which release, which edition |

Three decisions worth knowing:

- **The file wins over the environment.** `build-info.json` is written INTO the image
  by the Dockerfile, so it cannot go stale: a new commit is a new image is a new file.
  An `OPSCAT_COMMIT` in someone's `.env` is a promise, and a promise left behind from
  an earlier release would lie through every rebuild.
- **Nothing is guessed.** A build given no arg answers `"unknown"`; the resolver never
  invents a plausible id. An endpoint whose entire job is "which code is this" is the
  last place for a good-enough answer, and `"unknown"` is a state a deploy check can
  act on while a wrong sha is not.
- **`commit` alone does not prove a deploy — `startedAt` is the other half.** The pair
  separates "new image built and running" from "new image built, old container still
  serving", which is the failure the deploy check exists for. The workflow polls the
  container itself (`docker compose exec app`) rather than the public URL, and compares
  against the HOST's `HEAD`: only the host knows what it pulled, and a second merge
  landing mid-deploy must not fail the first one.

The endpoint is unauthenticated, like `/api/health` (which the container's own
`HEALTHCHECK` reads before anyone could log in). A short commit id opens nothing on a
private repository, and the alternative — SSH for every "is it live?" — is what made
deploy verification something people skip. Harness: `server/e2e-version.js`.

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
docs/      this file, API.md, OPEN-CORE.md, OPERATIONS.md, SENSORS.md; design docs
           for work in flight: INCIDENTS-V2.md, AUTOMATION-V1.md, ONCALL-V1.md
           (read as a set — each states the contract the other two build against)
```
