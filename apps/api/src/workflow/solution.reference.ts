import type { SolutionUnavailable } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';
import { checksOf, type CompiledTask } from '../content/pack-compiler';

/**
 * What the pack answers for **this task** of this phase, in the pack's own
 * order.
 *
 * `code` phases ship a solution at the very paths the learner edits; `tests`
 * phases ship the reference suite at the learner's own test paths. The other
 * two kinds ship nothing, and the reason is carried so the screen can say it
 * in the pack's terms rather than guess.
 *
 * The *scope* is the task's. `checksOf(phase, task)` is the phase's own checks
 * for a sole task (the snapshot stores them once, on the phase) so on the
 * shipped project every array below is the phase's and the door answers the
 * phase's bytes in the phase's order.
 *
 * **The answers are narrowed at the source, never filtered here.** A task's
 * `checks` slice carries its own `solutionFiles` / `referenceTestFiles` map,
 * and the place to require that the union of the slices' maps is the phase's,
 * with no key in two, is the compiler (it needs no such rule while executable
 * phases are never split across tasks). Filtering a phase-wide map by the
 * task's own targets would be a second, weaker statement of that rule in a
 * different file.
 *
 * **This is a narrowing and never a widening.** Nothing here can put a path
 * behind a door that the phase did not already answer for.
 */
export function referenceFiles(
  phase: PhaseContent,
  task: CompiledTask,
): {
  available: boolean;
  reason: SolutionUnavailable;
  files: [string, string][];
} {
  const checks = checksOf(phase, task);
  const pairs = (order: string[], answers: Record<string, string>): [string, string][] =>
    order.filter((path) => answers[path] !== undefined).map((path) => [path, answers[path]]);
  switch (checks.kind) {
    case 'code':
      return {
        available: true,
        reason: null,
        files: pairs(checks.editableTargets, checks.solutionFiles),
      };
    case 'tests':
      return {
        available: true,
        reason: null,
        files: pairs(checks.learnerTestFiles, checks.referenceTestFiles),
      };
    // A story or design record is prose in a form: the learner's own
    // requirement or design, with no model answer to serve.
    case 'story':
    case 'design':
      return { available: false, reason: 'prose', files: [] };
    // A quiz declares its own `QuizChecks` slice, so it
    // falls here rather than to the phase's checks, which is the seal, and it
    // is the precise reason the slice exemption is written for the phase's
    // sole non-quiz task and **never** for a quiz. A quiz that fell back to an
    // implementation phase's checks would reach `case 'code'` above and hand
    // the learner the model answer through a gate its own pass had opened.
    //
    // The reason is carried rather than left to the `default:` arm because
    // `config` is a different sentence about a different pack: a quiz ships no
    // answer because its answer is a key nobody is ever served, not because
    // the learner wrote configuration for their own machine.
    case 'quiz':
      return { available: false, reason: 'quiz', files: [] };
    default:
      return { available: false, reason: 'config', files: [] };
  }
}
