import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The bell's table.
 *
 * ## `notifications`
 *
 * One row per thing the product has to tell somebody: a gate passed, a review
 * posted, a deadline near, a drill still open, a stuck flag answered, a note
 * from an instructor — and, on the staff side, which learner needs a look.
 *
 * A notification is a pointer, never a record. Every fact it names is stored
 * somewhere that is kept for the term (the submission, the report, the audit
 * row, the class schedule), which is what lets the service delete these on
 * three retention rules without losing anything: read rows after seven days,
 * everything after thirty, and never more than two hundred per account.
 *
 * `IDX_notifications_user_created` carries `id` as its third column for the
 * reason the B2 migration gives for the audit indexes: the list sorts
 * `createdAt DESC, id DESC`, and an index stopping at `createdAt` still leaves
 * sqlite a temporary b-tree for the tie-break — and same-second rows are the
 * normal case here, since one verdict writes `gate.passed` and `review.posted`
 * together.
 *
 * `UQ_notifications_unread_subject` is the partial index that stops the bell
 * repeating itself: at most one *unread* row per account, kind and subject, so
 * a drill open for three days is one row rather than one every fifteen
 * minutes. The insert loses to the index rather than to a read-then-write,
 * which is the only version of this that survives the sweep and the grading
 * pipeline firing together.
 *
 * **Never** use `queryRunner.addColumn` or `dropColumn` on this table in a
 * later sqlite migration. The driver rebuilds the table from the definition it
 * just read and recreates its indexes without their `WHERE` clause, which
 * would silently drop the predicate above and let the bell repeat itself. Use
 * raw `ALTER TABLE "notifications" ADD COLUMN "x" varchar` instead — the rule
 * the B2 migration documents for `submissions` and `UQ_submissions_in_flight`.
 *
 * One new table, no change to any existing one, so it applies to a populated
 * database while the previous release is serving and the previous release
 * keeps working against it. `readAt` is an ISO instant in a `varchar` like
 * `passedAt` and `unlockedAt` rather than a dialect date, so the predicate and
 * the retention comparisons read identically on both dialects.
 *
 * The timestamp is the first of a fixed block (1788600000000 onwards), so the
 * chain order is fixed by the file names; nothing in this migration depends on
 * the others in that block.
 */
export class D4Notifications1788600000000 implements MigrationInterface {
    name = 'D4Notifications1788600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    /**
     * Drops the table. Reverting loses every unread row, which costs a learner
     * the pointers and nothing else: the gate, the review, the deadline and
     * the flag are all still where they were written.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "audience" character varying NOT NULL DEFAULT 'learner', "kind" character varying NOT NULL, "title" character varying NOT NULL, "detail" text, "href" character varying NOT NULL, "phaseKey" character varying, "subjectKey" character varying NOT NULL, "actorUserId" character varying, "readAt" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_notifications_unread_subject" ON "notifications" ("userId", "kind", "subjectKey") WHERE "readAt" IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_notifications_user_created" ON "notifications" ("userId", "createdAt", "id") `);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_notifications_user_created"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_notifications_unread_subject"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
    }

    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "notifications" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "audience" varchar NOT NULL DEFAULT ('learner'), "kind" varchar NOT NULL, "title" varchar NOT NULL, "detail" text, "href" varchar NOT NULL, "phaseKey" varchar, "subjectKey" varchar NOT NULL, "actorUserId" varchar, "readAt" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_notifications_unread_subject" ON "notifications" ("userId", "kind", "subjectKey") WHERE "readAt" IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_notifications_user_created" ON "notifications" ("userId", "createdAt", "id") `);
    }

    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_notifications_user_created"`);
        await queryRunner.query(`DROP INDEX "UQ_notifications_unread_subject"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
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
