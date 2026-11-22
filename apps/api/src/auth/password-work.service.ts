import { Injectable, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config';
import {
  PASSWORD_BCRYPT_ROUNDS, PASSWORD_INPUT_BYTES, PASSWORD_PENDING_BYTES, PASSWORD_WORKERS,
  PasswordReply, PasswordRequest,
} from './password-work.protocol';

export const PASSWORD_WORK_UNAVAILABLE = 'Password sign-in is temporarily busy. Please try again shortly.';
function unavailable(): ServiceUnavailableException { return new ServiceUnavailableException(PASSWORD_WORK_UNAVAILABLE); }

/** Small worker boundary, replaceable by deterministic protocol doubles in unit tests. */
export interface PasswordWorker {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: PasswordRequest): void;
  terminate(): Promise<number>;
  removeAllListeners(): this;
  ref(): void;
  unref(): void;
}
export interface PasswordPoolOptions {
  queueLimit: number;
  timeoutMs: number;
  idleMs: number;
  workerFactory?: () => PasswordWorker;
}
type Job = {
  id: string;
  owner: symbol;
  kind: 'hash' | 'compare';
  payload: PasswordRequest | null;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: string | boolean) => void;
  reject: (error: ServiceUnavailableException) => void;
  settled: boolean;
};
type Slot = {
  worker: PasswordWorker;
  state: 'starting' | 'ready' | 'busy' | 'terminating';
  active: Job | null;
  termination: Promise<void> | null;
  startupTimer: ReturnType<typeof setTimeout> | null;
};

function productionWorker(): PasswordWorker {
  const compiled = path.join(__dirname, 'password-work.worker.js');
  const sourceWorker = !fs.existsSync(compiled) && config.nodeEnv !== 'production';
  const worker = new Worker(sourceWorker ? path.join(__dirname, 'password-work.worker.ts') : compiled, {
    workerData: { bcryptModule: require.resolve('bcryptjs') },
    // The development API is run through ts-node too. Its worker gets the
    // same CommonJS transpilation in its own thread, with no inherited hooks
    // or environment. Production requires its compiled file and fails closed
    // if the artifact is missing; hashing never falls back onto this thread.
    env: sourceWorker ? { TS_NODE_SKIP_PROJECT: 'true', TS_NODE_COMPILER_OPTIONS:
      JSON.stringify({ module: 'CommonJS', moduleResolution: 'node', target: 'ES2021' }) } : {},
    execArgv: sourceWorker ? ['--require', require.resolve('ts-node/register/transpile-only')] : [],
    stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  // Unexpected worker output must not turn secrets into application logs.
  worker.stdout.resume(); worker.stderr.resume();
  return worker;
}

/** Fixed-size worker pool. A terminating thread still occupies its slot. */
export class PasswordWorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly pending: Job[] = [];
  private pendingBytes = 0;
  private closing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private closePromise: Promise<void> | null = null;
  private workerFailures = 0;
  private broken = false;
  private terminationUnconfirmed = false;
  private readonly factory: () => PasswordWorker;

  constructor(private readonly options: PasswordPoolOptions) {
    if (!Number.isInteger(options.queueLimit) || options.queueLimit < 1 || options.queueLimit > 128 ||
        !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000 ||
        !Number.isInteger(options.idleMs) || options.idleMs < 1000 || options.idleMs > 60000) {
      throw new Error('Invalid password worker bounds');
    }
    this.factory = options.workerFactory ?? productionWorker;
  }

  run(owner: symbol, operation: { type: 'hash'; password: string } | { type: 'compare'; password: string; encoded: string }): Promise<string | boolean> {
    if (this.closing || this.broken) return Promise.reject(unavailable());
    if (typeof operation.password !== 'string' ||
        (operation.type === 'compare' && typeof operation.encoded !== 'string')) return Promise.reject(unavailable());
    const bytes = Buffer.byteLength(operation.password) +
      (operation.type === 'compare' ? Buffer.byteLength(operation.encoded) : 0);
    if (bytes > PASSWORD_INPUT_BYTES || this.pending.length >= this.options.queueLimit ||
        this.pendingBytes + bytes > PASSWORD_PENDING_BYTES) return Promise.reject(unavailable());
    this.clearIdle();
    const id = randomUUID();
    return new Promise<string | boolean>((resolve, reject) => {
      const job: Job = {
        id, owner, kind: operation.type, payload: { ...operation, id }, bytes, resolve, reject, settled: false,
        // Waiting in the FIFO consumes the same deadline as actual hashing.
        timer: setTimeout(() => this.timeout(job), this.options.timeoutMs),
      };
      this.pending.push(job); this.pendingBytes += bytes;
      this.dispatch();
    });
  }

  private settle(job: Job, value?: string | boolean): void {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); job.payload = null;
    if (value === undefined) job.reject(unavailable()); else job.resolve(value);
  }

  private removePending(job: Job): boolean {
    const index = this.pending.indexOf(job);
    if (index < 0) return false;
    this.pending.splice(index, 1); this.pendingBytes -= job.bytes;
    return true;
  }

  private timeout(job: Job): void {
    if (job.settled) return;
    this.settle(job);
    if (this.removePending(job)) { this.maybeIdle(); return; }
    const slot = [...this.slots].find((entry) => entry.active === job);
    if (slot) void this.retire(slot, true);
  }

  private createSlot(): void {
    if (this.closing || this.broken || this.slots.size >= PASSWORD_WORKERS) return;
    let worker: PasswordWorker;
    try { worker = this.factory(); } catch { this.creationFailed(); return; }
    const slot: Slot = { worker, state: 'starting', active: null, termination: null, startupTimer: null };
    this.slots.add(slot);
    slot.startupTimer = setTimeout(() => { void this.retire(slot, true); }, this.options.timeoutMs);
    worker.on('message', (message) => this.receive(slot, message));
    worker.on('error', () => { void this.retire(slot, true); });
    worker.on('exit', () => { void this.retire(slot, true); });
  }

  private creationFailed(): void {
    this.workerFailures++;
    // A missing/broken runtime is not an endless spawn loop or an inline fallback.
    if (this.workerFailures >= 3) {
      this.broken = true;
      for (const job of this.pending.splice(0)) this.settle(job);
      this.pendingBytes = 0;
      for (const slot of this.slots) void this.retire(slot, false);
    } else this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.closing || this.broken || !this.pending.length) return;
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.dispatch(); }, 100);
  }

  private receive(slot: Slot, message: unknown): void {
    if (slot.state === 'terminating' || !this.slots.has(slot)) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) { void this.retire(slot, true); return; }
    const reply = message as PasswordReply;
    if (reply.type === 'ready' && Object.keys(message).length === 1 && slot.state === 'starting') {
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      slot.startupTimer = null;
      slot.state = 'ready'; this.dispatch(); this.maybeIdle(); return;
    }
    const job = slot.active;
    if (slot.state !== 'busy' || !job || reply.type === 'ready' || reply.id !== job.id) {
      void this.retire(slot, true); return;
    }
    if (reply.type === 'failed' && Object.keys(message).length === 2) {
      slot.active = null; slot.state = 'ready'; this.settle(job); this.dispatch(); this.maybeIdle(); return;
    }
    const validValue = reply.type === 'result' && Object.keys(message).length === 3 &&
      (job.kind === 'compare' ? typeof reply.value === 'boolean' : typeof reply.value === 'string' &&
        new RegExp(`^\\$2[aby]\\$${PASSWORD_BCRYPT_ROUNDS}\\$[./A-Za-z0-9]{53}$`).test(reply.value));
    if (!validValue) { void this.retire(slot, true); return; }
    this.workerFailures = 0;
    slot.active = null; slot.state = 'ready'; this.settle(job, (reply as { value: string | boolean }).value);
    this.dispatch(); this.maybeIdle();
  }

  private dispatch(): void {
    if (this.closing || this.broken || this.restartTimer) return;
    // Fixed maximum two, including workers that are starting or terminating.
    if (this.pending.length) {
      const missing = PASSWORD_WORKERS - this.slots.size;
      for (let n = 0; n < missing && !this.restartTimer && !this.broken; n++) this.createSlot();
    }
    for (const slot of this.slots) {
      if (slot.state !== 'ready') continue;
      const job = this.pending.shift();
      if (!job) break;
      this.pendingBytes -= job.bytes;
      if (job.settled || !job.payload) continue;
      slot.state = 'busy'; slot.active = job; slot.worker.ref();
      const payload = job.payload; job.payload = null;
      try { slot.worker.postMessage(payload); } catch { void this.retire(slot, true); }
    }
    this.maybeIdle();
  }

  private retire(slot: Slot, failure: boolean): Promise<void> {
    if (slot.termination) return slot.termination;
    slot.state = 'terminating';
    slot.worker.ref();
    if (slot.startupTimer) clearTimeout(slot.startupTimer);
    slot.startupTimer = null;
    if (slot.active) { this.settle(slot.active); slot.active = null; }
    if (failure) this.workerFailures++;
    // The thread retains its slot until termination resolves, even after its
    // request times out. A replacement can never overlap an old live worker.
    slot.termination = Promise.resolve().then(() => slot.worker.terminate()).then(() => {
      slot.worker.removeAllListeners(); this.slots.delete(slot);
      if (failure && this.workerFailures >= 3) {
        this.broken = true;
        for (const job of this.pending.splice(0)) this.settle(job);
        this.pendingBytes = 0;
        for (const other of this.slots) void this.retire(other, false);
      } else if (failure) this.scheduleRestart();
      else this.dispatch();
      this.maybeIdle();
    }).catch(() => {
      // Cannot confirm thread termination: retain the slot, fail closed, and
      // never start a replacement. No worker error text is exposed or logged.
      this.broken = true;
      this.terminationUnconfirmed = true;
      for (const job of this.pending.splice(0)) this.settle(job);
      this.pendingBytes = 0;
      for (const other of this.slots) if (other !== slot) void this.retire(other, false);
    });
    return slot.termination;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private maybeIdle(): void {
    if (this.closing || this.pending.length || [...this.slots].some((slot) => slot.active || slot.state === 'starting')) return;
    for (const slot of this.slots) if (slot.state === 'ready') slot.worker.unref();
    if (this.idleTimer || !this.slots.size) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending.length && ![...this.slots].some((slot) => slot.active)) {
        for (const slot of this.slots) void this.retire(slot, false);
      }
    }, this.options.idleMs);
    this.idleTimer.unref?.();
  }

  /** Stop only one application's jobs when test apps share this process pool. */
  async releaseOwner(owner: symbol): Promise<void> {
    for (const job of [...this.pending]) if (job.owner === owner) { this.removePending(job); this.settle(job); }
    const owned = [...this.slots].filter((slot) => slot.active?.owner === owner);
    await Promise.all(owned.map((slot) => this.retire(slot, false)));
    this.maybeIdle();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.clearIdle();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const job of this.pending.splice(0)) this.settle(job);
    this.pendingBytes = 0;
    this.closePromise = Promise.all([...this.slots].map((slot) => this.retire(slot, false))).then(() => {
      if (this.terminationUnconfirmed) throw unavailable();
    });
    return this.closePromise;
  }
}

type SharedPool = { pool: PasswordWorkerPool; owners: Set<symbol>; closing: boolean };
let processPool: SharedPool | null = null;

/** Nest and direct callers share one lazy pool per process, never one per AuthService. */
@Injectable()
export class PasswordWorkService implements OnApplicationShutdown {
  private readonly owner = Symbol('password-work-owner');
  private shared: SharedPool | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  private pool(): PasswordWorkerPool {
    if (this.closed || processPool?.closing) throw unavailable();
    if (!processPool) {
      processPool = { pool: new PasswordWorkerPool({
        queueLimit: config.passwordWorkQueueLimit,
        timeoutMs: config.passwordWorkTimeoutMs,
        idleMs: config.passwordWorkIdleMs,
      }), owners: new Set(), closing: false };
    }
    this.shared = processPool;
    this.shared.owners.add(this.owner);
    return this.shared.pool;
  }

  hash(password: string): Promise<string> {
    try { return this.pool().run(this.owner, { type: 'hash', password }) as Promise<string>; }
    catch { return Promise.reject(unavailable()); }
  }

  compare(password: string, encoded: string): Promise<boolean> {
    try { return this.pool().run(this.owner, { type: 'compare', password, encoded }) as Promise<boolean>; }
    catch { return Promise.reject(unavailable()); }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const shared = this.shared;
    if (!shared) return this.closing = Promise.resolve();
    shared.owners.delete(this.owner);
    if (shared.owners.size) return this.closing = shared.pool.releaseOwner(this.owner);
    shared.closing = true;
    this.closing = shared.pool.close().then(() => { if (processPool === shared) processPool = null; });
    return this.closing;
  }

  onApplicationShutdown(): Promise<void> { return this.close(); }
}
