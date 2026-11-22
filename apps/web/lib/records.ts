'use client';

/**
 * Per-phase records that outlive a page: the run log Home shows, and the
 * submissions, runs and mentor exchanges the journal draws its timeline from.
 *
 * In page state, every visit to Home would refetch the run log and every
 * visit to the journal would show five skeleton blocks while three requests
 * a phase went out again. They are the same records every time, so
 * they belong to the session rather than to a mount: read synchronously on
 * mount, refreshed in the background only when the copy has gone stale, and
 * dropped when the session ends.
 *
 * A run or a submission does not empty them either. Emptying would leave the
 * next page nothing to draw, and it would say so ("nothing has run in Implementation
 * yet", one commit after a run finished) so a change marks the copy stale,
 * starts the refetch there and then, and lets the fresh answer replace the old
 * one when it lands. Only a different learner or a different project is a
 * reason to throw the records away.
 */
import type { AssistantMessageView, ExecutionRunView, SubmissionView } from '@learnsdlc/shared';
import { api } from './api';
import { onSessionEnd, ownedByToken } from './session';
import { viewingAs } from './view-as';

/** Everything the journal needs about one phase. */
export interface PhaseRecords {
  submissions: SubmissionView[];
  runs: ExecutionRunView[];
  chat: AssistantMessageView[];
}

/** How long a cached copy is used without a background refresh. */
export const FRESH_MS = 60_000;

interface Entry<T> {
  value: T;
  at: number;
  /** Set when something changed the phase: still drawn, no longer trusted. */
  stale?: boolean;
}

const runsCache = new Map<string, Entry<ExecutionRunView[]>>();
const recordsCache = new Map<string, Entry<PhaseRecords>>();
const inflight = new Map<string, Promise<unknown>>();
/**
 * These belong to one signed-in session. A different token (sign out, then
 * sign in as someone else in the same tab) must never read the last
 * learner's runs, so everything is dropped the moment the token changes.
 */
const own = ownedByToken(() => {
  runsCache.clear();
  recordsCache.clear();
  inflight.clear();
  scopes.clear();
});

/**
 * Bumped whenever the cached answers stop being what the server would say. A
 * fetch that was already in the air asked its question before that, so its
 * answer is still handed to whoever is waiting on it but is never written into
 * the cache over the newer one.
 */
let generation = 0;

const isStale = (entry: Entry<unknown> | undefined): boolean =>
  !entry || entry.stale === true || Date.now() - entry.at > FRESH_MS;

/* ------------------------------- the run log ------------------------------ */

/** The cached run log for a phase, or undefined when there is none yet. */
export function cachedRuns(phaseId: string | undefined): ExecutionRunView[] | undefined {
  if (!phaseId) return undefined;
  own();
  return runsCache.get(phaseId)?.value;
}

/** Overwrite the run log, e.g. straight after a run this page started. */
export function putRuns(phaseId: string, runs: ExecutionRunView[]): void {
  own();
  runsCache.set(phaseId, { value: runs, at: Date.now() });
}

/**
 * Fetch the run log unless the cached copy is younger than a minute. Resolves
 * with the list to show, cached or fresh; never rejects: a run log that will
 * not load is not a reason to fail a page.
 */
export async function loadRuns(phaseId: string, force = false): Promise<ExecutionRunView[]> {
  own();
  const held = runsCache.get(phaseId);
  if (held && !force && !isStale(held)) return held.value;
  const key = `runs:${phaseId}`;
  const running = inflight.get(key) as Promise<ExecutionRunView[]> | undefined;
  if (running) return running;
  const mine = generation;
  const p: Promise<ExecutionRunView[]> = api
    .runs(phaseId)
    .then((list) => {
      if (mine === generation) putRuns(phaseId, list);
      return list;
    })
    .catch(() => held?.value ?? [])
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/* ----------------------------- journal records ---------------------------- */

export function cachedRecords(phaseIds: string[]): Record<string, PhaseRecords> {
  own();
  const out: Record<string, PhaseRecords> = {};
  phaseIds.forEach((id) => {
    const held = recordsCache.get(id);
    if (held) out[id] = held.value;
  });
  return out;
}

/** True when every phase asked for already has a copy in hand. */
export function hasRecords(phaseIds: string[]): boolean {
  own();
  return phaseIds.every((id) => recordsCache.has(id));
}

/**
 * Every open phase's records in one request.
 *
 * The journal and the dossier both walk the whole project, and per phase that
 * is three requests a phase: 18 of /journal's 31 and 18 of /dossier's 42.
 * This fills the same cache `loadRecords` fills, so every
 * reader after it is a cache hit and nothing else in the module moves. A
 * failure falls back to nothing cached, and the per-phase path still runs.
 */
export async function loadAllRecords(slug: string): Promise<boolean> {
  own();
  const key = `recs:${slug}`;
  const running = inflight.get(key) as Promise<boolean> | undefined;
  if (running) return running;
  const mine = generation;
  const p = api
    .phaseRecords(slug)
    .then((all) => {
      if (mine !== generation) return false;
      for (const [phaseId, records] of Object.entries(all)) {
        recordsCache.set(phaseId, { value: records, at: Date.now() });
        if (records.runs.length) putRuns(phaseId, records.runs);
      }
      return true;
    })
    .catch(() => false)
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/**
 * Which tasks a phase's revisions are read under.
 *
 * A refresh after a submission (`refreshPhaseRecords`, `staleRecords`) knows
 * the phase and nothing else, and asking the phase route for a split phase's
 * revisions is the 400 this whole scope exists to stop. So the scope is
 * remembered per phase, and every read after that reads it the same way.
 *
 * **It is a property of the phase, not of a past read.** Remembering only what
 * a room asked for would leave two paths reaching this cache with no scope
 * at all: the dossier fills every phase in one bulk request
 * ({@link loadAllRecords}), {@link staleRecords} refreshes every phase the
 * session has ever held (including split phases whose rooms were never
 * opened). Each would then fall back to the refused phase-wide route, `partial` would
 * come back true so the fresh copy was never cached, and the entry would stay
 * stale for the rest of the session while every visit re-fired the refused
 * request. {@link rememberTaskScopes} is the
 * project saying, once, what each of its phases holds.
 */
const scopes = new Map<string, string[]>();

/**
 * What each phase of the project holds, told before anything reads it.
 *
 * The provider calls this with the phase list it has just loaded, so a phase's
 * scope is known whether or not a room in it has ever been opened. A phase with
 * one task records the empty scope, which means the phase-wide route, the one
 * the API resolves for it.
 */
export function rememberTaskScopes(
  phases: readonly { id: string; tasks?: readonly { key: string }[] }[],
): void {
  own();
  phases.forEach((phase) => {
    if (phase.tasks) scopeOf(phase.id, phase.tasks);
  });
}

/** The keys to read a phase's revisions under, or none for a single-task phase. */
function scopeOf(phaseId: string, tasks: readonly { key: string }[] | undefined): string[] {
  if (tasks) {
    const keys = tasks.length > 1 ? tasks.map((task) => task.key) : [];
    scopes.set(phaseId, keys);
    return keys;
  }
  // A phase nothing has declared is one the project never listed: a sole-task
  // phase is every phase in the product until a teacher splits one, and the
  // phase route is the one the API resolves for it.
  return scopes.get(phaseId) ?? [];
}

/**
 * A phase's revisions, however many tasks it holds.
 *
 * One task (every phase in the product until a teacher splits one) is a
 * single phase-wide call, and the API resolves the task
 * itself. More than one and each task's own route is asked, because the
 * phase-wide route is refused; the union is ordered the way
 * `GET /phases/records` orders the journal's, oldest first by `createdAt` and
 * then by id, and each revision keeps the `attempt` its own task counted.
 */
function readSubmissions(phaseId: string, keys: string[]): Promise<SubmissionView[]> {
  if (keys.length < 2) return api.submissions(phaseId);
  return Promise.all(keys.map((key) => api.submissions(phaseId, key))).then((lists) =>
    lists.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  );
}

/**
 * The three requests a phase, made once. Returns what came back plus whether
 * any part of it failed, so the page can say so without failing.
 *
 * `tasks` is the phase's task list where the caller holds one, which decides
 * how the revisions are read. A caller with none gets whatever the
 * phase was last read under.
 */
export async function loadRecords(
  phaseId: string,
  opts: { force?: boolean; tasks?: readonly { key: string }[] } = {},
): Promise<{ records: PhaseRecords; partial: boolean }> {
  own();
  const { force = false, tasks } = opts;
  const keys = scopeOf(phaseId, tasks);
  const held = recordsCache.get(phaseId);
  if (held && !force && !isStale(held)) return { records: held.value, partial: false };
  const key = `rec:${phaseId}`;
  const running = inflight.get(key) as Promise<{ records: PhaseRecords; partial: boolean }> | undefined;
  if (running) return running;
  const mine = generation;
  let partial = false;
  const miss = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
    p.catch(() => {
      partial = true;
      return fallback;
    });
  const p: Promise<{ records: PhaseRecords; partial: boolean }> = Promise.all([
    miss(readSubmissions(phaseId, keys), [] as SubmissionView[]),
    miss(api.runs(phaseId), [] as ExecutionRunView[]),
    // A teacher viewing a learner's work is never shown
    // their mentor conversation: it is private to the learner, and the
    // teacher's twin of this read is refused by design, so it is not asked
    // for. Withheld on purpose rather than failed, so the record is whole.
    viewingAs() ? Promise.resolve([] as AssistantMessageView[]) : miss(api.chatHistory(phaseId), [] as AssistantMessageView[]),
  ])
    .then(([submissions, runs, chat]) => {
      const records: PhaseRecords = { submissions, runs, chat };
      // A phase whose three requests all failed is not worth caching as an
      // empty record: the next visit should try again. And an answer from
      // before the last change is shown to whoever asked but not kept.
      if (mine === generation) {
        if (!partial) recordsCache.set(phaseId, { value: records, at: Date.now() });
        if (runs.length) putRuns(phaseId, runs);
      }
      return { records, partial };
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/* ------------------------------ invalidation ------------------------------ */

/**
 * Everything held is out of date: mark it so and ask for it again now.
 *
 * The copies stay where they are (a page that mounts in the meantime draws
 * them rather than a skeleton) and the fetch is started here rather than on
 * the next mount, so by the time the learner arrives the fresh answer is
 * usually already in.
 */
export function staleRecords(): void {
  generation += 1;
  inflight.clear();
  const runIds = [...runsCache.keys()];
  const recordIds = [...recordsCache.keys()];
  runsCache.forEach((entry) => {
    entry.stale = true;
  });
  recordsCache.forEach((entry) => {
    entry.stale = true;
  });
  runIds.forEach((id) => {
    void loadRuns(id, true);
  });
  recordIds.forEach((id) => {
    void loadRecords(id, { force: true });
  });
}

/** The same, for the one phase that was just run, submitted or merged. */
export function refreshPhaseRecords(phaseId: string): void {
  const runs = runsCache.get(phaseId);
  const records = recordsCache.get(phaseId);
  if (!runs && !records) return;
  generation += 1;
  if (runs) {
    runs.stale = true;
    inflight.delete(`runs:${phaseId}`);
    void loadRuns(phaseId, true);
  }
  if (records) {
    records.stale = true;
    inflight.delete(`rec:${phaseId}`);
    void loadRecords(phaseId, { force: true });
  }
}

/** Throw the records away: a different learner, or a different project. */
export function resetRecords(): void {
  generation += 1;
  runsCache.clear();
  recordsCache.clear();
  inflight.clear();
  scopes.clear();
}

onSessionEnd(resetRecords);
