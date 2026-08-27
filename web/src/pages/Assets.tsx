// Assets — every monitored counterparty in one list: server agents, SNMP
// targets, synthetic checks and implicit log/event sources (applications),
// with a single "+ Add" entry point that routes to the right flow.
import React, { useEffect, useState } from 'react';
import { useApp, useTab } from '../state';
import { api } from '../api';
import { SEV, relTime } from '../format';
import { Card, Button, Modal, StatusPill, Field, TableScroll, TableSkeleton, PageHeader, Tabs, Input, COL} from '../ui';
import {
  AppWindowIcon,
  ArrowUpRightIcon,
  HeartPulseIcon,
  NetworkIcon,
  PlusIcon,
  RadarIcon,
  ServerIcon,
  XIcon,
} from 'lucide-react';
import { CreateKeyModal, RegisterAgentModal, AddTargetModal, OnceSecretModal } from './Settings';
import type { SecretInfo } from './Settings';
import type { AssetRow } from '../types';

// Name | Type | Detail | Status | Last seen | delete. Detail holds the hostname,
// URL or target, so it is the one that gets the slack — Name and Detail were both
// `1fr` before, which split it evenly between a short name and a long address.
// Type holds a StatusPill, so it takes COL.status — whose own note reads "one
// StatusPill or SevBadge". It was COL.label (minmax(90px, 0.6fr)), i.e. the track
// for short *text*, and at 390px it resolved to 54px: enough for "check", not for
// "log source". Status is the one carrying free text here, so the two swap.
const COLS = [COL.text, COL.status, COL.textWide, COL.label, COL.age, COL.tiny].join(' ');

const KIND_UI: Record<AssetRow['kind'], { label: string; color: string }> = {
  agent: { label: 'agent', color: '#38b6ff' },
  snmp: { label: 'snmp', color: '#e3b341' },
  check: { label: 'check', color: '#bc8cff' },
  heartbeat: { label: 'heartbeat', color: '#f0883e' },
  container: { label: 'container', color: '#58a6ff' },
  'log-source': { label: 'log source', color: '#3fb950' },
  syslog: { label: 'syslog', color: '#2ea043' },
  vendor: { label: 'vendor', color: '#d29922' },
  reputation: { label: 'reputation', color: '#f85149' },
};

// Every kind in KIND_UI gets a tab, in the order the list reads best. `reputation`
// was missing from the old filter row while its rows were in the table — the one
// asset kind nobody could narrow to.
const ASSET_TABS = ['all', 'agent', 'container', 'snmp', 'check', 'heartbeat',
  'vendor', 'reputation', 'syslog', 'log-source'] as const;
type AssetTab = typeof ASSET_TABS[number];

/**
 * Where an asset actually LIVES — the page that owns it, and the overlay parameter
 * that opens its detail there.
 *
 * Assets is a directory, not a store: every row is a projection of a record that
 * belongs to another page, which already has a flyout for it. So a click does not
 * open a second, thinner panel here — it navigates to the owning page with the
 * overlay parameter set, and the real flyout opens exactly as if the reader had
 * arrived on that page and clicked the row themselves. One detail view per record,
 * and it stays the one its own page maintains.
 *
 * `null` where nothing owns the row yet: a container has no id of its own (it is a
 * name under an agent), a `source` is an inferred log device rather than a record,
 * and a heartbeat is configured here. Those rows are deliberately NOT clickable —
 * a row that looks interactive and does nothing is worse than one that does not.
 */
function assetTarget(r: AssetRow): { nav: string; search: string; label: string } | null {
  if (r.id == null) {
    // A log source has no record, but it does have a name the log view filters by —
    // which is the closest thing to "show me this asset" that exists for it.
    if (r.kind === 'log-source') {
      return { nav: 'logs', search: `?q=${encodeURIComponent(r.name)}`, label: 'Open in Logs' };
    }
    return null;
  }
  switch (r.kind) {
    case 'check': return { nav: 'synthetics', search: `?check=${r.id}`, label: 'Open in Synthetics' };
    case 'vendor': return { nav: 'vendors', search: `?vendor=${r.id}`, label: 'Open in Vendors' };
    case 'reputation': return { nav: 'reputation', search: `?asset=${r.id}`, label: 'Open in Reputation' };
    /* A syslog endpoint is a real record with a real flyout, so this opens THAT
     * one — the tab segment names the tab, the query parameter names the row,
     * and the reader lands exactly where they would have by clicking it in
     * Settings themselves. */
    case 'syslog': return { nav: 'settings/collectors', search: `?endpoint=${r.id}`, label: 'Open in Settings' };
    // Agents and SNMP targets are configured in Settings and have no flyout of their
    // own yet, so this lands on the tab that lists them rather than on the record.
    case 'agent':
    case 'snmp': return { nav: 'settings/collectors', search: '', label: 'Open in Settings' };
    default: return null;
  }
}

function statusColor(s: string): string {
  if (s === 'online' || s === 'ok' || s === 'active' || s === 'running') return SEV.green;
  // `unknown` = a reputation run that could not complete. Amber, not red: there
  // is no evidence against the asset, only missing evidence.
  if (s === 'pending' || s === 'late' || s === 'restarting' || s === 'paused' || s === 'unknown') return '#e3b341';
  // `waiting` = configured and nothing has arrived yet. Grey rather than green:
  // an endpoint nobody ever connected is the commonest support case in syslog,
  // and colouring it like a working one is how it stays unnoticed.
  if (s === 'disabled' || s === 'waiting' || s === 'created') return 'var(--text3)';
  if (s === 'listed') return SEV.high;
  return SEV.critical; // offline / failing / missing / exited / unreachable / error text
}

export default function Assets() {
  const app = useApp();
  const canEdit = app.user ? app.user.role !== 'analyst' : false;
  const [rows, setRows] = useState<AssetRow[] | null>(null);
  // In the path, not in useState: these are eight mutually exclusive lists, each of
  // them a place worth linking to. Held in state, "look at the containers" could not
  // be sent to anyone, Back left the page entirely and a reload dropped the reader
  // on `all` — the one view they had just navigated away from.
  const [filter, setFilter] = useTab(ASSET_TABS);
  const [adding, setAdding] = useState(false);
  const [modal, setModal] = useState<'key' | 'agent' | 'target' | 'heartbeat' | null>(null);
  const [secret, setSecret] = useState<SecretInfo | null>(null);

  const load = () => api.get<AssetRow[]>('/api/assets').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const shown = rows?.filter((r) => filter === 'all' || r.kind === filter);
  // null, not 0, while the rows are still on their way — see ui.tsx <Count>.
  const counts = (k: AssetTab) => (rows === null ? null
    : k === 'all' ? rows.length : rows.filter((r) => r.kind === k).length);

  const pick = (m: 'key' | 'agent' | 'target' | 'heartbeat' | 'synthetics') => {
    setAdding(false);
    if (m === 'synthetics') { app.setNav('synthetics'); return; }
    setModal(m);
  };

  const removeHeartbeat = async (r: AssetRow) => {
    if (!confirm(`Delete heartbeat "${r.name}"?`)) return;
    await api.del(`/api/heartbeats/${r.id}`);
    load();
  };

  return (
    <div className="page">
      <PageHeader title="Assets">
        {canEdit && <Button variant="primary" onClick={() => setAdding(true)}><PlusIcon size={13} /> Add</Button>}
      </PageHeader>

      {/* Was a row of <Button size="sm"> with the active state written inline at each
          call site — the look of the "+ Add" CTA one line above, for eight things
          that command nothing. Tabs also puts the choice in the URL. */}
      <Tabs value={filter} onChange={setFilter} tabs={ASSET_TABS.map((k) => {
        const label = k === 'all' ? 'All' : KIND_UI[k].label;
        return [k, `${label[0].toUpperCase()}${label.slice(1)}`, counts(k)] as const;
      })} />

      <Card style={{ padding: 0 }}>
        <TableScroll cols={COLS} stickyFirst minWidth={700}>
        <div className="tbl-head">
          <span>Name</span><span>Type</span><span>Detail</span><span>Status</span><span>Last seen</span><span />
        </div>
        {!shown ? (
          <TableSkeleton rows={6} />
        ) : shown.length === 0 ? (
          <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center'}}>
            nothing monitored yet — hit “+ Add” to bring in your first server, device, app or check</div>
        ) : shown.map((r, i) => {
          const target = assetTarget(r);
          const go = target ? () => app.setNav(target.nav, target.search) : undefined;
          return (
          <div key={`${r.kind}-${r.id ?? r.name}-${i}`} className="tbl-row"
            style={go ? { cursor: 'pointer' } : undefined}
            title={target ? target.label : undefined}
            onClick={go}>
            <span className="mono text-base font-semibold text-text0" style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <StatusPill text={KIND_UI[r.kind].label} color={KIND_UI[r.kind].color} />
            <span className="mono text-sm text-text2" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail || '—'}</span>
            <span className="mono text-sm" style={{ color: statusColor(r.status), overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.status}>{r.status}</span>
            <span className="mono text-xs text-text3">
              {r.lastSeen ? relTime(r.lastSeen) : 'never'}</span>
            <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}
              onClick={(e) => e.stopPropagation()}>
              {canEdit && r.kind === 'heartbeat' && (
                <button title="Delete heartbeat" style={{ color: SEV.critical, display: 'inline-flex' }}
                  onClick={() => removeHeartbeat(r)}><XIcon size={15} /></button>
              )}
              {target && (
                <button title={target.label} onClick={go} aria-label={target.label}
                  className="text-text3" style={{ display: 'inline-flex' }}>
                  <ArrowUpRightIcon size={14} />
                </button>
              )}
            </span>
          </div>
          );
        })}
        </TableScroll>
      </Card>

      {adding && (
        <Modal title="Add to monitoring" onClose={() => setAdding(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <AddChoice icon={<ServerIcon size={17} />} title="Server" note="Install the OpsCat agent — CPU, RAM, disk, network + logs"
              onClick={() => pick('agent')} />
            <AddChoice icon={<NetworkIcon size={17} />} title="Network device" note="Poll a switch, router or firewall via SNMP"
              onClick={() => pick('target')} />
            <AddChoice icon={<AppWindowIcon size={17} />} title="Application" note="Create an API key for the SDK, OTLP, Sentry or webhooks"
              onClick={() => pick('key')} />
            <AddChoice icon={<RadarIcon size={17} />} title="Synthetic check" note="HTTP, ping, DNS, TCP or traceroute — from one or more locations"
              onClick={() => pick('synthetics')} />
            <AddChoice icon={<HeartPulseIcon size={17} />} title="Heartbeat / cron job" note="A backup or cron job pings a URL — silence raises an alert"
              onClick={() => pick('heartbeat')} />
          </div>
        </Modal>
      )}
      {modal === 'agent' && <RegisterAgentModal onClose={() => setModal(null)} onCreated={load} onSecret={setSecret} />}
      {modal === 'target' && <AddTargetModal onClose={() => setModal(null)} onCreated={load} />}
      {modal === 'key' && <CreateKeyModal onClose={() => setModal(null)} onCreated={load} onSecret={setSecret} />}
      {modal === 'heartbeat' && <CreateHeartbeatModal onClose={() => setModal(null)} onCreated={load} onSecret={setSecret} />}
      {secret && <OnceSecretModal {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function CreateHeartbeatModal({ onClose, onCreated, onSecret }:
  { onClose: () => void; onCreated: () => void; onSecret: (s: SecretInfo) => void }) {
  const [name, setName] = useState('');
  const [intervalS, setIntervalS] = useState(3600);
  const [graceS, setGraceS] = useState(300);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post<{ pingUrl: string }>('/api/heartbeats', { name, intervalS, graceS });
      onSecret({
        title: 'Heartbeat created',
        note: 'Ping this URL from your job (curl -fsS <url>). It is shown only once.',
        value: r.pingUrl,
      });
      onCreated(); onClose();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title="Add heartbeat" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="nightly-backup" />
        </Field>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <Field label="Expected every (seconds)">
              <Input type="number" min={30} value={intervalS}
                onChange={(e) => setIntervalS(Number(e.target.value))} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Grace (seconds)">
              <Input type="number" min={0} value={graceS}
                onChange={(e) => setGraceS(Number(e.target.value))} />
            </Field>
          </div>
        </div>
        <div className="text-xs text-text3" style={{ marginBottom: 8 }}>
          No ping for longer than interval + grace raises a <span className="mono">heartbeat_missed</span> event.
        </div>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy || !name.trim()}>{busy ? '…' : 'Create heartbeat'}</Button>
      </form>
    </Modal>
  );
}

function AddChoice({ icon, title, note, onClick }:
  { icon: React.ReactNode; title: string; note: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center',
      textAlign: 'left', cursor: 'pointer', padding: '12px 14px', background: 'var(--bg2)' }}>
      <span className="text-text2" style={{ fontSize: 18}}>{icon}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="text-base font-bold text-text0">{title}</span>
        <span className="text-xs text-text3">{note}</span>
      </span>
    </button>
  );
}
