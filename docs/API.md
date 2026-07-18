# OpsCat API

Two surfaces:

- **`/api/*`** — session-authenticated UI API (cookie `opscat_sid`; state-changing requests
  need header `X-OpsCat-CSRF` with the token from login). Roles: `admin > cto > lead > analyst`.
- **`/v1/*`** — open machine surface, authenticated per request with API keys
  (`Authorization: Bearer ock_…`, also accepted: `X-Api-Key` header or `?key=` query),
  agent tokens (`oca_…`) or probe keys (`ocp_…`). Keys are created in the UI (Settings)
  and shown exactly once.

Public (no auth): `GET /api/health`, `GET /api/status` (JSON), `GET /status` (HTML status
page — per-organization in the cloud edition: `/status/:slug`), and `GET /api/plans`
(edition, public plan matrix, auth options for the login/pricing UI).

**Multi-tenancy:** every session, API key, agent token and probe key is bound to one
organization; all queries are scoped to it. Super-admins may target another org with
`?org=<id>` or the `X-OpsCat-Org` header.

## Auth

| Method & path | Body | Notes |
|---|---|---|
| POST `/api/auth/login` | `{email, password}` | → `{user, csrf}`; sets session cookie |
| POST `/api/auth/magic-link` | `{email}` | always `{ok:true}`; sends sign-in link via Resend |
| POST `/api/auth/magic-login` | `{token}` | consumes link token → `{user, csrf}` |
| POST `/api/auth/change-password` | `{currentPassword, newPassword}` | min 12 chars |
| GET `/api/auth/me` | — | current user + csrf |
| POST `/api/auth/logout` | — | |
| POST `/api/auth/signup` | `{orgName, name, email, password}` | cloud edition + signups open — creates organization + owner |
| GET `/api/auth/github` | — | GitHub login (community feature); `…/github/callback` completes — requires a verified GitHub e-mail |
| GET `/api/auth/google` | — | Google login (cloud); `…/google/callback` completes the flow |
| GET `/api/auth/microsoft` | — | Microsoft / Entra ID login (cloud); `…/microsoft/callback` completes the flow |

Each social route 404s until its client id/secret env vars are set; `/api/plans`
reports which providers are active. In the community edition social login signs in
existing users only — self-service signup for unknown e-mails is cloud-edition.

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

## Agents (`/v1`, agent token)

| Endpoint | Body |
|---|---|
| POST `/v1/agents/heartbeat` | `{hostname?, platform?, version?}` → `{ok, intervalS}` |
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
- `GET/POST/PATCH/DELETE /api/rules[/:id]` — `{name,enabled,channel:'email'|'teams'|'webhook',triggerName,severityMin,cooldownM,recipients:[]}` (lead+ to modify)
- `GET /api/notifications` → `[{ts,rule,event,channel,ok,error}]`
- `GET/POST /api/incidents`, `POST /api/incidents/:id/status` (`{status,message?}`), `PATCH /api/incidents/:id` (`{title?,severity?,published?,rca:{summary,impact,rootCause,resolution,actions}}`) — incident objects: `{id,label,title,severity,status,published,startedAt,resolvedAt,durationMs,updates:[{ts,status,message}],rca}`
- `GET /api/admin/components` → `[{id,name,group,status,uptimePct,days:[{day,worst}]}]`; POST/PATCH/DELETE for lead+ (`status` ∈ operational|degraded|partial|major|maintenance)
- `GET /api/synthetics/locations` (POST creates remote probe → `{probeKey}` once), `GET/POST/PATCH/DELETE /api/synthetics/checks`, `GET /api/synthetics/results` (latest per check×location), `GET /api/synthetics/results/series?checkId=&locationId=&hours=`, `GET /api/synthetics/results/route?locationId=`, `POST /api/synthetics/run`
- `GET /api/admin/users` (all roles), POST/PATCH admin only (`{resetPassword:true}` → one-time password)
- `GET/POST/PATCH /api/admin/apikeys` (lead+) — POST → `{key}` shown once
- `GET/POST/PATCH/DELETE /api/admin/snmp/targets` (lead+) — `{name,host,port,community,oids:[{oid,label}],intervalS}`
- `GET /api/admin/agents` (`{id,name,group,hostname,platform,version,active,lastSeenAt,online}`), POST (lead+) → `{token}` once, `GET /api/admin/agents/:id/metrics?hours=`
- `GET/PATCH /api/admin/settings` — keys: `org_name, backend_label, status_published, retention_logs_days, alert_email_from, auth_email_from, teams_webhook_url, classifiers`
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
`402 {error, limit, plan}`. Community edition enforces nothing.

## Super-admin (cloud edition, `/api/superadmin` — requires `is_super_admin`)

| Method & path | Notes |
|---|---|
| GET `/overview` | platform KPIs: orgs, users, MRR, ingest volume |
| GET/POST `/orgs` · GET/PATCH/DELETE `/orgs/:id` | manage organizations (plan, status) |
| POST `/orgs/:id/impersonate` | switch the session into that org (audited) |
| POST `/users/:id/super-admin` | grant/revoke the platform role |
| GET `/audit` | platform-wide audit trail |

Errors are always JSON `{error}` with proper status codes. Rate limits: auth 10/min/IP,
API 300/min/session, ingest 600/min/key → `429`.
