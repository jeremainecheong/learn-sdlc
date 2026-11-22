import type { EntityManager } from 'typeorm';
import type { SubmissionView } from '@learnsdlc/shared';
import { taskStatesByPhaseState } from '../analytics/queries';
import type { PhaseContent } from '../content/content.types';
import { checksOf, isQuizTask, type CompiledTask } from '../content/pack-compiler';
import { QuizAttemptEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import { isoOrNull } from '../db/timestamps';
import { strictEvidencePassed } from '../feedback/feedback.service';
import { taskForRevision } from '../feedback/task-resolution';
import { strictTaskEvidencePassed } from '../feedback/strict-evidence';
import { attemptEpochOf } from '../quiz/quiz-attempts.service';

/**
 * What the console reads off a learner's board beside the rows themselves:
 * the newest revision as the console shows it, whether it passed the strict
 * gate, and how many quiz papers each task has used. Plain functions over an
 * EntityManager and the pinned version, with no service state.
 */

/**
 * The newest attempt on a phase, plus the two facts about it the export needs
 * that a `SubmissionView` does not carry: which pack graded it, and whether it
 * was produced by a regrade.
 */
export interface LatestSubmission {
  view: SubmissionView;
  packVersion: string | null;
  regraded: boolean;
}

/**
 * The key a learner's spent-paper count is grouped and read under.
 *
 * The epoch is part of the key rather than a filter applied afterwards,
 * because *has this learner run out of papers* is a question about the run
 * they are in now: the papers of a run a teacher has already reset are in the
 * record and count towards nothing.
 */
function quizSpentKey(phaseStateId: string, taskKey: string, epoch: number): string {
  return `${phaseStateId}\u0000${taskKey}\u0000${epoch}`;
}

/**
 * Whether one revision passes the strict gate; against **the task it names**.
 *
 * A teacher-created task's rubric is derived from its own rules, so it can
 * differ from its phase's on a single-task phase as well as on a split one.
 * Judging a revision by the phase's rubric would tell a teacher that a task
 * strict-passed by a rubric it does not have. `taskForRevision` answers *the
 * phase's only task* for a one-task phase whatever key the row carries, which
 * is what keeps a legacy revision keyed `''` on a `main` phase readable.
 *
 * With no task list (a phase the version no longer declares) the question
 * falls back to the phase's own.
 */
export function verifiedRevision(
  phase: PhaseContent | undefined,
  tasks: readonly CompiledTask[],
  view: SubmissionView,
): boolean {
  if (!view.verifiedPass || !phase) return false;
  if (!view.report?.aiReview || !Array.isArray(view.report.checks)) return false;
  const task = taskForRevision(tasks, view.taskKey ?? '');
  return task
    ? strictTaskEvidencePassed(task, view.report, view.report.aiReview)
    : strictEvidencePassed(phase, view.report, view.report.aiReview);
}

/**
 * `{ quizAttemptsSpent }` for a quiz that has run out of papers, or `{}`.
 *
 * Three conjuncts and no fourth. The task has to **be** a quiz, read off the
 * pinned version's own slice rather than off the row; the teacher has to
 * have set a limit, because a quiz with none can never run out; and the row
 * has to be unpassed, because a learner who is through is not waiting for
 * anybody. The count is of the row's **current** epoch, which is
 * `resetCount`, so the flag clears the moment a reset lands rather than the
 * next time a paper is drawn.
 *
 * An empty object rather than `false` on a task that is not a quiz: a
 * written task carrying `quizAttemptsSpent: false` would read as a quiz
 * nobody has finished.
 *
 * "Passed" is not "through" when the row was written
 * by a Sign off and the strict-evidence gate still waits on a passing paper
 * (`waitedOn`, from the phase's own `evidenceNeeded`). That learner is
 * exactly as stuck as one who never passed (the room cannot hand out a
 * paper and Reset is the way out) so the flag, and the console's "out of
 * papers" line with it, stays up for them.
 */
export function quizAttemptsSpent(
  phase: PhaseContent | undefined,
  task: CompiledTask | undefined,
  row: TaskStateEntity,
  quizSpent: Map<string, number>,
  waitedOn = false,
): { quizAttemptsSpent?: boolean } {
  if (!phase || !task || !isQuizTask(task)) return {};
  const slice = checksOf(phase, task);
  const max = slice.kind === 'quiz' ? slice.attempts.max : null;
  if (max === null) return {};
  const spent =
    quizSpent.get(quizSpentKey(row.phaseStateId, row.taskKey, attemptEpochOf(row))) ?? 0;
  return { quizAttemptsSpent: spent >= max && (row.status !== 'passed' || waitedOn) };
}

/**
 * One row as the console reads it: the same shape `FeedbackService.toView`
 * produces, built here so the instructor service does not have to carry the
 * grading pipeline's dependencies. `verifiedPass` is the cheap half; the phase view
 * adds the exact criterion and check validation, against the task the
 * revision names.
 */
export function toLatest(submission: SubmissionEntity, retained: Set<string>): LatestSubmission {
  return {
    view: {
      id: submission.id,
      status: submission.status,
      score: submission.score,
      passed: submission.passed,
      verifiedPass:
        retained.has(submission.id) &&
        submission.status === 'completed' &&
        submission.passed === true &&
        submission.report?.assessmentMode === 'strict_binary' &&
        submission.report.passed === true,
      report: submission.report,
      createdAt: isoOrNull(submission.createdAt) ?? '',
      error: submission.error || undefined,
      taskKey: submission.taskKey,
    },
    packVersion: submission.packVersion,
    regraded: Boolean(submission.regradeOf),
  };
}

/**
 * The `task_states` rows of these phase states, grouped, or an empty map.
 *
 * One indexed lookup on `UQ_task_states_key`'s leading column, and it is the
 * switch every per-task read here is behind: on a board that has none (the
 * shipped pack's, on every phase) it comes back empty and no surface asks a
 * per-task question at all.
 */
export async function taskRowsByState(
  manager: EntityManager,
  phaseStateIds: string[],
): Promise<Map<string, TaskStateEntity[]>> {
  // Delegated rather than repeated. Two copies of `taskStatesByPhaseState`
  // is how a CSV and a console come to disagree about one learner; a live
  // risk, because the two percentages are read off these rows on both
  // surfaces and the gradebook's numbers have to be the dashboard's.
  return taskStatesByPhaseState(manager, phaseStateIds);
}

/**
 * How many papers each learner has handed in, per task and per attempt
 * epoch.
 *
 * One grouped query, in `taskRowsByState`'s shape and behind the same
 * switch: a board with no task rows cannot hold a quiz, so a project of
 * sole-task phases issues this not at all. Keyed by epoch as well as by task
 * because a teacher's reset starts a new run of the quiz, and *has this
 * learner run out of papers* is a question about the run they are in.
 *
 * Void papers (the one a reset found open) are outside the count, the same
 * way they are outside the learner's own.
 */
export async function quizSpentByState(
  manager: EntityManager,
  phaseStateIds: string[],
): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  if (!phaseStateIds.length) return spent;
  const rows: { phaseStateId: string; taskKey: string; epoch: number; spent: string }[] =
    await manager
      .createQueryBuilder(QuizAttemptEntity, 'attempt')
      .select('attempt.phaseStateId', 'phaseStateId')
      .addSelect('attempt.taskKey', 'taskKey')
      .addSelect('attempt.epoch', 'epoch')
      .addSelect('COUNT(*)', 'spent')
      .where('attempt.phaseStateId IN (:...ids)', { ids: phaseStateIds })
      .andWhere('attempt.submittedAt IS NOT NULL')
      .andWhere('attempt.voidedAt IS NULL')
      .groupBy('attempt.phaseStateId')
      .addGroupBy('attempt.taskKey')
      .addGroupBy('attempt.epoch')
      .getRawMany();
  for (const row of rows) {
    spent.set(quizSpentKey(row.phaseStateId, row.taskKey, Number(row.epoch)), Number(row.spent));
  }
  return spent;
}
