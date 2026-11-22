import { JobDeferredUntil } from './job-queue';
import 'reflect-metadata';
import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import { ServiceUnavailableException } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { Repository } from 'typeorm';
import { ExecutionRunEntity, SubmissionEntity } from '../db/entities';
import {
  BullQueue,
  QUEUE_UNAVAILABLE_MESSAGE,
  SHUTDOWN_DEADLINE_MS,
  StallTuning,
  TerminalJobFailure,
  setTerminalFailureSink,
} from './bull.queue';
import { JobRecoveryService } from './job-recovery.service';
import type { JobsService } from './jobs.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Nothing listens on this port, so ioredis never reaches 'ready' and keeps
 * reconnecting; BullMQ's graceful close would wait on it forever.
 */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1/0';

describe('BullQueue.shutdown', () => {
  it('resolves promptly when Redis is unreachable and leaves no client reconnecting', async () => {
    const queue = new BullQueue(UNREACHABLE_REDIS, 1, 1);
    queue.register('run', async () => undefined);
    // The two ioredis clients the queue owns; BullMQ ends the first itself on
    // close but treats the second as shared and leaves it alone.
    const owned = (queue as unknown as { connection: Redis; workerConnection: Redis });
    const clients = [owned.connection, owned.workerConnection];

    const startedAt = Date.now();
    await queue.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(3000);

    // ioredis retries every 50–2000ms; a client still on that loop would
    // reconnect several times in this window and hold the process open.
    const reconnects = clients.map((client) => jest.spyOn(client, 'connect'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const spy of reconnects) expect(spy).not.toHaveBeenCalled();
  }, 10_000);

  it('clears the deadline timer when the graceful close wins', async () => {
    const queue = new BullQueue(UNREACHABLE_REDIS, 1, 1);
    const owned = queue as unknown as { connection: Redis; queue: { close(): Promise<void> } };
    // 'ready' is the branch that arms the full 50s budget; the stubs below let
    // the graceful path win at once, which is the case that could leave the
    // timer pending and hold the process open until the deadline expired.
    Object.defineProperty(owned.connection, 'status', { value: 'ready', configurable: true });
    owned.queue.close = async () => undefined;
    owned.connection.quit = (async () => 'OK') as Redis['quit'];

    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const setSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const handle = (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      if (ms === SHUTDOWN_DEADLINE_MS) armed.push(handle);
      return handle;
    }) as never);
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => {
      cleared.push(handle);
      return (realClearTimeout as (...a: unknown[]) => unknown)(handle);
    }) as never);

    try {
      await queue.shutdown();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }

    expect(armed).toHaveLength(1);
    expect(cleared).toContain(armed[0]);
  }, 10_000);
});

/**
 * `enqueue` is awaited inside the request that pressed Run or Submit.
 * ioredis carries a command across a reconnect rather than rejecting it, so
 * with Redis unreachable an unbounded call would never settle: the browser's
 * fetch would sit there with no status, no timeout and nothing to show the
 * learner. With REDIS_URL on a closed port, both `POST /phases/:id/run` and
 * `/submit` answer 503 in about 3 s.
 *
 * The two tests below drive the deadline itself rather than a dead Redis: a
 * real `add` against a closed port leaves BullMQ internals retrying, which
 * kept the jest process alive for eight seconds after the run. What has to
 * hold either way is this contract: the wait is bounded, and what comes back
 * is a 503 a learner can act on.
 */
describe('BullQueue.enqueue', () => {
  /** A queue whose `add` behaves as the test says, over connections nothing answers. */
  const queueWhoseAddWill = (add: () => Promise<unknown>, deadlineMs: number): BullQueue => {
    const queue = new BullQueue(UNREACHABLE_REDIS, 1, 1, deadlineMs);
    (queue as unknown as { queue: { add: () => Promise<unknown> } }).queue.add = add;
    return queue;
  };

  const enqueueRejection = async (queue: BullQueue) =>
    queue.enqueue('submission', { id: 'submission-1' }).then(
      () => null,
      (err: ServiceUnavailableException) => err,
    );

  it('answers 503 rather than waiting on a queue that never accepts the job', async () => {
    const queue = queueWhoseAddWill(() => new Promise(() => undefined), 300);
    const startedAt = Date.now();

    const rejection = await enqueueRejection(queue);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect(rejection?.getStatus()).toBe(503);
    // What the learner reads: no host, no port, no Redis.
    expect(rejection?.message).toBe(QUEUE_UNAVAILABLE_MESSAGE);
    expect(rejection?.message).not.toContain('127.0.0.1');
    expect(rejection?.message).not.toMatch(/redis/i);

    await queue.shutdown();
  }, 20_000);

  /**
   * And the real thing, for fidelity: with nothing listening, BullMQ's own
   * `add` does not come back inside the deadline either. (This suite already
   * leaves jest a few seconds to unwind whenever it points a queue at a closed
   * port; that predates this test.)
   */
  it('answers 503 for a Redis that is not there', async () => {
    const queue = new BullQueue(UNREACHABLE_REDIS, 1, 1, 300);
    const startedAt = Date.now();

    const rejection = await enqueueRejection(queue);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect(rejection?.message).toBe(QUEUE_UNAVAILABLE_MESSAGE);

    await queue.shutdown();
  }, 20_000);

  it('answers 503 the same way when the queue refuses the job outright', async () => {
    const queue = queueWhoseAddWill(
      () => Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false")),
      3_000,
    );

    const rejection = await enqueueRejection(queue);

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    // ioredis's wording is for the log; the learner gets the same sentence
    // whichever way the queue failed.
    expect(rejection?.message).toBe(QUEUE_UNAVAILABLE_MESSAGE);

    await queue.shutdown();
  }, 20_000);
});

/**
 * Past `maxStalledCount` BullMQ fails a job without ever calling the
 * handler, and a job whose last attempt throws is not retried again either.
 * Either way no handler code runs, so without a terminal-failure hook the
 * submission or run row would sit at "queued" or "running" for ever: a
 * spinner the learner could only escape by asking someone to restart the
 * server. These drive the real thing against a real Redis, because the
 * behaviour under test is BullMQ's own.
 */
describe('BullQueue terminal failures', () => {
  /** Short enough to watch a stall-out happen inside a test. */
  const FAST_STALL: StallTuning = { lockDuration: 500, stalledInterval: 200, maxStalledCount: 0 };

  let server: ChildProcess | null = null;
  let redisUrl: string;
  let admin: Redis;
  const opened: BullQueue[] = [];

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  // `what` may be a thunk because the interesting half of it (whatever the
  // server said before it died, or the spawn error when there is no
  // redis-server on this machine at all) does not exist yet when the wait
  // starts. Interpolating it eagerly is what reported "redis-server on 36193
  // ()" from CI and left the reason unsaid.
  const waitFor = async (
    until: () => boolean | Promise<boolean>,
    what: string | (() => string),
    budgetMs = 15_000,
  ) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (await until()) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  beforeAll(async () => {
    const port = await freePort();
    redisUrl = `redis://127.0.0.1:${port}/0`;
    // Own the server rather than borrowing the developer's: no persistence, no
    // shared keyspace, gone when the suite ends.
    server = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    server.stderr?.on('data', (chunk) => (stderr += chunk));
    server.on('error', (err) => (stderr += err.message));

    admin = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => 100 });
    await waitFor(
      async () => {
        try {
          if (admin.status === 'end' || admin.status === 'wait') await admin.connect();
          return (await admin.ping()) === 'PONG';
        } catch {
          return false;
        }
      },
      () => `redis-server on ${port} (${stderr.slice(0, 400).trim() || 'it said nothing'})`,
      20_000,
    );
  }, 30_000);

  afterEach(async () => {
    setTerminalFailureSink(null);
    while (opened.length) await opened.pop()?.shutdown();
    await admin.flushall();
  });

  afterAll(async () => {
    admin?.disconnect();
    server?.kill('SIGKILL');
  });

  const open = (attempts: number): BullQueue => {
    const queue = new BullQueue(redisUrl, 1, attempts, 3_000, FAST_STALL);
    opened.push(queue);
    return queue;
  };

  it('durably defers a live lease without completing or consuming failure attempts', async () => {
    const failures: TerminalJobFailure[] = [];
    setTerminalFailureSink(failure => { failures.push(failure); });
    let calls = 0;
    let completed = false;
    const queue = open(1);
    queue.register('submission', async () => {
      calls += 1;
      if (calls <= 3) throw new JobDeferredUntil(Date.now() + 150);
      completed = true;
    });
    await queue.enqueue('submission', { id: 'leased-submission' });
    await waitFor(() => calls >= 1, 'first lease collision');
    expect(completed).toBe(false);
    await waitFor(() => completed, 'the deferred lease to become claimable');
    expect(calls).toBe(4);
    expect(failures).toEqual([]);
    const backing = (queue as any).queue;
    await waitFor(async () => (await backing.getJob('submission-leased-submission'))?.getState().then((state: string) => state === 'completed'), 'persisted completion');
    const job = await backing.getJob('submission-leased-submission');
    expect(job).toBeTruthy();
    // Successful completion counts once; the three lease deferrals do not exhaust the single-attempt budget.
    expect(job.attemptsMade).toBe(1);
  }, 10_000);

  it('reports nothing while BullMQ will still retry, and reports the attempt it gives up on', async () => {
    const seen: TerminalJobFailure[] = [];
    setTerminalFailureSink((failure) => {
      seen.push(failure);
    });

    let calls = 0;
    const queue = open(2);
    queue.register('submission', async () => {
      calls += 1;
      throw new Error('grading blew up');
    });

    await queue.enqueue('submission', { id: 'submission-42' });

    await waitFor(() => calls === 1, 'the first attempt');
    // The queue is about to retry this one, so nothing may be written back:
    // a row marked failed here is a verdict the UI treats as final while the
    // work is still going to happen.
    expect(seen).toEqual([]);

    await waitFor(() => seen.length === 1, 'the terminal failure', 20_000);
    expect(calls).toBe(2);
    expect(seen[0]).toMatchObject({
      kind: 'submission',
      id: 'submission-42',
      reason: 'attempts-exhausted',
      attempts: 2,
    });
  }, 40_000);

  it('marks a submission failed when its job stalls past maxStalledCount', async () => {
    const dataSource = await memoryDataSource();
    const submissions: Repository<SubmissionEntity> = dataSource.getRepository(SubmissionEntity);
    const recovery = new JobRecoveryService(
      submissions,
      dataSource.getRepository(ExecutionRunEntity),
      { durable: true, backendName: 'redis-bullmq' } as JobsService,
    );
    // The wiring under test: on a durable queue this registers the sink
    // instead of failing rows at boot.
    await recovery.onApplicationBootstrap();

    const row = await submissions.save(
      submissions.create({ phaseStateId: 'phase-1', userId: 'learner-1', status: 'running' }),
    );

    try {
      // A worker takes the job and dies holding its lock: the shape of a
      // killed process, and what maxStalledCount counts.
      let started = false;
      const dying = open(1);
      dying.register('submission', () => {
        started = true;
        return new Promise<void>(() => undefined);
      });
      await dying.enqueue('submission', { id: row.id });
      await waitFor(() => started, 'the first worker to pick the job up');
      await (dying as unknown as { worker: { close(force: boolean): Promise<void> } }).worker.close(true);

      // A second worker finds the expired lock, stalls the job out, and never
      // calls the handler at all.
      let calledAgain = false;
      const survivor = open(1);
      survivor.register('submission', async () => {
        calledAgain = true;
      });

      await waitFor(
        async () => (await submissions.findOneByOrFail({ id: row.id })).status === 'failed',
        'the stalled-out submission to be written back as failed',
        25_000,
      );
      const failed = await submissions.findOneByOrFail({ id: row.id });
      // The interrupted wording, specifically: a stall-out is a worker that
      // kept dying, not a grader that ran and could not produce a verdict.
      expect(failed.error).toContain('interrupted');
      expect(failed.error).toContain('Press Submit again');
      // No path, no job id, no BullMQ wording.
      expect(failed.error).not.toMatch(/stall|bullmq|redis/i);
      expect(calledAgain).toBe(false);
    } finally {
      await recovery.onApplicationShutdown();
      await dataSource.destroy();
    }
  }, 60_000);
});
