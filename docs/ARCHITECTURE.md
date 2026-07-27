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
                        │ opscat-server (Node 22, Express 4)         │
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
| Express 4 + Node 22 | Existing stack (CLAUDE.md), tiny footprint on the 2-vCPU VPS. |
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

## Synthetics

- `synthetic_locations`: the built-in local probe (this VPS, `NBG`) plus any number of
  **remote probes** — the same lightweight agent script run with `--probe` and a probe key.
- Check types: `http`, `icmp` (ping), `dns`, `tcp`, `traceroute`. Results keep latency,
  jitter, loss, and hop data (traceroute) per location.
- Failing checks feed the pipeline as events (`synthetic_check_failed`), so alert rules
  and the status page react automatically.

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
  orgs and the community edition have no `'0'` flag, so they never see it. The flow is
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

## Repository layout

```
server/    Express API + engines (server/src/ee/** = Enterprise Edition)
web/       React + Vite UI (built into server/public at docker build; UI icons come
           from lucide-react, brand marks are inline SVGs in web/src/icons.tsx —
           no unicode-glyph icons, no emojis)
sdk/js/    @opscat/sdk — dependency-free log SDK (Node + browser)
agent/     opscat-agent.js — dependency-free server agent (+ --probe mode)
marketing/ static marketing site served at opscat.io/ (private repo only)
deploy/    sensor fleet provisioning — cloud-init, provider APIs, Terraform
scripts/   publish-community.sh — filtered sync to the public repo
docs/      this file, API.md, OPEN-CORE.md, OPERATIONS.md, SENSORS.md
```
