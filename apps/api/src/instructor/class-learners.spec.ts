import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import type { AssistantService } from '../assistant/assistant.service';
import { ContentService } from '../content/content.service';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  UserEntity,
} from '../db/entities';
import type { InstructorCaller } from './cohort-scope';
import { ClassLearnersQuery } from './instructor.dto';
import { CLASS_LEARNERS_PAGE, InstructorService } from './instructor.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Reading the teacher home as one `GET /instructor/learners/:userId` per
 * learner, four at a time, against the controller's 60-a-minute limit, would
 * stop a class of more than about sixty learners loading its own home page.
 *
 * `classLearnerDetails` answers the same `InstructorLearnerDetail` for a page
 * of the caller's learners in one request. It is the per-learner read, run for
 * each learner the caller's scope holds: **the same authorisation** (every
 * detail goes through `learnerDetail`, and so through `scopedLearner`), **no
 * write**, and **bounded**; at most `CLASS_LEARNERS_PAGE` learners a request,
 * paged by an id cursor.
 */
describe('InstructorService.classLearnerDetails', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: InstructorService;
  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let admin: InstructorCaller;
  let loner: InstructorCaller;
  let tuesday = '';
  let thursday = '';
  const tuesdayLearners: string[] = [];
  let thursdayLearner = '';
  let unattached = '';

  const assistant = { tokensToday: async () => 0 } as unknown as AssistantService;
  const manager = () => dataSource.manager;
  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  const enrol = async (userId: string) => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug: 'tasktrackr', currentPhaseOrder: 1 }),
    );
    for (const phase of content.getProject('tasktrackr').phases) {
      await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          status: phase.order === 1 ? 'in_progress' : 'locked',
        }),
      );
    }
  };

  /** Every row in every table, so "writes nothing" is one comparison. */
  const census = async () => {
    const counts: Record<string, number> = {};
    for (const entity of ALL_ENTITIES) {
      const name = typeof entity === 'function' ? entity.name : String(entity);
      counts[name] = await manager().count(entity as never);
    }
    return counts;
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    service = new InstructorService(dataSource, content, assistant);

    const danaRow = await saveUser({ email: 'dana@class-learners.test', role: 'INSTRUCTOR' });
    const samRow = await saveUser({ email: 'sam@class-learners.test', role: 'INSTRUCTOR' });
    const adminRow = await saveUser({ email: 'ops@class-learners.test', role: 'ADMIN' });
    const lonerRow = await saveUser({ email: 'new@class-learners.test', role: 'INSTRUCTOR' });
    tuesday = (
      await manager().save(
        manager().create(CohortEntity, { name: 'Tuesday class', joinCode: 'ABCDEFGH', ownerUserId: danaRow.id }),
      )
    ).id;
    thursday = (
      await manager().save(
        manager().create(CohortEntity, { name: 'Thursday class', joinCode: 'JKLMNPQR', ownerUserId: samRow.id }),
      )
    ).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };
    admin = { id: adminRow.id, role: 'ADMIN', cohort: 'default' };
    loner = { id: lonerRow.id, role: 'INSTRUCTOR', cohort: 'default' };

    for (const name of ['Ada', 'Bo', 'Cy']) {
      const row = await saveUser({ email: `${name}@class-learners.test`, displayName: name, cohort: tuesday });
      tuesdayLearners.push(row.id);
      await enrol(row.id);
    }
    tuesdayLearners.sort();
    thursdayLearner = (await saveUser({ email: 'ola@class-learners.test', displayName: 'Ola', cohort: thursday })).id;
    await enrol(thursdayLearner);
    unattached = (await saveUser({ email: 'una@class-learners.test', displayName: 'Una' })).id;
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it("answers the caller's class, in id order, each learner exactly as the per-learner read does", async () => {
    const page = await service.classLearnerDetails(dana, {});
    expect(page.map((one) => one.userId)).toEqual(tuesdayLearners);
    for (const one of page) expect(one).toEqual(await service.learnerDetail(dana, one.userId));
    expect(page[0].enrollments).toHaveLength(1);
    expect(page[0].cohortName).toBe('Tuesday class');
  });

  it('narrows to one class, and a class outside the caller\'s scope is empty rather than a leak', async () => {
    expect((await service.classLearnerDetails(dana, { cohort: tuesday })).map((one) => one.userId)).toEqual(
      tuesdayLearners,
    );
    expect(await service.classLearnerDetails(dana, { cohort: thursday })).toEqual([]);
    expect((await service.classLearnerDetails(sam, {})).map((one) => one.userId)).toEqual([thursdayLearner]);
    // an instructor with no class of their own reaches nobody, as every
    // instructor read answers them; `default` is not a class
    expect(await service.classLearnerDetails(loner, {})).toEqual([]);
    expect(await service.classLearnerDetails(loner, { cohort: 'default' })).toEqual([]);
    expect(await service.classLearnerDetails(dana, { cohort: 'default' })).toEqual([]);
  });

  it('gives an admin every learner, and one class when asked, as the per-learner read does', async () => {
    const all = (await service.classLearnerDetails(admin, {})).map((one) => one.userId);
    expect(all).toEqual([...tuesdayLearners, thursdayLearner, unattached].sort());
    expect((await service.classLearnerDetails(admin, { cohort: thursday })).map((one) => one.userId)).toEqual([
      thursdayLearner,
    ]);
    expect((await service.classLearnerDetails(admin, { cohort: 'default' })).map((one) => one.userId)).toEqual([
      unattached,
    ]);
    // staff are never in it
    expect(all).not.toContain(dana.id);
  });

  it('is bounded: a page holds at most CLASS_LEARNERS_PAGE learners, and the id cursor walks the rest', async () => {
    expect(CLASS_LEARNERS_PAGE).toBe(50);
    const first = await service.classLearnerDetails(dana, { limit: 2 });
    expect(first.map((one) => one.userId)).toEqual(tuesdayLearners.slice(0, 2));
    const rest = await service.classLearnerDetails(dana, { limit: 2, after: first[1].userId });
    expect(rest.map((one) => one.userId)).toEqual(tuesdayLearners.slice(2));
    expect(await service.classLearnerDetails(dana, { limit: 2, after: tuesdayLearners[2] })).toEqual([]);
    // a limit above the page is the page, never more
    const spy = jest.spyOn(service, 'learnerDetail');
    await service.classLearnerDetails(admin, { limit: 10_000 });
    expect(spy.mock.calls.length).toBeLessThanOrEqual(CLASS_LEARNERS_PAGE);
    spy.mockRestore();
  });

  it('writes nothing: no audit row and no other row moves', async () => {
    const before = await census();
    await service.classLearnerDetails(admin, {});
    await service.classLearnerDetails(dana, { cohort: tuesday });
    expect(await census()).toEqual(before);
    expect(await manager().count(AuditEventEntity)).toBe(before.AuditEventEntity);
  });

  it('refuses a learner the per-learner read refuses, so the two can never disagree', async () => {
    // the same function decides both: a learner outside Dana's scope is a 404
    // there and absent here
    await expect(service.learnerDetail(dana, thursdayLearner)).rejects.toThrow(NotFoundException);
    expect((await service.classLearnerDetails(dana, {})).map((one) => one.userId)).not.toContain(thursdayLearner);
  });

  it('holds the query to its shape at the pipe: a limit of 1..50, a uuid cursor, a bounded class id', async () => {
    const errors = async (query: Record<string, unknown>) =>
      (await validate(plainToInstance(ClassLearnersQuery, query) as object, { whitelist: true })).map(
        (one) => one.property,
      );
    expect(await errors({})).toEqual([]);
    expect(await errors({ cohort: tuesday, limit: '50', after: tuesdayLearners[0] })).toEqual([]);
    expect(await errors({ limit: '51' })).toEqual(['limit']);
    expect(await errors({ limit: '0' })).toEqual(['limit']);
    expect(await errors({ after: 'not-a-uuid' })).toEqual(['after']);
    expect(await errors({ cohort: 'x'.repeat(65) })).toEqual(['cohort']);
  });

  // Last, because it gives Dana a second class and every case above reads her
  // scope as one.
  it('narrows a teacher of two classes to the one asked for, and reads both without it', async () => {
    const wednesday = (
      await manager().save(
        manager().create(CohortEntity, { name: 'Wednesday class', joinCode: 'STUVWXYZ', ownerUserId: dana.id }),
      )
    ).id;
    const wes = (await saveUser({ email: 'wes@class-learners.test', displayName: 'Wes', cohort: wednesday })).id;
    // Dana's scope is now `In([tuesday, wednesday])`, and the class filter is
    // the conjunction of that operator and the one class asked for
    expect((await service.classLearnerDetails(dana, {})).map((one) => one.userId)).toEqual(
      [...tuesdayLearners, wes].sort(),
    );
    expect((await service.classLearnerDetails(dana, { cohort: wednesday })).map((one) => one.userId)).toEqual([wes]);
    expect((await service.classLearnerDetails(dana, { cohort: tuesday })).map((one) => one.userId)).toEqual(
      tuesdayLearners,
    );
    expect(await service.classLearnerDetails(dana, { cohort: thursday })).toEqual([]);
    expect((await service.learnerDetail(dana, wes)).cohortName).toBe('Wednesday class');
  });
});
