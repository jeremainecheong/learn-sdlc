import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H3 — a phase stops being one piece of work.
 *
 * ## `task_states`
 *
 * One row per **authored** task of a phase, per learner. A phase whose compiled
 * list is exactly one task keyed `SOLE_TASK_KEY` gets no row at all, so the
 * imported default project is untouched by this table — no row, no query, no
 * behaviour. Every phase of every *teacher-authored* project declares one task
 * keyed `main`, so those get a row on every phase of every kind, which is why
 * the column list is the final one: `ranBeforeSubmit`, `awaitingSignOff`,
 * `signedOffBy`, `resetAt` and `resetCount` are all declared here at once. A
 * column added later is a second migration
 * against a table a term of coursework already lives in.
 *
 * `updatedAt` is spelled `${t.created}` — a DEFAULT that fires on insert and
 * never again. `TaskStateEntity` declares it `@UpdateDateColumn`, and TypeORM
 * is what moves it on a write, exactly as it does for `phase_states.updatedAt`
 * (the behaviour C6's header records in as many words). The two halves are one
 * decision: the reader is a grouped `MAX("updatedAt")`, and the DDL alone would
 * make it answer the insert time for ever.
 *
 * ## `task_resets`
 *
 * A copy of a task's files at each task reset. `RetentionService.sweep` prunes
 * it by **bytes** (`files` emptied to `{}` on all but the newest three per
 * task state; the column is NOT NULL), not by rows.
 *
 * ## `submissions.taskKey`, and the guard it re-cuts
 *
 * A revision is now a statement about one task. `''` is the compiled sole
 * task's own key, so a revision of the default project reads exactly what it
 * read before; it is also this migration's backfill default, which is a
 * different fact about the same string — a revision handed in before this
 * migration carries no key of its own, and which task it belongs to is a question
 * the row writers answer against the board rather than one a migration may.
 *
 * `UQ_submissions_in_flight` is dropped and recreated on `(phaseStateId,
 * taskKey)`: two tasks of one written phase are two pieces of work and a
 * learner may have both in flight. Drop-then-create, never the other way round,
 * because the name is the same one. `IDX_submissions_task_created` is **new**
 * beside `IDX_submissions_phase_state_created` rather than a widening of it:
 * putting `taskKey` in position two would destroy the prefix
 * `newestSubmissionsPerPhaseState`'s `MAX("createdAt") … GROUP BY
 * "phaseStateId"` seeks on. This migration does not touch that index in either
 * direction, which is also what lets `down()` revert to an empty file.
 *
 * ## The locks this takes on a live PostgreSQL, and for how long
 *
 * `database.module.ts`'s `migrationSettings` sets no `migrationsTransactionMode`,
 * so TypeORM's default — `all` — runs the whole batch in **one transaction**.
 * That decides everything else:
 *
 * | Statement | Lock on `submissions` | Held until |
 * |---|---|---|
 * | `ALTER TABLE ADD "taskKey" … DEFAULT ''` | ACCESS EXCLUSIVE | commit |
 * | `CREATE INDEX IDX_submissions_task_created` | SHARE | commit |
 * | `DROP INDEX UQ_submissions_in_flight` | ACCESS EXCLUSIVE | commit |
 * | `CREATE UNIQUE INDEX UQ_submissions_in_flight` | SHARE | commit |
 *
 * So the class is locked out of the hot table for the duration of both index
 * builds, not for three seconds. `SET lock_timeout = '3s'` is the first
 * Postgres statement and is worth having — it bounds how long this migration
 * **waits** behind a long-running reader rather than piling a lock queue behind
 * itself — but it is **not** the safety argument and must not be read as one.
 * `CREATE INDEX CONCURRENTLY` is unavailable for the same reason the hold is
 * long: it cannot run inside a transaction block and TypeORM is running one.
 * When the timeout fires the whole batch aborts — one transaction, one
 * rollback, nothing half applied — so the runbook line is *run H3 in a quiet
 * window; if it aborts on `lock_timeout`, nothing was applied and it may simply
 * be run again.*
 *
 * Neither the Postgres `ALTER` nor the sqlite one rewrites a row: Postgres 11+
 * makes a non-volatile default metadata-only, and sqlite records the default in
 * the schema and applies it on read. The sqlite branch adds its column with raw
 * `ALTER TABLE … ADD COLUMN` rather than `queryRunner.addColumn`, for the
 * reason the D6 header wrote down and H2 repeated: the driver implements
 * `addColumn` as a table rebuild, and the rebuild recreates the table's indexes
 * from a definition that has lost the `WHERE` of a partial index — which on
 * `submissions` is the double-submit guard itself.
 *
 * Both dialects are real (sqlite is the supported local-first store), and each direction refuses a third by
 * name rather than silently doing nothing. H1 and H2 each declare their own
 * `typesFor`; this one declares its own, with `float`, `int` and `json` beside
 * their seven.
 */
export class H3TaskStates1789600200000 implements MigrationInterface {
  name = 'H3TaskStates1789600200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = typesFor(queryRunner, this.name);
    // First, and Postgres only. It bounds the wait, not the hold — see above.
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(
      `CREATE TABLE "task_states" ("id" ${t.id}, "phaseStateId" ${t.str} NOT NULL, ` +
        `"userId" ${t.str} NOT NULL, "taskKey" ${t.str} NOT NULL, ` +
        `"status" ${t.str} NOT NULL DEFAULT ${t.lit('in_progress')}, ` +
        `"bestScore" ${t.float} NULL, "attempts" ${t.int} NOT NULL DEFAULT 0, ` +
        `"ranBeforeSubmit" ${t.bool(false)}, "passedAt" ${t.str} NULL, ` +
        `"solutionReadAt" ${t.str} NULL, "awaitingSignOff" ${t.bool(false)}, ` +
        `"signedOffBy" ${t.str} NULL, "signedOffAt" ${t.str} NULL, ` +
        `"resetAt" ${t.str} NULL, "resetCount" ${t.int} NOT NULL DEFAULT 0, ` +
        `"createdAt" ${t.created}, "updatedAt" ${t.created})`,
    );
    // The natural key. Enrolment writes these rows one at a time and the board
    // repair fills what it missed, so two passes must not be able to leave two
    // rows for one task — a learner would then have two of the same piece of
    // work, one of which the gate reads.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_task_states_key" ON "task_states" ("phaseStateId", "taskKey") `,
    );
    await queryRunner.query(`CREATE INDEX "IDX_task_states_user" ON "task_states" ("userId") `);

    await queryRunner.query(
      `CREATE TABLE "task_resets" ("id" ${t.id}, "taskStateId" ${t.str} NOT NULL, ` +
        `"userId" ${t.str} NOT NULL, "files" ${t.json} NOT NULL, "createdAt" ${t.created})`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_task_resets_user" ON "task_resets" ("userId") `);

    // Raw on both dialects. See the note above this class.
    await queryRunner.query(
      t.postgres
        ? `ALTER TABLE "submissions" ADD "taskKey" ${t.str} NOT NULL DEFAULT ${t.lit('')}`
        : `ALTER TABLE "submissions" ADD COLUMN "taskKey" ${t.str} NOT NULL DEFAULT ${t.lit('')}`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_submissions_task_created" ON "submissions" ("phaseStateId", "taskKey", "createdAt", "id") `,
    );
    // Drop then create, because the guard keeps its name. A status comparison
    // is the shape Postgres normalises to and still compares equal, which is
    // what the codebase's own parity note vouches for.
    await queryRunner.query(`DROP INDEX "UQ_submissions_in_flight"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_submissions_in_flight" ON "submissions" ("phaseStateId", "taskKey") WHERE status IN ('queued','running')`,
    );
  }

  /**
   * The reversal, in the order required: the indexes naming `taskKey` before
   * the column, the column before the tables, and each table's indexes before
   * the table.
   *
   * **The in-flight rows are written off before the one-column index comes
   * back, and that is not tidiness.** Restoring `UNIQUE (phaseStateId) WHERE
   * status IN ('queued','running')` on a populated database raises a unique
   * violation exactly when two in-flight submissions share a phase state —
   * which is the state this migration exists to allow. A fresh file never reaches
   * it, so `database.module.spec.ts`'s revert would never have seen it;
   * `task-state-migration.spec.ts` proves it on a populated one. The statement
   * shape is the one `feedback.service.ts` uses to write off a stalled
   * revision: scoped to the status it is being read at, so a verdict that
   * landed in the meantime is never overwritten.
   *
   * Reverting discards every task row, so a split phase's learners come back to
   * a board that cannot describe their work. Revert only a deploy no teacher
   * has published a split phase against — and, per the runbook, run
   * `migration:revert` once against every database that ran this.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const t = typesFor(queryRunner, this.name);
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(`DROP INDEX "UQ_submissions_in_flight"`);
    // sqlite refuses to drop a column an index names, and this one names it.
    await queryRunner.query(`DROP INDEX "IDX_submissions_task_created"`);

    await queryRunner.query(
      `UPDATE "submissions" SET "status" = 'failed', ` +
        `"error" = '${ROLLBACK_INTERRUPTION}' ` +
        `WHERE "status" IN ('queued','running')`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_submissions_in_flight" ON "submissions" ("phaseStateId") WHERE status IN ('queued','running')`,
    );
    await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "taskKey"`);

    await queryRunner.query(`DROP INDEX "IDX_task_resets_user"`);
    await queryRunner.query(`DROP TABLE "task_resets"`);
    for (const name of ['IDX_task_states_user', 'UQ_task_states_key']) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "task_states"`);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class. H1 and H2 each carry their own
// copy for the same reason, as D6 does with `isPostgres` / `isSqlite`.

/**
 * What a learner is told about a revision the rollback interrupted. It is a
 * fact and an instruction, in that order, because the only thing they can do
 * about it is hand the work in again.
 */
const ROLLBACK_INTERRUPTION =
  'This submission was interrupted by a release rollback. Submit again.';

/**
 * The dialect's own spelling of each type this migration writes, resolved once
 * so that both branches are one statement rather than two copies that drift —
 * and refusing a third dialect by name, which is the rule the D6 header set and
 * H1 and H2 kept.
 *
 * `float`, `int` and `json` are this migration's own additions to H1's seven:
 * `double precision` against `float` (`InitialSchema` writes both), `integer`
 * on either, and a JSON document stored as `text` on either, which is what
 * TypeORM's `simple-json` maps to.
 *
 * Index names are unqualified in both directions: Postgres resolves them
 * through `search_path`, which is what lets the reversal be proved inside an
 * isolated schema rather than only against `public`.
 */
interface DialectTypes {
  postgres: boolean;
  /** A generated uuid primary key, as every other table in this schema declares it. */
  id: string;
  str: string;
  float: string;
  int: string;
  json: string;
  created: string;
  bool(value: boolean): string;
  lit(value: string): string;
}

function typesFor(queryRunner: QueryRunner, migration: string): DialectTypes {
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
  return {
    postgres,
    id: postgres
      ? 'uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY'
      : 'varchar PRIMARY KEY NOT NULL',
    str: postgres ? 'character varying' : 'varchar',
    float: postgres ? 'double precision' : 'float',
    int: 'integer',
    json: 'text',
    created: postgres
      ? 'TIMESTAMP NOT NULL DEFAULT now()'
      : "datetime NOT NULL DEFAULT (datetime('now'))",
    bool: (value: boolean) =>
      postgres
        ? `boolean NOT NULL DEFAULT ${value ? 'true' : 'false'}`
        : `boolean NOT NULL DEFAULT (${value ? 1 : 0})`,
    lit: (value: string) => (postgres ? `'${value}'` : `('${value}')`),
  };
}
