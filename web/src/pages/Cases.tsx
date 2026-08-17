// Cases — triage queue with status tabs and an inline case editor.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useTab } from '../state';
import { api } from '../api';
import { sevColor, fmtDuration, alertStatusLabel, alertStatusColor, SEV } from '../format';
import { Card, Button, SevBadge, StatusPill, Avatar, Modal, Field, TableScroll, TableSkeleton, PageHeader, Tabs, Input, Textarea, COL} from '../ui';
import { Select } from '../Select';
import type { CaseRow, UserRow } from '../types';

const TABS = ['all', 'open', 'assigned', 'closed'] as const;
type Tab = typeof TABS[number];
const STATUS_COLORS: Record<CaseRow['status'], string> = {
  open: '#e3b341', assigned: '#388bfd', closed: '#8b949e',
};
// Case | Sev | Event | Server | Status | Alert | Assignee | Root Cause | Duration.
// Seven of the eight tracks were fixed, so "Event" absorbed the whole window while
// Root Cause — free text an analyst wrote — stayed at 140px and truncated.
const COLS = [COL.id, COL.status, COL.text, COL.textWide, COL.status, COL.status, COL.label,
  COL.text, COL.age].join(' ');

export default function Cases() {
  const app = useApp();
  const [tab, setTab] = useTab(TABS);
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
      <PageHeader title="Cases" />

      <Tabs value={tab} onChange={setTab}
        tabs={TABS.map((t) => [t, t === 'all' ? 'All' : `${t[0].toUpperCase()}${t.slice(1)} ${counts[t]}`] as const)} />

      <Card style={{ padding: 0 }}>
        <TableScroll cols={COLS} stickyFirst minWidth={1010}>
        <div className="tbl-head">
          <span>Case</span><span>Sev</span><span>Event</span><span>Server</span>
          <span>Status</span><span>Alert</span><span>Assignee</span><span>Root Cause</span>
          <span style={{ textAlign: 'right' }}>Duration</span>
        </div>
        {!cases ? (
          <TableSkeleton rows={6} />
        ) : rows.length === 0 ? (
          <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center'}}>
            {tab === 'all' ? 'no cases yet' : `no ${tab} cases`}
          </div>
        ) : rows.map((c) => (
          <div key={c.id} className="tbl-row" style={{ cursor: 'pointer' }}
            onClick={() => setEditing(c)}>
            <span className="mono text-sm" style={{ color: '#388bfd' }}>{c.label}</span>
            <SevBadge score={c.severity} />
            <span className="mono text-sm" style={{ color: sevColor(c.severity), overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span className="mono text-sm text-text1" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.device}</span>
            <StatusPill text={c.status} color={STATUS_COLORS[c.status]} />
            {/* "is anybody being woken about this, and did they answer" — the
                question a handover starts with, next to the case it is about */}
            {c.alert
              ? <StatusPill text={alertStatusLabel(c.alert.status)} color={alertStatusColor(c.alert.status)} />
              : <span className="text-text3">—</span>}
            {c.assigned ? (
              <span className="row" style={{ gap: 6, minWidth: 0 }}>
                <Avatar i={c.assigned.i} c={c.assigned.c} size={20} />
                <span className="text-sm text-text1" style={{ overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.assigned.n}</span>
              </span>
            ) : <span className="text-text3">—</span>}
            <span className="mono text-xs" style={{ color: c.rootCause ? 'var(--text2)' : 'var(--text3)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.rootCause || '—'}</span>
            <span className="mono text-sm text-text1" style={{ textAlign: 'right' }}>
              {fmtDuration(c.durationMs)}</span>
          </div>
        ))}
        </TableScroll>
      </Card>

      {editing && (
        <CaseEditor c={editing} users={app.users} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function CaseEditor({ c, users, onClose, onSaved }:
  { c: CaseRow; users: UserRow[]; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const [status, setStatus] = useState<CaseRow['status']>(c.status);
  const [assignee, setAssignee] = useState<string>(c.assigned ? String(c.assigned.id) : '');
  const [rootCause, setRootCause] = useState(c.rootCause ?? '');
  const [note, setNote] = useState(c.note ?? '');
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [acking, setAcking] = useState(false);
  const canPromote = app.user ? app.user.role !== 'analyst' : false; // lead+

  // "I have seen it, stop ringing." It acknowledges the case AND whatever is
  // escalating about it, and it deliberately does NOT assign — owning the work
  // is a separate statement (docs/ONCALL-V1.md §13.4). Spent the moment the case
  // carries an ack, and the endpoint answers 409 for the same call.
  const acknowledge = async () => {
    setAcking(true);
    try { await api.post(`/api/cases/${c.id}/ack`, {}); onSaved(); }
    catch { setAcking(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/cases/${c.id}`, {
        status,
        assignedUserId: assignee === '' ? null : assignee,
        rootCause: rootCause.trim() || null,
        note: note.trim() || null,
      });
      onSaved();
    } catch { setSaving(false); }
  };
  // case → incident: prefills from the case, links case + event, drops a note
  const promote = async () => {
    setPromoting(true);
    try {
      await api.post(`/api/cases/${c.id}/promote`, {});
      onSaved();
      app.setNav('incidents');
    } catch { setPromoting(false); }
  };

  return (
    <Modal title={`Edit ${c.label}`} onClose={onClose} width={460}>
      <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between', gap: 8 }}>
        <span className="text-sm text-text2" style={{ minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span className="mono" style={{ color: sevColor(c.severity) }}>{c.name}</span>
          <span className="mono text-text3"> · {c.device}</span>
        </span>
        {c.incident ? (
          <span className="pill mono text-xs" title="This case was promoted to an incident"
            style={{ color: '#388bfd', background: 'rgba(56,139,253,0.1)',
              border: '1px solid rgba(56,139,253,0.3)', flexShrink: 0 }}>
            {c.incident.label}
          </span>
        ) : canPromote && (
          <Button size="sm" onClick={promote} disabled={promoting}
            title="Open an incident from this case — links the case and its event, prefills title and severity">
            {promoting ? 'Promoting…' : 'Promote to Incident'}
          </Button>
        )}
      </div>
      <div className="row row-wrap" style={{ gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <Button size="sm" disabled={!!c.ackedAt || acking} onClick={acknowledge}
          title="Stop the escalation. Does not assign the case to you.">
          {c.ackedAt ? 'Acknowledged' : acking ? 'Acknowledging…' : 'Acknowledge'}
        </Button>
        {c.ackedAt && c.ackedBy && (
          <span className="text-sm text-text3">by {c.ackedBy.n}</span>
        )}
        {c.alert && (
          <StatusPill text={alertStatusLabel(c.alert.status)} color={alertStatusColor(c.alert.status)} />
        )}
        {c.alert && c.alert.status === 'active' && (
          <span className="text-xs" style={{ color: SEV.critical }}>
            step {c.alert.step + 1} of {c.alert.policyName ?? 'the policy'}
          </span>
        )}
      </div>
      <Field label="Status">
        <Select title="Status" value={status}
          onChange={(v) => setStatus(v as CaseRow['status'])}
          options={[{ value: 'open', label: 'open' }, { value: 'assigned', label: 'assigned' },
            { value: 'closed', label: 'closed' }]} />
      </Field>
      <Field label="Assignee">
        {/* the team list is data — it can grow past the point where scrolling a
            native option list is reasonable, so this one searches itself */}
        <Select title="Assignee" placeholder="— unassigned" aria-label="Assignee"
          value={assignee} onChange={setAssignee}
          options={[{ value: '', label: '— unassigned' },
            ...users.map((u) => ({ value: String(u.id), label: u.name }))]} />
      </Field>
      <Field label="Root Cause">
        <Input value={rootCause} onChange={(e) => setRootCause(e.target.value)}
          placeholder="e.g. upstream DNS timeout" />
      </Field>
      <Field label="Note">
        <Textarea className="rca" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
  );
}
