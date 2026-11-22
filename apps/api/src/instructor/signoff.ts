import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { ASSIGNMENT_REASON_MIN, PHASE_ORDER, TASK_KEY_MAX_LENGTH } from '@learnsdlc/shared';
import type {
  BulkSignoffBody,
  BulkSignoffResult,
  PhaseKey,
  SignoffQueueRow,
  SignoffQueueView,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { CompiledTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { atomic, rowLock } from '../db/atomic';
import {
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { phaseRollup } from '../feedback/checkers';
import { recordAudit } from '../audit/audit';
import { UNATTACHED_COHORT, type InstructorCaller } from './cohort-scope';
import { isUuid, UUID_PATTERN } from '../db/uuid';
import { heldEnrollment } from '../db/enrollment-lock';
import { REASON_MAX_LENGTH } from './instructor.dto';

/**
 * The class's sign-off queue, and the bulk sign-off beside it.
 *
 * A `signOff` task is passed by a teacher's countersignature and by nothing
 * else: a passing verdict leaves it `awaitingSignOff` (`taskRollup`), a
 * teacher's phase Pass leaves it alone (`countersignatureNote`), and the
 * strict gate wants `signedOffBy` on its row. The per-learner `task-signoff`
 * lever (`InstructorService.overridePhase`) writes it one learner at a time;
 * this file writes the same countersignature for a whole class at once, and
 * leaves the per-learner lever as it is.
 *
 * **What one batch is.** One class, one task (phase key and task key), one
 * reason, many learners. Each learner is countersigned in **their own
 * transaction**, under **their own enrolment lock** (the lock every roll-up
 * writer takes (`writeVerdict`, the regrade, `advance`, the override)) and the
 * learners are taken in **sorted enrolment order**, so a batch never holds two
 * learners' locks at once and two batches meet each learner in the same
 * order. A learner the batch cannot sign is reported by one sentence and left
 * exactly as they were; the learners either side of them are signed.
 *
 * **What each learner's transaction writes** is what `task-signoff` writes, to
 * the column: the task row `passed`, its score floored at the task's own pass
 * mark, `awaitingSignOff` cleared, `signedOffBy`/`signedOffAt` set; then the
 * phase's roll-up over the pinned version's required keys, so the phase opens
 * exactly when the countersignature was the last thing it was waiting for, and
 * never a second time (`phaseRollup` keeps a committed `passedAt`). And one
 * audit row, `class.bulk-signoff`, per learner, carrying the batch's reason.
 *
 * **What it refuses, per learner**, and this is narrower than the per-learner
 * lever, on purpose: only a task the pinned version marks `signOff`, whose
 * row is `awaitingSignOff` (the evidence is in) and not yet `passed`. The
 * queue lists exactly those rows, so a batch built from the queue signs what
 * the teacher saw and nothing they did not.
 */

/**
 * The pass date a countersignature writes. A date held from before the
 * learner's last retry (`resetAt` at or after it) is the earlier pass, which
 * the retry keeps: this pass takes its own date, as `taskRollup` gives any
 * other task's new pass. Otherwise a held date is kept, as it always was.
 */
export function signOffPassedAt(row: { passedAt: string | null; resetAt: string | null }, now: string): string {
  return row.resetAt && row.passedAt && row.passedAt <= row.resetAt ? now : (row.passedAt ?? now);
}

/** The most learners one batch may name: a large class, not a deployment. */
export const SIGNOFF_BATCH_MAX = 200;

/** What a learner the batch did not sign is told, one sentence each, no id or byte in it. */
export const SIGNOFF_REFUSALS = {
  notInClass: 'This learner is not in this class, so nothing was signed for them.',
  notAwaiting: (task: string) =>
    `${task} is not awaiting a countersignature for this learner, so nothing was signed.`,
  alreadyPassed: (task: string) => `${task} has already passed for this learner.`,
  notSignOff: (task: string) =>
    `${task} does not need a countersignature; use this learner's own page for any other lever.`,
  marking: (task: string) =>
    `A newer revision of ${task} is still being marked for this learner, so nothing was signed; try again once its verdict is in.`,
  ambiguous:
    'This learner has more than one project awaiting that task, so nothing was signed; sign it off on their own page.',
  unreadable:
    "This learner's project could not be read, so nothing was signed for them; try their own page.",
} as const;

/** The batch, as the route takes it. `reason`'s length is the service's to judge, after trimming. */
export class BulkSignoffDto implements BulkSignoffBody {
  @IsIn(PHASE_ORDER)
  phaseKey!: PhaseKey;

  @IsString()
  @MinLength(1)
  @MaxLength(TASK_KEY_MAX_LENGTH)
  taskKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SIGNOFF_BATCH_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds!: string[];

  @IsString()
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

/** A refusal of one learner, raised inside their transaction so it rolls back whole. */
class LearnerRefused extends Error {
  constructor(readonly sentence: string) {
    super(sentence);
  }
}

/** The learner a batch will try, and the enrolment whose lock it will take. */
interface Target {
  userId: string;
  enrollment: EnrollmentEntity;
}

@Injectable()
export class SignoffService {
  private readonly logger = new Logger(SignoffService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
  ) {}

  /* --------------------------------- queue -------------------------------- */

  /**
   * The class's tasks awaiting a countersignature, by learner and task: every
   * row of a learner in this class that is `awaitingSignOff`, not `passed`,
   * and whose pinned version still marks the task `signOff`. Oldest first,
   * because the learner who has waited longest is the one to sign first.
   * Writes nothing.
   */
  async queue(caller: InstructorCaller, cohortId: string): Promise<SignoffQueueView> {
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);
    const learners = await manager.find(UserEntity, {
      where: { role: 'LEARNER', cohort: cohortId },
      select: ['id', 'displayName'],
    });
    if (!learners.length) return { cohortId, rows: [] };
    const names = new Map(learners.map((one) => [one.id, one.displayName]));

    const awaited = await manager.find(TaskStateEntity, {
      where: { userId: In([...names.keys()]), awaitingSignOff: true, status: Not('passed') },
    });
    if (!awaited.length) return { cohortId, rows: [] };
    const states = await manager.find(PhaseStateEntity, {
      where: { id: In([...new Set(awaited.map((row) => row.phaseStateId))]) },
    });
    const stateOf = new Map(states.map((state) => [state.id, state]));
    const enrollments = await manager.find(EnrollmentEntity, {
      where: { id: In([...new Set(states.map((state) => state.enrollmentId))]) },
    });
    const enrollmentOf = new Map(enrollments.map((one) => [one.id, one]));

    const since = await this.awaitingSinceOf(manager, awaited);
    const rows: SignoffQueueRow[] = [];
    for (const row of awaited) {
      const state = stateOf.get(row.phaseStateId);
      const enrollment = state && enrollmentOf.get(state.enrollmentId);
      if (!state || !enrollment || state.userId !== row.userId) continue;
      const task = this.tasksOf(enrollment, state.phaseKey)?.find((one) => one.taskKey === row.taskKey);
      // A row the pinned version no longer names as countersigned is not the
      // queue's to offer: the bulk route would refuse it.
      if (!task?.signOff) continue;
      rows.push({
        userId: row.userId,
        learnerName: names.get(row.userId) ?? '',
        phaseKey: state.phaseKey,
        taskKey: row.taskKey,
        taskTitle: task.title,
        awaitingSince: since.get(`${row.phaseStateId}\u0000${row.taskKey}`) ?? isoOf(row.updatedAt),
      });
    }
    rows.sort(
      (a, b) =>
        a.awaitingSince.localeCompare(b.awaitingSince) ||
        a.learnerName.localeCompare(b.learnerName) ||
        a.userId.localeCompare(b.userId) ||
        PHASE_ORDER.indexOf(a.phaseKey) - PHASE_ORDER.indexOf(b.phaseKey) ||
        a.taskKey.localeCompare(b.taskKey),
    );
    return { cohortId, rows };
  }

  /* --------------------------------- bulk --------------------------------- */

  /**
   * Countersign one task for many learners of one class, with one reason.
   * One transaction per learner, in sorted enrolment order; partial results
   * reported. A class not the caller's is a 404 and nothing is read beyond it.
   */
  async bulk(caller: InstructorCaller, cohortId: string, body: BulkSignoffBody): Promise<BulkSignoffResult> {
    const { phaseKey, taskKey, userIds } = this.shaped(body);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < ASSIGNMENT_REASON_MIN) {
      throw new BadRequestException(
        `give a reason of at least ${ASSIGNMENT_REASON_MIN} characters — it is recorded with each learner's sign-off`,
      );
    }
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);

    const refused: BulkSignoffResult['refused'] = [];
    const members = new Set(
      (
        await manager.find(UserEntity, {
          where: { id: In(userIds), role: 'LEARNER', cohort: cohortId },
          select: ['id'],
        })
      ).map((one) => one.id.toLowerCase()),
    );
    const picked = await this.targetsOf(
      manager,
      userIds.filter((userId) => members.has(userId)),
      phaseKey,
      taskKey,
    );
    const targets: Target[] = [];
    for (const userId of userIds) {
      const one = members.has(userId) ? picked.get(userId) : SIGNOFF_REFUSALS.notInClass;
      if (typeof one === 'string' || !one) refused.push({ userId, sentence: one ?? SIGNOFF_REFUSALS.notAwaiting(taskKey) });
      else targets.push({ userId, enrollment: one });
    }
    // Sorted enrolment order: a deterministic order, the same for
    // every batch. Each learner's transaction holds exactly one enrolment lock
    // and commits before the next begins, so it is not what prevents a
    // deadlock; one lock per transaction is. Widening a transaction to
    // several learners would need its own lock-order analysis.
    targets.sort((a, b) => (a.enrollment.id < b.enrollment.id ? -1 : a.enrollment.id > b.enrollment.id ? 1 : 0));

    const signedOff: string[] = [];
    for (const target of targets) {
      try {
        await atomic(this.dataSource, (tx) =>
          this.signOne(tx, caller, cohortId, target, phaseKey, taskKey, reason, userIds.length),
        );
        signedOff.push(target.userId);
      } catch (error) {
        if (error instanceof LearnerRefused) {
          refused.push({ userId: target.userId, sentence: error.sentence });
          continue;
        }
        this.logger.warn(
          `bulk sign-off could not sign learner ${target.userId} on ${phaseKey}/${taskKey}: ${(error as Error)?.message ?? error}`,
        );
        refused.push({ userId: target.userId, sentence: SIGNOFF_REFUSALS.unreadable });
      }
    }

    // Reported in the order the teacher named them, whatever stage refused them.
    const position = new Map(userIds.map((userId, index) => [userId, index]));
    refused.sort((a, b) => (position.get(a.userId) ?? 0) - (position.get(b.userId) ?? 0));

    // A structured line beside the trail, as the per-learner override writes one.
    this.logger.log({
      event: 'class.bulk-signoff',
      actorId: caller.id,
      cohortId,
      phaseKey,
      taskKey,
      signed: signedOff.length,
      refused: refused.length,
      reason,
    });
    return { signedOff, refused };
  }

  /* -------------------------------- helpers ------------------------------- */

  /** The batch's shape, refused whole before anything is read. */
  private shaped(body: BulkSignoffBody): Pick<BulkSignoffBody, 'phaseKey' | 'taskKey' | 'userIds'> {
    const { phaseKey, taskKey, userIds } = body ?? ({} as BulkSignoffBody);
    if (!PHASE_ORDER.includes(phaseKey)) throw new BadRequestException('name one phase of the project');
    if (typeof taskKey !== 'string' || !taskKey.trim() || taskKey.length > TASK_KEY_MAX_LENGTH) {
      throw new BadRequestException('name one task of that phase');
    }
    // Ids are case-folded first: a uuid is the same learner in either case,
    // and the database hands its own back in lower case.
    const ids = Array.isArray(userIds) ? userIds.map((id) => (typeof id === 'string' ? id.toLowerCase() : id)) : [];
    if (
      !Array.isArray(userIds) ||
      ids.length < 1 ||
      ids.length > SIGNOFF_BATCH_MAX ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => isUuid(id))
    ) {
      throw new BadRequestException(
        `name between 1 and ${SIGNOFF_BATCH_MAX} learners of the class, each once`,
      );
    }
    return { phaseKey, taskKey: taskKey.trim(), userIds: ids };
  }

  /**
   * The enrolment each learner's countersignature would land on: the one
   * whose phase holds this task awaiting. More than one is refused rather
   * than guessed at; none is answered from inside the learner's own
   * transaction when an enrolment can be named, so the sentence is the
   * precise one. Three reads for the whole batch, not three per learner;
   * everything is read again under each learner's lock.
   */
  private async targetsOf(
    manager: EntityManager,
    userIds: string[],
    phaseKey: PhaseKey,
    taskKey: string,
  ): Promise<Map<string, EnrollmentEntity | string>> {
    const out = new Map<string, EnrollmentEntity | string>();
    if (!userIds.length) return out;
    const enrollments = await manager.find(EnrollmentEntity, { where: { userId: In(userIds) } });
    const states = enrollments.length
      ? await manager.find(PhaseStateEntity, {
          where: { phaseKey, enrollmentId: In(enrollments.map((one) => one.id)) },
        })
      : [];
    const rows = states.length
      ? await manager.find(TaskStateEntity, { where: { phaseStateId: In(states.map((one) => one.id)), taskKey } })
      : [];
    const enrollmentById = new Map(enrollments.map((one) => [one.id, one]));
    for (const userId of userIds) {
      const mine = enrollments.filter((one) => one.userId.toLowerCase() === userId);
      const myStates = states.filter((state) => mine.some((one) => one.id === state.enrollmentId));
      const stateIds = new Set(myStates.map((state) => state.id));
      const myRows = rows.filter((row) => stateIds.has(row.phaseStateId));
      const awaiting = myRows.filter((row) => row.awaitingSignOff && row.status !== 'passed');
      if (awaiting.length > 1) {
        out.set(userId, SIGNOFF_REFUSALS.ambiguous);
        continue;
      }
      const lead = awaiting[0] ?? (myRows.length === 1 ? myRows[0] : undefined);
      const chosen = lead
        ? myStates.find((state) => state.id === lead.phaseStateId)?.enrollmentId
        : myStates.length === 1
          ? myStates[0].enrollmentId
          : undefined;
      const enrollment = chosen ? enrollmentById.get(chosen) : undefined;
      out.set(userId, enrollment ?? SIGNOFF_REFUSALS.notAwaiting(taskKey));
    }
    return out;
  }

  /**
   * When each awaited row reached awaiting: the first passing revision of
   * that task since its last reset; the verdict `taskRollup` set
   * `awaitingSignOff` on. A row with no such revision (a board written by an
   * import) falls back to the row's own last write.
   */
  private async awaitingSinceOf(
    manager: EntityManager,
    awaited: TaskStateEntity[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const passing = await manager.find(SubmissionEntity, {
      where: {
        phaseStateId: In([...new Set(awaited.map((row) => row.phaseStateId))]),
        status: 'completed',
        passed: true,
      },
      select: ['id', 'phaseStateId', 'taskKey', 'createdAt'],
    });
    for (const row of awaited) {
      const key = `${row.phaseStateId}\u0000${row.taskKey}`;
      const after = row.resetAt ?? '';
      const first = passing
        .filter((one) => one.phaseStateId === row.phaseStateId && one.taskKey === row.taskKey)
        .map((one) => isoOf(one.createdAt))
        .filter((at) => at && at >= after)
        .sort()[0];
      if (first) out.set(key, first);
    }
    return out;
  }

  /**
   * One learner's countersignature, inside their own transaction: the lock,
   * the re-read, the refusals, the row, the roll-up, the audit row. Every
   * refusal throws, so a refused learner's transaction writes nothing.
   */
  private async signOne(
    tx: EntityManager,
    caller: InstructorCaller,
    cohortId: string,
    target: Target,
    phaseKey: PhaseKey,
    taskKey: string,
    reason: string,
    batch: number,
  ): Promise<void> {
    const { userId } = target;
    // Membership first, under a share lock on the learner's row: a class move
    // (`CohortsService.join`/`leave`) takes that row FOR UPDATE, so it either
    // committed before this read (and the learner, no longer in this class,
    // is refused) or waits until this learner's countersignature commits.
    // User row, then enrolment: no writer takes them in the other order.
    const member = await tx.findOne(UserEntity, {
      where: { id: userId, role: 'LEARNER', cohort: cohortId },
      select: ['id'],
      ...rowLock(tx, 'pessimistic_read'),
    });
    if (!member) throw new LearnerRefused(SIGNOFF_REFUSALS.notInClass);
    // The pin is read under the lock, never from the batch's earlier read: a
    // migrate committed in between moves the task list this write quantifies over.
    const enrollment = await this.lockEnrolment(tx, target.enrollment);
    const held = await tx.findOne(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id, userId, phaseKey },
    });
    if (!held) throw new LearnerRefused(SIGNOFF_REFUSALS.notAwaiting(taskKey));

    const tasks = this.content.getTasksForEnrollment(enrollment, phaseKey);
    // A sole-task phase has no task row and is never countersigned by key.
    const task = soleTaskList(tasks) ? undefined : tasks.find((one) => one.taskKey === taskKey);
    if (!task) throw new LearnerRefused(SIGNOFF_REFUSALS.notAwaiting(taskKey));
    if (!task.signOff) throw new LearnerRefused(SIGNOFF_REFUSALS.notSignOff(task.title));

    const rows = await tx.find(TaskStateEntity, { where: { phaseStateId: held.id } });
    const row = rows.find((one) => one.taskKey === taskKey);
    if (!row) throw new LearnerRefused(SIGNOFF_REFUSALS.notAwaiting(task.title));
    if (row.status === 'passed') throw new LearnerRefused(SIGNOFF_REFUSALS.alreadyPassed(task.title));
    if (!row.awaitingSignOff) throw new LearnerRefused(SIGNOFF_REFUSALS.notAwaiting(task.title));
    // A newer revision of this task still queued or running would land its
    // verdict on a countersigned, sticky pass: the batch signs the evidence
    // the queue showed, so it waits for that verdict instead. Asked under the
    // enrolment lock, keyed as `UQ_submissions_in_flight` is.
    const marking = await tx.exists(SubmissionEntity, {
      where: { phaseStateId: held.id, taskKey, status: In(['queued', 'running']) },
    });
    if (marking) throw new LearnerRefused(SIGNOFF_REFUSALS.marking(task.title));

    // `task-signoff`'s own write, to the column (`InstructorService.overridePhase`).
    const now = new Date().toISOString();
    const scored = Math.max(row.bestScore ?? 0, task.rubric.passThreshold);
    const fields: Partial<TaskStateEntity> = {
      status: 'passed',
      passedAt: signOffPassedAt(row, now),
      bestScore: scored,
      awaitingSignOff: false,
      signedOffBy: caller.id,
      signedOffAt: now,
    };
    await tx.update(TaskStateEntity, { id: row.id }, fields);
    Object.assign(row, fields);
    const patch = phaseRollup(
      { status: held.status, passedAt: held.passedAt, bestScore: held.bestScore },
      tasks,
      rows,
      { passed: true, overall: scored },
      now,
    );
    if (Object.keys(patch).length) await tx.update(PhaseStateEntity, { id: held.id }, patch);

    await recordAudit(tx, {
      event: 'class.bulk-signoff',
      actorUserId: caller.id,
      subjectUserId: userId,
      targetId: held.id,
      action: 'task-signoff',
      reason,
      detail: {
        cohortId,
        projectSlug: enrollment.projectSlug,
        phaseKey,
        taskKey: task.taskKey,
        taskTitle: task.title,
        batchSize: batch,
      },
    });
  }

  /**
   * The pessimistic write lock every roll-up writer takes, on the enrolment;
   * `advance`'s idiom, `writeVerdict`'s and the override's. Postgres only:
   * `atomic` chains transactions on SQLite, where one connection makes
   * writers serial whatever is asked for, and the row is simply re-read. A
   * method of its own so the PG spec can hold the lock open and prove the
   * learner's writer waits on it.
   */
  private async lockEnrolment(tx: EntityManager, enrollment: EnrollmentEntity): Promise<EnrollmentEntity> {
    return heldEnrollment(tx, enrollment);
  }

  /** The pinned version's tasks for one phase, or nothing where it cannot be read. */
  private tasksOf(enrollment: EnrollmentEntity, phaseKey: string): CompiledTask[] | undefined {
    try {
      return this.content.getTasksForEnrollment(enrollment, phaseKey);
    } catch {
      return undefined;
    }
  }

  /**
   * The class has to be the caller's: owned, the caller's own cohort, or any
   * class for an admin; `ScheduleService`'s rule, and its 404, so guessing
   * ids tells a second instructor nothing about which classes exist.
   */
  private async requireOwnedCohort(
    manager: EntityManager,
    caller: InstructorCaller,
    cohortId: string,
  ): Promise<CohortEntity> {
    const cohort =
      typeof cohortId === 'string' && cohortId !== UNATTACHED_COHORT && UUID_PATTERN.test(cohortId)
        ? await manager.findOne(CohortEntity, { where: { id: cohortId } })
        : null;
    const mine =
      cohort && (caller.role === 'ADMIN' || cohort.ownerUserId === caller.id || caller.cohort === cohort.id);
    if (!mine) throw new NotFoundException('no class with that id in your classes');
    return cohort;
  }
}

/**
 * A stored timestamp as ISO text: a Date, or a string re-parsed, and '' for no
 * value. A string that does not parse throws, as `toISOString` does; a
 * timestamp column never holds one.
 */
const isoOf = (value: Date | string | null | undefined): string =>
  value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : '';
