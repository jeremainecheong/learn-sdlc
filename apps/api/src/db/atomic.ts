import { DataSource, EntityManager } from 'typeorm';

const tails = new WeakMap<DataSource, Promise<void>>();

/** SQLite has one connection; overlapping BEGIN calls are not independent transactions. */
export async function atomic<T>(source: DataSource, work: (manager: EntityManager) => Promise<T>): Promise<T> {
  if (source.options.type === 'postgres') return source.transaction(work);
  const previous = tails.get(source) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => next);
  tails.set(source, tail);
  await previous;
  try { return await source.transaction(work); }
  finally { release(); if (tails.get(source) === tail) tails.delete(source); }
}

/** The row locks a read may take. */
export type RowLockMode = 'pessimistic_write' | 'pessimistic_read';

/**
 * The find option that locks the rows a read returns, on PostgreSQL only.
 * Spread it into a find: `findOne(Entity, { where, ...rowLock(manager) })`.
 * On sqlite it is empty, because `atomic` already makes writers serial on the
 * one connection and sqlite has no row locks to take.
 */
export function rowLock(
  source: DataSource | EntityManager,
  mode: RowLockMode = 'pessimistic_write',
): { lock?: { mode: RowLockMode } } {
  const type = 'connection' in source ? source.connection.options.type : source.options.type;
  return type === 'postgres' ? { lock: { mode } } : {};
}
