'use client';

/**
 * Where the room of a split phase opens.
 *
 * On a phase a teacher split, the task list and the IDE row scroll together
 * (`RoomStack`). The row keeps a floor, so the editor is never squeezed shut,
 * but on a laptop the list is tall enough that the editor would start below
 * the fold: at 1280x800 the file-tab strip would be the only part of the row
 * on screen.
 *
 * So the room places its region once, on arrival: it scrolls by the least that
 * puts {@link EDITOR_PEEK_PX} of the editor on screen, and never past the top
 * of the IDE row, so the row opens whole with its file tabs. The list above is
 * one scroll away.
 *
 * It is a placement, not a pin. It stands down for good the moment the learner
 * scrolls, wheels, taps or types in the region, and after
 * {@link ARRIVAL_SETTLE_MS} whatever happens; until then it re-places the
 * region when the stack changes height under it (the gate banner and the task
 * counts arrive a moment after the room does).
 */
import { useEffect, type RefObject } from 'react';

/** How much of the editor is on screen when the room opens: its first lines, not a strip of tabs. */
export const EDITOR_PEEK_PX = 160;

/**
 * A scroll that would stop this close above the IDE row goes to the row
 * instead, so the region never opens on a sliver of the list.
 */
export const ANCHOR_SNAP_PX = 80;

/** How long the arrival placement follows the stack settling, at most. */
export const ARRIVAL_SETTLE_MS = 2_500;

/** What the placement is computed from, all in px of the region's scroll content. */
export interface ArrivalMeasure {
  /** The region's visible height. */
  viewport: number;
  /** Where the editor starts, measured from the top of the stack. */
  editorTop: number;
  /** The furthest the region may scroll on arrival: the IDE row, with its margin. */
  anchorTop: number;
}

/**
 * The region's `scrollTop` on arrival. Zero where the editor already shows;
 * otherwise the least scroll that shows {@link EDITOR_PEEK_PX} of it, snapped
 * to the anchor when it would stop within {@link ANCHOR_SNAP_PX} of it, and
 * never past the anchor.
 */
export function arrivalScrollTop(
  { viewport, editorTop, anchorTop }: ArrivalMeasure,
  peek = EDITOR_PEEK_PX,
  snap = ANCHOR_SNAP_PX,
): number {
  const need = Math.ceil(editorTop + peek - viewport);
  if (need <= 0) return 0;
  const ceiling = Math.max(0, Math.floor(anchorTop));
  if (need >= ceiling - snap) return ceiling;
  return need;
}

/**
 * The region's measure, or null while the editor is not drawn: below `lg`
 * the room shows one pane at a time, and a pane that is not the code's has no
 * editor to reveal.
 */
export function measureArrival(region: HTMLElement): ArrivalMeasure | null {
  const editor = region.querySelector<HTMLElement>('[data-testid="editor-host"]');
  const anchor = region.querySelector<HTMLElement>('[data-active-pane]');
  if (!editor || !anchor) return null;
  const drawn = editor.getBoundingClientRect();
  if (drawn.width <= 0 || drawn.height <= 0) return null;
  const box = region.getBoundingClientRect();
  const into = (top: number) => top - box.top + region.scrollTop;
  const margin = Number.parseFloat(getComputedStyle(anchor).marginTop) || 0;
  return {
    viewport: region.clientHeight,
    editorTop: into(drawn.top),
    anchorTop: into(anchor.getBoundingClientRect().top) - margin,
  };
}

/**
 * Bring a file tab into view by moving its strip sideways, and nothing else.
 *
 * `scrollIntoView` scrolls every scrollable ancestor, and on a split phase one
 * of those is the room region: selecting a tab would move the whole room down
 * until the strip sat at the bottom edge, leaving the editor out of view.
 */
export function revealTabInStrip(strip: HTMLElement, tab: HTMLElement): void {
  const edge = strip.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  if (box.left < edge.left) strip.scrollLeft -= edge.left - box.left;
  else if (box.right > edge.right) strip.scrollLeft += Math.min(box.right - edge.right, box.left - edge.left);
}

/** What the learner does in the region that means the placement is theirs from now on. */
const TAKEN_OVER = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Place `region` on arrival, once per `arrival` (the phase and the task), and
 * only where `enabled`: a phase with one task has no stack to place.
 */
export function useArrivalReveal(
  region: RefObject<HTMLElement | null>,
  arrival: string,
  enabled: boolean,
): void {
  useEffect(() => {
    const node = region.current;
    if (!enabled || !node) return;
    let done = false;
    /** The `scrollTop` this placement last left, so a scroll by anyone else is noticed. */
    let left: number | null = null;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    const finish = () => {
      if (done) return;
      done = true;
      observer?.disconnect();
      for (const kind of TAKEN_OVER) node.removeEventListener(kind, finish);
      window.clearTimeout(timer);
    };
    function place() {
      if (done || !node) return;
      if (left !== null && Math.abs(node.scrollTop - left) > 1) {
        finish();
        return;
      }
      const measure = measureArrival(node);
      if (!measure) return;
      const top = arrivalScrollTop(measure);
      if (Math.abs(node.scrollTop - top) > 1) node.scrollTop = top;
      left = node.scrollTop;
    }
    for (const kind of TAKEN_OVER) node.addEventListener(kind, finish, { passive: true });
    observer?.observe(node);
    for (const child of Array.from(node.children)) observer?.observe(child);
    const timer = window.setTimeout(finish, ARRIVAL_SETTLE_MS);
    const frame = requestAnimationFrame(place);
    return () => {
      cancelAnimationFrame(frame);
      finish();
    };
  }, [region, arrival, enabled]);
}
