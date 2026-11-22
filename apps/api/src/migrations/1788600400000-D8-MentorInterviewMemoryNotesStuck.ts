import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The mentor's four pieces of state: the customer interview and
 * the stuck flag on `phase_states`, the mentor's memory on `enrollments`, and
 * one new table for the notes an instructor writes for a whole class.
 *
 * Three of the four are nullable columns with no default, so on both dialects
 * they are a catalogue-only change: no row is rewritten, the previous release
 * keeps serving against the new schema, and a column that accepts null accepts
 * everything it accepted before.
 *
 * They are added with raw `ALTER TABLE ... ADD COLUMN` rather than
 * `queryRunner.addColumn`, which on sqlite rebuilds the table from the
 * definition it just read — and that read loses the `WHERE` of a partial unique
 * index. Neither `phase_states` nor `enrollments` carries one here, so the
 * rebuild would in fact survive; writing the DDL out means it still will after
 * somebody adds one, and it is the rule the B2 migration documents for `submissions` and
 * `UQ_submissions_in_flight`.
 *
 * `instructor_notes` keys its author as `authorUserId`, not `userId`, on
 * purpose: `account.service.ts` walks every `userId` column to export and erase
 * a learner's coursework, and a note written for thirty learners is neither.
 */
export class D8MentorInterviewMemoryNotesStuck1788600400000 implements MigrationInterface {
    name = 'D8MentorInterviewMemoryNotesStuck1788600400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) {
            await queryRunner.query(
                `CREATE TABLE "instructor_notes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
                    `"kind" character varying NOT NULL, "cohortId" character varying NOT NULL, ` +
                    `"projectSlug" character varying, "phaseKey" character varying, "text" text NOT NULL, ` +
                    `"authorUserId" character varying NOT NULL, "sourceId" character varying, ` +
                    `"doneAt" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), ` +
                    `"updatedAt" TIMESTAMP NOT NULL DEFAULT now(), ` +
                    `CONSTRAINT "PK_instructor_notes_id" PRIMARY KEY ("id"))`,
            );
        } else if (isSqlite(queryRunner)) {
            await queryRunner.query(
                `CREATE TABLE "instructor_notes" ("id" varchar PRIMARY KEY NOT NULL, ` +
                    `"kind" varchar NOT NULL, "cohortId" varchar NOT NULL, ` +
                    `"projectSlug" varchar, "phaseKey" varchar, "text" text NOT NULL, ` +
                    `"authorUserId" varchar NOT NULL, "sourceId" varchar, "doneAt" varchar, ` +
                    `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
                    `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
            );
        } else {
            throw new Error(unsupported(queryRunner, this.name));
        }

        await queryRunner.query(
            `CREATE INDEX "IDX_instructor_notes_cohort_kind" ON "instructor_notes" ("cohortId", "kind") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_instructor_notes_author" ON "instructor_notes" ("authorUserId") `,
        );

        // Identical statements on both dialects: `text` is a real type in each,
        // and neither table has a partial index for a rebuild to lose.
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "interview" text`);
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "stuck" text`);
        await queryRunner.query(`ALTER TABLE "enrollments" ADD "mentorMemory" text`);
    }

    /**
     * sqlite has supported `ALTER TABLE ... DROP COLUMN` since 3.35 and this
     * repo ships better-sqlite3 on 3.49, so the reverse needs no table rebuild
     * on either dialect. Dropping the columns discards the interviews, the
     * flags and the memory, which is what reverting this migration means.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!isPostgres(queryRunner) && !isSqlite(queryRunner)) {
            throw new Error(unsupported(queryRunner, this.name));
        }
        await queryRunner.query(`ALTER TABLE "enrollments" DROP COLUMN "mentorMemory"`);
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "stuck"`);
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "interview"`);
        await queryRunner.query(
            isPostgres(queryRunner)
                ? `DROP INDEX "public"."IDX_instructor_notes_author"`
                : `DROP INDEX "IDX_instructor_notes_author"`,
        );
        await queryRunner.query(
            isPostgres(queryRunner)
                ? `DROP INDEX "public"."IDX_instructor_notes_cohort_kind"`
                : `DROP INDEX "IDX_instructor_notes_cohort_kind"`,
        );
        await queryRunner.query(`DROP TABLE "instructor_notes"`);
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
