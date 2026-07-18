// Inventory — every monitored counterparty in one list: server agents, SNMP
// targets, synthetic checks and implicit log/event sources (applications),
// with a single "+ Add" entry point that routes to the right flow.
import React, { useEffect, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, relTime } from '../format';
import { Modal, StatusPill } from '../ui';
import { CreateKeyModal, RegisterAgentModal, AddTargetModal, OnceSecretModal } from './Settings';
import type { SecretInfo } from './Settings';
import type { InventoryRow } from '../types';

const COLS = '1fr 110px 1fr 110px 110px';

const KIND_UI: Record<InventoryRow['kind'], { label: string; color: string }> = {
  agent: { label: 'agent', color: '#38b6ff' },
  snmp: { label: 'snmp', color: '#e3b341' },
  check: { label: 'check', color: '#bc8cff' },
  source: { label: 'source', color: '#3fb950' },
};

function statusColor(s: string): string {
  if (s === 'online' || s === 'ok' || s === 'active') return SEV.green;
  if (s === 'pending') return '#e3b341';
  if (s === 'disabled') return 'var(--text3)';
  return SEV.critical; // offline / failing / unreachable / error text
}

export default function Inventory() {
  const app = useApp();
  const canEdit = app.user ? app.user.role !== 'analyst' : false;
  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  const [filter, setFilter] = useState<InventoryRow['kind'] | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [modal, setModal] = useState<'key' | 'agent' | 'target' | null>(null);
  const [secret, setSecret] = useState<SecretInfo | null>(null);

  const load = () => api.get<InventoryRow[]>('/api/inventory').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const shown = rows?.filter((r) => filter === 'all' || r.kind === filter);
  const counts = (k: InventoryRow['kind']) => rows?.filter((r) => r.kind === k).length ?? 0;

  const pick = (m: 'key' | 'agent' | 'target' | 'synthetics') => {
    setAdding(false);
    if (m === 'synthetics') { app.setNav('synthetics'); return; }
    setModal(m);
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Inventory</h1>
        {canEdit && <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add</button>}
      </div>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {(['all', 'agent', 'snmp', 'check', 'source'] as const).map((k) => (
          <button key={k} className="btn btn-sm" onClick={() => setFilter(k)}
            style={{ background: filter === k ? 'var(--bg3)' : undefined,
              color: filter === k ? 'var(--text0)' : 'var(--text2)' }}>
            {k === 'all' ? `all (${rows?.length ?? 0})` : `${KIND_UI[k].label} (${counts(k)})`}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Name</span><span>Type</span><span>Detail</span><span>Status</span><span>Last seen</span>
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
          </div>
        ))}
      </div>

      {adding && (
        <Modal title="Add to monitoring" onClose={() => setAdding(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <AddChoice icon="⌗" title="Server" note="Install the OpsCat agent — CPU, RAM, disk, network + logs"
              onClick={() => pick('agent')} />
            <AddChoice icon="◈" title="Network device" note="Poll a switch, router or firewall via SNMP"
              onClick={() => pick('target')} />
            <AddChoice icon="≡" title="Application" note="Create an API key for the SDK, OTLP, Sentry or webhooks"
              onClick={() => pick('key')} />
            <AddChoice icon="◉" title="Synthetic check" note="HTTP, ping, DNS or traceroute — from one or more locations"
              onClick={() => pick('synthetics')} />
          </div>
        </Modal>
      )}
      {modal === 'agent' && <RegisterAgentModal onClose={() => setModal(null)} onCreated={load} onSecret={setSecret} />}
      {modal === 'target' && <AddTargetModal onClose={() => setModal(null)} onCreated={load} />}
      {modal === 'key' && <CreateKeyModal onClose={() => setModal(null)} onCreated={load} onSecret={setSecret} />}
      {secret && <OnceSecretModal {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function AddChoice({ icon, title, note, onClick }:
  { icon: string; title: string; note: string; onClick: () => void }) {
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
