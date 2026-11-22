import { EntityManager } from 'typeorm';
import { SubmissionEntity } from '../db/entities';
import type { NewestSubmission } from './queries';

/** One task's newest attempt on one phase state, as decided by the database. */
export interface NewestTaskSubmission extends NewestSubmission {
  /** `''` on a sole-task phase, and on every revision written before tasks were keyed. */
  taskKey: string;
}

/**
 * The newest submission per `(phase state, task)`, decided in SQL rather than
 * in JavaScript.
 *
 * The sibling `newestSubmissionsPerPhaseState` (`analytics.service.ts`) answers
 * one row per phase state and keeps its name, its query and its three callers:
 * it is *last activity on this phase*, which stays the right question for the
 * console's idle window and the CSV's activity column. This is the other
 * question the task grain makes askable (*the newest revision of this task*)
 * and two readers need it: the class map's rule tally, which has to read the
 * report of the task that owns each rule rather than whichever task the learner
 * submitted last, and the regrade, whose candidate is one learner per task.
 *
 * It lives in a module of its own because both of those readers consume it and
 * neither owns it, and a function one of them wrote for the other is a
 * build-order edge between two things that are meant to be independent.
 *
 * The shape is the sibling's, and deliberately so (same aggregate, same
 * tie-break, same quoting) with `taskKey` added to the grouping and to the
 * join. Three details are inherited rather than reinvented, each for its own
 * recorded reason:
 *
 * - **`MAX(CAST(id AS text))`**, not `MAX(id)`: Postgres has no `max(uuid)`
 *   aggregate before 18 and the deployed stack is 16. The cast is
 *   order-preserving on both dialects, so the row picked is the row
 *   `ORDER BY id DESC` picks; the tie-break every other reader of this table
 *   uses.
 * - **Quoted subquery columns**; `"m"."maxAt"`, not `m.maxAt`: `m` is a
 *   derived table with no entity metadata, so the query builder passes the
 *   reference through verbatim and Postgres would fold an unquoted one to lower
 *   case and answer `column m.maxat does not exist`.
 * - **`"s"."taskKey"`, quoted, rather than the property path `s.taskKey`.** The
 *   column is added by migration H3 and declared on the entity; a property path
 *   is resolved against entity metadata while a quoted column reference is
 *   passed through, so the quoted form does not depend on the entity. The
 *   emitted SQL is identical either way, on both dialects.
 *
 * An explicit order, which the sibling does not have: the rows are a map's
 * worth of keys and callers build a `Map` from them, so the cost is a sort over
 * one row per task and the benefit is that two runs of the same query are
 * comparable, which is what lets a spec hold this function against its
 * sibling row for row.
 *
 * The four-column index `(phaseStateId, taskKey, createdAt, id)` is what the
 * inner `MAX` seeks on.
 */
export async function newestSubmissionsPerTask(
  manager: EntityManager,
  phaseStateIds: string[],
): Promise<NewestTaskSubmission[]> {
  if (!phaseStateIds.length) return [];
  return manager
    .createQueryBuilder(SubmissionEntity, 's')
    .select('s.phaseStateId', 'phaseStateId')
    .addSelect('s.userId', 'userId')
    .addSelect('"s"."taskKey"', 'taskKey')
    .addSelect('"m"."maxAt"', 'createdAt')
    .addSelect('MAX(CAST(s.id AS text))', 'id')
    .innerJoin(
      (sub) =>
        sub
          .select('n.phaseStateId', 'psid')
          .addSelect('"n"."taskKey"', 'tkey')
          .addSelect('MAX(n.createdAt)', 'maxAt')
          .from(SubmissionEntity, 'n')
          .where('n.phaseStateId IN (:...phaseStateIds)')
          .groupBy('n.phaseStateId')
          .addGroupBy('"n"."taskKey"'),
      'm',
      '"m"."psid" = s.phaseStateId AND "m"."tkey" = "s"."taskKey" AND s.createdAt = "m"."maxAt"',
    )
    .setParameter('phaseStateIds', phaseStateIds)
    .groupBy('s.phaseStateId')
    .addGroupBy('s.userId')
    .addGroupBy('"s"."taskKey"')
    .addGroupBy('"m"."maxAt"')
    .orderBy('s.phaseStateId', 'ASC')
    .addOrderBy('"s"."taskKey"', 'ASC')
    .getRawMany<NewestTaskSubmission>();
}
