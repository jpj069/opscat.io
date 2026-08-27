// Pipeline — log ingest throughput (lines / volume / event hits) and the
// classifier rule chain (custom per-org rules + read-only built-ins + tester).
import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { SEV, alpha, fmtBytes, fmtHistory, relTime, sevColor } from '../format';
import { Card, Button, ChartSkeleton, Toggle,
  KpiCard, LineChart, Modal, Flyout, Field, TableScroll, TableSkeleton, Input, Tabs, Segmented,
  PageHeader, COL } from '../ui';
import { Select } from '../Select';
import { useTab } from '../state';
import type {
  ClassifierRule, ClassifiersResponse, ClassifyTestResult, DryRun, PipelineStats, ScoutTemplate,
} from '../types';
import {
  CheckIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';

type Tab = 'throughput' | 'classifiers' | 'scout';
type Range = '24h' | '7d' | '30d';

const PIPELINE_TABS = [
  ['throughput', 'Throughput'], ['classifiers', 'Classifiers'], ['scout', 'Scout'],
] as const;

export default function Pipeline() {
  const [tab, setTab] = useTab(PIPELINE_TABS.map((t) => t[0]));
  return (
    <div className="page">
      <PageHeader title="Log Pipeline" />
      <Tabs tabs={PIPELINE_TABS} value={tab} onChange={setTab} />
      {tab === 'throughput' ? <Throughput /> : tab === 'classifiers' ? <Classifiers /> : <Scout />}
    </div>
  );
}

// ---------------------------------------------------------------- throughput

const RANGES = [['24h', '24h'], ['7d', '7d'], ['30d', '30d']] as const;
const CHART_H = 160;

function Throughput() {
  const app = useApp();
  const [range, setRange] = useState<Range>('24h');
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setStats(null); setErr('');
    api.get<PipelineStats>(`/api/admin/pipeline/stats?range=${range}`)
      .then(setStats)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'network error'));
  }, [range]);

  const hourly = !stats || stats.step < 86400000;
  const stepLabel = hourly ? 'hour' : 'day';

  // Sparse axis labels (every ~8th point) keep the axis readable; `tips` carries
  // the full one for every point, so the hover readout can name the bucket.
  const { labels, tips } = useMemo(() => {
    if (!stats) return { labels: [] as string[], tips: [] as string[] };
    const every = Math.max(1, Math.ceil(stats.buckets.length / 8));
    const full = stats.buckets.map((b) => {
      const d = new Date(b.bucket);
      const day = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      return hourly ? `${day} ${String(d.getHours()).padStart(2, '0')}:00` : day;
    });
    return { tips: full, labels: full.map((l, i) => (i % every === 0 ? l.slice(hourly ? 6 : 0) : '')) };
  }, [stats, hourly]);

  const peak = useMemo(() => stats ? Math.max(0, ...stats.buckets.map((b) => b.lines)) : 0, [stats]);
  const fmtCount = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

  // Drag over a span, land on the lines that made it. The bucket START of the first
  // and the END of the last, so the window covers the whole span the reader drew —
  // taking bucket[to] as the end would silently drop its own hour (or day).
  const showInLogs = (a: number, b: number) => {
    if (!stats) return;
    const from = stats.buckets[a].bucket;
    const to = Math.min(Date.now(), stats.buckets[b].bucket + stats.step);
    app.setNav('logs', `?from=${from}&to=${to}`);
  };

  if (err) return <Card className="text-base" style={{ color: SEV.critical}}>{err}</Card>;

  // No loading branch: KpiCard and LineChart render their own placeholder when
  // handed null, so the page keeps its real structure from the first paint.
  const lines = stats?.totals.lines ?? 0;
  const hitRate = stats && lines ? Math.round((stats.totals.events / lines) * 100) : 0;
  const perStep = stats && stats.buckets.length ? Math.round(lines / stats.buckets.length) : 0;
  const bytesPerStep = stats && stats.buckets.length
    ? Math.round(stats.totals.bytes / stats.buckets.length) : 0;
  // The capacity number. Only real when the minute counters reach into the range —
  // otherwise the card says so instead of dressing an hourly average up as a
  // per-second rate (see PipelineStats.peak).
  const peakMin = stats?.peak?.source === 'minute' ? stats.peak : null;
  return (
    <>
      <div className="row row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="text-sm text-text3">
          Ingest volume per {stepLabel}, last {range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'}
        </span>
        <Segmented label="Time range" value={range} onChange={setRange} options={RANGES} />
      </div>
      <div style={{ display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))' }}>
        <KpiCard label="LOG LINES" value={stats ? fmtCount(lines) : null} color={SEV.cyan}
          spark={stats?.buckets.map((b) => b.lines)}
          sub={stats ? `≈ ${fmtCount(perStep)} per ${stepLabel}` : null} />
        <KpiCard label={`VOLUME / ${stepLabel.toUpperCase()}`}
          value={stats ? fmtBytes(bytesPerStep) : null} color={SEV.purple}
          spark={stats?.buckets.map((b) => b.bytes)}
          sub={stats ? `${fmtBytes(stats.totals.bytes)} total · ${fmtBytes(lines ? Math.round(stats.totals.bytes / lines) : 0)}/line` : null} />
        <KpiCard label="CLASSIFIED HITS" value={stats ? fmtCount(stats.totals.events) : null} color={SEV.medium}
          spark={stats?.buckets.map((b) => b.events)}
          sub={stats ? `${hitRate}% of lines matched a rule` : null} />
        <KpiCard label={`PEAK / ${stepLabel.toUpperCase()}`} value={stats ? fmtCount(peak) : null}
          color={SEV.green} sub={stats ? `busiest ${stepLabel} in range` : null} />
        <KpiCard label="PEAK / MIN" color={SEV.high}
          value={!stats ? null : peakMin ? fmtCount(peakMin.lines) : '—'}
          sub={!stats ? null : peakMin
            ? `≈ ${peakMin.perSecond.toFixed(peakMin.perSecond < 10 ? 1 : 0)} lines/s · ${fmtHistory(peakMin.at!)}`
            : 'minute counters only cover the last 48h'} />
      </div>
      <div style={{ display: 'grid', gap: 14,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <Card title={`Log lines per ${stepLabel}`}>
          <LineChart points={stats?.buckets.map((b) => b.lines) ?? null} labels={labels} tips={tips}
            onSelect={showInLogs} selectLabel="Span"
            color={SEV.cyan} fmt={fmtCount} h={CHART_H} />
        </Card>
        <Card title={`Volume per ${stepLabel}`}>
          <LineChart points={stats?.buckets.map((b) => b.bytes) ?? null} labels={labels} tips={tips}
            onSelect={showInLogs} selectLabel="Span"
            color={SEV.purple} fmt={fmtBytes} h={CHART_H} />
        </Card>
        <Card title={`Classified hits per ${stepLabel}`}>
          <LineChart points={stats?.buckets.map((b) => b.events) ?? null} labels={labels} tips={tips}
            onSelect={showInLogs} selectLabel="Span"
            color={SEV.medium} fmt={fmtCount} h={CHART_H} />
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- classifiers

// Pattern (regex) | Flags | Event name | Severity | Target | State | actions
const GRID = [COL.textWide, COL.num, COL.text, COL.num, COL.num, COL.toggle, COL.actions].join(' ');
// The built-ins have no state and no per-row actions, so those two tracks fall
// away — the remaining five stay identical, so the two tables read as one list.
const BUILTIN_GRID = [COL.textWide, COL.num, COL.text, COL.num, COL.num].join(' ');

function Classifiers() {
  const app = useApp();
  const isAdmin = app.user?.role === 'admin';
  const [builtin, setBuiltin] = useState<ClassifierRule[] | null>(null);
  const [custom, setCustom] = useState<ClassifierRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [dryRun, setDryRun] = useState<ClassifierRule | null>(null);

  useEffect(() => {
    api.get<ClassifiersResponse>('/api/admin/pipeline/classifiers')
      .then((r) => { setBuiltin(r.builtin); setCustom(r.custom); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'network error'));
  }, []);

  const edit = (i: number, patch: Partial<ClassifierRule>) => {
    setCustom((cur) => cur.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setDirty(true); setSaved(false);
  };
  // a hand-written rule starts as a draft too — you write it, dry-run it, then
  // switch it on; the same three steps Scout's suggestions go through
  const add = () => {
    setCustom((cur) => [...cur,
      { pattern: '', flags: 'i', name: '', severity: 50, targetGroup: null, enabled: false }]);
    setDirty(true); setSaved(false);
  };
  const remove = (i: number) => {
    setCustom((cur) => cur.filter((_, j) => j !== i));
    setDirty(true); setSaved(false);
  };
  const save = async () => {
    setSaving(true); setErr('');
    try {
      await api.put('/api/admin/pipeline/classifiers', { classifiers: custom });
      setDirty(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'network error'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <Tester />

      <Card>
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>Custom rules · this organization</span>
          {isAdmin && <Button size="sm" onClick={add}><PlusIcon size={13} /> Add rule</Button>}
        </div>
        <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
          Evaluated before the built-ins, first match wins. Target group extracts a regex
          capture group (1-9) into the event target — it becomes part of the dedupe key.
          A <b>draft</b> is stored but classifies nothing: dry-run it against the last 24h
          of logs, then switch it live.
        </div>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <TableScroll cols={GRID} minWidth={760}>
          <div className="tbl-head" style={{ padding: '8px 0' }}>
            <span>Pattern (regex)</span><span>Flags</span><span>Event name</span>
            <span>Severity</span><span>Target</span><span>State</span><span></span>
          </div>
          {custom.length === 0 && (
            <div className="text-text3 text-base" style={{ padding: 16, textAlign: 'center'}}>
              No custom rules yet — only the built-ins below apply.
            </div>
          )}
          {custom.map((c, i) => (
            <div key={i} className="tbl-row" style={{ padding: '5px 0' }}>
              <Input className="mono text-sm" disabled={!isAdmin} value={c.pattern} placeholder="disk (full|usage)"
                 onChange={(e) => edit(i, { pattern: e.target.value })} />
              <Input className="mono text-sm" disabled={!isAdmin} value={c.flags ?? 'i'} placeholder="i"
                 onChange={(e) => edit(i, { flags: e.target.value })} />
              <Input className="mono text-sm" disabled={!isAdmin} value={c.name} placeholder="disk_full"
                 onChange={(e) => edit(i, { name: e.target.value })} />
              <Input className="mono text-sm" disabled={!isAdmin} value={String(c.severity)} inputMode="numeric"
                style={{ color: sevColor(c.severity) }}
                onChange={(e) => edit(i, { severity: parseInt(e.target.value, 10) || 0 })} />
              <Input className="mono text-sm" disabled={!isAdmin} value={c.targetGroup ?? ''} placeholder="—"
                inputMode="numeric"
                onChange={(e) => edit(i, { targetGroup: e.target.value ? parseInt(e.target.value, 10) : null })} />
              <span className="row" style={{ gap: 6 }}>
                <Toggle on={c.enabled !== false} disabled={!isAdmin}
                  onClick={() => edit(i, { enabled: c.enabled === false })} />
                <span className={`text-2xs ${c.enabled === false ? 'text-text3' : 'text-text2'}`}>
                  {c.enabled === false ? 'draft' : 'live'}</span>
              </span>
              <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                <Button size="sm" disabled={!c.pattern} title="What would this rule have done in the last 24h?"
                  onClick={() => setDryRun(c)}>Dry run</Button>
                {isAdmin && <button title="Delete rule" style={{ color: SEV.critical, display: 'inline-flex' }}
                  onClick={() => remove(i)}><XIcon size={15} /></button>}
              </span>
            </div>
          ))}
        </TableScroll>
        {isAdmin && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 12, marginTop: 12 }}>
            {saved && <span className="row text-base font-semibold" style={{ color: SEV.green, gap: 4 }}>
              <CheckIcon size={13} /> saved</span>}
            <Button variant="primary" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save Rules'}
            </Button>
          </div>
        )}
        {!isAdmin && (
          <div className="text-xs text-text3" style={{ marginTop: 8 }}>
            Only administrators can change classifier rules.
          </div>
        )}
      </Card>

      <Card>
        <div className="card-title">Built-in rules</div>
        <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
          Shipped with OpsCat, evaluated after your custom rules. Lines matching no rule fall
          back to their syslog severity (crit and above still become events).
        </div>
        {/* The skeleton belongs INSIDE the scroller, like the rows it stands in for.
            Outside it, a 620px-wide grid on a 390px phone pushes the whole page
            sideways for as long as the fetch takes — which reads as the page
            "jumping" when you switch to this tab, and disappears before you can
            look at it. */}
        <TableScroll cols={BUILTIN_GRID} minWidth={640}>
          <div className="tbl-head" style={{ padding: '8px 0' }}>
            <span>Pattern (regex)</span><span>Flags</span><span>Event name</span>
            <span>Severity</span><span>Target</span>
          </div>
          {builtin === null && <TableSkeleton rows={5} flush />}
          {builtin?.map((c) => (
              <div key={c.name + c.pattern} className="tbl-row" style={{ padding: 'var(--row-py) 0' }}>
                <span className="mono text-xs text-text2" style={{ overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.pattern}>{c.pattern}</span>
                <span className="mono text-xs text-text3">{c.flags}</span>
                <span className="mono text-sm text-text0">{c.name}</span>
                <span className="mono text-sm font-semibold" style={{ color: sevColor(c.severity) }}>{c.severity}</span>
                <span className="mono text-xs text-text2">
                  {c.targetGroup ? `group ${c.targetGroup}` : '—'}</span>
              </div>
            ))}
        </TableScroll>
      </Card>
      {dryRun && <DryRunModal rule={dryRun} onClose={() => setDryRun(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- dry run

const DRY_RANGES = [['24', '24h'], ['168', '7d'], ['720', '30d']] as const;

/**
 * The result of a backtest, rendered the same way wherever it is run — from a
 * rule row, and from Scout's draft dialog.
 *
 * The three outcome numbers are the point. "matched 4.812 lines" alone is the
 * answer to the wrong question: what an admin needs before switching a rule on is
 * whether those lines are ALREADY classified. `shadowed` in particular is the
 * failure the single-line tester cannot show — an existing custom rule matches
 * first, so the new rule can be perfect and still never fire.
 */
function DryRunResult({ run }: { run: DryRun }) {
  const cell = (label: string, value: number, color: string, hint: string) => (
    <div className="card" style={{ padding: '8px 10px', minWidth: 0 }} title={hint}>
      <div className="micro text-2xs">{label}</div>
      <div className="mono font-bold" style={{ fontSize: 18, color }}>{value.toLocaleString()}</div>
      <div className="text-2xs text-text3">{hint}</div>
    </div>
  );
  return (
    <>
      <div style={{ display: 'grid', gap: 8, marginTop: 10,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(130px, 100%), 1fr))' }}>
        {cell('MATCHED', run.matched, SEV.cyan, `of ${run.scanned.toLocaleString()} lines`)}
        {cell('NEW', run.fresh, SEV.green, 'unclassified today')}
        {cell('TAKEOVER', run.takeover, SEV.medium, 'built-in / syslog today')}
        {cell('SHADOWED', run.shadowed, run.shadowed ? SEV.high : 'var(--text3)', 'a custom rule wins first')}
      </div>
      <div className="text-xs text-text2" style={{ marginTop: 8 }}>
        Would have produced <b className="text-text0">{run.events}</b> event
        {run.events === 1 ? '' : 's'} (deduped per device + target) and opened{' '}
        <b className="text-text0">{run.cases}</b> case{run.cases === 1 ? '' : 's'}.
        {run.shadowed > 0 && (
          <span style={{ color: SEV.high }}> {run.shadowed} matching line
            {run.shadowed === 1 ? '' : 's'} already belong to an earlier custom rule — this rule
            never sees them.</span>
        )}
        {(run.truncated || run.timedOut) && (
          <span className="text-text3"> Stopped early ({run.timedOut ? 'time budget' : 'line cap'}),
            so the numbers are a floor, not a total.</span>
        )}
      </div>
      {run.samples.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="micro text-2xs" style={{ marginBottom: 4 }}>MATCHED LINES</div>
          {run.samples.map((s, i) => (
            <div key={i} className="mono text-2xs" style={{ padding: '4px 8px', borderRadius: 4,
              background: 'var(--bg2)', border: '1px solid var(--bg3)', marginBottom: 4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.line}>
              <span className="text-text3">{s.device}</span>{' '}
              {s.target && <span style={{ color: SEV.purple }}>[{s.target}]</span>}{' '}
              <span className="text-text1">{s.line}</span>
              {s.replaces && <span className="text-text3"> · was {s.replaces.name} ({s.replaces.source})</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Dry run for a saved/edited custom rule, from the rule's own row.
function DryRunModal({ rule, onClose }: { rule: ClassifierRule; onClose: () => void }) {
  const [hours, setHours] = useState('24');
  const [run, setRun] = useState<DryRun | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setRun(null); setErr('');
    api.post<DryRun>('/api/admin/pipeline/dryrun', {
      pattern: rule.pattern, flags: rule.flags || 'i', name: rule.name || 'rule',
      severity: rule.severity, targetGroup: rule.targetGroup ?? null, hours: parseInt(hours, 10),
    }).then(setRun).catch((e) => setErr(e instanceof ApiError ? e.message : 'network error'));
  }, [rule, hours]);

  // An analysis, not a form: shadowed / takeover / fresh is read AGAINST the rule
  // list it came from, so it belongs beside it rather than over it.
  return (
    <Flyout title={`Dry run · ${rule.name || 'unnamed rule'}`} onClose={onClose} width={640}>
      <div className="mono text-xs text-text2" style={{ background: 'var(--bg2)',
        border: '1px solid var(--bg3)', borderRadius: 6, padding: '8px 10px',
        wordBreak: 'break-all' }}>/{rule.pattern}/{rule.flags || 'i'}</div>
      <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <span className="text-xs text-text3">
          Read-only: matches stored logs, classifies nothing and stores nothing.
        </span>
        <Segmented label="Dry-run range" value={hours} onChange={setHours} options={DRY_RANGES} />
      </div>
      {err && <div className="text-sm" style={{ color: SEV.critical, marginTop: 8 }}>{err}</div>}
      {!err && run === null && <ChartSkeleton h={120} />}
      {run && <DryRunResult run={run} />}
    </Flyout>
  );
}

// ---------------------------------------------------------------- rule tester

function Tester() {
  const [line, setLine] = useState('');
  const [sev, setSev] = useState('6');
  const [result, setResult] = useState<ClassifyTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setResult(null);
    try {
      setResult(await api.post<ClassifyTestResult>('/api/admin/pipeline/test',
        { line, sev: parseInt(sev, 10) }));
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'network error'); }
    finally { setBusy(false); }
  };

  const m = result?.match;
  return (
    <Card>
      <div className="card-title">Rule tester</div>
      <form onSubmit={run} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Input required className="mono" value={line} onChange={(e) => setLine(e.target.value)}
          placeholder="paste a sample log line, e.g.  kernel: Out of memory: Killed process 1234 (node)"
          style={{ flex: 3, minWidth: 240, fontSize: 'var(--t-sm)' }} />
        <Select title="Severity" value={sev} onChange={setSev} style={{ width: 150 }}
          options={['0 emerg', '1 alert', '2 crit', '3 err', '4 warning', '5 notice', '6 info', '7 debug']
            .map((s) => ({ value: s.split(' ')[0], label: `syslog ${s}` }))} />
        <Button variant="primary" size="sm" disabled={busy}>{busy ? '…' : 'Test line'}</Button>
      </form>
      {err && <div className="text-sm" style={{ color: SEV.critical, marginTop: 8 }}>{err}</div>}
      {result && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 6,
          background: m ? alpha(sevColor(m.severity), 0.08) : 'var(--bg2)',
          border: `1px solid ${m ? alpha(sevColor(m.severity), 0.3) : 'var(--bg3)'}` }}>
          {m ? (
            <div className="mono text-sm text-text1" style={{ display: 'flex',
              flexWrap: 'wrap', gap: 14 }}>
              <span>event <b className="text-text0">{m.name}</b></span>
              <span>severity <b style={{ color: sevColor(m.severity) }}>{m.severity}</b></span>
              <span>target <b className="text-text0">{m.target ?? '—'}</b></span>
              <span>matched by <b className="text-text0">{m.source}</b>
                {m.pattern ? <span className="text-text3"> ({m.pattern})</span> : null}</span>
              <span style={{ color: m.severity >= result.caseThreshold ? SEV.high : 'var(--text3)' }}>
                {m.severity >= result.caseThreshold ? 'would open a case' : 'no case'}</span>
            </div>
          ) : (
            <span className="mono text-sm text-text2">
              no match — the line is stored as a log only, no event is created
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- scout

// Seen | Template | Last seen | AI suggestion | actions
// actionsBar, not actions: the row carries FOUR labelled buttons (Logs,
// AI suggest/Re-suggest, Create draft, Dismiss). In the 84px icon-button track they
// wrapped to two lines each and the bar reached back over the AI-suggestion text.
const SCOUT_GRID = [COL.num, COL.textWide, COL.age, COL.text, COL.actionsBar].join(' ');

// OpsCat Scout: templates mined from unclassified lines, ordered by frequency.
// Admins ask the org's LLM for a name/severity, approve into a classifier
// rule, or dismiss (remembered — never suggested again).
function Scout() {
  const app = useApp();
  const isAdmin = app.user?.role === 'admin';
  const [rows, setRows] = useState<ScoutTemplate[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [approving, setApproving] = useState<ScoutTemplate | null>(null);

  const load = () => api.get<ScoutTemplate[]>('/api/admin/scout')
    .then(setRows).catch((e) => setErr(e instanceof ApiError ? e.message : 'network error'));
  useEffect(() => { load(); }, []);

  const suggest = async (t: ScoutTemplate) => {
    setBusyId(t.id); setErr('');
    try {
      const r = await api.post<{ suggestion: ScoutTemplate['suggestion'] }>(
        `/api/admin/scout/${t.id}/suggest`, {});
      setRows((cur) => cur?.map((x) => (x.id === t.id ? { ...x, suggestion: r.suggestion } : x)) ?? cur);
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'network error'); }
    finally { setBusyId(null); }
  };
  // The template is masked, so it matches no raw line — the server hands us the
  // longest LITERAL run to search for instead, and the row's own first/last seen
  // becomes the window. Clamped to now so a clock skew cannot produce a future
  // window that matches nothing.
  const showLogs = (t: ScoutTemplate) => {
    const to = Math.min(Date.now(), t.lastSeen + 60000);
    const from = Math.min(t.firstSeen, to - 3600000);
    app.setNav('logs', `?q=${encodeURIComponent(t.filter || '')}&from=${from}&to=${to}`);
  };
  const dismiss = async (t: ScoutTemplate) => {
    setBusyId(t.id);
    try { await api.post(`/api/admin/scout/${t.id}/dismiss`, {}); load(); }
    catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'network error'); }
    finally { setBusyId(null); }
  };

  return (
    <>
      <Card>
        <div className="card-title">Scout · suggested rules from unmatched lines</div>
        <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
          Scout watches log lines no classifier matched, masks the variable parts
          (<span className="mono">&lt;IP&gt;, &lt;NUM&gt;, &lt;*&gt;</span>) and groups them into templates.
          Frequent templates are rule candidates: let the AI suggest a name and severity, then
          create a <b>draft rule</b> from it — or dismiss noise for good.
          A draft is a normal custom rule that classifies nothing yet:
          dry-run it against real logs, edit it, and switch it live under Classifiers.
        </div>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <TableScroll cols={SCOUT_GRID} minWidth={880}>
          <div className="tbl-head" style={{ padding: '8px 0' }}>
            <span>Seen</span><span>Template</span><span>Last seen</span><span>AI suggestion</span><span></span>
          </div>
          {rows === null && <TableSkeleton rows={4} flush />}
          {rows?.length === 0 && (
            <div className="text-base text-text3" style={{ padding: 20, textAlign: 'center' }}>
              Nothing pending — every recent log line matched a rule, or no unmatched lines arrived yet.
            </div>
          )}
          {rows?.map((t) => (
            <div key={t.id} className="tbl-row" style={{ padding: 'var(--row-py) 0' }}>
              <span className="mono text-sm font-bold text-text0">
                {t.count >= 1000 ? `${(t.count / 1000).toFixed(1)}k` : t.count}×</span>
              <span className="mono text-xs text-text1" title={t.sample || undefined}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.template}</span>
              <span className="mono text-xs text-text2">{relTime(t.lastSeen)}</span>
              <span className="text-xs" style={{ overflow: 'hidden' }}>
                {t.suggestion ? (
                  t.suggestion.skip ? (
                    <span className="text-text3" title={t.suggestion.reason}>
                      noise — {t.suggestion.reason.slice(0, 60)}</span>
                  ) : (
                    <span className="mono" title={t.suggestion.reason}>
                      <b className="text-text0">{t.suggestion.name}</b>
                      <b style={{ color: sevColor(t.suggestion.severity), marginLeft: 6 }}>
                        {t.suggestion.severity}</b>
                      <span className="text-text3" style={{ marginLeft: 6 }}>
                        {t.suggestion.reason.slice(0, 50)}</span>
                    </span>
                  )
                ) : <span className="text-text3">—</span>}
              </span>
              <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                {/* Not admin-only: reading the lines a template stands for is what
                    everyone does first, and it only opens a filtered log view. */}
                <Button size="sm" disabled={!t.filter} onClick={() => showLogs(t)}
                  title="Open the log lines this template was mined from">Logs</Button>
                {isAdmin && <>
                  <Button size="sm" disabled={busyId === t.id} onClick={() => suggest(t)}
 title="Ask the org's LLM for a name + severity">
                    {busyId === t.id ? '…' : t.suggestion ? 'Re-suggest' : 'AI suggest'}
                  </Button>
                  <Button size="sm" style={{ color: SEV.green }} onClick={() => setApproving(t)}
 title="Turn this template into a draft rule — inactive until you switch it on">
                    Create draft</Button>
                  <Button size="sm" style={{ color: 'var(--text3)' }} disabled={busyId === t.id}
 onClick={() => dismiss(t)} title="Never suggest this template again">Dismiss</Button>
                </>}
              </span>
            </div>
          ))}
        </TableScroll>
        {!isAdmin && (
          <div className="text-xs text-text3" style={{ marginTop: 8 }}>
            Only administrators can draft rules or dismiss suggestions.
          </div>
        )}
      </Card>
      {approving && (
        <ApproveModal template={approving} onClose={() => setApproving(null)}
          onDone={() => { setApproving(null); load(); }} />
      )}
    </>
  );
}

/**
 * Turn a mined template into a DRAFT rule.
 *
 * Three things the admin gets to see before anything is written: the regex that
 * will be generated, what it would have done to the last 24h of logs, and that
 * the rule starts switched off. The regex comes from the SERVER — the same
 * `templateToPattern()` that writes the rule — because the mask table has 14
 * tag→pattern pairs and a second copy in the browser would eventually disagree
 * with the rule it claims to describe.
 */
function ApproveModal({ template, onClose, onDone }: {
  template: ScoutTemplate; onClose: () => void; onDone: () => void;
}) {
  const placeholders = template.template.match(/<[A-Z*]+>/g) || [];
  const [name, setName] = useState(template.suggestion?.name || '');
  const [severity, setSeverity] = useState(String(template.suggestion?.severity ?? 40));
  const [targetIndex, setTargetIndex] = useState('0');
  const [hours, setHours] = useState('24');
  const [preview, setPreview] = useState<DryRun | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // The preview follows the target picker (the capture group changes the regex)
  // and the range. It deliberately does NOT follow name/severity keystrokes —
  // those only relabel the counts, and a dry run per typed character is a scan of
  // the log table per typed character.
  useEffect(() => {
    setPreview(null); setPreviewErr('');
    api.post<DryRun>(`/api/admin/scout/${template.id}/dryrun`, {
      targetIndex: parseInt(targetIndex, 10) || 0,
      severity: parseInt(severity, 10) || 0,
      name: name || undefined,
      hours: parseInt(hours, 10),
    }).then(setPreview)
      .catch((e) => setPreviewErr(e instanceof ApiError ? e.message : 'network error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id, targetIndex, hours]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post(`/api/admin/scout/${template.id}/approve`, {
        name, severity: parseInt(severity, 10), targetIndex: parseInt(targetIndex, 10) || 0,
      });
      onDone();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'network error'); setBusy(false); }
  };

  return (
    <Modal title="Create draft rule from template" onClose={onClose} width={640}>
      <div className="mono text-xs text-text2" style={{ background: 'var(--bg2)',
        border: '1px solid var(--bg3)', borderRadius: 6, padding: '8px 10px', marginBottom: 12,
        wordBreak: 'break-all' }}>{template.template}</div>
      <form onSubmit={submit}>
        <Field label="Event name">
          <Input required className="mono" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="billing.sync_slow" />
        </Field>
        <div className="row row-wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ width: 120 }}>
            <Field label="Severity (0-100)">
              <Input required className="mono" inputMode="numeric" value={severity}
                onChange={(e) => setSeverity(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Field label="Target (dedupe entity)">
              <Select title="Target" value={targetIndex} onChange={setTargetIndex}
                options={[{ value: '0', label: 'none — dedupe per device only' },
                  ...placeholders.map((p, i) => ({
                    value: String(i + 1), label: `placeholder ${i + 1}: ${p}`,
                  }))]} />
            </Field>
          </div>
        </div>

        <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <span className="micro text-2xs">GENERATED RULE · DRY RUN</span>
          <Segmented label="Dry-run range" value={hours} onChange={setHours} options={DRY_RANGES} />
        </div>
        {preview && (
          <div className="mono text-xs" style={{ background: 'var(--bg2)', marginTop: 6,
            border: `1px solid ${preview.tooLong ? SEV.critical : 'var(--bg3)'}`, borderRadius: 6,
            padding: '8px 10px', wordBreak: 'break-all', color: 'var(--text1)' }}>
            /{preview.pattern}/i
            {preview.captureGroup
              ? <span className="text-text3"> · group {preview.captureGroup} → target</span> : null}
            {preview.tooLong && <div style={{ color: SEV.critical }}>
              {preview.pattern!.length} chars — over the 300-char rule limit, this template
              cannot become a rule.</div>}
          </div>
        )}
        {previewErr && <div className="text-sm" style={{ color: SEV.critical, marginTop: 6 }}>{previewErr}</div>}
        {!previewErr && preview === null && <ChartSkeleton h={110} />}
        {preview && <DryRunResult run={preview} />}

        <div className="text-xs text-text3" style={{ margin: '12px 0 10px' }}>
          The rule is created as a <b>draft</b>: stored under Classifiers, classifying nothing
          until you switch it live there. Severity ≥ 60 auto-opens a case once it is.
        </div>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block disabled={busy || preview?.tooLong}>
          {busy ? '…' : 'Create draft rule'}</Button>
      </form>
    </Modal>
  );
}
