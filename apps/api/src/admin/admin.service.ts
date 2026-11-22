import { PasswordWorkService } from '../auth/password-work.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In, type QueryDeepPartialEntity } from 'typeorm';
import type { AdminCohortView, AdminUserView, Role } from '@learnsdlc/shared';
import { AuthService } from '../auth/auth.service';
// One definition of the increment, shared with the learner's own password
// change, so the two writers that revoke sessions cannot drift apart.
import { BUMP_TOKEN_VERSION } from '../db/token-version';
import { CohortEntity, UserEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
import { config } from '../config';
import { normaliseEmail } from '../auth/email';
import { UNATTACHED_COHORT, learnerCountsByCohort } from '../instructor/cohort-scope';

export type { AdminCohortView, AdminUserView } from '@learnsdlc/shared';

export interface UpdateUserPatch {
  role?: Role;
  cohort?: string;
  disabled?: boolean;
}

/**
 * The operator's side of the terms: suspend, restore, change a role, move an
 * account between cohorts, set a password for someone locked out.
 *
 * Every write that should end a live session bumps tokenVersion (the guard
 * compares the token's `ver` to the row, so the increment is the revocation)
 * and then drops the cached row so it lands now rather than at the cache TTL.
 * The increment is written as SQL and the write names only the columns the
 * operation owns, because the operator is not the only writer: the learner may
 * be changing their own password in the same second, and a saved row would
 * carry every stale column back over theirs.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  /**
   * AuthService is optional only so the spec can drive the data path with a
   * bare DataSource; in the running app Nest always supplies it.
   */
  constructor(
    private readonly passwords: PasswordWorkService,
    private readonly dataSource: DataSource,
    @Optional() private readonly auth?: AuthService,
  ) {}

  async lookup(email: string): Promise<AdminUserView> {
    const manager = this.dataSource.manager;
    const user = await manager.findOne(UserEntity, {
      where: { email: normaliseEmail(email) },
    });
    if (!user) throw new NotFoundException('no account with that email');
    return this.view(manager, user);
  }

  /** Every class, oldest first: one read for the classes, one for their owners, one for their counts. */
  async listCohorts(): Promise<AdminCohortView[]> {
    const manager = this.dataSource.manager;
    const cohorts = await manager.find(CohortEntity, { order: { createdAt: 'ASC' } });
    if (!cohorts.length) return [];
    const owners = await manager.find(UserEntity, {
      where: { id: In([...new Set(cohorts.map((cohort) => cohort.ownerUserId))]) },
      select: ['id', 'email'],
    });
    const emailOf = new Map(owners.map((owner) => [owner.id, owner.email]));
    const members = await learnerCountsByCohort(manager, cohorts.map((cohort) => cohort.id));
    return cohorts.map((cohort) =>
      adminCohortView(cohort, emailOf.get(cohort.ownerUserId) ?? null, members.get(cohort.id) ?? 0),
    );
  }

  /** One class as the console reads it. `ownerEmail` is null for an owner who is gone. */
  private async cohortView(
    manager: EntityManager,
    cohort: CohortEntity,
  ): Promise<AdminCohortView> {
    const owner = await manager.findOne(UserEntity, {
      where: { id: cohort.ownerUserId },
      select: ['id', 'email'],
    });
    const memberCount = await manager.count(UserEntity, {
      where: { cohort: cohort.id, role: 'LEARNER' },
    });
    return adminCohortView(cohort, owner?.email ?? null, memberCount);
  }

  /**
   * Move a class to another instructor.
   *
   * The action account deletion leans on: an instructor who owns a class cannot
   * delete their account until somebody else owns it, and this is how somebody
   * else comes to. It is also the only repair for a class whose owner has
   * left, since scope resolves through `cohorts.ownerUserId`
   * (`cohort-scope.ts`) and a dangling owner means nobody can see the class
   * while its join code keeps working.
   *
   * Only staff may hold one: handing a class to a learner would put every
   * classmate's work behind an account with no console to read it from and no
   * expectation of holding it. The new owner is not moved into the class;
   * `learnerScope` folds in every cohort they own regardless of their own
   * cohort column, so the class is visible to them the moment this returns,
   * and moving them would silently take them out of whatever class they teach.
   */
  async reassignCohortOwner(
    actorId: string,
    cohortId: string,
    newOwnerUserId: string,
  ): Promise<AdminCohortView> {
    const manager = this.dataSource.manager;
    const cohort = await manager.findOne(CohortEntity, { where: { id: cohortId } });
    if (!cohort) throw new NotFoundException('no cohort with that id');

    const owner = await manager.findOne(UserEntity, { where: { id: newOwnerUserId } });
    if (!owner) throw new NotFoundException('account not found');
    if (owner.role === 'LEARNER') {
      throw new BadRequestException('a class can only be owned by an instructor or an admin');
    }
    if (owner.disabledAt) {
      throw new BadRequestException('that account is suspended, so it cannot be given a class');
    }
    if (cohort.ownerUserId === newOwnerUserId) return this.cohortView(manager, cohort);

    const previousOwnerUserId = cohort.ownerUserId;
    // Names the one column this operation owns, for the same reason every
    // other write here does: the join code may be being rotated in the same
    // second, and a saved row would carry the copy read above back over it.
    const { affected } = await manager.update(
      CohortEntity,
      { id: cohortId },
      { ownerUserId: newOwnerUserId },
    );
    if (!affected) throw new NotFoundException('no cohort with that id');

    this.logger.log(
      `admin ${actorId} moved cohort ${cohortId} from ${previousOwnerUserId} to ${newOwnerUserId}`,
    );
    // The subject is the new owner: they are the account that gained the
    // reach, and the trail should answer "who was given this class" from the
    // subject column the console already pages by. The previous owner is in
    // the detail, because a class changing hands has two ends.
    await recordAudit(manager, {
      event: 'admin.cohort.owner',
      actorUserId: actorId,
      subjectUserId: newOwnerUserId,
      targetId: cohortId,
      action: `owner of ${cohort.name}`,
      detail: { cohortName: cohort.name, from: previousOwnerUserId, to: newOwnerUserId },
    });

    const updated = await manager.findOne(CohortEntity, { where: { id: cohortId } });
    if (!updated) throw new NotFoundException('no cohort with that id');
    return this.cohortView(manager, updated);
  }

  /**
   * Apply whichever of role / cohort / disabled the console sent.
   *
   * The caller may not suspend or demote themselves: the console would sign
   * its own operator out mid-request and, with one admin, leave the
   * deployment with nobody able to undo it.
   */
  async update(actorId: string, userId: string, patch: UpdateUserPatch): Promise<AdminUserView> {
    const manager = this.dataSource.manager;
    const user = await manager.findOne(UserEntity, { where: { id: userId } });
    if (!user) throw new NotFoundException('account not found');

    const demotesSelf = patch.role !== undefined && patch.role !== 'ADMIN';
    if (userId === actorId && (demotesSelf || patch.disabled === true)) {
      throw new BadRequestException('you cannot suspend or demote your own account');
    }

    const changes: string[] = [];
    // Only the columns this call decided to change. Saving the row read above
    // would carry every other column with it, so a second operator's
    // suspension (or the learner's own password change) landing between the
    // read and the write would be silently undone by a cohort move.
    const fields: QueryDeepPartialEntity<UserEntity> = {};
    let revoke = false;

    if (patch.role !== undefined && patch.role !== user.role) {
      fields.role = patch.role;
      changes.push(`role=${patch.role}`);
      // A demotion has to reach every process, and forgetSession only clears
      // this one's map: another replica would keep serving the cached
      // instructor row until the session cache TTL runs out. Putting the answer
      // in the row itself is what every process reads. It costs the person one
      // sign-in, which is the right price for a role they no longer hold.
      revoke = true;
      // A learner's cohort column is the class they sit in as a student; for
      // staff, `learnerScope` reads the same column as a class they may see
      // every learner of. Left as it was, a promotion would hand the new
      // instructor the transcripts, overrides and budget lever over every
      // former classmate, without anybody having granted them a class. So the
      // seat is given up with the role unless this same patch names a class.
      if (user.role === 'LEARNER' && patch.cohort === undefined && user.cohort !== UNATTACHED_COHORT) {
        fields.cohort = UNATTACHED_COHORT;
        changes.push(`cohort=${UNATTACHED_COHORT}`);
      }
    }

    if (patch.cohort !== undefined && patch.cohort !== user.cohort) {
      if (patch.cohort !== UNATTACHED_COHORT) {
        const cohort = await manager.findOne(CohortEntity, { where: { id: patch.cohort } });
        if (!cohort) throw new BadRequestException('no cohort with that id');
      }
      fields.cohort = patch.cohort;
      changes.push(`cohort=${patch.cohort}`);
    }

    if (patch.disabled === true && !user.disabledAt) {
      fields.disabledAt = new Date().toISOString();
      // Suspension is what the terms promise, and a promise that takes effect
      // in seven days when the token expires is not one. The bump kills every
      // outstanding token; the guard refuses the row on disabledAt regardless.
      revoke = true;
      changes.push('suspended');
    } else if (patch.disabled === false && user.disabledAt) {
      fields.disabledAt = null;
      changes.push('restored');
    }

    if (!changes.length) return this.view(manager, user);

    // Added to in SQL, not in JavaScript: two revocations in the same moment
    // that both read 4 and both write 5 revoke once between them, and a token
    // minted at 5 would survive both.
    if (revoke) fields.tokenVersion = BUMP_TOKEN_VERSION;
    const { affected } = await manager.update(UserEntity, { id: userId }, fields);
    if (!affected) throw new NotFoundException('account not found');
    this.auth?.forgetSession(userId);
    // Ids, never addresses: the audit line names who did what to whom
    // without carrying either party's email into the log stream.
    this.logger.log(
      `admin ${actorId} updated ${userId}: ${changes.join(', ')}${revoke ? '; sessions revoked' : ''}`,
    );
    await recordAudit(manager, {
      event: 'admin.user.update',
      actorUserId: actorId,
      subjectUserId: userId,
      action: changes.join(', '),
      detail: { changes, sessionsRevoked: revoke },
    });

    // Read back rather than describing the copy in hand: the console should
    // show the row as it now stands, including whatever another operator
    // changed while this request was in flight.
    const updated = await manager.findOne(UserEntity, { where: { id: userId } });
    if (!updated) throw new NotFoundException('account not found');
    return this.view(manager, updated);
  }

  /**
   * Set a password for someone who has lost theirs. There is no
   * current-password proof here (that is the point of the operation) so
   * the console refuses it for the caller's own account, where the proof is
   * what keeps a borrowed session from taking the account over.
   */
  async setPassword(
    actorId: string,
    userId: string,
    password: string,
  ): Promise<{ changed: true }> {
    if (config.authProvider === 'cognito') {
      throw new BadRequestException({
        code: 'MANAGED_ACCOUNT_ACTION_REQUIRED',
        message: 'Passwords are managed by Cognito. Use password recovery or the Cognito administration console.',
      });
    }
    if (userId === actorId) {
      throw new BadRequestException('change your own password from your account page');
    }
    const manager = this.dataSource.manager;
    const user = await manager.findOne(UserEntity, { where: { id: userId } });
    if (!user) throw new NotFoundException('account not found');

    // The row is read above only to answer a bad id before spending a quarter
    // of a second on bcrypt; the write names its two columns and adds to the
    // version in SQL. Saving the row would put the `disabledAt` read before
    // the hash back over a suspension made during it, and would collapse with
    // the learner's own password change into a single revocation.
    const passwordHash = await this.passwords.hash(password);
    // The person who lost the password may not be the only one holding a
    // session for it; a new hash with the old version would leave those alive.
    const { affected } = await manager.update(
      UserEntity,
      { id: userId },
      { passwordHash, tokenVersion: BUMP_TOKEN_VERSION },
    );
    if (!affected) throw new NotFoundException('account not found');
    this.auth?.forgetSession(userId);

    this.logger.log(`admin ${actorId} set a new password for ${userId}; earlier sessions revoked`);
    // No reason field: the password itself is never recorded, and what an
    // appeal asks is only that it happened, to whom, and when.
    await recordAudit(manager, {
      event: 'admin.password.set',
      actorUserId: actorId,
      subjectUserId: userId,
      action: 'password set',
      detail: { sessionsRevoked: true },
    });
    return { changed: true };
  }

  private async view(manager: EntityManager, user: UserEntity): Promise<AdminUserView> {
    const cohort =
      user.cohort === UNATTACHED_COHORT
        ? null
        : await manager.findOne(CohortEntity, { where: { id: user.cohort } });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      cohort: user.cohort,
      cohortName: cohort?.name ?? null,
      disabledAt: user.disabledAt,
      createdAt:
        user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt),
    };
  }
}

/** One class as the console reads it, from the class row and the two facts read beside it. */
function adminCohortView(cohort: CohortEntity, ownerEmail: string | null, memberCount: number): AdminCohortView {
  return {
    id: cohort.id,
    name: cohort.name,
    joinCode: cohort.joinCode,
    ownerUserId: cohort.ownerUserId,
    ownerEmail,
    memberCount,
  };
}
