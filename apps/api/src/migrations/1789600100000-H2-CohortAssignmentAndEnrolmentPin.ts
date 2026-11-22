import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H2 — the class's project, and the pin.
 *
 * ## `enrollments.projectVersionId`
 *
 * The pin. `packVersion` beside it is the stamped *string*, added so that "a
 * regrade after a rubric fix is not guesswork"; this is the version itself, and
 * it is what makes "a change never alters an in-flight attempt" a property of
 * the database rather than a hope. A published version is immutable, so a
 * learner resolved to one cannot have a rubric, a hidden suite or a phase title
 * move under an attempt. Nullable, because an enrolment made before the model
 * existed has no pin and the read resolves the published head for it.
 *
 * ## `cohort_project_assignments`
 *
 * Which project a class is working, with a reason and an actor. The class
 * panel writes it and step 2 of the default resolution reads it. The risky
 * part is a partial unique index that has to satisfy the schema builder's zero-pending-queries
 * assertion on both dialects.
 *
 * **`state varchar NOT NULL DEFAULT 'active'` with `WHERE state = 'active'`,
 * by design.** `UNIQUE (cohortId) WHERE active` cannot
 * be declared: TypeORM's `@Index` carries one `where` string for both dialects,
 * so `active = true` / `active = 1` is not expressible, and a bare boolean
 * predicate on a column sqlite stores as an integer is not the shape Postgres
 * normalises a status comparison to. A status comparison *is* that shape, which
 * is what the codebase's own parity note vouches for.
 *
 * Purely additive: one new table, two new indexes and one nullable column.
 * Nothing is dropped, renamed or retyped and no existing row is rewritten.
 *
 * Both dialects are real (sqlite is the supported local-first store), and the sqlite branch adds its column
 * with raw `ALTER TABLE … ADD COLUMN` rather than `queryRunner.addColumn`, for
 * the reason the D6 header wrote down and verified: TypeORM's sqlite driver
 * implements `addColumn` as a table rebuild, and the rebuild recreates the
 * table's indexes from a definition that has lost the `WHERE` of a partial
 * index. On `enrollments` that would take `UQ_enrollments_user_project` through
 * a rewrite — the index that is the only thing stopping a double-tapped Start
 * leaving a learner with two enrolments — and TypeORM's own generator does
 * exactly that rebuild if it is allowed to. sqlite's `ADD COLUMN` needs no
 * rebuild for a nullable column with no default, so every index on the table
 * survives untouched.
 */
export class H2CohortAssignmentAndEnrolmentPin1789600100000 implements MigrationInterface {
  name = 'H2CohortAssignmentAndEnrolmentPin1789600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = typesFor(queryRunner, this.name);

    await queryRunner.query(
      `CREATE TABLE "cohort_project_assignments" ("id" ${t.id}, "cohortId" ${t.str} NOT NULL, ` +
        `"projectVersionId" ${t.str} NOT NULL, "assignedByUserId" ${t.str} NOT NULL, ` +
        `"state" ${t.str} NOT NULL DEFAULT ${t.lit('active')}, "reason" text NOT NULL, ` +
        `"createdAt" ${t.created})`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cohort_project_assignments_cohort" ON "cohort_project_assignments" ("cohortId", "createdAt") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cohort_project_assignment_active" ON "cohort_project_assignments" ("cohortId") WHERE state = 'active'`,
    );

    // Raw, and nullable with no default, so sqlite records the column in the
    // schema without rewriting the table. See the note above this class.
    await queryRunner.query(
      t.postgres
        ? `ALTER TABLE "enrollments" ADD "projectVersionId" character varying`
        : `ALTER TABLE "enrollments" ADD COLUMN "projectVersionId" varchar`,
    );
  }

  /**
   * The index first, then the table, then the column — the order required
   * because sqlite refuses to drop a column an index names and because a
   * reversal that left the partial index behind would leave the next `up()`
   * unable to create it.
   *
   * Reverting unpins every enrolment, so a learner mid-attempt resolves the
   * published head again. `packVersion` still records which pack graded them,
   * which is why that column was kept rather than replaced.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    typesFor(queryRunner, this.name);
    await queryRunner.query(`DROP INDEX "UQ_cohort_project_assignment_active"`);
    await queryRunner.query(`DROP INDEX "IDX_cohort_project_assignments_cohort"`);
    await queryRunner.query(`DROP TABLE "cohort_project_assignments"`);
    // Raw `DROP COLUMN` for the same reason `up` uses raw `ADD COLUMN`: the
    // driver's own `dropColumn` rebuilds `enrollments` and would recreate its
    // indexes from a definition that has lost a partial index's `WHERE`.
    await queryRunner.query(`ALTER TABLE "enrollments" DROP COLUMN "projectVersionId"`);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class. H1 carries its own copy for the
// same reason, as D6 does with `isPostgres` / `isSqlite`.

interface DialectTypes {
  postgres: boolean;
  id: string;
  str: string;
  created: string;
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
    created: postgres
      ? 'TIMESTAMP NOT NULL DEFAULT now()'
      : "datetime NOT NULL DEFAULT (datetime('now'))",
    lit: (value: string) => (postgres ? `'${value}'` : `('${value}')`),
  };
}
