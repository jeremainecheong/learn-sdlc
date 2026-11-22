// @vitest-environment jsdom
/**
 * The record a learner is promised is one they can open, mounted.
 *
 * A platform project a learner started is set aside when their class works
 * another one, and the Start card tells them "Your work on TaskTrackr stays
 * in your record." The shell draws only the project the server resolves, so
 * if the dossier and completion pages read only the shell's enrolment,
 * /dossier would tell a learner with a term of TaskTrackr evidence "No
 * project started". These pages open the kept record by name.
 *
 * The real pages, inside the real project provider and session, with `fetch`
 * the one seam, answered with the shapes the server gives such a learner
 * (apps/api/test/teacher-projects.e2e-spec.ts steps 10b and 13): a catalogue
 * led by the class's project with TaskTrackr marked `setAside`, nothing from
 * the unnamed `/enrollments/mine` until they start, and TaskTrackr's finished
 * board by name.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, ProjectMeta, UserProfile } from '@learnsdlc/shared';
import { settle } from './support/dom';

const nav = vi.hoisted(() => ({ search: '' }));
const routed = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routed,
  usePathname: () => '/dossier',
  useSearchParams: () => new URLSearchParams(nav.search),
  useParams: () => ({}),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));

const meta = (slug: string, title: string, setAside?: true): ProjectMeta =>
  ({
    slug,
    title,
    tagline: `${title} tagline`,
    description: `${title} description`,
    language: 'python',
    phaseTitles: [],
    hasWarmup: false,
    ...(setAside ? { setAside } : {}),
  }) as ProjectMeta;

const CLASS_PROJECT = meta('field-notes', 'Field Notes');
const KEPT = meta('tasktrackr', 'TaskTrackr', true);
const SENTINEL = 'KEPT STORY SENTINEL: the learner wrote this in TaskTrackr.';
const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;

const learner: UserProfile = {
  id: 'ola',
  email: 'ola@lab.test',
  displayName: 'Ola Learner',
  role: 'LEARNER',
  cohort: 'tuesday',
  profileVersion: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
};

const phase = (key: (typeof KEYS)[number], order: number) => ({
  id: `kept-${key}`,
  key,
  order,
  title: key[0].toUpperCase() + key.slice(1),
  status: 'passed',
  bestScore: 90,
  attempts: 1,
  reflection: 'Done.',
  passedAt: '2026-09-14T01:00:00.000Z',
  opensAt: null,
  dueAt: null,
});

/** TaskTrackr, finished alone before the learner joined the class. */
const keptBoard = {
  id: 'enrolment-tasktrackr',
  projectSlug: 'tasktrackr',
  projectTitle: 'TaskTrackr',
  currentPhaseOrder: 6,
  completed: true,
  completedAt: '2026-09-14T02:00:00.000Z',
  startedAt: '2026-09-01T00:00:00.000Z',
  phases: KEYS.map((key, index) => phase(key, index + 1)),
} as unknown as EnrollmentView;

const submission = (key: string) => ({
  id: `sub-${key}`,
  phaseStateId: `kept-${key}`,
  status: 'completed',
  passed: true,
  verifiedPass: true,
  reviewUnavailable: false,
  attempt: 1,
  createdAt: '2026-09-14T01:00:00.000Z',
  commitMessage: 'Done',
});

/** The class's project, started: what the unnamed `/enrollments/mine` answers once the learner has pressed Start. */
const startedOnClassProject = (): EnrollmentView =>
  ({
    ...keptBoard,
    id: 'enrolment-field-notes',
    projectSlug: 'field-notes',
    projectTitle: 'Field Notes',
    completed: false,
    completedAt: null,
    phases: [{ ...keptBoard.phases[0], id: 'notes-requirements', status: 'in_progress', passedAt: null }],
  }) as unknown as EnrollmentView;

const calls: { method: string; path: string }[] = [];
/** What the unnamed `/enrollments/mine` answers: nothing until the class's project is started. */
const server = { resolved: null as EnrollmentView | null, catalogue: [] as ProjectMeta[] };

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
  calls.push({ method, path });
  if (method !== 'GET') return Promise.resolve(answer(500, { message: `nothing is written here: ${method} ${path}` }));
  if (path === '/projects') return Promise.resolve(answer(200, server.catalogue));
  // Not started on the class's project: the unnamed read answers nothing.
  if (path === '/enrollments/mine') return Promise.resolve(answer(200, server.resolved));
  if (path === '/enrollments/mine?project=tasktrackr') return Promise.resolve(answer(200, keptBoard));
  if (path === '/phases/summaries?project=tasktrackr')
    return Promise.resolve(answer(200, keptBoard.phases.map((one) => ({ ...one, view: 'summary', files: [] }))));
  if (path === '/phases/records?project=tasktrackr')
    return Promise.resolve(
      answer(200, Object.fromEntries(keptBoard.phases.map((one) => [one.id, { submissions: [], runs: [], chat: [] }]))),
    );
  if (path.startsWith('/submissions/review-history/pages?project=tasktrackr'))
    return Promise.resolve(answer(200, { items: KEYS.map(submission), nextCursor: null, total: KEYS.length }));
  if (path.startsWith('/submissions/review-history/pages'))
    return Promise.resolve(answer(200, { items: [], nextCursor: null, total: 0 }));
  const one = /^\/submissions\/sub-([a-z]+)\?include=snapshot$/.exec(path);
  if (one)
    return Promise.resolve(
      answer(200, {
        ...submission(one[1]),
        report: null,
        // The story record the dossier's Requirements section draws.
        workspaceSnapshot:
          one[1] === 'requirements'
            ? { 'requirements/story.json': JSON.stringify({ id: 'US-4', title: SENTINEL, persona: '', capability: '', benefit: '', criteria: [], scopeExclusions: [], notes: '' }) }
            : {},
      }),
    );
  if (/^\/submissions\/sub-[a-z]+\/teacher-feedback$/.test(path)) return Promise.resolve(answer(200, []));
  if (path.includes('analytics')) return Promise.resolve(answer(200, null));
  return Promise.resolve(answer(200, []));
}

let host: HTMLDivElement;
let root: Root;
let ProjectProvider: (typeof import('@/lib/useProject'))['ProjectProvider'];


beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  nav.search = '';
  calls.length = 0;
  server.resolved = null;
  server.catalogue = [CLASS_PROJECT, KEPT];
  vi.stubGlobal('fetch', vi.fn(serve));
  vi.resetModules();
  const session = await import('@/lib/session');
  session.setAuthSession('learner-token', learner);
  ({ ProjectProvider } = await import('@/lib/useProject'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = async (Page: () => ReactNode) => {
  await act(async () => {
    root.render(
      <ProjectProvider>
        <Page />
      </ProjectProvider>,
    );
  });
  await settle(12);
};

const hrefs = () => [...host.querySelectorAll('a')].map((link) => link.getAttribute('href'));

/** Settles until `ready` holds, for pages whose reads run in batches; bounded, so a miss is a failure and not a hang. */
const until = async (ready: () => boolean) => {
  for (let round = 0; round < 60 && !ready(); round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('the record of a project set aside for the class’s', () => {
  it('tells the truth on the dossier before the class’s project is started, and links the kept one', async () => {
    const Dossier = (await import('@/app/(app)/dossier/page')).default;
    await mount(Dossier);

    expect(host.textContent).not.toContain('No project started');
    expect(host.textContent).not.toContain('Start your project to collect your submitted evidence');
    const kept = host.querySelector('[data-testid="kept-projects"]');
    expect(kept).not.toBeNull();
    expect(kept!.textContent).toContain('TaskTrackr');
    expect(hrefs()).toContain('/dossier?project=tasktrackr');
    expect(hrefs()).toContain('/completion?project=tasktrackr');
  });

  it('opens the kept project’s printable evidence by name, and never makes it the shell’s project', async () => {
    nav.search = 'project=tasktrackr';
    const Dossier = (await import('@/app/(app)/dossier/page')).default;
    await mount(Dossier);
    await until(() => Boolean(host.textContent?.includes(SENTINEL)));

    expect(host.textContent).toContain(SENTINEL);
    expect(host.querySelector('[data-testid="kept-project-notice"]')?.textContent).toContain('TaskTrackr');
    expect(calls.some((call) => call.path === '/enrollments/mine?project=tasktrackr')).toBe(true);
    expect(calls.some((call) => call.path === '/phases/summaries?project=tasktrackr')).toBe(true);
    // Read, not started: nothing written, and the shell still resolves by asking.
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    const { getActiveProject } = await import('@/lib/project');
    expect(getActiveProject()).not.toBe('tasktrackr');
  });

  it('opens the kept project’s completion record and its export', async () => {
    nav.search = 'project=tasktrackr';
    const Completion = (await import('@/app/(app)/completion/page')).default;
    await mount(Completion);

    expect(host.textContent).toContain('You saw it all the way through.');
    expect(host.textContent).toContain('Export project record');
    expect(host.querySelector('[data-testid="kept-project-notice"]')?.textContent).toContain('TaskTrackr');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('puts a door to the kept record beside the sentence that promises it', async () => {
    const Dashboard = (await import('@/app/(app)/dashboard/page')).default;
    await mount(Dashboard);

    expect(host.querySelector('[data-testid="set-aside-notice"]')?.textContent).toContain('stays in your record');
    const door = host.querySelector<HTMLAnchorElement>('[data-testid="set-aside-record"]');
    expect(door?.getAttribute('href')).toBe('/dossier?project=tasktrackr');
    expect(door?.textContent).toContain('TaskTrackr');
  });

  it('lists the kept project on the portfolio of a learner working the class’s project', async () => {
    server.resolved = startedOnClassProject();
    const Portfolio = (await import('@/app/(app)/artefacts/page')).default;
    await mount(Portfolio);
    await until(() => Boolean(host.querySelector('[data-testid="kept-projects"]')));

    expect(host.querySelector('[data-testid="kept-projects"]')?.textContent).toContain('TaskTrackr');
    expect(host.querySelector('[data-testid="kept-projects"]')?.textContent).not.toContain('Field Notes');
    expect(hrefs()).toContain('/dossier?project=tasktrackr');
  });

  /**
   * The portfolio and the Start card open the kept record, and so must
   * /progress: the learner's review history, the page the portfolio's own
   * "Review history" button leads to. Once the learner starts the class's
   * project the Start card is gone, so without a door here the page that
   * calls itself "Your learning record" would have no way to the record they
   * were told they keep.
   */
  it('lists the kept project on the review history of a learner working the class’s project', async () => {
    server.resolved = startedOnClassProject();
    const Progress = (await import('@/app/(app)/progress/page')).default;
    await mount(Progress);
    await until(() => Boolean(host.querySelector('[data-testid="kept-projects"]')));

    const kept = host.querySelector('[data-testid="kept-projects"]');
    expect(kept?.textContent).toContain('TaskTrackr');
    expect(kept?.textContent).not.toContain('Field Notes');
    expect(kept?.querySelector('a[href="/dossier?project=tasktrackr"]')).not.toBeNull();
    expect(kept?.querySelector('a[href="/completion?project=tasktrackr"]')).not.toBeNull();
    // A door, not a start: the page wrote nothing and the shell is still the class's.
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    const { getActiveProject } = await import('@/lib/project');
    expect(getActiveProject()).not.toBe('tasktrackr');
  });

  it('keeps the door on /progress before the class’s project is started, on the Start card, and once only', async () => {
    const Progress = (await import('@/app/(app)/progress/page')).default;
    await mount(Progress);
    await until(() => Boolean(host.querySelector('[data-testid="set-aside-record"]')));

    expect(host.querySelector('[data-testid="set-aside-notice"]')?.textContent).toContain('stays in your record');
    expect(host.querySelector('[data-testid="set-aside-record"]')?.getAttribute('href')).toBe('/dossier?project=tasktrackr');
    // The Start card already carries the door, so the page does not draw it twice.
    expect(host.querySelector('[data-testid="kept-projects"]')).toBeNull();
  });

  it('draws no kept projects on /progress for a learner who holds only the project they are on', async () => {
    server.catalogue = [CLASS_PROJECT];
    server.resolved = startedOnClassProject();
    const Progress = (await import('@/app/(app)/progress/page')).default;
    await mount(Progress);
    await until(() => Boolean(host.textContent?.includes('Submission history')));

    expect(host.textContent).toContain('Submission history');
    expect(host.querySelector('[data-testid="kept-projects"]')).toBeNull();
    expect(hrefs().some((href) => href?.includes('?project='))).toBe(false);
  });

  it('reads a slug that is not one of the learner’s other projects as no name at all', async () => {
    nav.search = 'project=someone-elses';
    const Dossier = (await import('@/app/(app)/dossier/page')).default;
    await mount(Dossier);

    expect(calls.some((call) => call.path.includes('someone-elses'))).toBe(false);
  });
});

describe('keptProjects', () => {
  it('lists a learner’s projects after the one they are on, and nothing for staff', async () => {
    const { keptProjects } = await import('@/lib/record-project');
    const catalogue = [CLASS_PROJECT, KEPT];
    expect(keptProjects(catalogue, '', 'LEARNER').map((one) => one.slug)).toEqual(['tasktrackr']);
    expect(keptProjects(catalogue, 'field-notes', 'LEARNER').map((one) => one.slug)).toEqual(['tasktrackr']);
    expect(keptProjects([CLASS_PROJECT], 'field-notes', 'LEARNER')).toEqual([]);
    expect(keptProjects(catalogue, '', 'INSTRUCTOR')).toEqual([]);
    expect(keptProjects(undefined, '', 'LEARNER')).toEqual([]);
  });
});
