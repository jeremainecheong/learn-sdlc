/**
 * The workspace: the demo clock, the commit message limit, the pinned run
 * clock and the warm-up row's status.
 */

/* ------------------------------- demo clock ------------------------------ */

/**
 * The demo clock's state. Present only on a loopback, non-production API
 * started with DEMO_CLOCK=true; every other deployment answers 404, so a
 * client that gets this shape back knows it is talking to a demo laptop.
 */
export interface DemoClockView {
  /** True while the process is reporting a time other than the real one. */
  engaged: boolean;
  /** What the API currently believes the time is, ISO 8601. */
  now: string;
  /**
   * How far ahead of the real clock it is, in milliseconds. Negative while the
   * clock is wound back to the start of a seeded term; a span only ever moves
   * it forward.
   */
  offsetMs: number;
}

/* ------------------- the workspace: commit, clock, warm-up ------------------ */

/** The longest a commit message may be, so the field and the DTO agree. */
export const COMMIT_MESSAGE_MAX = 140;

/** An ISO date, and the only shape the run clock accepts. */
export const RUN_CLOCK_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** What a learner is told when the date they pinned is not one. */
export const RUN_CLOCK_MESSAGE = 'pin the clock to a date, as 2026-03-01';

/** What `PUT /phases/:id/clock` answers. */
export interface RunClockSaved {
  saved: true;
  runClock: string | null;
}

/** The status a stored warm-up row (`warmup_states.status`) holds. */
export type WarmupStatus = 'not_started' | 'in_progress' | 'done';
