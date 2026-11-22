import { MigrationInterface, QueryRunner } from "typeorm";

/** The learner-facing half of a superseded grading job: it will never finish. */
const SUPERSEDED_MESSAGE =
    'This submission was superseded by a newer attempt and never finished grading. ' +
    'Nothing was lost — your workspace is saved. Press Submit again to grade it.';

/**
 * Three uniqueness rules the code was only ever asserting in JavaScript, moved
 * into the database:
 *
 *   - `enrollments (userId, projectSlug)` — one enrolment per learner and
 *     project. `WorkflowService.enroll` guards with a `findOne` and then
 *     inserts, so two tabs, a double-tapped Start or a retried request all
 *     pass the guard and all insert.
 *   - `phase_states (enrollmentId, phaseOrder)` — one row per phase. Enrolment
 *     writes its six rows one at a time, and the repair that fills a
 *     half-written enrolment must not be able to add a second phase 4.
 *   - `submissions (phaseStateId) WHERE status IN ('queued','running')` — at
 *     most one grading job in flight per phase, so a double-submit cannot put
 *     two gradings on the same phase state. Terminal rows stay outside the
 *     index: the phase keeps its whole back catalogue of attempts.
 *
 * Written for both dialects, and deliberately not dialect-guarded. sqlite and
 * Postgres both take `WHERE` on `CREATE UNIQUE INDEX` with the same syntax,
 * and TypeORM's schema sync emits the identical shape for the sqlite the unit
 * tests build, so the synchronised schema and the migrated one agree. Only the
 * parameter placeholder and the boolean literal differ, and both are resolved
 * from `connection.options.type` below.
 *
 * Additive: three indexes and one status repair. No column is dropped,
 * renamed or retyped.
 *
 * ## Why up() repairs before it indexes
 *
 * `CREATE UNIQUE INDEX` fails on a table that already holds the duplicate it
 * is meant to prevent, and the instructor's laptop has to boot on the morning
 * of a class whatever its table holds. So each index is preceded by the
 * narrowest repair that can be made without touching learner work:
 *
 *   - superseded in-flight submissions are moved to `failed`, which is job
 *     bookkeeping rather than coursework and is the terminal state
 *     `JobRecoveryService` already writes for a job that can no longer finish;
 *   - a duplicate enrolment is deleted only when it carries no work at all —
 *     no workspace, reflection, score, attempt, link, drill, pass, submission,
 *     run, mentor message or release — which is the shape a retried POST
 *     leaves behind seconds apart, and the copy the product already ignores.
 *
 * A duplicate that does carry work is a human decision — which of the two
 * copies is the learner's real one — so the migration stops with a message
 * naming the rows rather than guessing. `phase_states` needs no repair: a
 * duplicate there cannot arise from any code that has shipped, because each
 * enrolment writes its six orders exactly once.
 */
export class A3UniqueEnrolmentAndInFlightIndexes1788534380347 implements MigrationInterface {
    name = 'A3UniqueEnrolmentAndInFlightIndexes1788534380347'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.retireSupersededSubmissions(queryRunner);
        await this.dropEmptyDuplicateEnrolments(queryRunner);

        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_enrollments_user_project" ON "enrollments" ("userId", "projectSlug")`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_phase_states_enrollment_order" ON "phase_states" ("enrollmentId", "phaseOrder")`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_submissions_in_flight" ON "submissions" ("phaseStateId") WHERE status IN ('queued','running')`);
    }

    /**
     * Everything queued or running for a phase except the newest one. Two rows
     * in flight for one phase mean a double-submit got past the read-then-write
     * guard; the newest is the one the learner is watching, and the older ones
     * would grade the same workspace a second time.
     */
    private async retireSupersededSubmissions(queryRunner: QueryRunner): Promise<void> {
        const stale: { id: string }[] = await queryRunner.query(`
            SELECT s."id" AS "id" FROM "submissions" s
            WHERE s."status" IN ('queued','running')
              AND EXISTS (
                SELECT 1 FROM "submissions" n
                WHERE n."phaseStateId" = s."phaseStateId"
                  AND n."status" IN ('queued','running')
                  AND (n."createdAt" > s."createdAt" OR (n."createdAt" = s."createdAt" AND n."id" > s."id"))
              )
        `);
        for (const row of stale) {
            await queryRunner.query(
                `UPDATE "submissions" SET "status" = 'failed', "error" = ${this.bind(queryRunner, 1)} ` +
                    `WHERE "id" = ${this.bind(queryRunner, 2)}`,
                [SUPERSEDED_MESSAGE, row.id],
            );
        }
        if (stale.length) {
            console.warn(
                `[A3] ${stale.length} superseded in-flight submission(s) marked failed before the in-flight index`,
            );
        }
    }

    /**
     * Duplicate enrolments, oldest kept — the rule `analytics.service.ts`
     * already applies when it builds the class map. An untouched duplicate and
     * its phase states go; one with work in it stops the migration.
     */
    private async dropEmptyDuplicateEnrolments(queryRunner: QueryRunner): Promise<void> {
        const duplicates: { id: string; userId: string; projectSlug: string }[] = await queryRunner.query(`
            SELECT e."id" AS "id", e."userId" AS "userId", e."projectSlug" AS "projectSlug" FROM "enrollments" e
            WHERE EXISTS (
                SELECT 1 FROM "enrollments" o
                WHERE o."userId" = e."userId" AND o."projectSlug" = e."projectSlug"
                  AND (o."startedAt" < e."startedAt" OR (o."startedAt" = e."startedAt" AND o."id" < e."id"))
            )
        `);
        if (!duplicates.length) return;

        const working = await this.enrolmentsCarryingWork(queryRunner);
        const contested = duplicates.filter((d) => working.has(d.id));
        if (contested.length) {
            throw new Error(
                `A3 cannot add the unique index on enrollments (userId, projectSlug): ` +
                    `${contested.length} duplicate enrolment(s) hold learner work, and only a person can say which ` +
                    `copy is the real one — ` +
                    contested.map((d) => `${d.userId} on ${d.projectSlug} (enrolment ${d.id})`).join('; ') +
                    `. See docs/production-runbook.md before re-running.`,
            );
        }
        for (const duplicate of duplicates) {
            await queryRunner.query(
                `DELETE FROM "phase_states" WHERE "enrollmentId" = ${this.bind(queryRunner, 1)}`,
                [duplicate.id],
            );
            await queryRunner.query(
                `DELETE FROM "enrollments" WHERE "id" = ${this.bind(queryRunner, 1)}`,
                [duplicate.id],
            );
        }
        console.warn(`[A3] ${duplicates.length} empty duplicate enrolment(s) removed before the unique index`);
    }

    /**
     * Every enrolment holding anything a learner typed, ran, was graded on,
     * asked about or shipped. One set-based pass rather than a query per
     * duplicate, and no bound parameters, so the SQL is the same either side.
     * The casts are load-bearing on Postgres: every id column is `uuid` while
     * the `enrollmentId` and `phaseStateId` the children carry are
     * `character varying`, and Postgres has no `varchar = uuid` operator and
     * will not union the two types. sqlite ignores the cast.
     */
    private async enrolmentsCarryingWork(queryRunner: QueryRunner): Promise<Set<string>> {
        const untouched = queryRunner.connection.options.type === 'postgres' ? 'false' : '0';
        const rows: { id: string }[] = await queryRunner.query(`
            SELECT CAST(e."id" AS varchar) AS "id" FROM "enrollments" e
              WHERE e."completed" <> ${untouched} OR e."currentPhaseOrder" <> 1
            UNION SELECT p."enrollmentId" FROM "phase_states" p
              WHERE p."workspace" IS NOT NULL OR p."reflection" IS NOT NULL OR p."bestScore" IS NOT NULL
                 OR p."attempts" <> 0 OR p."links" IS NOT NULL OR p."drill" IS NOT NULL
                 OR p."passedAt" IS NOT NULL
            UNION SELECT r."enrollmentId" FROM "releases" r
            UNION SELECT m."enrollmentId" FROM "assistant_messages" m
            UNION SELECT p2."enrollmentId" FROM "phase_states" p2
              JOIN "submissions" s ON s."phaseStateId" = CAST(p2."id" AS varchar)
            UNION SELECT p3."enrollmentId" FROM "phase_states" p3
              JOIN "execution_runs" x ON x."phaseStateId" = CAST(p3."id" AS varchar)
        `);
        return new Set(rows.map((row) => row.id));
    }

    /** Postgres numbers its placeholders; sqlite takes them positionally. */
    private bind(queryRunner: QueryRunner, index: number): string {
        return queryRunner.connection.options.type === 'postgres' ? `$${index}` : '?';
    }

    /**
     * Drops the three indexes and nothing else. The submissions retired above
     * are not un-retired and the empty duplicate enrolments are not recreated:
     * neither held learner work, and a revert that invented rows would be
     * worse than one that does not.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const scope = queryRunner.connection.options.type === 'postgres' ? '"public".' : '';
        await queryRunner.query(`DROP INDEX ${scope}"UQ_submissions_in_flight"`);
        await queryRunner.query(`DROP INDEX ${scope}"UQ_phase_states_enrollment_order"`);
        await queryRunner.query(`DROP INDEX ${scope}"UQ_enrollments_user_project"`);
    }

}
