import type { EntityManager } from 'typeorm';
import { soleNonQuizTask, type CompiledTask } from '../content/pack-compiler';
import { SubmissionEntity, type PhaseStateEntity, type TaskStateEntity } from '../db/entities';

/* ----------------------- the adoption of legacy revisions ----------------- */

/**
 * Give a phase's legacy revisions (written before revisions carried a task
 * key) the key its one task declares.
 *
 * A phase with exactly one task has exactly one owner for its history, and
 * `taskKey: ''` on those rows is the migration's backfill default rather than
 * a learner's answer. Every phase of every teacher-authored project declares
 * `main`, so a learner who submitted before the upgrade holds passing revisions that the
 * pinned version's required key cannot see: `strictPass`' `taskKey` narrow
 * finds nothing and `advance` refuses for ever.
 *
 * **The trigger is the board's state, not the fact that a call inserted a
 * row.** `submit`'s insert reaches the database through `loadOwnedState`, which
 * stamps the pack and does *not* repair the board (`reconcileToPack` is reached
 * only from `phaseSummaries`, `enrollmentView` and `phaseDetail`), so an
 * insert-keyed adoption would never fire for a learner whose first request
 * after the upgrade is a submit. Hence: every creator, on every pass.
 *
 * **`status NOT IN ('queued','running')` is not tidiness.** Across an upgrade
 * a learner can hold a legacy `queued` row keyed `''` beside a newer
 * in-flight row keyed `main`; rewriting the first would collide
 * with the second under `UQ_submissions_in_flight (phaseStateId, taskKey)` and
 * the violation would propagate out of `repairBoard` and 500 the learner's
 * board until the stale row aged out. Excluding them is also why the adoption
 * has to run on every pass rather than once: a `''` row that is queued at
 * upgrade time and completes after the first repair is exactly the population
 * this exists for.
 *
 * It is idempotent in the only sense that matters: once there are no `''` rows
 * it is one narrow indexed UPDATE affecting none, and it rewrites a column
 * whose value was a migration default, never learner content.
 *
 * Never reachable on a sole-task phase: no `task_states` row is ever written
 * there, so no creator calls this, and the adopted key on the authored
 * path is therefore never `SOLE_TASK_KEY`.
 *
 * **The phase's sole NON-QUIZ task, never `tasks.length`.** A quiz added
 * beside the artefact task would stop this dead on a
 * count test, and the cost is total: `strictPass`' `taskKey` narrow then finds
 * nothing and `advance` refuses **for ever** on a phase the learner already
 * did the work in. The sentence this repair is built out of: *a phase with
 * exactly one task that can hold a submission has exactly one owner for its
 * history*: is asked of the right task instead. A quiz can own no legacy
 * history, because legacy revisions predate quizzes, so the owner is the
 * non-quiz task or there is none. For every quiz-free shape the two questions
 * have the same answer, which is the equivalence test.
 */
export async function adoptOrphanRevisions(
  manager: EntityManager,
  phaseStateId: string,
  tasks: readonly CompiledTask[],
): Promise<void> {
  const sole = soleNonQuizTask(tasks);
  if (!sole) return;
  await manager
    .createQueryBuilder()
    .update(SubmissionEntity)
    .set({ taskKey: sole.taskKey })
    .where('"phaseStateId" = :id AND "taskKey" = :empty', { id: phaseStateId, empty: '' })
    .andWhere("status NOT IN ('queued','running')")
    .execute();
}

/**
 * The pass a learner had already earned before per-task rows existed, carried
 * onto the row a creator is about to write.
 *
 * The adoption above gives a legacy **revision** the key its phase's one task
 * declares, because *a phase with exactly one task has exactly one owner for
 * its history*. That sentence is about the **row** too: a learner who passed a
 * teacher-authored phase before the upgrade has `phase_states.status =
 * 'passed'` and no `task_states` row at all, and a row created at
 * `in_progress` makes `strictPass`' row conjunct false for ever, the learner
 * is refused the merge they had already earned while the tile stays green, and
 * the project-completion arm quantifies the same predicate over every phase.
 * The adoption alone does not reach it: `strictPass` asks for the evidenced
 * revision **and** the row.
 *
 * So the seed is bounded to exactly the shape whose answer is unambiguous, by
 * three conjuncts and no more:
 *
 * - **the phase reads `passed`**, never `locked` (sticky, and could never
 *   pass), never `in_progress` or `submitted` (nothing to inherit);
 * - **the pinned list holds exactly one task**, two or more and the phase's
 *   pass is the roll-up of a *set*, so it names no single owner and the rule
 *   *a missing row is a failing row* is the whole of the answer;
 * - **that task is required**, provable from the first conjunct, because the
 *   compiler refuses a phase with no required task, and written anyway: the
 *   same belt and braces as `phaseRollup`'s `requiredKeys.size > 0`, and in the
 *   same direction.
 *
 * The phase's **sole non-quiz task** and never `soleTaskList`: the two are
 * different questions and this is the adoption's one. A creator is never
 * reached on a *synthesised* sole task (no row exists there), so the list
 * here is authored, and one authored task is the common case for a teacher's
 * project rather than a corner.
 *
 * **Quizzes.** The first conjunct must not be `tasks.length !== 1`: a quiz
 * added beside the artefact task would break it, because a learner who
 * **passed** the phase before the quiz existed holds
 * `phase_states.status = 'passed'` and no `task_states` row, so without the
 * carry the row a creator writes lands `in_progress` and the pass they earned
 * is gone. The carry follows the sole non-quiz task, and the quiz beside it
 * gets none: a quiz that did not exist cannot have been passed. Every
 * one-task shape answers the same either way.
 *
 * It cannot manufacture a pass a teacher has withdrawn: `task-reopen` and
 * `task-reset` write the **phase** row down to `in_progress` when the task is
 * required, so a reopened phase never reads `passed` here. And it is a
 * **creator's** decision alone: a row the board already holds is that board's
 * answer, and every creator writes through an insert that settles on
 * `UQ_task_states_key` rather than rewriting one.
 */
export function carriedTaskPass(
  state: Pick<PhaseStateEntity, 'status' | 'passedAt' | 'bestScore'>,
  tasks: readonly CompiledTask[],
  task: CompiledTask,
): Pick<TaskStateEntity, 'status' | 'passedAt' | 'bestScore'> | null {
  if (soleNonQuizTask(tasks)?.taskKey !== task.taskKey) return null;
  if (state.status !== 'passed' || !task.required) return null;
  return { status: 'passed', passedAt: state.passedAt, bestScore: state.bestScore };
}
