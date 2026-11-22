/**
 * Which view the Implementation room opens on.
 *
 * Split puts the preview beside the code; on a 1440x900 screen that leaves the
 * editor about six lines. So the room opens on Code below 1600 px and on Split
 * from 1600 px up. It never opens on the preview alone, and the preview button
 * stays in the room's view tabs wherever the room has a preview, one click
 * away: students can always see previews.
 *
 * The page renders 'code' on the server and on the first client frame, so the
 * markup matches during hydration; a mount effect then applies this to the
 * window's width, before the learner has chosen a view.
 */
export type InitialImplementationView = 'code' | 'split';

/** The narrowest window that opens on Split. */
export const SPLIT_MIN_WIDTH = 1600;

export function initialImplementationView(width: number): InitialImplementationView {
  return width >= SPLIT_MIN_WIDTH ? 'split' : 'code';
}
