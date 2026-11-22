import { nextPhaseOf, type EnrollmentView } from '@learnsdlc/shared';

/**
 * Whether the learner has already moved on from a phase, by the
 * shell's enrolment: the project completed, or the learner standing on a
 * later phase. The phase is found in the enrolment by its id, so an enrolment
 * that does not hold it (another project, a stale copy) says nothing and the
 * band stays as it was. `next` is the phase after it by place, if any.
 */
export function movedOnFrom(
  enrollment: EnrollmentView | null,
  phaseId: string,
): { enrollment: EnrollmentView; next: EnrollmentView['phases'][number] | null } | null {
  const mine = enrollment?.phases.find((one) => one.id === phaseId);
  if (!enrollment || !mine) return null;
  if (!enrollment.completed && !(enrollment.currentPhaseOrder > mine.order)) return null;
  return { enrollment, next: nextPhaseOf(enrollment, mine.key) };
}
