import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { AgenticService } from '../src/assistant/agentic.service';
import { AgentTurnEntity } from '../src/assistant/agent-turn.entity';
import { buildDataSourceOptions } from '../src/db/database.module';
import { describeIfPostgres } from './support/postgres';

/** Real PostgreSQL timestamp(6), actual turns() query, no model or app writes.
 * One connection's TEMP table shadows the migrated public journal. All writes
 * and cleanup explicitly name pg_temp; retained owners and rows stay untouched.
 */

describeIfPostgres('Agentic journal pagination preserves PostgreSQL microseconds', () => {
  let source: DataSource;
  let connection: QueryRunner;
  let service: AgenticService;
  const owner = randomUUID(), otherOwner = randomUUID();
  const phaseId = randomUUID(), otherPhaseId = randomUUID(), otherOwnerPhaseId = randomUUID();
  const provider = { structured: jest.fn() };

  beforeAll(async () => {
    const options = buildDataSourceOptions();
    if (options.type !== 'postgres') throw new Error('This regression requires PostgreSQL');
    source = new DataSource({ ...options, entities: [AgentTurnEntity], synchronize: false, migrationsRun: false,
      extra: { ...options.extra, max: 1 } });
    await source.initialize();
    connection = source.createQueryRunner();
    await connection.connect();
    await connection.query('CREATE TEMP TABLE agent_turns (LIKE public.agent_turns INCLUDING ALL)');
    const workflow = {
      loadOwnedState: async (userId: string, requestedPhase: string) => {
        if (!((userId === owner && (requestedPhase === phaseId || requestedPhase === otherPhaseId)) || (userId === otherOwner && requestedPhase === otherOwnerPhaseId))) {
          throw new ForbiddenException('Not your phase');
        }
        return { state: { workspace: {} }, phase: { files: [] } };
      },
    };
    // Keep the real TypeORM repository/query builder on the TEMP-owning
    // connection. No SQL, result or clock mock participates in pagination.
    jest.spyOn(source, 'getRepository').mockImplementation(entity => connection.manager.getRepository(entity));
    // The constructor's last two arguments are the run repository (read only
    // by the explanation review) and the pinned-task content reader.
    // Pagination reaches neither, so both stay inert here.
    service = new AgenticService({} as any, workflow as any, {} as any, provider as any, source, {} as any, {} as any);
  });
  beforeEach(async () => { await connection.query('TRUNCATE TABLE pg_temp.agent_turns'); provider.structured.mockClear(); });
  afterAll(async () => {
    if (connection) {
      await connection.query('DROP TABLE IF EXISTS pg_temp.agent_turns');
      await connection.release();
    }
    if (source?.isInitialized) await source.destroy();
  });

  async function insert(id: string, userId: string, stateId: string, createdAt: string) {
    await connection.query(`INSERT INTO pg_temp.agent_turns
      (id,"userId","phaseStateId","requestId","requestHash",kind,status,message,"baseWorkspaceHash",response,"createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'chat','completed','Controlled pagination fixture',$5,$6,$7::timestamp,$7::timestamp)`,
    [id, userId, stateId, randomUUID(), '0'.repeat(64), JSON.stringify({ kind: 'discussion', reply: 'Controlled test reply', questions: [], proposal: null }), createdAt]);
  }

  it('returns every row exactly once across 30-row pages with unequal and tied microseconds in one millisecond', async () => {
    for (let index = 0; index < 65; index++) {
      // Four tied rows per instant puts equal timestamps across both page
      // boundaries. Every distinct instant still decodes to the same JS Date.
      const micros = 830000 + 900 - Math.floor(index / 4);
      await insert(randomUUID(), owner, phaseId, `2026-09-15 06:39:50.${micros}`);
    }
    await insert(randomUUID(), owner, otherPhaseId, '2026-09-15 06:39:50.830999');
    await insert(randomUUID(), otherOwner, otherOwnerPhaseId, '2026-09-15 06:39:50.830999');
    const expected: Array<{ id: string }> = await connection.query('SELECT id FROM pg_temp.agent_turns WHERE "userId"=$1 AND "phaseStateId"=$2 ORDER BY "createdAt" DESC,id DESC', [owner, phaseId]);
    const first = await service.turns(owner, phaseId);
    expect(first.items.map(row => row.id)).toEqual(expected.slice(0, 30).map(row => row.id));
    expect(new Set(first.items.map(row => row.createdAt.toISOString())).size).toBe(1);
    expect(first.nextCursor).toBe(first.items[29].id);
    const second = await service.turns(owner, phaseId, first.nextCursor!);
    expect(second.items.map(row => row.id)).toEqual(expected.slice(30, 60).map(row => row.id));
    expect(second.nextCursor).toBe(second.items[29].id);
    const third = await service.turns(owner, phaseId, second.nextCursor!);
    expect(third.items.map(row => row.id)).toEqual(expected.slice(60).map(row => row.id));
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map(row => row.id);
    expect(ids).toEqual(expected.map(row => row.id));
    expect(new Set(ids).size).toBe(65);
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it('rejects missing, other-owner and other-phase cursor IDs with404 while retaining an owned phase guard', async () => {
    const crossPhase = randomUUID(), crossOwner = randomUUID();
    await insert(crossPhase, owner, otherPhaseId, '2026-09-15 06:39:50.830967');
    await insert(crossOwner, otherOwner, otherOwnerPhaseId, '2026-09-15 06:39:50.830967');
    for (const cursor of [randomUUID(), crossPhase, crossOwner]) {
      await expect(service.turns(owner, phaseId, cursor)).rejects.toMatchObject({ status: 404 });
    }
    await expect(service.turns(owner, otherOwnerPhaseId)).rejects.toMatchObject({ status: 403 });
    expect(provider.structured).not.toHaveBeenCalled();
  });
});
