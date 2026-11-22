import type { PhaseSolutionMeta, PhaseStatus } from '@learnsdlc/shared';

/**
 * Whether a room may draw *Read the reference solution* for a phase.
 *
 * A passed phase the pack answers, and one whose pass the strict review
 * accepted. A teacher's Pass or Sign off reads
 * `passed` on the board with no reviewed revision behind it; the route opens
 * on the gate's evidence and nothing less, and the phase detail says so with
 * `solution.awaitingReview`. One predicate for every room that draws the
 * door, so none of them offers one the route refuses.
 */
export function solutionDoorOpen(
  phase: { status: PhaseStatus; solution?: PhaseSolutionMeta } | null | undefined,
): boolean {
  return phase?.status === 'passed' && !!phase.solution?.available && !phase.solution.awaitingReview;
}
