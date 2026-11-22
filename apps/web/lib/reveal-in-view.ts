/**
 * Bring something a press just drew into view inside the box that scrolls it,
 * and move nothing else.
 *
 * `scrollIntoView` scrolls every scrollable ancestor, the page's own frame among
 * them (`.shell-page` is still a scroll container: `components/shell/shell-fidelity.css`),
 * so a reveal made with it can cut off the top of the page. This scrolls one box:
 * the nearest ancestor that scrolls up and down. It is instant, never smooth, and
 * it leaves the keyboard focus where it is.
 *
 * Every reveal here moves the box by the least that brings what it shows into
 * view, and nothing when that is in view already. What lies above the view, or
 * is taller than it, is brought in at its top, so its first lines show; what lies
 * below it is brought up until its foot is in view, and no further.
 */

/** The space kept between the target and the edge of the box it is brought to. */
const MARGIN = 12;

/**
 * How much of an opened fold counts as its first lines: the first block under its
 * summary, up to about six lines of the fold's 13.5 px text.
 */
export const FIRST_LINES = 120;

/** The nearest box around `node` that scrolls up and down, or null where none does. */
export function verticalScroller(node: HTMLElement): HTMLElement | null {
  for (let at = node.parentElement; at; at = at.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

/**
 * The least move (in px, positive scrolls down) that brings the span from `top` to `bottom` into the view, or null
 * when the span is in view already. A span taller than the view keeps its top in view.
 */
function leastMove(view: DOMRect, top: number, bottom: number): number | null {
  if (top >= view.top && bottom <= view.bottom) return null;
  if (top < view.top) return top - view.top - MARGIN;
  return Math.min(bottom - view.bottom + MARGIN, top - view.top - MARGIN);
}

/**
 * Moves `scroller` by `by`, unless that would take `keep` (the field the person is typing in) out of the view while
 * it is in view now: the person's own field is never scrolled away from them. True when it moved the box.
 */
function move(scroller: HTMLElement, view: DOMRect, by: number, keep: HTMLElement | null): boolean {
  if (keep && keep !== scroller && scroller.contains(keep)) {
    const field = keep.getBoundingClientRect();
    const inView = field.top >= view.top && field.bottom <= view.bottom;
    const staysInView = field.top - by >= view.top && field.bottom - by <= view.bottom;
    if (inView && !staysInView) return false;
  }
  const top = Math.max(0, scroller.scrollTop + by);
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'instant' });
  else scroller.scrollTop = top;
  return true;
}

/**
 * Brings `target` into view in `scroller` by the least move. True when it moved the box; false when the target was in
 * view already, nothing around it scrolls, or the move would take `keep` out of the view.
 */
export function revealInScroller(
  target: HTMLElement,
  scroller: HTMLElement | null = verticalScroller(target),
  keep: HTMLElement | null = null,
): boolean {
  if (!scroller) return false;
  const view = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const by = leastMove(view, box.top, box.bottom);
  return by === null ? false : move(scroller, view, by, keep);
}

/**
 * Brings an opened fold into view by the least move. When the whole fold fits the view (with the margin above and
 * below it), all of it is brought in: nothing moves when it is wholly in view already, and a fold opened at the foot
 * of the view comes up until its foot is just above the view's foot, its summary never above the view's top (a short
 * fold, such as one bug and its "What B1 changes", shows without a scroll). A fold
 * taller than that is brought in by its head only: its summary and its first lines (the first block under the
 * summary, at most `FIRST_LINES` of it). The summary that was pressed stays where it was when those lines already show
 * under it; otherwise the box moves only as far as they need, so the rows above it stay in view. True when it moved
 * the box.
 */
export function revealFoldHead(fold: HTMLDetailsElement, scroller: HTMLElement | null = verticalScroller(fold)): boolean {
  if (!scroller) return false;
  const view = scroller.getBoundingClientRect();
  const whole = fold.getBoundingClientRect();
  if (whole.bottom - whole.top + 2 * MARGIN <= view.bottom - view.top) {
    const by = leastMove(view, whole.top, whole.bottom);
    return by === null ? false : move(scroller, view, by, null);
  }
  const summary = Array.from(fold.children).find((child) => child.tagName === 'SUMMARY');
  if (!summary) return revealInScroller(fold, scroller);
  const head = summary.getBoundingClientRect();
  const first = summary.nextElementSibling?.getBoundingClientRect() ?? null;
  const bottom = first ? Math.max(head.bottom, Math.min(first.bottom, head.bottom + FIRST_LINES)) : head.bottom;
  const by = leastMove(view, head.top, bottom);
  return by === null ? false : move(scroller, view, by, null);
}
