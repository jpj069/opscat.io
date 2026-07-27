// Pipeline — log ingest throughput (lines / volume / event hits) and the
// classifier rule chain (custom per-org rules + read-only built-ins + tester).
import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { SEV, alpha, fmtBytes, sevColor } from '../format';
import { KpiCard, LineChart, TableScroll, TableSkeleton } from '../ui';
import type { ClassifierRule, ClassifiersResponse, ClassifyTestResult, PipelineStats } from '../types';

type Tab = 'throughput' | 'classifiers';
type Range = '24h' | '7d' | '30d';

export default function Pipeline() {
  const [tab, setTab] = useState<Tab>('throughput');
  return (
    <div className="page">
      <h1 className="page-title">Pipeline</h1>
      <div className="row" style={{ gap: 0, marginBottom: 14, borderBottom: '1px solid var(--bg3)' }}>
        {([['throughput', 'Throughput'], ['classifiers', 'Classifiers']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding: '6px 14px', fontSize: 11, fontWeight: 600,
              color: tab === id ? 'var(--text0)' : 'var(--text2)',
              borderBottom: tab === id ? '2px solid #388bfd' : '2px solid transparent' }}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'throughput' ? <Throughput /> : <Classifiers />}
    </div>
  );
}

// ---------------------------------------------------------------- throughput

function Throughput() {
  const [range, setRange] = useState<Range>('24h');
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setStats(null); setErr('');
    api.get<PipelineStats>(`/api/admin/pipeline/stats?range=${range}`)
      .then(setStats)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'network error'));
  }, [range]);

  const labels = useMemo(() => {
    if (!stats) return [];
    const hourly = stats.step < 86400000;
    return stats.buckets.map((b, i) => {
      // label every ~6th point so the axis stays readable
      if (stats.buckets.length > 8 && i % Math.ceil(stats.buckets.length / 8) !== 0) return '';
      const d = new Date(b.bucket);
      return hourly
        ? `${String(d.getHours()).padStart(2, '0')}:00`
        : d.toISOString().slice(5, 10);
    });
  }, [stats]);

  const peak = useMemo(() => stats ? Math.max(0, ...stats.buckets.map((b) => b.lines)) : 0, [stats]);
  const fmtCount = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

  if (err) return <div className="card" style={{ color: SEV.critical, fontSize: 12 }}>{err}</div>;

  // No loading branch: KpiCard and LineChart render their own placeholder when
  // handed null, so the page keeps its real structure from the first paint.
  const stepLabel = !stats || stats.step < 86400000 ? 'hour' : 'day';
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
        <span className="row" style={{ gap: 0, border: '1px solid var(--bg3)', borderRadius: 5, overflow: 'hidden' }}>
          {(['24h', '7d', '30d'] as const).map((r) => (
            <button key={r} onClick={() => setRange(r)}
              style={{ padding: '4px 12px', fontSize: 10, fontWeight: 600,
                background: range === r ? 'var(--bg3)' : 'transparent',
                color: range === r ? 'var(--text0)' : 'var(--text3)' }}>{r}</button>
          ))}
        </span>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 14, alignItems: 'stretch' }}>
        <KpiCard label="LOG LINES" value={stats ? fmtCount(stats.totals.lines) : null} color={SEV.cyan}
          spark={stats?.buckets.map((b) => b.lines)}
          sub={stats ? `ingested in the last ${stats.range}` : null} />
        <KpiCard label="VOLUME" value={stats ? fmtBytes(stats.totals.bytes) : null} color={SEV.purple}
          spark={stats?.buckets.map((b) => b.bytes)} sub="raw line bytes" />
        <KpiCard label="CLASSIFIED HITS" value={stats ? fmtCount(stats.totals.events) : null} color={SEV.medium}
          spark={stats?.buckets.map((b) => b.events)} sub="lines that matched a rule" />
        <KpiCard label={`PEAK / ${stepLabel.toUpperCase()}`} value={stats ? fmtCount(peak) : null}
          color={SEV.green} sub={`busiest ${stepLabel} in range`} />
      </div>
      <div className="card">
        <div className="card-title">Log lines per {stepLabel}</div>
        <LineChart points={stats?.buckets.map((b) => b.lines) ?? null} labels={labels}
          color={SEV.cyan} fmt={fmtCount} />
      </div>
      <div className="card">
        <div className="card-title">Volume per {stepLabel}</div>
        <LineChart points={stats?.buckets.map((b) => b.bytes) ?? null} labels={labels}
          color={SEV.purple} fmt={fmtBytes} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- classifiers

const GRID = 'minmax(220px,2fr) 60px 150px 80px 70px 40px';

function Classifiers() {
  const app = useApp();
  const isAdmin = app.user?.role === 'admin';
  const [builtin, setBuiltin] = useState<ClassifierRule[] | null>(null);
  const [custom, setCustom] = useState<ClassifierRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<ClassifiersResponse>('/api/admin/pipeline/classifiers')
      .then((r) => { setBuiltin(r.builtin); setCustom(r.custom); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'network error'));
  }, []);

  const edit = (i: number, patch: Partial<ClassifierRule>) => {
    setCustom((cur) => cur.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setDirty(true); setSaved(false);
  };
  const add = () => {
    setCustom((cur) => [...cur, { pattern: '', flags: 'i', name: '', severity: 50, targetGroup: null }]);
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

      <div className="card">
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>Custom rules · this organization</span>
          {isAdmin && <button className="btn btn-sm" onClick={add}>+ Add rule</button>}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
          Evaluated before the built-ins, first match wins. Target group extracts a regex
          capture group (1-9) into the event target — it becomes part of the dedupe key.
        </div>
        {err && <div style={{ color: SEV.critical, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <TableScroll minWidth={680}>
          <div className="tbl-head" style={{ gridTemplateColumns: GRID, padding: '8px 0' }}>
            <span>Pattern (regex)</span><span>Flags</span><span>Event name</span>
            <span>Severity</span><span>Target</span><span></span>
          </div>
          {custom.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              No custom rules yet — only the built-ins below apply.
            </div>
          )}
          {custom.map((c, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8,
              padding: '5px 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <input className="mono" disabled={!isAdmin} value={c.pattern} placeholder="disk (full|usage)"
                style={{ fontSize: 11 }} onChange={(e) => edit(i, { pattern: e.target.value })} />
              <input className="mono" disabled={!isAdmin} value={c.flags ?? 'i'} placeholder="i"
                style={{ fontSize: 11 }} onChange={(e) => edit(i, { flags: e.target.value })} />
              <input className="mono" disabled={!isAdmin} value={c.name} placeholder="disk_full"
                style={{ fontSize: 11 }} onChange={(e) => edit(i, { name: e.target.value })} />
              <input className="mono" disabled={!isAdmin} value={String(c.severity)} inputMode="numeric"
                style={{ fontSize: 11, color: sevColor(c.severity) }}
                onChange={(e) => edit(i, { severity: parseInt(e.target.value, 10) || 0 })} />
              <input className="mono" disabled={!isAdmin} value={c.targetGroup ?? ''} placeholder="—"
                inputMode="numeric" style={{ fontSize: 11 }}
                onChange={(e) => edit(i, { targetGroup: e.target.value ? parseInt(e.target.value, 10) : null })} />
              <span>
                {isAdmin && <button title="Delete rule" style={{ color: SEV.critical, fontSize: 14 }}
                  onClick={() => remove(i)}>×</button>}
              </span>
            </div>
          ))}
        </TableScroll>
        {isAdmin && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 12, marginTop: 12 }}>
            {saved && <span style={{ color: SEV.green, fontSize: 12, fontWeight: 600 }}>saved ✓</span>}
            <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save Rules'}
            </button>
          </div>
        )}
        {!isAdmin && (
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8 }}>
            Only administrators can change classifier rules.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Built-in rules</div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
          Shipped with OpsCat, evaluated after your custom rules. Lines matching no rule fall
          back to their syslog severity (crit and above still become events).
        </div>
        {builtin === null && <TableSkeleton cols={GRID} rows={5} />}
        {builtin && (
          <TableScroll minWidth={640}>
            <div className="tbl-head" style={{ gridTemplateColumns: GRID, padding: '8px 0' }}>
              <span>Pattern (regex)</span><span>Flags</span><span>Event name</span>
              <span>Severity</span><span>Target</span><span></span>
            </div>
            {builtin.map((c) => (
              <div key={c.name + c.pattern} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8,
                padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text2)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.pattern}>{c.pattern}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>{c.flags}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text0)' }}>{c.name}</span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: sevColor(c.severity) }}>{c.severity}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>
                  {c.targetGroup ? `group ${c.targetGroup}` : '—'}</span>
                <span />
              </div>
            ))}
          </TableScroll>
        )}
      </div>
    </>
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
    <div className="card">
      <div className="card-title">Rule tester</div>
      <form onSubmit={run} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input required className="mono" value={line} onChange={(e) => setLine(e.target.value)}
          placeholder="paste a sample log line, e.g.  kernel: Out of memory: Killed process 1234 (node)"
          style={{ flex: 3, minWidth: 240, fontSize: 11 }} />
        <select value={sev} onChange={(e) => setSev(e.target.value)} style={{ width: 150 }}>
          {['0 emerg', '1 alert', '2 crit', '3 err', '4 warning', '5 notice', '6 info', '7 debug'].map((s) => (
            <option key={s} value={s.split(' ')[0]}>syslog {s}</option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? '…' : 'Test line'}</button>
      </form>
      {err && <div style={{ color: SEV.critical, fontSize: 11, marginTop: 8 }}>{err}</div>}
      {result && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 6,
          background: m ? alpha(sevColor(m.severity), 0.08) : 'var(--bg2)',
          border: `1px solid ${m ? alpha(sevColor(m.severity), 0.3) : 'var(--bg3)'}` }}>
          {m ? (
            <div className="mono" style={{ fontSize: 11, color: 'var(--text1)', display: 'flex',
              flexWrap: 'wrap', gap: 14 }}>
              <span>event <b style={{ color: 'var(--text0)' }}>{m.name}</b></span>
              <span>severity <b style={{ color: sevColor(m.severity) }}>{m.severity}</b></span>
              <span>target <b style={{ color: 'var(--text0)' }}>{m.target ?? '—'}</b></span>
              <span>matched by <b style={{ color: 'var(--text0)' }}>{m.source}</b>
                {m.pattern ? <span style={{ color: 'var(--text3)' }}> ({m.pattern})</span> : null}</span>
              <span style={{ color: m.severity >= result.caseThreshold ? SEV.high : 'var(--text3)' }}>
                {m.severity >= result.caseThreshold ? 'would open a case' : 'no case'}</span>
            </div>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>
              no match — the line is stored as a log only, no event is created
            </span>
          )}
        </div>
      )}
    </div>
  );
}
