/**
 * How long after a start the first retention sweep waits, by default: two
 * hours. A deployment step that compares every table before and after a new
 * process starts must see no housekeeping writes in between, and two hours is
 * well past any such check.
 *
 * The cost: a process that lives less than two hours never sweeps. A laptop
 * started for one class session keeps its emptiable reset copies and its
 * month-old cache rows until it is left up longer than that.
 */
export const DEFAULT_FIRST_SWEEP_DELAY_MS = 2 * 60 * 60 * 1000;

/** The longest delay a Node timer holds; a larger value would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * RETENTION_FIRST_SWEEP_DELAY_MS, in milliseconds: set it lower (0 sweeps at
 * once) on a machine that never runs a before-and-after comparison of its
 * tables. Anything that is not a whole number a timer can hold leaves the
 * default.
 */
export function resolveFirstSweepDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RETENTION_FIRST_SWEEP_DELAY_MS || '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_FIRST_SWEEP_DELAY_MS;
  const value = Number(raw);
  return value <= MAX_TIMER_MS ? value : DEFAULT_FIRST_SWEEP_DELAY_MS;
}
