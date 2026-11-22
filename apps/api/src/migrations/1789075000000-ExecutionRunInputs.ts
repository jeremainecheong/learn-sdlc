import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ExecutionRunInputs1789075000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "execution_runs" ADD "inputSnapshot" text');
    await runner.query('ALTER TABLE "execution_runs" ADD "inputHash" varchar');
    await runner.query('ALTER TABLE "execution_runs" ADD "runClock" varchar');
    await runner.query('ALTER TABLE "execution_runs" ADD "processingToken" varchar');
    await runner.query('ALTER TABLE "execution_runs" ADD "processingLeaseUntil" varchar');
    await runner.query('ALTER TABLE "execution_runs" ADD "error" text');
    // These jobs predate immutable inputs. Retain their records and results;
    // running today's draft would falsely describe what their Run click meant.
    await runner.query(`UPDATE "execution_runs" SET "status" = 'failed', "error" = 'This older run did not retain its inputs. Your saved work is unchanged. Press Run again to execute the current files.' WHERE "kind" = 'run' AND "status" IN ('queued','running') AND "inputSnapshot" IS NULL`);
    await runner.query(`CREATE UNIQUE INDEX "UQ_execution_runs_in_flight" ON "execution_runs" ("phaseStateId") WHERE kind = 'run' AND status IN ('queued','running')`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "UQ_execution_runs_in_flight"');
    for (const column of ['error', 'processingLeaseUntil', 'processingToken', 'runClock', 'inputHash', 'inputSnapshot']) {
      await runner.query(`ALTER TABLE "execution_runs" DROP COLUMN "${column}"`);
    }
  }
}
