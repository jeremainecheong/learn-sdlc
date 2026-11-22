// @vitest-environment jsdom
/**
 * The teacher's roster for a learner whose class works another project.
 *
 * A learner who started the default on their own and whose class then works a
 * teacher's project has the default row set aside so they can start the
 * class's. The row stays theirs, whole and pinned. `learnerDetail` puts
 * the project the learner is working first once they have started it, and
 * marks a set-aside row `setAside`, so:
 *
 *  - a learner who has started the class's project is drawn on it: its phase,
 *    its passes, its checklist row, and the dossier the console prints;
 *  - a learner who has not started it yet is drawn as not started, and the
 *    roster says it is the class's project they have not started: it does not
 *    draw the set-aside project as if it were the class's work, put its
 *    submissions in the review queue, or name it in the roll call.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstructorEnrollmentView,
  InstructorLearnerDetail,
  InstructorLearnerRow,
  InstructorPhaseView,
  PhaseKey,
} from '@learnsdlc/shared';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  overview: vi.fn(),
  learner: vi.fn(),
  audit: vi.fn(),
  history: vi.fn(),
  notes: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn() },
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
    useRouter: () => mocks.router,
  };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR' }),
}));
vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: mocks.mine },
  formatJoinCode: (value: string) => value,
}));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    overview: mocks.overview,
    learner: mocks.learner,
    // The portal's class read, answered through the per-learner stand-in so
    // every case reads the same learner details either way.
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))),
    audit: mocks.audit,
  },
}));
vi.mock('@/lib/api-experience', () => ({
  experienceApi: { teacherFeedback: mocks.notes, teacherSubmissions: mocks.history },
}));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/staff/ClassProjectCard', () => ({ ClassProjectCard: () => null }));
vi.mock('@/components/staff/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/components/staff/LearnerTasks', () => ({ LearnerTasks: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

/* ---------------------------- contract fixtures --------------------------- */

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];

/** A board `passed` phases in, with the current phase's newest revision where one is given. */
function board(
  slug: string,
  title: string,
  passed: number,
  submitted?: { id: string; createdAt: string },
): InstructorEnrollmentView {
  const phases = KEYS.map(
    (key, i) =>
      ({
        id: `${slug}-${key}`,
        key,
        order: i + 1,
        title: TITLES[i],
        status: i < passed ? 'passed' : i === passed ? 'in_progress' : 'locked',
        bestScore: null,
        attempts: i === passed && submitted ? 1 : 0,
        reflection: null,
        passedAt: null,
        opensAt: null,
        dueAt: null,
        hints: 0,
        relianceIndex: 0,
        passThreshold: 70,
        unlockedAt: null,
        lastSubmission:
          i === passed && submitted
            ? {
                id: submitted.id,
                phaseStateId: `${slug}-${key}`,
                status: 'completed',
                passed: false,
                score: 40,
                createdAt: submitted.createdAt,
                report: {},
              }
            : null,
      }) as unknown as InstructorPhaseView,
  );
  return {
    id: `enrolment-${slug}`,
    projectSlug: slug,
    projectTitle: title,
    currentPhaseOrder: passed + 1,
    completed: false,
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    phases,
  };
}

const CLASS_TITLE = 'Library Desk — a teacher’s project';
const KEPT_TITLE = 'TaskTrackr — the default project';

const learner = (
  userId: string,
  displayName: string,
  enrollments: InstructorEnrollmentView[],
): InstructorLearnerDetail =>
  ({
    userId,
    displayName,
    email: `${userId}@example.test`,
    cohort: 'class-one',
    cohortName: 'Example class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments,
  }) as InstructorLearnerDetail;

/** Ada started the class's project; her default row is set aside, and listed after it. */
const ADA = learner('ada', 'Ada Example', [
  board('library-desk', CLASS_TITLE, 1, { id: 'ada-class-review', createdAt: '2026-09-20T00:00:00.000Z' }),
  { ...board('tasktrackr', KEPT_TITLE, 4, { id: 'ada-kept-review', createdAt: '2026-09-25T00:00:00.000Z' }), setAside: true },
]);

/** Bo joined late and has not started the class's project: one row, set aside. */
const BO = learner('bo', 'Bo Example', [
  { ...board('tasktrackr', KEPT_TITLE, 3, { id: 'bo-kept-review', createdAt: '2026-09-26T00:00:00.000Z' }), setAside: true },
]);

const row = (userId: string, projectSlug: string, checklistPercent: number): InstructorLearnerRow =>
  ({
    userId,
    displayName: userId,
    email: `${userId}@example.test`,
    cohort: 'class-one',
    cohortName: 'Example class',
    projectSlug,
    progressPercent: 0,
    phasesPassed: 0,
    averageScore: null,
    totalHints: 0,
    relianceIndex: 0,
    tokensToday: 0,
    completed: false,
    integrityFlag: false,
    difficultyTier: 'standard',
    checklistPercent,
    masteryPercent: null,
  }) as InstructorLearnerRow;

/** The overview answers one row per enrolment, so both of each learner's rows are here. */
const ROWS = [
  row('ada', 'library-desk', 25),
  row('ada', 'tasktrackr', 90),
  row('bo', 'tasktrackr', 75),
];

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const must = (id: string) => {
  const found = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};
/** The table view's row for one learner, as its cells' text. */
const cells = (name: string) => {
  const tr = [...host.querySelectorAll('.exp-table tbody tr')].find(
    (item) => item.querySelector('strong')?.textContent === name,
  );
  if (!tr) throw new Error(`no roster row for ${name}`);
  return [...tr.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
};

const open = async (search: string) => {
  mocks.overview.mockResolvedValue({ learners: ROWS });
  const byId = new Map([ADA, BO].map((one) => [one.userId, one]));
  mocks.learner.mockImplementation(async (id: string) => byId.get(id));
  window.history.replaceState(null, '', `/teacher/class?class=class-one${search}`);
  await act(async () => root.render(<TeacherPortal classView />));
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  const replace = window.history.replaceState.bind(window.history);
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    replace(...args);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
    push(...args);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  mocks.mine.mockResolvedValue([{ id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 2 }]);
  mocks.history.mockResolvedValue([]);
  mocks.notes.mockResolvedValue([]);
  mocks.audit.mockResolvedValue([]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

/* ---------------------------------- tests --------------------------------- */

describe('a learner whose class works another project, on the teacher’s roster', () => {
  it('draws a learner who has started the class’s project on it', async () => {
    await open('&view=table');

    const [, className, phase, passed, checklist] = cells('Ada Example');
    expect(className).toBe('Example class');
    // Library Desk is one phase in; the set-aside board is four in.
    expect(phase).toBe('Design');
    expect(passed).toBe('1 / 6');
    // The class project's row of the two the overview answers for her.
    expect(checklist).toBe('25%');
    expect(host.querySelector('[data-testid="set-aside-ada"]')).toBeNull();
  });

  it('draws a learner who has not started it as not started, and says it is the class’s project', async () => {
    await open('&view=table');

    const [identity, , phase, passed, checklist] = cells('Bo Example');
    expect(phase).toBe('Not started');
    expect(passed).toBe('0 / 6');
    // Not the set-aside row's number: that checklist is another project's.
    expect(checklist).toBe('—');
    expect(must('set-aside-bo').textContent).toBe('Has not started the class’s project yet');
    expect(identity).toContain('Has not started the class’s project yet');
  });

  it('keeps the set-aside project out of the roll call, the counts and the review queue', async () => {
    await open('');

    // The roll call names the class's project only.
    expect(host.textContent).toContain(CLASS_TITLE);
    expect(host.textContent).not.toContain('TaskTrackr');
    // Ada is enrolled on it; Bo has not started it.
    const metric = [...host.querySelectorAll('.exp-teacher-metrics section')].find((section) =>
      section.textContent?.includes('Enrolled learners'),
    );
    expect(metric?.querySelector('strong')?.textContent).toBe('1');
    expect(host.textContent).toContain('1 have not started the project.');
    // Only the class project's revision waits for review; the newer ones on
    // the set-aside boards are that project's, not this class's work.
    expect(mocks.notes.mock.calls.map((call) => call[0])).toEqual(['ada-class-review']);
    // The map draws Bo's six phases as not started, not as the old board.
    const boRow = [...host.querySelectorAll('.exp-table tbody tr')].find(
      (item) => item.querySelector('strong')?.textContent === 'Bo Example',
    )!;
    expect(boRow.querySelectorAll('.exp-cell-button')).toHaveLength(0);
    expect(boRow.textContent).toContain('Has not started the class’s project yet');
  });

  it('prints the dossier of the project the console is showing, not the learner’s oldest', async () => {
    await open('&evidence=ada&phase=library-desk-design');

    const print = [...host.querySelectorAll('a')].find((node) => node.textContent?.includes('Print submitted evidence'));
    expect(print).toBeDefined();
    const target = new URL(print!.href);
    expect(target.pathname).toBe('/instructor/learners/ada/dossier');
    expect(target.searchParams.get('project')).toBe('library-desk');
    expect(target.searchParams.get('returnTo')).toBe(window.location.pathname + window.location.search);
  });
});
