// On-Call (docs/ONCALL-V1.md slices 1 and 2). Four tabs, all URL-bound:
// Schedules (who has the duty), Policies (the escalation ladders), Alerts (what
// is ringing, who was reached, who acknowledged) and My on-call (a person's own
// contact methods — the only place an address is ever shown).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useTab, useOverlayParam, useQueryState } from '../state';
import { api, ApiError } from '../api';
import {
  SEV, fmtDateTime, fmtHistory, initials, relTime, sevColor,
  alertStatusLabel, alertStatusColor,
} from '../format';
import {
  Card, Button, PageHeader, Tabs, Modal, Flyout, Field, Input, HostInput, TableScroll, TableSkeleton,
  StatusPill, Avatar, COL, DateTime, ListSkeleton,
} from '../ui';
import { Select, MultiSelect } from '../Select';
import { subscribe as subscribePush, supported as pushSupported, browserLabel } from '../push';
import type {
  OnCallSchedule, OnCallTeam, TeamMember, ShiftSlice,
  EscalationPolicy, EscalationTargetKind, AlertRow, MyOnCall, ContactMethodKind,
} from '../types';

// Module scope: useQueryState memoises on this array.
const ONCALL_KEYS = ['alerts'] as const;
const TABS = [['schedules', 'Schedules'], ['policies', 'Policies'], ['alerts', 'Alerts'],
  ['me', 'My on-call'], ['teams', 'Teams']] as const;
type Tab = typeof TABS[number][0];

// Name | Timezone | On call now | Via | Team | actions
const SCHED_COLS = [COL.text, COL.label, COL.text, COL.label, COL.label, COL.actionsWide].join(' ');
const TEAM_COLS = [COL.text, COL.textWide, COL.actions].join(' ');
// Policy | Steps | Rings for | High from | Support hours | actions
const POLICY_COLS = [COL.text, COL.textWide, COL.label, COL.num, COL.label, COL.actions].join(' ');
// Subject | Status | Urgency | Policy | Step | Raised | Acknowledged | actions
const ALERT_COLS = [COL.text, COL.status, COL.label, COL.text, COL.label, COL.time, COL.text,
  COL.actionsWide].join(' ');

const ROTATIONS = [['daily', 'Daily'], ['weekly', 'Weekly'], ['custom', 'Every N days']] as const;
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']] as const;

// A short, curated list plus whatever the browser knows. Intl.supportedValuesOf
// is the full IANA set (~600 zones) — offered, but the common ones come first
// so nobody scrolls to Europe/Berlin past Africa/Abidjan.
const COMMON_TZ = ['UTC', 'Europe/Berlin', 'Europe/London', 'Europe/Zurich', 'Europe/Vienna',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney'];
function timezoneOptions() {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf?.('timeZone') ?? []; } catch { /* older engine */ }
  const rest = all.filter((z) => !COMMON_TZ.includes(z));
  return [...COMMON_TZ, ...rest].map((z) => ({ value: z, label: z }));
}

const viaLabel = (via: string | null) =>
  (via === 'override' ? 'Override' : via ? `Layer ${Number(via.split(':')[1]) + 1}` : '—');

export default function OnCall() {
  const app = useApp();
  const canEdit = app.user ? app.user.role !== 'analyst' : false;
  const [tab, setTab] = useTab(TABS.map((t) => t[0]) as readonly Tab[]);

  const [schedules, setSchedules] = useState<OnCallSchedule[] | null>(null);
  const [teams, setTeams] = useState<OnCallTeam[] | null>(null);
  const [editing, setEditing] = useState<OnCallSchedule | 'new' | null>(null);
  const [editingTeam, setEditingTeam] = useState<OnCallTeam | 'new' | null>(null);
  const [detail, setDetail] = useOverlayParam('schedule');
  const [policies, setPolicies] = useState<EscalationPolicy[] | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<EscalationPolicy | 'new' | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  // A refinement of the alerts tab — it drives the fetch, so "show me the live ones"
  // is exactly the link somebody pastes into a handover. Query, replacing not pushing.
  const [q, setQ] = useQueryState(ONCALL_KEYS);
  const alertFilter = q.alerts || 'live';
  const setAlertFilter = (v: string) => setQ({ alerts: v === 'live' ? null : v });
  const [openAlert, setOpenAlert] = useOverlayParam('alert');

  const load = useCallback(() => {
    api.get<OnCallSchedule[]>('/api/oncall/schedules').then(setSchedules).catch(() => setSchedules([]));
    api.get<OnCallTeam[]>('/api/oncall/teams').then(setTeams).catch(() => setTeams([]));
    api.get<EscalationPolicy[]>('/api/oncall/policies').then(setPolicies).catch(() => setPolicies([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadAlerts = useCallback(() => {
    setAlerts(null);
    api.get<AlertRow[]>(`/api/oncall/alerts?status=${alertFilter}`)
      .then(setAlerts).catch(() => setAlerts([]));
  }, [alertFilter]);
  useEffect(() => { if (tab === 'alerts') loadAlerts(); }, [tab, loadAlerts]);

  const teamName = (id: number | null) => teams?.find((t) => t.id === id)?.name ?? '—';

  return (
    <div className="page">
      <PageHeader title="On-Call">
        {canEdit && tab === 'schedules' && (
          <Button variant="primary" onClick={() => setEditing('new')}>New Schedule</Button>
        )}
        {canEdit && tab === 'teams' && (
          <Button variant="primary" onClick={() => setEditingTeam('new')}>New Team</Button>
        )}
        {canEdit && tab === 'policies' && (
          <Button variant="primary" onClick={() => setEditingPolicy('new')}>New Policy</Button>
        )}
        {tab === 'alerts' && (
          <Select title="Show" value={alertFilter} onChange={setAlertFilter}
            options={[{ value: 'live', label: 'Live' }, { value: 'active', label: 'Escalating' },
              { value: 'acked', label: 'Acknowledged' }, { value: 'exhausted', label: 'Nobody answered' },
              { value: 'all', label: 'Everything' }]} />
        )}
      </PageHeader>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'schedules' && (
        <Card style={{ padding: 0 }}>
          <TableScroll cols={SCHED_COLS} stickyFirst minWidth={760}>
            <div className="tbl-head">
              <span>Schedule</span><span>Timezone</span><span>On call now</span>
              <span>Via</span><span>Team</span><span />
            </div>
            {!schedules ? (
              <TableSkeleton rows={4} />
            ) : schedules.length === 0 ? (
              <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
                no schedules yet — nobody is on call
              </div>
            ) : schedules.map((s) => (
              <div key={s.id} className="tbl-row">
                <button className="link-cell text-base font-semibold text-text0"
                  onClick={() => setDetail(s.id)} title="Open the rotation">{s.name}</button>
                <span className="mono text-sm text-text2">{s.timezone}</span>
                {s.onCall ? (
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <Avatar i={initials(s.onCall.name)} c={s.onCall.color} size={20} />
                    <span className="text-sm text-text1" style={{ overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.onCall.name}</span>
                  </span>
                ) : (
                  <StatusPill text={s.layers.length ? 'Nobody' : 'Not set up'}
                    color={s.layers.length ? SEV.critical : SEV.info} />
                )}
                <span className="text-sm text-text2">{viaLabel(s.via)}</span>
                <span className="text-sm text-text2">{teamName(s.teamId)}</span>
                {canEdit ? (
                  <span className="row" style={{ gap: 6 }}>
                    <Button size="sm" onClick={() => setDetail(s.id)}>Rotation</Button>
                    <Button size="sm" onClick={() => setEditing(s)}>Edit</Button>
                  </span>
                ) : <span />}
              </div>
            ))}
          </TableScroll>
        </Card>
      )}

      {tab === 'policies' && (
        <Card style={{ padding: 0 }}>
          <TableScroll cols={POLICY_COLS} stickyFirst minWidth={820}>
            <div className="tbl-head">
              <span>Policy</span><span>Escalation</span><span>Rings for</span>
              <span>High from</span><span>Support hours</span><span />
            </div>
            {!policies ? (
              <TableSkeleton rows={3} />
            ) : policies.length === 0 ? (
              <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
                no escalation policies yet — an alert needs a ladder to climb
              </div>
            ) : policies.map((p) => (
              <div key={p.id} className="tbl-row">
                <span className="text-base font-semibold text-text0">{p.name}</span>
                <span className="text-sm text-text2" style={{ overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ladderSummary(p)}</span>
                <span className="mono text-sm text-text1">{fmtRing(p.worstCaseMinutes)}</span>
                <span className="mono text-sm" style={{ color: sevColor(p.highMin) }}>≥ {p.highMin}</span>
                <span className="text-sm text-text2">{hoursSummary(p)}</span>
                {canEdit
                  ? <Button size="sm" onClick={() => setEditingPolicy(p)}>Edit</Button>
                  : <span />}
              </div>
            ))}
          </TableScroll>
        </Card>
      )}

      {tab === 'alerts' && (
        <Card style={{ padding: 0 }}>
          <TableScroll cols={ALERT_COLS} stickyFirst minWidth={960}>
            <div className="tbl-head">
              <span>Subject</span><span>Status</span><span>Urgency</span><span>Policy</span>
              <span>Step</span><span>Raised</span><span>Acknowledged</span><span />
            </div>
            {!alerts ? (
              <TableSkeleton rows={5} />
            ) : alerts.length === 0 ? (
              <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
                nothing is escalating
              </div>
            ) : alerts.map((a) => (
              <div key={a.id} className="tbl-row">
                <button className="link-cell text-base font-semibold text-text0"
                  onClick={() => setOpenAlert(a.id)} title="Who was notified, and when">
                  {a.subjectLabel ?? `#${a.id}`}
                </button>
                <StatusPill text={alertStatusLabel(a.status)} color={alertStatusColor(a.status)} />
                <span className="text-sm" style={{ color: a.urgency === 'high' ? SEV.critical : SEV.info }}>
                  {a.urgency === 'high' ? 'High' : 'Low'}
                </span>
                <span className="text-sm text-text2" style={{ overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.policyName ?? '—'}</span>
                <span className="mono text-sm text-text2">{stepLabel(a)}</span>
                <span className="mono text-xs text-text3">{fmtHistory(a.createdAt)}</span>
                {a.ackedBy ? (
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <Avatar i={initials(a.ackedBy.name)} c={a.ackedBy.color} size={18} />
                    <span className="text-sm text-text1" style={{ overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.ackedBy.name}{a.ackMinutes !== null ? ` · ${a.ackMinutes}m` : ''}
                    </span>
                  </span>
                ) : <span className="text-sm text-text3">—</span>}
                <AlertActions alert={a} onDone={loadAlerts} />
              </div>
            ))}
          </TableScroll>
        </Card>
      )}

      {tab === 'me' && <MyOnCallTab />}

      {tab === 'teams' && (
        <Card style={{ padding: 0 }}>
          <TableScroll cols={TEAM_COLS} minWidth={560}>
            <div className="tbl-head">
              <span>Team</span><span>Members</span><span />
            </div>
            {!teams ? (
              <TableSkeleton rows={3} />
            ) : teams.length === 0 ? (
              <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
                no teams yet
              </div>
            ) : teams.map((t) => (
              <div key={t.id} className="tbl-row">
                <span className="text-base font-semibold text-text0">{t.name}</span>
                <span className="row row-wrap" style={{ gap: 6 }}>
                  {t.members.length === 0 && <span className="text-sm text-text3">nobody yet</span>}
                  {t.members.map((m) => (
                    <span key={m.id} className="row" style={{ gap: 4 }}>
                      <Avatar i={initials(m.name)} c={m.color} size={18} />
                      <span className="text-sm text-text2">{m.name}</span>
                    </span>
                  ))}
                </span>
                {canEdit
                  ? <Button size="sm" onClick={() => setEditingTeam(t)}>Edit</Button>
                  : <span />}
              </div>
            ))}
          </TableScroll>
        </Card>
      )}

      {editing && (
        <ScheduleEditor schedule={editing === 'new' ? null : editing} teams={teams ?? []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {editingTeam && (
        <TeamEditor team={editingTeam === 'new' ? null : editingTeam}
          onClose={() => setEditingTeam(null)} onSaved={() => { setEditingTeam(null); load(); }} />
      )}
      {detail !== null && (
        <RotationEditor scheduleId={detail} canEdit={canEdit}
          onClose={() => setDetail(null)} onSaved={load} />
      )}
      {editingPolicy && (
        <PolicyEditor policy={editingPolicy === 'new' ? null : editingPolicy}
          schedules={schedules ?? []} teams={teams ?? []}
          onClose={() => setEditingPolicy(null)} onSaved={() => { setEditingPolicy(null); load(); }} />
      )}
      {openAlert !== null && (
        <AlertDetail alertId={openAlert} onClose={() => setOpenAlert(null)} onChanged={loadAlerts} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function TeamEditor({ team, onClose, onSaved }:
  { team: OnCallTeam | null; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const [name, setName] = useState(team?.name ?? '');
  const [members, setMembers] = useState<string[]>(team?.members.map((m) => m.id) ?? []);
  const [err, setErr] = useState('');
  const people = app.users ?? [];

  const save = async () => {
    setErr('');
    try {
      if (team) await api.patch(`/api/oncall/teams/${team.id}`, { name, members });
      else await api.post('/api/oncall/teams', { name, members });
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'save failed'); }
  };

  return (
    <Modal title={team ? `Edit ${team.name}` : 'New Team'} onClose={onClose} width={440}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Network" />
      </Field>
      <Field label="Members">
        <MultiSelect title="Members" value={members} onChange={setMembers}
          options={people.map((u) => ({ value: u.id, label: u.name || u.email }))} />
      </Field>
      {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={!name.trim()}>Save</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function ScheduleEditor({ schedule, teams, onClose, onSaved }:
  { schedule: OnCallSchedule | null; teams: OnCallTeam[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(schedule?.name ?? '');
  const [tz, setTz] = useState(schedule?.timezone
    ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  const [teamId, setTeamId] = useState<string>(schedule?.teamId ? String(schedule.teamId) : '');
  const [err, setErr] = useState('');
  const tzOptions = useMemo(timezoneOptions, []);

  const save = async () => {
    setErr('');
    const body = { name, timezone: tz, teamId: teamId ? Number(teamId) : null };
    try {
      if (schedule) await api.patch(`/api/oncall/schedules/${schedule.id}`, body);
      else await api.post('/api/oncall/schedules', body);
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'save failed'); }
  };
  const remove = async () => {
    if (!schedule || !confirm(`Delete schedule "${schedule.name}"?`)) return;
    try { await api.del(`/api/oncall/schedules/${schedule.id}`); onSaved(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'delete failed'); }
  };

  return (
    <Modal title={schedule ? `Edit ${schedule.name}` : 'New Schedule'} onClose={onClose} width={440}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Primary" />
      </Field>
      <Field label="Timezone">
        <Select title="Timezone" value={tz} onChange={setTz} options={tzOptions} />
      </Field>
      <div className="text-xs text-text3" style={{ marginTop: -6, marginBottom: 10 }}>
        The handoff happens at this zone&rsquo;s local time — and stays there across DST.
      </div>
      <Field label="Team (optional)">
        <Select title="Team" value={teamId} onChange={setTeamId}
          options={[{ value: '', label: 'No team' },
            ...teams.map((t) => ({ value: String(t.id), label: t.name }))]} />
      </Field>
      {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        {schedule && <Button variant="danger" onClick={remove}>Delete</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={!name.trim()}>Save</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
type DraftLayer = {
  rotation: 'daily' | 'weekly' | 'custom';
  intervalD: number;
  handoffAt: number;
  participants: string[];
  days: number[];
  from: string;
  to: string;
};

const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function RotationEditor({ scheduleId, canEdit, onClose, onSaved }:
  { scheduleId: number; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const [sched, setSched] = useState<OnCallSchedule | null>(null);
  const [layers, setLayers] = useState<DraftLayer[] | null>(null);
  const [shifts, setShifts] = useState<ShiftSlice[] | null>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const people = app.users ?? [];

  const load = useCallback(() => {
    api.get<OnCallSchedule>(`/api/oncall/schedules/${scheduleId}`).then((s) => {
      setSched(s);
      setLayers(s.layers.map((l) => ({
        rotation: l.rotation, intervalD: l.intervalD, handoffAt: l.handoffAt,
        participants: l.participants.map((p) => p.id),
        days: l.restrict?.days ?? [], from: l.restrict?.from ?? '', to: l.restrict?.to ?? '',
      })));
    }).catch(() => setSched(null));
    api.get<{ shifts: ShiftSlice[] }>(`/api/oncall/schedules/${scheduleId}/timeline?days=14`)
      .then((t) => setShifts(t.shifts)).catch(() => setShifts([]));
  }, [scheduleId]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!layers) return;
    setSaving(true); setErr('');
    try {
      await api.put(`/api/oncall/schedules/${scheduleId}/layers`, {
        layers: layers.map((l) => ({
          rotation: l.rotation, intervalD: l.intervalD, handoffAt: l.handoffAt,
          participants: l.participants,
          restrict: (l.days.length || l.from) ? { days: l.days, from: l.from || null, to: l.to || null } : null,
        })),
      });
      load(); onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'save failed'); }
    finally { setSaving(false); }
  };

  const patch = (i: number, p: Partial<DraftLayer>) =>
    setLayers((ls) => (ls ? ls.map((l, j) => (j === i ? { ...l, ...p } : l)) : ls));

  return (
    <Flyout title={sched ? `${sched.name} — rotation` : 'Rotation'} onClose={onClose} width={620}>
      {!sched || !layers ? <ListSkeleton rows={4} /> : (
        <>
          <div className="text-sm text-text2" style={{ marginBottom: 12 }}>
            Layers are evaluated from the bottom up — the <b>last</b> one that has somebody
            available wins. An override beats all of them.
          </div>

          {layers.map((l, i) => (
            <Card key={i} style={{ marginBottom: 10 }}>
              <div className="row row-wrap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="card-title">Layer {i + 1}{i === 0 ? ' (base)' : ''}</span>
                {canEdit && (
                  <Button size="sm" variant="danger"
                    onClick={() => setLayers((ls) => (ls ? ls.filter((_, j) => j !== i) : ls))}>
                    Remove
                  </Button>
                )}
              </div>
              <Field label="Rotation">
                <div className="row row-wrap" style={{ gap: 8 }}>
                  <Select title="Rotation" value={l.rotation}
                    onChange={(v) => patch(i, { rotation: v as DraftLayer['rotation'] })}
                    options={ROTATIONS.map(([v, lbl]) => ({ value: v, label: lbl }))} />
                  {l.rotation === 'custom' && (
                    <Input type="number" width={90} value={String(l.intervalD)}
                      onChange={(e) => patch(i, { intervalD: Number(e.target.value) || 1 })} />
                  )}
                </div>
              </Field>
              <Field label={`First handoff — its time of day is the handoff time, in ${sched.timezone}`}>
                <DateTime value={toLocalInput(l.handoffAt)}
                  onChange={(e) => patch(i, { handoffAt: new Date(e.target.value).getTime() })} />
              </Field>
              <Field label="Rotation order">
                <MultiSelect title="Participants" value={l.participants}
                  onChange={(v) => patch(i, { participants: v })}
                  options={people.map((u) => ({ value: u.id, label: u.name || u.email }))} />
              </Field>
              <Field label="Only during (optional) — empty means 24/7; outside the window this layer yields nobody">
                <div className="row row-wrap" style={{ gap: 8 }}>
                  <MultiSelect title="Days" value={l.days.map(String)}
                    onChange={(v) => patch(i, { days: v.map(Number) })}
                    options={WEEKDAYS.map(([v, lbl]) => ({ value: String(v), label: lbl }))} />
                  <Input width={90} placeholder="08:00" value={l.from}
                    onChange={(e) => patch(i, { from: e.target.value })} />
                  <Input width={90} placeholder="18:00" value={l.to}
                    onChange={(e) => patch(i, { to: e.target.value })} />
                </div>
              </Field>
            </Card>
          ))}

          {canEdit && (
            <Button onClick={() => setLayers((ls) => [...(ls ?? []), {
              rotation: 'weekly', intervalD: 1, handoffAt: Date.now(),
              participants: [], days: [], from: '', to: '',
            }])}>Add layer</Button>
          )}

          <div className="card-title" style={{ margin: '18px 0 6px' }}>Next 14 days</div>
          {!shifts ? <ListSkeleton rows={3} /> : shifts.length === 0 ? (
            <div className="text-sm text-text3">nothing scheduled</div>
          ) : (
            // A week grid is a wide table and would push the page sideways on a
            // phone; the shift list says the same thing and wraps.
            <div style={{ gap: 4 }}>
              {shifts.slice(0, 40).map((s, i) => (
                <div key={i} className="row row-wrap" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="mono text-xs text-text3" style={{ minWidth: 0 }}>
                    {fmtDateTime(s.startsAt)} →
                  </span>
                  {s.user ? (
                    <span className="row" style={{ gap: 5 }}>
                      <Avatar i={initials(s.user.name)} c={s.user.color} size={16} />
                      <span className="text-sm text-text1">{s.user.name}</span>
                    </span>
                  ) : <StatusPill text="Nobody" color={SEV.critical} />}
                  {s.via === 'override' && <span className="text-xs text-text3">override</span>}
                </div>
              ))}
            </div>
          )}

          {err && <div className="text-sm" style={{ color: SEV.critical, margin: '10px 0' }}>{err}</div>}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            <Button onClick={onClose}>Close</Button>
            {canEdit && (
              <Button variant="primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save rotation'}
              </Button>
            )}
          </div>
        </>
      )}
    </Flyout>
  );
}

// ---------------------------------------------------------------------------
// Small readers shared by the tabs above. They live here rather than in ui.tsx
// because none of them is a component — they are the vocabulary of ONE page.
const fmtRing = (min: number) =>
  (min < 60 ? `${min} min` : min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`);

const ladderSummary = (p: EscalationPolicy) => {
  if (!p.steps.length) return 'no steps — this policy cannot ring anybody';
  const rungs = p.steps.map((s) => (s.targets.length ? s.targets.map((t) => t.label).join(' + ') : 'nobody'));
  return rungs.join(' → ') + (p.repeatN ? ` (×${p.repeatN + 1})` : '');
};

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hoursSummary = (p: EscalationPolicy) => {
  if (!p.hours) return '24/7';
  const days = p.hours.days.length ? p.hours.days.map((d) => DAY_NAMES[d]).join(' ') : 'daily';
  return p.hours.from ? `${days} ${p.hours.from}–${p.hours.to ?? ''}` : days;
};

const stepLabel = (a: AlertRow) =>
  `${a.step + 1}${a.round ? ` · pass ${a.round + 1}` : ''}`;

// Acknowledge is disabled the moment it cannot change anything AND the endpoint
// answers 409 for the same call — a disabled button is a courtesy, not a lock.
function AlertActions({ alert, onDone }: { alert: AlertRow; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const live = alert.status === 'active';
  const act = async (what: 'ack' | 'cancel') => {
    setBusy(true);
    try { await api.post(`/api/oncall/alerts/${alert.id}/${what}`, {}); onDone(); }
    catch { /* the list refresh below shows the real state */ }
    finally { setBusy(false); }
  };
  if (!live && alert.status !== 'acked') return <span />;
  return (
    <span className="row" style={{ gap: 6 }}>
      <Button size="sm" disabled={!live || busy} onClick={() => act('ack')}
        title="Stop the escalation. Does not assign the case to you.">Ack</Button>
      <Button size="sm" variant="danger" disabled={busy} onClick={() => act('cancel')}>Stop</Button>
    </span>
  );
}

// ---------------------------------------------------------------------------
function AlertDetail({ alertId, onClose, onChanged }:
  { alertId: number; onClose: () => void; onChanged: () => void }) {
  const [a, setA] = useState<AlertRow | null>(null);
  const load = useCallback(() => {
    api.get<AlertRow>(`/api/oncall/alerts/${alertId}`).then(setA).catch(() => setA(null));
  }, [alertId]);
  useEffect(() => { load(); }, [load]);

  return (
    <Flyout title={a?.subjectLabel ?? (a ? `Alert ${a.id}` : 'Alert')} onClose={onClose}
      badges={a ? (<>
        <StatusPill text={alertStatusLabel(a.status)} color={alertStatusColor(a.status)} />
        <StatusPill text={a.urgency === 'high' ? 'High urgency' : 'Low urgency'}
          color={a.urgency === 'high' ? SEV.critical : SEV.info} />
      </>) : undefined}
      sub={a?.policyName ? `via ${a.policyName}` : undefined}>
      {!a ? <ListSkeleton rows={5} /> : (
        <>
          {a.subjectTitle && <div className="text-base text-text1" style={{ marginBottom: 6 }}>{a.subjectTitle}</div>}
          {a.message && <div className="text-sm text-text2" style={{ marginBottom: 10 }}>{a.message}</div>}
          <div className="text-sm text-text3" style={{ marginBottom: 14 }}>
            Raised {fmtHistory(a.createdAt)} by {a.source}
            {a.nextAt !== null && <> · next escalation {relTime(a.nextAt)}</>}
            {a.endedAt !== null && <> · ended {fmtHistory(a.endedAt)}{a.endReason ? ` (${a.endReason})` : ''}</>}
          </div>

          <div className="card-title" style={{ marginBottom: 6 }}>Who was reached</div>
          {!a.attempts || a.attempts.length === 0 ? (
            <div className="text-sm text-text3">nobody yet</div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {a.attempts.map((t, i) => (
                <div key={i} className="row row-wrap" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="mono text-xs text-text3">{fmtHistory(t.notifiedAt)}</span>
                  <span className="row" style={{ gap: 5 }}>
                    <Avatar i={initials(t.user.name)} c={t.user.color} size={16} />
                    <span className="text-sm text-text1">{t.user.name}</span>
                  </span>
                  <span className="text-xs text-text3">
                    step {t.step + 1}{t.round ? ` · pass ${t.round + 1}` : ''} · {t.via}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button onClick={onClose}>Close</Button>
            <AlertActions alert={a} onDone={() => { load(); onChanged(); }} />
          </div>
        </>
      )}
    </Flyout>
  );
}

// ---------------------------------------------------------------------------
type DraftStep = { timeoutM: number; targets: { kind: EscalationTargetKind; refId: string }[] };

function PolicyEditor({ policy, schedules, teams, onClose, onSaved }: {
  policy: EscalationPolicy | null; schedules: OnCallSchedule[]; teams: OnCallTeam[];
  onClose: () => void; onSaved: () => void;
}) {
  const app = useApp();
  const [name, setName] = useState(policy?.name ?? '');
  const [repeatN, setRepeatN] = useState(policy?.repeatN ?? 0);
  const [highMin, setHighMin] = useState(policy?.highMin ?? 80);
  const [days, setDays] = useState<number[]>(policy?.hours?.days ?? []);
  const [from, setFrom] = useState(policy?.hours?.from ?? '');
  const [to, setTo] = useState(policy?.hours?.to ?? '');
  const [tz, setTz] = useState(policy?.hours?.tz
    ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  const [steps, setSteps] = useState<DraftStep[]>(policy?.steps.map((s) => ({
    timeoutM: s.timeoutM, targets: s.targets.map((t) => ({ kind: t.kind, refId: t.refId })),
  })) ?? [{ timeoutM: 5, targets: [] }]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const tzOptions = useMemo(timezoneOptions, []);

  // Every target the org can name, in one list: the picker's value carries the
  // kind, so a schedule and a person named the same thing cannot collide.
  const targetOptions = useMemo(() => [
    ...schedules.map((s) => ({ value: `schedule:${s.id}`, label: `Schedule · ${s.name}` })),
    ...teams.map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}` })),
    ...(app.users ?? []).map((u) => ({ value: `user:${u.id}`, label: `Person · ${u.name || u.email}` })),
  ], [schedules, teams, app.users]);

  const worstCase = steps.reduce((a, s) => a + (Number(s.timeoutM) || 0), 0) * (repeatN + 1);
  const patch = (i: number, p: Partial<DraftStep>) =>
    setSteps((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const save = async () => {
    setSaving(true); setErr('');
    const body = {
      name,
      repeatN: Number(repeatN),
      highMin: Number(highMin),
      hours: (days.length || from) ? { days, from: from || null, to: to || null, tz } : null,
      steps: steps.map((s) => ({ timeoutM: Number(s.timeoutM) || 5, targets: s.targets })),
    };
    try {
      if (policy) await api.patch(`/api/oncall/policies/${policy.id}`, body);
      else await api.post('/api/oncall/policies', body);
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'save failed'); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!policy || !confirm(`Delete policy "${policy.name}"?`)) return;
    try { await api.del(`/api/oncall/policies/${policy.id}`); onSaved(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'delete failed'); }
  };

  return (
    <Modal title={policy ? `Edit ${policy.name}` : 'New Escalation Policy'} onClose={onClose} width={580}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard" />
      </Field>

      <div className="text-sm text-text2" style={{ marginBottom: 12 }}>
        A ladder, not a flow: each rung is tried, and if nobody acknowledges within its
        timeout the next one is. Targets are resolved when the rung starts, so a handover
        mid-escalation reaches whoever is on call then.
      </div>

      {steps.map((s, i) => (
        <Card key={i} style={{ marginBottom: 10 }}>
          <div className="row row-wrap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="card-title">Step {i + 1}{i === 0 ? ' (immediately)' : ''}</span>
            {steps.length > 1 && (
              <Button size="sm" variant="danger"
                onClick={() => setSteps((ls) => ls.filter((_, j) => j !== i))}>Remove</Button>
            )}
          </div>
          <Field label="Notify">
            <MultiSelect title="Targets"
              value={s.targets.map((t) => `${t.kind}:${t.refId}`)}
              onChange={(v) => patch(i, { targets: v.map((x) => {
                const idx = x.indexOf(':');
                return { kind: x.slice(0, idx) as EscalationTargetKind, refId: x.slice(idx + 1) };
              }) })}
              options={targetOptions} />
          </Field>
          <Field label="Escalate after (minutes without an acknowledgement)">
            <Input type="number" width={110} min={1} value={String(s.timeoutM)}
              onChange={(e) => patch(i, { timeoutM: Number(e.target.value) || 1 })} />
          </Field>
        </Card>
      ))}
      <Button onClick={() => setSteps((ls) => [...ls, { timeoutM: 5, targets: [] }])}>Add step</Button>

      <div className="row row-wrap" style={{ gap: 10, alignItems: 'flex-start', marginTop: 14 }}>
        <Field label="Repeat the whole ladder">
          <Select title="Repeat" value={String(repeatN)} onChange={(v) => setRepeatN(Number(v))}
            options={[0, 1, 2, 3, 4, 5].map((n) => ({
              value: String(n), label: n === 0 ? 'Once through' : `${n} more pass${n > 1 ? 'es' : ''}`,
            }))} />
        </Field>
        <Field label="High urgency from severity">
          <Input type="number" width={110} min={0} max={100} value={String(highMin)}
            onChange={(e) => setHighMin(Number(e.target.value))} />
        </Field>
      </div>
      {/* The unit a human reasons in. "3 steps x 5 min x 2 passes" is arithmetic
          homework; "rings for at most 30 min" is the setting explaining itself. */}
      <div className="text-sm text-text2" style={{ margin: '-4px 0 12px' }}>
        This policy rings for at most <b>{fmtRing(worstCase)}</b> before giving up and
        raising <span className="mono text-xs">alert_exhausted</span>.
        Anything below severity {highMin} is a low-urgency notice: delivered once, never escalated.
      </div>

      <Field label="Support hours (optional) — outside them a LOW-urgency alert is held; high urgency always goes">
        <div className="row row-wrap" style={{ gap: 8 }}>
          <MultiSelect title="Days" value={days.map(String)}
            onChange={(v) => setDays(v.map(Number))}
            options={WEEKDAYS.map(([v, lbl]) => ({ value: String(v), label: lbl }))} />
          <Input width={90} placeholder="08:00" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input width={90} placeholder="18:00" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </Field>
      {(days.length > 0 || from) && (
        <Field label="Support hours are in">
          <Select title="Timezone" value={tz} onChange={setTz} options={tzOptions} />
        </Field>
      )}

      {err && <div className="text-sm" style={{ color: SEV.critical, margin: '10px 0' }}>{err}</div>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        {policy && <Button variant="danger" onClick={remove}>Delete</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The ONLY screen in the product that shows a contact address, and it shows
// exactly one person's: their own (docs/ONCALL-V1.md §7).
const METHOD_KINDS: [ContactMethodKind, string, string][] = [
  ['sms', 'SMS', '+4915112345678'],
  ['voice', 'Phone call', '+4915112345678'],
  ['email', 'E-mail', 'you@example.com'],
  ['ntfy', 'ntfy topic URL', 'https://ntfy.sh/my-private-topic'],
  ['telegram', 'Telegram chat id', '-1001234567890'],
  ['pushover', 'Pushover user key', 'uQiRzpo4DXghDmr9…'],
];
const kindLabel = (k: string) =>
  (k === 'push' ? 'Push' : METHOD_KINDS.find(([v]) => v === k)?.[1] ?? k);
const METERED = ['sms', 'voice'];

function MyOnCallTab() {
  const [me, setMe] = useState<MyOnCall | null>(null);
  const [kind, setKind] = useState<ContactMethodKind>('sms');
  const [address, setAddress] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const push = useMemo(pushSupported, []);

  const load = useCallback(() => {
    api.get<MyOnCall>('/api/oncall/me').then(setMe).catch(() => setMe(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setErr('');
    try {
      const r = await api.post<{ id: number; needsVerification: boolean }>(
        '/api/oncall/me/methods', { kind, address: address.trim() });
      setAddress('');
      load();
      // Straight into verification: a number that is stored but unverified is
      // never rung, and leaving that as a second deliberate step is how somebody
      // ends up believing they are reachable when they are not.
      if (r.needsVerification) sendCode(r.id);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'could not add that'); }
  };

  const enablePush = async () => {
    setErr(''); setBusy(true);
    try { await subscribePush(browserLabel()); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'could not enable push'); }
    finally { setBusy(false); }
  };

  const sendCode = async (id: number) => {
    setErr(''); setBusy(true);
    try { await api.post(`/api/oncall/me/methods/${id}/verify`, {}); setVerifying(id); setCode(''); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'could not send the code'); }
    finally { setBusy(false); }
  };
  const confirmCode = async (id: number) => {
    setErr(''); setBusy(true);
    try { await api.post(`/api/oncall/me/methods/${id}/verify/confirm`, { code: code.trim() });
      setVerifying(null); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'wrong code'); }
    finally { setBusy(false); }
  };
  const testMethod = async (id: number) => {
    setErr(''); setBusy(true);
    try { await api.post(`/api/oncall/me/methods/${id}/test`, {}); setErr(''); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'the test failed'); }
    finally { setBusy(false); }
  };
  const remove = async (id: number) => {
    try { await api.del(`/api/oncall/me/methods/${id}`); load(); } catch { /* stale row */ }
  };
  const setRule = async (methodId: number, urgency: 'high' | 'low', delayM: number | null) => {
    if (!me) return;
    const rest = me.rules.filter((r) => !(r.methodId === methodId && r.urgency === urgency));
    const next = delayM === null ? rest : [...rest, { urgency, delayM, methodId }];
    try {
      await api.put('/api/oncall/me/rules', {
        rules: next.map((r) => ({ urgency: r.urgency, delayM: r.delayM, methodId: r.methodId })),
      });
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'could not save that'); }
  };

  const placeholder = METHOD_KINDS.find(([k]) => k === kind)?.[2] ?? '';
  const DELAYS = [
    { value: '', label: 'Never' }, { value: '0', label: 'Immediately' },
    { value: '2', label: 'After 2 min' }, { value: '5', label: 'After 5 min' },
    { value: '10', label: 'After 10 min' }, { value: '15', label: 'After 15 min' },
  ];
  const delayOf = (methodId: number, urgency: 'high' | 'low') => {
    const r = me?.rules.find((x) => x.methodId === methodId && x.urgency === urgency);
    return r ? String(r.delayM) : '';
  };

  if (!me) return <Card><ListSkeleton rows={4} /></Card>;

  return (
    <>
      <Card>
        <div className="card-title" style={{ marginBottom: 4 }}>How I want to be reached</div>
        <div className="text-sm text-text2" style={{ marginBottom: 12 }}>
          These belong to you, not to the organisation — the same account in two workspaces
          has one phone. Nobody else can see the addresses.
          {me.methods.length === 0 && <> Until you add one, alerts go to <b>{me.fallbackEmail}</b>.</>}
        </div>

        {me.methods.length > 0 && (
          <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
            {me.methods.map((m) => (
              <Card key={m.id}>
                <div className="row row-wrap" style={{ gap: 8, justifyContent: 'space-between' }}>
                  <span className="row row-wrap" style={{ gap: 6 }}>
                    <StatusPill text={kindLabel(m.kind)}
                      color={METERED.includes(m.kind) ? SEV.purple : SEV.info} />
                    {m.needsVerification && <StatusPill text="Unverified" color={SEV.high} />}
                  </span>
                  <span className="row row-wrap" style={{ gap: 6 }}>
                    {m.needsVerification && (
                      <Button size="sm" disabled={busy} onClick={() => sendCode(m.id)}>Verify</Button>
                    )}
                    {!m.blockedReason && m.kind !== 'voice' && (
                      <Button size="sm" disabled={busy} onClick={() => testMethod(m.id)}
                        title="Send a test through the real delivery path">Test</Button>
                    )}
                    <Button size="sm" variant="danger" onClick={() => remove(m.id)}>Remove</Button>
                  </span>
                </div>
                {/* Why this method will not be used, in the same words the
                    delivery log uses. A method that is quietly skipped is
                    indistinguishable from a quiet night. */}
                {m.blockedReason && (
                  <div className="text-sm" style={{ color: SEV.high, marginTop: 6 }}>{m.blockedReason}</div>
                )}
                {verifying === m.id && (
                  <div className="row row-wrap" style={{ gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
                    <Field label="Six-digit code we just sent to this number">
                      <Input width={130} inputMode="numeric" value={code}
                        onChange={(e) => setCode(e.target.value)} placeholder="123456" />
                    </Field>
                    <Button variant="primary" disabled={busy || code.trim().length !== 6}
                      onClick={() => confirmCode(m.id)}>Confirm</Button>
                    <Button disabled={busy} onClick={() => setVerifying(null)}>Cancel</Button>
                  </div>
                )}
                {/* Wrapped, not ellipsised: this is the one screen where a person
                    checks their own address, and half of it is no use. An ntfy topic
                    URL has no spaces, so it needs `anywhere` to break at all —
                    measured at 390px, where it pushed the page 123px sideways. */}
                <div className="mono text-sm text-text1"
                  style={{ overflowWrap: 'anywhere', marginTop: 6 }}>{m.address}</div>
                <div className="row row-wrap" style={{ gap: 10, marginTop: 10 }}>
                  <Field label="High urgency">
                    <Select title="High urgency" value={delayOf(m.id, 'high')}
                      onChange={(v) => setRule(m.id, 'high', v === '' ? null : Number(v))}
                      options={DELAYS} />
                  </Field>
                  <Field label="Low urgency">
                    <Select title="Low urgency" value={delayOf(m.id, 'low')}
                      onChange={(v) => setRule(m.id, 'low', v === '' ? null : Number(v))}
                      options={DELAYS} />
                  </Field>
                </div>
              </Card>
            ))}
            <div className="text-xs text-text3">
              A rule that fires later than its escalation step can ever run is skipped and
              recorded as such — the policy will already have moved on.
            </div>
          </div>
        )}

        <div className="row row-wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label="Add a contact method">
            <Select title="Kind" value={kind} onChange={(v) => setKind(v as ContactMethodKind)}
              options={METHOD_KINDS.map(([v, lbl]) => ({ value: v, label: lbl }))} />
          </Field>
          <Field label={METERED.includes(kind) ? 'Number, in international format' : 'Address'}>
            <HostInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder={placeholder} />
          </Field>
          <Button variant="primary" onClick={add} disabled={!address.trim()}>Add</Button>
        </div>
        {METERED.includes(kind) && !me.telephonyConfigured && (
          <div className="text-sm" style={{ color: SEV.high, marginTop: 8 }}>
            No SMS or voice provider is configured for this organisation yet, so a number
            cannot be verified. An admin sets one under Settings &rsaquo; Notifications.
          </div>
        )}
        {err && <div className="text-sm" style={{ color: SEV.critical, marginTop: 8 }}>{err}</div>}

        {/* Web Push: free, acknowledgeable, and the one channel whose setup step
            people cannot guess — iOS refuses it outright until the site has been
            added to the Home Screen, so that is said here rather than discovered
            through a permission prompt that never appears. */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--bg3)' }}>
          <div className="card-title" style={{ marginBottom: 4 }}>Push notifications</div>
          {push.state === 'needs-install' ? (
            <div className="text-sm text-text2">
              On iPhone and iPad, add OpsCat to the Home Screen first — Safari only delivers
              push to an installed app. Share &rsaquo; Add to Home Screen, then open it from there.
            </div>
          ) : push.state === 'unsupported' ? (
            <div className="text-sm text-text2">This browser cannot receive push notifications.</div>
          ) : push.state === 'denied' ? (
            <div className="text-sm text-text2">
              Notifications are blocked for this site. Allow them in your browser settings,
              then reload this page.
            </div>
          ) : (
            <div className="row row-wrap" style={{ gap: 8, alignItems: 'center' }}>
              <Button disabled={busy} onClick={enablePush}>Enable on this browser</Button>
              <span className="text-sm text-text3">
                One per browser — a laptop and a phone both ring.
              </span>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="card-title" style={{ marginBottom: 8 }}>My next shifts</div>
        {me.shifts.length === 0 ? (
          <div className="text-sm text-text3">nothing in the next two weeks</div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {me.shifts.map((s, i) => (
              <div key={i} className="row row-wrap" style={{ gap: 8, alignItems: 'baseline' }}>
                <span className="mono text-xs text-text3">{fmtDateTime(s.startsAt)} →</span>
                <span className="text-sm text-text1">{s.schedule}</span>
                {s.via === 'override' && <span className="text-xs text-text3">override</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
