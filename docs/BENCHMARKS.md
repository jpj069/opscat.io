# OpsCat benchmarks

Measured 2026-08-18 against commit `1a61982` (the PostgreSQL-only build, the day
SQLite was removed). The source under test did not change during the run — the
commit landed mid-session on work that was already on disk.

§5 (PostgreSQL vs ClickHouse) was measured later the same day against `aa0f0db`,
on the same sandbox, with the same corpus generator.

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

### 4.4 The agent's probe cycle had no re-entrancy guard — FIXED in agent v0.4.0

> **Status: fixed.** `probeCycle()` opens with `if (probeRunning) return;` since
> v0.4.0, like the three server engines it should always have matched. The
> measurement below is what motivated the change and is kept for that reason —
> read it in the past tense.

`engine/synthetics.js`, `engine/vendors.js` and `engine/reconcile.js` all open
with `if (running) return;`. `probeCycle()` in `agent/opscat-agent.js` did not —
it was called from a bare `setInterval(run, 30000)`.

Measured rather than reasoned about: 200 checks against a target answering in
150 ms is a 45 s sweep, i.e. longer than the 30 s poll. The stub target saw
**two requests in flight from a single agent process** and served 730 requests
where 600 were expected — a sequential prober cannot do that. The overlapping
cycle re-runs checks that are due again, reports them twice, and adds load to a
node that is already behind, which is the wrong direction for a box under
pressure.

It does not corrupt anything (the server records both results and the dedupe
still folds the events), but it makes an overloaded sensor spend its remaining
capacity on duplicate work. Every capacity number in §6 was therefore measured
with a sweep that fits inside the poll interval, and the 45 s run is reported
here rather than in the results.

### 4.5 A remote probe's interval was quantised to the 30 s poll — FIXED in agent v0.4.0

> **Status: fixed.** v0.4.0 separates the two clocks that were one: the work
> list is still refreshed every 30 s (`PROBE_LIST_MS`), but the due-check tick
> runs every 5 s (`PROBE_TICK_MS`) against the cached list — the same 5 s grid
> `engine/synthetics.js` uses for the local probe. A 60 s check now fires within
> 5 s of its deadline instead of slipping to 90 s, so **detection on a remote
> sensor is back to the advertised ~2 minutes**, not 2-3. The measurement below
> is what motivated the change; read it in the past tense.

The agent polled every 30 s and ran whatever was due; `due` is
`now - last >= intervalS * 1000`. A 60 s interval therefore only survives if the
poll lands *after* the 60 s boundary, and `setInterval` firing two milliseconds
early is enough to miss it:

```
# debug agent 0 cycle 0: offsets 1@0 2@5 3@8 4@13 …
# debug agent 0 cycle 1: offsets 1@90015 2@90019 3@90023 4@90025 …
```

That was a 60 s check executing every **90 s**, reproducibly, on an idle node with
eight checks. The same rounding turned a 45 s interval into 60 s and a 20 s
interval into 30 s.

It mattered beyond tidiness because detection time is two consecutive failures:
on a remote sensor the advertised "~2 minutes at defaults" was really 2-3
minutes. The local cloud probe was never affected — `engine/synthetics.js` has
always ticked every 5 s, which is where the fix's 5 s grid comes from.

**The lesson worth keeping is why one constant did two jobs.** "How often do I
ask the server what to run" and "how often do I check whether something is due"
are different questions with different right answers, and they were the same
`setInterval`. Lowering the single constant to 5 s would have multiplied the
control-plane request rate by six for no benefit; raising it would have made the
quantisation worse. Two constants was the fix, not a smaller one.

---

## 5. PostgreSQL vs ClickHouse, head to head

This section exists because the question *"should the log-search path move to
ClickHouse?"* had been answered twice with spot measurements taken on the
production host during an experiment, and never with a controlled comparison.
It is a **database** comparison, not a product comparison: the app is not in the
path on either side.

### 5.1 Method

Both engines are fed the **same file**. `gen.js` is seeded (xorshift32, seed
`20260818`), so a rerun produces a byte-identical corpus, and the TSV is loaded
into Postgres with `COPY` and into ClickHouse with `INSERT … FORMAT
TabSeparated`. Nothing is generated twice, so nothing can differ by generator.

| | |
|---|---|
| Corpus | 596,491 lines · 7 days · 24 devices · same 8/12/80 severity mix and diurnal shape as §2 |
| Scale-up corpus | 5,964,910 lines — same 7 days, 10× the density |
| PostgreSQL | 16.13, packaged defaults, `logs` + both shipped indexes |
| ClickHouse | 26.8.1.1663 (official build), `MergeTree`, `ORDER BY (org_id, ts)`, `PARTITION BY` day, `device`/`source` as `LowCardinality` |
| Transport | both over TCP from one Node process — `pg` for Postgres, HTTP for ClickHouse |
| Timing | 3 warm-up passes discarded, then 25 timed (15 on the 10× corpus); p50 and p95 over those |
| Cores | both engines pinned to `0,1`, load generator on `2,3`; ClickHouse additionally `max_threads=2`, which is what it would auto-detect on a 2-vCPU box |

The queries are the ones §2.1 measured, copied from `server/src/routes/ops.js`,
translated to ClickHouse syntax but not to ClickHouse *idiom* — same windows,
same `LIKE`, same `ORDER BY`, same limits. Where the translation would have
changed what the product asks for, it was left alone.

**The per-query floor is not the same on both.** An empty `SELECT 1` costs
**0.19 ms** on Postgres and **1.39 ms** over ClickHouse's HTTP interface. Roughly
1.2 ms of every ClickHouse number below is transport, which matters only for the
queries that finish in single-digit milliseconds — and those are exactly the ones
Postgres wins.

### 5.2 Bulk load

| | PostgreSQL | ClickHouse |
|---|---|---|
| 596 k rows, data only | 2.76 s — **216 k rows/s** | 2.97 s — 201 k rows/s |
| + indexes / merge | 3.07 s | 0.29 s |
| **596 k total** | 5.83 s — **102 k rows/s** | 3.27 s — **183 k rows/s** |
| **5.96 M total** | 62.8 s — **95 k rows/s** | 11.5 s — **518 k rows/s** |

At the small corpus the two are within a factor of two. At ten times the volume
they are not: Postgres has to build two B-trees over 6 M rows, ClickHouse sorts
into daily parts and merges. **This is bulk load, not the product's ingest
path** — OpsCat ingests through `POST /v1/ingest/logs`, which does dedupe,
severity ratcheting and rollups per batch, and tops out around 10,500 lines/s
(§1.2). Neither number above is reachable through the API.

### 5.3 On-disk size

| | PostgreSQL | ClickHouse | |
|---|---|---|---|
| 596 k rows | 172 MB (95 heap + 76 index) | **12.68 MiB** | **13.6× smaller** |
| 5.96 M rows | 1,713 MB (951 + 762) | **123.07 MiB** | **13.9× smaller** |
| per row | ~301 bytes | **22 bytes** | |
| compression ratio | — | 4.5× on the columns, before the index saving | |

Two thirds of the difference is compression of `line`; the rest is that Postgres
carries 762 MB of B-tree for the same 6 M rows and ClickHouse carries a sparse
primary index measured in kilobytes. This is the single most one-sided result in
the comparison and it is the one that would actually change what retention we can
offer on a small disk.

### 5.4 Query latency — the corpus we have today

596 k rows, both engines on two cores. p50, with p95 in brackets.

| Query | PostgreSQL | ClickHouse | |
|---|---|---|---|
| Log tail — 2 h window, LIMIT 300 | **1.2 ms** (4.5) | 6.6 ms (9.1) | **PG 5.5×** |
| Recent logs for ONE device, LIMIT 20 | **0.3 ms** (0.4) | 11.8 ms (24.1) | **PG 39×** |
| Dashboard — `COUNT(*)`, last 24 h | 9.1 ms (10.6) | **3.6 ms** (4.3) | CH 2.6× |
| Log search — substring, 24 h | 76.1 ms (105) | **7.1 ms** (9.6) | CH 10.7× |
| Log search — substring, 7 d | 435.3 ms (453) | **17.2 ms** (19.8) | CH 25.2× |
| Log search — rare term, 7 d | 414.3 ms (438) | **25.4 ms** (28.1) | CH 16.3× |
| Roll-call — last line per device | 96.8 ms (101) | **19.6 ms** (21.9) | CH 4.9× |
| Top devices by volume, 7 d | 95.9 ms (100) | **20.6 ms** (35.6) | CH 4.7× |
| Throughput chart — daily, 7 d | 260.6 ms (275) | **25.8 ms** (31.6) | CH 10.1× |
| Throughput chart — hourly, 7 d | 159.2 ms (171) | **23.1 ms** (30.0) | CH 6.9× |

**ClickHouse is faster on eight of ten, and slower on the two that run most
often** — the Logs page opens with the tail, the event slide-over with the
per-device tail. Read that as arithmetic and not yet as a conclusion: §5.7 counts
the same table against a latency budget instead, and both of those queries turn
out to be **inside** the budget on both engines, which makes the 5× and the 39×
differences nobody can perceive. What follows is still worth understanding,
because it is structural rather than a misconfiguration.

That is not a tuning gap. `EXPLAIN indexes=1, projections=1` shows ClickHouse
reading **14 granules out of 70** for the 20-row device lookup — it is finding the
right place efficiently and then reading 8,192 rows per granule because
`index_granularity = 8192` is what a MergeTree does. **A sparse index cannot do a
20-row point lookup**, and a 300-line tail is a point lookup.

The obvious counter-move was tried and **did not work**, which is worth recording
rather than omitting: giving ClickHouse a projection ordered `(org_id, device,
ts)` — the exact shape of Postgres's second index — left the device lookup at
**11.6 ms** (from 11.8 ms) and **doubled on-disk size from 22 to 44 bytes/row**.
The projection *is* used, and it does not help, because granularity and not
ordering is the cost.

### 5.5 Query latency — ten times the corpus

5.96 M rows, otherwise identical. This is the number the old "do not extrapolate"
caveat asked for.

| Query | PostgreSQL | ClickHouse | |
|---|---|---|---|
| Log tail — 2 h window | **1.3 ms** | 6.4 ms | PG 4.9× |
| Recent logs for ONE device | **0.4 ms** | 16.1 ms | PG 40× |
| Dashboard — `COUNT(*)`, 24 h | 374.6 ms | **3.8 ms** | **CH 98×** |
| Log search — substring, 24 h | 916.3 ms | **10.8 ms** | **CH 85×** |
| Log search — substring, 7 d | 51.0 ms | **23.4 ms** | CH 2.2× |
| Log search — rare term, 7 d | 67.4 ms | **24.7 ms** | CH 2.7× |
| Roll-call — last line per device | 880.2 ms | **87.3 ms** | CH 10.1× |
| Top devices by volume, 7 d | 908.9 ms | **87.3 ms** | CH 10.4× |
| Throughput chart — daily, 7 d | 2,620 ms | **133.7 ms** | CH 19.6× |
| Throughput chart — hourly, 7 d | 1,809 ms | **110.4 ms** | CH 16.4× |

The two queries Postgres wins are **flat** — 1.2 → 1.3 ms and 0.3 → 0.4 ms for
ten times the data, because an index scan that stops at `LIMIT` does not care how
big the table is. Everything else on the Postgres side grew by roughly the factor
the old caveat predicted, and the shipped throughput chart crossed **2.6 seconds**,
which is past the point where a page feels broken.

**One Postgres result is not monotone, and it is the more interesting finding.**
The 24-hour search costs **916 ms** while the 7-day search over the same table
costs **51 ms** — the narrower question is 18× more expensive than the wider one.
`EXPLAIN (ANALYZE)` says why:

```
24 h:  Parallel Seq Scan on logs  (actual rows=14176 loops=3)   976 ms
 7 d:  Parallel Index Scan Backward using idx_logs_org_ts       66 ms
```

Over 7 days the planner walks the index backward from the newest row and stops
once the `LIMIT 300` is satisfied. Over 24 hours it estimates that the range is
too narrow to find 300 matches that way, and scans 6 M rows instead. Both plans
are reasonable; the estimate is what flips. The consequence for a user is that
**narrowing the time filter can make log search slower**, unpredictably, at a
volume we have not reached yet. ClickHouse's two numbers for the same pair are
10.8 ms and 23.4 ms — monotone, because it scans either way and the window only
decides how many parts it touches.

### 5.6 What it costs to run

| | resident |
|---|---|
| PostgreSQL — postmaster + all backends, PSS | **161 MB** |
| ClickHouse — single process, PSS | **609 MB** |
| ClickHouse — RSS | 695 MB |

Measured after the query runs, at rest, on the 6 M-row corpus. ClickHouse is
**~3.8× the whole Postgres cluster**, and it is a floor rather than a peak: mark
cache, uncompressed cache and per-query memory come out of the same process.

On the 4 vCPU / 16 GB sandbox that is irrelevant. On the production VM it is not:
**3,800 MB total**, already running the app, Postgres, Caddy, unbound and
livekit, with the whole stack idling at 283 MB (§3). Adding ClickHouse would
roughly **triple the platform's resident memory** and take a fifth of the machine
for a database with no user-visible query to answer yet.

### 5.7 Against a budget, not against each other

The tables above are ratios, and **a ratio between two numbers that are both far
below perception is not a finding.** The per-device tail is 0.3 ms on Postgres
and 11.8 ms on ClickHouse — 39×, and nobody on earth can tell those apart. The
first version of this section led with that number, which made a real difference
(storage, the scans) share a headline with a difference that does not exist.

So: a budget first, and the ratios only where a budget is crossed.

**The budget, derived rather than picked.** §2.2 measured Express and JSON
serialisation at 8-20 ms on top of the query, and no number here includes real
network. So:

| Band | Database time | What it means |
|---|---|---|
| **inside** | ≤ 50 ms | invisible — the request is dominated by overhead and network, not by the database |
| **edge** | 50-250 ms | perceptible, and acceptable for a deliberate action (a search, opening a chart) |
| **outside** | > 250 ms | the user waits for us |

Counted that way, on two cores:

| | inside | edge | **outside** |
|---|---|---|---|
| PostgreSQL, 596 k rows | 3 | 4 | **3** |
| ClickHouse, 596 k rows | **10** | 0 | **0** |
| PostgreSQL, 5.96 M rows | 2 | 2 | **6** |
| ClickHouse, 5.96 M rows | 6 | 4 | **0** |

**ClickHouse never leaves the budget, at either scale.** Postgres leaves it three
times at today's size and six times at ten times that. And the two queries
Postgres "wins" are inside the budget on **both** engines, so they are not an
argument for either one — which is the correction: §5.4's "loses the two that
matter most" was true as arithmetic and misleading as a conclusion.

What survives from that paragraph is narrower and worth keeping. The 39× is not
latency the user feels, it is **CPU per request**: 11.8 ms of database time
against 0.3 ms is 39× the work per page open, which is a capacity ceiling rather
than a delay. At the request rate this instance actually serves that is nowhere
near binding — and **that rate was not measured** (Caddy logs no access lines to
stdout here), so this stays a shape, not a number.

### 5.7.1 Where production actually sits

Interpolating from the sandbox was the wrong way to answer this, so it was
measured on the live database instead — read-only, warm cache, 2026-08-18:

| | production, 392,319 rows / 7 days |
|---|---|
| Log tail, 2 h | **1.34 ms** — inside |
| Infrastructure roll-call | **70.4 ms** — edge |
| Log search, 7 d | **318.5 ms** — **outside** |
| Throughput chart, daily over 7 d | **371.6 ms** — **outside** |

`logs` holds 392,319 rows in 144 MB — *smaller* than this section's 596 k corpus,
because retention is 7 days. So production is not approaching the point where
Postgres leaves the budget. **It is already past it, on two user-facing queries,
at a fifteenth of the volume the earlier "revisit at 2-3 M rows" trigger named.**
That trigger was wrong and is withdrawn.

### 5.7.2 But two of those three are a missing rollup, not an engine limit

Before "add a second database", the cheaper question: is Postgres being asked the
right query?

- **The throughput chart (371.6 ms) aggregates raw rows on every page load.**
  The product already has this pattern and already runs it on the hot write
  path — `event_buckets` folds events into per-minute counts inside the ingest
  transaction (§`engine/pipeline.js`). **There is no equivalent for `logs`**;
  `grep` for a logs rollup in `schema.sql` returns nothing. A `log_buckets` fold
  of the same shape turns a full scan of 392 k rows into a read of ~10 k
  pre-aggregated ones, and it scales with *retention* instead of with volume.
- **The roll-call (70.4 ms) is `MAX(ts) GROUP BY device` over the whole table**
  to answer "when was each device last heard from" — 24 rows out of 392 k. That
  is a maintained column on a device table, not a scan.
- **Full-text search (318.5 ms) is the one that genuinely wants a different
  engine.** `LIKE '%…%'` cannot use a B-tree; §2.3 shows it is the scan itself.
  Postgres's own answer is a `pg_trgm` GIN index, which costs write throughput on
  the path §1.3 says is already CPU-bound — a real trade, not a free win.

So the honest split of the three over-budget queries: **two are ours to fix in
the database we already run, one is a genuine engine question.**

### 5.7.3 What the stack costs with ClickHouse in it

Measured on the production host on 2026-08-19, about thirty seconds after the
stack came up on the ClickHouse build. `docker stats`, so RSS per container:

| container | |
|---|---|
| `app` | 114.7 MiB |
| `clickhouse` | 321.5 MiB |
| `db` (PostgreSQL) | 245.4 MiB |
| `caddy` | 31.2 MiB |
| `unbound` | 8.4 MiB |
| `livekit` (profile-gated, off by default) | 21.9 MiB |
| **total without livekit** | **~721 MiB** |

Two honest qualifications, because this number replaces a published claim:

- **It is a fresh boot.** ClickHouse grows as its mark cache fills; § 5.6
  measured it at **609 MB PSS** after real query load in the sandbox, which puts
  the settled figure nearer **1 GB**. Both databases carry `mem_limit: 1g` in
  both compose files, so the worst case is bounded rather than open-ended.
- **The claim it replaces was already loose.** "The whole stack idles under
  350 MB" came from § 3, which measured **app + Postgres only** — no Caddy, no
  unbound, no second database. The comparable Postgres-only figure for the
  actual stack is closer to 400 MB. So the honest headline is not "350 → 750";
  it is "**~400 MB → ~750 MB, and the old number was never the whole stack**".

### 5.7.4 The settled figure, and the two numbers above that went stale

§ 5.7.3 was measured **thirty seconds after boot**, and it said so — but a
number with a caveat next to it still gets copied without the caveat, and this
one was: the marketing page carried "around 720 MB" and "each one is capped at
1 GB" straight out of that table. Both stopped being true within a day of being
published, for two different reasons, neither of which touched the table itself.

**What moved.** #180 raised ClickHouse's ceiling — `max_server_memory_usage`
768 MiB → 1.15 GiB and the container `mem_limit` 1g → 1.5g — because the
original figure was sized for an idle experiment rather than for a database
serving reads. So "both databases carry `mem_limit: 1g`" is simply wrong now,
and the sentence was on a public web page.

**Re-measured on the production host, settled rather than fresh** — `docker
stats` again, so RSS per container, with uptimes given because that is the whole
difference between this table and the one above:

| container | | uptime |
|---|---|---|
| `app` | 126.9 MiB | 8 h |
| `clickhouse` | 521.1 MiB | 23 h |
| `db` (PostgreSQL) | 181.5 MiB | 45 h |
| `caddy` | 29.8 MiB | 2 d |
| `unbound` | 11.3 MiB | 8 h |
| `livekit` (profile-gated, off by default) | 13.9 MiB | 12 d |
| **total without livekit** | **~871 MiB** | |

So the fresh-boot 721 MiB settles at **~871 MiB**, and § 5.7.3's own prediction
("nearer 1 GB") was the right shape and slightly pessimistic: ClickHouse settled
at 521 MiB, not at its 1.15 GiB ceiling. PostgreSQL went the other way — 245
MiB at boot, 181 MiB now, and part of that is § 5.7.5 below.

**The bounded worst case is what should be quoted, not the idle figure**, and it
is no longer one number: PostgreSQL 1 GB, ClickHouse 1.5 GB, everything else
unbounded but small. On a 3.7 GB host with no swap that is the plan-against
figure, and it is why `mem_limit` is not optional here (see the comment in
`docker-compose.yml`).

### 5.7.5 What 14× less disk looks like once it is real

Incidental, and the best confirmation in this document, because nobody set it
up: the same production host, after the pre-cutover Postgres rows were dropped
(#189).

| | rows | on disk | per row |
|---|---|---|---|
| PostgreSQL `logs` (before the drop) | 347,024 | 145 MB | 438 B |
| ClickHouse `logs` (now) | ~365,000 | **8.36 MiB**, 15 active parts | **24 B** |

That is **18×**, against the 14× § 5.3 measured on an identical corpus. The
published claim stays at 14× — § 5.3 is the apples-to-apples measurement and
these two row sets are not the same rows — but it is worth knowing that the
conservative number is the one on the website.

---

### 5.8 The recommendation, and what was decided

**Decided on 2026-08-19: adopt it, for log lines only.** The analysis below is
kept as written rather than rewritten to match the outcome — it is the reasoning
that produced the decision, including the part it got wrong.

What shipped: `src/db/log-store.js`, one interface with two implementations,
chosen at boot by `CLICKHOUSE_URL`. Everything transactional stays in Postgres.
See `docs/ARCHITECTURE.md` § Log storage.

**Amended the next day: ClickHouse became the default in the community edition
too.** The original split — ClickHouse in the cloud, Postgres for self-hosters —
rested on § 5.6's memory figure and on not wanting to falsify a published
"idles under 350 MB". § 5.7.3 measured what the stack actually costs and the
claim was corrected rather than protected, which removed the argument: a
self-hosted instance with real log volume hits the same 250 ms wall § 5.7.1
found in production. `CLICKHOUSE_URL=` empty remains supported and remains
covered by the parity harness — it is no longer the default, which is not the
same as deprecated.

What the decision did NOT wait for: items 1 and 2 below — the missing
`log_buckets` rollup and a maintained `last_seen` — are still worth doing and are
still in `docs/BACKLOG.md`. They now serve the *community* edition, where the
throughput chart still scans raw rows. That is the part of this recommendation
that survived intact and it should not be lost because the third item was taken.

---

Revised after the budget analysis above, and it is no longer a flat "no".

**Do these in order. Stop when the budget is met.**

1. **Add a `log_buckets` rollup, folded in the ingest transaction like
   `event_buckets`.** Removes the 371.6 ms chart — the single worst number
   production has — without a second datastore, a second backup, or a byte of
   new memory. This is the highest ratio of benefit to risk in the whole
   comparison and it should not wait on the ClickHouse decision.
2. **Give the roll-call a maintained `last_seen` per device.** Same argument,
   smaller prize.
3. **Then, and only then, decide about full-text search.** With 1 and 2 done,
   exactly one query is outside the budget, and the choice is a narrow one
   between `pg_trgm` (costs ingest CPU, no new component) and ClickHouse for the
   `logs` table alone (17-25 ms, 14× less disk, and a second datastore to
   operate).

**What still argues against ClickHouse, once the ratios are set aside:** it is
609 MB resident against 161 MB for the whole Postgres cluster, on a VM with
3,819 MB — and it is a second system to back up, restore, keep consistent and be
woken up by. **What argues for it** is no longer speed alone: it is that 22
bytes/row against 301 is what decides how much retention fits on a 38 GB disk,
and retention is a thing we sell.

If it is adopted it is **not** a migration: ClickHouse beside Postgres for the
`logs` table only, with Postgres keeping the tail queries, every transactional
table, and the spine.

### 5.9 Reproducing this section

```sh
# ClickHouse, no Docker needed — a single static binary
curl https://builds.clickhouse.com/master/amd64/clickhouse -o clickhouse && chmod +x clickhouse
./clickhouse server --config-file=ch-config.xml &

node gen.js corpus.tsv 596500          # seeded; identical file every time
psql "$PG" -c "\copy logs(...) FROM 'corpus.tsv' WITH (FORMAT text, NULL '\N')"
./clickhouse client -q "INSERT INTO logs FORMAT TabSeparated" < corpus.tsv

CH_MAX_THREADS=2 taskset -c 2,3 node bench.js 25    # both engines pinned to 0,1
```

`gen.js` and `bench.js` are scratchpad tooling, not repo files — the corpus is
defined by the seed and the mix described in §5.1, and both scripts are short
enough to rebuild from this section. What must not change if the numbers are to
be comparable: the seed, the 3-warm-up/25-timed shape, the core pinning, and
loading both engines from one file.

---

## 6. Sensor probe capacity

`scripts/loadtest-probe.mjs` drives the **real, unmodified** `opscat-agent.js
--probe` against two stubs it hosts itself: a control plane answering
`GET /v1/synthetics/checks` and `POST /v1/synthetics/report`, and a target
server that responds after a configurable delay. No OpsCat server and no
database are involved, so the number describes the agent rather than our API.

Two details decide whether the measurement means anything:

- **Every check gets its own origin** (`127.x.y.z`). Pointing 1000 checks at one
  host measures a warm keep-alive socket, which is the opposite of a real probe
  where every check is a different site and pays TCP — and TLS — setup again.
  Same run with `--same-origin` is available for comparison.
- **The agents are pinned to two cores** (`--pin 0,1`) with the driver and stubs
  on the other two, the same convention §0 uses for the ingest numbers. A
  t3.small has 2 vCPU, so this is an upper bound for one, not a simulation of
  one — see the burst caveat at the end.

All runs: Node 22.22.2, agent v0.3.0, TLS 1.3 to the stub, 8 KB response body.

| Scenario (per agent process) | wall per check | throughput | CPU per check | RSS |
|---|---|---|---|---|
| HTTP, no network delay, 200 checks | 2.5 ms | 406 checks/s | 1.70 ms | 91 MB |
| **HTTPS**, no network delay, 200 checks | 5.0 ms | 202 checks/s | 3.48 ms | 102 MB |
| HTTPS, no network delay, 1000 checks | 4.8 ms | 207 checks/s | 3.46 ms | 195 MB |
| HTTPS, 150 ms target delay, 100 checks | 155.7 ms | 6.4 checks/s | 4.65 ms | 92 MB |
| HTTPS, 150 ms delay, 100 checks x **4 agents** | 156.1 ms | 25.6 checks/s | 4.94 ms | 89 MB each |
| HTTPS, no delay, 200 checks x **8 agents** | 16.9 ms | **473 checks/s** | 4.17 ms | 105 MB each |

### 6.0 Re-measured after the agent grew a pool

Everything below was measured on the **sequential** agent (v0.3.0), and it is
kept because it is what motivated the change. v0.4.0 runs its due list through a
bounded pool (`--concurrency`, default 8), and the same rig says:

| Concurrency | wall per check | throughput | CPU per check | in flight at target |
|---|---|---|---|---|
| 1 (v0.3.0's behaviour) | 243.7 ms | 4.1 checks/s | 9.75 ms | 1 |
| **8 (the new default)** | 19.6 ms | **50.9 checks/s** | 3.55 ms | 8 |
| 16 | 10.3 ms | 97.4 checks/s | 3.65 ms | 16 |

200 checks, HTTPS, one origin each, target answering after 150 ms, agents pinned
to two cores. Scaling is linear in the pool size because the wait is the network,
not us — at 16 the node is at ~18% of the CPU ceiling below.

**One node at a 60 s interval therefore carries ~3,000 checks at the default
pool, not ~385**, and ~1,500 at the half-interval operating point this section
recommends. The CPU ceiling did not move: it was never the constraint.

> **Superseded by §6.0.1.** The table above was measured on a developer
> workstation, and the `--concurrency` flag it names **did not work** — see
> below. Use §6.0.1 for anything customer-facing.

### 6.0.1 Measured on a real sensor node, and a bug in this benchmark

The first opportunity to run the rig **on a provisioned node** (break-glass SSH,
§11 of `docs/SENSOR-AGENTS.md`) produced three identical results for
`--concurrency 1`, `8` and `16` — 31.2, 31.2 and 30.8 checks/s, each reporting
`max in flight at target 8`.

That line was the tell. **`--concurrency` was neither parsed nor forwarded**:
`loadtest-probe.mjs` never declared the constant, and it spawned the agent as
`[AGENT, '--probe']` with nothing carrying the setting. Every run measured the
agent's default of 8, and the summary printed "8" each time — which reads as
confirmation instead of the contradiction it was. The fix passes
`OPSCAT_PROBE_CONCURRENCY` through the child's environment (not argv: the
`taskset` path rewrites argv).

Re-run on **AWS t3.small, us-east-1** (2 vCPU burstable, 2 GiB — the `standard`
node class from `providers/index.js`), agent v0.4.0,
200-400 checks, HTTPS, one origin each, target answering after 150 ms:

| Concurrency | throughput | in flight | check latency p50 | cores busy | checks @ 60 s |
|---|---|---|---|---|---|
| 1 | 5.6/s | 1 | 160 ms | 0.03 | ~333 |
| 8 (previous default) | 31.3/s | 8 | 160 ms | 0.16 | ~1,877 |
| **16 (default since v0.4.1)** | **44.1/s** | 16 | 164 ms | 0.23 | **~2,644** |
| 32 | 85.5/s | 32 | 182 ms | 0.40 | ~5,128 |
| 64 | 99.2/s | 64 | 261 ms | 0.44 | ~5,953 |

**A real node is slower than the workstation** — 31.3 checks/s at the default
against the 50.9 measured on the dev box — so the honest capacity figure is
**~1,900 checks per node at a 60 s interval**, ~950 at the half-interval
operating point. Not ~3,000. Anything quoted to a customer uses these.

**The pool trades throughput against the number this product exists to report.**
The target answers in a fixed 150 ms, so every millisecond of p50 above ~160 ms
is the agent's own queue being reported as the site's latency: +2% at 16, +14%
at 32, **+63% at 64**. A synthetic monitor that inflates the latency it measures
is broken in a way no error message will ever surface. That, not CPU, is what
caps the pool — the box never went past **0.44 of its 2 cores** at any setting.

On this evidence 16 is nearly free (+41% capacity for +2% latency) and 8 was
conservative; beyond 16 the measurement quality is what is being spent. **The
agent default moved to 16 in v0.4.1** on exactly this table.

**And the CPU column has a second reading, because the node BURSTS.** A t3.small
sustains 20% per vCPU — **0.4 vCPU** — and earns credits below that, spends them
above. Against that line:

| Pool | cores busy | vs the 0.4 baseline |
|---|---|---|
| 8 | 0.16 | 40% of it — indefinitely sustainable |
| 16 | 0.23 | 58% — sustainable |
| 32 | 0.40 | exactly at it — no margin |
| 64 | 0.44 | **above it — burns credits, then throttles** |

So the last two rows are not capacities a node can hold. They are what it does
while its credit balance drains; once that is empty the instance is capped at
baseline and the sweep stops fitting in the interval. The usable ceiling on this
class is **~2,600 checks at pool 16**, and the 5,000-6,000 figures are peak, not
steady state.

**Both numbers are also a LINEAR extrapolation** from 200-400 measured checks —
`60 s ÷ measured ms-per-check` — and they assume per-check cost stays flat as the
work list grows. §6 measured it flat from 100 to 1000 checks (155.7 → 156.1 ms),
which is the evidence for extrapolating at all, but RSS grows ~100 MB per 1000
checks, so a 2 GiB node has its own limit somewhere past this. Nobody has run a
sensor at 2,000 real checks yet; treat these as an upper bound with a known
method, not as an observation.

**The agent WAS sequential, and that was the whole story.** The target's in-flight
counter never exceeded 1 for a single agent process, and per-check cost was flat
from 100 to 1000 checks (155.7 ms vs 156.1 ms with four agents; 5.0 ms vs 4.8 ms
without network delay). Four agent processes multiplied throughput by exactly
four at unchanged per-check cost, which says the box was not the constraint at
all — the loop was.

**Where the box actually ends:** eight concurrent agents on two pinned cores
reached **473 checks/s at 1.98 cores busy** — saturation, and it agrees with the
per-check CPU cost (2000 core-ms/s ÷ 4.17 ms ≈ 479/s). Over a 60 s interval that
CPU ceiling is ~28,000 checks. A single sequential agent reaches ~385 in the same
minute. **The gap between the loop and the hardware is a factor of ~70.**

### 6.1 What one node carries

A check against a real HTTPS site costs roughly three round trips (TCP, TLS 1.3,
request) plus the ~5 ms the node spends itself. For a site 50 ms away that is
~155 ms per check, sequentially:

| Interval | Sequential capacity | Recommended (50% headroom) |
|---|---|---|
| 60 s | ~385 checks | **~190** |
| 30 s | ~190 checks | ~95 |
| 15 s | ~95 checks | ~48 |

Halve the numbers for targets 150 ms away, double them for 25 ms ones — the
network round trip is the term that moves, and it is the customer's, not ours.

At the recommended point the node is idle: 190 checks x 4.65 ms of CPU is 0.88
core-seconds per minute, **1.5% of one core**. That matters specifically on AWS,
because a t3.small is burstable — baseline is 20% of 2 vCPU and sustained load
above it either throttles or, in `unlimited` mode (the T3 default), bills extra.
A realistic probe fleet sits an order of magnitude below the baseline. A node
pushed past ~2000 checks would not.

---

## 7. Claim sheet

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
| App + Postgres idle at **283 MB** | fresh boot, empty database, bare metal, **app and Postgres only** — this is NOT "the whole stack", and was quoted that way on the marketing page until § 5.7.3 measured the real thing | §3 |
| The whole stack with ClickHouse runs at **~721 MiB** | six containers on the production host, ~30 s after boot; nearer 1 GB once ClickHouse's caches fill, and capped at 1 GB per database by `mem_limit` | §5.7.3 |
| App + Postgres at **347 MB** under full ingest load | 4 cores, c=4, Postgres counted as PSS | §3 |
| **CPU-bound, not disk-bound** | `synchronous_commit=off` buys only 7% | §1.3 |
| ClickHouse stores the same corpus in **1/14 of the disk** (22 vs 301 bytes/row) | `MergeTree`, `LowCardinality` device/source, indexes counted on the Postgres side | §5.3 |
| ClickHouse answers log search and the charts **5-25× faster** at 596 k rows, **16-98× at 6 M** | both engines on 2 cores; the same SQL, not ClickHouse-idiomatic rewrites | §5.4, §5.5 |
| Postgres is 5× / 39× faster on the log tail and the per-device tail | true, and **not a difference anyone can perceive** — both are inside the budget on both engines. It is 39× the CPU per request, i.e. capacity, not delay | §5.4, §5.7 |
| **ClickHouse never leaves the 250 ms budget**; Postgres leaves it 3× at 596 k rows and 6× at 6 M | database time only, two cores, the ten statements the product runs | §5.7 |
| **Production is already outside the budget** on log search (318 ms) and the throughput chart (372 ms) | live database, warm cache, 392,319 rows / 7 days retention — measured, not interpolated | §5.7.1 |
| Two of those three are **a missing rollup, not an engine limit** | `event_buckets` folds events per minute on the ingest path; nothing equivalent exists for `logs`, so the chart scans every row on every page load | §5.7.2 |
| ClickHouse costs **609 MB resident**, ~3.8× the whole Postgres cluster | at rest, PSS, after the 6 M-row run | §5.6 |
| Postgres log search **stops being monotone** at 6 M rows: 24 h costs 916 ms, 7 d costs 51 ms | plan flip between seq scan and backward index scan; not reproduced at 596 k | §5.5 |
| One sensor node sustains **~2,600 HTTPS checks at a 60 s interval** | agent v0.4.1 at the default pool of 16, measured ON a provisioned AWS t3.small; the monitored site is ~150 ms away; the sweep may fill the interval. Replaces an earlier ~3,000 taken on a workstation with a broken `--concurrency` flag | §6.0.1 |
| **~1,300 checks** per node at 60 s with headroom | same, keeping the sweep at half the interval so a slow target cannot push the cycle past its own deadline | §6.0.1 |
| Raising the pool costs **latency fidelity, not CPU** | p50 rises 160 → 261 ms from pool 8 → 64 against a target pinned at 150 ms; the box stays under 0.44 of 2 cores throughout, so the queue is being reported as the site's latency | §6.0.1 |
| The **sequential** agent (v0.3.0) sustained ~385 / ~190 | the numbers this change was made against — same rig, pool of 1 | §6, §6.1 |
| A probe node saturates two cores at **~473 HTTPS checks/s** | eight concurrent agent processes, zero network wait, TLS 1.3 to a loopback target, cores pinned — a CPU ceiling, ~70x above what the sequential agent reaches | §6 |
| A check costs the node **3.5-5 ms of CPU and ~0 idle RAM** | HTTPS, 8 KB body; RSS is ~90-105 MB per agent process plus ~100 MB per 1000 checks in the work list | §6 |

---

## What these numbers do NOT say

- **The probe numbers do not include the network.** The stub target delays its
  *response*; the TCP and TLS handshakes complete at loopback speed. Real per-check
  wall time is roughly `3 x RTT + 5 ms`, which is why §5 reports the node's own
  cost separately instead of quoting one figure that silently contains a
  particular customer's latency.
- **They were not measured on a t3.small.** Two pinned sandbox cores are faster
  than a burstable t3 baseline. Treat §5 as a ceiling, and note that the
  recommended operating point sits at 1.5% of one core, far under the burst
  baseline where the difference would start to matter.
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
- **They do not say the product is fast at scale** — but §5.5 now measures the
  ten-times case that this bullet used to only warn about. The §1-§4 corpus is
  596,500 rows over 7 days for one organisation. At 5,964,910 rows the shipped
  throughput chart goes from 261 ms to **2,620 ms** and the roll-call from 97 ms
  to 880 ms, so the linear prediction holds for the scans. What it does **not**
  predict is the plan flip in §5.5, where the 24-hour log search becomes 18×
  slower than the 7-day one. Extrapolation gets the scans right and misses the
  cliff; measure it.
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
- **§5 does not say ClickHouse is slow at the tail queries in a deployment built
  around it.** It says the SQL the product runs today, unchanged, is slower there.
  A design that kept a hot recent window elsewhere, or used a much smaller
  `index_granularity` for it, was not measured. What §5.4 does establish is that
  the naive move — point the existing queries at ClickHouse — makes the two most
  frequent ones worse, and that the obvious fix (a projection) does not work.
- **§5 does not measure ingest through the product.** Its load figures are `COPY`
  and `INSERT … FORMAT TabSeparated` straight into a table. OpsCat's write path
  does dedupe, severity ratcheting and rollups per batch and tops out an order of
  magnitude lower (§1.2). Nothing in §5.2 is a claim about OpsCat's ingest rate.
- **§5 does not measure the two engines under concurrent load**, and the memory
  figure in §5.6 is at rest. ClickHouse's per-query memory is taken from the same
  process, so a busy instance is larger than 609 MB by an amount not measured here.
