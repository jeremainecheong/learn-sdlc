import { MigrationInterface, QueryRunner } from 'typeorm';

export class AgentProposals1789071000000 implements MigrationInterface {
  name = 'AgentProposals1789071000000';
  async up(runner: QueryRunner): Promise<void> {
    const pg = runner.connection.options.type === 'postgres';
    await runner.query(`CREATE TABLE "agent_proposals" (
      "id" ${pg ? 'uuid NOT NULL DEFAULT uuid_generate_v4()' : 'varchar NOT NULL'} PRIMARY KEY,
      "userId" varchar NOT NULL, "phaseStateId" varchar NOT NULL, "prompt" text NOT NULL,
      "files" text NOT NULL, "proposalHash" varchar NOT NULL, "baseWorkspaceHash" varchar NOT NULL,
      "assessment" text NOT NULL, "explanation" text, "explanationAssessment" text,
      "approvedAt" varchar, "appliedAt" varchar,
      "createdAt" ${pg ? 'TIMESTAMP NOT NULL DEFAULT now()' : "datetime NOT NULL DEFAULT (datetime('now'))"},
      "updatedAt" ${pg ? 'TIMESTAMP NOT NULL DEFAULT now()' : "datetime NOT NULL DEFAULT (datetime('now'))"}
    )`);
    await runner.query('CREATE INDEX "IDX_agent_proposals_owner_phase" ON "agent_proposals" ("userId", "phaseStateId")');
  }
  async down(runner: QueryRunner): Promise<void> { await runner.query('DROP TABLE "agent_proposals"'); }
}
