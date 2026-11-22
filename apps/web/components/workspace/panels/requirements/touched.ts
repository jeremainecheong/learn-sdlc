import { API_CONTRACT_JSON, DESIGN_JSON, SCREEN_CONTRACT_JSON, designItemPlaces, designReviewProjection, storyReviewProjection, type DesignDocuments, type FieldChange, type Story } from '@learnsdlc/shared';

/**
 * The fields an applied Agentic proposal wrote, kept for this browser tab so
 * the story form, and the Design room's forms, can say which fields the
 * assistant wrote. One store per phase, read the same way for both: a mark is
 * a review projection path and the value the assistant wrote there.
 *
 * Each mark is a review projection path (`story/so-that`, `story/ac-2/given`,
 * `story/scope/1`, …, as the API names a proposal's `changes`) with the value
 * the assistant wrote there (for a criterion, the whole criterion; see
 * `touchedValue`). A field is marked only while it still holds that value, so a field the learner rewrote, a row the learner added where the
 * assistant removed one, and restored starter content are never credited to
 * the assistant, and a cancelled edit leaves its mark as it was.
 *
 * The marks are a convenience, never evidence: storage can be missing or
 * refuse a write, and then the form simply shows none. A submit and a task
 * reset clear them.
 */
export type TouchedRecord = Record<string, string>;

export const touchedKey = (phaseId: string) => `learnsdlc:touched:${phaseId}`;

/**
 * A per-phase record of strings kept in this tab's sessionStorage under
 * `keyOf(phaseId)`. A storage that is missing or throws, or that holds
 * anything but an object, reads as no record; a write or a clear it refuses
 * is dropped, because the marks are a convenience.
 */
export function touchedStore<T extends Readonly<Record<string, string>>>(keyOf: (phaseId: string) => string) {
  return {
    read(phaseId: string): T {
      try {
        const raw: unknown = JSON.parse(sessionStorage.getItem(keyOf(phaseId)) ?? '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {} as T;
        return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) as T;
      } catch {
        return {} as T;
      }
    },
    write(phaseId: string, record: T): void {
      try { sessionStorage.setItem(keyOf(phaseId), JSON.stringify(record)); } catch { /* no marks kept */ }
    },
    clear(phaseId: string): void {
      try { sessionStorage.removeItem(keyOf(phaseId)); } catch { /* nothing kept */ }
    },
  };
}

const storyTouched = touchedStore<TouchedRecord>(touchedKey);

/**
 * The value a mark is matched on: a field's own text, except for a criterion,
 * which is matched as a whole. Every `story/ac-N/*` path stands for its
 * criterion's kind and three clauses together, because criteria are numbered
 * by position: a learner's criterion moved or written into the assistant's
 * position may share a clause with it ("I open the report"), and a shared
 * clause says nothing about whose criterion it is. A criterion the proposal
 * removed has no kind in the projection, so it records nothing.
 */
export function touchedValue(projection: Record<string, string>, path: string): string | undefined {
  const criterion = path.match(/^(story\/ac-\d+)\//);
  if (!criterion) return projection[path];
  const at = criterion[1];
  if (projection[`${at}/tag`] === undefined) return undefined;
  return JSON.stringify([projection[`${at}/tag`], projection[`${at}/given`] ?? '', projection[`${at}/when`] ?? '', projection[`${at}/then`] ?? '']);
}

export function readTouched(phaseId: string | undefined): TouchedRecord {
  return phaseId ? storyTouched.read(phaseId) : {};
}

/** Writes a record that holds marks, and clears the key for one that holds none. */
function writeRecord(phaseId: string, record: TouchedRecord): void {
  if (Object.keys(record).length) storyTouched.write(phaseId, record);
  else storyTouched.clear(phaseId);
}

/**
 * Record what an applied proposal wrote: each changed path whose new value is
 * not empty, with that value, merged over the marks of earlier applies. A
 * path this proposal emptied or removed loses any earlier mark.
 */
export function recordTouched(phaseId: string | undefined, paths: Iterable<string>, after: Story): void {
  if (!phaseId) return;
  const projection = storyReviewProjection(after);
  const next = { ...readTouched(phaseId) };
  for (const path of paths) {
    const value = projection[path];
    const matched = touchedValue(projection, path);
    if (value !== undefined && value !== '' && matched !== undefined) next[path] = matched;
    else delete next[path];
  }
  writeRecord(phaseId, next);
}

/** Whether the field at `path` still holds what the assistant wrote there. */
export function isTouched(record: TouchedRecord, projection: Record<string, string>, path: string): boolean {
  const stored = record[path];
  return stored !== undefined && touchedValue(projection, path) === stored;
}

export function clearTouched(phaseId: string | undefined): void {
  if (phaseId) writeRecord(phaseId, {});
}

/** A numbered item's path: its item ('design/operation-3') and the rest ('/returns', or nothing). */
const NUMBERED = /^((?:design|api|screens)\/[a-z]+-\d+)(\/.*)?$/;
/** A path moved to its item's number in the applied documents (`designItemPlaces`); null when that item is gone. */
const placed = (places: Record<string, string | null>, path: string): string | null => {
  const numbered = NUMBERED.exec(path);
  if (!numbered) return path;
  const at = places[numbered[1]];
  return at ? `${at}${numbered[2] ?? ''}` : null;
};

/**
 * Record what an applied design proposal wrote. A design change set numbers
 * its items by the saved documents (`designChangeSet`), and the room reads the
 * applied ones, where an item sits at another number once an earlier one is
 * removed or added. So every item is matched by its id (a screen by its
 * route), never by its number: `designItemPlaces` turns each change path into
 * its item and finds that item in the applied documents. A change with a new
 * value marks the field there, with the applied text the room reads; a change
 * that empties a field clears that field's mark; a change on an item the
 * proposal removed marks nothing. The marks kept from earlier applies were
 * numbered by the same saved documents, so each follows its item too, and a
 * mark on a removed item goes with it.
 */
export function recordDesignTouched(phaseId: string | undefined, changes: readonly FieldChange[], saved: DesignDocuments, applied: DesignDocuments): void {
  if (!phaseId) return;
  const places = designItemPlaces(saved, applied);
  const projection = designReviewProjection(applied, { contracts: { api: true, screens: true }, sequence: true });
  const next: TouchedRecord = {};
  for (const [path, value] of Object.entries(readTouched(phaseId))) {
    const at = placed(places, path);
    if (at) next[at] = value;
  }
  for (const change of changes) {
    const at = placed(places, change.path);
    if (!at) continue;
    const value = projection[at];
    if (change.after && value) next[at] = value;
    else delete next[at];
  }
  writeRecord(phaseId, next);
}

/**
 * The marks of an applied design proposal: the documents as applied are the
 * saved ones overlaid with the proposal's files and the workspace the Apply
 * answered with; each change is marked on its item there (`recordDesignTouched`).
 */
export function recordAppliedDesign(phaseId: string | undefined, changes: readonly FieldChange[], saved: DesignDocuments, files: Record<string, string>, workspace: Record<string, string>): void {
  const applied = { ...saved, ...files, ...workspace };
  recordDesignTouched(phaseId, changes, saved, { [DESIGN_JSON]: applied[DESIGN_JSON], [API_CONTRACT_JSON]: applied[API_CONTRACT_JSON], [SCREEN_CONTRACT_JSON]: applied[SCREEN_CONTRACT_JSON] });
}

/**
 * The marks follow their items when the learner's own edit adds or removes
 * one (a form's Remove): each mark on a numbered item of `before` moves to
 * that item's number in `after`, a mark on a removed item goes, and a mark on
 * a document the edit did not touch stays as it is. True when anything moved.
 */
export function moveDesignTouched(phaseId: string | undefined, before: DesignDocuments, after: DesignDocuments): boolean {
  if (!phaseId) return false;
  const held = readTouched(phaseId);
  if (!Object.keys(held).length) return false;
  const places = designItemPlaces(before, after);
  const next: TouchedRecord = {};
  let moved = false;
  for (const [path, value] of Object.entries(held)) {
    const item = NUMBERED.exec(path)?.[1];
    const at = item && !(item in places) ? path : placed(places, path);
    if (at !== path) moved = true;
    if (at) next[at] = value;
  }
  if (moved) writeRecord(phaseId, next);
  return moved;
}

/** The Design room's names for the shared store's readers: the same marks, read and cleared the same way. */
export { readTouched as readDesignTouched, clearTouched as clearDesignTouched };
