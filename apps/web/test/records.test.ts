/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRunView } from '@learnsdlc/shared';

/**
 * The per-phase record cache: the run log Home shows and the three lists the
 * journal draws its timeline from.
 *
 * Its rules are all about what a page sees while something else is in flight:
 * a copy that is stale is still drawn, a failed refetch never empties what is
 * held, and an answer to a question asked before the last change is handed to
 * whoever waited for it but never written back into the cache.
 */

const api = {
  runs: vi.fn(),
  submissions: vi.fn(),
  chatHistory: vi.fn(),
};

vi.mock('@/lib/api', () => ({ api }));

type Records = typeof import('@/lib/records');
let records: Records;

const runRow = (id: string): ExecutionRunView =>
  ({ id, kind: 'run', status: 'completed', result: null, createdAt: '2026-09-02T10:00:00.000Z' }) as ExecutionRunView;

beforeEach(async () => {
  window.localStorage.clear();
  api.runs.mockReset().mockResolvedValue([runRow('r1')]);
  api.submissions.mockReset().mockResolvedValue([]);
  api.chatHistory.mockReset().mockResolvedValue([]);
  vi.resetModules();
  records = await import('@/lib/records');
});

describe('the run log', () => {
  it('asks once and answers from the copy for a minute', async () => {
    await records.loadRuns('p1');
    await records.loadRuns('p1');

    expect(api.runs).toHaveBeenCalledTimes(1);
    expect(records.cachedRuns('p1')).toEqual([runRow('r1')]);
  });

  it('makes one request when two pages ask at the same moment', async () => {
    const [a, b] = await Promise.all([records.loadRuns('p1'), records.loadRuns('p1')]);
    expect(api.runs).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('asks again when the caller says the copy is out of date', async () => {
    await records.loadRuns('p1');
    await records.loadRuns('p1', true);
    expect(api.runs).toHaveBeenCalledTimes(2);
  });

  it('keeps the copy it has when the refetch fails, and never rejects', async () => {
    await records.loadRuns('p1');
    api.runs.mockRejectedValueOnce(new Error('502'));

    await expect(records.loadRuns('p1', true)).resolves.toEqual([runRow('r1')]);
    expect(records.cachedRuns('p1')).toEqual([runRow('r1')]);
  });

  it('answers with an empty log rather than failing a page that has none', async () => {
    api.runs.mockRejectedValueOnce(new Error('502'));
    await expect(records.loadRuns('p9')).resolves.toEqual([]);
    expect(records.cachedRuns('p9')).toBeUndefined();
  });

  it('has nothing cached for a phase it was never asked about', () => {
    expect(records.cachedRuns(undefined)).toBeUndefined();
    expect(records.cachedRuns('nobody')).toBeUndefined();
  });

  it('takes a log handed to it straight after a run', () => {
    records.putRuns('p1', [runRow('fresh')]);
    expect(records.cachedRuns('p1')).toEqual([runRow('fresh')]);
  });
});

describe('the journal records', () => {
  it('makes the three requests once and reports nothing missing', async () => {
    const { records: held, partial } = await records.loadRecords('p1');

    expect(partial).toBe(false);
    expect(held.runs).toEqual([runRow('r1')]);
    expect(api.submissions).toHaveBeenCalledTimes(1);
    expect(api.chatHistory).toHaveBeenCalledTimes(1);
    expect(records.hasRecords(['p1'])).toBe(true);
    // The run log comes free with it rather than being asked for twice.
    expect(records.cachedRuns('p1')).toEqual([runRow('r1')]);
  });

  it('says so, rather than failing, when one of the three does not answer', async () => {
    api.chatHistory.mockRejectedValueOnce(new Error('503'));
    const { records: held, partial } = await records.loadRecords('p1');

    expect(partial).toBe(true);
    expect(held.chat).toEqual([]);
    expect(held.runs).toEqual([runRow('r1')]);
    // A partial answer is not kept: the next visit should try again.
    expect(records.hasRecords(['p1'])).toBe(false);
  });

  it('hands one answer to everyone who asked while it was in the air', async () => {
    const [a, b] = await Promise.all([records.loadRecords('p1'), records.loadRecords('p1')]);
    expect(a).toBe(b);
    expect(api.submissions).toHaveBeenCalledTimes(1);
  });

  it('returns what is cached for the phases asked about, and nothing for the rest', async () => {
    await records.loadRecords('p1');
    expect(Object.keys(records.cachedRecords(['p1', 'p2']))).toEqual(['p1']);
    expect(records.hasRecords(['p1', 'p2'])).toBe(false);
  });
});

describe('when something changes underneath', () => {
  it('keeps showing what it holds while it fetches again', async () => {
    await records.loadRuns('p1');
    api.runs.mockResolvedValue([runRow('r2')]);

    records.staleRecords();

    // The old copy is still there to draw with, not a skeleton.
    expect(records.cachedRuns('p1')).toEqual([runRow('r1')]);
    await vi.waitFor(() => expect(records.cachedRuns('p1')).toEqual([runRow('r2')]));
  });

  it('never writes an answer asked for before the records went stale over the newer one', async () => {
    await records.loadRuns('p1');

    // A fetch that was asked before the records went stale and lands after.
    let land: (v: ExecutionRunView[]) => void = () => undefined;
    api.runs.mockImplementationOnce(
      () =>
        new Promise<ExecutionRunView[]>((resolve) => {
          land = resolve;
        }),
    );
    const inflight = records.loadRuns('p1', true);
    records.staleRecords();
    land([runRow('stale-answer')]);

    // The caller waiting on it is answered, because an answer is better than a
    // spinner; the cache is not, because the question was asked too early.
    await expect(inflight).resolves.toEqual([runRow('stale-answer')]);
    expect(records.cachedRuns('p1')).not.toEqual([runRow('stale-answer')]);
  });

  // The room draws the stale copy at once and follows the refresh to the fresh one (the workspace page's records effect).
  it('hands a page the refresh a change started, and nothing when none is in the air', async () => {
    api.submissions.mockResolvedValue([{ id: 's1' }]);
    await records.loadRecords('p1');
    expect(records.refreshingRecords('p1')).toBeUndefined();

    api.submissions.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    api.submissions.mockClear();
    records.refreshPhaseRecords('p1');

    // Still the copy from before the change, with its refresh in the air.
    expect(records.cachedRecords(['p1']).p1.submissions).toEqual([{ id: 's1' }]);
    const refresh = records.refreshingRecords('p1');
    expect(refresh).toBeDefined();
    await expect(refresh).resolves.toMatchObject({ partial: false, records: { submissions: [{ id: 's1' }, { id: 's2' }] } });
    // Following it asked for nothing of its own, and once it has landed there is nothing left to follow.
    expect(api.submissions).toHaveBeenCalledTimes(1);
    expect(records.refreshingRecords('p1')).toBeUndefined();
    expect(records.refreshingRecords('never-read')).toBeUndefined();
  });

  it('hands a page the newer refresh when a second change overtakes the first', async () => {
    api.submissions.mockResolvedValue([{ id: 's1' }]);
    await records.loadRecords('p1');

    // Two changes, the second while the first one's refresh is still in the air: a verdict's two arrivals.
    const land: ((v: unknown[]) => void)[] = [];
    api.submissions.mockImplementation(() => new Promise<unknown[]>((resolve) => { land.push(resolve); }));
    records.staleRecords();
    const first = records.refreshingRecords('p1');
    records.staleRecords();
    const second = records.refreshingRecords('p1');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // The overtaken answer reaches whoever waited on it and is never written into the cache, so the copy a
    // page reads at that moment is still the one from before the change.
    land[0]([{ id: 's1' }, { id: 's2' }]);
    await first;
    expect(records.cachedRecords(['p1']).p1.submissions).toEqual([{ id: 's1' }]);
    // The refresh a page is handed after the second change is the one that brings the list as it now is.
    land[1]([{ id: 's1' }, { id: 's2' }]);
    await expect(second).resolves.toMatchObject({ partial: false, records: { submissions: [{ id: 's1' }, { id: 's2' }] } });
    expect(records.cachedRecords(['p1']).p1.submissions).toEqual([{ id: 's1' }, { id: 's2' }]);
  });

  it('refreshes only the phase that was run, and only what is already held', async () => {
    await records.loadRuns('p1');
    api.runs.mockClear().mockResolvedValue([runRow('after')]);

    records.refreshPhaseRecords('p2');
    expect(api.runs).not.toHaveBeenCalled();

    records.refreshPhaseRecords('p1');
    await vi.waitFor(() => expect(records.cachedRuns('p1')).toEqual([runRow('after')]));
  });

  it('throws everything away for a different learner or a different project', async () => {
    await records.loadRuns('p1');
    records.resetRecords();
    expect(records.cachedRuns('p1')).toBeUndefined();
    expect(records.hasRecords(['p1'])).toBe(false);
  });

  it('empties itself when a second learner signs in over the first', async () => {
    window.localStorage.setItem('lsdlc_token', 'first');
    await records.loadRuns('p1');
    expect(records.cachedRuns('p1')).toEqual([runRow('r1')]);

    window.localStorage.setItem('lsdlc_token', 'second');
    expect(records.cachedRuns('p1')).toBeUndefined();
  });
});

