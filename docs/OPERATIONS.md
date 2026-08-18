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

All state lives in PostgreSQL, in the `opscat_pgdata` volume. There is one
engine and no switch: `DATABASE_URL` is required and the app refuses to start
without it.

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

## Agents & probes

Install the server agent on hosts you want to monitor (see `agent/README.md`),
or run it in `--probe` mode on remote machines to add synthetic-monitoring
locations. Both authenticate with tokens minted in the UI.
