// On-Call — who has the duty (docs/ONCALL-V1.md slice 1). Schedules with their
// rotation layers and overrides, plus the teams a schedule can belong to.
// Escalation policies and alerts arrive in slice 2; the tabs are URL-bound so
// adding one later is a list entry, not a rewrite.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useTab } from '../state';
import { api, ApiError } from '../api';
import { SEV, fmtDateTime, initials } from '../format';
import {
  Card, Button, PageHeader, Tabs, Modal, Field, Input, TableScroll, TableSkeleton,
  StatusPill, Avatar, COL, DateTime, ListSkeleton,
} from '../ui';
import { Select, MultiSelect } from '../Select';
import type { OnCallSchedule, OnCallTeam, TeamMember, ShiftSlice } from '../types';

const TABS = [['schedules', 'Schedules'], ['teams', 'Teams']] as const;
type Tab = typeof TABS[number][0];

// Name | Timezone | On call now | Via | Team | actions
const SCHED_COLS = [COL.text, COL.label, COL.text, COL.label, COL.label, COL.actionsWide].join(' ');
const TEAM_COLS = [COL.text, COL.textWide, COL.actions].join(' ');

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
  const [detail, setDetail] = useState<number | null>(null);

  const load = useCallback(() => {
    api.get<OnCallSchedule[]>('/api/oncall/schedules').then(setSchedules).catch(() => setSchedules([]));
    api.get<OnCallTeam[]>('/api/oncall/teams').then(setTeams).catch(() => setTeams([]));
  }, []);
  useEffect(() => { load(); }, [load]);

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
      </PageHeader>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'schedules' && (
        <Card style={{ padding: 0 }}>
          <TableScroll stickyFirst minWidth={760}>
            <div className="tbl-head" style={{ gridTemplateColumns: SCHED_COLS }}>
              <span>Schedule</span><span>Timezone</span><span>On call now</span>
              <span>Via</span><span>Team</span><span />
            </div>
            {!schedules ? (
              <TableSkeleton cols={SCHED_COLS} rows={4} />
            ) : schedules.length === 0 ? (
              <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
                no schedules yet — nobody is on call
              </div>
            ) : schedules.map((s) => (
              <div key={s.id} className="tbl-row" style={{ gridTemplateColumns: SCHED_COLS }}>
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

      {tab === 'teams' && (
        <Card style={{ padding: 0 }}>
          <TableScroll minWidth={560}>
            <div className="tbl-head" style={{ gridTemplateColumns: TEAM_COLS }}>
              <span>Team</span><span>Members</span><span />
            </div>
            {!teams ? (
              <TableSkeleton cols={TEAM_COLS} rows={3} />
            ) : teams.length === 0 ? (
              <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
                no teams yet
              </div>
            ) : teams.map((t) => (
              <div key={t.id} className="tbl-row" style={{ gridTemplateColumns: TEAM_COLS }}>
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
    <Modal title={sched ? `${sched.name} — rotation` : 'Rotation'} onClose={onClose} width={620}>
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
            <div style={{ display: 'grid', gap: 4 }}>
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
    </Modal>
  );
}
