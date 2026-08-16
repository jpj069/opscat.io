// Assets — every monitored counterparty in one list: server agents, SNMP
// targets, synthetic checks and implicit log/event sources (applications),
// with a single "+ Add" entry point that routes to the right flow.
import React, { useEffect, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, relTime } from '../format';
import { Card, Button, Modal, StatusPill, Field, TableScroll, TableSkeleton, PageHeader, Input, COL} from '../ui';
import {
  AppWindowIcon,
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
const COLS = [COL.text, COL.label, COL.textWide, COL.status, COL.age, COL.tiny].join(' ');

const KIND_UI: Record<AssetRow['kind'], { label: string; color: string }> = {
  agent: { label: 'agent', color: '#38b6ff' },
  snmp: { label: 'snmp', color: '#e3b341' },
  check: { label: 'check', color: '#bc8cff' },
  heartbeat: { label: 'heartbeat', color: '#f0883e' },
  container: { label: 'container', color: '#58a6ff' },
  source: { label: 'source', color: '#3fb950' },
  vendor: { label: 'vendor', color: '#d29922' },
  reputation: { label: 'reputation', color: '#f85149' },
};

function statusColor(s: string): string {
  if (s === 'online' || s === 'ok' || s === 'active' || s === 'running') return SEV.green;
  // `unknown` = a reputation run that could not complete. Amber, not red: there
  // is no evidence against the asset, only missing evidence.
  if (s === 'pending' || s === 'late' || s === 'restarting' || s === 'paused' || s === 'unknown') return '#e3b341';
  if (s === 'disabled' || s === 'waiting' || s === 'created') return 'var(--text3)';
  if (s === 'listed') return SEV.high;
  return SEV.critical; // offline / failing / missing / exited / unreachable / error text
}

export default function Assets() {
  const app = useApp();
  const canEdit = app.user ? app.user.role !== 'analyst' : false;
  const [rows, setRows] = useState<AssetRow[] | null>(null);
  const [filter, setFilter] = useState<AssetRow['kind'] | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [modal, setModal] = useState<'key' | 'agent' | 'target' | 'heartbeat' | null>(null);
  const [secret, setSecret] = useState<SecretInfo | null>(null);

  const load = () => api.get<AssetRow[]>('/api/assets').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const shown = rows?.filter((r) => filter === 'all' || r.kind === filter);
  const counts = (k: AssetRow['kind']) => rows?.filter((r) => r.kind === k).length ?? 0;

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

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {(['all', 'agent', 'container', 'snmp', 'check', 'heartbeat', 'vendor', 'source'] as const).map((k) => (
          <Button size="sm" key={k} onClick={() => setFilter(k)}
 style={{ background: filter === k ? 'var(--bg3)' : undefined,
 color: filter === k ? 'var(--text0)' : 'var(--text2)' }}>
            {k === 'all' ? `all (${rows?.length ?? 0})` : `${KIND_UI[k].label} (${counts(k)})`}
          </Button>
        ))}
      </div>

      <Card style={{ padding: 0 }}>
        <TableScroll stickyFirst minWidth={700}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Name</span><span>Type</span><span>Detail</span><span>Status</span><span>Last seen</span><span />
        </div>
        {!shown ? (
          <TableSkeleton cols={COLS} rows={6} />
        ) : shown.length === 0 ? (
          <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center'}}>
            nothing monitored yet — hit “+ Add” to bring in your first server, device, app or check</div>
        ) : shown.map((r, i) => (
          <div key={`${r.kind}-${r.id ?? r.name}-${i}`} className="tbl-row" style={{ gridTemplateColumns: COLS }}>
            <span className="mono text-base font-semibold text-text0" style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <StatusPill text={KIND_UI[r.kind].label} color={KIND_UI[r.kind].color} />
            <span className="mono text-sm text-text2" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail || '—'}</span>
            <span className="mono text-sm" style={{ color: statusColor(r.status), overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.status}>{r.status}</span>
            <span className="mono text-xs text-text3">
              {r.lastSeen ? relTime(r.lastSeen) : 'never'}</span>
            <span>
              {canEdit && r.kind === 'heartbeat' && (
                <button title="Delete heartbeat" style={{ color: SEV.critical, display: 'inline-flex' }}
                  onClick={() => removeHeartbeat(r)}><XIcon size={15} /></button>
              )}
            </span>
          </div>
        ))}
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
