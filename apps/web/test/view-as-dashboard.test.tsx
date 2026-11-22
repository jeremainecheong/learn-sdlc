// @vitest-environment jsdom
/**
 * A teacher pressing View as lands on the LEARNER's dashboard.
 *
 * Each read must go to a door that answers for the learner. Otherwise the
 * teacher gets a dashboard that greets them by their own name, shows an
 * "insufficient role" card with Retry reviews, and draws no project tiles:
 * the shell's batch of phase summaries sent to the view-as phase route is read
 * as a phase id "summaries" and answered 500; the review history sent to the
 * learner-only route is refused 403; and the map is the teacher's own for
 * that slug.
 *
 * The real page, inside the real project provider and session, with `fetch`
 * the only seam. The server here answers exactly as the API does for an
 * instructor: the twins answer the learner's data, and the learner-only routes
 * refuse.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseKey, ProjectMeta, UserProfile } from '@learnsdlc/shared';
import { stubMatchMedia } from './support/dom';

const routed = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() },
  path: '/dashboard',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routed.router,
  usePathname: () => routed.path,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];
const LEARNER_ID = '4132affa-f218-452c-a422-891fa401a0e0';

const teacher: UserProfile = {
  id: 'teacher-one',
  email: 'teacher-one@example.invalid',
  displayName: 'Dana Teacher',
  role: 'INSTRUCTOR',
  cohort: null,
  profileVersion: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
} as unknown as UserProfile;

const meta: ProjectMeta = {
  slug: 'room-desk',
  title: 'RoomDesk — book a meeting room',
  tagline: '',
  description: '',
  language: 'python',
  phaseTitles: KEYS.map((key, i) => ({ key, order: i + 1, title: TITLES[i] })),
  hasWarmup: false,
} as ProjectMeta;

const summary = (i: number) => ({
  id: `learner-phase-${KEYS[i]}`,
  key: KEYS[i],
  order: i + 1,
  title: TITLES[i],
  status: i < 2 ? 'passed' : i === 2 ? 'in_progress' : 'locked',
  bestScore: i < 2 ? 90 : null,
  attempts: i < 3 ? 1 : 0,
  reflection: null,
  passedAt: i < 2 ? '2026-09-28T01:00:00.000Z' : null,
  opensAt: null,
  dueAt: null,
});

/** The learner's board, as `GET /instructor/learners/:id/enrollment` answers it. */
const board = (): EnrollmentView =>
  ({
    id: 'learner-enrolment',
    projectSlug: 'room-desk',
    projectTitle: meta.title,
    currentPhaseOrder: 3,
    completed: false,
    startedAt: '2026-09-28T00:00:00.000Z',
    completedAt: null,
    phases: KEYS.map((_, i) => summary(i)),
  }) as unknown as EnrollmentView;

const detail = (i: number) => ({
  ...summary(i),
  view: 'summary',
  projectSlug: 'room-desk',
  intro: '',
  taskPanel: '',
  objectives: [],
  artifactKind: 'story',
  files: [],
  rubric: { passThreshold: 70, criteria: [] },
  tasks: [],
  canRun: false,
  runLabel: 'Run tests',
  lastSubmission: null,
  updatedAt: null,
});

const history = {
  items: [0, 1].map((i) => ({
    id: `submission-${i}`,
    phaseStateId: `learner-phase-${KEYS[i]}`,
    status: 'completed',
    passed: true,
    verifiedPass: true,
    createdAt: '2026-09-28T01:00:00.000Z',
    commitMessage: null,
  })),
  nextCursor: null,
  total: 2,
};

const answer = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;

const calls: string[] = [];

/** What the API answers an INSTRUCTOR's token with, route by route. */
function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = String(url).replace(/^.*\/api\/v1/, '');
  const method = String(init?.method ?? 'GET').toUpperCase();
  calls.push(`${method} ${path}`);
  const scoped = `/instructor/learners/${LEARNER_ID}`;
  if (method !== 'GET') return Promise.resolve(answer(500, { message: 'no write is expected' }));
  if (path === '/projects') return Promise.resolve(answer(200, [meta]));
  if (path === '/auth/me') return Promise.resolve(answer(200, teacher));
  if (path.startsWith('/notifications')) return Promise.resolve(answer(200, []));
  if (path.startsWith(`${scoped}/enrollment`)) return Promise.resolve(answer(200, board()));
  if (path.startsWith(`${scoped}/analytics`)) return Promise.resolve(answer(200, null));
  if (path.startsWith(`${scoped}/phases/summaries`)) return Promise.resolve(answer(200, [0, 1, 2].map(detail)));
  if (path.startsWith(`${scoped}/projects/room-desk/map`)) return Promise.resolve(answer(200, { nodes: [], edges: [] }));
  if (path.startsWith(`/submissions/learner-history/${LEARNER_ID}`)) return Promise.resolve(answer(200, history));
  // The learner-only routes refuse an instructor, the phase twin reads a word
  // as a phase id, and the teacher's own board is not the learner's.
  if (path.startsWith('/submissions/review-history')) return Promise.resolve(answer(403, { message: 'insufficient role' }));
  if (path.startsWith(`${scoped}/phases/`)) return Promise.resolve(answer(500, { message: 'invalid input syntax for type uuid' }));
  if (path.startsWith('/enrollments/mine') || path.startsWith('/phases/') || path.startsWith('/projects/'))
    return Promise.resolve(answer(200, null));
  return Promise.resolve(answer(200, []));
}

let host: HTMLDivElement;
let root: Root;

const settle = async () => {
  for (let round = 0; round < 14; round += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(serve));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  vi.resetModules();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('View as lands on the learner’s dashboard', () => {
  it('greets the learner, draws their project, shows no role error, and writes nothing', async () => {
    const session = await import('@/lib/session');
    session.setAuthSession('teacher-token', teacher);
    const viewAs = await import('@/lib/view-as');
    viewAs.startViewAs({ userId: LEARNER_ID, displayName: 'Lee Learner', email: 'lee@example.invalid', cohort: 'class-one' });
    const { ProjectProvider } = await import('@/lib/useProject');
    const Dashboard = (await import('@/app/(app)/dashboard/page')).default;

    await act(async () => {
      root.render(
        <ProjectProvider>
          <Dashboard />
        </ProjectProvider>,
      );
    });
    await settle();

    const text = host.textContent ?? '';
    // Their name, not the teacher's.
    expect(host.querySelector('h1')?.textContent).toBe('Welcome, Lee.');
    expect(text).not.toContain('Welcome, Dana');
    // No refusal reached the page.
    expect(text).not.toMatch(/insufficient role/i);
    expect(text).not.toContain('Retry reviews');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    // Their project and their phase.
    expect(host.querySelector('[data-testid="dashboard-project"]')?.textContent).toContain('RoomDesk');
    expect(text).toContain('Implementation');

    // Every read went to a door that answers for the learner…
    expect(calls).toContain(`GET /instructor/learners/${LEARNER_ID}/phases/summaries?project=room-desk`);
    expect(calls.some((call) => call.startsWith(`GET /submissions/learner-history/${LEARNER_ID}?project=room-desk`))).toBe(true);
    expect(calls.some((call) => call.startsWith(`GET /instructor/learners/${LEARNER_ID}/projects/room-desk/map`))).toBe(true);
    // …none to a learner-only route or the teacher's own board…
    expect(calls.filter((call) => /^GET \/(phases|enrollments|projects\/room-desk|submissions\/review-history)/.test(call))).toEqual([]);
    // …and nothing was written.
    expect(calls.filter((call) => !call.startsWith('GET '))).toEqual([]);
    viewAs.stopViewAs();
  });
});
