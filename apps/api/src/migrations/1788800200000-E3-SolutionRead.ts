import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Who has read the pack's answer, and when.
 *
 * After a phase's gate passes, the learner may open the reference the hidden
 * tests were written against beside their own merged files. Reading it changes
 * no score and no file, but a class has to be able to say who has seen the
 * answer and when — so the first reading is stamped on the phase state and
 * audited, and the learner's own dossier says so too.
 *
 * One nullable varchar with no default: on both dialects that is a
 * catalogue-only change, no row is rewritten, and the previous release keeps
 * serving against the new schema. It holds an ISO string like `unlockedAt`,
 * `passedAt` and `workspaceUpdatedAt` beside it rather than a timestamp, so it
 * keeps milliseconds, compares as text on either dialect and needs no
 * dialect-specific conversion.
 *
 * Nothing is backfilled. A phase that passed before this migration has not had its
 * reference read — there was no door to read it through — and null says
 * exactly that.
 *
 * Raw `ALTER TABLE ... ADD COLUMN` rather than `queryRunner.addColumn`, which
 * on sqlite rebuilds the table from the definition it just read and loses the
 * `WHERE` of any partial unique index. `phase_states` carries none here, so a
 * rebuild would survive; writing the DDL out means it still will after somebody
 * adds one. It is the rule the B2 migration documents for `submissions` and
 * `UQ_submissions_in_flight`.
 */
export class E3SolutionRead1788800200000 implements MigrationInterface {
    name = 'E3SolutionRead1788800200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) {
            await queryRunner.query(
                `ALTER TABLE "phase_states" ADD "solutionReadAt" character varying`,
            );
        } else if (isSqlite(queryRunner)) {
            await queryRunner.query(`ALTER TABLE "phase_states" ADD "solutionReadAt" varchar`);
        } else {
            throw new Error(unsupported(queryRunner, this.name));
        }
    }

    /**
     * sqlite has supported `ALTER TABLE ... DROP COLUMN` since 3.35 and this
     * repo ships better-sqlite3 on 3.49, so the reverse needs no table rebuild
     * on either dialect. Dropping it forgets who has read which answer; the
     * audit rows survive, because they are a different record for a different
     * reader.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!isPostgres(queryRunner) && !isSqlite(queryRunner)) {
            throw new Error(unsupported(queryRunner, this.name));
        }
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "solutionReadAt"`);
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
