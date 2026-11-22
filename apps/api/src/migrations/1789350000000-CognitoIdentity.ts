import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive: does not rewrite account ids, passwords, roles or learning records. */
export class CognitoIdentity1789350000000 implements MigrationInterface {
  name = 'CognitoIdentity1789350000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "users" ADD "cognitoSub" varchar');
    await runner.query('CREATE UNIQUE INDEX "IDX_users_cognitoSub" ON "users" ("cognitoSub")');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "IDX_users_cognitoSub"');
    await runner.query('ALTER TABLE "users" DROP COLUMN "cognitoSub"');
  }
}
