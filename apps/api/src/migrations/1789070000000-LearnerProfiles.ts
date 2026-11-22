import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive DDL preserves existing SQLite indexes and data; no table reconstruction. */
export class LearnerProfiles1789070000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const pg = runner.connection.options.type === 'postgres';
    await runner.query('ALTER TABLE "users" ADD COLUMN "avatar" integer NOT NULL DEFAULT (0)');
    await runner.query(`ALTER TABLE "users" ADD COLUMN "bio" text NOT NULL DEFAULT ('')`);
    await runner.query(`ALTER TABLE "users" ADD COLUMN "goals" text NOT NULL DEFAULT ('')`);
    await runner.query(`ALTER TABLE "users" ADD COLUMN "onboardingCompleted" boolean NOT NULL DEFAULT (${pg ? 'false' : '0'})`);
    // Existing learners retain their established journey; new accounts onboard.
    await runner.query(`UPDATE "users" SET "onboardingCompleted" = ${pg ? 'true' : '1'}`);
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const name of ['onboardingCompleted', 'goals', 'bio', 'avatar']) await runner.query(`ALTER TABLE "users" DROP COLUMN "${name}"`);
  }
}
