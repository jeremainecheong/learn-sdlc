import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H4 — a quiz is a task, and a paper is a row.
 *
 * ## `quiz_attempts`
 *
 * One row per paper: drawn when a learner starts, closed when they hand it in.
 * A table rather than a column on `submissions`, because the paper has to exist
 * *before* a verdict does — a reload redraws the same questions in the same
 * order, and a cooldown measures from `startedAt`.
 *
 * The whole column list is declared here at once: `packVersion` is stamped
 * beside `submissions.packVersion`, and
 * `submissionId` links the revision the grader scored. A column added later is
 * a second migration against a table a term of coursework already lives in.
 *
 * Nothing in this table is the answer key. `QuizQuestion.correct` stays in the
 * pinned version's sealed `checks` slice, which `projectVersionId` names, and
 * `paper` carries question ids and option ids in display order — a draw and a
 * permutation, never a second copy of the bank.
 *
 * ## `epoch` and `voidedAt` — the recovery, and why they are columns
 *
 * A required quiz failed on every allowed attempt would lock its phase and
 * every phase after it with nothing in the product able to open them again. The teacher's
 * existing per-task `task-reset` is the recovery, and these two columns are
 * what make it one. `epoch` is stamped at start from `task_states.resetCount`,
 * so a reset starts a new run of the quiz and the spent count, the open-paper
 * lookup, the attempt numbering and `attemptsLeft` all quantify over the
 * current epoch alone; **no row is ever deleted**, so the teacher's view and
 * the learner's export still carry every paper. An integer rather than a
 * timestamp comparison, because a reset and a hand-in in the same millisecond
 * would otherwise leave it undecidable which side of the line a paper falls.
 * `voidedAt` is stamped on a paper the reset found open: it is closed so it
 * leaves `UQ_quiz_attempts_open` — which is deliberately **not** epoch-scoped,
 * because *at most one open paper per learner and task* is the whole of what
 * it guarantees — and marked so nothing mistakes a closed-but-never-sat paper
 * for a sheet.
 *
 * Neither column is in an index. Both are read only alongside `phaseStateId`
 * and `taskKey`, which `IDX_quiz_attempts_task` already leads with, and the
 * rows behind that seek are one learner's papers on one quiz.
 *
 * ## The three devices, and which one this migration creates
 *
 * `UQ_quiz_attempts_open` is the **idempotent-start** device and nothing else.
 * While a row has `submittedAt IS NULL` a second start cannot insert a second
 * paper, so the route hands back the open one rather than drawing again. Once
 * that row is closed it constrains nothing, which is exactly right and is why
 * it is neither of the other two:
 *
 * | Job | Device |
 * |---|---|
 * | A double **start** is idempotent | `UQ_quiz_attempts_open`, below |
 * | A **replay** of a handed-in paper is refused | an explicit `submittedAt IS NOT NULL` test on the hand-in route |
 * | The attempt **limit** | `COUNT(*) … WHERE submittedAt IS NOT NULL`, on `IDX_quiz_attempts_task`'s leading columns |
 *
 * `IDX_quiz_attempts_task` is `(phaseStateId, taskKey, createdAt)`: the two
 * leading columns are what that count and the learner's *attempts used and
 * left* read, and `createdAt` is what orders a task's papers without leaving
 * sqlite a temporary b-tree — the reason the B2 migration gives for the console indexes.
 * `IDX_quiz_attempts_user` is the column the export and the erasure walk.
 *
 * ## Parity, and the precedent that actually vouches for it
 *
 * `UQ_quiz_attempts_open`'s predicate is `"submittedAt" IS NULL`, and the
 * in-tree precedent for that shape is **`UQ_notifications_unread_subject`**
 * (`db/entities.ts`, created at `1788600000000-D4-Notifications.ts:71` and
 * `:83` — byte-identical `CREATE UNIQUE INDEX … WHERE "readAt" IS NULL` in the
 * Postgres and the sqlite arm). It is **not** `UQ_submissions_in_flight`,
 * `UQ_project_versions_draft` or `UQ_cohort_project_assignment_active`: all
 * three are status-string comparisons, which is the shape their own comments
 * vouch for — *"Postgres stores the predicate normalised — `((status)::text =
 * ANY (...))` — and still compares it equal"* — and not one of them says
 * anything about `IS NULL`. A parity spec written against the wrong precedent
 * proves the wrong thing.
 *
 * ## One new table, and the hazard it therefore never reaches
 *
 * This migration creates **one table and no column on an existing one**. The
 * sqlite driver's table-rebuild hazard — `addColumn`/`dropColumn` recreating a
 * table's indexes from a definition that has lost a partial index's `WHERE`,
 * which H3 and D4 each guard against — is not reached at all, in either
 * direction. A later migration that adds a column to this table must use raw
 * `ALTER TABLE "quiz_attempts" ADD COLUMN "x" varchar`, and the entity says so
 * beside the index.
 *
 * It also means the locks are on nothing a class is reading: `CREATE TABLE`
 * takes an ACCESS EXCLUSIVE on a table that did not exist a statement ago, and
 * the three index builds are on that same empty table. `SET lock_timeout =
 * '3s'` is still the first Postgres statement, in H3's shape and for H3's
 * reason — it bounds how long this migration **waits** behind a long-running
 * reader rather than piling a lock queue behind itself — and it is still not
 * the safety argument. Here the safety argument is that there is nothing to be
 * unsafe with.
 *
 * Reverting drops the table, so every paper in flight goes with it and a
 * learner mid-quiz starts again. Nothing else is lost: a scored attempt's
 * verdict is the `submissions` row it links to, and the task's best score is on
 * `task_states`.
 *
 * Both dialects are real (sqlite is the supported local-first store), and each direction refuses a third by
 * name rather than silently doing nothing. H1, H2 and H3 each declare their own
 * `typesFor`; this one declares its own, with a nullable `bool` beside H3's
 * `float` and `json`.
 */
export class H4QuizAttempts1789700000000 implements MigrationInterface {
  name = 'H4QuizAttempts1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = typesFor(queryRunner, this.name);
    // First, and Postgres only. It bounds the wait, not the hold — see above.
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(
      `CREATE TABLE "quiz_attempts" ("id" ${t.id}, "phaseStateId" ${t.str} NOT NULL, ` +
        `"userId" ${t.str} NOT NULL, "taskKey" ${t.str} NOT NULL, ` +
        `"epoch" ${t.int} NOT NULL DEFAULT 0, "voidedAt" ${t.str} NULL, ` +
        `"projectVersionId" ${t.str} NOT NULL, "packVersion" ${t.str} NULL, ` +
        `"submissionId" ${t.str} NULL, "paper" ${t.json} NOT NULL, ` +
        `"answers" ${t.json} NULL, "score" ${t.float} NULL, "passed" ${t.bool} NULL, ` +
        `"startedAt" ${t.str} NOT NULL, "submittedAt" ${t.str} NULL, ` +
        `"createdAt" ${t.created})`,
    );
    // The idempotent start, and only that. An open paper is one a learner may
    // come back to; a closed one is outside the predicate, so a task keeps its
    // whole back catalogue of attempts. `IS NULL` is the shape D4 proved on
    // both dialects — see the note above this class.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_attempts_open" ON "quiz_attempts" ("phaseStateId", "taskKey") WHERE "submittedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_attempts_user" ON "quiz_attempts" ("userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_attempts_task" ON "quiz_attempts" ("phaseStateId", "taskKey", "createdAt") `,
    );
  }

  /**
   * The reversal: each index before the table it is on, and nothing else
   * touched in either direction — this migration added no column to any
   * existing table, so there is none to take back and no rewrite to be careful
   * about.
   *
   * Index names are unqualified in both directions, as H3 writes them:
   * Postgres resolves them through `search_path`, which is what lets the
   * reversal be proved inside an isolated schema rather than only against
   * `public`.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const t = typesFor(queryRunner, this.name);
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    for (const name of [
      'IDX_quiz_attempts_task',
      'IDX_quiz_attempts_user',
      'UQ_quiz_attempts_open',
    ]) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "quiz_attempts"`);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class. H1, H2 and H3 each carry their own
// copy for the same reason, as D6 does with `isPostgres` / `isSqlite`.

/**
 * The dialect's own spelling of each type this migration writes, resolved once
 * so that both branches are one statement rather than two copies that drift —
 * and refusing a third dialect by name, which is the rule the D6 header set and
 * H1, H2 and H3 kept.
 *
 * `bool` is this migration's own addition to H3's list, and it is a **nullable**
 * boolean rather than H3's defaulted one: `passed` is null while a paper is
 * open. Both dialects spell it `boolean`, as `submissions.passed` already is on
 * each (`InitialSchema:41` and `:85`), so it is resolved here for symmetry with
 * the rest rather than because the two differ.
 */
interface DialectTypes {
  postgres: boolean;
  /** A generated uuid primary key, as every other table in this schema declares it. */
  id: string;
  str: string;
  /** H3's spelling, for `epoch` — the attempt epoch, defaulted rather than nullable. */
  int: string;
  float: string;
  bool: string;
  json: string;
  created: string;
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
    // H3's spelling, unchanged: both dialects take `integer`, and the column is
    // resolved here with the rest so that no type in this file is a literal.
    int: 'integer',
    float: postgres ? 'double precision' : 'float',
    bool: 'boolean',
    json: 'text',
    created: postgres
      ? 'TIMESTAMP NOT NULL DEFAULT now()'
      : "datetime NOT NULL DEFAULT (datetime('now'))",
  };
}
