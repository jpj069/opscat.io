-- ClickHouse schema — the log LINE store, and nothing else.
--
-- Everything transactional stays in PostgreSQL (src/schema.sql). What lives
-- here is the one table that is append-only, never updated, read by scans, and
-- large: raw log lines. Events, cases, incidents, users and the whole spine are
-- not candidates and are not here — see docs/ARCHITECTURE.md § Log storage.
--
-- SAME DISCIPLINE AS schema.sql: every statement is idempotent, because
-- `clickhouse.init()` applies this file on EVERY boot. A statement without
-- `IF NOT EXISTS` works on the install that creates it and kills the process on
-- every restart afterwards.
--
-- Statements are separated by a line containing only `;`. ClickHouse's HTTP
-- interface takes one statement per request, so the loader splits on that
-- rather than on every semicolon — a semicolon inside a comment or a string
-- would otherwise cut a statement in half.

CREATE TABLE IF NOT EXISTS logs (
  org_id  UUID,
  ts      Int64,                        -- unix ms, the same value Postgres stored
  device  LowCardinality(String),
  line    String,
  sev     UInt8,                        -- syslog 0..7
  source  LowCardinality(String),
  meta    Nullable(String)              -- JSON
)
ENGINE = MergeTree
-- One part per day. It bounds a merge, it makes a time-windowed query touch
-- only the days it asks for, and it is what makes `DROP PARTITION` available
-- if a bulk delete is ever needed.
PARTITION BY toYYYYMMDD(toDateTime(intDiv(ts, 1000)))
-- (org_id, ts) mirrors Postgres's idx_logs_org_ts, and the leading org_id is
-- what makes tenant isolation an index seek rather than a filter.
ORDER BY (org_id, ts)
-- A CEILING, not the retention policy. Per-org retention is a plan limit an
-- org may shorten (plans.retentionDaysFor), which a table-level TTL cannot
-- express — engine/retention.js still does that work, per org. This exists so
-- that a sweep which stops running cannot grow the table forever: 400 days is
-- above the largest plan (365) so it can never delete a row an org paid for.
TTL toDateTime(intDiv(ts, 1000)) + INTERVAL 400 DAY
SETTINGS index_granularity = 8192
;

-- NO SKIP INDEX ON `line`, AND THAT IS A MEASURED DECISION, NOT AN OMISSION.
--
-- The obvious move is a `tokenbf_v1` index on `line` so full-text search can
-- skip granules. It was written, shipped into this file, and then EXPLAINed:
--
--   EXPLAIN indexes=1 SELECT ... WHERE line ILIKE '%timeout%'
--   Indexes:  Min-Max · Partition · PrimaryKey        <- no skip index
--
-- ClickHouse does not consult it, and it is right not to: a bloom filter over
-- TOKENS cannot answer a SUBSTRING question. `%timeout%` must also match
-- "timeouts", and no token filter can promise that. It would only be usable if
-- the product's search meant whole words (`hasToken`), which it does not — the
-- Logs page is a substring box and people paste half an IP into it.
--
-- What it cost while it was there: 669 KiB of index, written on every insert,
-- consulted never. What the scan costs without it: ILIKE over 596,491 rows,
-- p50 12.6 ms, p95 14.7 ms on two cores — faster than the 17.2 ms in
-- docs/BENCHMARKS.md § 5.4, because that measurement used the product's
-- `lower(line) LIKE lower(?)` translated literally and wrapping the column in
-- a function is what stops any index being consulted at all.
--
-- So: no index, and if someone adds one, EXPLAIN it before believing it.
