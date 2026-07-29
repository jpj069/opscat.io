// Reputation — blocklist monitoring for the org's sending assets. Its own page
// because it answers a different question from Synthetics: not "is it up" but
// "is it deliverable". A listed mail server is perfectly reachable.
//
// Three display rules carry the whole feature, see docs/ARCHITECTURE.md:
//   - informational listings (range/ASN-wide) are shown but never alert
//   - a list that could not be queried is UNKNOWN, never "clean"
//   - a finding carries its delisting link, so the fix is one click away
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV } from '../format';
import {
  PageHeader, TableScroll, TableSkeleton, Modal, Field, GlowDot, StatusPill,
  Toggle, KpiCard,
} from '../ui';
import type {
  ReputationAsset, ReputationOverview, ReputationStatus, ReputationTier,
} from '../types';

const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };

// one grid string for head, rows and skeleton — never inline it twice
const GRID = 'minmax(150px,1.4fr) minmax(140px,1.2fr) 150px minmax(150px,1.4fr) 110px 70px';

const STATUS_UI: Record<ReputationStatus, { label: string; color: string }> = {
  listed: { label: 'listed', color: SEV.critical },
  informational: { label: 'informational', color: SEV.low },
  clean: { label: 'clean', color: SEV.green },
  unknown: { label: 'unknown', color: SEV.medium },
  pending: { label: 'pending', color: SEV.info },
};
const TIER_COLOR: Record<ReputationTier, string> = {
  critical: SEV.critical, standard: SEV.high, informational: SEV.low,
};

const HOURS = [
  { v: 3600, l: '1 h' }, { v: 10800, l: '3 h' }, { v: 21600, l: '6 h' },
  { v: 43200, l: '12 h' }, { v: 86400, l: '24 h' },
];

const ago = (ts: number | null): string => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export default function Reputation() {
  const app = useApp();
  const [assets, setAssets] = useState<ReputationAsset[] | null>(null);
  const [overview, setOverview] = useState<ReputationOverview | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canWrite = (ROLE_RANK[app.user?.role ?? ''] ?? 0) >= ROLE_RANK.lead;

  const load = () => {
    api.get<ReputationAsset[]>('/api/reputation/assets').then(setAssets).catch(() => setAssets([]));
    api.get<ReputationOverview>('/api/reputation/overview').then(setOverview).catch(() => { /* keep prior */ });
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const iv = setInterval(load, 60000); // blocklist state moves over hours
    return () => clearInterval(iv);
  }, []);

  const sel = useMemo(
    () => (assets ?? []).find((a) => a.id === selId) ?? null, [assets, selId]);

  // Coverage is reported per kind because the denominators differ (31 IP lists
  // vs 8 domain lists). "19/31" on IPs and "8/8" on domains is the honest
  // reading; one merged number made a domain-only org look catastrophic.
  const coverage = useMemo(() => {
    if (!overview) return { value: null as string | null, sub: null as string | null, color: SEV.info };
    const parts = (['ip', 'domain'] as const)
      .map((k) => ({ k, c: overview.coverage[k] }))
      .filter((p) => p.c.queried != null);
    if (!parts.length) return { value: '—', sub: 'nothing checked yet', color: SEV.info };
    const missing = parts.reduce((m, p) => m + p.c.unavailable, 0);
    return {
      value: parts.map((p) => `${p.c.queried}/${p.c.total}`).join(' · '),
      sub: missing > 0
        ? `${missing} list${missing === 1 ? '' : 's'} unreachable`
        : `${parts.map((p) => p.k).join(' + ')} lists answering`,
      color: missing > 0 ? SEV.medium : SEV.info,
    };
  }, [overview]);

  // Every mutation surfaces its failure. A "check now" that silently does
  // nothing on a 502 from the resolver is the worst possible outcome on a page
  // whose entire job is telling you whether something is wrong.
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : 'request failed');

  const runNow = async (a: ReputationAsset) => {
    setBusyId(a.id); setErr(null);
    try { await api.post(`/api/reputation/assets/${a.id}/run`); load(); }
    catch (e) { fail(e); }
    finally { setBusyId(null); }
  };
  const toggle = async (a: ReputationAsset) => {
    setErr(null);
    try { await api.patch(`/api/reputation/assets/${a.id}`, { enabled: !a.enabled }); load(); }
    catch (e) { fail(e); }
  };
  const remove = async (a: ReputationAsset) => {
    if (!window.confirm(`Stop monitoring “${a.target}”?`)) return;
    setErr(null);
    try {
      await api.del(`/api/reputation/assets/${a.id}`);
      if (selId === a.id) setSelId(null);
      load();
    } catch (e) { fail(e); }
  };

  return (
    <div className="page">
      <PageHeader title="Reputation">
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add asset</button>
        )}
      </PageHeader>

      <div className="row row-wrap" style={{ gap: 10, marginBottom: 14 }}>
        <KpiCard label="MONITORED" value={overview ? String(overview.total) : null} color={SEV.cyan}
          sub={overview ? `${overview.ip} ip · ${overview.domain} domain` : null} />
        <KpiCard label="LISTED" value={overview ? String(overview.listed) : null}
          color={overview && overview.listed > 0 ? SEV.critical : SEV.green}
          sub={overview && overview.listed > 0 ? 'alerting' : 'nothing actionable'} />
        <KpiCard label="INFORMATIONAL" value={overview ? String(overview.informational) : null}
          color={SEV.low} sub="recorded, not alerted" />
        <KpiCard label="LIST COVERAGE" value={coverage.value} color={coverage.color}
          sub={coverage.sub} />
      </div>

      {err && (
        <div className="text-sm" style={{ color: SEV.critical, marginBottom: 10 }}>{err}</div>
      )}

      <div className="card">
        <div className="card-title">
          Monitored assets
          <span className="mono text-2xs text-text3" style={{ marginLeft: 8 }}>
            blocklist state, refreshed on each asset’s own interval
          </span>
        </div>

        <TableScroll minWidth={760}>
          <div className="tbl-head" style={{ gridTemplateColumns: GRID }}>
            <span>Target</span><span>Role (rDNS)</span><span>Status</span>
            <span>Lists</span><span>Checked</span><span />
          </div>

          {assets === null && <TableSkeleton cols={GRID} rows={5} />}

          {assets !== null && assets.length === 0 && (
            <div className="text-sm text-text2" style={{ padding: '18px 12px' }}>
              No assets monitored yet. Add the IPs your mail actually leaves from — they are in
              your SPF record — plus the sending domain itself.
            </div>
          )}

          {(assets ?? []).map((a) => {
            const ui = STATUS_UI[a.status];
            const actionable = a.listings.filter((l) => l.tier !== 'informational');
            const shown = actionable.length ? actionable : a.listings;
            return (
              <div key={a.id} className="tbl-row" style={{ gridTemplateColumns: GRID, cursor: 'pointer' }}
                onClick={() => setSelId(selId === a.id ? null : a.id)}>
                <span className="mono text-sm text-text0">{a.target}</span>
                <span className="mono text-2xs text-text3">{a.rdns || (a.kind === 'domain' ? 'domain' : '—')}</span>
                <span className="row" style={{ gap: 6 }}>
                  <GlowDot color={a.enabled ? ui.color : 'var(--text3)'} size={7} />
                  <StatusPill text={a.enabled ? ui.label : 'paused'}
                    color={a.enabled ? ui.color : 'var(--text3)'} />
                </span>
                <span className="mono text-2xs text-text2">
                  {shown.length ? shown.map((l) => l.name).join(', ') : '—'}
                </span>
                <span className="mono text-2xs text-text3">{ago(a.lastCheckedAt)}</span>
                <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}
                  onClick={(e) => e.stopPropagation()}>
                  {canWrite && (
                    <button title="Check now" onClick={() => runNow(a)} disabled={busyId === a.id}
                      style={{ color: busyId === a.id ? 'var(--text3)' : 'var(--text2)' }}>
                      <RefreshCwIcon size={13} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </TableScroll>
      </div>

      {sel && <AssetFlyout asset={sel} canWrite={canWrite} busy={busyId === sel.id}
        onToggle={() => toggle(sel)} onDelete={() => remove(sel)}
        onRun={() => runNow(sel)} onClose={() => setSelId(null)} />}

      {showAdd && (
        <AddAsset onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); load(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- flyout

// Detail lives in the platform's standard right-side slide-over (same shape as the
// Synthetics check flyout): backdrop + sticky header carrying identity, status and
// the write actions, body below.
function AssetFlyout({ asset, canWrite, busy, onToggle, onDelete, onRun, onClose }: {
  asset: ReputationAsset; canWrite: boolean; busy: boolean;
  onToggle: () => void; onDelete: () => void; onRun: () => void; onClose: () => void;
}) {
  const ui = STATUS_UI[asset.status];
  const actionable = asset.listings.filter((l) => l.tier !== 'informational');
  const info = asset.listings.filter((l) => l.tier === 'informational');

  // Close on Escape — every other slide-over in the app is dismissible that way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="overlay-dim" onClick={onClose} />
      <div className="slide-over" style={{ width: 560 }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bg3)',
          position: 'sticky', top: 0, background: 'var(--bg1)', zIndex: 5 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <span className="mono text-md font-bold text-text0" style={{
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.target}</span>
              <StatusPill text={asset.kind || 'asset'} color={SEV.info} />
              <StatusPill text={asset.enabled ? ui.label : 'paused'}
                color={asset.enabled ? ui.color : 'var(--text3)'} />
            </div>
            <button className="text-text2" onClick={onClose} style={{ fontSize: 'var(--t-xl)' }}>×</button>
          </div>
          {asset.rdns && (
            <div className="mono text-2xs text-text3" style={{ marginTop: 4 }}>{asset.rdns}</div>
          )}
          {canWrite && (
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <span className="row" style={{ gap: 6 }}>
                <Toggle on={asset.enabled} onClick={onToggle} />
                <span className="mono text-2xs text-text2">
                  {asset.enabled ? 'enabled' : 'paused'}</span>
              </span>
              <button className="btn btn-sm" onClick={onRun} disabled={busy}>
                {busy ? 'checking…' : 'Check now'}</button>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={onDelete} style={{ color: SEV.critical }}>Delete</button>
            </div>
          )}
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* stats */}
          <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
            {([
              ['Lists queried', asset.zonesQueried != null ? String(asset.zonesQueried) : '—',
                'var(--text0)'],
              ['Listed on', String(actionable.length),
                actionable.length ? SEV.critical : 'var(--text0)'],
              ['Unreachable', String(asset.unavailable.length),
                asset.unavailable.length ? SEV.medium : 'var(--text0)'],
              ['Interval', `${Math.round(asset.intervalS / 3600)}h`, 'var(--text0)'],
            ] as [string, string, string][]).map(([k, v, c]) => (
              <div key={k}>
                <div className="micro text-2xs">{k}</div>
                <div className="mono text-md" style={{ color: c, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* findings */}
          <div className="card">
            <div className="card-title">Blocklist status</div>

            {asset.error && (
              <div className="text-sm" style={{ color: SEV.critical }}>{asset.error}</div>
            )}

            {!asset.error && asset.listings.length === 0 && asset.lastCheckedAt && (
              <div className="mono text-sm" style={{ color: SEV.green }}>Not listed</div>
            )}

            {!asset.error && !asset.lastCheckedAt && (
              <div className="mono text-sm text-text2">Not checked yet</div>
            )}

            {actionable.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {actionable.map((l) => (
                  <div key={l.zone} className="row" style={{ gap: 8, justifyContent: 'space-between',
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '8px 10px' }}>
                    <span className="row" style={{ gap: 8, minWidth: 0 }}>
                      <StatusPill text={l.tier} color={TIER_COLOR[l.tier]} />
                      <span className="mono text-sm text-text0">{l.name}</span>
                      {l.codes?.length > 0 && (
                        <span className="mono text-2xs text-text3">{l.codes.join(' ')}</span>
                      )}
                    </span>
                    {l.url && (
                      <a className="mono text-2xs" href={l.url} target="_blank"
                        rel="noreferrer noopener">delist ↗</a>
                    )}
                  </div>
                ))}
              </div>
            )}

            {info.length > 0 && (
              <div className="mono text-2xs text-text2" style={{ marginTop: 10, lineHeight: 1.6 }}>
                Informational only (range- or ASN-wide lists, never alerted):{' '}
                {info.map((l) => l.name).join(', ')}
              </div>
            )}

            {asset.policy.length > 0 && (
              <div className="mono text-2xs text-text2" style={{ marginTop: 8, lineHeight: 1.6 }}>
                Policy listings (the range is flagged as “should not send mail directly”, not
                as abusive): {asset.policy.join(', ')}
              </div>
            )}

            {asset.unavailable.length > 0 && (
              <div className="mono text-2xs" style={{ marginTop: 8, lineHeight: 1.6, color: SEV.medium }}>
                Not reachable, so not checked — these are unknown, not clean:{' '}
                {asset.unavailable.join(', ')}
              </div>
            )}
          </div>

          {/* config */}
          <div className="mono text-2xs text-text2" style={{ background: 'var(--bg3)',
            borderRadius: 6, padding: 10, lineHeight: 1.7 }}>
            kind: {asset.kind || '—'} · interval: {Math.round(asset.intervalS / 3600)}h
            {asset.rdns && <> · rdns: {asset.rdns}</>}<br />
            last checked: {ago(asset.lastCheckedAt)}
            {asset.lastDurationMs != null && <> · took {Math.round(asset.lastDurationMs)}ms</>}<br />
            runs on the OpsCat server — a blocklist answer does not vary by vantage point
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- add

function AddAsset({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [target, setTarget] = useState('');
  const [intervalS, setIntervalS] = useState(21600);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post('/api/reputation/assets', { target: target.trim(), intervalS });
      onAdded();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="Add asset" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Target">
          <input required autoFocus value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder="198.51.100.25 or example.com" />
        </Field>
        <div className="micro text-2xs text-text2" style={{ margin: '-4px 0 10px', lineHeight: 1.6 }}>
          An IP address or a domain — no scheme, no path. The target is checked verbatim: a
          domain is not resolved first, otherwise you would be checking the website instead of
          the mail sender.
        </div>
        <Field label="Interval">
          <select value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))}>
            {HOURS.map((h) => <option key={h.v} value={h.v}>{h.l}</option>)}
          </select>
        </Field>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !target.trim()}>
          {busy ? '…' : 'Add asset'}</button>
      </form>
    </Modal>
  );
}
