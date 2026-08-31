-- Agent names were UNIQUE across the whole table, i.e. across every tenant.
--
-- The symptom was a first run that stops dead: onboarding's Server Agent tab
-- POSTs an agent called `my-first-server`, so the first organisation on an
-- instance to open that tab claimed the name for everybody. Every other org —
-- and the same org on a second visit, since the token is not retrievable and
-- the tab asks for a new one — got `409 agent name already exists` about a row
-- it is not allowed to see, and the browser rendered the placeholder
-- "registering agent…" forever.
--
-- A name is a label its own tenant chooses. It carries no authority: agents
-- authenticate on `token_hash` (globally unique, and left that way), never on
-- the name. So the constraint that belongs here is per-org, and the global one
-- was leaking one tenant's naming into another's namespace.
--
-- Safe in one direction only, which is why it is this way round: every existing
-- row was already globally unique, so it is trivially unique per org. Adding
-- the constraint cannot fail on existing data.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_name_key;
ALTER TABLE agents ADD CONSTRAINT agents_org_id_name_key UNIQUE (org_id, name);
