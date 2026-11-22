import { describe, expect, it } from 'vitest';
import { EDITOR_MIN, HELD_OPEN_EDITOR_MIN, HELD_OPEN_RESULTS_MIN, RESULTS_BAR, RESULTS_MIN, splitFor } from '@/components/workspace/useResultsSplit';

/**
 * The results split rule, and its one exception: a column too
 * short for both minimums folds the results to their bar, unless the learner
 * asked for them (the console opened from the running app), when the results
 * keep their height and the preview above shrinks instead of being hidden.
 */
describe('the editor and results split', () => {
  it('gives both their minimums where they fit, and the asked height within them', () => {
    expect(splitFor(600, 200)).toEqual({ results: 200, collapsed: false, measured: true });
    expect(splitFor(600, 20)).toEqual({ results: RESULTS_MIN, collapsed: false, measured: true });
    expect(splitFor(600, 900)).toEqual({ results: 600 - EDITOR_MIN, collapsed: false, measured: true });
  });

  it('folds the results to their bar where both minimums cannot fit', () => {
    expect(splitFor(EDITOR_MIN + RESULTS_MIN - 1, 200)).toEqual({ results: RESULTS_BAR, collapsed: true, measured: true });
  });

  it('holds the results open under a shrunk editor when the learner asked for them', () => {
    // 300 px: the results keep their minimum, the editor keeps 120 (140 would fit, 120 is the hold's share).
    expect(splitFor(300, 200, true)).toEqual({ results: RESULTS_MIN, collapsed: false, measured: true });
    // 250 px: the results keep their minimum and the editor the 90 left.
    expect(splitFor(250, 200, true)).toEqual({ results: RESULTS_MIN, collapsed: false, measured: true });
    // 90 px (the Split view at 1280 by 720 under a 320 px preview): the editor gives way; the results take it all.
    expect(splitFor(90, 200, true)).toEqual({ results: 90, collapsed: false, measured: true });
    // Below the tab bar and a few lines: the bar alone.
    expect(splitFor(HELD_OPEN_RESULTS_MIN - 1, 200, true)).toEqual({ results: RESULTS_BAR, collapsed: true, measured: true });
    // Unmeasured stays unmeasured.
    expect(splitFor(0, 200, true)).toEqual({ results: 200, collapsed: false, measured: false });
    expect(HELD_OPEN_EDITOR_MIN).toBe(120);
  });
});
