import { isLastPhase, type PhaseEvidenceGap, type PhaseKey } from '@learnsdlc/shared';
import { In, IsNull, Not, type EntityManager } from 'typeorm';
import { PhaseStateEntity, QuizAttemptEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import type { PhaseContent } from '../content/content.types';
import { checksOf, isQuizTask, type CompiledTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { strictTaskEvidencePassed } from '../feedback/strict-evidence';
import { QuizAttemptsService, attemptEpochOf } from '../quiz/quiz-attempts.service';

/**
 * The strict-evidence gate's question, asked of each REQUIRED task of one
 * phase: which of them has no sealed, strictly reviewed pass that still counts?
 *
 * A teacher's Sign off or phase-wide Pass writes the board `passed` without a
 * revision behind it, so a room that could not ask what `advance` would say
 * would show "Phase evidence accepted" and Continue over a gate that then
 * refuses. So the gate and the room read ONE predicate: `advance`'s
 * `strictPass` refuses exactly when this returns anything, and `phaseDetail`
 * names what it returns (through {@link evidenceNeededAt}). It reads the rows
 * on the manager it is handed, without loading the two snapshot copies it only
 * asks the presence of.
 *
 * `tasks` is the pinned version's list for the phase (`getTasksForEnrollment`,
 * never the head's). The gate is asked of every
 * REQUIRED task and of nothing else. An optional task is shown, attempted and
 * scored, and moves no gate. The caller decides what an empty required set
 * means (the gate reads it shut); this answers only about the tasks there are.
 *
 * Runs on the manager it is handed, so `advance` asks it inside its
 * transaction and under its enrolment lock, after the heal it may refuse.
 */
export async function requiredTasksWithoutEvidence(
  manager: EntityManager,
  target: { id: string },
  tasks: readonly CompiledTask[],
  userId: string,
): Promise<CompiledTask[]> {
  const sole = soleTaskList(tasks);
  const required = tasks.filter((task) => task.required);
  const answers = await Promise.all(
    required.map((task) => taskHasStrictEvidence(manager, target, task, sole, userId)),
  );
  return required.filter((_, index) => !answers[index]);
}

/**
 * How many stored reports {@link taskHasStrictEvidence} loads at once. The
 * question is asked on every read of a passed phase, and a learner with many
 * passing resubmissions should not pay for every report on each read; the newest is almost always the strict pass, so one small batch
 * usually answers it.
 */
export const STRICT_EVIDENCE_REPORT_BATCH = 8;

/**
 * The gate's question about ONE task: does a sealed, strictly reviewed pass of
 * it still count? `requiredTasksWithoutEvidence` asks it of each required task,
 * and the reference-solution door asks it of the task whose answer it would
 * hand over: a teacher's Pass or Sign off writes the board
 * `passed` with no revision behind it, and an answer key opened on the board
 * alone let the learner read the answer and submit it for the very pass the
 * gate was still waiting on. One predicate, so the door and the gate cannot
 * disagree about what "passed" means.
 *
 * `sole` is `soleTaskList` of the phase's pinned list: on a sole-task phase the
 * row IS `target`, whose `status` the caller has already read as `passed`, so
 * no `task_states` read is issued. The caller owns that half: this asks
 * only about the evidence and, on an authored task, the row that says it
 * still counts.
 */
export async function taskHasStrictEvidence(
  manager: EntityManager,
  target: { id: string },
  task: CompiledTask,
  sole: boolean,
  userId: string,
): Promise<boolean> {
  // `taskKey: task.taskKey` is the whole second statement, not a
  // tidiness detail: `FIXED_SCORER_KEYS.code` is the same four criteria
  // for every code task of a project, and a teacher's markdown tasks
  // inherit the phase's rubric until they narrow it. Without the
  // narrow, one task's clean revision strict-passes every required
  // sibling: same keys, green checks, nothing to tell them apart.
  //
  // The two snapshot conjuncts are asked in SQL and the two copies are
  // never loaded: this question is asked on every read of a passed current
  // phase (the room, the shell's summaries, the teacher's roster) where
  // reading a whole workspace per passing revision to answer "is there one?"
  // would be waste. `IS NOT NULL` is the truthiness of `s.workspaceSnapshot
  // && s.contextSnapshot`: both are `simple-json` objects, written as
  // SQL NULL when absent (retention nulls them the same way), and an object
  // is never falsy. `InstructorService.latestSubmissions` asks it the same
  // way for the console.
  //
  // The reports themselves are read a batch at a time, newest first, and the
  // reading stops at the first strict pass: the ids are one
  // narrow indexed read, and the question is still "is there ANY", so every
  // candidate is asked before the answer is no, the answer is exactly the
  // one a single load of every report would give.
  //
  // On a non-quiz authored task the evidence must
  // be of the CURRENT run. A reset (the teacher's `task-reset` or
  // `reset-phase`, or the learner's own) raises the row's `resetCount`, and a
  // teacher's Pass after it writes the row `passed` with no new revision, so
  // the candidates are the revisions whose `resetEpoch` is NULL (the current
  // run: every reset first stamps the task's NULL rows with the ending run's
  // number) or equals the row's count. A quiz keeps its paper rule, and a
  // sole task (TaskTrackr) has no row and is untouched.
  const base = {
    phaseStateId: target.id,
    taskKey: task.taskKey,
    userId,
    status: 'completed' as const,
    passed: true,
    workspaceSnapshot: Not(IsNull()),
    contextSnapshot: Not(IsNull()),
  };
  let current: TaskStateEntity | null | undefined;
  if (!sole && !isQuizTask(task)) {
    current = await manager.findOne(TaskStateEntity, {
      where: { phaseStateId: target.id, taskKey: task.taskKey },
    });
    if (current?.status !== 'passed') return false;
  }
  const candidates = await manager.find(SubmissionEntity, {
    select: ['id'],
    where: current
      ? [
          { ...base, resetEpoch: IsNull() },
          { ...base, resetEpoch: current.resetCount },
        ]
      : base,
    order: { createdAt: 'DESC', id: 'DESC' },
  });
  let evidenced = false;
  for (let from = 0; from < candidates.length && !evidenced; from += STRICT_EVIDENCE_REPORT_BATCH) {
    const batch = await manager.find(SubmissionEntity, {
      select: ['id', 'report'],
      where: { id: In(candidates.slice(from, from + STRICT_EVIDENCE_REPORT_BATCH).map((one) => one.id)) },
    });
    evidenced = batch.some(
      (s) =>
        s.report?.assessmentMode === 'strict_binary' &&
        s.report.passed &&
        // A stored report with no review or no checks list is not evidence,
        // and asking `strictTaskEvidencePassed` about it throws a TypeError:
        // a 500 from `advance` instead of its refusal, and one the room's
        // `evidenceNeeded` would raise on every read. The same two guards
        // `InstructorService.verifiedRevision` asks first; nothing that could
        // otherwise pass is refused by them.
        !!s.report.aiReview &&
        Array.isArray(s.report.checks) &&
        strictTaskEvidencePassed(task, s.report, s.report.aiReview),
    );
  }
  if (!evidenced) return false;
  // A sole task's row IS `target`, and the caller has already read its
  // `status === 'passed'`. No `task_states` read is issued.
  if (sole) return true;
  // THE ROW IS A CONJUNCT, not just the key's carrier. A stored passing
  // revision says the work was once right; the row says it still
  // counts. A teacher's `task-reopen` (and the learner's own reset)
  // withdraw a task's pass **without deleting a submission**, so a
  // quantifier that asked the submissions alone would find the
  // untouched old revision and advance anyway.
  // (Already read above for a non-quiz task, before the candidates.)
  const row =
    current !== undefined
      ? current
      : await manager.findOne(TaskStateEntity, {
          where: { phaseStateId: target.id, taskKey: task.taskKey },
        });
  if (row?.status !== 'passed') return false;
  // `CompiledTask` has no `sealed` field (that is a `PhaseTaskView`
  // derivation) so the countersignature conjunct is written over the
  // column that carries the fact. Not reachable through the task shapes
  // that exist, because a markdown task is sealed by construction and
  // `taskRollup` refuses `passed` on a signOff task until `task-signoff`
  // writes it; written anyway, for any shape that later reaches it.
  if (!task.signOff) return true;
  return !!row.signedOffBy;
}


/**
 * What the gate reads of the project around one phase: the pinned version's
 * phases, and its compiled tasks for any of them. The reader's own two sources:
 * `WorkflowService` asks the content service directly, the teacher's console
 * through its reporting wrapper, so neither is asked to share the other's.
 */
export interface GateCourse {
  phases: readonly Pick<PhaseContent, 'key' | 'order' | 'title' | 'checks'>[];
  tasksFor(phaseKey: string): readonly CompiledTask[];
}

/** A phase state, as much of it as the gate reads. */
type GatePhaseState = { id: string; status: string; phaseKey: PhaseKey };

/** Where a gap in ANOTHER phase is, for the door and the sentence. */
type GapHome = Pick<PhaseEvidenceGap, 'phaseId' | 'phaseKey' | 'phaseTitle'>;

/**
 * Whether a required quiz the gate is still waiting on has nothing left to
 * draw.
 *
 * A teacher's Sign off writes a quiz's row `passed` without a paper, and the
 * gate still wants a passing one, so on a quiz whose every allowed paper of
 * this run is handed in, the room's Submit door leads to a room that cannot
 * hand out a paper, and only a Reset (a new attempt epoch) opens it. The count
 * is the quiz's own: `QuizAttemptsService.handedIn` over the epoch the task's
 * row is in (`attemptEpochOf`), which is the number `start` refuses on.
 *
 * The learner's room makes two exceptions, and so does this: the last paper's
 * verdict still coming (it may pass), and a sheet nobody marked (it is handed
 * in again, not reset). Only a last paper whose revision was marked settles it.
 */
async function quizOutOfPapers(
  manager: EntityManager,
  target: { id: string },
  phase: Pick<PhaseContent, 'checks'>,
  task: CompiledTask,
): Promise<boolean> {
  if (!isQuizTask(task)) return false;
  const slice = checksOf(phase, task);
  if (slice.kind !== 'quiz' || slice.attempts.max === null) return false;
  const row = await manager.findOne(TaskStateEntity, {
    select: ['id', 'resetCount'],
    where: { phaseStateId: target.id, taskKey: task.taskKey },
  });
  const epoch = attemptEpochOf(row);
  const papers = new QuizAttemptsService(manager.getRepository(QuizAttemptEntity));
  if ((await papers.handedIn(target.id, task.taskKey, epoch)) < slice.attempts.max) return false;
  const latest = await papers.latestHandedIn(target.id, task.taskKey, epoch);
  if (!latest?.submissionId) return false;
  const marked = await manager.findOne(SubmissionEntity, {
    select: ['id', 'status'],
    where: { id: latest.submissionId },
  });
  return marked?.status === 'completed';
}

/**
 * `advance`'s `strictPass(target)`, as a list of what is missing rather than a
 * boolean: empty exactly when `strictPass` answers true.
 *
 * `strictPass` refuses a phase whose content is gone, whose row is not
 * `passed`, whose required set is empty, or one of whose required tasks has no
 * evidence, so this names the phase itself for the first three (there is no
 * one task to name) and each such task for the last. The phase is named by
 * `home` where the gap is in another phase than the one being read.
 */
async function phaseGaps(
  manager: EntityManager,
  target: GatePhaseState,
  phase: Pick<PhaseContent, 'title' | 'checks'> | undefined,
  tasks: readonly CompiledTask[],
  userId: string,
  home: GapHome = {},
): Promise<PhaseEvidenceGap[]> {
  if (!phase || target.status !== 'passed' || !tasks.some((task) => task.required)) {
    return [{ key: '', title: phase?.title ?? target.phaseKey, ...home }];
  }
  const missing = await requiredTasksWithoutEvidence(manager, target, tasks, userId);
  return Promise.all(
    missing.map(async (task) => ({
      key: task.taskKey,
      title: task.title,
      ...((await quizOutOfPapers(manager, target, phase, task)) ? { noPapersLeft: true as const } : {}),
      ...home,
    })),
  );
}

/**
 * The gate's own answer, asked only where a Continue is drawn and named for a
 * reader: the learner's room
 * (`PhaseDetail.evidenceNeeded`) and the teacher's console
 * (`InstructorPhaseView.evidenceNeeded`, and the note a lever answers with).
 *
 * `advance` refuses a phase unless its row reads `passed` and it is the phase
 * the enrolment stands on, and a completed project has nothing to advance, so
 * outside those three this answers `undefined` without a query. Inside them it
 * asks what `advance` asks, in the order it asks it:
 *
 *  1. `strictPass` of this phase: the required tasks with no evidence, in
 *     task order, a quiz with no paper left marked `noPapersLeft`;
 *  2. on the project's LAST phase only, the completion arm, which asks
 *     `strictPass` of every other phase again (otherwise a teacher who
 *     reopens Requirements for a learner on Maintenance would leave the room
 *     drawing "Complete course" over a refusal). Each gap carries the phase it
 *     is in.
 *
 * `undefined` when `advance` would accept. What it does not predict: a heal
 * `advance` performs first (a lost race that left the row `submitted`), whose
 * room draws no Continue; and `advance`'s refusal of a version that holds no
 * phase, which no room reaches, because a room is a phase its version holds.
 * The arm is asked on the version's last phase by key (`isLastPhase`), never
 * at `order + 1`: a version's phases are an ordered subset of the six, which
 * the draft compiler and publish number 1 to n, and a stored version
 * numbered otherwise reaches the arm on its last phase all the same.
 */
export async function evidenceNeededAt(
  manager: EntityManager,
  enrollment: { id: string; completed: boolean; currentPhaseOrder: number },
  state: GatePhaseState & { phaseOrder: number; userId: string },
  course: GateCourse,
): Promise<PhaseEvidenceGap[] | undefined> {
  if (state.status !== 'passed' || enrollment.completed || enrollment.currentPhaseOrder !== state.phaseOrder) {
    return undefined;
  }
  const phase = course.phases.find((one) => one.key === state.phaseKey);
  const own = await phaseGaps(manager, state, phase, course.tasksFor(state.phaseKey), state.userId);
  if (own.length) return own;
  if (!isLastPhase(course, state.phaseKey)) return undefined;

  // The completion arm. Only between the last pass and "Complete course", so
  // every other room pays nothing for it; `workspace` is never selected.
  const states = await manager.find(PhaseStateEntity, {
    select: ['id', 'phaseKey', 'status'],
    where: { enrollmentId: enrollment.id },
  });
  const gaps: PhaseEvidenceGap[] = [];
  for (const other of course.phases) {
    if (other.key === state.phaseKey) continue;
    const target = states.find((one) => one.phaseKey === other.key);
    const home: GapHome = {
      ...(target ? { phaseId: target.id } : {}),
      phaseKey: other.key as PhaseKey,
      phaseTitle: other.title,
    };
    if (!target) {
      gaps.push({ key: '', title: other.title, ...home });
      continue;
    }
    gaps.push(...(await phaseGaps(manager, target, other, course.tasksFor(other.key), state.userId, home)));
  }
  return gaps.length ? gaps : undefined;
}

/**
 * What kind of pass a `passed` phase holds, for the surfaces that draw every
 * phase at once (`EnrollmentView.phases[].passKind`): `reviewed` where each
 * required task has its sealed, strictly reviewed pass, `credit` where the
 * board reads passed on a teacher's Mark as passed or sign-off alone.
 */
export type PassKind = 'reviewed' | 'credit';

/**
 * A required task a credited phase holds no reviewed pass of (one gap of
 * {@link phaseGaps}), by its key. `awaitsSignOff` where its review passed and
 * only the teacher's countersignature is missing, so a reader says "Awaiting
 * your teacher's sign-off" there rather than "review still needed", and a
 * revision of a task not named here is a current pass.
 */
export type CreditTask = { key: string; awaitsSignOff?: true };

/** What {@link passKindOf} answers: the kind, and on a credit its tasks. */
export type PassFacts = { passKind: PassKind; creditTasks?: CreditTask[] };

/**
 * {@link PassKind} of one phase, wherever it stands: behind the learner, the
 * one they stand on, or ahead.
 *
 * It asks {@link phaseGaps}, the predicate `advance`'s `strictPass` and
 * {@link evidenceNeededAt} ask of a phase, and nothing else: `credit` exactly
 * when that predicate names a gap in this phase. It never asks the completion
 * arm (a gap in another phase is that phase's own answer). Unlike
 * {@link evidenceNeededAt}, it also answers on a phase the learner has already
 * left. On an authored task list, a teacher's later re-pass there (a task
 * reset, then Mark as passed with no new revision) is named as credit rather
 * than drawn as a reviewed pass, because a reset puts the task's earlier
 * revisions out of the current run (`resetEpoch`). On a sole-task phase
 * (shipped TaskTrackr) there is no run to leave: a reset or Retry followed by
 * Mark as passed still reads `reviewed` on the earlier reviewed pass, the
 * same answer `advance` gives there.
 *
 * On a credit it also names the tasks the gate still wants
 * ({@link CreditTask}), and which of them wait only on the countersignature,
 * from `heldRows` (this phase's task rows, where the caller has read them)
 * or one read of its own.
 *
 * Words only: no gate, count, grade or export reads it. `undefined`, without
 * a query, on a phase that is not `passed`, and on one whose content the
 * version no longer holds (there is no rule to ask; the caller sends nothing).
 */
export async function passKindOf(
  manager: EntityManager,
  state: GatePhaseState & { userId: string },
  course: GateCourse,
  heldRows?: readonly Pick<TaskStateEntity, 'taskKey' | 'status' | 'awaitingSignOff'>[],
): Promise<PassFacts | undefined> {
  if (state.status !== 'passed') return undefined;
  const phase = course.phases.find((one) => one.key === state.phaseKey);
  if (!phase) return undefined;
  const tasks = course.tasksFor(state.phaseKey);
  const gaps = await phaseGaps(manager, state, phase, tasks, state.userId);
  if (!gaps.length) return { passKind: 'reviewed' };
  // Which gaps wait only on the countersignature: the task's row says its
  // review passed and the teacher has not signed it off (`taskRollup` sets
  // `awaitingSignOff` on a passing verdict of a sign-off task; a reset, a
  // reopen and the sign-off itself clear it). A sole task has no row, so
  // nothing is read there. The caller's rows of this phase when it holds
  // them (the board read has them already); else one read, only on a credit.
  const rows = soleTaskList(tasks)
    ? []
    : heldRows ?? await manager.find(TaskStateEntity, {
        select: ['taskKey', 'status', 'awaitingSignOff'],
        where: { phaseStateId: state.id, taskKey: In(gaps.map((gap) => gap.key)) },
      });
  const awaits = (key: string): boolean =>
    rows.some((row) => row.taskKey === key && row.awaitingSignOff && row.status !== 'passed');
  return {
    passKind: 'credit',
    creditTasks: gaps.map((gap) => (awaits(gap.key) ? { key: gap.key, awaitsSignOff: true as const } : { key: gap.key })),
  };
}

/**
 * What the gate will still want of a phase passed AHEAD of the learner, once
 * they reach it.
 *
 * `advance` refuses a phase the learner has not reached whatever it holds, so
 * {@link evidenceNeededAt} answers nothing there. But the room has two true
 * things to say about such a phase, and they are not the same: a phase the
 * learner earned their own reviewed pass on (submitted while it was unlocked
 * early) opens Continue the moment they reach it; a phase a teacher marked
 * passed on the board alone does not, because the strict gate still wants
 * that review. "Continue opens here once you reach it" is true of only the
 * first.
 *
 * So this asks `strictPass`'s own question of the phase: {@link phaseGaps},
 * the predicate {@link evidenceNeededAt} asks of the phase the learner stands
 * on, and only on a `passed` phase ahead of the learner in a project that is
 * not complete. It never asks the completion arm (that is the last phase's
 * question once it is reached). `undefined` everywhere else, without a query,
 * and wherever the phase's own reviewed pass is in.
 */
export async function evidenceNeededAhead(
  manager: EntityManager,
  enrollment: { completed: boolean; currentPhaseOrder: number },
  state: GatePhaseState & { phaseOrder: number; userId: string },
  course: GateCourse,
): Promise<PhaseEvidenceGap[] | undefined> {
  if (state.status !== 'passed' || enrollment.completed || state.phaseOrder <= enrollment.currentPhaseOrder) {
    return undefined;
  }
  const phase = course.phases.find((one) => one.key === state.phaseKey);
  const gaps = await phaseGaps(manager, state, phase, course.tasksFor(state.phaseKey), state.userId);
  return gaps.length ? gaps : undefined;
}
