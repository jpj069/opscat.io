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
const { db } = require('../db');
const { now } = require('../util');
const config = require('../config');
const alerts = require('../engine/alerts');
const subscribers = require('./subscribers');
const { IMPACTS, worst } = require('./status-scale');

const label = (id) => `INC-${2000 + id}`;
const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];

const q = {
  byId: db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?'),
  updates: db.prepare('SELECT ts, status, message FROM incident_updates WHERE incident_id = ? ORDER BY ts'),
  insUpdate: db.prepare(`INSERT INTO incident_updates (incident_id, ts, status, message, user_id)
    VALUES (?, ?, ?, ?, ?)`),
  comps: db.prepare(`SELECT ic.component_id AS id, ic.impact, c.name FROM incident_components ic
    JOIN components c ON c.id = ic.component_id WHERE ic.incident_id = ? ORDER BY c.sort, c.id`),
  links: db.prepare('SELECT kind, ref_id, created_at FROM incident_links WHERE incident_id = ? ORDER BY created_at, ref_id'),
  insLink: db.prepare(`INSERT OR IGNORE INTO incident_links (incident_id, kind, ref_id, created_at)
    VALUES (?, ?, ?, ?)`),
  delComps: db.prepare('DELETE FROM incident_components WHERE incident_id = ?'),
  insComp: db.prepare(`INSERT INTO incident_components (incident_id, component_id, impact) VALUES (?, ?, ?)
    ON CONFLICT(incident_id, component_id) DO UPDATE SET impact = excluded.impact`),
  compOfOrg: db.prepare('SELECT id FROM components WHERE id = ? AND org_id = ?'),
  openImpacts: db.prepare(`SELECT ic.impact FROM incident_components ic
    JOIN incidents i ON i.id = ic.incident_id
    WHERE ic.component_id = ? AND i.status != 'resolved'`),
  setCompStatus: db.prepare('UPDATE components SET status = ? WHERE id = ?'),
  member: db.prepare(`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.org_id = ? AND u.active = 1`),
  userName: db.prepare('SELECT name FROM users WHERE id = ?'),
  rules: db.prepare('SELECT * FROM alert_rules WHERE org_id = ? AND enabled = 1'),
  insNotif: db.prepare(`INSERT INTO notifications
    (org_id, ts, rule_id, rule_name, event_id, case_label, channel, ok, error)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`),
  caseById: db.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?'),
  caseNote: db.prepare('UPDATE cases SET note = ? WHERE id = ?'),
  incidentOfCase: db.prepare(`SELECT incident_id FROM incident_links WHERE kind = 'case' AND ref_id = ?
    ORDER BY created_at DESC LIMIT 1`),
};

// ---- view model -------------------------------------------------------------
function view(i) {
  const assignee = i.assignee_id ? q.userName.get(i.assignee_id) : null;
  return {
    id: i.id, label: label(i.id), title: i.title, severity: i.severity, status: i.status,
    published: !!i.published, startedAt: i.started_at, resolvedAt: i.resolved_at,
    durationMs: (i.resolved_at || now()) - i.started_at,
    assigneeId: i.assignee_id || null, assignee: assignee ? assignee.name : null,
    components: q.comps.all(i.id),
    links: q.links.all(i.id).map((l) => ({
      kind: l.kind, refId: l.ref_id,
      label: l.kind === 'case' ? `C-${1000 + l.ref_id}` : `#${l.ref_id}`,
    })),
    updates: q.updates.all(i.id),
    rca: { summary: i.rca_summary, impact: i.rca_impact, rootCause: i.rca_root_cause,
      resolution: i.rca_resolution, actions: i.rca_actions },
  };
}

// ---- component-status derivation -------------------------------------------
// Recompute the given components from their open incidents. Called after every
// transition that can change the answer; touching only the affected ids keeps
// a manual status on components no incident is linked to.
function recomputeComponents(componentIds) {
  for (const id of new Set(componentIds)) {
    const impacts = q.openImpacts.all(id).map((r) => r.impact);
    q.setCompStatus.run(worst(impacts, 'operational'), id);
  }
}

// ---- lifecycle events through the alert rules ------------------------------
// Same matching as a real event: enabled rules whose severity_min allows the
// incident severity and whose trigger is empty or exactly the event name.
function emit(name, incident, extra = '') {
  const ev = {
    id: 0, name, device: label(incident.id), ip: null, target: null,
    severity: incident.severity, hits: 1, last_seen: now(),
    description: `${label(incident.id)} "${incident.title}" — ${name.replace(/_/g, ' ')}` +
      (extra ? ` ${extra}` : '') + `\n\n${config.baseUrl}/app/incidents`,
  };
  for (const rule of q.rules.all(incident.org_id)) {
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
function setComponentsTx(orgId, incidentId, components) {
  // replace-all semantics; ids outside the org are refused by the caller
  const before = q.comps.all(incidentId).map((c) => c.id);
  q.delComps.run(incidentId);
  for (const c of components) q.insComp.run(incidentId, c.id, c.impact);
  recomputeComponents([...before, ...components.map((c) => c.id)]);
}

// Validate a components payload against the org. Returns a clean array or null.
function cleanComponents(orgId, raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out = [];
  for (const c of raw) {
    const id = Number(c && c.id);
    const impact = (c && c.impact) || 'degraded';
    if (!Number.isInteger(id) || !IMPACTS.includes(impact)) return null;
    if (!q.compOfOrg.get(id, orgId)) return null;
    out.push({ id, impact });
  }
  return out;
}

// ---- verbs -----------------------------------------------------------------
// create: declare dialog v2 / promote / MCP / (later) flows. `components` is
// a cleaned array from cleanComponents; assigneeId must be an org member.
function create(orgId, userId, { title, severity, message, components, assigneeId, linkCaseId, linkEventId }) {
  const t = now();
  let row;
  db.transaction(() => {
    const info = db.prepare(`INSERT INTO incidents (org_id, title, severity, status, started_at, created_by, assignee_id)
      VALUES (?, ?, ?, 'investigating', ?, ?, ?)`)
      .run(orgId, title, severity, t, userId, assigneeId || null);
    const id = Number(info.lastInsertRowid);
    q.insUpdate.run(id, t, 'investigating', message || 'Incident opened.', userId);
    if (assigneeId) {
      const who = q.userName.get(assigneeId);
      q.insUpdate.run(id, t + 1, 'investigating', `Assigned to ${who ? who.name : assigneeId}.`, userId);
    }
    if (linkCaseId) q.insLink.run(id, 'case', linkCaseId, t);
    if (linkEventId) q.insLink.run(id, 'event', linkEventId, t);
    if (components && components.length) {
      for (const c of components) q.insComp.run(id, c.id, c.impact);
      recomputeComponents(components.map((c) => c.id));
    }
    row = q.byId.get(id, orgId);
  })();
  emit('incident_created', row);
  return row;
}

function setStatus(orgId, userId, id, status, message) {
  const i = q.byId.get(id, orgId);
  if (!i || !STATUSES.includes(status)) return null;
  const t = now();
  db.transaction(() => {
    db.prepare('UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ? AND org_id = ?')
      .run(status, status === 'resolved' ? t : null, i.id, orgId);
    q.insUpdate.run(i.id, t, status, message || `Status changed to ${status}.`, userId);
    // every transition recomputes — this is what makes a manual component
    // status "recomputed away on the next incident transition" (§2)
    recomputeComponents(q.comps.all(i.id).map((c) => c.id));
  })();
  const row = q.byId.get(i.id, orgId);
  emit('incident_status_changed', row, `(${i.status} → ${status})`);
  if (status === 'resolved' && i.status !== 'resolved') {
    emit('incident_resolved', row);
    // A resolved incident stops alerting about itself. This is the fourth thing
    // that must happen exactly once here — beside the synthetic events and the
    // component derivation — and it is why this module became the single
    // mutation path in the first place (docs/ONCALL-V1.md §5, §8).
    require('../engine/alert-chain').onSubjectClosed(orgId, 'incident', row.id, 'incident resolved');
  }
  // published incidents additionally reach the status-page subscribers
  if (row.published) subscribers.notifyIncident(row, 'update', message);
  return row;
}

// publish/unpublish through the same single path as every other mutation —
// the moment an incident FIRST becomes visible on the public page, confirmed
// subscribers get the initial notification.
function setPublished(orgId, userId, id, value) {
  const i = q.byId.get(id, orgId);
  if (!i) return null;
  const next = value ? 1 : 0;
  if (i.published === next) return i;
  db.prepare('UPDATE incidents SET published = ? WHERE id = ? AND org_id = ?').run(next, i.id, orgId);
  const row = q.byId.get(i.id, orgId);
  if (next && !i.published) subscribers.notifyIncident(row, 'published');
  return row;
}

// assign: null clears. Writes the timeline entry like a human would.
function assign(orgId, userId, id, assigneeId) {
  const i = q.byId.get(id, orgId);
  if (!i) return null;
  let name = null;
  if (assigneeId !== null) {
    const m = q.member.get(assigneeId, orgId);
    if (!m) return { error: 'assignee must be a member of this organization' };
    name = m.name;
  }
  if ((i.assignee_id || null) === (assigneeId || null)) return q.byId.get(id, orgId);
  db.transaction(() => {
    db.prepare('UPDATE incidents SET assignee_id = ? WHERE id = ? AND org_id = ?').run(assigneeId, i.id, orgId);
    q.insUpdate.run(i.id, now(), i.status, assigneeId ? `Assigned to ${name}.` : 'Unassigned.', userId);
  })();
  return q.byId.get(i.id, orgId);
}

function setComponents(orgId, id, components) {
  const i = q.byId.get(id, orgId);
  if (!i) return null;
  db.transaction(() => setComponentsTx(orgId, i.id, components))();
  return q.byId.get(i.id, orgId);
}

// promote: case → incident (docs/INCIDENTS-V2.md §3.1 — the only promoted
// path; a direct event promote was deliberately not built, see §7).
function promote(orgId, userId, caseId, { title, severity, components, assigneeId } = {}) {
  const c = q.caseById.get(caseId, orgId);
  if (!c) return null;
  const existing = q.incidentOfCase.get(c.id);
  if (existing) {
    const i = q.byId.get(existing.incident_id, orgId);
    if (i && i.status !== 'resolved') return { already: view(i) };
  }
  const row = create(orgId, userId, {
    title: title || `${c.name} on ${c.device}`,
    severity: severity ?? c.severity,
    message: `Promoted from case C-${1000 + c.id}.`,
    components, assigneeId: assigneeId ?? c.assigned_user_id ?? userId,
    linkCaseId: c.id, linkEventId: c.event_id || null,
  });
  const stamp = `→ promoted to ${label(row.id)}`;
  q.caseNote.run(c.note ? `${c.note}\n${stamp}` : stamp, c.id);
  return { incident: row };
}

// incident badge for a case detail (null when never promoted)
function incidentOfCase(caseId) {
  const l = q.incidentOfCase.get(caseId);
  return l ? { id: l.incident_id, label: label(l.incident_id) } : null;
}

module.exports = {
  view, label, STATUSES, create, setStatus, setPublished, assign, setComponents,
  cleanComponents, promote, incidentOfCase, recomputeComponents, emit,
};
