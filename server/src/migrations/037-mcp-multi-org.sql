-- One MCP connection may cover several organizations.
--
-- Until here a connection was bound to exactly one org, chosen in the consent
-- screen: somebody who looks after three of them authorized three times and
-- switched clients by hand. The binding was never a security property — it was
-- a single column.
--
-- `org_id` STAYS, and stays the primary org: revocation, the grant list and
-- every token issued before this migration key on it. A row with
-- org_scope='list' and org_ids NULL therefore means exactly what it meant
-- yesterday — [org_id] — which is why no token has to be re-issued and there is
-- no dual-accept branch to remove later.
--
-- What the two new columns are NOT: authoritative. `memberships` decides, on
-- every request, exactly as it does today for the single-org case (the token
-- deliberately carries no role either). The stored set is an upper bound the
-- membership check intersects with, so leaving an organization takes effect
-- immediately in both modes rather than at the next token expiry.
ALTER TABLE oauth_codes  ADD COLUMN IF NOT EXISTS org_scope TEXT NOT NULL DEFAULT 'list';
ALTER TABLE oauth_codes  ADD COLUMN IF NOT EXISTS org_ids   TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS org_scope TEXT NOT NULL DEFAULT 'list';
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS org_ids   TEXT;
