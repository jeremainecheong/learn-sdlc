/**
 * The Implementation room's first view.
 *
 * At 1440x900 Split leaves about six editor lines, so the room opens on Code
 * below 1600 px and on Split from 1600 px up. The page renders 'code' on the
 * server and on the first client frame (no hydration mismatch); one mount
 * effect moves a wide window to Split before the learner has chosen. The Page
 * preview button is drawn wherever the room has a preview, one click away, so
 * a learner can always see the preview.
 *
 * This file holds the rule. The room that applies it is rendered at each width,
 * and with Run app pressed, in `work-room-header.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import { SPLIT_MIN_WIDTH, initialImplementationView } from '@/components/workspace/implementation-view';

describe('initialImplementationView', () => {
  it('opens on Code below 1600 px and on Split from 1600 px', () => {
    expect(SPLIT_MIN_WIDTH).toBe(1600);
    for (const width of [0, 390, 1024, 1280, 1440, 1599]) expect(initialImplementationView(width)).toBe('code');
    for (const width of [1600, 1680, 1920, 2560]) expect(initialImplementationView(width)).toBe('split');
  });

  it('never opens on the preview alone, and treats a missing width as narrow', () => {
    expect(initialImplementationView(Number.NaN)).toBe('code');
    expect(initialImplementationView(-1)).toBe('code');
  });
});
