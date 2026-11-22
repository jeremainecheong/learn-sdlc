import { EntityManager, In } from 'typeorm';
import { AssistantMessageEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';

/**
 * The class-wide reads the console and the learner detail share: one grouped
 * query each over any number of phase states, so a page costs the same few
 * queries for a class of one or of fifty. Plain functions over an
 * EntityManager, with no Nest service of their own.
 */

/**
 * Mentor hints per phase state (the learner's own messages) for any number
 * of phases in one GROUP BY. Shared with InstructorService so the two views of
 * a learner cannot disagree about what counts as a hint.
 */
export async function hintsByPhaseState(
  manager: EntityManager,
  phaseStateIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!phaseStateIds.length) return counts;
  const rows = await manager
    .createQueryBuilder(AssistantMessageEntity, 'm')
    .select('m.phaseStateId', 'phaseStateId')
    .addSelect('COUNT(*)', 'hints')
    .where('m.role = :role', { role: 'user' })
    .andWhere('m.phaseStateId IN (:...ids)', { ids: phaseStateIds })
    .groupBy('m.phaseStateId')
    .getRawMany<{ phaseStateId: string; hints: string | number }>();
  // Postgres returns COUNT as a string (bigint), sqlite as a number.
  for (const row of rows) counts.set(row.phaseStateId, Number(row.hints));
  return counts;
}

/**
 * The `task_states` rows of these phase states, grouped by phase state.
 *
 * This is the **one** read the two overview percentages
 * cost. It is keyed `phaseStateId IN (…)` for the whole class at once, so the
 * console asks it once whatever the class size, which is what the docstring on
 * `instructorOverview` promises and what that method's recorded query count
 * holds it to. One per learner would have been six queries a page for a class
 * of one and three hundred for a class of fifty.
 *
 * Exported beside `hintsByPhaseState` for the reason that one is exported: the
 * dashboard, the console and the gradebook read the same rows, and a second
 * copy of this query is how two surfaces come to disagree about one board.
 *
 * A board of **sole-task** phases (the shipped project's, on every phase)
 * holds no rows here at all, and that is not a gap: a sole task's numbers are
 * the phase row's, and `taskViews` reads them from there for the learner and
 * for the analytics and instructor services. The map simply comes back empty.
 */
export async function taskStatesByPhaseState(
  manager: EntityManager,
  phaseStateIds: string[],
): Promise<Map<string, TaskStateEntity[]>> {
  const grouped = new Map<string, TaskStateEntity[]>();
  if (!phaseStateIds.length) return grouped;
  const rows = await manager.find(TaskStateEntity, {
    where: { phaseStateId: In(phaseStateIds) },
  });
  for (const row of rows) {
    const held = grouped.get(row.phaseStateId);
    if (held) held.push(row);
    else grouped.set(row.phaseStateId, [row]);
  }
  return grouped;
}

/** One phase state's newest attempt, as decided by the database. */
export interface NewestSubmission {
  phaseStateId: string;
  userId: string;
  /** The submission id, ready to load by name. */
  id: string;
  /** `MAX(createdAt)`, in whatever shape the driver returns; `toDate` normalises it. */
  createdAt: unknown;
}

/**
 * The newest submission per phase state, decided in SQL rather than in
 * JavaScript.
 *
 * The class map and the CSV export each want one row per phase state; the
 * last thing the learner submitted. Asking for every submission the phase
 * states have ever carried, ordered newest first, and keeping the first per
 * phase state as the rows go past reads one row per attempt ever made by the
 * class: at 2,400 submissions for a fifty-learner cohort that is 18 ms of
 * driver work to find 300 rows, and at ten times the history 104 ms, and
 * better-sqlite3 does it on the event loop, so a console refreshing every
 * thirty seconds would also slow `/health/live`. In SQL the same answer is
 * 5 ms and 8 ms: what crosses the driver is one row per phase state whatever
 * the term has held.
 *
 * The tie-break is the greatest `id` among the rows sharing `MAX(createdAt)`,
 * which is exactly what `ORDER BY createdAt DESC, id DESC LIMIT 1` picks; the
 * ordering every other reader of this table uses (`FeedbackService.latestFor`).
 * Two submissions in the same second are ordinary on a machine whose
 * timestamps are second-resolution, and picking differently here would show
 * the console a different attempt from the one the learner is looking at.
 *
 * It is `MAX(CAST(id AS text))` rather than `MAX(id)` because Postgres has no
 * `max(uuid)` aggregate before 18 and `docker-compose.yml` pins 16: the plain
 * form answers `function max(uuid) does not exist` on the production stack
 * while passing on sqlite, where the column is text already. The cast is
 * order-preserving (Postgres compares a uuid as its sixteen bytes and prints
 * it as lower-case canonical hex, which sorts the same way) so the row picked
 * is the row `ORDER BY id DESC` picks, on both dialects.
 *
 * Written with the query builder so both dialects get their own placeholders,
 * and as an aggregate rather than a window function so the inner `MAX` is a
 * covering-index seek on `IDX_submissions_phase_state_created`.
 *
 * The subquery's columns are named with their quotes on; `"m"."maxAt"`, not
 * `m.maxAt`. `m` is a derived table, so it has no entity metadata and the
 * query builder passes those references through exactly as written; Postgres
 * folds an unquoted identifier to lower case and answers
 * `column m.maxat does not exist`, while sqlite compares identifiers without
 * case and does not care. The alias TypeORM emits for the subquery column is
 * quoted (`AS "maxAt"`), so quoting here is what makes the two agree.
 */
export async function newestSubmissionsPerPhaseState(
  manager: EntityManager,
  phaseStateIds: string[],
): Promise<NewestSubmission[]> {
  if (!phaseStateIds.length) return [];
  return manager
    .createQueryBuilder(SubmissionEntity, 's')
    .select('s.phaseStateId', 'phaseStateId')
    .addSelect('s.userId', 'userId')
    .addSelect('"m"."maxAt"', 'createdAt')
    .addSelect('MAX(CAST(s.id AS text))', 'id')
    .innerJoin(
      (sub) =>
        sub
          .select('n.phaseStateId', 'psid')
          .addSelect('MAX(n.createdAt)', 'maxAt')
          .from(SubmissionEntity, 'n')
          .where('n.phaseStateId IN (:...phaseStateIds)')
          .groupBy('n.phaseStateId'),
      'm',
      '"m"."psid" = s.phaseStateId AND s.createdAt = "m"."maxAt"',
    )
    .setParameter('phaseStateIds', phaseStateIds)
    .groupBy('s.phaseStateId')
    .addGroupBy('s.userId')
    .addGroupBy('"m"."maxAt"')
    .getRawMany<NewestSubmission>();
}
