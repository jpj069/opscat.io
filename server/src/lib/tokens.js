'use strict';
/**
 * The credential namespace: every secret OpsCat mints, and the prefix that says
 * what it is.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * There were SEVEN string literals across five route files and no single place
 * that listed them, so the namespace existed only in people's heads. That is
 * how it came to be inconsistent in the first place — the letter names the
 * CREDENTIAL, and nothing stopped the next one from being `ocsa_` or a bare hex
 * string. A prefix is user-visible surface: an operator pastes it into a
 * systemd env file, a secret scanner matches it, a support ticket quotes it. It
 * deserves the same "one description, not five copies" treatment as the API
 * contract and the storage seam.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * `oc` + ONE letter + `_`. One letter, because a two-letter prefix collides
 * with a one-letter one under every anchored pattern anyone writes: `ocha_`
 * would be matched by every grep, log filter and scanner rule for `och_`, which
 * is the heartbeat token. That is not hypothetical tidiness — it is why the
 * Sensor Agent's key is `ocs_` and not `ocsa_`.
 *
 * ── Renaming one is nearly free, and it is worth knowing why ─────────────────
 *
 * Nothing authenticates on the prefix. Every lookup in the app is
 * `WHERE token_hash = sha256(presented)` — `requireProbeKey`, `requireAgentToken`,
 * the API-key guard, the heartbeat ping. So an old credential keeps working
 * forever after a prefix change, with no dual-accept branch to write and no
 * migration to run: the prefix only labels newly minted secrets.
 *
 * `ocl_` (log collector) rather than the more obvious `occ_` for the same
 * family of reasons, one step further out. Both are legal under the rule and
 * `occ_` was free — but `occ_` and `ock_` differ by ONE letter and live in
 * exactly the same places: a systemd env file, a screenshot, a support ticket,
 * a line someone reads aloud. Anchored patterns tell them apart perfectly and
 * humans do not, and every credential mistake this namespace has ever produced
 * was a human one.
 *
 * That is what made `ocp_` → `ocs_` (probe key → Sensor Agent key) a decision
 * about NAMING rather than about compatibility. `docs/SENSOR-AGENTS.md` §1 had
 * parked it with `synthetic_*` and `--probe` as a "stable technical
 * identifier"; that was the wrong bucket. A table name is internal, a flag is
 * internal, a credential a human copies is not.
 */
const crypto = require('crypto');

/**
 * kind → prefix. The comment is the documentation; there is no second table.
 * Adding a credential means adding a line HERE, which is the point.
 */
const PREFIX = {
  apiKey: 'ock_',       // ingest API key — SDK, OTLP, Sentry, webhooks
  agentToken: 'oca_',   // Host Agent — heartbeat, CPU/RAM/disk (Assets › Agents)
  sensorKey: 'ocs_',    // Sensor Agent — synthetic checks (Synthetics › Sensor Agents)
  collectorKey: 'ocl_', // Syslog Collector — the relay-side receiver (Settings › Collectors)
  heartbeat: 'och_',    // heartbeat ping URL — the token IS the URL
  tunnelKey: 'oct_',    // Syslog tunnel gateway — PLATFORM infrastructure, not a tenant's
  mcpClient: 'ocm_',    // MCP OAuth client id
  mcpAccess: 'ocm_at_', // MCP OAuth access token
  mcpRefresh: 'ocm_rt_', // MCP OAuth refresh token
};

/**
 * Prefixes a kind ALSO answers to, for anything that reads a credential rather
 * than mints one. Never used for authentication (that is a hash lookup) — it
 * exists so a validator cannot reject a credential this product itself issued.
 */
const LEGACY = {
  sensorKey: ['ocp_'],  // pre-2026-08 probe keys; still live on every node that has not been re-provisioned
};

/** @param {keyof PREFIX} kind @param {number} [bytes] */
function mint(kind, bytes = 24) {
  const p = PREFIX[kind];
  if (!p) throw new Error(`mint: unknown credential kind "${kind}"`);
  return p + crypto.randomBytes(bytes).toString('hex');
}

/**
 * A pattern matching this kind — its current prefix and any legacy one, then
 * hex. For VALIDATION of a value about to be interpolated somewhere dangerous
 * (cloud-init, an env file), never for deciding whether a caller is authorised.
 * @param {keyof PREFIX} kind
 */
function pattern(kind) {
  if (!PREFIX[kind]) throw new Error(`pattern: unknown credential kind "${kind}"`);
  // Every prefix is `oc[a-z]_` or `ocm_xx_` — nothing in them is a regex
  // metacharacter, so they go in verbatim. Keep it that way: a prefix that
  // needed escaping would be a prefix that breaks every grep too.
  const all = [PREFIX[kind]].concat(LEGACY[kind] || []);
  return new RegExp(`^(?:${all.join('|')})[a-f0-9]{16,128}$`);
}

module.exports = { PREFIX, LEGACY, mint, pattern };
