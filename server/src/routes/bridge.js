'use strict';
/*
 * OpsCat Bridge (docs/BRIDGE.md) — the incident war room / situation room on
 * the LiveKit API: ONE LiveKit room per bridge, breakouts are server-side
 * subscription groups, never separate media rooms. Phase-1 backend slice:
 * lifecycle, access tokens, presence mirror (LiveKit webhooks), feed, SSE.
 * Media flows client <-> LiveKit only; this file never touches audio/video.
 *
 *   POST  /incidents/:id/room      open (idempotent)                   lead+
 *   GET   /incidents/:id/room      peek (does a room exist?)           member
 *   GET   /room/:id                state: groups, participants, media  member
 *   POST  /room/:id/token          short-lived LiveKit access token    member
 *   POST  /room/:id/groups         create a breakout                   member
 *   PATCH /room/:id/groups/:gid    rename / close a breakout           member
 *   POST  /room/:id/join           move self to a group (null=lobby)   member
 *   GET   /room/:id/feed           feed page (?after=<id> cursor)      member
 *   POST  /room/:id/close          close the room                      lead+
 *   POST  /hooks/livekit           LiveKit webhook — no session; raw body is
 *                                  provided by index.js, signature-verified
 *
 * Gating: 503 until OPSCAT_LIVEKIT_* is configured; in the hosted cloud the
 * org's plan must additionally carry the `bridge` feature (Business+).
 * Community core (Apache-2.0): plans.hasFeature is always true there — every
 * self-hoster gets the full room, AI layer included (bring-your-own STT/LLM
 * keys via the llm.js-style provider settings).
 */
const express = require('express');
const { AccessToken, WebhookReceiver, TrackSource } = require('livekit-server-sdk');
const { getOrgSetting } = require('../db');
// The async storage shim (docs/POSTGRES-MIGRATION-PLAN.md § Phase 4). Imported as
// `store` because `q` is already this file's statement table.
const store = require('../db/shim');
const config = require('../config');
const plans = require('../plans');
const sec = require('../security');
const voice = require('../voice');
const { now, isStr, optStr, clampInt, httpError, RateLimiter, isId } = require('../util');
const { hub } = require('./ops'); // org-scoped SSE hub (module cache, no cycle)

const router = express.Router();

const GROUP_COLORS = ['#388bfd', '#a371f7', '#d29922', '#3fb950', '#f85149', '#8b949e'];

const q = {
  incident: store.prepare('SELECT id, org_id, title, status FROM incidents WHERE id = ? AND org_id = ?'),
  roomById: store.prepare('SELECT * FROM bridges WHERE id = ? AND org_id = ?'),
  roomByIncident: store.prepare('SELECT * FROM bridges WHERE incident_id = ? AND org_id = ?'),
  roomByName: store.prepare('SELECT * FROM bridges WHERE org_id = ? AND id = ?'),
  // `bridges.incident_id` is UNIQUE, and "open" is documented as idempotent: two
  // leads pressing it at the same moment must get one room, not a 23505 that
  // Postgres would turn into a 500 (and, inside a transaction, an abort). DO
  // NOTHING + re-read makes the duplicate the normal path, and `.changes` is what
  // says whether THIS request opened the room — so the "opened the Bridge" feed
  // line and the audit row are written exactly once, by the winner.
  createRoom: store.prepare(`INSERT INTO bridges (org_id, incident_id, status, transcription, created_by, created_at)
    VALUES (?, ?, 'open', ?, ?, ?) ON CONFLICT (incident_id) DO NOTHING`),
  closeRoom: store.prepare("UPDATE bridges SET status = 'closed', closed_at = ? WHERE id = ?"),
  groups: store.prepare('SELECT * FROM bridge_groups WHERE room_id = ? AND closed_at IS NULL ORDER BY sort, id'),
  groupById: store.prepare('SELECT * FROM bridge_groups WHERE id = ? AND room_id = ?'),
  groupCount: store.prepare('SELECT COUNT(*) c FROM bridge_groups WHERE room_id = ?'),
  createGroup: store.prepare(`INSERT INTO bridge_groups (room_id, name, color, sort, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  renameGroup: store.prepare('UPDATE bridge_groups SET name = ? WHERE id = ?'),
  closeGroup: store.prepare('UPDATE bridge_groups SET closed_at = ? WHERE id = ?'),
  unassignGroup: store.prepare('UPDATE bridge_participants SET group_id = NULL WHERE room_id = ? AND group_id = ?'),
  participants: store.prepare(`SELECT p.user_id, p.group_id, p.connected, p.joined_at, p.last_seen,
      u.name, u.email, u.color FROM bridge_participants p JOIN users u ON u.id = p.user_id
    WHERE p.room_id = ? ORDER BY p.joined_at`),
  upsertParticipant: store.prepare(`INSERT INTO bridge_participants (room_id, user_id, group_id, connected, joined_at, last_seen)
    VALUES (@room_id, @user_id, @group_id, @connected, @ts, @ts)
    ON CONFLICT(room_id, user_id) DO UPDATE SET group_id = @group_id, connected = @connected, last_seen = @ts`),
  setConnected: store.prepare(`UPDATE bridge_participants SET connected = ?, last_seen = ?,
    left_at = CASE WHEN ? = 0 THEN CAST(? AS BIGINT) ELSE NULL END WHERE room_id = ? AND user_id = ?`),
  getParticipant: store.prepare('SELECT * FROM bridge_participants WHERE room_id = ? AND user_id = ?'),
  insFeed: store.prepare(`INSERT INTO bridge_feed (room_id, group_id, user_id, kind, severity, body, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  feedAfter: store.prepare('SELECT * FROM bridge_feed WHERE room_id = ? AND id > ? ORDER BY id LIMIT ?'),
  feedTail: store.prepare('SELECT * FROM bridge_feed WHERE room_id = ? ORDER BY id DESC LIMIT ?'),
  user: store.prepare('SELECT id, name, email FROM users WHERE id = ?'),
  orgPlan: store.prepare('SELECT plan FROM organizations WHERE id = ?'),
};

const enabled = () => !!(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
const roomName = (room) => `br-${room.org_id}-${room.id}`;
const displayName = (u) => (u && (u.name || u.email)) || 'someone';

let _receiver = null;
function receiver() {
  if (!_receiver) _receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);
  return _receiver;
}

// The feature gate mirrors the UI model: infrastructure unset → 503 for every
// org; plan without the feature → 403 (only ever bites in the cloud edition).
async function gate(req, res, next) {
  if (!enabled()) return httpError(res, 503, 'bridge not configured');
  const plan = ((await q.orgPlan.get(req.orgId)) || {}).plan || 'free';
  if (!plans.hasFeature(plan, 'bridge')) {
    return httpError(res, 403, 'plan does not include the bridge');
  }
  next();
}

async function getRoom(req, res) {
  const id = clampInt(req.params.id, 1, 2 ** 31, 0);
  const room = id ? await q.roomById.get(id, req.orgId) : null;
  if (!room) { httpError(res, 404, 'room not found'); return null; }
  return room;
}

async function feedItem(room, { groupId = null, userId = null, kind, severity = 'info', body, meta = null }) {
  const ts = now();
  const id = await q.insFeed.insert(room.id, groupId, userId, kind, severity, body,
    meta ? JSON.stringify(meta) : '{}', ts);
  const item = { id, room_id: room.id, group_id: groupId, user_id: userId,
    kind, severity, body, meta: meta || {}, created_at: ts };
  hub.broadcast('bridge.feed', { roomId: room.id, item }, room.org_id);
  return item;
}

async function broadcastPresence(room) {
  hub.broadcast('bridge.presence', { roomId: room.id, participants: await q.participants.all(room.id) }, room.org_id);
}
async function broadcastGroups(room) {
  hub.broadcast('bridge.groups', { roomId: room.id, groups: await q.groups.all(room.id) }, room.org_id);
}

async function roomState(room) {
  return {
    room: { id: room.id, incidentId: room.incident_id, status: room.status,
      transcription: !!room.transcription, createdAt: room.created_at, closedAt: room.closed_at },
    groups: await q.groups.all(room.id),
    participants: await q.participants.all(room.id),
    livekit: { url: config.livekit.url, room: roomName(room) },
    // can transcription actually run? (a provider is configured for this org
    // or the platform) — the UI turns the chip into a setup hint when false
    stt: !!voice.resolveConfig(room.org_id),
  };
}

// ── lifecycle ───────────────────────────────────────────────────────────────
router.post('/incidents/:id/room', sec.requireSession, gate, sec.requireRole('lead'), async (req, res) => {
  const incId = clampInt(req.params.id, 1, 2 ** 31, 0);
  const inc = incId ? await q.incident.get(incId, req.orgId) : null;
  if (!inc) return httpError(res, 404, 'incident not found');
  let room = await q.roomByIncident.get(inc.id, req.orgId);
  if (!room) {
    // transcription default is ON (docs/BRIDGE.md §7.2); an org opts
    // out with the org setting bridge_transcription = '0'.
    const tx = getOrgSetting(req.orgId, 'bridge_transcription') === '0' ? 0 : 1;
    const opened = (await q.createRoom.run(req.orgId, inc.id, tx, req.user.id, now())).changes === 1;
    // Read back by incident, not by lastInsertRowid: on a DO NOTHING conflict the
    // driver reports the connection's previous insert, which is some other row.
    room = await q.roomByIncident.get(inc.id, req.orgId);
    if (opened) {
      await feedItem(room, { userId: req.user.id, kind: 'system',
        body: `${displayName(req.user)} opened the Bridge` });
      sec.audit(req.user.id, 'bridge_open', `room ${room.id} for INC-${2000 + inc.id}`, req.orgId);
    }
  }
  res.json(await roomState(room));
});

router.get('/incidents/:id/room', sec.requireSession, gate, async (req, res) => {
  const incId = clampInt(req.params.id, 1, 2 ** 31, 0);
  const inc = incId ? await q.incident.get(incId, req.orgId) : null;
  if (!inc) return httpError(res, 404, 'incident not found');
  const room = await q.roomByIncident.get(inc.id, req.orgId);
  res.json(room ? await roomState(room) : { room: null });
});

router.get('/room/:id', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (room) res.json(await roomState(room));
});

router.post('/room/:id/close', sec.requireSession, gate, sec.requireRole('lead'), async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  if (room.status !== 'closed') {
    await q.closeRoom.run(now(), room.id);
    await feedItem(room, { userId: req.user.id, kind: 'system',
      body: `${displayName(req.user)} closed the Bridge` });
    sec.audit(req.user.id, 'bridge_close', `room ${room.id}`, req.orgId);
  }
  res.json({ ok: true });
});

// ── media access ────────────────────────────────────────────────────────────
router.post('/room/:id/token', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  if (room.status !== 'open') return httpError(res, 409, 'room is closed');
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: String(req.user.id),
    name: displayName(req.user),
    ttl: '15m',
  });
  at.addGrant({ room: roomName(room), roomJoin: true, canPublish: true,
    canSubscribe: true, canPublishData: true });
  res.json({ url: config.livekit.url, room: roomName(room), token: await at.toJwt() });
});

// ── breakouts ───────────────────────────────────────────────────────────────
router.post('/room/:id/groups', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  if (room.status !== 'open') return httpError(res, 409, 'room is closed');
  const name = req.body && req.body.name;
  if (!isStr(name, 60)) return httpError(res, 400, 'name required (max 60 chars)');
  const n = (await q.groupCount.get(room.id)).c;
  const gid = await q.createGroup.insert(room.id, name.trim(), GROUP_COLORS[n % GROUP_COLORS.length], n, req.user.id, now());
  await feedItem(room, { userId: req.user.id, groupId: gid, kind: 'system',
    body: `Breakout ${name.trim()} created by ${displayName(req.user)}` });
  await broadcastGroups(room);
  res.json({ group: await q.groupById.get(gid, room.id) });
});

router.patch('/room/:id/groups/:gid', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  const gid = clampInt(req.params.gid, 1, 2 ** 31, 0);
  const group = gid ? await q.groupById.get(gid, room.id) : null;
  if (!group) return httpError(res, 404, 'group not found');
  const { name, closed } = req.body || {};
  if (!optStr(name, 60)) return httpError(res, 400, 'invalid name');
  if (name && name.trim()) await q.renameGroup.run(name.trim(), group.id);
  if (closed === true && !group.closed_at) {
    await q.closeGroup.run(now(), group.id);
    await q.unassignGroup.run(room.id, group.id); // members fall back to the lobby
    await feedItem(room, { userId: req.user.id, kind: 'system',
      body: `Breakout ${group.name} closed by ${displayName(req.user)}` });
    await broadcastPresence(room);
  }
  await broadcastGroups(room);
  res.json({ group: await q.groupById.get(group.id, room.id) });
});

router.post('/room/:id/join', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  if (room.status !== 'open') return httpError(res, 409, 'room is closed');
  let groupId = null;
  if (req.body && req.body.groupId != null) {
    groupId = clampInt(req.body.groupId, 1, 2 ** 31, 0);
    const g = groupId ? await q.groupById.get(groupId, room.id) : null;
    if (!g || g.closed_at) return httpError(res, 404, 'group not found');
  }
  const before = await q.getParticipant.get(room.id, req.user.id);
  const connected = before ? before.connected : 0;
  await q.upsertParticipant.run({ room_id: room.id, user_id: req.user.id, group_id: groupId, connected, ts: now() });
  if (!before || before.group_id !== groupId) {
    const target = groupId ? (await q.groupById.get(groupId, room.id)).name : 'the Lobby';
    await feedItem(room, { userId: req.user.id, groupId, kind: 'system',
      body: `${displayName(req.user)} ${before ? 'moved to' : 'joined'} ${target}` });
  }
  await broadcastPresence(room);
  res.json({ ok: true, groupId });
});

// ── feed ────────────────────────────────────────────────────────────────────
router.get('/room/:id/feed', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  const limit = clampInt(req.query.limit, 1, 500, 100);
  const after = clampInt(req.query.after, 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = after ? await q.feedAfter.all(room.id, after, limit)
    : (await q.feedTail.all(room.id, limit)).reverse();
  res.json({ items: rows.map((r) => ({ ...r, meta: JSON.parse(r.meta || '{}') })) });
});

// ── transcription (docs/BRIDGE.md phase 2, `chunked` mode) ──────────────────
// Browsers cut speech into VAD-bounded chunks (their OWN mic — pristine local
// signal, no server-side decode) and post them here; we hand the audio to the
// org's voice provider and write the text into the feed, attributed to the
// speaker's current group. index.js mounts express.raw for audio/* on
// /api/room so req.body is the raw Buffer.
const sttLimiter = new RateLimiter({ perMinute: 40, burst: 12 }); // per user+room

router.post('/room/:id/transcribe', sec.requireSession, gate, async (req, res) => {
  const room = await getRoom(req, res);
  if (!room) return;
  if (room.status !== 'open') return httpError(res, 409, 'room is closed');
  if (!room.transcription) return httpError(res, 409, 'transcription is off for this room');
  if (!Buffer.isBuffer(req.body) || req.body.length < 1500) {
    return httpError(res, 400, 'audio chunk required');
  }
  if (!sttLimiter.allow(`${room.id}:${req.user.id}`)) {
    return httpError(res, 429, 'rate limit exceeded');
  }
  let text;
  try {
    text = await voice.transcribe(room.org_id, req.body, req.headers['content-type']);
  } catch (e) {
    return httpError(res, e.unconfigured ? 503 : 502, String(e.message).slice(0, 300));
  }
  text = text.trim().slice(0, 600);
  if (!text) return res.json({ ok: true, text: null }); // silence / filler
  const p = await q.getParticipant.get(room.id, req.user.id);
  const durMs = clampInt(req.query.dur, 0, 60000, 0);
  const item = await feedItem(room, {
    userId: req.user.id,
    groupId: p ? p.group_id : null,
    kind: 'transcript',
    body: text,
    meta: durMs ? { durMs } : null,
  });
  res.json({ ok: true, text, id: item.id });
});

// ── LiveKit webhook: presence mirror + share events ─────────────────────────
// index.js mounts express.raw() on this path — signature verification needs
// the untouched body. Auth is the JWT in the Authorization header, signed with
// the LiveKit API secret; there is deliberately no session here.
router.post('/hooks/livekit', async (req, res) => {
  if (!enabled()) return httpError(res, 503, 'bridge not configured');
  let ev;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    ev = await receiver().receive(raw, req.headers.authorization);
  } catch (e) {
    return httpError(res, 401, 'bad webhook signature');
  }
  // The room name is `br-<orgUuid>-<roomId>` (see roomName above) and the
  // participant identity IS the user's uuid. Both used to be integers, and both
  // failure modes are silent: a non-matching name answers "not one of ours" and a
  // parseInt'd uuid is NaN, so presence would simply never mirror while every
  // webhook still returned 200.
  const m = /^br-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i
    .exec((ev.room && ev.room.name) || '');
  if (!m) return res.json({ ok: true }); // not one of ours
  const room = await q.roomByName.get(m[1], parseInt(m[2], 10));
  if (!room) return res.json({ ok: true });
  const identity = (ev.participant && ev.participant.identity) || '';
  const user = isId(identity) ? await q.user.get(identity) : null;
  const ts = now();

  if (ev.event === 'participant_joined' && user) {
    const before = await q.getParticipant.get(room.id, user.id);
    await q.upsertParticipant.run({ room_id: room.id, user_id: user.id,
      group_id: before ? before.group_id : null, connected: 1, ts });
    await feedItem(room, { userId: user.id, kind: 'system', body: `${displayName(user)} connected` });
    await broadcastPresence(room);
  } else if (ev.event === 'participant_left' && user) {
    await q.setConnected.run(0, ts, 0, ts, room.id, user.id);
    await feedItem(room, { userId: user.id, kind: 'system', body: `${displayName(user)} disconnected` });
    await broadcastPresence(room);
  } else if (ev.event === 'track_published' && user && ev.track
      // the receiver parses protobuf JSON, so source arrives as the ENUM
      // number — the string form is kept as a guard against SDK changes
      && (ev.track.source === TrackSource.SCREEN_SHARE
        || String(ev.track.source) === 'SCREEN_SHARE')) {
    const p = await q.getParticipant.get(room.id, user.id);
    const g = p && p.group_id ? await q.groupById.get(p.group_id, room.id) : null;
    await feedItem(room, { userId: user.id, groupId: g ? g.id : null, kind: 'system',
      body: `${displayName(user)} started sharing${g ? ` in ${g.name}` : ''}` });
  }
  res.json({ ok: true });
});

module.exports = router;
