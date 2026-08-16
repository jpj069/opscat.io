# OpsCat API

Two surfaces:

- **`/api/*`** — session-authenticated UI API (cookie `opscat_sid`; state-changing requests
  need header `X-OpsCat-CSRF` with the token from login). Roles: `admin > cto > lead > analyst`.
- **`/v1/*`** — open machine surface, authenticated per request with API keys
  (`Authorization: Bearer ock_…`, also accepted: `X-Api-Key` header or `?key=` query),
  agent tokens (`oca_…`) or probe keys (`ocp_…`). Keys are created in the UI (Settings)
  and shown exactly once.

Public (no auth): `GET /api/health`, `GET /api/version`, `GET /api/status` (JSON),
`GET /status` (HTML status page — per-organization in the EE: `/status/:slug`), and
`GET /api/plans` (edition, public plan matrix, auth options for the login/pricing UI).

**Build identity.** `GET /api/version` answers which code is running, and `/api/health`
carries the same block next to its liveness fields — one request answers both, which is
what the container's `HEALTHCHECK` and the deploy check need:

```json
{ "service": "opscat", "version": "2.0.0", "edition": "cloud",
  "commit": "1bcda1e", "builtAt": "2026-08-16T23:00:20Z",
  "startedAt": "2026-08-16T23:00:31.402Z", "ts": 1786921283044 }
```

`commit` is stamped into the image at build time (`build-info.json`, written by the
Dockerfile from the `OPSCAT_COMMIT` build arg); a development checkout answers with its
own `git HEAD`, and a build that was given neither answers `"unknown"` rather than
guessing. `builtAt` is when the image was built (`null` in a checkout — nothing was),
`startedAt` when this process started: a deploy has landed when `commit` matches AND
`startedAt` moved. Unauthenticated on purpose — the question "which commit is live" has
to be answerable from outside the host, and a short commit id opens no door on a private
repository. See `docs/ARCHITECTURE.md` § Build identity.

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
organizations (`memberships`, one role per org) and — in the **EE** — switches
the org their session acts in via `POST /api/auth/switch-org` (default: their home org).
Super-admins may target any org with `?org=<id>` or the `X-OpsCat-Org` header.

## Auth

| Method & path | Body | Notes |
|---|---|---|
| POST `/api/auth/login` | `{email, password}` | → `{user, csrf}`; sets session cookie. An account with **no password** (link-invited, or reset by an admin) is refused here whatever is sent |
| POST `/api/auth/magic-link` | `{email}` | always `{ok:true}`; sends sign-in link via the configured transport. `GET /api/plans` → `auth.mail` says whether there is one — the login screen hides the tab without it |
| POST `/api/auth/magic-login` | `{token}` | consumes a sign-in **or** activation token → `{user, csrf, invited}`. `invited:true` marks an activation (7-day invite token), so the app offers "set a password" once |
| POST `/api/auth/change-password` | `{currentPassword?, newPassword}` | min 12 chars; `currentPassword` not required while a forced change (`mustChangePassword`) is pending, nor on an account that has none yet (`hasPassword:false`) |
| GET `/api/auth/me` | — | current user + csrf (role reflects the active org) |
| GET `/api/auth/orgs` | — | the caller's orgs → `{activeOrgId, orgs:[{orgId,name,slug,plan,role,onboardingDone}]}` |
| POST `/api/auth/switch-org` | `{orgId}` | **cloud only** — set the session's active org (caller must be a member) |
| POST `/api/auth/logout` | — | |
| POST `/api/auth/signup` | `{orgName, name, email, password}` | EE + signups open — creates organization + owner |
| GET `/api/auth/github` | — | GitHub login (community feature); `…/github/callback` completes — requires a verified GitHub e-mail |
| GET `/api/auth/google` | — | Google login (cloud); `…/google/callback` completes the flow |
| GET `/api/auth/microsoft` | — | Microsoft / Entra ID login (cloud); `…/microsoft/callback` completes the flow |

Each social route 404s until its client id/secret env vars are set; `/api/plans`
reports which providers are active. In the CE social login signs in
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
one-liner shown in onboarding and Settings → Agents & SNMP:
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
- `GET /api/events/:id` → event + `spark` (same 10 cumulative points as the list) + `recentLogs` + `timeline` + `case {label,id,status}`
  - `timeline: [{ts, user:{id,n,i,c}|null, action, detail}]`, oldest first — who did what to this
    event. `user: null` = the platform, not a person. The first entry is always `detected`,
    derived from `firstSeen` (so events predating the table still have a history) and carries
    no `detail`: `severity` is the CURRENT value, and a derived line must not state as fact
    something a later downgrade made true. Actions: `detected`, `assign`, `downgrade`
    (`"92 → 67"`), `finish`, `note` (the note body), `case_status`, `root_cause`.
- `POST /api/events/:id/action` — `{action:'finish'|'downgrade'|'assign'|'note', userId?, note?}`
  - appends one `timeline` entry per accepted call. **409** when the action would change
    nothing: already finished, already assigned to that user, severity already at the floor
    (10). The UI disables the matching button; this is the same rule enforced server-side.
- `GET /api/cases?status=` → `[{id,label,eventId,name,device,severity,status,assigned,rootCause,note,openedAt,closedAt,durationMs}]`
- `PATCH /api/cases/:id` — `{status?, assignedUserId?, rootCause?, note?}`. Each field that
  actually CHANGED appends an entry to the event's timeline (a re-save of an untouched form
  records nothing), so a note written here and one written in the slide-over land in the
  same history. `note` is a single column — it holds the latest note; the timeline holds all
  of them, with their authors.
- `GET /api/logs?hours=&from=&to=&q=&limit=` → `[{ts,device,line,sev}]` `from`/`to` are an ABSOLUTE window in ms and take precedence over `hours` — that is what a link from elsewhere needs: Scout's "the lines behind this template" and the throughput chart's "the lines under the span I dragged over" both name a fixed span, and re-deriving it as "hours ago" goes stale in an open tab. `hours` still caps at 720.
- `GET /api/dashboard` → `{sevCounts, openCases, mttrMs, logs24, events24, casesByAnalyst}`
- `GET /api/analytics?range=24h|7d|30d` → `{volume:[{d,c,h,m,l}], mttrDaily:[{d,v}], topTypes, topServers, totals:{events,mttrMs,resolutionRate,notifications,notificationsFailed}}`
- `GET/POST/PATCH/DELETE /api/rules[/:id]` — `{name,enabled,channel:'email'|'msteams'|'webhook'|'slack'|'telegram'|'discord'|'ntfy'|'pushover',triggerName,severityMin,cooldownM,recipients:[]}` (lead+ to modify). `recipients` per channel: email addresses, webhook/Slack/Discord/ntfy URLs, Telegram chat ids, Pushover user keys; Telegram/Pushover need `telegram_bot_token`/`pushover_token` in settings
- `GET /api/notifications` → `[{ts,rule,event,channel,ok,error}]`
- `GET /api/assets` → unified list of monitored assets `[{kind:'agent'|'snmp'|'check'|'heartbeat'|'container'|'source'|'vendor', id, name, detail, status, lastSeen}]` — agents, SNMP targets, synthetic checks, heartbeats, containers (latest agent snapshot), monitored vendors plus implicit log/event sources
- `GET/POST/DELETE /api/maintenance[/:id]` (lead+ to modify) — `{name, startsAt, endsAt}` (ms epoch, ≤30 days); while a window is active all alert dispatch for the org is suppressed (events still record; the notification log shows `suppressed: maintenance window "…"`)
- `GET/POST/PATCH/DELETE /api/heartbeats[/:id]` (lead+ to modify) — `{name, intervalS, graceS}`; POST returns `pingUrl` once. Public ping: `GET|POST /v1/heartbeat/:token` (no other auth); silence past interval+grace raises a `heartbeat_missed` event
- `GET/POST /api/incidents` (POST lead+ — `{title, severity?, message?, assigneeId?, components?:[{id,impact}]}`, `impact` ∈ degraded|partial|major — the app-wide status scale, see `lib/status-scale.js`), `POST /api/incidents/:id/status` (`{status,message?}`), `PATCH /api/incidents/:id` (`{title?,severity?,published?,assigneeId?,components?,rca:{…}}` — `assigneeId` writes a timeline entry; `components` replaces the affected set) — incident objects: `{id,label,title,severity,status,published,startedAt,resolvedAt,durationMs,assigneeId,assignee,components:[{id,impact,name}],links:[{kind:'case'|'event',refId,label}],updates:[{ts,status,message}],rca}`. Every mutation goes through `lib/incidents.js`: it emits the synthetic lifecycle events `incident_created`/`incident_status_changed`/`incident_resolved` through the org's **alert rules** (name/severity-matched like `bridge_insight`; reserved for alert rules — flows use native `incident.*` triggers, see docs/INCIDENTS-V2.md §3.2) and recomputes derived component status (worst impact across OPEN incidents; back to `operational` on the last resolve; manual component status is recomputed away on the next incident transition)
- `POST /api/cases/:id/promote` (lead+) — case → incident: prefills `{title?,severity?,components?,assigneeId?}` from the case (assignee defaults case-assignee → promoter), links the case and its event in `incident_links`, appends a case note; an open incident already linked to the case is returned with `already:true` instead of a twin. Case rows carry `incident:{id,label}|null`
- `GET /api/admin/components` → `[{id,name,group,status,ownerId,uptimePct,days:[{day,worst}]}]`; POST/PATCH/DELETE for lead+ (`status` ∈ operational|degraded|partial|major|maintenance — but derived from open incidents, see above; `ownerId` in PATCH sets/clears the component owner (`component_owners`, feeds auto-assign), must be an org member; `group` is a free label the component carries — the set of groups IS the distinct values in use, there is no group entity, and the admin UI offers the ones already in use plus "New group…" so a typo cannot silently mint a second one. PATCH audits as `component_update` naming the facts that actually changed — it logged `component_status … → operational` for a group rename before)
- **Status-page subscribers** (`lib/subscribers.js`, docs/INCIDENTS-V2.md slice 2) — e-mail double-opt-in, only available when a mail transport is configured AND `status_subscribers_enabled` ≠ '0'. Public: `POST /status[/:slug]/subscribe` (form) / `POST /api/status/subscribe?org=` (JSON) — honeypot + 3/min rate limit, **uniform `{ok:true}`** for new/pending/confirmed/invalid so the form cannot probe an address book; the confirm mail carries a single-use token link (48h TTL, hashed at rest). `GET /status/confirm?token=` confirms; `GET/POST /status/unsubscribe` is deliberately two-step (mail scanners GET every link) and accepts the original token or the per-mail `id`+HMAC pair. Confirmed subscribers are mailed on every transition of a **published** incident and the moment one first becomes published (`lib/incidents.setStatus`/`setPublished` — one mutation path, so the REST API and MCP behave identically); each mail carries its own unsubscribe link. Admin (lead+, addresses are PII): `GET /api/admin/status-subscribers` → `{available,enabled,confirmed,pending,rows:[{id,email,confirmedAt,createdAt}]}`, `DELETE /api/admin/status-subscribers/:id`
- `GET /status[/:slug]/feed.xml` — Atom feed of the published incidents the status page shows (same payload, `.xml` beside the page URL like `.json`); XML-escaped, `<link rel="alternate">` on the page, works independently of e-mail subscriptions
- **Status pages** (`lib/status-pages.js`, `lib/status-branding.js`, `lib/status-domains.js`, schema v18). A status page is a ROW, not an implicit per-org thing: an org has a default page (slug = the org's slug, so every pre-v18 URL still resolves) and, on Enterprise, additional ones. A page is addressable three ways, most specific first: its own **verified domain** → its **slug** (`/status/<slug>`) → the origin default (`/status`). **Pricing shape** (see `plans.js`): the page's IDENTITY — logo, favicon, accent, light/dark, description, support/legal links — is **ungated on every plan including Free**, because a status page is public and a Free one wearing a generic OpsCat mark advertises us badly rather than pressuring an upgrade. What is paid for is distance from OpsCat and what costs us to run: `status_domain` (pro+), `status_whitelabel` + `status_css` (business+), `status_pages_multi` (enterprise). All four are refused on WRITE with a 403 (a switch that silently does nothing is worse than one that explains itself) **and** re-checked on RENDER, so a downgrade stops the behaviour without destroying the configuration — an upgrade restores it untouched. Admin (read lead+, write admin): `GET /api/admin/status-pages` → `{pages:[…], limits:{canWhitelabel,canCustomCss,canCustomDomain,canMultiPage}, maxAssetBytes, maxCssBytes, defaultAccent}`; each page carries `resolved`, the exact object the public page renders with, so the admin preview cannot drift from the page it previews. `POST /api/admin/status-pages` (`{name,slug,visibility}`), `PATCH /api/admin/status-pages/:id` (`{name?,slug?,published?,visibility?,accent?,theme?,description?,supportUrl?,legalUrl?,hidePowered?,customCss?,componentIds?}`), `DELETE …/:id` (never the default page), `POST …/:id/rotate-token`. **Components:** `componentIds` is a positive subset; NO rows means *all*, so a page that shows everything keeps doing so as components are added. An incident appears on a page when it touches one of its components — or names none at all, which is how an org-wide announcement is expressed. **Private pages:** `visibility:'private'` mints an unguessable `access_token`; the page answers only for `?k=<token>` (then remembered in an httpOnly cookie so the links on the page work without carrying the secret), sends `noindex` in markup and header, and **404s rather than 403s** — a 403 would confirm that a page with that slug exists. Rotating the token is the revoke button. **Assets:** `PUT|DELETE /api/admin/status-pages/:id/asset/:kind` (`logo`|`favicon`, body `{data}` base64 or a `data:` URI, ≤512 KB). Typed by **magic bytes, not by the declared type**, and SVG is refused outright: `/status/logo` can be opened directly and an SVG there would execute on the status page's own origin. Public: `GET /status[/:slug]/logo|favicon` — same-origin (no CSP `img-src` entry needed), `nosniff` + `Content-Disposition: inline`, ETag/304, 404 while unpublished or private-without-secret. An unset favicon falls back to the logo. **Custom CSS:** appended to the page's own `<style>` block, ≤20 KB, and rejected (never stripped) when it contains a closing `</style>` — that one string would turn a stylesheet field into stored XSS. **Custom domains:** `POST /api/admin/status-pages/:id/domain` `{domain}` stores it UNVERIFIED and returns the two DNS records to create; `POST …/domain/verify` looks for the TXT challenge at `_opscat-challenge.<domain>` (records are joined before comparison — a value may be split at 255 bytes) and only then sets `domain_verified_at`; `DELETE …/domain` clears it. The CNAME that routes traffic is deliberately NOT the proof: a dangling CNAME from a former owner would otherwise hand the name to whoever asks next. Our own hostnames (`baseUrl`, `gridHost`) cannot be claimed. `GET /api/public/tls-check?domain=` is Caddy's on-demand-TLS gate and answers 200 **only** for a stored, verified, plan-covered domain — answering broadly would make the deployment an open certificate mint and burn the ACME rate limit. On its own domain the page serves at that host's ROOT (`/`, `/summary.json`, `/feed.xml`, `/logo`, `/favicon`, `/subscribe`, `/report`, `/confirm`, `/unsubscribe`) and every link it prints stays on that host.
- `GET /api/synthetics/locations` (own + visible managed incl. `booked`/`region`/`nodeStatus`; POST creates a self-hosted sensor agent → `{probeKey}` once), `POST /api/synthetics/locations/provision` (BYO-cloud: provisions into the org's own AWS/GCP account), `POST|DELETE /api/synthetics/locations/:id/book` (managed-location booking, plan quota `managedLocations`, premium = Enterprise plan), `GET|POST|DELETE /api/synthetics/cloud-credentials` (encrypted at rest, responses carry label+hint only), `GET /api/synthetics/provider-catalog`, `GET/POST/PATCH/DELETE /api/synthetics/checks` (types http|icmp|dns|tcp|traceroute; http checks accept `assertions {status?, keyword?, jsonPath?, jsonValue?}` and record `certDaysLeft` for https — ≤14 days raises `tls_cert_expiring`. Reputation assets are not in this table at all — they have their own tables and API at `/api/reputation/*`), `GET /api/synthetics/results` (latest per check×location), `GET /api/synthetics/results/series?checkId=&locationId=&hours=`, `GET /api/synthetics/history?minutes=&buckets=` (bucketed uptime per check for the HeatBar — worst-status-wins per bucket: `ok`/`warn`/`bad`/`na`, plus `uptimePct` and avg latency per bucket), `GET /api/synthetics/results/route?locationId=`, `POST /api/synthetics/run`
- **Reputation** (blocklist monitoring — own feature, own page, **own tables**: `reputation_assets` + `reputation_runs` (time series, pruned) + `reputation_listings` (one row per episode of being listed, with `firstSeen`/`resolvedAt`, kept)): `GET /api/reputation/assets` (each asset carries `status` (`listed`|`informational`|`clean`|`unknown`|`pending`), `kind` (`ip`|`domain`), `rdns`, `worstTier`, `listings[{name,zone,tier,codes,url,subject,firstSeen,lastSeen,resolvedAt}]` (`subject` null = the asset itself, otherwise the mail server the finding is about, e.g. `mail4.example.com [1.2.3.4]`), `mxHosts[{host,ip,provider,listed,covered}]` (domain assets: the servers behind its MX records, each with its own verdict — the domain's RHSBL result says nothing about them. `provider` non-null means the host is delegated to a mail platform and was deliberately NOT queried: a DNSBL is consulted by the receiving server against the *sending* address, and a cloud MX only accepts, so a listing there is neither actionable nor meaningful — and querying it would spend the address budget the org's own relays need) — **currently open episodes only**, `policy[]`, `unavailable[]`, `errored[]`, `zonesQueried`, `zonesTotal`, `lastCheckedAt`), `GET /api/reputation/overview` (KPI counts + `coverage {ip:{queried,total,unavailable}, domain:{…}}` — per kind, because the denominators differ: 31 IP lists vs 8 domain lists), `GET /api/reputation/assets/:id/history?limit=` (**every** episode, open and delisted, newest first — answers "how long were we on Spamhaus in March", which the previous sample-based model could not), `POST /api/reputation/assets` (`{target, intervalS?}` — target is a bare IP or domain, no scheme/path; stored normalised and de-duplicated on its canonical key, so `MAIL.Example.com.` 409s against an existing `mail.example.com`; interval floor **1h** — the feature's own, not the plan's — ceiling 24h, default 6h; counts against the plan's `checks` budget), `PATCH /api/reputation/assets/:id` (`{enabled?, intervalS?}`), `DELETE /api/reputation/assets/:id` (runs + listings cascade), `POST /api/reputation/assets/:id/run` (synchronous re-check, returns the fresh asset), `GET /api/reputation/zones` (the curated zone catalog with tiers), `POST /api/reputation/discover` (lead+ — `{domain}` → reads its SPF record and returns `{spf, lookups:{used,limit,permerror}, candidates:[{target,kind,source,alreadyMonitored}], pools:[{include,via,lookups}], ranges:[{range,via}], warnings[], queries}`; only mechanisms written directly in the record become candidates — an `include:` is a provider's shared pool and is reported rather than offered, while `redirect=` recurses as top-level per RFC 7208 §6.1 — and the RFC 7208 lookup budget falls out of the same walk, so a record above 10 lookups is flagged as the PermError it is), `POST /api/reputation/assets/bulk` (lead+ — `{targets:[], intervalS?}`, max 100; reports `{added, skipped:[{target,reason}]}` per target rather than failing the batch, and dedupes within the batch as well as against existing assets). A listing raises `reputation_listed` (severity by tier: critical 85 / standard 65; informational never alerts) rather than `synthetic_check_failed` — the asset is reachable, it is just undeliverable; delisting raises `reputation_cleared` (severity 20, below the alerting floor) so a `close_event` automation can finish the raise and close its case. `unavailable` zones are **unknown, not clean** — but a finding outranks a partial run: if some zones answered and listed the asset the status is `listed`, with the incompleteness still reported in `error`. An open episode is only ever resolved by a zone that **answered that run**, so a resolver having a bad day cannot silently erase a live listing. Reputation is server-local and that is now structural rather than guarded: the engine is the only writer of runs and listings and acts on evidence it gathered itself, so a probe key has no path to forge a listing or overwrite one. It is likewise unreachable from `POST /api/synthetics/run` and MCP `opscat_run_checks` — use the lead-only per-asset run.

- `GET /api/vendors` → `[{id,slug,name,feedType,feedUrl,pageUrl,intervalS,enabled,componentId,status,lastCheckedAt,lastError,activeIncidents}]` (`status` ∈ unknown|operational|degraded|partial|major|maintenance); `GET /api/vendors/catalog` → bundled vendor catalog `[{slug,name,feedType,feedUrl,pageUrl,domains}]`; `GET /api/vendors/:id` → vendor + `components:[{name,status,updatedAt}]` + `incidents:[{id,remoteId,title,status,impact,url,startedAt,resolvedAt,updatedAt}]`; `POST /api/vendors` (lead+) — `{slug}` from the catalog **or** custom `{name, feedType:'statuspage'|'instatus'|'slack'|'gcp'|'aws'|'heroku'|'statusio'|'rss', feedUrl, pageUrl?}` (https only, SSRF-guarded), `intervalS?` 60–3600 (default 120), polls immediately; `PATCH /api/vendors/:id` (lead+) — `{intervalS?, enabled?, componentId?}` (`componentId` mirrors the vendor state onto an own status-page component, `null` unmaps); `DELETE /api/vendors/:id` (lead+); `POST /api/vendors/:id/poll` — check now. New vendor incidents raise `vendor_incident` events (severity by impact: critical 90, major 82, partial 75, minor 55, maintenance 25, unknown 65), recovery raises `vendor_recovered` (20)
- `POST /api/vendors/detect` (lead+) — `{url}` of any status page → auto-detects the machine-readable feed behind it (Statuspage/incident.io shim, Instatus, Heroku, Slack-style, Google dashboards, status.io page-id extraction, RSS/Atom `<link>` discovery) → `{feedType, feedUrl, pageUrl, name, preview:{status,components,incidents}}`; 422 when nothing supported is found. Custom feed URLs are normalized on create (lowercase host, no trailing slash) so identical vendors across orgs share one polling fetch
- `POST /api/vendors/subscribe-catalog` (lead+) — subscribe the org to every catalog vendor it doesn't monitor yet (interval 300 s) → `{added, total}`; used to seed the public vendor grid
- Public vendor grid (no auth, off by default — publish with setting `vendor_grid_published=1` or env `OPSCAT_GRID_PUBLISHED=1`): `GET /api/public/vendor-grid` → `{updatedAt, total, disrupted, counts:{total,green,warn,red}, vendors:[{slug,name,status,activeIncidents,userReports60m,uptimePct,days:[{day,worst}],pageUrl,lastCheckedAt}]}` (org 1's monitored vendors, cached 60 s; `uptimePct`/`days` come from the per-minute `vendor_days` rollup, 45-day window); HTML at `GET /vendor-grid` (query params: `view=grid|list` — list shows 45-day heatbars + uptime, `f=all|green|warn|red` filter pills), and served as the front page on the grid host (`OPSCAT_GRID_HOST`, default `radar.opscat.io` — Caddy vhost included, DNS record required). Community signal: `POST /vendor-grid/report` (form) / `POST /api/public/vendor-grid/report` (JSON) — `{slug}` + honeypot `website`; per-IP rate limit, one report per visitor per vendor per hour, salted IP hash only, pruned after 30 days; grid shows `userReports60m`, ≥5 reports/60 min raise a `vendor_reports_spike` event in org 1
- `GET /api/superadmin/custom-vendors` (super-admin) — custom feeds across all orgs grouped by URL with org counts: the curation signal for catalog promotion (never public)
- `GET /api/status-reports?hours=` → `{total, reports:[{ts,component,message}]}` — anonymous problem reports submitted on the public status page. Public submission: `POST /api/status/report[?org=slug]` (JSON) or the status page's own form (`POST /status/report`, `POST /status/:slug/report`, urlencoded) — `{componentId?, message?}` + honeypot field `website`; rate-limited per IP (3/min), one report per visitor per 10 min, stores only a salted IP hash. ≥ `status_reports_threshold` (default 5) reports in 15 min raise a `user_reports_spike` event (severity 75, 85 at 3× threshold, re-raised at most every 10 min)
- `GET /api/admin/users` (lead+) lists org **members** with their per-org role. POST/PATCH admin only: POST with a known e-mail attaches that existing account to the org (multi-org, → `{added:true}`), an unknown e-mail creates a user; PATCH `{role}` sets the per-org role, `{remove:true}` drops the member from this org, `{resetPassword:true}` resets the password.

  Creating a user and resetting a password both have **two outcomes**, and the answer says which:

  | Mail transport | Answer | Account state |
  |---|---|---|
  | configured | `{invited:true, email}` | no password at all; a single-use activation link, valid 7 days, was mailed |
  | none | `{initialPassword}` | that password is set and `must_change_password = 1` — hand it over out of band |
  | send failed | `{initialPassword, mailFailed:true}` | same as above; the account is never left unreachable |
  | `manual:true` in the body | `{initialPassword}` | the deliberate escape hatch — a mailbox that is not reachable yet, a shared NOC account. Only the literal `true` takes it |

  `GET` also returns **`pending`** per row — an unused, unexpired activation link is
  outstanding. Derived from the token, not from an empty password: an SSO account has no
  password either and is not pending, and an expired link needs re-inviting.

  **`POST /api/superadmin/orgs`** (platform-initiated org creation) takes the same three
  outcomes, plus one of its own: an address that already has an OpsCat account becomes
  the owner of the new organization (`{attached:true}`) rather than being refused —
  multi-org is a supported shape. Nothing is issued and nothing is mailed in that case.
  New organizations start on `free` with **no** `trial_ends_at`: `free` is a forever
  plan, nothing ever read that column to expire anything, and the billing page showed a
  trial end date on a plan that does not end.

  The link path is the default wherever mail works: it means no shared secret ever exists, so there is nothing for the forced-change dialog to guard. See `server/src/lib/invites.js` and `server/e2e-invite.js` (61 checks).
- `GET/POST/PATCH /api/admin/apikeys` (lead+) — POST → `{key}` shown once
- `GET/POST/PATCH/DELETE /api/admin/snmp/targets` (lead+) — `{name,host,port,version:'2c'|'3',community?,oids:[{oid,label}],intervalS}`; v3 instead of community: `{v3User, v3Level:'noAuthNoPriv'|'authNoPriv'|'authPriv', v3AuthProtocol:'sha'|'md5', v3AuthKey, v3PrivProtocol:'aes'|'des', v3PrivKey}` (keys stored encrypted, never returned)
- `GET /api/admin/agents` (`{id,name,group,hostname,platform,version,active,autoUpdate,lastSeenAt,online}`), POST (lead+, `{name,group,autoUpdate?}` default true) → `{token}` once, PATCH `/:id` `{autoUpdate}`, `GET /api/admin/agents/:id/metrics?hours=`
- `GET/PATCH /api/admin/settings` — `GET` also returns two computed, read-only fields: `retention_logs_days_max` (the plan's log-retention ceiling in days, `''` = none) and `retention_logs_days_effective` (what the cleanup actually applies today). `PATCH` validates `retention_logs_days` as a whole number 1-3650 **and** against the plan ceiling — over-plan is a 400 naming the limit, not a silent clamp. Keys: `org_name, backend_label, status_published, retention_logs_days, onboarding_done, onboarding_role, onboarding_goal, onboarding_source, alert_email_from, auth_email_from, msteams_webhook_url, telegram_bot_token, pushover_token, classifiers, status_reports_enabled, status_reports_public, status_reports_threshold`. `onboarding_done` is `'0'` on a fresh cloud org and flipped to `'1'` when its admin finishes/skips the first-run setup flow; `onboarding_role/goal/source` capture the personalization answers (source = acquisition channel, only asked on a user's first org) for later analysis
- `GET /api/admin/pipeline/stats?range=24h|7d|30d` → `{range, step, buckets:[{bucket,lines,bytes,events}], totals:{lines,bytes,events}, peak}` — ingest throughput from the hourly `ingest_stats` counters (hour buckets for 24h, day buckets otherwise, gaps zero-filled). `peak` = `{source:'minute'|'hour', lines, bytes, at, perSecond, coveredFrom}` is the busiest MINUTE, read from `ingest_minutes` (48h deep) — the burst the ingest has to survive. `source:'hour'` means those counters do not reach into the range, so there is **no** per-second figure and the UI says so rather than dividing an hourly average by 60
- `GET /api/admin/pipeline/classifiers` → `{builtin:[…], custom:[…]}` (rule shape: `{pattern, flags, name, severity, targetGroup?, enabled?}`); `PUT` (admin) replaces the org's custom rules `{classifiers:[…]}` (≤100 rules, patterns validated, live reload — no restart). **`enabled: false` is a draft**: stored, listed and dry-runnable, but skipped when the chain is compiled. Only the literal `false` drafts a rule — a rule stored before drafts existed has no `enabled` key and keeps classifying
- `POST /api/admin/pipeline/test` — `{line, sev?}` → `{match:{name,severity,target,source:'custom'|'builtin'|'syslog',pattern}|null, caseThreshold}` — runs ONE pasted line through the org's classifier chain, nothing is stored
- `POST /api/admin/pipeline/dryrun` (admin) — `{pattern, flags?, name?, severity?, targetGroup?, hours?}` → backtests a rule against the logs already stored: `{hours, scanned, matched, shadowed, takeover, fresh, events, cases, samples:[{ts,device,line,target,replaces}], truncated, timedOut}`. Read-only — nothing is classified, stored or alerted. The three outcome counts assume the rule's real position (appended last among the custom rules, which run before the built-ins): **shadowed** = an earlier custom rule already matches, so this rule would never fire; **takeover** = a built-in or the syslog floor classifies it today; **fresh** = nothing classifies it today. `events`/`cases` are distinct dedupe keys (`name|device|target`), cases only when `severity ≥ 60`. Bounded to the newest 20 000 lines and a 2 s budget, both reported rather than silently applied
- `GET /api/admin/scout[?status=pending|approved|dismissed]` — **Scout**: templates mined from unclassified log lines (masking + Drain-style grouping in `engine/scout.js`), ordered by frequency. Admin actions: `POST /api/admin/scout/:id/suggest` asks the org's LLM (see AI below) for `{name, severity, skip, reason}` (stored on the row); `POST …/:id/dryrun` `{targetIndex?, severity?, name?, hours?}` → `{pattern, captureGroup, tooLong}` plus the `pipeline/dryrun` counts — the generated regex is returned by the SERVER (same `templateToPattern()` that writes the rule), so the preview can never disagree with the rule; `POST …/:id/approve` `{name, severity, targetIndex?, enable?}` converts the template into a custom classifier rule (placeholder `targetIndex` becomes the capture group / event target), **as a draft** (`enabled:false`) unless `enable:true` — Scout proposes, a human switches it on under Classifiers; audited as `scout_draft` / `scout_approve`; `POST …/:id/dismiss` hides it for good (kept so it is never re-suggested). Pending templates age out after 14 days, dismissed after 90; max 500 pending per org (lowest counts evicted)
- `GET/POST/PATCH/DELETE /api/admin/automations[/:id]` (lead+ to modify) — automation objects `{name, enabled, trigger:{event ('*'=any), severityMin}, actions:[…], cooldownM}`; action types: `{type:'close_event', raiseEvent, matchTarget?}` (lifecycle: the trigger event finishes the matching open raise event + closes its case), `{type:'assign_case', userId}`, `{type:'webhook', url}`. Max 5 actions; at most one run per event dedupe key and cooldown. `GET /api/admin/automations/runs?limit=` lists recent runs from the audit trail (action `automation_run`, system actor)
- `GET/PUT /api/admin/ai` (admin) — org LLM override `{baseUrl (OpenAI-compatible API root), model, apiKey (write-only, stored encrypted; '' clears)}`; GET reports `{org:{baseUrl,model,hasKey}, platformConfigured, effectiveSource:'org'|'platform'|null, effectiveModel}` — never key material. `POST /api/admin/ai/test` dry-runs a one-line prompt against the effective endpoint → `{ok, source, model, latencyMs}` or 502
- `GET /api/admin/system`, `GET /api/admin/audit` (admin)

## Billing (EE, `/api/billing`)

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
plan by default. CE enforces nothing.

`statusSubscribers` (50 / 500 / 5 000 / ∞) is the one limit that is not enforced on a
create route, because its "create" is an anonymous form. It counts **confirmed**
subscribers only — a pending double-opt-in may never complete, and letting unconfirmed
rows consume the allowance would let a stranger exhaust an org's quota by typing
addresses into the public form — and it is checked when a NEW address subscribes, never
at confirm time, so a visitor already holding a confirm mail is never met with "link
invalid". The org simply stops taking sign-ups; the answer stays the uniform `{ok:true}`
every other subscribe outcome gives, so the limit is not an enumeration signal either.
It sits beside `MAX_PER_ORG` in `lib/subscribers.js`, which counts *every* row and is an
abuse bound, not a commercial one.

## Super-admin (EE, `/api/superadmin` — requires `is_super_admin`)

Managed sensor fleet: `GET|POST /api/superadmin/platform-credentials`,
`GET|POST|PATCH|DELETE /api/superadmin/managed-locations` (provision with the
platform AWS/GCP credentials; PATCH toggles `visible`/`premium`; teardown
revokes the probe key before destroying the VM).

- `GET /api/superadmin/managed-locations/:id` → one location in full: everything the
  list row carries, plus `providerInstanceId`, `agentVersion`, `credential
  {id,label,hint}`, `nodeCreatedAt`, `lastSeenAt`, `checks`, `tenantOrgs
  [{id,name,plan}]` and `timeline`. The list keeps `tenants` as a COUNT and so does
  this — one field name, one shape, both endpoints.
- `timeline: [{ts, user:{id,n,i,c}|null, action, detail}]`, oldest first. `user: null`
  = the platform acted (a probe checked in), not a person. Actions: `provisioned`,
  `instance_created`, `provision_failed`, `online`, `visibility`, `premium`,
  `teardown`, `instance_destroyed`, `teardown_failed`.
- The rows are written by POST (provision, and the failure path), PATCH (only for a
  field that actually changed) and DELETE, plus the probe's first check-in. They live
  in `node_timeline`, which has **no foreign key to the location on purpose**: teardown
  deletes the location row, and the history has to outlive its subject — see
  `docs/ARCHITECTURE.md` § Managed fleet history.

| Method & path | Notes |
|---|---|
| GET `/overview` | platform KPIs: orgs, users, MRR, ingest volume |
| GET/POST `/orgs` · GET/PATCH/DELETE `/orgs/:id` | manage organizations (plan, status) |
| POST `/orgs/:id/impersonate` | switch the session into that org (audited) |
| GET `/super-admins` | list platform super-admins |
| POST `/super-admins` | `{email}` — grant the flag to an existing account (audited) |
| POST `/users/:id/super-admin` | grant/revoke the platform role by user id (self-demote rejected) |
| GET/PUT `/ai` | platform LLM default (OpenAI-compatible `{baseUrl, model, apiKey}` — key write-only/encrypted); orgs without their own Settings → AI & Voice override use this |
| GET `/audit` | platform-wide audit trail |

Errors are always JSON `{error}` with proper status codes. Rate limits: auth 10/min/IP,
API 300/min/session, ingest 600/min/key → `429`.
