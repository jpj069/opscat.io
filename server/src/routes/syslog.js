'use strict';
/*
 * Syslog collector endpoints — the record a customer creates for each relay.
 *
 * ── Why there is no new credential kind here ────────────────────────────────
 *
 * The collector authenticates with an ordinary `api_keys` row carrying the new
 * `collector` scope. That was a decision with an alternative: a table of its
 * own, with its own hash column and its own guard. `api_keys` already provides
 * the hash lookup, the per-key rate limit, `last_used_at`, revocation and the
 * org stamp — and `pipeline.ingestLogs` already records the key NAME as
 * `logs.source`, so "which site is sending too much" is answerable with no new
 * code at all. A second credential kind would have re-implemented five things
 * to gain none.
 *
 * Two things the scope buys that a plain `ingest` key would not:
 *
 *   * **Blast radius.** An `ingest` key may also post events and webhooks. A
 *     key sitting in an env file on a customer's relay should do exactly one
 *     thing, and `collector` is that one thing.
 *   * **A budget of its own.** `apiKeys` is 2 on Free and 10 on Pro. Without
 *     the split in plans.js a customer with eight sites would have two keys
 *     left for everything else.
 *
 * ── `collector` is NOT in the generic key-minting route on purpose ──────────
 *
 * `routes/admin.js` refuses it (its `allowed` list is unchanged), because a
 * collector key with no `syslog_endpoints` row is a live credential belonging
 * to nothing — the same shape as the orphaned `agents` row that `e2e-sensors`
 * exists to catch. The only way to get one is through this file, which writes
 * both rows in one transaction.
 */
const express = require('express');
const q = require('../db/shim');
const { now, sha256, isStr } = require('../util');
const sec = require('../security');
const plans = require('../plans');
const tokens = require('../lib/tokens');
const config = require('../config');
const { snippets } = require('../lib/syslog-config');
const wg = require('../lib/wireguard');
const logStore = require('../db/log-store');
const { createRouteRegistrar, ApiProblem } = require('../lib/route-schema');
const S = require('../schemas/syslog');

const router = express.Router();
/* Session OR an `api`-scoped bearer key, same as every other app router: these
 * endpoints are configuration, and configuration has to be drivable from a
 * script as well as from the browser. It is what puts `req.user`, `req.org` and
 * `req.orgId` in place, which every handler below relies on. */
router.use(sec.requireSessionOrToken);
const route = createRouteRegistrar(router, '/api/syslog');

/* `last_seen_at` is READ from the key rather than stored on the endpoint:
 * `requireApiKey` already touches `api_keys.last_used_at` on every request, so
 * a column here would be a second write on the hottest path answering the same
 * question — and the two would disagree the first time one of them failed. */
const qList = q.prepare(`SELECT e.*, k.prefix AS key_prefix, k.last_used_at
  FROM syslog_endpoints e LEFT JOIN api_keys k ON k.id = e.api_key_id AND k.active = 1
  WHERE e.org_id = ? ORDER BY e.id`);
const qOne = q.prepare(`SELECT e.*, k.prefix AS key_prefix, k.last_used_at
  FROM syslog_endpoints e LEFT JOIN api_keys k ON k.id = e.api_key_id AND k.active = 1
  WHERE e.id = ? AND e.org_id = ?`);

const MODES = ['collector', 'managed', 'tunnel'];
const view = (r) => ({
  id: Number(r.id),
  name: r.name,
  mode: MODES.includes(r.mode) ? r.mode : 'collector',
  // Public halves only. A peer's PUBLIC key is not a secret — it is in the
  // customer's own config file — and the inner address is what the whole tunnel
  // mode is about, so both belong on the screen.
  peerPublicKey: r.peer_pubkey === undefined ? null : r.peer_pubkey,
  tunnelIp: r.tunnel_ip === undefined ? null : r.tunnel_ip,
  devicePrefix: r.device_prefix === undefined ? null : r.device_prefix,
  enabled: !!r.enabled,
  keyPrefix: r.key_prefix || null,
  lastSeenAt: r.last_used_at === undefined ? null : r.last_used_at,
  createdAt: Number(r.created_at),
});

/* Everything the generator needs that comes from the instance rather than from
 * the endpoint. One helper so the four call sites cannot disagree about which
 * gateway they are naming. */
const gw = () => ({
  baseUrl: config.baseUrl,
  syslogHost: config.syslogHost,
  syslogPort: config.syslogPort,
  pen: config.syslogPen,
  tunnelNet: config.tunnelNet,
  tunnelEndpoint: config.tunnelEndpoint,
  tunnelPubkey: config.tunnelPubkey,
  tunnelServerIp: wg.serverIp(config.tunnelNet),
});

/** True when this instance actually runs a tunnel gateway. */
const tunnelReady = () => !!(config.tunnelNet && config.tunnelEndpoint && config.tunnelPubkey);

/**
 * `managed` is offered only where a gateway has actually been configured.
 *
 * A community instance has none, and printing `syslog.:6514` — or worse, a
 * plausible hostname belonging to our cloud — would be a configuration that
 * silently sends nothing, or somebody else's logs somewhere they did not
 * choose. The refusal is at the WRITE, so an endpoint can never be stored in a
 * mode whose snippets cannot be rendered.
 */
function checkMode(mode) {
  if (mode === undefined || mode === null) return 'collector';
  if (!MODES.includes(mode)) throw new ApiProblem(400, 'bad mode');
  if (mode === 'managed' && !config.syslogHost) {
    throw new ApiProblem(400, 'this instance has no managed syslog endpoint configured');
  }
  /* All three of net/endpoint/public key or none. Two out of three renders a
   * configuration the customer cannot use — an inner network with nothing to
   * dial, or an endpoint with no key to trust — and the failure would be theirs
   * to discover rather than ours. */
  if (mode === 'tunnel' && !tunnelReady()) {
    throw new ApiProblem(400, 'this instance has no syslog tunnel configured');
  }
  return mode;
}

/**
 * Allocate the next inner address, INSIDE the caller's transaction.
 *
 * It reads what is taken and proposes the lowest free one, which is a race by
 * construction: two of these running at once read the same set and propose the
 * same address. That is fine and deliberate — the unique index (migration 031)
 * is what actually decides, and the loser's whole transaction rolls back. The
 * retry is here rather than at the call site because the call site would have
 * to know that a 23505 on THIS column means "try again" while one on another
 * means something else entirely.
 */
async function allocateIp() {
  const rows = await q.prepare(
    'SELECT tunnel_ip FROM syslog_endpoints WHERE tunnel_ip IS NOT NULL').all();
  const ip = wg.nextIp(config.tunnelNet, rows.map((r) => r.tunnel_ip));
  if (!ip) throw new ApiProblem(507, 'the tunnel address pool is exhausted');
  return ip;
}

/** A peer key is interpolated into two config files; see lib/wireguard.js. */
function checkPeerKey(k, required) {
  if (k === undefined || k === null || k === '') {
    if (required) throw new ApiProblem(400, 'peerPublicKey required for a tunnel endpoint');
    return null;
  }
  if (!wg.isPeerKey(k)) throw new ApiProblem(400, 'peerPublicKey must be a WireGuard public key');
  return k;
}

/** Mint a collector key and write its api_keys row. Returns {id, key}. */
async function mintKey(orgId, name, userId) {
  const key = tokens.mint('collectorKey');
  const id = await q.prepare(`INSERT INTO api_keys
    (org_id, name, prefix, key_hash, scopes, role, active, created_by, created_at)
    VALUES (?, ?, ?, ?, 'collector', 'analyst', 1, ?, ?)`)
    .insert(orgId, name, key.slice(0, 12), sha256(key), userId, now());
  return { id, key };
}

route({
  method: 'get', path: '/endpoints',
  summary: 'List syslog collector endpoints',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  responses: { 200: S.Endpoint.array() },
}, async ({ req }) => (await qList.all(req.orgId)).map(view));

route({
  method: 'post', path: '/endpoints',
  summary: 'Create a syslog collector endpoint',
  description: 'Mints a collector key and returns it ONCE, together with ready-to-paste '
    + 'installation and relay snippets. The key is not retrievable afterwards.',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  body: S.CreateBody,
  responses: { 200: S.EndpointWithConfig, 400: S.ErrorResponse, 402: S.ErrorResponse },
}, async ({ req }) => {
  const { name, devicePrefix, collectorHost } = req.body || {};
  if (!isStr(name, 100)) throw new ApiProblem(400, 'name required');
  const mode = checkMode((req.body || {}).mode);
  const peerKey = checkPeerKey((req.body || {}).peerPublicKey, mode === 'tunnel');
  if (devicePrefix !== undefined && devicePrefix !== null && !isStr(devicePrefix, 32)) {
    throw new ApiProblem(400, 'devicePrefix must be a short string');
  }

  /* Both rows or neither. A key written without its endpoint is a live
   * credential for a thing that does not exist, and nothing in the UI would
   * ever show it again — so the plan refusal has to roll the key back, not
   * merely stop after it. */
  let created = null;
  let key = null;
  await q.withTx(async () => {
    const minted = await mintKey(req.orgId, name.trim(), req.user.id);
    /* Allocated inside the same transaction as the row that holds it, so a plan
     * refusal below does not leak an address the way it would have leaked a key.
     * The unique index is what actually decides; see allocateIp(). */
    const ip = mode === 'tunnel' ? await allocateIp() : null;
    const r = await plans.insertWithinLimit(req.orgId, req.org.plan, 'syslogEndpoints',
      `INSERT INTO syslog_endpoints (org_id, name, api_key_id, device_prefix, enabled, mode,
         peer_pubkey, tunnel_ip, created_by, created_at)
       SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?`,
      [req.orgId, name.trim(), minted.id, devicePrefix || null, mode, peerKey, ip,
        req.user.id, now()],
      '', { returningId: true });
    if (r.refused) {
      throw new ApiProblem(402,
        `plan limit reached (${r.used}/${r.limit} syslogEndpoints) — upgrade your plan to add more`);
    }
    key = minted.key;
    created = await qOne.get(r.id, req.orgId);
  });

  sec.audit(req.user.id, 'syslog_endpoint_create', name.trim(), req.orgId);
  return Object.assign(view(created), {
    key,
    snippets: snippets(Object.assign(gw(),
      { key, mode, collectorHost, name: created.name, tunnelIp: created.tunnel_ip })),
  });
});

route({
  method: 'patch', path: '/endpoints/:id',
  summary: 'Rename an endpoint, change its device prefix, or switch it off',
  description: 'Disabling refuses the endpoint\'s ingest without destroying its key, '
    + 'so a noisy site can be silenced and switched back on without touching the relay.',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.PatchBody,
  responses: { 200: S.Endpoint, 400: S.ErrorResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const e = await qOne.get(req.params.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'endpoint not found');
  const { name, devicePrefix, enabled, mode, peerPublicKey } = req.body || {};
  if (name !== undefined && !isStr(name, 100)) throw new ApiProblem(400, 'bad name');
  /* Switching mode is allowed and does not touch the key: the same credential
   * authenticates both paths, so a customer moving off their own collector
   * re-pastes a configuration rather than re-keying a relay. */
  const nextMode = mode === undefined ? e.mode : checkMode(mode);
  const nextPeer = checkPeerKey(peerPublicKey,
    // Becoming a tunnel needs a key; already being one and not sending a new key
    // is an ordinary partial update, so the row's own key stands.
    nextMode === 'tunnel' && !e.peer_pubkey);
  /* An address is allocated when an endpoint BECOMES a tunnel and never
   * released while it still is one. Re-allocating on every PATCH would hand the
   * customer a new inner address for a rename, and their config file — which
   * pins it in `Address =` — would silently stop matching. */
  const nextIp = nextMode === 'tunnel' && !e.tunnel_ip ? await allocateIp() : null;
  if (devicePrefix !== undefined && devicePrefix !== null && !isStr(devicePrefix, 32)) {
    throw new ApiProblem(400, 'bad devicePrefix');
  }
  /* COALESCE keeps a field that was not sent — a PATCH that names only
   * `enabled` must not null the device prefix. `?::text` because Postgres
   * cannot infer the type of a bare parameter inside COALESCE. */
  await q.prepare(`UPDATE syslog_endpoints
    SET name = COALESCE(?::text, name),
        device_prefix = CASE WHEN ?::int = 1 THEN ?::text ELSE device_prefix END,
        enabled = COALESCE(?::int, enabled),
        mode = COALESCE(?::text, mode),
        peer_pubkey = COALESCE(?::text, peer_pubkey),
        tunnel_ip = COALESCE(?::text, tunnel_ip)
    WHERE id = ? AND org_id = ?`)
    .run(name === undefined ? null : name.trim(),
      devicePrefix === undefined ? 0 : 1, devicePrefix || null,
      enabled === undefined ? null : (enabled ? 1 : 0),
      mode === undefined ? null : mode,
      nextPeer, nextIp,
      e.id, req.orgId);
  // The key's name is what lands in `logs.source`, so a rename has to reach it
  // or the endpoint and its own log lines stop agreeing.
  if (name !== undefined && e.api_key_id) {
    await q.prepare('UPDATE api_keys SET name = ? WHERE id = ? AND org_id = ?')
      .run(name.trim(), e.api_key_id, req.orgId);
  }
  sec.audit(req.user.id, 'syslog_endpoint_update', e.name, req.orgId);
  return view(await qOne.get(e.id, req.orgId));
});

route({
  method: 'post', path: '/endpoints/:id/rotate',
  summary: 'Issue a new collector key for this endpoint',
  description: 'The previous key stops working immediately. Returns the new key ONCE.',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.ConfigQuery,
  responses: { 200: S.EndpointWithConfig, 404: S.ErrorResponse },
}, async ({ req }) => {
  const e = await qOne.get(req.params.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'endpoint not found');
  let key = null;
  await q.withTx(async () => {
    // Deactivated, not deleted: `logs.source` and the audit trail still refer to
    // it, and a deleted row would make yesterday's lines unattributable.
    if (e.api_key_id) {
      await q.prepare('UPDATE api_keys SET active = 0 WHERE id = ? AND org_id = ?')
        .run(e.api_key_id, req.orgId);
    }
    const minted = await mintKey(req.orgId, e.name, req.user.id);
    await q.prepare('UPDATE syslog_endpoints SET api_key_id = ? WHERE id = ? AND org_id = ?')
      .run(minted.id, e.id, req.orgId);
    key = minted.key;
  });
  sec.audit(req.user.id, 'syslog_endpoint_rotate', e.name, req.orgId);
  return Object.assign(view(await qOne.get(e.id, req.orgId)), {
    key,
    snippets: snippets(Object.assign(gw(),
      { key, mode: e.mode, collectorHost: req.body?.collectorHost, name: e.name,
        tunnelIp: e.tunnel_ip })),
  });
});

route({
  method: 'get', path: '/endpoints/:id/config',
  summary: 'Configuration snippets for an endpoint',
  description: 'The key is NOT included — it is retrievable only when minted. The blocks '
    + 'render a placeholder in its place.',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, query: S.ConfigQuery,
  responses: { 200: S.Snippets, 404: S.ErrorResponse },
}, async ({ req }) => {
  const e = await qOne.get(req.params.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'endpoint not found');
  const host = typeof req.query.collectorHost === 'string' ? req.query.collectorHost : undefined;
  return snippets(Object.assign(gw(),
    { key: null, mode: e.mode, collectorHost: host, name: e.name, tunnelIp: e.tunnel_ip }));
});

route({
  method: 'get', path: '/endpoints/:id/throughput',
  summary: 'Lines per UTC day for one endpoint',
  description: 'Answers "which site is sending too much" from the key name every line '
    + 'already carries — there is no per-endpoint counter anywhere, and there does not '
    + 'need to be one.',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, query: S.ThroughputQuery,
  responses: { 200: S.Throughput, 404: S.ErrorResponse },
}, async ({ req }) => {
  const e = await qOne.get(req.params.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'endpoint not found');
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const since = Date.now() - days * 86400000;
  /* `logs.source` holds the KEY's name, and a rename keeps the two in step
   * (see the PATCH above) — so this reads the endpoint's CURRENT name and the
   * history follows it rather than splitting at the rename. */
  const rows = await logStore.dailyBySource({ orgId: req.orgId, source: e.name, since });
  return {
    days,
    source: e.name,
    buckets: rows.map((r) => ({ day: Number(r.bucket), lines: Number(r.c) })),
  };
});

route({
  method: 'delete', path: '/endpoints/:id',
  summary: 'Delete an endpoint and revoke its key',
  tags: ['Syslog'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam,
  responses: { 200: S.OkResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const e = await qOne.get(req.params.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'endpoint not found');
  await q.withTx(async () => {
    if (e.api_key_id) {
      await q.prepare('UPDATE api_keys SET active = 0 WHERE id = ? AND org_id = ?')
        .run(e.api_key_id, req.orgId);
    }
    await q.prepare('DELETE FROM syslog_endpoints WHERE id = ? AND org_id = ?').run(e.id, req.orgId);
  });
  sec.audit(req.user.id, 'syslog_endpoint_delete', e.name, req.orgId);
  return { ok: true };
});

module.exports = router;
