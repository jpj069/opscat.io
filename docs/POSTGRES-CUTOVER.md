# The PostgreSQL cutover runbook

> **EXECUTED 2026-08-18 09:16Z. This is now a record, not a procedure.**
>
> It is kept because the shape of a cutover is worth having written down and
> because the postmortem value is in the steps that were actually run. **Do not
> follow it as written**: the tools it names are gone, deliberately, in the same
> commit that removed SQLite (decision D6).
>
> - `scripts/pg-copy.js` — the SQLite→Postgres copier. Deleted; its job is
>   finished, and keeping it meant keeping `better-sqlite3` as a dependency,
>   which is the thing being removed. It is in git history if a cutover ever
>   needs replaying.
> - `scripts/pg-schema.js` — the SQLite→Postgres DDL translator. Deleted;
>   `server/src/schema.sql` IS PostgreSQL DDL now, applied by `db.init()` at
>   every boot.
> - `OPSCAT_DB` — the engine switch, and step 8's rollback with it. There is no
>   second engine to roll back to. The rollback for a schema change now is a
>   restore from `pg_dump` (`docs/OPERATIONS.md` § Backups).

Phase 7 of `docs/POSTGRES-MIGRATION-PLAN.md`. This was the operational procedure,
written to be **executed**, not read — every step is a command and an expected
answer, and every check says what to do when it fails.

It is deliberately a separate file from the plan. The plan argues; this decides.
During a maintenance window nobody wants to read an argument.

> **The cut is not autonomous.** Steps 0–3 are rehearsal and can be run any time
> against a copy. Steps 4 onward stop production and change where the data lives.
> They run on an explicit human decision, at an agreed time, with somebody
> watching — not on a schedule and not as a side effect of a merge.

---

## 0. Preconditions

Every one of these is a hard gate. A "mostly" here becomes an outage at step 6.

| | Check | How |
|---|---|---|
| 0.1 | The host has capacity for both engines | `free -g` and `df -h /` on `opscat-nbg-01`; see `docs/POSTGRES-MIGRATION-PLAN.md` § 0a for the measured sizing |
| 0.2 | Every Phase 4 file is converted | `cd server && grep -rlE "^// @ts-nocheck" src \| wc -l` → **0**. The pragma is the conversion checklist; a file still carrying one still calls the synchronous driver. Anchored at line start on purpose — an unanchored grep also matches the word in a comment and answers 1 for a codebase that is fully converted, which is a precondition failing in a maintenance window over prose |
| 0.3 | CI is green on the merge commit | `CI` action: server e2e, the prepare sweep, web build, both images |
| 0.4 | The sweep reports no deferrals | `node scripts/pg-sweep.js "$URL" --corpus …` → "all of them PREPARE cleanly", and the DEFERRED list is empty |
| 0.5 | The adapter passes against the real server | `node scripts/pg-adapter-check.js "$URL"` |
| 0.6 | A SQLite backup exists that is **not** on the same host | Copy `/opt/opscat/data/opscat.db` off the box. This is the rollback, and a rollback on the failing host is not one |

---

## 1. Bring PostgreSQL up

The compose service is behind a profile, so it is not started by the ordinary
deploy. That is the safety property — starting it changes nothing about the
running app.

```bash
# on opscat-nbg-01, in /opt/opscat
grep -q '^POSTGRES_PASSWORD=' .env || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d db     # `db` was profiled when this was written; it is part of the stack now
docker compose exec db pg_isready -U opscat -d opscat      # expect: accepting connections
```

`POSTGRES_PASSWORD` has an **empty default on purpose**: compose interpolates the
whole file even for a service it will not start, so `${VAR:?}` here would abort
the production deploy over a container nobody asked for. Empty, postgres itself
refuses to start — the honest failure, and only for whoever opted in.

Do **not** set `OPSCAT_DB=postgres` yet. The URL alone changes nothing; that
separation is the point (see the comment in `docker-compose.yml`).

---

## 2. Build and apply the schema

Never hand-write it. `pg-schema.js` translates `schema.sql`, for the same reason
the classifier preview executes the real function: a second copy drifts, and the
copy that drifts is the one the sweep did **not** run against.

```bash
cd /opt/opscat/server
node scripts/pg-schema.js > /tmp/pg-schema.sql
docker compose exec -T db psql -U opscat -d opscat -v ON_ERROR_STOP=1 -q < /tmp/pg-schema.sql
docker compose exec db psql -U opscat -d opscat -tc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
```

Expect **80**, and the same number on the SQLite side:

```bash
node -e "console.log(require('better-sqlite3')('data/opscat.db',{readonly:true})
  .prepare(\"SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\")
  .get().c)"
```

**Not `sqlite3 data/opscat.db ".tables"`** — the CLI is not installed in the
image and is not guaranteed on the host either, and this is a step that would
fail in the middle of a maintenance window, which is the most expensive moment
to discover a missing binary. `better-sqlite3` is right there, because the app
runs on it. (`.tables | wc -w` was also counting words rather than tables, which
happens to agree only while no table name contains whitespace.)

A mismatch means `schema.sql` and the migrations have drifted apart again —
`e2e-schema.js` guards exactly that, so a mismatch here with a green CI is a bug
in the guard and stops the cutover.

---

## 3. Rehearse the copy — at least three times

**The wall-clock number this produces is the input to the maintenance-window
decision.** An estimate is not.

```bash
# Rehearse against the LIVE database, read-only — that is what found the bug
# below. Concurrent writes make --verify report a handful of count and
# timestamp mismatches; those are the app working, not the copier failing. What
# you are looking for is a FAIL line, which is a row the target refuses.
cd /opt/opscat && PW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker compose run --rm --no-deps -w /app/server \
  -e DBURL="postgres://opscat:${PW}@db:5432/opscat" app \
  sh -c 'node scripts/pg-copy.js "$DBURL" --sqlite /data/opscat.db --truncate --verify'
```

Two things about that invocation, both learned the hard way on the real host:

- **`-w /app/server`.** `node -e` otherwise starts in `/app`, where
  `better-sqlite3` is not resolvable — the module lives in
  `/app/server/node_modules`. A command that fails with `MODULE_NOT_FOUND` in a
  maintenance window costs minutes you did not budget.
- **Run it detached (`nohup … &`) and poll the log.** An SSH call that times out
  does NOT stop the container process: it keeps running, invisibly, and a second
  attempt then writes to the same destination while the first still holds it.
  Two backups into one file produce a file that looks finished and is not.

**Status: DONE. The cut was executed on production on 2026-08-18, 09:13:38Z →
09:16:35Z — 2 min 57 s of downtime.** The numbers below are measured, on
`opscat-nbg-01`, against the real 1.63 GB database:

| | |
|---|---|
| Cold backup (app stopped, `cp` of the quiescent files) | **6 s** for 1.77 GB incl. the WAL |
| The copy itself, `--truncate --verify` | **98.6 s** — 1,630,101 rows into 48 tables |
| Verify | `sequences advanced: 47`, `every table matches, row for row.` |
| Switch + boot | ~12 s |
| Resulting Postgres database | **365 MB** (SQLite was 1.63 GB — mostly free pages and WAL) |
| Host after the cut | 2.2 GB RAM available with both engines up, 21 GB disk free |

**The rehearsal earned its place, and this is the entry to read if you are ever
tempted to skip one.** Run against the live database beforehand, it failed:

    FAIL synthetic_locations: invalid input syntax for type uuid: "1.0"
    FAIL synthetic_results: violates foreign key constraint ..._location_id_fkey

One row — a probe location created years ago by `ensureLocalLocation(1)`, the
literal-`1`-for-the-default-org bug — took **774,724 synthetic results** with it
through the foreign key. Had that been discovered during the window instead of
before it, the site would have been down while somebody worked out whether the
row could be deleted.

It could, and only because the facts said so: the orphan had **zero**
`synthetic_results`, **zero** `check_locations` and **zero**
`org_location_access` rows pointing at it, and the default org already had its
own `kind='local'` location carrying 276,466 results. Re-pointing it would have
given that org TWO local locations and split its history — so the safe action
was a delete, and it was verified to be a delete of something nothing referenced
rather than assumed to be. **Check that before the window, not in it.**

The earlier rehearsal against a synthetic 560-row database proved:

- `pg-schema.js` output applies clean — 80 tables;
- the copier reads the target's own `information_schema`, sorts 91 foreign keys
  topologically, and lands every row: `560 rows into 10 table(s)`,
  `sequences advanced: 47`, `every table matches, row for row.`;
- **and the application then BOOTS on the copied database and serves from it** —
  `/api/health` ok, the public status page 200, and the row counts unchanged
  afterwards (`logs=500 events=40 users=1 orgs=1`). That last step is the one
  worth insisting on: a copy that verifies row-for-row still tells you nothing
  about whether the app can read it back.

**What it did NOT prove, and must not be quoted as:** the wall-clock number.
That run was a synthetic 560-row database; production is ~1.63 GB (plan § 0a).
`T` from a rehearsal against a real copy of production is still the only input
to the maintenance-window decision, and it has not been measured yet.

`--verify` re-reads every row on both sides and compares them column by column.
Counts alone are the weakest possible evidence: a copy that puts columns in the
wrong order matches on count exactly.

Expect, and record each time:

- `N rows into M table(s) in T s` — **T is the number that matters**
- `sequences advanced: K` — non-zero. An identity column is not advanced by an
  explicitly supplied id, and the copier supplies every id; without this the
  first ordinary insert after the cut collides on the primary key
- `every table matches, row for row.`

If a row fails on `invalid input syntax for type uuid`, that is the copier
working: a value in an identity column is not a UUID, and it must be fixed in
SQLite **before** the cut, not cast away.

Rehearse until three consecutive runs are clean and T is stable. Then decide the
window: T plus the deploy, plus a margin for step 7.

---

## 4. Stop writing

From here the site is down. Note the time.

```bash
docker compose stop app          # Caddy stays up and serves its error page
docker compose ps                # app: exited; db, caddy: running
```

Stopping the app rather than putting it in a read-only mode is deliberate: there
is no read-only mode, and inventing one for a single event is more risk than the
downtime it saves.

---

## 5. Copy for real

```bash
cd /opt/opscat/server
node scripts/pg-copy.js "$DATABASE_URL" --sqlite /opt/opscat/data/opscat.db --truncate --verify
```

The copier refuses a non-empty target without `--truncate`, and deliberately does
not upsert: topping up a half-copied database is the one state where counts match
and contents do not.

**If `--verify` reports any mismatch, stop.** Do not proceed and investigate
later — go to step 8 (rollback) and investigate with the site up.

---

## 6. Switch the engine

```bash
cd /opt/opscat
echo "OPSCAT_DB=postgres" >> .env
grep -q '^DATABASE_URL=' .env || echo "DATABASE_URL=postgres://opscat:<pw>@db:5432/opscat" >> .env
docker compose up -d app
docker compose logs -f app | head -40
```

Expect the boot line and no `unknown OPSCAT_DB backend` (a typo there is refused
rather than silently falling back to SQLite — which would look like a successful
cutover onto an empty database).

---

## 7. Verify, in this order

The order matters: each step depends on the previous one being true.

```bash
# 7.1 the process is alive and serving the commit that was deployed
curl -s https://opscat.io/api/version        # commit matches, startedAt is after the cut

# 7.2 it is talking to Postgres, not SQLite
docker compose exec db psql -U opscat -d opscat -tc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='opscat'"   # > 1

# 7.3 reads work and are scoped — log in and load a page with tenant data
#     (a missed await returns 200 with ANOTHER TENANT'S rows; that is the failure
#      mode this whole port is about, and it is invisible in a log)

# 7.4 writes work AND the sequences are right — this is the step that catches
#     the classic post-cutover failure
#     create anything with an integer id (an event, a case, a check) through the
#     UI or the API and confirm it succeeds. A `duplicate key value violates
#     unique constraint` here means step 5's setval pass did not run.

# 7.5 ingest works
curl -sS -X POST https://opscat.io/v1/logs -H "Authorization: Bearer ock_…" \
  -H 'content-type: application/json' -d '{"lines":[{"device":"cutover-probe","line":"hello"}]}'
```

Then watch for one full alert-rule cooldown period before declaring it done.

---

## 8. Rollback

**Valid only until the first write lands in Postgres**, so this decision is made
minutes after the cut, not days. After that, rolling back means losing the writes
made since — which is a different, much worse decision, taken deliberately.

```bash
cd /opt/opscat
docker compose stop app
sed -i '/^OPSCAT_DB=/d' .env          # back to the sqlite default
cp /path/to/backup/opscat.db data/opscat.db
docker compose up -d app
curl -s https://opscat.io/api/health
```

The SQLite file was never written to during the cut — the app was stopped — so
the backup and the live file should be identical. Restore anyway: the cost is
seconds and the alternative is trusting that nothing touched it.

---

## 9. After

- Leave the SQLite file in place, untouched, for at least a week. It costs disk
  and it is the only rollback that exists.
- Update the docs that state SQLite as a fact — `docs/OPERATIONS.md`,
  `scripts/publish/OPERATIONS.community.md`, `docs/ARCHITECTURE.md` (§ storage,
  and the note that status assets are BLOBs "because the SQLite file is the only
  volume the Docker deployment persists" — no longer true), `README.md`.
- Phase 8 (soak and tune) starts here: ingest latency, indexes for the six
  ex-`WITHOUT ROWID` tables, and autovacuum on the per-request `touchSession` /
  `touchUser` / `touchKey` / `touchToken` rows. Those were free under
  better-sqlite3 and are now the busiest write path in the system, with dead
  tuples to match.
- The community edition keeps SQLite. Nothing here applies to it, and
  `OPSCAT_DB` defaults to `sqlite` precisely so a self-hoster inherits none of
  this.
