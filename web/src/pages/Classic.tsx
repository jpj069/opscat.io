// Classic — terminal recreation of the legacy CTO monitoring view.
// Uses its OWN palette (NOT the app tokens), per the design handoff.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { age, fmtDateTime } from '../format';

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function palette(theme: string) {
  if (theme === 'light') {
    return {
      bg: '#fbfbf8', logs: '#1e7a1e', text: '#2a2a2a', head: '#000',
      sev: { red: '#c0362f', orange: '#b56200', yellow: '#8f7500' },
    };
  }
  return {
    bg: '#000', logs: '#6cae6c', text: '#c8c8c8', head: '#fff',
    sev: { red: '#ff5f56', orange: '#ff9f45', yellow: '#d4a72c' },
  };
}

const EVENT_COLS = '40px 128px 8ch minmax(90px,150px) 1fr';

export default function Classic() {
  const app = useApp();
  const pal = palette(app.theme);
  const [orient, setOrient] = useState<'horizontal' | 'vertical'>('horizontal');
  const [split, setSplit] = useState(50);
  const [full, setFull] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fullscreen: Esc exits.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const ql = q.trim().toLowerCase();
  const logs = useMemo(() => {
    if (!ql) return app.logs;
    return app.logs.filter((l) =>
      l.line.toLowerCase().includes(ql) || l.device.toLowerCase().includes(ql));
  }, [app.logs, ql]);
  const events = useMemo(() => {
    if (!ql) return app.events;
    return app.events.filter((e) =>
      `${e.name} ${e.device} ${e.target ?? ''} ${e.description ?? ''}`.toLowerCase().includes(ql));
  }, [app.events, ql]);

  const sevTone = (sev: number) =>
    sev >= 80 ? pal.sev.red : sev >= 60 ? pal.sev.orange : pal.sev.yellow;

  const act = async (id: number, action: 'finish' | 'downgrade', e: React.MouseEvent) => {
    e.stopPropagation();
    try { await api.post(`/api/events/${id}/action`, { action }); app.refreshEvents(); }
    catch { /* session gone / already actioned */ }
  };

  const vert = orient === 'vertical';
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = wrapRef.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const frac = vert ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      setSplit(Math.min(80, Math.max(20, frac * 100)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const iconBtn: React.CSSProperties = {
    width: 14, height: 14, borderRadius: '50%', border: '1px solid currentColor',
    background: 'transparent', color: 'currentColor', fontSize: 9, lineHeight: '12px',
    padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  };
  const headStyle: React.CSSProperties = {
    color: pal.head, borderBottom: `1px solid ${pal.head}`, fontWeight: 700,
    whiteSpace: 'pre', flexShrink: 0,
  };
  const txtBtn = (active: boolean): React.CSSProperties => ({
    color: active ? pal.head : pal.text, fontFamily: MONO, fontSize: 12,
    background: 'transparent', padding: '1px 3px', fontWeight: active ? 700 : 400,
  });
  const termInput: React.CSSProperties = {
    background: 'transparent', color: pal.text, border: `1px solid ${pal.text}`,
    borderRadius: 0, fontFamily: MONO, fontSize: 12, padding: '2px 6px',
  };

  const logsPane = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div style={{ ...headStyle, padding: '2px 8px 3px' }}>=== LOGS ===</div>
      <div style={{ overflow: 'auto', flex: 1, lineHeight: 1.28 }}>
        {logs.length === 0 && (
          <div style={{ padding: 8, color: pal.text, opacity: 0.6 }}>
            {ql ? 'no matching log lines' : 'waiting for log stream…'}
          </div>
        )}
        {logs.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 130px 1fr', gap: 8,
            padding: '0 8px', color: pal.logs }}>
            <span>{fmtDateTime(l.ts)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.device}</span>
            <span style={{ wordBreak: 'break-all' }}>{l.line}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const eventsPane = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div style={{ ...headStyle, display: 'grid', gridTemplateColumns: EVENT_COLS, gap: 8,
        padding: '2px 8px 3px' }}>
        <span />
        <span>AGE / TOTAL</span>
        <span style={{ textAlign: 'right' }}>HITS</span>
        <span>DEVICE</span>
        <span>EVENT</span>
      </div>
      <div style={{ overflow: 'auto', flex: 1, lineHeight: 1.42 }}>
        {events.length === 0 && (
          <div style={{ padding: 8, color: pal.text, opacity: 0.6 }}>
            {ql ? 'no matching events' : 'no active events — all quiet'}
          </div>
        )}
        {events.map((e) => {
          const c = sevTone(e.severity);
          return (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: EVENT_COLS, gap: 8,
              padding: '0 8px', color: c, alignItems: 'baseline' }}>
              <span style={{ display: 'inline-flex', gap: 4, alignSelf: 'center' }}>
                <button title="finish" onClick={(ev) => act(e.id, 'finish', ev)} style={iconBtn}>✓</button>
                <button title="downgrade" onClick={(ev) => act(e.id, 'downgrade', ev)} style={iconBtn}>↓</button>
              </span>
              <span>{age(Date.now() - e.lastSeen)} / {age(Date.now() - e.firstSeen)}</span>
              <span style={{ textAlign: 'right' }}>{e.hits}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.device}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.name}{e.target ? ` ${e.target}` : ''}{e.description ? ` (${e.description})` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{
      position: full ? 'fixed' : 'relative', inset: full ? 0 : undefined,
      zIndex: full ? 9999 : undefined, height: '100%', width: full ? '100%' : undefined,
      background: pal.bg, color: pal.text, fontFamily: MONO, fontSize: 12,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* in-screen topbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
        borderBottom: `1px solid ${pal.head}`, flexShrink: 0 }}>
        <span style={{ color: pal.logs, textDecoration: 'underline', cursor: 'pointer' }}>cl</span>
        <span style={{ color: pal.logs, textDecoration: 'underline', cursor: 'pointer' }}>ed</span>
        <select value={app.settings.backend_label || 'backend'} onChange={() => { /* single option */ }}
          style={termInput}>
          <option>{app.settings.backend_label || 'backend'}</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…"
          style={{ ...termInput, flex: 1, maxWidth: 320 }} />
        <div style={{ flex: 1 }} />
        <button onClick={() => setOrient('horizontal')} style={txtBtn(orient === 'horizontal')} title="stacked">[H]</button>
        <button onClick={() => setOrient('vertical')} style={txtBtn(orient === 'vertical')} title="side-by-side">[V]</button>
        <button onClick={() => setFull((f) => !f)} style={txtBtn(full)} title="fullscreen">[F]</button>
      </div>

      {/* split panes: logs over events (horizontal) / side-by-side (vertical) */}
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, display: 'flex',
        flexDirection: vert ? 'row' : 'column' }}>
        <div style={{ [vert ? 'width' : 'height']: `${split}%`,
          display: 'flex', minHeight: 0, minWidth: 0 } as React.CSSProperties}>
          {logsPane}
        </div>
        <div onMouseDown={startDrag} style={{ flexShrink: 0, background: pal.head, opacity: 0.35,
          cursor: vert ? 'col-resize' : 'row-resize',
          [vert ? 'width' : 'height']: 5 } as React.CSSProperties} />
        <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>{eventsPane}</div>
      </div>
    </div>
  );
}
