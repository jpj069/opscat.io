// LogsPage — historical log search with regex filter and live tail for short windows.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { fmtDateTime, logSevColor } from '../format';
import { Card, Button, TableSkeleton, PageHeader, Input, COL} from '../ui';
import { Select } from '../Select';
import type { LogRow } from '../types';

const HOURS = [1, 2, 6, 12, 24];
// Time | Device | Line
const COLS = [COL.time, COL.text, COL.textWide].join(' ');

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
    <div className="page-fill" style={{ padding: '20px 24px', gap: 14 }}>
      <PageHeader title="Logs" />

      <div className="row row-wrap" style={{ gap: 10 }}>
        <Select title="Time range" value={String(hours)} onChange={(v) => setHours(Number(v))}
          options={HOURS.map((h) => ({ value: String(h), label: `${h} h` }))} />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter (regex)…"
          style={{ flex: '1 1 150px', maxWidth: 400 }} />
        <Button size="sm" onClick={() => setFilter('')}>Clear</Button>
        <div style={{ flex: 1 }} />
        <span className="mono text-xs text-text3">{rows.length} lines</span>
      </div>

      <Card style={{ flex: 1, minHeight: 0, padding: 0, display: 'flex',
        flexDirection: 'column', overflow: 'hidden' }}>
        {/* the ONE horizontal scroller for this table (design-system TableScroll):
            head + rows scroll sideways together, rows scroll vertically inside */}
        <div className="tbl-scroll" style={{ flex: 1, minHeight: 0, display: 'flex',
          flexDirection: 'column' }}>
        <div style={{ minWidth: 620, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="tbl-head" style={{ gridTemplateColumns: COLS }}>
          <span>Time</span><span>Device</span><span>Line</span>
        </div>
        <div className="fill-scroll">
          {!fetched ? (
            <TableSkeleton cols={COLS} rows={14} dense />
          ) : rows.length === 0 ? (
            <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center'}}>
              {filter.trim() ? 'no matching log lines' : 'no logs in window'}
            </div>
          ) : rows.map((l, i) => (
            <div key={`${l.ts}-${i}`} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8,
              padding: 'var(--log-py) 16px', borderBottom: '1px solid var(--bg3)' }}>
              <span className="mono text-xs text-text3">{fmtDateTime(l.ts)}</span>
              <span className="mono text-xs text-text1" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.device}</span>
              <span className="mono text-xs" style={{ color: logSevColor(l.sev), wordBreak: 'break-all' }}>
                {l.line}</span>
            </div>
          ))}
        </div>
        </div>
        </div>
      </Card>
    </div>
  );
}
