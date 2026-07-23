// Cases — triage queue with status tabs and an inline case editor.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { sevColor, fmtDuration } from '../format';
import { SevBadge, StatusPill, Avatar, Modal, Field, TableScroll } from '../ui';
import type { CaseRow, UserRow } from '../types';

const TABS = ['all', 'open', 'assigned', 'closed'] as const;
type Tab = typeof TABS[number];
const STATUS_COLORS: Record<CaseRow['status'], string> = {
  open: '#e3b341', assigned: '#388bfd', closed: '#8b949e',
};
const COLS = '90px 90px 1fr 140px 90px 140px 140px 80px';

export default function Cases() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('all');
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [editing, setEditing] = useState<CaseRow | null>(null);

  const load = () => api.get<CaseRow[]>('/api/cases').then(setCases).catch(() => {});
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { open: 0, assigned: 0, closed: 0 };
    (cases || []).forEach((x) => { c[x.status]++; });
    return c;
  }, [cases]);

  const rows = useMemo(() => {
    if (!cases) return [];
    return tab === 'all' ? cases : cases.filter((c) => c.status === tab);
  }, [cases, tab]);

  return (
    <div className="page">
      <h1 className="page-title">Cases</h1>

      <div className="row" style={{ gap: 4, borderBottom: '1px solid var(--bg3)' }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 12px', fontSize: 12, textTransform: 'capitalize', marginBottom: -1,
            color: tab === t ? 'var(--text0)' : 'var(--text2)',
            borderBottom: tab === t ? '2px solid #388bfd' : '2px solid transparent',
          }}>
            {t}{t !== 'all' && <span className="mono" style={{ marginLeft: 5, fontSize: 10,
              color: 'var(--text3)' }}>{counts[t]}</span>}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <TableScroll minWidth={900}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Case</span><span>Sev</span><span>Event</span><span>Server</span>
          <span>Status</span><span>Assignee</span><span>Root Cause</span>
          <span style={{ textAlign: 'right' }}>Duration</span>
        </div>
        {!cases ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
            {tab === 'all' ? 'no cases yet' : `no ${tab} cases`}
          </div>
        ) : rows.map((c) => (
          <div key={c.id} className="tbl-row" style={{ gridTemplateColumns: COLS, cursor: 'pointer' }}
            onClick={() => setEditing(c)}>
            <span className="mono" style={{ fontSize: 11, color: '#388bfd' }}>{c.label}</span>
            <SevBadge score={c.severity} />
            <span className="mono" style={{ fontSize: 11, color: sevColor(c.severity), overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text1)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.device}</span>
            <StatusPill text={c.status} color={STATUS_COLORS[c.status]} />
            {c.assigned ? (
              <span className="row" style={{ gap: 6, minWidth: 0 }}>
                <Avatar i={c.assigned.i} c={c.assigned.c} size={20} />
                <span style={{ fontSize: 11, color: 'var(--text1)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.assigned.n}</span>
              </span>
            ) : <span style={{ color: 'var(--text3)' }}>—</span>}
            <span className="mono" style={{ fontSize: 10, color: c.rootCause ? 'var(--text2)' : 'var(--text3)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.rootCause || '—'}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text1)', textAlign: 'right' }}>
              {fmtDuration(c.durationMs)}</span>
          </div>
        ))}
        </TableScroll>
      </div>

      {editing && (
        <CaseEditor c={editing} users={app.users} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function CaseEditor({ c, users, onClose, onSaved }:
  { c: CaseRow; users: UserRow[]; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<CaseRow['status']>(c.status);
  const [assignee, setAssignee] = useState<string>(c.assigned ? String(c.assigned.id) : '');
  const [rootCause, setRootCause] = useState(c.rootCause ?? '');
  const [note, setNote] = useState(c.note ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/cases/${c.id}`, {
        status,
        assignedUserId: assignee === '' ? null : Number(assignee),
        rootCause: rootCause.trim() || null,
        note: note.trim() || null,
      });
      onSaved();
    } catch { setSaving(false); }
  };

  return (
    <Modal title={`Edit ${c.label}`} onClose={onClose} width={460}>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>
        <span className="mono" style={{ color: sevColor(c.severity) }}>{c.name}</span>
        <span className="mono" style={{ color: 'var(--text3)' }}> · {c.device}</span>
      </div>
      <Field label="Status">
        <select value={status} onChange={(e) => setStatus(e.target.value as CaseRow['status'])}>
          <option value="open">open</option>
          <option value="assigned">assigned</option>
          <option value="closed">closed</option>
        </select>
      </Field>
      <Field label="Assignee">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">— unassigned</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </Field>
      <Field label="Root Cause">
        <input value={rootCause} onChange={(e) => setRootCause(e.target.value)}
          placeholder="e.g. upstream DNS timeout" />
      </Field>
      <Field label="Note">
        <textarea className="rca" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
