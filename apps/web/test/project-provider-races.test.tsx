// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ token: 'owner-a', projects: vi.fn(), enrollment: vi.fn(), analytics: vi.fn(), summaries: vi.fn(), map: vi.fn(), putMap: vi.fn(), staleHistory: vi.fn(), resetHistory: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { projects: rig.projects, myEnrollment: rig.enrollment, analyticsMe: rig.analytics, phaseSummaries: rig.summaries, projectMap: rig.map },
  getToken: () => rig.token, ApiError: class extends Error {}, describeError: (_error: unknown, fallback: string) => fallback }));
vi.mock('@/lib/session', () => ({ onSessionEnd: () => () => {}, ownedByToken: (drop: () => void) => {
  let owner: string | null = null;
  return () => { if (owner !== rig.token) { drop(); owner = rig.token; } };
} }));
vi.mock('@/lib/project-map', () => ({ CARD_MAP: { compact: true, showLocked: true }, putMap: rig.putMap, resetMaps: vi.fn(), staleMaps: vi.fn() }));
vi.mock('@/lib/records', () => ({ resetRecords: vi.fn(), staleRecords: vi.fn(), rememberTaskScopes: vi.fn() }));
vi.mock('@/lib/review-history', () => ({ resetReviewHistory: rig.resetHistory, staleReviewHistory: rig.staleHistory }));
import { ProjectProvider, resetProject, useProject, type ProjectState } from '@/lib/useProject';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const enrollment = (id: string) => ({ id, projectSlug: 'tasktrackr', currentPhaseOrder: 1, phases: [] });
let root: Root, host: HTMLDivElement, current: ProjectState;
function Probe() { current = useProject(); return <output>{current.enrollment?.id ?? 'opening'}|{current.revalidating ? 'refreshing' : 'settled'}|{current.error}</output>; }
const render = (key = 'current') => act(async () => root.render(<ProjectProvider key={key}><Probe /></ProjectProvider>));
beforeEach(() => {
  vi.clearAllMocks(); rig.token = 'owner-a'; resetProject();
  rig.projects.mockResolvedValue([{ slug: 'tasktrackr', title: 'TaskTrackr' }]);
  rig.enrollment.mockResolvedValue(enrollment('initial'));
  rig.analytics.mockResolvedValue(null); rig.summaries.mockResolvedValue([]); rig.map.mockResolvedValue(null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('project provider request ownership', () => {
  it.each(['success', 'failure'] as const)('does not let an older refresh %s replace a newer record or error state', async outcome => {
    await render(); expect(current.enrollment?.id).toBe('initial');
    const older = deferred<ReturnType<typeof enrollment>>();
    rig.enrollment.mockReturnValueOnce(older.promise).mockResolvedValueOnce(enrollment('newest'));
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = current.reload(); });
    await act(async () => { second = current.reload(); await second; });
    expect(current.enrollment?.id).toBe('newest');
    await act(async () => {
      if (outcome === 'success') older.resolve(enrollment('outdated'));
      else older.reject(new Error('Older request failed'));
      await first;
    });
    expect(current.enrollment?.id).toBe('newest'); expect(current.error).toBe(''); expect(current.revalidating).toBe(false);
    const calls = rig.projects.mock.calls.length;
    await render('revisit');
    expect(current.enrollment?.id).toBe('newest'); expect(rig.projects).toHaveBeenCalledTimes(calls);
    expect(rig.staleHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps refreshing while the winner is pending even if the older request has completed', async () => {
    await render();
    const older = deferred<ReturnType<typeof enrollment>>(), newer = deferred<ReturnType<typeof enrollment>>();
    rig.enrollment.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = current.reload(); });
    await act(async () => { second = current.reload(); });
    await act(async () => { older.resolve(enrollment('outdated')); });
    expect(current.enrollment?.id).toBe('initial'); expect(current.revalidating).toBe(true);
    await act(async () => { newer.resolve(enrollment('newest')); await Promise.all([first, second]); });
    expect(current.enrollment?.id).toBe('newest'); expect(current.revalidating).toBe(false);
  });

  it('retains the latest refresh failure instead of replacing it with an older success', async () => {
    await render();
    const older = deferred<ReturnType<typeof enrollment>>();
    rig.enrollment.mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error('Current request failed'));
    let first!: Promise<void>;
    await act(async () => { first = current.reload(); });
    await act(async () => { await current.reload(); });
    const failure = current.error;
    expect(failure).toContain('could not be loaded');
    await act(async () => { older.resolve(enrollment('outdated')); await first; });
    expect(current.enrollment?.id).toBe('initial'); expect(current.error).toBe(failure); expect(current.revalidating).toBe(false);
  });

  it('discards a previous session’s late data and map after a token replacement without a logout event', async () => {
    const oldMap = deferred<unknown>();
    rig.enrollment.mockResolvedValueOnce(enrollment('private-owner-a')).mockResolvedValueOnce(enrollment('private-owner-b'));
    rig.map.mockReturnValueOnce(oldMap.promise).mockResolvedValueOnce({ nodes: [{ id: 'map-b' }], edges: [] });
    await render('a'); expect(rig.map).toHaveBeenCalledTimes(1);
    rig.token = 'owner-b'; // Simulates another tab replacing positive token/profile values.
    await render('b'); expect(current.enrollment?.id).toBe('private-owner-b');
    await act(async () => { oldMap.resolve({ nodes: [{ id: 'map-a' }], edges: [] }); });
    expect(current.enrollment?.id).toBe('private-owner-b');
    expect(rig.putMap).toHaveBeenCalledTimes(1);
    expect(rig.putMap.mock.calls[0][2]).toEqual({ nodes: [{ id: 'map-b' }], edges: [] });
    await render('b-revisit');
    expect(current.enrollment?.id).toBe('private-owner-b'); expect(rig.projects).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('owner-a');
  });
});
