import { MigrationInterface, QueryRunner } from "typeorm";

export class ProfileVersion1789073000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE "users" ADD COLUMN "profileVersion" integer NOT NULL DEFAULT (0)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "users" DROP COLUMN "profileVersion"');
  }
}
