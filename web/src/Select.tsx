// Design-system standard: THE dropdown. Replaces the native <select> wherever the
// options come from data or a picker needs search / multi-select.
//
// Why a custom control at all — the native <select> is sized by its LONGEST OPTION
// (so data dictates layout width), it cannot be searched, cannot hold pills, and on
// phones iOS renders its own wheel that ignores the app's design. The one thing it
// does better is that it never triggers the iOS focus-zoom; this component keeps
// that property by never putting a <16px text input on screen: the trigger is a
// button, and the only real text field (the search box) is a full 16px.
//
// Layout, both validated on a real iPhone before this was written:
//   phone (≤720px) — a bottom sheet with the search field in the FOOTER, directly
//     above the keyboard, options above it. Search at the top disappears behind the
//     keyboard the moment you type, because `position: fixed` anchors to the LAYOUT
//     viewport and iOS does not shrink that for the keyboard. Hence `--kb`, measured
//     from visualViewport.
//   desktop — an anchored popover, search at the top where it reads naturally.
//
// Both live in the browser's TOP LAYER (Popover API, see toplayer.ts). That is what
// makes a picker opened from inside a modal paint ABOVE it: the top layer orders by
// "last opened wins", and the picker is by definition opened later. It also means
// the panel needs no portal — the top layer escapes every clipping and transformed
// ancestor by itself, and staying a DOM descendant of the dialog is what keeps the
// panel out of the inert subtree `showModal()` creates around everything else.
import React from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { topLayer } from './toplayer';

export type SelectOption = { value: string; label: string; disabled?: boolean };

// Below this many options a search field is noise — a month picker (12) must not
// get one, a check list (dozens) must.
const SEARCH_THRESHOLD = 13;
// Above this many selections the trigger switches to "1 pill + N more"; the full
// set lives in the overview that opens UPWARD over the trigger. Two pills already
// need three lines at 390px, so "compact" has to mean one.
const PILL_LIMIT = 5;
const MOBILE_Q = '(max-width: 720px)';

function useMedia(query: string): boolean {
  const [match, setMatch] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

// Keep the sheet above the software keyboard and inside the visible area.
function useKeyboardInset(active: boolean) {
  const [inset, setInset] = React.useState({ kb: 0, maxH: 0 });
  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const sync = () => setInset({
      kb: Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)),
      maxH: Math.round(Math.min(vv.height * 0.85, vv.height - 12)),
    });
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    // the keyboard slides in with a delay — re-measure once it has settled
    const t1 = window.setTimeout(sync, 300);
    const t2 = window.setTimeout(sync, 700);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [active]);
  return inset;
}

type Anchor = { left: number; top: number; width: number; maxH: number; up: boolean };

// Fixed coordinates for the desktop popover, re-measured on scroll/resize so it
// stays glued to its trigger.
function useAnchor(active: boolean, ref: React.RefObject<HTMLElement>): Anchor | null {
  const [pos, setPos] = React.useState<Anchor | null>(null);
  React.useLayoutEffect(() => {
    if (!active) { setPos(null); return; }
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 200 && above > below;
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 220) - 8)),
        top: up ? r.top - 6 : r.bottom + 6,
        width: Math.max(r.width, 220),
        maxH: Math.max(160, Math.min(340, up ? above : below)),
        up,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, ref]);
  return pos;
}

// ------------------------------------------------------------------ the panel

function Panel({ options, selected, multi, title, searchable, onPick, onClose, anchorRef }: {
  options: SelectOption[];
  selected: Set<string>;
  multi: boolean;
  title: string;
  searchable: boolean;
  onPick: (value: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}) {
  const mobile = useMedia(MOBILE_Q);
  const { kb, maxH } = useKeyboardInset(mobile);
  const anchor = useAnchor(!mobile, anchorRef);
  const [query, setQuery] = React.useState('');
  // the panel mounts fresh on every open, so this is exactly "start on the current
  // selection"; filtering resets it from the input handler
  const [active, setActive] = React.useState(() =>
    Math.max(0, options.findIndex((o) => selected.has(o.value))));
  const [drag, setDrag] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const layerRef = React.useRef<HTMLDivElement>(null);
  const uid = React.useId();

  // Into the top layer for as long as the panel is mounted. Layout effect, not
  // effect: after paint would leave one frame in which the sheet is still an
  // ordinary z-indexed element — under any open dialog.
  React.useLayoutEffect(() => {
    const el = layerRef.current;
    topLayer(el, true);
    return () => topLayer(el, false);
    // the wrapper is the same DOM node in both layouts, so this must NOT re-run
    // when `mobile` flips — hide+show would flash the panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Focus the SEARCH FIELD on desktop, the LIST on a phone. Autofocusing the search
  // on a phone opens the software keyboard immediately, which covers most of the
  // sheet before a single option has been seen — and the overwhelming case is
  // "tap the one you want", not "type". The keyboard now appears only when the
  // user taps the search field, which is also when --kb lifts the sheet clear of it.
  React.useEffect(() => {
    const target = searchable && !mobile ? searchRef.current : listRef.current;
    target?.focus({ preventScroll: true });
  }, [searchable, mobile]);

  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-o${active}`)}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, uid, visible.length]);

  // Escape lives on the document: after a drag (or a tap on the grab handle) the
  // focus is outside the panel, and a handler on the panel would never see it.
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!visible.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = visible[active];
      if (o && !o.disabled) onPick(o.value);
    }
  }

  // Swiping the sheet down closes it — the grab handle promises that gesture, so
  // it has to actually do it.
  const dragFrom = React.useRef(0);
  const dragHandlers = mobile ? {
    onPointerDown: (e: React.PointerEvent) => {
      dragFrom.current = e.clientY;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag(0.0001);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!dragFrom.current) return;
      setDrag(Math.max(0, e.clientY - dragFrom.current));
    },
    onPointerUp: () => {
      if (drag > 90) onClose();
      dragFrom.current = 0;
      setDrag(0);
    },
    onPointerCancel: () => { dragFrom.current = 0; setDrag(0); },
  } : {};

  const list = (
    <ul className="sel-list" role="listbox" tabIndex={-1} ref={listRef}
      aria-label={title} aria-multiselectable={multi || undefined}
      aria-activedescendant={visible.length ? `${uid}-o${active}` : undefined}>
      {visible.length === 0 && <li className="sel-empty">No matches</li>}
      {visible.map((o, i) => (
        <li key={o.value} role="presentation">
          <button type="button" className={`sel-opt${i === active ? ' active' : ''}`}
            id={`${uid}-o${i}`} role="option" aria-selected={selected.has(o.value)}
            disabled={o.disabled} onClick={() => onPick(o.value)}
            // hover-to-highlight is a pointer affordance; on a phone the sheet slides
            // up UNDER the finger and would highlight whatever row lands there
            onMouseEnter={mobile ? undefined : () => setActive(i)}>
            <Check size={15} className="sel-tick" aria-hidden />
            <span>{o.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  const search = searchable ? (
    <input ref={searchRef} className="sel-search" type="text" value={query}
      placeholder={`Search ${title.toLowerCase()}…`} aria-label={`Search ${title.toLowerCase()}`}
      autoComplete="off"
      // deliberately NO onKeyDown here: the panel container already has it, and
      // handling the event twice moves the highlight two rows per press
      onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
  ) : null;

  if (mobile) {
    return (
      <div className="top-layer" ref={layerRef}>
        <div className="sel-backdrop open" style={drag ? { opacity: Math.max(0, 1 - drag / 260) } : undefined}
          onClick={onClose} />
        <div className={`sel-sheet open${drag ? ' dragging' : ''}`} role="dialog" aria-modal="true"
          aria-label={title} onKeyDown={onKeyDown}
          style={{
            ['--kb' as string]: `${kb}px`,
            maxHeight: maxH ? `${maxH}px` : undefined,
            transform: drag ? `translateY(${drag}px)` : undefined,
          }}>
          <div className="sel-handle" {...dragHandlers}><div className="sel-grab" /></div>
          <div className="sel-head" {...dragHandlers}><div className="sel-title">{title}</div></div>
          {list}
          {(searchable || multi) && (
            <div className="sel-foot">
              {search}
              {multi && <button type="button" className="btn btn-primary sel-done" onClick={onClose}>Done</button>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="top-layer" ref={layerRef}>
      <div className="sel-scrim" onClick={onClose} />
      <div className="sel-pop" role="dialog" aria-label={title} onKeyDown={onKeyDown}
        style={{
          left: anchor?.left ?? -9999, top: anchor?.top ?? -9999, width: anchor?.width,
          maxHeight: anchor?.maxH, transform: anchor?.up ? 'translateY(-100%)' : undefined,
        }}>
        {searchable && <div className="sel-pophead">{search}</div>}
        {list}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ triggers

function useOpen(): [boolean, (v: boolean) => void, React.RefObject<HTMLElement>] {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLElement>(null);
  const set = React.useCallback((v: boolean) => {
    setOpen(v);
    if (!v) ref.current?.focus({ preventScroll: true });
  }, []);
  return [open, set, ref];
}

function triggerKeys(open: boolean, setOpen: (v: boolean) => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) setOpen(true);   // never re-open an open panel
    }
  };
}

function wantsSearch(searchable: 'auto' | boolean, count: number) {
  return searchable === 'auto' ? count >= SEARCH_THRESHOLD : searchable;
}

export function Select({ value, onChange, options, title = 'Select', placeholder = 'Select…',
  searchable = 'auto', disabled, style, id, 'aria-label': ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  title?: string;
  placeholder?: string;
  searchable?: 'auto' | boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  id?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen, ref] = useOpen();
  const current = options.find((o) => o.value === value);
  return (
    <div className="sel" style={style}>
      <button type="button" id={id} className="sel-trigger" disabled={disabled}
        ref={ref as React.RefObject<HTMLButtonElement>} aria-label={ariaLabel}
        role="combobox" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(!open)} onKeyDown={triggerKeys(open, setOpen)}>
        <span className={`sel-value${current ? '' : ' sel-placeholder'}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="sel-chev" aria-hidden />
      </button>
      {open && (
        <Panel options={options} selected={new Set(value ? [value] : [])} multi={false}
          title={title} searchable={wantsSearch(searchable, options.length)} anchorRef={ref}
          onPick={(v) => { onChange(v); setOpen(false); }} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

export function MultiSelect({ value, onChange, options, title = 'Select', placeholder = 'None selected',
  searchable = 'auto', disabled, style, id, 'aria-label': ariaLabel }: {
  value: string[];
  onChange: (value: string[]) => void;
  options: SelectOption[];
  title?: string;
  placeholder?: string;
  searchable?: 'auto' | boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  id?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen, ref] = useOpen();
  const [overview, setOverview] = React.useState(false);
  const mobile = useMedia(MOBILE_Q);
  const chosen = options.filter((o) => value.includes(o.value));
  const compact = chosen.length > PILL_LIMIT;

  React.useEffect(() => { if (!compact) setOverview(false); }, [compact]);

  // The remove × is a POINTER affordance and is dropped on phones. Measured on a
  // 390px viewport: it is an 18×18 tap target sitting in the middle of the control
  // you are trying to open, so tapping the trigger's centre deleted a selection
  // instead of opening the picker (pills went 2 → 1 and nothing else happened).
  // Growing it to the 44px touch minimum would make one pill fill the field. On a
  // phone the whole trigger opens the sheet, and de-selecting is what tapping an
  // already-selected option in that sheet does.
  const pill = (o: SelectOption) => (
    <span className="sel-pill" key={o.value}>
      <span>{o.label}</span>
      {!mobile && (
        <button type="button" aria-label={`Remove ${o.label}`}
          onClick={(e) => { e.stopPropagation(); onChange(value.filter((v) => v !== o.value)); }}>
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );

  return (
    <div className="sel" style={style}>
      {/* A div, not a button: the pills' remove buttons must not be nested inside
          a button (invalid HTML, and the taps stop working). Those buttons
          stopPropagation, so anywhere ELSE on the trigger — including a pill's
          label — opens the picker. */}
      <div id={id} className="sel-trigger sel-trigger-multi" aria-label={ariaLabel}
        ref={ref as React.RefObject<HTMLDivElement>} role="combobox" tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox" aria-expanded={open} aria-disabled={disabled}
        onClick={() => { if (!disabled) setOpen(!open); }}
        onKeyDown={disabled ? undefined : triggerKeys(open, setOpen)}>
        <span className="sel-pills">
          {chosen.length === 0 && <span className="sel-placeholder">{placeholder}</span>}
          {!compact && chosen.map(pill)}
          {compact && pill(chosen[0])}
          {compact && (
            <button type="button" className="sel-more" aria-expanded={overview}
              onClick={(e) => { e.stopPropagation(); setOverview((v) => !v); }}>
              +{chosen.length - 1} more
            </button>
          )}
        </span>
        <ChevronDown size={14} className="sel-chev" aria-hidden />
      </div>
      {/* opens UPWARD — an overview that pushes the form down moves the field the
          user is looking at; laying it over the trigger does not */}
      {compact && overview && (
        <div className="sel-overview">
          <div className="sel-ovhead">
            <span className="micro">{chosen.length} selected</span>
            <button type="button" className="sel-clear" onClick={() => onChange([])}>Remove all</button>
          </div>
          <div className="sel-ovpills">{chosen.map(pill)}</div>
        </div>
      )}
      {open && (
        <Panel options={options} selected={new Set(value)} multi title={title}
          searchable={wantsSearch(searchable, options.length)} anchorRef={ref}
          onPick={(v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])}
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
