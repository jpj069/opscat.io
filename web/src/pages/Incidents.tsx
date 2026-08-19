// Incidents — master-detail: incident list + status timeline + RCA editor.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp, useOverlayParam, useQueryState } from '../state';
import { SEV, alpha, sevColor, fmtTime, fmtDuration, fmtDateTime, STATUS_META, IMPACTS } from '../format';
import { Card, Button, SevBadge, StatusPill, Modal, Field, ListSkeleton, TextSkeleton, Input, Textarea} from '../ui';
import { Select, MultiSelect } from '../Select';
import type { Incident, Impact, Component } from '../types';
import {
  CheckIcon,
  PlusIcon,
} from 'lucide-react';

const STATUS_COLOR: Record<Incident['status'], string> = {
  investigating: '#f85149', identified: '#f0883e', monitoring: '#e3b341', resolved: '#3fb950',
};
const STATUSES: Incident['status'][] = ['investigating', 'identified', 'monitoring', 'resolved'];
const RCA_FIELDS: { key: keyof Incident['rca']; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'impact', label: 'Impact' },
  { key: 'rootCause', label: 'Root Cause' },
  { key: 'resolution', label: 'Resolution' },
  { key: 'actions', label: 'Action Items' },
];
const CLAMP2 = {
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
  overflow: 'hidden', lineHeight: 1.35,
} as React.CSSProperties;

function statusColor(s: string): string {
  return STATUS_COLOR[s as Incident['status']] ?? 'var(--text2)';
}

// Module scope: useQueryState memoises on this array.
const INCIDENT_KEYS = ['who'] as const;

export default function Incidents() {
  const app = useApp();
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  // "Which incident is on your screen?" is the first question of every handover, and
  // in useState it had no answer that could be pasted into one.
  const [selectedId, setSelectedId] = useOverlayParam('incident');
  const [showNew, setShowNew] = useState(false);
  const [comps, setComps] = useState<Component[]>([]);
  // Also a refinement, also in the query — "the incidents assigned to Nadia" is a link.
  const [q, setQ] = useQueryState(INCIDENT_KEYS);
  const who = q.who || '';
  const setWho = (v: string) => setQ({ who: v || null });

  // `sel` is read from the closure rather than through a functional update: the URL is
  // the source of truth now, so there is no setState queue to sequence against.
  const load = async (selectId?: number, sel = selectedId) => {
    const rows = await api.get<Incident[]>('/api/incidents');
    setIncidents(rows);
    // An explicit pick is the reader's and PUSHES; keeping or defaulting a selection is
    // ours and REPLACES — this page always has a row open, so pushing the automatic one
    // would leave Back pointing at a state the page instantly undoes.
    // Re-asserting the row that is already open is a REFRESH after a mutation, not a
    // navigation — `reload(incident.id)` fires on every status change, and after a deep
    // link (where no entry is ours yet) that would push a duplicate the reader has to
    // press Back through twice to escape.
    if (selectId != null) { setSelectedId(selectId, selectId === sel); return; }
    if (sel != null && rows.some((r) => r.id === sel)) return;
    setSelectedId(rows[0]?.id ?? null, true);
  };
  useEffect(() => { load().catch(() => setIncidents([])); }, []);
  useEffect(() => { api.get<Component[]>('/api/admin/components').then(setComps).catch(() => {}); }, []);

  const selected = useMemo(
    () => incidents?.find((i) => i.id === selectedId) ?? null,
    [incidents, selectedId],
  );
  const shown = useMemo(() => {
    if (!incidents) return null;
    if (who === '') return incidents;
    // `Number(who)` — users.id is a UUID, so this was NaN, and `assigneeId === NaN` is
    // false for every row: picking a colleague from the filter showed an empty list and
    // looked like they had no incidents. Only "Anyone" and "me" ever worked. This is the
    // exact shape CLAUDE.md's identity-keys rule names, and the type gate cannot see it —
    // `string | undefined` and `string | number | undefined` overlap, so === is allowed.
    const id = who === 'me' ? app.user?.id : who;
    return incidents.filter((i) => i.assigneeId === id);
  }, [incidents, who, app.user]);

  return (
    <div className="page-console split">
      {/* ---------------------------------------------------------- list */}
      <div className="split-master">
        <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px',
          borderBottom: '1px solid var(--bg3)', flexShrink: 0 }}>
          <span className="text-lg font-bold text-text0">Incidents</span>
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}><PlusIcon size={13} /> New Incident</Button>
        </div>
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--bg3)', flexShrink: 0 }}>
          <Select title="Assignee filter" aria-label="Filter by assignee" value={who} onChange={setWho}
            options={[{ value: '', label: 'Anyone' }, { value: 'me', label: 'Assigned to me' },
              ...app.users.map((u) => ({ value: String(u.id), label: u.name }))]} />
        </div>
        <div className="split-master-scroll">
          {shown === null && <ListSkeleton rows={5} lines={3} />}
          {shown && shown.length === 0 && (
            <div className="text-text3 text-sm" style={{ padding: 24}}>
              {who === '' ? 'No incidents yet — declare one with “+ New Incident”.'
                : 'No incidents for this assignee.'}
            </div>
          )}
          {shown?.map((inc) => {
            const c = sevColor(inc.severity);
            const active = inc.id === selectedId;
            return (
              <div key={inc.id} onClick={() => setSelectedId(inc.id)}
                style={{ cursor: 'pointer', padding: '10px 14px', borderBottom: '1px solid var(--bg3)',
                  borderLeft: active ? `2px solid ${c}` : '2px solid transparent',
                  background: active ? alpha(c, 0.06) : undefined }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="mono text-sm" style={{ color: SEV.low }}>{inc.label}</span>
                  <StatusPill text={inc.status} color={STATUS_COLOR[inc.status]} />
                </div>
                <div style={{ marginBottom: 6 }}><SevBadge score={inc.severity} /></div>
                <div className="text-base text-text0" style={{ marginBottom: 5, ...CLAMP2 }}>{inc.title}</div>
                <div className="mono text-2xs text-text3">
                  started {fmtTime(inc.startedAt)} · {fmtDuration(inc.durationMs)}
                  {inc.assignee ? ` · ${inc.assignee}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------------- detail */}
      <div className="split-detail">
        {incidents === null
          ? <TextSkeleton lines={6} />
          : !selected
          ? <div className="text-text3 text-base">Select an incident to view its timeline and RCA.</div>
          : <IncidentDetail key={selected.id} incident={selected} comps={comps} reload={load} />}
      </div>

      {showNew && <NewIncidentModal comps={comps} onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); load(id); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ impact picker

// Affected components with a per-component impact on the app-wide status
// scale — the component's public status is DERIVED from these while the
// incident is open (docs/INCIDENTS-V2.md §2).
function ImpactPicker({ comps, value, onChange }: {
  comps: Component[];
  value: { id: number; impact: Impact }[];
  onChange: (v: { id: number; impact: Impact }[]) => void;
}) {
  return (
    <>
      <MultiSelect title="Affected components" placeholder="No components affected"
        value={value.map((c) => String(c.id))}
        onChange={(ids) => onChange(ids.map((s) =>
          value.find((v) => String(v.id) === s) ?? { id: Number(s), impact: 'degraded' as Impact }))}
        options={comps.map((c) => ({ value: String(c.id), label: c.name }))} />
      {value.map((v) => (
        <div key={v.id} className="row" style={{ gap: 8, marginTop: 6 }}>
          <span className="text-sm text-text1" style={{ flex: 1, minWidth: 0, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {comps.find((c) => c.id === v.id)?.name ?? `#${v.id}`}</span>
          <Select title="Impact" aria-label="Impact" value={v.impact}
            style={{ width: 150, flexShrink: 0 }}
            onChange={(imp) => onChange(value.map((x) => (x.id === v.id ? { ...x, impact: imp as Impact } : x)))}
            options={IMPACTS.map((i) => ({ value: i, label: STATUS_META[i].label }))} />
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ detail

function IncidentDetail({ incident, comps, reload }:
  { incident: Incident; comps: Component[]; reload: (id?: number) => Promise<void> }) {
  const app = useApp();
  const [draft, setDraft] = useState(() => ({
    summary: incident.rca?.summary ?? '',
    impact: incident.rca?.impact ?? '',
    rootCause: incident.rca?.rootCause ?? '',
    resolution: incident.rca?.resolution ?? '',
    actions: incident.rca?.actions ?? '',
  }));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: Incident['status']) => {
    await api.post(`/api/incidents/${incident.id}/status`, { status });
    await reload(incident.id);
  };
  const setAssignee = async (v: string) => {
    // NOT Number(v): a user id is a uuid since migration 21, Number('7f3a…') is
    // NaN, and JSON.stringify turns NaN into null — which this endpoint reads as
    // "clear the assignee". Assigning somebody silently unassigned instead.
    await api.patch(`/api/incidents/${incident.id}`, { assigneeId: v === '' ? null : v });
    await reload(incident.id);
  };
  const setComponents = async (v: { id: number; impact: Impact }[]) => {
    await api.patch(`/api/incidents/${incident.id}`, { components: v });
    await reload(incident.id);
  };
  const togglePublish = async () => {
    await api.patch(`/api/incidents/${incident.id}`, { published: !incident.published });
    await reload(incident.id);
  };
  const saveRca = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/incidents/${incident.id}`, { rca: draft });
      await reload(incident.id);
      setDirty(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setBusy(false); }
  };

  const updates = [...incident.updates].reverse();

  return (
    <>
      {/* header — a toolbar, so it wraps on phones instead of pushing sideways */}
      <div className="row row-wrap" style={{ gap: 8, marginBottom: 8 }}>
        <span className="mono text-base" style={{ color: SEV.low }}>{incident.label}</span>
        <SevBadge score={incident.severity} />
        <StatusPill text={incident.status} color={STATUS_COLOR[incident.status]} />
        <div style={{ flex: 1 }} />
        <button className="pill" onClick={() => { app.setBridgeIncident(incident.id); app.setNav('bridge'); }}
          style={{ cursor: 'pointer', color: SEV.cyan, background: alpha(SEV.cyan, 0.1),
            border: `1px solid ${alpha(SEV.cyan, 0.3)}` }}>
          Open the Bridge
        </button>
        <button className="pill" onClick={togglePublish} style={{ cursor: 'pointer', ...(incident.published
          ? { color: SEV.green, background: alpha(SEV.green, 0.12), border: `1px solid ${alpha(SEV.green, 0.3)}` }
          : { color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)' }) }}>
          {incident.published && <CheckIcon size={12} />}
          {incident.published ? 'On public status page' : 'Not published'}
        </button>
      </div>
      <h1 className="font-bold text-text0" style={{ fontSize: 17, margin: '0 0 18px' }}>{incident.title}</h1>

      {/* set status */}
      <div className="micro text-2xs" style={{ marginBottom: 8 }}>Set Status</div>
      <div className="row" style={{ gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {STATUSES.map((s) => {
          const col = STATUS_COLOR[s];
          const on = incident.status === s;
          return (
            <Button size="sm" key={s} onClick={() => setStatus(s)}
 style={{ color: col, borderColor: col, textTransform: 'capitalize',
 background: on ? alpha(col, 0.15) : 'transparent' }}>{s}</Button>
          );
        })}
      </div>

      {/* impact & ownership */}
      <Card style={{ marginBottom: 18 }}>
        <div className="card-title">Impact &amp; ownership</div>
        <div className="row row-wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: '0 1 240px', minWidth: 200 }}>
            <span className="micro text-2xs" style={{ display: 'block', marginBottom: 4 }}>Assignee</span>
            <Select title="Assignee" placeholder="— unassigned" aria-label="Assignee"
              value={incident.assigneeId ? String(incident.assigneeId) : ''} onChange={setAssignee}
              options={[{ value: '', label: '— unassigned' },
                ...app.users.map((u) => ({ value: String(u.id), label: u.name }))]} />
          </div>
          <div style={{ flex: '1 1 260px', minWidth: 220 }}>
            <span className="micro text-2xs" style={{ display: 'block', marginBottom: 4 }}>
              Affected components</span>
            <ImpactPicker comps={comps} value={incident.components} onChange={setComponents} />
            {incident.components.length > 0 && (
              <div className="text-2xs text-text3" style={{ marginTop: 6 }}>
                Component status on the public page follows the worst impact of open incidents.
              </div>
            )}
          </div>
        </div>
        {incident.links.length > 0 && (
          <div className="row row-wrap" style={{ gap: 6, marginTop: 12 }}>
            <span className="micro text-2xs">Linked</span>
            {incident.links.map((l) => (
              <span key={`${l.kind}${l.refId}`} className="pill mono text-xs"
                style={{ color: SEV.low, background: alpha(SEV.low, 0.1),
                  border: `1px solid ${alpha(SEV.low, 0.3)}` }}>
                {l.kind === 'case' ? l.label : `event ${l.label}`}
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* timeline */}
      <Card style={{ marginBottom: 18 }}>
        <div className="card-title">Timeline</div>
        {updates.length === 0 && <div className="text-sm text-text3">No updates yet.</div>}
        {updates.map((u, i) => (
          <div key={i} className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '7px 0',
            borderBottom: i < updates.length - 1 ? '1px solid var(--bg3)' : undefined }}>
            <span className="mono text-xs text-text3" style={{ width: 140, flexShrink: 0 }}>
              {fmtDateTime(u.ts)}</span>
            <StatusPill text={u.status} color={statusColor(u.status)} />
            {/* min-width: 0 lets the flex item shrink below its content; the
                message then wraps instead of pushing the page sideways */}
            <span className="text-sm text-text1" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {u.message}</span>
          </div>
        ))}
      </Card>

      {/* RCA editor */}
      <Card>
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>Root Cause Analysis</span>
          {saved && <span className="row mono text-xs" style={{ color: SEV.green, gap: 4 }}>
            <CheckIcon size={12} /> saved</span>}
        </div>
        {RCA_FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'block', marginBottom: 12 }}>
            <span className="micro text-2xs" style={{ display: 'block', marginBottom: 4 }}>{f.label}</span>
            <Textarea className="rca" value={draft[f.key]}
              onChange={(e) => { setDraft((d) => ({ ...d, [f.key]: e.target.value })); setDirty(true); setSaved(false); }} />
          </label>
        ))}
        <Button variant="primary" onClick={saveRca} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save RCA'}
        </Button>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ new modal

function NewIncidentModal({ comps, onClose, onCreated }:
  { comps: Component[]; onClose: () => void; onCreated: (id?: number) => void }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState(70);
  const [message, setMessage] = useState('');
  // everything below is optional — declare-fast stays two fields
  const [assignee, setAssignee] = useState(app.user ? String(app.user.id) : '');
  const [impacted, setImpacted] = useState<{ id: number; impact: Impact }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const inc = await api.post<Incident>('/api/incidents', {
        title, severity, message,
        assigneeId: assignee === '' ? null : assignee,   // uuid, never Number()
        components: impacted,
      });
      onCreated(inc?.id);
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="New Incident" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Title">
          <Input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Elevated API error rate" />
        </Field>
        <Field label="Severity (0–100)">
          <Input type="number" min={0} max={100} value={severity}
            onChange={(e) => setSeverity(Number(e.target.value))} />
        </Field>
        <Field label="Initial message">
          <Textarea className="rca" value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="We are investigating reports of…" />
        </Field>
        <Field label="Assignee">
          <Select title="Assignee" placeholder="— unassigned" aria-label="Assignee"
            value={assignee} onChange={setAssignee}
            options={[{ value: '', label: '— unassigned' },
              ...app.users.map((u) => ({ value: String(u.id), label: u.name }))]} />
        </Field>
        {comps.length > 0 && (
          <Field label="Affected components">
            <ImpactPicker comps={comps} value={impacted} onChange={setImpacted} />
          </Field>
        )}
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy || !title}>{busy ? '…' : 'Create incident'}</Button>
      </form>
    </Modal>
  );
}
