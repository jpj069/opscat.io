'use strict';
// Bridge insight analyzer (docs/BRIDGE.md phase 3): reads each open bridge's
// NEW feed lines (transcripts + system events), asks the org's LLM (llm.js —
// the same provider config that powers the AI card) for findings another
// group must not miss, writes them back into the feed as `insight` items
// (SSE fans them out; the UI renders them and toasts criticals), and pushes
// criticals through the org's alert rules. Deliberately boring economics:
// at most one chat call per room per interval, and only once enough new
// speech accumulated; the analyzed_feed_id pointer on the room makes
// restarts idempotent — a window is never billed twice.
const { db } = require('../db');
const llm = require('../llm');
const alerts = require('./alerts');
const config = require('../config');
const { now } = require('../util');

const INTERVAL_MS = 45000;
const MIN_NEW_TRANSCRIPTS = 2; // don't burn a call on a single stray line
const MAX_INSIGHTS_PER_RUN = 3;
const PUSH_COOLDOWN_MS = 5 * 60 * 1000; // critical fan-out at most every 5 min/room

const q = {
  openRooms: db.prepare(`SELECT b.*, i.title AS incident_title, i.severity AS incident_severity,
      i.status AS incident_status FROM bridges b JOIN incidents i ON i.id = b.incident_id
    WHERE b.status = 'open' AND b.transcription = 1`),
  newItems: db.prepare(`SELECT f.*, u.name AS user_name, u.email AS user_email
      FROM bridge_feed f LEFT JOIN users u ON u.id = f.user_id
    WHERE f.room_id = ? AND f.id > ? AND f.kind != 'insight' ORDER BY f.id LIMIT 120`),
  priorInsights: db.prepare(`SELECT body FROM bridge_feed
    WHERE room_id = ? AND kind = 'insight' ORDER BY id DESC LIMIT 12`),
  groups: db.prepare('SELECT id, name FROM bridge_groups WHERE room_id = ? AND closed_at IS NULL ORDER BY sort, id'),
  setAnalyzed: db.prepare('UPDATE bridges SET analyzed_feed_id = ? WHERE id = ?'),
  insFeed: db.prepare(`INSERT INTO bridge_feed (room_id, group_id, user_id, kind, severity, body, meta, created_at)
    VALUES (?, ?, NULL, 'insight', ?, ?, '{}', ?)`),
  rules: db.prepare('SELECT * FROM alert_rules WHERE org_id = ? AND enabled = 1'),
  insNotif: db.prepare(`INSERT INTO notifications
    (org_id, ts, rule_id, rule_name, event_id, case_label, channel, ok, error)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`),
};

const lastPush = new Map(); // roomId -> ts of the last critical fan-out

const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);

function feedLine(item, groupName) {
  const who = item.user_name || item.user_email || 'someone';
  if (item.kind === 'transcript') return `[${hhmm(item.created_at)}] (${groupName}) ${who}: "${item.body}"`;
  return `[${hhmm(item.created_at)}] system — ${item.body}`;
}

const SYSTEM_PROMPT = 'You are the silent analyst in an incident war room. Teams work the incident '
  + 'in parallel breakout groups; you read the live feed and surface ONLY findings another group '
  + 'must not miss. Respond with STRICT JSON, nothing else:\n'
  + '{"insights":[{"severity":"info"|"notable"|"critical","groupId":<number or null>,"body":"<finding, max 200 chars>"}]}\n'
  + 'Rules: report NEW findings only — never repeat or rephrase anything listed under PRIOR '
  + 'INSIGHTS. Prefer an empty list over noise. "critical" is reserved for what every responder '
  + 'must see NOW: root cause identified, fix or rollback decided, customer impact changed, '
  + 'conflicting or dangerous actions between groups. Set groupId to the breakout the finding '
  + 'came from (null for the Lobby). Terse NOC style: what, where, evidence.';

async function analyzeRoom(room) {
  const cfg = llm.resolveConfig(room.org_id);
  if (!cfg) return { skipped: 'no-llm' };
  const items = q.newItems.all(room.id, room.analyzed_feed_id);
  const transcripts = items.filter((i) => i.kind === 'transcript');
  if (transcripts.length < MIN_NEW_TRANSCRIPTS) return { skipped: 'quiet' };

  const groups = q.groups.all(room.id);
  const gname = (gid) => (gid == null ? 'Lobby'
    : (groups.find((g) => g.id === gid) || {}).name || `group ${gid}`);
  const prior = q.priorInsights.all(room.id).reverse();
  const elapsedM = Math.round((now() - room.created_at) / 60000);
  const user = [
    `INCIDENT: INC-${2000 + room.incident_id} "${room.incident_title}" — severity `
      + `${room.incident_severity}, status ${room.incident_status}, bridge open ${elapsedM}m.`,
    `BREAKOUTS: ${JSON.stringify(groups)} (groupId null = Lobby)`,
    prior.length
      ? `PRIOR INSIGHTS (do not repeat):\n${prior.map((p) => `- ${p.body}`).join('\n')}`
      : 'PRIOR INSIGHTS: none',
    `FEED (new since last analysis):\n${items.map((i) => feedLine(i, gname(i.group_id))).join('\n')}`,
    'JSON:',
  ].join('\n\n');

  const reply = await llm.chat(room.org_id,
    [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
    { maxTokens: 500, temperature: 0, timeoutMs: 25000 });

  // models love to wrap JSON in fences or prose — take the outermost object
  const m = reply.match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { /* unparseable — treat as empty */ }
  const valid = (Array.isArray(parsed && parsed.insights) ? parsed.insights : [])
    .filter((x) => x && ['info', 'notable', 'critical'].includes(x.severity)
      && typeof x.body === 'string' && x.body.trim())
    .slice(0, MAX_INSIGHTS_PER_RUN)
    .map((x) => ({
      severity: x.severity,
      body: x.body.trim().slice(0, 300),
      groupId: groups.some((g) => g.id === x.groupId) ? x.groupId : null,
    }));

  // the pointer advances after every successful LLM round — an empty result
  // is an answer too, and the same window must never be billed twice
  const maxId = items[items.length - 1].id;
  const ts = now();
  const { hub } = require('../routes/ops'); // module cache — no load-time cycle
  for (const ins of valid) {
    const r = q.insFeed.run(room.id, ins.groupId, ins.severity, ins.body, ts);
    hub.broadcast('bridge.feed', { roomId: room.id, item: {
      id: Number(r.lastInsertRowid), room_id: room.id, group_id: ins.groupId, user_id: null,
      kind: 'insight', severity: ins.severity, body: ins.body, meta: {}, created_at: ts,
    } }, room.org_id);
  }
  q.setAnalyzed.run(maxId, room.id);

  const critical = valid.find((x) => x.severity === 'critical');
  if (critical) pushCritical(room, critical);
  return { inserted: valid.length };
}

// Critical insights additionally ride the org's alert channels — matched like
// a real event: enabled rules whose severity_min allows 85 and whose trigger
// is empty or exactly 'bridge_insight'. Throttled per room so a hot analyzer
// can never storm the channels.
function pushCritical(room, insight) {
  const t = now();
  if (t - (lastPush.get(room.id) || 0) < PUSH_COOLDOWN_MS) return;
  lastPush.set(room.id, t);
  const ev = {
    id: 0, name: 'bridge_insight', device: `INC-${2000 + room.incident_id}`,
    ip: null, target: null, severity: 85, hits: 1,
    description: `${insight.body}\n\nBridge: ${config.baseUrl}/app/bridge`,
    last_seen: t,
  };
  for (const rule of q.rules.all(room.org_id)) {
    if (ev.severity < rule.severity_min) continue;
    if (rule.trigger_name && rule.trigger_name !== 'bridge_insight') continue;
    alerts.dispatch(rule, ev)
      .then(() => q.insNotif.run(room.org_id, now(), rule.id,
        `${rule.name} (bridge insight)`, rule.channel, 1, null))
      .catch((err) => q.insNotif.run(room.org_id, now(), rule.id,
        `${rule.name} (bridge insight)`, rule.channel, 0, String(err.message).slice(0, 300)));
  }
}

async function runOnce() {
  if (!config.livekit.url) return; // Bridge not configured — nothing to analyze
  for (const room of q.openRooms.all()) {
    try { await analyzeRoom(room); }
    catch (e) { console.error(`[bridge-insights] room ${room.id}:`, e.message); }
  }
}

function start() {
  setInterval(() => { runOnce(); }, INTERVAL_MS);
}

module.exports = { start, runOnce, analyzeRoom };
