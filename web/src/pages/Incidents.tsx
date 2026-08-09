// Incidents — master-detail: incident list + status timeline + RCA editor.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../state';
import { SEV, alpha, sevColor, fmtTime, fmtDuration, fmtDateTime } from '../format';
import { Card, Button, SevBadge, StatusPill, Modal, Field, ListSkeleton, TextSkeleton, Input, Textarea} from '../ui';
import type { Incident } from '../types';

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

export default function Incidents() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = async (selectId?: number) => {
    const rows = await api.get<Incident[]>('/api/incidents');
    setIncidents(rows);
    setSelectedId((cur) => {
      if (selectId != null) return selectId;
      if (cur != null && rows.some((r) => r.id === cur)) return cur;
      return rows[0]?.id ?? null;
    });
  };
  useEffect(() => { load().catch(() => setIncidents([])); }, []);

  const selected = useMemo(
    () => incidents?.find((i) => i.id === selectedId) ?? null,
    [incidents, selectedId],
  );

  return (
    <div className="page-console" style={{ display: 'flex', minHeight: 0 }}>
      {/* ---------------------------------------------------------- list */}
      <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--bg3)',
        display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px',
          borderBottom: '1px solid var(--bg3)', flexShrink: 0 }}>
          <span className="text-lg font-bold text-text0">Incidents</span>
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>+ New Incident</Button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {incidents === null && <ListSkeleton rows={5} lines={3} />}
          {incidents && incidents.length === 0 && (
            <div className="text-text3 text-sm" style={{ padding: 24}}>
              No incidents yet — declare one with “+ New Incident”.
            </div>
          )}
          {incidents?.map((inc) => {
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
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------------- detail */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', minWidth: 0 }}>
        {incidents === null
          ? <TextSkeleton lines={6} />
          : !selected
          ? <div className="text-text3 text-base">Select an incident to view its timeline and RCA.</div>
          : <IncidentDetail key={selected.id} incident={selected} reload={load} />}
      </div>

      {showNew && <NewIncidentModal onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); load(id); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ detail

function IncidentDetail({ incident, reload }: { incident: Incident; reload: (id?: number) => Promise<void> }) {
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
      {/* header */}
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
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
          {incident.published ? '✓ On public status page' : 'Not published'}
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
            <span className="text-sm text-text1">{u.message}</span>
          </div>
        ))}
      </Card>

      {/* RCA editor */}
      <Card>
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>Root Cause Analysis</span>
          {saved && <span className="mono text-xs" style={{ color: SEV.green }}>saved ✓</span>}
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

function NewIncidentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id?: number) => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState(70);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const inc = await api.post<Incident>('/api/incidents', { title, severity, message });
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
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy || !title}>{busy ? '…' : 'Create incident'}</Button>
      </form>
    </Modal>
  );
}
