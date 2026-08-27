# OpsCat

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Open Core](https://img.shields.io/badge/model-open--core-6366f1.svg)](docs/OPEN-CORE.md)

Infrastructure Ops Platform for NOC/SRE teams — self-hosted monitoring, or use
[OpsCat Cloud](https://opscat.io). **[Open core](docs/OPEN-CORE.md):** the whole
platform is Apache-2.0 and self-hostable (single organization, all features, no
limits); the hosted multi-tenant SaaS layer (billing, super-admin, SSO, managed
sensors) is the commercially-licensed Enterprise Edition. Run the community
edition with `OPSCAT_EDITION=community` (default).

## Features

- **Log ingestion** — open HTTPS endpoints (`/v1/ingest/*`), a dependency-free
  [JS SDK](sdk/js/), OTLP/HTTP (OpenTelemetry logs + traces), Sentry and generic webhooks.
- **Event engine** — classifies log lines, scores severity 0–100, dedupes into live
  events, auto-opens cases, drives alert rules (Resend e-mail / Teams / webhooks).
- **Server agents** — a single-file [agent](agent/) reporting heartbeat, CPU/RAM/disk/network
  metrics and (optionally) journald logs.
- **Synthetics** — HTTP/ICMP/DNS/TCP/traceroute checks from the platform host plus any
  number of remote probe locations (the agent in `--probe` mode).
- **Reputation** — blocklist monitoring for your sending IPs and domains across 31 IP / 8 domain lists, tiered so range-wide listings never page anyone, and honest about
  lists that could not be queried (unknown, never "clean").
- **SNMP** — v2c polling of network devices with unreachable/threshold events.
- **Vendor monitoring** — supply-chain watch on the official status pages of 220+
  services (GitHub, AWS, Cloudflare, Stripe, Notion, GitLab, Heroku, Snowflake,
  Smartsheet, Qualtrics, …) plus custom feeds — any Statuspage, Instatus,
  incident.io or status.io page works; vendor incidents raise events/alerts and
  can mirror onto your own status-page components.
- **Incidents & status page** — incident timeline + RCA editor, public status page
  at `/status` with 45-day component uptime, e-mail subscribers (double-opt-in) +
  Atom feed, and Downdetector-style anonymous "report a problem" submissions
  (spikes raise alerts before monitoring catches up). Brandable: your logo,
  favicon, accent colour, light or dark, description and support links — included
  on every plan, because a status page is public and should look like yours.
  Optionally on your own domain (`status.acme.com`, certificate issued
  automatically after a DNS check), with your own CSS, and as several pages —
  including private, link-only ones for a specific audience.
- **UI** — React SPA (`/app`): live monitor with streaming logs (SSE), dashboard,
  cases, analytics, alert rules, synthetics, terminal-style Classic View, user & key
  management. Dark/light themes. Password, magic-link and GitHub login (Google +
  Microsoft on [OpsCat Cloud](https://opscat.io)).

## Repository layout

| Path | What |
|------|------|
| `server/` | Express 5 API + engines (pipeline, alerts, synthetics, SNMP, retention) — PostgreSQL 16 storage |
| `web/` | React + Vite + TypeScript UI, built into the server image |
| `sdk/js/` | `@opscat/sdk` — dependency-free logging SDK (Node ≥18 + browsers) |
| `agent/` | `opscat-agent.js` — dependency-free server agent + probe mode + installer |
| `docs/` | [ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md) · [OPERATIONS](docs/OPERATIONS.md) · [MCP-PLAN](docs/MCP-PLAN.md) |

**Two databases, and only two.** Everything transactional — events, cases,
incidents, users, settings — lives in **PostgreSQL**. Raw log **lines** live in
**ClickHouse**: they are the one table that is append-only, never updated, read
by scanning and large, so they are the one table a column store is right for.
About **14× less disk per line** and log search an order of magnitude faster.
Nothing is joined across the two.

No search cluster, no message broker, no JVM, no queue. The whole stack — API,
engines, both databases, Caddy, DNS resolver — runs on a **2-vCPU / 4 GB VM** at
about **870 MB** settled, measured on our own production host after days of real
traffic rather than seconds after boot. The compose file caps PostgreSQL at 1 GB
and ClickHouse at 1.5 GB, so the ceiling is a number you can plan against rather
than a surprise.

<sub>Constrained box? `docker-compose.postgres-logs.yml` keeps log lines in
PostgreSQL and drops the stack to ~400 MB. Supported and tested on every pull
request — see [OPERATIONS](docs/OPERATIONS.md) — but Postgres + ClickHouse is
the stack.</sub>

Measured figures, each with the conditions that make it true, are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

> **Upgrading an existing install?** Set `CLICKHOUSE_PASSWORD` in `.env` (it
> refuses to start without one), then bring your log history across —
> `docker compose exec -T app node server/scripts/migrate-logs-to-clickhouse.js`.
> Reads switch over as soon as the app restarts, so without that step your older
> lines stay in PostgreSQL and stop being displayed.

## Quick start (development)

```bash
npm run setup                 # install server + web deps
cd server && npm start        # API on :3000 (seeds first admin — password printed once)
cd web && npm run dev         # Vite dev server on :5173, proxies /api + /v1
```

## Production

```bash
docker compose up -d --build  # app (internal only) + Caddy (TLS on 80/443)
```

Configuration via environment / `.env` (see `docker-compose.yml`): `OPSCAT_ADMIN_EMAIL`,
`RESEND_API_KEY` or `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` (e-mail
via Resend API or any SMTP relay), `OPSCAT_ALERT_FROM`, `OPSCAT_SECRET`, `OPSCAT_BASE_URL`.
Deploys run from GitHub Actions on push to `main` (SSH → `docker-compose up -d --build`).

## Drop your logs here

```bash
curl -X POST https://opscat.io/v1/ingest/logs \
  -H "Authorization: Bearer ock_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"logs":[{"device":"web-01","line":"kernel: Out of memory: Killed process 4242","sev":2}]}'
```

Create API keys in the UI under **Settings → API & Access**. Full surface: [docs/API.md](docs/API.md).
