import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { CohortEntity, UserEntity } from '../db/entities';
import { InstructorCaller, learnerScope } from './cohort-scope';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Who an instructor may see.
 *
 * The scope is asserted the way it is used (as the `where` of a real query)
 * rather than by its shape, because the shape has more than one spelling
 * (`cohort: 'x'` and `In(['x'])` mean the same thing) and the rows it returns
 * are what a learner's privacy actually rests on.
 */
describe('learnerScope', () => {
  let dataSource: DataSource;

  /** Every learner this instructor may read, by address. */
  async function visibleTo(caller: InstructorCaller): Promise<string[]> {
    const manager = dataSource.manager;
    const rows = await manager.find(UserEntity, {
      where: await learnerScope(manager, caller),
      order: { email: 'ASC' },
    });
    return rows.map((row) => row.email);
  }

  async function learner(email: string, cohort: string): Promise<UserEntity> {
    return dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email,
        passwordHash: 'not-a-password',
        displayName: email,
        role: 'LEARNER',
        cohort,
      }),
    );
  }

  async function staff(email: string, role: 'INSTRUCTOR' | 'ADMIN', cohort = 'default') {
    return dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email,
        passwordHash: 'not-a-password',
        displayName: email,
        role,
        cohort,
      }),
    );
  }

  async function cohort(name: string, ownerUserId: string): Promise<CohortEntity> {
    return dataSource.manager.save(
      dataSource.manager.create(CohortEntity, { name, joinCode: name.toUpperCase(), ownerUserId }),
    );
  }

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.manager.clear(CohortEntity);
    await dataSource.manager.clear(UserEntity);
    // The learners nobody has claimed: registered, never typed a join code.
    await learner('unattached-a@school.test', 'default');
    await learner('unattached-b@school.test', 'default');
  });

  it('shows an instructor who has no class of their own nobody at all', async () => {
    const fresh = await staff('new-instructor@school.test', 'INSTRUCTOR');
    expect(fresh.cohort).toBe('default');

    expect(await visibleTo({ id: fresh.id, role: 'INSTRUCTOR', cohort: fresh.cohort })).toEqual([]);
  });

  it('shows an instructor their own class, and still not the unattached', async () => {
    const owner = await staff('owner@school.test', 'INSTRUCTOR');
    const sectionA = await cohort('section-a', owner.id);
    // create() moves the creator into the class it made.
    await dataSource.manager.update(UserEntity, { id: owner.id }, { cohort: sectionA.id });
    await learner('ada@school.test', sectionA.id);

    expect(await visibleTo({ id: owner.id, role: 'INSTRUCTOR', cohort: sectionA.id })).toEqual([
      'ada@school.test',
    ]);
  });

  it('shows an instructor every class they own, not only the newest', async () => {
    const owner = await staff('owner@school.test', 'INSTRUCTOR');
    const first = await cohort('section-a', owner.id);
    const second = await cohort('section-b', owner.id);
    await learner('ada@school.test', first.id);
    await learner('grace@school.test', second.id);
    // Another instructor's class stays theirs.
    const other = await staff('other@school.test', 'INSTRUCTOR');
    const theirs = await cohort('cs101', other.id);
    await learner('linus@school.test', theirs.id);

    expect(await visibleTo({ id: owner.id, role: 'INSTRUCTOR', cohort: second.id })).toEqual([
      'ada@school.test',
      'grace@school.test',
    ]);
  });

  it('shows an admin every learner, the unattached included', async () => {
    const admin = await staff('admin@school.test', 'ADMIN');
    const someone = await staff('owner@school.test', 'INSTRUCTOR');
    const sectionA = await cohort('section-a', someone.id);
    await learner('ada@school.test', sectionA.id);

    expect(await visibleTo({ id: admin.id, role: 'ADMIN', cohort: 'default' })).toEqual([
      'ada@school.test',
      'unattached-a@school.test',
      'unattached-b@school.test',
    ]);
  });

  it('never puts staff in an instructor’s scope, whatever class they sit in', async () => {
    const owner = await staff('owner@school.test', 'INSTRUCTOR');
    const sectionA = await cohort('section-a', owner.id);
    await dataSource.manager.update(UserEntity, { id: owner.id }, { cohort: sectionA.id });
    await staff('co-teacher@school.test', 'INSTRUCTOR', sectionA.id);
    await learner('ada@school.test', sectionA.id);

    expect(await visibleTo({ id: owner.id, role: 'INSTRUCTOR', cohort: sectionA.id })).toEqual([
      'ada@school.test',
    ]);
  });
});
