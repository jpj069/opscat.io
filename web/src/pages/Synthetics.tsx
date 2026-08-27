// Synthetics — Checks tab (dense table: HeatBar, agent grid, filter cards,
// check flyout) + Sensor Agents tab (fleet cards, traceroute, self-hosted
// deploy with one-time probe key). See docs/SENSOR-AGENTS.md for the concept.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useTab, useQueryState, useOverlayParam } from '../state';
import { api } from '../api';
import { SEV } from '../format';
import { AddTile, Card, Button,
  LineChart, Spark, GlowDot, StatusPill, Toggle, Modal, Field, TableScroll,
  PageHeader, TableSkeleton, CardsSkeleton, BarsSkeleton,
  HeatBar, StatusBadge, StatusGrid, Honeycomb, TipHost, TipBody, CELL_COLOR, Tabs, KpiTabs, Chip, Flyout,
  Segmented, Input, HostInput, Textarea, COL, Busy, Skeleton} from '../ui';
import type { CellState, GridCell, HeatBucket } from '../ui';
import { Select } from '../Select';
import type {
  SynthLocation, SynthCheck, SynthResult, SynthSeriesPoint, SynthHistory, SynthHistoryEntry,
  CloudCredential, CatalogEntry, ProviderCatalog,
} from '../types';
import {
  ArrowLeftIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';

const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };
const CHECK_TYPES: SynthCheck['type'][] = ['http', 'icmp', 'dns', 'tcp', 'traceroute'];
const PLACEHOLDER: Record<SynthCheck['type'], string> = {
  http: 'https://example.com/health',
  icmp: 'host.example.com',
  dns: 'example.com @ 8.8.8.8',
  tcp: 'host.example.com:443',
  traceroute: 'host.example.com',
};

/* The fleet an org actually uses: everything it owns, plus the managed
 * locations it has BOOKED. One predicate, three readers — the tab count read
 * `locations.length` while the tab body and the check form both filtered, so
 * the tab said "Sensor Agents 3" over two cards for as long as any managed
 * location in the catalog sat unbooked. Same shape as `canReturnTo`: a rule
 * written twice is a rule that disagrees with itself. */
const usableLocations = (locs: SynthLocation[] | null) =>
  (locs ?? []).filter((l) => l.kind !== 'managed' || l.booked);

// HeatBar ranges — decided bucket counts: 30min/1h/6h/12h → 30 buckets,
// 24h → 32×45min, 7d → 28×6h (shift boundaries), 30d → 30×1 day.
const RANGES = [
  { k: '30m', minutes: 30, buckets: 30 }, { k: '1h', minutes: 60, buckets: 30 },
  { k: '6h', minutes: 360, buckets: 30 }, { k: '12h', minutes: 720, buckets: 30 },
  { k: '24h', minutes: 1440, buckets: 32 }, { k: '7d', minutes: 10080, buckets: 28 },
  { k: '30d', minutes: 43200, buckets: 30 },
] as const;
type RangeKey = typeof RANGES[number]['k'];
// Module scope so the reference is stable across renders — useQueryState memoises on it.
const SYN_KEYS = ['status'] as const;
const CHECK_FILTERS = ['all', 'passing', 'degraded', 'failing', 'paused'] as const;
const CHECK_CARDS = [
  ['all', 'All checks', 'var(--text0)'], ['passing', 'Passing', SEV.green],
  ['degraded', 'Degraded', SEV.medium], ['failing', 'Failing', SEV.critical],
  ['paused', 'Paused', SEV.info],
] as const;

type CheckStatus = 'passing' | 'degraded' | 'failing' | 'paused';
const STATUS_COLOR: Record<CheckStatus, string> = {
  passing: SEV.green, degraded: SEV.medium, failing: SEV.critical, paused: SEV.info,
};

type Hop = { hop: number; ip: string; ms: number | null };

// Target | Check | Agents | (uptime bar) | % | Latency | Status | Actions
const CHECK_GRID = [COL.textWide, COL.label, COL.label, COL.text, COL.num, COL.age, COL.status, COL.actions].join(' ');

const fmtT = (ts: number, withDate: boolean) => {
  const d = new Date(ts);
  return withDate
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function Synthetics() {
  const app = useApp();
  const [tab, setTab] = useTab(['checks', 'agents'] as const);
  const [locations, setLocations] = useState<SynthLocation[] | null>(null);
  const [checks, setChecks] = useState<SynthCheck[] | null>(null);
  const [results, setResults] = useState<SynthResult[]>([]);
  const [history, setHistory] = useState<Map<number, SynthHistoryEntry>>(new Map());
  const [histMeta, setHistMeta] = useState<{ since: number; bucketMs: number } | null>(null);
  const [range, setRange] = useState<RangeKey>('24h');
  // The status filter refines the Checks tab; the path's tab segment is already
  // taken by checks/agents, so it is a query parameter — `/app/synthetics/checks
  // ?status=failing`. Held in useState it could not be sent to the colleague who
  // asked which checks are red, which is the only question this filter answers.
  const [q, setQ] = useQueryState(SYN_KEYS);
  const rawStatus = q.status ?? 'all';
  const filter = (CHECK_FILTERS as readonly string[]).includes(rawStatus)
    ? (rawStatus as 'all' | CheckStatus) : 'all';
  const setFilter = (f: 'all' | CheckStatus) => setQ({ status: f === 'all' ? null : f });
  const [flyId, setFlyId] = useOverlayParam('check');
  const [running, setRunning] = useState(false);
  const [showAddCheck, setShowAddCheck] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [selLoc, setSelLoc] = useState<number | null>(null);
  const [route, setRoute] = useState<Hop[] | null>(null);
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
    // null = still loading, [] = loaded and empty — the route card shows a skeleton
    // for the first and "no route data yet" for the second.
    if (tab !== 'agents' || selLoc == null) { setRoute(null); return; }
    setRoute(null);
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

  // null while `checks` is null: "Failing 0" is the best news a NOC screen can carry
  // and it was being printed before anything had been fetched.
  const counts = useMemo(() => {
    if (!checks) return null;
    const c = { all: 0, passing: 0, degraded: 0, failing: 0, paused: 0 };
    for (const ch of checks) { c.all += 1; c[statusOf(ch)] += 1; }
    return c;
  }, [checks, results]);

  const visible = (checks ?? []).filter((c) => filter === 'all' || statusOf(c) === filter);
  const flyCheck = checks?.find((c) => c.id === flyId) ?? null;

  return (
    <div className="page">
      <TipHost />
      {/* Title + actions, then the tab bar UNDER it — the same three-part shape every
          other page has. The tab bar used to live inside PageHeader's action slot,
          which made this one header 44.5px against everyone else's 32px, so the page
          content started 12px lower here than anywhere else in the app. */}
      <PageHeader title="Synthetics">
        <div className="row row-wrap" style={{ gap: 10 }}>
          {tab === 'checks' && (
            /* The exact case Segmented was written for — the component's own note
               names 24h/7d/30d — and it was still being hand-drawn here. */
            <Segmented value={range} onChange={setRange} label="History range"
              options={RANGES.map((r) => [r.k, r.k] as const)} />
          )}
          {canWrite && (
            <Button onClick={runChecks} disabled={running}>
              {running ? 'running…' : 'Run checks now'}
            </Button>
          )}
          {canWrite && tab === 'checks' && (
            <Button variant="primary" onClick={() => setShowAddCheck(true)}><PlusIcon size={13} /> New check</Button>
          )}
          {canWrite && tab === 'agents' && (
            <Button variant="primary" onClick={() => setShowAddAgent(true)}><PlusIcon size={13} /> New Sensor Agent</Button>
          )}
        </div>
      </PageHeader>

      {/* `?? ''` grew the label when the number landed, so the whole bar shifted and
          "Sensor Agents" moved out from under a thumb already travelling towards it.
          Count reserves the box first and shimmers until the number exists. */}
      <Tabs value={tab} onChange={setTab} tabs={[
        ['checks', 'Checks', checks?.length ?? null],
        ['agents', 'Sensor Agents', locations ? usableLocations(locations).length : null]] as const} />

      {tab === 'checks' && (
        <>
          {/* This was six inline styles per card reproducing .card plus a selection
              ring — i.e. KpiCard and Tabs, drawn by hand. KpiTabs is the two of them,
              so the null placeholder comes from KpiCard rather than a second copy. */}
          <KpiTabs value={filter} onChange={setFilter} items={CHECK_CARDS.map(([id, label, color]) => ({
            id, label, color, count: counts ? counts[id] : null }))} />

          {/* checks table */}
          <Card style={{ padding: 0 }}>
            <TableScroll cols={CHECK_GRID} stickyFirst minWidth={960}>
              <div className="tbl-head">
                <span>Target</span><span>Check</span><span>Agents</span>
                <span>Uptime · {range}</span><span>%</span><span>Latency</span>
                <span>Status</span><span style={{ textAlign: 'right' }}>Actions</span>
              </div>
              {checks === null && <TableSkeleton rows={6} />}
              {checks && visible.length === 0 && (
                <div className="text-text3 text-sm" style={{ padding: 20}}>
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
                    style={{ cursor: 'pointer',
                      background: st === 'failing' ? 'rgba(248,81,73,0.04)' : undefined }}>
                    <span className="mono text-text0" style={{ overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.target}</span>
                    <span><StatusBadge label={c.type} state={badgeState(st)} /></span>
                    <span onClick={(e) => e.stopPropagation()}>
                      {latestFor(c.id).length
                        ? <Honeycomb cells={agentCells(c)} size={9} gap={1.5} />
                        : <span className="mono text-xs text-text3">—</span>}
                    </span>
                    <HeatBar buckets={heatBuckets(c)} />
                    <span className="mono text-sm" style={{
                      color: st === 'failing' ? SEV.critical : 'var(--text1)' }}>
                      {h?.uptimePct != null ? h.uptimePct : '—'}
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      {spark.length >= 2 && <Spark data={spark} w={46} h={16} color={SEV.cyan} />}
                      <span className="mono text-sm text-text1">
                        {last?.latencyMs != null
                          ? <>{Math.round(last.latencyMs)}<span className="text-text3 text-2xs">ms</span></>
                          : '—'}
                      </span>
                    </span>
                    <StatusPill text={st} color={STATUS_COLOR[st]} />
                    <span className="row" style={{ justifyContent: 'flex-end', gap: 8 }}
                      onClick={(e) => e.stopPropagation()}>
                      {canWrite && <Toggle on={c.enabled} onClick={() => toggleCheck(c)} />}
                      {canWrite && (
                        <Button size="sm" variant="danger" title="Delete" aria-label="Delete check"
 onClick={() => removeCheck(c)}><XIcon size={13} /></Button>
                      )}
                    </span>
                  </div>
                );
              })}
            </TableScroll>
          </Card>
        </>
      )}

      {tab === 'agents' && (
        <AgentsTab locations={locations} results={results} checks={checks} route={route}
          selLoc={selLoc} setSelLoc={setSelLoc} canWrite={canWrite}
          onDeleted={() => { loadLocations(); loadResults(); }}
          onAdd={() => setShowAddAgent(true)} />
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
    <Flyout title={check.target} onClose={onClose}
      badges={<>
        <StatusBadge label={check.type} state={badgeState(status)} />
        <StatusPill text={status === 'degraded' ? `degraded · ${okCount}/${latest.length}` : status}
          color={STATUS_COLOR[status]} />
      </>}
      actions={canWrite ? (
        <>
          <span className="row" style={{ gap: 6 }}>
            <Toggle on={check.enabled} onClick={onToggle} />
            <span className="mono text-2xs text-text2">
              {check.enabled ? 'enabled' : 'paused'}</span>
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="danger" onClick={onDelete} >Delete</Button>
        </>
      ) : undefined}>
      <>
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
                <span className="micro text-2xs" style={{ display: 'block' }}>{label}</span>
                <span className="mono text-xl font-bold" style={{ color }}>{value}</span>
              </span>
            ))}
          </div>

          {/* heat bar — full flyout width */}
          <div>
            <div className="micro text-2xs" style={{ marginBottom: 5 }}>Last {range}</div>
            <HeatBar buckets={heatBuckets} big />
          </div>

          {/* by agent */}
          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="micro text-2xs">By sensor agent ({latest.length})</span>
              <Segmented value={gridMode} onChange={setGridMode} label="Agent grid style"
                options={[['hex', 'Honeycomb'], ['grid', 'StatusGrid']] as const} />
            </div>
            {latest.length === 0
              ? <div className="mono text-xs text-text3">no results yet</div>
              : gridMode === 'grid'
                ? <StatusGrid cells={gridCells} cell={18} gap={3} />
                : <Honeycomb cells={gridCells} size={22} gap={2} />}
            <div className="mono text-2xs text-text3" style={{ marginTop: 8 }}>
              1 cell = 1 sensor agent · hover = details · click = latency series below
            </div>
          </div>

          {/* issues */}
          {issues.length > 0 && (
            <div>
              <div className="micro text-2xs" style={{ marginBottom: 4 }}>
                Attention needed ({issues.length})</div>
              {issues.map((r) => {
                const loc = locById.get(r.locationId);
                return (
                  <div key={r.locationId} className="row"
                    style={{ gap: 8, padding: '6px 0', borderBottom: '1px solid var(--bg3)' }}>
                    <GlowDot color={SEV.critical} size={6} />
                    <span className="mono text-sm text-text0" style={{ width: 130 }}>
                      {loc ? `${loc.city} ${loc.cc}` : `location ${r.locationId}`}</span>
                    <span className="mono text-xs" style={{ color: SEV.critical }}>
                      {r.meta?.error || 'check failed'}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* latency chart for selected agent */}
          <Card>
            <div className="card-title">
              Latency 24h — {locById.get(chartLoc ?? -1)?.city ?? '—'}
            </div>
            <LineChart points={seriesVals} color={SEV.cyan} fmt={(v) => `${Math.round(v)}ms`} />
          </Card>

          {/* config */}
          <div className="mono text-xs text-text2" style={{ background: 'var(--bg3)',
            borderRadius: 6, padding: 10, lineHeight: 1.7 }}>
            type: {check.type} · target: {check.target}<br />
            interval: {check.intervalS}s · timeout: {check.timeoutMs}ms<br />
            {check.assertions && <>assertions: {JSON.stringify(check.assertions)}<br /></>}
            agents: all ({latest.length} reporting)
          </div>
      </>
    </Flyout>
  );
}

/**
 * User-Agent presets for HTTP checks.
 *
 * The default identifies the monitor, and that is the right default: a probe
 * that says what it is can be allow-listed at a WAF, recognised in an access log
 * and kept out of analytics. The browser strings exist because a check pointed
 * at a site behind bot protection is refused for exactly that reason — and a red
 * check that means "the WAF blocked our monitor" is a signal nobody can act on.
 *
 * Said plainly in the form rather than hidden here: a browser UA gets you past a
 * User-Agent rule and nothing else. JA3/TLS fingerprinting and JS challenges see
 * a Node client either way.
 */
const UA_PRESETS: [value: string, label: string][] = [
  ['', 'OpsCat (default — identifies the monitor)'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Chrome on Windows'],
  ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    'Chrome on Android'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Safari on iPhone'],
  ['curl/8.5.0', 'curl'],
  ['__custom__', 'Custom…'],
];

// ---------------------------------------------------------- sensor agents tab

function AgentsTab({ locations, results, checks, route, selLoc, setSelLoc, canWrite, onDeleted, onAdd }: {
  locations: SynthLocation[] | null; results: SynthResult[]; checks: SynthCheck[] | null;
  route: Hop[] | null; selLoc: number | null; setSelLoc: (id: number) => void;
  canWrite: boolean; onDeleted: () => void; onAdd: () => void;
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
  const maxHop = Math.max(...(route ?? []).map((h) => h.ms ?? 0), 1);

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

  const mine = usableLocations(locations);

  return (
    <>
      {/* agent cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {locations === null && <CardsSkeleton count={4} w={150} h={116} />}
        {mine.map((loc) => {
          const res = locResult(loc.id);
          const ms = res?.latencyMs ?? null;
          const active = loc.id === selLoc;
          const n = checkCount(loc.id);
          return (
            <div key={loc.id} onClick={() => setSelLoc(loc.id)} style={{ width: 150, cursor: 'pointer',
              background: 'var(--bg2)', borderRadius: 8, padding: 12,
              border: active ? `1px solid ${SEV.low}` : '1px solid var(--bg3)',
              boxShadow: active ? '0 0 0 1px rgba(56,139,253,0.35)' : undefined }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="text-sm font-semibold text-text0">{loc.city}</span>
                <span className="mono text-2xs text-text2" style={{ background: 'var(--bg3)',
                  padding: '1px 5px', borderRadius: 4 }}>{loc.cc}</span>
              </div>
              {/* 22px is a display size and stays literal; the colour is data-driven */}
              <div className="mono font-bold" style={{ fontSize: 22, margin: '8px 0 2px',
                color: ms == null ? 'var(--text3)' : ms > 150 ? SEV.medium : SEV.green }}>
                {ms == null ? '—'
                  : <>{Math.round(ms)}<span className="text-sm text-text3"> ms</span></>}
              </div>
              <div className="mono text-2xs text-text3">
                {loc.kind === 'local' ? 'built-in'
                  : loc.kind === 'managed' ? 'opscat managed'
                    : loc.provider ? `${loc.provider} hosted` : 'self hosted'}
                {' · '}{n} check{n === 1 ? '' : 's'}
              </div>
              {/* The address checks leave from — the answer to "what do I
                  allow-list?", which used to need the cloud provider's console.
                  The built-in probe runs INSIDE the OpsCat server and has no
                  last_ip of its own, so this rendered a bare `—`: an orphan dash
                  under the meta line, answering nothing and reading like a bug.
                  Say where it runs instead; "your OpsCat server" is a true and
                  actionable answer to the same question. */}
              <div className="mono text-2xs text-text3" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis' }} title={loc.lastIp ?? undefined}>
                {loc.lastIp ?? (loc.kind === 'local' ? 'this OpsCat server' : 'address not reported yet')}
              </div>
              <div className="row" style={{ gap: 5, marginTop: 6, justifyContent: 'space-between' }}>
                <span className="row" style={{ gap: 5 }}>
                  <GlowDot color={loc.nodeStatus === 'provisioning' ? SEV.medium
                    : loc.online ? SEV.green : 'var(--text3)'} size={7} />
                  <span className="micro" style={{ fontSize: 'var(--t-2xs)' }}>
                    {loc.nodeStatus === 'provisioning' ? 'provisioning' : loc.online ? 'online' : 'offline'}</span>
                </span>
                {canWrite && loc.kind === 'customer' && (
                  <Button size="sm" variant="danger" aria-label="Remove location"
 onClick={(e) => { e.stopPropagation(); removeLocation(loc); }}><XIcon size={13} /></Button>
                )}
                {canWrite && loc.kind === 'managed' && loc.booked && (
                  <Button size="sm" title="Unbook"
 onClick={(e) => { e.stopPropagation(); unbook(loc); }}>unbook</Button>
                )}
              </div>
            </div>
          );
        })}
        {/* The tile stays after the cards rather than replacing them when the
            list is empty: "add another" then needs no second affordance, and
            the empty state is the same control rather than a different screen. */}
        {locations !== null && canWrite && (
          <AddTile label="Add Sensor Agent" onClick={onAdd} h={116}
            icon={<PlusIcon size={16} />} />
        )}
        {locations !== null && !canWrite && mine.length === 0 && (
          <div className="text-text3 text-sm">No sensor agents yet.</div>
        )}
      </div>

      {/* route card for selected agent */}
      <Card>
        <div className="card-title">
          Route — from {locations?.find((l) => l.id === selLoc)?.city ?? '—'}</div>
        {route === null
          ? <BarsSkeleton rows={5} labelW={120} />
          : route.length === 0
          ? <div className="text-text3 text-sm">no route data yet</div>
          : route.map((h, i) => {
            const last = i === route.length - 1;
            const w = h.ms != null ? (h.ms / maxHop) * 100 : 0;
            return (
              <div key={i} className="row" style={{ gap: 10, padding: '4px 0' }}>
                <span className="mono text-xs text-text3" style={{ width: 18 }}>{h.hop}</span>
                <span className="mono text-sm text-text1" style={{ width: 120,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.ip}</span>
                <div style={{ flex: 1, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${w}%`, height: '100%', background: last ? SEV.low : SEV.info }} />
                </div>
                <span className="mono text-xs text-text2" style={{ width: 44, textAlign: 'right' }}>
                  {h.ms != null ? `${Math.round(h.ms)}ms` : '*'}</span>
              </div>
            );
          })}
      </Card>

      {canWrite && <CloudCredentialsCard />}
      {canWrite && <SensorSshCard />}
      {canWrite && <CheckIdentityCard />}
    </>
  );
}

/**
 * The org-wide default User-Agent for HTTP checks — what a check sends when it
 * does not carry one of its own. Per check it is set in the check form; here so
 * an org can identify its whole monitoring fleet in one place.
 */
function CheckIdentityCard() {
  const [ua, setUa] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<Record<string, string>>('/api/admin/settings')
      .then((s) => setUa(s.synthetic_user_agent || '')).catch(() => setUa(''));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setMsg('');
    try {
      await api.patch('/api/admin/settings', { synthetic_user_agent: (ua || '').trim() });
      setMsg((ua || '').trim() ? 'saved' : 'cleared — checks send the OpsCat default again');
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Card style={{ padding: 0 }}>
      <div className="card-title" style={{ padding: '12px 16px 0' }}>Check identity
        <span className="mono text-2xs text-text3 font-normal">
          default User-Agent for HTTP checks — a check may override it</span>
      </div>
      <form onSubmit={save} style={{ padding: '10px 16px 14px' }}>
        {ua === null && (
          <Busy>
            <Skeleton w={150} h={8} style={{ display: 'block', marginBottom: 6 }} />
            <Skeleton h={30} radius={6} />
          </Busy>
        )}
        {ua !== null && (
          <>
            <Field label="Default User-Agent (empty = OpsCat's own)">
              <Input className="mono" width="100%" value={ua} maxLength={200}
                placeholder="OpsCat-Synthetics/1.0 (+https://opscat.io/bot)"
                onChange={(e) => setUa(e.target.value)} />
            </Field>
            <div className="row row-wrap" style={{ gap: 8 }}>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>Save</Button>
              {msg && <span className="mono text-2xs text-text3">{msg}</span>}
              {err && <span className="mono text-2xs" style={{ color: SEV.critical }}>{err}</span>}
            </div>
          </>
        )}
      </form>
    </Card>
  );
}

/**
 * Break-glass SSH for AUTO-PROVISIONED sensors (docs/SENSOR-AGENTS.md §11).
 *
 * Off by default and deliberately two fields: a key with no source range would
 * be an open port 22, and a range with no key would be a rule protecting
 * nothing. The server refuses each half on its own, so this form only has to
 * present them together — and it says, rather than implies, that the setting
 * applies to the NEXT node: cloud-init runs once, so an existing box cannot
 * grow a key it did not boot with.
 */
function SensorSshCard() {
  const [key, setKey] = useState<string | null>(null);
  const [cidrs, setCidrs] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<Record<string, string>>('/api/admin/settings')
      .then((s) => { setKey(s.sensor_ssh_key || ''); setCidrs(s.sensor_ssh_cidrs || ''); })
      .catch(() => setKey(''));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setMsg('');
    try {
      await api.patch('/api/admin/settings',
        { sensor_ssh_key: (key || '').trim(), sensor_ssh_cidrs: cidrs.trim() });
      setMsg((key || '').trim() ? 'saved — applies to sensors provisioned from now on' : 'break-glass SSH disabled');
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Card style={{ padding: 0 }}>
      <div className="card-title" style={{ padding: '12px 16px 0' }}>Break-glass SSH
        <span className="mono text-2xs text-text3 font-normal">
          optional — off unless both fields are set</span>
      </div>
      <form onSubmit={save} style={{ padding: '10px 16px 14px' }}>
        {key === null && (
          /* Derived from the real fields below — two labelled rows, same
             rhythm — rather than a second layout that goes stale. */
          <Busy>
            {[0, 1].map((i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <Skeleton w={i ? 210 : 170} h={8} style={{ display: 'block', marginBottom: 6 }} />
                <Skeleton h={30} radius={6} />
              </div>
            ))}
            <Skeleton w={64} h={28} radius={6} />
          </Busy>
        )}
        {key !== null && (
          <>
            <Field label="Authorized public key (opscat-admin)">
              <Input className="mono" width="100%" value={key} maxLength={1200}
                placeholder="ssh-ed25519 AAAA… you@example.com" onChange={(e) => setKey(e.target.value)} />
            </Field>
            <Field label="Allowed source addresses (comma separated, /16 or narrower)">
              <HostInput className="mono" width="100%" value={cidrs} maxLength={200}
                placeholder="91.98.197.223, 10.4.0.0/16" onChange={(e) => setCidrs(e.target.value)} />
            </Field>
            <div className="row row-wrap" style={{ gap: 8 }}>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>Save</Button>
              {msg && <span className="mono text-2xs text-text3">{msg}</span>}
              {err && <span className="mono text-2xs" style={{ color: SEV.critical }}>{err}</span>}
            </div>
            <div className="mono text-2xs text-text3" style={{ marginTop: 8, lineHeight: 1.7 }}>
              opens tcp/22 on new AWS/GCP sensors for those addresses only<br />
              ssh opscat-admin@&lt;sensor ip&gt; — the IP is on the agent card once it checks in
            </div>
          </>
        )}
      </form>
    </Card>
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
    <Card style={{ padding: 0 }}>
      <div className="card-title" style={{ padding: '12px 16px 0' }}>Cloud credentials
        <span className="mono text-2xs text-text3 font-normal">
          bring your own cloud — encrypted at rest, secrets never shown again</span>
      </div>
      {(creds ?? []).map((c) => (
        <div key={c.id} className="row" style={{ padding: '9px 16px', borderBottom: '1px solid var(--bg3)', gap: 10 }}>
          <span className="mono text-sm text-text0" style={{ width: 44, textTransform: 'uppercase' }}>{c.provider}</span>
          <span className="mono text-sm text-text1">{c.label}</span>
          <span className="mono text-xs text-text3">{c.hint}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="danger" onClick={() => revoke(c)}>revoke</Button>
        </div>
      ))}
      {creds && creds.length === 0 && (
        <div className="mono text-xs text-text3" style={{ padding: '10px 16px'}}>
          no cloud keys yet — needed for AWS/GCP hosted sensor agents</div>
      )}
      <div style={{ padding: '10px 16px' }}>
        <Button size="sm" onClick={() => setAdding(true)}><PlusIcon size={13} /> Add credential</Button>
        <span className="mono text-2xs text-text3" style={{ marginLeft: 8 }}>AWS · GCP</span>
      </div>
      {adding && <AddCredentialModal onClose={() => setAdding(false)}
        onAdded={() => { setAdding(false); load(); }} />}
    </Card>
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
          <Select title="Provider" value={provider} onChange={(v) => setProvider(v as 'aws' | 'gcp')}
            options={[{ value: 'aws', label: 'AWS' }, { value: 'gcp', label: 'GCP' }]} />
        </Field>
        <Field label="Label">
          <Input required value={label} maxLength={60} placeholder="e.g. prod-sensors"
            onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {provider === 'aws' ? (
          <>
            <Field label="Access key ID">
              <Input required className="mono" value={awsKeyId} placeholder="AKIA…"
                onChange={(e) => setAwsKeyId(e.target.value)} />
            </Field>
            <Field label="Secret access key">
              <Input required type="password" className="mono" value={awsSecret}
                onChange={(e) => setAwsSecret(e.target.value)} />
            </Field>
            <div className="mono text-2xs text-text3" style={{ marginBottom: 10 }}>
              Use a least-privilege IAM user: ec2 Run/Terminate/DescribeInstances + DescribeImages only.
            </div>
          </>
        ) : (
          <Field label="Service-account JSON">
            <Textarea required className="mono rca" value={gcpJson} rows={5}
              placeholder='{"type":"service_account","client_email":…}'
              onChange={(e) => setGcpJson(e.target.value)} />
          </Field>
        )}
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy}>{busy ? '…' : 'Store encrypted'}</Button>
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
  const [uaPreset, setUaPreset] = useState('');
  const [uaCustom, setUaCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const usable = usableLocations(locations);
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
        locationIds: allAgents ? [] : selAgents,
        // '' = inherit (org default, then ours). The sentinel never leaves the form.
        userAgent: type === 'http'
          ? (uaPreset === '__custom__' ? uaCustom.trim() : uaPreset) : undefined });
      onAdded();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="New check" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Type">
          <Select title="Check type" value={type} onChange={(v) => setType(v as SynthCheck['type'])}
            options={CHECK_TYPES.map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Target">
          <HostInput required autoFocus value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder={PLACEHOLDER[type]} />
        </Field>
        <Field label="Interval (seconds)">
          <Input type="number" min={5} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))} />
        </Field>
        <Field label="Timeout (ms)">
          <Input type="number" min={100} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
        </Field>
        {type === 'http' && (
          <>
            <Field label="Sends as (User-Agent)">
              <Select title="User agent" value={uaPreset} onChange={setUaPreset}
                options={UA_PRESETS.map(([value, label]) => ({ value, label }))} />
            </Field>
            {uaPreset === '__custom__' && (
              <Field label="Custom User-Agent">
                <Input className="mono" width="100%" value={uaCustom} maxLength={200}
                  placeholder="MyMonitor/1.0 (+https://example.com/bot)"
                  onChange={(e) => setUaCustom(e.target.value)} />
              </Field>
            )}
            {uaPreset !== '' && (
              <div className="mono text-2xs text-text3" style={{ margin: '-4px 0 10px', lineHeight: 1.6 }}>
                a browser string gets past a User-Agent rule, not past JA3 fingerprinting
                or a JS challenge — prefer allow-listing our IP where you can
              </div>
            )}
            <div className="micro text-2xs" style={{ margin: '4px 0 6px' }}>
              ASSERTIONS (optional — leave empty for "reachable = ok")</div>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Field label="Expected status">
                  <Input inputMode="numeric" value={expectStatus} placeholder="e.g. 200"
                    onChange={(e) => setExpectStatus(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 2 }}>
                <Field label="Body must contain">
                  <Input value={keyword} placeholder='e.g. "status":"ok"'
                    onChange={(e) => setKeyword(e.target.value)} />
                </Field>
              </div>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Field label="JSON path">
                  <Input className="mono" value={jsonPath} placeholder="$.status"
                    onChange={(e) => setJsonPath(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="equals">
                  <Input className="mono" value={jsonValue} placeholder="ok"
                    onChange={(e) => setJsonValue(e.target.value)} />
                </Field>
              </div>
            </div>
          </>
        )}
        <div className="row" style={{ justifyContent: 'space-between', margin: '4px 0 6px' }}>
          <span className="micro text-2xs">RUN FROM THESE SENSOR AGENTS</span>
          <span className="row" style={{ gap: 6 }}>
            {/* It used to say "incl. future", and it meant it — the check was
                stored with no location rows and every sensor booked afterwards
                picked it up. The server writes today's fleet out explicitly
                now, so the promise is gone along with the behaviour. */}
            <span className="mono text-2xs text-text2">all agents</span>
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
                <span className="mono text-sm text-text0">{l.city} {l.cc}</span>
                <span className="mono text-2xs text-text3">
                  {l.kind === 'local' ? 'built-in' : l.kind === 'managed' ? 'managed'
                    : l.provider ? `${l.provider} hosted` : 'self hosted'}</span>
                <GlowDot color={l.online ? SEV.green : 'var(--text3)'} size={6} />
              </div>
            ))}
          </div>
        )}
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy || !target || (!allAgents && selAgents.length === 0)}>
          {busy ? '…' : 'Create check'}</Button>
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
  const wizApp = useApp();

  useEffect(() => {
    api.get<CloudCredential[]>('/api/synthetics/cloud-credentials').then(setCreds).catch(() => setCreds([]));
    api.get<ProviderCatalog>('/api/synthetics/provider-catalog').then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const managed = locations.filter((l) => l.kind === 'managed');
  const managedBooked = managed.filter((l) => l.booked).length;
  const credFor = (p: 'aws' | 'gcp') => creds.filter((c) => c.provider === p);
  /* `managed.length === 0` has TWO causes and the card used to name only one.
   * In the community edition there is no OpsCat fleet, which is permanent and
   * worth saying. In the cloud edition it means the fleet is momentarily empty —
   * every node torn down, or the first one still provisioning — and telling a
   * paying customer "not available in OpsCat CE" then is simply false. It reads
   * as a plan limit, so the operator stops looking. Measured the hard way: it
   * cost an evening of "why can this org not book the node?" while the answer
   * was that the node did not exist for those 90 seconds. */
  const isCE = wizApp.edition === 'community';

  const pick = (p: WizProvider) => {
    if ((p === 'aws' || p === 'gcp') && credFor(p).length === 0) {
      setErr(`no ${p.toUpperCase()} key stored — add one under Cloud credentials on the Sensor Agents tab`);
      return;
    }
    if (p === 'managed' && managed.length === 0) return; // nothing to pick — see isCE above
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
        <div className="text-sm text-text1" style={{ marginBottom: 10 }}>
          Store this probe key now — it is <b>not retrievable later</b>:
        </div>
        <div className="mono text-sm text-text0" style={{ background: 'var(--bg3)',
          borderRadius: 6, padding: 10, wordBreak: 'break-all', marginBottom: 12 }}>{probeKey}</div>
        <div className="mono text-2xs text-text2" style={{ background: 'var(--bg3)',
          borderRadius: 6, padding: 10, lineHeight: 1.8, marginBottom: 12 }}>
          OPSCAT_URL=&lt;this instance&gt; OPSCAT_PROBE_KEY=&lt;key&gt; \<br />
          &nbsp;&nbsp;node opscat-agent.js --probe
          <span className="text-text3" style={{ display: 'block'}}>
            # outbound HTTPS only, no inbound needed</span>
        </div>
        <Button variant="primary" block
 onClick={onClose}>I stored the key</Button>
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
          <span className="text-base font-semibold text-text0">{title}</span>
          {right}
        </span>
        <span className="text-xs text-text2" style={{ display: 'block', marginTop: 2 }}>{sub}</span>
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
              ? <span className="mono text-xs text-text0"><b>{managedBooked}</b> in use</span>
              : <StatusPill text={isCE ? 'not available in OpsCat CE' : 'no location online right now'}
                  color={isCE ? SEV.info : SEV.medium} />,
            managed.length === 0)}
          {(['aws', 'gcp'] as const).map((p) => provCard(p, `${p.toUpperCase()} hosted`,
            'Provisioned into your cloud account — runs on your cloud bill. Unlimited.',
            credFor(p).length
              ? <StatusPill text="key configured" color={SEV.green} />
              : <StatusPill text="no key — add under Cloud credentials" color={SEV.critical} />))}
          {provCard('self', 'Self hosted',
            'Your own hardware — any network, private targets included. Unlimited & free.')}
          {err && <div className="text-sm" style={{ color: SEV.critical}}>{err}</div>}
        </>
      )}
      {step === 2 && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <Button size="sm" onClick={() => { setStep(1); setErr(''); }}>
              <ArrowLeftIcon size={13} /> back</Button>
            <span className="mono text-xs text-text2">
              {prov === 'self' ? 'self hosted' : prov === 'managed' ? 'OpsCat Managed' : `${prov.toUpperCase()} hosted`}
            </span>
          </div>
          {prov === 'self' ? (
            <>
              <Field label="City / label">
                <Input required autoFocus value={city} maxLength={80}
                  placeholder="e.g. Munich HQ" onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Field label="Country code (ISO2)">
                <Input required value={cc} maxLength={2} placeholder="DE" className="mono"
                  onChange={(e) => setCc(e.target.value.toUpperCase())} />
              </Field>
            </>
          ) : (
            <>
              <div className="micro text-2xs" style={{ marginBottom: 6 }}>Region</div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {/* Chips rather than Segmented: the list comes from data, and Segmented
                    is for a fixed handful. The atom is what adds aria-pressed — as bare
                    buttons these were N identical unlabelled controls to a reader. */}
                {regions.map((r) => (
                  <Chip key={r} active={region === r}
                    onClick={() => { setRegion(r); setEntry(null); }}>{r}</Chip>
                ))}
              </div>
              <div className="micro text-2xs" style={{ marginBottom: 6 }}>City</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                {!region && <span className="mono text-xs text-text3" style={{ gridColumn: '1/-1' }}>
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
                      <span className="text-sm font-semibold text-text0">{e.city}</span>
                      <span className="mono text-2xs text-text2" style={{ background: 'var(--bg3)',
                        padding: '1px 5px', borderRadius: 4 }}>{e.cc}</span>
                      <span className="mono text-2xs text-text3" style={{ marginLeft: 'auto' }}>
                        {taken ? 'booked' : mLoc?.isPremium ? 'premium' : prov === 'managed' ? '' : e.code}
                      </span>
                    </div>
                  );
                })}
              </div>
              {(prov === 'aws' || prov === 'gcp') && (
                <>
                  <Field label="Credential">
                    <Select title="Credential" value={credId != null ? String(credId) : ''}
                      onChange={(v) => setCredId(Number(v))}
                      options={credFor(prov).map((c) => ({ value: String(c.id), label: `${c.label} (${c.hint})` }))} />
                  </Field>
                  <Field label="Instance class">
                    <Select title="Instance class" value={cls}
                      onChange={(v) => setCls(v as 'standard' | 'browser')} options={[
                        { value: 'standard', label: 'standard — http · icmp · dns · tcp · traceroute' },
                        { value: 'browser', label: 'browser-capable — + browser checks later (more RAM)' }]} />
                  </Field>
                  <div className="mono text-2xs" style={{ color: SEV.medium, marginBottom: 10 }}>
                    Runs in your cloud account, on your bill. OpsCat tags the instance opscat-sensor
                    and auto-reconciles orphans hourly.
                  </div>
                </>
              )}
            </>
          )}
          {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
          <Button variant="primary" block
 onClick={create}
 disabled={busy || (prov === 'self' ? (!city || cc.length !== 2) : !entry)}>
            {busy ? '…' : prov === 'self' ? 'Create & show probe key'
              : prov === 'managed' ? 'Book location' : 'Provision sensor agent'}
          </Button>
        </>
      )}
    </Modal>
  );
}
