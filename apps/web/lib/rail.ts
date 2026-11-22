import type { EnrollmentView, LearnerAnalytics, PhaseSummary } from '@learnsdlc/shared';
import type { PaletteGroup, ShellNav } from '@/components/shell/types';
import { projectName } from './project-name';


/**
 * The rail's project column, from data the page already has.
 *
 * Every learner page loads the enrolment through one shared, cached loader, so
 * handing the rail its phases costs no request. A page without an enrolment
 * gets nothing and the rail draws its links alone.
 */
export function railOf(
  enrollment: EnrollmentView | null,
  analytics: LearnerAnalytics | null,
  currentPhase?: PhaseSummary,
  /**
   * What ⌘K finds beyond the phases and the links: the learner's criteria,
   * code, tests and artefacts. Built by {@link useProjectPalette} on the page,
   * because it costs a pass over the project map and a page renders often.
   */
  paletteGroups?: PaletteGroup[],
): ShellNav | undefined {
  if (!enrollment) return undefined;
  return {
    projectTitle: projectName(enrollment.projectTitle),
    phases: enrollment.phases,
    currentPhaseId: currentPhase?.id,
    tokensToday: analytics?.tokensToday,
    paletteGroups,
  };
}
