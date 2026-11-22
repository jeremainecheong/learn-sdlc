import type { CompiledSnapshot } from './pack-compiler';
import { phaseCheckKind } from './phase-grading';

/**
 * What a version's Requirements phase grades, read from its compiled snapshot:
 * the checks kind (`story`, or the 2.x `markdown`), and for a story the phase's
 * learner story id (`US-4`, or `learner-picks`).
 *
 * The kind is `phaseCheckKind`'s reading. One reading for every caller that
 * has to tell a 2.x TaskTrackr version from a story one: the boot re-pin
 * (`seed/story-repin.service.ts`), which moves learners and classes off the
 * first. The class picker (`classroom/cohort-project.service.ts`) reads
 * Requirements, Design, Deployment and Maintenance together through
 * `olderFormatPhase`.
 */
export function requirementsGrading(compiled: Pick<CompiledSnapshot, 'content'> | null | undefined): {
  kind: string | undefined;
  storyId: string | undefined;
} {
  const checks = compiled?.content?.phases?.find((phase) => phase.key === 'requirements')?.checks as
    | { learnerStory?: { id?: unknown } }
    | undefined;
  const id = checks?.learnerStory?.id;
  return { kind: phaseCheckKind(compiled, 'requirements'), storyId: typeof id === 'string' ? id : undefined };
}
