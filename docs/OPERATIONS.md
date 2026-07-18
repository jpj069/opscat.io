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
# optional e-mail (alerts + magic-link login) via Resend:
RESEND_API_KEY=
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

All state lives in one SQLite database (WAL mode) inside the `opscat_data`
volume. Back it up with:

```bash
docker compose exec app sh -c \
  "sqlite3 /data/opscat.db '.backup /data/backup.db'" \
  && docker cp "$(docker compose ps -q app)":/data/backup.db ./opscat-backup.db
```

(or snapshot the volume). Restore = stop the stack, replace `/data/opscat.db`,
start again.

## Upgrades

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically and are backward-compatible; still, take
a backup first.

## Health & monitoring the monitor

- `GET /api/health` — liveness (also used by the container HEALTHCHECK).
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
