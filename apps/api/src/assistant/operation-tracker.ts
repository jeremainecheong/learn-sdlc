import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const AI_OPERATION_KINDS = ['guided', 'interview', 'agentic', 'grading', 'serialised'] as const;
export type AiOperationKind = typeof AI_OPERATION_KINDS[number];
interface Operation { kind: AiOperationKind; startedAt: number; pending: number }
const context = new AsyncLocalStorage<Operation>();
const active = new Set<Operation>();

/** Contains no account, prompt, proposal, provider response or request identifiers. */
export function aiOperationSnapshot(): { kind: AiOperationKind; active: number; oldestSeconds: number }[] {
  const now = performance.now();
  return AI_OPERATION_KINDS.map(kind => {
    const operations = [...active].filter(operation => operation.kind === kind);
    return { kind, active: operations.length, oldestSeconds: operations.length
      ? Math.max(0, (now - Math.min(...operations.map(operation => operation.startedAt))) / 1000) : 0 };
  });
}

/**
 * Nested scopes retain the same operation, rather than double-counting it.
 * In particular, retaining the actual queued promise means an HTTP timeout or
 * client disconnect cannot make still-running work disappear from the gauge.
 * This observes work; it never cancels, retries, changes approval or grants access.
 */
export function trackAiOperation<T>(kind: AiOperationKind, work: () => T | Promise<T>): Promise<T> {
  const inherited = context.getStore();
  const operation = inherited && active.has(inherited)
    ? inherited : { kind, startedAt: performance.now(), pending: 0 };
  operation.pending += 1;
  active.add(operation);
  return context.run(operation, async () => {
    try { return await work(); }
    finally {
      operation.pending -= 1;
      if (operation.pending === 0) active.delete(operation);
    }
  });
}

/**
 * The ambient operation's kind, for a metric label of bounded cardinality;
 * 'none' outside a tracked operation, and for a retained tail whose operation
 * has already settled. Reads only what trackAiOperation stored, and changes
 * nothing.
 */
export function currentAiOperationKind(): AiOperationKind | 'none' {
  const operation = context.getStore();
  return operation && active.has(operation) ? operation.kind : 'none';
}

/** Service-method boundary, including ownership reads and final persistence. */
export function TrackedAiOperation(kind: AiOperationKind): MethodDecorator {
  return (_target, _property, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return trackAiOperation(kind, () => original.apply(this, args));
    };
  };
}
