// The browser's TOP LAYER, in one helper.
//
// Every floating surface in this app used to be ordered by a number: the modal at
// --z-modal, the picker at --z-picker, the tooltip at --z-tip. That works exactly
// as long as everyone remembers the numbers — and it stopped working the first
// time a bottom sheet was opened from inside a modal, because the sheet portals to
// <body> and JSX nesting buys it nothing.
//
// The top layer answers it structurally instead: it paints above every z-index in
// the document, and it orders by "LAST OPENED WINS". A picker is always opened FROM
// some surface, so it is always opened later, so it is always on top. That is the
// hand-written rule, enforced by the platform.
//
// Two entrances, one behaviour: `<dialog>.showModal()` (see Modal in ui.tsx) and
// the Popover API for everything else, which is what this helper drives.
//
// `popover="manual"` on purpose — NOT "auto". Auto brings light-dismiss, which
// hides the popover on pointerdown; the trigger's own click handler then runs
// against state that already flipped and re-opens it. These surfaces bring their
// own scrim, their own Escape handler and their own React state, so all that is
// wanted from the platform here is the layer.
//
// A browser without the Popover API keeps the element exactly where it is, ordered
// by the --z-* token in its class — i.e. the old behaviour, unchanged.

export const HAS_POPOVER = typeof HTMLElement !== 'undefined'
  && typeof HTMLElement.prototype.showPopover === 'function';

/** Put `el` in the top layer while `on` is true. Idempotent — safe to call on every render. */
export function topLayer(el: HTMLElement | null, on: boolean): void {
  if (!el || !HAS_POPOVER) return;
  const open = el.matches(':popover-open');
  if (on === open) return;
  if (on) {
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    el.showPopover();
  } else {
    el.hidePopover();
  }
}
