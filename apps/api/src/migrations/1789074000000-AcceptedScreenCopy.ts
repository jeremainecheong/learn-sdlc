import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive: historical submissions retain their original absent context. */
export class AcceptedScreenCopy1789074000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "phase_states" ADD "acceptedScreenCopy" text');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "phase_states" DROP COLUMN "acceptedScreenCopy"');
  }
}
