// @vitest-environment jsdom
/**
 * The teacher's own route, with the per-task view connected.
 *
 * `/instructor/learners/[userId]` redirects to `/teacher?learner=…`, so the
 * page a teacher actually opens a learner on is `TeacherPortal` and its
 * evidence panel. That panel is where the three per-task levers are called,
 * `InstructorPhaseView.tasks` is read, and `AuditList`'s per-task sentences
 * are drawn; without it no page would reach any of them.
 *
 * What is asserted here is the connection, not the panel's own behaviour:
 * `teacher-task-levers.test.tsx` owns that:
 *
 *  - a split phase draws its tasks inside the evidence the teacher opened;
 *  - a phase with the synthesised sole task draws no task rows;
 *  - the record of changes is on screen, with `task.signoff`, `task.reopen`
 *    and `task.reset` read back as sentences;
 *  - a lever's answer redraws the phase where the teacher is looking, without
 *    re-reading the whole class.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuditEventView,
  InstructorLearnerDetail,
  InstructorPhaseView,
  InstructorTaskView,
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
  SubmissionEvidence: ({ submissionId }: { submissionId: string }) => (
    <section data-testid="selected-evidence">{submissionId}</section>
  ),
}));

/* ---------------------------- contract fixtures --------------------------- */

const revision = {
  id: 'review-one',
  taskKey: 'story',
  status: 'completed' as const,
  score: 82,
  passed: true,
  report: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  attempt: 2,
};

const taskRow = (over: Partial<InstructorTaskView>): InstructorTaskView => ({
  key: 'story',
  order: 1,
  required: true,
  title: 'Write the user story',
  status: 'passed',
  bestScore: 82,
  attempts: 2,
  passedAt: '2026-09-12T00:00:00.000Z',
  awaitingSignOff: false,
  signedOffAt: null,
  lastSubmission: revision,
  ...over,
});

const SPLIT_TASKS: InstructorTaskView[] = [
  taskRow({}),
  taskRow({
    key: 'criteria',
    order: 2,
    title: 'Write the acceptance criteria',
    status: 'in_progress',
    bestScore: 40,
    attempts: 1,
    passedAt: null,
    lastSubmission: { ...revision, id: 'review-two', taskKey: 'criteria', score: 40, passed: false },
  }),
];

const phaseOn = (tasks: InstructorTaskView[] | undefined): InstructorPhaseView =>
  ({
    id: 'phase-one',
    key: 'requirements',
    title: 'Requirements',
    order: 1,
    status: 'in_progress',
    bestScore: 82,
    attempts: 3,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    hints: 1,
    relianceIndex: 0.2,
    passThreshold: 70,
    unlockedAt: '2026-09-10T00:00:00.000Z',
    lastSubmission: revision,
    tasks,
  }) as InstructorPhaseView;

const learnerOn = (tasks: InstructorTaskView[] | undefined): InstructorLearnerDetail =>
  ({
    userId: 'learner-one',
    displayName: 'Ada Example',
    email: 'ada@example.test',
    cohort: 'class-one',
    cohortName: 'Example class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'enrolment-one',
        projectSlug: 'payroll',
        projectTitle: 'Payroll',
        currentPhaseOrder: 1,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases: [phaseOn(tasks)],
      },
    ],
  }) as InstructorLearnerDetail;

const auditRow = (over: Partial<AuditEventView>): AuditEventView => ({
  id: 'audit-one',
  event: 'task.signoff',
  actorUserId: 'teacher',
  actorName: 'Teacher A',
  subjectUserId: 'learner-one',
  subjectName: 'Ada Example',
  targetId: 'phase-one',
  action: 'task-signoff',
  reason: 'Countersigned after reading it with them.',
  detail: { phaseKey: 'requirements', taskKey: 'story', taskTitle: 'Write the user story' },
  createdAt: '2026-09-18T09:00:00.000Z',
  ...over,
});

const TRAIL: AuditEventView[] = [
  auditRow({}),
  auditRow({ id: 'audit-two', event: 'task.reopen', action: 'task-reopen' }),
  auditRow({ id: 'audit-three', event: 'task.reset', action: 'task-reset' }),
];

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const must = <T extends HTMLElement>(id: string) => {
  const found = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};

const openEvidence = async (tasks: InstructorTaskView[] | undefined) => {
  mocks.learner.mockResolvedValue(learnerOn(tasks));
  window.history.replaceState(
    null,
    '',
    '/teacher/class?class=class-one&evidence=learner-one&phase=phase-one&submission=review-one',
  );
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
    { id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 },
  ]);
  mocks.overview.mockResolvedValue({ learners: [{ userId: 'learner-one', cohort: 'class-one' }] });
  // The whole phase's history, every task included: `teacherSubmissions` pages
  // the phase and `submission-feedback.service.ts` scopes that read to the
  // phase across every taskKey. A revision the panel can open is therefore
  // always a revision the history holds.
  mocks.history.mockResolvedValue([
    { id: 'review-one', status: 'completed', passed: true, createdAt: '2026-09-12T00:00:00.000Z', attempt: 2 },
    { id: 'review-two', status: 'completed', passed: false, createdAt: '2026-09-13T00:00:00.000Z', attempt: 1 },
  ]);
  mocks.notes.mockResolvedValue([]);
  mocks.audit.mockResolvedValue(TRAIL);
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

describe('the evidence a teacher opens on a split phase', () => {
  it('draws the phase’s tasks, each with its own state and levers', async () => {
    await openEvidence(SPLIT_TASKS);

    expect(q('learner-tasks')).not.toBeNull();
    expect(must('learner-task-story').textContent).toContain('Write the user story');
    expect(must('learner-task-criteria').textContent).toContain('Write the acceptance criteria');
    for (const id of ['task-signoff-criteria', 'task-reopen-story', 'task-reset-story'])
      expect(q(id)).not.toBeNull();
  });

  it('opens a task’s own newest revision in the evidence beside it', async () => {
    await openEvidence(SPLIT_TASKS);
    expect(q('selected-evidence')?.textContent).toBe('review-one');

    await act(async () => must<HTMLButtonElement>('task-submission-criteria').click());

    expect(new URLSearchParams(window.location.search).get('submission')).toBe('review-two');
    // And the evidence panel beside it actually moved. Asserting the query
    // parameter alone would pass while the panel showed "This review is not in
    // the selected phase", which is the whole of what the case is named for.
    expect(q('selected-evidence')?.textContent).toBe('review-two');
    expect(host.textContent).not.toContain('This review is not in the selected phase');
  });
});

describe('a phase holding one authored task, which is every unsplit teacher project', () => {
  it('draws the panel and all three levers on the route a teacher opens', async () => {
    // `soleTaskList` is `length === 1 && key === ''`, so a phase keyed `main`
    // (what a copied project's phases all hold until somebody splits one)
    // takes all three levers at the route. A length test would hide them there.
    await openEvidence([taskRow({ key: 'main', title: 'Requirements', status: 'in_progress', passedAt: null })]);

    expect(q('learner-tasks')).not.toBeNull();
    expect(must('learner-task-main').textContent).toContain('Requirements');
    for (const id of ['task-signoff-main', 'task-reopen-main', 'task-reset-main'])
      expect(q(id)).not.toBeNull();
  });
});

describe('a phase whose task list is the synthesised sole one', () => {
  it('draws exactly what it drew before, with no task panel and no task levers', async () => {
    await openEvidence([taskRow({ key: '', title: 'Requirements' })]);

    expect(q('learner-tasks')).toBeNull();
    expect(host.textContent).not.toContain('Tasks in Requirements');
    // The evidence panel itself is unaffected: the history and the record it
    // selected are both still there.
    expect(q('selected-evidence')?.textContent).toBe('review-one');
    expect(host.textContent).toContain('Submission history');
  });

  it('draws no task panel for a phase written before tasks existed', async () => {
    await openEvidence(undefined);

    expect(q('learner-tasks')).toBeNull();
    expect(q('selected-evidence')?.textContent).toBe('review-one');
  });
});

describe('the record of changes, on the page a teacher opens a learner on', () => {
  it('reads the three per-task levers back as sentences', async () => {
    await openEvidence(SPLIT_TASKS);

    expect(mocks.audit).toHaveBeenCalledWith('learner-one', expect.any(Number));
    const trail = must('audit-list').textContent ?? '';
    expect(trail).toContain('Signed off Write the user story in Requirements');
    expect(trail).toContain('Reopened Write the user story');
    expect(trail).toContain('Reset Write the user story');
    expect(trail).not.toContain('task.signoff');
  });

  it('says so rather than showing an empty trail when the record cannot be read', async () => {
    mocks.audit.mockRejectedValue(new Error('unreachable'));
    await openEvidence(SPLIT_TASKS);

    expect(q('audit-list')).toBeNull();
    expect(host.textContent).toContain('The record of changes could not be read.');
  });
});

describe('a lever pressed from the portal', () => {
  it('redraws the phase the override answered, and reads the record again', async () => {
    mocks.override.mockResolvedValue(
      phaseOn([SPLIT_TASKS[0], { ...SPLIT_TASKS[1], status: 'passed', bestScore: 70, passedAt: '2026-09-19T00:00:00.000Z' }]),
    );
    await openEvidence(SPLIT_TASKS);
    const reads = mocks.learner.mock.calls.length;

    await act(async () => must<HTMLButtonElement>('task-signoff-criteria').click());
    await act(async () => {
      fireEvent.change(must<HTMLTextAreaElement>('task-lever-reason-criteria'), {
        target: { value: 'Countersigned after reading it with them in class.' },
      });
    });
    await act(async () => must<HTMLButtonElement>('task-lever-do-criteria').click());

    expect(mocks.override).toHaveBeenCalledWith(
      'learner-one',
      'phase-one',
      'task-signoff',
      'Countersigned after reading it with them in class.',
      'criteria',
    );
    // Its reviewed pass, countersigned, reads "Review passed".
    expect(must('learner-task-criteria').textContent).toContain('Review passed');
    // The class is not re-read: the override answered with the phase.
    expect(mocks.learner.mock.calls.length).toBe(reads);
    expect(mocks.audit.mock.calls.length).toBeGreaterThan(1);
  });
});
