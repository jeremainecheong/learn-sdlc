import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Adds the storage behind revisions, links, the deployment drill, release
 * records and the audit trail.
 *
 * Additive only: two new tables, their indexes, and three nullable columns.
 * Nothing existing is dropped, renamed or retyped, so it is safe to apply to a
 * populated database while the old code is still serving.
 *
 * Both dialects are real (see the note on migration 1). sqlite is the supported
 * local-first store, so the sqlite branch builds the same schema rather than
 * recording a no-op, and `docs/production-runbook.md` §3a is the path that uses it.
 */
export class SlicesRevisionsLinksDrillReleasesAudit1788451988662 implements MigrationInterface {
    name = 'SlicesRevisionsLinksDrillReleasesAudit1788451988662'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * Reverts exactly what up() added and nothing else. It still destroys
     * learner data written since the deploy (links, drill progress, submission
     * snapshots, releases, audit rows), so revert only a deploy that has not
     * been used.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        // Every id default below is uuid_generate_v4(). InitialSchema creates
        // the extension for a fresh database, but a database that applied
        // InitialSchema before that line existed never will — a recorded
        // migration does not run again. Creating it needs CREATE on the
        // database; docs/production-runbook.md §2 says what to grant, or what
        // a superuser must run first on a managed Postgres.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "releases" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "enrollmentId" character varying NOT NULL, "userId" character varying NOT NULL, "phaseStateId" character varying NOT NULL, "phaseKey" character varying NOT NULL, "phaseOrder" integer NOT NULL, "version" character varying NOT NULL, "score" double precision, "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6b6fc2599a5a281dd44a7d64016" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_450abf31de667d04a348f5c382" ON "releases" ("enrollmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d0ae503a22f7684ef89be7550c" ON "releases" ("userId") `);
        // One release per enrolment and phase: two concurrent merges of the
        // same phase both pass the read-then-write guard in advance(), and only
        // the database can refuse the second.
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_releases_enrollment_phase" ON "releases" ("enrollmentId", "phaseOrder") `);
        await queryRunner.query(`CREATE TABLE "audit_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "event" character varying NOT NULL, "actorUserId" character varying NOT NULL, "subjectUserId" character varying NOT NULL, "targetId" character varying, "action" character varying, "reason" text, "detail" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_910f64d901a5c3e9878f0d4a407" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2e65cfff9e135c7c99c9da371b" ON "audit_events" ("actorUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_911d10eeba0b44d6ae067a0fcf" ON "audit_events" ("subjectUserId") `);
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "links" text`);
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "drill" text`);
        await queryRunner.query(`ALTER TABLE "submissions" ADD "workspaceSnapshot" text`);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "workspaceSnapshot"`);
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "drill"`);
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "links"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_911d10eeba0b44d6ae067a0fcf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e65cfff9e135c7c99c9da371b"`);
        await queryRunner.query(`DROP TABLE "audit_events"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_releases_enrollment_phase"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0ae503a22f7684ef89be7550c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_450abf31de667d04a348f5c382"`);
        await queryRunner.query(`DROP TABLE "releases"`);
    }

    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "releases" ("id" varchar PRIMARY KEY NOT NULL, "enrollmentId" varchar NOT NULL, "userId" varchar NOT NULL, "phaseStateId" varchar NOT NULL, "phaseKey" varchar NOT NULL, "phaseOrder" integer NOT NULL, "version" varchar NOT NULL, "score" float, "notes" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_450abf31de667d04a348f5c382" ON "releases" ("enrollmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d0ae503a22f7684ef89be7550c" ON "releases" ("userId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_releases_enrollment_phase" ON "releases" ("enrollmentId", "phaseOrder") `);
        await queryRunner.query(`CREATE TABLE "audit_events" ("id" varchar PRIMARY KEY NOT NULL, "event" varchar NOT NULL, "actorUserId" varchar NOT NULL, "subjectUserId" varchar NOT NULL, "targetId" varchar, "action" varchar, "reason" text, "detail" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2e65cfff9e135c7c99c9da371b" ON "audit_events" ("actorUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_911d10eeba0b44d6ae067a0fcf" ON "audit_events" ("subjectUserId") `);
        await queryRunner.addColumn(
            'phase_states',
            new TableColumn({ name: 'links', type: 'text', isNullable: true }),
        );
        await queryRunner.addColumn(
            'phase_states',
            new TableColumn({ name: 'drill', type: 'text', isNullable: true }),
        );
        await queryRunner.addColumn(
            'submissions',
            new TableColumn({ name: 'workspaceSnapshot', type: 'text', isNullable: true }),
        );
    }

    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('submissions', 'workspaceSnapshot');
        await queryRunner.dropColumn('phase_states', 'drill');
        await queryRunner.dropColumn('phase_states', 'links');
        await queryRunner.query(`DROP INDEX "IDX_911d10eeba0b44d6ae067a0fcf"`);
        await queryRunner.query(`DROP INDEX "IDX_2e65cfff9e135c7c99c9da371b"`);
        await queryRunner.query(`DROP TABLE "audit_events"`);
        await queryRunner.query(`DROP INDEX "UQ_releases_enrollment_phase"`);
        await queryRunner.query(`DROP INDEX "IDX_d0ae503a22f7684ef89be7550c"`);
        await queryRunner.query(`DROP INDEX "IDX_450abf31de667d04a348f5c382"`);
        await queryRunner.query(`DROP TABLE "releases"`);
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
