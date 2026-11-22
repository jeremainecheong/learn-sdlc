import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * S8 — proposal feedback: the reason a structured proposal was refused stays
 * on its failed turn, and every proposal keeps the learner's short summary of
 * what it changes.
 *
 * ## `agent_turns.errorDetail`
 *
 * One nullable text column. Without it, a chat turn whose generated story,
 * design, runbook or change-request record the validator refused would fail
 * with its kind's fixed sentence alone ("The assistant's proposal was not a
 * valid design and was discarded.") and the rule's reason would be lost on
 * the way, so the learner and the operator would retry blind. The service
 * writes the reason here (`RefusedProposalException.detail`, at most 400
 * characters of the validator's own sentence) and the turn view says it after
 * the fixed sentence. Every other turn, and every turn written before this
 * migration, reads NULL and is shown exactly as before.
 *
 * ## `agent_proposals.summary`
 *
 * One nullable text column. The Agentic generation call also writes
 * a short summary for the learner, inside the same call: which files or record
 * sections the proposal changes and what to check before accepting it, never
 * why it is right. The service stores it here (`readProposalSummary`: one
 * line, at most 600 characters) and the review card and Compare show it above
 * the diff. It is not part of the explanation assessment. A proposal whose
 * model wrote none, and every proposal written before this migration, reads
 * NULL and shows no summary.
 *
 * Both dialects are real (sqlite is the supported local-first store). Each
 * column is added with raw `ALTER TABLE … ADD COLUMN` rather than
 * `queryRunner.addColumn`, for the reason the D6 header wrote down and H2 and
 * H3 repeated: the sqlite driver implements `addColumn` as a table rebuild.
 * No index names either column, so sqlite's `DROP COLUMN` (3.35+) reverses it in
 * place. Nullable and without a default, so neither dialect rewrites a row.
 */
export class S8ProposalFeedback1793430000000 implements MigrationInterface {
  name = 'S8ProposalFeedback1793430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const postgres = isPostgres(queryRunner, this.name);
    // Bounds the wait for the table lock, not the hold; see H3.
    if (postgres) await queryRunner.query(`SET lock_timeout = '3s'`);
    await queryRunner.query(
      postgres
        ? `ALTER TABLE "agent_turns" ADD "errorDetail" text NULL`
        : `ALTER TABLE "agent_turns" ADD COLUMN "errorDetail" text NULL`,
    );
    await queryRunner.query(
      postgres
        ? `ALTER TABLE "agent_proposals" ADD "summary" text NULL`
        : `ALTER TABLE "agent_proposals" ADD COLUMN "summary" text NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    isPostgres(queryRunner, this.name);
    await queryRunner.query(`ALTER TABLE "agent_turns" DROP COLUMN "errorDetail"`);
    await queryRunner.query(`ALTER TABLE "agent_proposals" DROP COLUMN "summary"`);
  }
}

/** Which of the two supported dialects this is; a third is refused by name rather than half-migrated. */
function isPostgres(queryRunner: QueryRunner, migration: string): boolean {
  const type = queryRunner.connection.options.type;
  if (type === 'postgres') return true;
  if (type === 'better-sqlite3' || type === 'sqlite') return false;
  throw new Error(`${migration}: this deployment supports postgres and better-sqlite3; the data source is "${type}"`);
}
