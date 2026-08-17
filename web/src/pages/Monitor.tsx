// Monitor — default screen: resizable split of live events + streaming logs.
import React, { useMemo, useRef, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, alpha, sevColor, age, fmtTime, logSevColor } from '../format';
import { Avatar, SevBadge, Spark, TableScroll, TableSkeleton, Input, COL} from '../ui';
import {
  ArrowDownIcon,
  CheckIcon,
  PanelLeftIcon,
  PanelTopIcon,
  SquareIcon,
} from 'lucide-react';

type Filter = 'all' | 'critical' | 'high' | 'medium' | 'low';
const BANDS: Record<Exclude<Filter, 'all'>, [number, number]> = {
  critical: [80, 101], high: [60, 80], medium: [40, 60], low: [20, 40],
};
// one source of truth per grid: the rows AND their loading placeholder read it
// finish/downgrade | severity | hits | sparkline | device + age | name + description |
// assignee. `actions` leads here rather than trails, which is fine — what is NOT
// fine is sizing it by content: `COL.actions` used to be `max-content`, and a track
// that measures its own cell resolves differently in the header than in the rows
// (they are separate grids). Two icon buttons measure 59px; the 84px track holds
// them with room, and holds the same width in the header.
const EVENT_COLS = [COL.actions, COL.status, COL.num, COL.spark,
  COL.text, COL.textWide, COL.tiny].join(' ');
// minmax, not 1fr: the real rows need the track to grow to the longest line
// (that is what makes the list scroll sideways), and the SKELETON needs it not
// to collapse to a bar's intrinsic width. One constant feeds both.
// grid-exempt LOG_COLS: a log stream, not a table. `max-content` sizes the scroller
// to the widest line on purpose, so the row borders span the full scrolled width.
const LOG_COLS = '64px 130px minmax(240px, max-content)';

export default function Monitor() {
  const app = useApp();
  const [layout, setLayout] = useState<'horizontal' | 'vertical' | 'events'>('horizontal');
  const [split, setSplit] = useState(58);
  const [filter, setFilter] = useState<Filter>('all');
  const [logQuery, setLogQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const events = useMemo(() => {
    if (filter === 'all') return app.events;
    const [lo, hi] = BANDS[filter];
    return app.events.filter((e) => e.severity >= lo && e.severity < hi);
  }, [app.events, filter]);

  const logs = useMemo(() => {
    if (!logQuery) return app.logs;
    try {
      const re = new RegExp(logQuery, 'i');
      return app.logs.filter((l) => re.test(l.line) || re.test(l.device));
    } catch {
      const q = logQuery.toLowerCase();
      return app.logs.filter((l) => l.line.toLowerCase().includes(q) || l.device.toLowerCase().includes(q));
    }
  }, [app.logs, logQuery]);

  // POINTER events, not mouse: with mousedown/mousemove the divider cannot be dragged
  // on a phone at all, so the split is frozen at whatever it was and the smaller pane
  // stays unusably short with no way to grow it. setPointerCapture keeps the drag
  // alive when the finger leaves the 5px bar, which it immediately does.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const vert = layout === 'vertical';
    const rect = wrapRef.current!.getBoundingClientRect();
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const frac = vert ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      setSplit(Math.min(80, Math.max(25, frac * 100)));
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  };

  const act = async (id: number, action: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.post(`/api/events/${id}/action`, { action });
    app.refreshEvents();
  };

  const eventsPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div className="row" style={{ padding: '10px 16px', gap: 6, flexShrink: 0 }}>
        {(['all', 'critical', 'high', 'medium', 'low'] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`}
            style={filter === f && f !== 'all' ? { color: SEV[f], borderColor: alpha(SEV[f], 0.5) } : undefined}
            onClick={() => setFilter(f)}>
            {f}{f !== 'all' && ` ${app.events.filter((e) => e.severity >= BANDS[f][0] && e.severity < BANDS[f][1]).length}`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span className="mono text-2xs text-text3">{events.length} events</span>
      </div>
      {/* Vertical on the outside, horizontal inside TableScroll. EVENT_COLS is ~552px
          at its minimum, so on a 390px phone this list DOES overflow — it used to scroll
          sideways anyway (overflow-y: auto computes overflow-x to auto next to it) but
          with no fade and no affordance, so it read as clipped. */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        <TableScroll cols={EVENT_COLS} minWidth={620}>
        {app.eventsLoading && <TableSkeleton rows={7} />}
        {!app.eventsLoading && events.length === 0 && (
          <div className="text-text3 text-sm" style={{ padding: 40, textAlign: 'center'}}>
            No active events{filter !== 'all' ? ` in band "${filter}"` : ''} — all quiet.
          </div>
        )}
        {events.map((e) => {
          const c = sevColor(e.severity);
          const selected = app.selectedEvent === e.id;
          return (
            <div key={e.id} className="tbl-row" onClick={() => app.setSelectedEvent(e.id)}
              style={{ cursor: 'pointer',
                borderLeft: selected ? `2px solid ${c}` : '2px solid transparent',
                background: selected ? alpha(c, 0.06) : undefined }}>
              <span className="row" style={{ gap: 4 }}>
                <button title="Finish" aria-label="Finish" onClick={(ev) => act(e.id, 'finish', ev)}
                  style={{ color: SEV.green, opacity: 0.7, display: 'inline-flex' }}>
                  <CheckIcon size={14} /></button>
                <button title="Downgrade" aria-label="Downgrade" onClick={(ev) => act(e.id, 'downgrade', ev)}
                  style={{ color: SEV.medium, opacity: 0.7, display: 'inline-flex' }}>
                  <ArrowDownIcon size={14} /></button>
              </span>
              <SevBadge score={e.severity} />
              <span className="mono text-sm font-semibold text-text0" style={{
                textAlign: 'right' }}>{e.hits}</span>
              <Spark data={e.spark} color={c} />
              <span style={{ minWidth: 0 }}>
                <span className="mono text-sm text-text0" style={{ display: 'block',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.device}</span>
                <span className="mono text-2xs text-text3">
                  {age(Date.now() - e.lastSeen)} / {age(Date.now() - e.firstSeen)}</span>
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="mono text-sm font-semibold" style={{ color: c, display: 'block' }}>
                  {e.name}</span>
                <span className="text-xs text-text2" style={{ display: 'block', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description}</span>
              </span>
              {e.assigned
                ? <Avatar i={e.assigned.i} c={e.assigned.c} size={22} />
                : <span style={{ width: 22, height: 22, borderRadius: '50%',
                    border: '1px dashed var(--border)' }} />}
            </div>
          );
        })}
        </TableScroll>
      </div>
    </div>
  );

  const logsPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div className="row" style={{ padding: '8px 16px', gap: 8, flexShrink: 0,
        borderBottom: '1px solid var(--bg3)' }}>
        <span className="row" style={{ gap: 5 }}>
          <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: SEV.green }} />
          <span className="micro text-2xs">LIVE LOGS</span>
        </span>
        {/* no inline font-size on a form control: an inline style beats the media query
            that lifts inputs to 16px on phones, and below 16px iOS zooms the page on
            focus. Density comes from the padding. */}
        <Input value={logQuery} onChange={(e) => setLogQuery(e.target.value)}
          placeholder="filter (regex)…" style={{ flex: 1, maxWidth: 280, padding: '3px 8px' }} />
        <span className="mono text-2xs text-text3">{logs.length}</span>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column-reverse' }}>
        <div>
          {/* One log line, one row — it scrolls sideways to the end instead of wrapping
              into four. Wrapping kept every character on screen but destroyed the
              column rhythm the timestamp and device columns exist for, and a 300-char
              syslog line pushed the next entry a screen further down. `fit` sizes the
              scroller to the widest line so borders span the whole scrolled width. */}
          {/* peek off: the nudge animation is an affordance for a static table; on a
              stream that appends a row a second it reads as the list twitching. */}
          <TableScroll cols={LOG_COLS} fit peek={false}>
          {app.logsLoading && <TableSkeleton rows={10} dense />}
          {logs.map((l, i) => (
            <div key={i} className="tbl-row" style={{ gap: 10, padding: 'var(--log-py) 16px' }}>
              <span className="mono text-xs text-text3">{fmtTime(l.ts)}</span>
              <span className="mono text-xs text-text1" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.device}</span>
              <span className="mono text-xs" style={{ color: logSevColor(l.sev),
                whiteSpace: 'nowrap' }}>{l.line}</span>
            </div>
          ))}
          </TableScroll>
        </div>
      </div>
    </div>
  );

  const vert = layout === 'vertical';
  return (
    <div className="page-console" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ padding: '10px 16px 0', gap: 6 }}>
        <span className="micro text-2xs">LAYOUT</span>
        {([['horizontal', PanelTopIcon], ['vertical', PanelLeftIcon], ['events', SquareIcon]] as const).map(([l, Icon]) => (
          <button key={l} className={`chip ${layout === l ? 'active' : ''}`} title={l}
            style={{ display: 'inline-flex', alignItems: 'center' }}
            onClick={() => setLayout(l)}><Icon size={11} /></button>
        ))}
      </div>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, display: 'flex',
        flexDirection: vert ? 'row' : 'column', padding: '8px 0 0' }}>
        <div style={{ [vert ? 'width' : 'height']: layout === 'events' ? '100%' : `${split}%`,
          display: 'flex', minHeight: 0, minWidth: 0 } as React.CSSProperties}>
          {eventsPanel}
        </div>
        {layout !== 'events' && (
          <>
            <div onPointerDown={startDrag} className="split-bar" role="separator"
              aria-label="Resize panels"
              style={{ cursor: vert ? 'col-resize' : 'row-resize',
                [vert ? 'width' : 'height']: 5 } as React.CSSProperties} />
            <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>{logsPanel}</div>
          </>
        )}
      </div>
    </div>
  );
}
