import type { EntityManager } from 'typeorm';
import { SettingEntity } from '../db/entities';

/*
 * The boot passes' receipts: one settings row per pass, holding JSON with the
 * running totals and the last runs. Shared by the null-pin pass and the
 * re-pin, which read and extend their receipts the same way.
 */

/** How many runs a boot pass's receipt keeps, the latest ones; the running totals still count every run. */
export const RECEIPT_RUNS = 50;

/**
 * The receipt held under `key`, as a plain object: an empty object when there
 * is none, or when what is stored is not JSON or not an object.
 */
export async function readReceipt(manager: EntityManager, key: string): Promise<Record<string, unknown>> {
  const held = await manager.findOneBy(SettingEntity, { key });
  let receipt: Record<string, unknown> = {};
  try {
    const parsed = held ? (JSON.parse(held.value) as unknown) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) receipt = parsed as Record<string, unknown>;
  } catch {
    receipt = {};
  }
  return receipt;
}

/** A receipt's `runs` with one more entry, at most `RECEIPT_RUNS` of them, the oldest dropped. */
export function appendRun(runs: unknown, entry: Record<string, unknown>): unknown[] {
  return [...(Array.isArray(runs) ? runs : []), entry].slice(-RECEIPT_RUNS);
}
