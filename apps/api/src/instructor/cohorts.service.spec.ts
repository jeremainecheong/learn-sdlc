import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthService } from '../auth/auth.service';
import { ALL_ENTITIES, AuditEventEntity, CohortEntity, UserEntity } from '../db/entities';
import {
  CohortsService,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  generateJoinCode,
  normalizeJoinCode,
} from './cohorts.service';
import { memoryDataSource } from '../../test/support/memory-db';

describe('join codes', () => {
  it('are eight characters from the unambiguous alphabet', () => {
    const allowed = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`);
    for (let i = 0; i < 500; i++) expect(generateJoinCode()).toMatch(allowed);
  });

  it('never contain the characters that get misread', () => {
    // The whole point of the alphabet; a lookalike would be a support ticket.
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[IO01]/);
  });

  it('normalise what a learner typed back to what was issued', () => {
    expect(normalizeJoinCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeJoinCode('ABCD EFGH')).toBe('ABCDEFGH');
    expect(normalizeJoinCode('')).toBe('');
  });
});

describe('CohortsService', () => {
  let dataSource: DataSource;
  let cohorts: CohortsService;
  let forgetSession: jest.Mock;
  let instructorId = '';
  let otherInstructorId = '';
  let learnerId = '';
  const missingId = '00000000-0000-4000-8000-000000000000';

  const save = (fields: Partial<UserEntity>) =>
    dataSource.manager.save(
      dataSource.manager.create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }),
    );
  const user = (id: string) => dataSource.manager.findOneByOrFail(UserEntity, { id });
  /** The whole trail, oldest first: these tests write two or three rows at most. */
  const trail = () =>
    dataSource.manager.find(AuditEventEntity, { order: { createdAt: 'ASC', id: 'ASC' } });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    instructorId = (await save({ email: 'dana@learnsdlc.test', role: 'INSTRUCTOR' })).id;
    otherInstructorId = (await save({ email: 'sam@learnsdlc.test', role: 'INSTRUCTOR' })).id;
    learnerId = (await save({ email: 'learner@learnsdlc.test' })).id;
    forgetSession = jest.fn();
    cohorts = new CohortsService(dataSource, { forgetSession } as unknown as AuthService);
  });

  describe('create', () => {
    it('stores the class with a fresh code and moves the creator into it', async () => {
      const view = await cohorts.create(instructorId, '  Tuesday class ');
      expect(view).toMatchObject({ name: 'Tuesday class', memberCount: 0 });
      expect(view.joinCode).toHaveLength(JOIN_CODE_LENGTH);

      const row = await dataSource.manager.findOneByOrFail(CohortEntity, { id: view.id });
      expect(row.ownerUserId).toBe(instructorId);
      // The overview scopes by the instructor's own cohort column; left in
      // 'default' they would be looking at the wrong class.
      expect((await user(instructorId)).cohort).toBe(view.id);
      expect(forgetSession).toHaveBeenCalledWith(instructorId);
    });

    it('gives every class its own code', async () => {
      const a = await cohorts.create(instructorId, 'One');
      const b = await cohorts.create(instructorId, 'Two');
      expect(a.joinCode).not.toBe(b.joinCode);
    });

    it('writes an audit row naming who made the class and which one', async () => {
      // A class is a scope, so creating one must leave a trace; otherwise
      // the trail could not say who could read whose work, or since when.
      const view = await cohorts.create(instructorId, 'Tuesday class');
      const rows = await trail();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: 'cohort.create',
        actorUserId: instructorId,
        subjectUserId: instructorId,
        targetId: view.id,
        action: 'Tuesday class',
      });
    });

    it('writes no class and no audit row when the owner does not exist', async () => {
      await expect(cohorts.create(missingId, 'Ghost class')).rejects.toThrow(NotFoundException);
      expect(await trail()).toHaveLength(0);
      expect(await dataSource.manager.count(CohortEntity, {})).toBe(0);
    });

    it('refuses an owner with no account behind it', async () => {
      await expect(
        cohorts.create('00000000-0000-4000-8000-000000000000', 'Ghost'),
      ).rejects.toThrow(NotFoundException);
      expect(await dataSource.manager.count(CohortEntity)).toBe(0);
    });
  });

  describe('listOwned', () => {
    it('lists only the caller’s classes, oldest first, with member counts', async () => {
      const mine = await cohorts.create(instructorId, 'Mine');
      await cohorts.create(otherInstructorId, 'Theirs');
      await cohorts.join(learnerId, mine.joinCode);

      const list = await cohorts.listOwned(instructorId);
      expect(list.map((c) => c.name)).toEqual(['Mine']);
      expect(list[0].memberCount).toBe(1);
    });
  });

  describe('join', () => {
    it('puts the learner in the class and drops their cached session', async () => {
      const created = await cohorts.create(instructorId, 'Tuesday class');
      const view = await cohorts.join(learnerId, created.joinCode);
      expect(view.id).toBe(created.id);
      expect((await user(learnerId)).cohort).toBe(created.id);
      expect(forgetSession).toHaveBeenCalledWith(learnerId);
    });

    it('writes an audit row with the actor, the subject and both ends of the move', async () => {
      const first = await cohorts.create(instructorId, 'Tuesday class');
      const second = await cohorts.create(otherInstructorId, 'Thursday class');
      await cohorts.join(learnerId, first.joinCode);
      await cohorts.join(learnerId, second.joinCode);

      // Found by target rather than by position: both rows land in the same
      // second and the tie-break is a random uuid, so order proves nothing here.
      const joins = (await trail()).filter((row) => row.event === 'cohort.join');
      expect(joins).toHaveLength(2);
      const joined = (cohortId: string) => joins.find((row) => row.targetId === cohortId);
      expect(joined(first.id)).toMatchObject({
        event: 'cohort.join',
        actorUserId: learnerId,
        subjectUserId: learnerId,
        targetId: first.id,
        action: 'Tuesday class',
        detail: { from: 'default', to: first.id },
      });
      // The second join is also a departure: a code typed into the wrong box
      // takes a learner out of one instructor's view as well as into another's.
      expect(joined(second.id)).toMatchObject({
        action: 'Thursday class',
        detail: { from: first.id, to: second.id },
      });
    });

    it('writes no audit row for a code the learner has already used', async () => {
      const created = await cohorts.create(instructorId, 'Tuesday class');
      await cohorts.join(learnerId, created.joinCode);
      await cohorts.join(learnerId, created.joinCode);
      expect((await trail()).filter((row) => row.event === 'cohort.join')).toHaveLength(1);
    });

    it('writes no audit row when the code matches nothing', async () => {
      await expect(cohorts.join(learnerId, 'ZZZZZZZZ')).rejects.toThrow(NotFoundException);
      expect(await trail()).toHaveLength(0);
    });

    it('accepts the code however it was typed', async () => {
      const created = await cohorts.create(instructorId, 'Tuesday class');
      const typed = ` ${created.joinCode.slice(0, 4).toLowerCase()}-${created.joinCode.slice(4)} `;
      await cohorts.join(learnerId, typed);
      expect((await user(learnerId)).cohort).toBe(created.id);
    });

    it('refuses an unknown or empty code, changing nothing', async () => {
      await expect(cohorts.join(learnerId, 'ZZZZZZZZ')).rejects.toThrow(NotFoundException);
      await expect(cohorts.join(learnerId, '---')).rejects.toThrow(NotFoundException);
      expect((await user(learnerId)).cohort).toBe('default');
      expect(forgetSession).not.toHaveBeenCalled();
    });

    /**
     * The browser draws this refusal word for word under the code
     * box, on onboarding and on My classroom, where every other line is a
     * sentence, so it is one too: a capital, a full stop, and the one thing
     * the learner can do next. The same words for an unknown code and an
     * empty one, so the refusal still says nothing about which codes exist.
     */
    it('says a wrong code in a sentence the page can show as it stands', async () => {
      for (const code of ['ZZZZZZZZ', '---']) {
        const refused = await cohorts.join(learnerId, code).catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(NotFoundException);
        expect((refused as NotFoundException).message).toBe(
          'There is no class with that code. Check it and try again.',
        );
      }
    });

    it('counts only learners as members', async () => {
      const created = await cohorts.create(instructorId, 'Tuesday class');
      await cohorts.join(learnerId, created.joinCode);
      // The creator sits in the same cohort column but is not a member.
      expect((await cohorts.listOwned(instructorId))[0].memberCount).toBe(1);
    });
  });
});
