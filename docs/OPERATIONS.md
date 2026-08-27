# OpsCat Community Edition — Operations

How to run and operate a self-hosted OpsCat instance. (This is the community
edition of this document; hosting-provider specifics of the managed OpsCat
Cloud service are internal.)

## Deployment

```bash
git clone https://github.com/jpj069/opscat.io.git opscat && cd opscat
cp .env.example .env   # if present — otherwise create .env, see below
docker compose up -d --build
```

Caddy terminates TLS and is the only published port (80/443). The app container
has no host port on purpose. Set your domain in `.env`:

```ini
OPSCAT_DOMAIN=monitoring.example.com     # Caddy auto-provisions TLS
OPSCAT_BASE_URL=https://monitoring.example.com
OPSCAT_SECRET=<long random string>       # cookie/crypto secret; generate once
# optional e-mail (alerts + magic-link login) — EITHER the Resend API:
RESEND_API_KEY=
# OR any SMTP relay (SES, Mailgun, corporate smarthost, …):
SMTP_HOST=
SMTP_PORT=587                            # 587 submission (default); 465 with SMTP_SECURE=1
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=0                            # 1 = implicit TLS (port 465)
OPSCAT_ALERT_FROM=alerts@example.com
OPSCAT_AUTH_FROM=login@example.com
OPSCAT_ADMIN_EMAIL=you@example.com       # first admin user (seeded on first boot)
```

Keep `.env` at mode `600` and never commit it.

## First login

On first boot the server seeds the admin user (`OPSCAT_ADMIN_EMAIL`) and prints
a one-time generated password to the container log:

```bash
docker compose logs app | grep -i password
```

Log in at `https://<your-domain>/app`, then change the password.

## Data & backups

All state lives in PostgreSQL, in the `opscat_pgdata` volume. `DATABASE_URL` is
required and the app refuses to start without it.

Raw log LINES live in ClickHouse (`opscat_chdata`) — see *The two databases*
below. Everything else is in PostgreSQL, so the `pg_dump` below remains the
backup that matters. A lost ClickHouse volume costs the raw lines behind events
that already exist, for as long as your retention would have kept them; the
instance comes back working, with a Logs page that refills as agents ship.

Back ClickHouse up too if the retention you keep makes the lines themselves
something you would miss — it is a `SELECT … FORMAT Native` dump, and it is not
free on a large table. If you run with `CLICKHOUSE_URL=` empty, the lines are in
PostgreSQL and the `pg_dump` already has them.

If you are coming from a build that ran on SQLite, note that the file-copy
backup is gone with the file. `pg_dump` in a cron is more to set up than
copying `opscat.db` was — that was the acknowledged cost of having one engine
instead of two SQL dialects. What it gives back is a dump that is consistent
without stopping the app.

### Backing up

The user and database below are the compose defaults; if you set
`POSTGRES_USER` / `POSTGRES_DB` in your `.env`, substitute those — `pg_dump`
against a user that does not exist fails loudly, but against the WRONG
database it succeeds and gives you an empty dump.

```bash
docker compose exec -T db pg_dump -U opscat -Fc opscat > opscat-$(date +%F).dump
```

### Restoring

Restore into an EMPTY database — `pg_restore` does not clear what is already
there, and restoring over a running instance leaves you with a mix of both:

```bash
docker compose stop app
docker compose exec -T db dropdb   -U opscat --if-exists opscat
docker compose exec -T db createdb -U opscat opscat
docker compose exec -T db pg_restore -U opscat -d opscat < opscat-2026-08-18.dump
docker compose start app
```

Verify a backup by restoring it somewhere, not by checking that the file is
non-empty. `pg_dump` exits 0 on an unreachable table it was never asked for.

**Snapshotting the volume works for either engine only while the stack is
stopped.** A filesystem snapshot of a running database is a crash image; both
engines recover from one, but that is a property you should test rather than
assume on the day you need it.

## Upgrades

```bash
git pull
OPSCAT_COMMIT=$(git rev-parse --short=7 HEAD) docker compose up -d --build
curl -s http://localhost/api/version     # did the new build actually come up?
```

`OPSCAT_COMMIT` stamps the image with the commit it was built from, so
`/api/version` can tell you afterwards which code is running. Leave it out and
the answer is `"unknown"` — honest, but then an upgrade that built fine and
failed to restart looks exactly like one that worked.

Database migrations run automatically and are backward-compatible; still, take
a backup first.

## Health & monitoring the monitor

- `GET /api/health` — liveness (also used by the container HEALTHCHECK).
- `GET /api/version` — which build is running: `version`, `commit`, `builtAt`
  (when the image was built) and `startedAt` (when this container came up).
  Both endpoints are unauthenticated, so an external monitor can read them.
- `GET /status` — public status page.
- Logs: `docker compose logs -f app`.

## Log retention

Retention defaults are configurable under **Settings** in the UI; the retention
engine prunes old logs/events on an interval. Community edition has no plan
limits — retention is whatever you configure.

## The two databases

Everything transactional — events, cases, incidents, users, settings — is in
**PostgreSQL**. Raw log **lines** are in **ClickHouse**. Nothing is joined
across the two, and only PostgreSQL needs a backup on a schedule (see *Data &
backups*).

ClickHouse is there because two things get slow as an instance grows, and both
are full scans of the log table: **full-text log search** and the **throughput
chart** on the Analytics page. Measured on 596,491 lines over 7 days, two cores
(`docs/BENCHMARKS.md`):

| | PostgreSQL | ClickHouse |
|---|---|---|
| disk per log line | ~301 bytes | **22 bytes** |
| log search, 7 days | 435 ms | **17-25 ms** |
| throughput chart, 7 days | 261 ms | **26 ms** |
| the same chart at 6 M lines | 2,620 ms | **134 ms** |

**What it costs is memory, stated plainly:** the stack settles at about
**870 MB** with both databases, against roughly 400 MB with PostgreSQL alone —
measured on our own production host after days of traffic, not seconds after
boot, because ClickHouse grows into its caches and a fresh-boot figure flatters
it by 150 MB. The compose file caps PostgreSQL at `mem_limit: 1g` and ClickHouse
at `1.5g`, so the ceiling is bounded rather than open-ended: budget 2.5 GB for
the two databases in the worst case, and remember that a host with no swap needs
those caps to be real.

### Running without it

On a box too small to spare that — a Pi, a 1 GB VPS, an appliance — there is a
one-file opt-out:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres-logs.yml up -d
```

Log lines then stay in PostgreSQL and everything works exactly as before.

**Use the override file rather than just emptying `CLICKHOUSE_URL`.** An empty
URL tells the app to use PostgreSQL, which is half the job: the `clickhouse`
service is still declared, so `docker compose up -d` starts the container anyway
and you pay the memory for a database nothing reads. The override removes the
service and the dependency on it.

You will still need a `CLICKHOUSE_PASSWORD` line in `.env` and it can say
anything (`CLICKHOUSE_PASSWORD=unused`). Compose interpolates every service
block when it loads the file, including one it will never start, so the
requirement is evaluated before the override applies. Requiring it on the
default path is deliberate — an install that silently comes up without its log
store is much harder to diagnose than one line at startup.

This is a supported configuration, not a deprecated one: CI runs the same 40
assertions against both stores on every change.

### Upgrading an existing install

Two steps, and the second is the one people miss.

**1. Set a password**, or `docker compose up -d` refuses to start:

```bash
CLICKHOUSE_PASSWORD=$(openssl rand -hex 24)   # in .env
```

It fails loudly on purpose. An install that comes up without its log store
reports itself as a crash-loop, which is much harder to diagnose than a
one-line error at startup.

**2. Bring your existing log lines across**, once the stack is up:

```bash
docker compose exec -T app node server/scripts/migrate-logs-to-clickhouse.js --dry-run
docker compose exec -T app node server/scripts/migrate-logs-to-clickhouse.js
```

Reads switch to ClickHouse the moment the app restarts, so without this your
history is still in PostgreSQL and simply stops being displayed. The script
pages through the table, verifies the row counts agree, does **not** delete the
PostgreSQL rows, and refuses to run a second time (there is no key to
deduplicate on, so a second pass would double every line).

Once the Logs page looks right, reclaim the PostgreSQL space:

```bash
docker compose exec -T app node server/scripts/migrate-logs-to-clickhouse.js --drop-source
```

It re-checks, **per organisation**, that ClickHouse holds at least as many lines
inside the same timestamp window before it truncates anything, and refuses
outright if any org comes up short. Per organisation rather than one total,
because a busy tenant's new lines would otherwise cover for an empty one. That
guard catches a copy that half-ran or never ran; it cannot prove the rows are
identical, so look at the Logs page first.

Add `--dry-run` to that same command to run the **whole** verification and print
the per-organisation table without truncating anything. Do that first: after the
truncate there is nothing left to compare against.

If your instance has been ingesting into ClickHouse for a while before you get
here, the PostgreSQL table may no longer be a subset of it — the oldest rows
aged past their retention window on the ClickHouse side and are genuinely gone.
Copying is then wrong (it would duplicate everything both stores hold) and the
shortfall is real. `--accept-loss=<lines>` is for that case: a **ceiling**, not
a switch, so the script measures the real shortfall and still refuses if it is
larger than the number you give. What is accepted is printed beside what was
measured.

You do not have to run any of this to avoid a leak, only to get the space back
sooner: the retention sweep prunes the orphaned PostgreSQL rows on its own
schedule as well.

### Things worth knowing

- **If ClickHouse cannot be reached, the app exits.** It does not fall back to
  PostgreSQL — that would split your lines across two stores with no error
  anywhere, and the split stays invisible until you search for one that is in
  the other.
- `docker compose logs app | grep '^log store:'` says which one is serving.
- Retention works exactly as configured, per organisation, on both.
- Going back means setting `CLICKHOUSE_URL=` empty; lines already in ClickHouse
  are not copied back.

## Agents & probes

Install the server agent on hosts you want to monitor (see `agent/README.md`),
or run it in `--probe` mode on remote machines to add synthetic-monitoring
locations. Both authenticate with tokens minted in the UI.
