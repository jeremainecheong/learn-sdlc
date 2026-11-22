/**
 * The page preview's hand-over to a tab of its own.
 *
 * The workspace writes the code in the editor, as it is at the moment the
 * learner opens the link, to this browser's localStorage under
 * `learnsdlc.pagePreview.<id>`; the tab at `/page-preview#<id>` reads it once,
 * keeps its own copy in sessionStorage (so a refresh shows the same snapshot,
 * whatever the workspace has stashed since) and draws it in the same sandboxed
 * frame. Nothing leaves the browser and nothing personal is in the address:
 * the id is a random token made once per mounted preview.
 *
 * Every storage call is wrapped: storage that is full or blocked means the tab
 * says it has nothing to show, never a crash.
 */

export const PAGE_HANDOVER_PREFIX = 'learnsdlc.pagePreview.';
export const PAGE_HANDOVER_VERSION = 1;
/** Records older than this are removed when the workspace stashes again. */
export const PAGE_HANDOVER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The clean-up looks at no more than this many storage keys. */
const SCAN_LIMIT = 500;

export type PageHandover = { files: Record<string, string>; takenAt: string; version: typeof PAGE_HANDOVER_VERSION };

/** A random token for one mounted preview: not an account, project or phase id. */
export function newHandoverId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return raw.replace(/[^a-zA-Z0-9]/g, '');
}

export function handoverKey(id: string): string {
  return `${PAGE_HANDOVER_PREFIX}${id}`;
}

/** The URL of the tab for this id, on this app's own origin. */
export function handoverHref(id: string): string {
  return `/page-preview#${id}`;
}

/** A well-formed record, or null. */
export function parseHandover(text: string | null | undefined): PageHandover | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as { files?: unknown; takenAt?: unknown; version?: unknown };
  if (record.version !== PAGE_HANDOVER_VERSION) return null;
  if (typeof record.takenAt !== 'string' || Number.isNaN(Date.parse(record.takenAt))) return null;
  if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files)) return null;
  const files: Record<string, string> = {};
  for (const [path, body] of Object.entries(record.files as Record<string, unknown>)) {
    if (typeof body !== 'string') return null;
    files[path] = body;
  }
  return { files, takenAt: record.takenAt, version: PAGE_HANDOVER_VERSION };
}

/** Removes this prefix's records older than a day (and broken ones). Never throws. */
export function pruneHandovers(storage: Storage, now: number): void {
  try {
    const stale: string[] = [];
    const count = Math.min(storage.length, SCAN_LIMIT);
    for (let i = 0; i < count; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(PAGE_HANDOVER_PREFIX)) continue;
      const record = parseHandover(storage.getItem(key));
      if (!record || now - Date.parse(record.takenAt) > PAGE_HANDOVER_MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // storage unreadable: nothing to clean
  }
}

function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Writes the snapshot for `id`. Synchronous, so it has landed before the new
 * tab reads it. Returns false when storage refused it; never throws.
 */
export function stashHandover(id: string, files: Record<string, string>, now: number = Date.now()): boolean {
  const storage = localStore();
  if (!storage) return false;
  pruneHandovers(storage, now);
  const record: PageHandover = { files, takenAt: new Date(now).toISOString(), version: PAGE_HANDOVER_VERSION };
  try {
    storage.setItem(handoverKey(id), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * The tab's snapshot for `id`: its own sessionStorage copy when it has one
 * (a refresh), otherwise the workspace's record, copied into sessionStorage.
 */
export function takeHandover(id: string): PageHandover | null {
  if (!id || !/^[a-zA-Z0-9]+$/.test(id)) return null;
  const key = handoverKey(id);
  const session = sessionStore();
  let kept: PageHandover | null = null;
  try {
    kept = parseHandover(session?.getItem(key));
  } catch {
    kept = null;
  }
  if (kept) return kept;
  let record: PageHandover | null = null;
  try {
    record = parseHandover(localStore()?.getItem(key));
  } catch {
    record = null;
  }
  if (!record) return null;
  try {
    session?.setItem(key, JSON.stringify(record));
  } catch {
    // no copy kept: a refresh reads the workspace's record again
  }
  return record;
}
