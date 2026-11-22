/**
 * The queue contract shared by both backends.
 *
 * Jobs are *named handlers with serializable payloads* (an id), never
 * closures: a closure cannot outlive the process that created it, which is
 * exactly what a durable queue must do. Handlers reload everything they need
 * from the database, so the same job can be executed by any worker, at any
 * time, including after a restart.
 */
// 'regrade' re-runs one stored revision
// against the content pack as it is on disk now. Both backends dispatch by
// name, so a new kind is a new handler and nothing else.
export type JobKind = 'submission' | 'run' | 'regrade';

export interface JobPayload {
  /** Row id of the submission or execution run to process. */
  id: string;
  /**
   * Whose work this is. The in-process scheduler takes one job from each owner
   * in turn, so a learner's burst cannot get in front of the rest of the class.
   * Absent is legal and lands every such job in one shared turn: a job with no
   * owner is never worse off than under first in, first out.
   */
  ownerId?: string;
}

export type JobHandler = (payload: JobPayload) => Promise<void>;

export interface JobQueue {
  /** Register the handler for a job kind. Must happen before jobs are consumed. */
  register(kind: JobKind, handler: JobHandler): void;
  /** Enqueue work. Returns once the job is durably accepted (Redis) or scheduled. */
  enqueue(kind: JobKind, payload: JobPayload): Promise<void>;
  /** Resolve when no work is outstanding: used by tests. */
  onIdle(): Promise<void>;
  /** Cheap liveness check of the backing store; must return or throw quickly. */
  ping(): Promise<void>;
  /** Stop accepting work and let in-flight jobs finish. */
  shutdown(): Promise<void>;
  /** True when jobs survive a process restart. */
  readonly durable: boolean;
  readonly name: string;
  // Both optional, so a backend need not implement them.
  /** Jobs the scheduler would dispatch before this one, or null when it cannot say. */
  positionOf?(kind: JobKind, id: string): number | null;
  /** Median duration of the last few completed jobs of this kind, or null. */
  recentDurationMs?(kind: JobKind): number | null;
}

/** A live database lease must be retried later without consuming a job attempt. */
export class JobDeferredUntil extends Error {
  constructor(readonly timestamp: number) { super('Job is already held by a live processing lease'); this.name = 'JobDeferredUntil'; }
}
