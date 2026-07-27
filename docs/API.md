# OpsCat API

Two surfaces:

- **`/api/*`** — session-authenticated UI API (cookie `opscat_sid`; state-changing requests
  need header `X-OpsCat-CSRF` with the token from login). Roles: `admin > cto > lead > analyst`.
- **`/v1/*`** — open machine surface, authenticated per request with API keys
  (`Authorization: Bearer ock_…`, also accepted: `X-Api-Key` header or `?key=` query),
  agent tokens (`oca_…`) or probe keys (`ocp_…`). Keys are created in the UI (Settings)
  and shown exactly once.

Public (no auth): `GET /api/health`, `GET /status` (HTML status page —
per-organization in the cloud edition: `/status/:slug`), and `GET /api/plans`
(edition, public plan matrix, auth options for the login/pricing UI).

**Token auth for the operations API.** `/api/events`, `/api/cases`, `/api/incidents`,
`/api/synthetics/*`, `/api/vendors/*` and the rest of the operations surface accept
`Authorization: Bearer` as well as a browser session, so scripts and cron jobs need
neither a cookie nor an MCP client. Two credentials resolve: an **MCP access token**
(acts as its user with their membership role; `read` scope for GET, `write` for
mutations) or an **API key with the `api` scope** (acts with the key's own `role`, which
can never exceed the role of whoever created it). No CSRF header is required for Bearer —
CSRF protects cookie auth. Account, API-key, billing, organization and super-admin
endpoints stay **session-only**: a credential that can mint another credential is a
privilege-escalation path.

**MCP server** (`POST/GET/DELETE /mcp`, Streamable HTTP, MCP revision 2025-11-25).
Authenticated with an OAuth 2.1 Bearer token; the authorization server lives on the same
origin (`/oauth/register` RFC 7591 · `/oauth/authorize` PKCE S256 only · `/oauth/token` ·
`/oauth/revoke` RFC 7009), with discovery at `/.well-known/oauth-authorization-server`
(RFC 8414) and `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728, both forms).
The consent screen carries an **organization picker**: the token is bound to one
organization and every tool is scoped to it, so no tool takes an org argument. Roles are
read from `memberships` per request, never cached in the token. 18 tools (9 read, 9 write), each annotated and carrying an `outputSchema`; a read-only
credential never sees the write tools. Two resources (`opscat://org/<id>/status`,
`.../incidents/open`). Destructive calls confirm via elicitation. Per-user connections
are listed and revoked at `GET/DELETE /api/admin/connections`. Tool reference:
`/mcp/llms.txt`. See `docs/MCP-PLAN.md`.

**Machine-readable status page.** Append `.json` to any status page URL — `/status.json`,
`/status/:slug.json` — and get the exact payload the page renders. The URL already
identifies the organization, so there is no slug parameter to pass; the page links its own
JSON in the footer. `/summary.json` is the origin-level alias for a single-org instance or
a status page on its own domain, and is the shape OpsCat's own vendor detector probes for
(`engine/vendor-feeds.js`), so an OpsCat status page is auto-detectable by OpsCat.
`GET /api/status[?org=slug]` remains as an alias. All forms 404 with
`{"error":"not published"}` when the org is unknown or its page is unpublished.

**Multi-tenancy:** API keys, agent tokens and probe keys are each bound to one
organization; all queries are scoped to it. A **user** may belong to several
organizations (`memberships`, one role per org) and — in the **cloud edition** — switches
the org their session acts in via `POST /api/auth/switch-org` (default: their home org).
Super-admins may target any org with `?org=<id>` or the `X-OpsCat-Org` header.

## Auth

| Method & path | Body | Notes |
|---|---|---|
| POST `/api/auth/login` | `{email, password}` | → `{user, csrf}`; sets session cookie |
| POST `/api/auth/magic-link` | `{email}` | always `{ok:true}`; sends sign-in link via Resend |
| POST `/api/auth/magic-login` | `{token}` | consumes link token → `{user, csrf}` |
| POST `/api/auth/change-password` | `{currentPassword?, newPassword}` | min 12 chars; `currentPassword` not required while a forced change (`mustChangePassword`) is pending |
| GET `/api/auth/me` | — | current user + csrf (role reflects the active org) |
| GET `/api/auth/orgs` | — | the caller's orgs → `{activeOrgId, orgs:[{orgId,name,slug,plan,role,onboardingDone}]}` |
| POST `/api/auth/switch-org` | `{orgId}` | **cloud only** — set the session's active org (caller must be a member) |
| POST `/api/auth/logout` | — | |
| POST `/api/auth/signup` | `{orgName, name, email, password}` | cloud edition + signups open — creates organization + owner |
| GET `/api/auth/github` | — | GitHub login (community feature); `…/github/callback` completes — requires a verified GitHub e-mail |
| GET `/api/auth/google` | — | Google login (cloud); `…/google/callback` completes the flow |
| GET `/api/auth/microsoft` | — | Microsoft / Entra ID login (cloud); `…/microsoft/callback` completes the flow |

Each social route 404s until its client id/secret env vars are set; `/api/plans`
reports which providers are active. In the community edition social login signs in
existing users only — self-service signup for unknown e-mails is cloud-edition.
A verified social login retires a pending admin-issued temporary password: the
account adopts the provider, `mustChangePassword` is cleared and password login
stays disabled until an admin issues a new reset.

**Organizations (multi-org, cloud):** `POST /api/orgs {orgName}` lets a signed-in user
spin up an additional organization (they become its admin) and switches the session into
it — gated by the current org's plan carrying the `multi_org` feature (on every plan by
default; see `plans.js`). Adding an existing account to an org, or removing a member, is
done through the admin users API below.

## Ingest (`/v1`, API key scope `ingest`)

| Endpoint | Body |
|---|---|
| POST `/v1/ingest/logs` | `{logs:[{ts?, device, line, sev?, meta?}]}` or bare array; ≤500/batch; `sev` = syslog 0–7 |
| POST `/v1/ingest/events` | `{name, device, target?, description?, severity? (0–100), ip?, ts?}` |
| POST `/v1/ingest/webhook` | generic: `{name/alertname, device/host, message/description, severity?, target?}` |
| POST `/v1/integrations/sentry` | Sentry issue-alert webhook payload; use `…/sentry?key=ock_…` as the webhook URL |
| POST `/v1/otlp/v1/logs` | OTLP/HTTP JSON `{resourceLogs:[…]}` — full ingest (service.name → device) |
| POST `/v1/otlp/v1/traces` | OTLP/HTTP JSON — spans with error status become events |
| POST `/v1/otlp/v1/metrics` | accepted (partialSuccess), not stored yet |

Log lines run through the classifier pipeline (see `server/src/engine/pipeline.js`): lines
scoring ≥20 aggregate into events (dedupe on name+device+target), ≥60 auto-open a case.
Custom classifier rules are per-organization (Pipeline page / `/api/admin/pipeline/classifiers`)
and are evaluated before the built-ins. On the cloud edition, log-line endpoints additionally
enforce the plan's `ingestLinesPerDay` limit and answer `429` once the day's allowance is spent.

## Agents (`/v1`, agent token)

Install files are served unauthenticated under `/agent/` (`install.sh`,
`opscat-agent.js`, `opscat-agent.service`), enabling the copy-paste install
one-liner shown in onboarding and Settings → Agents:
`curl -fsSL https://<host>/agent/install.sh | sudo OPSCAT_URL=… OPSCAT_AGENT_TOKEN=oca_… sh`

| Endpoint | Body |
|---|---|
| POST `/v1/agents/heartbeat` | `{hostname?, platform?, version?}` → `{ok, intervalS, latestVersion, updateAvailable}` |
| GET `/v1/agents/update` | server-bundled agent script for self-update (`X-Agent-Version` header); agents with auto-update on replace themselves and restart via systemd |
| POST `/v1/agents/containers` | `{containers:[{name, image, state, cpuPct?, memUsed?, memLimit?}]}` — docker snapshot (minute-bucketed); a previously-running container now missing/stopped raises `container_down` |
| POST `/v1/agents/metrics` | `{cpuPct, load1, memUsed, memTotal, diskUsed, diskTotal, netRx, netTx}` |
| POST `/v1/agents/logs` | `{logs:[…]}` like ingest/logs |

## Remote probes (`/v1`, probe key)

| Endpoint | Notes |
|---|---|
| GET `/v1/synthetics/checks` | work list `[{id, type, target, intervalS, timeoutMs}]` |
| POST `/v1/synthetics/report` | `{results:[{checkId, ok, latencyMs?, meta?, ts?}]}` ≤200 |

## UI API (`/api`, session)

- `GET /api/stream` — SSE; events: `log` `{ts,device,line,sev}`, `event` (event object)
- `GET /api/events?status=active|finished|downgraded|all&limit=` → `[{id,name,device,ip,target,description,severity,hits,status,firstSeen,lastSeen,assigned:{id,n,i,c}|null,spark:[10 cumulative points]}]`
- `GET /api/events/:id` → event + `recentLogs` + `case {label,id,status}`
- `POST /api/events/:id/action` — `{action:'finish'|'downgrade'|'assign'|'note', userId?, note?}`
- `GET /api/cases?status=` → `[{id,label,eventId,name,device,severity,status,assigned,rootCause,note,openedAt,closedAt,durationMs}]`
- `PATCH /api/cases/:id` — `{status?, assignedUserId?, rootCause?, note?}`
- `GET /api/logs?hours=&q=&limit=` → `[{ts,device,line,sev}]`
- `GET /api/dashboard` → `{sevCounts, openCases, mttrMs, logs24, events24, casesByAnalyst}`
- `GET /api/analytics?range=24h|7d|30d` → `{volume:[{d,c,h,m,l}], mttrDaily:[{d,v}], topTypes, topServers, totals:{events,mttrMs,resolutionRate,notifications,notificationsFailed}}`
- `GET/POST/PATCH/DELETE /api/rules[/:id]` — `{name,enabled,channel:'email'|'teams'|'webhook'|'slack'|'telegram'|'discord'|'ntfy'|'pushover',triggerName,severityMin,cooldownM,recipients:[]}` (lead+ to modify). `recipients` per channel: email addresses, webhook/Slack/Discord/ntfy URLs, Telegram chat ids, Pushover user keys; Telegram/Pushover need `telegram_bot_token`/`pushover_token` in settings
- `GET /api/notifications` → `[{ts,rule,event,channel,ok,error}]`
- `GET /api/assets` → unified list of monitored assets `[{kind:'agent'|'snmp'|'check'|'heartbeat'|'container'|'source'|'vendor', id, name, detail, status, lastSeen}]` — agents, SNMP targets, synthetic checks, heartbeats, containers (latest agent snapshot), monitored vendors plus implicit log/event sources
- `GET/POST/DELETE /api/maintenance[/:id]` (lead+ to modify) — `{name, startsAt, endsAt}` (ms epoch, ≤30 days); while a window is active all alert dispatch for the org is suppressed (events still record; the notification log shows `suppressed: maintenance window "…"`)
- `GET/POST/PATCH/DELETE /api/heartbeats[/:id]` (lead+ to modify) — `{name, intervalS, graceS}`; POST returns `pingUrl` once. Public ping: `GET|POST /v1/heartbeat/:token` (no other auth); silence past interval+grace raises a `heartbeat_missed` event
- `GET/POST /api/incidents`, `POST /api/incidents/:id/status` (`{status,message?}`), `PATCH /api/incidents/:id` (`{title?,severity?,published?,rca:{summary,impact,rootCause,resolution,actions}}`) — incident objects: `{id,label,title,severity,status,published,startedAt,resolvedAt,durationMs,updates:[{ts,status,message}],rca}`
- `GET /api/admin/components` → `[{id,name,group,status,uptimePct,days:[{day,worst}]}]`; POST/PATCH/DELETE for lead+ (`status` ∈ operational|degraded|partial|major|maintenance)
- `GET /api/synthetics/locations` (POST creates remote probe → `{probeKey}` once), `GET/POST/PATCH/DELETE /api/synthetics/checks` (types http|icmp|dns|tcp|traceroute; http checks accept `assertions {status?, keyword?, jsonPath?, jsonValue?}` and record `certDaysLeft` for https — ≤14 days raises `tls_cert_expiring`), `GET /api/synthetics/results` (latest per check×location), `GET /api/synthetics/results/series?checkId=&locationId=&hours=`, `GET /api/synthetics/results/route?locationId=`, `POST /api/synthetics/run`
- `GET /api/vendors` → `[{id,slug,name,feedType,feedUrl,pageUrl,intervalS,enabled,componentId,status,lastCheckedAt,lastError,activeIncidents}]` (`status` ∈ unknown|operational|degraded|partial|major|maintenance); `GET /api/vendors/catalog` → bundled vendor catalog `[{slug,name,feedType,feedUrl,pageUrl,domains}]`; `GET /api/vendors/:id` → vendor + `components:[{name,status,updatedAt}]` + `incidents:[{id,remoteId,title,status,impact,url,startedAt,resolvedAt,updatedAt}]`; `POST /api/vendors` (lead+) — `{slug}` from the catalog **or** custom `{name, feedType:'statuspage'|'instatus'|'slack'|'gcp'|'aws'|'heroku'|'statusio'|'rss', feedUrl, pageUrl?}` (https only, SSRF-guarded), `intervalS?` 60–3600 (default 120), polls immediately; `PATCH /api/vendors/:id` (lead+) — `{intervalS?, enabled?, componentId?}` (`componentId` mirrors the vendor state onto an own status-page component, `null` unmaps); `DELETE /api/vendors/:id` (lead+); `POST /api/vendors/:id/poll` — check now. New vendor incidents raise `vendor_incident` events (severity by impact: critical 90, major 82, partial 75, minor 55, maintenance 25, unknown 65), recovery raises `vendor_recovered` (20)
- `POST /api/vendors/detect` (lead+) — `{url}` of any status page → auto-detects the machine-readable feed behind it (Statuspage/incident.io shim, Instatus, Heroku, Slack-style, Google dashboards, status.io page-id extraction, RSS/Atom `<link>` discovery) → `{feedType, feedUrl, pageUrl, name, preview:{status,components,incidents}}`; 422 when nothing supported is found. Custom feed URLs are normalized on create (lowercase host, no trailing slash) so identical vendors across orgs share one polling fetch
- `POST /api/vendors/subscribe-catalog` (lead+) — subscribe the org to every catalog vendor it doesn't monitor yet (interval 300 s) → `{added, total}`; used to seed the public vendor grid
- Public vendor grid (no auth, off by default — publish with setting `vendor_grid_published=1` or env `OPSCAT_GRID_PUBLISHED=1`): `GET /api/public/vendor-grid` → `{updatedAt, total, disrupted, counts:{total,green,warn,red}, vendors:[{slug,name,status,activeIncidents,userReports60m,uptimePct,days:[{day,worst}],pageUrl,lastCheckedAt}]}` (org 1's monitored vendors, cached 60 s; `uptimePct`/`days` come from the per-minute `vendor_days` rollup, 45-day window); HTML at `GET /vendor-grid` (query params: `view=grid|list` — list shows 45-day heatbars + uptime, `f=all|green|warn|red` filter pills), and served as the front page on the grid host (`OPSCAT_GRID_HOST`, default `radar.opscat.io` — Caddy vhost included, DNS record required). Community signal: `POST /vendor-grid/report` (form) / `POST /api/public/vendor-grid/report` (JSON) — `{slug}` + honeypot `website`; per-IP rate limit, one report per visitor per vendor per hour, salted IP hash only, pruned after 30 days; grid shows `userReports60m`, ≥5 reports/60 min raise a `vendor_reports_spike` event in org 1
- `GET /api/superadmin/custom-vendors` (super-admin) — custom feeds across all orgs grouped by URL with org counts: the curation signal for catalog promotion (never public)
- `GET /api/status-reports?hours=` → `{total, reports:[{ts,component,message}]}` — anonymous problem reports submitted on the public status page. Public submission: `POST /api/status/report[?org=slug]` (JSON) or the status page's own form (`POST /status/report`, `POST /status/:slug/report`, urlencoded) — `{componentId?, message?}` + honeypot field `website`; rate-limited per IP (3/min), one report per visitor per 10 min, stores only a salted IP hash. ≥ `status_reports_threshold` (default 5) reports in 15 min raise a `user_reports_spike` event (severity 75, 85 at 3× threshold, re-raised at most every 10 min)
- `GET /api/admin/users` (lead+) lists org **members** with their per-org role. POST/PATCH admin only: POST with a known e-mail attaches that existing account to the org (multi-org), an unknown e-mail creates a user (`initialPassword` once); PATCH `{role}` sets the per-org role, `{remove:true}` drops the member from this org, `{resetPassword:true}` → one-time password
- `GET/POST/PATCH /api/admin/apikeys` (lead+) — POST → `{key}` shown once
- `GET/POST/PATCH/DELETE /api/admin/snmp/targets` (lead+) — `{name,host,port,version:'2c'|'3',community?,oids:[{oid,label}],intervalS}`; v3 instead of community: `{v3User, v3Level:'noAuthNoPriv'|'authNoPriv'|'authPriv', v3AuthProtocol:'sha'|'md5', v3AuthKey, v3PrivProtocol:'aes'|'des', v3PrivKey}` (keys stored encrypted, never returned)
- `GET /api/admin/agents` (`{id,name,group,hostname,platform,version,active,autoUpdate,lastSeenAt,online}`), POST (lead+, `{name,group,autoUpdate?}` default true) → `{token}` once, PATCH `/:id` `{autoUpdate}`, `GET /api/admin/agents/:id/metrics?hours=`
- `GET/PATCH /api/admin/settings` — keys: `org_name, backend_label, status_published, retention_logs_days, onboarding_done, onboarding_role, onboarding_goal, onboarding_source, alert_email_from, auth_email_from, teams_webhook_url, telegram_bot_token, pushover_token, classifiers, status_reports_enabled, status_reports_public, status_reports_threshold`. `onboarding_done` is `'0'` on a fresh cloud org and flipped to `'1'` when its admin finishes/skips the first-run setup flow; `onboarding_role/goal/source` capture the personalization answers (source = acquisition channel, only asked on a user's first org) for later analysis
- `GET /api/admin/pipeline/stats?range=24h|7d|30d` → `{range, step, buckets:[{bucket,lines,bytes,events}], totals:{lines,bytes,events}}` — ingest throughput from the hourly `ingest_stats` counters (hour buckets for 24h, day buckets otherwise, gaps zero-filled)
- `GET /api/admin/pipeline/classifiers` → `{builtin:[…], custom:[…]}` (rule shape: `{pattern, flags, name, severity, targetGroup?}`); `PUT` (admin) replaces the org's custom rules `{classifiers:[…]}` (≤100 rules, patterns validated, live reload — no restart)
- `POST /api/admin/pipeline/test` — `{line, sev?}` → `{match:{name,severity,target,source:'custom'|'builtin'|'syslog',pattern}|null, caseThreshold}` — dry-runs a sample line through the org's classifier chain, nothing is stored
- `GET/POST/PATCH/DELETE /api/admin/automations[/:id]` (lead+ to modify) — automation objects `{name, enabled, trigger:{event ('*'=any), severityMin}, actions:[…], cooldownM}`; action types: `{type:'close_event', raiseEvent, matchTarget?}` (lifecycle: the trigger event finishes the matching open raise event + closes its case), `{type:'assign_case', userId}`, `{type:'webhook', url}`. Max 5 actions; at most one run per event dedupe key and cooldown. `GET /api/admin/automations/runs?limit=` lists recent runs from the audit trail (action `automation_run`, system actor)
- `GET/PUT /api/admin/ai` (admin) — org LLM override `{baseUrl (OpenAI-compatible API root), model, apiKey (write-only, stored encrypted; '' clears)}`; GET reports `{org:{baseUrl,model,hasKey}, platformConfigured, effectiveSource:'org'|'platform'|null, effectiveModel}` — never key material. `POST /api/admin/ai/test` dry-runs a one-line prompt against the effective endpoint → `{ok, source, model, latencyMs}` or 502
- `GET /api/admin/system`, `GET /api/admin/audit` (admin)

## Billing (cloud edition, `/api/billing`)

| Method & path | Notes |
|---|---|
| GET `/api/billing/status` | plan, subscription status, current period end, usage vs limits |
| POST `/api/billing/checkout` | `{plan}` (admin) → `{url}` — Stripe Checkout session |
| POST `/api/billing/portal` | (admin) → `{url}` — Stripe customer portal |
| POST `/api/billing/webhook` | Stripe events; HMAC signature-verified, no session |
| POST `/api/billing/setup` | (super-admin) idempotently creates products/prices in Stripe |

Plan limits (`server/src/plans.js`) are enforced on create routes (users, API keys,
agents, SNMP targets, checks, sensors): exceeding a limit returns
`402 {error, limit, plan}`. Feature flags in the same file gate cloud capabilities via
`hasFeature` — e.g. `multi_org` (multiple organizations per account), enabled on every
plan by default. Community edition enforces nothing.

## Super-admin (cloud edition, `/api/superadmin` — requires `is_super_admin`)

| Method & path | Notes |
|---|---|
| GET `/overview` | platform KPIs: orgs, users, MRR, ingest volume |
| GET/POST `/orgs` · GET/PATCH/DELETE `/orgs/:id` | manage organizations (plan, status) |
| POST `/orgs/:id/impersonate` | switch the session into that org (audited) |
| GET `/super-admins` | list platform super-admins |
| POST `/super-admins` | `{email}` — grant the flag to an existing account (audited) |
| POST `/users/:id/super-admin` | grant/revoke the platform role by user id (self-demote rejected) |
| GET/PUT `/ai` | platform LLM default (OpenAI-compatible `{baseUrl, model, apiKey}` — key write-only/encrypted); orgs without their own Settings → AI override use this |
| GET `/audit` | platform-wide audit trail |

Errors are always JSON `{error}` with proper status codes. Rate limits: auth 10/min/IP,
API 300/min/session, ingest 600/min/key → `429`.
