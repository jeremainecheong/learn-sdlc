import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * What "last saved" means.
 *
 * `phase_states.updatedAt` is an `@UpdateDateColumn`, so TypeORM moves it on
 * every write to the row — `markRan`, the drill's three writes, `saveLinks`,
 * the run clock and the grading job all bump it — while the entity documented
 * it as the last workspace write and the IDE's status bar rendered it as a
 * save time. A learner who pressed "Run health check" watched "Saved at" jump
 * to now without having saved anything, and the stamp was stored only to the
 * second, which is coarser than the 700 ms autosave that produces it.
 *
 * So the save gets a column of its own, written by `saveWorkspace` and by
 * nothing else. `updatedAt` keeps its meaning — any write to this row — which
 * is what a second tab wants for a staleness check.
 *
 * A nullable varchar with no default: on both dialects that is a
 * catalogue-only change, no row is rewritten, and the previous release keeps
 * serving against the new schema. It holds an ISO string like `unlockedAt` and
 * `passedAt` beside it rather than a timestamp, so it keeps milliseconds,
 * compares as text on either dialect and needs no dialect-specific conversion.
 *
 * Nothing is backfilled. There is no honest value to backfill from: `updatedAt`
 * is precisely the number this column exists to stop showing, and copying it
 * would stamp "saved" on a phase whose workspace has never been written. Null
 * reads as "not known", the status bar shows the word without a time, and the
 * learner's next autosave — 700 ms of typing — makes it exact.
 *
 * Raw `ALTER TABLE ... ADD COLUMN` rather than `queryRunner.addColumn`, which
 * on sqlite rebuilds the table from the definition it just read and loses the
 * `WHERE` of any partial unique index. `phase_states` carries none here, so a
 * rebuild would survive; writing the DDL out means it still will after somebody
 * adds one. It is the rule the B2 migration documents for `submissions` and
 * `UQ_submissions_in_flight`.
 */
export class C6WorkspaceUpdatedAt1788700000000 implements MigrationInterface {
    name = 'C6WorkspaceUpdatedAt1788700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) {
            await queryRunner.query(
                `ALTER TABLE "phase_states" ADD "workspaceUpdatedAt" character varying`,
            );
        } else if (isSqlite(queryRunner)) {
            await queryRunner.query(`ALTER TABLE "phase_states" ADD "workspaceUpdatedAt" varchar`);
        } else {
            throw new Error(unsupported(queryRunner, this.name));
        }
    }

    /**
     * sqlite has supported `ALTER TABLE ... DROP COLUMN` since 3.35 and this
     * repo ships better-sqlite3 on 3.49, so the reverse needs no table rebuild
     * on either dialect. Dropping it discards every save stamp, and the status
     * bar goes back to having nothing honest to show.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!isPostgres(queryRunner) && !isSqlite(queryRunner)) {
            throw new Error(unsupported(queryRunner, this.name));
        }
        await queryRunner.query(`ALTER TABLE "phase_states" DROP COLUMN "workspaceUpdatedAt"`);
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
