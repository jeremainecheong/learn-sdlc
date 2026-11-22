import type { ProjectContent } from '../content/content.types';
import type { EnrollmentEntity, PhaseStateEntity } from '../db/entities';

/**
 * The phase states an enrolment's board draws and counts: for a pinned
 * enrolment, only those whose key its version holds, as the
 * learner's own board filters them (`WorkflowService.enrollmentView`). A row
 * pinned at its project's first publish may keep a state for a phase that
 * version lacks (`pinNullRowsAtFirstPublish`); it stays in the store and is
 * never drawn, numbered or counted, so it adds no column and no "/ n" on a
 * teacher's board, no phase to the record and no pass to a count. A null pin
 * keeps every state, as the learner's board does: it follows the head, and a
 * phase a newer head dropped stays on its board by its key, with the
 * learner's work. The teacher's views (`InstructorService`), the analytics
 * and the repository export read their states through this one rule. A fault
 * pin, one naming no version installed here, is served the head, so its board
 * reads as the head's, as `advance` and completion do.
 */
export function statesOnBoard<T extends Pick<PhaseStateEntity, 'phaseKey'>>(
  enrollment: Pick<EnrollmentEntity, 'projectVersionId'>,
  project: Pick<ProjectContent, 'phases'>,
  states: T[],
): T[] {
  if (!enrollment.projectVersionId) return states;
  return states.filter((state) => project.phases.some((phase) => phase.key === state.phaseKey));
}

/**
 * How many phases an enrolment's "n of m" counts: the pinned version's phase
 * count, whose every phase completion asks for, even when the board holds
 * fewer states than its version (an imported one); a null pin counts the
 * states on its board.
 */
export function phasesToCount(
  enrollment: Pick<EnrollmentEntity, 'projectVersionId'>,
  project: Pick<ProjectContent, 'phases'>,
  onBoard: readonly unknown[],
): number {
  return enrollment.projectVersionId ? project.phases.length : onBoard.length;
}
