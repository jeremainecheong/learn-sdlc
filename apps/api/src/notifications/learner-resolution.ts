import type { EnrollmentPin } from '../content/content.service';

/**
 * Which project a learner is in, as the reminder sweep asks it.
 *
 * `WorkflowService.projectVersionForLearner` is the answer, and the app module
 * provides it under this token (`useExisting`). The sweep looks it up through
 * `ModuleRef` when it runs, and never names the workflow service: the workflow
 * service injects the feedback service, which injects the notifications
 * service, so a constructor dependency the other way is a cycle Nest waits on
 * for ever, and an import of that module from here is a load-order cycle that
 * leaves a constructor's metadata undefined in whichever process loads this
 * file first. A token and a type-only import carry the call with neither.
 */
export const LEARNER_RESOLUTION = 'LEARNER_RESOLUTION';

export interface LearnerResolution {
  projectVersionForLearner(learner: { id: string; cohort?: string; role?: string }): Promise<EnrollmentPin | null>;
}
