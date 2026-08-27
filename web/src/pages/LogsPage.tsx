// LogsPage — historical log search with regex filter and live tail for short windows.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useQueryState } from '../state';
import { api } from '../api';
import { SEV, alpha, fmtDateTime, fmtHistory, logSevColor } from '../format';
import { Card, Button, TableSkeleton, PageHeader, Input, COL} from '../ui';
import { Select } from '../Select';
import type { LogRow } from '../types';

const HOURS = [1, 2, 6, 12, 24];
// q = the regex/substring filter, from/to = an ABSOLUTE window a link can name
// (Scout's template, a spike dragged over on the throughput chart)
const LOG_PARAMS = ['q', 'from', 'to', 'hours'] as const;
// Time | Device | Line
const COLS = [COL.time, COL.text, COL.textWide].join(' ');

export default function LogsPage() {
  const app = useApp();
  const [params, setParams] = useQueryState(LOG_PARAMS);
  const filter = params.q || '';
  const from = Number(params.from) || 0;
  const to = Number(params.to) || 0;
  const windowed = from > 0;
  const hours = Number(params.hours) || 2;
  const [fetched, setFetched] = useState<LogRow[] | null>(null);

  useEffect(() => {
    setFetched(null);
    // The server narrows by substring; the client then applies the same string as a
    // REGEX over what came back. Sending it as `q` too is what makes a filtered deep
    // link work at all — without it the window's first 1000 lines are fetched and
    // the interesting ones may not be among them.
    const qs = windowed
      ? `from=${from}&to=${to || Date.now()}`
      : `hours=${hours}`;
    const search = filter.trim() ? `&q=${encodeURIComponent(filter.trim())}` : '';
    api.get<LogRow[]>(`/api/logs?${qs}&limit=1000${search}`)
      .then(setFetched).catch(() => setFetched([]));
  }, [hours, from, to, windowed, filter]);

  // Live tail only for a short RELATIVE window with no filter — a named window in
  // the past cannot grow, and merging the live stream into it would show lines from
  // outside the very span the link was about.
  const liveMerge = !windowed && hours <= 2 && !filter.trim();

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
        {windowed ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="pill mono text-xs" style={{ color: SEV.cyan,
              background: alpha(SEV.cyan, 0.12), border: `1px solid ${alpha(SEV.cyan, 0.3)}` }}>
              {fmtHistory(from)} — {to ? fmtHistory(to) : 'now'}
            </span>
            <Button size="sm" onClick={() => setParams({ from: null, to: null })}>Clear window</Button>
          </span>
        ) : (
          <Select title="Time range" value={String(hours)}
            onChange={(v) => setParams({ hours: v })}
            options={HOURS.map((h) => ({ value: String(h), label: `${h} h` }))} />
        )}
        <Input value={filter} onChange={(e) => setParams({ q: e.target.value })}
          placeholder="filter (regex)…" style={{ flex: '1 1 150px', maxWidth: 400 }} />
        <Button size="sm" onClick={() => setParams({ q: null })}>Clear</Button>
        <div style={{ flex: 1 }} />
        <span className="mono text-xs text-text3">{rows.length} lines</span>
      </div>

      <Card style={{ flex: 1, minHeight: 0, padding: 0, display: 'flex',
        flexDirection: 'column', overflow: 'hidden' }}>
        {/* the ONE horizontal scroller for this table (design-system TableScroll):
            head + rows scroll sideways together, rows scroll vertically inside */}
        <div className="tbl-scroll" style={{ flex: 1, minHeight: 0, display: 'flex',
          flexDirection: 'column' }}>
        {/* --tbl-cols once, here, for the head AND the rows below it. This table
            cannot use `TableScroll`/subgrid: its rows scroll vertically inside their
            own box, so head and rows are not siblings of one grid. The variable still
            gives them one definition, which is the half that was drifting. */}
        <div style={{ minWidth: 620, flex: 1, minHeight: 0, display: 'flex',
          flexDirection: 'column', ['--tbl-cols' as string]: COLS }}>
        <div className="tbl-head">
          <span>Time</span><span>Device</span><span>Line</span>
        </div>
        <div className="fill-scroll">
          {!fetched ? (
            <TableSkeleton rows={14} dense />
          ) : rows.length === 0 ? (
            <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center'}}>
              {filter.trim() ? 'no matching log lines' : 'no logs in window'}
              {/* A named window in the past can be empty simply because the lines
                  aged out — log retention defaults to 7 days. Saying so beats an
                  empty table that reads like a broken link. */}
              {windowed && from < Date.now() - 86400000 && (
                <div className="text-xs" style={{ marginTop: 6 }}>
                  This window is older than a day — the lines may have passed the
                  retention period.
                </div>
              )}
            </div>
          ) : rows.map((l, i) => (
            <div key={`${l.ts}-${i}`} className="tbl-row" style={{ padding: 'var(--log-py) 16px' }}>
              <span className="mono text-xs text-text3">{fmtDateTime(l.ts)}</span>
              {/* The device is the one field on a log line that is worth narrowing to,
                  and it is already the search the box would run — so it is a button
                  rather than a new panel. A log line has no id and no record behind
                  it, so there is nothing a flyout could show that this row does not
                  already print in full. */}
              <button className="mono text-xs text-text1 link-cell" title={`Only ${l.device}`}
                onClick={() => setParams({ q: l.device })}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textAlign: 'left' }}>{l.device}</button>
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
