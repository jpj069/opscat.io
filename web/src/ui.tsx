// Shared UI atoms: severity badges, sparklines, avatars, toggles, charts.
import React from 'react';
import { SEV, sevBand, sevColor, sevLabel, alpha } from './format';

export function SevBadge({ score }: { score: number }) {
  const c = sevColor(score);
  return (
    <span className="sev-badge" style={{ color: c, background: alpha(c, 0.12), border: `1px solid ${alpha(c, 0.3)}` }}>
      <span className="sev-dot" style={{ background: c }} />
      {sevLabel(score)}
    </span>
  );
}

export function StatusPill({ text, color }: { text: string; color: string }) {
  return (
    <span className="pill" style={{ color, background: alpha(color, 0.12), border: `1px solid ${alpha(color, 0.3)}` }}>
      {text}
    </span>
  );
}

export function Avatar({ i, c, size = 26 }: { i: string; c: string; size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `linear-gradient(135deg, ${c}, ${alpha(c, 0.6)})`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.max(8, size * 0.35), fontWeight: 600, color: '#fff',
      fontFamily: "'JetBrains Mono', monospace",
    }}>{i}</span>
  );
}

export function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`toggle ${on ? 'on' : ''}`} onClick={onClick} disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: 'default' } : undefined}>
      <span className="knob" />
    </button>
  );
}

export function Spark({ data, w = 56, h = 18, color = SEV.low, fill = true, dot = true }:
  { data: number[]; w?: number; h?: number; color?: string; fill?: boolean; dot?: boolean }) {
  if (!data || data.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...data); const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * (w - 2) + 1,
    h - 2 - ((v - min) / range) * (h - 4),
  ]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const poly = `1,${h - 1} ${line} ${w - 1},${h - 1}`;
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} style={{ display: 'block', flexShrink: 0 }}>
      {fill && <polygon points={poly} fill={alpha(color, 0.12)} />}
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.4} />
      {dot && <circle cx={last[0]} cy={last[1]} r={2} fill={color} />}
    </svg>
  );
}

export function KpiCard({ label, value, color, spark, sub }:
  { label: string; value: string; color: string; spark?: number[]; sub?: string }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 150 }}>
      <div className="micro" style={{ fontSize: 9 }}>{label}</div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <span className="mono" style={{ fontSize: 26, fontWeight: 700, color }}>{value}</span>
        {spark && <Spark data={spark} w={64} h={24} color={color} />}
      </div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// Stacked area chart (event volume by severity band).
export function StackedArea({ data, w = 460, h = 140 }:
  { data: { d: string; c: number; h: number; m: number; l: number }[]; w?: number; h?: number }) {
  if (!data.length) return <div style={{ color: 'var(--text3)', fontSize: 11 }}>no data yet</div>;
  const keys: ('l' | 'm' | 'h' | 'c')[] = ['l', 'm', 'h', 'c'];
  const colors = { l: SEV.low, m: SEV.medium, h: SEV.high, c: SEV.critical };
  const totals = data.map((r) => r.c + r.h + r.m + r.l);
  const max = Math.max(...totals, 1);
  const px = (i: number) => data.length === 1 ? w / 2 : (i / (data.length - 1)) * (w - 20) + 10;
  const py = (v: number) => h - 16 - (v / max) * (h - 26);
  let acc = data.map(() => 0);
  const layers = keys.map((k) => {
    const base = [...acc];
    acc = acc.map((a, i) => a + data[i][k]);
    const top = acc.map((v, i) => `${px(i)},${py(v)}`).join(' ');
    const bottom = base.map((v, i) => `${px(i)},${py(v)}`).reverse().join(' ');
    return { k, points: `${top} ${bottom}` };
  });
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {layers.map((l) => <polygon key={l.k} points={l.points} fill={alpha(colors[l.k], 0.18)}
        stroke={colors[l.k]} strokeWidth={1} />)}
      {data.map((r, i) => (
        <text key={i} x={px(i)} y={h - 3} textAnchor="middle" fontSize={8}
          fill="var(--text3)" fontFamily="'JetBrains Mono',monospace">{r.d.slice(5)}</text>
      ))}
    </svg>
  );
}

export function LineChart({ points, labels, color = SEV.green, w = 460, h = 140, fmt }:
  { points: number[]; labels?: string[]; color?: string; w?: number; h?: number; fmt?: (v: number) => string }) {
  if (!points.length) return <div style={{ color: 'var(--text3)', fontSize: 11 }}>no data yet</div>;
  const max = Math.max(...points, 1); const min = Math.min(...points, 0);
  const range = max - min || 1;
  const px = (i: number) => points.length === 1 ? w / 2 : (i / (points.length - 1)) * (w - 20) + 10;
  const py = (v: number) => h - 16 - ((v - min) / range) * (h - 30);
  const line = points.map((v, i) => `${px(i)},${py(v)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polygon points={`10,${h - 16} ${line} ${px(points.length - 1)},${h - 16}`} fill={alpha(color, 0.1)} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} />
      {points.map((v, i) => <circle key={i} cx={px(i)} cy={py(v)} r={2} fill={color} />)}
      {labels && labels.map((l, i) => (
        <text key={i} x={px(i)} y={h - 3} textAnchor="middle" fontSize={8}
          fill="var(--text3)" fontFamily="'JetBrains Mono',monospace">{l}</text>
      ))}
      <text x={10} y={10} fontSize={9} fill="var(--text2)" fontFamily="'JetBrains Mono',monospace">
        {fmt ? fmt(max) : max}
      </text>
    </svg>
  );
}

export function HBars({ items, color = SEV.low, max: maxOverride }:
  { items: { n: string; v: number; c?: string }[]; color?: string; max?: number }) {
  const max = maxOverride ?? Math.max(...items.map((i) => i.v), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.length === 0 && <div style={{ color: 'var(--text3)', fontSize: 11 }}>no data yet</div>}
      {items.map((it) => (
        <div key={it.n} className="row">
          <span className="mono" style={{ width: 130, fontSize: 10, color: 'var(--text1)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.n}</span>
          <div style={{ flex: 1, height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(it.v / max) * 100}%`, height: '100%', background: it.c || color }} />
          </div>
          <span className="mono" style={{ width: 40, fontSize: 10, color: 'var(--text2)', textAlign: 'right' }}>
            {it.v}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 420, hideClose = false }:
  { title: string; onClose: () => void; children: React.ReactNode; width?: number; hideClose?: boolean }) {
  return (
    <>
      <div className="overlay-dim" onClick={hideClose ? undefined : onClose} />
      <div style={{ position: 'fixed', top: '15%', left: '50%', transform: 'translateX(-50%)',
        width, maxWidth: '94vw', background: 'var(--bg1)', border: '1px solid var(--border)',
        borderRadius: 10, zIndex: 120, padding: 18, boxShadow: '0 16px 48px rgba(0,0,0,0.45)' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text0)' }}>{title}</span>
          {!hideClose && <button onClick={onClose} style={{ color: 'var(--text2)', fontSize: 16 }}>×</button>}
        </div>
        {children}
      </div>
    </>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
      <span className="micro" style={{ fontSize: 9 }}>{label}</span>
      {children}
    </label>
  );
}

export function GlowDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: color,
    boxShadow: `0 0 6px ${color}`, display: 'inline-block', flexShrink: 0 }} />;
}
