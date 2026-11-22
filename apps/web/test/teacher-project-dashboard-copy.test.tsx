// @vitest-environment jsdom
/**
 * A class on a teacher's project, and the copy the web itself writes.
 *
 * A learner on RoomDesk, a teacher's copy of TaskTrackr, must not be steered
 * back to TaskTrackr from outside the task list: the dashboard's hero must not
 * say "write US-4: an overdue report" or "Your first step: Write the
 * overdue-report story" (an optional task on RoomDesk), the Requirements
 * tutorial must not say "Ask Dana about the overdue report", the brief asides
 * must not read "REQUIREMENTS / TASKTRACKR: The missing morning report", the
 * case file's kicker must not read "TASKTRACKR / REQUIREMENTS", the room's
 * door must not say "Meet Dana", and /progress and /artefacts must not be
 * headed "TaskTrackr / …". All of that copy is written into the web, not read
 * from the project. Content the project inherits (a phase's intro, the
 * interview persona) is the project's own and is not asserted here.
 *
 * The real pages, inside the real project provider and session, with `fetch`
 * the only seam. The chrome is drawn as its children. A TaskTrackr learner is
 * asserted beside the RoomDesk cases: the web names no project of its own
 * (`useProject.test.ts`), so the kickers and eyebrows read the learner's
 * project from their enrolment (TaskTrackr's still say TASKTRACKR) and the
 * words about TaskTrackr's story are absent for everyone rather than switched
 * on a slug the web may not hold.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseKey, PhaseTaskView, ProjectMeta, UserProfile } from '@learnsdlc/shared';
import { stubMatchMedia } from './support/dom';

const routed = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() },
  path: '/dashboard',
  phaseId: 'phase-requirements',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routed.router,
  usePathname: () => routed.path,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ phaseId: routed.phaseId }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
// The frame around a document page, drawn as its children: what is asserted is
// what the page and its case file write, not the shell's rail.
vi.mock('@/components/shell', async (original) => ({
  ...(await original<typeof import('@/components/shell')>()),
  DocPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  WorkPage: ({ children, strip }: { children: ReactNode; strip?: ReactNode }) => (
    <main>
      {strip}
      {children}
    </main>
  ),
  PhaseStrip: () => null,
}));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];

const learner: UserProfile = {
  id: 'learner-one',
  email: 'learner-one@example.invalid',
  displayName: 'Lee Learner',
  role: 'LEARNER',
  cohort: 'class-one',
  profileVersion: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
};

type Project = { slug: string; title: string };
const ROOMDESK: Project = { slug: 'room-desk', title: 'RoomDesk — book a meeting room' };
const TASKTRACKR: Project = { slug: 'tasktrackr', title: 'TaskTrackr — a task manager you can run' };

const server = { project: ROOMDESK, calls: [] as string[] };

const meta = (p: Project): ProjectMeta =>
  ({
    slug: p.slug,
    title: p.title,
    tagline: '',
    description: '',
    language: 'python',
    phaseTitles: KEYS.map((key, i) => ({ key, order: i + 1, title: TITLES[i] })),
    hasWarmup: false,
  }) as ProjectMeta;

const summary = (i: number) => ({
  id: `phase-${KEYS[i]}`,
  key: KEYS[i],
  order: i + 1,
  title: TITLES[i],
  status: i === 0 ? 'in_progress' : 'locked',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
});

const board = (): EnrollmentView =>
  ({
    id: `enrolment-${server.project.slug}`,
    projectSlug: server.project.slug,
    projectTitle: server.project.title,
    currentPhaseOrder: 1,
    completed: false,
    startedAt: '2026-09-28T00:00:00.000Z',
    completedAt: null,
    phases: KEYS.map((_, i) => summary(i)),
  }) as unknown as EnrollmentView;

/** RoomDesk's Requirements: the inherited story made optional, the teacher's own required. */
const tasks = (): PhaseTaskView[] =>
  server.project === ROOMDESK
    ? ([
        { key: 'main', order: 1, required: false, title: 'Requirements', artefactType: 'user-story', status: 'in_progress', attempts: 0, bestScore: null },
        { key: 'booking-story', order: 2, required: true, title: 'Write the room-booking story', artefactType: 'user-story', status: 'in_progress', attempts: 0, bestScore: null },
      ] as PhaseTaskView[])
    : ([{ key: '', order: 1, required: true, title: 'Requirements', artefactType: 'user-story', status: 'in_progress', attempts: 0, bestScore: null }] as PhaseTaskView[]);

const requirementsSummary = () => ({
  ...summary(0),
  view: 'summary',
  projectSlug: server.project.slug,
  intro: 'The phase intro, which is the project’s own content.',
  taskPanel: '',
  objectives: ['Write the story.'],
  artifactKind: 'story',
  files: [],
  rubric: { passThreshold: 70, criteria: [{ key: 'c1', title: 'A checkable criterion', description: '', weight: 1 }] },
  tasks: tasks(),
  canRun: false,
  runLabel: 'Run tests',
  lastSubmission: null,
  updatedAt: null,
});

const answer = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: { get: () => null } }) as unknown as Response;

function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = String(url).replace(/^.*\/api\/v1/, '');
  const method = String(init?.method ?? 'GET').toUpperCase();
  server.calls.push(`${method} ${path}`);
  if (method === 'GET' && path === '/projects') return Promise.resolve(answer(200, [meta(server.project)]));
  if (method === 'GET' && path.startsWith('/enrollments/mine')) return Promise.resolve(answer(200, board()));
  if (method === 'GET' && path.startsWith('/phases/summaries')) return Promise.resolve(answer(200, [requirementsSummary()]));
  if (method === 'GET' && path.startsWith('/phases/phase-requirements')) return Promise.resolve(answer(200, requirementsSummary()));
  if (method === 'GET' && path.includes('/review-history/pages')) return Promise.resolve(answer(200, { items: [], nextCursor: null, total: 0 }));
  return Promise.resolve(answer(200, path.includes('analytics') || path.includes('/map') ? null : []));
}

let host: HTMLDivElement;
let root: Root;
let ProjectProvider: (typeof import('@/lib/useProject'))['ProjectProvider'];

const settle = async () => {
  for (let round = 0; round < 12; round += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mount = async (page: ReactNode) => {
  await act(async () => {
    root.render(<ProjectProvider>{page}</ProjectProvider>);
  });
  await settle();
};

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  routed.router.push.mockReset();
  server.project = ROOMDESK;
  server.calls = [];
  vi.stubGlobal('fetch', vi.fn(serve));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
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

const text = () => host.textContent ?? '';

/* ------------------------------- the dashboard ---------------------------- */

describe('the dashboard of a learner on a teacher’s project', () => {
  it('names no TaskTrackr story, and points at the task the phase actually needs next', async () => {
    const Dashboard = (await import('@/app/(app)/dashboard/page')).default;
    await mount(<Dashboard />);

    expect(host.querySelector('[data-testid="dashboard-project"]')?.textContent).toContain('RoomDesk');
    expect(text()).not.toContain('US-4');
    expect(text()).not.toMatch(/overdue/i);
    expect(text()).not.toContain('TaskTrackr');
    // "Your first step" is the first required task still open, by its title.
    const step = host.querySelector('.exp-resume-foot strong')?.textContent;
    expect(step).toBe('Write the room-booking story');
  });

  it('tells a TaskTrackr learner the same true sentence, under their own project’s name', async () => {
    server.project = TASKTRACKR;
    const Dashboard = (await import('@/app/(app)/dashboard/page')).default;
    await mount(<Dashboard />);

    expect(host.querySelector('[data-testid="dashboard-project"]')?.textContent).toContain('TaskTrackr');
    expect(text()).toContain('Interview your stakeholder, then write a user story with acceptance criteria a test could check.');
    // One task, so no list to name it from: the phase's own step.
    expect(host.querySelector('.exp-resume-foot strong')?.textContent).toBe('Write your user story');
  });
});

/* ---------------------------- the record pages ---------------------------- */

describe('the record pages name the learner’s project', () => {
  it('heads /progress with RoomDesk, not TaskTrackr', async () => {
    routed.path = '/progress';
    const Progress = (await import('@/app/(app)/progress/page')).default;
    await mount(<Progress />);
    expect(host.querySelector('.exp-hero .exp-eyebrow')?.textContent).toBe('RoomDesk / Your learning record');
    expect(text()).not.toContain('TaskTrackr');
  });

  it('heads /artefacts with RoomDesk, not TaskTrackr', async () => {
    routed.path = '/artefacts';
    const Artefacts = (await import('@/app/(app)/artefacts/page')).default;
    await mount(<Artefacts />);
    expect(host.querySelector('.exp-hero .exp-eyebrow')?.textContent).toBe('RoomDesk / The evidence of each phase');
  });

  it('still says TaskTrackr on TaskTrackr', async () => {
    server.project = TASKTRACKR;
    routed.path = '/progress';
    const Progress = (await import('@/app/(app)/progress/page')).default;
    await mount(<Progress />);
    expect(host.querySelector('.exp-hero .exp-eyebrow')?.textContent).toBe('TaskTrackr / Your learning record');
  });
});

/* ------------------- the brief: kickers, asides, the door ------------------ */

describe('the Requirements brief of a teacher’s project', () => {
  it('names RoomDesk in the case file and the aside, and opens the interview without naming Dana', async () => {
    routed.path = '/workspace/phase-requirements/brief';
    const BriefPage = (await import('@/app/(app)/workspace/[phaseId]/brief/page')).default;
    await mount(<BriefPage />);

    expect(host.querySelector('[data-testid="brief"]')).not.toBeNull();
    expect(host.querySelector('.phase-case-kicker')?.textContent).toBe('ROOMDESK / REQUIREMENTS');
    expect(host.querySelector('.phase-brief-intro small')?.textContent).toBe('REQUIREMENTS / ROOMDESK');
    expect(text()).not.toContain('TASKTRACKR');
    expect(text()).not.toContain('The missing morning report');
    expect(text()).not.toMatch(/overdue report/i);
    const door = [...host.querySelectorAll('.phase-room-nav a')].find((a) => a.getAttribute('href')?.endsWith('/interview'));
    expect(door?.textContent).toBe('Stakeholder interview');
    expect(text()).not.toContain('Meet Dana');
  });

  it('still names TaskTrackr on TaskTrackr, read from the enrolment', async () => {
    server.project = TASKTRACKR;
    routed.path = '/workspace/phase-requirements/brief';
    const BriefPage = (await import('@/app/(app)/workspace/[phaseId]/brief/page')).default;
    await mount(<BriefPage />);

    expect(host.querySelector('.phase-case-kicker')?.textContent).toBe('TASKTRACKR / REQUIREMENTS');
    expect(host.querySelector('.phase-brief-intro small')?.textContent).toBe('REQUIREMENTS / TASKTRACKR');
    const door = [...host.querySelectorAll('.phase-room-nav a')].find((a) => a.getAttribute('href')?.endsWith('/interview'));
    expect(door?.textContent).toBe('Stakeholder interview');
  });
});

/* ------------------------ the Requirements tutorial ------------------------ */

describe('the Requirements tutorial of a teacher’s project', () => {
  it('asks the stakeholder, not Dana, and writes the learner’s story, not US-4', async () => {
    const { phaseTutorialMarks, marksFor } = await import('@/components/shell/tours');
    const tour = phaseTutorialMarks('requirements').map((mark) => `${mark.title} ${mark.body}`).join(' ');
    expect(tour).not.toContain('Dana');
    expect(tour).not.toContain('US-4');
    expect(tour).not.toMatch(/overdue/i);
    expect(phaseTutorialMarks('requirements')[0].body).toContain('Ask the stakeholder what they need');
    for (const page of ['issue', 'ide'] as const) {
      const marks = marksFor(page).map((mark) => `${mark.title} ${mark.body}`).join(' ');
      expect(marks).not.toContain('US-4');
      expect(marks).not.toMatch(/overdue/i);
    }
  });

  it('is drawn with those words in the tour a RoomDesk learner is shown', async () => {
    const realRect = Element.prototype.getBoundingClientRect;
    const realShow = HTMLDialogElement.prototype.showModal;
    const realClose = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    Element.prototype.getBoundingClientRect = () =>
      ({ top: 20, left: 20, right: 220, bottom: 60, width: 200, height: 40, x: 20, y: 20, toJSON() {} }) as DOMRect;
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    try {
      const { CoachMarks } = await import('@/components/shell/CoachMarks');
      await mount(
        <>
          <button id="requirements-interview-tab">Stakeholder interview</button>
          <CoachMarks phaseTutorial={{ ownerId: 'learner-one', phaseId: 'phase-requirements', phaseKey: 'requirements', ready: true }} />
        </>,
      );
      const coach = host.querySelector('[data-testid="coach"]');
      expect(coach).not.toBeNull();
      expect(coach!.textContent).toContain('Ask the stakeholder');
      expect(coach!.textContent).not.toContain('Dana');
    } finally {
      await act(async () => root.render(null));
      Element.prototype.getBoundingClientRect = realRect;
      HTMLDialogElement.prototype.showModal = realShow;
      HTMLDialogElement.prototype.close = realClose;
    }
  });
});
