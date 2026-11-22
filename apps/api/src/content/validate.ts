/*
 * The pack readers' validation helpers. Packs are hand-authored JSON, so a
 * broken pack should name its own mistake at boot rather than surface as an
 * undefined three services away. Each helper throws one fixed sentence when
 * its condition fails.
 *
 * This module imports nothing, so the loader, the record validators, the
 * pointer readers and the warm-up loader can all import it without forming a
 * cycle between them.
 */

/** Throws `message` when `condition` is falsy. */
export function req(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** A required string with at least one non-space character, returned as written. */
export function reqString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/** An optional list of strings: empty when absent, refused when it holds anything else. */
export function reqStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  req(
    Array.isArray(value) && value.every((v) => typeof v === 'string'),
    `${field} must be an array of strings`,
  );
  return value as string[];
}

/** An optional string key: kept only when the pack actually declares it. */
export function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * A pack version: `MAJOR.MINOR.PATCH`, optionally with a prerelease or build
 * suffix. The same shape pins an npm package exactly (no `^`, no `~`, no range).
 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
