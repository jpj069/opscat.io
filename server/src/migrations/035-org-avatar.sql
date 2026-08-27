-- An organisation's own avatar (see schema.sql for why it is not status_assets).
-- Databases that already exist get the table here; a fresh install gets it from
-- schema.sql, which is why both are written in the same commit.
CREATE TABLE IF NOT EXISTS org_assets (
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('avatar')),
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, kind)
);
