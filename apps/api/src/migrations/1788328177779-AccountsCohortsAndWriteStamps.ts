import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Classes, revocable sessions and the workspace write stamp.
 *
 * Both dialects are real (see the note on migration 1). The sqlite branch adds
 * its columns through `queryRunner.addColumn` rather than raw DDL: sqlite
 * refuses `ALTER TABLE … ADD COLUMN` when the default is not a constant, and
 * `phase_states.updatedAt` defaults to `datetime('now')`. TypeORM's sqlite
 * driver answers that by rebuilding the table and carrying the rows over, which
 * is the same twelve-step dance by hand and is safe on a populated file.
 */
export class AccountsCohortsAndWriteStamps1788328177779 implements MigrationInterface {
    name = 'AccountsCohortsAndWriteStamps1788328177779'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cohorts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "joinCode" character varying NOT NULL, "ownerUserId" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_fd38f76b135e907b834fda1e752" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6da1b0e8dd103c20803cbae80b" ON "cohorts" ("joinCode") `);
        await queryRunner.query(`CREATE INDEX "IDX_37a222e2956243e46af0e9d854" ON "cohorts" ("ownerUserId") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "tokenVersion" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "disabledAt" character varying`);
        await queryRunner.query(`ALTER TABLE "users" ADD "emailVerifiedAt" character varying`);
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "updatedAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "emailVerifiedAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "disabledAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tokenVersion"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_37a222e2956243e46af0e9d854"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6da1b0e8dd103c20803cbae80b"`);
        await queryRunner.query(`DROP TABLE "cohorts"`);
    }

    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cohorts" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "joinCode" varchar NOT NULL, "ownerUserId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6da1b0e8dd103c20803cbae80b" ON "cohorts" ("joinCode") `);
        await queryRunner.query(`CREATE INDEX "IDX_37a222e2956243e46af0e9d854" ON "cohorts" ("ownerUserId") `);
        await queryRunner.addColumn(
            'users',
            new TableColumn({ name: 'tokenVersion', type: 'integer', isNullable: false, default: 0 }),
        );
        await queryRunner.addColumn(
            'users',
            new TableColumn({ name: 'disabledAt', type: 'varchar', isNullable: true }),
        );
        await queryRunner.addColumn(
            'users',
            new TableColumn({ name: 'emailVerifiedAt', type: 'varchar', isNullable: true }),
        );
        await queryRunner.addColumn(
            'phase_states',
            new TableColumn({
                name: 'updatedAt',
                type: 'datetime',
                isNullable: false,
                default: "datetime('now')",
            }),
        );
    }

    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('phase_states', 'updatedAt');
        await queryRunner.dropColumn('users', 'emailVerifiedAt');
        await queryRunner.dropColumn('users', 'disabledAt');
        await queryRunner.dropColumn('users', 'tokenVersion');
        await queryRunner.query(`DROP INDEX "IDX_37a222e2956243e46af0e9d854"`);
        await queryRunner.query(`DROP INDEX "IDX_6da1b0e8dd103c20803cbae80b"`);
        await queryRunner.query(`DROP TABLE "cohorts"`);
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
