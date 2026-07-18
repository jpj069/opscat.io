// Monitor — default screen: resizable split of live events + streaming logs.
import React, { useMemo, useRef, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, alpha, sevColor, age, fmtTime, logSevColor } from '../format';
import { Avatar, SevBadge, Spark } from '../ui';

type Filter = 'all' | 'critical' | 'high' | 'medium' | 'low';
const BANDS: Record<Exclude<Filter, 'all'>, [number, number]> = {
  critical: [80, 101], high: [60, 80], medium: [40, 60], low: [20, 40],
};

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

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const vert = layout === 'vertical';
    const rect = wrapRef.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const frac = vert ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      setSplit(Math.min(80, Math.max(25, frac * 100)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
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
        <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>{events.length} events</span>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {events.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>
            No active events{filter !== 'all' ? ` in band "${filter}"` : ''} — all quiet. 🐈
          </div>
        )}
        {events.map((e) => {
          const c = sevColor(e.severity);
          const selected = app.selectedEvent === e.id;
          return (
            <div key={e.id} onClick={() => app.setSelectedEvent(e.id)}
              style={{ display: 'grid', cursor: 'pointer', alignItems: 'center',
                gridTemplateColumns: '44px 86px 52px 60px minmax(120px,0.8fr) minmax(160px,1.2fr) 30px',
                gap: 8, padding: 'var(--row-py) 16px', borderBottom: '1px solid var(--bg3)',
                borderLeft: selected ? `2px solid ${c}` : '2px solid transparent',
                background: selected ? alpha(c, 0.06) : undefined }}>
              <span className="row" style={{ gap: 4 }}>
                <button title="Finish" onClick={(ev) => act(e.id, 'finish', ev)}
                  style={{ color: SEV.green, fontSize: 11, opacity: 0.7 }}>✓</button>
                <button title="Downgrade" onClick={(ev) => act(e.id, 'downgrade', ev)}
                  style={{ color: SEV.medium, fontSize: 11, opacity: 0.7 }}>↓</button>
              </span>
              <SevBadge score={e.severity} />
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text0)',
                textAlign: 'right' }}>{e.hits}</span>
              <Spark data={e.spark} color={c} />
              <span style={{ minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text0)', display: 'block',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.device}</span>
                <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>
                  {age(Date.now() - e.lastSeen)} / {age(Date.now() - e.firstSeen)}</span>
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: c, display: 'block' }}>
                  {e.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text2)', display: 'block', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description}</span>
              </span>
              {e.assigned
                ? <Avatar i={e.assigned.i} c={e.assigned.c} size={22} />
                : <span style={{ width: 22, height: 22, borderRadius: '50%',
                    border: '1px dashed var(--border)' }} />}
            </div>
          );
        })}
      </div>
    </div>
  );

  const logsPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div className="row" style={{ padding: '8px 16px', gap: 8, flexShrink: 0,
        borderBottom: '1px solid var(--bg3)' }}>
        <span className="row" style={{ gap: 5 }}>
          <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: SEV.green }} />
          <span className="micro" style={{ fontSize: 9 }}>LIVE LOGS</span>
        </span>
        <input value={logQuery} onChange={(e) => setLogQuery(e.target.value)}
          placeholder="filter (regex)…" style={{ flex: 1, maxWidth: 280, padding: '3px 8px', fontSize: 11 }} />
        <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>{logs.length}</span>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column-reverse' }}>
        <div>
          {logs.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '64px 130px 1fr', gap: 10,
              padding: 'var(--log-py) 16px', borderBottom: '1px solid var(--bg3)' }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtTime(l.ts)}</span>
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

  const vert = layout === 'vertical';
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ padding: '10px 16px 0', gap: 6 }}>
        <span className="micro" style={{ fontSize: 9 }}>LAYOUT</span>
        {([['horizontal', '⬒'], ['vertical', '◧'], ['events', '▢']] as const).map(([l, icon]) => (
          <button key={l} className={`chip ${layout === l ? 'active' : ''}`} title={l}
            onClick={() => setLayout(l)}>{icon}</button>
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
            <div onMouseDown={startDrag} style={{ flexShrink: 0, background: 'var(--bg3)',
              cursor: vert ? 'col-resize' : 'row-resize',
              [vert ? 'width' : 'height']: 5 } as React.CSSProperties} />
            <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>{logsPanel}</div>
          </>
        )}
      </div>
    </div>
  );
}
