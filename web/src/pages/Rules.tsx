// Rules — alert routing rules + recent notification log. Editing requires lead+.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api, ApiError } from '../api';
import { SEV, fmtTime, CHANNEL_META, channelLabel, channelColor } from '../format';
import { Card, Button, StatusPill, Toggle, Modal, Field, TableScroll, TableSkeleton, PageHeader, Input, Textarea, COL} from '../ui';
import { Select } from '../Select';
import type { Rule, NotificationRow } from '../types';
import { PlusIcon } from 'lucide-react';

// label + color per channel live in format.ts (CHANNEL_META), so the pill, the
// picker and the notification log cannot drift apart.
// Rule | Channel | Trigger | Min Sev | Cooldown | On | actions
// actionsWide: the bar is Test / Edit / Del — labelled buttons, 130px measured
const RULE_COLS = [COL.text, COL.label, COL.text, COL.num, COL.num, COL.toggle, COL.actionsWide].join(' ');
// Time | Rule | Event | Channel | Status — the time is fmtTime, but time-of-day
// only, so it needs an age-sized track and not a full timestamp one.
const NOTIF_COLS = [COL.age, COL.text, COL.text, COL.label, COL.status].join(' ');
const DEFAULT_TRIGGERS = ['ddos', 'out_of_memory', 'synthetic_check_failed', 'snmp_unreachable',
  'agent_offline', 'host_disk_high', 'sentry_error', 'tls_cert_expiring', 'heartbeat_missed', 'container_down',
  'bridge_insight', 'incident_created', 'incident_status_changed', 'incident_resolved'];

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
  // fire a synthetic TEST ALERT through the rule's real channel
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; name: string; ok: boolean; text: string } | null>(null);
  const testFire = async (r: Rule) => {
    setTesting(r.id); setTestResult(null);
    try {
      const resp = await api.post<{ ok: boolean; latencyMs: number }>(`/api/rules/${r.id}/test`, {});
      setTestResult({ id: r.id, name: r.name, ok: true, text: `test alert sent — ${resp.latencyMs} ms` });
    } catch (ex) {
      setTestResult({ id: r.id, name: r.name, ok: false,
        text: ex instanceof ApiError ? ex.message : 'network error' });
    } finally { setTesting(null); loadNotifs(); }
  };

  return (
    <div className="page">
      <PageHeader title="Alert Rules">
        {canEdit && (
          <Button variant="primary" onClick={() => setEditing('new')}><PlusIcon size={13} /> New Rule</Button>
        )}
      </PageHeader>

      <Card style={{ padding: 0 }}>
        <TableScroll cols={RULE_COLS} stickyFirst minWidth={700}>
        <div className="tbl-head">
          <span>Rule</span><span>Channel</span><span>Trigger</span><span>Min Sev</span>
          <span>Cooldown</span><span>On</span><span />
        </div>
        {!rules ? (
          <TableSkeleton rows={4} />
        ) : rules.length === 0 ? (
          <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center'}}>
            no rules yet</div>
        ) : rules.map((r) => (
          <div key={r.id} className="tbl-row" style={{ opacity: r.enabled ? 1 : 0.5 }}>
            <span className="text-base font-semibold text-text0" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <StatusPill text={channelLabel(r.channel)} color={channelColor(r.channel)} />
            <span className="mono text-sm" style={{ color: r.triggerName ? 'var(--text1)' : 'var(--text3)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.triggerName || 'any'}</span>
            <span className="mono text-sm text-text2">≥ {r.severityMin}</span>
            <span className="mono text-sm text-text2">{r.cooldownM}m</span>
            <Toggle on={r.enabled} disabled={!canEdit} onClick={canEdit ? () => toggle(r) : undefined} />
            {canEdit ? (
              <span className="row" style={{ gap: 6 }}>
                <Button size="sm" onClick={() => testFire(r)} disabled={testing === r.id}
                  title="Send a clearly-marked test alert through this channel now">
                  {testing === r.id ? 'Sending…' : 'Test'}
                </Button>
                <Button size="sm" onClick={() => setEditing(r)}>Edit</Button>
                <Button size="sm" variant="danger" onClick={() => remove(r)}>Del</Button>
              </span>
            ) : <span />}
          </div>
        ))}
        </TableScroll>
        {testResult && (
          <div className="text-sm" style={{ padding: '8px 16px', borderTop: '1px solid var(--bg3)',
            color: testResult.ok ? SEV.green : SEV.critical }}>
            {testResult.name}: {testResult.text}
          </div>
        )}
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="card-title" style={{ padding: '14px 16px 0' }}>Recent Notifications</div>
        <TableScroll cols={NOTIF_COLS} minWidth={560}>
        <div className="tbl-head">
          <span>Time</span><span>Rule</span><span>Event</span><span>Channel</span><span>Status</span>
        </div>
        {!notifs ? (
          <TableSkeleton rows={4} />
        ) : notifs.length === 0 ? (
          <div className="text-text3 text-sm" style={{ padding: 24, textAlign: 'center'}}>
            no notifications yet</div>
        ) : notifs.map((n, i) => (
          <div key={i} className="tbl-row">
            <span className="mono text-xs text-text3">{fmtTime(n.ts)}</span>
            <span className="text-sm text-text1" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.rule}</span>
            <span className="mono text-sm" style={{ color: '#388bfd', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.event}</span>
            <StatusPill text={channelLabel(n.channel)} color={channelColor(n.channel)} />
            <span className="mono text-xs" style={{ color: n.ok ? SEV.green : SEV.critical }}
              title={n.ok ? undefined : n.error}>{n.ok ? 'sent' : 'failed'}</span>
          </div>
        ))}
        </TableScroll>
      </Card>

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

  const RECIPIENTS_UI: Record<Rule['channel'], { label: string; placeholder: string }> = {
    email: { label: 'Recipients — one email per line', placeholder: 'noc@opscat.io' },
    msteams: { label: 'Microsoft Teams webhook URL (empty = Settings default)', placeholder: 'https://…' },
    webhook: { label: 'Webhook URL', placeholder: 'https://…' },
    slack: { label: 'Slack incoming-webhook URL(s) — one per line', placeholder: 'https://hooks.slack.com/services/…' },
    telegram: { label: 'Telegram chat ID(s) — one per line (bot token in Settings)', placeholder: '-1001234567890' },
    discord: { label: 'Discord webhook URL(s) — one per line', placeholder: 'https://discord.com/api/webhooks/…' },
    ntfy: { label: 'ntfy topic URL(s) — one per line', placeholder: 'https://ntfy.sh/opscat-alerts' },
    pushover: { label: 'Pushover user key(s) — one per line (app token in Settings)', placeholder: 'uQiRzpo4DXghDmr9…' },
  };
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
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Critical → on-call" />
      </Field>
      <Field label="Channel">
        <Select title="Channel" value={channel} onChange={(v) => setChannel(v as Rule['channel'])}
          options={Object.entries(CHANNEL_META).map(([value, m]) => ({ value, label: m.label }))} />
      </Field>
      <Field label="Trigger Event (empty = any)">
        <Input value={trigger} onChange={(e) => setTrigger(e.target.value)} list="rule-triggers"
          placeholder="any" />
        <datalist id="rule-triggers">
          {eventNames.map((n) => <option key={n} value={n} />)}
        </datalist>
      </Field>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Field label="Min Severity (0-100)">
            <Input type="number" min={0} max={100} value={sevMin}
              onChange={(e) => setSevMin(Number(e.target.value))} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Cooldown (minutes)">
            <Input type="number" min={0} value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value))} />
          </Field>
        </div>
      </div>
      <Field label={RECIPIENTS_UI[channel].label}>
        <Textarea className="rca" value={recipients} onChange={(e) => setRecipients(e.target.value)}
          placeholder={RECIPIENTS_UI[channel].placeholder} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={saving || !name.trim()} onClick={save}>
          {saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
  );
}
