'use client';

import { experienceApi, type SubmissionHistoryItem } from './api-experience';
import { getToken, onSessionEnd, ownedByToken } from './session';
import { sameSession } from './session-token';

type Entry = { records: SubmissionHistoryItem[]; at: number; stale: boolean; signature: string };
const entries = new Map<string, Entry>();
const pending = new Map<string, { signature: string; operation: Promise<SubmissionHistoryItem[]> }>();
let generation = 0;
export const REVIEW_HISTORY_FRESH_MS = 60_000;

export function resetReviewHistory(): void {
  generation += 1;
  entries.clear();
  pending.clear();
}
const own = ownedByToken(resetReviewHistory);
onSessionEnd(resetReviewHistory);

export function staleReviewHistory(): void {
  generation += 1;
  entries.forEach(entry => { entry.stale = true; });
  pending.clear();
}

/** A known learning record remains visible when its page is revisited. */
export function cachedReviewHistory(key: string): SubmissionHistoryItem[] | undefined {
  own();
  return getToken() ? entries.get(key)?.records : undefined;
}

export function loadReviewHistory(key: string, slug: string, force = false, signature = ''): Promise<SubmissionHistoryItem[]> {
  own();
  const token = getToken();
  const held = token ? entries.get(key) : undefined;
  if (!force && held && held.signature === signature && !held.stale && Date.now() - held.at < REVIEW_HISTORY_FRESH_MS) return Promise.resolve(held.records);
  const running = token ? pending.get(key) : undefined;
  // A forced read follows a newly observed verdict or explicit Retry. Joining
  // an older GET could put the pre-verdict history back over completed evidence.
  if (!force && running?.signature === signature) return running.operation;
  const mine = generation;
  const operation = experienceApi.history(slug).then(records => {
    // A response may arrive after logout or a replacement sign-in. Never
    // publish that response to either the caller or the next owner's cache.
    if (!sameSession(getToken(), token)) throw new Error('Your sign-in changed. Open your learning record again.');
    if (token && (mine !== generation || pending.get(key)?.operation !== operation)) {
      const newer = pending.get(key);
      if (newer) return newer.operation;
      const latest = entries.get(key);
      if (latest && !latest.stale) return latest.records;
      throw new ReviewHistorySuperseded();
    }
    if (token && mine === generation && pending.get(key)?.operation === operation) entries.set(key, { records, at: Date.now(), stale: false, signature });
    return records;
  }).finally(() => {
    if (pending.get(key)?.operation === operation) pending.delete(key);
  });
  if (token) pending.set(key, { signature, operation });
  return operation;
}

/** The project refresh will issue the replacement read; this is not a failure. */
export class ReviewHistorySuperseded extends Error {
  constructor() { super('A newer learning-record request replaced this one.'); this.name = 'ReviewHistorySuperseded'; }
}
