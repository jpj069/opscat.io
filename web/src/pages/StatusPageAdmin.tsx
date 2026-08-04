// StatusPageAdmin — public status page management: publish toggle, components
// + anonymous user problem reports (Downdetector-style).
import React, { useEffect, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { alpha, relTime } from '../format';
import { Toggle, GlowDot, Modal, Field, TableScroll, TableSkeleton, PageHeader, Input} from '../ui';
import { Select } from '../Select';
import type { Component, CompStatus, StatusReportsResponse } from '../types';

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
      <PageHeader title="Status Page">
        {isAdmin && (
          <span className="row" style={{ gap: 8 }}>
            <Toggle on={published} onClick={togglePublish} />
            <span className="micro text-2xs">{published ? 'Published' : 'Unpublished'}</span>
          </span>
        )}
        <a className="btn" href="/status" target="_blank" rel="noreferrer">View public page ↗</a>
      </PageHeader>

      {/* overall banner */}
      <div className="card" style={{ borderColor: alpha(overallColor, 0.4), background: alpha(overallColor, 0.06) }}>
        <div className="row" style={{ gap: 10 }}>
          <GlowDot color={overallColor} size={10} />
          <span className="text-lg font-bold" style={{ color: overallColor }}>{OVERALL[worst]}</span>
        </div>
      </div>

      {/* components table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px' }}>
          <span className="card-title" style={{ margin: 0 }}>Components</span>
          {canEdit && <button className="btn btn-sm" onClick={() => setShowAdd(true)}>+ Add component</button>}
        </div>
        <TableScroll stickyFirst minWidth={780}>
        <div className="tbl-head" style={{ gridTemplateColumns: GRID }}>
          <span />
          <span>Name</span>
          <span>Group</span>
          <span>Status</span>
          <span>45-day uptime</span>
          <span style={{ textAlign: 'right' }}>Uptime</span>
        </div>
        {components === null && <TableSkeleton cols={GRID} rows={5} />}
        {components && components.length === 0 && (
          <div className="text-text3 text-sm" style={{ padding: 20}}>No components yet.</div>
        )}
        {components?.map((c) => {
          const pct = c.uptimePct.replace(/%/g, '');
          return (
            <div key={c.id} className="tbl-row" style={{ gridTemplateColumns: GRID }}>
              <GlowDot color={COMP_COLOR[c.status]} />
              <span className="text-base font-semibold text-text0">{c.name}</span>
              <span className="mono text-xs text-text2">{c.group}</span>
              <Select title="Component status" value={c.status} disabled={isAnalyst}
                onChange={(v) => setStatus(c.id, v as CompStatus)}
                options={COMP_STATUSES.map((s) => ({ value: s, label: s }))} />
              <UptimeStrip days={c.days} />
              <span className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <span className="mono text-sm text-text1">{pct}%</span>
                {canEdit && (
                  <button className="btn btn-sm" title="Delete" onClick={() => remove(c)}
                    style={{ color: '#f85149' }}>×</button>
                )}
              </span>
            </div>
          );
        })}
        </TableScroll>
      </div>

      <UserReports isAdmin={isAdmin} />

      {showAdd && <AddComponentModal onClose={() => setShowAdd(false)}
        onAdded={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ user reports

function UserReports({ isAdmin }: { isAdmin: boolean }) {
  const app = useApp();
  const [data, setData] = useState<StatusReportsResponse | null>(null);
  const [enabled, setEnabled] = useState(app.settings.status_reports_enabled !== '0');
  const [publicCount, setPublicCount] = useState(app.settings.status_reports_public === '1');
  const [threshold, setThreshold] = useState(app.settings.status_reports_threshold || '5');

  useEffect(() => {
    setEnabled(app.settings.status_reports_enabled !== '0');
    setPublicCount(app.settings.status_reports_public === '1');
    setThreshold(app.settings.status_reports_threshold || '5');
  }, [app.settings]);

  const load = () => api.get<StatusReportsResponse>('/api/status-reports?hours=24')
    .then(setData).catch(() => setData({ total: 0, reports: [] }));
  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const save = async (patch: Record<string, string>) => {
    try { await api.patch('/api/admin/settings', patch); } catch { /* revert via settings reload */ }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px', flexWrap: 'wrap', gap: 10 }}>
        <span className="card-title" style={{ margin: 0 }}>
          User reports (last 24h: {data ? data.total : '…'})</span>
        {isAdmin && (
          <span className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 6 }}>
              <Toggle on={enabled} onClick={() => { setEnabled(!enabled); save({ status_reports_enabled: !enabled ? '1' : '0' }); }} />
              <span className="micro text-2xs">Accept reports</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <Toggle on={publicCount} onClick={() => { setPublicCount(!publicCount); save({ status_reports_public: !publicCount ? '1' : '0' }); }} />
              <span className="micro text-2xs">Show count publicly</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="micro text-2xs">Alert at</span>
              <Input className="text-sm" type="number" min={1} max={1000} value={threshold} width={60} style={{ padding: '3px 6px' }}
                onChange={(e) => setThreshold(e.target.value)}
                onBlur={() => save({ status_reports_threshold: String(Math.max(1, parseInt(threshold, 10) || 5)) })} />
              <span className="micro text-2xs">/ 15 min</span>
            </span>
          </span>
        )}
      </div>
      <div style={{ padding: '0 16px 12px' }}>
        {!data || data.reports.length === 0 ? (
          <div className="text-sm text-text3" style={{ paddingBottom: 4 }}>
            no reports in the last 24 hours — visitors can report problems on the public status page;
            a spike raises a <span className="mono">user_reports_spike</span> event</div>
        ) : data.reports.slice(0, 30).map((r, i) => (
          <div key={i} className="row" style={{ gap: 8, padding: '4px 0', borderBottom: '1px solid var(--bg3)' }}>
            <span className="mono text-xs text-text3" style={{ flexShrink: 0 }}>{relTime(r.ts)}</span>
            {r.component && <span className="mono text-xs text-text2" style={{ flexShrink: 0 }}>[{r.component}]</span>}
            <span className="text-sm text-text1" style={{ overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap' }}>{r.message || <span className="text-text3">no message</span>}</span>
          </div>
        ))}
      </div>
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
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="API Gateway" />
        </Field>
        <Field label="Group">
          <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Core Services" />
        </Field>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !name}>{busy ? '…' : 'Add component'}</button>
      </form>
    </Modal>
  );
}
