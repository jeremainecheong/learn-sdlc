// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleText } from './support/source-text';
import { ALL_PROJECTS, getConsoleProject, instructorApi, setConsoleProject } from '@/lib/api-instructor';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';

/**
 * The console names no project the teacher did not choose.
 *
 * `getConsoleProject` must not answer the shipped slug for anyone who has not
 * chosen one: the portal passes that slug to the overview, to the
 * help-request list and to its own enrolment lookup, and would print the
 * shipped pack's title over the roll call. Every instructor read takes the
 * project as optional and answers over the caller's own learners without it,
 * so a default slug is only a guess at the answer, and the wrong one for a
 * teacher whose classes are on another project.
 *
 * The fixture slugs are deliberately not the shipped pack's, for the reason
 * `useProject.test.ts` gives in its own words: a test written against
 * "tasktrackr" would pass just as happily against a hard-coded default.
 */

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  notes: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  /** Every project the portal has handed the help-request list, render by render. */
  stuckProjects: [] as Array<string | undefined>,
  /** The transport under `lib/api-instructor`, so a path can be read whole. */
  request: vi.fn(),
}));
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(),
  request: mocks.request,
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(''), useRouter: () => mocks.router }));
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR' }) }));
vi.mock('@/lib/api-cohorts', () => ({ cohortsApi: { mine: mocks.mine }, formatJoinCode: (code: string) => code }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherFeedback: mocks.notes } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: ({ project }: { project?: string }) => { mocks.stuckProjects.push(project); return null; } }));
vi.mock('@/components/experience/ScrollRegion', () => ({ ScrollRegion: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const CONSOLE_KEY = 'lsdlc_instructor_project';

describe('the project the console is looking at', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    // The window stub goes back first: nothing after it can read storage.
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('names no project until the console has chosen one, so the server resolves it', () => {
    expect(getConsoleProject()).toBe('');
  });

  it('names no project where there is no browser to remember one', () => {
    // The server render, where no stored preference can be read.
    vi.stubGlobal('window', undefined);
    expect(getConsoleProject()).toBe('');
  });

  it('names no project when the preference cannot be read', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    expect(getConsoleProject()).toBe('');
  });

  it('still answers the project the console stored', () => {
    // A regression guard: the preference is the one answer that is a choice.
    setConsoleProject('ledger');
    expect(window.localStorage.getItem(CONSOLE_KEY)).toBe('ledger');
    expect(getConsoleProject()).toBe('ledger');
    setConsoleProject(ALL_PROJECTS);
    expect(getConsoleProject()).toBe(ALL_PROJECTS);
  });
});

/**
 * Regression guards over the one console read whose refusal sentence turns on
 * whether a project was named. `learnerDossier` looks the enrolment up by slug
 * when it is given one and takes the learner's oldest when it is not
 * (`instructor.service.ts:1080-1093`), and refuses in two different sentences:
 * "this learner has not started that project" against a slug, "…has not
 * started a project" without one. The console names none until it is pointed
 * at one, so the second is the sentence a teacher reads for a learner who has
 * started nothing: deliberate, since the first named a project the teacher
 * never chose, and pinned here so the next change to either branch is visible.
 */
describe('the dossier the console asks for', () => {
  /** The rule the dossier page applies to the console's choice
   * (`app/(app)/instructor/learners/[userId]/dossier/page.tsx:42-45`). */
  const consoleChoice = () => {
    const chosen = getConsoleProject();
    return chosen && chosen !== ALL_PROJECTS ? chosen : undefined;
  };
  const pathAsked = () => mocks.request.mock.calls.at(-1)?.[1];

  beforeEach(() => {
    window.localStorage.clear();
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({});
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('names no project while the console has not been pointed at one', async () => {
    await instructorApi.learnerDossier('learner-1', consoleChoice());

    expect(pathAsked()).toBe('/instructor/learners/learner-1/dossier');
  });

  it('names no project while the console is looking at all of them', async () => {
    setConsoleProject(ALL_PROJECTS);
    await instructorApi.learnerDossier('learner-1', consoleChoice());

    expect(pathAsked()).toBe('/instructor/learners/learner-1/dossier');
  });

  it('names the project the console was pointed at', async () => {
    setConsoleProject('ledger');
    await instructorApi.learnerDossier('learner-1', consoleChoice());

    expect(pathAsked()).toBe('/instructor/learners/learner-1/dossier?project=ledger');
  });
});

/**
 * The override client is the only way the
 * browser reaches `POST …/override`, and three of that route's seven actions
 * are about ONE task of a phase: `task-signoff`, `task-reset`, `task-reopen`.
 * `PhaseOverrideDto.taskKey` carries which one
 * (`apps/api/src/instructor/instructor.dto.ts:61`), the controller passes it
 * (`instructor.controller.ts:100`) and the service refuses a key the pinned
 * version does not declare with the loader's own 404, so a client that drops
 * the field resolves the empty key and turns every per-task lever into
 * "unknown task: " (`instructor.service.ts:1028-1035`,
 * `feedback.service.ts:532-534`).
 *
 * The four phase levers name no task and their body must not gain a field, on
 * a shipped sole-task board or anywhere else.
 */
describe('the override the console sends', () => {
  const bodySent = () => mocks.request.mock.calls.at(-1)?.[2];
  const pathSent = () => mocks.request.mock.calls.at(-1)?.[1];

  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({});
  });

  it('sends the four phase levers the body they send today', async () => {
    await instructorApi.override('learner-1', 'phase-1', 'pass', 'passed in the review');

    expect(pathSent()).toBe('/instructor/learners/learner-1/phases/phase-1/override');
    // Strict: not even `taskKey: undefined`, so a phase lever over a shipped
    // project posts exactly the phase-lever body.
    expect(bodySent()).toStrictEqual({ action: 'pass', reason: 'passed in the review' });
  });

  it('names the task a per-task lever is about, or the service answers 404 for the empty key', async () => {
    await instructorApi.override('learner-1', 'phase-1', 'task-signoff', 'countersigned in class', 'story');

    expect(bodySent()).toStrictEqual({
      action: 'task-signoff',
      reason: 'countersigned in class',
      taskKey: 'story',
    });
  });
});

describe('the teacher portal reads the projects its learners are in', () => {
  const phase = (id: string) => ({
    id,
    key: 'requirements',
    title: 'Requirements',
    order: 1,
    status: 'in_progress',
    attempts: 1,
    lastSubmission: null,
  });
  const learnerOn = (id: string, slug: string, title: string) => ({
    userId: id,
    displayName: id,
    email: `${id}@example.test`,
    cohort: 'class',
    cohortName: 'Test class',
    createdAt: '2026-09-01T00:00:00Z',
    tokensToday: 0,
    enrollments: [
      {
        id: `enrolment-${id}`,
        projectSlug: slug,
        projectTitle: title,
        currentPhaseOrder: 1,
        completed: false,
        startedAt: '2026-09-01T00:00:00Z',
        completedAt: null,
        phases: [phase(`phase-${id}`)],
      },
    ],
  });
  /** Both console reads the portal makes, spied on the real module so that
   * `getConsoleProject` above is the shipped one rather than a mock. */
  const consoleReads = () => ({
    overview: vi.spyOn(instructorApi, 'overview'),
    learner: vi.spyOn(instructorApi, 'learner'),
    // The portal's class read, answered through the per-learner spy so every
    // case reads the same learner details either way.
    learnersIn: vi
      .spyOn(instructorApi, 'learnersIn')
      .mockImplementation(async (ids) => Promise.all(ids.map((id) => instructorApi.learner(id)))),
  });
  let host: HTMLDivElement, root: Root;
  let overview: ReturnType<typeof consoleReads>['overview'];
  let learner: ReturnType<typeof consoleReads>['learner'];

  async function renderPortal(roster: Array<ReturnType<typeof learnerOn>>): Promise<void> {
    overview.mockResolvedValue({ learners: roster.map(row => ({ userId: row.userId, cohort: row.cohort })) } as never);
    learner.mockImplementation(async id => roster.find(row => row.userId === id) as never);
    await act(async () => root.render(<TeacherPortal />));
  }
  const metric = (label: string) =>
    [...host.querySelectorAll('.exp-teacher-metrics .exp-panel')]
      .find(panel => panel.querySelector('span')?.textContent === label)
      ?.querySelector('strong')?.textContent;
  const rollCall = () =>
    [...host.querySelectorAll('.exp-section-heading')]
      .find(heading => heading.querySelector('h2')?.textContent?.includes('Where the work is happening'))
      ?.querySelector('p')?.textContent;

  beforeEach(() => {
    mocks.stuckProjects.length = 0;
    mocks.mine.mockResolvedValue([{ id: 'class', name: 'Test class', joinCode: 'TEST12', memberCount: 2 }]);
    mocks.notes.mockResolvedValue([]);
    ({ overview, learner } = consoleReads());
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('asks for the overview across the caller’s own projects and counts the enrolments it answers', async () => {
    await renderPortal([learnerOn('First learner', 'ledger', 'Ledger'), learnerOn('Second learner', 'ledger', 'Ledger')]);

    // No slug at all: AnalyticsService.instructorOverview answers one row per
    // enrolment for every learner in the caller's scope when given none.
    expect(overview.mock.calls).toEqual([[]]);
    expect(metric('Enrolled learners')).toBe('2');
    expect(host.textContent).not.toContain('0 associated learners');
  });

  it('names the projects its learners are in rather than the project the deployment ships', async () => {
    await renderPortal([learnerOn('First learner', 'ledger', 'Ledger'), learnerOn('Second learner', 'ledger', 'Ledger')]);

    expect(rollCall()).toBe('2 associated learners / Ledger');
  });

  it('names every project a teacher’s two classes are on, once each', async () => {
    await renderPortal([learnerOn('First learner', 'ledger', 'Ledger'), learnerOn('Second learner', 'atlas', 'Atlas')]);

    expect(rollCall()).toBe('2 associated learners / Ledger, Atlas');
    expect(metric('Enrolled learners')).toBe('2');
  });

  it('names no project where no learner in view is in one', async () => {
    // Someone who joined the class and started nothing is on the roll call by
    // design (`analytics.service.ts:392-397`). The roll call counts them and
    // names no project, because the class is in none; the shipped pack's
    // title must not be printed here whatever the class is doing.
    const idle = (id: string) => ({ ...learnerOn(id, 'ledger', 'Ledger'), enrollments: [] });
    await renderPortal([idle('First learner'), idle('Second learner')]);

    expect(rollCall()).toBe('2 associated learners');
  });

  it('counts a class with nobody in it without naming a project', async () => {
    await renderPortal([]);

    expect(rollCall()).toBe('0 associated learners');
  });

  it('asks for the help requests of its own learners without narrowing them to a project', async () => {
    await renderPortal([learnerOn('First learner', 'ledger', 'Ledger')]);

    // The stuck list is scoped by the caller's own learners on the server and
    // by `learnerIds` in the browser; the slug was only ever a view filter.
    expect(mocks.stuckProjects.length).toBeGreaterThan(0);
    expect([...new Set(mocks.stuckProjects)]).toEqual([undefined]);
  });
});

/**
 * A scan of the two console files for the shipped project's slug and title.
 * `useProject.test.ts` permits these paths rather than requiring them, so
 * this is the check that they hold neither.
 */
describe('no console module names a project', () => {
  it('holds no quoted project slug and no DEFAULT_PROJECT in the console client', () => {
    const client = moduleText('instructorApi');
    expect(client).not.toMatch(/(['"`])tasktrackr\1/);
    expect(client).not.toMatch(/DEFAULT_PROJECT/);
  });

  it('holds no project name at all in the portal', () => {
    // Not only the slug: the roll call must not print the shipped pack's title.
    // Read across the portal and the model module its roster logic is split
    // into. The portal's import tree cannot be read: lib/project-name.ts and
    // other shared modules name the shipped pack on purpose.
    const portal = moduleText('TeacherPortal') + moduleText('components/staff/console/teacher-portal-model.ts');
    expect(portal).not.toMatch(/tasktrackr/i);
    expect(portal).not.toMatch(/DEFAULT_PROJECT/);
  });
});
