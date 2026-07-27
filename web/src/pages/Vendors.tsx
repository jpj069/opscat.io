// Vendors — 3rd-party supply-chain monitoring: subscribe to the official
// status feeds of the services you depend on (from the built-in catalog or a
// custom feed URL); vendor incidents raise events through the normal pipeline
// and can mirror onto an own status-page component.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api, ApiError } from '../api';
import { SEV, relTime, fmtDateTime } from '../format';
import { Modal, StatusPill, Field, TableScroll, TableSkeleton } from '../ui';
import { RefreshCwIcon, ExternalLinkIcon, SearchIcon } from 'lucide-react';
import type { Component, VendorCatalogEntry, VendorDetail, VendorFeedType, VendorRow } from '../types';

const COLS = '1fr 130px 90px 100px 110px 60px';

const STATUS_UI: Record<string, { label: string; color: string }> = {
  operational: { label: 'operational', color: SEV.green },
  degraded: { label: 'degraded', color: SEV.medium },
  partial: { label: 'partial outage', color: SEV.high },
  major: { label: 'major outage', color: SEV.critical },
  maintenance: { label: 'maintenance', color: SEV.low },
  unknown: { label: 'unknown', color: SEV.info },
};
const IMPACT_COLOR: Record<string, string> = {
  critical: SEV.critical, major: SEV.critical, partial: SEV.high,
  degraded: SEV.medium, minor: SEV.medium, maintenance: SEV.low, unknown: SEV.info,
};
const FEED_TYPES: VendorFeedType[] = ['statuspage', 'instatus', 'slack', 'gcp', 'aws', 'heroku', 'statusio', 'rss'];

export default function Vendors() {
  const app = useApp();
  const canEdit = app.user ? app.user.role !== 'analyst' : false;
  const [rows, setRows] = useState<VendorRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = () => api.get<VendorRow[]>('/api/vendors').then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const pollNow = async (v: VendorRow) => {
    setBusyId(v.id);
    try { await api.post(`/api/vendors/${v.id}/poll`); load(); } finally { setBusyId(null); }
  };
  const remove = async (v: VendorRow) => {
    if (!confirm(`Stop monitoring "${v.name}"?`)) return;
    await api.del(`/api/vendors/${v.id}`);
    load();
  };

  const disrupted = rows?.filter((r) => ['degraded', 'partial', 'major'].includes(r.status)).length ?? 0;

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Vendors</h1>
        {canEdit && <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add vendor</button>}
      </div>

      {rows && rows.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--text2)' }}>
          <span className="mono">{rows.length} monitored</span>
          <span>·</span>
          <span className="mono" style={{ color: disrupted ? SEV.high : SEV.green }}>
            {disrupted ? `${disrupted} with issues` : 'all operational'}</span>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <TableScroll minWidth={720}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Vendor</span><span>Status</span><span>Incidents</span><span>Feed</span><span>Checked</span><span />
        </div>
        {!rows ? (
          <TableSkeleton cols={COLS} rows={6} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
            no vendors monitored yet — hit “+ Add vendor” to watch the status pages of the services you depend on</div>
        ) : rows.map((v) => {
          const ui = STATUS_UI[v.status] || STATUS_UI.unknown;
          return (
            <div key={v.id} className="tbl-row" style={{ gridTemplateColumns: COLS, cursor: 'pointer' }}
              onClick={() => setDetailId(v.id)}>
              <span style={{ minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)',
                  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.name}{!v.enabled && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> (paused)</span>}
                </span>
                {v.lastError && <span className="mono" style={{ fontSize: 10, color: SEV.critical,
                  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={v.lastError}>feed error: {v.lastError}</span>}
              </span>
              <span><StatusPill text={ui.label} color={ui.color} /></span>
              <span className="mono" style={{ fontSize: 11,
                color: v.activeIncidents ? SEV.high : 'var(--text3)' }}>
                {v.activeIncidents ? `${v.activeIncidents} active` : '—'}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>{v.feedType}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>
                {v.lastCheckedAt ? relTime(v.lastCheckedAt) : 'never'}</span>
              <span className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                <button title="Check now" onClick={() => pollNow(v)} disabled={busyId === v.id}
                  style={{ color: busyId === v.id ? 'var(--text3)' : 'var(--text2)' }}>
                  <RefreshCwIcon size={13} /></button>
                {canEdit && <button title="Stop monitoring" style={{ color: SEV.critical, fontSize: 13 }}
                  onClick={() => remove(v)}>×</button>}
              </span>
            </div>
          );
        })}
        </TableScroll>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text3)' }}>
        Vendor incidents raise <span className="mono">vendor_incident</span> events — create an alert rule with
        that trigger to get notified. Recoveries raise <span className="mono">vendor_recovered</span>.
      </div>

      {adding && <AddVendorModal existing={rows ?? []} onClose={() => setAdding(false)} onAdded={load} />}
      {detailId !== null && <VendorDetailModal id={detailId} canEdit={canEdit}
        onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}

// ---------------------------------------------------------------- add modal

function AddVendorModal({ existing, onClose, onAdded }:
  { existing: VendorRow[]; onClose: () => void; onAdded: () => void }) {
  const [catalog, setCatalog] = useState<VendorCatalogEntry[]>([]);
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [err, setErr] = useState('');
  // custom form — paste a status-page URL, detection fills the rest
  const [detectUrl, setDetectUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [feedType, setFeedType] = useState<VendorFeedType>('statuspage');
  const [feedUrl, setFeedUrl] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get<VendorCatalogEntry[]>('/api/vendors/catalog').then(setCatalog).catch(() => {}); }, []);
  const added = useMemo(() => new Set(existing.map((v) => v.slug)), [existing]);
  const ql = q.toLowerCase();
  const hits = catalog.filter((c) => !q || c.name.toLowerCase().includes(ql)
    || c.slug.includes(ql) || c.domains.some((d) => d.includes(ql)));

  const addFromCatalog = async (c: VendorCatalogEntry) => {
    setErr(''); setBusySlug(c.slug);
    try { await api.post('/api/vendors', { slug: c.slug }); onAdded(); }
    catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); }
    finally { setBusySlug(null); }
  };

  const detect = async () => {
    setErr(''); setPreview(null); setDetecting(true);
    try {
      const d = await api.post<{ feedType: VendorFeedType; feedUrl: string; pageUrl: string;
        name: string | null; preview: { status: string; components: number; incidents: number } }>(
        '/api/vendors/detect', { url: detectUrl });
      setFeedType(d.feedType); setFeedUrl(d.feedUrl); setPageUrl(d.pageUrl);
      if (d.name && !name.trim()) setName(d.name);
      setPreview(`detected ${d.feedType} — status ${d.preview.status}, `
        + `${d.preview.components} components, ${d.preview.incidents} active incidents`);
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'detection failed'); }
    finally { setDetecting(false); }
  };

  const addCustom = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await api.post('/api/vendors', { name, feedType, feedUrl, pageUrl: pageUrl || undefined });
      onAdded(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Add vendor" onClose={onClose} width={480}>
      <div className="row" style={{ gap: 0, marginBottom: 12, borderBottom: '1px solid var(--bg3)' }}>
        {([['catalog', 'Catalog'], ['custom', 'Custom feed']] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => { setCustom(key === 'custom'); setErr(''); }}
            style={{ padding: '6px 12px', fontSize: 11, fontWeight: 600,
              color: custom === (key === 'custom') ? 'var(--text0)' : 'var(--text2)',
              borderBottom: custom === (key === 'custom') ? '2px solid #388bfd' : '2px solid transparent' }}>
            {label}
          </button>
        ))}
      </div>
      {!custom ? (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10, background: 'var(--bg2)',
            border: '1px solid var(--bg3)', borderRadius: 6, padding: '6px 10px' }}>
            <SearchIcon size={13} style={{ color: 'var(--text3)', flexShrink: 0 }} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${catalog.length || ''} vendors — GitHub, AWS, Cloudflare, Stripe…`}
              style={{ border: 'none', background: 'transparent', padding: 0, flex: 1 }} />
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {hits.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)',
              fontSize: 11 }}>no match — add it via the “Custom feed” tab</div>}
            {hits.map((c) => (
              <div key={c.slug} className="row" style={{ gap: 10, padding: '7px 10px',
                background: 'var(--bg2)', borderRadius: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)', display: 'block' }}>
                    {c.name}</span>
                  <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>
                    {c.feedType} · {c.domains[0]}</span>
                </span>
                {added.has(c.slug)
                  ? <span className="mono" style={{ fontSize: 10, color: SEV.green }}>monitored</span>
                  : <button className="btn btn-sm" disabled={busySlug !== null}
                      onClick={() => addFromCatalog(c)}>
                      {busySlug === c.slug ? '…' : '+ Add'}</button>}
              </div>
            ))}
          </div>
          {err && <div style={{ color: SEV.critical, fontSize: 11, marginTop: 8 }}>{err}</div>}
        </>
      ) : (
        <form onSubmit={addCustom}>
          <Field label="Status page URL — we detect the feed automatically">
            <div className="row" style={{ gap: 6 }}>
              <input autoFocus value={detectUrl} onChange={(e) => setDetectUrl(e.target.value)}
                placeholder="https://status.example.com" style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" onClick={detect}
                disabled={detecting || !detectUrl.trim()}>{detecting ? '…' : 'Detect'}</button>
            </div>
          </Field>
          {preview && <div className="mono" style={{ fontSize: 10, color: SEV.green, marginBottom: 10 }}>
            ✓ {preview}</div>}
          <Field label="Name">
            <input required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Acme SaaS" />
          </Field>
          <Field label="Feed type">
            <select value={feedType} onChange={(e) => setFeedType(e.target.value as VendorFeedType)}>
              {FEED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Feed URL (https)">
            <input required value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)}
              placeholder="https://status.example.com/api/v2/summary.json" />
          </Field>
          <Field label="Status page URL (optional)">
            <input value={pageUrl} onChange={(e) => setPageUrl(e.target.value)}
              placeholder="https://status.example.com" />
          </Field>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
            Detection covers Statuspage, Instatus, incident.io, status.io, Heroku, Google dashboards
            and RSS/Atom. If it fails, pick the feed type manually.
          </div>
          {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
            disabled={busy || !name.trim() || !feedUrl.trim()}>{busy ? '…' : 'Start monitoring'}</button>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- detail modal

function VendorDetailModal({ id, canEdit, onClose, onChanged }:
  { id: number; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<VendorDetail | null>(null);
  const [components, setComponents] = useState<Component[]>([]);

  const load = () => api.get<VendorDetail>(`/api/vendors/${id}`).then(setDetail).catch(onClose);
  useEffect(() => {
    load();
    api.get<Component[]>('/api/admin/components').then(setComponents).catch(() => {});
  }, [id]);

  if (!detail) return null;
  const ui = STATUS_UI[detail.status] || STATUS_UI.unknown;
  const broken = detail.components.filter((c) => c.status !== 'operational');
  const okCount = detail.components.length - broken.length;

  const patch = async (body: object) => {
    await api.patch(`/api/vendors/${id}`, body);
    load(); onChanged();
  };

  return (
    <Modal title={detail.name} onClose={onClose} width={520}>
      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <StatusPill text={ui.label} color={ui.color} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>
          checked {detail.lastCheckedAt ? relTime(detail.lastCheckedAt) : 'never'} · every {detail.intervalS}s</span>
        {detail.pageUrl && (
          <a href={detail.pageUrl} target="_blank" rel="noreferrer" className="row"
            style={{ gap: 4, fontSize: 10, color: SEV.low }}>
            status page <ExternalLinkIcon size={11} /></a>
        )}
      </div>
      {detail.lastError && (
        <div className="mono" style={{ fontSize: 11, color: SEV.critical, marginBottom: 10 }}>
          feed error: {detail.lastError}</div>
      )}

      {canEdit && (
        <div className="row" style={{ gap: 10, marginBottom: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Field label="Mirror onto own status-page component">
              <select value={detail.componentId ?? ''} onChange={(e) =>
                patch({ componentId: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">— not mirrored —</option>
                {components.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Poll interval (seconds)">
              <input type="number" min={60} max={3600} defaultValue={detail.intervalS}
                onBlur={(e) => { const v = Number(e.target.value); if (v !== detail.intervalS) patch({ intervalS: v }); }} />
            </Field>
          </div>
          <label className="row" style={{ gap: 6, fontSize: 11, color: 'var(--text2)', paddingBottom: 12 }}>
            <input type="checkbox" checked={detail.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })} /> enabled
          </label>
        </div>
      )}

      {detail.components.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="micro" style={{ fontSize: 9, marginBottom: 6 }}>VENDOR COMPONENTS</div>
          {broken.slice(0, 20).map((c) => (
            <div key={c.name} className="row" style={{ padding: '3px 0', gap: 8 }}>
              <span className="sev-dot" style={{ background: (STATUS_UI[c.status] || STATUS_UI.unknown).color }} />
              <span style={{ fontSize: 11, color: 'var(--text1)', flex: 1 }}>{c.name}</span>
              <span className="mono" style={{ fontSize: 10,
                color: (STATUS_UI[c.status] || STATUS_UI.unknown).color }}>{c.status}</span>
            </div>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text3)', paddingTop: 4 }}>
            {broken.length === 0 ? `all ${detail.components.length} components operational`
              : `${okCount} more components operational`}
          </div>
        </div>
      )}

      <div className="micro" style={{ fontSize: 9, marginBottom: 6 }}>INCIDENT HISTORY</div>
      {detail.incidents.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>no incidents recorded since monitoring started</div>
      )}
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {detail.incidents.map((i) => (
          <div key={i.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--bg3)' }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="sev-dot" style={{ background: i.resolvedAt ? 'var(--text3)'
                : IMPACT_COLOR[i.impact || 'unknown'] || SEV.info, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: i.resolvedAt ? 'var(--text2)' : 'var(--text0)', flex: 1 }}>
                {i.url ? <a href={i.url} target="_blank" rel="noreferrer"
                  style={{ color: 'inherit' }}>{i.title}</a> : i.title}
              </span>
            </div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', paddingLeft: 16 }}>
              {i.impact || 'unknown'} · {i.startedAt ? fmtDateTime(i.startedAt) : '—'}
              {i.resolvedAt ? ` → resolved ${relTime(i.resolvedAt)}` : ' · ongoing'}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
