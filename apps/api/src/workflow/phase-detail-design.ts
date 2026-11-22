import type { PhaseDetail } from '@learnsdlc/shared';
import type { PhaseChecks } from '../content/content.types';

/**
 * The design spec the room and the teacher's preview render the checks panel
 * from: the two contract switches, the sequence switch, the stories the design
 * must trace to and the floor. Copied, so a caller never holds the compiled
 * snapshot's own objects. Undefined for a phase of any other kind.
 */
export function phaseDetailDesign(checks: PhaseChecks): PhaseDetail['design'] {
  if (checks.kind !== 'design') return undefined;
  return {
    contracts: { ...checks.contracts },
    sequence: checks.sequence,
    stories: checks.stories.map((s) => ({ ...s })),
    floor: { ...checks.floor },
  };
}
