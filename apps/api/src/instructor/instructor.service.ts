import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { And, DataSource, EntityManager, Equal, In, IsNull, MoreThan, Not } from 'typeorm';
import type { FindOperator, FindOptionsWhere } from 'typeorm';
import type {
  AuditEventView,
  DossierPhase,
  InstructorEnrollmentView,
  InstructorLearnerDetail,
  InstructorPhaseView,
  InstructorTaskView,
  LearnerDossier,
  PhaseEvidenceGap,
  PhaseOverrideAction,
  SubmissionView,
} from '@learnsdlc/shared';
import { OVERRIDE_REASON_MIN, PHASE_ORDER } from '@learnsdlc/shared';
import { hintsByPhaseState, newestSubmissionsPerPhaseState } from '../analytics/queries';
import { newestSubmissionsPerTask } from '../analytics/newest-per-task';
import { pinnedReading, type Percentages } from '../analytics/pinned-reading';
import { AssistantService } from '../assistant/assistant.service';
import { ContentService } from '../content/content.service';
import { PhaseContent, ProjectContent } from '../content/content.types';
import { phasesToCount, statesOnBoard } from '../workflow/states-on-board';
import { isQuizTask, type CompiledTask } from '../content/pack-compiler';
import { requiredKeysOf, soleTaskList } from '../content/task-units';
import { atomic } from '../db/atomic';
import { WorkflowService } from '../workflow/workflow.service';
import { drillWithIncident } from '../workflow/drill-incident';
// The strict-evidence gate's own question, for the console.
import { evidenceNeededAhead, evidenceNeededAt, type GateCourse } from '../workflow/strict-gate';
import {
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { phaseRollup, relianceIndex } from '../feedback/checkers';
// The one writer of `quiz_attempts`, built over the manager
// this service already holds; the same idiom `FeedbackService` uses, and for
// the same reason. Nothing here imports the quiz's routes.
import { QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { stampEndingRun } from '../workflow/reset-epoch';
import { strictEvidencePassed } from '../feedback/feedback.service';
import { taskForRevision, unknownTask } from '../feedback/task-resolution';
import { strictTaskEvidencePassed } from '../feedback/strict-evidence';
import {
  AUDIT_DEFAULT_LIMIT,
  auditTake,
  auditViews,
  recordAudit,
} from '../audit/audit';
import { signOffPassedAt } from './signoff';
import { buildDossierJournal } from './journal';
import {
  InstructorCaller,
  UNATTACHED_COHORT,
  classFileLabel,
  classScope,
  cohortNameOf,
  cohortNamesById,
  learnerScope,
  scopedLearner,
} from './cohort-scope';
// The class's dates, read the same way the learner's own board is.
import {
  NO_SCHEDULE,
  ScheduleMap,
  effectivePhaseStatus,
  isLate,
  scheduleForCohort,
  scheduleKey,
  schedulesFor,
} from './schedule.service';
import { dossierRevision, releaseView } from './record-views';
import { CLASS_LEARNERS_PAGE } from './instructor.dto';
import { UUID_PATTERN } from '../db/uuid';
import { isoOrNull } from '../db/timestamps';
import { heldEnrollment } from '../db/enrollment-lock';
import {
  CSV_COLUMNS,
  GRADEBOOK_COLUMNS,
  conformanceCell,
  csvCell,
  drillCell,
  killMatrixCell,
} from './csv';
import { asUserId, cursorIdParam, decodeAuditCursor, storedDate } from './audit-cursor';
import {
  quizAttemptsSpent,
  quizSpentByState,
  taskRowsByState,
  toLatest,
  verifiedRevision,
  type LatestSubmission,
} from './board-reads';

export type { InstructorCaller } from './cohort-scope';

/**
 * What the three per-task levers refuse a
 * phase whose compiled list is the **synthesised sole task** with.
 *
 * The guard is `soleTaskList`, not a key check. Such a phase really does
 * declare `SOLE_TASK_KEY`, so a key check alone would accept `task-signoff` on
 * the empty key, take `phaseRollup`'s first arm and flip the phase to `passed`
 * at `Math.max(bestScore ?? 0, 0)`; past `pass`'s already-passed refusal and
 * past its `passThreshold` floor. On such a phase the phase's own levers are
 * the levers, and they are the ones that carry those two rules.
 */
export const SOLE_TASK_LEVER_REFUSAL =
  "This phase has one task, so the phase's own levers are the levers: use Pass, Reopen or Reset phase.";

/**
 * What `task-reset` and `reset-phase` refuse with while a revision of the work
 * they would start over is still queued or running.
 *
 * **The race.** A revision is graded from the snapshot taken when it was
 * handed in, and its verdict is written under the enrolment lock whenever the
 * job finishes (`feedback.service.ts` `writeVerdict`). A reset that commits
 * first is then followed by that verdict, which re-passes the task at the old
 * revision's score; the phase lever's case is the same, over every task the
 * phase holds. So each lever asks, **inside** `overridePhase`'s existing
 * enrolment lock and on its transaction, whether anything is in flight, keyed
 * exactly as `UQ_submissions_in_flight` is: `(phaseStateId, taskKey)` for one
 * task, every key of the phase for the phase lever. A revision that was in
 * flight when the lock was taken is seen. A learner's grading job that was
 * mid-write is waited for by the lock and then reads as finished, because its
 * status and its roll-up are written in one locked transaction.
 *
 * **This check narrows the non-quiz reset race; it does not close it on its
 * own.** Three windows are out of its sight, and the nullable
 * `submissions.resetEpoch` (a verdict of an earlier run moves no gate) is
 * what closes them for a task with its own `task_states` row. A sole task has
 * no row, so its revisions stay NULL, which reads as the current run
 * (`reset-epoch.ts`, `verdictIsOfAnotherRun`):
 * - **the submit window.** A submission that commits after this check has
 *   read could land its verdict on the fresh start;
 * - **the regrade's own gap.** A regrade writes its row `completed` in its own
 *   statement (`regrade.service.ts`, before its roll-up transaction takes the
 *   enrolment lock), so a reset that runs in that gap reads nothing in flight,
 *   commits, and the regrade's roll-up then re-passes the fresh start at the
 *   regraded score;
 * - **a regrade started after the reset.** Regrade candidates carry no
 *   `resetAt` filter, so a batch run at any later time (a republish and
 *   regrade included) grades the pre-reset revision and rolls its verdict up
 *   onto the fresh start. No lock can see a job that has not begun. A quiz's own run is already
 * closed by its attempt epoch (`verdictIsOfAnotherRun`); the refusal applies to
 * a quiz all the same, because one rule is one sentence to a teacher and a
 * paper's mark lands in moments.
 *
 * Nothing else is held: `pass`, `reopen`, `reset-workspace`, `task-signoff` and
 * `task-reopen` do not have this race. A row stuck in flight is not a
 * reset that is stuck for ever either; the job recovery marks it failed at
 * boot, or when the durable queue gives up on it (`job-recovery.service.ts`).
 *
 * One sentence, the subject first: the task's title for `task-reset`, the
 * phase's for `reset-phase`.
 */
export function inFlightResetRefusal(subject: string): string {
  return `${subject} cannot be reset while a revision of it is still being marked; try again once its verdict is in.`;
}

/**
 * What `pass` has to say when it could not pass everything the gate wants.
 *
 * A task the pack marks `signOff` is passed by a countersignature and by
 * nothing else; that is what `taskRollup` guarantees and what keeps `status`
 * meaning one thing to the door, the roll-up and `advance`. So a teacher's
 * Pass writes the `required && !signOff` rows and says, rather than silently
 * leaving the phase shut, which rows it did not write and what does write them.
 */
export function countersignatureNote(pending: number): string {
  return (
    `${pending} task(s) on this phase need a countersignature. ` +
    'Passing the phase does not countersign them — use Sign off on each.'
  );
}

/**
 * What a lever answers with when it left the phase reading `passed` on the
 * learner's current phase but the strict-evidence gate would still refuse
 * their Continue.
 *
 * A Sign off and a phase-wide Pass both write the board (the row, then the
 * phase) and neither stands in for a sealed, strictly reviewed revision:
 * a countersignature is the second half of a pass, never the first
 * (`taskRollup`, {@link countersignatureNote}, `strictPass`). Without this a
 * teacher would read "Design now reads passed" while the learner meets a
 * refusal; this says, at the moment the lever lands, what the learner still
 * has to do.
 *
 * "So they still submit it" is not true of a quiz with
 * no paper left (`noPapersLeft`) (its room cannot hand one out, and only a
 * Reset starts a new run of papers) so such a quiz is named in a sentence of
 * its own that says so. A gap in an earlier phase (the last phase's
 * completion arm) is named with the phase it is in.
 */
export function evidenceStillNeededNote(
  phaseTitle: string,
  tasks: readonly Pick<PhaseEvidenceGap, 'title' | 'noPapersLeft' | 'phaseTitle'>[],
  /**
   * The phase is AHEAD of the one the learner stands on (a teacher's Unlock
   * early and Pass), so the gate is one they meet once they reach it, said
   * as such, rather than as a Continue refused now.
   */
  { ahead = false }: { ahead?: boolean } = {},
): string {
  const nameOf = (task: Pick<PhaseEvidenceGap, 'title' | 'phaseTitle'>): string =>
    task.phaseTitle && task.phaseTitle !== task.title ? `${task.title} in ${task.phaseTitle}` : task.title;
  const joined = (titles: string[]): string =>
    titles.length <= 1
      ? (titles[0] ?? phaseTitle)
      : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
  const names = joined(tasks.map(nameOf));
  const one = tasks.length <= 1;
  const submittable = tasks.filter((task) => !task.noPapersLeft);
  const spent = tasks.filter((task) => task.noPapersLeft);
  const head =
    `${phaseTitle} reads passed, but the learner ` +
    `${ahead ? 'has not reached it yet, and once they do they ' : ''}cannot move on until ${names} ` +
    `${one ? 'has' : 'have'} a reviewed pass of ${one ? 'its' : 'their'} own. ` +
    'A sign-off or a Pass credits the work here; it does not stand in for the review';
  if (!spent.length) return `${head}, so they still submit ${one ? 'it' : 'each of them'} for one.`;
  const lone = spent.length === 1;
  const stuck =
    `${joined(spent.map(nameOf))} ${lone ? 'has' : 'have'} no papers left, so the learner cannot sit ` +
    `${lone ? 'it' : 'them'} again until you use Reset on ${lone ? 'it' : 'each'}, which starts a fresh set of ` +
    'attempts and takes the credit back until they pass.';
  if (!submittable.length) return `${head}. ${stuck}`;
  return (
    `${head}, so they still submit ${submittable.length === 1 ? joined(submittable.map(nameOf)) : `each of ${joined(submittable.map(nameOf))}`} for one. ${stuck}`
  );
}

/**
 * What an override answers with.
 *
 * `InstructorPhaseView` plus the one sentence a lever may have to say about
 * what it could not do. It is a superset, so every existing reader is
 * unchanged and the console can ignore it.
 */
export interface PhaseOverrideResult extends InstructorPhaseView {
  /** Set only where the action could not finish the job on its own. */
  note?: string;
}

/** Which audit event each override leaves; the three task levers have their own. */
const OVERRIDE_EVENTS: Partial<Record<PhaseOverrideAction, AuditEventView['event']>> = {
  'task-signoff': 'task.signoff',
  'task-reset': 'task.reset',
  'task-reopen': 'task.reopen',
};

// The page bound lives beside the query it
// bounds, and is re-exported here for the service's readers.
export { CLASS_LEARNERS_PAGE } from './instructor.dto';

/** What `classLearnerDetails` is asked: one class or the whole scope, a page of it. */
export interface ClassLearnersRead {
  /** One class of the caller's; absent reads every learner their scope holds. */
  cohort?: string;
  /** The last learner id of the previous page; the page starts after it. */
  after?: string;
  /** At most `CLASS_LEARNERS_PAGE`, which is also the default. */
  limit?: number;
}

/**
 * The instructor's view of one learner, and the levers to unblock them.
 *
 * Every route funnels through scopedLearner(): an instructor reaches only
 * learners in their own classes (cohort-scope.ts), an admin reaches anyone.
 * The refusal is a 404 rather than a 403 so that guessing ids tells a second
 * instructor nothing about which ids exist in other classes.
 */
@Injectable()
export class InstructorService {
  private readonly logger = new Logger(InstructorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
    private readonly assistant: AssistantService,
    /**
     * The learner's own resolution, so the roster leads with the project they
     * are working and marks one set aside for their class's. Optional so specs
     * that build this service by hand get the plain oldest-first order; the
     * app always injects it.
     */
    @Optional() private readonly workflow?: WorkflowService,
  ) {}

  /**
   * One learner in the caller's class, or a 404. The rule itself lives in
   * `cohort-scope.ts` so the view-as read routes reach a learner
   * through the same function rather than a second copy of it.
   */
  private scopedLearner(
    manager: EntityManager,
    caller: InstructorCaller,
    userId: string,
  ): Promise<UserEntity> {
    return scopedLearner(manager, caller, userId);
  }

  /* ------------------------------- detail ------------------------------- */

  async learnerDetail(
    caller: InstructorCaller,
    userId: string,
  ): Promise<InstructorLearnerDetail> {
    const manager = this.dataSource.manager;
    const learner = await this.scopedLearner(manager, caller, userId);

    const started = await manager.find(EnrollmentEntity, {
      where: { userId: learner.id },
      order: { startedAt: 'ASC' },
    });
    // The project the learner is working now leads (their class's
    // once they have started it) then the rest oldest first, so a roster that
    // draws the first enrolment shows them where they are; a row set aside for
    // the class's project is marked. The learner's resolution, not the caller's.
    const standing = this.workflow && started.length > 0
      ? await this.workflow.rosterStanding({ id: learner.id, cohort: learner.cohort }, started)
      : null;
    const enrollments = standing?.current
      ? [
          ...started.filter((row) => row.projectSlug === standing.current),
          ...started.filter((row) => row.projectSlug !== standing.current),
        ]
      : started;
    const states = enrollments.length
      ? await manager.find(PhaseStateEntity, {
          where: { enrollmentId: In(enrollments.map((e) => e.id)) },
          order: { phaseOrder: 'ASC' },
        })
      : [];
    const stateIds = states.map((s) => s.id);
    const hints = await hintsByPhaseState(manager, stateIds);
    const latest = await this.latestSubmissions(manager, stateIds);
    // The per-task record. Both reads are
    // skipped entirely on a board that has no task rows, which is every phase
    // of the shipped pack, so a project of sole-task phases costs one indexed
    // lookup that comes back empty and nothing else.
    const taskRows = await taskRowsByState(manager, stateIds);
    const perTask = taskRows.size
      ? await this.latestSubmissionsPerTask(manager, [...taskRows.keys()])
      : new Map<string, Map<string, LatestSubmission>>();
    // Quiz papers: behind the same switch, for the same reason.
    const quizSpent = taskRows.size
      ? await quizSpentByState(manager, [...taskRows.keys()])
      : new Map<string, number>();

    // On each enrolment, the one phase a Continue can be
    // drawn on (passed, current, project not complete) asked the gate's own
    // question. Every other phase costs nothing, so a class mid-phase adds no
    // query at all.
    const gaps = new Map<string, PhaseEvidenceGap[]>();
    for (const enrollment of enrollments) {
      const current = states.find(
        (s) => s.enrollmentId === enrollment.id && s.phaseOrder === enrollment.currentPhaseOrder,
      );
      if (!current) continue;
      const needed = await evidenceNeededAt(manager, enrollment, current, this.gateCourse(enrollment));
      if (needed) gaps.set(current.id, needed);
      // And a phase passed AHEAD of them (a teacher's
      // Unlock early and Pass), asked what the same gate will want of it once
      // they reach it; the learner's room says so beside `notReachedYet`, and
      // the roster cell says it too. Only a passed phase ahead is asked,
      // so a class working in order adds no query.
      if (enrollment.completed) continue;
      for (const ahead of states) {
        if (
          ahead.enrollmentId !== enrollment.id ||
          ahead.status !== 'passed' ||
          ahead.phaseOrder <= enrollment.currentPhaseOrder
        )
          continue;
        const owed = await evidenceNeededAhead(manager, enrollment, ahead, this.gateCourse(enrollment));
        if (owed) gaps.set(ahead.id, owed);
      }
    }

    const cohort =
      learner.cohort === UNATTACHED_COHORT
        ? null
        : await manager.findOne(CohortEntity, {
            where: { id: learner.cohort },
          });

    // The interview is recorded, not graded; this
    // is where it is read. The phase states are already loaded, so this costs
    // no extra rows.
    const interviewed =
      states.find((s) => s.phaseKey === 'requirements')?.interview ?? null;
    const interview = interviewed
      ? {
          questions: interviewed.turns.length,
          settled: new Set(interviewed.turns.flatMap((t) => t.facts)).size,
        }
      : null;

    return {
      userId: learner.id,
      email: learner.email,
      displayName: learner.displayName,
      avatar: learner.avatar ?? 0,
      cohort: learner.cohort,
      cohortName: cohort?.name ?? null,
      createdAt: isoOrNull(learner.createdAt) ?? '',
      tokensToday: await this.assistant.tokensToday(learner.id),
      interview,
      enrollments: await Promise.all(
        enrollments.map(async (enrollment) => {
          const view = this.enrollmentView(
            enrollment,
            states.filter((s) => s.enrollmentId === enrollment.id),
            hints,
            latest,
            // The learner's class dates for that enrolment's project: the
            // console shows the board the learner sees, not a different one.
            await scheduleForCohort(
              manager,
              learner.cohort,
              enrollment.projectSlug,
            ),
            taskRows,
            perTask,
            quizSpent,
            gaps,
          );
          return standing?.setAside.has(enrollment.id) ? { ...view, setAside: true as const } : view;
        }),
      ),
    };
  }

  /**
   * The teacher home's read of a whole
   * class, in one request rather than one per learner against the
   * controller's 60-a-minute limit.
   *
   * It is `learnerDetail`, run for each learner in a page of the caller's
   * scope, so it cannot answer anything the per-learner route would refuse:
   * the ids come from `learnerScope` (the rule `scopedLearner` applies), and
   * every detail is then read **through** `learnerDetail` and so through
   * `scopedLearner` again. A class outside the caller's scope is an empty
   * page, never a 404 that says it exists. It writes nothing. It is bounded:
   * at most `CLASS_LEARNERS_PAGE` learners, in id order, walked by `after`,
   * and read one learner at a time so a page costs the database what that many
   * per-learner reads cost, never more at once.
   */
  async classLearnerDetails(
    caller: InstructorCaller,
    read: ClassLearnersRead = {},
  ): Promise<InstructorLearnerDetail[]> {
    const manager = this.dataSource.manager;
    const scope = await learnerScope(manager, caller);
    const where: FindOptionsWhere<UserEntity> = { ...scope };
    if (read.cohort !== undefined) {
      const within = scope.cohort;
      where.cohort =
        within === undefined
          ? read.cohort
          : And(typeof within === 'string' ? Equal(within) : (within as FindOperator<string>), Equal(read.cohort));
    }
    if (read.after !== undefined) where.id = MoreThan(read.after);
    const take = Math.min(
      CLASS_LEARNERS_PAGE,
      Math.max(1, Number.isInteger(read.limit) ? (read.limit as number) : CLASS_LEARNERS_PAGE),
    );
    const page = await manager.find(UserEntity, {
      where,
      select: ['id'],
      order: { id: 'ASC' },
      take,
    });
    const details: InstructorLearnerDetail[] = [];
    for (const learner of page) details.push(await this.learnerDetail(caller, learner.id));
    return details;
  }

  private enrollmentView(
    enrollment: EnrollmentEntity,
    states: PhaseStateEntity[],
    hints: Map<string, number>,
    latest: Map<string, LatestSubmission>,
    dates: ScheduleMap = NO_SCHEDULE,
    taskRows: Map<string, TaskStateEntity[]> = new Map(),
    perTask: Map<string, Map<string, LatestSubmission>> = new Map(),
    quizSpent: Map<string, number> = new Map(),
    /** By phase state id, the phases whose Continue the gate would refuse. */
    gaps: Map<string, PhaseEvidenceGap[]> = new Map(),
  ): InstructorEnrollmentView {
    // The learner's own version, not the published head. This
    // is the heading of the card a teacher reads the class from (the project's
    // title, each phase's title and the gate printed beside each score) and
    // all three are facts about the attempt in front of them. A null pin
    // answers the head, so a legacy row (enrolled before pinning) reads the head.
    const project = this.content.getForEnrollment(enrollment);
    return {
      id: enrollment.id,
      projectSlug: enrollment.projectSlug,
      projectTitle: project.title,
      currentPhaseOrder: enrollment.currentPhaseOrder,
      completed: enrollment.completed,
      startedAt: isoOrNull(enrollment.startedAt) ?? '',
      completedAt: enrollment.completedAt,
      phases: statesOnBoard(enrollment, project, states).map((state) =>
        this.phaseView(
          state,
          project,
          hints.get(state.id) ?? 0,
          latest.get(state.id)?.view ?? null,
          dates,
          this.tasksOf(enrollment, state.phaseKey),
          taskRows.get(state.id) ?? [],
          perTask.get(state.id),
          quizSpent,
          gaps.get(state.id),
        ),
      ),
    };
  }

  private phaseView(
    state: PhaseStateEntity,
    project: ProjectContent,
    hints: number,
    lastSubmission: SubmissionView | null,
    dates: ScheduleMap = NO_SCHEDULE,
    tasks: readonly CompiledTask[] = [],
    rows: TaskStateEntity[] = [],
    perTask?: Map<string, LatestSubmission>,
    quizSpent: Map<string, number> = new Map(),
    // What the gate still wants, where it would refuse.
    evidenceNeeded?: PhaseEvidenceGap[],
  ): InstructorPhaseView {
    const phase = project.phases.find((p) => p.key === state.phaseKey);
    const scheduled = dates.get(state.phaseKey);
    return {
      id: state.id,
      key: state.phaseKey,
      order: state.phaseOrder,
      title: phase?.title ?? state.phaseKey,
      // The same overlay the learner's own card draws: the
      // instructor must see the board the learner sees, dates included.
      status: effectivePhaseStatus(state.status, scheduled?.opensAt),
      bestScore: state.bestScore,
      attempts: state.attempts,
      // Reflections remain editable drafts; released notes are in the dossier.
      reflection: null,
      passedAt: state.passedAt,
      unlockedAt: state.unlockedAt,
      hints,
      relianceIndex: relianceIndex(hints, state.attempts),
      passThreshold: phase?.rubric.passThreshold ?? 0,
      lastSubmission: lastSubmission
        ? { ...lastSubmission, verifiedPass: verifiedRevision(phase, tasks, lastSubmission) }
        : null,
      // The per-task record, built from the
      // rows rather than from the compiled list, so a phase that has none
      // (every phase of a project of sole-task phases) carries an empty array
      // and no lookup at all. A row naming a key the pinned version no longer
      // declares is kept and never marked required: the learner did that work,
      // and the gate quantifies over the pinned version's keys and nothing else.
      tasks: rows.length ? this.taskViews(phase, tasks, rows, perTask, quizSpent, evidenceNeeded) : [],
      opensAt: scheduled?.opensAt ?? null,
      dueAt: scheduled?.dueAt ?? null,
      // Absent unless the gate would refuse, so every other view is unchanged.
      ...(evidenceNeeded ? { evidenceNeeded } : {}),
    };
  }

  /** One phase's tasks as the console reads them: the rows, named by the pin. */
  private taskViews(
    phase: PhaseContent | undefined,
    tasks: readonly CompiledTask[],
    rows: TaskStateEntity[],
    perTask?: Map<string, LatestSubmission>,
    quizSpent: Map<string, number> = new Map(),
    evidenceNeeded: readonly PhaseEvidenceGap[] = [],
  ): InstructorTaskView[] {
    const byKey = new Map(tasks.map((task) => [task.taskKey, task]));
    // The tasks of THIS phase the gate still waits on (a gap carrying a
    // `phaseId` is another phase's, named on the last phase's view).
    const waitedOn = new Set(evidenceNeeded.filter((gap) => !gap.phaseId).map((gap) => gap.key));
    return rows
      .map((row) => {
        const task = byKey.get(row.taskKey);
        const newest = perTask?.get(row.taskKey)?.view ?? null;
        return {
          key: row.taskKey,
          // Every allowed paper of THIS run handed in, and
          // not passed. A teacher cannot reset what they cannot see is stuck,
          // and this is the same pair of facts the learner's own room reads.
          // Spread so that a task which is not a quiz carries no field at all.
          ...quizAttemptsSpent(phase, task, row, quizSpent, waitedOn.has(row.taskKey)),
          // A key the pinned version does not declare sorts last and is never
          // required; it is recorded because the learner did the work.
          order: task?.order ?? Number.MAX_SAFE_INTEGER,
          required: task?.required ?? false,
          title: task?.title ?? row.taskKey,
          status: row.status,
          bestScore: row.bestScore,
          attempts: row.attempts,
          passedAt: row.passedAt,
          awaitingSignOff: row.awaitingSignOff,
          signedOffAt: row.signedOffAt,
          lastSubmission: newest
            ? { ...newest, verifiedPass: verifiedRevision(phase, tasks, newest) }
            : null,
        };
      })
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }

  /**
   * The compiled tasks of one phase of the version this enrolment holds, or an
   * empty list where this build cannot name them.
   *
   * Empty rather than a throw, because every caller here is a *reporting*
   * surface: a console page must not 404 because one enrolment sits on a
   * version whose phase key the catalogue has lost, exactly as `phaseView`
   * already stands the phase key in for a title it cannot find. An empty list
   * makes every per-task derivation fall back to the phase's own answer.
   */
  private tasksOf(enrollment: EnrollmentEntity, phaseKey: string): CompiledTask[] {
    try {
      return this.content.getTasksForEnrollment(enrollment, phaseKey);
    } catch {
      return [];
    }
  }

  /**
   * The project the strict-evidence gate reads for one enrolment: the pinned
   * version's phases, and `tasksOf` for their tasks, so
   * a list this build cannot name reads as an empty required set, which the
   * gate reads shut and names as the phase itself, exactly as `advance`
   * would refuse it.
   */
  private gateCourse(enrollment: EnrollmentEntity): GateCourse {
    return {
      phases: this.content.getForEnrollment(enrollment).phases,
      tasksFor: (phaseKey) => this.tasksOf(enrollment, phaseKey),
    };
  }

  /**
   * Newest submission per phase state, in two queries rather than one per
   * phase: an aggregate that decides which id is newest for each phase state,
   * then one that loads only those rows. The report column is the heavy part,
   * and a whole class's back catalogue of attempts does not belong in memory
   * to find six rows.
   */
  private async latestSubmissions(
    manager: EntityManager,
    phaseStateIds: string[],
  ): Promise<Map<string, LatestSubmission>> {
    const latest = new Map<string, LatestSubmission>();
    if (!phaseStateIds.length) return latest;
    const newest = await newestSubmissionsPerPhaseState(manager, phaseStateIds);
    if (!newest.length) return latest;
    const rows = await manager.find(SubmissionEntity, {
      where: { id: In(newest.map((row) => row.id)) },
      // Named columns, never the whole row: this runs once per phase state
      // across a whole class, and `workspaceSnapshot` is a full copy of every
      // editable file the learner had at submission time. Nothing below reads
      // it, and decoding it would be tens of megabytes of JSON per request.
      select: [
        'id',
        'phaseStateId',
        'status',
        'score',
        'passed',
        'report',
        'error',
        'createdAt',
        // The export's four attempt columns are all facts about this
        // one row, so they ride along rather than costing a second query.
        'packVersion',
        'regradeOf',
        // Which task this revision is
        // about, so the strict gate is asked of that task's rubric and not of
        // the phase's.
        'taskKey',
      ],
    });
    // Query presence without decoding the source payload for every learner.
    const retained = new Set(
      (
        await manager.find(SubmissionEntity, {
          where: {
            id: In(newest.map((row) => row.id)),
            workspaceSnapshot: Not(IsNull()),
            contextSnapshot: Not(IsNull()),
          },
          select: ['id'],
        })
      ).map((row) => row.id),
    );
    for (const submission of rows) {
      if (latest.has(submission.phaseStateId)) continue;
      latest.set(submission.phaseStateId, toLatest(submission, retained));
    }
    return latest;
  }

  /**
   * The newest attempt **per task**, for the phase states that have task rows.
   *
   * The sibling above keeps its name, its query and its three consumers: *the
   * newest revision on this phase* stays the right question for the phase
   * view's `lastSubmission` and for the console's activity column. This is the
   * other question the task grain makes askable, and two readers need it; the
   * per-task record in the dossier, and the four CSV columns that have to
   * follow the work that gates the phase rather than whichever task was handed
   * in last.
   *
   * It is never called on a board with no task rows, so a project of sole-task
   * phases pays nothing for it.
   */
  private async latestSubmissionsPerTask(
    manager: EntityManager,
    phaseStateIds: string[],
  ): Promise<Map<string, Map<string, LatestSubmission>>> {
    const out = new Map<string, Map<string, LatestSubmission>>();
    if (!phaseStateIds.length) return out;
    const newest = await newestSubmissionsPerTask(manager, phaseStateIds);
    if (!newest.length) return out;
    const ids = newest.map((row) => row.id);
    const rows = await manager.find(SubmissionEntity, {
      where: { id: In(ids) },
      // The same named columns as the sibling, and for the same reason: this
      // runs across a whole class and `workspaceSnapshot` is a full copy of
      // every editable file the learner had at submission time.
      select: [
        'id',
        'phaseStateId',
        'taskKey',
        'status',
        'score',
        'passed',
        'report',
        'error',
        'createdAt',
        'packVersion',
        'regradeOf',
      ],
    });
    const retained = new Set(
      (
        await manager.find(SubmissionEntity, {
          where: { id: In(ids), workspaceSnapshot: Not(IsNull()), contextSnapshot: Not(IsNull()) },
          select: ['id'],
        })
      ).map((row) => row.id),
    );
    for (const submission of rows) {
      const byTask = out.get(submission.phaseStateId) ?? new Map<string, LatestSubmission>();
      if (!byTask.has(submission.taskKey)) {
        byTask.set(submission.taskKey, toLatest(submission, retained));
      }
      out.set(submission.phaseStateId, byTask);
    }
    return out;
  }

  /* ------------------------------ override ------------------------------ */

  async overridePhase(
    caller: InstructorCaller,
    userId: string,
    phaseStateId: string,
    action: PhaseOverrideAction,
    reason: string,
    taskKey?: string,
  ): Promise<PhaseOverrideResult> {
    const trimmed = reason.trim();
    if (trimmed.length < OVERRIDE_REASON_MIN) {
      throw new BadRequestException(
        `give a reason of at least ${OVERRIDE_REASON_MIN} characters`,
      );
    }
    const manager = this.dataSource.manager;
    const learner = await this.scopedLearner(manager, caller, userId);

    // Looked up under the learner's id, never by phase id alone: a phase id
    // from another class must not become readable by naming a learner in mine.
    //
    // This read answers the 404 and names the enrolment. It does NOT decide
    // anything the override writes: a verdict can commit between here and the
    // lock, so the columns come from the re-read inside it.
    const state = UUID_PATTERN.test(phaseStateId)
      ? await manager.findOne(PhaseStateEntity, {
          where: { id: phaseStateId, userId: learner.id },
        })
      : null;
    if (!state) throw new NotFoundException('no such phase for this learner');
    const enrollment = await manager.findOneByOrFail(EnrollmentEntity, {
      id: state.enrollmentId,
    });
    // The pinned version. `pass` floors the score at this phase's own
    // `passThreshold`, so the version resolved here is written into the
    // learner's record as a number: it has to be the gate they were held to,
    // not one a later publication moved.
    const project = this.content.getForEnrollment(enrollment);
    const phase = project.phases.find((p) => p.key === state.phaseKey);
    // The pinned version's task list, read through the one accessor every
    // per-task question here goes through.
    const tasks = this.tasksOf(enrollment, state.phaseKey);
    const now = new Date().toISOString();

    /**
     * The whole write is one transaction,
     * under the pessimistic **enrolment** lock; `advance`'s own idiom, on the
     * enrolment and not on the phase state, because that is the row every
     * writer of a phase's status can reach from and the one `advance` already
     * holds. `scopedLearner`, the reason-length refusal, the two lookups above
     * and the structured log below stay outside it: none of them writes.
     *
     * The sign-off is the case that makes this necessary rather than tidy. A
     * countersignature happens **once**, and nothing later heals a phase that a
     * lost race left `submitted` with every required task `passed`.
     *
     * And the phase state is **re-read inside the lock**, as `held`. The lookup
     * above answers whose phase this is; it cannot answer what the phase says,
     * because a verdict can commit between that read and the lock. A patch
     * computed from the outer row would serialise the write without serialising
     * the read it is computed from, and `task-reopen` would then decide the
     * phase write-down on a status that is no longer there, leaving the phase
     * green over a reopened required task, which `phaseRollup`'s monotonicity
     * never heals downward. The roll-up writers that take this same lock all
     * re-read after it (`feedback.service.ts`'s `writeVerdict`,
     * `regrade.service.ts`, `advance`) and this one is not the exception.
     * Inside the transaction `state` is only its own id; every column that a
     * writer can move is read from `held`.
     */
    const written = await atomic(this.dataSource, async (tx) => {
      await heldEnrollment(tx, { id: enrollment.id, userId: learner.id });
      const held = await tx.findOneByOrFail(PhaseStateEntity, {
        id: state.id,
        userId: learner.id,
      });
      const rows = tasks.length
        ? await tx.find(TaskStateEntity, { where: { phaseStateId: held.id } })
        : [];
      const rowOf = (key: string): TaskStateEntity | undefined =>
        rows.find((row) => row.taskKey === key);
      // A lever that clears the files moves the save stamp, by the formula every
      // workspace writer uses: a learner save or a drill resolve that read the
      // row before the reset then fails its compare-and-swap, rather than
      // writing the old files back over the reset.
      const nextWorkspaceStamp = (): string =>
        new Date(Math.max(Date.now(), (Date.parse(held.workspaceUpdatedAt ?? '') || 0) + 1)).toISOString();

      /**
       * Is a revision of this phase (of one task, where a key is named) still
       * queued or running? Read on `tx`, after the lock above, which is the
       * whole of what makes it worth asking (see `inFlightResetRefusal`).
       */
      const marking = (key?: string): Promise<boolean> =>
        tx.exists(SubmissionEntity, {
          where: {
            phaseStateId: held.id,
            ...(key === undefined ? {} : { taskKey: key }),
            status: In(['queued', 'running']),
          },
        });

      /** Write one task row and keep the in-memory copy the roll-up reads. */
      const writeTask = async (
        row: TaskStateEntity,
        fields: Partial<TaskStateEntity>,
      ): Promise<void> => {
        await tx.update(TaskStateEntity, { id: row.id }, fields);
        Object.assign(row, fields);
      };

      /**
       * The row a required task must have, created if the board never got one.
       *
       * `orIgnore` and then a read, the grader's own idiom (`heldTaskRow`,
       * `feedback.service.ts`): a repair landing at the same instant settles on
       * `UQ_task_states_key` rather than on a read-then-write. The new row
       * joins `rows`, so the note below, the response's per-task view and any
       * later reader of this list quantify over it like every other.
       *
       * Reached from `pass` alone, and only on an authored list, see there.
       */
      const mintTask = async (task: CompiledTask): Promise<TaskStateEntity> => {
        const where = { phaseStateId: held.id, taskKey: task.taskKey };
        await tx
          .createQueryBuilder()
          .insert()
          .into(TaskStateEntity)
          .values({ ...where, userId: held.userId })
          .orIgnore()
          .execute();
        const made = await tx.findOneOrFail(TaskStateEntity, { where });
        rows.push(made);
        this.logger.warn(
          `phase state ${held.id} had no task state for "${task.taskKey}"; an instructor Pass created it rather than passing the phase over a gate it could not open`,
        );
        return made;
      };

      // A patch, never save(state). save() writes back every column that differs
      // from the row, and this entity was read before the request did any of its
      // work: the learner is very likely typing in the phase being passed or
      // reopened (that is usually why they asked) and their 700 ms autosave,
      // along with any verdict the grader wrote in between, would be reverted by
      // an instructor's click. Only the columns the action owns go back.
      let patch: Partial<PhaseStateEntity>;
      /** The release a `reset-phase` removed, kept so the trail can carry it. */
      let released: ReleaseRecordEntity | null = null;
      /** What `pass` could not finish on its own, if anything. */
      let note: string | undefined;
      /** The task a per-task lever named, for the audit row. */
      let named: CompiledTask | undefined;
      /** What a `task-reset` did to a QUIZ, if the task it named was one. */
      let quizReset: { attemptEpoch: number; voidedQuizAttemptId: string | null } | undefined;

      switch (action) {
        case 'pass': {
          if (held.status === 'passed')
            throw new ConflictException('this phase is already passed');
          if (!phase)
            throw new NotFoundException(
              'phase content no longer exists, so its pass mark is unknown',
            );
          // A teacher's Pass is about the
          // gate, so it writes the rows the gate quantifies over (the required
          // tasks) and leaves an optional one alone, because an optional task
          // is shown, scored and recorded and moves no gate.
          //
          // A `signOff` task is not among them: `task-signoff` is the only
          // writer that may set `status: 'passed'` on one, which is what keeps
          // `passed` meaning one thing to the door, the roll-up and `advance`.
          // Saying so beats leaving the phase quietly shut.
          //
          // A sole task has no row and must never gain one; the phase row
          // IS its row, and `soleTaskList` is the predicate for that, never a
          // key test. On such a phase `rows` is empty, so the loop below writes
          // nothing and the shipped project's Pass stays a single-row update.
          const authored = !soleTaskList(tasks);
          for (const task of tasks) {
            if (!task.required || task.signOff) continue;
            // A required key with no row is a FAILING key: `phaseRollup`
            // quantifies over the keys and `strictPass` reads the row itself,
            // as a conjunct beside the evidence. Skipping it wrote the phase
            // `passed` over a gate that would refuse `advance` for ever; a
            // green tile the teacher had no way to tell from an open one.
            // Nothing else fills the hole on this path: `repairBoard` runs from
            // the learner's own reads (`reconcileToPack`, `phaseDetail`) and an
            // override reaches neither, so a board not read since the phase was
            // split, or a row lost to a restore, arrives here without it.
            const row = rowOf(task.taskKey) ?? (authored ? await mintTask(task) : undefined);
            if (!row) continue;
            await writeTask(row, {
              status: 'passed',
              // A pass already stamped keeps its date: this is a gate being
              // opened, not a second pass.
              passedAt: row.passedAt ?? now,
              // The task's own rubric gate is the floor, never a ceiling.
              bestScore: Math.max(row.bestScore ?? 0, task.rubric.passThreshold),
              awaitingSignOff: false,
            });
          }
          const pending = tasks.filter(
            (task) => task.required && task.signOff && rowOf(task.taskKey)?.status !== 'passed',
          ).length;
          if (pending) note = countersignatureNote(pending);
          patch = {
            status: 'passed',
            passedAt: now,
            unlockedAt: held.unlockedAt ?? now,
            // The rubric gate is the floor, never a ceiling: a learner who scored
            // above it keeps their own number.
            bestScore: Math.max(held.bestScore ?? 0, phase.rubric.passThreshold),
          };
          break;
        }
        case 'reopen': {
          if (held.status === 'in_progress')
            throw new ConflictException('this phase is already open');
          patch = {
            status: 'in_progress',
            // Reopening from 'locked' is the early unlock; from 'passed' it withdraws
            // the pass but keeps the score history, which is the learner's record.
            passedAt: null,
            unlockedAt: held.unlockedAt ?? now,
          };
          // The task rows come down with the phase, or the phase reads open
          // while every row under it still reads passed, and the two surfaces
          // disagree about one gate. The scores stay: they are the record.
          for (const row of rows) {
            await writeTask(row, { status: 'in_progress', passedAt: null, awaitingSignOff: false });
          }
          break;
        }
        case 'reset-workspace': {
          // The one column here an instructor is meant to overwrite: a reset
          // clears the files whatever landed while they were deciding.
          patch = {
            workspace: null,
            workspaceUpdatedAt: nextWorkspaceStamp(),
            // A run against the old files says nothing about the fresh ones, and
            // the process score would otherwise credit it on the next submit.
            ranBeforeSubmit: false,
          };
          break;
        }
        case 'reset-phase': {
          // The fourth lever: start the phase over.
          //
          // `reopen` plus `reset-workspace` is not this. Together they leave the
          // links, the drill write-up, the merge message and (the one that
          // matters) the release record for the phase. A learner who merges
          // again then hits `UQ_releases_enrollment_phase`, and `advance` treats
          // the loser of that race as a success (workflow.service.ts), so the
          // *old* release survives with the old score and the learner's history
          // says a phase shipped twice at a number nobody can explain. So the
          // release goes, and its version, score and merge message are copied
          // into the audit row's detail: the record moves into the trail rather
          // than disappearing.
          //
          // Seven columns are cleared and one is set. `attempts` is deliberately
          // not among them; how many goes at the rubric a learner has had is a
          // fact about them, and zeroing it would move the reliance index's
          // denominator for an instructor's housekeeping. Neither is
          // `currentPhaseOrder`, and no submission is deleted: the revision
          // history is exactly what an appeal reads.
          //
          // And never while a revision of ANY task of the phase is still
          // being marked, because this lever clears every row that verdict
          // would land on. Asked first, so a refusal writes nothing.
          if (await marking())
            throw new ConflictException(inFlightResetRefusal(phase?.title ?? 'This phase'));
          released = await tx.findOne(ReleaseRecordEntity, {
            where: { enrollmentId: enrollment.id, phaseOrder: held.phaseOrder },
          });
          if (released) await tx.delete(ReleaseRecordEntity, { id: released.id });
          patch = {
            workspace: null,
            workspaceUpdatedAt: nextWorkspaceStamp(),
            links: null,
            drill: null,
            reflection: null,
            ranBeforeSubmit: false,
            bestScore: null,
            passedAt: null,
            // A phase the learner had never reached stays out of reach: a reset
            // is not an unlock, and `reopen` is the lever that is.
            status: held.status === 'locked' ? 'locked' : 'in_progress',
          };
          // The task rows are reset with it, score included; without that a
          // phase reset from 90 comes back at 90 the moment the roll-up takes
          // the mean over rows nothing cleared. `attempts` is the learner's
          // record and this lever does not move it.
          //
          // A NON-QUIZ row's `resetCount` rises by one, so a
          // regrade of a revision from before the phase reset is of another run
          // and moves no gate (the regrade half of this lever's race). Its
          // NULL-epoch revisions are stamped with the run that ends first
          // (`stampEndingRun`), on this transaction under the lock above.
          //
          // `resetCount` IS a quiz's attempt epoch, so this
          // lever deliberately returns no quiz attempts. A phase reset
          // withdraws a quiz's pass and leaves its papers spent, which on a
          // required quiz with a spent limit leaves the learner with nothing
          // to press, and `task-reset` on that quiz is then the lever that
          // opens it, always. Said here so the next reader does not have to
          // work it out from two files.
          for (const row of rows) {
            const kind = tasks.find((one) => one.taskKey === row.taskKey);
            const startsOver = !!kind && !isQuizTask(kind) && !soleTaskList(tasks);
            if (startsOver) await stampEndingRun(tx, row);
            await writeTask(row, {
              status: patch.status,
              passedAt: null,
              bestScore: null,
              ranBeforeSubmit: false,
              awaitingSignOff: false,
              // As `task-reset` below; a sign-off is part
              // of the verdict a reset takes back.
              signedOffBy: null,
              signedOffAt: null,
              solutionReadAt: null,
              ...(startsOver ? { resetAt: now, resetCount: row.resetCount + 1 } : {}),
            });
          }
          break;
        }
        case 'task-signoff':
        case 'task-reset':
        case 'task-reopen': {
          // The three levers a teacher has
          // over ONE task of a phase.
          if (!phase)
            throw new NotFoundException(
              'phase content no longer exists, so its tasks are unknown',
            );
          if (soleTaskList(tasks)) throw new BadRequestException(SOLE_TASK_LEVER_REFUSAL);
          const key = (taskKey ?? '').trim();
          const task = tasks.find((one) => one.taskKey === key);
          // The loader's own register, one grain down: a key the pinned version
          // does not declare is a 404, never a lever applied to a guess. The
          // sentence is the product's one sentence for that fact, minted where
          // the learner's routes mint it, so a teacher and a learner are told
          // the same thing about the same key.
          if (!task) throw unknownTask(key);
          const row = rowOf(key);
          if (!row)
            throw new NotFoundException(
              `this learner has no state for the task "${key}" yet`,
            );
          named = task;

          if (action === 'task-signoff') {
            if (row.status === 'passed')
              throw new ConflictException('this task is already passed');
            const scored = Math.max(row.bestScore ?? 0, task.rubric.passThreshold);
            await writeTask(row, {
              status: 'passed',
              // After a learner's retry, the new pass takes its own date.
              passedAt: signOffPassedAt(row, now),
              bestScore: scored,
              // Never `passed` beside `awaitingSignOff`: the countersignature
              // IS the second half, so once it lands there is nothing awaited.
              awaitingSignOff: false,
              signedOffBy: caller.id,
              signedOffAt: now,
            });
            // The verdict this lever hands the roll-up. The authored arm reads
            // the rows and not the verdict, and the sole-task arm is refused
            // above by name, so the pair below is a statement rather than an
            // input, but it is the honest one: this task is through, at the
            // number the row now carries.
            patch = phaseRollup(
              { status: held.status, passedAt: held.passedAt, bestScore: held.bestScore },
              tasks,
              rows,
              { passed: true, overall: scored },
              now,
            );
            break;
          }

          if (action === 'task-reopen') {
            // Withdraws the verdict and keeps the record, which on a quiz
            // means the papers stay spent, because the epoch is `resetCount`
            // and this lever does not move it. `task-reset` beside it is the
            // one that hands the attempts back.
            if (row.status === 'in_progress')
              throw new ConflictException('this task is already open');
            await writeTask(row, {
              status: 'in_progress',
              passedAt: null,
              awaitingSignOff: false,
              // The countersignature was part of the pass this withdraws;
              // left on the row it would read "signed off" beside whatever
              // pass came next. The audit trail keeps the sign-off.
              signedOffBy: null,
              signedOffAt: null,
            });
          } else {
            // `task-reset` starts one task over: its verdict, its score and its
            // door go, and the count of how many times that has happened is
            // what `resetAt` and `resetCount` are for. `attempts` stays; how
            // many goes at the rubric a learner has had is a fact about them.
            // No file is deleted here: the workspace is the phase's, and the
            // learner-facing reset (the one that writes `task_resets`) is what
            // touches files.
            //
            // Never while a revision of THIS task is still being marked;
            // its verdict would land on the fresh start. A sibling's does not
            // hold it, exactly as it does not hold this task's own submit.
            if (await marking(key)) throw new ConflictException(inFlightResetRefusal(task.title));
            // Close the run this reset ends before the count
            // moves. A quiz keeps its paper rule, so only a non-quiz task.
            if (!isQuizTask(task)) await stampEndingRun(tx, row);
            await writeTask(row, {
              status: 'in_progress',
              passedAt: null,
              bestScore: null,
              ranBeforeSubmit: false,
              awaitingSignOff: false,
              // A countersignature is part of the verdict a reset takes back,
              // so it goes with it; otherwise the console would read "signed
              // off" beside a task started over. `task.signoff` in the audit
              // trail is the record that it was once given.
              signedOffBy: null,
              signedOffAt: null,
              solutionReadAt: null,
              resetAt: now,
              resetCount: row.resetCount + 1,
            });
            // THE RECOVERY for a spent quiz, and the only one there is.
            //
            // A required quiz failed on every allowed attempt locks its phase
            // and the rest of the project behind it, and nothing else in the product can
            // open them: the cap is compulsory on a required quiz, the count
            // is over the papers already handed in, and a live enrolment is
            // never re-pinned, so republishing with a larger cap does not
            // reach the learner who is stuck. This lever is what reaches them.
            //
            // It costs no new column and no new write. `resetCount` (which
            // the line above already increments, for every kind of task) IS
            // the attempt **epoch** a paper is stamped with, so the spent
            // count, the *open paper* lookup, the attempt numbering and
            // `attemptsLeft` all begin again while every paper the learner
            // ever sat stays exactly where it is. Nothing here deletes a row.
            //
            // The one paper that cannot simply be left is the one still open:
            // it belongs to the run that has just ended. `voidOpen` closes it
            // (so it leaves `UQ_quiz_attempts_open` and the learner can draw
            // a new one) and marks it void, so it is never scored, never
            // counted and never linked to a revision, and a stale hand-in of
            // it meets the same one sentence every other wrong attempt id
            // meets. The write is on `tx`, so it rolls back with the rest.
            if (isQuizTask(task)) {
              quizReset = {
                attemptEpoch: row.resetCount,
                voidedQuizAttemptId: await new QuizAttemptsService(
                  tx.getRepository(QuizAttemptEntity),
                ).voidOpen(held.id, key),
              };
            }
          }
          // The phase row comes down with a REQUIRED task, and the roll-up is
          // not the instrument for it: `phaseRollup` is monotonic and never
          // un-passes, because stickiness is a rule about verdicts, and a
          // teacher's lever is not one. An optional task moves no gate, so it
          // moves no phase row either.
          patch =
            task.required && held.status === 'passed'
              ? { status: 'in_progress', passedAt: null }
              : {};
          break;
        }
        default:
          // `PhaseOverrideAction` is exhausted above, so `action` is `never`
          // here and this line is unreachable through the DTO's `@IsIn`. It is
          // written anyway, because an action this build cannot carry out must
          // be refused rather than write an empty patch; a doubt reads shut.
          throw new BadRequestException(
            `this build cannot carry out the override "${String(action)}"`,
          );
      }

      if (Object.keys(patch).length) {
        // The in-memory copy the response view is built from: the row as the
        // lock found it, plus the columns this action owns. Never `save(held)`.
        Object.assign(held, patch);
        await tx.update(PhaseStateEntity, { id: held.id }, patch);
      }

      await recordAudit(tx, {
        event: OVERRIDE_EVENTS[action] ?? 'phase.override',
        actorUserId: caller.id,
        subjectUserId: learner.id,
        targetId: held.id,
        action,
        reason: trimmed,
        detail: {
          projectSlug: enrollment.projectSlug,
          phaseKey: held.phaseKey,
          // Only ever set by a per-task lever, and the whole of what makes the
          // row readable six weeks later.
          ...(named ? { taskKey: named.taskKey, taskTitle: named.title } : {}),
          // Only ever set by `task-reset` on a QUIZ: which run of the quiz the
          // learner is now on, and the paper this reset closed without it ever
          // having been sat. An appeal about a missing paper reads this row.
          ...(quizReset ?? {}),
          // Only ever set by `reset-phase`, and the only copy of the release
          // that is left once the row is gone.
          ...(released
            ? {
                removedRelease: {
                  version: released.version,
                  score: released.score,
                  notes: released.notes,
                  createdAt: isoOrNull(released.createdAt),
                },
              }
            : {}),
        },
      });
      return { held, rows, note };
    });

    // A structured line, not prose: overrides are what an appeal or an audit
    // asks about, and the reason has to be searchable next to who did it.
    this.logger.log({
      event: 'phase.override',
      action,
      actorId: caller.id,
      learnerId: learner.id,
      phaseStateId: state.id,
      projectSlug: enrollment.projectSlug,
      phaseKey: state.phaseKey,
      ...(taskKey === undefined ? {} : { taskKey }),
      reason: trimmed,
    });

    const hints =
      (await hintsByPhaseState(manager, [state.id])).get(state.id) ?? 0;
    const latest =
      (await this.latestSubmissions(manager, [state.id])).get(state.id)?.view ??
      null;
    const perTask = written.rows.length
      ? (await this.latestSubmissionsPerTask(manager, [state.id])).get(state.id)
      : undefined;
    // Read rather than defaulted, because the response a
    // teacher reads after a lever must say what the console said before it.
    // Defaulting to an empty map would answer `quizAttemptsSpent:
    // false` for a quiz whose papers really are spent.
    const quizSpent = written.rows.length
      ? await quizSpentByState(manager, [state.id])
      : new Map<string, number>();
    // A lever that leaves the learner's current phase
    // reading `passed` has not necessarily opened it; the gate still wants a
    // reviewed revision of every required task. Asked after the commit, of the
    // enrolment as it now stands, with the gate's own predicate.
    const standing = await manager.findOneByOrFail(EnrollmentEntity, { id: enrollment.id });
    const course = this.gateCourse(standing);
    // A Pass on a phase AHEAD of the learner has not opened
    // it either; `advance` refuses it until they reach it, and then the gate
    // asks for the same reviewed pass. The lever's own question promises the
    // answer says whether one is still owed, so it is asked here too, with the
    // predicate the learner's room asks (`evidenceNeededAhead`).
    const current = await evidenceNeededAt(manager, standing, written.held, course);
    const ahead = current ? undefined : await evidenceNeededAhead(manager, standing, written.held, course);
    const needed = current ?? ahead;
    const view: PhaseOverrideResult = this.phaseView(
      // The row the lock found plus the patch, never the snapshot read before
      // it: a teacher who reopens a task is shown the phase as it now stands.
      written.held,
      project,
      hints,
      latest,
      await scheduleForCohort(manager, learner.cohort, enrollment.projectSlug),
      tasks,
      written.rows,
      perTask,
      quizSpent,
      needed,
    );
    const note = [
      written.note,
      needed
        ? evidenceStillNeededNote(phase?.title ?? state.phaseKey, needed, { ahead: Boolean(ahead) })
        : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    return note ? { ...view, note } : view;
  }

  /* -------------------------------- audit ------------------------------- */

  /**
   * The audit trail, newest first, one keyset page at a time.
   *
   * Scoped the way every other route here is: an instructor reads what
   * happened to the learners in their own classes, plus their own actions
   * wherever they landed, and an admin reads everything. Naming a learner
   * outside the caller's classes is the same 404 as asking for their detail
   * page, so the trail cannot be used to enumerate other people's classes.
   *
   * ## Why a cursor rather than a bigger `take`
   *
   * `take` alone bounds what is returned, not what is read. Every shape of
   * this query sorts by `createdAt DESC, id DESC`, and with nothing indexing
   * `createdAt` the database read the whole table and sorted all of it to hand
   * back fifty rows; `SCAN audit_events` then `USE TEMP B-TREE FOR ORDER BY`,
   * growing with every override and class move the deployment
   * has ever recorded. A keyset cursor turns each page into a range on an
   * index that is already in the answer's order: `SEARCH audit_events USING
   * INDEX ... ((createdAt,id)<(?,?))`, no sort, the same cost on the first day
   * of term and the last.
   *
   * `id` is in the cursor as well as the index because timestamps here are not
   * unique (an override and the class move beside it land in the same
   * second) and a cursor on `createdAt` alone would either skip the rest of
   * that second or repeat it.
   *
   * ## Why the class scope is an `EXISTS` rather than a list of ids
   *
   * Naming the learners (`subjectUserId IN (thirty ids)`) is a shape the
   * planner serves by seeking each id in turn and sorting what it finds, which
   * puts the temporary b-tree straight back. Asking instead whether the row's
   * subject is one of my learners lets the walk stay on the ordered index and
   * checks each candidate with a primary-key lookup. It also drops a query:
   * the ids never have to be fetched.
   */
  async auditLog(
    caller: InstructorCaller,
    learnerId?: string,
    limit = AUDIT_DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<AuditEventView[]> {
    const manager = this.dataSource.manager;
    const take = auditTake(limit);
    const query = manager.createQueryBuilder(AuditEventEntity, 'a');

    if (learnerId) {
      const learner = await this.scopedLearner(manager, caller, learnerId);
      query.where('a.subjectUserId = :subjectUserId', {
        subjectUserId: learner.id,
      });
    } else if (caller.role !== 'ADMIN') {
      const scope = await learnerScope(manager, caller);
      // An instructor an admin created a minute ago has no class yet, and
      // `learnerScope` matches nobody. Their own actions are then the whole
      // answer, and asking for it by name is a seek on the actor index rather
      // than a walk of a trail that holds nothing for them.
      const anyLearner = await manager.findOne(UserEntity, {
        where: scope,
        select: ['id'],
      });
      if (anyLearner) {
        const inMyClass = query
          .subQuery()
          .select('1')
          .from(UserEntity, 'u')
          .where(`u.id = ${asUserId(manager, 'a.subjectUserId')}`)
          .andWhere(scope);
        query
          .where(
            `(EXISTS ${inMyClass.getQuery()} OR a.actorUserId = :actorUserId)`,
          )
          .setParameters(inMyClass.getParameters())
          .setParameter('actorUserId', caller.id);
      } else {
        query.where('a.actorUserId = :actorUserId', { actorUserId: caller.id });
      }
    }

    const from = decodeAuditCursor(cursor);
    const rows = await query
      .andWhere(
        `(a.createdAt, a.id) < (:cursorAt, ${cursorIdParam(manager)})`,
        {
          cursorAt: storedDate(manager, from.createdAt),
          cursorId: from.id,
        },
      )
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(take)
      .getMany();
    return auditViews(manager, rows);
  }

  /* ------------------------------- export ------------------------------- */

  /** The class's name as the class export's file name carries it (`-class-tuesday-class`). */
  classFileLabel(cohort: string): Promise<string> {
    return classFileLabel(this.dataSource.manager, cohort);
  }

  /**
   * One row per learner × phase for the caller's class. Learners who have not
   * started anything have no grades and so no rows; the overview is the roll
   * call, this is the grade book.
   */
  async exportCsv(
    caller: InstructorCaller,
    projectSlug?: string,
    /** One class of the caller's: absent, every class in their scope. */
    cohort?: string,
  ): Promise<string> {
    // Fail loudly on a typo'd slug: an empty file looks like an empty class.
    if (projectSlug) this.content.getProject(projectSlug);
    const manager = this.dataSource.manager;

    const learners = await manager.find(UserEntity, {
      where: cohort ? await classScope(manager, caller, cohort) : await learnerScope(manager, caller),
      order: { email: 'ASC' },
    });
    const byUser = new Map(learners.map((l) => [l.id, l]));
    const enrollments = learners.length
      ? await manager.find(EnrollmentEntity, {
          where: {
            userId: In([...byUser.keys()]),
            ...(projectSlug ? { projectSlug } : {}),
          },
        })
      : [];
    const byEnrollment = new Map(enrollments.map((e) => [e.id, e]));
    const states = enrollments.length
      ? await manager.find(PhaseStateEntity, {
          where: { enrollmentId: In([...byEnrollment.keys()]) },
        })
      : [];
    const hints = await hintsByPhaseState(
      manager,
      states.map((s) => s.id),
    );
    const latest = await this.latestSubmissions(
      manager,
      states.map((s) => s.id),
    );
    const cohortNames = await cohortNamesById(
      manager,
      learners.map((l) => l.cohort),
    );
    // One read per class and project in the file, not one per row: `late` is
    // derived from the class's due date, and a class of twenty-five shares six.
    const schedules = await schedulesFor(manager, learners, enrollments);
    // The four appended columns describe
    // the newest revision among the phase's REQUIRED tasks. Both reads are
    // skipped on a board with no task rows, where the sole task is required and
    // the newest required revision already IS the newest revision.
    const taskRows = await taskRowsByState(
      manager,
      states.map((s) => s.id),
    );
    const perTask = taskRows.size
      ? await this.latestSubmissionsPerTask(manager, [...taskRows.keys()])
      : new Map<string, Map<string, LatestSubmission>>();

    const rows = states
      .map((state) => {
        const enrollment = byEnrollment.get(state.enrollmentId)!;
        const learner = byUser.get(enrollment.userId)!;
        return { state, enrollment, learner };
      })
      .sort(
        (a, b) =>
          a.learner.email.localeCompare(b.learner.email) ||
          a.enrollment.projectSlug.localeCompare(b.enrollment.projectSlug) ||
          a.state.phaseOrder - b.state.phaseOrder,
      );

    const lines = [CSV_COLUMNS.join(',')];
    for (const { state, enrollment, learner } of rows) {
      const phaseHints = hints.get(state.id) ?? 0;
      const newest = latest.get(state.id);
      const report = newest?.view.report ?? null;
      // The row is the phase's row and its
      // gate columns are the required set's, so `late` answers *was the work
      // that gates this phase handed in on time*, which is the question a due
      // date asks. An optional task handed in after the bell is visible in the
      // per-task export and moves nothing here, exactly as it moves no gate.
      // Where no required task has a revision the four read the newest revision
      // on the phase state, as a sole-task phase does: a learner with only optional work has no
      // required answer to date, and a blank and a no are different facts.
      const gating =
        this.newestRequired(
          enrollment,
          state.phaseKey,
          perTask.get(state.id),
        ) ?? newest;
      const dueAt =
        schedules
          .get(scheduleKey(learner.cohort, enrollment.projectSlug))
          ?.get(state.phaseKey)?.dueAt ?? null;
      lines.push(
        [
          learner.email,
          learner.displayName,
          cohortNames.get(learner.cohort) ?? learner.cohort,
          enrollment.projectSlug,
          state.phaseKey,
          state.status,
          state.bestScore,
          state.attempts,
          phaseHints,
          relianceIndex(phaseHints, state.attempts),
          state.passedAt,
          enrollment.completed,
          killMatrixCell(report),
          conformanceCell(report),
          drillCell(report),
          // `late` is derived here rather than stored, so moving a
          // class's due date moves what this file says on the next export and
          // a class with no dates has no lateness at all. Blank, not `false`,
          // when there is nothing to compare against: a blank and a no are
          // different facts.
          gating?.packVersion ?? '',
          gating?.view.createdAt ?? '',
          gating && dueAt
            ? isLate(gating.view.createdAt, dueAt)
              ? 'yes'
              : 'no'
            : '',
          gating ? (gating.regraded ? 'yes' : 'no') : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * The grade book: one row per learner and project, one column per phase.
   *
   * A different question from `exportCsv`, not a smaller one. That file is the
   * record an appeal reads (every phase on its own line with its attempts,
   * hints and reliance index) and this one is the shape a spreadsheet or an
   * LMS import wants, where a learner is a row and a phase is a column.
   *
   * A phase with no score is blank rather than zero, and `average` is the mean
   * of the phases that do have one: a blank and a zero are different facts,
   * and inventing a weighting or a late penalty the content pack does not
   * declare would be this file making up a grading policy.
   *
   * The last two columns are the two overview
   * numbers, read off the pinned version's tasks rather than off these phase
   * rows; `checklist %` over the required tasks the version declares, and
   * `quiz mastery %` over its quiz tasks. They are appended, because the header
   * is the contract a spreadsheet import reads.
   *
   * **A blank `quiz mastery %` has two meanings, and a teacher reading a term
   * of marks should be told which.** The number is the mean of each quiz
   * task's `bestScore`, and a quiz with no score is left out of the mean
   * rather than counted as a zero, so the cell is blank both for a learner
   * who never opened the quiz and for one whose teacher has **reset** it,
   * because a reset withdraws the pass and the best score together (the
   * `task-reset` arm of `overridePhase`, and `masteryPercentOf`'s own rule
   * about a blank and a zero being different facts). That is the intended
   * reading (the learner is being asked again, and a number from a run that
   * has been withdrawn would be a number about work that no longer counts)
   * but it is not one a spreadsheet can infer. The papers themselves are never
   * deleted: every one of them stays in `quiz_attempts` for the learner
   * detail view and for an appeal.
   */
  async exportGradebook(
    caller: InstructorCaller,
    projectSlug?: string,
    /**
     * One class of the caller's: a class page's "Download this class's grade
     * book". Absent, the book covers every class in the caller's scope; a
     * class outside it is a 404 before any read.
     */
    cohort?: string,
  ): Promise<string> {
    if (projectSlug) this.content.getProject(projectSlug);
    const manager = this.dataSource.manager;

    const learners = await manager.find(UserEntity, {
      where: cohort ? await classScope(manager, caller, cohort) : await learnerScope(manager, caller),
      order: { email: 'ASC' },
    });
    const byUser = new Map(learners.map((l) => [l.id, l]));
    const enrollments = learners.length
      ? await manager.find(EnrollmentEntity, {
          where: {
            userId: In([...byUser.keys()]),
            ...(projectSlug ? { projectSlug } : {}),
          },
        })
      : [];
    const states = enrollments.length
      ? await manager.find(PhaseStateEntity, {
          where: { enrollmentId: In(enrollments.map((e) => e.id)) },
        })
      : [];
    const cohortNames = await cohortNamesById(
      manager,
      learners.map((l) => l.cohort),
    );
    // The one read the two appended columns cost, keyed
    // `phaseStateId IN (…)` for the whole class at once. On a board of
    // sole-task phases (the shipped project's, on every phase) it comes back
    // empty and every task's numbers are read from the phase row, exactly as
    // the learner's own board reads them.
    const taskRows = await taskRowsByState(
      manager,
      states.map((s) => s.id),
    );

    const rows = enrollments
      .map((enrollment) => ({
        enrollment,
        learner: byUser.get(enrollment.userId)!,
      }))
      .filter((row) => row.learner)
      .sort(
        (a, b) =>
          a.learner.email.localeCompare(b.learner.email) ||
          a.enrollment.projectSlug.localeCompare(b.enrollment.projectSlug),
      );

    const lines = [GRADEBOOK_COLUMNS.join(',')];
    for (const { enrollment, learner } of rows) {
      const mine = states.filter(
        (state) => state.enrollmentId === enrollment.id,
      );
      const byKey = new Map(mine.map((state) => [state.phaseKey, state]));
      const scored = mine
        .map((state) => state.bestScore)
        .filter(
          (score): score is number => score !== null && score !== undefined,
        );
      const average = scored.length
        ? Math.round(
            scored.reduce((sum, score) => sum + score, 0) / scored.length,
          )
        : '';
      const percentages = this.pinnedPercentages(enrollment, mine, taskRows);
      lines.push(
        [
          learner.email,
          learner.displayName,
          cohortNames.get(learner.cohort) ?? learner.cohort,
          enrollment.projectSlug,
          ...PHASE_ORDER.map((key) => byKey.get(key)?.bestScore ?? ''),
          average,
          mine.filter((state) => state.status === 'passed').length,
          enrollment.completed,
          // The two overview numbers, appended. Both go through `csvCell` with every
          // other cell, so the formula-injection guard covers them too, and
          // both are blank rather than `0` where there is nothing to say: no
          // quiz on the pinned version, or a version this build cannot read.
          percentages?.checklistPercent ?? '',
          percentages?.masteryPercent ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * The two overview numbers for one enrolment, over its **pinned** version's
   * tasks, or null where the version cannot be read.
   *
   * The overall half of `pinnedReading`, the reading the learner's dashboard
   * shows, so the console and the dashboard cannot answer differently. No
   * query of its own: the rows arrive from the single `taskRowsByState` read
   * the caller makes for every learner at once.
   *
   * **Null, not zero, where the version cannot be read.** A database can carry
   * an enrolment on a pack the catalogue no longer ships, and a gradebook that
   * printed `0` for it would report work nobody failed. The caller blanks both
   * cells, which is this file's own rule about a blank and a zero being
   * different facts.
   */
  private pinnedPercentages(
    enrollment: EnrollmentEntity,
    states: PhaseStateEntity[],
    taskRows: ReadonlyMap<string, TaskStateEntity[]>,
  ): Percentages | null {
    return pinnedReading(this.content, enrollment, states, taskRows)?.overall ?? null;
  }

  /**
   * The newest revision among a phase's **required** tasks, or null.
   *
   * Null where this phase state carries no task rows at all, so the caller's
   * `?? newest` falls back to the newest revision on the phase state, which on
   * a sole-task phase is the same row, because the sole task is required
   * (`soleTaskFor`). Null, too, where the required tasks have no revision
   * between them: a learner with only optional work has no required answer to
   * date, and the fallback is what keeps a blank a blank.
   */
  private newestRequired(
    enrollment: EnrollmentEntity,
    phaseKey: string,
    perTask: Map<string, LatestSubmission> | undefined,
  ): LatestSubmission | null {
    if (!perTask?.size) return null;
    const required = requiredKeysOf(this.tasksOf(enrollment, phaseKey));
    let best: LatestSubmission | null = null;
    for (const key of required) {
      const held = perTask.get(key);
      if (!held) continue;
      if (!best || held.view.createdAt > best.view.createdAt) best = held;
    }
    return best;
  }

  /* ------------------------- dossier --------------------------------------- */

  /**
   * One learner's whole project as a document: the files they wrote, every
   * revision with its commit message, the verdict each phase was merged on,
   * the releases, the drill and the timeline. The instructor's copy of what
   * the learner assembles in their own browser from routes they already have.
   *
   * Three things make this route different from every other one here, and all
   * three are deliberate.
   *
   * It goes through `scopedLearner`, so a learner in another instructor's
   * class is a 404 like everywhere else. It writes an audit row: this hands an
   * instructor a learner's own files as one document, and the audit rule is that
   * a change in who can read a learner's work leaves a row. And it never reads
   * the text of a mentor exchange at all; `audience` is `'instructor'`, and
   * the query behind the mentor rows selects ids and timestamps, so the
   * privacy line is in the SQL rather than in a filter someone can forget.
   */
  async learnerDossier(
    caller: InstructorCaller,
    userId: string,
    projectSlug?: string,
  ): Promise<LearnerDossier> {
    const manager = this.dataSource.manager;
    const learner = await this.scopedLearner(manager, caller, userId);

    // The named project, or the oldest enrolment; the same choice
    // AnalyticsService.forLearner and ViewAsService make, for the same reason:
    // row order is not a decision.
    const enrollment = await manager.findOne(EnrollmentEntity, {
      where: projectSlug
        ? { userId: learner.id, projectSlug }
        : { userId: learner.id },
      order: { startedAt: 'ASC' },
    });
    if (!enrollment) {
      throw new NotFoundException(
        projectSlug
          ? 'this learner has not started that project'
          : 'this learner has not started a project',
      );
    }
    // The dossier is the document an appeal reads, and it is
    // printed. The project and phase names on it are the ones the work was done
    // under, which is the version the enrolment holds.
    const project = this.content.getForEnrollment(enrollment);

    // The phases the record prints and counts are the pinned version's: a
    // state for a phase it lacks is left out (`statesOnBoard`).
    const states = statesOnBoard(
      enrollment,
      project,
      await manager.find(PhaseStateEntity, {
        where: { enrollmentId: enrollment.id },
        order: { phaseOrder: 'ASC' },
      }),
    );
    const stateIds = states.map((state) => state.id);
    const hints = await hintsByPhaseState(manager, stateIds);

    // Strict completion requires the original snapshot and submission context.
    // Read them for validation here; revision views never expose their bytes.
    const revisions = stateIds.length
      ? await manager.find(SubmissionEntity, {
          where: { phaseStateId: In(stateIds) },
          order: { createdAt: 'DESC', id: 'DESC' },
          select: [
            'id',
            'phaseStateId',
            'status',
            'score',
            'passed',
            'report',
            'error',
            'createdAt',
            'commitMessage',
            'runClock',
            'contextSnapshot',
            'workspaceSnapshot',
            // Which task this revision is
            // about, so the strict gate is asked of that task's rubric.
            'taskKey',
          ],
        })
      : [];
    const byState = new Map<string, SubmissionEntity[]>(
      stateIds.map((id) => [id, []]),
    );
    for (const row of revisions) byState.get(row.phaseStateId)?.push(row);

    // The pinned version's task list, per
    // phase, read once. A teacher-created task's rubric is derived from its own
    // rules, so judging a revision by the phase's would tell a teacher that a
    // task strict-passed by a rubric it does not have.
    const tasksByPhase = new Map<string, CompiledTask[]>(
      states.map((state) => [state.phaseKey, this.tasksOf(enrollment, state.phaseKey)]),
    );
    const snapshots = new Map(revisions.map(row => [row.id, row.workspaceSnapshot ?? null]));
    const verifiedById = new Map(revisions.map(row => {
      const state = states.find(item => item.id === row.phaseStateId);
      const phase = project.phases.find(item => item.key === state?.phaseKey);
      const tasks = tasksByPhase.get(state?.phaseKey ?? '') ?? [];
      const task = taskForRevision(tasks, row.taskKey);
      const verified = Boolean(
        phase && row.status === 'completed' && row.passed === true &&
        row.workspaceSnapshot && row.contextSnapshot &&
        row.report?.assessmentMode === 'strict_binary' && row.report.passed === true &&
        row.report.aiReview && Array.isArray(row.report.checks) &&
        (task
          ? strictTaskEvidencePassed(task, row.report, row.report.aiReview)
          : strictEvidencePassed(phase, row.report, row.report.aiReview)),
      );
      return [row.id, verified] as const;
    }));

    /**
     * Whether THIS PHASE has a strict-evidence pass, quantified over the
     * pinned version's required keys, not over the rows.
     *
     * `rows.some(verified)` means *this phase has a strict-evidence pass* only
     * while one phase is one task. Under the task grain it would mean *some
     * task does*, so a two-required-task phase passed on task A's evidence plus
     * an instructor's Pass on task B would read `passed` with a stamped
     * `passedAt` here while `advance` refuses the same phase; a reporting
     * surface presenting one task's report as the phase's.
     *
     * A revision is matched to a key through `taskForRevision`, the same
     * resolver the grader uses, so a phase holding one task owns every revision
     * of that phase whatever key the row carries, which is what keeps a legacy
     * revision keyed `''` on a `main` phase readable. On a sole-task phase the
     * required set is the one key `''` and every revision carries it, so this
     * is `rows.some(verified)` term for term.
     */
    const verifiedPhase = (state: PhaseStateEntity): boolean => {
      const tasks = tasksByPhase.get(state.phaseKey) ?? [];
      const required = requiredKeysOf(tasks);
      const rows = byState.get(state.id) ?? [];
      if (!required.size) return rows.some((row) => verifiedById.get(row.id) === true);
      return [...required].every((key) =>
        rows.some(
          (row) =>
            taskForRevision(tasks, row.taskKey)?.taskKey === key &&
            verifiedById.get(row.id) === true,
        ),
      );
    };
    const verifiedByState = new Map(states.map((state) => [state.id, verifiedPhase(state)]));
    // Teachers receive a retained submitted snapshot, never the live draft.
    // Prefer the merged revision, otherwise the latest submitted revision.
    const evidenceByState = new Map(
      stateIds.map((id) => {
        const rows = byState.get(id) ?? [];
        return [
          id,
          rows.find((row) => verifiedById.get(row.id) === true) ?? rows.find((row) => row.passed === true) ?? rows[0] ?? null,
        ] as const;
      }),
    );

    const releases = await manager.find(ReleaseRecordEntity, {
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: 'ASC' },
    });
    const mergeMessages = new Map<string, string | null>(
      releases.map((release) => [release.phaseStateId, release.notes]),
    );

    const phases: DossierPhase[] = states.map((state) => {
      const rows = byState.get(state.id) ?? [];
      const total = rows.length;
      const views = rows
        .map((row, i) => ({ ...dossierRevision(row, total - i), verifiedPass: verifiedById.get(row.id) === true }))
        .reverse();
      const merged = rows.find((row) => verifiedById.get(row.id) === true) ?? rows.find((row) => row.passed === true) ?? null;
      const mergedView = merged
        ? (views.find((view) => view.id === merged.id) ?? null)
        : null;
      const phase = project.phases.find((p) => p.key === state.phaseKey);
      const evidence = evidenceByState.get(state.id);
      const workspace = evidence ? (snapshots.get(evidence.id) ?? null) : null;
      const files =
        phase && workspace !== null
          ? this.content
              .workspaceFiles(phase, workspace)
              .filter(
                (file) =>
                  file.editable &&
                  Object.prototype.hasOwnProperty.call(workspace, file.path),
              )
              .map((file) => ({
                path: file.path,
                content: file.content,
                language: file.language,
              }))
          : [];
      const verified = verifiedByState.get(state.id) === true;
      return {
        phaseStateId: state.id,
        key: state.phaseKey,
        order: state.phaseOrder,
        title: phase?.title ?? state.phaseKey,
        status: state.status === 'passed' && !verified ? 'submitted' : state.status,
        bestScore: state.bestScore,
        attempts: state.attempts,
        hints: hints.get(state.id) ?? 0,
        passedAt: verified ? state.passedAt : null,
        files,
        revisions: views,
        merged: mergedView,
        mergeMessage: mergeMessages.get(state.id) ?? null,
        // The incident from the snapshot's runbook record, as the learner's own dossier reads it.
        drill: phase
          ? drillWithIncident(evidence?.contextSnapshot?.drill ?? null, workspace, phase)
          : (evidence?.contextSnapshot?.drill ?? null),
        links: evidence?.contextSnapshot?.links ?? [],
        // When this learner read the pack's own
        // answer for this phase, or null. The reference itself is not printed;
        // it is the same on every learner's copy, and printing it would treble
        // the document to say nothing about this learner.
        solutionReadAt: state.solutionReadAt ?? null,
        // A design phase's stories, from the phase spec of the version the
        // enrolment holds: the contract's contradictions are read against
        // them, as on the learner's own copy.
        ...(phase?.checks.kind === 'design' ? { designStories: phase.checks.stories.map((story) => ({ ...story })), designContracts: { ...phase.checks.contracts } } : {}),
        // A Maintenance's ticket, for section 9, from the same spec, as the learner's copy reads it.
        ...(phase?.checks.kind === 'code' && phase.checks.ticket
          ? { changeTicket: { ...phase.checks.ticket, acceptance: phase.checks.ticket.acceptance.map((line) => ({ ...line })) } }
          : {}),
      };
    });

    const scored = phases
      .map((phase) => phase.bestScore)
      .filter((score): score is number => score != null);
    const dossier: LearnerDossier = {
      audience: 'instructor',
      userId: learner.id,
      displayName: learner.displayName,
      email: learner.email,
      cohortName: await cohortNameOf(manager, learner.cohort),
      projectSlug: enrollment.projectSlug,
      projectTitle: project.title,
      packVersion: enrollment.packVersion,
      startedAt: isoOrNull(enrollment.startedAt) ?? '',
      // The same per-phase predicate the status downgrade takes, so
      // a project is complete when every phase's required keys are all answered
      // by a strict-evidence pass of their own, never when some task of every
      // phase is. Asked of every phase the pinned version holds, never of the
      // board's states alone: an imported board can hold fewer states than its
      // version and still carry a completion.
      completedAt: project.phases.length > 0 && project.phases.every((p) => phases.some((s) =>
        s.key === p.key && s.status === 'passed' && verifiedByState.get(s.phaseStateId) === true))
        ? enrollment.completedAt : null,
      phasesPassed: phases.filter((phase) => phase.status === 'passed').length,
      // "n of m phases passed" counts the pinned version's phases (`phasesToCount`)
      totalPhases: phasesToCount(enrollment, project, phases),
      averageScore: scored.length
        ? Math.round(
            scored.reduce((sum, score) => sum + score, 0) / scored.length,
          )
        : null,
      phases,
      releases: releases.map((release) => releaseView(release)),
      // The same rows also become `docs/journal.md` in the
      // repository export, so the builder lives in `journal.ts`.
      journal: await buildDossierJournal(
        manager,
        states.map((state) => {
          const evidence = evidenceByState.get(state.id);
          return Object.assign(new PhaseStateEntity(), state, {
            workspace: evidence ? (snapshots.get(evidence.id) ?? null) : null,
          });
        }),
        phases,
        releases,
        { submittedOnly: true },
      ),
      generatedAt: new Date().toISOString(),
    };

    this.logger.log({
      event: 'instructor.dossier',
      actorId: caller.id,
      learnerId: learner.id,
      projectSlug: enrollment.projectSlug,
    });
    await recordAudit(manager, {
      event: 'dossier.read',
      actorUserId: caller.id,
      subjectUserId: learner.id,
      targetId: enrollment.projectSlug,
      action: 'read',
      detail: { displayName: learner.displayName, phases: phases.length },
    });
    return dossier;
  }

}
