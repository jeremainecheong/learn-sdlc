import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import type { AuthService } from '../auth/auth.service';
import { AccountService } from '../account/account.service';
import { ALL_ENTITIES, AuditEventEntity, CohortEntity, UserEntity } from '../db/entities';
import { AdminService } from './admin.service';
import { UNATTACHED_COHORT } from '../instructor/cohort-scope';
import { config } from '../config';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Let `intruder` run inside the next read of a users row.
 *
 * That read is the window: the console has the row in hand, has written
 * nothing, and is about to spend a quarter of a second hashing at cost 12 or
 * looking a cohort up. Anything another writer does in that window is written
 * back over by a save of the row read before it. Driving the window from the
 * read rather than from a stubbed clock keeps the timing exact.
 *
 * One shot, so the intruder's own reads pass straight through.
 * (The learner's side of the same race lives in account.service.spec.ts, which
 * carries its own copy; a spec cannot import another spec without running it.)
 */
const duringTheNextUserRead = (dataSource: DataSource, intruder: () => Promise<unknown>): void => {
  const manager = dataSource.manager;
  const read = manager.findOne.bind(manager);
  let armed = true;
  jest.spyOn(manager, 'findOne').mockImplementation((async (entity: unknown, options: unknown) => {
    const row = await read(entity as never, options as never);
    if (armed && entity === UserEntity) {
      armed = false;
      await intruder();
    }
    return row;
  }) as never);
};

describe('AdminService', () => {
  let dataSource: DataSource;
  let admin: AdminService;
  let forgetSession: jest.Mock;
  let actorId = '';
  let learnerId = '';
  let cohortId = '';

  const learnerEmail = 'learner@learnsdlc.test';
  const missingId = '00000000-0000-4000-8000-000000000000';

  const user = (id: string) => dataSource.manager.findOneByOrFail(UserEntity, { id });
  const auditRows = () => dataSource.manager.find(AuditEventEntity, {});

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const manager = dataSource.manager;
    const actor = await manager.save(
      manager.create(UserEntity, {
        email: 'ops@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'Ops',
        role: 'ADMIN',
      }),
    );
    actorId = actor.id;
    const learner = await manager.save(
      manager.create(UserEntity, {
        email: learnerEmail,
        passwordHash: 'x',
        displayName: 'Learner',
        tokenVersion: 4,
      }),
    );
    learnerId = learner.id;
    const cohort = await manager.save(
      manager.create(CohortEntity, { name: 'Tuesday class', joinCode: 'ABCDEFGH', ownerUserId: actorId }),
    );
    cohortId = cohort.id;

    // Only forgetSession is exercised; the rest of AuthService is irrelevant here.
    forgetSession = jest.fn();
    admin = new AdminService(passwordWorkFixture(), dataSource, { forgetSession } as unknown as AuthService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('lookup', () => {
    it('finds the account however the address was typed, without the hash', async () => {
      const view = await admin.lookup(`  ${learnerEmail.toUpperCase()} `);
      expect(view).toMatchObject({ id: learnerId, email: learnerEmail, role: 'LEARNER' });
      expect(JSON.stringify(view)).not.toContain('passwordHash');
    });

    it('names the cohort the account is in', async () => {
      await admin.update(actorId, learnerId, { cohort: cohortId });
      expect(await admin.lookup(learnerEmail)).toMatchObject({
        cohort: cohortId,
        cohortName: 'Tuesday class',
      });
    });

    it('refuses an unknown address', async () => {
      await expect(admin.lookup('nobody@learnsdlc.test')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('suspends: stamps disabledAt, bumps tokenVersion and drops the session', async () => {
      const before = await user(learnerId);
      const view = await admin.update(actorId, learnerId, { disabled: true });
      const after = await user(learnerId);

      expect(view.disabledAt).toEqual(expect.any(String));
      expect(after.disabledAt).toBe(view.disabledAt);
      // The guard admits a token only while its `ver` equals this column, so
      // the increment is what ends the suspended account's live sessions.
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(forgetSession).toHaveBeenCalledWith(learnerId);
    });

    it('restores: clears disabledAt without revoking again', async () => {
      await admin.update(actorId, learnerId, { disabled: true });
      const suspended = await user(learnerId);
      const view = await admin.update(actorId, learnerId, { disabled: false });
      const after = await user(learnerId);

      expect(view.disabledAt).toBeNull();
      expect(after.disabledAt).toBeNull();
      expect(after.tokenVersion).toBe(suspended.tokenVersion);
    });

    it('suspending twice does not bump twice', async () => {
      await admin.update(actorId, learnerId, { disabled: true });
      const once = await user(learnerId);
      await admin.update(actorId, learnerId, { disabled: true });
      const twice = await user(learnerId);
      expect(twice.tokenVersion).toBe(once.tokenVersion);
      expect(twice.disabledAt).toBe(once.disabledAt);
    });

    it('changes the role and drops the cached session so the guard re-reads it', async () => {
      const view = await admin.update(actorId, learnerId, { role: 'INSTRUCTOR' });
      expect(view.role).toBe('INSTRUCTOR');
      expect((await user(learnerId)).role).toBe('INSTRUCTOR');
      expect(forgetSession).toHaveBeenCalledWith(learnerId);
    });

    it('takes a promoted learner out of the class they sat in, unless the patch names one', async () => {
      // A learner's cohort column is their seat; for staff the same column is
      // a class they may read every learner of. Promotion must not turn one
      // into the other.
      await dataSource.manager.update(UserEntity, { id: learnerId }, { cohort: cohortId });
      const view = await admin.update(actorId, learnerId, { role: 'INSTRUCTOR' });
      expect(view.role).toBe('INSTRUCTOR');
      expect((await user(learnerId)).cohort).toBe(UNATTACHED_COHORT);
      const [row] = await auditRows();
      expect(row.detail).toMatchObject({ changes: ['role=INSTRUCTOR', `cohort=${UNATTACHED_COHORT}`] });

      // An admin who means the promoted account to keep a class says so.
      await dataSource.manager.update(
        UserEntity,
        { id: learnerId },
        { role: 'LEARNER', cohort: cohortId },
      );
      await admin.update(actorId, learnerId, { role: 'INSTRUCTOR', cohort: cohortId });
      expect((await user(learnerId)).cohort).toBe(cohortId);

      // A role change between staff roles leaves the column alone.
      await admin.update(actorId, learnerId, { role: 'ADMIN' });
      expect((await user(learnerId)).cohort).toBe(cohortId);
    });

    it('moves the account into an existing cohort, or back to default', async () => {
      await admin.update(actorId, learnerId, { cohort: cohortId });
      expect((await user(learnerId)).cohort).toBe(cohortId);
      await admin.update(actorId, learnerId, { cohort: UNATTACHED_COHORT });
      expect((await user(learnerId)).cohort).toBe(UNATTACHED_COHORT);
    });

    it('refuses a cohort id that does not exist, changing nothing', async () => {
      await expect(admin.update(actorId, learnerId, { cohort: missingId })).rejects.toThrow(
        BadRequestException,
      );
      expect((await user(learnerId)).cohort).toBe(UNATTACHED_COHORT);
    });

    it.each([
      ['suspend', { disabled: true }],
      ['demote', { role: 'LEARNER' as const }],
    ])('refuses to %s the caller’s own account', async (_case, patch) => {
      await expect(admin.update(actorId, actorId, patch)).rejects.toThrow(BadRequestException);
      const self = await user(actorId);
      expect(self.role).toBe('ADMIN');
      expect(self.disabledAt).toBeNull();
    });

    it('applies nothing and revokes nothing when nothing changed', async () => {
      const before = await user(learnerId);
      await admin.update(actorId, learnerId, { role: 'LEARNER', cohort: UNATTACHED_COHORT, disabled: false });
      const after = await user(learnerId);
      expect(after.tokenVersion).toBe(before.tokenVersion);
      expect(forgetSession).not.toHaveBeenCalled();
    });

    it('refuses an id with no account behind it', async () => {
      await expect(admin.update(actorId, missingId, { disabled: true })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('records what changed in the audit trail, and nothing when nothing changed', async () => {
      await admin.update(actorId, learnerId, { role: 'INSTRUCTOR', disabled: true });
      const [row] = await auditRows();
      expect(row).toMatchObject({
        event: 'admin.user.update',
        actorUserId: actorId,
        subjectUserId: learnerId,
        action: 'role=INSTRUCTOR, suspended',
        detail: { changes: ['role=INSTRUCTOR', 'suspended'], sessionsRevoked: true },
      });

      await admin.update(actorId, learnerId, { role: 'INSTRUCTOR' });
      expect(await auditRows()).toHaveLength(1);
    });

    it('revokes on a role change too, so a demotion cannot be ridden out on the token in hand', async () => {
      const before = await user(learnerId);
      const view = await admin.update(actorId, learnerId, { role: 'INSTRUCTOR' });
      const after = await user(learnerId);

      expect(view.role).toBe('INSTRUCTOR');
      // forgetSession clears this process's cache and nobody else's. A second
      // process keeps serving the row it read until the session cache TTL runs
      // out, which is a demoted instructor holding the console for another
      // half minute. The version lives in the row, so every process reads it,
      // at the price of one sign-in.
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(forgetSession).toHaveBeenCalledWith(learnerId);
      const [row] = await auditRows();
      expect(row).toMatchObject({
        action: 'role=INSTRUCTOR',
        detail: { sessionsRevoked: true },
      });
    });

    it('moves an account into a class without undoing a password change made in the same moment', async () => {
      const account = new AccountService(passwordWorkFixture(), dataSource);
      const current = 'Correct-Horse-9';
      const replacement = 'Staple-Battery-42';
      await dataSource.manager.update(
        UserEntity,
        { id: learnerId },
        { passwordHash: await bcrypt.hash(current, 4) },
      );
      const before = await user(learnerId);

      // The learner changes their own password in the window between the
      // console's read and its write.
      duringTheNextUserRead(dataSource, () =>
        account.changePassword(learnerId, current, replacement),
      );
      await admin.update(actorId, learnerId, { cohort: cohortId });

      const after = await user(learnerId);
      expect(after.cohort).toBe(cohortId);
      // Saving the row the console read would put the old hash and the old
      // version back: the learner's password change undone, and every token
      // they had just signed out alive again for the rest of its week.
      expect(await bcrypt.compare(replacement, after.passwordHash)).toBe(true);
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    });
  });

  describe('setPassword', () => {
    const replacement = 'Staple-Battery-42';

    it('does not pretend a local hash update changes a Cognito password', async () => {
      const before = await user(learnerId);
      const provider = config.authProvider;
      config.authProvider = 'cognito';
      try {
        await expect(admin.setPassword(actorId, learnerId, replacement)).rejects.toThrow('Passwords are managed by Cognito');
        expect(await user(learnerId)).toEqual(before);
        expect(forgetSession).not.toHaveBeenCalled();
      } finally { config.authProvider = provider; }
    });

    it('stores a hash of the new password and revokes every session', async () => {
      const before = await user(learnerId);
      await expect(admin.setPassword(actorId, learnerId, replacement)).resolves.toEqual({
        changed: true,
      });
      const after = await user(learnerId);
      expect(await bcrypt.compare(replacement, after.passwordHash)).toBe(true);
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(forgetSession).toHaveBeenCalledWith(learnerId);
    });

    it('refuses the caller’s own account, which keeps the current-password proof', async () => {
      await expect(admin.setPassword(actorId, actorId, replacement)).rejects.toThrow(
        BadRequestException,
      );
      expect((await user(actorId)).passwordHash).toBe('x');
    });

    it('refuses an id with no account behind it', async () => {
      await expect(admin.setPassword(actorId, missingId, replacement)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does not undo a suspension made while the new hash was being computed', async () => {
      const before = await user(learnerId);

      // A second operator suspends the same account inside the window. Saving
      // the row read before it would put `disabledAt: null` back and restore
      // an account somebody has just been suspended from.
      let suspendedAt: string | null = null;
      duringTheNextUserRead(dataSource, async () => {
        suspendedAt = (await admin.update(actorId, learnerId, { disabled: true })).disabledAt;
      });

      await expect(admin.setPassword(actorId, learnerId, replacement)).resolves.toEqual({
        changed: true,
      });

      const after = await user(learnerId);
      expect(suspendedAt).toEqual(expect.any(String));
      expect(after.disabledAt).toBe(suspendedAt);
      // Two revocations happened, so the version advanced twice.
      expect(after.tokenVersion).toBe(before.tokenVersion + 2);
      expect(await bcrypt.compare(replacement, after.passwordHash)).toBe(true);
    });

    it('records that a password was set, and never the password', async () => {
      await admin.setPassword(actorId, learnerId, replacement);
      const [row] = await auditRows();
      expect(row).toMatchObject({
        event: 'admin.password.set',
        actorUserId: actorId,
        subjectUserId: learnerId,
        action: 'password set',
        reason: null,
        detail: { sessionsRevoked: true },
      });
      expect(JSON.stringify(row)).not.toContain(replacement);
    });
  });

  describe('listCohorts', () => {
    it('lists every class oldest first, with its owner and its learner count, in three reads', async () => {
      const manager = dataSource.manager;
      const orphan = await manager.save(
        manager.create(CohortEntity, { name: 'Friday class', joinCode: 'JKLMNPQR', ownerUserId: missingId }),
      );
      await manager.update(CohortEntity, { id: cohortId }, { createdAt: new Date('2026-01-05T09:00:00.000Z') });
      await manager.update(CohortEntity, { id: orphan.id }, { createdAt: new Date('2026-01-06T09:00:00.000Z') });
      await manager.update(UserEntity, { id: learnerId }, { cohort: cohortId });
      const reads = jest.spyOn(manager, 'find');
      const counts = jest.spyOn(manager, 'count');

      expect(await admin.listCohorts()).toEqual([
        { id: cohortId, name: 'Tuesday class', joinCode: 'ABCDEFGH', ownerUserId: actorId, ownerEmail: 'ops@learnsdlc.test', memberCount: 1 },
        { id: orphan.id, name: 'Friday class', joinCode: 'JKLMNPQR', ownerUserId: missingId, ownerEmail: null, memberCount: 0 },
      ]);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(counts).not.toHaveBeenCalled();
    });

    it('answers an empty list when there is no class', async () => {
      await dataSource.manager.clear(CohortEntity);
      expect(await admin.listCohorts()).toEqual([]);
    });
  });

  describe('reassignCohortOwner', () => {
    /** Somebody to hand a class to. */
    const seedInstructor = async (email: string, fields: Partial<UserEntity> = {}) => {
      const manager = dataSource.manager;
      return manager.save(
        manager.create(UserEntity, {
          email,
          passwordHash: 'x',
          displayName: 'Dana',
          role: 'INSTRUCTOR',
          ...fields,
        }),
      );
    };

    it('moves the class, and the learners in it come with it', async () => {
      // Scope resolves through cohorts.ownerUserId
      // (cohort-scope.ts), so this one column is what makes a class visible to
      // anybody at all. Without this action a class whose owner has gone is
      // unreachable while its join code keeps working.
      const dana = await seedInstructor('dana@learnsdlc.test');
      await dataSource.manager.update(UserEntity, { id: learnerId }, { cohort: cohortId });

      const view = await admin.reassignCohortOwner(actorId, cohortId, dana.id);

      expect(view).toMatchObject({
        id: cohortId,
        name: 'Tuesday class',
        ownerUserId: dana.id,
        ownerEmail: 'dana@learnsdlc.test',
        memberCount: 1,
      });
      expect((await dataSource.manager.findOneByOrFail(CohortEntity, { id: cohortId })).ownerUserId).toBe(
        dana.id,
      );
    });

    it('leaves the new owner in whatever class they were already teaching', async () => {
      const dana = await seedInstructor('dana@learnsdlc.test', { cohort: 'their-own-class' });
      await admin.reassignCohortOwner(actorId, cohortId, dana.id);
      expect((await user(dana.id)).cohort).toBe('their-own-class');
    });

    it('records who moved the class, to whom, and from whom', async () => {
      const dana = await seedInstructor('dana@learnsdlc.test');
      await admin.reassignCohortOwner(actorId, cohortId, dana.id);

      const [row] = await auditRows();
      expect(row).toMatchObject({
        event: 'admin.cohort.owner',
        actorUserId: actorId,
        subjectUserId: dana.id,
        targetId: cohortId,
        action: 'owner of Tuesday class',
        detail: { cohortName: 'Tuesday class', from: actorId, to: dana.id },
      });
    });

    it('refuses to hand a class to a learner, changing nothing', async () => {
      await expect(admin.reassignCohortOwner(actorId, cohortId, learnerId)).rejects.toThrow(
        BadRequestException,
      );
      expect((await dataSource.manager.findOneByOrFail(CohortEntity, { id: cohortId })).ownerUserId).toBe(
        actorId,
      );
      expect(await auditRows()).toHaveLength(0);
    });

    it('refuses to hand a class to a suspended account', async () => {
      const dana = await seedInstructor('dana@learnsdlc.test', {
        disabledAt: new Date().toISOString(),
      });
      await expect(admin.reassignCohortOwner(actorId, cohortId, dana.id)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses an unknown class and an unknown account', async () => {
      const dana = await seedInstructor('dana@learnsdlc.test');
      await expect(admin.reassignCohortOwner(actorId, missingId, dana.id)).rejects.toThrow(
        NotFoundException,
      );
      await expect(admin.reassignCohortOwner(actorId, cohortId, missingId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('writes nothing when the class is already theirs', async () => {
      const view = await admin.reassignCohortOwner(actorId, cohortId, actorId);
      expect(view.ownerUserId).toBe(actorId);
      expect(await auditRows()).toHaveLength(0);
    });

    it('clears the way for the previous owner to delete their account', async () => {
      // The two halves of the class-ownership rule (deletion refused while a
      // class is owned; an admin moves the class), in the order an instructor
      // meets them.
      const dana = await seedInstructor('dana@learnsdlc.test');
      await dataSource.manager.update(UserEntity, { id: learnerId }, { cohort: cohortId });
      const account = new AccountService(passwordWorkFixture(), dataSource);

      await expect(admin.update(actorId, actorId, {})).resolves.toBeDefined();
      await expect(account.deleteAccount(actorId, 'ops@learnsdlc.test')).rejects.toThrow(
        /Tuesday class, which has 1 learner in it/,
      );

      await admin.reassignCohortOwner(actorId, cohortId, dana.id);
      await expect(account.deleteAccount(actorId, 'ops@learnsdlc.test')).resolves.toEqual({
        deleted: true,
      });
      // The class and its learner outlive the account that made it.
      expect(await dataSource.manager.count(CohortEntity, {})).toBe(1);
      expect((await user(learnerId)).cohort).toBe(cohortId);
    });
  });
});
