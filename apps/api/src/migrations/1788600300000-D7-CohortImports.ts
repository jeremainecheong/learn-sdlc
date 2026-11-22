import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The receipt a class import leaves behind.
 *
 * ## `cohort_imports`
 *
 * A class moves between two laptops as one JSON file. The import writes
 * ordinary rows through the ordinary entities — a cohort, users, enrolments,
 * phase states, submissions, releases and messages — so nothing about the
 * running app has to know that an import happened. What it cannot write
 * through the ordinary entities is the provenance: which file this class came
 * from, which machine wrote it, what the file was allowed to carry, and the
 * other machine's audit trail, which is kept verbatim in `sourceAudit` rather
 * than replayed as rows here. An audit row is a claim about who did something
 * on *this* machine; copying one in would name actor ids that do not exist
 * here and make the local trail unreadable.
 *
 * `IDX_cohort_imports_sha` is deliberately not unique. Importing the same file
 * twice to make a second copy of a class is a supported answer, so the
 * duplicate check is a read and the 409 it raises is overridable.
 *
 * One new table, no changes to any existing one — which is the point. Nothing
 * is dropped, renamed or retyped and no existing row is rewritten, so it
 * applies to a populated database while the previous release is serving, and
 * the previous release keeps working against it.
 *
 * Both dialects are real (sqlite is the supported local-first store). There is no `ALTER TABLE` here at all,
 * so the sqlite branch cannot trip the table-rebuild hazard that costs
 * `submissions` the `WHERE` on `UQ_submissions_in_flight`; it is a bare
 * `CREATE TABLE` on both sides.
 */
export class D7CohortImports1788600300000 implements MigrationInterface {
    name = 'D7CohortImports1788600300000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * Drops the table. Reverting loses the provenance of every class carried
     * onto this machine, including the only copy of the other machine's trail,
     * so revert only a deploy that has not imported anything.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cohort_imports" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cohortId" character varying NOT NULL, "actorUserId" character varying NOT NULL, "format" character varying NOT NULL, "formatVersion" integer NOT NULL, "documentSha256" character varying NOT NULL, "bytes" integer NOT NULL, "sourceHost" character varying, "sourceExportedAt" character varying, "includes" text, "counts" text, "sourceAudit" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_dd58a3ee5795b9b84e800fb10e8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b8406c4c756ef0156823b99615" ON "cohort_imports" ("cohortId") `);
        await queryRunner.query(`CREATE INDEX "IDX_cohort_imports_sha" ON "cohort_imports" ("documentSha256") `);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_cohort_imports_sha"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b8406c4c756ef0156823b99615"`);
        await queryRunner.query(`DROP TABLE "cohort_imports"`);
    }

    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cohort_imports" ("id" varchar PRIMARY KEY NOT NULL, "cohortId" varchar NOT NULL, "actorUserId" varchar NOT NULL, "format" varchar NOT NULL, "formatVersion" integer NOT NULL, "documentSha256" varchar NOT NULL, "bytes" integer NOT NULL, "sourceHost" varchar, "sourceExportedAt" varchar, "includes" text, "counts" text, "sourceAudit" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_b8406c4c756ef0156823b99615" ON "cohort_imports" ("cohortId") `);
        await queryRunner.query(`CREATE INDEX "IDX_cohort_imports_sha" ON "cohort_imports" ("documentSha256") `);
    }

    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_cohort_imports_sha"`);
        await queryRunner.query(`DROP INDEX "IDX_b8406c4c756ef0156823b99615"`);
        await queryRunner.query(`DROP TABLE "cohort_imports"`);
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
