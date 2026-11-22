import type { FeedbackReport } from '@learnsdlc/shared';

/**
 * The signals that put a learner on the class queue and in the bell, shared so
 * the console and a notification say the same thing about one learner.
 */

/** A learner with no activity for this long is on the queue whatever their scores say. */
export const IDLE_DAYS = 7;
/** Two goes at the same gate is the point where a nudge beats another attempt. */
export const STUCK_ATTEMPTS = 2;

/**
 * The integrity signals a report raises, in words an instructor can act on.
 *
 * Exported so the bell says exactly what the class queue says
 * about the same submission. Two copies of this sentence is how a console and
 * a notification come to disagree about one learner.
 */
export function integrityReasons(report: FeedbackReport | null | undefined): string[] {
  if (!report) return [];
  const flags = report.integrity;
  const reasons: string[] = [];
  if (flags.relianceFlag) reasons.push('leaning on the mentor');
  if (flags.mentorPasteFlag) reasons.push('a passage matches a mentor reply');
  if (flags.noEffortFlag) reasons.push('passed with no run and heavy hint use');
  return reasons;
}
