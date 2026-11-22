import { MigrationInterface, QueryRunner } from 'typeorm';
export class LessonConversationScope1789071000002 implements MigrationInterface {
  name = 'LessonConversationScope1789071000002';
  async up(runner: QueryRunner): Promise<void> { await runner.query('ALTER TABLE "assistant_messages" ADD "conversationScope" varchar NOT NULL DEFAULT \'project\''); }
  async down(runner: QueryRunner): Promise<void> { await runner.query('ALTER TABLE "assistant_messages" DROP COLUMN "conversationScope"'); }
}
