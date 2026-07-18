// Synthetics — probe locations, latency chart, traceroute + checks management.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV } from '../format';
import { LineChart, Spark, GlowDot, StatusPill, Toggle, Modal, Field } from '../ui';
import type { SynthLocation, SynthCheck, SynthResult, SynthSeriesPoint } from '../types';

const CHECK_GRID = '110px 1fr 80px 90px 90px 120px';
const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };
const CHECK_TYPES: SynthCheck['type'][] = ['http', 'icmp', 'dns', 'tcp', 'traceroute'];
const PLACEHOLDER: Record<SynthCheck['type'], string> = {
  http: 'https://example.com/health',
  icmp: 'host.example.com',
  dns: 'example.com @ 8.8.8.8',
  tcp: 'host.example.com:443',
  traceroute: 'host.example.com',
};

type Hop = { hop: number; ip: string; ms: number | null };

export default function Synthetics() {
  const app = useApp();
  const [locations, setLocations] = useState<SynthLocation[] | null>(null);
  const [checks, setChecks] = useState<SynthCheck[] | null>(null);
  const [results, setResults] = useState<SynthResult[]>([]);
  const [series, setSeries] = useState<SynthSeriesPoint[]>([]);
  const [route, setRoute] = useState<Hop[]>([]);
  const [selCheck, setSelCheck] = useState<number | null>(null);
  const [selLoc, setSelLoc] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [tick, setTick] = useState(0);

  const canWrite = (ROLE_RANK[app.user?.role ?? ''] ?? 0) >= ROLE_RANK.lead; // lead+ (analyst = view only)

  const loadResults = () => api.get<{ latest: SynthResult[] }>('/api/synthetics/results')
    .then((r) => setResults(r.latest || [])).catch(() => { /* keep prior */ });
  const loadChecks = () => api.get<SynthCheck[]>('/api/synthetics/checks').then(setChecks).catch(() => setChecks([]));
  const loadLocations = () => api.get<SynthLocation[]>('/api/synthetics/locations')
    .then(setLocations).catch(() => setLocations([]));

  useEffect(() => { loadLocations(); loadChecks(); loadResults(); }, []);
  useEffect(() => {
    const iv = setInterval(() => { loadResults(); setTick((t) => t + 1); }, 30000);
    return () => clearInterval(iv);
  }, []);

  // default selections
  useEffect(() => {
    if (checks && selCheck == null) {
      const first = checks.find((c) => c.enabled) ?? checks[0];
      if (first) setSelCheck(first.id);
    }
  }, [checks]);
  useEffect(() => {
    if (locations && selLoc == null && locations.length) setSelLoc(locations[0].id);
  }, [locations]);

  // series for selected check × location
  useEffect(() => {
    if (selCheck == null || selLoc == null) { setSeries([]); return; }
    api.get<SynthSeriesPoint[]>(`/api/synthetics/results/series?checkId=${selCheck}&locationId=${selLoc}&hours=24`)
      .then(setSeries).catch(() => setSeries([]));
  }, [selCheck, selLoc, tick]);

  // traceroute for selected location
  useEffect(() => {
    if (selLoc == null) { setRoute([]); return; }
    api.get<any>(`/api/synthetics/results/route?locationId=${selLoc}`)
      .then((d) => setRoute(d?.hops ?? d?.meta?.hops ?? (Array.isArray(d) ? d : [])))
      .catch(() => setRoute([]));
  }, [selLoc, tick]);

  const runChecks = async () => {
    setRunning(true);
    try { await api.post('/api/synthetics/run'); await loadResults(); setTick((t) => t + 1); }
    finally { setRunning(false); }
  };
  const toggleCheck = async (c: SynthCheck) => {
    await api.patch(`/api/synthetics/checks/${c.id}`, { enabled: !c.enabled });
    loadChecks();
  };
  const removeCheck = async (c: SynthCheck) => {
    if (!window.confirm(`Delete ${c.type} check “${c.target}”?`)) return;
    await api.del(`/api/synthetics/checks/${c.id}`);
    loadChecks(); loadResults();
  };

  const enabledChecks = checks?.filter((c) => c.enabled) ?? [];
  const selectedCheck = checks?.find((c) => c.id === selCheck) ?? null;
  const selectedLoc = locations?.find((l) => l.id === selLoc) ?? null;

  const icmpIds = useMemo(
    () => new Set((checks ?? []).filter((c) => c.type === 'icmp').map((c) => c.id)),
    [checks],
  );
  const locResult = (locId: number): SynthResult | undefined => {
    const icmp = results.find((r) => r.locationId === locId && icmpIds.has(r.checkId));
    if (icmp) return icmp;
    if (selCheck != null) return results.find((r) => r.locationId === locId && r.checkId === selCheck);
    return undefined;
  };

  const seriesPts = series.filter((s) => s.latencyMs != null);
  const seriesVals = seriesPts.map((s) => s.latencyMs as number);
  const step = Math.max(1, Math.ceil(seriesPts.length / 5));
  const chartLabels = seriesPts.map((s, i) =>
    (i % step === 0 ? `${String(new Date(s.ts).getHours()).padStart(2, '0')}:00` : ''));

  const maxHop = Math.max(...route.map((h) => h.ms ?? 0), 1);

  return (
    <div className="page">
      {/* header */}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Synthetics</h1>
        <div className="row" style={{ gap: 10 }}>
          <select value={selCheck ?? ''} onChange={(e) => setSelCheck(Number(e.target.value))}
            style={{ fontSize: 11 }}>
            {enabledChecks.length === 0 && <option value="">no enabled checks</option>}
            {enabledChecks.map((c) => <option key={c.id} value={c.id}>{c.type} {c.target}</option>)}
          </select>
          {canWrite && (
            <button className="btn btn-primary" onClick={runChecks} disabled={running}>
              {running ? 'running…' : 'Run checks now'}
            </button>
          )}
        </div>
      </div>

      {/* location cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {locations === null && (
          <div className="mono" style={{ color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        )}
        {locations && locations.length === 0 && (
          <div style={{ color: 'var(--text3)', fontSize: 11 }}>No probe locations configured.</div>
        )}
        {locations?.map((loc) => {
          const res = locResult(loc.id);
          const ms = res?.latencyMs ?? null;
          const loss = res?.meta?.loss ?? 0;
          const jitter = res?.meta?.jitter;
          const active = loc.id === selLoc;
          const pingColor = ms == null ? 'var(--text3)' : loss > 1 ? SEV.critical : ms > 150 ? SEV.medium : SEV.green;
          return (
            <div key={loc.id} onClick={() => setSelLoc(loc.id)} style={{ width: 150, cursor: 'pointer',
              background: 'var(--bg2)', borderRadius: 8, padding: 12,
              border: active ? '1px solid #388bfd' : '1px solid var(--bg3)',
              boxShadow: active ? '0 0 0 1px rgba(56,139,253,0.35)' : undefined }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text0)' }}>{loc.city}</span>
                <span className="mono" style={{ fontSize: 9, color: 'var(--text2)', background: 'var(--bg3)',
                  padding: '1px 5px', borderRadius: 4 }}>{loc.cc}</span>
              </div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: pingColor, margin: '8px 0 2px' }}>
                {ms == null ? '—' : <>{Math.round(ms)}<span style={{ fontSize: 11, color: 'var(--text3)' }}> ms</span></>}
              </div>
              {active && seriesVals.length >= 2 && <Spark data={seriesVals} w={64} h={20} color={SEV.cyan} />}
              <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginTop: 4 }}>
                jitter {jitter != null ? jitter : '—'} · loss {loss}%
              </div>
              <div className="row" style={{ gap: 5, marginTop: 6 }}>
                <GlowDot color={loc.online ? SEV.green : 'var(--text3)'} size={7} />
                <span className="micro" style={{ fontSize: 8 }}>{loc.online ? 'online' : 'offline'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* latency chart + route */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: 1, minWidth: 320 }}>
          <div className="card-title">
            Latency 24h — {selectedCheck ? selectedCheck.target : '—'} from {selectedLoc ? selectedLoc.city : '—'}
          </div>
          <LineChart points={seriesVals} labels={chartLabels} color={SEV.cyan} fmt={(v) => `${Math.round(v)}ms`} />
        </div>
        <div className="card" style={{ flex: 1, minWidth: 320 }}>
          <div className="card-title">Route</div>
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
                    <div style={{ width: `${w}%`, height: '100%', background: last ? '#388bfd' : '#8b949e' }} />
                  </div>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text2)', width: 44, textAlign: 'right' }}>
                    {h.ms != null ? `${Math.round(h.ms)}ms` : '*'}</span>
                </div>
              );
            })}
        </div>
      </div>

      {/* checks table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="tbl-head" style={{ gridTemplateColumns: CHECK_GRID }}>
          <span>Type</span>
          <span>Target</span>
          <span>Interval</span>
          <span>Locations</span>
          <span>Status</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>
        {checks === null && (
          <div className="mono" style={{ padding: 20, color: 'var(--text3)', fontSize: 11 }}>loading…</div>
        )}
        {checks && checks.length === 0 && (
          <div style={{ padding: 20, color: 'var(--text3)', fontSize: 11 }}>No checks configured yet.</div>
        )}
        {checks?.map((c) => (
          <div key={c.id} className="tbl-row" style={{ gridTemplateColumns: CHECK_GRID }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text0)' }}>{c.type}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text1)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.target}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>{c.intervalS}s</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>{c.locations}</span>
            <StatusPill text={c.passing ? 'passing' : 'failing'} color={c.passing ? SEV.green : SEV.critical} />
            <span className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              {canWrite && <Toggle on={c.enabled} onClick={() => toggleCheck(c)} />}
              {canWrite && (
                <button className="btn btn-sm" title="Delete" onClick={() => removeCheck(c)}
                  style={{ color: '#f85149' }}>×</button>
              )}
            </span>
          </div>
        ))}
        {canWrite && (
          <div style={{ padding: '12px 16px' }}>
            <button className="btn btn-sm" onClick={() => setShowAdd(true)}>+ Add check</button>
          </div>
        )}
      </div>

      {showAdd && <AddCheckModal onClose={() => setShowAdd(false)}
        onAdded={() => { setShowAdd(false); loadChecks(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ add modal

function AddCheckModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [type, setType] = useState<SynthCheck['type']>('http');
  const [target, setTarget] = useState('');
  const [intervalS, setIntervalS] = useState(60);
  const [timeoutMs, setTimeoutMs] = useState(5000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/api/synthetics/checks', { type, target, intervalS, timeoutMs }); onAdded(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="Add check" onClose={onClose}>
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
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || !target}>{busy ? '…' : 'Add check'}</button>
      </form>
    </Modal>
  );
}
