// @vitest-environment jsdom
/**
 * The two overview numbers on the teacher's roster.
 *
 * The sponsor asked for *"an overview of the checklist as one intuitive
 * percentage"*. The gradebook CSV is where a teacher takes it away; this table
 * is where they read it without downloading anything.
 *
 * What is asserted here is the connection and the two rules that go with it:
 *
 *  - the columns are drawn from `InstructorLearnerRow`, which is the only
 *    payload that carries them: the per-learner detail read the rest of this
 *    table is built from does not ask the question;
 *  - a learner the API has no number for draws a dash and never `0%`, which is
 *    the same distinction the CSV makes between a blank and a zero;
 *  - the row is matched by learner **and project**, because the overview
 *    answers one row per enrolment and this table draws the learner's oldest;
 *  - the roster sorts by either column, highest first, with the learners who
 *    have no number last.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstructorLearnerDetail,
  InstructorLearnerRow,
} from '@learnsdlc/shared';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  overview: vi.fn(),
  learner: vi.fn(),
  audit: vi.fn(),
  override: vi.fn(),
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
vi.mock('@/lib/session', async original => ({
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
    // The portal reads the class in one call; it answers here through the
    // per-learner stand-in, so every case reads the same learner details.
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))),
    audit: mocks.audit,
    override: mocks.override,
  },
}));
vi.mock('@/lib/api-experience', () => ({
  experienceApi: { teacherFeedback: mocks.notes, teacherSubmissions: mocks.history },
}));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: () => null,
}));

/* ---------------------------- contract fixtures --------------------------- */

const detail = (
  userId: string,
  displayName: string,
  projectSlug: string | null,
): InstructorLearnerDetail =>
  ({
    userId,
    displayName,
    email: `${userId}@example.test`,
    cohort: 'class-one',
    cohortName: 'Example class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: projectSlug
      ? [
          {
            id: `enrolment-${userId}`,
            projectSlug,
            projectTitle: 'Payroll',
            currentPhaseOrder: 1,
            completed: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            completedAt: null,
            phases: [],
          },
        ]
      : [],
  }) as InstructorLearnerDetail;

const classRow = (over: Partial<InstructorLearnerRow>): InstructorLearnerRow =>
  ({
    userId: 'ada',
    displayName: 'Ada Example',
    email: 'ada@example.test',
    cohort: 'class-one',
    cohortName: 'Example class',
    projectSlug: 'payroll',
    progressPercent: 0,
    phasesPassed: 0,
    averageScore: null,
    totalHints: 0,
    relianceIndex: 0,
    tokensToday: 0,
    completed: false,
    integrityFlag: false,
    difficultyTier: 'standard',
    ...over,
  }) as InstructorLearnerRow;

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const must = <T extends HTMLElement>(id: string) => {
  const found = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};
const names = () =>
  [...host.querySelectorAll('.exp-table tbody tr')].map(
    row => row.querySelector('strong')?.textContent,
  );
const headers = () =>
  [...host.querySelectorAll('.exp-table thead th')].map(cell => cell.textContent);

/** The roster, in table view, over these class rows and these learners. */
const openRoster = async (
  rows: InstructorLearnerRow[],
  details: InstructorLearnerDetail[],
  search = '',
) => {
  mocks.overview.mockResolvedValue({ learners: rows });
  const byId = new Map(details.map(one => [one.userId, one]));
  mocks.learner.mockImplementation(async (id: string) => byId.get(id));
  window.history.replaceState(null, '', `/teacher/class?class=class-one&view=table${search}`);
  await act(async () => root.render(<TeacherPortal classView />));
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
  mocks.mine.mockResolvedValue([
    { id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 3 },
  ]);
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

describe('the roster’s two percentage columns', () => {
  it('draws both beside the phases a learner has passed', async () => {
    await openRoster(
      [classRow({ checklistPercent: 67, masteryPercent: 80 })],
      [detail('ada', 'Ada Example', 'payroll')],
    );

    expect(headers()).toEqual([
      'Learner',
      'Class',
      'Current phase',
      'Phases passed',
      'Checklist',
      'Quiz mastery',
      'Latest submission',
    ]);
    expect(must('checklist-ada').textContent).toBe('67%');
    expect(must('mastery-ada').textContent).toBe('80%');
  });

  it('draws a dash and never a zero for a learner the numbers are missing for', async () => {
    // Three ways the field is absent, and none of them is a failure: a version
    // this build cannot read, a learner who has started nothing, and an older
    // API that does not send the field.
    await openRoster(
      [classRow({ checklistPercent: 40, masteryPercent: null }), classRow({ userId: 'bo', projectSlug: null })],
      [detail('ada', 'Ada Example', 'payroll'), detail('bo', 'Bo Example', null)],
    );

    expect(must('mastery-ada').textContent).toBe('—');
    expect(must('mastery-ada').textContent).not.toContain('0');
    expect(must('checklist-bo').textContent).toBe('—');
    expect(must('mastery-bo').textContent).toBe('—');
    // and the number that IS there is still drawn
    expect(must('checklist-ada').textContent).toBe('40%');
  });

  it('draws a real zero as a zero, which is the other half of the same rule', async () => {
    // A learner who has passed none of the required work has a checklist of
    // nought, and that is a fact rather than a blank. Only an absent field is
    // a dash.
    await openRoster(
      [classRow({ checklistPercent: 0, masteryPercent: 0 })],
      [detail('ada', 'Ada Example', 'payroll')],
    );

    expect(must('checklist-ada').textContent).toBe('0%');
    expect(must('mastery-ada').textContent).toBe('0%');
  });

  it('reads the row for the enrolment on screen, not the first row with that learner’s id', async () => {
    // The overview answers one row per enrolment. This table draws the
    // learner's **oldest** enrolment, so a learner in three projects must not
    // be shown another project's checklist. The row on screen sits in the
    // middle deliberately: keying on the learner's id alone answers the first
    // row or the last one depending on how the lookup is built, and both are
    // wrong.
    await openRoster(
      [
        classRow({ projectSlug: 'inventory', checklistPercent: 12, masteryPercent: 20 }),
        classRow({ projectSlug: 'payroll', checklistPercent: 83, masteryPercent: 91 }),
        classRow({ projectSlug: 'archive', checklistPercent: 5, masteryPercent: 7 }),
      ],
      [detail('ada', 'Ada Example', 'payroll')],
    );

    expect(must('checklist-ada').textContent).toBe('83%');
    expect(must('mastery-ada').textContent).toBe('91%');
  });

  it('draws the phase map with no checklist percentage on it', async () => {
    mocks.overview.mockResolvedValue({ learners: [classRow({ checklistPercent: 67 })] });
    mocks.learner.mockResolvedValue(detail('ada', 'Ada Example', 'payroll'));
    window.history.replaceState(null, '', '/teacher/class?class=class-one');
    await act(async () => root.render(<TeacherPortal classView />));

    // Six phase columns and the learner, with no percentage column and no sort
    // control: the two numbers belong to the roster, and the map is a picture
    // of the six gates.
    expect(headers()).toHaveLength(7);
    expect(headers()).not.toContain('Checklist');
    expect(host.textContent).not.toContain('Sort by');
  });
});

describe('sorting the roster by either number', () => {
  const THREE = [
    classRow({ userId: 'ada', displayName: 'Ada Example', checklistPercent: 40, masteryPercent: 90 }),
    classRow({ userId: 'bo', displayName: 'Bo Example', checklistPercent: 80, masteryPercent: 50 }),
    classRow({ userId: 'cy', displayName: 'Cy Example' }),
  ];
  const DETAILS = [
    detail('ada', 'Ada Example', 'payroll'),
    detail('bo', 'Bo Example', 'payroll'),
    detail('cy', 'Cy Example', 'payroll'),
  ];

  it('is ordered by name until a teacher asks for something else', async () => {
    await openRoster(THREE, DETAILS);
    expect(names()).toEqual(['Ada Example', 'Bo Example', 'Cy Example']);
  });

  it('sorts by the checklist, highest first, with the learners who have no number last', async () => {
    await openRoster(THREE, DETAILS, '&sort=checklist');
    expect(names()).toEqual(['Bo Example', 'Ada Example', 'Cy Example']);
    expect(
      [...host.querySelectorAll('.exp-table thead th')]
        .find(cell => cell.textContent === 'Checklist')
        ?.getAttribute('aria-sort'),
    ).toBe('descending');
  });

  it('sorts by quiz mastery on the same rule, and the select is what says so', async () => {
    await openRoster(THREE, DETAILS);
    const control = [...host.querySelectorAll<HTMLSelectElement>('select')].find(select =>
      [...select.options].some(option => option.value === 'mastery'),
    )!;
    await act(async () => {
      fireEvent.change(control, { target: { value: 'mastery' } });
    });

    expect(names()).toEqual(['Ada Example', 'Bo Example', 'Cy Example']);
    expect(new URLSearchParams(window.location.search).get('sort')).toBe('mastery');
    expect(
      [...host.querySelectorAll('.exp-table thead th')]
        .find(cell => cell.textContent === 'Quiz mastery')
        ?.getAttribute('aria-sort'),
    ).toBe('descending');
  });
});
