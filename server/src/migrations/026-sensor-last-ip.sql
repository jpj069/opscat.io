-- The address a probe location actually reaches us from.
--
-- "What are your sensor IPs?" is the first question anyone asks before they
-- allow-list a monitor, and the product could not answer it: nothing recorded
-- where a probe connects from, so the answer had to be reconstructed from the
-- cloud provider's API (and for a self-hosted agent it could not be
-- reconstructed at all). Written on every work-list pull, so it follows a node
-- whose ephemeral public IP changed under it.
ALTER TABLE synthetic_locations ADD COLUMN IF NOT EXISTS last_ip TEXT;
