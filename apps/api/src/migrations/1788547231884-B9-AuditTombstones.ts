import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * One column loses its NOT NULL: `audit_events.subjectUserId`.
 *
 * Removing every audit row where a deleted account was the subject would lose
 * the one thing an appeal cannot do without: the record that an instructor
 * overrode a grade would disappear with the learner it was written about, and
 * so would the record of the deletion itself. The policy this migration makes
 * storable is a tombstone instead — the event,
 * the actor, the action, the reason and the time all survive; the person does
 * not. Null in this column means erasure, never a missing value, because
 * `recordAudit` always names a subject and nothing else ever writes null here.
 *
 * Nothing is dropped, renamed or retyped: on Postgres this is a catalogue-only
 * change, and no row is rewritten on either dialect. It applies to a populated
 * database while the previous release is still serving, and the previous
 * release keeps working against it — a column that accepts null still accepts
 * every value it accepted before.
 *
 * Both dialects are real: sqlite is the supported local-first store. sqlite has no
 * `ALTER COLUMN ... DROP NOT NULL`, so the sqlite branch rebuilds the table the
 * way TypeORM's own sqlite driver would; see `upSqlite` for why that is written
 * out by hand rather than delegated to `queryRunner.changeColumn`.
 */
export class B9AuditTombstones1788547231884 implements MigrationInterface {
    name = 'B9AuditTombstones1788547231884'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) {
            await queryRunner.query(`ALTER TABLE "audit_events" ALTER COLUMN "subjectUserId" DROP NOT NULL`);
            return;
        }
        if (isSqlite(queryRunner)) return this.rebuildSqlite(queryRunner, 'varchar');
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * Puts the NOT NULL back, and refuses rather than guessing when it cannot.
     *
     * A tombstone has no subject to restore: the account is gone, and inventing
     * an id — or deleting the row to make the constraint fit — would destroy the
     * record this migration exists to keep. So a deployment holding tombstones
     * stops here with a count and a name, which is a person's decision to make,
     * not a migration's.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ tombstones }] = await queryRunner.query(
            `SELECT COUNT(*) AS "tombstones" FROM "audit_events" WHERE "subjectUserId" IS NULL`,
        );
        if (Number(tombstones) > 0) {
            throw new Error(
                `${this.name} cannot restore NOT NULL on audit_events.subjectUserId: ` +
                    `${tombstones} tombstoned row(s) record accounts that have been deleted and have no ` +
                    `subject to give back. Reverting would either invent an id or destroy the record of a ` +
                    `deletion. See docs/production-runbook.md before re-running.`,
            );
        }
        if (isPostgres(queryRunner)) {
            await queryRunner.query(`ALTER TABLE "audit_events" ALTER COLUMN "subjectUserId" SET NOT NULL`);
            return;
        }
        if (isSqlite(queryRunner)) return this.rebuildSqlite(queryRunner, 'varchar NOT NULL');
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * The sqlite table rebuild, written out rather than delegated.
     *
     * `queryRunner.changeColumn` would do the same dance, but it recreates the
     * table's indexes from the definition it read a moment earlier and that
     * definition loses the `WHERE` of a partial index — the trap the B2
     * migration documents for `submissions` and `UQ_submissions_in_flight`.
     * `audit_events` has no partial index, so `changeColumn` would in fact
     * survive; writing the five indexes out by name means it still will after
     * somebody adds one.
     *
     * Indexes first, table second, indexes again: sqlite drops an index with its
     * table, so recreating them after the rename is not optional. The five are
     * the two single-column ones from migration 3 and the three keyset ones from
     * the B2 migration, in the order those migrations created them.
     */
    private async rebuildSqlite(queryRunner: QueryRunner, subjectType: string): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_audit_events_actor_created"`);
        await queryRunner.query(`DROP INDEX "IDX_audit_events_subject_created"`);
        await queryRunner.query(`DROP INDEX "IDX_audit_events_created"`);
        await queryRunner.query(`DROP INDEX "IDX_911d10eeba0b44d6ae067a0fcf"`);
        await queryRunner.query(`DROP INDEX "IDX_2e65cfff9e135c7c99c9da371b"`);
        await queryRunner.query(
            `CREATE TABLE "temporary_audit_events" (` +
                `"id" varchar PRIMARY KEY NOT NULL, "event" varchar NOT NULL, ` +
                `"actorUserId" varchar NOT NULL, "subjectUserId" ${subjectType}, ` +
                `"targetId" varchar, "action" varchar, "reason" text, "detail" text, ` +
                `"createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
        );
        await queryRunner.query(
            `INSERT INTO "temporary_audit_events"(` +
                `"id", "event", "actorUserId", "subjectUserId", "targetId", "action", "reason", "detail", "createdAt") ` +
                `SELECT "id", "event", "actorUserId", "subjectUserId", "targetId", "action", "reason", "detail", "createdAt" ` +
                `FROM "audit_events"`,
        );
        await queryRunner.query(`DROP TABLE "audit_events"`);
        await queryRunner.query(`ALTER TABLE "temporary_audit_events" RENAME TO "audit_events"`);
        await queryRunner.query(`CREATE INDEX "IDX_2e65cfff9e135c7c99c9da371b" ON "audit_events" ("actorUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_911d10eeba0b44d6ae067a0fcf" ON "audit_events" ("subjectUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_created" ON "audit_events" ("createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_subject_created" ON "audit_events" ("subjectUserId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_actor_created" ON "audit_events" ("actorUserId", "createdAt", "id") `);
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
