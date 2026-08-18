# OpsCat benchmarks

Measured 2026-08-18 against commit `1a61982` (the PostgreSQL-only build, the day
SQLite was removed). The source under test did not change during the run — the
commit landed mid-session on work that was already on disk.

Every number below was produced in **this repository's sandbox**, never against
production, and every one carries the command that produces it again.

Read [What these numbers do NOT say](#what-these-numbers-do-not-say) before
quoting anything. It is not boilerplate — three of the headline numbers are only
true under a condition that is easy to drop in a sentence.

---

## 0. The hardware, stated first

The single most important caveat: **this is not the production VM.**

| | Benchmark sandbox | Production (`opscat-nbg-01`) |
|---|---|---|
| CPU | 4 vCPU, Intel Xeon @ 2.10 GHz | **2 vCPU** |
| RAM | 16,075 MB (15,049 MB available) | **3,800 MB** |
| Swap | none | none until 2026-08-18 |
| Disk | 252 GB virtio, 28 GB free | 38 GB |
| Kernel | Linux 6.18.5 x86_64 | Ubuntu 24.04 |
| Runtime | Node 22.22.2, PostgreSQL 16.13 | Node 22 (Alpine), PostgreSQL 16 |
| Stack | app + Postgres only, no Docker | app, Postgres, Caddy, unbound, livekit, all in Docker |

```
nproc          # 4
free -m        # total 16075, available 15049, Swap 0
```

The sandbox has **twice the cores and four times the memory** of the production
VM, and it is not running Caddy, unbound or livekit alongside. So a sentence of
the form *"OpsCat ingests N lines/s and the whole stack idles at 340 MB on a tiny
VM"* is **two measurements from two different machines** and must not be written.

To take that caveat out of the reader's hands rather than the writer's, every
ingest number is reported **twice**: once on all 4 cores, and once with the app
and Postgres pinned to 2 cores (`taskset -c 0,1`) with the load generator kept on
the other two. The 2-core column is the one to quote next to anything that
mentions the production VM's size — with the remaining caveat that it still has
16 GB of RAM behind it, so it is an **upper bound** for a 3.8 GB machine, not a
simulation of one.

PostgreSQL ran at its packaged defaults, which is what a self-hoster gets:

```
shared_buffers 128MB · work_mem 4MB · max_connections 100
fsync on · synchronous_commit on · wal_level replica
```

### Reproducing the whole setup

```sh
# 1. cluster (skip if already running)
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/opscat-ci \
  -l /tmp/pg.log -o '-p 5433 -k /tmp' start"
psql "postgres://postgres@localhost:5433/postgres?host=/tmp" -c "CREATE DATABASE opscat_bench;"

# 2. the app, against that database
cd server
DATABASE_URL='postgres://postgres@localhost:5433/opscat_bench?host=/tmp' \
OPSCAT_SECRET=bench-secret PORT=3200 OPSCAT_EDITION=community \
OPSCAT_ADMIN_EMAIL=admin@bench.test OPSCAT_ADMIN_PASSWORD=bench-admin-password-1 \
  node src/index.js
```

`RESEND_API_KEY` and `SMTP_HOST` must be **unset**. With a Resend key in the
environment the seeded "Critical → E-Mail" alert rule fires on every critical
event the load test creates: the first run of this benchmark made live outbound
API calls to Resend, which both distorts the measurement and mails real people.

Ingest keys were minted directly into `api_keys` (scope `ingest`), the way the
harnesses seed fixtures. Eight of them — see §1.

---

## 1. Ingest throughput

`scripts/loadtest-ingest.js` posts batches of log lines to `POST /v1/ingest/logs`
and reports throughput and latency percentiles.

**A single API key is capped at 600 requests/minute server-side** (`ingestLimiter`
in `server/src/security.js`, burst 200). At batch 500 that is a hard ceiling of
~5,000 lines/s per key, and a run that hits it is measuring the rate limiter, not
the product. Demonstrated rather than assumed:

```sh
node scripts/loadtest-ingest.js --url http://127.0.0.1:3200 --key $ONE_KEY \
  --duration 20 --concurrency 4 --batch 500
# status codes  200×396  429×79      ← 17% of requests refused by the limiter
# lines accepted 198000 (9783/s)
```

Every number below therefore uses **eight keys round-robined** via
`--key a,b,c,…`, and every reported run returned `200` for every request unless
stated otherwise.

### 1.1 Four cores (sandbox as-is)

Batch 500, 8 keys, 30 s per run, against a database already holding the
596,500-row corpus from §2.

| In-flight requests | Lines/s sustained | p50 | p95 | p99 | max | Non-200 |
|---|---|---|---|---|---|---|
| 1 | 8,198 | 59 ms | 80 ms | 103 ms | 142 ms | none |
| 2 | 14,496 | 66 ms | 90 ms | 113 ms | 150 ms | none |
| **4** | **17,242** | 111 ms | 160 ms | 190 ms | 223 ms | none |
| 8 | 16,274 | 231 ms | 345 ms | 408 ms | 467 ms | none |
| 16 | 15,545 | 497 ms | 654 ms | 701 ms | 761 ms | none |
| 32 | 16,237 | 974 ms | 1,156 ms | 1,281 ms | 1,399 ms | none |

```sh
node scripts/loadtest-ingest.js --url http://127.0.0.1:3200 --key $EIGHT_KEYS \
  --duration 30 --concurrency 4 --batch 500
```

**Saturation is at 4 in-flight requests.** Past that, throughput is flat and
latency grows in proportion to concurrency — the queue lengthens, the server does
not go faster. Quoting concurrency 32 would give a bigger-sounding p99 for no
extra throughput; quoting 4 is the honest operating point.

Run-to-run spread at concurrency 4, three consecutive runs: **16,792 / 16,484 /
16,640 lines/s** (p50 115 / 118 / 115 ms). About ±1%.

### 1.2 Two cores (app + Postgres pinned, closer to production)

```sh
taskset -pc 0,1 $POSTGRES_POSTMASTER_PID      # new backends inherit it
taskset -c 0,1 node src/index.js              # the app
taskset -c 2,3 node scripts/loadtest-ingest.js --url http://127.0.0.1:3200 \
  --key $EIGHT_KEYS --duration 30 --concurrency 4 --batch 500
```

| In-flight requests | Lines/s sustained | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 8,389 | 57 ms | 75 ms | 96 ms |
| 2 | 9,859 | 97 ms | 128 ms | 171 ms |
| **4** | **10,555** | 186 ms | 238 ms | 275 ms |
| 8 | 10,381 | 382 ms | 459 ms | 506 ms |

Halving the cores costs about **39%** of peak throughput, not 50% — a single
request is not itself parallel (concurrency 1 is 8,198 vs 8,389 lines/s, i.e.
identical within noise), so the second pair of cores only buys overlap.

### 1.3 What the limiting factor is

**CPU, and mostly Postgres's share of it.** Three measurements say so:

- Sampled during a concurrency-4 run on 4 cores: app **88%** of one core,
  Postgres **172%**, combined 260% of the 400% available, whole machine 70% busy
  (the rest is the load generator, which lives on the same box).
- Pinned to 2 cores, same run: app **57%**, Postgres **114%** — 171% of the 200%
  available, i.e. **86% of the two cores**, with throughput flat. That is a
  CPU-bound system.
- Not the load generator: two *separate* generator processes at concurrency 4
  each (8 in flight, 4 keys apiece) delivered **15,125 lines/s combined**, the
  same as one process at concurrency 8. The client is not the ceiling. (One
  batch in that run returned `500` — the two processes' workers overlap on the
  same device names, which is §4.1 in miniature.)
- Not WAL fsync: with `synchronous_commit = off` the same run reached **17,865
  lines/s** against ~16,600 with it on — **+7%**. Durability is not what this
  costs.

```sh
node sample.js 38 c4      # scratchpad sampler: /proc CPU deltas + RSS/PSS
```

### 1.4 Bulk load

Building the 596,500-line corpus through the same public endpoint took **77 s**
end to end at concurrency 8 — but that figure includes five of eight workers
stopping early on the failure described in §4, so it is a floor, not a rate.
The clean rate is the table in §1.1.

The `accepted` count the endpoint returns is truthful: a 15 s run reporting
`252000 accepted` left exactly **252,000** new rows in `logs`.

---

## 2. Query latency on a realistic corpus

### The corpus

596,500 log lines spread over **7 days** across **24 devices**, ingested through
the real `POST /v1/ingest/logs` path — so the events, the per-minute rollups and
the cases are what the product would actually have written, not hand-inserted
rows. Line mix ~8% classifier-matching, ~12% warnings, ~80% noise, with a diurnal
shape rather than a flat one.

| Table | Rows | Heap | Total incl. indexes |
|---|---|---|---|
| `logs` | 596,500 | 85 MB | **152 MB** |
| `event_buckets` | 106,103 | 5.4 MB | 10 MB |
| `events` | 145 | 2.2 MB | 7.2 MB |
| `cases` | 73 | 56 kB | 144 kB |
| **database total** | | | **181 MB** |

That is **~267 bytes on disk per log line**, indexes included. Production's own
figure — 1.6 M rows in 371 MB — works out at ~232 bytes/row, so the corpus is
representative in shape and slightly more expensive per row, not less.

### 2.1 SQL latency (the statements the product runs)

One connection, no concurrency, 3 warm-up passes discarded, then 25 timed passes;
p50 and p95 over those 25. Measured against the `pg` pool directly, so this is
database time only — §2.2 has the same work end to end over HTTP.

**Four cores:**

| Query | p50 | p95 | Rows |
|---|---|---|---|
| Log tail — Logs page default, 2 h window, LIMIT 300 | **1.3 ms** | 3.0 ms | 300 |
| Case list — `/api/cases`, newest 200 | **0.4 ms** | 0.7 ms | 73 |
| Event sparkline rollup — 30 one-minute buckets | **0.8 ms** | 1.0 ms | 30 |
| Event list — `/api/events` active, severity DESC | **0.9 ms** | 1.6 ms | 145 |
| Dashboard — `COUNT(*)` of logs in the last 24 h | **7.3 ms** | 7.8 ms | 1 |
| Log search — substring, 24 h window, LIMIT 300 | **37.9 ms** | 50.2 ms | 300 |
| Infrastructure roll-call — last line seen per device | **62.7 ms** | 68.6 ms | 24 |
| Top devices by volume, 7 d | **63.7 ms** | 69.5 ms | 10 |
| Log search — substring, **7 d** window, LIMIT 300 | **213.7 ms** | 243.2 ms | 300 |
| Log search — rare term, 7 d (finds little, scans all) | **212.0 ms** | 256.8 ms | 300 |
| Throughput chart — daily buckets over 7 d (shipped) | **209.5 ms** | 220.7 ms | 8 |
| Throughput chart — hourly buckets over 7 d (not shipped) | **216.5 ms** | 228.5 ms | 168 |

**Two cores** (Postgres pinned to `0,1`), same corpus, same session:

| Query | p50 (2 vCPU) | p50 (4 vCPU) |
|---|---|---|
| Log tail, 2 h | 0.9 ms | 1.3 ms |
| Log search, 24 h | 56.3 ms | 37.9 ms |
| Log search, 7 d | **307.9 ms** | 213.7 ms |
| Throughput chart, daily over 7 d | **204.8 ms** | 209.5 ms |
| Top devices, 7 d | 92.2 ms | 63.7 ms |
| Roll-call, last line per device | 92.4 ms | 62.7 ms |
| Event list / case list | 1.0 / 0.4 ms | 0.9 / 0.4 ms |

```sh
node queries.js 25    # scratchpad; the SQL is copied verbatim from
                      # server/src/routes/ops.js
```

### 2.2 End to end over HTTP

The real endpoints, authenticated with an `api`-scoped key, one request at a time,
paced at 300 ms to stay under the 300/min API-token limit. Two warm-up passes
discarded, 12 timed. This is SQL + Express + JSON serialisation — what a browser
waits for, minus the network.

| Endpoint | p50 (4 vCPU) | p95 | p50 (2 vCPU) | Payload |
|---|---|---|---|---|
| `GET /api/logs?hours=2&limit=300` | **9.4 ms** | 17.1 ms | 8.9 ms | 35 KB |
| `GET /api/events` | **9.6 ms** | 17.0 ms | 11.3 ms | 45 KB |
| `GET /api/dashboard` | **16.5 ms** | 33.5 ms | 15.9 ms | <1 KB |
| `GET /api/cases` | **17.2 ms** | 38.5 ms | 15.9 ms | 20 KB |
| `GET /api/logs?q=timeout&hours=24` | **51.5 ms** | 63.9 ms | 61.7 ms | 30 KB |
| `GET /api/assets` | **72.2 ms** | 78.4 ms | 89.5 ms | 3 KB |
| `GET /api/logs?q=timeout&hours=168` | **223.2 ms** | 296.8 ms | 311.9 ms | 30 KB |
| `GET /api/analytics?range=7d` | **227.4 ms** | 250.1 ms | 226.0 ms | 1 KB |

```sh
node http-queries.js $API_KEY http://127.0.0.1:3200 12
```

### 2.3 Why the fast ones are fast and the slow ones are slow

Not a guess — `EXPLAIN (ANALYZE, BUFFERS)`:

- **Log tail, 2 h: 0.25 ms, 17 buffers.** `Index Scan Backward using
  idx_logs_org_ts`, stopping at the LIMIT. Its cost is set by the page size, not
  by the table size — this query does not get slower as the corpus grows.
- **Log search over 7 d: `Parallel Seq Scan` over all 596,500 rows.** `LIKE
  '%…%'` cannot use a B-tree, so every retained line is read and lowercased.
  ~200 ms *is* the cost of scanning the corpus; it scales linearly with retention
  and volume, and it is the same whether the term is common or rare (213.7 ms vs
  212.0 ms — identical, because both scan everything).
- **Throughput chart: `Seq Scan` + aggregate over all 596,500 rows.** Also
  linear. At the packaged `work_mem = 4MB` it sorts to disk (external merge,
  15 MB spilled); with `work_mem = 64MB` it switches to a `HashAggregate` and the
  p50 goes **196.7 ms → 162.4 ms**, about **17%**. Worth knowing, not worth a
  headline: the query is dominated by the scan, not the sort.

---

## 3. Resource footprint

`app_rss` is the Node process's RSS. Postgres is reported as **PSS**
(proportional set size) because a naive sum of RSS over its 16 backends counts
the 128 MB of `shared_buffers` sixteen times — that sum reaches 1.1–1.8 GB under
load and means nothing. PSS divides shared pages among their sharers.

| State | App RSS | Postgres PSS | Total | App CPU | Postgres CPU |
|---|---|---|---|---|---|
| Idle, fresh boot, empty database | 111 MB | 172 MB | **283 MB** | ~0% | ~0% |
| Idle, 596 k-row corpus loaded | 157 MB | 176 MB | **333 MB** | ~0% | ~0% |
| Under ingest load, c=4, 4 vCPU | 158 MB | 190 MB | **347 MB** | 88% | 172% |
| Under ingest load, c=4, 2 vCPU pinned | 223 MB | 192 MB | **415 MB** | 57% | 114% |

```sh
node sample.js 20 idle     # 1 Hz; CPU from /proc/<pid>/stat deltas,
node sample.js 38 c4       # memory from VmRSS and smaps_rollup Pss
```

Two things worth stating plainly:

- **Node's heap does not shrink back.** After one sustained ingest run the idle
  app sits at 157 MB rather than the 111 MB it booted at. "Idles at 111 MB" is
  true only of a process that has not done any work yet.
- **This is two processes, not the stack.** Production's ~340 MB figure covers
  app + Postgres + Caddy + unbound + livekit in Docker. These 283–415 MB cover
  app + Postgres on bare metal. They are not comparable line-for-line.

---

## 4. Failures found while measuring

Reported here because a benchmark that only prints its best runs is advertising.

### 4.1 Concurrent ingest deadlocks when two batches share event keys

**This is the finding that most constrains §1, and it is a live defect, not a
tuning issue.**

`pipeline.ingestLogs` upserts one row into `events` per classified line, **in
arrival order**, inside one transaction per batch. Two batches whose lines happen
to produce the same two dedupe keys in different orders take the row locks in
different orders, and PostgreSQL kills one:

```
ERROR:  deadlock detected
DETAIL: Process 23751 waits for ShareLock on transaction 77341; blocked by 23754.
        Process 23754 waits for ShareLock on transaction 77350; blocked by 27086.
        …
        Process 23751: INSERT INTO events (…) ON CONFLICT (org_id, dedupe_key) …
```

The whole batch rolls back and the client gets a `500`. Measured, 30 s runs,
batch 500, 8 keys, 4 cores:

| Workload | In flight | Lines/s | Batches refused `500` |
|---|---|---|---|
| Each sender writes about **its own** device (what `loadtest-ingest.js` does) | 4 | **16,700** | 0 |
| 24 devices shared across senders | 1 | 8,516 | 0 |
| 24 devices shared across senders | 2 | **926** | 33% |
| 24 devices shared across senders | 4 | **158** | 77% |
| 24 devices shared across senders | 8 | **28** | 95% |
| **One** shared device, 5 event types | 4 | **153** | 79% |
| **One** shared device, **1** event type | 4 | 10,984 | 0 |
| 24 devices shared, batch **50** instead of 500 | 2 | 6,560 | 0 (but 28 × `429`) |

Three things follow, and all three are measurements from that table:

1. **The shipped load test cannot see this bug.** It gives every worker its own
   `loadtest-<worker>` device, so concurrent batches never share a dedupe key.
   That is why §1 is clean — and it means §1's numbers describe *disjoint*
   senders, which must be said whenever they are quoted.
2. **The trigger is ≥2 shared event keys, not many devices.** One device
   producing two kinds of event is enough (79% refused); one device producing one
   kind is fine (zero). A log forwarder shipping a whole fleet over several
   connections, or two app instances reporting the same `device`, hits this.
3. **Batch size is the exposure.** The same contended workload at batch 50
   deadlocked zero times, because a shorter transaction holds fewer locks for
   less time. It is not a free fix: ten times the requests for the same lines
   walks into the per-key rate limit (28 requests were refused `429` in that
   run).

The `event_buckets` half of this exact bug was already found and fixed — the
per-minute rollup is folded in JS to one row per key precisely so its update
order stops being data-dependent (see the comment above `writeBuckets` in
`server/src/engine/pipeline.js`). The `events` upsert loop next to it was not
given the same treatment. The shape of the fix is the same: fold or sort
`matches` by dedupe key before the upsert loop, so every transaction takes the
locks in one order. **Not attempted here — this document measures, it does not
change the product.**

Reproduce with a one-line edit to a copy of the load test:

```sh
sed 's#device: `loadtest-${worker}`#device: `loadtest-${(seq + i) % 24}`#' \
  scripts/loadtest-ingest.js > /tmp/loadtest-shared.js
node /tmp/loadtest-shared.js --url http://127.0.0.1:3200 --key $EIGHT_KEYS \
  --duration 30 --concurrency 4 --batch 500
```

### 4.2 The app process disappeared once, mid-run

During the first concurrency-8 run the Node process vanished with no message on
stderr, no `unhandledRejection` line, and no OOM in `dmesg`. The two runs queued
behind it therefore reported 100% network errors and 0 lines/s — those two runs
are discarded, not reported as results.

It did not recur in roughly fifteen subsequent runs, including the same
concurrency-8 workload, once the app was put under a supervisor that records exit
status. **Cause unknown.** It is recorded here because "we saw it once and cannot
explain it" is the honest state, and because the numbers in §1 were re-measured
from scratch afterwards rather than salvaged from around it.

### 4.3 A Resend key in the environment mails real people

The first attempt ran with `RESEND_API_KEY` inherited from the shell. The seeded
`Critical → E-Mail` alert rule fired on every critical event the load test
created, producing a live outbound HTTPS call per event. Everything in §1 and §3
was re-measured with the variable unset.

---

## 5. Claim sheet

Each row is a sentence that is true **with the condition next to it attached**.
Detaching the condition makes it false.

| Claim | Only true when | Source |
|---|---|---|
| Sustains **~10,500 log lines/s** on 2 vCPU | 4 concurrent batches of 500; senders write about disjoint devices; Postgres at packaged defaults; 596 k rows already stored | §1.2 |
| Sustains **~17,000 log lines/s** on 4 vCPU | same, on the 4-core sandbox — **not** on the production VM | §1.1 |
| Ingest p50 **111 ms**, p99 **190 ms** for a 500-line batch | 4 cores, 4 in flight, the operating point above | §1.1 |
| Log tail in **about a millisecond** (0.9-1.3 ms p50 across runs) | the Logs page's default 2 h window, 300 lines, index scan; independent of corpus size | §2.1 |
| **Under 20 ms** for the event list, case list and dashboard end to end | over HTTP, warm, single request at a time | §2.2 |
| Full-text log search across **7 days / 596 k lines in ~215 ms** | 4 cores; substring scan, no index possible; ~310 ms on 2 cores; grows linearly with retention | §2.1, §2.3 |
| **~267 bytes per log line** on disk, indexes included | this corpus's line-length mix | §2 |
| App + Postgres idle at **283 MB** | fresh boot, empty database, bare metal, no Caddy/unbound/livekit | §3 |
| App + Postgres at **347 MB** under full ingest load | 4 cores, c=4, Postgres counted as PSS | §3 |
| **CPU-bound, not disk-bound** | `synchronous_commit=off` buys only 7% | §1.3 |

---

## What these numbers do NOT say

- **They do not describe production.** They were produced on a 4 vCPU / 16 GB
  sandbox. The 2-core column exists to narrow that gap, and it still has 16 GB of
  page cache behind it, no Docker layer, and no Caddy, unbound or livekit
  competing for the same two cores. Treat the 2-core column as a **ceiling** for
  the production VM, and never put a throughput number in the same sentence as
  production's memory figure.
- **They do not say OpsCat ingests 17,000 lines/s from a real fleet.** They say
  it does so from senders whose batches do not share event dedupe keys. Under a
  contended workload — one log forwarder shipping a fleet over several
  connections — measured throughput fell to **158 lines/s with 77% of batches
  rejected** (§4.1). Until that is fixed, any ingest claim needs the disjoint-
  sender condition or it is false for a common deployment.
- **They do not say the product is fast at scale.** The corpus is 596,500 rows
  over 7 days for one organisation. The three ~200 ms queries are full scans:
  they scale linearly, so ten times the corpus is roughly ten times the number,
  and nothing here measures ten times the corpus. Do not extrapolate to
  "millions of lines" — measure it.
- **They do not measure the network.** Every request was over loopback. Add real
  TLS, Caddy, and internet RTT for anything a customer's browser or agent will
  experience.
- **They do not measure a multi-tenant instance.** One organisation, one corpus,
  no other traffic. Nothing here says what a hundred orgs on one box do to each
  other.
- **They do not measure reads under write load.** §2 was measured on a quiet
  system and §1 on an unqueried one. The interesting number for a NOC — "is the
  Logs page still fast while 15,000 lines/s are arriving?" — was not taken.
- **They do not measure retention, backup or restore**, the synthetic-check
  engine, SNMP polling, the alert delivery path, or the status page.
- **They are single-instance.** There is no clustering or read-replica story
  behind any of these numbers.
