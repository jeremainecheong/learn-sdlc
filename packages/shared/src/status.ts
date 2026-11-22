/**
 * The one status vocabulary every list shares.
 *   pass, gate cleared (green fill)
 *   done, finished, no gate (phase-hue fill)
 *   now, the thing being worked on (accent outline)
 *   todo, not started or locked (dashed)
 *   fail, failing (red fill)
 *   warn, needs a decision or a resubmission (orange fill)
 *
 * It sits in the shared package beside {@link ./map} because the project map is
 * built by the API as well as the browser. The web app's `lib/phase.ts`
 * re-exports both names for its own imports.
 */
import type { PhaseStatus } from './phases';

export type StatusState = 'pass' | 'done' | 'now' | 'todo' | 'fail' | 'warn';

export function statusState(status: PhaseStatus, isCurrent: boolean): StatusState {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'locked':
      return 'todo';
    case 'submitted':
      // submitted and not passed means the last attempt fell short of the gate
      return 'warn';
    case 'in_progress':
    default:
      return isCurrent ? 'now' : 'todo';
  }
}
