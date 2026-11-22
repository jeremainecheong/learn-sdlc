import { NotFoundException } from '@nestjs/common';
import { EntityManager, Equal, FindOperator, FindOptionsWhere, In } from 'typeorm';
import type { AuthUser } from '../auth/auth.decorators';
import { CohortEntity, UserEntity } from '../db/entities';
import { UUID_PATTERN } from '../db/uuid';

export type InstructorCaller = Pick<AuthUser, 'id' | 'role' | 'cohort'>;

/**
 * Where every account starts. It is not a class: it is the absence of one,
 * and `UserEntity.cohort` defaults to it, so it names both the learners who
 * have not typed a join code and the staff nobody has put anywhere.
 */
export const UNATTACHED_COHORT = 'default';

/**
 * Which learners an instructor may see: everyone in a class they created,
 * plus their own cohort column when that is a real class. Creating a class
 * moves the creator into it, so an instructor with two classes would
 * otherwise only ever see the newest one.
 *
 * `default` is dropped, because it is not a class. An instructor an admin
 * created a minute ago is still sitting in it, and folding it into the scope
 * handed them every learner who registered without a join code (address,
 * transcript, budget lever and override) from an account that had been
 * given no class at all. Unattached learners are an admin's to see, and an
 * admin's scope is every learner anyway.
 *
 * So an instructor with no class of their own matches no learner: `In([])`
 * compiles to `0=1` on both dialects, which is the honest answer to "who is
 * in my class" asked before there is one. Cohort ids are uuids, so no real
 * class can collide with the sentinel.
 */
export async function learnerScope(
  manager: EntityManager,
  caller: InstructorCaller,
): Promise<FindOptionsWhere<UserEntity>> {
  if (caller.role === 'ADMIN') return { role: 'LEARNER' };
  const owned = await manager.find(CohortEntity, {
    where: { ownerUserId: caller.id },
    select: ['id'],
  });
  const cohorts = [...new Set([caller.cohort, ...owned.map((c) => c.id)])].filter(
    (cohort) => cohort !== UNATTACHED_COHORT,
  );
  return { role: 'LEARNER', cohort: cohorts.length === 1 ? cohorts[0] : In(cohorts) };
}

/**
 * One learner the caller is allowed to see, or a 404.
 *
 * The refusal is a 404 rather than a 403 so that guessing ids tells a second
 * instructor nothing about which ids exist in other classes, and the id is
 * shape-checked before the query because Postgres raises on a malformed uuid
 * and that surfaces as a 500 where a 404 is the truth.
 *
 * A separate module rather than part of `InstructorService`, so the view-as read routes
 * can go through exactly this function rather than a second copy of it: the
 * whole safety of that feature is that it reaches a learner the same way every
 * other instructor read does.
 */
export async function scopedLearner(
  manager: EntityManager,
  caller: InstructorCaller,
  userId: string,
): Promise<UserEntity> {
  const learner = UUID_PATTERN.test(userId)
    ? await manager.findOne(UserEntity, {
        where: { id: userId, ...(await learnerScope(manager, caller)) },
      })
    : null;
  if (!learner) throw new NotFoundException('no learner with that id in your class');
  return learner;
}

/**
 * The caller's scope narrowed to one class, for the two class exports'
 * optional `?cohort=`: a class page downloads that class's grade
 * book, and no other class's learner is in the file.
 *
 * A class outside the caller's scope is the 404 every other instructor read
 * gives (`assertClassInScope`), before any learner is read, so a
 * guessed id tells a second teacher nothing. An admin may name any class that
 * exists, and `default`, the unattached learners, which are an admin's too.
 */
export async function classScope(
  manager: EntityManager,
  caller: InstructorCaller,
  cohort: string,
): Promise<FindOptionsWhere<UserEntity>> {
  const scope = await learnerScope(manager, caller);
  await assertClassInScope(manager, caller, scope, cohort);
  return { ...scope, cohort: Equal(cohort) };
}

/**
 * A class the caller may read, or the 404 every other instructor read gives
 * for something outside the caller's classes. `scope` is the caller's
 * `learnerScope`, already read, so this adds no query for a non-admin; an
 * admin's class is counted, and `default` is an admin's without a read.
 */
export async function assertClassInScope(
  manager: EntityManager,
  caller: InstructorCaller,
  scope: FindOptionsWhere<UserEntity>,
  cohort: string,
): Promise<void> {
  const refuse = () => new NotFoundException('no class with that id in your classes');
  if (caller.role === 'ADMIN') {
    if (cohort !== UNATTACHED_COHORT) {
      if (!UUID_PATTERN.test(cohort)) throw refuse();
      if (!(await manager.count(CohortEntity, { where: { id: cohort } }))) throw refuse();
    }
  } else if (!scopedCohortIds(scope).includes(cohort)) {
    throw refuse();
  }
}

/** The classes a non-admin scope reads: one id, the `In([...])` of several, or none. */
function scopedCohortIds(scope: FindOptionsWhere<UserEntity>): string[] {
  const cohort = scope.cohort as string | FindOperator<string> | undefined;
  if (cohort === undefined) return [];
  if (typeof cohort === 'string') return [cohort];
  const value: unknown = cohort.value;
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * The class's name as a file name can carry it (`tuesday-class`), for the
 * class export's file name; the id's first eight characters when the name
 * leaves nothing, so two classes' files never share one name by accident.
 */
export async function classFileLabel(manager: EntityManager, cohort: string): Promise<string> {
  const row = UUID_PATTERN.test(cohort)
    ? await manager.findOne(CohortEntity, { where: { id: cohort }, select: ['id', 'name'] })
    : null;
  const slug = (row?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || cohort.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'class';
}

/**
 * Class names by id, for a reader who would otherwise see a raw cohort id.
 * Duplicates and `default` (no class) are dropped before the one read; an id
 * with no class row is simply absent from the map.
 */
export async function cohortNamesById(manager: EntityManager, cohortIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(cohortIds)].filter((id) => id !== UNATTACHED_COHORT);
  if (!ids.length) return new Map();
  const rows = await manager.find(CohortEntity, { where: { id: In(ids) }, select: ['id', 'name'] });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * How many learners each class holds, for any number of classes in one
 * GROUP BY. A class with no learner is absent from the map, so a reader takes
 * `?? 0`.
 */
export async function learnerCountsByCohort(manager: EntityManager, cohortIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!cohortIds.length) return counts;
  const rows = await manager
    .createQueryBuilder(UserEntity, 'u')
    .select('u.cohort', 'cohort')
    .addSelect('COUNT(*)', 'members')
    .where('u.role = :role', { role: 'LEARNER' })
    .andWhere('u.cohort IN (:...ids)', { ids: [...new Set(cohortIds)] })
    .groupBy('u.cohort')
    .getRawMany<{ cohort: string; members: string | number }>();
  // PostgreSQL returns COUNT as a string (bigint), sqlite as a number.
  for (const row of rows) counts.set(row.cohort, Number(row.members));
  return counts;
}

/** The class this learner is in, or null for one who has not joined a class. */
export async function cohortNameOf(
  manager: EntityManager,
  cohort: string,
): Promise<string | null> {
  if (!cohort || cohort === UNATTACHED_COHORT) return null;
  const row = await manager.findOne(CohortEntity, {
    where: { id: cohort },
    select: ['id', 'name'],
  });
  return row?.name ?? null;
}
