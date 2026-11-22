import { SOLE_TASK_KEY } from '@learnsdlc/shared';
import type { PhaseContent } from './content.types';
import { gradedUnitsOf, type CompiledTask, type GradedUnit } from './pack-compiler';

/**
 * The reader's seam for the task grain: the one sole-task predicate, and the
 * derivations every builder, gate and roll-up asks through it.
 *
 * Pure, and database-free on purpose. `feedback` already reads `content`, so
 * this module lives here and the graders import it rather than the other way
 * round; nothing in it touches an entity, a repository or a request.
 *
 * Everything here is one corollary written down once:
 *
 * **The sole task is the phase.** For a phase whose compiled list is one
 * *synthesised* task, that task's checks are the phase's, its owned paths are
 * every editable path, its graded units are `gradedUnitsOf(phase)`, its rubric
 * is the phase's and it is required. So every derivation below is
 * `soleTaskList(tasks) ? <the phase-wide expression, unchanged> : <the per-task
 * expression>`, and the first arm is the phase-wide code, unchanged. The
 * branch is not an optimisation; it is the proof.
 */

/**
 * Whether this phase's compiled list is the **synthesised sole task**: the one
 * shape whose per-task question has a phase-wide answer.
 *
 * **Both conjuncts, and neither alone.**
 *
 * `tasks.length === 1` alone is wrong, and in this tree it is wrong on the
 * mainline rather than in a corner: every phase of every teacher-authored
 * project already holds exactly one *authored* task, keyed `main`
 * (`INHERITED_TASK_KEY`). Such a phase compiles (orders contiguous, one
 * required, units non-empty and disjoint), and under a length test it would
 * take the phase-wide arm, where it gets no `task_states` row while its
 * required set is `{'main'}`. A key with no row is a failing key, so the phase
 * could never pass.
 *
 * `taskKey === SOLE_TASK_KEY` alone is wrong in the other direction: the
 * compiler accepts the empty key inside an authored list, so a phase authored
 * as `['' required, 'web' optional]` would take the phase-wide arm, where the
 * verdict is whichever task's submission landed, and passing the **optional**
 * task would open the phase and serve its answer key. A compile rule refuses
 * that list at publish, and this function does not have to know about it, which
 * is the point of having one predicate.
 *
 * This is the **only** place either test is written. A second copy is a second
 * answer.
 */
export function soleTaskList(tasks: readonly CompiledTask[]): boolean {
  return tasks.length === 1 && tasks[0].taskKey === SOLE_TASK_KEY;
}

/**
 * The keys that gate the phase, from the **pinned version's** task list.
 *
 * Derived here rather than passed in, so no caller can hand a roll-up a set
 * derived from the rows it is quantifying over, which is exactly the mistake
 * that made a missing row invisible.
 */
export function requiredKeysOf(tasks: readonly CompiledTask[]): Set<string> {
  return new Set(tasks.filter((task) => task.required).map((task) => task.taskKey));
}

/** The graded units this task is scored by. For a sole task, the phase's own. */
export function unitsOf(
  phase: PhaseContent,
  tasks: readonly CompiledTask[],
  task: CompiledTask,
): GradedUnit[] {
  return soleTaskList(tasks) ? gradedUnitsOf(phase) : task.gradedUnits;
}

/**
 * Whether this task owns one graded unit.
 *
 * The kind is an argument rather than inferred from the id because the three
 * namespaces are separate, a rule and a run may legitimately share a name,
 * so "does this task own that unit" is a question about a pair.
 */
export function ownsUnit(
  phase: PhaseContent,
  tasks: readonly CompiledTask[],
  task: CompiledTask,
  kind: GradedUnit['kind'],
  id: string,
): boolean {
  return unitsOf(phase, tasks, task).some((unit) => unit.kind === kind && unit.id === id);
}
