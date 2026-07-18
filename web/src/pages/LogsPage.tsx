// LogsPage — historical log search with regex filter and live tail for short windows.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { fmtDateTime, logSevColor } from '../format';
import type { LogRow } from '../types';

const HOURS = [1, 2, 6, 12, 24];
const COLS = '150px 150px 1fr';

export default function LogsPage() {
  const app = useApp();
  const [hours, setHours] = useState(2);
  const [filter, setFilter] = useState('');
  const [fetched, setFetched] = useState<LogRow[] | null>(null);

  useEffect(() => {
    setFetched(null);
    api.get<LogRow[]>(`/api/logs?hours=${hours}&limit=1000`).then(setFetched).catch(() => setFetched([]));
  }, [hours]);

  // For short windows with no active filter, merge in the live stream.
  const liveMerge = hours <= 2 && !filter.trim();

  const base = useMemo(() => {
    const src = fetched || [];
    if (!liveMerge) return src;
    const seen = new Set<string>();
    const out: LogRow[] = [];
    for (const l of [...src, ...app.logs]) {
      const k = `${l.ts}|${l.line}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push(l);
    }
    return out;
  }, [fetched, app.logs, liveMerge]);

  const rows = useMemo(() => {
    let list = base;
    const q = filter.trim();
    if (q) {
      try {
        const re = new RegExp(q, 'i');
        list = list.filter((l) => re.test(l.line) || re.test(l.device));
      } catch {
        const lq = q.toLowerCase();
        list = list.filter((l) => l.line.toLowerCase().includes(lq) || l.device.toLowerCase().includes(lq));
      }
    }
    return [...list].sort((a, b) => b.ts - a.ts).slice(0, 1500);
  }, [base, filter]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '20px 24px', gap: 14 }}>
      <h1 className="page-title">Logs</h1>

      <div className="row" style={{ gap: 10 }}>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {HOURS.map((h) => <option key={h} value={h}>{h} h</option>)}
        </select>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter (regex)…"
          style={{ flex: 1, maxWidth: 400 }} />
        <button className="btn btn-sm" onClick={() => setFilter('')}>Clear</button>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>{rows.length} lines</span>
      </div>

      <div className="card" style={{ flex: 1, minHeight: 0, padding: 0, display: 'flex',
        flexDirection: 'column', overflow: 'hidden' }}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Time</span><span>Device</span><span>Line</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {!fetched ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
              {filter.trim() ? 'no matching log lines' : 'no logs in window'}
            </div>
          ) : rows.map((l, i) => (
            <div key={`${l.ts}-${i}`} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8,
              padding: 'var(--log-py) 16px', borderBottom: '1px solid var(--bg3)' }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtDateTime(l.ts)}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text1)', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.device}</span>
              <span className="mono" style={{ fontSize: 10, color: logSevColor(l.sev), wordBreak: 'break-all' }}>
                {l.line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
