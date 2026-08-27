-- Stage 2: an endpoint says whether the customer runs a collector of their own
-- or sends straight to our managed gateway.
--
-- It changes no behaviour on the ingest path — both modes authenticate with the
-- same `collector`-scoped key and land in the same `/v1/collector/logs`. What it
-- decides is which configuration the product PRINTS, and that is worth a column
-- rather than a guess: the two snippets are not interchangeable, and an endpoint
-- shown the wrong one sends nothing at all while looking configured.
--
-- DEFAULT 'collector' is what makes this migration safe for the endpoints that
-- already exist: every one of them was created for a customer-run collector.
ALTER TABLE syslog_endpoints
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'collector';
