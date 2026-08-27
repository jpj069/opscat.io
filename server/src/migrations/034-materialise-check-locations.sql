-- Make every check's agent assignment EXPLICIT.
--
-- `check_locations` used an absent row set to mean "all agents, including ones
-- that do not exist yet" (routes/synthetics.js said so, and the check dialog's
-- toggle promised it out loud). So booking a managed sensor silently attached
-- every check in the org to it: a node in another continent starts costing
-- money and, worse, every uptime and latency series the org has quietly gains a
-- new sampler. Nobody clicked anything.
--
-- Backfill each check with zero rows to the fleet it is running on TODAY —
-- everything the org owns, plus the managed locations it has actually booked.
-- That is what "all agents" meant a second before this migration ran, so no
-- check changes where it runs; it only stops inheriting the future.
--
-- A check whose org has no runnable location at all keeps zero rows, and that
-- is deliberate: `runsOnLocation()` still reads the empty set as "anywhere".
-- The alternative — a check that runs NOWHERE — is silent and invisible, which
-- is the worse of the two failures by a distance.
INSERT INTO check_locations (check_id, location_id)
SELECT c.id, l.id
  FROM synthetic_checks c
  JOIN synthetic_locations l
    ON l.active = 1
   AND (l.org_id = c.org_id
        OR (l.kind = 'managed' AND l.visible = 1
            AND EXISTS (SELECT 1 FROM org_location_access a
                         WHERE a.org_id = c.org_id AND a.location_id = l.id)))
 WHERE NOT EXISTS (SELECT 1 FROM check_locations cl WHERE cl.check_id = c.id)
ON CONFLICT DO NOTHING;
