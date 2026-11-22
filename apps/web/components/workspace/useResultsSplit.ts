'use client';

/**
 * The room's working area by its height as well as its width.
 *
 * Two readings, both from a ResizeObserver:
 *
 * - **the pane area** (the row of brief, centre and mentor). Under
 *   {@link FOCUS_BELOW} px the room defaults to a focused mode: the brief and
 *   the mentor start collapsed (their toggles still open them) and the centre
 *   shows the editor or the results, with a Code / Results switch, rather than
 *   a split that leaves a results strip of a few lines;
 * - **the centre column's split** between the editor and the results under it.
 *   The learner drags it (or moves it with the arrow keys); the editor keeps
 *   at least {@link EDITOR_MIN} px and the results at least
 *   {@link RESULTS_MIN}. Where both cannot fit, the results fold to their tab
 *   bar and the room offers "Show results".
 *
 * Nothing here unmounts anything: the editor, its file, its caret and the
 * selected result tab are the same elements in every mode.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export const FOCUS_BELOW = 520;
export const EDITOR_MIN = 240;
export const RESULTS_MIN = 160;
/** The results' tab bar alone, when the split cannot hold both minimums. */
export const RESULTS_BAR = 46;
/**
 * What the editor keeps, when it can, under results the learner asked to see
 * on a column too short for both minimums; where even that does not leave the
 * results their minimum, the editor gives the rest, down to nothing, as the
 * room did before the split: the console the learner opened matters more than
 * an editor of a few lines, and the app preview above keeps its own height so
 * the app stays usable.
 */
export const HELD_OPEN_EDITOR_MIN = 120;
/** The least the held-open results are worth drawing: their tab bar and a few lines. */
export const HELD_OPEN_RESULTS_MIN = RESULTS_BAR + 24;
const STEP = 24;

export interface Split {
  /** The results' height in px. */
  results: number;
  /** Both minimums do not fit: the results show their tab bar only. */
  collapsed: boolean;
  /** Whether the column has been measured at all (never, in a unit test's DOM). */
  measured: boolean;
}

/**
 * The split for `avail` px of editor plus results, given the height the learner
 * asked for. `holdOpen` is the learner's own ask for the results (the console
 * opened from the running app, the merged-head e2e's preview case): on a
 * column too short for both minimums the results then keep up to
 * {@link RESULTS_MIN}, the editor keeps {@link HELD_OPEN_EDITOR_MIN} where that
 * still leaves the results their minimum and otherwise gives way down to
 * nothing, rather than the results folding to their bar with no room for the
 * console. The app preview above is not touched: shrinking it left the app's
 * frame unusable.
 */
export function splitFor(avail: number, wanted: number, holdOpen = false): Split {
  if (avail <= 0) return { results: wanted, collapsed: false, measured: false };
  if (avail < EDITOR_MIN + RESULTS_MIN) {
    if (holdOpen && avail >= HELD_OPEN_RESULTS_MIN) {
      const editor = Math.min(HELD_OPEN_EDITOR_MIN, Math.max(0, avail - RESULTS_MIN));
      return { results: Math.min(RESULTS_MIN, avail - editor), collapsed: false, measured: true };
    }
    return { results: RESULTS_BAR, collapsed: true, measured: true };
  }
  return { results: Math.round(Math.min(Math.max(wanted, RESULTS_MIN), avail - EDITOR_MIN)), collapsed: false, measured: true };
}

/**
 * The results' height in a code room before the learner drags it, given the
 * room the column has (`avail`) and the tab the results show.
 *
 * A run's results and a review are read whole: every code room gives its Tests and
 * Review tabs 320 px once there is a run to read (a 190 px pane would put the Maintenance room's
 * three test rows under the fold) or the review is open. Before any run the other
 * rooms give the editor the room.
 */
export function roomResultsHeight({ implementation, bottom, hasRun, avail }: { implementation: boolean; bottom: string; hasRun: boolean; avail: number }): number {
  // The Ledger and the Problems list are read row by row like Health: at 160 px the Ledger showed two of its
  // claims at 1440 x 900, so they take Health's 300. The terminal and the console keep 160.
  if (implementation) return bottom === 'feedback' || bottom === 'tests' ? 320 : bottom === 'health' || bottom === 'ledger' || bottom === 'problems' ? 300 : 160;
  if (bottom === 'feedback' || (bottom === 'tests' && hasRun)) return 320;
  return Math.min(220, Math.max(160, Math.round(avail * 0.3)));
}

/** Whether a pane area this tall opens in the focused mode. Unmeasured (0) is not short. */
export function isShortArea(height: number): boolean {
  return height > 0 && height < FOCUS_BELOW;
}

/** The height of the column's children that are neither the editor nor the results. */
function chromeOf(section: HTMLElement): number {
  let used = 0;
  for (const child of Array.from(section.children) as HTMLElement[]) {
    if (child.matches('[data-testid="editor-host"], [data-testid="bottom-panel"], .results-split-handle')) continue;
    used += child.offsetHeight;
  }
  return used;
}

export function useResultsSplit({
  areaRef,
  sectionRef,
  defaultResults,
  remeasure,
  holdOpen = false,
}: {
  areaRef: RefObject<HTMLElement | null>;
  sectionRef: RefObject<HTMLElement | null>;
  /** The results' height before the learner has dragged it, given the room the column has. */
  defaultResults: number | ((avail: number) => number);
  /** Anything that changes the column's own chrome (the view, the console). */
  remeasure?: unknown;
  /** The learner's own ask for the results (the console opened): see {@link splitFor}. */
  holdOpen?: boolean;
}) {
  const [areaHeight, setAreaHeight] = useState(0);
  const [avail, setAvail] = useState(0);
  const [wanted, setWanted] = useState<number | null>(null);

  const measure = useCallback(() => {
    const area = areaRef.current;
    const section = sectionRef.current;
    if (area) setAreaHeight(Math.round(area.getBoundingClientRect().height));
    if (section) setAvail(Math.max(0, Math.round(section.clientHeight - chromeOf(section))));
  }, [areaRef, sectionRef]);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    if (areaRef.current) observer.observe(areaRef.current);
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, [measure, areaRef, sectionRef]);

  useEffect(() => {
    measure();
  }, [measure, remeasure]);

  const fallback = typeof defaultResults === 'function' ? defaultResults(avail) : defaultResults;
  const split = splitFor(avail, wanted ?? fallback, holdOpen);

  const drag = useRef<{ y: number; start: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    drag.current = { y: event.clientY, start: split.results };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setWanted(drag.current.start + (drag.current.y - event.clientY));
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const max = Math.max(RESULTS_MIN, avail - EDITOR_MIN);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const now = split.results;
    const next =
      event.key === 'ArrowUp' ? now + STEP
        : event.key === 'ArrowDown' ? now - STEP
          : event.key === 'Home' ? max
            : event.key === 'End' ? RESULTS_MIN
              : null;
    if (next === null) return;
    event.preventDefault();
    setWanted(Math.min(Math.max(next, RESULTS_MIN), max));
  };

  return {
    areaHeight,
    focused: isShortArea(areaHeight),
    split,
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'horizontal' as const,
      'aria-label': 'Resize the results under the code',
      'aria-valuemin': RESULTS_MIN,
      'aria-valuemax': max,
      'aria-valuenow': split.results,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
    },
  };
}
