/**
 * The suite's common waits, named, so a slower machine raises one class of
 * wait in one place. A spec that needs a different wait for one step writes
 * its own value beside the reason.
 *
 * The per-test budget (300 s) and the per-assertion default (20 s) are set in
 * playwright.config.ts.
 */

/** A control, a line of text or a panel appearing after the step that brings it. */
export const UI_READY = 30_000;

/** A page load, a route change, or a screen that reads several API routes first. */
export const NAVIGATION = 60_000;

/** Learner code run in the code runner, or a submission graded. */
export const SANDBOX_RUN = 120_000;
