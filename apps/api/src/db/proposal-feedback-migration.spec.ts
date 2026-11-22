import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES, AgentProposalEntity, AgentTurnEntity } from './entities';

/**
 * The S8 migration on the local-first store: `agent_turns.errorDetail`, the
 * reason a structured proposal was refused, and `agent_proposals.summary`, the
 * learner's short note of what a proposal changes.
 *
 * `database.module.spec.ts` asserts the two parity properties over every
 * migration (zero pending schema-builder queries after the run, a full revert
 * back to an empty file); this is the narrow proof, in the shape of the H3 migration's spec:
 * each column lands nullable, a refused turn or a summarised proposal fills
 * it and every other row leaves it NULL, and the reversal drops both columns
 * and leaves the rows in place.
 */
describe('the S8 proposal feedback migration', () => {
  const migrations = [path.join(__dirname, '..', 'migrations', '*.{ts,js}')];
  let dir = '';
  let opened: DataSource[] = [];

  const open = async (file: string): Promise<DataSource> => {
    const dataSource = await new DataSource({
      type: 'better-sqlite3', database: file, entities: ALL_ENTITIES, synchronize: false, migrationsRun: true, migrations, migrationsTableName: 'learnsdlc_migrations',
    } as DataSourceOptions).initialize();
    opened.push(dataSource);
    return dataSource;
  };
  const columns = async (dataSource: DataSource, table = 'agent_turns'): Promise<{ name: string; type: string; notnull: number }[]> =>
    (await dataSource.query(`PRAGMA table_info("${table}")`)) as { name: string; type: string; notnull: number }[];
  const proposal = (prompt: string, summary: string | null): Partial<AgentProposalEntity> => ({
    userId: 'learner-1', phaseStateId: 'phase-1', prompt, files: { 'tasks.py': 'x' }, proposalHash: `hash-${prompt}`, baseWorkspaceHash: 'base', lastEdit: null,
    assessment: { adequate: true, feedback: 'Bounded.', questions: [] }, summary, explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null,
  });
  const SUMMARY = 'Changes tasks.py. Check the boundary at today.';
  const turn = (requestId: string, patch: Partial<AgentTurnEntity>): Partial<AgentTurnEntity> => ({
    userId: 'learner-1', phaseStateId: 'phase-1', requestId, requestHash: `hash-${requestId}`, kind: 'chat', status: 'failed', message: 'Add a screen.',
    parentTurnId: null, parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'base', proposalId: null, response: null, errorCode: null, errorDetail: null, ...patch,
  });

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-s8-')); });
  afterEach(async () => {
    for (const dataSource of opened) if (dataSource.isInitialized) await dataSource.destroy();
    opened = [];
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('adds the column nullable, which a refused turn fills and every other turn leaves NULL', async () => {
    const db = await open(path.join(dir, 'up.sqlite'));
    const column = (await columns(db)).find((c) => c.name === 'errorDetail');
    expect({ type: column?.type.toLowerCase(), notnull: column?.notnull }).toEqual({ type: 'text', notnull: 0 });
    const repo = db.getRepository(AgentTurnEntity);
    await repo.save(repo.create(turn('r-1', { errorCode: 'design_proposal_refused', errorDetail: 'The design record is not valid: decision D1 satisfies is not a list.' })));
    await repo.save(repo.create(turn('r-2', { errorCode: 'request_failed' })));
    expect((await repo.findOneByOrFail({ requestId: 'r-1' })).errorDetail).toBe('The design record is not valid: decision D1 satisfies is not a list.');
    expect((await repo.findOneByOrFail({ requestId: 'r-2' })).errorDetail).toBeNull();
  });

  it('adds agent_proposals.summary nullable, which a summarised proposal fills and every other proposal leaves NULL', async () => {
    const db = await open(path.join(dir, 'up-proposals.sqlite'));
    const column = (await columns(db, 'agent_proposals')).find((c) => c.name === 'summary');
    expect({ type: column?.type.toLowerCase(), notnull: column?.notnull }).toEqual({ type: 'text', notnull: 0 });
    const repo = db.getRepository(AgentProposalEntity);
    const withSummary = await repo.save(repo.create(proposal('p-1', SUMMARY)));
    const without = await repo.save(repo.create(proposal('p-2', null)));
    expect((await repo.findOneByOrFail({ id: withSummary.id })).summary).toBe(SUMMARY);
    expect((await repo.findOneByOrFail({ id: without.id })).summary).toBeNull();
  });

  it('reverts in place: both columns are gone and the rows stay', async () => {
    const db = await open(path.join(dir, 'down.sqlite'));
    const repo = db.getRepository(AgentTurnEntity);
    await repo.save(repo.create(turn('r-3', { errorCode: 'design_proposal_refused', errorDetail: 'The design record is not valid: decision D1 satisfies is not a list.' })));
    const proposals = db.getRepository(AgentProposalEntity);
    await proposals.save(proposals.create(proposal('p-3', SUMMARY)));
    const applied = async (): Promise<boolean> =>
      ((await db.query(`SELECT name FROM learnsdlc_migrations WHERE name = ?`, ['S8ProposalFeedback1793430000000'])) as unknown[]).length > 0;
    expect(await applied()).toBe(true);
    while (await applied()) await db.undoLastMigration();
    expect((await columns(db)).map((c) => c.name)).not.toContain('errorDetail');
    expect((await columns(db, 'agent_proposals')).map((c) => c.name)).not.toContain('summary');
    expect(((await db.query(`SELECT "prompt" FROM "agent_proposals"`)) as { prompt: string }[])).toEqual([{ prompt: 'p-3' }]);
    expect(((await db.query(`SELECT "requestId", "errorCode" FROM "agent_turns"`)) as { requestId: string; errorCode: string }[])).toEqual([{ requestId: 'r-3', errorCode: 'design_proposal_refused' }]);
  });
});
