/**
 * The field-by-field change between two labelled projections (path to text),
 * which the story, design, runbook and change-request change sets all are,
 * and the id-keyed numbering their list paths share. Pure.
 */
import { canonicalJson } from './record-read';

/** One field a proposal changes, by its review path (a story's, a design's, a runbook's or a change request's). Absent sides were empty or not there. */
export interface FieldChange { path: string; before?: string; after?: string }

/**
 * Every path whose text differs, the old projection's paths first in their
 * order, then the paths only the new one has. An absent path reads as empty,
 * so a side that is empty is left out of the entry and an empty field that
 * comes or goes is no change.
 */
export function projectionChangeSet(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const x = before[path] ?? '', y = after[path] ?? '';
    if (x === y) continue;
    out.push({ path, ...(x ? { before: x } : {}), ...(y ? { after: y } : {}) });
  }
  return out;
}

/** A key as text: a string as written, a number or a boolean spelled out, anything else as canonical JSON. */
const keyText = (v: unknown): string => (typeof v === 'string' ? v
  : typeof v === 'number' || typeof v === 'boolean' ? String(v) : canonicalJson(v));

/** Each item's key, made unique: a missing or repeated key takes its occurrence number, so repeats pair up in order. */
export function uniqueKeys<T>(list: readonly T[], keyOf: (item: T) => unknown): string[] {
  const seen = new Map<string, number>();
  return list.map((item) => {
    const key = keyText(keyOf(item));
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return key && n === 0 ? key : `${key}\u0000${n}`;
  });
}

/**
 * The list in numbered slots. With no base the slots are the list itself. With
 * a base (the earlier version) the slots follow the base's keys in its order,
 * then the keys only this list has; a slot is empty where this list lacks the
 * base's key, so a removed item leaves its number empty and renumbers nothing.
 * The design, runbook and change-request projections all number by it.
 */
export function numberedSlots<T>(list: readonly T[], keyOf: (item: T) => unknown, base?: readonly T[]): (T | undefined)[] {
  if (!base) return [...list];
  const mine = new Map(uniqueKeys(list, keyOf).map((key, i) => [key, list[i]]));
  return [...new Set([...uniqueKeys(base, keyOf), ...mine.keys()])].map((key) => mine.get(key));
}

/**
 * A review path of the projection rooted at `root` ("runbook", "change"): it
 * starts `root/` and its last segment holds no dot, so a file under a folder
 * of that name, such as `runbook/notes.md`, is never one.
 */
export const isProjectionPathUnder = (root: string, path: string): boolean => path.startsWith(`${root}/`) && !/\.[^/]*$/.test(path);
