// Rules — alert routing rules + recent notification log. Editing requires lead+.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, fmtTime } from '../format';
import { StatusPill, Toggle, Modal, Field } from '../ui';
import type { Rule, NotificationRow } from '../types';

const CHAN_COLORS: Record<string, string> = {
  teams: '#5865f2', email: '#388bfd', sms: '#3fb950', webhook: '#3fb950',
};
const chanColor = (ch: string) => CHAN_COLORS[ch] || SEV.info;
const RULE_COLS = '1fr 90px 140px 70px 80px 60px 110px';
const NOTIF_COLS = '80px 1fr 90px 90px 70px';
const DEFAULT_TRIGGERS = ['ddos', 'out_of_memory', 'synthetic_check_failed', 'snmp_unreachable',
  'agent_offline', 'host_disk_high', 'sentry_error'];

export default function Rules() {
  const app = useApp();
  const canEdit = app.user ? app.user.role !== 'analyst' : false;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [notifs, setNotifs] = useState<NotificationRow[] | null>(null);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);

  const loadRules = () => api.get<Rule[]>('/api/rules').then(setRules).catch(() => {});
  const loadNotifs = () => api.get<NotificationRow[]>('/api/notifications').then(setNotifs).catch(() => {});
  useEffect(() => { loadRules(); loadNotifs(); }, []);

  const eventNames = useMemo(() => {
    const fromEvents = app.events.map((e) => e.name);
    return Array.from(new Set([...fromEvents, ...DEFAULT_TRIGGERS])).sort();
  }, [app.events]);

  const toggle = async (r: Rule) => {
    await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled });
    loadRules();
  };
  const remove = async (r: Rule) => {
    if (!confirm(`Delete rule "${r.name}"?`)) return;
    await api.del(`/api/rules/${r.id}`);
    loadRules();
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Alert Rules</h1>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>+ New Rule</button>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="tbl-head" style={{ gridTemplateColumns: RULE_COLS }}>
          <span>Rule</span><span>Channel</span><span>Trigger</span><span>Min Sev</span>
          <span>Cooldown</span><span>On</span><span />
        </div>
        {!rules ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        ) : rules.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
            no rules yet</div>
        ) : rules.map((r) => (
          <div key={r.id} className="tbl-row" style={{ gridTemplateColumns: RULE_COLS,
            opacity: r.enabled ? 1 : 0.5 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <StatusPill text={r.channel} color={chanColor(r.channel)} />
            <span className="mono" style={{ fontSize: 11, color: r.triggerName ? 'var(--text1)' : 'var(--text3)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.triggerName || 'any'}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>≥ {r.severityMin}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>{r.cooldownM}m</span>
            <Toggle on={r.enabled} disabled={!canEdit} onClick={canEdit ? () => toggle(r) : undefined} />
            {canEdit ? (
              <span className="row" style={{ gap: 6 }}>
                <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
                <button className="btn btn-sm" style={{ color: SEV.critical }} onClick={() => remove(r)}>Del</button>
              </span>
            ) : <span />}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="card-title" style={{ padding: '14px 16px 0' }}>Recent Notifications</div>
        <div className="tbl-head" style={{ gridTemplateColumns: NOTIF_COLS }}>
          <span>Time</span><span>Rule</span><span>Event</span><span>Channel</span><span>Status</span>
        </div>
        {!notifs ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        ) : notifs.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
            no notifications yet</div>
        ) : notifs.map((n, i) => (
          <div key={i} className="tbl-row" style={{ gridTemplateColumns: NOTIF_COLS }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtTime(n.ts)}</span>
            <span style={{ fontSize: 11, color: 'var(--text1)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.rule}</span>
            <span className="mono" style={{ fontSize: 11, color: '#388bfd', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.event}</span>
            <StatusPill text={n.channel} color={chanColor(n.channel)} />
            <span className="mono" style={{ fontSize: 10, color: n.ok ? SEV.green : SEV.critical }}
              title={n.ok ? undefined : n.error}>{n.ok ? 'sent' : 'failed'}</span>
          </div>
        ))}
      </div>

      {editing && (
        <RuleEditor rule={editing === 'new' ? null : editing} eventNames={eventNames}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); loadRules(); }} />
      )}
    </div>
  );
}

function RuleEditor({ rule, eventNames, onClose, onSaved }:
  { rule: Rule | null; eventNames: string[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(rule?.name ?? '');
  const [channel, setChannel] = useState<Rule['channel']>(rule?.channel ?? 'email');
  const [trigger, setTrigger] = useState(rule?.triggerName ?? '');
  const [sevMin, setSevMin] = useState(rule?.severityMin ?? 60);
  const [cooldown, setCooldown] = useState(rule?.cooldownM ?? 10);
  const [recipients, setRecipients] = useState((rule?.recipients ?? []).join('\n'));
  const [saving, setSaving] = useState(false);

  const isUrl = channel === 'teams' || channel === 'webhook';
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const body = {
      name: name.trim(),
      enabled: rule?.enabled ?? true,
      channel,
      triggerName: trigger.trim() || null,
      severityMin: Number(sevMin),
      cooldownM: Number(cooldown),
      recipients: recipients.split('\n').map((r) => r.trim()).filter(Boolean),
    };
    try {
      if (rule) await api.patch(`/api/rules/${rule.id}`, body);
      else await api.post('/api/rules', body);
      onSaved();
    } catch { setSaving(false); }
  };

  return (
    <Modal title={rule ? `Edit ${rule.name}` : 'New Rule'} onClose={onClose} width={460}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Critical → on-call" />
      </Field>
      <Field label="Channel">
        <select value={channel} onChange={(e) => setChannel(e.target.value as Rule['channel'])}>
          <option value="email">email</option>
          <option value="teams">teams</option>
          <option value="webhook">webhook</option>
        </select>
      </Field>
      <Field label="Trigger Event (empty = any)">
        <input value={trigger} onChange={(e) => setTrigger(e.target.value)} list="rule-triggers"
          placeholder="any" />
        <datalist id="rule-triggers">
          {eventNames.map((n) => <option key={n} value={n} />)}
        </datalist>
      </Field>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Field label="Min Severity (0-100)">
            <input type="number" min={0} max={100} value={sevMin}
              onChange={(e) => setSevMin(Number(e.target.value))} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Cooldown (minutes)">
            <input type="number" min={0} value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value))} />
          </Field>
        </div>
      </div>
      <Field label={isUrl ? 'Webhook URL(s) — one per line' : 'Recipients — one email per line'}>
        <textarea className="rca" value={recipients} onChange={(e) => setRecipients(e.target.value)}
          placeholder={isUrl ? 'https://…' : 'noc@opscat.io'} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving || !name.trim()} onClick={save}>
          {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
