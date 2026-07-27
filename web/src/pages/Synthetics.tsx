// Synthetics — Checks tab (dense table: HeatBar, agent grid, filter cards,
// check flyout) + Sensor Agents tab (fleet cards, traceroute, self-hosted
// deploy with one-time probe key). See docs/SENSOR-AGENTS.md for the concept.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV } from '../format';
import {
  LineChart, Spark, GlowDot, StatusPill, Toggle, Modal, Field, TableScroll,
  PageHeader, TableSkeleton, CardsSkeleton,
  HeatBar, StatusBadge, StatusGrid, Honeycomb, TipHost, TipBody, CELL_COLOR,
} from '../ui';
import type { CellState, GridCell, HeatBucket } from '../ui';
import type {
  SynthLocation, SynthCheck, SynthResult, SynthSeriesPoint, SynthHistory, SynthHistoryEntry,
  CloudCredential, CatalogEntry, ProviderCatalog,
} from '../types';

const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };
const CHECK_TYPES: SynthCheck['type'][] = ['http', 'icmp', 'dns', 'tcp', 'traceroute'];
const PLACEHOLDER: Record<SynthCheck['type'], string> = {
  http: 'https://example.com/health',
  icmp: 'host.example.com',
  dns: 'example.com @ 8.8.8.8',
  tcp: 'host.example.com:443',
  traceroute: 'host.example.com',
};

// HeatBar ranges — decided bucket counts: 30min/1h/6h/12h → 30 buckets,
// 24h → 32×45min, 7d → 28×6h (shift boundaries), 30d → 30×1 day.
const RANGES = [
  { k: '30m', minutes: 30, buckets: 30 }, { k: '1h', minutes: 60, buckets: 30 },
  { k: '6h', minutes: 360, buckets: 30 }, { k: '12h', minutes: 720, buckets: 30 },
  { k: '24h', minutes: 1440, buckets: 32 }, { k: '7d', minutes: 10080, buckets: 28 },
  { k: '30d', minutes: 43200, buckets: 30 },
] as const;
type RangeKey = typeof RANGES[number]['k'];

type CheckStatus = 'passing' | 'degraded' | 'failing' | 'paused';
const STATUS_COLOR: Record<CheckStatus, string> = {
  passing: SEV.green, degraded: SEV.medium, failing: SEV.critical, paused: SEV.info,
};

type Hop = { hop: number; ip: string; ms: number | null };

const CHECK_GRID = 'minmax(150px,1.3fr) 92px 118px minmax(180px,2fr) 56px 108px 92px 76px';

const fmtT = (ts: number, withDate: boolean) => {
  const d = new Date(ts);
  return withDate
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function Synthetics() {
  const app = useApp();
  const [tab, setTab] = useState<'checks' | 'agents'>('checks');
  const [locations, setLocations] = useState<SynthLocation[] | null>(null);
  const [checks, setChecks] = useState<SynthCheck[] | null>(null);
  const [results, setResults] = useState<SynthResult[]>([]);
  const [history, setHistory] = useState<Map<number, SynthHistoryEntry>>(new Map());
  const [histMeta, setHistMeta] = useState<{ since: number; bucketMs: number } | null>(null);
  const [range, setRange] = useState<RangeKey>('24h');
  const [filter, setFilter] = useState<'all' | CheckStatus>('all');
  const [flyId, setFlyId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [showAddCheck, setShowAddCheck] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [selLoc, setSelLoc] = useState<number | null>(null);
  const [route, setRoute] = useState<Hop[]>([]);
  const [tick, setTick] = useState(0);

  const canWrite = (ROLE_RANK[app.user?.role ?? ''] ?? 0) >= ROLE_RANK.lead;
  const rangeDef = RANGES.find((r) => r.k === range)!;

  const loadChecks = () => api.get<SynthCheck[]>('/api/synthetics/checks').then(setChecks).catch(() => setChecks([]));
  const loadLocations = () => api.get<SynthLocation[]>('/api/synthetics/locations')
    .then((l) => { setLocations(l); setSelLoc((cur) => cur ?? (l.length ? l[0].id : null)); })
    .catch(() => setLocations([]));
  const loadResults = () => api.get<{ latest: SynthResult[] }>('/api/synthetics/results')
    .then((r) => setResults(r.latest || [])).catch(() => { /* keep prior */ });
  const loadHistory = () => api.get<SynthHistory>(
    `/api/synthetics/history?minutes=${rangeDef.minutes}&buckets=${rangeDef.buckets}`)
    .then((h) => {
      setHistory(new Map(h.checks.map((c) => [c.checkId, c])));
      setHistMeta({ since: h.since, bucketMs: h.bucketMs });
    }).catch(() => { /* keep prior */ });

  useEffect(() => { loadLocations(); loadChecks(); loadResults(); }, []);
  useEffect(() => { loadHistory(); }, [range]);
  useEffect(() => {
    const iv = setInterval(() => { loadResults(); loadHistory(); setTick((t) => t + 1); }, 30000);
    return () => clearInterval(iv);
  }, [range]);

  // traceroute for the agents tab
  useEffect(() => {
    if (tab !== 'agents' || selLoc == null) { setRoute([]); return; }
    api.get<any>(`/api/synthetics/results/route?locationId=${selLoc}`)
      .then((d) => setRoute(d?.hops ?? d?.meta?.hops ?? []))
      .catch(() => setRoute([]));
  }, [tab, selLoc, tick]);

  const runChecks = async () => {
    setRunning(true);
    try { await api.post('/api/synthetics/run'); await loadResults(); await loadHistory(); }
    finally { setRunning(false); }
  };
  const toggleCheck = async (c: SynthCheck) => {
    await api.patch(`/api/synthetics/checks/${c.id}`, { enabled: !c.enabled });
    loadChecks();
  };
  const removeCheck = async (c: SynthCheck) => {
    if (!window.confirm(`Delete ${c.type} check “${c.target}”?`)) return;
    await api.del(`/api/synthetics/checks/${c.id}`);
    if (flyId === c.id) setFlyId(null);
    loadChecks(); loadResults();
  };

  const locById = useMemo(() => new Map((locations ?? []).map((l) => [l.id, l])), [locations]);
  const latestFor = (checkId: number) => results.filter((r) => r.checkId === checkId);

  const statusOf = (c: SynthCheck): CheckStatus => {
    if (!c.enabled) return 'paused';
    const rs = latestFor(c.id);
    if (!rs.length) return c.passing ? 'passing' : 'failing';
    const bad = rs.filter((r) => !r.ok).length;
    if (bad === 0) return 'passing';
    return bad === rs.length ? 'failing' : 'degraded';
  };
  const badgeState = (st: CheckStatus): CellState =>
    st === 'paused' ? 'na' : st === 'passing' ? 'ok' : st === 'degraded' ? 'warn' : 'bad';

  const agentCells = (c: SynthCheck, onPick?: (locId: number) => void): GridCell[] =>
    latestFor(c.id)
      .sort((a, b) => a.locationId - b.locationId)
      .map((r) => {
        const loc = locById.get(r.locationId);
        const state: CellState = r.ok ? 'ok' : 'bad';
        return {
          state,
          onClick: onPick ? () => onPick(r.locationId) : undefined,
          tip: <TipBody color={CELL_COLOR[state]}
            title={loc ? `${loc.city} ${loc.cc}` : `location ${r.locationId}`}
            sub={`${loc?.kind === 'local' ? 'built-in' : 'sensor agent'} · last run ${Math.max(0, Math.round((Date.now() - r.ts) / 1000))}s ago`}
            value={r.ok
              ? (r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : 'ok')
              : <span style={{ color: SEV.critical }}>{r.meta?.error || 'failed'}</span>} />,
        };
      });

  const heatBuckets = (c: SynthCheck): HeatBucket[] => {
    const h = history.get(c.id);
    return Array.from({ length: rangeDef.buckets }, (_, i) => {
      const b = h?.buckets[i] ?? { s: 'na' as CellState, ms: null };
      if (!histMeta) return { s: b.s, ms: b.ms };
      const start = histMeta.since + i * histMeta.bucketMs;
      const daily = histMeta.bucketMs >= 20 * 3600000;
      const label = daily ? fmtT(start, true) : `${fmtT(start, false)}–${fmtT(start + histMeta.bucketMs, false)}`;
      return {
        s: b.s, ms: b.ms,
        tip: <TipBody color={CELL_COLOR[b.s]} title={label}
          sub={b.s === 'na' ? 'no data' : b.s === 'ok' ? 'all runs ok' : b.s === 'warn' ? 'some runs failed' : 'all runs failed'}
          value={b.ms != null ? `avg ${b.ms} ms` : undefined} />,
      };
    });
  };

  const counts = useMemo(() => {
    const c = { all: 0, passing: 0, degraded: 0, failing: 0, paused: 0 };
    for (const ch of checks ?? []) { c.all += 1; c[statusOf(ch)] += 1; }
    return c;
  }, [checks, results]);

  const visible = (checks ?? []).filter((c) => filter === 'all' || statusOf(c) === filter);
  const flyCheck = checks?.find((c) => c.id === flyId) ?? null;

  return (
    <div className="page">
      <TipHost />
      {/* header: title, tabs, range, actions */}
      <PageHeader title="Synthetics">
          <span className="row" style={{ gap: 2 }}>
            {(['checks', 'agents'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600,
                  color: tab === t ? 'var(--text0)' : 'var(--text2)',
                  borderBottom: `2px solid ${tab === t ? SEV.low : 'transparent'}` }}>
                {t === 'checks' ? 'Checks' : 'Sensor Agents'}
                <span className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 5 }}>
                  {t === 'checks' ? (checks?.length ?? '') : (locations?.length ?? '')}
                </span>
              </button>
            ))}
          </span>
        <div className="row row-wrap" style={{ gap: 10 }}>
          {tab === 'checks' && (
            <span className="row" style={{ gap: 4 }}>
              {RANGES.map((r) => (
                <button key={r.k} className={`chip ${range === r.k ? 'active' : ''}`}
                  onClick={() => setRange(r.k)}>{r.k}</button>
              ))}
            </span>
          )}
          {canWrite && (
            <button className="btn" onClick={runChecks} disabled={running}>
              {running ? 'running…' : 'Run checks now'}
            </button>
          )}
          {canWrite && tab === 'checks' && (
            <button className="btn btn-primary" onClick={() => setShowAddCheck(true)}>+ New check</button>
          )}
          {canWrite && tab === 'agents' && (
            <button className="btn btn-primary" onClick={() => setShowAddAgent(true)}>+ New Sensor Agent</button>
          )}
        </div>
      </PageHeader>

      {tab === 'checks' && (
        <>
          {/* filter cards */}
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {([['all', 'All checks', 'var(--text0)'], ['passing', 'Passing', SEV.green],
              ['degraded', 'Degraded', SEV.medium], ['failing', 'Failing', SEV.critical],
              ['paused', 'Paused', SEV.info]] as const).map(([key, label, color]) => (
              <button key={key} onClick={() => setFilter(key as typeof filter)}
                style={{ flex: 1, minWidth: 110, textAlign: 'left', background: 'var(--bg2)',
                  border: `1px solid ${filter === key ? SEV.low : 'var(--bg3)'}`,
                  boxShadow: filter === key ? '0 0 0 1px rgba(56,139,253,0.35)' : undefined,
                  borderRadius: 8, padding: '10px 14px' }}>
                <span className="micro" style={{ fontSize: 9 }}>{label}</span>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color, marginTop: 2 }}>
                  {counts[key as keyof typeof counts]}
                </div>
              </button>
            ))}
          </div>

          {/* checks table */}
          <div className="card" style={{ padding: 0 }}>
            <TableScroll minWidth={960}>
              <div className="tbl-head" style={{ gridTemplateColumns: CHECK_GRID }}>
                <span>Target</span><span>Check</span><span>Agents</span>
                <span>Uptime · {range}</span><span>%</span><span>Latency</span>
                <span>Status</span><span style={{ textAlign: 'right' }}>Actions</span>
              </div>
              {checks === null && <TableSkeleton cols={CHECK_GRID} rows={6} />}
              {checks && visible.length === 0 && (
                <div style={{ padding: 20, color: 'var(--text3)', fontSize: 11 }}>
                  {checks.length === 0 ? 'No checks configured yet.' : 'No checks match this filter.'}
                </div>
              )}
              {visible.map((c) => {
                const st = statusOf(c);
                const h = history.get(c.id);
                const spark = (h?.buckets ?? []).map((b) => b.ms).filter((v): v is number => v != null);
                const last = latestFor(c.id).find((r) => r.latencyMs != null);
                return (
                  <div key={c.id} className="tbl-row"
                    onClick={() => setFlyId(c.id)}
                    style={{ gridTemplateColumns: CHECK_GRID, cursor: 'pointer',
                      background: st === 'failing' ? 'rgba(248,81,73,0.04)' : undefined }}>
                    <span className="mono" style={{ color: 'var(--text0)', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.target}</span>
                    <span><StatusBadge label={c.type} state={badgeState(st)} /></span>
                    <span onClick={(e) => e.stopPropagation()}>
                      {latestFor(c.id).length
                        ? <Honeycomb cells={agentCells(c)} size={9} gap={1.5} />
                        : <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>—</span>}
                    </span>
                    <HeatBar buckets={heatBuckets(c)} />
                    <span className="mono" style={{ fontSize: 11,
                      color: st === 'failing' ? SEV.critical : 'var(--text1)' }}>
                      {h?.uptimePct != null ? h.uptimePct : '—'}
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      {spark.length >= 2 && <Spark data={spark} w={46} h={16} color={SEV.cyan} />}
                      <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>
                        {last?.latencyMs != null
                          ? <>{Math.round(last.latencyMs)}<span style={{ color: 'var(--text3)', fontSize: 9 }}>ms</span></>
                          : '—'}
                      </span>
                    </span>
                    <StatusPill text={st} color={STATUS_COLOR[st]} />
                    <span className="row" style={{ justifyContent: 'flex-end', gap: 8 }}
                      onClick={(e) => e.stopPropagation()}>
                      {canWrite && <Toggle on={c.enabled} onClick={() => toggleCheck(c)} />}
                      {canWrite && (
                        <button className="btn btn-sm" title="Delete" onClick={() => removeCheck(c)}
                          style={{ color: SEV.critical }}>×</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </TableScroll>
          </div>
        </>
      )}

      {tab === 'agents' && (
        <AgentsTab locations={locations} results={results} checks={checks} route={route}
          selLoc={selLoc} setSelLoc={setSelLoc} canWrite={canWrite}
          onDeleted={() => { loadLocations(); loadResults(); }} />
      )}

      {flyCheck && (
        <CheckFlyout check={flyCheck} status={statusOf(flyCheck)} range={range}
          badgeState={badgeState} heatBuckets={heatBuckets(flyCheck)}
          uptime={history.get(flyCheck.id)?.uptimePct ?? null}
          cells={(onPick) => agentCells(flyCheck, onPick)}
          latest={latestFor(flyCheck.id)} locById={locById}
          canWrite={canWrite} onToggle={() => toggleCheck(flyCheck)}
          onDelete={() => removeCheck(flyCheck)} onClose={() => setFlyId(null)} />
      )}
      {showAddCheck && <AddCheckModal locations={locations ?? []} onClose={() => setShowAddCheck(false)}
        onAdded={() => { setShowAddCheck(false); loadChecks(); }} />}
      {showAddAgent && <NewAgentWizard locations={locations ?? []} onClose={() => setShowAddAgent(false)}
        onChanged={() => { loadLocations(); loadChecks(); }} />}
    </div>
  );
}

// ------------------------------------------------------------- check flyout

function CheckFlyout({ check, status, range, badgeState, heatBuckets, uptime, cells, latest,
  locById, canWrite, onToggle, onDelete, onClose }: {
  check: SynthCheck; status: CheckStatus; range: string;
  badgeState: (st: CheckStatus) => CellState; heatBuckets: HeatBucket[]; uptime: number | null;
  cells: (onPick: (locId: number) => void) => GridCell[];
  latest: SynthResult[]; locById: Map<number, SynthLocation>;
  canWrite: boolean; onToggle: () => void; onDelete: () => void; onClose: () => void;
}) {
  const [gridMode, setGridMode] = useState<'grid' | 'hex'>('hex'); // Honeycomb is the default
  const [agentLoc, setAgentLoc] = useState<number | null>(null);
  const [series, setSeries] = useState<SynthSeriesPoint[]>([]);

  const okCount = latest.filter((r) => r.ok).length;
  const issues = latest.filter((r) => !r.ok);
  const chartLoc = agentLoc ?? latest[0]?.locationId ?? null;

  useEffect(() => {
    if (chartLoc == null) { setSeries([]); return; }
    api.get<SynthSeriesPoint[]>(
      `/api/synthetics/results/series?checkId=${check.id}&locationId=${chartLoc}&hours=24`)
      .then(setSeries).catch(() => setSeries([]));
  }, [check.id, chartLoc]);

  const seriesVals = series.filter((s) => s.latencyMs != null).map((s) => s.latencyMs as number);
  const gridCells = cells((locId) => setAgentLoc(locId));

  return (
    <>
      <div className="overlay-dim" onClick={onClose} />
      <div className="slide-over" style={{ width: 560 }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bg3)',
          position: 'sticky', top: 0, background: 'var(--bg1)', zIndex: 5 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text0)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{check.target}</span>
              <StatusBadge label={check.type} state={badgeState(status)} />
              <StatusPill text={status === 'degraded' ? `degraded · ${okCount}/${latest.length}` : status}
                color={STATUS_COLOR[status]} />
            </div>
            <button onClick={onClose} style={{ color: 'var(--text2)', fontSize: 15 }}>×</button>
          </div>
          {canWrite && (
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <span className="row" style={{ gap: 6 }}>
                <Toggle on={check.enabled} onClick={onToggle} />
                <span className="mono" style={{ fontSize: 9, color: 'var(--text2)' }}>
                  {check.enabled ? 'enabled' : 'paused'}</span>
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
              ['Agents ok', latest.length ? `${okCount}/${latest.length}` : '—',
                latest.length && okCount < latest.length ? SEV.medium : 'var(--text0)'],
              [`Uptime ${range}`, uptime != null ? `${uptime}%` : '—', 'var(--text0)'],
              ['Interval', `${check.intervalS}s`, 'var(--text0)'],
              ['Timeout', `${check.timeoutMs}ms`, 'var(--text0)'],
            ] as const).map(([label, value, color]) => (
              <span key={label}>
                <span className="micro" style={{ fontSize: 9, display: 'block' }}>{label}</span>
                <span className="mono" style={{ fontSize: 16, fontWeight: 700, color }}>{value}</span>
              </span>
            ))}
          </div>

          {/* heat bar — full flyout width */}
          <div>
            <div className="micro" style={{ fontSize: 9, marginBottom: 5 }}>Last {range}</div>
            <HeatBar buckets={heatBuckets} big />
          </div>

          {/* by agent */}
          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="micro" style={{ fontSize: 9 }}>By sensor agent ({latest.length})</span>
              <span className="row" style={{ gap: 6 }}>
                <button className={`chip ${gridMode === 'hex' ? 'active' : ''}`}
                  onClick={() => setGridMode('hex')}>Honeycomb</button>
                <button className={`chip ${gridMode === 'grid' ? 'active' : ''}`}
                  onClick={() => setGridMode('grid')}>StatusGrid</button>
              </span>
            </div>
            {latest.length === 0
              ? <div className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>no results yet</div>
              : gridMode === 'grid'
                ? <StatusGrid cells={gridCells} cell={18} gap={3} />
                : <Honeycomb cells={gridCells} size={22} gap={2} />}
            <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginTop: 8 }}>
              1 cell = 1 sensor agent · hover = details · click = latency series below
            </div>
          </div>

          {/* issues */}
          {issues.length > 0 && (
            <div>
              <div className="micro" style={{ fontSize: 9, marginBottom: 4 }}>
                Attention needed ({issues.length})</div>
              {issues.map((r) => {
                const loc = locById.get(r.locationId);
                return (
                  <div key={r.locationId} className="row"
                    style={{ gap: 8, padding: '6px 0', borderBottom: '1px solid var(--bg3)' }}>
                    <GlowDot color={SEV.critical} size={6} />
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text0)', width: 130 }}>
                      {loc ? `${loc.city} ${loc.cc}` : `location ${r.locationId}`}</span>
                    <span className="mono" style={{ fontSize: 10, color: SEV.critical }}>
                      {r.meta?.error || 'check failed'}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* latency chart for selected agent */}
          <div className="card">
            <div className="card-title">
              Latency 24h — {locById.get(chartLoc ?? -1)?.city ?? '—'}
            </div>
            <LineChart points={seriesVals} color={SEV.cyan} fmt={(v) => `${Math.round(v)}ms`} />
          </div>

          {/* config */}
          <div className="mono" style={{ fontSize: 10, color: 'var(--text2)', background: 'var(--bg3)',
            borderRadius: 6, padding: 10, lineHeight: 1.7 }}>
            type: {check.type} · target: {check.target}<br />
            interval: {check.intervalS}s · timeout: {check.timeoutMs}ms<br />
            {check.assertions && <>assertions: {JSON.stringify(check.assertions)}<br /></>}
            agents: all ({latest.length} reporting)
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------- sensor agents tab

function AgentsTab({ locations, results, checks, route, selLoc, setSelLoc, canWrite, onDeleted }: {
  locations: SynthLocation[] | null; results: SynthResult[]; checks: SynthCheck[] | null;
  route: Hop[]; selLoc: number | null; setSelLoc: (id: number) => void;
  canWrite: boolean; onDeleted: () => void;
}) {
  const icmpIds = useMemo(
    () => new Set((checks ?? []).filter((c) => c.type === 'icmp').map((c) => c.id)),
    [checks],
  );
  const locResult = (locId: number): SynthResult | undefined =>
    results.find((r) => r.locationId === locId && icmpIds.has(r.checkId))
      ?? results.find((r) => r.locationId === locId);
  const checkCount = (locId: number) =>
    new Set(results.filter((r) => r.locationId === locId).map((r) => r.checkId)).size;
  const maxHop = Math.max(...route.map((h) => h.ms ?? 0), 1);

  const removeLocation = async (l: SynthLocation) => {
    if (!window.confirm(`Remove sensor agent “${l.city}”? Its probe key stops working immediately`
      + `${l.provider ? ' and the cloud instance is destroyed' : ''}.`)) return;
    await api.del(`/api/synthetics/locations/${l.id}`);
    onDeleted();
  };
  const unbook = async (l: SynthLocation) => {
    if (!window.confirm(`Unbook managed location “${l.city}”? Checks stop running from there.`)) return;
    await api.del(`/api/synthetics/locations/${l.id}/book`);
    onDeleted();
  };

  // the agents tab shows the fleet the org actually uses: own + booked managed
  const mine = (locations ?? []).filter((l) => l.kind !== 'managed' || l.booked);

  return (
    <>
      {/* agent cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {locations === null && <CardsSkeleton count={4} w={150} h={116} />}
        {locations && mine.length === 0 && (
          <div style={{ color: 'var(--text3)', fontSize: 11 }}>No sensor agents yet.</div>
        )}
        {mine.map((loc) => {
          const res = locResult(loc.id);
          const ms = res?.latencyMs ?? null;
          const active = loc.id === selLoc;
          return (
            <div key={loc.id} onClick={() => setSelLoc(loc.id)} style={{ width: 150, cursor: 'pointer',
              background: 'var(--bg2)', borderRadius: 8, padding: 12,
              border: active ? `1px solid ${SEV.low}` : '1px solid var(--bg3)',
              boxShadow: active ? '0 0 0 1px rgba(56,139,253,0.35)' : undefined }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text0)' }}>{loc.city}</span>
                <span className="mono" style={{ fontSize: 9, color: 'var(--text2)', background: 'var(--bg3)',
                  padding: '1px 5px', borderRadius: 4 }}>{loc.cc}</span>
              </div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, margin: '8px 0 2px',
                color: ms == null ? 'var(--text3)' : ms > 150 ? SEV.medium : SEV.green }}>
                {ms == null ? '—'
                  : <>{Math.round(ms)}<span style={{ fontSize: 11, color: 'var(--text3)' }}> ms</span></>}
              </div>
              <div className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>
                {loc.kind === 'local' ? 'built-in'
                  : loc.kind === 'managed' ? 'opscat managed'
                    : loc.provider ? `${loc.provider} hosted` : 'self hosted'}
                {' · '}{checkCount(loc.id)} checks
              </div>
              <div className="row" style={{ gap: 5, marginTop: 6, justifyContent: 'space-between' }}>
                <span className="row" style={{ gap: 5 }}>
                  <GlowDot color={loc.nodeStatus === 'provisioning' ? SEV.medium
                    : loc.online ? SEV.green : 'var(--text3)'} size={7} />
                  <span className="micro" style={{ fontSize: 8 }}>
                    {loc.nodeStatus === 'provisioning' ? 'provisioning' : loc.online ? 'online' : 'offline'}</span>
                </span>
                {canWrite && loc.kind === 'customer' && (
                  <button className="btn btn-sm" style={{ color: SEV.critical }}
                    onClick={(e) => { e.stopPropagation(); removeLocation(loc); }}>×</button>
                )}
                {canWrite && loc.kind === 'managed' && loc.booked && (
                  <button className="btn btn-sm" title="Unbook"
                    onClick={(e) => { e.stopPropagation(); unbook(loc); }}>unbook</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* route card for selected agent */}
      <div className="card">
        <div className="card-title">
          Route — from {locations?.find((l) => l.id === selLoc)?.city ?? '—'}</div>
        {route.length === 0
          ? <div style={{ color: 'var(--text3)', fontSize: 11 }}>no route data yet</div>
          : route.map((h, i) => {
            const last = i === route.length - 1;
            const w = h.ms != null ? (h.ms / maxHop) * 100 : 0;
            return (
              <div key={i} className="row" style={{ gap: 10, padding: '4px 0' }}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text3)', width: 18 }}>{h.hop}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text1)', width: 120,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.ip}</span>
                <div style={{ flex: 1, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${w}%`, height: '100%', background: last ? SEV.low : SEV.info }} />
                </div>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text2)', width: 44, textAlign: 'right' }}>
                  {h.ms != null ? `${Math.round(h.ms)}ms` : '*'}</span>
              </div>
            );
          })}
      </div>

      {canWrite && <CloudCredentialsCard />}
    </>
  );
}

// Bring-your-own-cloud keys: encrypted at rest, the API only ever returns
// label + hint. Least-privilege policies are documented in docs/SENSOR-AGENTS.md.
function CloudCredentialsCard() {
  const [creds, setCreds] = useState<CloudCredential[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.get<CloudCredential[]>('/api/synthetics/cloud-credentials')
    .then(setCreds).catch(() => setCreds([]));
  useEffect(() => { load(); }, []);

  const revoke = async (c: CloudCredential) => {
    if (!window.confirm(`Revoke ${c.provider} credential “${c.label}”?`)) return;
    try { await api.del(`/api/synthetics/cloud-credentials/${c.id}`); load(); }
    catch (e) { window.alert(e instanceof Error ? e.message : 'error'); }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-title" style={{ padding: '12px 16px 0' }}>Cloud credentials
        <span className="mono" style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 400 }}>
          bring your own cloud — encrypted at rest, secrets never shown again</span>
      </div>
      {(creds ?? []).map((c) => (
        <div key={c.id} className="row" style={{ padding: '9px 16px', borderBottom: '1px solid var(--bg3)', gap: 10 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text0)', width: 44, textTransform: 'uppercase' }}>{c.provider}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>{c.label}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>{c.hint}</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" style={{ color: SEV.critical }} onClick={() => revoke(c)}>revoke</button>
        </div>
      ))}
      {creds && creds.length === 0 && (
        <div className="mono" style={{ padding: '10px 16px', fontSize: 10, color: 'var(--text3)' }}>
          no cloud keys yet — needed for AWS/GCP hosted sensor agents</div>
      )}
      <div style={{ padding: '10px 16px' }}>
        <button className="btn btn-sm" onClick={() => setAdding(true)}>+ Add credential</button>
        <span className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 8 }}>AWS · GCP</span>
      </div>
      {adding && <AddCredentialModal onClose={() => setAdding(false)}
        onAdded={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function AddCredentialModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [provider, setProvider] = useState<'aws' | 'gcp'>('aws');
  const [label, setLabel] = useState('');
  const [awsKeyId, setAwsKeyId] = useState('');
  const [awsSecret, setAwsSecret] = useState('');
  const [gcpJson, setGcpJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    let secret: unknown;
    if (provider === 'aws') secret = { accessKeyId: awsKeyId.trim(), secretAccessKey: awsSecret.trim() };
    else {
      try { secret = JSON.parse(gcpJson); }
      catch { setErr('paste the full service-account JSON'); setBusy(false); return; }
    }
    try { await api.post('/api/synthetics/cloud-credentials', { provider, label, secret }); onAdded(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="Add cloud credential" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Provider">
          <select value={provider} onChange={(e) => setProvider(e.target.value as 'aws' | 'gcp')}>
            <option value="aws">AWS</option><option value="gcp">GCP</option>
          </select>
        </Field>
        <Field label="Label">
          <input required value={label} maxLength={60} placeholder="e.g. prod-sensors"
            onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {provider === 'aws' ? (
          <>
            <Field label="Access key ID">
              <input required className="mono" value={awsKeyId} placeholder="AKIA…"
                onChange={(e) => setAwsKeyId(e.target.value)} />
            </Field>
            <Field label="Secret access key">
              <input required type="password" className="mono" value={awsSecret}
                onChange={(e) => setAwsSecret(e.target.value)} />
            </Field>
            <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 10 }}>
              Use a least-privilege IAM user: ec2 Run/Terminate/DescribeInstances + DescribeImages only.
            </div>
          </>
        ) : (
          <Field label="Service-account JSON">
            <textarea required className="mono rca" value={gcpJson} rows={5}
              placeholder='{"type":"service_account","client_email":…}'
              onChange={(e) => setGcpJson(e.target.value)} />
          </Field>
        )}
        {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Store encrypted'}</button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------- add modals

function AddCheckModal({ locations, onClose, onAdded }: {
  locations: SynthLocation[]; onClose: () => void; onAdded: () => void;
}) {
  const [type, setType] = useState<SynthCheck['type']>('http');
  const [target, setTarget] = useState('');
  const [intervalS, setIntervalS] = useState(60);
  const [timeoutMs, setTimeoutMs] = useState(5000);
  const [expectStatus, setExpectStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [jsonPath, setJsonPath] = useState('');
  const [jsonValue, setJsonValue] = useState('');
  const [allAgents, setAllAgents] = useState(true);
  const [selAgents, setSelAgents] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // agents this org can run checks from: own + booked managed
  const usable = locations.filter((l) => l.kind !== 'managed' || l.booked);
  const toggleAgent = (id: number) => setSelAgents((cur) =>
    cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const assertions = type === 'http' && (expectStatus || keyword || jsonPath) ? {
      status: expectStatus ? Number(expectStatus) : undefined,
      keyword: keyword || undefined,
      jsonPath: jsonPath || undefined,
      jsonValue: jsonPath ? jsonValue : undefined,
    } : undefined;
    try {
      await api.post('/api/synthetics/checks', { type, target, intervalS, timeoutMs, assertions,
        locationIds: allAgents ? [] : selAgents });
      onAdded();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="New check" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value as SynthCheck['type'])}>
            {CHECK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Target">
          <input required autoFocus value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder={PLACEHOLDER[type]} />
        </Field>
        <Field label="Interval (seconds)">
          <input type="number" min={5} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))} />
        </Field>
        <Field label="Timeout (ms)">
          <input type="number" min={100} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
        </Field>
        {type === 'http' && (
          <>
            <div className="micro" style={{ fontSize: 9, margin: '4px 0 6px' }}>
              ASSERTIONS (optional — leave empty for "reachable = ok")</div>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Field label="Expected status">
                  <input inputMode="numeric" value={expectStatus} placeholder="e.g. 200"
                    onChange={(e) => setExpectStatus(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 2 }}>
                <Field label="Body must contain">
                  <input value={keyword} placeholder='e.g. "status":"ok"'
                    onChange={(e) => setKeyword(e.target.value)} />
                </Field>
              </div>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Field label="JSON path">
                  <input className="mono" value={jsonPath} placeholder="$.status"
                    onChange={(e) => setJsonPath(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="equals">
                  <input className="mono" value={jsonValue} placeholder="ok"
                    onChange={(e) => setJsonValue(e.target.value)} />
                </Field>
              </div>
            </div>
          </>
        )}
        <div className="row" style={{ justifyContent: 'space-between', margin: '4px 0 6px' }}>
          <span className="micro" style={{ fontSize: 9 }}>RUN FROM THESE SENSOR AGENTS</span>
          <span className="row" style={{ gap: 6 }}>
            <span className="mono" style={{ fontSize: 9, color: 'var(--text2)' }}>all agents (incl. future)</span>
            <Toggle on={allAgents} onClick={() => setAllAgents(!allAgents)} />
          </span>
        </div>
        {!allAgents && (
          <div style={{ marginBottom: 10 }}>
            {usable.map((l) => (
              <div key={l.id} className="row" onClick={() => toggleAgent(l.id)}
                style={{ gap: 8, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 4,
                  border: `1px solid ${selAgents.includes(l.id) ? SEV.low : 'var(--border)'}`,
                  background: 'var(--bg2)' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                  border: `1.5px solid ${selAgents.includes(l.id) ? SEV.low : 'var(--border)'}`,
                  background: selAgents.includes(l.id) ? SEV.low : 'transparent' }} />
                <span className="mono" style={{ fontSize: 11, color: 'var(--text0)' }}>{l.city} {l.cc}</span>
                <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>
                  {l.kind === 'local' ? 'built-in' : l.kind === 'managed' ? 'managed'
                    : l.provider ? `${l.provider} hosted` : 'self hosted'}</span>
                <GlowDot color={l.online ? SEV.green : 'var(--text3)'} size={6} />
              </div>
            ))}
          </div>
        )}
        {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !target || (!allAgents && selAgents.length === 0)}>
          {busy ? '…' : 'Create check'}</button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------- New Sensor Agent wizard
// Step 1: pick where the agent runs — OpsCat Managed (plan quota; the list is
// empty in the Community edition), AWS/GCP hosted (needs a stored credential;
// runs on the customer's cloud bill) or self hosted (free, unlimited).
// Step 2: pick the location, clustered Region → City.
type WizProvider = 'managed' | 'aws' | 'gcp' | 'self';

function NewAgentWizard({ locations, onClose, onChanged }: {
  locations: SynthLocation[]; onClose: () => void; onChanged: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [prov, setProv] = useState<WizProvider>('self');
  const [creds, setCreds] = useState<CloudCredential[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [credId, setCredId] = useState<number | null>(null);
  const [cls, setCls] = useState<'standard' | 'browser'>('standard');
  const [city, setCity] = useState('');
  const [cc, setCc] = useState('');
  const [probeKey, setProbeKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<CloudCredential[]>('/api/synthetics/cloud-credentials').then(setCreds).catch(() => setCreds([]));
    api.get<ProviderCatalog>('/api/synthetics/provider-catalog').then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const managed = locations.filter((l) => l.kind === 'managed');
  const managedBooked = managed.filter((l) => l.booked).length;
  const credFor = (p: 'aws' | 'gcp') => creds.filter((c) => c.provider === p);

  const pick = (p: WizProvider) => {
    if ((p === 'aws' || p === 'gcp') && credFor(p).length === 0) {
      setErr(`no ${p.toUpperCase()} key stored — add one under Cloud credentials on the Sensor Agents tab`);
      return;
    }
    if (p === 'managed' && managed.length === 0) return; // CE: card is informational
    setErr(''); setProv(p); setRegion(null); setEntry(null);
    setCredId((p === 'aws' || p === 'gcp') ? credFor(p)[0].id : null);
    setStep(2);
  };

  const cityChoices: CatalogEntry[] = prov === 'managed'
    ? managed.map((l) => ({ code: String(l.id), city: l.city, cc: l.cc, region: l.region ?? 'Other' }))
    : (prov === 'aws' || prov === 'gcp') && catalog ? catalog.catalog[prov] : [];
  const regions = [...new Set(cityChoices.map((e) => e.region))];

  const create = async () => {
    setBusy(true); setErr('');
    try {
      if (prov === 'self') {
        const res = await api.post<{ id: number; probeKey: string }>(
          '/api/synthetics/locations', { city, cc });
        setProbeKey(res.probeKey); onChanged();
      } else if (prov === 'managed') {
        await api.post(`/api/synthetics/locations/${entry!.code}/book`, {});
        onChanged(); onClose();
      } else {
        await api.post('/api/synthetics/locations/provision',
          { provider: prov, region: entry!.code, credentialId: credId, instanceClass: cls });
        onChanged(); onClose();
      }
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); }
    finally { setBusy(false); }
  };

  if (probeKey) {
    return (
      <Modal title="Sensor agent created" onClose={onClose} hideClose>
        <div style={{ fontSize: 11, color: 'var(--text1)', marginBottom: 10 }}>
          Store this probe key now — it is <b>not retrievable later</b>:
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text0)', background: 'var(--bg3)',
          borderRadius: 6, padding: 10, wordBreak: 'break-all', marginBottom: 12 }}>{probeKey}</div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--text2)', background: 'var(--bg3)',
          borderRadius: 6, padding: 10, lineHeight: 1.8, marginBottom: 12 }}>
          OPSCAT_URL=&lt;this instance&gt; OPSCAT_PROBE_KEY=&lt;key&gt; \<br />
          &nbsp;&nbsp;node opscat-agent.js --probe
          <span style={{ display: 'block', color: 'var(--text3)' }}>
            # outbound HTTPS only, no inbound needed</span>
        </div>
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          onClick={onClose}>I stored the key</button>
      </Modal>
    );
  }

  const provCard = (p: WizProvider, title: string, sub: string, right?: React.ReactNode, disabled = false) => (
    <button key={p} onClick={() => pick(p)} disabled={disabled}
      style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%', textAlign: 'left',
        border: '1px solid var(--border)', borderRadius: 8, padding: '11px 13px', marginBottom: 8,
        background: 'var(--bg2)', opacity: disabled ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      <span style={{ flex: 1 }}>
        <span className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text0)' }}>{title}</span>
          {right}
        </span>
        <span style={{ display: 'block', fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>{sub}</span>
      </span>
    </button>
  );

  return (
    <Modal title="New Sensor Agent" onClose={onClose} width={480}>
      {step === 1 && (
        <>
          {provCard('managed', 'OpsCat Managed Sensor',
            'Ready in seconds — we run the fleet, you pick a location.',
            managed.length
              ? <span className="mono" style={{ fontSize: 10, color: 'var(--text0)' }}><b>{managedBooked}</b> in use</span>
              : <StatusPill text="not available in OpsCat CE" color={SEV.info} />,
            managed.length === 0)}
          {(['aws', 'gcp'] as const).map((p) => provCard(p, `${p.toUpperCase()} hosted`,
            'Provisioned into your cloud account — runs on your cloud bill. Unlimited.',
            credFor(p).length
              ? <StatusPill text="key configured" color={SEV.green} />
              : <StatusPill text="no key — add under Cloud credentials" color={SEV.critical} />))}
          {provCard('self', 'Self hosted',
            'Your own hardware — any network, private targets included. Unlimited & free.')}
          {err && <div style={{ color: SEV.critical, fontSize: 11 }}>{err}</div>}
        </>
      )}
      {step === 2 && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <button className="btn btn-sm" onClick={() => { setStep(1); setErr(''); }}>← back</button>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>
              {prov === 'self' ? 'self hosted' : prov === 'managed' ? 'OpsCat Managed' : `${prov.toUpperCase()} hosted`}
            </span>
          </div>
          {prov === 'self' ? (
            <>
              <Field label="City / label">
                <input required autoFocus value={city} maxLength={80}
                  placeholder="e.g. Munich HQ" onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Field label="Country code (ISO2)">
                <input required value={cc} maxLength={2} placeholder="DE" className="mono"
                  onChange={(e) => setCc(e.target.value.toUpperCase())} />
              </Field>
            </>
          ) : (
            <>
              <div className="micro" style={{ fontSize: 9, marginBottom: 6 }}>Region</div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {regions.map((r) => (
                  <button key={r} className={`chip ${region === r ? 'active' : ''}`}
                    onClick={() => { setRegion(r); setEntry(null); }}>{r}</button>
                ))}
              </div>
              <div className="micro" style={{ fontSize: 9, marginBottom: 6 }}>City</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                {!region && <span className="mono" style={{ fontSize: 10, color: 'var(--text3)', gridColumn: '1/-1' }}>
                  pick a region above</span>}
                {region && cityChoices.filter((e) => e.region === region).map((e) => {
                  const mLoc = prov === 'managed' ? managed.find((l) => String(l.id) === e.code) : null;
                  const taken = !!mLoc?.booked;
                  return (
                    <div key={e.code} onClick={() => !taken && setEntry(e)}
                      style={{ border: `1px solid ${entry?.code === e.code ? SEV.low : 'var(--border)'}`,
                        boxShadow: entry?.code === e.code ? '0 0 0 1px rgba(56,139,253,0.35)' : undefined,
                        borderRadius: 6, padding: '8px 11px', cursor: taken ? 'default' : 'pointer',
                        background: 'var(--bg2)', opacity: taken ? 0.55 : 1 }}
                      className="row">
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text0)' }}>{e.city}</span>
                      <span className="mono" style={{ fontSize: 9, color: 'var(--text2)', background: 'var(--bg3)',
                        padding: '1px 5px', borderRadius: 4 }}>{e.cc}</span>
                      <span className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 'auto' }}>
                        {taken ? 'booked' : mLoc?.isPremium ? 'premium' : prov === 'managed' ? '' : e.code}
                      </span>
                    </div>
                  );
                })}
              </div>
              {(prov === 'aws' || prov === 'gcp') && (
                <>
                  <Field label="Credential">
                    <select value={credId ?? ''} onChange={(e) => setCredId(Number(e.target.value))}>
                      {credFor(prov).map((c) => <option key={c.id} value={c.id}>{c.label} ({c.hint})</option>)}
                    </select>
                  </Field>
                  <Field label="Instance class">
                    <select value={cls} onChange={(e) => setCls(e.target.value as 'standard' | 'browser')}>
                      <option value="standard">standard — http · icmp · dns · tcp · traceroute</option>
                      <option value="browser">browser-capable — + browser checks later (more RAM)</option>
                    </select>
                  </Field>
                  <div className="mono" style={{ fontSize: 9, color: SEV.medium, marginBottom: 10 }}>
                    Runs in your cloud account, on your bill. OpsCat tags the instance opscat-sensor
                    and auto-reconciles orphans hourly.
                  </div>
                </>
              )}
            </>
          )}
          {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
            onClick={create}
            disabled={busy || (prov === 'self' ? (!city || cc.length !== 2) : !entry)}>
            {busy ? '…' : prov === 'self' ? 'Create & show probe key'
              : prov === 'managed' ? 'Book location' : 'Provision sensor agent'}
          </button>
        </>
      )}
    </Modal>
  );
}
