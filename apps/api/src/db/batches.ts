/*
 * Batch sizes for statements that carry one bound parameter per row or id,
 * and the one helper that cuts a list into them. Both dialects bind one
 * parameter per value, so a pack's file rows and blobs are written in batches
 * rather than in one statement that would depend on a driver's variable limit;
 * each size is well under every driver's bound-parameter limit.
 */

/** Rows per multi-row INSERT. */
export const INSERT_BATCH = 100;

/** Ids per `IN (...)` list on a read. */
export const IN_LIST_BATCH = 500;

/** `items` cut into consecutive slices of at most `size`, in order. */
export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}
