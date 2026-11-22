import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionHistoryItem } from '@/lib/api-experience';

const state = vi.hoisted(() => ({ token: 'learner-one' as string | null, history: vi.fn(), end: () => {} }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { history: state.history } }));
vi.mock('@/lib/session', () => ({
  getToken: () => state.token,
  onSessionEnd: (listener: () => void) => { state.end = listener; },
  ownedByToken: (drop: () => void) => {
    let owner: string | null = null;
    return () => { if (owner !== state.token) { drop(); owner = state.token; } };
  },
}));
import { cachedReviewHistory, loadReviewHistory, resetReviewHistory, staleReviewHistory } from '@/lib/review-history';

const record = (id: string): SubmissionHistoryItem => ({ id, phaseStateId: 'requirements', attempt: 1, status: 'completed', passed: false,
  verifiedPass: false, reviewUnavailable: false, createdAt: '2026-09-15T00:00:00Z' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { state.token = 'learner-one'; state.history.mockReset(); resetReviewHistory(); });

describe('learning record continuity', () => {
  it('reuses a verified empty history without a new request on a page revisit', async () => {
    state.history.mockResolvedValue([]);
    await loadReviewHistory('enrollment', 'tasktrackr');
    expect(cachedReviewHistory('enrollment')).toEqual([]);
    await loadReviewHistory('enrollment', 'tasktrackr');
    expect(state.history).toHaveBeenCalledTimes(1);
  });

  it('deduplicates simultaneous pages requesting the same record', async () => {
    const read = deferred<SubmissionHistoryItem[]>(); state.history.mockReturnValue(read.promise);
    const first = loadReviewHistory('enrollment', 'tasktrackr');
    const second = loadReviewHistory('enrollment', 'tasktrackr');
    expect(second).toBe(first);
    read.resolve([record('first')]); await first;
    expect(state.history).toHaveBeenCalledTimes(1);
  });

  it('keeps existing records visible during a failed refresh, then retries the real request', async () => {
    state.history.mockResolvedValueOnce([record('old')]);
    await loadReviewHistory('enrollment', 'tasktrackr');
    staleReviewHistory(); state.history.mockRejectedValueOnce(new Error('Offline'));
    await expect(loadReviewHistory('enrollment', 'tasktrackr')).rejects.toThrow('Offline');
    expect(cachedReviewHistory('enrollment')?.[0].id).toBe('old');
    state.history.mockResolvedValueOnce([record('new')]);
    await loadReviewHistory('enrollment', 'tasktrackr');
    expect(cachedReviewHistory('enrollment')?.[0].id).toBe('new');
  });

  it('reloads when phase attempts/status change without showing an invented empty history', async () => {
    state.history.mockResolvedValueOnce([record('old')]);
    await loadReviewHistory('enrollment', 'tasktrackr', false, 'attempt:1');
    const next = deferred<SubmissionHistoryItem[]>(); state.history.mockReturnValueOnce(next.promise);
    const reload = loadReviewHistory('enrollment', 'tasktrackr', false, 'attempt:2');
    expect(cachedReviewHistory('enrollment')?.[0].id).toBe('old');
    next.resolve([record('new')]); await reload;
    expect(cachedReviewHistory('enrollment')?.[0].id).toBe('new');
  });

  it('does not let a superseded request overwrite a newer history', async () => {
    const old = deferred<SubmissionHistoryItem[]>(); const next = deferred<SubmissionHistoryItem[]>();
    state.history.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = loadReviewHistory('enrollment', 'tasktrackr', false, 'attempt:1');
    const second = loadReviewHistory('enrollment', 'tasktrackr', false, 'attempt:2');
    next.resolve([record('new')]); await second;
    old.resolve([record('old')]); expect((await first)[0].id).toBe('new');
    expect(cachedReviewHistory('enrollment')?.[0].id).toBe('new');
  });

  it('a terminal-evidence refresh supersedes a pending same-signature queued history for every caller', async () => {
    state.history.mockResolvedValueOnce([record('queued')]);
    await loadReviewHistory('enrollment', 'tasktrackr', false, 'attempt:1');
    staleReviewHistory();
    const old = deferred<SubmissionHistoryItem[]>(); const next = deferred<SubmissionHistoryItem[]>();
    state.history.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const background = loadReviewHistory('enrollment', 'tasktrackr', false, 'attempt:1');
    const completed = loadReviewHistory('enrollment', 'tasktrackr', true, 'attempt:1');
    expect(completed).not.toBe(background);
    old.resolve([record('queued')]);
    next.resolve([record('completed')]);
    expect((await background)[0].id).toBe('completed');
    expect((await completed)[0].id).toBe('completed');
    expect(cachedReviewHistory('enrollment')?.[0].id).toBe('completed');
  });

  it('discards cached private records immediately when the session changes', async () => {
    state.history.mockResolvedValueOnce([record('private')]);
    await loadReviewHistory('enrollment', 'tasktrackr');
    state.token = 'learner-two';
    expect(cachedReviewHistory('enrollment')).toBeUndefined();
  });

  it('rejects a late response belonging to a previous session', async () => {
    const read = deferred<SubmissionHistoryItem[]>(); state.history.mockReturnValue(read.promise);
    const pending = loadReviewHistory('enrollment', 'tasktrackr');
    state.token = 'learner-two'; read.resolve([record('private')]);
    await expect(pending).rejects.toThrow('sign-in changed');
    expect(cachedReviewHistory('enrollment')).toBeUndefined();
  });

  it('drops records on logout and keeps separate enrollment histories separate', async () => {
    state.history.mockResolvedValueOnce([record('project-one')]).mockResolvedValueOnce([record('project-two')]);
    await loadReviewHistory('one', 'one'); await loadReviewHistory('two', 'two');
    expect(cachedReviewHistory('one')?.[0].id).toBe('project-one');
    expect(cachedReviewHistory('two')?.[0].id).toBe('project-two');
    state.end();
    expect(cachedReviewHistory('one')).toBeUndefined();
    expect(cachedReviewHistory('two')).toBeUndefined();
  });
});
