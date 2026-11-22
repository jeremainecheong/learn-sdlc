import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AgentTurnEntity } from './agent-turn.entity';
import { AgentProposalEntity } from './agent-proposal.entity';
import { AgentConversationTurns1789446000000 } from '../migrations/1789446000000-AgentConversationTurns';
import { AgentProposals1789071000000 } from '../migrations/1789071000000-AgentProposals';
import { AgencyEditEvidence1789076000000 } from '../migrations/1789076000000-AgencyEditEvidence';
import { S8ProposalFeedback1793430000000 } from '../migrations/1793430000000-S8-ProposalFeedback';

describe('the private Agentic turn journal', () => {
  let source: DataSource;
  const migration = new AgentConversationTurns1789446000000();

  beforeEach(async () => {
    source = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [AgentTurnEntity, AgentProposalEntity] });
    await source.initialize();
    // The proposal-feedback migration adds a column to the journal and one to the proposals, so both tables exist
    // before it runs.
    await new AgentProposals1789071000000().up(source.createQueryRunner());
    await new AgencyEditEvidence1789076000000().up(source.createQueryRunner());
    await migration.up(source.createQueryRunner());
    await new S8ProposalFeedback1793430000000().up(source.createQueryRunner());
  });
  afterEach(async () => { if (source?.isInitialized) await source.destroy(); });

  const turn = (userId: string, requestId: string) => ({
    userId, phaseStateId: randomUUID(), requestId, requestHash: 'a'.repeat(64),
    kind: 'chat' as const, status: 'pending' as const,
    message: 'Clarify the exact due-date boundary.', baseWorkspaceHash: 'b'.repeat(64),
  });

  it('lets only one pending request be recorded per owner, including simultaneous duplicate inserts', async () => {
    const repo = source.getRepository(AgentTurnEntity);
    const owner = randomUUID(), requestId = randomUUID();
    const outcomes = await Promise.allSettled([
      repo.insert(turn(owner, requestId)), repo.insert(turn(owner, requestId)),
    ]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(await repo.countBy({ userId: owner, requestId })).toBe(1);
    await repo.insert(turn(randomUUID(), requestId));
    expect(await repo.count()).toBe(2);
  });

  it('rejects impossible operation kinds and states in the database', async () => {
    const repo = source.getRepository(AgentTurnEntity);
    await expect(repo.insert({ ...turn(randomUUID(), randomUUID()), kind: 'apply' as 'chat' })).rejects.toThrow();
    await expect(repo.insert({ ...turn(randomUUID(), randomUUID()), status: 'approved' as 'pending' })).rejects.toThrow();
    expect(await repo.count()).toBe(0);
  });

  it('adds and reverts the journal without rewriting previous proposals or their assessments', async () => {
    const runner = source.createQueryRunner();
    await new S8ProposalFeedback1793430000000().down(runner);
    await migration.down(runner);
    // Written the way a proposal was before that migration: in raw SQL, since the entity names the summary column.
    await source.query(
      'INSERT INTO "agent_proposals" ("id", "userId", "phaseStateId", "prompt", "files", "proposalHash", "baseWorkspaceHash", "assessment", "explanation", "explanationAssessment") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), randomUUID(), randomUUID(), 'Keep the due-date boundary strict.', JSON.stringify({ 'story.md': 'original' }), 'c'.repeat(64), 'd'.repeat(64),
        JSON.stringify({ adequate: true, feedback: 'The requested boundary is explicit.', questions: [] }), 'A task due today is overdue.',
        JSON.stringify({ adequate: false, feedback: 'Today is not overdue.', questions: ['What changes tomorrow?'] })],
    );
    const before = await source.query('SELECT * FROM agent_proposals');
    await migration.up(runner);
    await new S8ProposalFeedback1793430000000().up(runner);
    await source.getRepository(AgentTurnEntity).insert(turn(randomUUID(), randomUUID()));
    // The migration adds only the summary column, NULL on the earlier row; nothing else in the row moves.
    expect(await source.query('SELECT * FROM agent_proposals')).toEqual(before.map((row: object) => ({ ...row, summary: null })));
    expect((await source.getRepository(AgentProposalEntity).findOneByOrFail({ prompt: 'Keep the due-date boundary strict.' })).summary).toBeNull();
    await new S8ProposalFeedback1793430000000().down(runner);
    await migration.down(runner);
    expect(await source.query('SELECT * FROM agent_proposals')).toEqual(before);
    expect(await runner.hasTable('agent_turns')).toBe(false);
  });
});
