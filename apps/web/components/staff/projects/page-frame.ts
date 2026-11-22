/**
 * The width of the teacher's Projects pages.
 *
 * The Projects list and a project's editor draw their own `<main>` inside
 * `AppShell`, as the class pages do, at the class pages' width, so moving from
 * "My classes" to "Projects" never shifts the page sideways or narrows it. The
 * class pages' frame is `.exp-page` in
 * `components/experience/experience.css`: at most 1440 px, centred, with a
 * side padding of 30 px above 1050 px, 24 px from 521 to 1050 px and 16 px
 * at 520 px and under. `WIDE_PAGE` is the same width and the same side
 * padding, so the heading starts at the same left edge on both.
 *
 * The Teacher guide is long prose and keeps its own 900 px column.
 */
export const WIDE_PAGE =
  'mx-auto flex w-full min-w-0 max-w-[1440px] flex-col gap-4 px-4 py-4 sm:py-6 min-[521px]:px-6 min-[1051px]:px-[30px]';

/**
 * A comfortable measure for a text block or a single-column form inside the
 * wide page: 852 px, a 900 px column less its side padding.
 */
export const MEASURE = 'max-w-[852px]';

/** The CSS variable that holds the editor's sticky tab bar's height, as measured. */
export const BAR_HEIGHT_VAR = '--editor-bar-h';

/**
 * The scroll margin of every place a link or a step of the path scrolls to in
 * the project editor: the sticky tab bar's real height (`BAR_HEIGHT_VAR`, set
 * on the editor's `<main>` from the bar as it is drawn, so a bar that wraps to
 * several lines on a phone is counted whole) and a 16 px gap, so the place
 * lands below the bar and not behind it.
 */
export const BELOW_BAR = 'scroll-mt-[calc(var(--editor-bar-h,0px)_+_16px)]';
