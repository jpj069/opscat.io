-- Where a credential has EVER launched, so the orphan sweeper can look there.
--
-- engine/reconcile.js derived its region list from `SELECT DISTINCT
-- provider_region FROM sensor_nodes` — live rows — while the same sweeper
-- DELETEs those rows. So the moment the last node in a region went away, that
-- region stopped being listed and an orphan there was never destroyed. The
-- comment above the query already said "regions we ever provisioned with this
-- credential", which is precisely what it did not do.
--
-- The set that matters is "everywhere this credential has ever started an
-- instance", and nothing else in the schema remembers that. This table does,
-- and the sweeper never deletes from it.
CREATE TABLE IF NOT EXISTS cloud_regions_used (
  credential_id BIGINT NOT NULL REFERENCES cloud_credentials(id) ON DELETE CASCADE,
  region        TEXT NOT NULL,
  first_used_at BIGINT NOT NULL,
  PRIMARY KEY (credential_id, region)
);

-- Backfill from the nodes that exist right now. It cannot recover a region
-- whose last node is already gone — that history was never written down — so
-- an orphan leaked before this migration still needs finding by hand. From
-- here on the set only grows.
INSERT INTO cloud_regions_used (credential_id, region, first_used_at)
SELECT DISTINCT cloud_credential_id, provider_region, MIN(created_at)
FROM sensor_nodes
WHERE cloud_credential_id IS NOT NULL AND provider_region IS NOT NULL
GROUP BY cloud_credential_id, provider_region
ON CONFLICT (credential_id, region) DO NOTHING;
