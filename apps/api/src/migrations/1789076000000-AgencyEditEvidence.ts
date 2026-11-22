import { MigrationInterface, QueryRunner } from 'typeorm';

/** Preserve exact prior proposal bytes for explanation of the learner's latest edit. */
export class AgencyEditEvidence1789076000000 implements MigrationInterface {
  name = 'AgencyEditEvidence1789076000000';
  async up(runner: QueryRunner): Promise<void> { await runner.query('ALTER TABLE "agent_proposals" ADD "lastEdit" text'); }
  async down(runner: QueryRunner): Promise<void> { await runner.query('ALTER TABLE "agent_proposals" DROP COLUMN "lastEdit"'); }
}
