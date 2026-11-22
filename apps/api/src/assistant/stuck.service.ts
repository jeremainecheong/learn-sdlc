import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import type { PhaseKey, StuckFlag, StuckItem } from '@learnsdlc/shared';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { learnerScope } from '../instructor/cohort-scope';
import { ContentService } from '../content/content.service';
import { EnrollmentEntity, PhaseStateEntity, UserEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
// The bell. Both halves of the flag are things somebody is waiting
// on, so both are pushed as well as polled.
import { NotificationsService } from '../notifications/notifications.service';
import { WorkflowService } from '../workflow/workflow.service';

/**
 * The stuck flag: a learner raises a hand from the mentor column,
 * and their instructor answers it in the same place.
 *
 * One flag per phase, and the learner clears it, never the instructor, the
 * question "did that help?" belongs to the person who asked it, and a flag an
 * instructor could tick off is a queue they manage rather than a conversation.
 *
 * The flag is read on a 20-second poll; on one laptop with one class a poll
 * on a handful of open flags is cheap. It also writes two notifications:
 * `class.help` when a flag goes up, so the instructor is told rather than
 * having to be looking at the console, and `stuck.answered` when it comes
 * back down. The poll stays as the fallback for a learner whose socket
 * dropped, neither notification call is allowed to fail the flag itself.
 */
@Injectable()
export class StuckService {
  private readonly logger = new Logger(StuckService.name);

  /** The most open flags one console page shows, like every other learner list. */
  static readonly MAX_OPEN = 50;

  constructor(
    private readonly dataSource: DataSource,
    private readonly workflow: WorkflowService,
    private readonly content: ContentService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ------------------------------- learner ------------------------------- */

  /** The learner's own flag on this phase, or null. */
  async mine(userId: string, phaseStateId: string): Promise<StuckFlag | null> {
    const { state } = await this.workflow.loadOwnedState(userId, phaseStateId);
    return state.stuck ?? null;
  }

  /**
   * Raise one. A second flag while one is open is refused rather than silently
   * replacing the first: the instructor may already be typing an answer to it,
   * and overwriting the question they are answering is the one outcome nobody
   * wants.
   */
  async raise(
    userId: string,
    phaseStateId: string,
    question: string,
    tried: string,
  ): Promise<StuckFlag> {
    const { state } = await this.workflow.loadOwnedState(userId, phaseStateId);
    if (state.stuck && !state.stuck.clearedAt) {
      throw new ConflictException('you already have a flag open on this phase');
    }
    const flag: StuckFlag = {
      raisedAt: new Date().toISOString(),
      question: question.trim(),
      tried: (tried || '').trim(),
      answeredAt: null,
      answeredBy: null,
      answeredByName: null,
      answer: null,
      clearedAt: null,
    };
    await this.replaceFlag(this.dataSource.manager, state, flag);
    this.logger.log(`stuck flag raised on ${state.phaseKey} by ${userId}`);
    // Their instructor's bell, in the learner's own words. The flag
    // is written whether or not this succeeds.
    await this.notifications.onStuckRaised(state, flag).catch(() => undefined);
    return flag;
  }

  /** Clearing is the learner's. An unanswered flag can be withdrawn the same way. */
  async clear(userId: string, phaseStateId: string): Promise<StuckFlag | null> {
    const { state } = await this.workflow.loadOwnedState(userId, phaseStateId);
    if (!state.stuck || state.stuck.clearedAt) return state.stuck ?? null;
    const flag: StuckFlag = { ...state.stuck, clearedAt: new Date().toISOString() };
    await this.replaceFlag(this.dataSource.manager, state, flag);
    return flag;
  }

  /** Help requests share the phase row with work and reviews. Compare only the
   * flag that was read, so concurrent replies/clears cannot replace each other
   * or require writing a stale copy of the learner's workspace. */
  private async replaceFlag(manager: EntityManager, state: PhaseStateEntity, next: StuckFlag) {
    const write = manager.createQueryBuilder().update(PhaseStateEntity).set({ stuck: next }).where('id = :id', { id: state.id });
    if (state.stuck == null) write.andWhere('stuck IS NULL');
    else write.andWhere('stuck = :previous', { previous: JSON.stringify(state.stuck) });
    const result = await write.execute();
    if (result.affected !== 1) throw new ConflictException('This help request changed while you were writing. Reopen it to read the latest reply before trying again.');
  }

  /* ------------------------------ instructor ----------------------------- */

  /**
   * Who has asked for help, oldest first. `state: 'open'` is the console's
   * default and means "not cleared", an answered flag stays on the page until
   * the learner says it helped, because an answer nobody has read is not done.
   */
  async list(
    caller: InstructorCaller,
    options: { project?: string; cohortId?: string; state?: 'open' | 'all' } = {},
  ): Promise<StuckItem[]> {
    const manager = this.dataSource.manager;
    const learners = await manager.find(UserEntity, {
      where: await learnerScope(manager, caller),
      select: ['id', 'displayName', 'email', 'cohort'],
    });
    if (learners.length === 0) return [];
    // Apply a class view only after authorisation, and before the response cap.
    // An arbitrary cohortId must never replace the caller's authorised scope.
    const people = new Map(learners.filter(learner => !options.cohortId || learner.cohort === options.cohortId).map((learner) => [learner.id, learner]));
    if (people.size === 0) return [];

    const states = await manager.find(PhaseStateEntity, {
      where: { userId: In([...people.keys()]), stuck: Not(IsNull()) },
      order: { updatedAt: 'ASC' },
    });
    if (states.length === 0) return [];

    const enrollments = await manager.find(EnrollmentEntity, {
      where: { id: In([...new Set(states.map((state) => state.enrollmentId))]) },
      select: ['id', 'projectSlug', 'projectVersionId'],
    });
    const projects = new Map(enrollments.map((row) => [row.id, row.projectSlug]));
    // The pin each enrolment holds, for the phase title.
    const pins = new Map(enrollments.map((row) => [row.id, { projectSlug: row.projectSlug, projectVersionId: row.projectVersionId ?? null }]));

    const wantAll = options.state === 'all';
    const rows: StuckItem[] = [];
    for (const state of states) {
      const flag = state.stuck;
      if (!flag) continue;
      if (!wantAll && flag.clearedAt) continue;
      const projectSlug = projects.get(state.enrollmentId) ?? '';
      if (options.project && projectSlug !== options.project) continue;
      const learner = people.get(state.userId);
      if (!learner) continue;
      rows.push({
        phaseStateId: state.id,
        userId: state.userId,
        displayName: learner.displayName,
        email: learner.email,
        projectSlug,
        phaseKey: state.phaseKey,
        phaseTitle: this.phaseTitle(pins.get(state.enrollmentId) ?? { projectSlug, projectVersionId: null }, state.phaseKey),
        raisedAt: flag.raisedAt,
        question: flag.question,
        tried: flag.tried,
        answeredAt: flag.answeredAt,
        answeredByName: flag.answeredByName,
        answer: flag.answer,
      });
    }
    // Oldest first: the person who has been waiting longest is the next one to
    // help, and the cap keeps a term of cleared flags off one page.
    rows.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
    return rows.slice(0, StuckService.MAX_OPEN);
  }

  /**
   * Read from the version the enrolment holds, as every
   * other enrolment-scoped read is, never the pack's head, a teacher's copy
   * or an older version is named by the phase its learner is working.
   */
  private phaseTitle(pin: { projectSlug: string; projectVersionId: string | null }, phaseKey: PhaseKey): string {
    if (!pin.projectSlug) return phaseKey;
    try {
      return this.content.getPhaseForEnrollment(pin, phaseKey).title;
    } catch {
      // A pack renamed or removed under a live enrolment: the key is still the
      // truthful answer, and a console page is not worth a 500.
      return phaseKey;
    }
  }

  /**
   * Answer one. Scoped exactly like every other instructor route: a learner
   * outside the caller's class is a 404, not a 403, so guessing ids tells a
   * second instructor nothing about which ids exist elsewhere.
   */
  async answer(
    caller: InstructorCaller,
    phaseStateId: string,
    answer: string,
  ): Promise<StuckItem> {
    const { item, state, answered } = await this.dataSource.transaction(async (manager: EntityManager) => {
      const state = await manager.findOne(PhaseStateEntity, { where: { id: phaseStateId } });
      if (!state) throw new NotFoundException('no flag with that id in your class');
      const learner = await manager.findOne(UserEntity, {
        where: { id: state.userId, ...(await learnerScope(manager, caller)) },
      });
      if (!learner) throw new NotFoundException('no flag with that id in your class');

      const flag = state.stuck;
      if (!flag) throw new NotFoundException('no flag with that id in your class');
      if (flag.clearedAt) {
        throw new ConflictException('that flag was cleared while you were writing');
      }

      const actor = await manager.findOne(UserEntity, {
        where: { id: caller.id },
        select: ['id', 'displayName'],
      });
      const answeredAt = new Date().toISOString();
      const answered: StuckFlag = {
        ...flag,
        answeredAt,
        answeredBy: caller.id,
        answeredByName: actor?.displayName ?? null,
        answer: answer.trim(),
      };
      await this.replaceFlag(manager, state, answered);

      const enrollment = await manager.findOne(EnrollmentEntity, {
        where: { id: state.enrollmentId },
        select: ['id', 'projectSlug', 'projectVersionId'],
      });
      const waitedMinutes = Math.max(
        0,
        Math.round((Date.parse(answeredAt) - Date.parse(flag.raisedAt)) / 60000),
      );
      // The reason is the answer itself: what an instructor told a learner when
      // they were stuck is the record of the help given, and an appeal six
      // weeks later reads exactly this.
      await recordAudit(manager, {
        event: 'stuck.answer',
        actorUserId: caller.id,
        subjectUserId: state.userId,
        targetId: state.id,
        action: 'answered',
        reason: answered.answer,
        detail: {
          phaseKey: state.phaseKey,
          projectSlug: enrollment?.projectSlug ?? null,
          waitedMinutes,
        },
      });

      const projectSlug = enrollment?.projectSlug ?? '';
      const item: StuckItem = {
        phaseStateId: state.id,
        userId: state.userId,
        displayName: learner.displayName,
        email: learner.email,
        projectSlug,
        phaseKey: state.phaseKey,
        phaseTitle: this.phaseTitle({ projectSlug, projectVersionId: enrollment?.projectVersionId ?? null }, state.phaseKey),
        raisedAt: answered.raisedAt,
        question: answered.question,
        tried: answered.tried,
        answeredAt: answered.answeredAt,
        answeredByName: answered.answeredByName,
        answer: answered.answer,
      };
      return { item, state, answered };
    });

    // The learner's bell, after the row has committed. A socket
    // event about an answer that then rolled back is worse than a late one,
    // and a bell that could fail an answer would be worse than both.
    await this.notifications.onStuckAnswered(state, answered).catch(() => undefined);
    return item;
  }
}
