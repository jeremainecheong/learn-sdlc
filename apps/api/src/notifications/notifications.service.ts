import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';
import {
  Between,
  DataSource,
  EntityManager,
  EntityTarget,
  In,
  IsNull,
  Not,
  ObjectLiteral,
} from 'typeorm';
import type {
  FeedbackReport,
  NotificationAudience,
  NotificationEvent,
  NotificationKind,
  NotificationListView,
  NotificationView,
  PhaseKey,
  PhaseStatus,
  StuckFlag,
} from '@learnsdlc/shared';
import { nextPhaseOf } from '@learnsdlc/shared';
import { integrityReasons, STUCK_ATTEMPTS } from '../analytics/signals';
import { ContentService, type EnrollmentPin } from '../content/content.service';
import {
  CohortEntity,
  CohortPhaseScheduleEntity,
  EnrollmentEntity,
  NotificationEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { EventsGateway } from '../events/events.gateway';
import { recordAudit } from '../audit/audit';
import { learnerScope, UNATTACHED_COHORT } from '../instructor/cohort-scope';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { isUniqueViolation } from '../db/unique-violation';
import { LEARNER_RESOLUTION, type LearnerResolution } from './learner-resolution';
import { DISPLAY_LOCALE } from '../config/locale';
import { UUID_PATTERN } from '../db/uuid';
import { DAY_MS, HOUR_MS, isoOrEmpty } from '../db/timestamps';

/* ------------------------------ retention -------------------------------- */

/**
 * How long a row that has been read is kept. A bell is about now: once a
 * learner has seen "Testing: Pass" the record of the pass is the
 * submission, and this row is a pointer nobody will follow again.
 */
export const NOTIFICATION_READ_MAX_AGE_DAYS = 7;

/** How long any row is kept, read or not. A month-old nudge is not a nudge. */
export const NOTIFICATION_MAX_AGE_DAYS = 30;

/** The most rows one account keeps. Past this, the oldest go first. */
export const NOTIFICATIONS_KEPT_PER_USER = 200;

/* -------------------------------- the sweep ------------------------------- */

/** Boot, then every quarter hour. A laptop is closed between classes. */
export const NOTIFICATION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** How long a drill may sit paged and unresolved before the bell says so. */
export const DRILL_UNRESOLVED_HOURS = 24;

/** How far ahead a due date is worth mentioning. */
export const DEADLINE_NEAR_DAYS = 3;

/* --------------------------------- limits --------------------------------- */

/** What the panel draws, and the most one request may ask for. */
export const NOTIFICATION_LIST_DEFAULT = 20;
export const NOTIFICATION_LIST_MAX = 50;

/** A learner's or an instructor's own words, cut to one line in the panel. */
export const NOTIFICATION_DETAIL_MAX = 160;

/**
 * Who signs the review threads, per phase. The twin of `PHASE_REVIEWER` in
 * `apps/web/lib/phase.ts`, which draws the same six people on the pull
 * request; only the role is needed here, because the sentence is written once,
 * at creation, and never assembled in the browser.
 */
const REVIEWER_ROLE: Record<PhaseKey, string> = {
  requirements: 'product owner',
  design: 'architect',
  implementation: 'senior engineer',
  testing: 'QA lead',
  deployment: 'site reliability engineer',
  maintenance: 'maintainer',
};

/**
 * What one verdict did to the phase it was about, handed to the bell by the
 * writer that did it.
 *
 * A verdict is a statement about one **task**, and the bell's two decisions
 * are about the phase and about that task: *did the gate open* and *has this
 * learner been at this piece of work too long*. Neither is derivable from
 * `passed` once a phase can hold more than one task, and both are already in
 * the roll-up's hand, so they are passed rather than recomputed: a second
 * derivation is a second answer.
 *
 * On a phase whose compiled list is the synthesised sole task, `after` is
 * `nextPhaseStatus(before, passed)` and `taskAttempts` is null, so
 * every expression below reduces to its phase-level form.
 */
export interface VerdictTransition {
  /** The phase's status as the roll-up read it. */
  before: PhaseStatus;
  /** The phase's status as the roll-up left it. */
  after: PhaseStatus;
  /** The task this verdict was about, as the pinned version keys it. */
  taskKey: string;
  /** That task's own attempt counter, or null where the phase holds no task row. */
  taskAttempts: number | null;
}

/* ---------------------- a task's sign-off, read ---------------------- */

/** What a revision's task says about its countersignature. Read only. */
export interface TaskSignOffRead {
  /** The task row the revision is about, or null where none can be named. */
  taskKey: string | null;
  /** The task's passing evidence is in and waits for the teacher. */
  awaiting: boolean;
  /** The teacher countersigned, and this revision is the evidence they signed. */
  signedOff: boolean;
  /** When, as an ISO string, and only when `signedOff`. */
  signedOffAt: string | null;
}

/** A completed revision as the sign-off read needs it. */
export interface SignOffRevision {
  id: string;
  taskKey: string;
  passed: boolean | null;
  createdAt: Date | string;
}

const timeOf = (value: Date | string | null | undefined): number =>
  value instanceof Date ? value.getTime() : value ? Date.parse(String(value)) : NaN;

/**
 * Which task row a revision is about. `''` is the phase's sole task, which is
 * the phase's only task row when it has exactly one; otherwise nothing is
 * guessed.
 */
export function revisionTaskKey(taskKey: string, rows: readonly Pick<TaskStateEntity, 'taskKey'>[]): string {
  return taskKey || (rows.length === 1 ? rows[0].taskKey : '');
}

/**
 * Whether `revision` is the evidence its task's sign-off was given on: the
 * task row carries `signedOffAt`, and this revision is that task's newest
 * completed passing revision created at or before it. `rows` are the phase
 * state's task rows and `completed` its completed revisions. Pure: the two
 * writers (`signoff.ts`, the `task-signoff` lever) are the only thing that
 * sets the columns, and nothing here writes.
 */
export function taskSignOffOf(
  revision: Pick<SignOffRevision, 'id' | 'taskKey'>,
  rows: readonly TaskStateEntity[],
  completed: readonly SignOffRevision[],
): TaskSignOffRead {
  const key = revisionTaskKey(revision.taskKey, rows);
  const row = key ? rows.find((one) => one.taskKey === key) : undefined;
  if (!row) return { taskKey: null, awaiting: false, signedOff: false, signedOffAt: null };
  const awaiting = row.awaitingSignOff && row.status !== 'passed';
  const cut = timeOf(row.signedOffAt);
  if (!Number.isFinite(cut)) return { taskKey: key, awaiting, signedOff: false, signedOffAt: null };
  const signed = completed
    .filter((one) => one.passed === true && revisionTaskKey(one.taskKey, rows) === key && timeOf(one.createdAt) <= cut)
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
  const signedOff = signed?.id === revision.id;
  return { taskKey: key, awaiting, signedOff, signedOffAt: signedOff ? new Date(cut).toISOString() : null };
}

/** The bell's two sign-off sentences, appended to a projected review's detail. */
export const SIGNOFF_WAITING_LINE = "Waiting for your teacher's sign-off.";
export const SIGNOFF_DONE_LINE = 'Signed off by your teacher.';

/** The newest review row of one phase task, and the revision it now reports. */
interface LatestReview {
  revision: SubmissionEntity;
  phase: PhaseStateEntity;
  pin: EnrollmentPin | null;
  signOff: TaskSignOffRead;
}

/** What one read of a learner's review rows decides. */
interface LatestReviews {
  /** Unread review rows that a newer review row of the same phase task supersedes. */
  hidden: Set<string>;
  /** Newest review row id → the latest revision it is projected onto. */
  targets: Map<string, LatestReview>;
}

/** What one notification is written with. */
export interface NotifyInput {
  userId: string;
  audience: NotificationAudience;
  kind: NotificationKind;
  /** The natural key of the thing this is about; see the entity's comment. */
  subjectKey: string;
  title: string;
  detail?: string | null;
  href: string;
  phaseKey?: PhaseKey | null;
  actorUserId?: string | null;
}

/** What one sweep did. */
export interface NotificationSweepResult {
  written: number;
  pruned: number;
}

/**
 * The bell.
 *
 * This service is the only way anything in the API creates a notification, and
 * `notify` is deliberately an insert that catches its own unique violation
 * rather than a read followed by a write: the sweep and the grading pipeline
 * fire together often enough that the race is real, and the partial index
 * `UQ_notifications_unread_subject` is the only thing that can settle it.
 *
 * Nothing here is allowed to be the reason something else fails. A verdict
 * that could not write its notification is still a verdict, a sweep that threw
 * is logged and tried again in a quarter of an hour, and every fact a row
 * points at is stored somewhere that is kept for the term. A notification is a
 * pointer, never a record.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
    private readonly events: EventsGateway,
    /**
     * Where the sweep finds which project each learner is in, so a class's
     * dates remind a learner only of the project
     * their dashboard opens. Read at sweep time, never at construction: the
     * answer is `WorkflowService`, which injects `FeedbackService`, which
     * injects this service, so a constructor dependency would be a cycle, and
     * Nest waits on one for ever rather than refusing it. Optional so the
     * specs that build this service by hand treat every row as a reminder;
     * the app always has it.
     */
    @Optional() @Inject(ModuleRef) private readonly modules?: ModuleRef,
  ) {}

  private resolved: LearnerResolution | null | undefined;

  /** `LEARNER_RESOLUTION`, looked up once; null where the app provides none. */
  private resolution(): LearnerResolution | null {
    if (this.resolved === undefined) {
      try {
        this.resolved = this.modules?.get<LearnerResolution>(LEARNER_RESOLUTION, { strict: false }) ?? null;
      } catch {
        this.resolved = null;
      }
    }
    return this.resolved;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sweepAndLog();
    this.timer = setInterval(() => {
      void this.sweepAndLog();
    }, NOTIFICATION_SWEEP_INTERVAL_MS);
    // Never the reason the process stays up: a sweep that has not come round
    // yet must not hold a CLI or a test run open.
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------ the reads ------------------------------ */

  /**
   * The unread rows for one account, newest first, and the true unread count
   * whether or not it fits in `limit`.
   *
   * There is no read archive and no cursor: the panel draws eight rows, what
   * falls off the bottom is read on the page it concerns, and a "read" list
   * would be a second inbox nobody opens.
   */
  async list(userId: string, limit = NOTIFICATION_LIST_DEFAULT): Promise<NotificationListView> {
    const manager = this.dataSource.manager;
    const take = Math.min(Math.max(1, Math.trunc(limit) || NOTIFICATION_LIST_DEFAULT), NOTIFICATION_LIST_MAX);
    // An older review row of a phase task whose
    // newer row is listed is not listed, and is not counted.
    const latest = await this.latestReviews(manager, userId);
    const rows = await manager.find(NotificationEntity, {
      where: {
        userId,
        readAt: IsNull(),
        ...(latest.hidden.size ? { id: Not(In([...latest.hidden])) } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take,
    });
    return {
      items: await this.viewsOf(manager, rows, latest),
      unread: await this.unreadCount(manager, userId, latest),
    };
  }

  /**
   * Mark one row read. Scoped to the caller, and a row that is not theirs is a
   * 404 rather than a 403: the caller must not learn that the id exists.
   *
   * A row that is already read is a 200 with the current count, not an error:
   * marking something read twice is not a mistake worth refusing, and two tabs
   * with the same panel open will do it.
   */
  async markRead(userId: string, id: string): Promise<{ unread: number }> {
    const manager = this.dataSource.manager;
    const row = await manager.findOne(NotificationEntity, { where: { id, userId } });
    if (!row) throw new NotFoundException('notification not found');
    if (!row.readAt) {
      await manager.update(NotificationEntity, { id, userId }, { readAt: new Date().toISOString() });
    }
    return { unread: await this.unreadCount(manager, userId) };
  }

  /** Empty the New block. A second call is a no-op, not an error. */
  async markAllRead(userId: string): Promise<{ unread: number }> {
    const manager = this.dataSource.manager;
    await manager.update(
      NotificationEntity,
      { userId, readAt: IsNull() },
      { readAt: new Date().toISOString() },
    );
    return { unread: 0 };
  }

  /* ----------------------------- the writes ------------------------------ */

  /**
   * Create one notification, unless an unread one with the same
   * `(userId, kind, subjectKey)` already exists, in which case nothing is
   * written and `null` comes back.
   *
   * The duplicate is caught rather than read for: the sweep runs every quarter
   * hour while the grading pipeline runs whenever a learner presses Submit,
   * and a read-then-write between the two writes the row twice.
   */
  async notify(input: NotifyInput): Promise<NotificationView | null> {
    const manager = this.dataSource.manager;
    const row = await this.insertRow(manager, input);
    if (!row) return null;
    return this.announce(manager, row);
  }

  /** The same for a list, in one transaction, announced once it has committed. */
  async notifyMany(inputs: NotifyInput[]): Promise<void> {
    if (!inputs.length) return;
    const written = await this.dataSource.transaction(async (manager) => {
      const rows: NotificationEntity[] = [];
      for (const input of inputs) {
        const row = await this.insertRow(manager, input);
        if (row) rows.push(row);
      }
      return rows;
    });
    for (const row of written) await this.announce(this.dataSource.manager, row);
  }

  /**
   * Insert one row, or answer null because an unread one already says this.
   *
   * Kept separate from {@link notify} so a caller that owns a transaction
   * (the instructor's note, which writes an audit row beside it) can insert
   * inside it and announce only once it has committed. Nothing is emitted from
   * inside a transaction: a socket event about a row that then rolls back is
   * worse than a late one.
   */
  private async insertRow(
    manager: EntityManager,
    input: NotifyInput,
  ): Promise<NotificationEntity | null> {
    const row = manager.create(NotificationEntity, {
      userId: input.userId,
      audience: input.audience,
      kind: input.kind,
      subjectKey: input.subjectKey,
      title: input.title,
      detail: input.detail ?? null,
      href: input.href,
      phaseKey: input.phaseKey ?? null,
      actorUserId: input.actorUserId ?? null,
      readAt: null,
    });
    try {
      return await manager.save(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Somebody already told them this and they have not read it yet. Saying
      // it twice is the failure mode this index exists to prevent.
      return null;
    }
  }

  /** The view of a committed row, pushed to its owner, and handed back. */
  private async announce(
    manager: EntityManager,
    row: NotificationEntity,
  ): Promise<NotificationView> {
    const [view] = await this.viewsOf(manager, [row]);
    const event: NotificationEvent = {
      notification: view,
      unread: await this.unreadCount(manager, row.userId),
    };
    this.events.emitNotification(row.userId, event);
    return view;
  }

  /**
   * The unread count the panel shows: every unread row, less the older review
   * rows `list` does not list. A read, never a write.
   */
  private async unreadCount(
    manager: EntityManager,
    userId: string,
    latest?: LatestReviews,
  ): Promise<number> {
    const raw = await manager.count(NotificationEntity, { where: { userId, readAt: IsNull() } });
    if (!raw) return 0;
    const { hidden } = latest ?? (await this.latestReviews(manager, userId));
    return Math.max(0, raw - hidden.size);
  }

  /**
   * The learner's review rows, grouped by phase
   * state and task, the newest row of each group projected onto that task's
   * newest completed revision, and the older unread rows of the group hidden.
   *
   * Why: `onVerdict` writes `review.posted` only for a verdict with threads,
   * and `gate.passed` only when the phase opens. A strict Pass with no threads
   * on a countersigned task does neither, so read as stored the bell would
   * keep the first "Needs revision" for ever. Emission is not changed; this is a read.
   *
   * A group is projected only when its latest revision is a strict binary
   * verdict whose report agrees with its row: the guard `binaryReviewViews`
   * already applies, so a legacy weighted review keeps its own row and words.
   * Several tasks of one phase are separate groups: one task's newer revision
   * never relabels another task's verdict.
   */
  private async latestReviews(manager: EntityManager, userId: string): Promise<LatestReviews> {
    const out: LatestReviews = { hidden: new Set(), targets: new Map() };
    const reviews = await manager.find(NotificationEntity, {
      where: { userId, kind: 'review.posted', audience: 'learner' },
      select: ['id', 'userId', 'subjectKey', 'phaseKey', 'readAt', 'createdAt'],
    });
    const subjects = [...new Set(reviews.map((row) => row.subjectKey).filter((key) => UUID_PATTERN.test(key)))];
    if (!subjects.length) return out;
    const own = await manager.find(SubmissionEntity, {
      where: { id: In(subjects), userId, status: 'completed' },
      select: ['id', 'userId', 'phaseStateId', 'taskKey', 'createdAt'],
    });
    if (!own.length) return out;
    const phaseIds = [...new Set(own.map((sub) => sub.phaseStateId))];
    const phases = await manager.find(PhaseStateEntity, {
      where: { id: In(phaseIds), userId },
      select: ['id', 'userId', 'phaseKey', 'enrollmentId'],
    });
    if (!phases.length) return out;
    const taskRows = await manager.find(TaskStateEntity, { where: { phaseStateId: In(phaseIds), userId } });
    const completed = await manager.find(SubmissionEntity, {
      where: { phaseStateId: In(phaseIds), userId, status: 'completed' },
      select: ['id', 'userId', 'phaseStateId', 'taskKey', 'passed', 'createdAt'],
    });
    const enrollments = await manager.find(EnrollmentEntity, {
      where: { id: In([...new Set(phases.map((phase) => phase.enrollmentId))]) },
      select: ['id', 'projectSlug', 'projectVersionId'],
    });

    const newestFirst = <T extends { id: string; createdAt: Date | string }>(a: T, b: T): number =>
      timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const groups = new Map<string, { phase: PhaseStateEntity; key: string; rows: NotificationEntity[] }>();
    for (const row of reviews) {
      const sub = own.find((one) => one.id === row.subjectKey);
      const phase = sub && phases.find((one) => one.id === sub.phaseStateId);
      if (!sub || !phase || phase.phaseKey !== row.phaseKey) continue;
      // The guard `binaryReviewViews` keeps: a row never predates its revision.
      const submittedAt = timeOf(sub.createdAt);
      const notifiedAt = timeOf(row.createdAt);
      if (!Number.isFinite(submittedAt) || !Number.isFinite(notifiedAt) || submittedAt > notifiedAt) continue;
      const key = revisionTaskKey(sub.taskKey, taskRows.filter((one) => one.phaseStateId === phase.id));
      const id = `${phase.id}\u0000${key}`;
      const group = groups.get(id) ?? { phase, key, rows: [] };
      group.rows.push(row);
      groups.set(id, group);
    }
    if (!groups.size) return out;

    const picked = new Map<string, { group: { phase: PhaseStateEntity; key: string; rows: NotificationEntity[] }; newest: NotificationEntity; latest: SubmissionEntity }>();
    for (const [id, group] of groups) {
      const rowsOfPhase = taskRows.filter((one) => one.phaseStateId === group.phase.id);
      const latest = completed
        .filter((one) => one.phaseStateId === group.phase.id && revisionTaskKey(one.taskKey, rowsOfPhase) === group.key)
        .sort(newestFirst)[0];
      if (latest) picked.set(id, { group, newest: [...group.rows].sort(newestFirst)[0], latest });
    }
    const reports = picked.size
      ? await manager.find(SubmissionEntity, {
          where: { id: In([...new Set([...picked.values()].map((one) => one.latest.id))]), userId },
          select: ['id', 'userId', 'phaseStateId', 'taskKey', 'passed', 'report', 'createdAt'],
        })
      : [];
    for (const { group, newest, latest } of picked.values()) {
      const revision = reports.find((one) => one.id === latest.id);
      if (
        !revision ||
        revision.report?.assessmentMode !== 'strict_binary' ||
        typeof revision.passed !== 'boolean' ||
        revision.report.passed !== revision.passed
      )
        continue;
      const held = enrollments.find((one) => one.id === group.phase.enrollmentId);
      const rowsOfPhase = taskRows.filter((one) => one.phaseStateId === group.phase.id);
      out.targets.set(newest.id, {
        revision,
        phase: group.phase,
        pin: held ? { projectSlug: held.projectSlug, projectVersionId: held.projectVersionId } : null,
        signOff: taskSignOffOf(
          revision,
          rowsOfPhase,
          completed.filter((one) => one.phaseStateId === group.phase.id),
        ),
      });
      for (const row of group.rows) if (row.id !== newest.id && !row.readAt) out.hidden.add(row.id);
    }
    return out;
  }

  /** Rows as the client reads them, with the actor's name resolved in one query. */
  private async viewsOf(
    manager: EntityManager,
    rows: NotificationEntity[],
    latest?: LatestReviews,
  ): Promise<NotificationView[]> {
    const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => !!id))];
    const people = actorIds.length
      ? await manager.find(UserEntity, { where: { id: In(actorIds) }, select: ['id', 'displayName'] })
      : [];
    const names = new Map(people.map((person) => [person.id, person.displayName]));
    const binary = await this.binaryReviewViews(manager, rows, latest);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      audience: row.audience,
      title: binary.get(row.id)?.title ?? row.title,
      detail: binary.get(row.id)?.detail ?? row.detail,
      href: binary.get(row.id)?.href ?? row.href,
      phaseKey: (row.phaseKey as PhaseKey | null) ?? null,
      actorName: row.actorUserId ? names.get(row.actorUserId) ?? null : null,
      readAt: row.readAt,
      createdAt: isoOrEmpty(row.createdAt),
    }));
  }

  /**
   * Old gate events name a phase, not a revision. Only its first recorded Pass
   * can establish how that gate was graded; a later strict regrade must never
   * relabel an earlier weighted assessment. Read projections leave event and
   * assessment records unchanged, and resolve evidence under the event owner.
   */
  private async binaryReviewViews(
    manager: EntityManager,
    rows: NotificationEntity[],
    latest?: LatestReviews,
  ): Promise<Map<string, { title: string; detail: string | null; href?: string }>> {
    const gates = rows.filter(row => row.kind === 'gate.passed' && row.audience === 'learner');
    const reviews = rows.filter(row => row.kind === 'review.posted' && row.audience === 'learner');
    if (!gates.length && !reviews.length) return new Map();
    // The newest review row of a phase task
    // reports that task's latest revision, laid over the exact projection below.
    const projected = new Map<string, LatestReview>();
    for (const userId of new Set(reviews.map(row => row.userId))) {
      const found = latest ?? (await this.latestReviews(manager, userId));
      for (const row of reviews) {
        const target = row.userId === userId ? found.targets.get(row.id) : undefined;
        if (target) projected.set(row.id, target);
      }
    }
    const overlay = (
      result: Map<string, { title: string; detail: string | null; href?: string }>,
    ): Map<string, { title: string; detail: string | null; href?: string }> => {
      for (const row of reviews) {
        const target = projected.get(row.id);
        if (target) result.set(row.id, this.latestReviewView(row, target));
      }
      return result;
    };
    const firstPasses = gates.length
      ? await manager.createQueryBuilder(SubmissionEntity, 'submission')
        .select(['submission.id', 'submission.userId', 'submission.phaseStateId', 'submission.passed', 'submission.report', 'submission.createdAt'])
        .where(gates.map(row => ({ userId: row.userId, phaseStateId: row.subjectKey, status: 'completed', passed: true })))
        .andWhere(`NOT EXISTS (SELECT 1 FROM submissions earlier
          WHERE earlier."userId" = submission."userId"
          AND earlier."phaseStateId" = submission."phaseStateId"
          AND earlier.status = 'completed' AND earlier.passed = :successful
          AND earlier."createdAt" < submission."createdAt")`, { successful: true })
        .getMany()
      : [];
    const exactReviews = reviews.length
      ? await manager.find(SubmissionEntity, {
        where: reviews.map(row => ({ id: row.subjectKey, userId: row.userId, status: 'completed' as const })),
        select: ['id', 'userId', 'phaseStateId', 'passed', 'report', 'createdAt'],
      })
      : [];
    const evidence = [...firstPasses, ...exactReviews];
    if (!evidence.length) return overlay(new Map());
    const phases = await manager.find(PhaseStateEntity, {
      where: { id: In([...new Set(evidence.map(sub => sub.phaseStateId))]) },
      select: ['id', 'userId', 'phaseKey', 'enrollmentId'],
    });
    const enrollments = phases.length ? await manager.find(EnrollmentEntity, {
      where: { id: In([...new Set(phases.map(phase => phase.enrollmentId))]) },
      select: ['id', 'projectSlug', 'projectVersionId'],
    }) : [];
    const result = new Map<string, { title: string; detail: string | null; href?: string }>();
    for (const row of [...gates, ...reviews]) {
      const matching = (row.kind === 'gate.passed' ? firstPasses : exactReviews).filter(sub =>
        sub.userId === row.userId &&
        (row.kind === 'gate.passed' ? sub.phaseStateId === row.subjectKey : sub.id === row.subjectKey));
      // Timestamp ties with different modes are ambiguous: preserve the event.
      if (!matching.length || matching.some(sub =>
        sub.report?.assessmentMode !== 'strict_binary' || typeof sub.passed !== 'boolean' || sub.report.passed !== sub.passed)) continue;
      const sub = matching[0];
      const submittedAt = new Date(sub.createdAt).getTime();
      const notifiedAt = new Date(row.createdAt).getTime();
      if (!Number.isFinite(submittedAt) || !Number.isFinite(notifiedAt) || submittedAt > notifiedAt) continue;
      const report = sub.report!;
      if (row.kind === 'gate.passed' && !sub.passed) continue;
      const phase = phases.find(phase => phase.id === sub.phaseStateId && phase.userId === row.userId);
      if (!phase || phase.phaseKey !== row.phaseKey) continue;
      const held = enrollments.find(enrollment => enrollment.id === phase.enrollmentId);
      const pin = held ? { projectSlug: held.projectSlug, projectVersionId: held.projectVersionId } : null;
      result.set(row.id, {
        title: `${this.phaseTitle(pin, phase.phaseKey)}: ${sub.passed ? 'Pass' : 'Needs revision'}`,
        detail: row.kind === 'review.posted' ? this.reviewDetail(report, row.detail) : row.detail,
        ...(row.kind === 'review.posted' ? { href: `/feedback?phase=${encodeURIComponent(phase.id)}&submission=${encodeURIComponent(sub.id)}` } : {}),
      });
    }
    return overlay(result);
  }

  /**
   * One review row as its phase task's latest verdict:
   * the latest revision's Pass or Needs revision, a link to that revision, and
   * where the task is countersigned, whether the teacher has signed it off.
   * The row's own context line is kept only while it still names the same
   * revision; a later revision's line would otherwise say the wrong number.
   */
  private latestReviewView(
    row: NotificationEntity,
    target: LatestReview,
  ): { title: string; detail: string | null; href: string } {
    const { revision, phase, pin, signOff } = target;
    const report = revision.report!;
    const base = this.reviewDetail(report, revision.id === row.subjectKey ? row.detail : null);
    const line = signOff.signedOff
      ? SIGNOFF_DONE_LINE
      : signOff.awaiting && revision.passed
        ? SIGNOFF_WAITING_LINE
        : '';
    return {
      title: `${this.phaseTitle(pin, phase.phaseKey)}: ${revision.passed ? 'Pass' : 'Needs revision'}`,
      detail: line ? `${base} ${line}` : base,
      href: `/feedback?phase=${encodeURIComponent(phase.id)}&submission=${encodeURIComponent(revision.id)}`,
    };
  }

  private reviewDetail(report: FeedbackReport, context: string | null): string {
    const threads = countThreads(report);
    const summary = `${threads} review thread${threads === 1 ? '' : 's'}`;
    // Avoid adding the count again when this is already a new binary event.
    return context?.startsWith(`${summary}. `) ? context : `${summary}.${context ? ` ${context}` : ''}`;
  }

  /* ------------------------- the grading pipeline ------------------------- */

  /**
   * Everything one verdict has to tell somebody, in one call from
   * `FeedbackService.processSubmission`.
   *
   * Four rows at most: the learner's gate and their reviewer's threads, and
   * their instructor's two reasons to look (the same two the class queue
   * already raises, with the same sentences), so the bell and the Class page
   * cannot disagree about one learner.
   *
   * `state` is the row as it was read *before* this verdict was written, which
   * is what makes "the phase was not already passed" answerable at all; the
   * best score is recomputed here the same way the update recomputes it, so
   * the stuck sentence names the number the console will show.
   *
   * `transition` is the phase's own move, handed over rather than derived.
   * A verdict is about one **task**, and `passed` is that
   * task's answer: on a phase with two required tasks the first task's pass is
   * a pass whose phase has not opened, so a guard written on `passed` alone
   * would ring the bell on a dark gate and be silent at the moment the gate
   * actually opened. Only the roll-up knows which happened, so only the
   * roll-up can say.
   *
   * It never throws. The grade is the record and a notification is a pointer;
   * a bell that could fail a verdict would be the most expensive feature in
   * the product.
   */
  async onVerdict(
    state: PhaseStateEntity,
    submissionId: string,
    report: FeedbackReport,
    passed: boolean,
    transition: VerdictTransition,
  ): Promise<void> {
    try {
      const manager = this.dataSource.manager;
      const enrollment = await manager.findOne(EnrollmentEntity, {
        where: { id: state.enrollmentId },
        select: ['id', 'projectSlug', 'projectVersionId'],
      });
      const pin = enrollment
        ? { projectSlug: enrollment.projectSlug, projectVersionId: enrollment.projectVersionId }
        : null;
      const best = Math.max(state.bestScore ?? 0, report.overall);
      const inputs: NotifyInput[] = [];

      // The gate opening is the news, and it opens once. A pass on a phase
      // that had already passed is a regrade or a better revision; a pass on
      // one required task of two has opened nothing yet. Both are the same
      // sentence about the phase's own move, which is why the roll-up hands it
      // over: on a sole-task phase `after` is `nextPhaseStatus(before, passed)`
      // so this is `passed && state.status !== 'passed'` term for term.
      if (transition.after === 'passed' && transition.before !== 'passed') {
        inputs.push({
          userId: state.userId,
          audience: 'learner',
          kind: 'gate.passed',
          subjectKey: state.id,
          title: report.assessmentMode === 'strict_binary'
            ? `${this.phaseTitle(pin, state.phaseKey)}: Pass`
            : `${this.phaseTitle(pin, state.phaseKey)} passed with ${Math.round(report.overall)}`,
          detail: this.mergeLine(pin, state.phaseKey),
          href: `/workspace/${state.id}/pr`,
          phaseKey: state.phaseKey,
        });
      }

      const threads = countThreads(report);
      if (threads > 0) {
        inputs.push({
          userId: state.userId,
          audience: 'learner',
          kind: 'review.posted',
          subjectKey: submissionId,
          title: report.assessmentMode === 'strict_binary'
            ? `${this.phaseTitle(pin, state.phaseKey)}: ${passed ? 'Pass' : 'Needs revision'}`
            : `The ${REVIEWER_ROLE[state.phaseKey]} left ${threads} thread${threads === 1 ? '' : 's'} on your pull request`,
          detail: report.assessmentMode === 'strict_binary'
            ? this.reviewDetail(report, `${this.phaseTitle(pin, state.phaseKey)}, submission ${state.attempts}`)
            : `${this.phaseTitle(pin, state.phaseKey)}, submission ${state.attempts}`,
          href: report.assessmentMode === 'strict_binary'
            ? `/feedback?phase=${encodeURIComponent(state.id)}&submission=${encodeURIComponent(submissionId)}`
            : `/workspace/${state.id}/pr`,
          phaseKey: state.phaseKey,
        });
      }

      const owner = await this.classOwner(manager, state.userId);
      if (owner) {
        // Tries at the work that was graded, not the phase's sum over its
        // tasks. `phase_states.attempts` is
        // spent once per *task* submit, so a three-task phase would reach the
        // threshold on three **first** tries and tell a teacher a learner is
        // struggling when they have had one go at each of three pieces of
        // work. Three tries at one task is stuck, which is what this threshold
        // has always meant. `taskAttempts` is null where the phase has no task
        // row, and there the two numbers are the same number.
        const tries = transition.taskAttempts ?? state.attempts;
        if (!passed && tries >= STUCK_ATTEMPTS && (report.assessmentMode === 'strict_binary' || best < (report.passThreshold ?? 0))) {
          inputs.push({
            userId: owner,
            audience: 'instructor',
            kind: 'class.stuck',
            subjectKey: state.id,
            title: `${await this.displayName(manager, state.userId)} is stuck in ${this.phaseTitle(pin, state.phaseKey)}`,
            // The sentence AnalyticsService.classQueue writes, word for word.
            detail: `${state.attempts} submissions; the latest work needs revision.`,
            href: `/instructor/learners/${state.userId}`,
            phaseKey: state.phaseKey,
            actorUserId: state.userId,
          });
        }
        const reasons = integrityReasons(report);
        if (reasons.length) {
          inputs.push({
            userId: owner,
            audience: 'instructor',
            kind: 'class.integrity',
            subjectKey: submissionId,
            title: `An integrity flag on ${possessive(await this.displayName(manager, state.userId))} latest submission`,
            detail: `${this.phaseTitle(pin, state.phaseKey)}: ${reasons.join(', ')}`,
            href: `/instructor/learners/${state.userId}`,
            phaseKey: state.phaseKey,
            actorUserId: state.userId,
          });
        }
      }

      await this.notifyMany(inputs);
    } catch (error) {
      this.logger.warn(
        `the bell could not be written for submission ${submissionId}: ${(error as Error).message}`,
      );
    }
  }

  /* ------------------------------ the mentor ------------------------------ */

  /**
   * A learner raised a stuck flag: their class's owner is told, in the
   * learner's own words.
   *
   * The flag rides `phase_states.stuck` and has no id of its own, so the
   * subject key is the phase state and the instant it was raised: stable for
   * one flag, different for the next one on the same phase.
   */
  async onStuckRaised(state: PhaseStateEntity, flag: StuckFlag): Promise<void> {
    try {
      const manager = this.dataSource.manager;
      const owner = await this.classOwner(manager, state.userId);
      if (!owner) return;
      const pin = await this.pinOf(manager, state.enrollmentId);
      await this.notify({
        userId: owner,
        audience: 'instructor',
        kind: 'class.help',
        subjectKey: `${state.id}:${flag.raisedAt}`,
        title: `${await this.displayName(manager, state.userId)} raised a stuck flag in ${this.phaseTitle(pin, state.phaseKey)}`,
        detail: cap(flag.question),
        href: `/instructor/learners/${state.userId}`,
        phaseKey: state.phaseKey,
        actorUserId: state.userId,
      });
    } catch (error) {
      this.logger.warn(`the bell could not be told about a stuck flag: ${(error as Error).message}`);
    }
  }

  /** An instructor answered one. The learner is told where the answer is. */
  async onStuckAnswered(state: PhaseStateEntity, flag: StuckFlag): Promise<void> {
    try {
      const manager = this.dataSource.manager;
      const pin = await this.pinOf(manager, state.enrollmentId);
      await this.notify({
        userId: state.userId,
        audience: 'learner',
        kind: 'stuck.answered',
        subjectKey: `${state.id}:${flag.raisedAt}`,
        title: 'Your instructor answered your stuck flag',
        detail: this.phaseTitle(pin, state.phaseKey),
        href: `/workspace/${state.id}`,
        phaseKey: state.phaseKey,
        actorUserId: flag.answeredBy ?? null,
      });
    } catch (error) {
      this.logger.warn(`the bell could not carry a stuck answer: ${(error as Error).message}`);
    }
  }

  /* ---------------------------- the staff note ---------------------------- */

  /**
   * One instructor writing to one learner: the only notification a person
   * composes rather than the API noticing.
   *
   * Scoped through `learnerScope`, so `default` is invisible to an instructor
   * and every learner is visible to an admin, and audited with
   * the note's own words, so an appeal reads what was said rather than that
   * something was said. The subject key is a fresh uuid: two notes must never
   * collapse into one, however alike they are.
   */
  async note(
    caller: InstructorCaller,
    userId: string,
    text: string,
    phaseStateId?: string,
  ): Promise<{ sent: true }> {
    const { row, learnerId } = await this.dataSource.transaction(async (manager) => {
      const learner = await manager.findOne(UserEntity, {
        where: { id: userId, ...(await learnerScope(manager, caller)) },
      });
      if (!learner) throw new NotFoundException('learner not found');

      // The phase only decides which room the row opens. A phase state that is
      // not this learner's is ignored rather than refused: the note is still
      // worth sending, it simply lands on the dashboard.
      const state = phaseStateId
        ? await manager.findOne(PhaseStateEntity, { where: { id: phaseStateId, userId } })
        : null;

      const actor = await manager.findOne(UserEntity, {
        where: { id: caller.id },
        select: ['id', 'displayName'],
      });
      const written = await this.insertRow(manager, {
        userId: learner.id,
        audience: 'learner',
        kind: 'instructor.note',
        subjectKey: randomUUID(),
        title: `A note from ${actor?.displayName ?? 'your instructor'}`,
        detail: cap(text),
        href: state ? `/workspace/${state.id}` : '/dashboard',
        phaseKey: state?.phaseKey ?? null,
        actorUserId: caller.id,
      });

      await recordAudit(manager, {
        event: 'instructor.note',
        actorUserId: caller.id,
        subjectUserId: learner.id,
        targetId: written?.id ?? null,
        action: 'note',
        reason: null,
        // The note itself, so an appeal reads what was actually said.
        detail: { text },
      });
      return { row: written, learnerId: learner.id };
    });

    if (row) await this.announce(this.dataSource.manager, row);
    this.logger.log(`instructor ${caller.id} wrote to learner ${learnerId}`);
    return { sent: true };
  }

  /* -------------------------------- the sweep ------------------------------ */

  /** The whole sweep, with a line saying what it did. Never throws. */
  async sweepAndLog(): Promise<NotificationSweepResult> {
    try {
      const result = await this.sweep();
      if (result.written || result.pruned) {
        this.logger.log(
          `notification sweep: wrote ${result.written} row(s) and pruned ${result.pruned}`,
        );
      }
      return result;
    } catch (error) {
      // Housekeeping must never be the reason a class cannot work.
      this.logger.warn(`notification sweep failed, will try again later: ${(error as Error).message}`);
      return { written: 0, pruned: 0 };
    }
  }

  /**
   * Two jobs: say what has gone quiet and is still owed (a drill left paged,
   * a phase due this week), and then delete what nobody will read again.
   */
  async sweep(now = new Date()): Promise<NotificationSweepResult> {
    const drills = await this.writeDrillReminders(now);
    const deadlines = await this.writeDeadlineReminders(now);
    return { written: drills + deadlines, pruned: await this.prune(now) };
  }

  /**
   * A drill paged more than a day ago that nobody has resolved.
   *
   * `drill` is a `simple-json` column, so the predicate has to be read in
   * JavaScript and this is a scan of the phase states that carry one: a few
   * hundred rows on a laptop, four times an hour. It does not want an index:
   * an index on a JSON blob would not answer this question, and the table is
   * this small.
   */
  private async writeDrillReminders(now: Date): Promise<number> {
    const manager = this.dataSource.manager;
    const states = await manager.find(PhaseStateEntity, {
      where: { drill: Not(IsNull()), status: Not('passed') },
    });
    const cutoff = now.getTime() - DRILL_UNRESOLVED_HOURS * HOUR_MS;
    const inputs: NotifyInput[] = [];
    for (const state of states) {
      const drill = state.drill;
      if (!drill || drill.resolvedAt) continue;
      const paged = Date.parse(drill.pagedAt);
      if (!Number.isFinite(paged) || paged > cutoff) continue;
      inputs.push({
        userId: state.userId,
        audience: 'learner',
        kind: 'drill.unresolved',
        subjectKey: state.id,
        title: 'INCIDENT-1 is still open',
        detail: `Paged ${relativeDay(paged, now)}. The container has not started since.`,
        href: `/workspace/${state.id}/drill`,
        phaseKey: state.phaseKey,
      });
    }
    await this.notifyMany(inputs);
    return inputs.length;
  }

  /**
   * A phase this learner's class has dated, due inside the window and not
   * passed.
   *
   * The dates belong to the class rather than to the learner, so the scan
   * starts from the schedule: at most one row per class, project and phase,
   * and only the ones whose due date is actually near. A learner behind on
   * three phases is told about three, which is the truth: the panel shows
   * eight and says how many more there are.
   */
  private async writeDeadlineReminders(now: Date): Promise<number> {
    const manager = this.dataSource.manager;
    const horizon = new Date(now.getTime() + DEADLINE_NEAR_DAYS * DAY_MS);
    const dated = await manager.find(CohortPhaseScheduleEntity, {
      where: { dueAt: Between(now.toISOString(), horizon.toISOString()) },
    });
    const inputs: NotifyInput[] = [];
    // Which project each learner is in, asked once per learner per sweep.
    const placed = new Map<string, string | null>();
    for (const row of dated) {
      if (!row.dueAt || row.cohortId === UNATTACHED_COHORT) continue;
      const learners = await manager.find(UserEntity, {
        where: { cohort: row.cohortId, role: 'LEARNER' },
        select: ['id'],
      });
      if (!learners.length) continue;
      const held = await manager.find(EnrollmentEntity, {
        where: {
          userId: In(learners.map((learner) => learner.id)),
          projectSlug: row.projectSlug,
          completed: false,
        },
        // The pin as well as the id: one class's date, but the phase's title
        // is the learner's own version's, and two learners in one class can
        // hold two versions of the same project.
        select: ['id', 'userId', 'projectSlug', 'projectVersionId'],
      });
      // The class's dates outlive a reassignment, and a
      // row set aside for the class's project is not the project the
      // learner is in. Its dates are not theirs to be told about.
      const enrolments: EnrollmentEntity[] = [];
      for (const enrolment of held) {
        if (await this.isTheirProject(enrolment, row.cohortId, placed)) enrolments.push(enrolment);
      }
      if (!enrolments.length) continue;
      const pins = new Map<string, EnrollmentPin>(
        enrolments.map((enrolment) => [
          enrolment.id,
          { projectSlug: enrolment.projectSlug, projectVersionId: enrolment.projectVersionId },
        ]),
      );
      const states = await manager.find(PhaseStateEntity, {
        where: {
          enrollmentId: In(enrolments.map((enrolment) => enrolment.id)),
          phaseKey: row.phaseKey,
          status: Not('passed'),
        },
      });
      const due = new Date(row.dueAt);
      for (const state of states) {
        inputs.push({
          userId: state.userId,
          audience: 'learner',
          kind: 'deadline.near',
          // The date, not the instant: moving a due date is a new thing to say.
          subjectKey: `${state.id}:${row.dueAt.slice(0, 10)}`,
          title: `${this.phaseTitle(pins.get(state.enrollmentId) ?? null, row.phaseKey)} is due ${dueIn(due, now)}`,
          detail: describeDay(due),
          href: '/phases',
          phaseKey: row.phaseKey,
        });
      }
    }
    await this.notifyMany(inputs);
    return inputs.length;
  }

  /**
   * Whether an enrolment is on the project its learner is in: the one their
   * dashboard opens (`WorkflowService.projectVersionForLearner`). Where there
   * is no resolution to ask (a hand-built service) or it has no answer or
   * fails, the row counts, as every row did before: a reminder too many is a
   * pointer, and a sweep that stopped reminding is a silent failure.
   */
  private async isTheirProject(
    enrolment: EnrollmentEntity,
    cohort: string,
    placed: Map<string, string | null>,
  ): Promise<boolean> {
    const resolution = this.resolution();
    if (!resolution) return true;
    if (!placed.has(enrolment.userId)) {
      const pin = await resolution
        .projectVersionForLearner({ id: enrolment.userId, cohort, role: 'LEARNER' })
        .catch(() => null);
      placed.set(enrolment.userId, pin?.projectSlug ?? null);
    }
    const slug = placed.get(enrolment.userId);
    return !slug || slug === enrolment.projectSlug;
  }

  /**
   * The three retention rules, in the order that makes the third cheap: read
   * rows past a week, anything past a month, and then the oldest of whatever
   * an account has more than two hundred of.
   */
  private async prune(now: Date): Promise<number> {
    const manager = this.dataSource.manager;
    let pruned = 0;

    const readCutoff = storedDate(
      manager,
      NotificationEntity,
      'createdAt',
      new Date(now.getTime() - NOTIFICATION_READ_MAX_AGE_DAYS * DAY_MS),
    );
    const anyCutoff = storedDate(
      manager,
      NotificationEntity,
      'createdAt',
      new Date(now.getTime() - NOTIFICATION_MAX_AGE_DAYS * DAY_MS),
    );

    const read = await manager
      .createQueryBuilder()
      .delete()
      .from(NotificationEntity)
      .where('"readAt" IS NOT NULL AND "createdAt" < :cutoff', { cutoff: readCutoff })
      .execute();
    pruned += read.affected ?? 0;

    const old = await manager
      .createQueryBuilder()
      .delete()
      .from(NotificationEntity)
      .where('"createdAt" < :cutoff', { cutoff: anyCutoff })
      .execute();
    pruned += old.affected ?? 0;

    // Only the accounts that are actually over the cap are read back, so the
    // common case is one grouped count and no second query at all.
    const counted: { userId: string; n: string }[] = await manager
      .createQueryBuilder()
      .select('n."userId"', 'userId')
      .addSelect('COUNT(*)', 'n')
      .from(NotificationEntity, 'n')
      .groupBy('n."userId"')
      .having(`COUNT(*) > ${NOTIFICATIONS_KEPT_PER_USER}`)
      .getRawMany();
    for (const { userId } of counted) {
      const keep = await manager.find(NotificationEntity, {
        where: { userId },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: NOTIFICATIONS_KEPT_PER_USER,
        select: ['id'],
      });
      const dropped = await manager
        .createQueryBuilder()
        .delete()
        .from(NotificationEntity)
        .where({ userId, id: Not(In(keep.map((row) => row.id))) })
        .execute();
      pruned += dropped.affected ?? 0;
    }
    return pruned;
  }

  /* -------------------------------- helpers -------------------------------- */

  /**
   * The instructor who owns this learner's class, or null.
   *
   * An unattached learner has no class and so produces no instructor
   * notification: `default` is the absence of a class,
   * not a quiet one.
   */
  private async classOwner(manager: EntityManager, userId: string): Promise<string | null> {
    const learner = await manager.findOne(UserEntity, {
      where: { id: userId },
      select: ['id', 'cohort'],
    });
    if (!learner || !learner.cohort || learner.cohort === UNATTACHED_COHORT) return null;
    const cohort = await manager.findOne(CohortEntity, {
      where: { id: learner.cohort },
      select: ['id', 'ownerUserId'],
    });
    if (!cohort?.ownerUserId || cohort.ownerUserId === userId) return null;
    return cohort.ownerUserId;
  }

  private async displayName(manager: EntityManager, userId: string): Promise<string> {
    const person = await manager.findOne(UserEntity, {
      where: { id: userId },
      select: ['id', 'displayName'],
    });
    return person?.displayName ?? 'A learner';
  }

  /**
   * The version an enrolment holds, not the slug alone.
   *
   * What the bell says about a phase is said to the learner whose enrolment
   * this is, so it is their version's phase title and their version's next
   * phase: the same rule their room, their grade and their sandbox follow.
   * The slug on its own resolves the published head, which is another
   * learner's answer the day a second version is published under a live class.
   */
  private async pinOf(manager: EntityManager, enrollmentId: string): Promise<EnrollmentPin | null> {
    const enrolment = await manager.findOne(EnrollmentEntity, {
      where: { id: enrollmentId },
      select: ['id', 'projectSlug', 'projectVersionId'],
    });
    return enrolment
      ? { projectSlug: enrolment.projectSlug, projectVersionId: enrolment.projectVersionId }
      : null;
  }

  /**
   * The phase's title from the pinned version, or its key. A pack renamed or
   * removed under a live enrolment is not worth failing a notification over:
   * the key is still a truthful answer, and so is the head's title for a row
   * whose pin predates the version model.
   */
  private phaseTitle(pin: EnrollmentPin | null, phaseKey: PhaseKey): string {
    if (!pin?.projectSlug) return phaseKey;
    try {
      return this.content.getPhaseForEnrollment(pin, phaseKey).title;
    } catch {
      return phaseKey;
    }
  }

  /** "Merge it to open Deployment", or what to do when there is no next phase. */
  private mergeLine(pin: EnrollmentPin | null, phaseKey: PhaseKey): string {
    if (!pin?.projectSlug) return 'Merge it to open the next phase';
    try {
      const project = this.content.getForEnrollment(pin);
      const phase = project.phases.find((p) => p.key === phaseKey);
      const next = phase && nextPhaseOf(project, phase.key);
      if (!phase) return 'Merge it to open the next phase';
      return next ? `Merge it to open ${next.title}` : 'Merge it to finish the project';
    } catch {
      return 'Merge it to open the next phase';
    }
  }
}

/* --------------------------- module-private ------------------------------- */

/**
 * How many threads a reviewer left on this revision: the failing cases that
 * land on a line of the learner's own files, plus the analyzer findings worth
 * arguing with. The same two lists `buildThreads` draws the pull request from
 * (`apps/web/components/workspace/panels/implementation/pr.ts`), so the row
 * cannot promise a number the page does not show.
 */
export function countThreads(report: FeedbackReport): number {
  const cases = (report.tests?.cases ?? []).filter(
    (c) => c.status !== 'passed' && (c.frames?.length ?? 0) > 0,
  ).length;
  const issues = (report.staticAnalysis?.issues ?? []).filter((i) => i.severity !== 'info').length;
  return cases + issues;
}

/** A learner's or an instructor's own words, cut to one line for the panel. */
function cap(text: string, max = NOTIFICATION_DETAIL_MAX): string {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** "Wei Ling's", and "Chris'" when the name already ends in an s. */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** "today", "yesterday", "3 days ago": the drill's second sentence. */
function relativeDay(then: number, now: Date): string {
  const days = Math.floor((now.getTime() - then) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** "today", "tomorrow", "in 2 days": how a due date is announced. */
function dueIn(due: Date, now: Date): string {
  const days = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * "Thursday, 5 March", in this machine's zone. The browser and the API are the
 * same laptop on the local-first path, so printing the stored instant here is
 * exact rather than a guess (schedule.service.ts says the same).
 */
function describeDay(at: Date): string {
  if (Number.isNaN(at.getTime())) return '';
  const weekday = at.toLocaleDateString(DISPLAY_LOCALE, { weekday: 'long' });
  const day = at.toLocaleDateString(DISPLAY_LOCALE, { day: 'numeric', month: 'long' });
  return `${weekday}, ${day}`;
}

/**
 * A `Date` as this driver stores it. Postgres hands `createdAt` back as a
 * Date; better-sqlite3 keeps a `YYYY-MM-DD HH:MM:SS` string in UTC, and
 * comparing an ISO string against that compares text with a `T` and a `Z` in
 * it against text without. Copied from `retention.service.ts` rather than
 * imported across a bounded context, exactly as retention itself did.
 */
function storedDate(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
  property: string,
  value: Date,
): unknown {
  const column = manager.connection.getMetadata(entity).findColumnWithPropertyName(property)!;
  return manager.connection.driver.preparePersistentValue(value, column);
}
