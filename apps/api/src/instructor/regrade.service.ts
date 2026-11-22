import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  RUNNER_UNAVAILABLE_MESSAGE,
  type PhaseKey,
  type RegradeBatchStatus,
  type RegradeBatchView,
  type RegradeCandidate,
  type RegradeScope,
  type RegradeSkip,
} from '@learnsdlc/shared';
import { newestSubmissionsPerTask } from '../analytics/newest-per-task';
import { ContentService } from '../content/content.service';
import { olderFormatRoomSentence } from '../content/phase-grading';
import type { CompiledTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { atomic } from '../db/atomic';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  RegradeBatchEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { phaseRollup, taskRollup } from '../feedback/checkers';
import {
  FeedbackService,
  RunnerUnavailableError,
  verdictIsOfAnotherRun,
} from '../feedback/feedback.service';
import { submissionId } from '../feedback/submission-id';
import { taskForRevision } from '../feedback/task-resolution';
import { JobPayload } from '../jobs/job-queue';
import { JobsService } from '../jobs/jobs.service';
import { recordAudit } from '../audit/audit';
import { InstructorCaller, UNATTACHED_COHORT, learnerScope, scopedLearner } from './cohort-scope';
import { OVERRIDE_REASON_MIN } from '@learnsdlc/shared';
import { RegradeStartDto } from './instructor.dto';
import { UUID_PATTERN } from '../db/uuid';
import { isoOrEmpty } from '../db/timestamps';
import { heldEnrollment } from '../db/enrollment-lock';
import { isUniqueViolation } from '../db/unique-violation';

/**
 * The cohort key an admin's batch is filed under. Admin scope is every learner
 * in the deployment rather than a class, and the sentinel is what puts two
 * admin batches into the same slot of `UQ_regrade_batch_running`; one at a
 * time there too. Cohort ids are uuids, so no real class can collide with it.
 */
export const ALL_COHORTS = '*';

/**
 * The sentences a learner's instructor reads next to a name the batch left out.
 *
 * A learner whose pinned version holds the phase in an older form is skipped
 * too, at plan time, and a job that meets one anyway fails closed; that reason
 * is the room's own sentence for the phase (`olderFormatRoomSentence`), so it
 * has no constant here.
 */
export const SKIP_REASONS = {
  noSubmission: 'No submission in this phase yet.',
  inFlight: 'A submission is still being graded.',
  pruned: "Their newest revision lacks its original source or execution context, so it cannot be re-run safely.",
  current: 'Already graded on the pack that is on disk.',
  // The version a learner is pinned to decides which tasks their
  // phase holds, and it can move under a revision; a republish between the
  // preview and the job, or an appeal of work handed in against a version that
  // has since been re-cut. The batch says so rather than picking a task, for
  // the same reason the phase-level routes refuse rather than picking one:
  // grading a revision against the wrong task's rules is how a learner's work
  // goes to the wrong grader.
  unknownTask:
    'Their revision was graded as a task the version of this phase they hold no longer declares.',
  // A Requirements revision handed in under a 2.x version holds the markdown
  // story and no record, so the story checks would grade an empty story.
  storySnapshot2x: '2.x snapshot, not regraded: this revision holds the older markdown story, which the story checks cannot read.',
} as const;

/** The 2.x story file, looked for in a snapshot by its name only. */
const LEGACY_STORY_FILE = 'requirements/my-story.md';

/**
 * A candidate, with the task it is about.
 *
 * `RegradeCandidate` in the shared contract carries the two keys as **optional**
 * members, because an older preview has neither; this service always answers
 * both, and the extension is what says so in the type rather than in a
 * comment. A candidate is a **(learner, task)** pair: a written
 * phase may hold more than one task, each with its own newest revision and its
 * own half of the phase's gate. On a phase whose compiled list is the
 * synthesised sole task the pair is the learner and `SOLE_TASK_KEY`, so the
 * list is row for row and in order the list this service built before the task
 * grain.
 */
export interface TaskRegradeCandidate extends RegradeCandidate {
  /** The compiled task's key as the learner's **pinned** version declares it. */
  taskKey: string;
  /** That task's title, so the panel can name it without a second read. */
  taskTitle: string;
}

/** True for the throw `FeedbackService` raises when the sandbox was never reached. */
function isRunnerDown(err: unknown): boolean {
  return err instanceof RunnerUnavailableError;
}

/** What the regrade's trail says of a revision of a run a reset has ended. */
export const EARLIER_RUN_NOTE = 'of an earlier run, moved no gate';

/**
 * Re-grade a phase across a class after a content fix.
 *
 * The shape of the whole feature is in one sentence: **a regrade is a new
 * revision, never an edit of an old one**. An instructor who fixes a hidden
 * test that was wrong owes the class a new verdict, and owes an appeal six
 * weeks later the old one, so the submission the batch re-runs is untouched,
 * and its files, graded against the pack as it is on disk today, become a
 * second submission that points back at it (`regradeOf`).
 *
 * Three invariants hold whatever the new score is, and they are the reason
 * this can be run on a whole class without anybody's consent:
 *
 *  - a score never goes down (`Math.max` on `bestScore`);
 *  - a pass is never withdrawn (`nextPhaseStatus` refuses to un-pass, and this
 *    service does not work around it; an instructor who genuinely has to
 *    withdraw one uses the `reopen` override, which records a reason);
 *  - `attempts` never moves, because a regrade is not an attempt and must not
 *    push the reliance index's denominator around.
 *
 * The batch is one job per learner rather than one job for the class, so a
 * single learner's failure does not take the batch down, and the whole thing
 * is bounded for free by the run gate and `RUNNER_SLOTS` that already bound
 * ordinary submissions.
 */

@Injectable()
export class RegradeService implements OnModuleInit {
  private readonly logger = new Logger(RegradeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
    private readonly feedback: FeedbackService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('regrade', (payload) => this.processRegrade(payload));
  }

  /* ------------------------------- dry run ------------------------------ */

  /**
   * What a regrade would do. It writes nothing at all, not even an audit row,
   * because a question an instructor asked and did not act on is not an event
   * that happened to a learner.
   */
  async preview(caller: InstructorCaller, dto: RegradeStartDto): Promise<RegradeBatchView> {
    const manager = this.dataSource.manager;
    const plan = await this.plan(manager, caller, dto);
    return {
      id: '',
      status: 'running',
      projectSlug: plan.projectSlug,
      phaseKey: dto.phaseKey,
      scope: dto.scope,
      reason: dto.reason.trim(),
      packVersionTo: plan.packVersionTo,
      requested: plan.candidates.length,
      done: 0,
      failed: 0,
      newPasses: 0,
      skipped: plan.skipped,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      candidates: plan.candidates,
    };
  }

  /* -------------------------------- start ------------------------------- */

  async start(caller: InstructorCaller, dto: RegradeStartDto): Promise<RegradeBatchView> {
    const reason = dto.reason.trim();
    if (reason.length < OVERRIDE_REASON_MIN) {
      throw new BadRequestException(`give a reason of at least ${OVERRIDE_REASON_MIN} characters`);
    }
    const manager = this.dataSource.manager;
    const plan = await this.plan(manager, caller, dto);
    const phase = this.content.getPhase(plan.projectSlug, dto.phaseKey);
    if (!plan.candidates.length) {
      throw new BadRequestException(
        `nobody in this class has a submission in ${phase.title} that can be re-run`,
      );
    }

    const cohort = caller.role === 'ADMIN' ? ALL_COHORTS : caller.cohort;
    let batch: RegradeBatchEntity;
    try {
      batch = await manager.save(
        manager.create(RegradeBatchEntity, {
          actorUserId: caller.id,
          cohort,
          projectSlug: plan.projectSlug,
          phaseKey: dto.phaseKey,
          packVersionTo: plan.packVersionTo,
          scope: dto.scope,
          reason,
          status: 'running',
          requested: plan.candidates.length,
          done: 0,
          failed: 0,
          newPasses: 0,
          skipped: plan.skipped,
        }),
      );
    } catch (err) {
      // `UQ_regrade_batch_running` is a partial unique index on
      // (cohort, status), so the database decides the race between two
      // instructors pressing Regrade a second apart rather than a read the
      // second one would also pass.
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictException(await this.runningBatchMessage(manager, cohort));
    }

    // The revisions first, then the real total, then the jobs: no job can run
    // before `requested` is the number of rows that actually exist, so the
    // "done + failed === requested" test that finishes the batch cannot be
    // read against a total that is still moving.
    const enqueued: string[] = [];
    const lost: RegradeSkip[] = [];
    // Each regrade row copies its parent's `resetEpoch`, so "newest of the
    // current run" reads stay honest and the row describes itself. The strict
    // gate reads THIS row's epoch, so a copy
    // taken here from a NULL parent that a reset then stamps is corrected by
    // the job (`processRegrade`), which re-reads the parent.
    const parentEpochs = new Map<string, number | null>();
    const parentIds = plan.candidates.map((candidate) => candidate.submissionId);
    for (let from = 0; from < parentIds.length; from += 500) {
      for (const parent of await manager.find(SubmissionEntity, {
        select: ['id', 'resetEpoch'],
        where: { id: In(parentIds.slice(from, from + 500)) },
      })) {
        parentEpochs.set(parent.id, parent.resetEpoch ?? null);
      }
    }
    for (const candidate of plan.candidates) {
      try {
        const row = await manager.save(
          manager.create(SubmissionEntity, {
            // Time-ordered, like a learner's own submission: a batch writes one
            // row per phase state, and the row it writes must be the last one.
            id: submissionId(),
            phaseStateId: candidate.phaseStateId,
            userId: candidate.userId,
            // The task the revision being re-run is about. Without it the row
            // would take the column's `''` default, `UQ_submissions_in_flight`
            // would hold one slot for the whole phase state, and the
            // second task of a split phase would be reported to the instructor
            // as a phase that is already being graded.
            taskKey: candidate.taskKey,
            status: 'queued',
            packVersion: plan.packVersionTo,
            regradeOf: candidate.submissionId,
            regradeBatchId: batch.id,
            resetEpoch: parentEpochs.get(candidate.submissionId) ?? null,
          }),
        );
        enqueued.push(row.id);
      } catch (err) {
        // The learner submitted between the preview and now, and
        // `UQ_submissions_in_flight` is holding the phase's one grading slot.
        // Their own attempt is the newer question; leave it alone.
        if (!isUniqueViolation(err)) throw err;
        lost.push({
          userId: candidate.userId,
          displayName: candidate.displayName,
          reason: SKIP_REASONS.inFlight,
        });
      }
    }

    const skipped = [...plan.skipped, ...lost];
    await manager.update(
      RegradeBatchEntity,
      { id: batch.id },
      { requested: enqueued.length, skipped },
    );
    batch.requested = enqueued.length;
    batch.skipped = skipped;

    this.logger.log({
      event: 'regrade.start',
      actorId: caller.id,
      batchId: batch.id,
      cohort,
      projectSlug: plan.projectSlug,
      phaseKey: dto.phaseKey,
      scope: dto.scope,
      requested: enqueued.length,
      skipped: skipped.length,
      packVersionTo: plan.packVersionTo,
      reason,
    });
    await recordAudit(manager, {
      event: 'regrade.start',
      actorUserId: caller.id,
      subjectUserId: caller.id,
      targetId: batch.id,
      action: dto.scope,
      reason,
      detail: {
        projectSlug: plan.projectSlug,
        phaseKey: dto.phaseKey,
        requested: enqueued.length,
        packVersionTo: plan.packVersionTo,
      },
    });

    if (!enqueued.length) {
      await this.finish(manager, batch.id);
      return this.view(await manager.findOneByOrFail(RegradeBatchEntity, { id: batch.id }));
    }
    for (const id of enqueued) await this.jobs.enqueue('regrade', { id });
    return this.view(batch);
  }

  /* ------------------------------- reading ------------------------------ */

  /**
   * One batch, for the panel's two-second poll. Scoped the way every other
   * instructor read is: the actor's own batch, or one filed under a class the
   * caller can see, and a 404 rather than a 403 for anything else.
   */
  async status(caller: InstructorCaller, batchId: string): Promise<RegradeBatchView> {
    const manager = this.dataSource.manager;
    const batch = UUID_PATTERN.test(batchId)
      ? await manager.findOne(RegradeBatchEntity, { where: { id: batchId } })
      : null;
    const mine =
      batch &&
      (caller.role === 'ADMIN' ||
        batch.actorUserId === caller.id ||
        (batch.cohort !== ALL_COHORTS &&
          batch.cohort !== UNATTACHED_COHORT &&
          batch.cohort === caller.cohort));
    if (!mine) throw new NotFoundException('no regrade with that id');
    return this.view(batch);
  }

  /* ---------------------------- the job handler ------------------------- */

  /**
   * Grade one regraded revision.
   *
   * Registered as the durable 'regrade' handler, so it takes an id and reloads
   * everything: any worker can execute it, including after a restart. The
   * phase state it grades against is a **detached copy** whose workspace is the
   * parent revision's snapshot (the files as they were when the learner
   * submitted, not the files as they are now) and it is never saved, so a
   * learner typing in the phase while their class is regraded loses nothing.
   */
  async processRegrade({ id }: JobPayload): Promise<void> {
    const manager = this.dataSource.manager;
    const submission = await manager.findOne(SubmissionEntity, { where: { id } });
    if (!submission || !submission.regradeBatchId || !submission.regradeOf) {
      this.logger.warn(`regrade ${id} vanished or is not a regrade; nothing to do`);
      return;
    }
    const batch = await manager.findOne(RegradeBatchEntity, {
      where: { id: submission.regradeBatchId },
    });
    if (!batch) {
      await this.failSubmission(manager, id, 'The regrade this belonged to no longer exists.');
      return;
    }
    if (batch.status !== 'running') {
      // The batch stopped (the runner went away under an earlier job) so
      // this one must not write a verdict nobody asked for any more.
      await this.failSubmission(
        manager,
        id,
        'The regrade was stopped before this revision was re-run.',
      );
      return;
    }

    const parent = await manager.findOne(SubmissionEntity, { where: { id: submission.regradeOf } });
    const state = await manager.findOne(PhaseStateEntity, { where: { id: submission.phaseStateId } });
    if (!parent || !state) {
      await this.countFailure(manager, batch.id, id, 'The revision this re-ran no longer exists.');
      return;
    }
    if (!parent.workspaceSnapshot || !parent.contextSnapshot) {
      await this.countFailure(manager, batch.id, id, SKIP_REASONS.pruned);
      return;
    }
    // By name only: whatever the file says is never read.
    if (Object.prototype.hasOwnProperty.call(parent.workspaceSnapshot, LEGACY_STORY_FILE)) {
      await this.countFailure(manager, batch.id, id, SKIP_REASONS.storySnapshot2x);
      return;
    }
    const enrollment = await manager.findOne(EnrollmentEntity, { where: { id: state.enrollmentId } });
    if (!enrollment) {
      await this.countFailure(manager, batch.id, id, 'The enrolment this belonged to no longer exists.');
      return;
    }
    // A regrade re-runs the
    // version the learner submitted against. Reading the head would hold a
    // six-week-old revision to a rubric nobody had written when it was
    // submitted, and then write that verdict back over theirs, which is the
    // one thing an appeal must not be able to do. A null pin answers the head,
    // as every read does.
    const phase = this.content.getPhaseForEnrollment(enrollment, state.phaseKey);
    // The plan skips a learner pinned to a phase in an older form. A job
    // still reaches one when it was planned before the learner's pin moved;
    // it fails closed with the room's own sentence.
    const older = olderFormatRoomSentence(phase);
    if (older) {
      await this.countFailure(manager, batch.id, id, older);
      return;
    }

    // The revision keeps its own copy of the files it was graded on, exactly
    // as an ordinary submission does, so the learner's revision list can show
    // the regraded row against the same bytes the report was computed from.
    await manager.update(
      SubmissionEntity,
      { id },
      {
        status: 'running',
        workspaceSnapshot: parent.workspaceSnapshot,
        contextSnapshot: parent.contextSnapshot,
        // And the clock it was graded at, so the regraded row
        // reads the same way in the revision log as the one it re-ran.
        runClock: parent.runClock ?? null,
        // The parent's epoch as it stands now.
        // A reset that committed between `start`'s read and this row's insert
        // stamped the parent and not this row (it did not exist yet), and the
        // strict gate reads this row's epoch. A stamped epoch never changes,
        // so only a non-NULL one is copied: a NULL parent leaves the row's
        // own epoch alone, which a later reset stamps with the parent's.
        ...(parent.resetEpoch !== null && parent.resetEpoch !== undefined
          ? { resetEpoch: parent.resetEpoch }
          : {}),
      },
    );

    // Detached, and never saved: `manager.create` builds an entity that is not
    // attached to anything, and nothing below calls save() on it.
    const graded = manager.create(PhaseStateEntity, {
      ...state,
      workspace: parent.workspaceSnapshot,
      ...(parent.contextSnapshot ?? {}),
      acceptedScreenCopy: parent.contextSnapshot.acceptedScreenCopy ?? null,
      // Grade at the clock this revision asked
      // its question at, not at whatever the learner has pinned today. A
      // matrix regraded six weeks later must answer the same question as the
      // one being appealed; `packVersion` already works this way.
      runClock: parent.runClock ?? null,
    });

    // A regrade re-runs the revision against the task it was
    // submitted as, resolved through the same pin the phase came from. The
    // resolution sits **before** the try, so a key the pinned version no longer
    // declares is the named refusal below rather than the generic one the
    // catch gives a grader that blew up; a batch's instructor can act on the
    // first and cannot on the second.
    const tasks = this.content.getTasksForEnrollment(enrollment, state.phaseKey);
    const task = taskForRevision(tasks, parent.taskKey);
    if (!task) {
      await this.countFailure(manager, batch.id, id, SKIP_REASONS.unknownTask);
      return;
    }

    let report;
    try {
      // `parent.id` and not `id`: the revision being re-run, which is the one
      // whose evidence this verdict must be about. It matters for a quiz,
      // whose sheet is a row of its own rather than a file in the snapshot;
      // without it the grader would read *the newest sheet on this task*, and
      // a learner who handed one in between the plan and this job would have
      // their newer paper's score written onto the revision under appeal.
      report = await this.feedback.gradeSnapshot(phase, graded, tasks, task, parent.id);
    } catch (err) {
      if (isRunnerDown(err)) {
        // A class-sized batch against a runner that is not there would write
        // twenty-three useless failures into twenty-three learners' records.
        // Stop at the first one instead, change nothing about any phase, and
        // let the instructor try again when the runner is back.
        await manager.update(
          RegradeBatchEntity,
          { id: batch.id, status: 'running' },
          { status: 'stopped', finishedAt: new Date().toISOString() },
        );
        await this.failSubmission(manager, id, RUNNER_UNAVAILABLE_MESSAGE);
        this.logger.error(
          `regrade batch ${batch.id} stopped: the code runner could not be reached, so nothing was changed`,
        );
        return;
      }
      await this.countFailure(
        manager,
        batch.id,
        id,
        'This revision could not be re-graded. The old verdict is unchanged.',
      );
      return;
    }

    const passed = report.passed;
    await manager.update(
      SubmissionEntity,
      { id },
      { status: 'completed', score: report.overall, passed, report },
    );

    // The regrade is one of the five writers of a phase's status, and all
    // five go through the one roll-up under the one lock. Only the
    // read-then-write of the two state rows moves inside the transaction: the
    // verdict written above is a fact whatever the roll-up then decides, and
    // the audit row and the three counters below are appends that must not be
    // replayed if this block is retried.
    //
    // Patches, never save(): the learner may be typing in this phase right now,
    // and save() would post this job's copy of `workspace` back over the
    // autosave that landed in between. `attempts` is deliberately absent from
    // both patches; a regrade is not an attempt, on the phase's row or on the
    // task's.
    const now = new Date().toISOString();
    const verdict = { passed, overall: report.overall };
    const { before, roll, earlierRun } = await atomic(this.dataSource, async (tx) => {
      // `advance`'s idiom, and on the row `advance` takes it on: the enrolment.
      // It is the row every writer of a phase's status can reach from, and a
      // lock on the phase state would not serialise this against `advance`'s
      // read of the whole board. Postgres only, as everywhere else; sqlite has
      // one connection and `atomic` is what serialises there.
      await heldEnrollment(tx, { id: enrollment.id, userId: state.userId });
      const current = await tx.findOneByOrFail(PhaseStateEntity, { id: state.id });
      // A sole task has no row, so a sole-task phase issues no task query
      // at all and the roll-up takes `nextPhaseStatus`' own arm over it.
      const held = soleTaskList(tasks)
        ? []
        : await tx.find(TaskStateEntity, { where: { phaseStateId: state.id } });
      const mine = held.find((row) => row.taskKey === task.taskKey);
      // A regraded verdict for a paper of a run that has
      // ended is history and nothing else. The appeal is already stored (the
      // `update` that wrote `status`, `score`, `passed` and `report` on this
      // revision ran above) and what it must not do is move a gate: the row
      // below belongs to the run a teacher's audited reset started, and
      // neither its status nor the `bestScore` that reset nulled is a verdict
      // about a paper of the closed run's to write. `parent.id` and not `id`,
      // for the same reason the grade above reads it: the paper is the
      // revision under appeal's, not this regrade's. One predicate with
      // `writeVerdict`, read under the same enrolment lock, inside the same
      // transaction as the two rows it is about.
      if (await verdictIsOfAnotherRun(tx, task, mine, parent.id)) {
        this.logger.warn(
          `regrade ${id} re-ran revision ${parent.id}, which is of a run of task "${task.taskKey}" that a reset has ended on phase state ${state.id} (its paper's attempt epoch, or its own reset epoch); the verdict is kept on the revision and moves no gate`,
        );
        // The roll-up as it stands, so `before === roll.status` and the batch
        // counts no pass it did not open.
        return {
          before: current.status,
          roll: {
            status: current.status,
            passedAt: current.passedAt,
            bestScore: current.bestScore,
          },
          earlierRun: true,
        };
      }
      if (mine) {
        const patch = taskRollup(mine, task, verdict, now);
        await tx.update(TaskStateEntity, { id: mine.id }, patch);
        // so the roll-up below quantifies over the board this job just moved
        Object.assign(mine, patch);
      }
      // A required key with no row is a key that has not passed, and a regrade
      // does not write one: the three row creators are the board's, and a phase
      // whose rows are missing reads shut until a repair puts them back.
      const rolled = phaseRollup(current, tasks, held, verdict, now);
      await tx.update(
        PhaseStateEntity,
        { id: state.id },
        { bestScore: rolled.bestScore, status: rolled.status, passedAt: rolled.passedAt },
      );
      return { before: current.status, roll: rolled, earlierRun: false };
    });

    await recordAudit(manager, {
      event: 'phase.regrade',
      actorUserId: batch.actorUserId,
      subjectUserId: state.userId,
      targetId: state.id,
      reason: batch.reason,
      detail: {
        batchId: batch.id,
        submissionId: id,
        projectSlug: enrollment.projectSlug,
        phaseKey: state.phaseKey,
        from: parent.score,
        to: report.overall,
        packVersionFrom: parent.packVersion,
        packVersionTo: batch.packVersionTo,
        passedBefore: parent.passed,
        passedAfter: passed,
        // A revision of a run a reset has ended (the
        // teacher's or the learner's own) keeps its new verdict and moves no
        // gate, and the trail says so, so a teacher is not surprised that a
        // regrade after a reset changed nothing.
        ...(earlierRun ? { run: EARLIER_RUN_NOTE } : {}),
      },
    });

    // In SQL, never in JavaScript: the counter was read when this job started
    // and three of these run at a time, so two that overlap would write the
    // same number back and a batch would never reach its total.
    await manager.increment(RegradeBatchEntity, { id: batch.id }, 'done', 1);
    // Still "the regrade that closed the phase", which is what this counter has
    // always meant: with the roll-up it is the last required task's verdict
    // that moves the phase, so a batch that opened three phases reports three.
    if (roll.status === 'passed' && before !== 'passed') {
      await manager.increment(RegradeBatchEntity, { id: batch.id }, 'newPasses', 1);
    }
    await this.finishIfComplete(manager, batch.id);
  }

  /* ------------------------------ internals ----------------------------- */

  /**
   * Who the batch would cover, and who it would leave out.
   *
   * Everything here goes through the same three helpers the rest of the
   * console does (`learnerScope` for who the caller may see,
   * `newestSubmissionsPerTask` for the latest attempt, and the content service
   * for the pack) so a regrade cannot disagree with the class page about
   * either.
   *
   * A candidate is a **(learner, task)** pair, and
   * the latest attempt is the newest revision of *that task* rather than the
   * newest revision on the phase state. The sibling
   * `newestSubmissionsPerPhaseState` answers *last activity on this phase*,
   * which is still the right question for the console's idle window and the
   * CSV's activity column and the wrong one here: on a split phase it would
   * name whichever task the learner touched last and re-run that one twice.
   * On a board of sole-task phases every revision carries the one key, so the
   * two groupings agree row for row.
   */
  private async plan(
    manager: EntityManager,
    caller: InstructorCaller,
    dto: RegradeStartDto,
  ): Promise<{
    projectSlug: string;
    packVersionTo: string | null;
    candidates: TaskRegradeCandidate[];
    skipped: RegradeSkip[];
  }> {
    const project = this.content.getProject(dto.projectSlug);
    // Throws a 404 for a phase the pack does not declare, before anything is
    // read: a regrade of a phase that no longer exists is a typo, not a batch.
    this.content.getPhase(project.slug, dto.phaseKey);

    // One learner goes through `scopedLearner`, the same door every other
    // instructor read uses: it shape-checks the id before the query, because
    // Postgres raises on a malformed uuid and that surfaces as a 500 where a
    // 404 is the truth. The whole class goes through the scope directly.
    const learners: Pick<UserEntity, 'id' | 'displayName' | 'email'>[] = dto.userId
      ? [await scopedLearner(manager, caller, dto.userId)]
      : await manager.find(UserEntity, {
          where: await learnerScope(manager, caller),
          select: ['id', 'displayName', 'email'],
          order: { email: 'ASC' },
        });
    if (!learners.length) {
      return { projectSlug: project.slug, packVersionTo: project.version, candidates: [], skipped: [] };
    }

    const byUser = new Map(learners.map((learner) => [learner.id, learner]));
    const enrollments = await manager.find(EnrollmentEntity, {
      where: { userId: In([...byUser.keys()]), projectSlug: project.slug },
    });
    const states = enrollments.length
      ? await manager.find(PhaseStateEntity, {
          where: { enrollmentId: In(enrollments.map((e) => e.id)), phaseKey: dto.phaseKey },
        })
      : [];

    const byEnrollment = new Map(enrollments.map((row) => [row.id, row]));
    const newest = await newestSubmissionsPerTask(
      manager,
      states.map((state) => state.id),
    );
    const newestByTask = new Map(
      newest.map((row) => [`${row.phaseStateId}:${row.taskKey}`, String(row.id)]),
    );
    const rows = newest.length ? await this.newestRows(manager, [...newestByTask.values()]) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const attempts = await this.attemptNumbers(manager, states.map((state) => state.id));

    const candidates: TaskRegradeCandidate[] = [];
    const skipped: RegradeSkip[] = [];
    // In the order the learners came back, which is by email, then in task
    // order within each learner, so the panel's list and the export read the
    // same way.
    for (const learner of learners) {
      const state = states.find((row) => row.userId === learner.id);
      const skip = (reason: string) =>
        skipped.push({ userId: learner.id, displayName: learner.displayName, reason });
      if (!state) {
        skip(SKIP_REASONS.noSubmission);
        continue;
      }
      const tasks = this.tasksFor(byEnrollment.get(state.enrollmentId), dto.phaseKey);
      if (!tasks.length) {
        skip(SKIP_REASONS.unknownTask);
        continue;
      }
      // A phase the learner's pinned version holds in an older form has
      // nothing left to grade it: a skip with the room's own sentence, so the
      // instructor reads why and no job is queued to fail.
      const older = this.olderFormatFor(byEnrollment.get(state.enrollmentId), dto.phaseKey);
      if (older) {
        skip(older);
        continue;
      }
      for (const task of tasks) {
        const submissionId = newestByTask.get(`${state.id}:${task.taskKey}`);
        const row = submissionId ? byId.get(submissionId) : undefined;
        if (!row) {
          skip(SKIP_REASONS.noSubmission);
          continue;
        }
        if (row.status === 'queued' || row.status === 'running') {
          skip(SKIP_REASONS.inFlight);
          continue;
        }
        if (!row.hasSnapshot) {
          skip(SKIP_REASONS.pruned);
          continue;
        }
        if (row.legacyStory) {
          skip(SKIP_REASONS.storySnapshot2x);
          continue;
        }
        // `stale-pack` leaves out the learners whose verdict already came from
        // the pack on disk; silently, because they are not a problem, they are
        // simply not in the question. A null version is "before packs carried
        // one", which is never treated as a version and so is always stale.
        if (dto.scope === 'stale-pack' && row.packVersion && row.packVersion === project.version) {
          continue;
        }
        candidates.push({
          userId: learner.id,
          displayName: learner.displayName,
          phaseStateId: state.id,
          taskKey: task.taskKey,
          taskTitle: task.title,
          submissionId: row.id,
          // The revision number in the learner's own list for the whole phase:
          // `phase_states.attempts` beside it on the panel is a sum over the
          // phase's tasks (a declared looseness of split phases), and two
          // numbers on one panel have to mean one thing.
          attempt: attempts.get(row.id) ?? 1,
          score: row.score,
          passed: row.passed,
          packVersion: row.packVersion,
        });
      }
    }
    return { projectSlug: project.slug, packVersionTo: project.version, candidates, skipped };
  }

  /** The room's sentence for this learner's pinned phase when it is in an older form (`olderFormatRoomSentence`), else null. */
  private olderFormatFor(enrollment: EnrollmentEntity | undefined, key: string): string | null {
    if (!enrollment) return null;
    try {
      return olderFormatRoomSentence(this.content.getPhaseForEnrollment(enrollment, key));
    } catch {
      // a version with no such phase is `tasksFor`'s named skip, never this one
      return null;
    }
  }

  /**
   * The tasks of one phase **of the version this learner is pinned to**, in
   * task order, or the empty list where there are none to name.
   *
   * The pin and never the head: two learners in one class can hold two versions
   * of one project, and `getTasks(slug, key)` is the instructor console's
   * accessor for the head rather than a learner's. A version that declares no
   * such phase, or one this build has no statement for, is one learner the
   * regrade cannot reach rather than a batch that 500s for the whole class, so
   * it reads as a named skip and the other twenty-four are still planned.
   */
  private tasksFor(enrollment: EnrollmentEntity | undefined, key: string): CompiledTask[] {
    if (!enrollment) return [];
    try {
      return [...this.content.getTasksForEnrollment(enrollment, key)].sort(
        (a, b) => a.order - b.order,
      );
    } catch {
      return [];
    }
  }

  /**
   * The newest rows, without their files.
   *
   * `workspaceSnapshot` is a copy of every editable file the learner had, and
   * the only question the plan asks of it is whether it is still there; the
   * retention sweep nulls it on old revisions. Asking the
   * database that question rather than loading the column keeps a preview of a
   * class of twenty-five to kilobytes instead of tens of megabytes.
   */
  private async newestRows(
    manager: EntityManager,
    ids: string[],
  ): Promise<
    {
      id: string;
      status: string;
      score: number | null;
      passed: boolean | null;
      packVersion: string | null;
      hasSnapshot: boolean;
      legacyStory: boolean;
    }[]
  > {
    const raw = await manager
      .createQueryBuilder(SubmissionEntity, 's')
      .select('s.id', 'id')
      .addSelect('s.status', 'status')
      .addSelect('s.score', 'score')
      .addSelect('s.passed', 'passed')
      .addSelect('s.packVersion', 'packVersion')
      .addSelect('CASE WHEN s.workspaceSnapshot IS NULL OR s.contextSnapshot IS NULL THEN 0 ELSE 1 END', 'hasSnapshot')
      // The 2.x story file's name as a JSON key, matched in the stored text;
      // the snapshot itself is never loaded here.
      .addSelect('CASE WHEN s.workspaceSnapshot LIKE :legacyKey THEN 1 ELSE 0 END', 'legacyStory')
      .setParameter('legacyKey', `%${JSON.stringify(LEGACY_STORY_FILE)}:%`)
      .where('s.id IN (:...ids)', { ids })
      .getRawMany<{
        id: string;
        status: string;
        score: number | null;
        passed: boolean | number | null;
        packVersion: string | null;
        hasSnapshot: number | boolean;
        legacyStory: number | boolean;
      }>();
    return raw.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      score: row.score === null ? null : Number(row.score),
      passed: row.passed === null ? null : Boolean(row.passed),
      packVersion: row.packVersion,
      hasSnapshot: Boolean(Number(row.hasSnapshot)),
      legacyStory: Boolean(Number(row.legacyStory)),
    }));
  }

  /**
   * Which revision each submission is, 1-based, in the order the learner's own
   * list presents them. Ids only; the same read `FeedbackService.attemptNumber`
   * makes, done once for the whole class rather than once per learner.
   */
  private async attemptNumbers(
    manager: EntityManager,
    phaseStateIds: string[],
  ): Promise<Map<string, number>> {
    const numbers = new Map<string, number>();
    if (!phaseStateIds.length) return numbers;
    const ordered = await manager.find(SubmissionEntity, {
      where: { phaseStateId: In(phaseStateIds) },
      order: { createdAt: 'ASC', id: 'ASC' },
      select: { id: true, phaseStateId: true },
    });
    const seen = new Map<string, number>();
    for (const row of ordered) {
      const place = (seen.get(row.phaseStateId) ?? 0) + 1;
      seen.set(row.phaseStateId, place);
      numbers.set(row.id, place);
    }
    return numbers;
  }

  /** The sentence a second instructor gets, naming the person to wait for. */
  private async runningBatchMessage(manager: EntityManager, cohort: string): Promise<string> {
    const running = await manager.findOne(RegradeBatchEntity, {
      where: { cohort, status: 'running' },
    });
    const actor = running
      ? await manager.findOne(UserEntity, {
          where: { id: running.actorUserId },
          select: ['id', 'displayName'],
        })
      : null;
    const who = actor?.displayName ?? 'somebody else';
    return `A regrade started by ${who} is still running. Wait for it to finish.`;
  }

  private async failSubmission(
    manager: EntityManager,
    id: string,
    error: string,
  ): Promise<void> {
    await manager.update(
      SubmissionEntity,
      { id, status: In(['queued', 'running']) },
      { status: 'failed', error },
    );
  }

  /** A revision that could not be re-run: the old verdict stands, and the batch counts it. */
  private async countFailure(
    manager: EntityManager,
    batchId: string,
    submissionId: string,
    error: string,
  ): Promise<void> {
    await this.failSubmission(manager, submissionId, error);
    await manager.increment(RegradeBatchEntity, { id: batchId }, 'failed', 1);
    await this.finishIfComplete(manager, batchId);
  }

  private async finishIfComplete(manager: EntityManager, batchId: string): Promise<void> {
    const batch = await manager.findOne(RegradeBatchEntity, { where: { id: batchId } });
    if (!batch || batch.status !== 'running') return;
    if (batch.done + batch.failed < batch.requested) return;
    await this.finish(manager, batchId);
  }

  /**
   * Scoped to a batch that is still running, so the last two jobs finishing
   * together write the finish once rather than twice, and so a batch stopped
   * by a runner outage is never quietly marked finished behind it.
   */
  private async finish(manager: EntityManager, batchId: string): Promise<void> {
    await manager.update(
      RegradeBatchEntity,
      { id: batchId, status: 'running' },
      { status: 'finished', finishedAt: new Date().toISOString() },
    );
  }

  private view(batch: RegradeBatchEntity): RegradeBatchView {
    return {
      id: batch.id,
      status: batch.status as RegradeBatchStatus,
      projectSlug: batch.projectSlug,
      phaseKey: batch.phaseKey as PhaseKey,
      scope: batch.scope as RegradeScope,
      reason: batch.reason,
      packVersionTo: batch.packVersionTo,
      requested: batch.requested,
      done: batch.done,
      failed: batch.failed,
      newPasses: batch.newPasses,
      skipped: batch.skipped ?? [],
      createdAt: isoOrEmpty(batch.createdAt),
      finishedAt: batch.finishedAt,
    };
  }
}
