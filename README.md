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
- **SNMP** — v2c polling of network devices with unreachable/threshold events.
- **Incidents & status page** — incident timeline + RCA editor, public status page
  at `/status` with 45-day component uptime.
- **UI** — React SPA (`/app`): live monitor with streaming logs (SSE), dashboard,
  cases, analytics, alert rules, synthetics, terminal-style Classic View, user & key
  management. Dark/light themes. Password + magic-link login.

## Repository layout

| Path | What |
|------|------|
| `server/` | Express 4 API + engines (pipeline, alerts, synthetics, SNMP, retention) — SQLite (WAL) storage |
| `web/` | React + Vite + TypeScript UI, built into the server image |
| `sdk/js/` | `@opscat/sdk` — dependency-free logging SDK (Node ≥18 + browsers) |
| `agent/` | `opscat-agent.js` — dependency-free server agent + probe mode + installer |
| `docs/` | [ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md) · [OPERATIONS](docs/OPERATIONS.md) |

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
`RESEND_API_KEY`, `OPSCAT_ALERT_FROM`, `OPSCAT_SECRET`, `OPSCAT_BASE_URL`.
Deploys run from GitHub Actions on push to `main` (SSH → `docker-compose up -d --build`).

## Drop your logs here

```bash
curl -X POST https://opscat.io/v1/ingest/logs \
  -H "Authorization: Bearer ock_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"logs":[{"device":"web-01","line":"kernel: Out of memory: Killed process 4242","sev":2}]}'
```

Create API keys in the UI under **Settings → API Keys**. Full surface: [docs/API.md](docs/API.md).
