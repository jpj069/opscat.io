-- The host agent a managed node also runs.
--
-- `opscat-agent` has always had two roles in one binary: a HOST agent (agent
-- token → heartbeat, CPU/RAM/disk) and a SENSOR agent (probe key → synthetic
-- checks). A provisioned node only ever ran the second, so the fleet screen
-- could say how many checks it ran and nothing at all about whether the box was
-- keeping up. Registering it as a host agent too costs one row and one env line
-- in cloud-init, and the utilization block finally has hardware behind it.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the agent registration must
-- never take the node row with it — the node is what teardown works from.
ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS agent_id BIGINT
  REFERENCES agents(id) ON DELETE SET NULL;
