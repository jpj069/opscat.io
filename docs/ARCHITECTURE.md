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
                        │     snmp · retention                       │
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
2. Pipeline classifies each line (configurable regex classifiers) → severity score 0–100.
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
server/   Express API + engines (this is the deployable unit)
web/      React + Vite UI (built into server/public at docker build)
sdk/js/   @opscat/sdk — dependency-free log SDK (Node + browser)
agent/    opscat-agent.js — dependency-free server agent (+ --probe mode)
deploy/   Caddyfile
docs/     this file, API.md, OPERATIONS.md
```
