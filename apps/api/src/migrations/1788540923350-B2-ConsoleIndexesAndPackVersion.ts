import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The console at term scale: the six indexes every instructor page reads
 * through, and the two columns that say which content pack a learner started
 * under and which one graded an attempt.
 *
 * ## The indexes
 *
 * Each one replaces a full table scan, a sort of the whole table, or both.
 *
 *   - `users (role, cohort)`. `learnerScope` opens every instructor request
 *     with `role = 'LEARNER' AND cohort = ...`, and `email` was the only index
 *     on the table, so the overview, the class map, the export and the audit
 *     page each began with `SCAN users`. Cost grows with every account the
 *     deployment has ever had, not with the caller's class.
 *   - `audit_events (createdAt, id)`, `(subjectUserId, createdAt, id)` and
 *     `(actorUserId, createdAt, id)`. The trail is read newest first in three
 *     shapes — the whole trail, one learner's, or a class plus the caller's own
 *     actions — and nothing indexed `createdAt`, so every shape was
 *     `SCAN audit_events` then `USE TEMP B-TREE FOR ORDER BY`. `id` is the
 *     third column because the sort is `createdAt DESC, id DESC`: an index
 *     stopping at `createdAt` still leaves the tie-break to a temporary
 *     b-tree, and same-second rows are the normal case here.
 *   - `submissions (phaseStateId, createdAt, id)`. The class map and the CSV
 *     export want the newest attempt per phase state; `phaseStateId` alone
 *     could find the rows but not order them, so sqlite read a whole class's
 *     back catalogue and sorted it. With the ordering columns in the index,
 *     `MAX(createdAt)` per phase state is a covering-index seek.
 *   - `assistant_messages (userId, createdAt)`. `tokensToday` sums a learner's
 *     messages since midnight twice per mentor question, and the console asks
 *     it for the whole class on every load.
 *
 * ## The columns
 *
 * `enrollments.packVersion` and `submissions.packVersion` are nullable and
 * unwritten by this migration: the enrolment path stamps the first and the
 * grading path the second, from the version each pack declares.
 * Null therefore means "started or graded before packs were versioned", which
 * is the truth for every row that already exists and is not something a
 * backfill could invent.
 *
 * Additive only — six indexes and two nullable columns. Nothing is dropped,
 * renamed or retyped, and no row is rewritten, so it applies to a populated
 * database while the previous release is still serving. The single-column
 * indexes the composites supersede are deliberately left in place: dropping
 * them is a separate decision with its own risk, and an unused index costs a
 * little write time, not a page load.
 *
 * Both dialects are real: sqlite is the supported local-first store. The sqlite branch adds its columns with
 * raw `ALTER TABLE ... ADD COLUMN` rather than `queryRunner.addColumn`, for a
 * reason worth reading before writing the next sqlite migration: see the note
 * on `upSqlite` below.
 */
export class B2ConsoleIndexesAndPackVersion1788540923350 implements MigrationInterface {
    name = 'B2ConsoleIndexesAndPackVersion1788540923350'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * Drops the six indexes and the two columns. Reverting loses which pack
     * version graded an attempt, which is a fact about a grade rather than a
     * cache, so revert only a deploy that has not been used.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrollments" ADD "packVersion" character varying`);
        await queryRunner.query(`ALTER TABLE "submissions" ADD "packVersion" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_users_role_cohort" ON "users" ("role", "cohort") `);
        await queryRunner.query(`CREATE INDEX "IDX_submissions_phase_state_created" ON "submissions" ("phaseStateId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_assistant_messages_user_created" ON "assistant_messages" ("userId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_created" ON "audit_events" ("createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_subject_created" ON "audit_events" ("subjectUserId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_actor_created" ON "audit_events" ("actorUserId", "createdAt", "id") `);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_events_actor_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_events_subject_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_events_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_assistant_messages_user_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_submissions_phase_state_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_users_role_cohort"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "packVersion"`);
        await queryRunner.query(`ALTER TABLE "enrollments" DROP COLUMN "packVersion"`);
    }

    /**
     * Raw `ALTER TABLE ... ADD COLUMN`, not `queryRunner.addColumn`.
     *
     * TypeORM's sqlite driver implements `addColumn` as a table rebuild — a
     * new table, a copy of every row, a rename — and the rebuild recreates the
     * table's indexes from the definition it read a moment earlier. That
     * definition loses the `WHERE` on a partial index, so rebuilding
     * `submissions` silently drops `UQ_submissions_in_flight` (the
     * at-most-one-grading-in-flight rule) and leaves a database that accepts a
     * double submit. Verified: with `addColumn`, a second `queued` row for the
     * same phase state is accepted after this migration, and the schema
     * builder reports the index as still pending.
     *
     * sqlite's own `ADD COLUMN` needs no rebuild for a nullable column with no
     * default, which is exactly what these two are, so every index on the
     * table survives untouched. The usual warning about raw
     * `ADD COLUMN` is about non-constant defaults (`datetime('now')`), which
     * these do not have.
     *
     * Columns first, then indexes, so nothing new has to survive a rewrite.
     */
    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrollments" ADD COLUMN "packVersion" varchar`);
        await queryRunner.query(`ALTER TABLE "submissions" ADD COLUMN "packVersion" varchar`);
        await queryRunner.query(`CREATE INDEX "IDX_users_role_cohort" ON "users" ("role", "cohort") `);
        await queryRunner.query(`CREATE INDEX "IDX_submissions_phase_state_created" ON "submissions" ("phaseStateId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_assistant_messages_user_created" ON "assistant_messages" ("userId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_created" ON "audit_events" ("createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_subject_created" ON "audit_events" ("subjectUserId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_events_actor_created" ON "audit_events" ("actorUserId", "createdAt", "id") `);
    }

    /** Raw `DROP COLUMN` for the same reason `up` uses raw `ADD COLUMN`. */
    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_audit_events_actor_created"`);
        await queryRunner.query(`DROP INDEX "IDX_audit_events_subject_created"`);
        await queryRunner.query(`DROP INDEX "IDX_audit_events_created"`);
        await queryRunner.query(`DROP INDEX "IDX_assistant_messages_user_created"`);
        await queryRunner.query(`DROP INDEX "IDX_submissions_phase_state_created"`);
        await queryRunner.query(`DROP INDEX "IDX_users_role_cohort"`);
        await queryRunner.query(`ALTER TABLE "submissions" DROP COLUMN "packVersion"`);
        await queryRunner.query(`ALTER TABLE "enrollments" DROP COLUMN "packVersion"`);
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
