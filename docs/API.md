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
- `GET/POST/PATCH/DELETE /api/rules[/:id]` — `{name,enabled,channel:'email'|'teams'|'webhook'|'slack'|'telegram'|'discord'|'ntfy'|'pushover',triggerName,severityMin,cooldownM,recipients:[]}` (lead+ to modify). `recipients` per channel: email addresses, webhook/Slack/Discord/ntfy URLs, Telegram chat ids, Pushover user keys; Telegram/Pushover need `telegram_bot_token`/`pushover_token` in settings
- `GET /api/notifications` → `[{ts,rule,event,channel,ok,error}]`
- `GET /api/assets` → unified list of monitored assets `[{kind:'agent'|'snmp'|'check'|'heartbeat'|'source', id, name, detail, status, lastSeen}]` — agents, SNMP targets, synthetic checks, heartbeats plus implicit log/event sources
- `GET/POST/PATCH/DELETE /api/heartbeats[/:id]` (lead+ to modify) — `{name, intervalS, graceS}`; POST returns `pingUrl` once. Public ping: `GET|POST /v1/heartbeat/:token` (no other auth); silence past interval+grace raises a `heartbeat_missed` event
- `GET/POST /api/incidents`, `POST /api/incidents/:id/status` (`{status,message?}`), `PATCH /api/incidents/:id` (`{title?,severity?,published?,rca:{summary,impact,rootCause,resolution,actions}}`) — incident objects: `{id,label,title,severity,status,published,startedAt,resolvedAt,durationMs,updates:[{ts,status,message}],rca}`
- `GET /api/admin/components` → `[{id,name,group,status,uptimePct,days:[{day,worst}]}]`; POST/PATCH/DELETE for lead+ (`status` ∈ operational|degraded|partial|major|maintenance)
- `GET /api/synthetics/locations` (POST creates remote probe → `{probeKey}` once), `GET/POST/PATCH/DELETE /api/synthetics/checks` (types http|icmp|dns|tcp|traceroute; http checks accept `assertions {status?, keyword?, jsonPath?, jsonValue?}` and record `certDaysLeft` for https — ≤14 days raises `tls_cert_expiring`), `GET /api/synthetics/results` (latest per check×location), `GET /api/synthetics/results/series?checkId=&locationId=&hours=`, `GET /api/synthetics/results/route?locationId=`, `POST /api/synthetics/run`
- `GET /api/admin/users` (lead+) lists org **members** with their per-org role. POST/PATCH admin only: POST with a known e-mail attaches that existing account to the org (multi-org), an unknown e-mail creates a user (`initialPassword` once); PATCH `{role}` sets the per-org role, `{remove:true}` drops the member from this org, `{resetPassword:true}` → one-time password
- `GET/POST/PATCH /api/admin/apikeys` (lead+) — POST → `{key}` shown once
- `GET/POST/PATCH/DELETE /api/admin/snmp/targets` (lead+) — `{name,host,port,version:'2c'|'3',community?,oids:[{oid,label}],intervalS}`; v3 instead of community: `{v3User, v3Level:'noAuthNoPriv'|'authNoPriv'|'authPriv', v3AuthProtocol:'sha'|'md5', v3AuthKey, v3PrivProtocol:'aes'|'des', v3PrivKey}` (keys stored encrypted, never returned)
- `GET /api/admin/agents` (`{id,name,group,hostname,platform,version,active,lastSeenAt,online}`), POST (lead+) → `{token}` once, `GET /api/admin/agents/:id/metrics?hours=`
- `GET/PATCH /api/admin/settings` — keys: `org_name, backend_label, status_published, retention_logs_days, onboarding_done, onboarding_role, onboarding_goal, onboarding_source, alert_email_from, auth_email_from, teams_webhook_url, telegram_bot_token, pushover_token, classifiers`. `onboarding_done` is `'0'` on a fresh cloud org and flipped to `'1'` when its admin finishes/skips the first-run setup flow; `onboarding_role/goal/source` capture the personalization answers (source = acquisition channel, only asked on a user's first org) for later analysis
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
| POST `/users/:id/super-admin` | grant/revoke the platform role |
| GET `/audit` | platform-wide audit trail |

Errors are always JSON `{error}` with proper status codes. Rate limits: auth 10/min/IP,
API 300/min/session, ingest 600/min/key → `429`.
