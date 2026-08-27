-- Stage 3: the WireGuard tunnel, which is what makes plain UDP usable again.
--
-- Inside a tunnel there is no token in the message at all. The kernel binds the
-- inner source address to a peer's public key at the crypto layer, so "whose
-- logs are these?" is answered by the address the packet arrived from — which
-- an attacker cannot forge without the peer's private key. That is the whole
-- reason this mode exists: an appliance that can only speak plain UDP/514 has
-- no way to carry a credential, and no amount of product design changes that.
--
-- One tunnel per endpoint, so these are columns rather than a table: there is
-- no second thing to point at, and a join would only be able to answer the same
-- question the row already does.
ALTER TABLE syslog_endpoints
  ADD COLUMN IF NOT EXISTS peer_pubkey TEXT,
  ADD COLUMN IF NOT EXISTS tunnel_ip   TEXT;

-- The allocation invariant, and it is the ONLY thing standing between two
-- tenants and each other's logs: an inner address identifies exactly one
-- endpoint, across every organisation. A unique index rather than a check in
-- JS, because the allocation reads the highest address in use and writes the
-- next one — two of those running at once pick the same number, and the loser
-- has to be refused by the database rather than by hoping.
CREATE UNIQUE INDEX IF NOT EXISTS idx_syslog_tunnel_ip
  ON syslog_endpoints (tunnel_ip) WHERE tunnel_ip IS NOT NULL;
