// Incidents — master-detail: incident list + status timeline + RCA editor.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { SEV, alpha, sevColor, fmtTime, fmtDuration, fmtDateTime } from '../format';
import { SevBadge, StatusPill, Modal, Field } from '../ui';
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
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* ---------------------------------------------------------- list */}
      <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--bg3)',
        display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px',
          borderBottom: '1px solid var(--bg3)', flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text0)' }}>Incidents</span>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New Incident</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {incidents === null && (
            <div className="mono" style={{ padding: 24, color: 'var(--text3)', fontSize: 11 }}>loading…</div>
          )}
          {incidents && incidents.length === 0 && (
            <div style={{ padding: 24, color: 'var(--text3)', fontSize: 11 }}>
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
                  <span className="mono" style={{ fontSize: 11, color: SEV.low }}>{inc.label}</span>
                  <StatusPill text={inc.status} color={STATUS_COLOR[inc.status]} />
                </div>
                <div style={{ marginBottom: 6 }}><SevBadge score={inc.severity} /></div>
                <div style={{ fontSize: 12, color: 'var(--text0)', marginBottom: 5, ...CLAMP2 }}>{inc.title}</div>
                <div className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>
                  started {fmtTime(inc.startedAt)} · {fmtDuration(inc.durationMs)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------------- detail */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', minWidth: 0 }}>
        {!selected
          ? <div style={{ color: 'var(--text3)', fontSize: 12 }}>Select an incident to view its timeline and RCA.</div>
          : <IncidentDetail key={selected.id} incident={selected} reload={load} />}
      </div>

      {showNew && <NewIncidentModal onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); load(id); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ detail

function IncidentDetail({ incident, reload }: { incident: Incident; reload: (id?: number) => Promise<void> }) {
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
        <span className="mono" style={{ fontSize: 12, color: SEV.low }}>{incident.label}</span>
        <SevBadge score={incident.severity} />
        <StatusPill text={incident.status} color={STATUS_COLOR[incident.status]} />
        <div style={{ flex: 1 }} />
        <button className="pill" onClick={togglePublish} style={{ cursor: 'pointer', ...(incident.published
          ? { color: SEV.green, background: alpha(SEV.green, 0.12), border: `1px solid ${alpha(SEV.green, 0.3)}` }
          : { color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)' }) }}>
          {incident.published ? '✓ On public status page' : 'Not published'}
        </button>
      </div>
      <h1 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text0)', margin: '0 0 18px' }}>{incident.title}</h1>

      {/* set status */}
      <div className="micro" style={{ fontSize: 9, marginBottom: 8 }}>Set Status</div>
      <div className="row" style={{ gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {STATUSES.map((s) => {
          const col = STATUS_COLOR[s];
          const on = incident.status === s;
          return (
            <button key={s} className="btn btn-sm" onClick={() => setStatus(s)}
              style={{ color: col, borderColor: col, textTransform: 'capitalize',
                background: on ? alpha(col, 0.15) : 'transparent' }}>{s}</button>
          );
        })}
      </div>

      {/* timeline */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-title">Timeline</div>
        {updates.length === 0 && <div style={{ fontSize: 11, color: 'var(--text3)' }}>No updates yet.</div>}
        {updates.map((u, i) => (
          <div key={i} className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '7px 0',
            borderBottom: i < updates.length - 1 ? '1px solid var(--bg3)' : undefined }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text3)', width: 140, flexShrink: 0 }}>
              {fmtDateTime(u.ts)}</span>
            <StatusPill text={u.status} color={statusColor(u.status)} />
            <span style={{ fontSize: 11, color: 'var(--text1)' }}>{u.message}</span>
          </div>
        ))}
      </div>

      {/* RCA editor */}
      <div className="card">
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>Root Cause Analysis</span>
          {saved && <span className="mono" style={{ fontSize: 10, color: SEV.green }}>saved ✓</span>}
        </div>
        {RCA_FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'block', marginBottom: 12 }}>
            <span className="micro" style={{ fontSize: 9, display: 'block', marginBottom: 4 }}>{f.label}</span>
            <textarea className="rca" value={draft[f.key]}
              onChange={(e) => { setDraft((d) => ({ ...d, [f.key]: e.target.value })); setDirty(true); setSaved(false); }} />
          </label>
        ))}
        <button className="btn btn-primary" onClick={saveRca} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save RCA'}
        </button>
      </div>
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
          <input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Elevated API error rate" />
        </Field>
        <Field label="Severity (0–100)">
          <input type="number" min={0} max={100} value={severity}
            onChange={(e) => setSeverity(Number(e.target.value))} />
        </Field>
        <Field label="Initial message">
          <textarea className="rca" value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="We are investigating reports of…" />
        </Field>
        {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !title}>{busy ? '…' : 'Create incident'}</button>
      </form>
    </Modal>
  );
}
