// @vitest-environment jsdom
/**
 * Which project the dashboard's Start starts, and which project the shell asks
 * about once a class has changed: against the real provider, with `fetch` the
 * one seam.
 *
 * Neither route may name a project the browser chose:
 *
 * 1. **Start** must not send `start(catalogue[0])` for anybody the server has
 *    not placed. A member of staff reads every published project in content
 *    order, so a teacher's project that sorts before the default
 *    (`library-desk` before `tasktrackr`) would be the one sent, and the
 *    staff exception would enrol them in it. The request names nothing and
 *    the tab holds whatever the server answered.
 * 2. **A class join or leave** must not reload the shell under the slug it
 *    already holds: `GET /enrollments/mine?project=<old>` is answered with the
 *    old row and the learner would stay on a teacher's project their class
 *    had left. Once the page forgets the project, the reload asks the server.
 */
import { act, useEffect } from 'react';
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

type Session = typeof import('@/lib/session');
type Active = typeof import('@/lib/project');
type Provider = typeof import('@/lib/useProject');
type Shared = typeof import('@/components/experience/shared');

let session: Session;
let active: Active;
let provider: Provider;
let shared: Shared;
let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

const meta = (slug: string, title: string): ProjectMeta =>
  ({
    slug,
    title,
    tagline: `${title} tagline`,
    description: `${title} description`,
    language: 'python',
    phaseTitles: [],
    hasWarmup: false,
  }) as ProjectMeta;

const LIBRARY = meta('library-desk', 'Library Desk — a teacher’s project');
const DEFAULT = meta('tasktrackr', 'TaskTrackr — the default project');

const person = (role: UserProfile['role']): UserProfile => ({
  id: `${role.toLowerCase()}-one`,
  email: `${role.toLowerCase()}@lab.test`,
  displayName: 'Someone',
  role,
  cohort: 'default',
  profileVersion: 1,
  createdAt: '2026-09-20T00:00:00.000Z',
});

const board = (slug: string): EnrollmentView =>
  ({
    id: `enrolment-${slug}`,
    projectSlug: slug,
    projectTitle: slug === 'tasktrackr' ? DEFAULT.title : LIBRARY.title,
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

/** What the server answers, and everything the browser asked it. */
const server = {
  catalogue: [] as ProjectMeta[],
  /** The enrolment `GET /enrollments/mine` resolves when no project is named. */
  resolved: null as EnrollmentView | null,
  /** The enrolments this account holds, by slug: what a named read answers. */
  held: {} as Record<string, EnrollmentView>,
  /** What `POST /enrollments` starts. */
  starts: 'tasktrackr',
  calls: [] as { method: string; path: string; body: unknown }[],
};

const answer = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  }) as unknown as Response;

function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = String(url).replace(/^.*\/api\/v1/, '');
  const method = String(init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  server.calls.push({ method, path, body });
  if (method === 'GET' && path === '/projects') return Promise.resolve(answer(server.catalogue));
  if (method === 'GET' && path === '/enrollments/mine') return Promise.resolve(answer(server.resolved));
  if (method === 'GET' && path.startsWith('/enrollments/mine?project=')) {
    const named = decodeURIComponent(path.split('=')[1]);
    return Promise.resolve(answer(server.held[named] ?? null));
  }
  if (method === 'POST' && path === '/enrollments') {
    const started = board(server.starts);
    server.held[started.projectSlug] = started;
    return Promise.resolve(answer(started));
  }
  // Analytics, the phase summaries and the map: nothing this file reads.
  return Promise.resolve(answer(path.includes('summaries') ? [] : null));
}


beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  routed.push.mockReset();
  fetchMock.mockReset().mockImplementation(serve);
  vi.stubGlobal('fetch', fetchMock);
  server.catalogue = [];
  server.resolved = null;
  server.held = {};
  server.starts = 'tasktrackr';
  server.calls = [];
  vi.resetModules();
  session = await import('@/lib/session');
  active = await import('@/lib/project');
  provider = await import('@/lib/useProject');
  shared = await import('@/components/experience/shared');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const startButton = () =>
  [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Start Requirements'));

describe('the dashboard’s Start', () => {
  it('starts what the server resolves, not the project that sorts first, for staff reading every project', async () => {
    session.setAuthSession('staff-token', person('INSTRUCTOR'));
    // Every published project, in content order: a teacher's sorts first.
    server.catalogue = [LIBRARY, DEFAULT];
    const { ProjectProvider } = provider;
    const { EmptyProject } = shared;
    await act(async () => {
      root.render(
        <ProjectProvider>
          <EmptyProject />
        </ProjectProvider>,
      );
    });
    await settle(6);

    // The page does not claim a project the server has not named.
    expect(host.textContent).not.toContain('Library Desk');
    expect(startButton()).toBeDefined();
    await act(async () => startButton()!.click());
    await settle(6);

    const post = server.calls.find((call) => call.method === 'POST' && call.path === '/enrollments');
    expect(post).toBeDefined();
    // The whole rule in one assertion: nothing is named, so nothing sorted
    // first can be sent.
    expect(post!.body).toEqual({});
    expect(JSON.stringify(post!.body)).not.toContain('library-desk');
    // The tab holds the server's answer, and the learner is taken to its door.
    expect(active.getActiveProject()).toBe('tasktrackr');
    expect(routed.push).toHaveBeenCalledTimes(1);
    expect(String(routed.push.mock.calls[0][0])).toContain('phase-tasktrackr');
  });

  it('names the learner’s own project on the Start panel, exactly as the default reads today', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    // A learner's catalogue is the server's own: the project it resolves
    // for them leads it.
    server.catalogue = [DEFAULT];
    const { ProjectProvider } = provider;
    const { EmptyProject } = shared;
    await act(async () => {
      root.render(
        <ProjectProvider>
          <EmptyProject />
        </ProjectProvider>,
      );
    });
    await settle(6);

    expect(host.textContent).toContain(
      'Build TaskTrackr from the first stakeholder conversation to a maintained release.',
    );
    await act(async () => startButton()!.click());
    await settle(6);

    const post = server.calls.find((call) => call.method === 'POST' && call.path === '/enrollments');
    expect(post!.body).toEqual({});
    expect(active.getActiveProject()).toBe('tasktrackr');
  });

  it('names the teacher’s project where the server resolved it for this learner', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    server.catalogue = [LIBRARY];
    server.starts = 'library-desk';
    const { ProjectProvider } = provider;
    const { EmptyProject } = shared;
    await act(async () => {
      root.render(
        <ProjectProvider>
          <EmptyProject />
        </ProjectProvider>,
      );
    });
    await settle(6);

    expect(host.textContent).toContain('Build Library Desk from the first stakeholder conversation');
    expect(host.textContent).not.toContain('TaskTrackr');
    await act(async () => startButton()!.click());
    await settle(6);

    const post = server.calls.find((call) => call.method === 'POST' && call.path === '/enrollments');
    expect(post!.body).toEqual({});
    expect(active.getActiveProject()).toBe('library-desk');
  });
});

describe('the shell after a class has changed', () => {
  it('asks the server which project is the learner’s, once the page has forgotten the one it held', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    server.catalogue = [LIBRARY, DEFAULT];
    // In a class on the teacher's project, with a board there.
    server.held = { 'library-desk': board('library-desk') };
    server.resolved = board('library-desk');
    let reload: (() => Promise<void>) | undefined;
    let slug = '';
    const { ProjectProvider, useProject } = provider;
    function Probe() {
      const project = useProject();
      useEffect(() => {
        reload = project.reload;
        slug = project.slug;
      });
      return null;
    }
    await act(async () => {
      root.render(
        <ProjectProvider>
          <Probe />
        </ProjectProvider>,
      );
    });
    await settle(6);
    expect(slug).toBe('library-desk');
    expect(active.getActiveProject()).toBe('library-desk');

    // The learner leaves the class. The server now resolves the default, with
    // no board yet: the teacher's-project work stays in their record.
    server.resolved = null;
    server.calls = [];
    active.clearActiveProject();
    await act(async () => {
      await reload!();
    });
    await settle(6);

    const reads = server.calls.filter((call) => call.path.startsWith('/enrollments/mine'));
    expect(reads.length).toBeGreaterThan(0);
    // The question is asked without a name: a named read is answered with the
    // held row, which would keep the learner where they were.
    expect(reads.every((call) => call.path === '/enrollments/mine')).toBe(true);
    expect(slug).toBe('');
  });

  it('still refreshes the project it holds when nothing told it to forget', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    server.catalogue = [LIBRARY, DEFAULT];
    server.held = { 'library-desk': board('library-desk') };
    server.resolved = board('library-desk');
    let reload: (() => Promise<void>) | undefined;
    const { ProjectProvider, useProject } = provider;
    function Probe() {
      const project = useProject();
      useEffect(() => {
        reload = project.reload;
      });
      return null;
    }
    await act(async () => {
      root.render(
        <ProjectProvider>
          <Probe />
        </ProjectProvider>,
      );
    });
    await settle(6);
    server.calls = [];

    await act(async () => {
      await reload!();
    });
    await settle(6);

    // A reload after a submission still names the project it is showing.
    const reads = server.calls.filter((call) => call.path.startsWith('/enrollments/mine'));
    expect(reads.map((call) => call.path)).toEqual(['/enrollments/mine?project=library-desk']);
  });
});

/**
 * A learner whose class works another project.
 *
 * A learner who started the default on their own and whose class then works a
 * teacher's project (they joined late, or the class was given one after they
 * started) has the default set aside so they can start the class's. The row
 * is not deleted and its pin does not move. The server says so on the
 * learner's catalogue (`ProjectMeta.setAside`), leads it with the class's
 * project, and answers `GET /enrollments/mine` with nothing until they start
 * it. The Start card tells them once, in one plain sentence, and the sentence
 * goes when they start.
 */
describe('a learner whose class works another project', () => {
  const KEPT: ProjectMeta = { ...DEFAULT, setAside: true };
  const NOTICE =
    'Your class works on Library Desk, so that is what you start here. Your work on TaskTrackr stays in your record.';
  const notice = () => host.querySelector('[data-testid="set-aside-notice"]');

  /** The dashboard's own branch: the board once there is one, the Start card before. */
  function Home() {
    const project = provider.useProject();
    return project.enrollment ? <p data-testid="board">{project.enrollment.projectSlug}</p> : <shared.EmptyProject />;
  }

  const mount = async () => {
    const { ProjectProvider } = provider;
    await act(async () => {
      root.render(
        <ProjectProvider>
          <Home />
        </ProjectProvider>,
      );
    });
    await settle(6);
  };

  it('tells them on the Start card which project starts and that their earlier work stays', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    server.catalogue = [LIBRARY, KEPT];
    server.held = { tasktrackr: board('tasktrackr') };
    server.resolved = null;
    server.starts = 'library-desk';
    await mount();

    expect(notice()?.textContent).toBe(NOTICE);
    // One sentence about it, and the panel still names the class's project.
    expect(host.querySelectorAll('[data-testid="set-aside-notice"]')).toHaveLength(1);
    expect(host.textContent).toContain('Build Library Desk from the first stakeholder conversation');

    // Start still names nothing: the server starts the class's project.
    server.resolved = board('library-desk');
    await act(async () => startButton()!.click());
    await settle(6);
    const post = server.calls.find((call) => call.method === 'POST' && call.path === '/enrollments');
    expect(post!.body).toEqual({});
    expect(active.getActiveProject()).toBe('library-desk');
    // And once they have started, it is gone on its own.
    expect(host.querySelector('[data-testid="board"]')?.textContent).toBe('library-desk');
    expect(notice()).toBeNull();
    expect(host.textContent).not.toContain('stays in your record');
  });

  it('names every project set aside, and only those', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    server.catalogue = [LIBRARY, KEPT, { ...meta('ledger', 'Ledger — a platform project'), setAside: true }];
    await mount();

    expect(notice()?.textContent).toBe(
      'Your class works on Library Desk, so that is what you start here. Your work on TaskTrackr and Ledger stays in your record.',
    );
  });

  it('says nothing of the kind when nothing is set aside', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    server.catalogue = [LIBRARY, DEFAULT];
    await mount();

    expect(startButton()).toBeDefined();
    expect(notice()).toBeNull();
    expect(host.textContent).not.toContain('stays in your record');
  });

  it('says nothing of the kind to a member of staff, whose catalogue does not lead with their own', async () => {
    session.setAuthSession('staff-token', person('INSTRUCTOR'));
    // A staff listing never carries the mark; were one to, its first entry is
    // only the project that sorted first, and naming it would be a guess.
    server.catalogue = [LIBRARY, KEPT];
    await mount();

    expect(startButton()).toBeDefined();
    expect(notice()).toBeNull();
  });

  it('asks the server, rather than reopening the set-aside project, when the shell reloads the one it held', async () => {
    session.setAuthSession('learner-token', person('LEARNER'));
    // Working the default in an open tab.
    server.catalogue = [DEFAULT];
    server.held = { tasktrackr: board('tasktrackr') };
    server.resolved = board('tasktrackr');
    let reload: (() => Promise<void>) | undefined;
    let slug = '';
    const { ProjectProvider, useProject } = provider;
    function Probe() {
      const project = useProject();
      useEffect(() => {
        reload = project.reload;
        slug = project.slug;
      });
      return project.enrollment ? null : <shared.EmptyProject />;
    }
    await act(async () => {
      root.render(
        <ProjectProvider>
          <Probe />
        </ProjectProvider>,
      );
    });
    await settle(6);
    expect(slug).toBe('tasktrackr');

    // Their teacher gives the class a project. The default row is set aside;
    // the server now resolves the class's project, not started yet.
    server.catalogue = [LIBRARY, KEPT];
    server.resolved = null;
    server.calls = [];
    await act(async () => {
      await reload!();
    });
    await settle(6);

    const reads = server.calls.filter((call) => call.path.startsWith('/enrollments/mine'));
    expect(reads.map((call) => call.path)).toEqual(['/enrollments/mine']);
    expect(slug).toBe('');
    expect(notice()?.textContent).toBe(NOTICE);
  });
});

/**
 * An INSTRUCTOR may start only the platform's projects, their own,
 * or one assigned to a class of theirs, and is refused anything else in the
 * learner's one sentence. The dashboard's Start is the one place in the app a
 * member of staff starts a project, and it names none, so the server has
 * nothing to refuse there. Were it ever to refuse, the panel shows the
 * server's sentence as it stands, adds nothing that names a project, and
 * leaves a way to try again.
 */
describe('an instructor refused a start', () => {
  const REFUSAL =
    'Nothing was started, because that project is not one this account can start; your dashboard opens the project that is yours.';

  it('shows the server’s one sentence and names no project', async () => {
    session.setAuthSession('staff-token', person('INSTRUCTOR'));
    server.catalogue = [LIBRARY, DEFAULT];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(init?.method ?? 'GET').toUpperCase() === 'POST' && String(url).endsWith('/enrollments')) {
        server.calls.push({ method: 'POST', path: '/enrollments', body: JSON.parse(String(init?.body ?? '{}')) });
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ statusCode: 403, message: REFUSAL, error: 'Forbidden' }),
          headers: { get: () => null },
        } as unknown as Response);
      }
      return serve(url, init);
    });
    const { ProjectProvider } = provider;
    await act(async () => {
      root.render(
        <ProjectProvider>
          <shared.EmptyProject />
        </ProjectProvider>,
      );
    });
    await settle(6);
    await act(async () => startButton()!.click());
    await settle(6);

    const post = server.calls.find((call) => call.method === 'POST' && call.path === '/enrollments');
    expect(post!.body).toEqual({});
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(REFUSAL);
    expect(host.textContent).not.toContain('Library Desk');
    expect(host.textContent).not.toContain('library-desk');
    expect(routed.push).not.toHaveBeenCalled();
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry project'));
    expect(retry).toBeDefined();
    expect(retry!.disabled).toBe(false);
  });
});
