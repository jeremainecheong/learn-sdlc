// @vitest-environment jsdom
/**
 * A learner whose class is assigned another project, mounted: the real
 * dashboard page, inside the real project provider and session, with `fetch`
 * the only seam and the chrome
 * (`AppShell`) drawn as its children.
 *
 * The server half is proved over HTTP in `apps/api/test/teacher-projects.e2e-spec.ts`
 * (steps 10b.5 and 13): a learner who started the default and is in a class
 * whose ACTIVE assignment is another project reads a catalogue that leads with
 * the class's project and marks the default `setAside`, gets nothing from
 * `GET /enrollments/mine` until they start, and `POST /enrollments` naming
 * nothing starts the class's project. This file answers the page with exactly
 * those shapes and asserts what the learner meets at `/dashboard`:
 *
 * 1. they are told once, in one plain sentence, which project starts here and
 *    that their earlier work stays in their record;
 * 2. Start names no project (the server decides) and opens the class's board;
 * 3. once started, the sentence is gone, because the Start card that carried it
 *    is gone;
 * 4. a learner with nothing set aside, on the same page, is told nothing.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, ProjectMeta, UserProfile } from '@learnsdlc/shared';
import { settle } from './support/dom';

const routed = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routed,
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));

const meta = (slug: string, title: string, setAside?: true): ProjectMeta =>
  ({
    slug,
    title,
    tagline: `${title} tagline`,
    description: `${title} description`,
    language: 'python',
    phaseTitles: [{ key: 'requirements', order: 1, title: 'Requirements' }],
    hasWarmup: false,
    ...(setAside ? { setAside } : {}),
  }) as ProjectMeta;

/** What `GET /projects` answered the e2e's learner, in its order. */
const CLASS_PROJECT = meta('field-notes', 'Field Notes');
const KEPT_DEFAULT = meta('tasktrackr', 'TaskTrackr', true);
const NOTICE =
  'Your class works on Field Notes, so that is what you start here. Your work on TaskTrackr stays in your record.';

const learner: UserProfile = {
  id: 'ola',
  email: 'ola@lab.test',
  displayName: 'Ola Learner',
  role: 'LEARNER',
  cohort: 'tuesday',
  profileVersion: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
};

const board = (slug: string, title: string): EnrollmentView =>
  ({
    id: `enrolment-${slug}`,
    projectSlug: slug,
    projectTitle: title,
    currentPhaseOrder: 1,
    completed: false,
    phases: [
      {
        id: `phase-${slug}`,
        key: 'requirements',
        order: 1,
        title: 'Requirements',
        status: 'in_progress',
        bestScore: null,
        attempts: 0,
        reflection: null,
        passedAt: null,
        opensAt: null,
        dueAt: null,
      },
    ],
  }) as unknown as EnrollmentView;

const server = {
  catalogue: [] as ProjectMeta[],
  resolved: null as EnrollmentView | null,
  starts: CLASS_PROJECT,
  calls: [] as { method: string; path: string; body: unknown }[],
};

const answer = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  }) as unknown as Response;

function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = String(url).replace(/^.*\/api\/v1/, '');
  const method = String(init?.method ?? 'GET').toUpperCase();
  server.calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (method === 'GET' && path === '/projects') return Promise.resolve(answer(200, server.catalogue));
  if (method === 'GET' && path.startsWith('/enrollments/mine')) return Promise.resolve(answer(200, server.resolved));
  if (method === 'POST' && path === '/enrollments') {
    const started = board(server.starts.slug, server.starts.title);
    server.resolved = started;
    return Promise.resolve(answer(201, started));
  }
  // The phase summaries, the review history, analytics: lists, empty.
  return Promise.resolve(answer(200, path.includes('analytics') ? null : []));
}

let host: HTMLDivElement;
let root: Root;
let Dashboard: (typeof import('@/app/(app)/dashboard/page'))['default'];
let ProjectProvider: (typeof import('@/lib/useProject'))['ProjectProvider'];


const notices = () => host.querySelectorAll('[data-testid="set-aside-notice"]');
const startButton = () =>
  [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Start Requirements'));

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  routed.push.mockReset();
  vi.stubGlobal('fetch', vi.fn(serve));
  server.catalogue = [];
  server.resolved = null;
  server.starts = CLASS_PROJECT;
  server.calls = [];
  vi.resetModules();
  const session = await import('@/lib/session');
  session.setAuthSession('learner-token', learner);
  ({ ProjectProvider } = await import('@/lib/useProject'));
  Dashboard = (await import('@/app/(app)/dashboard/page')).default;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = async () => {
  await act(async () => {
    root.render(
      <ProjectProvider>
        <Dashboard />
      </ProjectProvider>,
    );
  });
  await settle();
};

describe('the dashboard of a learner whose class works another project', () => {
  it('tells them once, starts what the server resolves, and says no more once they have', async () => {
    server.catalogue = [CLASS_PROJECT, KEPT_DEFAULT];
    await mount();

    // Told once, in the one sentence, on the page they land on.
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toBe(NOTICE);
    expect(host.textContent?.split('stays in your record').length).toBe(2);
    // The Start card names the class's project, not the one set aside.
    expect(startButton()).toBeDefined();
    expect(host.textContent).toContain('Field Notes');

    await act(async () => startButton()!.click());
    await settle();

    // The browser named nothing; the server chose.
    const posts = server.calls.filter((call) => call.method === 'POST' && call.path === '/enrollments');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({});
    expect(JSON.stringify(posts[0].body)).not.toContain('tasktrackr');
    // The board is the class's, and the sentence went with the Start card.
    expect(routed.push).toHaveBeenCalledTimes(1);
    expect(String(routed.push.mock.calls[0][0])).toContain('phase-field-notes');
    expect(notices()).toHaveLength(0);
    expect(host.textContent).not.toContain('stays in your record');
  });

  it('says nothing of the kind to a learner with nothing set aside', async () => {
    server.catalogue = [meta('tasktrackr', 'TaskTrackr')];
    server.starts = meta('tasktrackr', 'TaskTrackr');
    await mount();

    expect(startButton()).toBeDefined();
    expect(notices()).toHaveLength(0);
    expect(host.textContent).not.toContain('stays in your record');
  });
});
