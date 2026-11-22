import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  AiCacheEntity,
  ALL_ENTITIES,
  PhaseStateEntity,
  SubmissionEntity,
  TaskResetEntity,
} from '../db/entities';
import {
  AI_CACHE_MAX_AGE_DAYS,
  BOOT_SWEEP_DELAY_MS,
  RESET_COPIES_KEPT,
  RetentionService,
  SWEEP_INTERVAL_MS,
} from './retention.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Keeping a full copy of the learner's editable files on every submission for
 * ever would cost 247 MB for one fifty-learner cohort at 10,080 submissions,
 * measured, on a laptop that is also the class's database. The retention
 * rule is the newest five revisions per phase plus every submission that
 * passed; everything else keeps its row, its report, its score and its
 * verdict, and loses only the files.
 */
describe('RetentionService', () => {
  let dataSource: DataSource;
  let service: RetentionService;
  const manager = () => dataSource.manager;

  const SNAPSHOT = { 'src/tracker.py': 'print("hello")', 'tests/test_tracker.py': 'assert True' };

  /** A phase state with a stable id, so a submission's id can name its phase. */
  const phase = async (key: 'design' | 'build'): Promise<string> => {
    const state = await manager().save(
      manager().create(PhaseStateEntity, {
        id: `phase-${key}`,
        enrollmentId: 'enrolment-1',
        userId: 'learner-1',
        phaseKey: key,
        phaseOrder: key === 'design' ? 1 : 2,
        status: 'in_progress',
      } as Partial<PhaseStateEntity>),
    );
    return state.id;
  };

  /** One attempt, numbered so its id and its timestamp agree on the order. */
  const attempt = async (
    phaseStateId: string,
    n: number,
    opts: { passed?: boolean } = {},
  ): Promise<SubmissionEntity> =>
    manager().save(
      manager().create(SubmissionEntity, {
        id: `${phaseStateId}-${String(n).padStart(3, '0')}`,
        phaseStateId,
        userId: 'learner-1',
        status: 'completed',
        score: 40 + n,
        passed: opts.passed ?? false,
        report: { attempt: n } as never,
        workspaceSnapshot: { ...SNAPSHOT },
        createdAt: new Date(1_788_000_000_000 + n * 60_000),
      } as Partial<SubmissionEntity>),
    );

  const withSnapshot = async (phaseStateId?: string): Promise<string[]> => {
    const rows = await manager().find(SubmissionEntity, {
      where: phaseStateId ? { phaseStateId } : {},
      order: { id: 'ASC' },
    });
    return rows.filter((row) => row.workspaceSnapshot !== null).map((row) => row.id);
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    service = new RetentionService(dataSource);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
  });

  it('keeps all sixty revisions, including every failed attempt, inspectable', async () => {
    const phaseStateId = await phase('design');
    for (let n = 1; n <= 60; n++) await attempt(phaseStateId, n);

    await service.sweep();

    const kept = await withSnapshot(phaseStateId);
    expect(kept).toHaveLength(60);
    expect(kept).toEqual(Array.from({ length: 60 }, (_, i) => `phase-design-${String(i + 1).padStart(3, '0')}`));

    // and they are whole, not merely present
    for (const id of kept) {
      const row = await manager().findOneByOrFail(SubmissionEntity, { id });
      expect(row.workspaceSnapshot).toEqual(SNAPSHOT);
    }
  });

  it('keeps every revision that passed, however far back it is', async () => {
    const phaseStateId = await phase('design');
    await attempt(phaseStateId, 1, { passed: true });
    for (let n = 2; n <= 30; n++) await attempt(phaseStateId, n);

    await service.sweep();

    const kept = await withSnapshot(phaseStateId);
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe('phase-design-001');
    expect(
      (await manager().findOneByOrFail(SubmissionEntity, { id: kept[0] })).workspaceSnapshot,
    ).toEqual(SNAPSHOT);
  });

  it('preserves the source alongside every historical verdict', async () => {
    const phaseStateId = await phase('design');
    for (let n = 1; n <= 10; n++) await attempt(phaseStateId, n);

    await service.sweep();

    const pruned = await manager().findOneByOrFail(SubmissionEntity, { id: 'phase-design-001' });
    expect(pruned.workspaceSnapshot).toEqual(SNAPSHOT);
    // Everything an appeal reads is still there; only the files are gone.
    expect(pruned.score).toBe(41);
    expect(pruned.passed).toBe(false);
    expect(pruned.status).toBe('completed');
    expect(pruned.report).toEqual({ attempt: 1 });
    expect(await manager().count(SubmissionEntity)).toBe(10);
  });

  it('does not creep further back each time it runs', async () => {
    const phaseStateId = await phase('design');
    for (let n = 1; n <= 12; n++) await attempt(phaseStateId, n);

    await service.sweep();
    const afterFirst = await withSnapshot(phaseStateId);
    await service.sweep();

    // A second pass leaves every revision's snapshot exactly as the first did.
    expect(await withSnapshot(phaseStateId)).toEqual(afterFirst);
  });

  it('expires cached mentor replies older than the window and leaves the rest', async () => {
    const now = new Date('2026-09-05T09:00:00.000Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    await manager().save([
      manager().create(AiCacheEntity, {
        cacheKey: 'last-term',
        content: 'a',
        createdAt: daysAgo(AI_CACHE_MAX_AGE_DAYS + 1),
      } as Partial<AiCacheEntity>),
      manager().create(AiCacheEntity, {
        cacheKey: 'this-week',
        content: 'b',
        createdAt: daysAgo(3),
      } as Partial<AiCacheEntity>),
    ]);

    const cleared = await service.sweep(now);

    expect(cleared.cacheEntries).toBe(1);
    expect((await manager().find(AiCacheEntity)).map((row) => row.cacheKey)).toEqual(['this-week']);
  });

  it('is housekeeping, so a failure is logged rather than thrown at whatever asked for it', async () => {
    const broken = new RetentionService({
      get manager() {
        throw new Error('database is closed');
      },
    } as unknown as DataSource);

    await expect(broken.sweepAndLog()).resolves.toEqual({
      cacheEntries: 0,
      resetCopies: 0,
    });
  });

  /**
   * The learner's reset writes `task_resets`, and the sweep prunes it. `files` is NOT
   * NULL, so the bound is bytes: every row outside the newest three per task
   * state reads `{}`, ordered `createdAt DESC, id DESC` (the writer mints a
   * UUIDv7 id, so two resets in one sqlite second still order), and no row is
   * ever deleted.
   */
  describe('the reset copies', () => {
    const FILES = { 'requirements/story.md': 'the learner\'s words' };
    /** Same second for every row: the id is what orders them, as on sqlite. */
    const SAME_SECOND = new Date('2026-09-30T02:00:00.000Z');
    const copy = (taskStateId: string, n: number, createdAt = SAME_SECOND) =>
      manager().save(
        manager().create(TaskResetEntity, {
          id: `0199${taskStateId}-${String(n).padStart(4, '0')}`,
          taskStateId,
          userId: 'learner-1',
          files: { ...FILES, n: String(n) },
          createdAt,
        } as Partial<TaskResetEntity>),
      );
    const byteful = async (taskStateId: string): Promise<string[]> =>
      (await manager().find(TaskResetEntity, { where: { taskStateId }, order: { id: 'ASC' } }))
        .filter((row) => Object.keys(row.files).length > 0)
        .map((row) => row.id);

    it('keeps the newest three per task state whole, empties the rest, deletes none', async () => {
      expect(RESET_COPIES_KEPT).toBe(3);
      for (let n = 1; n <= 5; n++) await copy('ts-a', n);
      for (let n = 1; n <= 2; n++) await copy('ts-b', n);

      const result = await service.sweep();

      expect(result.resetCopies).toBe(2);
      expect(await byteful('ts-a')).toEqual(['0199ts-a-0003', '0199ts-a-0004', '0199ts-a-0005']);
      expect(await byteful('ts-b')).toEqual(['0199ts-b-0001', '0199ts-b-0002']);
      const emptied = await manager().findOneByOrFail(TaskResetEntity, { id: '0199ts-a-0001' });
      expect(emptied.files).toEqual({});
      expect(await manager().count(TaskResetEntity)).toBe(7);
    });

    it('orders by createdAt first, then id', async () => {
      // the highest id is the oldest row, so createdAt must win
      await copy('ts-c', 9, new Date('2026-09-01T00:00:00.000Z'));
      for (let n = 1; n <= 3; n++) await copy('ts-c', n);
      await service.sweep();
      expect(await byteful('ts-c')).toEqual(['0199ts-c-0001', '0199ts-c-0002', '0199ts-c-0003']);
    });

    it('does not creep: a second sweep writes nothing', async () => {
      for (let n = 1; n <= 6; n++) await copy('ts-d', n);
      expect((await service.sweep()).resetCopies).toBe(3);
      expect((await service.sweep()).resetCopies).toBe(0);
      expect(await byteful('ts-d')).toHaveLength(3);
    });

    it('is a no-op on a database with no reset rows: no boot-time writer (§3.3)', async () => {
      // At the driver's query runner, which every statement passes through:
      // `manager.query` and the query builder alike (a spy on
      // `dataSource.query` would not see the builder's UPDATE).
      const queries: string[] = [];
      const spy = jest.spyOn(dataSource.logger, 'logQuery').mockImplementation((sql: string) => {
        queries.push(sql);
      });
      try {
        expect((await service.sweep()).resetCopies).toBe(0);
      } finally {
        spy.mockRestore();
      }
      const touching = queries.filter((sql) => /task_resets/.test(sql));
      expect(touching).toHaveLength(1);
      expect(touching[0]).toMatch(/^SELECT/i);
      expect(queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql) && /task_resets/.test(sql))).toBe(false);
    });

    it('names what it emptied in the sweep line', async () => {
      for (let n = 1; n <= 4; n++) await copy('ts-e', n);
      const log = jest.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
        .mockImplementation(() => undefined);
      try {
        expect((await service.sweepAndLog()).resetCopies).toBe(1);
        expect(log.mock.calls.map(([line]) => line).join('\n')).toMatch(/emptied 1 reset cop(y|ies)/);
      } finally {
        log.mockRestore();
      }
    });
  });

  /**
   * A start writes nothing. A deployment step may compare every table while
   * a new process boots, so the first sweep waits BOOT_SWEEP_DELAY_MS (the
   * PostgreSQL proof is retention-boot-window.spec.ts).
   */
  describe('the boot schedule', () => {
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('sweeps nothing at boot, once after the delay, then daily; both timers unref\'d and cleared at shutdown', () => {
      expect(BOOT_SWEEP_DELAY_MS).toBe(2 * 60 * 60 * 1000);
      jest.useFakeTimers();
      const fresh = new RetentionService(dataSource);
      const sweeps = jest.spyOn(fresh, 'sweepAndLog').mockResolvedValue({ cacheEntries: 0, resetCopies: 0 });
      const unref = jest.fn();
      const realTimeout = global.setTimeout;
      const realInterval = global.setInterval;
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const handle = realTimeout(fn, ms);
        (handle as unknown as { unref: () => void }).unref = unref;
        return handle;
      }) as never);
      jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
        const handle = realInterval(fn, ms);
        (handle as unknown as { unref: () => void }).unref = unref;
        return handle;
      }) as never);

      fresh.onApplicationBootstrap();
      expect(sweeps).not.toHaveBeenCalled();
      expect(unref).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(BOOT_SWEEP_DELAY_MS - 1);
      expect(sweeps).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(sweeps).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(SWEEP_INTERVAL_MS);
      expect(sweeps).toHaveBeenCalledTimes(2);

      fresh.onApplicationShutdown();
      jest.advanceTimersByTime(2 * SWEEP_INTERVAL_MS);
      expect(sweeps).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a shutdown before the delay cancels the first sweep', () => {
      jest.useFakeTimers();
      const fresh = new RetentionService(dataSource);
      const sweeps = jest.spyOn(fresh, 'sweepAndLog').mockResolvedValue({ cacheEntries: 0, resetCopies: 0 });
      fresh.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(1);
      fresh.onApplicationShutdown();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(BOOT_SWEEP_DELAY_MS + SWEEP_INTERVAL_MS);
      expect(sweeps).not.toHaveBeenCalled();
    });

    it('waits RETENTION_FIRST_SWEEP_DELAY_MS before the first sweep when it is set', () => {
      const held = process.env.RETENTION_FIRST_SWEEP_DELAY_MS;
      process.env.RETENTION_FIRST_SWEEP_DELAY_MS = '1000';
      jest.useFakeTimers();
      const fresh = new RetentionService(dataSource);
      const sweeps = jest.spyOn(fresh, 'sweepAndLog').mockResolvedValue({ cacheEntries: 0, resetCopies: 0 });
      try {
        fresh.onApplicationBootstrap();
        jest.advanceTimersByTime(999);
        expect(sweeps).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(sweeps).toHaveBeenCalledTimes(1);
      } finally {
        fresh.onApplicationShutdown();
        if (held === undefined) delete process.env.RETENTION_FIRST_SWEEP_DELAY_MS;
        else process.env.RETENTION_FIRST_SWEEP_DELAY_MS = held;
      }
    });
  });
});
