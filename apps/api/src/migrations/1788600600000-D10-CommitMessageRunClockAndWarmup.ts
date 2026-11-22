import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The workspace's three pieces of state: the commit message
 * and the run clock a revision was graded at on `submissions`, the learner's
 * run clock on `phase_states`, and one new table for the warm-up before
 * Requirements.
 *
 * The three columns are nullable with no default, so on both dialects they are
 * a catalogue-only change: no row is rewritten, the previous release keeps
 * serving against the new schema, and a column that accepts null accepts
 * everything it accepted before. A revision made before this migration reads
 * as one with no message, graded at the machine's clock, which is what it was.
 *
 * They are added with raw `ALTER TABLE ... ADD COLUMN` rather than
 * `queryRunner.addColumn`. That is not style: on sqlite TypeORM implements
 * addColumn by rebuilding the table from the definition it just read, and that
 * read loses the `WHERE` of a partial unique index. `submissions` carries
 * `UQ_submissions_in_flight`, the double-submit guard, whose whole value is
 * its predicate — rebuilding it would leave a unique index over every
 * submission a phase has ever had, so the second attempt at any phase would be
 * refused by the database.
 *
 * `warmup_states` is a table of its own rather than a seventh phase: the
 * warm-up has no rubric, no score and gates nothing, and `PhaseKey` is a
 * closed union that the class map, the analytics and both instructor pages key
 * on. Its unique index over (userId, projectSlug) is what makes the lazy first
 * read idempotent when two tabs open the room together.
 */
export class D10CommitMessageRunClockAndWarmup1788600600000 implements MigrationInterface {
    name = 'D10CommitMessageRunClockAndWarmup1788600600000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) {
            await queryRunner.query(
                `CREATE TABLE "warmup_states" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
                    `"userId" character varying NOT NULL, "projectSlug" character varying NOT NULL, ` +
                    `"status" character varying NOT NULL DEFAULT 'not_started', "workspace" text, ` +
                    `"attempts" integer NOT NULL DEFAULT 0, "passedAt" character varying, ` +
                    `"createdAt" TIMESTAMP NOT NULL DEFAULT now(), ` +
                    `"updatedAt" TIMESTAMP NOT NULL DEFAULT now(), ` +
                    `CONSTRAINT "PK_warmup_states_id" PRIMARY KEY ("id"))`,
            );
            await queryRunner.query(
                `ALTER TABLE "submissions" ADD "commitMessage" character varying`,
            );
            await queryRunner.query(`ALTER TABLE "submissions" ADD "runClock" character varying`);
            await queryRunner.query(`ALTER TABLE "phase_states" ADD "runClock" character varying`);
        } else if (isSqlite(queryRunner)) {
            await queryRunner.query(
                `CREATE TABLE "warmup_states" ("id" varchar PRIMARY KEY NOT NULL, ` +
                    `"userId" varchar NOT NULL, "projectSlug" varchar NOT NULL, ` +
                    `"status" varchar NOT NULL DEFAULT ('not_started'), "workspace" text, ` +
                    `"attempts" integer NOT NULL DEFAULT (0), "passedAt" varchar, ` +
                    `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
                    `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
            );
            await queryRunner.query(`ALTER TABLE "submissions" ADD "commitMessage" varchar`);
            await queryRunner.query(`ALTER TABLE "submissions" ADD "runClock" varchar`);
            await queryRunner.query(`ALTER TABLE "phase_states" ADD "runClock" varchar`);
        } else {
            throw new Error(unsupported(queryRunner, this.name));
        }

        // Identical on both dialects, and both are real indexes rather than
        // constraints so the sqlite schema the unit tests sync and the
        // migrated one agree.
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_warmup_states_user_project" ON "warmup_states" ("userId", "projectSlug") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_warmup_states_user" ON "warmup_states" ("userId") `,
        );
    }

    /**
     * sqlite has supported `ALTER TABLE ... DROP COLUMN` since 3.35 and this
     * repo ships better-sqlite3 on 3.49, so the reverse needs no table rebuild
     * on either dialect — which is the point, because a rebuild here would
     * lose the same partial index the forward direction avoids. Dropping the
     * columns discards the messages and the clocks, which is what reverting
     * this migration means.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!isPostgres(queryRunner) && !isSqlite(queryRunner)) {
            throw new Error(unsupported(queryRunner, this.name));
        }
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "runClock"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "runClock"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "commitMessage"`);
        await queryRunner.query(
            isPostgres(queryRunner)
                ? `DROP INDEX "public"."IDX_warmup_states_user"`
                : `DROP INDEX "IDX_warmup_states_user"`,
        );
        await queryRunner.query(
            isPostgres(queryRunner)
                ? `DROP INDEX "public"."UQ_warmup_states_user_project"`
                : `DROP INDEX "UQ_warmup_states_user_project"`,
        );
        await queryRunner.query(`DROP TABLE "warmup_states"`);
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
