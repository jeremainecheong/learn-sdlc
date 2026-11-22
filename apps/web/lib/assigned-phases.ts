/**
 * The phases of the version a class is assigned, for the teacher's board,
 * which draws a class's phases before (or beside) its learners' own (spec
 * 4.5). The class levers read the same field from the same view.
 *
 * The class's assignment names them (`CohortProjectAssignmentView.phases`, in
 * place order), whoever owns the version: another teacher's project, an
 * older-format or an unpublished version included. The answer is undefined
 * where it names none: a class with no assignment, a version that holds no
 * phase rows here, or a call that fails.
 */
import type { PhaseKey } from '@learnsdlc/shared';
import { instructorApi } from '@/lib/api-instructor';

export async function assignedVersionPhases(cohortId: string): Promise<PhaseKey[] | undefined> {
  try {
    const keys = (await instructorApi.classProject(cohortId))?.active?.phases;
    return keys?.length ? keys : undefined;
  } catch {
    return undefined;
  }
}
