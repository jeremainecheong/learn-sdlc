// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A background renewal (lib/api.ts) replaces the session token, not the
 * learner. Every place that tied work to the token it started under now asks
 * `sameSession`, so the call that triggered the renewal still lands: the
 * project load, the review history, the exit save, the session gate and the
 * sign-out. The real session store and the real modules, with `fetch` (or the
 * one API module a fence reads) as the seam; the renewal is made directly
 * with `replaceSessionToken`, exactly as lib/api.ts makes it.
 */

const routed = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routed,
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
}));
const history = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/api-experience', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-experience')>()),
  experienceApi: { history: history.read },
}));

import { endSession, getToken, onSessionLeaving } from '@/lib/api';
import { clearSession, replaceSessionToken, setAuthSession, setSession } from '@/lib/session';
import { loadReviewHistory, resetReviewHistory } from '@/lib/review-history';
import { saveVersionedWorkspaceOnExit } from '@/lib/api-workspace';
import { ProjectProvider, resetProject, useProject } from '@/lib/useProject';
import { SessionGate } from '@/components/shell/SessionGate';
import { useRequirementsSave } from '@/components/workspace/requirements/useRequirementsSave';
import { detail, file, phase } from './fixtures';

const NOW = Date.UTC(2026, 10, 9, 4, 0, 0);
const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (c: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(c)}.sig`;
const managed = (exp: number, extra: Record<string, unknown> = {}) =>
  jwt({ sub: 'user-1', ver: 0, provider: 'cognito', orig: NOW - 3_600_000, exp: Math.floor(exp / 1000), ...extra });
// Three hours left on both: request() itself never renews in these cases.
const OLD = managed(NOW + 3 * 3_600_000);
const RENEWED = managed(NOW + 3 * 3_600_000 + 60_000);
const profile = { id: 'user-1', email: 'learner@learnsdlc.test', displayName: 'Learner', role: 'LEARNER', cohort: 'default', createdAt: '2026-11-01T00:00:00.000Z' } as never;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() });
let route: (url: string, init?: RequestInit) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(String(url), init));
const renew = () => expect(replaceSessionToken(OLD, RENEWED)).toBe(true);

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  setAuthSession(OLD, profile);
  route = () => ok({});
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  history.read.mockReset();
  resetReviewHistory();
  resetProject();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  clearSession();
  vi.unstubAllGlobals();
});

describe('sameSession', () => {
  it('refuses the same account and sign-in time under a different provider', async () => {
    const { sameSession } = await import('@/lib/session-token');
    expect(sameSession(OLD, RENEWED)).toBe(true);
    expect(sameSession(OLD, managed(NOW + 3 * 3_600_000, { provider: 'local' }))).toBe(false);
    expect(sameSession(OLD, managed(NOW + 3 * 3_600_000, { provider: undefined }))).toBe(false);
  });
});

describe('a renewal in the middle of the work', () => {
  it('keeps the project load that triggered it (the load fence and the provider run)', async () => {
    let seen: ReturnType<typeof useProject> | null = null;
    function Probe() { seen = useProject(); return null; }
    route = (url) => {
      if (url.endsWith('/projects')) {
        renew();
        return ok([{ slug: 'tasktrackr', title: 'TaskTrackr', tagline: '', description: '', language: 'python', phaseTitles: [], hasWarmup: false }]);
      }
      if (url.includes('/enrollments/mine')) return ok(null);
      return ok({});
    };
    await act(async () => { root.render(<ProjectProvider><Probe /></ProjectProvider>); });
    await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
    expect(getToken()).toBe(RENEWED);
    expect(seen!.loading).toBe(false);
    expect(seen!.error).toBe('');
    expect(seen!.projects.map((p) => p.slug)).toEqual(['tasktrackr']);
  });

  it('keeps the versioned saver live when its own save triggers the renewal', async () => {
    const V1 = '2026-11-09T01:00:00.000Z';
    const V2 = '2026-11-09T01:00:01.000Z';
    const V3 = '2026-11-09T01:00:02.000Z';
    const source = detail(phase('requirements', 1, 'req', 'in_progress'), [file('requirements/draft.md', 'initial')], { workspaceUpdatedAt: V1 });
    let saver!: ReturnType<typeof useRequirementsSave>;
    let built = 0;
    function Room() { saver = useRequirementsSave('req', source); built += 1; return <output>{saver.saveError}</output>; }
    const saves: string[] = [];
    route = (url, init) => {
      if (url.endsWith('/phases/req/workspace') && init?.method === 'PUT') {
        saves.push(String((init.headers as Record<string, string>).authorization));
        if (saves.length === 1) renew();
        return ok({ version: saves.length === 1 ? V2 : V3 });
      }
      return ok({});
    };
    await act(async () => { root.render(<Room />); });
    const first = saver.flushSave;
    act(() => saver.setFile('requirements/draft.md', 'mine'));
    await act(async () => { await saver.flushSave(); });
    expect(getToken()).toBe(RENEWED);
    expect(saver.saveError).toBe('');
    expect(saver.savedVersion).toBe(V2);
    expect(saver.dirty).toBe(false);
    // A redraw under the renewed token keeps the same queue, version and all.
    await act(async () => { root.render(<Room />); });
    expect(built).toBeGreaterThan(1);
    expect(saver.flushSave).toBe(first);
    expect(saver.conflict).toBeNull();
    // And the next keystroke is saved, signed with the renewed token.
    act(() => saver.setFile('requirements/draft.md', 'mine again'));
    await act(async () => { await saver.flushSave(); });
    expect(saves).toEqual([`Bearer ${OLD}`, `Bearer ${RENEWED}`]);
    expect(saver.savedVersion).toBe(V3);
  });

  it('keeps the review history that was in the air', async () => {
    history.read.mockImplementation(async () => { renew(); return [{ id: 'r1' }]; });
    await expect(loadReviewHistory('enrollment', 'tasktrackr')).resolves.toEqual([{ id: 'r1' }]);
  });

  it('lets the exit save started under the old token go out', async () => {
    renew();
    route = () => ok({ version: 'v2' });
    await expect(saveVersionedWorkspaceOnExit('phase-1', { 'a.md': 'x' }, { baseVersion: 'v1', ownerId: 'user-1', token: OLD }))
      .resolves.toEqual({ version: 'v2' });
    // A different sign-in is still refused.
    setAuthSession(managed(NOW + 3 * 3_600_000, { orig: NOW }), profile);
    await expect(saveVersionedWorkspaceOnExit('phase-1', { 'a.md': 'x' }, { baseVersion: 'v1', ownerId: 'user-1', token: OLD }))
      .rejects.toThrow('editing session changed');
  });

  it('keeps the session gate open across a renewal', async () => {
    route = (url) => (url.endsWith('/auth/me') ? ok(profile) : ok({}));
    await act(async () => { root.render(<SessionGate><p data-testid="app">The app</p></SessionGate>); });
    await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
    expect(host.querySelector('[data-testid="app"]')).not.toBeNull();
    renew();
    // Anything that redraws the gate now reads the renewed token.
    act(() => setSession({ ...(profile as object), displayName: 'Learner Two' } as never));
    expect(host.querySelector('[data-testid="app"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-gate"]')).toBeNull();
    await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
    expect(host.querySelector('[data-testid="app"]')).not.toBeNull();
  });

  it('still signs out when the exit saves renew the token on the way', async () => {
    const off = onSessionLeaving(() => { renew(); });
    route = () => ok({ signedOut: true });
    await expect(endSession()).resolves.toBe(true);
    off();
    expect(getToken()).toBeNull();
    const logout = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/logout'));
    expect((logout?.[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${OLD}`);
  });
});
