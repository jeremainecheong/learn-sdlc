import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { CohortView } from '@learnsdlc/shared';
import { AuthService } from '../auth/auth.service';
import { CohortEntity, UserEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
import { atomic, rowLock } from '../db/atomic';
import { UNATTACHED_COHORT, learnerCountsByCohort } from './cohort-scope';

export type { CohortView } from '@learnsdlc/shared';

/**
 * No I, O, 0 or 1: a code is read out in class and typed from a whiteboard
 * photo, and those four are the ones that get mistaken for each other.
 */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 8;

/** Eight symbols from thirty-two is 2^40 codes; a collision is a retry, not a failure. */
const JOIN_CODE_ATTEMPTS = 5;

export function generateJoinCode(): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** What a learner typed, as the code was issued: upper-case, without the dashes and spaces people add. */
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * A cohort is a class: an instructor makes one, learners join it with the
 * code. Membership is the learner's users.cohort column, which is what the
 * instructor overview scopes by, so until a learner joins, the instructor
 * who created the class sees nobody, and after they join, only that
 * instructor does.
 */
@Injectable()
export class CohortsService {
  private readonly logger = new Logger(CohortsService.name);

  /** AuthService is optional so the spec can run on a bare DataSource. */
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly auth?: AuthService,
  ) {}

  /**
   * Creating a class also moves the creator into it, because the overview
   * scopes by the instructor's own cohort column: an instructor left in
   * 'default' would see every unattached learner rather than their class.
   */
  async create(ownerUserId: string, name: string): Promise<CohortView> {
    const cohort = await atomic(this.dataSource, async (manager) => {
      const owner = await manager.findOne(UserEntity, { where: { id: ownerUserId } });
      if (!owner) throw new NotFoundException('account not found');

      const saved = await this.insertWithFreshCode(manager, ownerUserId, name.trim());
      await manager.update(UserEntity, { id: ownerUserId }, { cohort: saved.id });
      // A class is a scope: from here, whoever owns it can read the work of
      // everyone who types the code. That is worth a row in the trail, and the
      // subject is the creator because the class moved them too. Inside the
      // transaction, so a class can never exist without the row that made it.
      await recordAudit(manager, {
        event: 'cohort.create',
        actorUserId: ownerUserId,
        subjectUserId: ownerUserId,
        targetId: saved.id,
        action: saved.name,
      });
      return saved;
    });
    this.auth?.forgetSession(ownerUserId);
    this.logger.log(`cohort ${cohort.id} created by ${ownerUserId}`);
    return this.view(this.dataSource.manager, cohort);
  }

  /**
   * Public because a class arriving as an import needs a join code
   * minted exactly the way a class made here does, and two generators would be
   * two answers to "what is a join code".
   */
  async insertWithFreshCode(
    manager: EntityManager,
    ownerUserId: string,
    name: string,
  ): Promise<CohortEntity> {
    for (let attempt = 0; attempt < JOIN_CODE_ATTEMPTS; attempt++) {
      const joinCode = generateJoinCode();
      // Checked rather than relying on the unique index alone: a constraint
      // violation inside a transaction aborts it on Postgres, and the retry
      // would then fail for an unrelated reason.
      if (await manager.exists(CohortEntity, { where: { joinCode } })) continue;
      return manager.save(manager.create(CohortEntity, { name, joinCode, ownerUserId }));
    }
    throw new ConflictException('could not allocate a join code; try again');
  }

  async listOwned(ownerUserId: string): Promise<CohortView[]> {
    const manager = this.dataSource.manager;
    const cohorts = await manager.find(CohortEntity, {
      where: { ownerUserId },
      order: { createdAt: 'ASC' },
    });
    const members = await learnerCountsByCohort(manager, cohorts.map((cohort) => cohort.id));
    return cohorts.map((cohort) => cohortView(cohort, members.get(cohort.id) ?? 0));
  }

  /**
   * The same 404 whether the code is unknown or malformed: a wrong code tells
   * the learner to check what they typed, and tells nobody else anything. The
   * browser shows the message as it stands, so it is a sentence.
   */
  async join(userId: string, rawCode: string): Promise<CohortView> {
    const manager = this.dataSource.manager;
    const joinCode = normalizeJoinCode(rawCode);
    const cohort = joinCode
      ? await manager.findOne(CohortEntity, { where: { joinCode } })
      : null;
    if (!cohort) throw new NotFoundException('There is no class with that code. Check it and try again.');

    const moved = await atomic(this.dataSource, async (tx) => {
      const user = await tx.findOne(UserEntity, {
        where: { id: userId },
        ...rowLock(this.dataSource),
      });
      if (!user) throw new NotFoundException('account not found');
      if (user.cohort === cohort.id) return false;
      const from = user.cohort;
      // One transaction, so the move and the record of it cannot come apart:
      // the whole point of the audit trail is that a learner never enters or
      // leaves an instructor's view without a row saying so.
      await tx.update(UserEntity, { id: userId }, { cohort: cohort.id });
      // The move itself is the event a learner or an instructor asks about
      // six weeks later: whose view did this account enter, when, and what
      // did it leave. Both ends are recorded, because a code typed into the
      // wrong box moves a learner out of one class as well as into another.
      await recordAudit(tx, {
        event: 'cohort.join',
        actorUserId: userId,
        subjectUserId: userId,
        targetId: cohort.id,
        action: cohort.name,
        detail: { from, to: cohort.id },
      });
      return true;
    });
    if (moved) {
      // The guard hands controllers the cohort from its cached row; drop it so
      // the next request already sees the new class.
      this.auth?.forgetSession(userId);
      this.logger.log(`user ${userId} joined cohort ${cohort.id}`);
    }
    return this.view(manager, cohort);
  }

  private async view(manager: EntityManager, cohort: CohortEntity): Promise<CohortView> {
    const memberCount = await manager.count(UserEntity, {
      where: { cohort: cohort.id, role: 'LEARNER' },
    });
    return cohortView(cohort, memberCount);
  }

  async classroom(userId: string): Promise<CohortView | null> {
    const manager = this.dataSource.manager;
    const user = await manager.findOneBy(UserEntity, { id: userId });
    if (!user) throw new NotFoundException('account not found');
    if (user.cohort === UNATTACHED_COHORT) return null;
    const cohort = await manager.findOneBy(CohortEntity, { id: user.cohort });
    return cohort ? this.view(manager, cohort) : null;
  }

  /** Membership is separate from coursework: leaving never touches phase records. */
  async leave(userId: string): Promise<{ left: true }> {
    await atomic(this.dataSource, async (manager) => {
      const user = await manager.findOne(UserEntity, { where: { id: userId }, ...rowLock(this.dataSource) });
      if (!user) throw new NotFoundException('account not found');
      if (user.cohort === UNATTACHED_COHORT) return;
      const from = user.cohort;
      await manager.update(UserEntity, { id: userId }, { cohort: UNATTACHED_COHORT });
      await recordAudit(manager, {
        event: 'cohort.leave', actorUserId: userId, subjectUserId: userId,
        targetId: from, action: 'leave', detail: { from, to: UNATTACHED_COHORT },
      });
    });
    this.auth?.forgetSession(userId);
    return { left: true };
  }
}

/** One class as its owner reads it, from the class row and its learner count. */
function cohortView(cohort: CohortEntity, memberCount: number): CohortView {
  return {
    id: cohort.id,
    name: cohort.name,
    joinCode: cohort.joinCode,
    createdAt:
      cohort.createdAt instanceof Date ? cohort.createdAt.toISOString() : String(cohort.createdAt),
    memberCount,
  };
}
