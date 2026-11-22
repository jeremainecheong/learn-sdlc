import { splittableCheckKind } from '@learnsdlc/shared';
import type { ProjectContent } from './content.types';
import { isOlderWritten, isOlderWrittenKind } from './older-written';
import { editablePathsOf, gradedUnitsOf, soleNonQuizTask, unitKey, type CompiledPhaseTasks } from './pack-compiler';

/**
 * Whether this build serves the phase a stored snapshot declared tasks for:
 * the compile-time scope restated at the runtime seam, plus the stored older
 * written shape whose grading is shut (see the second arm below).
 *
 * **One task is always servable, of every kind.** That is not a concession: it
 * is the mainline. Every phase of every teacher-authored project already holds
 * exactly one authored task keyed `main`, of whatever kind the phase is graded
 * by, and refusing those would refuse every teacher project on the platform.
 * It is also why this asks `length < 2` rather than `soleTaskList`: the
 * question here is how many tasks the phase holds, not whether the one it holds
 * is the synthesised sole task, and those have different answers for every
 * teacher project.
 *
 * **Both conjuncts for a longer list**, because the phase's kind is not the
 * only thing that decides what a report is built from: `checksOf` reads the
 * task's own checks where it declares them, so a `code`-kind task on a `story`
 * phase would reach the executable builders through a phase the phase-level
 * test called written. The compile rule the teacher meets is stated with the
 * same two conjuncts, and this is the statement against a snapshot that never
 * met it.
 *
 * A phase key the version's own content does not declare is a snapshot whose
 * tasks and whose phases disagree about what the version holds. There is no
 * kind to ask about, so it reads shut.
 *
 * **The wall's two arms, verbatim.** The compiler refuses a *shape*, not a
 * *count* (`pack-compiler.ts`, `tasks-in-a-phase-share-one-kind`), and a
 * runtime statement that refused on the count would refuse versions the
 * compiler publishes: publish would succeed and every learner pinned to it would take a
 * 500 on their next board, because this is the one seam an enrolment resolves
 * through. So the two statements are one statement, written twice: the same
 * two arms, the same conjuncts, and never a loosened kind test. The docstring's
 * own reason above is what makes that necessary rather than tidy: it becomes
 * true again the instant a **second** executable task appears, and the three
 * ownership conjuncts are what keep the first one whole. The one reading the
 * compiler has no twin for is the stored older written phase in arm one: an
 * upload never reaches the compiler with markdown checks (the loader converts
 * an older Requirements or Design and refuses the kind under any other key),
 * so the runtime reads that shape only for the rows already published.
 */
export function servablePhase(content: ProjectContent, compiled: CompiledPhaseTasks): boolean {
  if (compiled.tasks.length < 2) return true;
  const phase = content.phases.find((one) => one.key === compiled.key);
  if (!phase) return false;
  // Arm one: written work beside quizzes. Every task is graded by a kind whose
  // evidence costs no microVM, which is `splittableCheckKind` and is the
  // predicate the compiler's second refusal reads. The written phase kinds
  // (story, design) share it.
  if (phase.checks.kind === 'story' || phase.checks.kind === 'design') {
    return compiled.tasks.every((task) => splittableCheckKind(task.checkKind));
  }
  // Arm one also takes a stored older Requirements or Design: a phase whose
  // checks are the older markdown kind, under one of the two keys a structured
  // kind still keeps, with every task written (markdown) or a quiz. Such rows
  // were published under the same rule, and their learners keep their
  // board. Nothing new can take this shape: the loader converts or refuses
  // markdown on upload, draft publish refuses it at its own door, and the
  // compiler's wall backs both. Nothing is graded through it: a submit, a run or a
  // queued job on such a task fails closed with the phase's older-format room
  // sentence (`olderFormatRoomSentence`). The kind is compared as a string,
  // since `ArtifactKind` does not name it. Under any other key the markdown
  // phase is a retired one, and two written tasks on it stay refused.
  if (isOlderWritten(phase.checks) && (phase.key === 'requirements' || phase.key === 'design')) {
    return compiled.tasks.every(
      (task) => isOlderWrittenKind(task.checkKind) || task.checkKind === 'quiz',
    );
  }
  // Arm two: the all-six-phases rule. Exactly one task is not a quiz, it is
  // graded by the phase's own checks, and it owns every graded unit the phase
  // declares and every editable path the phase mounts. A phase shaped that way
  // divides nothing: the mapping from unit to task is total and constant, so
  // the executable task's grading is the phase's grading, expression for
  // expression. Drop any one conjunct and the reason above is live again.
  const only = soleNonQuizTask(compiled.tasks);
  if (!only || only.checkKind !== phase.checks.kind) return false;
  const mine = new Set(only.gradedUnits.map(unitKey));
  if (!gradedUnitsOf(phase).every((unit) => mine.has(unitKey(unit)))) return false;
  const held = new Set(only.owns);
  return editablePathsOf(phase).every((at) => held.has(at));
}
