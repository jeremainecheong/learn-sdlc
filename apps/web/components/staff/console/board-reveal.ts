/**
 * Brings the head of the class board into view when a teacher presses its
 * Phase map or Table toggle.
 *
 * On a class page the toggle sits above the downloads, the quiz results row
 * and the filters, so at 1440 by 900 a press would draw the table's first row
 * about a screen below the window's foot. This scrolls the page's scroll box by the
 * least that shows the board's head (the column headings and the first
 * learner's row) whole, so what sits above it (the class's numbers, the tab
 * row, the toggle just pressed) stays in view as far as the window allows.
 * The application's top bar and banners sit outside that box, so its top edge
 * is already below every part that stays put.
 *
 * It runs only on a teacher's own press (TeacherPortal.tsx): never on load,
 * never on a refresh or when data arrives, never on Back. It moves no focus
 * and scrolls only the one box, at once.
 */

/** The space kept between the head and the scroll box's edge it is brought to. */
export const REVEAL_GAP = 12;

/** Where things are, in viewport pixels, once the press has been drawn. */
interface RevealMeasure {
  /** The scroll box's top edge, its visible height and how far it is scrolled. */
  boxTop: number;
  boxHeight: number;
  scrollTop: number;
  /** The board's head: the table's top, and the foot of its first row (its heading row when it has none). */
  headTop: number;
  headBottom: number;
}

/**
 * The scroll position that shows the board's head, or null when the head is
 * already whole in view (nothing moves).
 *
 * A head below the window comes up until its foot is `gap` above the box's
 * foot. A head above the window, or one taller than the box, goes to `gap`
 * below the box's top.
 */
export function revealScrollTop(measure: RevealMeasure, gap = REVEAL_GAP): number | null {
  const { boxTop, boxHeight, scrollTop, headTop, headBottom } = measure;
  const boxBottom = boxTop + boxHeight;
  if (headTop >= boxTop && headBottom <= boxBottom) return null;
  const fits = headBottom - headTop <= boxHeight - 2 * gap;
  const target = headTop < boxTop || !fits ? scrollTop + headTop - (boxTop + gap) : scrollTop + headBottom - (boxBottom - gap);
  return Math.max(0, Math.round(target));
}

/** The nearest ancestor that scrolls up and down: the page's own scroll box. */
function scrollBoxOf(node: HTMLElement): HTMLElement | null {
  for (let at = node.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
}

/**
 * Measure the board drawn in `panel` and scroll its box so the head is in
 * view. True when it scrolled.
 */
export function revealBoardHead(panel: HTMLElement, gap = REVEAL_GAP): boolean {
  const box = scrollBoxOf(panel);
  const table = panel.querySelector<HTMLElement>('table');
  if (!box || !table) return false;
  // The sideways-scroll line above a wide table belongs to its head.
  const region = table.closest<HTMLElement>('.experience-scroll-region') ?? table;
  const firstRow =
    table.querySelector<HTMLElement>('tbody tr') ?? table.querySelector<HTMLElement>('thead') ?? table;
  const boxRect = box.getBoundingClientRect();
  const top = revealScrollTop(
    {
      boxTop: boxRect.top,
      boxHeight: boxRect.height,
      scrollTop: box.scrollTop,
      headTop: region.getBoundingClientRect().top,
      headBottom: firstRow.getBoundingClientRect().bottom,
    },
    gap,
  );
  if (top === null) return false;
  box.scrollTop = top;
  return true;
}
