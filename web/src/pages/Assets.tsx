// Assets — every monitored counterparty in one list: server agents, SNMP
// targets, synthetic checks and implicit log/event sources (applications),
// with a single "+ Add" entry point that routes to the right flow.
import React, { useEffect, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, relTime } from '../format';
import { Modal, StatusPill, Field, TableScroll } from '../ui';
import { ServerIcon, NetworkIcon, AppWindowIcon, RadarIcon, HeartPulseIcon } from 'lucide-react';
import { CreateKeyModal, RegisterAgentModal, AddTargetModal, OnceSecretModal } from './Settings';
import type { SecretInfo } from './Settings';
import type { AssetRow } from '../types';

const COLS = '1fr 110px 1fr 110px 110px 34px';

const KIND_UI: Record<AssetRow['kind'], { label: string; color: string }> = {
  agent: { label: 'agent', color: '#38b6ff' },
  snmp: { label: 'snmp', color: '#e3b341' },
  check: { label: 'check', color: '#bc8cff' },
  heartbeat: { label: 'heartbeat', color: '#f0883e' },
  container: { label: 'container', color: '#58a6ff' },
  source: { label: 'source', color: '#3fb950' },
};

function statusColor(s: string): string {
  if (s === 'online' || s === 'ok' || s === 'active' || s === 'running') return SEV.green;
  if (s === 'pending' || s === 'late' || s === 'restarting' || s === 'paused') return '#e3b341';
  if (s === 'disabled' || s === 'waiting' || s === 'created') return 'var(--text3)';
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
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Assets</h1>
        {canEdit && <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add</button>}
      </div>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {(['all', 'agent', 'container', 'snmp', 'check', 'heartbeat', 'source'] as const).map((k) => (
          <button key={k} className="btn btn-sm" onClick={() => setFilter(k)}
            style={{ background: filter === k ? 'var(--bg3)' : undefined,
              color: filter === k ? 'var(--text0)' : 'var(--text2)' }}>
            {k === 'all' ? `all (${rows?.length ?? 0})` : `${KIND_UI[k].label} (${counts(k)})`}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <TableScroll minWidth={700}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Name</span><span>Type</span><span>Detail</span><span>Status</span><span>Last seen</span><span />
        </div>
        {!shown ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        ) : shown.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
            nothing monitored yet — hit “+ Add” to bring in your first server, device, app or check</div>
        ) : shown.map((r, i) => (
          <div key={`${r.kind}-${r.id ?? r.name}-${i}`} className="tbl-row" style={{ gridTemplateColumns: COLS }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <StatusPill text={KIND_UI[r.kind].label} color={KIND_UI[r.kind].color} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--text2)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail || '—'}</span>
            <span className="mono" style={{ fontSize: 11, color: statusColor(r.status), overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.status}>{r.status}</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>
              {r.lastSeen ? relTime(r.lastSeen) : 'never'}</span>
            <span>
              {canEdit && r.kind === 'heartbeat' && (
                <button title="Delete heartbeat" style={{ color: SEV.critical, fontSize: 13 }}
                  onClick={() => removeHeartbeat(r)}>×</button>
              )}
            </span>
          </div>
        ))}
        </TableScroll>
      </div>

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
          <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="nightly-backup" />
        </Field>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <Field label="Expected every (seconds)">
              <input type="number" min={30} value={intervalS}
                onChange={(e) => setIntervalS(Number(e.target.value))} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Grace (seconds)">
              <input type="number" min={0} value={graceS}
                onChange={(e) => setGraceS(Number(e.target.value))} />
            </Field>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
          No ping for longer than interval + grace raises a <span className="mono">heartbeat_missed</span> event.
        </div>
        {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !name.trim()}>{busy ? '…' : 'Create heartbeat'}</button>
      </form>
    </Modal>
  );
}

function AddChoice({ icon, title, note, onClick }:
  { icon: React.ReactNode; title: string; note: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center',
      textAlign: 'left', cursor: 'pointer', padding: '12px 14px', background: 'var(--bg2)' }}>
      <span style={{ fontSize: 18, color: 'var(--text2)' }}>{icon}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text0)' }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{note}</span>
      </span>
    </button>
  );
}
