import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H9 — pin the enrolments that predate the pin. Data only.
 *
 * ## Why
 *
 * H2 added `enrollments."projectVersionId"` nullable, with no backfill, and a
 * null pin resolves to the project's published **head** on every read
 * (`ContentService.getForEnrollment`: no pin → the head). Every enrolment made
 * before the pin existed is such a row, and every one of them is on TaskTrackr
 * (the only project that existed then). While the head is TaskTrackr 2.0.1
 * nothing moves; the day a later TaskTrackr version is published, every one of those
 * learners would be moved onto it mid-project — a rubric, a hidden suite or a
 * phase title changing under an attempt, which is exactly what the pin exists
 * to prevent. This migration closes that before anything can move the head.
 *
 * ## By explicit semver, never "the head"
 *
 * The rows are pinned to the TaskTrackr version whose semver is **2.0.1** and
 * whose status is `published`, resolved inside the statement. Not "the version
 * they are on now", which is the head: on a database that has already imported
 * a later version (a developer's, or a native validation copy) the head would
 * be that later version and the pin would be wrong. On the host the migrations
 * run in the one-shot before the candidate's boot import, so the head there is
 * 2.0.1 — the version the seed imported and every null row already resolves to
 * — and the pin changes nothing a learner is served.
 *
 * `UQ_project_versions_version (projectId, version)` is unique, so the scalar
 * subquery returns at most one row; the `EXISTS` makes the statement write
 * nothing at all when there is no such row, rather than write NULL over NULL.
 * With no null rows, no 2.0.1 row, or a 2.0.1 row that is not `published`, it
 * changes nothing; on an empty database it is a no-op. Running it twice
 * changes nothing the second time. Null rows on any other slug are left alone
 * (a rollback window's row on a teacher's project is not this migration's to
 * guess at); the populated proof reports their count.
 *
 * ## The casts are load-bearing
 *
 * `projects.id` is `uuid` on Postgres (H1), while `project_versions.projectId`
 * and `enrollments.projectVersionId` are `character varying` (H1, H2).
 * Postgres 16 has no `uuid = character varying` operator, so the join is
 * written `CAST(p."id" AS varchar) = v."projectId"` and the value selected is
 * `CAST(v."id" AS varchar)` — the repository's own precedent is A3's
 * `CAST(p2."id" AS varchar)`. Without them the statement raises on Postgres,
 * and because the release runs its migrations under `transaction: 'all'`, H5
 * would roll back with it. sqlite has no uuid type and would pass either way,
 * which is why the Postgres spec is mandatory, not parity.
 *
 * ## One statement, both dialects, plain text
 *
 * The statement is identical on both dialects and is plain statement text in
 * `up()`, so the release tool reads it — and, reading DDL only, derives
 * `alteredTables=submissions` (H5's `ALTER`) and not `enrollments`. The
 * operator names `enrollments` in `--altered-tables` and passes
 * `--i-have-read-the-migrations`. The retention proof compares row counts for
 * altered tables, and an `UPDATE` keeps the count.
 *
 * ## A dev laptop's adopted sqlite file is not pinned
 *
 * `openDataSource` "adopts" a sqlite file whose schema is already current by
 * recording its migrations as applied without running them
 * (`database.module.ts`, `action: 'adopted'`). On such a file this statement
 * never runs and the legacy rows stay null. That is a developer's file, never
 * the host, which runs Postgres through the one-shot.
 */
export class H9PinLegacyEnrolments1789800100000 implements MigrationInterface {
  name = 'H9PinLegacyEnrolments1789800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = dialectOf(queryRunner, this.name);
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(
      `UPDATE "enrollments" SET "projectVersionId" = (` +
        `SELECT CAST(v."id" AS varchar) FROM "project_versions" v ` +
        `JOIN "projects" p ON CAST(p."id" AS varchar) = v."projectId" ` +
        `WHERE p."slug" = 'tasktrackr' AND v."version" = '2.0.1' AND v."status" = 'published') ` +
        `WHERE "projectVersionId" IS NULL AND "projectSlug" = 'tasktrackr' ` +
        `AND EXISTS (SELECT 1 FROM "project_versions" v ` +
        `JOIN "projects" p ON CAST(p."id" AS varchar) = v."projectId" ` +
        `WHERE p."slug" = 'tasktrackr' AND v."version" = '2.0.1' AND v."status" = 'published')`,
    );
  }

  /**
   * **A documented no-op.** A `down()` cannot tell the pins H9 wrote from pins
   * written at enrolment since the pin existed: both are TaskTrackr 2.0.1, and
   * un-pinning every 2.0.1 row would un-pin legitimate learners. Keeping the
   * pins is also safe: an API from before this migration reads a pinned row as pinned and serves
   * the same 2.0.1 bytes the null resolved to. Symmetry holds at the schema
   * level — the level the table-count proof checks — because `up()` changes no
   * schema. The frozen release transaction never runs a `down()`.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    dialectOf(queryRunner, this.name);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class. H1–H5 each carry their own copy
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
