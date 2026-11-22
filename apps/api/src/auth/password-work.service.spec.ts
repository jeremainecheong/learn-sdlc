import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as workerThreads from 'node:worker_threads';
import * as ts from 'typescript';
import * as bcrypt from 'bcryptjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { config } from '../config';
import { PasswordRequest } from './password-work.protocol';
import { PASSWORD_WORK_UNAVAILABLE, PasswordWorker, PasswordWorkerPool, PasswordWorkService } from './password-work.service';

const HASH = '$2a$12$' + 'A'.repeat(53);
class FakeWorker extends EventEmitter implements PasswordWorker {
  readonly sent: PasswordRequest[] = [];
  readonly stdout = { resume: jest.fn() };
  readonly stderr = { resume: jest.fn() };
  ref = jest.fn();
  unref = jest.fn();
  terminate = jest.fn<Promise<number>, []>().mockResolvedValue(0);
  postMessage(message: PasswordRequest): void { this.sent.push(message); }
  ready(): void { this.emit('message', { type: 'ready' }); }
  finish(value: string | boolean = HASH, id = this.sent.at(-1)!.id): void {
    this.emit('message', { type: 'result', id, value });
  }
}
const owner = Symbol('test-owner');
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function reject503(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error) => {
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.message).toBe(PASSWORD_WORK_UNAVAILABLE);
    return 'unavailable';
  });
}
function fixture(queueLimit = 64) {
  const workers: FakeWorker[] = [];
  const pool = new PasswordWorkerPool({ queueLimit, timeoutMs: 1000, idleMs: 1000,
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  return { pool, workers };
}

describe('bounded password worker protocol', () => {
  const pools: PasswordWorkerPool[] = [];
  const make = (queueLimit = 64) => { const value = fixture(queueLimit); pools.push(value.pool); return value; };
  beforeEach(() => jest.useFakeTimers());
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.close().catch(() => undefined)));
    jest.restoreAllMocks(); jest.useRealTimers();
  });

  it('creates no worker until needed, caps at two and associates out-of-order replies with their caller', async () => {
    const { pool, workers } = make(); expect(workers).toHaveLength(0);
    const a = pool.run(owner, { type: 'hash', password: 'first-secret' });
    const b = pool.run(owner, { type: 'compare', password: 'second-secret', encoded: HASH });
    const c = pool.run(owner, { type: 'compare', password: 'third-secret', encoded: HASH });
    expect(workers).toHaveLength(2); workers.forEach((w) => w.ready());
    expect(workers.map((w) => w.sent.length)).toEqual([1, 1]);
    workers[1].finish(false); await expect(b).resolves.toBe(false);
    expect(workers[1].sent[1].password).toBe('third-secret');
    workers[1].finish(true); workers[0].finish();
    await expect(a).resolves.toBe(HASH); await expect(c).resolves.toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('refuses saturation without creating extra workers or retaining another request', async () => {
    const { pool, workers } = make(1);
    const pending = reject503(pool.run(owner, { type: 'hash', password: 'one' }));
    await expect(reject503(pool.run(owner, { type: 'hash', password: 'over-capacity' }))).resolves.toBe('unavailable');
    expect(workers).toHaveLength(2);
    await pool.close(); await pending;
  });

  it('bounds pending bytes independently of pending request count', async () => {
    const { pool } = make();
    const pending = Array.from({ length: 4 }, () => reject503(pool.run(owner, { type: 'hash', password: 'x'.repeat(4 * 1024 * 1024) })));
    await expect(reject503(pool.run(owner, { type: 'hash', password: 'x' }))).resolves.toBe('unavailable');
    await pool.close(); await Promise.all(pending);
  });

  it('counts FIFO waiting against the original deadline', async () => {
    const { pool, workers } = make();
    const active = [reject503(pool.run(owner, { type: 'hash', password: 'a' })),
      reject503(pool.run(owner, { type: 'hash', password: 'b' }))];
    workers.forEach((w) => w.ready());
    jest.advanceTimersByTime(500);
    const waiting = reject503(pool.run(owner, { type: 'hash', password: 'waiting' }));
    workers.forEach((w) => { w.terminate.mockImplementation(() => new Promise(() => undefined)); });
    jest.advanceTimersByTime(1000); await flush();
    await expect(waiting).resolves.toBe('unavailable'); await Promise.all(active);
    expect(workers).toHaveLength(2);
    // Resolve teardown explicitly; this fixture otherwise deliberately models an unconfirmed termination.
    pools.splice(pools.indexOf(pool), 1);
  });

  it('keeps timed-out threads in their slots until termination is confirmed, and never replays the secret', async () => {
    const { pool, workers } = make();
    const a = reject503(pool.run(owner, { type: 'hash', password: 'expired-secret' }));
    workers.forEach((w) => w.ready());
    let finishTermination!: (code: number) => void;
    workers[0].terminate.mockImplementation(() => new Promise((resolve) => { finishTermination = resolve; }));
    jest.advanceTimersByTime(1000); await flush(); await a;
    const b = pool.run(owner, { type: 'compare', password: 'new-secret', encoded: HASH });
    expect(workers).toHaveLength(2); // the other existing worker can safely continue
    workers[1].finish(true); await expect(b).resolves.toBe(true);
    expect(workers[1].sent.some((request) => request.password === 'expired-secret')).toBe(false);
    workers[0].finish(HASH); // late result cannot resolve another request
    finishTermination(0); await flush();
  });

  it.each(['wrong-id', 'wrong-type', 'extra-field', 'wrong-cost'] as const)('fails closed on %s', async (kind) => {
    const { pool, workers } = make();
    const work = reject503(pool.run(owner, { type: 'hash', password: 'never-in-error' }));
    workers.forEach((w) => w.ready()); const id = workers[0].sent[0].id;
    workers[0].emit('message', kind === 'wrong-id' ? { type: 'result', id: 'other-job', value: HASH }
      : kind === 'wrong-type' ? { type: 'result', id, value: true }
      : kind === 'extra-field' ? { type: 'result', id, value: HASH, password: 'never-in-error' }
      : { type: 'result', id, value: HASH.replace('$12$', '$04$') });
    await expect(work).resolves.toBe('unavailable'); await flush();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects a crashed active job once and allows a queued caller on a confirmed replacement', async () => {
    const { pool, workers } = make();
    const a = reject503(pool.run(owner, { type: 'hash', password: 'crashed' }));
    workers.forEach((w) => w.ready());
    workers[0].emit('error', new Error('secret-bearing worker diagnostics must not escape'));
    await expect(a).resolves.toBe('unavailable'); await flush();
    const b = pool.run(owner, { type: 'compare', password: 'next', encoded: HASH });
    expect(workers).toHaveLength(3); // only two live: the crashed thread was already terminated
    workers[1].finish(true); await expect(b).resolves.toBe(true);
  });

  it('bounds repeated startup failure and returns a generic unavailable error', async () => {
    let attempts = 0;
    const pool = new PasswordWorkerPool({ queueLimit: 64, timeoutMs: 1000, idleMs: 1000,
      workerFactory: () => { attempts++; throw new Error('private bootstrap diagnostic'); } }); pools.push(pool);
    const work = reject503(pool.run(owner, { type: 'hash', password: 'secret' }));
    await jest.advanceTimersByTimeAsync(300);
    await expect(work).resolves.toBe('unavailable'); expect(attempts).toBe(3);
    await expect(reject503(pool.run(owner, { type: 'hash', password: 'next' }))).resolves.toBe('unavailable');
    expect(attempts).toBe(3);
  });

  it('bounds workers that never finish booting', async () => {
    const { pool, workers } = make();
    const work = reject503(pool.run(owner, { type: 'hash', password: 'secret' }));
    await jest.advanceTimersByTimeAsync(1000); await work;
    expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('idles threads away and creates a fresh bounded pool on later work', async () => {
    const { pool, workers } = make();
    const work = pool.run(owner, { type: 'hash', password: 'first' }); workers.forEach((w) => w.ready());
    workers[0].finish(); await work;
    await jest.advanceTimersByTimeAsync(1000);
    expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    const later = pool.run(owner, { type: 'hash', password: 'later' });
    expect(workers).toHaveLength(4); workers.slice(2).forEach((w) => w.ready());
    workers[2].finish(); await later;
  });

  it('clears queued/in-flight jobs at shutdown and refuses future work', async () => {
    const { pool, workers } = make();
    const pending = Array.from({ length: 5 }, () => reject503(pool.run(owner, { type: 'hash', password: 'private' })));
    workers.forEach((w) => w.ready()); await pool.close(); await Promise.all(pending);
    expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    await expect(reject503(pool.run(owner, { type: 'hash', password: 'after-shutdown' }))).resolves.toBe('unavailable');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never confirms shutdown or opens replacement slots after unconfirmed termination', async () => {
    const { pool, workers } = make();
    const work = reject503(pool.run(owner, { type: 'hash', password: 'private' })); workers.forEach((w) => w.ready());
    workers[0].terminate.mockRejectedValue(new Error('termination is not confirmed'));
    await expect(pool.close()).rejects.toThrow(PASSWORD_WORK_UNAVAILABLE); await work;
    await expect(reject503(pool.run(owner, { type: 'hash', password: 'other' }))).resolves.toBe('unavailable');
    expect(workers).toHaveLength(2);
  });

  it('releases only a departing owner and preserves the other caller association', async () => {
    const { pool, workers } = make(); const other = Symbol('other');
    const a = reject503(pool.run(owner, { type: 'hash', password: 'a' }));
    const b = pool.run(other, { type: 'compare', password: 'b', encoded: HASH }); workers.forEach((w) => w.ready());
    await pool.releaseOwner(owner); await a;
    workers[1].finish(true); await expect(b).resolves.toBe(true);
    expect(workers[1].terminate).not.toHaveBeenCalled();
  });
});

describe('process-wide service ownership', () => {
  it('shares at most two threads across direct service instances and releases the last owner', async () => {
    const workers: FakeWorker[] = [];
    const spy = jest.spyOn(require('node:worker_threads'), 'Worker').mockImplementation((() => {
      const worker = new FakeWorker(); workers.push(worker); return worker;
    }) as any);
    const original = { queue: config.passwordWorkQueueLimit, timeout: config.passwordWorkTimeoutMs, idle: config.passwordWorkIdleMs };
    config.passwordWorkQueueLimit = 64; config.passwordWorkTimeoutMs = 1000; config.passwordWorkIdleMs = 1000;
    const first = new PasswordWorkService(); const second = new PasswordWorkService();
    try {
      expect(workers).toHaveLength(0);
      const a = first.hash('one'); const b = second.compare('two', HASH);
      expect(workers).toHaveLength(2); workers.forEach((w) => w.ready());
      workers[0].finish(); workers[1].finish(true); await a; await b;
      await first.close(); expect(workers.every((w) => w.terminate.mock.calls.length === 0)).toBe(true);
      const c = second.compare('three', HASH); workers[0].finish(false); await expect(c).resolves.toBe(false);
      await second.close(); expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
      await expect(first.hash('closed')).rejects.toThrow(PASSWORD_WORK_UNAVAILABLE);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      await first.close(); await second.close(); spy.mockRestore();
      config.passwordWorkQueueLimit = original.queue; config.passwordWorkTimeoutMs = original.timeout; config.passwordWorkIdleMs = original.idle;
    }
  });
});

describe('actual native password workers', () => {
  let directory: string;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-password-workers-'));
    for (const name of ['password-work.worker', 'password-work.protocol']) {
      const source = fs.readFileSync(path.join(__dirname, `${name}.ts`), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } });
      fs.writeFileSync(path.join(directory, `${name}.js`), compiled.outputText, { mode: 0o600 });
    }
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('runs the source-development entry inside a real worker and releases the shared pool', async () => {
    const service = new PasswordWorkService();
    try {
      const hash = await service.hash('source-worker-password');
      expect(bcrypt.getRounds(hash)).toBe(12);
      await expect(service.compare('source-worker-password', hash)).resolves.toBe(true);
    } finally { await service.close(); }
  }, 20000);

  it('hashes at cost12, compares right/wrong and legacy hashes on real threads, and closes them', async () => {
    const workers: workerThreads.Worker[] = [];
    const pool = new PasswordWorkerPool({ queueLimit: 64, timeoutMs: 10000, idleMs: 1000,
      workerFactory: () => {
        const worker = new workerThreads.Worker(path.join(directory, 'password-work.worker.js'), {
          workerData: { bcryptModule: require.resolve('bcryptjs') }, env: {}, execArgv: [],
        }); workers.push(worker); return worker;
      } });
    try {
      const hash = await pool.run(owner, { type: 'hash', password: 'new-password-unique' }) as string;
      expect(bcrypt.getRounds(hash)).toBe(12);
      await expect(pool.run(owner, { type: 'compare', password: 'new-password-unique', encoded: hash })).resolves.toBe(true);
      await expect(pool.run(owner, { type: 'compare', password: 'incorrect', encoded: hash })).resolves.toBe(false);
      const legacy = bcrypt.hashSync('legacy-password', 4);
      await expect(pool.run(owner, { type: 'compare', password: 'legacy-password', encoded: legacy })).resolves.toBe(true);
      await expect(pool.run(owner, { type: 'compare', password: 'incorrect', encoded: legacy })).resolves.toBe(false);
      expect(workers).toHaveLength(2); expect(workers.every((w) => w.threadId > 0)).toBe(true);
    } finally { await pool.close(); }
    expect(workers.every((w) => w.threadId === -1)).toBe(true);
  }, 20000);
});
