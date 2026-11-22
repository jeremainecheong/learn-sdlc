import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The two things a learner writes about their own time: the
 * estimate they make before a phase, and the retrospective they write once its
 * gate has passed.
 *
 * Both are nullable columns with no default on a table the learner already
 * owns, so on either dialect this is a catalogue-only change: no row is
 * rewritten, the previous release keeps serving against the new schema, and no
 * new table means `account.service.ts`'s USER_SCOPED_ENTITIES list — which
 * `account.service.spec.ts` asserts is exhaustive — needs no entry.
 *
 * Written as raw `ALTER TABLE ... ADD COLUMN` rather than
 * `queryRunner.addColumn`, which on sqlite rebuilds the table from the
 * definition it just read and loses the `WHERE` of any partial unique index.
 * `phase_states` carries none here, so the rebuild would survive; writing the
 * DDL out means it still will after somebody adds one. It is the rule the B2
 * migration documents for `submissions` and `UQ_submissions_in_flight`.
 *
 * The timestamp is deliberately later than D8's 1788600400000: both migrations
 * add columns to `phase_states`, and a fixed order means a fresh file and a
 * migrated one land on the same schema.
 *
 * Nothing here stores an actual. `unlockedAt` and `passedAt` are already on the
 * row and already stamped by `WorkflowService`; the time a phase took is
 * arithmetic on read, never a third column that could disagree with them.
 */
export class D9EstimatesAndRetros1788600500000 implements MigrationInterface {
    name = 'D9EstimatesAndRetros1788600500000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!isPostgres(queryRunner) && !isSqlite(queryRunner)) {
            throw new Error(unsupported(queryRunner, this.name));
        }
        // Identical statements on both dialects: `text` is a real type in each,
        // and a nullable column with no default rewrites no row.
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "estimate" text`);
        await queryRunner.query(`ALTER TABLE "phase_states" ADD "retro" text`);
    }

    /**
     * sqlite has supported `ALTER TABLE ... DROP COLUMN` since 3.35 and this
     * repo ships better-sqlite3 on 3.49, so the reverse needs no table rebuild
     * on either dialect. Dropping them discards every estimate and every
     * retrospective, which is what reverting this migration means.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!isPostgres(queryRunner) && !isSqlite(queryRunner)) {
            throw new Error(unsupported(queryRunner, this.name));
        }
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "retro"`);
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "estimate"`);
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
