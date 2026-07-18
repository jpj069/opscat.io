// StatusPageAdmin — public status page management: publish toggle + components.
import React, { useEffect, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { alpha } from '../format';
import { Toggle, GlowDot, Modal, Field } from '../ui';
import type { Component, CompStatus } from '../types';

const GRID = '20px 1fr 110px 150px 260px 70px';
const COMP_COLOR: Record<CompStatus, string> = {
  operational: '#3fb950', degraded: '#e3b341', partial: '#f0883e', major: '#f85149', maintenance: '#bc8cff',
};
const COMP_STATUSES: CompStatus[] = ['operational', 'degraded', 'partial', 'major', 'maintenance'];
const RANK: Record<CompStatus, number> = { operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };
const OVERALL: Record<CompStatus, string> = {
  operational: 'All Systems Operational',
  maintenance: 'Scheduled Maintenance in Progress',
  degraded: 'Degraded Performance',
  partial: 'Partial Outage',
  major: 'Major Outage',
};
const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };

// uptime-strip cell color (maintenance shares the amber warning tone here)
function dayColor(w: CompStatus): string {
  switch (w) {
    case 'operational': return alpha('#3fb950', 0.55);
    case 'degraded': case 'maintenance': return '#e3b341';
    case 'partial': return '#f0883e';
    case 'major': return '#f85149';
  }
}

export default function StatusPageAdmin() {
  const app = useApp();
  const [components, setComponents] = useState<Component[] | null>(null);
  const [published, setPublished] = useState(app.settings.status_published === '1');
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => { setPublished(app.settings.status_published === '1'); }, [app.settings.status_published]);

  const load = () => api.get<Component[]>('/api/admin/components').then(setComponents).catch(() => setComponents([]));
  useEffect(() => { load(); }, []);

  const role = app.user?.role;
  const isAdmin = role === 'admin';
  const isAnalyst = role === 'analyst';
  const canEdit = (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK.lead; // lead+

  const togglePublish = async () => {
    const next = !published;
    setPublished(next);
    try { await api.patch('/api/admin/settings', { status_published: next ? '1' : '0' }); }
    catch { setPublished(!next); }
  };
  const setStatus = async (id: number, status: CompStatus) => {
    await api.patch(`/api/admin/components/${id}`, { status });
    load();
  };
  const remove = async (c: Component) => {
    if (!window.confirm(`Delete component “${c.name}”?`)) return;
    await api.del(`/api/admin/components/${c.id}`);
    load();
  };

  const worst: CompStatus = components && components.length
    ? components.reduce<CompStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'operational')
    : 'operational';
  const overallColor = COMP_COLOR[worst];

  return (
    <div className="page">
      {/* header */}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Status Page</h1>
        <div className="row" style={{ gap: 16 }}>
          {isAdmin && (
            <span className="row" style={{ gap: 8 }}>
              <Toggle on={published} onClick={togglePublish} />
              <span className="micro" style={{ fontSize: 9 }}>{published ? 'Published' : 'Unpublished'}</span>
            </span>
          )}
          <a className="btn" href="/status" target="_blank" rel="noreferrer">View public page ↗</a>
        </div>
      </div>

      {/* overall banner */}
      <div className="card" style={{ borderColor: alpha(overallColor, 0.4), background: alpha(overallColor, 0.06) }}>
        <div className="row" style={{ gap: 10 }}>
          <GlowDot color={overallColor} size={10} />
          <span style={{ fontSize: 14, fontWeight: 700, color: overallColor }}>{OVERALL[worst]}</span>
        </div>
      </div>

      {/* components table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px' }}>
          <span className="card-title" style={{ margin: 0 }}>Components</span>
          {canEdit && <button className="btn btn-sm" onClick={() => setShowAdd(true)}>+ Add component</button>}
        </div>
        <div className="tbl-head" style={{ gridTemplateColumns: GRID }}>
          <span />
          <span>Name</span>
          <span>Group</span>
          <span>Status</span>
          <span>45-day uptime</span>
          <span style={{ textAlign: 'right' }}>Uptime</span>
        </div>
        {components === null && (
          <div className="mono" style={{ padding: 20, color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        )}
        {components && components.length === 0 && (
          <div style={{ padding: 20, color: 'var(--text3)', fontSize: 11 }}>No components yet.</div>
        )}
        {components?.map((c) => {
          const pct = c.uptimePct.replace(/%/g, '');
          return (
            <div key={c.id} className="tbl-row" style={{ gridTemplateColumns: GRID }}>
              <GlowDot color={COMP_COLOR[c.status]} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)' }}>{c.name}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{c.group}</span>
              <select value={c.status} disabled={isAnalyst}
                onChange={(e) => setStatus(c.id, e.target.value as CompStatus)}
                style={{ fontSize: 11, padding: '3px 6px' }}>
                {COMP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <UptimeStrip days={c.days} />
              <span className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>{pct}%</span>
                {canEdit && (
                  <button className="btn btn-sm" title="Delete" onClick={() => remove(c)}
                    style={{ color: '#f85149' }}>×</button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {showAdd && <AddComponentModal onClose={() => setShowAdd(false)}
        onAdded={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ uptime strip

function UptimeStrip({ days }: { days: Component['days'] }) {
  const shown = days.slice(-45);
  const pad = Math.max(0, 45 - shown.length);
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', height: 18 }}>
      {Array.from({ length: pad }).map((_, i) => (
        <div key={`p${i}`} style={{ flex: 1, minWidth: 0, height: 18, borderRadius: 1,
          background: 'var(--bg3)', opacity: 0.4 }} />
      ))}
      {shown.map((d, i) => (
        <div key={i} title={`${d.day} · ${d.worst}`} style={{ flex: 1, minWidth: 0, height: 18,
          borderRadius: 1, background: dayColor(d.worst) }} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ add modal

function AddComponentModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/api/admin/components', { name, group }); onAdded(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="Add component" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="API Gateway" />
        </Field>
        <Field label="Group">
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Core Services" />
        </Field>
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !name}>{busy ? '…' : 'Add component'}</button>
      </form>
    </Modal>
  );
}
