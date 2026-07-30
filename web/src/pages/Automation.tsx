// Automation — trigger → actions rules run by the server engine against
// pipeline events: lifecycle auto-close (clear event finishes its raise
// event), case auto-assign, outbound webhooks. Every run is audited.
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { SEV } from '../format';
import { Modal, Field, Toggle, TableScroll, TableSkeleton, ListSkeleton, PageHeader, Input} from '../ui';
import { Select } from '../Select';

interface TeamMember { id: number; name: string; role: string; }
interface AutomationAction { type: 'close_event' | 'assign_case' | 'webhook';
  raiseEvent?: string; matchTarget?: boolean; userId?: number; url?: string; }
interface AutomationRow {
  id: number; name: string; enabled: boolean;
  trigger: { event: string; severityMin: number } | null;
  actions: AutomationAction[]; cooldownM: number; createdAt: number;
}
interface RunRow { ts: number; detail: string; }

const GRID = 'minmax(160px,1.4fr) minmax(150px,1.2fr) minmax(220px,2fr) 90px 80px 60px';
const RANK: Record<string, number> = { analyst: 1, lead: 2, cto: 3, admin: 4 };

function actionSummary(a: AutomationAction, team: TeamMember[]): string {
  if (a.type === 'close_event') {
    return `close ${a.raiseEvent}${a.matchTarget !== false ? ' (same target)' : ''}`;
  }
  if (a.type === 'assign_case') {
    const u = team.find((t) => t.id === a.userId);
    return `assign case → ${u ? u.name : `user #${a.userId}`}`;
  }
  return `webhook → ${(a.url || '').replace(/^https?:\/\//, '').slice(0, 40)}`;
}

export default function Automation() {
  const app = useApp();
  const canEdit = (RANK[app.user?.role || ''] || 0) >= 2;
  const [rows, setRows] = useState<AutomationRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [editing, setEditing] = useState<AutomationRow | 'new' | null>(null);

  const load = () => {
    api.get<AutomationRow[]>('/api/admin/automations').then(setRows).catch(() => setRows([]));
    api.get<RunRow[]>('/api/admin/automations/runs?limit=30').then(setRuns).catch(() => setRuns([]));
  };
  useEffect(() => {
    load();
    api.get<TeamMember[]>('/api/team').then(setTeam).catch(() => {});
  }, []);

  return (
    <div className="page">
      <PageHeader title="Automation">
        {canEdit && <button className="btn btn-sm" onClick={() => setEditing('new')}>+ New automation</button>}
      </PageHeader>

      <div className="card">
        <div className="card-title">Rules</div>
        <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
          When an event matches the trigger, the actions run — at most once per event
          and cooldown window. Every run is recorded in the audit trail below.
        </div>
        <TableScroll stickyFirst minWidth={780}>
          <div className="tbl-head" style={{ gridTemplateColumns: GRID, padding: '8px 0' }}>
            <span>Name</span><span>Trigger</span><span>Actions</span>
            <span>Cooldown</span><span>Enabled</span><span></span>
          </div>
          {rows === null && <TableSkeleton cols={GRID} rows={3} flush />}
          {rows?.length === 0 && (
            <div className="text-text3 text-base" style={{ padding: 20, textAlign: 'center'}}>
              No automations yet{canEdit ? ' — create the first one, e.g. a lifecycle rule that closes an event when its recovery event arrives.' : '.'}
            </div>
          )}
          {rows?.map((r) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8,
              padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <button onClick={canEdit ? () => setEditing(r) : undefined} title={canEdit ? 'Edit' : undefined}
                className="text-sm text-text0 font-semibold" style={{ textAlign: 'left',
                  cursor: canEdit ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' }}>{r.name}</button>
              <span className="mono text-xs text-text2" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.trigger ? `${r.trigger.event}${r.trigger.severityMin ? ` · sev ≥ ${r.trigger.severityMin}` : ''}` : 'invalid'}
              </span>
              <span className="mono text-xs text-text2" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.actions.map((a) => actionSummary(a, team)).join(' · ')}
              </span>
              <span className="mono text-xs text-text2">{r.cooldownM}m</span>
              <Toggle on={r.enabled} disabled={!canEdit}
                onClick={canEdit ? () => api.patch(`/api/admin/automations/${r.id}`, { enabled: !r.enabled }).then(load) : undefined} />
              <span>
                {canEdit && (
                  <button className="text-lg" title="Delete automation" style={{ color: SEV.critical}}
                    onClick={() => {
                      if (confirm(`Delete automation "${r.name}"?`)) {
                        api.del(`/api/admin/automations/${r.id}`).then(load);
                      }
                    }}>×</button>
                )}
              </span>
            </div>
          ))}
        </TableScroll>
      </div>

      <div className="card">
        <div className="card-title">Recent runs</div>
        {runs === null && <ListSkeleton rows={3} lines={1} />}
        {runs?.length === 0 && (
          <div className="text-text3 text-base" style={{ padding: 12, textAlign: 'center'}}>
            No runs yet.
          </div>
        )}
        {runs?.map((r, i) => (
          <div key={i} className="row" style={{ gap: 10, padding: '5px 0', borderBottom: '1px solid var(--bg3)' }}>
            <span className="mono text-xs text-text3" style={{ flexShrink: 0 }}>
              {new Date(r.ts).toLocaleString()}</span>
            <span className="mono text-xs" style={{ wordBreak: 'break-word',
              color: r.detail.includes('FAILED') ? SEV.critical : 'var(--text1)' }}>{r.detail}</span>
          </div>
        ))}
      </div>

      {editing && (
        <EditModal existing={editing === 'new' ? null : editing} team={team}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- edit modal

const ACTION_TYPES = [
  { value: 'close_event', label: 'Close event (lifecycle)' },
  { value: 'assign_case', label: 'Assign case' },
  { value: 'webhook', label: 'Send webhook' },
];

function EditModal({ existing, team, onClose, onSaved }: {
  existing: AutomationRow | null; team: TeamMember[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name || '');
  const [triggerEvent, setTriggerEvent] = useState(existing?.trigger?.event || '');
  const [severityMin, setSeverityMin] = useState(String(existing?.trigger?.severityMin ?? 0));
  const [cooldown, setCooldown] = useState(String(existing?.cooldownM ?? 15));
  const [actions, setActions] = useState<AutomationAction[]>(
    existing?.actions?.length ? existing.actions : [{ type: 'close_event', matchTarget: true }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setAction = (i: number, patch: Partial<AutomationAction>) =>
    setActions((cur) => cur.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const body = {
      name,
      trigger: { event: triggerEvent.trim(), severityMin: parseInt(severityMin, 10) || 0 },
      actions,
      cooldownM: parseInt(cooldown, 10),
      enabled: existing ? existing.enabled : true,
    };
    try {
      if (existing) await api.patch(`/api/admin/automations/${existing.id}`, body);
      else await api.post('/api/admin/automations', body);
      onSaved();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'network error'); setBusy(false); }
  };

  return (
    <Modal title={existing ? 'Edit automation' : 'New automation'} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)}
            placeholder="bgp lifecycle" />
        </Field>
        <div className="row row-wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 2, minWidth: 160 }}>
            <Field label="Trigger event name (* = any)">
              <Input required className="mono" value={triggerEvent}
                onChange={(e) => setTriggerEvent(e.target.value)} placeholder="bgp.peer_established" />
            </Field>
          </div>
          <div style={{ width: 110 }}>
            <Field label="Min severity">
              <Input className="mono" inputMode="numeric" value={severityMin}
                onChange={(e) => setSeverityMin(e.target.value)} />
            </Field>
          </div>
          <div style={{ width: 110 }}>
            <Field label="Cooldown (min)">
              <Input className="mono" inputMode="numeric" value={cooldown}
                onChange={(e) => setCooldown(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="micro text-2xs" style={{ margin: '4px 0 6px' }}>ACTIONS</div>
        {actions.map((a, i) => (
          <div key={i} style={{ border: '1px solid var(--bg3)', borderRadius: 6,
            padding: '8px 10px', marginBottom: 8 }}>
            <div className="row row-wrap" style={{ gap: 8 }}>
              <Select title="Action" value={a.type} aria-label="Action type"
                options={ACTION_TYPES} style={{ minWidth: 170 }}
                onChange={(v) => setAction(i, { type: v as AutomationAction['type'] })} />
              {actions.length > 1 && (
                <button type="button" title="Remove action" style={{ color: SEV.critical, marginLeft: 'auto' }}
                  onClick={() => setActions((cur) => cur.filter((_, j) => j !== i))}>×</button>
              )}
            </div>
            {a.type === 'close_event' && (
              <div style={{ marginTop: 8 }}>
                <Field label="Raise event to close (when this trigger fires)">
                  <Input required className="mono" value={a.raiseEvent || ''}
                    onChange={(e) => setAction(i, { raiseEvent: e.target.value })}
                    placeholder="bgp.peer_down" />
                </Field>
                <label className="row text-sm" style={{ gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={a.matchTarget !== false} style={{ width: 'auto' }}
                    onChange={(e) => setAction(i, { matchTarget: e.target.checked })} />
                  Only when the target matches (same peer/port/entity)
                </label>
              </div>
            )}
            {a.type === 'assign_case' && (
              <div style={{ marginTop: 8 }}>
                <Field label="Assign to">
                  <Select title="Assignee" value={a.userId ? String(a.userId) : ''}
                    placeholder="Pick a team member…" aria-label="Assignee"
                    options={team.map((t) => ({ value: String(t.id), label: `${t.name} (${t.role})` }))}
                    onChange={(v) => setAction(i, { userId: parseInt(v, 10) })} />
                </Field>
              </div>
            )}
            {a.type === 'webhook' && (
              <div style={{ marginTop: 8 }}>
                <Field label="Webhook URL (POST, JSON payload)">
                  <Input required type="url" className="mono" value={a.url || ''}
                    onChange={(e) => setAction(i, { url: e.target.value })}
                    placeholder="https://hooks.example.com/opscat" />
                </Field>
              </div>
            )}
          </div>
        ))}
        {actions.length < 5 && (
          <button type="button" className="btn btn-sm" style={{ marginBottom: 12 }}
            onClick={() => setActions((cur) => [...cur, { type: 'webhook' }])}>+ Add action</button>
        )}

        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : existing ? 'Save changes' : 'Create automation'}</button>
      </form>
    </Modal>
  );
}
