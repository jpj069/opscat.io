// Shared UI atoms: severity badges, sparklines, avatars, toggles, charts.
import React from 'react';
import { SEV, sevBand, sevColor, sevLabel, alpha } from './format';
import markLight from './assets/opscat-mark.png';
import markDark from './assets/opscat-mark-dark.png';

// The OpsCat brand mark (transparent line art). Renders both stroke variants;
// tokens.css shows the one matching body[data-theme].
export function BrandMark({ size = 26 }: { size?: number }) {
  const s = { width: size, height: size, flexShrink: 0 } as const;
  return (
    <>
      <img src={markLight} alt="" className="brand-light" style={s} />
      <img src={markDark} alt="" className="brand-dark" style={s} />
    </>
  );
}

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

// value/sub = null → the card renders itself in loading state (same chrome,
// placeholder where the number goes). Pass the value only once it is known.
export function KpiCard({ label, value, color, spark, sub }:
  { label: string; value: string | null; color: string; spark?: number[] | null; sub?: string | null }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 150 }}>
      <div className="micro" style={{ fontSize: 9 }}>{label}</div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        {value == null
          ? <Skeleton w={76} h={26} radius={4} />
          : <span className="mono" style={{ fontSize: 26, fontWeight: 700, color }}>{value}</span>}
        {spark && <Spark data={spark} w={64} h={24} color={color} />}
      </div>
      {/* sub === null means "a sub-line is coming" → reserve it, no layout jump */}
      {sub === null
        ? <Skeleton w={54} h={9} style={{ marginTop: 7 }} />
        : sub && <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// Stacked area chart (event volume by severity band). data == null → loading.
export function StackedArea({ data, w = 460, h = 140 }:
  { data: { d: string; c: number; h: number; m: number; l: number }[] | null; w?: number; h?: number }) {
  if (data == null) return <ChartSkeleton h={h} />;
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

// points == null → loading (an empty array stays the honest "no data yet").
export function LineChart({ points, labels, color = SEV.green, w = 460, h = 140, fmt }:
  { points: number[] | null; labels?: string[]; color?: string; w?: number; h?: number;
    fmt?: (v: number) => string }) {
  if (points == null) return <ChartSkeleton h={h} />;
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
  { items: { n: string; v: number; c?: string }[] | null; color?: string; max?: number }) {
  if (items == null) return <BarsSkeleton />;
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

// Design-system standard: THE horizontal scroll container for wide tables.
// Wrap the whole table block (head + rows + empty states) in it. It keeps its
// intrinsic height, so it never introduces inner vertical scrolling — cards
// and pages themselves must never become scroll containers (that lets flex
// squeeze them to viewport height; see tokens.css).
export function TableScroll({ minWidth = 620, children }:
  { minWidth?: number; children: React.ReactNode }) {
  return (
    <div className="tbl-scroll">
      <div style={{ minWidth }}>{children}</div>
    </div>
  );
}

// Design-system standard: THE page header. Title left, actions right, and it
// WRAPS — a toolbar that cannot wrap pushes the whole page sideways on phones
// (a `<select>` fed by user data is the usual culprit; see tokens.css). Use this
// instead of hand-rolling `.row` + `.page-title` per page.
export function PageHeader({ title, children }:
  { title: string; children?: React.ReactNode }) {
  return (
    <div className="row row-wrap" style={{ justifyContent: 'space-between', gap: 10 }}>
      <h1 className="page-title">{title}</h1>
      {children && (
        <div className="row row-wrap" style={{ gap: 10, minWidth: 0 }}>{children}</div>
      )}
    </div>
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

// ---- synthetics atoms: cell states, tooltip, HeatBar, StatusBadge, grids ----

export type CellState = 'ok' | 'warn' | 'bad' | 'na';
export const CELL_COLOR: Record<CellState, string> = {
  ok: SEV.green, warn: SEV.medium, bad: SEV.critical, na: 'var(--bg3)',
};

// Rich hover tooltip, one instance app-wide: mount <TipHost /> once in the app
// shell; components call tip()/hideTip() from mouse handlers. Follows the
// cursor and clamps to the viewport — replaces the browser's title tooltip.
let setTipState: ((s: { x: number; y: number; node: React.ReactNode } | null) => void) | null = null;
export function TipHost() {
  const [s, setS] = React.useState<{ x: number; y: number; node: React.ReactNode } | null>(null);
  React.useEffect(() => { setTipState = setS; return () => { setTipState = null; }; }, []);
  if (!s) return null;
  const x = Math.min(s.x + 14, (window.innerWidth || 800) - 200);
  const y = Math.min(s.y + 14, (window.innerHeight || 600) - 96);
  return (
    <div style={{ position: 'fixed', left: x, top: y, zIndex: 200, pointerEvents: 'none',
      background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 6,
      padding: '8px 11px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 150, maxWidth: 260 }}>
      {s.node}
    </div>
  );
}
export const tip = (node: React.ReactNode) => (e: React.MouseEvent) =>
  setTipState?.({ x: e.clientX, y: e.clientY, node });
export const hideTip = () => setTipState?.(null);

// Standard tooltip body: name line with status dot, sub line, value line.
export function TipBody({ color, title, sub, value }:
  { color: string; title: React.ReactNode; sub?: React.ReactNode; value?: React.ReactNode }) {
  return (
    <>
      <div className="mono row" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text0)', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {title}
      </div>
      {sub && <div className="mono" style={{ fontSize: 9, color: 'var(--text2)', marginTop: 3 }}>{sub}</div>}
      {value && <div className="mono" style={{ fontSize: 10, marginTop: 5, color: 'var(--text1)' }}>{value}</div>}
    </>
  );
}

export interface HeatBucket { s: CellState; ms?: number | null; tip?: React.ReactNode }

// Uptime heat-bar. Flex segments always fill the container width, so the
// bucket count may vary per range (decision: 30min/1h/6h/12h → 30 buckets,
// 24h → 32×45min, 7d → 28×6h, 30d → 30×1d) — worst-status-wins per bucket.
export function HeatBar({ buckets, big = false }: { buckets: HeatBucket[]; big?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', width: '100%' }}>
      {buckets.map((b, i) => (
        <span key={i}
          onMouseEnter={b.tip ? tip(b.tip) : undefined}
          onMouseMove={b.tip ? tip(b.tip) : undefined}
          onMouseLeave={b.tip ? hideTip : undefined}
          style={{ flex: 1, height: big ? 18 : 14, borderRadius: 1.5, minWidth: 2,
            background: CELL_COLOR[b.s], opacity: b.s === 'ok' ? 0.85 : 1 }} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ skeletons
//
// Design-system rule: a skeleton is DERIVED, never hand-drawn. Each component
// below either reuses the very layout the loaded UI uses (the same
// `gridTemplateColumns` constant, the same `.tbl-row`/`.card` chrome, the same
// `Row` wrapper) or is deliberately field-agnostic (bars, lines, cards). That
// way a column added to a table or a field added to a form carries over on its
// own — there is no second copy of the layout to keep in sync.
//
// Convention across the app: `null` data = still loading, `[]` = loaded & empty.

export function Skeleton({ w = '100%', h = 10, radius = 3, style }:
  { w?: number | string; h?: number | string; radius?: number; style?: React.CSSProperties }) {
  return <span className="skel" aria-hidden="true"
    style={{ width: w, height: h, borderRadius: radius, ...style }} />;
}

// Marks a region as busy for screen readers — visual placeholders are aria-hidden.
// Exported so page-local skeletons (built from that page's own row/field
// components) get the same semantics without re-writing the label.
export function Busy({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}

// Check-type label with a status dot (Checks column of the synthetics table).
export function StatusBadge({ label, state }: { label: string; state: CellState }) {
  const c = CELL_COLOR[state];
  return (
    <span className="mono" style={{ background: state === 'na' ? 'var(--bg3)' : alpha(c, 0.1),
      display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 3,
      fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', color: 'var(--text1)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%',
        background: state === 'na' ? 'var(--text3)' : c, marginRight: 4, display: 'inline-block' }} />
      {label}
    </span>
  );
}

export interface GridCell { state: CellState; tip?: React.ReactNode; onClick?: () => void }

// Waffle status grid (GitHub-contribution style): one cell per entity. Cells
// flow with the container width and wrap into the next row (flex-wrap) — the
// 30+ sensor-agents view; table rows use small cells, detail views large ones.
export function StatusGrid({ cells, cell = 12, gap = 3 }:
  { cells: GridCell[]; cell?: number; gap?: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap }}>
      {cells.map((c, i) => (
        <span key={i}
          onMouseEnter={c.tip ? tip(c.tip) : undefined}
          onMouseMove={c.tip ? tip(c.tip) : undefined}
          onMouseLeave={c.tip ? hideTip : undefined}
          onClick={c.onClick}
          style={{ width: cell, height: cell, borderRadius: Math.max(1.5, cell / 6),
            background: CELL_COLOR[c.state], cursor: c.onClick ? 'pointer' : 'default' }} />
      ))}
    </div>
  );
}

// Honeycomb variant of StatusGrid: interlocking pointy-top hexagons. Column
// count is measured from the container width (and re-measured on resize), so
// the comb fills the available width and overflows into further rows. Row
// pitch is 3/4·h plus the gap projected on the hex diagonal, which keeps the
// spacing between all neighbouring cells visually equal.
export function Honeycomb({ cells, size = 22, gap = 2 }:
  { cells: GridCell[]; size?: number; gap?: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [cols, setCols] = React.useState(10);
  React.useLayoutEffect(() => {
    const measure = () => {
      const w = ref.current?.clientWidth || 0;
      // odd rows shift half a cell right, so reserve that half cell
      setCols(Math.max(1, Math.floor((w - (size + gap) / 2 + gap) / (size + gap))));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [size, gap]);
  const h = size * 1.1547; // pointy-top hexagon: height = width * 2/sqrt(3)
  const rowShift = -(h / 4) + gap * 0.866; // interlock rows, keep diagonal gap ≈ gap
  const rows: GridCell[][] = [];
  for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
  return (
    <div ref={ref} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      {rows.map((row, r) => (
        <div key={r} style={{ display: 'flex', gap,
          marginLeft: r % 2 === 1 ? (size + gap) / 2 : 0,
          marginTop: r > 0 ? rowShift : 0 }}>
          {row.map((c, i) => (
            <span key={i}
              onMouseEnter={c.tip ? tip(c.tip) : undefined}
              onMouseMove={c.tip ? tip(c.tip) : undefined}
              onMouseLeave={c.tip ? hideTip : undefined}
              onClick={c.onClick}
              style={{ width: size, height: h, background: CELL_COLOR[c.state], flexShrink: 0,
                clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)',
                cursor: c.onClick ? 'pointer' : 'default' }} />
          ))}
        </div>
      ))}
    </div>
  );
}

// Stable pseudo-random in [0,1) — placeholder widths vary per cell but never
// re-shuffle between renders (Math.random would flicker on every re-render).
function jitter(a: number, b: number): number {
  const n = Math.sin((a + 1) * 12.9898 + (b + 1) * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// Splits a grid-template-columns string into its tracks, respecting
// minmax()/clamp() parentheses so `minmax(150px,1.3fr)` stays one track.
function gridTracks(template: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of template.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// THE table placeholder: pass the same `gridTemplateColumns` string the head and
// the rows use, and the skeleton inherits the column count, widths and row
// metrics automatically. `flush` drops the horizontal row padding for tables
// that sit inside an already-padded card; `dense` matches log-density rows.
export function TableSkeleton({ cols, rows = 5, flush = false, dense = false }:
  { cols: string; rows?: number; flush?: boolean; dense?: boolean }) {
  const tracks = gridTracks(cols);
  const py = dense ? 'var(--log-py)' : 'var(--row-py)';
  return (
    <Busy>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="tbl-row" style={{ gridTemplateColumns: cols,
          padding: `${py} ${flush ? '0' : '16px'}` }}>
          {tracks.map((_t, c) => (
            // percentage width fits any track type (px, fr, minmax) — the grid
            // cell already carries the real column width
            <Skeleton key={c} w={`${Math.round((0.48 + jitter(r, c) * 0.38) * 100)}%`} />
          ))}
        </div>
      ))}
    </Busy>
  );
}

// Stacked text lines — for prose/detail blocks with no fixed field layout.
export function TextSkeleton({ lines = 3, w = '100%' }: { lines?: number; w?: number | string }) {
  return (
    <Busy>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} w={i === lines - 1 ? '55%' : w} />
        ))}
      </div>
    </Busy>
  );
}

// Chart placeholder — occupies exactly the height the chart will take, so the
// card does not resize when the data lands.
export function ChartSkeleton({ h = 140, bars = 14 }: { h?: number; bars?: number }) {
  return (
    <Busy>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: h, padding: '10px 0 16px' }}>
        {Array.from({ length: bars }, (_, i) => (
          <Skeleton key={i} w="100%" h={`${Math.round((0.25 + jitter(i, 7) * 0.7) * 100)}%`} radius={2}
            style={{ flex: 1 }} />
        ))}
      </div>
    </Busy>
  );
}

// Horizontal bar list — same three-part row layout HBars renders (label, bar, value).
export function BarsSkeleton({ rows = 5, labelW = 130 }: { rows?: number; labelW?: number }) {
  return (
    <Busy>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="row">
            <Skeleton w={Math.round(labelW * (0.5 + jitter(i, 3) * 0.45))} />
            <div style={{ flex: 1 }}><Skeleton h={8} radius={4} /></div>
            <Skeleton w={24} />
          </div>
        ))}
      </div>
    </Busy>
  );
}

// Generic stacked list (feed/master list items) — field-agnostic on purpose.
export function ListSkeleton({ rows = 4, lines = 2, divided = true }:
  { rows?: number; lines?: number; divided?: boolean }) {
  return (
    <Busy>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', flexDirection: 'column', gap: 7,
          padding: '11px 14px', borderBottom: divided ? '1px solid var(--bg3)' : undefined }}>
          {Array.from({ length: lines }, (_, l) => (
            <Skeleton key={l} w={`${Math.round((0.4 + jitter(r, l) * 0.5) * 100)}%`} />
          ))}
        </div>
      ))}
    </Busy>
  );
}

// Grid of card placeholders (tile rows that are not KPI cards).
export function CardsSkeleton({ count = 4, w = 150, h = 104 }:
  { count?: number; w?: number; h?: number }) {
  return (
    <Busy>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} style={{ width: w, height: h, background: 'var(--bg2)', borderRadius: 8,
            border: '1px solid var(--bg3)', padding: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
            <Skeleton w="60%" />
            <Skeleton w="45%" h={20} radius={4} />
            <Skeleton w="80%" h={8} />
          </div>
        ))}
      </div>
    </Busy>
  );
}
