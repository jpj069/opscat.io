// Shared UI atoms: severity badges, sparklines, avatars, toggles, charts.
import React from 'react';
import { SEV, sevBand, sevColor, sevLabel, alpha } from './format';
import { HAS_POPOVER, topLayer } from './toplayer';
import markLight from './assets/opscat-mark.png';
import markDark from './assets/opscat-mark-dark.png';
import { XIcon } from 'lucide-react';

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

/**
 * Initials in a coloured disc. ONE size knob: everything else — the circle, the type
 * size, the centring — comes from `.avatar` in tokens.css, so a 16px avatar and a 28px
 * one are the same picture at two scales.
 *
 * It was computed inline here before, and neither half survived measuring: the
 * `Math.max(8, size * 0.35)` clamp meant a 16px avatar drew its initials at 0.50 of
 * the box while a 26px one used 0.35 (so the small one read as cramped and lopsided),
 * and the inherited 1.5 line-height centred the text by its LINE BOX rather than its
 * ink, leaving the letters ~1.7px high in a 16px avatar — measured in pixels.
 *
 * The initials are SVG for that second reason. HTML can only centre a LINE box, and a
 * line box is ascent + descent — but initials are capitals with nothing below the
 * baseline, so centring the box always leaves the letters sitting high. A `viewBox`
 * also turns the geometry into a ratio rather than a pixel count, so every size is
 * literally the same picture.
 *
 * `y = 63.9` is that centring, done properly: capitals occupy 0…capHeight above the
 * baseline, so the baseline goes at 50 + capHeight/2 = 50 + (0.73 × 38)/2. Measured,
 * not guessed — `dominant-baseline: central` (the font's ascent/descent midpoint) was
 * the first attempt and left the letters 1.06px high in a 26px disc.
 *
 * Only the colour stays inline — it is data, not geometry.
 */
export function Avatar({ i, c, size = 26 }: { i: string; c: string; size?: number }) {
  return (
    <span className="avatar" style={{
      ['--av' as string]: `${size}px`,
      background: `linear-gradient(135deg, ${c}, ${alpha(c, 0.6)})`,
    }} role="img" aria-label={i}>
      <svg viewBox="0 0 100 100" aria-hidden="true"><text x="50" y="63.9">{i}</text></svg>
    </span>
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

/**
 * Measures the box a graphic is drawn into, so an SVG can be laid out in REAL
 * pixels instead of being stretched out of a fixed `viewBox`.
 *
 * `viewBox` + `width="100%"` looks like the responsive answer and is a trap: the
 * box scales the whole coordinate system, so on a wide screen a 460×140 chart in a
 * 1800px card is drawn at ~4× — a 1.5px stroke lands at 6px, an 8px axis label at
 * 31px, and (with no `height`) the card grows to 548px tall. That is exactly how
 * the Pipeline throughput chart ended up a full screen of blown-up line art.
 * Measuring keeps every constant meaning what it says: 1.5px is 1.5px at any width.
 *
 * Measured, and the first draft still got it wrong: until the observer fires the SVG
 * is drawn at the FALLBACK width, and a 460px drawing inside a grid item (whose
 * `min-width` is `auto`, i.e. its content) widens the track to 460px — so the box
 * then measures 460 and the chart stays wrong, on a 390px phone, forever. Hence the
 * `max-width: 100%` on the SVG itself: it may be clipped for one frame, it may never
 * push its own box wider. The probe caught this; reading the diff did not.
 */
function useBoxWidth<T extends HTMLElement>(fallback: number, enabled = true) {
  // fs = the RESOLVED --t-2xs of this box, i.e. the size the axis labels will
  // actually be drawn at. It is 9px on a desktop and 11px on a phone, and an axis
  // gutter sized for the desktop number clips its own labels on the phone — which
  // is how "585.9 KB" reached a screenshot as "85.9 KB". Read it, do not assume it.
  const [box, setBox] = React.useState({ w: 0, fs: 0 });
  const roRef = React.useRef<ResizeObserver | null>(null);
  // A CALLBACK ref, not useRef + useLayoutEffect. A chart returns its SKELETON while
  // the data is null, so the one render the effect fires on has no node to measure —
  // and with a stable dependency it never fires again, leaving the chart at its
  // fallback width for good (measured: a width=460 attribute inside a 308px box on a
  // phone). A callback ref runs when the node actually attaches, whenever that is.
  const ref = React.useCallback((el: T | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!enabled || !el) return;
    const read = () => setBox({
      w: el.clientWidth,
      fs: parseFloat(getComputedStyle(el).getPropertyValue('--t-2xs')) || AXIS_FS,
    });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    roRef.current = ro;
  }, [enabled]);
  // 0.6em is JetBrains Mono's advance width — the axis font is monospaced, so the
  // width of a label is arithmetic rather than something to measure per string
  return {
    ref,
    width: enabled ? (box.w || fallback) : fallback,
    charW: (box.fs || AXIS_FS) * 0.6,
  };
}

// Round an axis maximum up to something a human reads as a boundary, so gridlines
// land on round numbers instead of on the sample. The ladder is deliberately fine:
// with only 1/2/5/10 a peak of 5.1k jumps the axis to 10k and the whole series is
// drawn in the bottom half of the plot for nothing. Every step halves cleanly, so
// the middle gridline stays a round number too.
const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  return (NICE.find((n) => f <= n) ?? 10) * exp;
}

// plot gutters: room for the y-axis labels on the left, the x-axis labels below.
// `l` is a FLOOR, not the width — the gutter is derived from the widest label the
// chart will actually print (see `gutter`). A fixed 46px silently cut "176.6 KB"
// down to "76.6 KB", which does not look like a clipped label, it looks like a
// chart whose middle gridline is bigger than its top one.
const CHART_PAD = { l: 30, r: 10, t: 12, b: 18 };
const AXIS_FS = 9; // fallback only — the real size is read off the box (useBoxWidth)
const gutter = (labels: string[], charW: number) =>
  Math.max(CHART_PAD.l, Math.ceil(Math.max(...labels.map((l) => l.length)) * charW) + 8);

// Which x-axis labels fit side by side. Callers hand over one label per point (or a
// pre-thinned array); how many there is ROOM for depends on the measured width,
// which only the chart knows — 8 labels are comfortable in a 515px card and run
// into each other in a 308px one.
function fitLabels(labels: string[], innerW: number, charW: number) {
  const idx = labels.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return new Set<number>();
  const widest = Math.max(...labels.map((l) => l.length));
  const room = Math.max(1, Math.floor(innerW / (widest * charW + 12)));
  const step = Math.ceil(idx.length / room);
  return new Set(idx.filter((_, k) => k % step === 0));
}

// …and keeps the outer ones inside the drawing: the last label is centred on the
// last point, which sits 10px from the right edge, so half of it hangs outside —
// "07-24" rendered as "07-2".
const labelX = (x: number, label: string, width: number, charW: number) => {
  const half = (label.length * charW) / 2;
  return Math.min(Math.max(x, half), width - half);
};

/**
 * Sparkline. `w` is a FIXED pixel width — right for a table cell, wrong for anything
 * that has to fit a box whose width comes from the viewport. `fluid` measures the
 * parent instead and draws at that width, with `w` as the pre-measurement fallback.
 *
 * Measured, not styled: the slide-over drew its hit trend at a hard-coded 470px, and
 * on a 390px phone the panel is 358px wide — so the panel scrolled sideways by 132px
 * with nothing to see out there. A `viewBox` + `preserveAspectRatio="none"` stretch
 * would fit the box too, but it scales x and y differently: the stroke thins and the
 * last-point dot turns into an ellipse. Measuring keeps the geometry honest.
 */
export function Spark({ data, w = 56, h = 18, color = SEV.low, fill = true, dot = true, fluid = false }:
  { data: number[]; w?: number; h?: number; color?: string; fill?: boolean; dot?: boolean; fluid?: boolean }) {
  const { ref: boxRef, width: ww } = useBoxWidth<HTMLSpanElement>(w, fluid);

  let svg: React.ReactElement;
  if (!data || data.length < 2) {
    svg = <svg width={ww} height={h} />;
  } else {
    const min = Math.min(...data); const max = Math.max(...data);
    const range = max - min || 1;
    const pts = data.map((v, i) => [
      (i / (data.length - 1)) * (ww - 2) + 1,
      h - 2 - ((v - min) / range) * (h - 4),
    ]);
    const line = pts.map((p) => p.join(',')).join(' ');
    const poly = `1,${h - 1} ${line} ${ww - 1},${h - 1}`;
    const last = pts[pts.length - 1];
    svg = (
      <svg width={ww} height={h} style={{ display: 'block', flexShrink: 0 }}>
        {fill && <polygon points={poly} fill={alpha(color, 0.12)} />}
        <polyline points={line} fill="none" stroke={color} strokeWidth={1.4} />
        {dot && <circle cx={last[0]} cy={last[1]} r={2} fill={color} />}
      </svg>
    );
  }
  // the measured span must be able to shrink, or it inherits the SVG's width and
  // reports the very number we are trying to correct
  if (!fluid) return svg;
  return <span ref={boxRef} style={{ display: 'block', width: '100%', minWidth: 0 }}>{svg}</span>;
}

// value/sub = null → the card renders itself in loading state (same chrome,
// placeholder where the number goes). Pass the value only once it is known.
export function KpiCard({ label, value, color, spark, sub }:
  { label: string; value: string | null; color: string; spark?: number[] | null; sub?: string | null }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 150 }}>
      <div className="micro text-2xs">{label}</div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        {value == null
          ? <Skeleton w={76} h={26} radius={4} />
          : <span className="mono font-bold" style={{ fontSize: 26, color }}>{value}</span>}
        {spark && <Spark data={spark} w={64} h={24} color={color} />}
      </div>
      {/* sub === null means "a sub-line is coming" → reserve it, no layout jump */}
      {sub === null
        ? <Skeleton w={54} h={9} style={{ marginTop: 7 }} />
        : sub && <div className="text-xs text-text2" style={{ marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// axis text: a token, not a literal — an SVG label rides the phone type scale like
// every other string in the app (presentation attributes cannot take a var(), a
// style can)
const AXIS_TEXT: React.CSSProperties = {
  fontSize: 'var(--t-2xs)', fontFamily: "'JetBrains Mono', monospace",
};

// Stacked area chart (event volume by severity band). data == null → loading.
export function StackedArea({ data, w = 460, h = 140 }:
  { data: { d: string; c: number; h: number; m: number; l: number }[] | null; w?: number; h?: number }) {
  const { ref, width, charW } = useBoxWidth<HTMLDivElement>(w);
  if (data == null) return <ChartSkeleton h={h} />;
  if (!data.length) return <div className="text-text3 text-sm">no data yet</div>;
  const keys: ('l' | 'm' | 'h' | 'c')[] = ['l', 'm', 'h', 'c'];
  const colors = { l: SEV.low, m: SEV.medium, h: SEV.high, c: SEV.critical };
  const top = niceMax(Math.max(...data.map((r) => r.c + r.h + r.m + r.l)));
  const padL = gutter([0, 0.5, 1].map((f) => String(Math.round(top * f))), charW);
  const innerW = Math.max(40, width - padL - CHART_PAD.r);
  const innerH = Math.max(30, h - CHART_PAD.t - CHART_PAD.b);
  const px = (i: number) => padL
    + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const py = (v: number) => CHART_PAD.t + innerH - (v / top) * innerH;
  let acc = data.map(() => 0);
  const layers = keys.map((k) => {
    const base = [...acc];
    acc = acc.map((a, i) => a + data[i][k]);
    const line = acc.map((v, i) => `${px(i)},${py(v)}`).join(' ');
    const bottom = base.map((v, i) => `${px(i)},${py(v)}`).reverse().join(' ');
    return { k, points: `${line} ${bottom}` };
  });
  const shown = fitLabels(data.map((r) => r.d.slice(5)), innerW, charW);
  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0 }}>
      <svg width={width} height={h} style={{ display: 'block', maxWidth: '100%' }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={width - CHART_PAD.r} y1={py(top * f)} y2={py(top * f)}
              stroke="var(--bg3)" strokeWidth={1} />
            <text x={padL - 8} y={py(top * f) + 3} textAnchor="end" style={AXIS_TEXT}
              fill="var(--text3)">{Math.round(top * f)}</text>
          </g>
        ))}
        {layers.map((l) => <polygon key={l.k} points={l.points} fill={alpha(colors[l.k], 0.22)}
          stroke={colors[l.k]} strokeWidth={1.2} />)}
        {data.map((r, i) => (shown.has(i) ? (
          <text key={i} x={labelX(px(i), r.d.slice(5), width, charW)} y={h - 4}
            textAnchor="middle" style={AXIS_TEXT} fill="var(--text3)">{r.d.slice(5)}</text>
        ) : null))}
      </svg>
    </div>
  );
}

/**
 * Single-series line chart. points == null → loading (an empty array stays the
 * honest "no data yet").
 *
 * Drawn at the measured width (see `useBoxWidth`), with a zero baseline, round
 * gridline values and a hover readout — a NOC chart whose points cannot be read
 * back is decoration. `tips` carries the full label per point (the `labels` array
 * is deliberately sparse so the axis stays legible).
 */
export function LineChart({ points, labels, tips, color = SEV.green, w = 460, h = 140, fmt }:
  { points: number[] | null; labels?: string[]; tips?: string[]; color?: string;
    w?: number; h?: number; fmt?: (v: number) => string }) {
  const { ref, width, charW } = useBoxWidth<HTMLDivElement>(w);
  const [hi, setHi] = React.useState<number | null>(null);
  if (points == null) return <ChartSkeleton h={h} />;
  if (!points.length) return <div className="text-text3 text-sm">no data yet</div>;
  const padB = labels ? CHART_PAD.b : 6;
  const top = niceMax(Math.max(...points));
  const ticks = [0, 0.5, 1].map((f) => top * f);
  const fv = (v: number) => (fmt ? fmt(v) : String(Math.round(v)));
  const padL = gutter(ticks.map(fv), charW);
  const innerW = Math.max(40, width - padL - CHART_PAD.r);
  const innerH = Math.max(30, h - CHART_PAD.t - padB);
  const px = (i: number) => padL
    + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const py = (v: number) => CHART_PAD.t + innerH - (v / top) * innerH;
  const line = points.map((v, i) => `${px(i)},${py(v)}`).join(' ');
  const shown = labels ? fitLabels(labels, innerW, charW) : null;
  const base = CHART_PAD.t + innerH;
  // touch as well as mouse: the readout is the only way to get a number off the
  // chart, and a NOC's second screen is a phone
  const at = (el: SVGRectElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    const i = Math.round(((clientX - r.left) / (innerW || 1)) * (points.length - 1));
    setHi(Math.max(0, Math.min(points.length - 1, i)));
  };
  const onMouse = (e: React.MouseEvent<SVGRectElement>) => at(e.currentTarget, e.clientX);
  const onTouch = (e: React.TouchEvent<SVGRectElement>) =>
    at(e.currentTarget, e.touches[0].clientX);
  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0, position: 'relative' }}>
      <svg width={width} height={h} style={{ display: 'block', maxWidth: '100%' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - CHART_PAD.r} y1={py(t)} y2={py(t)}
              stroke="var(--bg3)" strokeWidth={1} />
            <text x={padL - 8} y={py(t) + 3} textAnchor="end" style={AXIS_TEXT}
              fill="var(--text3)">{fv(t)}</text>
          </g>
        ))}
        <polygon points={`${px(0)},${base} ${line} ${px(points.length - 1)},${base}`}
          fill={alpha(color, 0.12)} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={1.5}
          strokeLinejoin="round" />
        {points.length <= 40 && points.map((v, i) => (
          <circle key={i} cx={px(i)} cy={py(v)} r={2} fill={color} />
        ))}
        {hi !== null && (
          <g>
            <line x1={px(hi)} x2={px(hi)} y1={CHART_PAD.t} y2={base}
              stroke={color} strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={px(hi)} cy={py(points[hi])} r={4} fill={color}
              stroke="var(--bg2)" strokeWidth={1.5} />
          </g>
        )}
        {labels && labels.map((l, i) => (shown?.has(i) ? (
          <text key={i} x={labelX(px(i), l, width, charW)} y={h - 4} textAnchor="middle"
            style={AXIS_TEXT} fill="var(--text3)">{l}</text>
        ) : null))}
        <rect x={padL} y={0} width={innerW} height={h} fill="transparent"
          onMouseMove={onMouse} onMouseLeave={() => setHi(null)}
          onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={() => setHi(null)} />
      </svg>
      {hi !== null && (
        <div className="chart-tip mono text-2xs"
          style={{ left: Math.min(Math.max(px(hi), 44), Math.max(44, width - 44)) }}>
          <b style={{ color }}>{fv(points[hi])}</b>
          {(tips?.[hi] || labels?.[hi]) && (
            <span className="text-text3"> · {tips?.[hi] || labels?.[hi]}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function HBars({ items, color = SEV.low, max: maxOverride }:
  { items: { n: string; v: number; c?: string }[] | null; color?: string; max?: number }) {
  if (items == null) return <BarsSkeleton />;
  const max = maxOverride ?? Math.max(...items.map((i) => i.v), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.length === 0 && <div className="text-text3 text-sm">no data yet</div>}
      {items.map((it) => (
        <div key={it.n} className="row">
          <span className="mono text-xs text-text1" style={{ width: 130,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.n}</span>
          <div style={{ flex: 1, height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(it.v / max) * 100}%`, height: '100%', background: it.c || color }} />
          </div>
          <span className="mono text-xs text-text2" style={{ width: 40, textAlign: 'right' }}>
            {it.v}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * THE tab bar for a page's sub-views.
 *
 * Pair it with `useTab` (state.tsx), which keeps the active tab in the URL as
 * `/app/<page>/<tab>`. That pairing is the point: a tab held only in useState
 * cannot be linked, bookmarked or reached with the back button, and a reload drops
 * the reader back onto the first one.
 *
 * `row-wrap`, because six tabs do not fit a 390px phone in one line and a tab bar
 * that pushes the page sideways is worse than one that wraps.
 */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="row row-wrap tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id}
          className={`tab${value === id ? ' active' : ''}`} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * THE range/mode switch — a handful of mutually exclusive, self-describing options
 * (24h · 7d · 30d) that belong ON the toolbar, not behind a dropdown.
 *
 * `Select` is for lists; this is for two to four fixed choices where showing them
 * all is cheaper than opening a panel. It exists so the pattern stops being
 * re-drawn per page: the Pipeline range switch was a hand-rolled `<span>` of bare
 * buttons with six inline styles, which is how a second look creeps in.
 */
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string])[];
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" aria-pressed={value === id}
          className={`seg-btn${value === id ? ' active' : ''}`} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * THE modal dialog — a real `<dialog>` shown with `showModal()`, i.e. in the
 * browser's TOP LAYER.
 *
 * The top layer paints above every z-index in the document and orders by
 * "last opened wins" — which IS the rule this app used to spell out by hand
 * ("a picker sits above the surface that opened it"). `Select` uses the Popover
 * API for the same reason; the two belong together. Converting only one puts the
 * picker back underneath, because a top-layer dialog beats any z-index.
 *
 * `showModal()` also brings the `::backdrop`, Escape, a focus trap and inertness
 * of everything behind it — all of which this modal previously did not have.
 * A browser without `showModal` falls back to a plain `[open]` dialog ordered by
 * `--z-modal`, i.e. exactly the old behaviour.
 *
 * The public API is unchanged, so all call sites stay as they are.
 */
export function Modal({ title, onClose, children, width = 420, hideClose = false }:
  { title: string; onClose: () => void; children: React.ReactNode; width?: number; hideClose?: boolean }) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const close = React.useRef(onClose);
  close.current = onClose;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // BOTH or NEITHER. A browser with showModal but without the Popover API
    // (Safari 16) would put the dialog in the top layer and leave the picker on
    // z-index 130 — i.e. exactly the bug this replaces, in a browser nobody tests.
    if (HAS_POPOVER && typeof el.showModal === 'function') el.showModal();
    // no top layer here: [open] alone, ordered by --z-modal, and drawing its own
    // dim because ::backdrop only exists for a MODAL dialog
    else { el.setAttribute('open', ''); el.dataset.flat = '1'; }
    // Escape fires `cancel` BEFORE the browser closes the dialog. Let the owner's
    // state do the closing (it unmounts us), or the DOM and React disagree.
    const onCancel = (e: Event) => { e.preventDefault(); if (!hideClose) close.current(); };
    el.addEventListener('cancel', onCancel);
    return () => {
      el.removeEventListener('cancel', onCancel);
      if (el.open) el.close();
    };
  }, [hideClose]);

  return (
    <dialog ref={ref} className="modal-dialog" aria-label={title}
      // a click that lands on the dialog itself is a click on the dim area —
      // the panel is the only thing inside it
      onClick={(e) => { if (e.target === ref.current && !hideClose) onClose(); }}>
      <div className="modal-panel" style={{ width }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <span className="text-md font-bold text-text0">{title}</span>
          {!hideClose && <button className="text-text2" aria-label="Close" onClick={onClose}
            style={{ display: 'inline-flex' }}><XIcon size={17} /></button>}
        </div>
        {children}
      </div>
    </dialog>
  );
}

// Design-system standard: THE horizontal scroll container for wide tables.
// Wrap the whole table block (head + rows + empty states) in it. It keeps its
// intrinsic height, so it never introduces inner vertical scrolling — cards
// and pages themselves must never become scroll containers (that lets flex
// squeeze them to viewport height; see tokens.css).
/**
 * THE horizontal scroll container for tables — and the only sanctioned one.
 *
 * On a phone the scrollbar is an OS overlay: iOS shows it only WHILE the finger moves,
 * so a table that runs past the right edge looks like it simply ends. This adds the
 * affordance the platform does not:
 *
 * - the content fades out at the right edge while there is more to see,
 * - the fade retracts while the user is actually scrolling (the native bar is visible
 *   then — two indicators at once read as noise),
 * - `peek` nudges the table ~30px and back the first time it comes into view.
 *
 * `stickyFirst` pins the first column so the row stays identifiable while scrolling.
 * It is per call site on purpose: it earns its keep when column one is the row's
 * identity (case id, hostname) and gets in the way when it is not.
 */
/**
 * Column tracks for a table's `gridTemplateColumns`, by what the column CONTAINS.
 *
 * The tables were the standard components; the widths were not. Every table hand-picked
 * pixel values, ~30 constants of them, and the failure mode is always the same one:
 * enough fixed tracks that the flexible one absorbs all the slack alone. The managed
 * fleet read `minmax(120px,1fr) 110px 150px 92px 64px 70px 90px` — six fixed of seven —
 * so on a wide screen every column stayed narrow while "Location" ate the free space,
 * and "Backed by" (`AWS eu-central-1 · standard`, the longest content in the table)
 * truncated at 150px.
 *
 * Composing from these instead means a width is chosen by asking "what goes in here?",
 * which is a question with a right answer, rather than by guessing a number:
 *
 *   const FLEET_GRID = [COL.text, COL.label, COL.textWide, COL.status,
 *                       COL.num, COL.status, COL.actions].join(' ');
 *
 * Two rules go with it, both about the same thing — the table has to survive a window
 * it was not authored at:
 *  - **At least one track must be flexible** (an `fr`), or the grid cannot use the
 *    space it is given. `check-table-grids.mjs` fails the build on an all-fixed grid.
 *  - **Give the slack to the column that needs it.** `textWide` takes 2fr against
 *    `text`'s 1fr; a fixed track is for content with a known ceiling — a pill, a
 *    count, a timestamp — never for a name, a URL or a description.
 */
export const COL = {
  /** free text that absorbs slack: a name, a device, a target */
  text: 'minmax(140px, 1fr)',
  /** the column that should get MOST of the slack — descriptions, URLs, joined fields */
  textWide: 'minmax(180px, 2fr)',
  /** short but variable: a region, a group, a class, an assignee */
  label: 'minmax(90px, 0.6fr)',
  /** a right-aligned count */
  num: '72px',
  /** one StatusPill or SevBadge */
  status: '104px',
  /** an absolute timestamp (fmtTime / fmtDate) */
  time: '150px',
  /** a relative age or duration ("2.4d", "12m ago") */
  age: '92px',
  /** an identifier with a known ceiling — "C-1002", an org id */
  id: '84px',
  /** a Toggle, or a one-word yes/no */
  toggle: '72px',
  /** a sparkline or other mini-chart cell */
  spark: '64px',
  /** an icon, a dot, an avatar, a drag handle — no label of its own */
  tiny: '34px',
  /** trailing buttons — as wide as the widest row needs, no wider */
  actions: 'max-content',
} as const;

export function TableScroll({ minWidth = 620, stickyFirst = false, peek = true, fit = false, children }:
  { minWidth?: number | string; stickyFirst?: boolean; peek?: boolean; fit?: boolean;
    children: React.ReactNode }) {
  const box = React.useRef<HTMLDivElement>(null);
  const sc = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = sc.current, wrap = box.current;
    if (!el || !wrap) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let idle: number | undefined;
    let nudging = false;

    // `more` drives the fade; it is false at the right end so the fade cannot sit
    // there suggesting content that does not exist.
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      wrap.dataset.more = max > 1 && el.scrollLeft < max - 4 ? '1' : '0';
    };
    const onScroll = () => {
      sync();
      if (nudging) return;            // the nudge is not the user scrolling
      wrap.dataset.scrolling = '1';
      window.clearTimeout(idle);
      idle = window.setTimeout(() => { wrap.dataset.scrolling = '0'; }, 500);
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();

    let io: IntersectionObserver | undefined;
    if (peek && !reduced) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io?.unobserve(el);
          const max = el.scrollWidth - el.clientWidth;
          if (max < 12) return;
          const dist = Math.min(30, max);
          const dur = 820;
          let t0: number | null = null;
          nudging = true;
          const frame = (t: number) => {
            if (t0 === null) t0 = t;
            const p = Math.min(1, (t - t0) / dur);
            const s = Math.sin(p * Math.PI);          // out and back in one motion
            el.scrollLeft = dist * (s * s * (3 - 2 * s));
            if (p < 1) requestAnimationFrame(frame);
            else { el.scrollLeft = 0; window.setTimeout(() => { nudging = false; }, 60); }
          };
          requestAnimationFrame(frame);
        }
      }, { threshold: 0.55 });
      io.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      window.clearTimeout(idle);
      ro.disconnect();
      io?.disconnect();
    };
  }, [peek]);

  return (
    <div className={`tbl-box${stickyFirst ? ' tbl-sticky1' : ''}`} ref={box} data-more="0">
      <div className="tbl-scroll" ref={sc}>
        {/* `fit` is for a list whose width is set by its CONTENT rather than by a
            column plan — a log line. `width: max-content` makes this wrapper as wide
            as the widest row, so row borders and the hover tint still span the full
            scrolled width; `min-width: 100%` keeps short content filling the panel.
            Without the max-content half, rows overflow a 100%-wide wrapper and their
            borders visibly stop where the viewport did. */}
        <div style={fit ? { width: 'max-content', minWidth: '100%' } : { minWidth }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// Design-system standard: THE page header. Title left, actions right, and it
// WRAPS — a toolbar that cannot wrap pushes the whole page sideways on phones
// (a `<select>` fed by user data is the usual culprit; see tokens.css). Use this
// instead of hand-rolling `.row` + `.page-title` per page.
/**
 * THE page header: title left, actions right, and a height that does not depend on
 * whether there ARE actions.
 *
 * That last part is the whole point. The row used to be sized by its tallest child, so
 * a page with a CTA was 32px tall and the same page on a tab without one was 24px —
 * and the tab bar underneath jumped 8px as you switched tabs (measured on
 * /app/platform/overview vs /app/platform/organizations). `.page-head` reserves the
 * action slot's height whether or not anything is in it, so every page and every tab
 * of every page starts its content at the same y.
 *
 * The geometry is a CLASS, not an inline style: a media query cannot beat an inline
 * style, and the phone has to be able to override this.
 */
export function PageHeader({ title, children }:
  { title: string; children?: React.ReactNode }) {
  return (
    <div className="page-head row row-wrap">
      <h1 className="page-title">{title}</h1>
      {children && (
        <div className="row row-wrap" style={{ gap: 10, minWidth: 0 }}>{children}</div>
      )}
    </div>
  );
}

/**
 * THE button.
 *
 * It emits the same `.btn` classes the app already used — a typed façade over the
 * existing CSS, not a second look. What it buys is that the variants finally live in
 * ONE place, and that two copy-pasted patterns stop being copy-pasted:
 *
 *   `block`  — 36 call sites wrote `style={{ width: '100%', justifyContent: 'center' }}`,
 *              the single most-duplicated inline style in the app.
 *   `danger` — 7 wrote `style={{ color: SEV.critical }}`, two with the raw hex.
 *
 * `type` is deliberately NOT defaulted. A bare <button> inside a <form> defaults to
 * `type="submit"`, so giving this a `type="button"` default would silently turn every
 * submit button in the app into a no-op — a regression a green build sails straight
 * through.
 */
export const Button = React.forwardRef<HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'primary' | 'danger';
    size?: 'md' | 'sm';
    /** Full width with the label centred — the shape a dialog's confirm button wants. */
    block?: boolean;
  }>(
  function Button({ variant = 'default', size = 'md', block, className, ...rest }, ref) {
    const cls = ['btn'];
    if (variant === 'primary') cls.push('btn-primary');
    if (variant === 'danger') cls.push('btn-danger');
    if (size === 'sm') cls.push('btn-sm');
    if (block) cls.push('btn-block');
    if (className) cls.push(className);
    return <button ref={ref} className={cls.join(' ')} {...rest} />;
  });

/**
 * THE surface. A titled panel — the box every page is built out of.
 *
 * `title` renders the `.card-title` row, so a card with a heading no longer needs two
 * elements at the call site. Never give this `overflow`: a flex child that hides its
 * overflow can collapse below its content height and grow an inner scrollbar, which is
 * exactly what `TableScroll` exists to avoid.
 */
export function Card({ title, actions, children, className, ...rest }:
  React.HTMLAttributes<HTMLDivElement> & { title?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={className ? `card ${className}` : 'card'} {...rest}>
      {title && (
        <div className="card-title">
          {title}
          {actions && <><span style={{ flex: 1 }} />{actions}</>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * THE text input. Use it instead of a bare <input> for every text-like control
 * (text, password, number, email, url, search, tel) — checkboxes and radios are a
 * different shape and stay native.
 *
 * On a phone it renders its value at an optical 14px while telling Safari 16px, so the
 * value no longer towers over its own 13px label and the focus zoom still cannot fire.
 * The how, and the three compensations it needs, are in tokens.css under `.ctl`.
 *
 * `width` goes through this prop, NOT through `style`: an inline width would beat the
 * compensation the scale depends on and leave a gap on the right edge of the control.
 */
export const Input = React.forwardRef<HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width'> & { width?: number | string }>(
  function Input({ className, width, style, inputMode, type, ...rest }, ref) {
    const w = typeof width === 'number' ? `${width}px` : width;
    // A field that only takes digits should raise the KEYPAD on a phone, not the
    // full alphabetic keyboard. iOS keys that off `inputmode`, not off `type`, and
    // `type="number"` alone still opens the wide numbers-and-punctuation layout.
    // Derived here rather than at the call site: nine fields would have to remember
    // it, and the tenth would not. A decimal field passes inputMode explicitly.
    const mode = inputMode ?? (type === 'number' ? 'numeric' : undefined);
    // A machine address is never prose. `url`/`email` keyboards drop the space bar
    // for a `.` and lose the suggestion strip — but only if the phone is also told
    // to stop capitalising and "correcting", which is three more attributes nobody
    // remembers. So they follow from the keyboard, in one place.
    const machine = mode === 'url' || mode === 'email';
    return (
      <input ref={ref} className={className ? `ctl ${className}` : 'ctl'} type={type} inputMode={mode}
        {...(machine ? { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : null)}
        style={w ? { ...style, ['--ctl-w' as string]: w } : style} {...rest} />
    );
  });

/**
 * THE control for a machine address — a hostname, an IP, a domain or a URL.
 *
 * There is NO digits-and-a-dot keyboard on iOS, and the two candidates both fail:
 * `inputMode="numeric"` has no `.` at all, and `inputMode="decimal"` puts the
 * LOCALE's decimal separator on the key — a comma on a German phone, so `10,0,0,1`.
 * The URL keyboard is the real answer: it keeps the letters a hostname needs, moves
 * `.` and `/` onto the main layer in place of the space bar, and drops the
 * suggestion strip that was offering "Ich / Hallo / Ja" over a field holding
 * `10.0.0.1`.
 *
 * `type` stays `text`: `type="url"` makes the browser demand a scheme, and
 * `core-switch-01` is a perfectly good host.
 */
export const HostInput = React.forwardRef<HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width' | 'type' | 'inputMode'>
  & { width?: number | string }>(
  function HostInput({ autoComplete = 'off', ...rest }, ref) {
    return <Input ref={ref} type="text" inputMode="url" autoComplete={autoComplete} {...rest} />;
  });

/* There is deliberately no NativeSelect any more. `Select` (Select.tsx) is THE
   dropdown for every list, short or long: one look, one keyboard model, one panel
   that the design system owns. The native control's remaining advantages were real
   but narrow — no iOS focus zoom (a button has none either) and the platform wheel
   on a phone (which ignores the app's design and cannot be searched) — and they did
   not pay for a second dropdown that behaved differently in every respect.
   A `<select>` is also sized by its LONGEST OPTION, i.e. by data, which is what
   pushed toolbars past the viewport in the first place. */

/**
 * THE date/time control.
 *
 * It exists because a `datetime-local` is the one input whose INTRINSIC width matters:
 * the browser sizes it to fit "05.08.2026, 09:21" in the user's locale, and that is
 * wider than any layout guess. Sizing it by hand is what broke the maintenance-window
 * form — three controls given `style={{ flex, minWidth }}` instead of the `width` prop,
 * so `--ctl-w` stayed unset, the optical scale compensated against 100% of the wrong
 * box, and the field overlapped its neighbour and ran 8px past the card.
 *
 * So the width lives HERE, once, and call sites override it through `width` only.
 */
export const DateTime = React.forwardRef<HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width' | 'type'> & { width?: number | string }>(
  function DateTime({ width = 190, ...rest }, ref) {
    return <Input ref={ref} type="datetime-local" width={width} {...rest} />;
  });

/**
 * THE multi-line text control.
 *
 * Unlike `Input` this deliberately does NOT ride the optical scale, and the reason is
 * measured rather than aesthetic: a textarea has a resize handle, and the handle sits on
 * the *layout* box while a transform only shrinks what is drawn. At scale 0.875 on a
 * 3-row box the handle ends up 11px BELOW the visible bottom edge — you grab the corner
 * you can see and hit nothing. So it keeps 16px, which is defensible on its own terms:
 * it is a writing surface, not a value to be read at a glance.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement,
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'width'> & { width?: number | string }>(
  function Textarea({ className, width, style, ...rest }, ref) {
    const w = typeof width === 'number' ? `${width}px` : width;
    return (
      <textarea ref={ref} className={className ? `ctl-ta ${className}` : 'ctl-ta'}
        style={w ? { ...style, ['--ctl-w' as string]: w } : style} {...rest} />
    );
  });

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
      <span className="micro text-2xs">{label}</span>
      {children}
    </label>
  );
}

/**
 * A colour: a swatch you click and a hex you can paste, both editing one value.
 *
 * The swatch stays a native `<input type="color">` for the same reason checkboxes
 * do — it is a button that opens the OS picker, so none of the reasons `Input`
 * exists (the phone font floor, the optical scale, the width compensation) apply
 * to it. The hex field beside it IS text, and is the half people paste a brand
 * colour into, so that one goes through `Input`.
 *
 * `onChange` fires only for a complete `#rrggbb`. Typing "#6" must not repaint
 * the caller with a broken colour on every keystroke, so the field holds its own
 * draft until it parses — which is also why a controlled `value` has to flow back
 * into that draft.
 */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export function ColorPicker({ value, onChange, disabled, placeholder }: {
  value: string; onChange: (hex: string) => void; disabled?: boolean; placeholder?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => { setDraft(value); }, [value]);
  const commit = (v: string) => {
    setDraft(v);
    if (HEX_COLOR_RE.test(v)) onChange(v.toLowerCase());
  };
  return (
    <span className="row" style={{ gap: 8 }}>
      <input type="color" className="swatch" aria-label="Pick a colour" disabled={disabled}
        value={HEX_COLOR_RE.test(draft) ? draft : '#000000'}
        onChange={(e) => commit(e.target.value)} />
      <Input className="mono" width={104} value={draft} disabled={disabled} maxLength={7}
        aria-label="Hex colour" placeholder={placeholder || '#6366f1'}
        onChange={(e) => commit(e.target.value)} />
    </span>
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
  return <Tip s={s} />;
}

// Its own component so the popover effect has a mount to hang on: TipHost is
// mounted once in the shell and would otherwise never remount.
function Tip({ s }: { s: { x: number; y: number; node: React.ReactNode } | null }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // A tooltip must sit above a modal too, and a <dialog> in the top layer beats
  // every z-index — so the tooltip goes into the top layer as well. TipHost lives
  // in the shell, OUTSIDE any dialog, so nothing else would lift it.
  React.useLayoutEffect(() => { topLayer(ref.current, !!s); }, [s]);
  if (!s) return null;
  const x = Math.min(s.x + 14, (window.innerWidth || 800) - 200);
  const y = Math.min(s.y + 14, (window.innerHeight || 600) - 96);
  return (
    <div ref={ref} className="tip-pop" style={{ left: x, top: y }}>
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
      <div className="mono row text-sm font-bold text-text0" style={{ gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {title}
      </div>
      {sub && <div className="mono text-2xs text-text2" style={{ marginTop: 3 }}>{sub}</div>}
      {value && <div className="mono text-xs text-text1" style={{ marginTop: 5}}>{value}</div>}
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
    <span className="mono text-2xs font-semibold text-text1" style={{ background: state === 'na' ? 'var(--bg3)' : alpha(c, 0.1),
      display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 3, whiteSpace: 'nowrap'}}>
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
