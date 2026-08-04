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
import { SEV, relTime } from '../format';
import {
  PageHeader, TableScroll, TableSkeleton, Modal, Field, GlowDot, StatusPill,
  Toggle, KpiCard, Input} from '../ui';
import { Select } from '../Select';
import type {
  BulkAddResult, ReputationAsset, ReputationDiscovery, ReputationListing,
  ReputationOverview, ReputationStatus, ReputationTier, ReputationZones,
} from '../types';

const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };

// one grid string for head, rows and skeleton — never inline it twice
const GRID = 'minmax(150px,1.4fr) minmax(140px,1.2fr) 150px minmax(150px,1.4fr) 110px 70px';
// head, rows and skeleton of the history table share this one string
const HISTORY_GRID = 'minmax(120px,1.3fr) minmax(90px,1fr) 80px 90px 100px 80px';
// same for the SPF discovery picker (checkbox · target · kind · source)
const SPF_GRID = '24px minmax(120px,1.4fr) 74px minmax(90px,1fr)';

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

// Interval as an operator reads it. Never Math.round(s/3600) — that renders a
// sub-hour interval (reachable via the API) as "0h".
const everyLabel = (s: number): string => (
  s >= 3600 && s % 3600 === 0 ? `${s / 3600}h`
    : s >= 3600 ? `${(s / 3600).toFixed(1)}h`
      : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`);

// What one blocklist did on the last run. `clean` is the only one that is an
// actual verdict — the other three all mean "we did not get an answer", which
// is the distinction the whole feature is built on.
type ZoneState = 'listed' | 'policy' | 'unreachable' | 'error' | 'clean';
const ZONE_UI: Record<ZoneState, { label: string; color: string }> = {
  listed: { label: 'listed', color: SEV.critical },
  policy: { label: 'policy', color: SEV.low },
  unreachable: { label: 'unreachable', color: SEV.medium },
  error: { label: 'error', color: SEV.medium },
  clean: { label: 'clean', color: SEV.green },
};

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
  const [zones, setZones] = useState<ReputationZones | null>(null);

  const canWrite = (ROLE_RANK[app.user?.role ?? ''] ?? 0) >= ROLE_RANK.lead;

  const load = () => {
    api.get<ReputationAsset[]>('/api/reputation/assets').then(setAssets).catch(() => setAssets([]));
    api.get<ReputationOverview>('/api/reputation/overview').then(setOverview).catch(() => { /* keep prior */ });
  };
  useEffect(() => { load(); }, []);
  // The zone catalog is static config, so it is fetched once and reused: the
  // flyout renders every list's state by diffing it against the asset's
  // findings, which needs no extra payload on the result row.
  useEffect(() => {
    api.get<ReputationZones>('/api/reputation/zones').then(setZones)
      .catch(() => { /* flyout falls back to findings-only */ });
  }, []);
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
  const setInterval_ = async (a: ReputationAsset, intervalS: number) => {
    setErr(null);
    try { await api.patch(`/api/reputation/assets/${a.id}`, { intervalS }); load(); }
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

      {sel && <AssetFlyout asset={sel} canWrite={canWrite} busy={busyId === sel.id} zones={zones}
        onToggle={() => toggle(sel)} onDelete={() => remove(sel)}
        onInterval={(v) => setInterval_(sel, v)}
        onRun={() => runNow(sel)} onClose={() => setSelId(null)} />}

      {showAdd && (
        <AddAsset zones={zones} onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); load(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- flyout

// Detail lives in the platform's standard right-side slide-over (same shape as the
// Synthetics check flyout): backdrop + sticky header carrying identity, status and
// the write actions, body below.
function AssetFlyout({ asset, canWrite, busy, zones, onToggle, onDelete, onInterval, onRun, onClose }: {
  asset: ReputationAsset; canWrite: boolean; busy: boolean; zones: ReputationZones | null;
  onToggle: () => void; onDelete: () => void; onInterval: (v: number) => void;
  onRun: () => void; onClose: () => void;
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
          position: 'sticky', top: 0, background: 'var(--bg1)', zIndex: 'var(--z-sticky)' }}>
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
              <span className="row" style={{ gap: 6 }}>
                <span className="micro text-2xs">EVERY</span>
                <Select title="Interval" value={String(asset.intervalS)} style={{ maxWidth: 92 }}
                  onChange={(v) => onInterval(Number(v))}
                  // a stored value outside the presets (set via the API) must still
                  // show, or changing anything else silently rewrites it
                  options={[
                    ...(HOURS.some((h) => h.v === asset.intervalS) ? [] : [
                      { value: String(asset.intervalS), label: everyLabel(asset.intervalS) }]),
                    ...HOURS.map((h) => ({ value: String(h.v), label: h.l })),
                  ]} />
              </span>
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
              ['Interval', everyLabel(asset.intervalS), 'var(--text0)'],
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
                    <span className="row row-wrap" style={{ gap: 8, minWidth: 0 }}>
                      <StatusPill text={l.tier} color={TIER_COLOR[l.tier]} />
                      <span className="mono text-sm text-text0">{l.name}</span>
                      {/* WHAT is listed. Without this a listed mail server reads as
                          "the domain is listed" and the fix is looked for in the
                          wrong place entirely. */}
                      {l.subject && (
                        <span className="mono text-2xs" style={{ color: SEV.medium }}>{l.subject}</span>
                      )}
                      {l.codes?.length > 0 && (
                        <span className="mono text-2xs text-text3">{l.codes.join(' ')}</span>
                      )}
                      {/* how long this has been going on — the first thing asked
                          about a listing, and the reason listings are their own
                          table rather than a field on the latest sample */}
                      <span className="mono text-2xs text-text3">listed {relTime(l.firstSeen)}</span>
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
          </div>

          {asset.mxHosts.length > 0 && (
            <div className="card">
              <div className="card-title">
                Mail servers
                <span className="mono text-2xs text-text3" style={{ marginLeft: 8 }}>
                  from this domain's MX records
                </span>
              </div>
              <div className="text-2xs text-text2" style={{ marginBottom: 8, lineHeight: 1.6 }}>
                The domain's own RHSBL verdict says nothing about these. A self-hosted
                server usually accepts <i>and</i> sends on the same address, so a listing
                there costs you delivery. Hosts on a mail platform only accept — outbound
                leaves elsewhere — so they are named, not queried.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {asset.mxHosts.map((m) => (
                  <div key={`${m.host}-${m.ip ?? m.provider}`} className="row row-wrap"
                    style={{ gap: 8, justifyContent: 'space-between' }}>
                    <span className="row row-wrap" style={{ gap: 8, minWidth: 0 }}>
                      <GlowDot color={m.provider ? 'var(--text3)'
                        : m.listed > 0 ? SEV.critical : m.covered ? SEV.green : SEV.medium}
                        size={7} />
                      <span className="mono text-2xs text-text0">{m.host}</span>
                      {m.ip && <span className="mono text-2xs text-text3">{m.ip}</span>}
                    </span>
                    <span className="mono text-2xs" style={{
                      color: m.provider ? 'var(--text3)'
                        : m.listed > 0 ? SEV.critical : m.covered ? SEV.green : SEV.medium }}>
                      {m.provider ? `delegated · ${m.provider}`
                        : m.listed > 0 ? `${m.listed} listing${m.listed === 1 ? '' : 's'}`
                          : m.covered ? 'clean' : 'incomplete'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <ZoneBreakdown asset={asset} zones={zones} />

          <ListingHistory assetId={asset.id} />

          {/* config */}
          <div className="mono text-2xs text-text2" style={{ background: 'var(--bg3)',
            borderRadius: 6, padding: 10, lineHeight: 1.7 }}>
            kind: {asset.kind || '—'} · interval: {everyLabel(asset.intervalS)}
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

// ------------------------------------------------------- listing history

// Every episode of being listed, open and closed. This exists because listings
// are their own table with first_seen/resolved_at — the previous model stored
// verdicts as samples and could answer "are we listed" but never "since when",
// "for how long", or "how often did this happen last year".
function ListingHistory({ assetId }: { assetId: number }) {
  const [rows, setRows] = useState<ReputationListing[] | null>(null);

  // null = loading, [] = loaded and empty (see CLAUDE.md § Loading States)
  useEffect(() => {
    setRows(null);
    api.get<ReputationListing[]>(`/api/reputation/assets/${assetId}/history?limit=50`)
      .then(setRows).catch(() => setRows([]));
  }, [assetId]);

  const span = (l: ReputationListing) => {
    const end = l.resolvedAt ?? l.lastSeen;
    const days = Math.max(0, Math.round((end - l.firstSeen) / 86400000));
    if (!l.resolvedAt) return `open · ${days}d so far`;
    return days >= 1 ? `${days}d` : '<1d';
  };

  return (
    <div className="card">
      <div className="card-title">
        Listing history
        {rows && rows.length > 0 && (
          <span className="mono text-2xs text-text3" style={{ marginLeft: 8 }}>
            {rows.filter((r) => !r.resolvedAt).length} open · {rows.length} total
          </span>
        )}
      </div>

      {rows !== null && rows.length === 0 && (
        <div className="mono text-2xs text-text3">
          Never listed on any blocklist we track.
        </div>
      )}

      {/* Same rule as everywhere: the skeleton goes INSIDE the scroller. This grid
          is ~560px at its minimum, so outside it the slide-over pushed the page
          sideways for as long as the history was loading. */}
      {(rows === null || rows.length > 0) && (
        <TableScroll minWidth={520}>
          <div className="tbl-head" style={{ gridTemplateColumns: HISTORY_GRID }}>
            <span>List</span><span>Subject</span><span>Tier</span><span>From</span><span>Until</span><span>For</span>
          </div>
          {rows === null && <TableSkeleton cols={HISTORY_GRID} rows={3} flush />}
          {rows?.map((l) => (
            <div key={`${l.zone}-${l.subject ?? ''}-${l.firstSeen}`} className="tbl-row"
              style={{ gridTemplateColumns: HISTORY_GRID }}>
              <span className="mono text-2xs text-text0">{l.name}</span>
              <span className="mono text-2xs text-text3">{l.subject || 'the asset'}</span>
              <span><StatusPill text={l.tier} color={TIER_COLOR[l.tier]} /></span>
              <span className="mono text-2xs text-text2">{relTime(l.firstSeen)}</span>
              <span className="mono text-2xs text-text2">
                {l.resolvedAt ? relTime(l.resolvedAt)
                  : <span style={{ color: SEV.critical }}>still listed</span>}
              </span>
              <span className="mono text-2xs text-text3">{span(l)}</span>
            </div>
          ))}
        </TableScroll>
      )}
    </div>
  );
}

// ------------------------------------------------------- per-zone breakdown

// Every list the asset was checked against, and what each one said. Derived
// entirely client-side by diffing the static catalog against the asset's
// findings — the result row carries only the exceptions, so this costs nothing
// on the wire. A list that is not an exception is genuinely clean; a list that
// is unreachable or errored is NOT, which is the point of showing them here
// rather than in a footnote.
function ZoneBreakdown({ asset, zones }: { asset: ReputationAsset; zones: ReputationZones | null }) {
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    if (!zones || !asset.kind) return null;
    const catalog = asset.kind === 'ip' ? zones.ip : zones.domain;
    const listed = new Map(asset.listings.map((l) => [l.name, l]));
    const policy = new Set(asset.policy);
    const unreachable = new Set(asset.unavailable);
    const errored = new Set(asset.errored);
    const rank: Record<ZoneState, number> = {
      listed: 0, unreachable: 1, error: 2, policy: 3, clean: 4,
    };
    return catalog.map((z) => {
      const hit = listed.get(z.name);
      const state: ZoneState = hit ? 'listed'
        : unreachable.has(z.name) ? 'unreachable'
          : errored.has(z.name) ? 'error'
            : policy.has(z.name) ? 'policy' : 'clean';
      return { ...z, state, codes: hit?.codes ?? [], url: hit?.url ?? null };
    }).sort((a, b) => rank[a.state] - rank[b.state]
      || a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));
  }, [asset, zones]);

  if (!rows) return null;
  const counts = rows.reduce((m, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; },
    {} as Record<ZoneState, number>);
  // Anything that is not a plain "clean" is worth seeing without a click.
  const notable = rows.filter((r) => r.state !== 'clean');
  const shown = open ? rows : notable;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="card-title" style={{ marginBottom: 0 }}>
          Lists checked
          <span className="mono text-2xs text-text3" style={{ marginLeft: 8 }}>
            {rows.length} {asset.kind === 'ip' ? 'IP blocklists' : 'domain blocklists'}
          </span>
        </div>
        <button className="mono text-2xs" style={{ color: 'var(--text2)' }}
          onClick={() => setOpen(!open)}>
          {open ? 'hide clean' : `show all (${counts.clean || 0} clean)`}
        </button>
      </div>

      <div className="row row-wrap" style={{ gap: 6, margin: '8px 0 10px' }}>
        {(['listed', 'unreachable', 'error', 'policy', 'clean'] as ZoneState[])
          .filter((k) => counts[k])
          .map((k) => (
            <StatusPill key={k} text={`${counts[k]} ${ZONE_UI[k].label}`} color={ZONE_UI[k].color} />
          ))}
      </div>

      {shown.length === 0 && (
        <div className="mono text-2xs text-text3">Nothing to flag — every list answered clean.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shown.map((z) => (
          <div key={z.zone} className="row" style={{ gap: 8, justifyContent: 'space-between',
            padding: '5px 0', borderTop: '1px solid var(--bg3)' }}>
            <span className="row" style={{ gap: 8, minWidth: 0 }}>
              <GlowDot color={ZONE_UI[z.state].color} size={6} />
              <span className="mono text-sm text-text0" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.name}</span>
              <span className="mono text-2xs text-text3">{z.zone}</span>
            </span>
            <span className="row" style={{ gap: 8, flexShrink: 0 }}>
              {z.codes.length > 0 && (
                <span className="mono text-2xs text-text3">{z.codes.join(' ')}</span>
              )}
              <StatusPill text={z.tier} color={TIER_COLOR[z.tier]} />
              <StatusPill text={ZONE_UI[z.state].label} color={ZONE_UI[z.state].color} />
              {z.url && z.state === 'listed' && (
                <a className="mono text-2xs" href={z.url} target="_blank"
                  rel="noreferrer noopener">delist ↗</a>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add

function AddAsset({ zones, onClose, onAdded }: {
  zones: ReputationZones | null; onClose: () => void; onAdded: () => void;
}) {
  // SPF first: it is the right way in. The addresses that matter are the ones in
  // the record, and the one worth finding is always the one nobody remembers.
  const [mode, setMode] = useState<'spf' | 'single'>('spf');
  const [intervalS, setIntervalS] = useState(21600);

  return (
    <Modal title="Add asset" onClose={onClose}>
      <div className="row row-wrap" style={{ gap: 6, marginBottom: 14 }}>
        {([['spf', 'From SPF record'], ['single', 'One target']] as const).map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            className={`btn ${mode === m ? 'btn-primary' : ''}`}>{label}</button>
        ))}
      </div>
      <Field label="Interval">
        <Select title="Interval" value={String(intervalS)} onChange={(v) => setIntervalS(Number(v))}
          options={HOURS.map((h) => ({ value: String(h.v), label: h.l }))} />
      </Field>
      {mode === 'spf'
        ? <FromSpf intervalS={intervalS} onAdded={onAdded} />
        : <SingleTarget zones={zones} intervalS={intervalS} onAdded={onAdded} />}
    </Modal>
  );
}

function SingleTarget({ zones, intervalS, onAdded }: {
  zones: ReputationZones | null; intervalS: number; onAdded: () => void;
}) {
  const nIp = zones ? zones.ip.length : 31;
  const nDomain = zones ? zones.domain.length : 8;
  const [target, setTarget] = useState('');
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
    <form onSubmit={submit}>
      <Field label="Target">
        <Input required autoFocus value={target} onChange={(e) => setTarget(e.target.value)}
          placeholder="198.51.100.25 or example.com" />
      </Field>
      <div className="text-2xs text-text2" style={{ margin: '-4px 0 12px', lineHeight: 1.7 }}>
        <b className="text-text1">One IP or one domain per asset</b> — no <span className="mono">https://</span>,
        no path.
        <div style={{ marginTop: 6 }}>
          An <b className="text-text1">IP</b> is checked against {nIp} blocklists, a{' '}
          <b className="text-text1">domain</b> against {nDomain} — different lists, so
          they are separate assets. Adding a domain does <b className="text-text1">not</b> check
          the IPs it sends from; add those too, or let{' '}
          <b className="text-text1">From SPF record</b> find them.
        </div>
      </div>
      {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
        disabled={busy || !target.trim()}>
        {busy ? '…' : 'Add asset'}</button>
    </form>
  );
}

// Read the SPF record and offer what it actually authorises. Two things fall out
// of the same walk: the senders to monitor, and whether the record blows the
// RFC 7208 budget of 10 DNS lookups — a PermError is as fatal for delivery as a
// blocklist entry and far less visible, so it is surfaced here rather than buried.
function FromSpf({ intervalS, onAdded }: { intervalS: number; onAdded: () => void }) {
  const [domain, setDomain] = useState('');
  const [result, setResult] = useState<ReputationDiscovery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const scan = async (e: React.FormEvent) => {
    e.preventDefault();
    setScanning(true); setErr(''); setResult(null);
    try {
      const r = await api.post<ReputationDiscovery>('/api/reputation/discover', { domain: domain.trim() });
      setResult(r);
      // Pre-select everything not already watched — the common case is "take all".
      setPicked(new Set(r.candidates.filter((c) => !c.alreadyMonitored).map((c) => c.target)));
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'lookup failed'); }
    finally { setScanning(false); }
  };

  const add = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post<BulkAddResult>('/api/reputation/assets/bulk',
        { targets: [...picked], intervalS });
      if (!r.added.length && r.skipped.length) {
        setErr(`nothing added — ${r.skipped[0].reason}`);
        setBusy(false); return;
      }
      onAdded();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  const toggle = (t: string) => setPicked((p) => {
    const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n;
  });

  const fresh = result?.candidates.filter((c) => !c.alreadyMonitored) ?? [];

  return (
    <div>
      <form onSubmit={scan}>
        <Field label="Sending domain">
          <Input required autoFocus value={domain} onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com" />
        </Field>
        <div className="text-2xs text-text2" style={{ margin: '-4px 0 12px', lineHeight: 1.7 }}>
          Reads the domain's <span className="mono">SPF</span> record and lists the senders it
          authorises directly. Third-party <span className="mono">include:</span> pools
          (Microsoft&nbsp;365, Pardot, Mailgun) are shown but not offered — those are the
          provider's addresses, and they watch them.
        </div>
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={scanning || !domain.trim()}>
          {scanning ? 'Reading SPF…' : 'Read SPF record'}
        </button>
      </form>

      {/* skeleton-exempt: SPF_GRID is ~330px at its minimum and fits a phone. */}
      {scanning && <div style={{ marginTop: 14 }}><TableSkeleton cols={SPF_GRID} rows={4} /></div>}

      {result && !scanning && (
        <div style={{ marginTop: 16 }}>
          {result.lookups.permerror && (
            <div className="text-2xs" style={{ background: 'var(--bg3)', borderLeft: `3px solid ${SEV.critical}`,
              borderRadius: 4, padding: '8px 10px', marginBottom: 10, lineHeight: 1.6 }}>
              <b style={{ color: SEV.critical }}>SPF is failing on its own.</b> The record needs{' '}
              <span className="mono">{result.lookups.used}</span> DNS lookups, above the limit of{' '}
              <span className="mono">{result.lookups.limit}</span> — receivers treat that as a
              PermError, so SPF does not pass no matter which addresses you monitor. Flatten an{' '}
              <span className="mono">include:</span> into its literal ranges to get back under.
            </div>
          )}
          {!result.lookups.permerror && result.spf && (
            <div className="text-2xs text-text3" style={{ marginBottom: 10 }}>
              {result.lookups.used}/{result.lookups.limit} SPF DNS lookups used.
            </div>
          )}

          {result.warnings.filter((w) => !w.includes('DNS lookups')).map((w) => (
            <div key={w} className="text-2xs" style={{ color: SEV.medium, marginBottom: 6 }}>{w}</div>
          ))}

          {fresh.length === 0 && (
            <div className="text-2xs text-text2" style={{ marginBottom: 10 }}>
              Nothing new — every sender this record authorises is already monitored.
            </div>
          )}

          {fresh.length > 0 && (
            <>
              <div className="row row-wrap" style={{ gap: 8, justifyContent: 'space-between',
                alignItems: 'baseline', marginBottom: 6 }}>
                <span className="text-sm text-text1">{fresh.length} sender(s) found</span>
                <button type="button" className="mono text-2xs" style={{ color: 'var(--text2)' }}
                  onClick={() => setPicked(picked.size === fresh.length
                    ? new Set() : new Set(fresh.map((c) => c.target)))}>
                  {picked.size === fresh.length ? 'select none' : 'select all'}
                </button>
              </div>
              <TableScroll minWidth={420}>
                <div className="tbl-head" style={{ gridTemplateColumns: SPF_GRID }}>
                  <span /><span>Target</span><span>Kind</span><span>From</span>
                </div>
                {fresh.map((c) => (
                  <label key={c.target} className="tbl-row" style={{ gridTemplateColumns: SPF_GRID,
                    cursor: 'pointer', alignItems: 'center' }}>
                    <input type="checkbox" checked={picked.has(c.target)}
                      onChange={() => toggle(c.target)} style={{ width: 14, height: 14 }} />
                    <span className="mono text-2xs text-text0">{c.target}</span>
                    <span><StatusPill text={c.kind} color={SEV.info} /></span>
                    <span className="mono text-2xs text-text3">{c.source}</span>
                  </label>
                ))}
              </TableScroll>
            </>
          )}

          {result.candidates.some((c) => c.alreadyMonitored) && (
            <div className="text-2xs text-text3" style={{ marginTop: 8 }}>
              Already monitored:{' '}
              {result.candidates.filter((c) => c.alreadyMonitored).map((c) => c.target).join(', ')}
            </div>
          )}

          {result.pools.length > 0 && (
            <div className="text-2xs text-text3" style={{ marginTop: 10, lineHeight: 1.7 }}>
              <b className="text-text2">Delegated to third parties</b> (not monitorable per
              address — shared provider pools):
              <div className="mono" style={{ marginTop: 3 }}>
                {result.pools.map((p) => `${p.include} (${p.lookups} lookup${p.lookups === 1 ? '' : 's'})`).join(' · ')}
              </div>
            </div>
          )}

          {result.ranges.length > 0 && (
            <div className="text-2xs text-text3" style={{ marginTop: 8, lineHeight: 1.7 }}>
              <b className="text-text2">Ranges</b> — blocklists answer about single addresses, so
              these cannot be watched as assets:
              <div className="mono" style={{ marginTop: 3 }}>
                {result.ranges.map((r) => r.range).join(' · ')}
              </div>
            </div>
          )}

          {err && <div className="text-sm" style={{ color: SEV.critical, margin: '10px 0 0' }}>{err}</div>}

          {fresh.length > 0 && (
            <button type="button" className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
              disabled={busy || picked.size === 0} onClick={add}>
              {busy ? '…' : `Add ${picked.size} asset${picked.size === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}

      {err && !result && <div className="text-sm" style={{ color: SEV.critical, marginTop: 10 }}>{err}</div>}
    </div>
  );
}
