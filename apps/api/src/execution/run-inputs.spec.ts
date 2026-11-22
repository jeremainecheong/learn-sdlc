import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { AcceptedScreenCopy, RunResult } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, ExecutionRunEntity, PhaseStateEntity } from '../db/entities';
import { ContentService } from '../content/content.service';
import { SCREEN_COPY_PATH } from '../content/screen-copy';
import { ExecutionService, RUN_INPUT_MISSING, runInputHash } from './execution.service';
import { ExecutionRunInputs1789075000000 } from '../migrations/1789075000000-ExecutionRunInputs';
import { memoryDataSource } from '../../test/support/memory-db';

const result = (stdout: string): RunResult => ({ ok: true, exitKind: 'ok', stdout, stderr: '', durationMs: 3 });
const copy: AcceptedScreenCopy = { version: 1, sourceSubmissionId: 'unit-fixture-design-submission', sourcePhaseStateId: 'unit-fixture-design-phase', title: 'Accepted overdue title', empty: 'Accepted empty sentence.' };

describe('immutable Run inputs and worker ownership (mocked execution, real database)', () => {
  let db: DataSource;
  let content: ContentService;
  let state: PhaseStateEntity;
  let service: ExecutionService;
  let enqueue: jest.Mock;
  let execute: jest.SpyInstance;
  const phase = () => content.getPhase('tasktrackr', 'implementation');
  const reload = () => db.manager.findOneByOrFail(PhaseStateEntity, { id: state.id });
  beforeAll(async () => {
    db = await memoryDataSource();
    content = new ContentService(); content.loadAll();
  });
  afterAll(async () => { await db.destroy(); });
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await db.manager.clear(entity);
    const enrollment = await db.manager.save(EnrollmentEntity, db.manager.create(EnrollmentEntity, { userId: 'run-input-owner', projectSlug: 'tasktrackr' }));
    state = await db.manager.save(PhaseStateEntity, db.manager.create(PhaseStateEntity, {
      userId: enrollment.userId, enrollmentId: enrollment.id, phaseKey: 'implementation', phaseOrder: 3,
      status: 'in_progress', workspace: { 'api/repository/tasks.py': '# input A' }, runClock: '2026-03-01', acceptedScreenCopy: copy,
    }));
    enqueue = jest.fn();
    service = new ExecutionService(db.getRepository(ExecutionRunEntity), db.getRepository(PhaseStateEntity), db.getRepository(EnrollmentEntity), content, {} as any, { enqueue, durable: true } as any, { emitJob: jest.fn() } as any);
    execute = jest.spyOn(service, 'executeForPhase').mockResolvedValue(result('input A executed'));
  });

  it('executes the captured editable bytes, clock and accepted copy after a later save, and exposes compact provenance only', async () => {
    const queued = await service.runPhase(phase(), state);
    await db.manager.update(PhaseStateEntity, state.id, { workspace: { 'api/repository/tasks.py': '# input B' }, runClock: '2026-06-01', acceptedScreenCopy: { ...copy, title: 'Later copy' } });
    await service.processRun({ id: queued.id });
    const [effective, files, clock] = execute.mock.calls[0];
    expect(files['api/repository/tasks.py']).toBe('# input A');
    expect(clock).toBe('2026-03-01');
    expect(JSON.parse(effective.files.find((file: { path: string }) => file.path === SCREEN_COPY_PATH).content).title).toBe(copy.title);
    const record = await db.manager.findOneByOrFail(ExecutionRunEntity, { id: queued.id });
    expect(record.inputHash).toBe(runInputHash(record.inputSnapshot!));
    const view = await service.getRun(record.id, state.userId);
    expect(view).toMatchObject({ status: 'completed', inputHash: record.inputHash, runClock: '2026-03-01' });
    expect(view).not.toHaveProperty('inputSnapshot');
    expect((await reload()).workspace!['api/repository/tasks.py']).toBe('# input B');
    await expect(service.getRun(record.id, 'another-user')).rejects.toThrow('run not found');
  });

  it('retains authoritative phase identity for an exact old run beyond the recent-history cap', async () => {
    const runs = db.getRepository(ExecutionRunEntity);
    const original = await runs.save(runs.create({ phaseStateId: state.id, userId: state.userId, kind: 'run', status: 'completed', result: result('historical outcome'), createdAt: new Date('2026-01-01T00:00:00Z') }));
    await runs.save(Array.from({ length: 51 }, (_, index) => runs.create({ phaseStateId: state.id, userId: state.userId, kind: 'run', status: 'completed', result: result('newer outcome'), createdAt: new Date(Date.parse('2026-01-02T00:00:00Z') + index * 1000) })));
    const recent = await service.listFor(state.id, state.userId);
    expect(recent).toHaveLength(50);
    expect(recent.some(run => run.id === original.id)).toBe(false);
    expect(recent.every(run => run.phaseStateId === state.id)).toBe(true);
    const historical = await service.getRun(original.id, state.userId);
    expect(historical).toMatchObject({ id: original.id, phaseStateId: state.id, result: result('historical outcome') });
    expect(historical).not.toHaveProperty('inputSnapshot');
    await expect(service.getRun(original.id, 'another-user')).rejects.toThrow('run not found');
  });

  it('deduplicates simultaneous Run presses at the database without enqueueing twice', async () => {
    const [a, b] = await Promise.all([service.runPhase(phase(), state), service.runPhase(phase(), { ...state, workspace: { 'api/repository/tasks.py': '# another concurrent draft' } })]);
    expect(a.id).toBe(b.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await db.manager.count(ExecutionRunEntity)).toBe(1);
    await service.processRun({ id: a.id });
    const next = await service.runPhase(phase(), await reload());
    expect(next.id).not.toBe(a.id);
  });

  it('ignores completed and failed duplicate deliveries without overwriting history', async () => {
    const queued = await service.runPhase(phase(), state);
    await service.processRun({ id: queued.id });
    await service.processRun({ id: queued.id });
    expect(execute).toHaveBeenCalledTimes(1);
    await db.manager.update(ExecutionRunEntity, queued.id, { status: 'failed', error: 'Retained terminal failure' });
    await service.processRun({ id: queued.id });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await service.getRun(queued.id, state.userId)).error).toBe('Retained terminal failure');
  });

  it('retries the same retained input after a worker error, never the next draft', async () => {
    execute.mockRejectedValueOnce(new Error('Unit fixture runner connection lost')).mockResolvedValueOnce(result('retried A'));
    const queued = await service.runPhase(phase(), state);
    await expect(service.processRun({ id: queued.id })).rejects.toThrow('connection lost');
    expect(await db.manager.findOneByOrFail(ExecutionRunEntity, { id: queued.id })).toMatchObject({ status: 'running', processingToken: null, processingLeaseUntil: null });
    await db.manager.update(PhaseStateEntity, state.id, { workspace: { 'api/repository/tasks.py': '# input B' }, runClock: '2026-09-01' });
    await service.processRun({ id: queued.id });
    expect(execute.mock.calls[1][1]).toEqual(execute.mock.calls[0][1]);
    expect(execute.mock.calls[1][2]).toBe('2026-03-01');
    expect((await service.getRun(queued.id, state.userId)).status).toBe('completed');
  });

  it('defers a concurrent delivery; a recovered lease owner defeats a late old worker and alone controls phase marking', async () => {
    let finish!: (run: RunResult) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    execute.mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); })
      .mockResolvedValueOnce({ ok: false, exitKind: 'unavailable', stdout: '', stderr: 'This transport cannot execute this workspace.', durationMs: 0 });
    const queued = await service.runPhase(phase(), state);
    const original = service.processRun({ id: queued.id });
    await started;
    await expect(service.processRun({ id: queued.id })).rejects.toMatchObject({ name: 'JobDeferredUntil' });
    expect(execute).toHaveBeenCalledTimes(1);
    await db.manager.update(ExecutionRunEntity, queued.id, { processingLeaseUntil: new Date(Date.now() - 1).toISOString() });
    await service.processRun({ id: queued.id });
    const recovered = await service.getRun(queued.id, state.userId);
    finish(result('stale successful worker'));
    await original;
    expect(await service.getRun(queued.id, state.userId)).toEqual(recovered);
    expect(recovered.status).toBe('failed');
    expect((await reload()).ranBeforeSubmit).toBe(false);
  });

  it('fails legacy queued inputs visibly without borrowing the current draft, and preserves legacy completed results', async () => {
    const old = await db.manager.save(ExecutionRunEntity, db.manager.create(ExecutionRunEntity, { userId: state.userId, phaseStateId: state.id, kind: 'run', status: 'queued' }));
    await service.processRun({ id: old.id });
    expect(await service.getRun(old.id, state.userId)).toMatchObject({ status: 'failed', error: RUN_INPUT_MISSING, inputHash: null, runClock: null });
    const completed = await db.manager.save(ExecutionRunEntity, db.manager.create(ExecutionRunEntity, { userId: state.userId, phaseStateId: state.id, kind: 'run', status: 'completed', result: result('original historical result') }));
    await service.processRun({ id: completed.id });
    expect((await service.getRun(completed.id, state.userId)).result).toEqual(result('original historical result'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('detects corrupted retained bytes instead of executing evidence with a mismatched hash', async () => {
    const queued = await service.runPhase(phase(), state);
    const record = await db.manager.findOneByOrFail(ExecutionRunEntity, { id: queued.id });
    await db.manager.update(ExecutionRunEntity, queued.id, { inputSnapshot: { ...record.inputSnapshot!, workspace: { tampered: 'bytes' } } });
    await service.processRun({ id: queued.id });
    expect((await service.getRun(queued.id, state.userId)).status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('hashes identical file maps consistently regardless of insertion order', () => {
    expect(runInputHash({ version: 1, workspace: { a: 'one', b: 'two' }, runClock: null, acceptedScreenCopy: copy }))
      .toBe(runInputHash({ version: 1, workspace: { b: 'two', a: 'one' }, runClock: null, acceptedScreenCopy: { ...copy } }));
  });
});

it('migrates only legacy pending Run records, preserving completed evidence and separate submission execution records', async () => {
  const db = await new DataSource({ type: 'better-sqlite3', database: ':memory:' }).initialize();
  try {
    await db.query('CREATE TABLE execution_runs (id varchar PRIMARY KEY, phaseStateId varchar, kind varchar, status varchar, result text)');
    await db.query(`INSERT INTO execution_runs VALUES ('old-a','phase','run','queued',NULL), ('old-b','phase','run','running','{"stdout":"partial original output"}'), ('old-complete','phase','run','completed','{"stdout":"original completed output"}'), ('separate-submit','phase','submit','queued',NULL)`);
    await new ExecutionRunInputs1789075000000().up(db.createQueryRunner());
    const rows = await db.query('SELECT * FROM execution_runs ORDER BY id');
    expect(rows.find((row: { id: string }) => row.id === 'old-a')).toMatchObject({ status: 'failed', error: RUN_INPUT_MISSING, inputSnapshot: null });
    expect(rows.find((row: { id: string }) => row.id === 'old-b')).toMatchObject({ status: 'failed', result: '{"stdout":"partial original output"}' });
    expect(rows.find((row: { id: string }) => row.id === 'old-complete')).toMatchObject({ status: 'completed', result: '{"stdout":"original completed output"}' });
    expect(rows.find((row: { id: string }) => row.id === 'separate-submit')).toMatchObject({ status: 'queued', error: null });
    await db.query(`INSERT INTO execution_runs (id,phaseStateId,kind,status) VALUES ('new-a','phase','run','queued')`);
    await expect(db.query(`INSERT INTO execution_runs (id,phaseStateId,kind,status) VALUES ('new-b','phase','run','queued')`)).rejects.toThrow();
  } finally { await db.destroy(); }
});
