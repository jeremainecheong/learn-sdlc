/**
 * The readers the design, runbook and change-request validators share: each
 * returns the value it read or throws a `RecordRefusal` carrying one fixed
 * sentence, so a validator reads top to bottom and stops at the first thing
 * wrong. An over-long id is named by its place, never quoted. The floors'
 * blank-text helper and the canonical JSON every projection keys by live here
 * too. Pure.
 */
/** A plain JSON object: not null, not a list. */
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON with every object's keys sorted and no whitespace: one text per value, whatever order it was written in. */
export function canonicalJson(v: unknown): string {
  const sorted = (x: unknown): unknown => (Array.isArray(x) ? x.map(sorted)
    : isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])])) : x);
  return v === undefined ? '' : JSON.stringify(sorted(v));
}

/** Missing, empty or whitespace only. */
export const blankText = (text: string | undefined): boolean => !(text ?? '').trim();

class RecordRefusal extends Error {}
export const refuseRecord = (message: string): never => {
  throw new RecordRefusal(message);
};

export function readText(value: unknown, what: string, cap: number): string {
  if (typeof value !== 'string') return refuseRecord(`${what} is not text`);
  if (value.length > cap) refuseRecord(`${what} is longer than ${cap} characters`);
  return value;
}

/** Missing, or null as an Agentic proposal writes "none": absent. */
export function readOptionalText(value: unknown, what: string, cap: number): string | undefined {
  return value === undefined || value === null ? undefined : readText(value, what, cap);
}

export function readTextList(value: unknown, what: string, itemCap: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return refuseRecord(`${what} is not a list`);
  if (value.length > maxItems) refuseRecord(`${what} has more than ${maxItems} items`);
  return value.map((item, i) => {
    if (typeof item !== 'string' || item.length > itemCap) refuseRecord(`${what} item ${i + 1} is not text of at most ${itemCap} characters`);
    return item as string;
  });
}

export function readObjects(raw: Record<string, unknown>, key: string, cap: number, plural: string, noun: string): Record<string, unknown>[] {
  const value = raw[key];
  if (!Array.isArray(value)) return refuseRecord(`${key} is not a list`);
  if (value.length > cap) refuseRecord(`more than ${cap} ${plural}`);
  return value.map((item, i) => (isObject(item) ? item : refuseRecord(`${noun} ${i + 1} is not an object`)));
}

export function readItemId(item: Record<string, unknown>, noun: string, index: number, seen: Set<string>, cap: number): string {
  const id = item.id;
  if (typeof id !== 'string' || !id.trim()) return refuseRecord(`${noun} ${index + 1} has no id`);
  if (id.length > cap) refuseRecord(`${noun} ${index + 1} has an id longer than ${cap} characters`);
  if (seen.has(id)) refuseRecord(`${noun} id ${id} is used twice`);
  seen.add(id);
  return id;
}

/** `{ [key]: value }`, or no key at all when the value is absent: an optional field is left out, never stored as undefined. */
export function optionalField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** The record's JSON read by `read`, or the first refusal; `label` names the record ("The runbook record"). */
export function readRecordText<T>(text: string, label: string, read: (raw: Record<string, unknown>) => T): { value: T; error: null } | { value: null; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { value: null, error: `${label} is not valid JSON` };
  }
  if (!isObject(raw)) return { value: null, error: `${label} is not an object` };
  try {
    return { value: read(raw), error: null };
  } catch (error) {
    if (error instanceof RecordRefusal) return { value: null, error: error.message };
    throw error;
  }
}
