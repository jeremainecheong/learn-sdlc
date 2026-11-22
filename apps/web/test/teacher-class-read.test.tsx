// @vitest-environment jsdom
/**
 * The teacher portal reads a class in one request (browser proof:
 * e2e/management.spec.ts).
 *
 * The teacher home and a class's own page (one component, TeacherPortal) must
 * not read every learner in view with one GET /instructor/learners/:userId
 * each: that route allows 60 a minute per account, so a teacher of one class
 * of 30 would have the third view in a minute refused. The portal reads the
 * class through the class-scoped read (`instructorApi.learnersIn`,
 * one request per 50 learners; `class-learners-client.test.ts`), and asks the
 * per-learner route for nobody on load. The harness is
 * `teacher-portal-percentages.test.tsx`'s.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  learnersIn: vi.fn(),
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
    learnersIn: mocks.learnersIn,
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

const THIRTY = Array.from({ length: 30 }, (_, n) => `learner-${String(n + 1).padStart(2, '0')}`);

const load = async (classView: boolean) => {
  mocks.overview.mockResolvedValue({ learners: THIRTY.map((userId) => classRow({ userId, displayName: userId })) });
  const byId = new Map(THIRTY.map((id) => [id, detail(id, id, 'payroll')]));
  mocks.learner.mockImplementation(async (id: string) => byId.get(id));
  mocks.learnersIn.mockImplementation(async (ids: string[]) => ids.map((id) => byId.get(id)));
  window.history.replaceState(null, '', classView ? '/teacher/class?class=class-one' : '/teacher');
  await act(async () => root.render(<TeacherPortal classView={classView} />));
};

describe('a class of 30, on load', () => {
  it("reads the class's own page in one class read, and no learner one at a time", async () => {
    await load(true);
    expect(mocks.learner).not.toHaveBeenCalled();
    expect(mocks.learnersIn).toHaveBeenCalledTimes(1);
    expect(mocks.learnersIn.mock.calls[0].slice(0, 2)).toEqual([THIRTY, 'class-one']);
    expect(host.textContent).toContain('30 associated learners');
  });

  it('lets the class read stop between pages once this load is superseded', async () => {
    await load(true);
    const stillWanted = mocks.learnersIn.mock.calls[0][2] as (() => boolean) | undefined;
    expect(typeof stillWanted).toBe('function');
    expect(stillWanted!()).toBe(true);
    act(() => root.unmount());
    expect(stillWanted!()).toBe(false);
    root = createRoot(host);
  });

  it('reads the home through the same class read, over the whole scope', async () => {
    await load(false);
    expect(mocks.learner).not.toHaveBeenCalled();
    expect(mocks.learnersIn).toHaveBeenCalledTimes(1);
    expect(mocks.learnersIn.mock.calls[0][0]).toEqual(THIRTY);
    expect(mocks.learnersIn.mock.calls[0][1]).toBeUndefined();
  });
});
