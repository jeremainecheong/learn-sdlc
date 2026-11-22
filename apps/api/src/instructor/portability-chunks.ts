import type { EntityManager } from 'typeorm';

/**
 * sqlite binds a statement's parameters into a fixed slot table (999 wide on
 * some builds), so a chunk has to be sized in parameters rather than in rows.
 * 500 is comfortably inside the smallest ceiling this product could meet, and
 * a wider table simply gets fewer rows per statement.
 */
const PARAMETERS_PER_STATEMENT = 500;

function chunkFor(columns: number): number {
  return Math.max(
    1,
    Math.floor(PARAMETERS_PER_STATEMENT / Math.max(1, columns)),
  );
}

/**
 * `manager.insert` rather than `save`: no entity hydration, one statement per
 * chunk, and the chunk sized by the statement's parameter count.
 */
export async function insertChunked<T>(
  manager: EntityManager,
  entity: new () => T,
  rows: Partial<T>[],
  columns: number,
): Promise<void> {
  if (!rows.length) return;
  const size = chunkFor(columns);
  for (let i = 0; i < rows.length; i += size) {
    await manager.insert(entity, rows.slice(i, i + size) as never);
  }
}
