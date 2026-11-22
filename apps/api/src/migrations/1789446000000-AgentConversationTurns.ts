import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive: it creates `agent_turns` and rewrites no existing proposal or learner row. */
export class AgentConversationTurns1789446000000 implements MigrationInterface {
  name = 'AgentConversationTurns1789446000000';

  async up(runner: QueryRunner): Promise<void> {
    const pg = runner.connection.options.type === 'postgres';
    // SQLite's TypeORM introspector expects the final CHECK and table closing
    // parenthesis on one line. Preserve both constraints in schema discovery.
    await runner.query(`CREATE TABLE "agent_turns" (
      "id" ${pg ? 'uuid NOT NULL DEFAULT uuid_generate_v4()' : 'varchar NOT NULL'} PRIMARY KEY,
      "userId" varchar NOT NULL, "phaseStateId" varchar NOT NULL,
      "requestId" varchar NOT NULL, "requestHash" varchar NOT NULL,
      "kind" varchar NOT NULL, "status" varchar NOT NULL, "message" text NOT NULL,
      "parentTurnId" varchar, "parentProposalId" varchar, "parentProposalHash" varchar,
      "baseWorkspaceHash" varchar NOT NULL, "proposalId" varchar,
      "response" text, "errorCode" varchar,
      "createdAt" ${pg ? 'TIMESTAMP NOT NULL DEFAULT now()' : "datetime NOT NULL DEFAULT (datetime('now'))"},
      "updatedAt" ${pg ? 'TIMESTAMP NOT NULL DEFAULT now()' : "datetime NOT NULL DEFAULT (datetime('now'))"},
      CONSTRAINT "CHK_agent_turns_kind" CHECK ("kind" IN ('chat', 'explain')),
      CONSTRAINT "CHK_agent_turns_status" CHECK ("status" IN ('pending', 'completed', 'failed')))`);
    await runner.query('CREATE UNIQUE INDEX "UQ_agent_turns_request" ON "agent_turns" ("userId", "requestId")');
    await runner.query('CREATE INDEX "IDX_agent_turns_owner_phase_created" ON "agent_turns" ("userId", "phaseStateId", "createdAt", "id")');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "agent_turns"');
  }
}
