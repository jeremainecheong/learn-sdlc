import { MigrationInterface, QueryRunner } from 'typeorm';
export class SubmissionProcessingLease1789071000003 implements MigrationInterface {
  name = 'SubmissionProcessingLease1789071000003';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "submissions" ADD "processingToken" varchar');
    await runner.query('ALTER TABLE "submissions" ADD "processingLeaseUntil" varchar');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "submissions" DROP COLUMN "processingLeaseUntil"');
    await runner.query('ALTER TABLE "submissions" DROP COLUMN "processingToken"');
  }
}
