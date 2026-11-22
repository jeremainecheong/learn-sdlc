import { MigrationInterface, QueryRunner } from 'typeorm';
export class SubmissionContext1789071000001 implements MigrationInterface {
  name = 'SubmissionContext1789071000001';
  async up(runner: QueryRunner): Promise<void> { await runner.query('ALTER TABLE "submissions" ADD "contextSnapshot" text'); }
  async down(runner: QueryRunner): Promise<void> { await runner.query('ALTER TABLE "submissions" DROP COLUMN "contextSnapshot"'); }
}
