import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H5 — which run of a task a submission belongs to.
 *
 * ## `submissions."resetEpoch" integer NULL`, no default
 *
 * The `task_states.resetCount` of the submission's task **at the moment the row
 * is inserted**, read under the enrolment lock in the same transaction that
 * snapshots the workspace and inserts the row. A reset (the teacher's
 * `task-reset`, or the learner's own) bumps `resetCount`, so a
 * verdict or a regrade that lands for a revision of an earlier run can be told
 * from one of the current run by comparing two integers — the rule
 * `quiz_attempts.epoch` already applies to papers (H4), extended to every task.
 *
 * **Nullable, and NULL means "the current run". It is not `DEFAULT 0`.** A
 * default would stamp 0 on every row already there, including a revision made
 * after a teacher reset while `resetCount` was already 1; a
 * later regrade would read that revision as another run and withhold an earned
 * pass, which is the worse failure `verdictIsOfAnotherRun`'s docstring names.
 * So NULL is written by, and read as the current run for:
 *
 * - every row that predates this migration;
 * - every row an API from before this migration writes during a rollback
 *   window (it does not know the column, so it inserts NULL);
 * - every sole-task (TaskTrackr) row, which has no task row to read an epoch
 *   from.
 *
 * No index names the column: it is read only for one submission id, through the
 * caller's manager, inside the enrolment lock.
 *
 * ## One statement, both dialects, and why it is raw
 *
 * `ALTER TABLE "submissions" ADD COLUMN "resetEpoch" integer` is valid on both.
 * It is raw rather than `queryRunner.addColumn` for the reason the D6 header
 * wrote down and H2 and H3 repeated: TypeORM's sqlite driver implements
 * `addColumn` as a table rebuild, and the rebuild recreates the table's
 * indexes from a definition that has lost the `WHERE` of a partial index —
 * which on `submissions` is `UQ_submissions_in_flight`, the double-submit
 * guard itself. sqlite's own `ADD COLUMN` needs no rebuild for a nullable
 * column with no default, and Postgres adds one as a catalogue change with no
 * table rewrite. It is also plain statement text in `up()`, so the release
 * tool's derivation reads it (`alteredTables=submissions`).
 *
 * On Postgres `SET lock_timeout = '3s'` comes first, in H3's and H4's shape:
 * the `ALTER` takes an ACCESS EXCLUSIVE lock for an instant, and the timeout
 * bounds how long it may WAIT behind a long reader, not how long it holds.
 *
 * Purely additive: one nullable column. No table is created or dropped, no
 * index is touched and no existing row is rewritten, so the table count stays
 * at 32 and every retained row keeps its bytes.
 */
export class H5SubmissionResetEpoch1789800000000 implements MigrationInterface {
  name = 'H5SubmissionResetEpoch1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = dialectOf(queryRunner, this.name);
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    // Raw on both dialects. See the note above this class.
    await queryRunner.query(`ALTER TABLE "submissions" ADD COLUMN "resetEpoch" integer`);
  }

  /**
   * Raw `DROP COLUMN` for the same reason `up` uses raw `ADD COLUMN`: the
   * driver's own `dropColumn` rebuilds `submissions` and would recreate the
   * in-flight guard without its `WHERE`. sqlite (≥ 3.35; the pinned toolchain
   * bundles 3.53) drops a column no index names in place, as H2's `down()`
   * already relies on for `enrollments."projectVersionId"`.
   *
   * Reverting forgets which run every revision belonged to, so a verdict for a
   * pre-reset revision would again move the current run's gate. Revert only a
   * deploy no learner or teacher has reset a task on since it went live.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const t = dialectOf(queryRunner, this.name);
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "resetEpoch"`);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class. H1–H4 each carry their own copy
// for the same reason, as D6 does with `isPostgres` / `isSqlite`.

interface Dialect {
  postgres: boolean;
}

/** Which of the two supported dialects this is, refusing a third by name. */
function dialectOf(queryRunner: QueryRunner, migration: string): Dialect {
  const type = queryRunner.connection.options.type;
  const postgres = type === 'postgres';
  const sqlite = type === 'better-sqlite3' || type === 'sqlite';
  if (!postgres && !sqlite) {
    throw new Error(
      `${migration} has no statements for "${type}". ` +
        'This deployment supports postgres (docker-compose.yml) and better-sqlite3 ' +
        '(the local-first path, docs/production-runbook.md §3a).',
    );
  }
  return { postgres };
}
