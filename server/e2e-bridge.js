'use strict';
/* End-to-end check for OpsCat Bridge (docs/BRIDGE.md).
 *
 * Deliberately hermetic: the database is a throwaway file and LiveKit is never
 * contacted — access tokens are locally-signed JWTs and the webhook is a
 * locally-signed request, so this runs in CI without network and without a
 * LiveKit server. It boots the real express app on its own port and drives it
 * over HTTP exactly like the browser does (cookie session + CSRF header).
 *
 * Covers: config gating (503), role gating (lead+ vs member), plan matrix,
 * org scoping, the room lifecycle (open/idempotent/close), breakout groups
 * (create/rename/close + lobby fallback), join/move + feed lines, feed
 * pagination, token grants (room, TTL, identity, publish rights), webhook
 * signature verification -> presence mirror, and audit attribution.
 *
 *   cd server && node e2e-bridge.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-bridge-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-bridge-secret';
process.env.PORT = '3117';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_LIVEKIT_URL = 'wss://rt.e2e.test';
process.env.OPSCAT_LIVEKIT_API_KEY = 'opscat';
process.env.OPSCAT_LIVEKIT_API_SECRET = 'e2e-livekit-secret-0123456789abcdef';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3117

const { db, addMembership } = require('./src/db');
const { hashPassword, now } = require('./src/util');
const config = require('./src/config');
const plans = require('./src/plans');
const { AccessToken } = require('livekit-server-sdk');

const BASE = 'http://127.0.0.1:3117';
const PASS = 'e2e-user-password-1';

const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

function mkUser(email, role, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const r = db.prepare(`INSERT INTO users (org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(orgId, email, email.split('@')[0], role, salt, hash, now());
  addMembership(r.lastInsertRowid, orgId, role);
  return { id: Number(r.lastInsertRowid), email };
}

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  const j = await r.json();
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, csrf: j.csrf, user: j.user, status: r.status };
}

async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
}

// A signed LiveKit webhook request, exactly like the sidecar sends it: the
// Authorization header is a JWT (API key/secret) carrying the body's sha256.
async function webhook(bodyObj, { tamper = false } = {}) {
  const body = JSON.stringify(bodyObj);
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, { identity: '' });
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const auth = await at.toJwt();
  const sent = tamper ? body.replace(/}$/, ' }') : body;
  const r = await fetch(`${BASE}/api/hooks/livekit`, {
    method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: auth }, body: sent,
  });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  // ── fixtures ──────────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (2, 'Other Org', 'other', 'enterprise', 'active', ?)`).run(now());
  const lead = mkUser('lead@e2e.test', 'lead', 1);
  const member = mkUser('member@e2e.test', 'analyst', 1); // analyst = lowest role
  mkUser('outsider@e2e.test', 'admin', 2);
  const incId = Number(db.prepare(`INSERT INTO incidents (org_id, title, severity, status, started_at)
    VALUES (1, 'Checkout API 500s', 85, 'investigating', ?)`).run(now()).lastInsertRowid);
  const L = await login('lead@e2e.test');
  const M = await login('member@e2e.test');
  const O = await login('outsider@e2e.test');
  chk('logins issue session + csrf', !!(L.cookie && L.csrf && M.cookie && O.cookie),
    `statuses ${L.status}/${M.status}/${O.status}`);

  // ── gates ─────────────────────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/incidents/${incId}/room`);
  chk('no session -> 401', anon.status === 401, `got ${anon.status}`);

  const savedUrl = config.livekit.url;
  config.livekit.url = '';
  const un = await call(M, 'GET', `/api/incidents/${incId}/room`);
  chk('unconfigured -> 503 "bridge not configured"', un.status === 503 && /not configured/.test(un.j?.error || ''),
    `got ${un.status} ${JSON.stringify(un.j)}`);
  config.livekit.url = savedUrl;

  chk('plan matrix: bridge on business+enterprise only',
    plans.PLANS.business.features.includes('bridge')
    && plans.PLANS.enterprise.features.includes('bridge')
    && !plans.PLANS.free.features.includes('bridge')
    && !plans.PLANS.pro.features.includes('bridge'));

  // ── lifecycle ─────────────────────────────────────────────────────────────
  const denied = await call(M, 'POST', `/api/incidents/${incId}/room`);
  chk('member cannot open (lead+) -> 403', denied.status === 403, `got ${denied.status}`);

  const opened = await call(L, 'POST', `/api/incidents/${incId}/room`);
  const roomId = opened.j?.room?.id;
  chk('lead opens the bridge', opened.status === 200 && !!roomId, `got ${opened.status}`);
  chk('room state shape', opened.j?.room?.status === 'open' && opened.j?.room?.transcription === true
    && Array.isArray(opened.j?.groups) && Array.isArray(opened.j?.participants), JSON.stringify(opened.j?.room));
  chk('livekit pointer uses br-<org>-<id>', opened.j?.livekit?.room === `br-1-${roomId}`
    && opened.j?.livekit?.url === 'wss://rt.e2e.test', JSON.stringify(opened.j?.livekit));

  const again = await call(L, 'POST', `/api/incidents/${incId}/room`);
  chk('open is idempotent (same room)', again.j?.room?.id === roomId, `got ${again.j?.room?.id}`);
  const feed0 = await call(M, 'GET', `/api/room/${roomId}/feed`);
  chk('exactly one "opened the Bridge" feed line',
    feed0.j?.items.filter((i) => /opened the Bridge/.test(i.body)).length === 1);
  chk('audit row bridge_open names the incident',
    !!db.prepare(`SELECT 1 FROM audit_log WHERE org_id = 1 AND user_id = ? AND action = 'bridge_open'
      AND detail LIKE ?`).get(lead.id, `%INC-${2000 + incId}%`));

  const peek = await call(M, 'GET', `/api/incidents/${incId}/room`);
  chk('member peek sees the room', peek.j?.room?.id === roomId);
  const foreign = await call(O, 'GET', `/api/room/${roomId}`);
  chk('other org -> 404 (scoping)', foreign.status === 404, `got ${foreign.status}`);
  const missing = await call(M, 'GET', '/api/incidents/999999/room');
  chk('unknown incident -> 404', missing.status === 404, `got ${missing.status}`);

  // ── token ─────────────────────────────────────────────────────────────────
  const tok = await call(M, 'POST', `/api/room/${roomId}/token`);
  chk('member gets an access token', tok.status === 200 && !!tok.j?.token, `got ${tok.status}`);
  const claims = tok.j?.token ? decodeJwt(tok.j.token) : {};
  chk('token identity is the user id', claims.sub === String(member.id), JSON.stringify(claims.sub));
  chk('token grants join+publish on exactly this room',
    claims.video?.room === `br-1-${roomId}` && claims.video?.roomJoin === true
    && claims.video?.canPublish === true && claims.video?.canSubscribe === true,
    JSON.stringify(claims.video));
  // the SDK signs exp but no iat — measure against the wall clock instead
  const nowS = Math.floor(Date.now() / 1000);
  chk('token TTL is 15 minutes', claims.exp > nowS + 880 && claims.exp <= nowS + 920,
    `exp in ${claims.exp - nowS}s`);

  // ── breakouts + join + feed ───────────────────────────────────────────────
  const g1 = await call(M, 'POST', `/api/room/${roomId}/groups`, { name: 'DB' });
  const g2 = await call(M, 'POST', `/api/room/${roomId}/groups`, { name: 'Network' });
  chk('members create breakouts', g1.status === 200 && g2.status === 200);
  chk('group colors cycle the palette', g1.j?.group?.color === '#388bfd' && g2.j?.group?.color === '#a371f7',
    `${g1.j?.group?.color} / ${g2.j?.group?.color}`);
  const badName = await call(M, 'POST', `/api/room/${roomId}/groups`, { name: 'x'.repeat(61) });
  chk('over-long group name -> 400', badName.status === 400, `got ${badName.status}`);

  const join1 = await call(M, 'POST', `/api/room/${roomId}/join`, { groupId: g1.j.group.id });
  chk('join a breakout', join1.status === 200 && join1.j?.groupId === g1.j.group.id);
  let feed = await call(M, 'GET', `/api/room/${roomId}/feed`);
  chk('feed line: joined <group>', feed.j.items.some((i) => /member joined DB/.test(i.body)));

  const move = await call(M, 'POST', `/api/room/${roomId}/join`, { groupId: null });
  chk('move to the lobby', move.status === 200 && move.j?.groupId === null);
  feed = await call(M, 'GET', `/api/room/${roomId}/feed`);
  chk('feed line: moved to the Lobby', feed.j.items.some((i) => /member moved to the Lobby/.test(i.body)));

  const rn = await call(M, 'PATCH', `/api/room/${roomId}/groups/${g1.j.group.id}`, { name: 'DB / Replication' });
  chk('rename breakout', rn.j?.group?.name === 'DB / Replication');

  // close a group somebody is in -> they fall back to the lobby
  await call(M, 'POST', `/api/room/${roomId}/join`, { groupId: g2.j.group.id });
  const gClose = await call(M, 'PATCH', `/api/room/${roomId}/groups/${g2.j.group.id}`, { closed: true });
  chk('close breakout', gClose.status === 200 && !!gClose.j?.group?.closed_at);
  const pRow = db.prepare('SELECT group_id FROM bridge_participants WHERE room_id = ? AND user_id = ?')
    .get(roomId, member.id);
  chk('closing a breakout drops members to the lobby', pRow && pRow.group_id === null, JSON.stringify(pRow));
  const joinClosed = await call(M, 'POST', `/api/room/${roomId}/join`, { groupId: g2.j.group.id });
  chk('joining a closed breakout -> 404', joinClosed.status === 404, `got ${joinClosed.status}`);

  const all = (await call(M, 'GET', `/api/room/${roomId}/feed?limit=500`)).j.items;
  const page1 = (await call(M, 'GET', `/api/room/${roomId}/feed?limit=2`)).j.items;
  const page2 = (await call(M, 'GET', `/api/room/${roomId}/feed?after=${all[0].id}&limit=500`)).j.items;
  chk('feed tail limit works', page1.length === 2 && page1[0].id < page1[1].id);
  chk('feed after-cursor pages forward', page2.length === all.length - 1 && page2.every((i) => i.id > all[0].id));

  // ── transcription (phase 2, chunked mode) ─────────────────────────────────
  // A local OpenAI-shaped /audio/transcriptions stub keeps this hermetic.
  const http = require('http');
  const voiceMod = require('./src/voice');
  let insightGroupId = null; // set right before the analyzer test below
  const sttStub = http.createServer((rq, rs) => {
    let n = 0;
    rq.on('data', (c) => { n += c.length; });
    rq.on('end', () => {
      rs.setHeader('content-type', 'application/json');
      if ((rq.url || '').includes('/chat/completions')) {
        // fenced on purpose — the analyzer must strip markdown around JSON
        const content = '```json\n' + JSON.stringify({ insights: [{ severity: 'critical',
          groupId: insightGroupId,
          body: 'db three is the root cause — replication lag since deploy 78d3ae2' }] }) + '\n```';
        rs.end(JSON.stringify({ choices: [{ message: { content } }] }));
      } else {
        rs.end(JSON.stringify({ text: n > 500 ? 'db three replication is lagging' : '' }));
      }
    });
  });
  await new Promise((r) => sttStub.listen(0, '127.0.0.1', r));
  const audio = Buffer.alloc(4000, 7);
  const postAudio = async (sess, p, bytes) => {
    const r = await fetch(BASE + p, { method: 'POST', body: bytes,
      headers: { cookie: sess.cookie, 'X-OpsCat-CSRF': sess.csrf, 'Content-Type': 'audio/webm' } });
    let j = null;
    try { j = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, j };
  };

  const preStt = await call(M, 'GET', `/api/room/${roomId}`);
  chk('roomState.stt is false without a provider', preStt.j?.stt === false, JSON.stringify(preStt.j?.stt));
  const noProv = await postAudio(M, `/api/room/${roomId}/transcribe`, audio);
  chk('transcribe without provider -> 503', noProv.status === 503, `got ${noProv.status}`);

  voiceMod.saveOrgConfig(1, { baseUrl: `http://127.0.0.1:${sttStub.address().port}`,
    model: 'whisper-e2e', apiKey: 'stt-key' });
  const postStt = await call(M, 'GET', `/api/room/${roomId}`);
  chk('roomState.stt flips true once configured', postStt.j?.stt === true, JSON.stringify(postStt.j?.stt));

  await call(M, 'POST', `/api/room/${roomId}/join`, { groupId: g1.j.group.id });
  const tr = await postAudio(M, `/api/room/${roomId}/transcribe?dur=1200`, audio);
  chk('speech chunk becomes a transcript', tr.status === 200 && tr.j?.text === 'db three replication is lagging',
    `got ${tr.status} ${JSON.stringify(tr.j)}`);
  feed = await call(M, 'GET', `/api/room/${roomId}/feed?limit=500`);
  const trItem = feed.j.items.find((i) => i.kind === 'transcript');
  chk('transcript feed line carries speaker + group + duration',
    !!trItem && trItem.user_id === member.id && trItem.group_id === g1.j.group.id
    && trItem.meta?.durMs === 1200, JSON.stringify(trItem));
  const tiny = await postAudio(M, `/api/room/${roomId}/transcribe`, Buffer.alloc(200));
  chk('sub-size blip -> 400', tiny.status === 400, `got ${tiny.status}`);

  const vLead = await call(L, 'GET', '/api/admin/voice');
  chk('lead is below admin for voice settings', vLead.status === 403, `got ${vLead.status}`);
  mkUser('orgadmin@e2e.test', 'admin', 1);
  const A = await login('orgadmin@e2e.test');
  const vGet = await call(A, 'GET', '/api/admin/voice');
  chk('admin voice status: config visible, key masked',
    vGet.status === 200 && vGet.j?.org?.hasKey === true
    && !JSON.stringify(vGet.j).includes('stt-key'), JSON.stringify(vGet.j));
  const vTest = await call(A, 'POST', '/api/admin/voice/test');
  chk('voice Test button round-trips the provider (tone WAV)',
    vTest.status === 200 && vTest.j?.ok === true && vTest.j?.source === 'org'
    && vTest.j?.model === 'whisper-e2e' && vTest.j?.latencyMs >= 0, JSON.stringify(vTest.j));

  // ── send-test-alert (rules test-fire; webhook channel vs the local stub) ──
  const ruleMk = await call(L, 'POST', '/api/rules', { name: 'e2e test rule', channel: 'webhook',
    severityMin: 60, cooldownM: 15, recipients: [`http://127.0.0.1:${sttStub.address().port}/hook`] });
  chk('rule created for test-fire', ruleMk.status === 200 && !!ruleMk.j?.id, JSON.stringify(ruleMk.j));
  const tf = await call(L, 'POST', `/api/rules/${ruleMk.j.id}/test`);
  chk('test alert round-trips the webhook channel',
    tf.status === 200 && tf.j?.ok === true && tf.j?.channel === 'webhook' && tf.j?.latencyMs >= 0,
    `got ${tf.status} ${JSON.stringify(tf.j)}`);
  const notifList = await call(L, 'GET', '/api/notifications');
  chk('test-fire lands in the notification log tagged (test)',
    JSON.stringify(notifList.j || []).includes('(test)'), JSON.stringify((notifList.j || [])[0]));
  const tfDenied = await call(M, 'POST', `/api/rules/${ruleMk.j.id}/test`);
  chk('analyst cannot test-fire (lead+)', tfDenied.status === 403, `got ${tfDenied.status}`);
  const tfMissing = await call(L, 'POST', '/api/rules/999999/test');
  chk('test-fire on unknown rule -> 404', tfMissing.status === 404, `got ${tfMissing.status}`);

  // ── phase 3: insight analyzer (LLM stub behind the same local server) ─────
  require('./src/llm').saveOrgConfig(1, { baseUrl: `http://127.0.0.1:${sttStub.address().port}`,
    model: 'llm-e2e', apiKey: 'llm-key' });
  insightGroupId = g1.j.group.id;
  await postAudio(M, `/api/room/${roomId}/transcribe?dur=900`, audio); // 2nd transcript -> above the quiet gate
  const bi = require('./src/engine/bridge-insights');
  await bi.runOnce();
  feed = await call(M, 'GET', `/api/room/${roomId}/feed?limit=500`);
  const insight = feed.j.items.find((i) => i.kind === 'insight');
  chk('analyzer writes a critical insight with group attribution',
    !!insight && insight.severity === 'critical' && insight.group_id === g1.j.group.id
    && insight.user_id === null && /root cause/.test(insight.body), JSON.stringify(insight));
  const ptr = db.prepare('SELECT analyzed_feed_id FROM bridges WHERE id = ?').get(roomId);
  chk('analyzed_feed_id pointer advanced (window never billed twice)',
    !!ptr && ptr.analyzed_feed_id > 0, JSON.stringify(ptr));
  const nInsights = feed.j.items.filter((i) => i.kind === 'insight').length;
  await bi.runOnce(); // nothing new was said -> quiet gate
  const feedQ = await call(M, 'GET', `/api/room/${roomId}/feed?limit=500`);
  chk('quiet room -> no duplicate insights',
    feedQ.j.items.filter((i) => i.kind === 'insight').length === nInsights);
  const notifBI = await call(L, 'GET', '/api/notifications');
  chk('critical insight pushed through the alert rules',
    JSON.stringify(notifBI.j || []).includes('(bridge insight)'),
    JSON.stringify((notifBI.j || [])[0]));

  // ── webhook -> presence mirror ────────────────────────────────────────────
  const evJoin = { event: 'participant_joined', room: { name: `br-1-${roomId}` },
    participant: { identity: String(member.id) } };
  const wj = await webhook(evJoin);
  chk('signed participant_joined accepted', wj.status === 200 && wj.j?.ok === true, `got ${wj.status}`);
  let conn = db.prepare('SELECT connected FROM bridge_participants WHERE room_id = ? AND user_id = ?')
    .get(roomId, member.id);
  chk('presence: connected = 1', conn?.connected === 1, JSON.stringify(conn));
  feed = await call(M, 'GET', `/api/room/${roomId}/feed`);
  chk('feed line: connected', feed.j.items.some((i) => /member connected/.test(i.body)));

  const ws = await webhook({ event: 'track_published', room: { name: `br-1-${roomId}` },
    participant: { identity: String(member.id) }, track: { source: 'SCREEN_SHARE' } });
  chk('track_published (screen share) accepted', ws.status === 200);
  feed = await call(M, 'GET', `/api/room/${roomId}/feed`);
  chk('feed line: started sharing', feed.j.items.some((i) => /member started sharing/.test(i.body)));

  const wl = await webhook({ event: 'participant_left', room: { name: `br-1-${roomId}` },
    participant: { identity: String(member.id) } });
  chk('participant_left accepted', wl.status === 200);
  conn = db.prepare('SELECT connected, left_at FROM bridge_participants WHERE room_id = ? AND user_id = ?')
    .get(roomId, member.id);
  chk('presence: connected = 0 with left_at', conn?.connected === 0 && conn?.left_at > 0, JSON.stringify(conn));

  const tampered = await webhook(evJoin, { tamper: true });
  chk('tampered body -> 401 bad signature', tampered.status === 401, `got ${tampered.status}`);
  const unsigned = await fetch(`${BASE}/api/hooks/livekit`, {
    method: 'POST', headers: { 'Content-Type': 'application/webhook+json' }, body: '{}',
  });
  chk('missing signature -> 401', unsigned.status === 401, `got ${unsigned.status}`);
  const foreignRoom = await webhook({ event: 'participant_joined', room: { name: 'br-9-999' },
    participant: { identity: String(member.id) } });
  chk('unknown room is ignored politely', foreignRoom.status === 200 && foreignRoom.j?.ok === true);

  // ── close ─────────────────────────────────────────────────────────────────
  const cDenied = await call(M, 'POST', `/api/room/${roomId}/close`);
  chk('member cannot close -> 403', cDenied.status === 403, `got ${cDenied.status}`);
  const closed = await call(L, 'POST', `/api/room/${roomId}/close`);
  chk('lead closes the bridge', closed.status === 200 && closed.j?.ok === true);
  const st = await call(M, 'GET', `/api/room/${roomId}`);
  chk('room reads closed', st.j?.room?.status === 'closed' && st.j?.room?.closedAt > 0);
  const tokClosed = await call(M, 'POST', `/api/room/${roomId}/token`);
  chk('token on a closed room -> 409', tokClosed.status === 409, `got ${tokClosed.status}`);
  const joinClosedRoom = await call(M, 'POST', `/api/room/${roomId}/join`, { groupId: null });
  chk('join on a closed room -> 409', joinClosedRoom.status === 409, `got ${joinClosedRoom.status}`);
  const gClosedRoom = await call(M, 'POST', `/api/room/${roomId}/groups`, { name: 'late' });
  chk('new breakout on a closed room -> 409', gClosedRoom.status === 409, `got ${gClosedRoom.status}`);
  const trClosed = await postAudio(M, `/api/room/${roomId}/transcribe`, audio);
  chk('transcribe on a closed room -> 409', trClosed.status === 409, `got ${trClosed.status}`);
  await call(L, 'POST', `/api/room/${roomId}/close`);
  feed = await call(M, 'GET', `/api/room/${roomId}/feed?limit=500`);
  chk('close is idempotent (one feed line)',
    feed.j.items.filter((i) => /closed the Bridge/.test(i.body)).length === 1);
  chk('audit row bridge_close exists',
    !!db.prepare(`SELECT 1 FROM audit_log WHERE org_id = 1 AND user_id = ? AND action = 'bridge_close'`)
      .get(lead.id));

  // ── browser-side headers: CSP + Permissions-Policy must carry the Bridge ──
  // The class of bug nothing else catches: server green, browser refuses the
  // signal WebSocket (connect-src) or the microphone (Permissions-Policy).
  const hdr = await fetch(`${BASE}/api/health`);
  const csp = hdr.headers.get('content-security-policy') || '';
  const perm = hdr.headers.get('permissions-policy') || '';
  chk('CSP connect-src names the LiveKit origin (wss + https twin)',
    /connect-src [^;]*wss:\/\/rt\.e2e\.test/.test(csp) && /connect-src [^;]*https:\/\/rt\.e2e\.test/.test(csp), csp);
  chk('Permissions-Policy allows the microphone for self',
    perm.includes('microphone=(self)'), perm);

  // ── SSE stream answers with the right content type ────────────────────────
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/api/stream`, { headers: { cookie: M.cookie }, signal: ac.signal });
  chk('SSE stream is served', sse.status === 200
    && /text\/event-stream/.test(sse.headers.get('content-type') || ''), sse.headers.get('content-type') || '');
  ac.abort();

  // ── summary ───────────────────────────────────────────────────────────────
  const fails = R.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${R.join('\n')}`);
  console.log(`\n${R.length - fails.length}/${R.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
