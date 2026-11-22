import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The two tables instructor tooling needs, and the two columns that let a
 * regraded verdict point back at the one it re-ran.
 *
 * ## `regrade_batches`
 *
 * A content fix mid-term — a hidden test that was wrong, a rubric weight that
 * was not what the pack meant — leaves a class holding verdicts nobody stands
 * behind. Re-running them is a batch, and a batch needs a row: who asked, for
 * which class, phase and pack, why, how far along it is, and which learners it
 * could not include. `UQ_regrade_batch_running` is a *partial* unique index on
 * (cohort, status): finished and stopped batches fall outside it, so a class
 * keeps its whole history of regrades while only the running one is exclusive.
 * That is what settles "one batch at a time per class" in the database rather
 * than in a read-then-write two instructors can both pass.
 *
 * ## `cohort_phase_schedule`
 *
 * One row per class, project and phase, carrying an open date and a due date,
 * both optional. Neither is copied onto a learner's row: a phase is shut
 * because the class's `opensAt` has not arrived, and work is late because its
 * `createdAt` is after the class's `dueAt`. Moving a date therefore moves what
 * is late immediately, and a class with no dates has no lateness at all.
 * Both instants are ISO strings in `varchar`, the same shape `passedAt`,
 * `unlockedAt` and `completedAt` already use, so reading one involves no
 * dialect date conversion.
 *
 * ## `submissions.regradeOf` and `submissions.regradeBatchId`
 *
 * A regrade never edits the row it re-ran — the old verdict is exactly what an
 * appeal needs to read — so the new verdict is a new revision that names its
 * parent and its batch. Both nullable with no default, which is what makes
 * the sqlite branch legal as a raw `ADD COLUMN`.
 *
 * Additive only: two new tables, four new indexes and two nullable columns.
 * Nothing is dropped, renamed or retyped and no existing row is rewritten, so
 * it applies to a populated database while the previous release is serving,
 * and the previous release keeps working against it.
 *
 * Both dialects are real (sqlite is the supported local-first store). The sqlite branch adds its two columns
 * with raw `ALTER TABLE ... ADD COLUMN` rather than `queryRunner.addColumn`,
 * for the reason the B2 migration wrote down and verified: TypeORM's sqlite driver
 * implements `addColumn` as a table rebuild, and the rebuild recreates the
 * table's indexes from a definition that has lost the `WHERE` of a partial
 * index — so rebuilding `submissions` silently drops
 * `UQ_submissions_in_flight` and leaves a database that accepts a double
 * submit. sqlite's own `ADD COLUMN` needs no rebuild for a nullable column
 * with no default, so every index on the table survives untouched.
 */
export class D6RegradeBatchesAndCohortSchedule1788600200000 implements MigrationInterface {
    name = 'D6RegradeBatchesAndCohortSchedule1788600200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * Drops both tables and both columns. Reverting loses the record of which
     * regrade produced a revision and every class date that has been set, so
     * revert only a deploy that has not been used.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * `uuid_generate_v4()` is the default every id in this schema already
     * uses; `InitialSchema` creates the extension, so nothing new is needed
     * here.
     */
    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "regrade_batches" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actorUserId" character varying NOT NULL, "cohort" character varying NOT NULL, "projectSlug" character varying NOT NULL, "phaseKey" character varying NOT NULL, "packVersionTo" character varying, "scope" character varying NOT NULL DEFAULT 'stale-pack', "reason" text NOT NULL, "status" character varying NOT NULL DEFAULT 'running', "requested" integer NOT NULL DEFAULT '0', "done" integer NOT NULL DEFAULT '0', "failed" integer NOT NULL DEFAULT '0', "newPasses" integer NOT NULL DEFAULT '0', "skipped" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "finishedAt" character varying, CONSTRAINT "PK_503d5a835dc5438d91c5a9f1b45" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6808b7e4d5bd96d7732273358a" ON "regrade_batches" ("actorUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_regrade_batch_running" ON "regrade_batches" ("cohort", "status") WHERE status = 'running'`);
        await queryRunner.query(`CREATE TABLE "cohort_phase_schedule" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cohortId" character varying NOT NULL, "projectSlug" character varying NOT NULL, "phaseKey" character varying NOT NULL, "opensAt" character varying, "dueAt" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9546c51a00ece2216f10c9f6589" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_cohort_phase_schedule" ON "cohort_phase_schedule" ("cohortId", "projectSlug", "phaseKey") `);
        await queryRunner.query(`ALTER TABLE "submissions" ADD "regradeOf" character varying`);
        await queryRunner.query(`ALTER TABLE "submissions" ADD "regradeBatchId" character varying`);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "regradeBatchId"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "regradeOf"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_cohort_phase_schedule"`);
        await queryRunner.query(`DROP TABLE "cohort_phase_schedule"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_regrade_batch_running"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6808b7e4d5bd96d7732273358a"`);
        await queryRunner.query(`DROP TABLE "regrade_batches"`);
    }

    /**
     * Columns first, then the new tables, so nothing new has to survive a
     * rewrite — and the two `ALTER TABLE`s are raw for the reason in the note
     * above this class.
     */
    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "submissions" ADD COLUMN "regradeOf" varchar`);
        await queryRunner.query(`ALTER TABLE "submissions" ADD COLUMN "regradeBatchId" varchar`);
        await queryRunner.query(`CREATE TABLE "regrade_batches" ("id" varchar PRIMARY KEY NOT NULL, "actorUserId" varchar NOT NULL, "cohort" varchar NOT NULL, "projectSlug" varchar NOT NULL, "phaseKey" varchar NOT NULL, "packVersionTo" varchar, "scope" varchar NOT NULL DEFAULT ('stale-pack'), "reason" text NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "requested" integer NOT NULL DEFAULT (0), "done" integer NOT NULL DEFAULT (0), "failed" integer NOT NULL DEFAULT (0), "newPasses" integer NOT NULL DEFAULT (0), "skipped" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "finishedAt" varchar)`);
        await queryRunner.query(`CREATE INDEX "IDX_6808b7e4d5bd96d7732273358a" ON "regrade_batches" ("actorUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_regrade_batch_running" ON "regrade_batches" ("cohort", "status") WHERE status = 'running'`);
        await queryRunner.query(`CREATE TABLE "cohort_phase_schedule" ("id" varchar PRIMARY KEY NOT NULL, "cohortId" varchar NOT NULL, "projectSlug" varchar NOT NULL, "phaseKey" varchar NOT NULL, "opensAt" varchar, "dueAt" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_cohort_phase_schedule" ON "cohort_phase_schedule" ("cohortId", "projectSlug", "phaseKey") `);
    }

    /**
     * Raw `DROP COLUMN` for the same reason `up` uses raw `ADD COLUMN`: the
     * driver's own `dropColumn` rebuilds `submissions` and loses the `WHERE`
     * on `UQ_submissions_in_flight`.
     */
    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "UQ_cohort_phase_schedule"`);
        await queryRunner.query(`DROP TABLE "cohort_phase_schedule"`);
        await queryRunner.query(`DROP INDEX "UQ_regrade_batch_running"`);
        await queryRunner.query(`DROP INDEX "IDX_6808b7e4d5bd96d7732273358a"`);
        await queryRunner.query(`DROP TABLE "regrade_batches"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "regradeBatchId"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "regradeOf"`);
    }

}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class.

function isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.connection.options.type === 'postgres';
}

function isSqlite(queryRunner: QueryRunner): boolean {
    const type = queryRunner.connection.options.type;
    return type === 'better-sqlite3' || type === 'sqlite';
}

function unsupported(queryRunner: QueryRunner, migration: string): string {
    return (
        `${migration} has no statements for "${queryRunner.connection.options.type}". ` +
        'This deployment supports postgres (docker-compose.yml) and better-sqlite3 ' +
        '(the local-first path, docs/production-runbook.md §3a).'
    );
}
