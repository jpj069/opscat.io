'use strict';
// Incident verbs — the ONE mutation path for incidents (docs/INCIDENTS-V2.md §3).
// The REST routes, the MCP tools and (later) the flow engine all call these,
// so the two things every writer must get happen exactly once, here:
//
//  - the synthetic lifecycle events (`incident_created`, `incident_status_changed`,
//    `incident_resolved`) ride the org's alert rules the same way
//    `bridge_insight` does — matched by name + severity_min, throttle-free
//    (an incident transition is rare and human-initiated), logged per channel;
//  - the component-status derivation: a component's status IS the worst
//    `impact` across all OPEN incidents linked to it (identity on the shared
//    scale, lib/status-scale.js), back to `operational` when the last one
//    resolves. Manual status writes stay possible but are recomputed away on
//    the next incident transition.
const store = require('../db/shim');
const { now } = require('../util');
const config = require('../config');
const alerts = require('../engine/alerts');
const subscribers = require('./subscribers');
const { IMPACTS, rankCaseSql } = require('./status-scale');

const label = (id) => `INC-${2000 + id}`;
const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];

const q = {
  byId: store.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?'),
  setStatus: store.prepare('UPDATE incidents SET status = ?, resolved_at = NULL WHERE id = ? AND org_id = ?'),
  // `AND status != 'resolved'` is the at-most-once gate for the RESOLVE
  // transition: `.changes`, not the row we read a moment ago, decides whether
  // this caller is the one that resolved the incident. Without it two concurrent
  // resolves both see an open incident, both emit `incident_resolved` — so every
  // matching alert rule pages the on-call twice — and both close the alert chain.
  resolve: store.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ?
    WHERE id = ? AND org_id = ? AND status != 'resolved'`),
  // Same gate for publish/unpublish, and this is the one that must not be got
  // wrong: the fan-out behind it MAILS EVERY CONFIRMED SUBSCRIBER of every page
  // the incident touches, and a mail cannot be recalled. The claim therefore
  // happens BEFORE the send — a send that then fails is a missed mail, which is
  // recoverable; a second send is not.
  publish: store.prepare('UPDATE incidents SET published = ? WHERE id = ? AND org_id = ? AND published != ?'),
  updates: store.prepare('SELECT ts, status, message FROM incident_updates WHERE incident_id = ? ORDER BY ts'),
  insUpdate: store.prepare(`INSERT INTO incident_updates (incident_id, ts, status, message, user_id)
    VALUES (?, ?, ?, ?, ?)`),
  comps: store.prepare(`SELECT ic.component_id AS id, ic.impact, c.name FROM incident_components ic
    JOIN components c ON c.id = ic.component_id WHERE ic.incident_id = ? ORDER BY c.sort, c.id`),
  links: store.prepare('SELECT kind, ref_id, created_at FROM incident_links WHERE incident_id = ? ORDER BY created_at, ref_id'),
  insLink: store.prepare(`INSERT INTO incident_links (incident_id, kind, ref_id, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
  delComps: store.prepare('DELETE FROM incident_components WHERE incident_id = ?'),
  insComp: store.prepare(`INSERT INTO incident_components (incident_id, component_id, impact) VALUES (?, ?, ?)
    ON CONFLICT(incident_id, component_id) DO UPDATE SET impact = excluded.impact`),
  compOfOrg: store.prepare('SELECT id FROM components WHERE id = ? AND org_id = ?'),
  // The derivation, in ONE statement — never SELECT the impacts, fold them with
  // worst() in JS and UPDATE the answer back. Two transitions touching the same
  // component would each compute from a snapshot the other has already replaced,
  // and the loser writes a status derived from incidents that are no longer open:
  // the public status page then shows the wrong colour, silently and for good.
  // The component derivation also has a SECOND, uncoordinated writer
  // (engine/vendors.js mirrors a vendor's state onto a mapped component), so the
  // window is not hypothetical. The ordering comes from lib/status-scale.js —
  // a hand-written CASE here would be the copy that drifts.
  setCompStatus: store.prepare(`UPDATE components SET status = COALESCE((
      SELECT ic.impact FROM incident_components ic
        JOIN incidents i ON i.id = ic.incident_id
       WHERE ic.component_id = components.id AND i.status != 'resolved'
       ORDER BY ${rankCaseSql('ic.impact')} DESC LIMIT 1), 'operational')
    WHERE id = ?`),
  member: store.prepare(`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.org_id = ? AND u.active = 1`),
  userName: store.prepare('SELECT name FROM users WHERE id = ?'),
  rules: store.prepare('SELECT * FROM alert_rules WHERE org_id = ? AND enabled = 1'),
  insNotif: store.prepare(`INSERT INTO notifications
    (org_id, ts, rule_id, rule_name, event_id, case_label, channel, ok, error)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`),
  caseById: store.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?'),
  // Append the promotion stamp IN SQL. `cases.note` is human-authored text, and
  // read-modify-write in JS silently discards whatever an operator typed between
  // the read and the write — no error, no trace, the note simply never existed
  // (CLAUDE.md § Actions and their record). Same shape as lib/cases.js
  // `closeWithNote`, the repo's model for this: the newline is BOUND, not spelled,
  // because SQLite has char(10) and Postgres has chr(10) and a parameter needs
  // neither. NULLIF keeps an empty note from producing a leading blank line, which
  // is what the `c.note ? … : stamp` ternary did. Bound args: ('\n', stamp, id).
  appendCaseNote: store.prepare("UPDATE cases SET note = COALESCE(NULLIF(note, '') || ?, '') || ? WHERE id = ?"),
  incidentOfCase: store.prepare(`SELECT incident_id FROM incident_links WHERE kind = 'case' AND ref_id = ?
    ORDER BY created_at DESC LIMIT 1`),
};

// ---- view model -------------------------------------------------------------
async function view(i) {
  const assignee = i.assignee_id ? await q.userName.get(i.assignee_id) : null;
  return {
    id: i.id, label: label(i.id), title: i.title, severity: i.severity, status: i.status,
    published: !!i.published, startedAt: i.started_at, resolvedAt: i.resolved_at,
    durationMs: (i.resolved_at || now()) - i.started_at,
    assigneeId: i.assignee_id || null, assignee: assignee ? assignee.name : null,
    components: await q.comps.all(i.id),
    links: (await q.links.all(i.id)).map((l) => ({
      kind: l.kind, refId: l.ref_id,
      label: l.kind === 'case' ? `C-${1000 + l.ref_id}` : `#${l.ref_id}`,
    })),
    updates: await q.updates.all(i.id),
    rca: { summary: i.rca_summary, impact: i.rca_impact, rootCause: i.rca_root_cause,
      resolution: i.rca_resolution, actions: i.rca_actions },
  };
}

// ---- component-status derivation -------------------------------------------
// Recompute the given components from their open incidents. Called after every
// transition that can change the answer; touching only the affected ids keeps
// a manual status on components no incident is linked to.
async function recomputeComponents(componentIds) {
  for (const id of new Set(componentIds)) await q.setCompStatus.run(id);
}

// ---- lifecycle events through the alert rules ------------------------------
// Same matching as a real event: enabled rules whose severity_min allows the
// incident severity and whose trigger is empty or exactly the event name.
async function emit(name, incident, extra = '') {
  const ev = {
    id: 0, name, device: label(incident.id), ip: null, target: null,
    severity: incident.severity, hits: 1, last_seen: now(),
    description: `${label(incident.id)} "${incident.title}" — ${name.replace(/_/g, ' ')}` +
      (extra ? ` ${extra}` : '') + `\n\n${config.baseUrl}/app/incidents`,
  };
  for (const rule of await q.rules.all(incident.org_id)) {
    if (ev.severity < rule.severity_min) continue;
    if (rule.trigger_name && rule.trigger_name !== name) continue;
    alerts.dispatch(rule, ev)
      .then(() => q.insNotif.run(incident.org_id, now(), rule.id, rule.name,
        label(incident.id), rule.channel, 1, null))
      .catch((err) => q.insNotif.run(incident.org_id, now(), rule.id, rule.name,
        label(incident.id), rule.channel, 0, String(err.message).slice(0, 300)));
  }
}

// ---- helpers ---------------------------------------------------------------
async function setComponentsTx(orgId, incidentId, components) {
  // replace-all semantics; ids outside the org are refused by the caller
  const before = (await q.comps.all(incidentId)).map((c) => c.id);
  await q.delComps.run(incidentId);
  for (const c of components) await q.insComp.run(incidentId, c.id, c.impact);
  await recomputeComponents([...before, ...components.map((c) => c.id)]);
}

// Validate a components payload against the org. Returns a clean array or null.
async function cleanComponents(orgId, raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out = [];
  for (const c of raw) {
    const id = Number(c && c.id);
    const impact = (c && c.impact) || 'degraded';
    if (!Number.isInteger(id) || !IMPACTS.includes(impact)) return null;
    if (!(await q.compOfOrg.get(id, orgId))) return null;
    out.push({ id, impact });
  }
  return out;
}

// ---- verbs -----------------------------------------------------------------
// create: declare dialog v2 / promote / MCP / (later) flows. `components` is
// a cleaned array from cleanComponents; assigneeId must be an org member.
async function create(orgId, userId, { title, severity, message, components, assigneeId, linkCaseId, linkEventId }) {
  const t = now();
  // withTx, never db.transaction: better-sqlite3 COMMITs when its callback
  // RETURNS, so an async callback commits immediately and every awaited write
  // below would land outside the transaction with nothing reporting it.
  const row = await store.withTx(async () => {
    // insert(), not run().lastInsertRowid — node-postgres has no such field.
    const id = await store.prepare(`INSERT INTO incidents (org_id, title, severity, status, started_at, created_by, assignee_id)
      VALUES (?, ?, ?, 'investigating', ?, ?, ?)`)
      .insert(orgId, title, severity, t, userId, assigneeId || null);
    await q.insUpdate.run(id, t, 'investigating', message || 'Incident opened.', userId);
    if (assigneeId) {
      const who = await q.userName.get(assigneeId);
      await q.insUpdate.run(id, t + 1, 'investigating', `Assigned to ${who ? who.name : assigneeId}.`, userId);
    }
    if (linkCaseId) await q.insLink.run(id, 'case', linkCaseId, t);
    if (linkEventId) await q.insLink.run(id, 'event', linkEventId, t);
    if (components && components.length) {
      for (const c of components) await q.insComp.run(id, c.id, c.impact);
      await recomputeComponents(components.map((c) => c.id));
    }
    return await q.byId.get(id, orgId);
  });
  await emit('incident_created', row);
  return row;
}

async function setStatus(orgId, userId, id, status, message) {
  const i = await q.byId.get(id, orgId);
  if (!i || !STATUSES.includes(status)) return null;
  const t = now();
  // Did THIS call perform the resolve transition? Answered by the write, not by
  // the read above — see q.resolve. A status update that is not a resolve, and a
  // second "resolve" of an already-resolved incident, still post their timeline
  // entry; only the once-per-incident consequences hang off this flag.
  let resolvedNow = false;
  await store.withTx(async () => {
    if (status === 'resolved') resolvedNow = (await q.resolve.run(t, i.id, orgId)).changes === 1;
    else await q.setStatus.run(status, i.id, orgId);
    await q.insUpdate.run(i.id, t, status, message || `Status changed to ${status}.`, userId);
    // every transition recomputes — this is what makes a manual component
    // status "recomputed away on the next incident transition" (§2)
    await recomputeComponents((await q.comps.all(i.id)).map((c) => c.id));
  });
  const row = await q.byId.get(i.id, orgId);
  await emit('incident_status_changed', row, `(${i.status} → ${status})`);
  if (resolvedNow) {
    await emit('incident_resolved', row);
    // A resolved incident stops alerting about itself. This is the fourth thing
    // that must happen exactly once here — beside the synthetic events and the
    // component derivation — and it is why this module became the single
    // mutation path in the first place (docs/ONCALL-V1.md §5, §8).
    await require('../engine/alert-chain').onSubjectClosed(orgId, 'incident', row.id, 'incident resolved');
  }
  // published incidents additionally reach the status-page subscribers
  if (row.published) await subscribers.notifyIncident(row, 'update', message);
  return row;
}

// publish/unpublish through the same single path as every other mutation —
// the moment an incident FIRST becomes visible on the public page, confirmed
// subscribers get the initial notification.
async function setPublished(orgId, userId, id, value) {
  const i = await q.byId.get(id, orgId);
  if (!i) return null;
  const next = value ? 1 : 0;
  // Claim the transition, then fan out — never "read, decide in JS, write, mail".
  // Two concurrent publishes of the same incident both read published = 0, both
  // pass a JS check and both reach notifyIncident: every confirmed subscriber of
  // every page the incident touches is mailed TWICE, unrecallably. `.changes` is
  // the gate; the caller that did not move the row sends nothing and answers with
  // the incident as it now stands.
  if ((await q.publish.run(next, i.id, orgId, next)).changes !== 1) return await q.byId.get(i.id, orgId);
  const row = await q.byId.get(i.id, orgId);
  if (next) await subscribers.notifyIncident(row, 'published');
  return row;
}

// assign: null clears. Writes the timeline entry like a human would.
async function assign(orgId, userId, id, assigneeId) {
  const i = await q.byId.get(id, orgId);
  if (!i) return null;
  let name = null;
  if (assigneeId !== null) {
    const m = await q.member.get(assigneeId, orgId);
    if (!m) return { error: 'assignee must be a member of this organization' };
    name = m.name;
  }
  if ((i.assignee_id || null) === (assigneeId || null)) return await q.byId.get(id, orgId);
  await store.withTx(async () => {
    await store.prepare('UPDATE incidents SET assignee_id = ? WHERE id = ? AND org_id = ?').run(assigneeId, i.id, orgId);
    await q.insUpdate.run(i.id, now(), i.status, assigneeId ? `Assigned to ${name}.` : 'Unassigned.', userId);
  });
  return await q.byId.get(i.id, orgId);
}

async function setComponents(orgId, id, components) {
  const i = await q.byId.get(id, orgId);
  if (!i) return null;
  await store.withTx(() => setComponentsTx(orgId, i.id, components));
  return await q.byId.get(i.id, orgId);
}

// promote: case → incident (docs/INCIDENTS-V2.md §3.1 — the only promoted
// path; a direct event promote was deliberately not built, see §7).
async function promote(orgId, userId, caseId, { title, severity, components, assigneeId } = {}) {
  const c = await q.caseById.get(caseId, orgId);
  if (!c) return null;
  const existing = await q.incidentOfCase.get(c.id);
  if (existing) {
    const i = await q.byId.get(existing.incident_id, orgId);
    if (i && i.status !== 'resolved') return { already: await view(i) };
  }
  const row = await create(orgId, userId, {
    title: title || `${c.name} on ${c.device}`,
    severity: severity ?? c.severity,
    message: `Promoted from case C-${1000 + c.id}.`,
    components, assigneeId: assigneeId ?? c.assigned_user_id ?? userId,
    linkCaseId: c.id, linkEventId: c.event_id || null,
  });
  const stamp = `→ promoted to ${label(row.id)}`;
  await q.appendCaseNote.run('\n', stamp, c.id);
  return { incident: row };
}

// incident badge for a case detail (null when never promoted)
async function incidentOfCase(caseId) {
  const l = await q.incidentOfCase.get(caseId);
  return l ? { id: l.incident_id, label: label(l.incident_id) } : null;
}

module.exports = {
  view, label, STATUSES, create, setStatus, setPublished, assign, setComponents,
  cleanComponents, promote, incidentOfCase, recomputeComponents, emit,
};
