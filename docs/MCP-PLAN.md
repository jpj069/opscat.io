# OpsCat MCP Server — implementation plan

Expose OpsCat to AI agents (Claude Desktop/Code, Cursor, claude.ai connectors) via
the Model Context Protocol, so an on-call engineer can ask "what's broken, since
when, and what changed" and act on the answer without leaving their client.

Spec baseline: **MCP revision 2025-11-25**. Reference implementation we are
borrowing from: the Lynk gateway (`jpj069/lynk-site`, `apps/gateway/src/lib/mcp/`)
— see [What we take from Lynk](#what-we-take-from-lynk-and-what-we-dont).

---

## 0. Guiding principle

**The MCP surface mirrors the UI's permission and limit model. It invents neither
stricter nor looser rules.**

If a `lead` can publish an incident in the web app, a `lead` can publish one
through MCP. If the app enforces no per-user call quota, MCP does not invent one
either. Where the two would diverge, the app is right and MCP follows — a second,
subtly different rule set is how authorization bugs are born. Every open question
in §6 was decided this way.

## 1. The blocker: `/api` has no token auth

This is the first piece of work, and it is not the MCP server itself.

`requireApiKey(scope)` (`server/src/security.js:146`) is mounted on exactly seven
`/v1` ingest routes. Everything an agent would want to *read* — events, cases,
logs, checks, incidents, agents, SNMP targets, vendors — lives under `/api` behind
`requireSession`: a session cookie **plus** an `x-opscat-csrf` header on every
non-GET. An MCP server authenticates machine-to-machine and has neither.

So: before any tool exists, `/api`'s authorization has to accept a token.

### OAuth 2.1 with an organization picker

**Decided:** OAuth is the primary credential, not an API key. That moves the
authorization server from a later milestone into M1, and it makes the multi-org
story a first-class part of the login rather than a workaround.

The flow, once per connection:

```
client → DCR (RFC 7591) → /oauth/authorize
                              ↓  existing session, or log in
                          consent screen
                              ↓  ← organization CHECKBOXES, when the user has >1
                          code (PKCE S256) → /oauth/token
                              ↓
                          access token bound to (user, orgs, scopes)
```

The consent screen lists every organization the user is a member of, with the
role they hold in each. With exactly one membership the picker is skipped — no
pointless click.

**This decision was reversed (migration 037), and the original objection was
right.** It read: keep the org boundary inside the credential rather than in a
tool argument an agent could get wrong, and connect a second organization by
running the flow a second time. What that cost in practice was the thing nobody
weighed — somebody who looks after three organizations authorized three times
and switched clients by hand, for a boundary that was never a security property
but a single column.

So a connection now covers a SET of organizations: checkboxes, all pre-ticked,
plus an opt-in for the ones joined later (`org_scope` = `list` | `all`). The
objection is answered by making the argument impossible to get wrong rather than
by removing it:

- with several organizations `organization` is **required** on every tool, and
  `resolveOrg` has **no default** — a call that names none is refused, never
  answered for whichever org sorts first;
- it is matched on the NAME, because a name is what survives a conversation and
  a uuid is not; an ambiguous name (`organizations.name` is not unique) is a
  refusal that offers the slugs, not a coin toss;
- the role is re-checked **per call** against the org that call resolved to, so
  admin in one and analyst in another behaves like exactly that;
- a connection with ONE organization is byte-identical to before — no argument,
  no extra concept.

What did not change is the part that carries the weight: the grant's org set is
an upper bound and `memberships` is the authority, re-read on every request.

### What this buys us

The permission model needs **no new columns**. `memberships (user_id, org_id, role)`
already exists (`server/src/db.js:194`), and it is already the thing
`requireRole()` reads. A token stamped with `(user_id, org_id)` resolves to the
user's real role in that org:

| Concern | Resolution |
|---|---|
| Org scoping | the token's org SET (`org_id` + `org_scope`/`org_ids`, migration 037), chosen at consent time and intersected with `memberships` on every request |
| Permissions | `memberships.role` for that `(user, org)` — the same row the UI reads |
| Revocation | Revoking a token, or removing the membership, both cut access immediately |
| Role changes | Follow automatically; the token carries no cached role |
| CSRF | Not applicable to Bearer auth — CSRF protects *cookie* auth. The guard stays for session requests and is skipped only when the request authenticated via Bearer |

Note that the token's org binding is deliberately independent of
`sessions.active_org_id`: switching organization in the browser must not silently
change what an already-issued MCP token can see.

Concretely, a `resolvePrincipal` middleware ahead of the `/api` routers, producing
the same request shape the handlers already expect (`req.user`, `req.org`,
`req.orgId`, `req.user.role`) so no route handler changes:

```js
// session cookie   → today's requireSession path (CSRF enforced)
// Bearer <token>   → oauth token → (user, org) → memberships.role  (no CSRF)
```

**Audit:** `sec.audit()` takes a real `userId` here — the human who authorized the
connection — with the client id in the detail field. An agent's mutation is
attributable to a person, not to a shared key.

**Rate limiting:** a dedicated limiter keyed by token id, separate from
`apiLimiter` (per session) and `ingestLimiter` (sized for ingest volume).

### API keys as the headless fallback

An API key remains useful where no browser can complete a consent flow: CI, a
cron job, a self-hosted instance with no public origin. That path is deliberately
**secondary** and ships after OAuth (M3), so the ergonomic default is the one with
per-user attribution and revocable consent. When it lands it needs
`ALTER TABLE api_keys ADD COLUMN role`, defaulting to the least-privileged
`analyst`, plus a new `mcp` value in the existing `scopes` CSV. Per the schema
convention in `server/src/db.js`, the `ALTER` goes in the migration block and any
index on it goes *after* the `ALTER`, never into the `CREATE TABLE` string.

---

## 2. Architecture

### Transport

Streamable HTTP at `/mcp`, mounted on the existing Express app. No new port — the
app still has no published port and everything continues to arrive through Caddy.
SSE-only transport is deprecated and is not implemented.

The SDK is `type: module` but ships a CJS condition in its exports map;
`require('@modelcontextprotocol/sdk/server/mcp.js')` from OpsCat's CommonJS server
is **verified working** (SDK 1.29.0, Node 22). No ESM migration needed.

Body parser: the global `express.json({ limit: '1mb' })` is fine — no MCP tool
should take a base64 payload (see §4).

### Session handling

Port the hardened design from `lynk-site` (`apps/gateway/src/lib/mcp/http-session.ts`),
translated to CJS, as `server/src/mcp/http-session.js`:

- only `initialize` opens a session; anything else that doesn't resolve to a live
  one is `404` and **allocates nothing** (otherwise every stray request leaks a
  fully-populated `McpServer`);
- idle TTL measured from the **last** request, never from creation;
- session ids are not reusable across users;
- `Origin` validated, `403` on an untrusted one, absent `Origin` allowed.

### Editions

Both editions get the same thing: OAuth 2.1 with the organization picker, one
transport, one tool registry. Community instances are usually single-org, so the
picker simply never renders there — the flow is identical, it just has nothing to
ask.

The MCP server and its authorization server are **core** (Apache-2.0), not EE: an
SRE self-hosting OpsCat should get the agent integration, and gating the login
behind the commercial edition would make the community build a second-class
client. Check `docs/OPEN-CORE.md`'s exclusion list when the files land; no new
exclusions are expected.

---

## 3. Tool surface

Derived from the endpoints that exist today. **Every tool carries annotations from
day one** — this is the single biggest lesson from the Lynk review, where 308
tools shipped without them. The spec default for an un-annotated tool is
`readOnlyHint: false` + `destructiveHint: true`, so an unannotated read tool reads
as dangerous to a host, and a genuinely destructive one is indistinguishable from
it.

### Read (`analyst`)

`readOnlyHint: true` on all of these.

| Tool | Backed by |
|---|---|
| `opscat_list_events` / `opscat_get_event` | `GET /api/events`, `/api/events/:id` |
| `opscat_list_cases` | `GET /api/cases` |
| `opscat_search_logs` | `GET /api/logs` |
| `opscat_get_dashboard` / `opscat_get_analytics` | `GET /api/dashboard`, `/api/analytics` |
| `opscat_list_checks` / `opscat_get_check_results` | `GET /api/synthetics/checks`, `/results` |
| `opscat_list_incidents` | `GET /api/incidents` |
| `opscat_list_agents` / `opscat_list_snmp_targets` | `GET /api/admin/agents`, `/api/admin/snmp/targets` |
| `opscat_list_heartbeats` / `opscat_list_maintenance` | `GET /api/heartbeats`, `/api/maintenance` |
| `opscat_list_alert_rules` | `GET /api/rules` |
| `opscat_list_vendors` | `GET /api/vendors` |

### Write (`lead`+)

| Tool | Annotations | Note |
|---|---|---|
| `opscat_update_case` (ack / close) | `destructive:false, idempotent:true` | additive state change |
| `opscat_event_action` | `destructive:false` | |
| `opscat_create_incident` | `destructive:false, idempotent:false` | public status page — user-visible |
| `opscat_post_incident_status` | `destructive:false` | public status page |
| `opscat_update_incident` | `destructive:false, idempotent:true` | |
| `opscat_create_maintenance` | `destructive:false` | |
| `opscat_delete_maintenance` | `destructive:true` | |
| `opscat_run_check` | `destructive:false, openWorld:true` | hits a third-party target |
| `opscat_poll_vendor` | `readOnly:false, openWorld:true` | |

Alert-rule mutation (`POST/PATCH/DELETE /api/rules`) is deliberately **out of
scope for v1** — an agent silently editing alerting is the failure mode nobody
wants. Read-only first; revisit once elicitation is in place.

Deliberately **never** exposed: user management, API-key management, org/billing,
super-admin. An agent that can mint credentials is a privilege-escalation path.

### Structured output

Every tool declares an `outputSchema` and returns `structuredContent` alongside
the text block. Cheap at the start, painful to retrofit across a grown tool set.

### Instructions

The `InitializeResult.instructions` block stays **under ~2 KB** and carries only
genuinely cross-tool rules (severity vocabulary, org scoping, "read before you
ack"). Per-tool behaviour belongs in tool descriptions and annotations. For
contrast: Lynk's is ~16 KB and goes into context at every session start.

---

## 4. Milestones

| | Scope | Done when |
|---|---|---|
| **M1 — shipped** | OAuth 2.1 AS (RFC 8414 metadata, RFC 7591 DCR, PKCE S256, RFC 9728 under both `.well-known` forms, RFC 8707 audience binding) **incl. the org picker**; principal middleware; `/mcp` transport; 8 read tools with annotations + `outputSchema` | Claude Desktop completes consent, picks an org, and answers "which checks are failing?" |
| **M2 — shipped** | 8 write tools; audit attribution to the authorizing human; per-token rate limit; a "Connected apps" view in Settings to see and revoke grants | An agent acks a case, and the audit log names the human who authorized the client |
| **M3 — shipped, widened** | `Authorization: Bearer` on the whole operations REST API — MCP tokens AND `api`-scoped API keys with their own role | A cron job drives `/api/events` with no browser and no MCP client |
| **M4 — shipped, minus Tasks** | Resources (status page, open incidents); SEP-973 server icon; elicitation confirms on destructive calls | A client attaches the status page as context; publishing an incident asks first |

M1 was the largest by a distance — the authorization server is most of it, and
the transport plus tools are comparatively small once a token resolves to a
principal.

**M3 was deliberately widened.** The plan had it as an API-key fallback *for MCP*.
The better shape, and what shipped, is token auth on the operations REST API
itself: the same endpoints the web app uses accept `Authorization: Bearer` from
either an MCP access token or an `api`-scoped API key. OpsCat is therefore
scriptable without MCP at all, and MCP becomes one client of that surface rather
than a private side door. Account, API-key, billing, org and super-admin routes
stay session-only.

**Tasks (SEP-1686) were NOT built.** SDK 1.29 ships the task *types* and the
low-level `tasks/*` request handlers, but `McpServer` has no `registerToolTask` —
the identifier appears only inside an error message. Hand-rolling the protocol
against an experimental surface with no supported server API would be a liability,
so the long-running tool (`opscat_run_checks`) stays synchronous until the SDK
exposes it.

### What M1 actually shipped

| File | Role |
|---|---|
| `server/src/schema.sql` | `oauth_clients`, `oauth_codes`, `oauth_tokens` (no migration needed — `schema.sql` runs with `IF NOT EXISTS` on every boot, so new *tables* reach existing databases; only new *columns* need a migration entry) |
| `server/src/lib/oauth.js` | DCR, PKCE codes, token issue/rotate/revoke |
| `server/src/routes/mcp-oauth.js` | Metadata, `/oauth/*`, the consent screen with the org picker. Separate from the EE-licensed `routes/oauth.js` (SSO *into* OpsCat) — this is core |
| `server/src/mcp/auth.js` | Bearer → principal; role read from `memberships` per request |
| `server/src/mcp/http-session.js` | Transport, with the four invariants |
| `server/src/mcp/tools.js` | 8 read tools, annotated, `outputSchema` on each |
| `server/src/mcp/server.js` | Scope- and role-gated registration; ~1 KB `instructions` |
| `server/src/routes/mcp.js` | `/mcp` + `/mcp/llms.txt` |
| `web/src/App.tsx` | Honours `?next=/oauth/…` after login so the consent flow resumes |
| `server/e2e-mcp.js` | 32-check end-to-end harness (`node e2e-mcp.js` against a running server) |

Two things worth remembering from the build:

- **`routes/oauth.js` already existed** and is EE-licensed (Google/Microsoft SSO,
  i.e. signing *into* OpsCat). The MCP authorization server is the opposite
  direction and is core, so it lives in `routes/mcp-oauth.js`. Nearly overwrote
  the EE file.
- **The consent POST cannot send the `x-opscat-csrf` header** a plain HTML form
  has no way to set. The signed consent ticket is bound to the session id
  instead, which is what makes the POST CSRF-safe.

### Non-goals for v1

- No log *ingestion* via MCP — that is what the SDK and `/v1` are for, and it
  would put unbounded payloads through a model's context.
- No file/base64 transport in tools.
- No agent-driven config of alert rules, users or billing.

---

## 5. What we take from Lynk (and what we don't)

**Take:**

- the hardened transport module (session store, leak guard, idle TTL, origin
  guard, RFC 9728 path derivation) — see `jpj069/lynk-site#519`;
- the OAuth 2.1 structure for M3: DCR, mandatory PKCE S256, audience binding, and
  serving protected-resource metadata under both `.well-known` forms;
- scope-gated tool registration (only register what the credential grants);
- the audit wrapper that records every tool call with arguments redacted to field
  *names* only.

**Don't take:**

- un-annotated tools (M1 fixes this by construction);
- text-only tool results without `outputSchema`;
- a 16 KB instructions blob;
- one endpoint carrying every tool family — OpsCat's surface is ~25 tools, so a
  single resource is right, but the scope gate stays so a read-only key never
  sees write tools.

---

## 6. Decisions

Settled 2026-07-27. Each follows the principle in §0 — match the app, don't
invent a parallel rule.

**1. Log reading — full message bodies, no redaction layer.**

`opscat_search_logs` returns log content as stored. The reasoning that makes this
safe is the org boundary: a token reads only the logs of the organizations it was
issued for — every one of them chosen by a member of that organization, who is
connecting their own data to their own AI client. Multi-org (037) does not widen
that: a call reads exactly the org it named, out of a set the person ticked, and
every org in the set is one they hold a membership in *at the moment of the
call*. It is still not a cross-tenant path, so the Personio-style redaction layer
would be protecting an org from itself.

What this does **not** remove is the standing logging-hygiene rule: applications
should not write secrets into logs in the first place. MCP makes the consequence
of breaking that rule more visible, not more severe.

A redaction layer stays a viable later addition (per-org opt-in, same shape as
Lynk's `PERSONIO_SENSITIVE_FIELDS`) if a Cloud customer asks for one — the tool's
response schema does not need to change to add it.

**2. No metering.** MCP tool calls do not count against a plan limit, because the
web app enforces no equivalent per-user limit either. Rate limiting still applies
as an abuse control, which is a different thing from a quota. Revisit only if
real usage makes it necessary.

**3. Status-page writes ship in v1**, at `lead` — the same role
`POST /api/incidents` already requires in the app. Deliberately *not* raised to
`cto` for MCP: an agent acting for a `lead` should be able to do what that `lead`
can do. The M4 elicitation confirm is added on top later as a safety net, not as
a permission.

**4. OAuth with an organization picker** — see §1. Multi-org users pick the
organization during consent; one connection per organization.

**5. No public unauthenticated MCP resource.** Instead the status page is now
machine-readable at its own URL: append `.json` to any status page
(`/status.json`, `/status/:slug.json`) and get the payload the page renders,
linked from the page footer. No slug parameter to look up — the URL already
identifies the org, which also means it keeps working unchanged when status pages
move to customer domains. `/summary.json` is the origin-level alias, deliberately
the shape OpsCat's own vendor detector probes for, so an OpsCat status page is
auto-detectable by OpsCat. Shipped alongside this plan.
