-- Per-check User-Agent for HTTP synthetic checks.
--
-- A monitor that identifies itself is the right default — an admin reading their
-- own access log should be able to tell our probe from a scraper. But a check
-- pointed at a site behind bot protection gets refused for exactly that reason,
-- and "the check is red because the WAF blocked the monitor" is not a signal
-- anyone can act on. NULL = fall back to the org default, then to ours.
ALTER TABLE synthetic_checks ADD COLUMN IF NOT EXISTS user_agent TEXT;
