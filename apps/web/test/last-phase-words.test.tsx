// @vitest-environment jsdom
/**
 * The project's last phase does not speak of a "next phase".
 *
 * On the last phase of the learner's project (`isLastPhase` over the
 * enrolment's own phase list, so a subset ending in Testing counts) no phase
 * follows: a Pass there, once every required task has passed, lets the
 * learner press "Complete the project", which runs `advance()` and marks the
 * enrolment complete (workflow.service.ts). Every surface that says "the next
 * phase opens" or "Continue to the next phase" elsewhere says there that the
 * project can be completed; every phase with one after it keeps its words.
 *
 * Surfaces: the Review card's Pass line (passedLine, single and split), the
 * feedback page's split hero (splitOpenLine), the IDE room's grading note, the
 * ready band (PhaseGateBanner), the brief's closing line (PhaseBriefIntro),
 * the printed record's credit lines (Dossier), and the teacher's sign-off
 * question (LearnerTasks), which says the phase passes (not "<Phase> opens"
 * of a phase already open), on every phase.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, InstructorPhaseView, InstructorTaskView, LearnerDossier, PhaseDetail, PhaseSummary, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import type { PhaseRecords } from '@/lib/records';
import { report, submission } from './fixtures';
import { stubMatchMedia } from './support/dom';

const rig = vi.hoisted(() => ({
  phaseId: 'last-room',
  token: 'owner-a',
  project: null as unknown,
  reviews: [] as unknown[],
  pr: { phase: {} as Record<string, unknown>, head: null as Record<string, unknown> | null },
  load: vi.fn(),
  save: vi.fn(),
  exit: vi.fn(),
  submit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: rig.phaseId }),
  useRouter: () => rig.router,
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code?: string, public body?: unknown) {
      super(message);
    }
  }
  return {
    ApiError,
    API_URL: '/api',
    api: { saveWorkspace: rig.save, submit: rig.submit, myEnrollment: vi.fn(async () => null), chat: vi.fn(), reflect: vi.fn(), advance: vi.fn() },
    getToken: () => rig.token,
    onSessionLeaving: () => () => {},
    signInHref: () => null,
    request: vi.fn(),
  };
});
vi.mock('@/lib/session', () => ({
  getSession: () => ({ id: rig.token }),
  useSession: () => ({ id: rig.token, role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
  onSessionEnd: () => () => {},
  ownedByToken: (clear: () => void) => {
    let held = '';
    return () => {
      if (held !== rig.token) {
        clear();
        held = rig.token;
      }
    };
  },
}));
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load },
  saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: () => null,
  rememberVersionedWorkspaceDraft: () => {},
  acknowledgeVersionedWorkspaceSave: () => {},
  discardVersionedWorkspaceDraft: () => {},
}));
vi.mock('@/lib/useProject', () => ({
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
  fullDetail: () => null,
  invalidateProject: vi.fn(),
  learnerMessage: (_err: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({ reviews: rig.reviews, hasLoaded: true, loading: false, refreshing: false, refreshError: '', error: '', refresh: () => {} }),
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }),
  stopPreviewOnExit: vi.fn(),
}));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }),
  WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
    <div>
      <div>{right}</div>
      {children}
    </div>
  ),
}));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null, PersonaPanel: () => null }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value }: { value: string }) => <textarea aria-label="Code" value={value} readOnly />,
}));
vi.mock('@/components/shell', async () => ({
  ...(await import('@/components/shell/routes')),
  DocPage: () => null,
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => (
    <main>
      {strip}
      {children}
    </main>
  ),
  PhaseStrip: ({ right }: { right: ReactNode }) => <header>{right}</header>,
  StatusBar: () => null,
  ActivityBar: () => null,
  // Every bottom tab's content is drawn, so the Review tab can be read.
  BottomPanel: ({ tabs }: { tabs: { key: string; content: ReactNode }[] }) => (
    <div>
      {tabs.map((tab) => (
        <section key={tab.key} data-testid={`bottom-${tab.key}`}>
          {tab.content}
        </section>
      ))}
    </div>
  ),
  Explorer: () => null,
  PersonaComposer: () => null,
  PersonaFeed: () => null,
  usePersona: () => ({ messages: [], busy: false }),
  PERSONA_NAME: { implementation: 'Ari', maintenance: 'Morgan' },
}));
vi.mock('@/components/pr', async () => {
  const { MergeCard } = await import('@/components/pr/MergeCard');
  return {
    MergeCard,
    Conversation: () => null,
    DiffView: () => null,
    ChecksCard: () => null,
    SubmissionsCard: () => null,
    ChecksTab: () => null,
    HistoryCard: () => null,
    gateReason: () => 'Resolve every failed criterion.',
    prHeadline: () => 'The change is reviewed',
    usePullRequest: () => ({
      detail: rig.pr.phase,
      head: rig.pr.head,
      threads: [],
      diffs: [],
      revisions: rig.pr.head ? [rig.pr.head] : [],
      gate: 0,
      fileRevision: rig.pr.head,
      fileBase: null,
      threadsFor: () => [],
      selectRevision: vi.fn(),
      submit: vi.fn(),
      filesKept: () => true,
      reload: vi.fn(async () => undefined),
      setError: vi.fn(),
      setNotice: vi.fn(),
    }),
  };
});

vi.mock('@/lib/api-instructor', () => ({ instructorApi: { override: vi.fn() } }));

const { passedLine, FeedbackPanel } = await import('@/components/workspace/FeedbackPanel');
const { splitOpenLine } = await import('@/components/workspace/signoff-surfaces-copy');
const { gradingPassLine } = await import('@/components/workspace/onward-copy');
const { PhaseGateBanner } = await import('@/components/workspace/PhaseGateBanner');
const { Dossier } = await import('@/components/dossier/Dossier');
const { buildDossier } = await import('@/components/dossier/build');
const { LearnerTasks } = await import('@/components/staff/LearnerTasks');
const { PhaseBriefIntro } = await vi.importActual<typeof import('@/components/workspace/PhaseBriefIntro')>(
  '@/components/workspace/PhaseBriefIntro',
);
const { default: WorkspacePage } = await import('@/app/(app)/workspace/[phaseId]/page');
const { default: FeedbackPage } = await import('@/app/(app)/feedback/page');

/*
 * The plain Pass card says only that the evidence is accepted, on
 * the last phase and before it; the gate band above the review says how to
 * continue (READY_LAST / READY_NEXT below). Both were "… Continue to the next
 * phase when ready." / "… Complete the project when ready." before.
 */
const ALL_NEXT = 'All required evidence accepted.';
const ALL_LAST = 'All required evidence accepted.';
/** What the card does not say: how to continue, which is the band's. */
const ONWARD = /when ready|next phase|Complete the project/;

type Row = Record<string, unknown>;
const task = (over: Row = {}): PhaseTaskView =>
  ({
    key: 'main', order: 1, required: true, title: 'The change', artefactType: 'code', evidence: 'automated', sealed: true,
    status: 'passed', awaitingSignOff: false, attempts: 1, bestScore: 88, passedAt: '2026-10-02T05:00:00.000Z', lastSubmission: 'rev-1', resetAt: null,
    solution: { available: false, files: 0, readAt: null },
    ...over,
  }) as unknown as PhaseTaskView;
const openTask = (key: string, title: string, order: number) =>
  task({ key, title, order, status: 'in_progress', passedAt: null, attempts: 0 });
const waitingTask = () => task({ evidence: 'signed-off', status: 'submitted', awaitingSignOff: true, passedAt: null });

const summaryRow = (key: string, order: number, status = 'passed'): PhaseSummary =>
  ({ id: `ph-${key}`, key, order, title: key[0].toUpperCase() + key.slice(1), status, bestScore: 88, attempts: 1, reflection: null, passedAt: null, opensAt: null, dueAt: null }) as PhaseSummary;
const SIX = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
/** A subset project whose last phase is Testing. */
const FOUR = ['requirements', 'design', 'implementation', 'testing'];
const enrollmentOf = (keys: string[], current: string, currentId: string, currentStatus = 'passed') => ({
  id: 'e-last', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', currentPhaseOrder: keys.indexOf(current) + 1, completed: false,
  startedAt: '2026-10-01T00:00:00Z', completedAt: null, releases: [],
  phases: keys.map((key, at) => ({ ...summaryRow(key, at + 1, key === current ? currentStatus : at < keys.indexOf(current) ? 'passed' : 'locked'), ...(key === current ? { id: currentId } : {}) })),
});

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.save.mockResolvedValue({ saved: true, version: '2026-10-02T05:00:00.000Z' });
  rig.exit.mockResolvedValue({ version: '2026-10-02T05:00:00.000Z' });
  rig.reviews = [];
  rig.project = null;
  window.history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

/* ------------------------------------------------------------ 1, 2: Review */

describe("the Review card's Pass line (passedLine)", () => {
  it('a phase with one task: the last phase says only that the evidence is accepted (the band says Complete the project)', () => {
    expect(passedLine([task()], 'main', null, true)).toBe(ALL_LAST);
    expect(passedLine(undefined, undefined, null, true)).toBe(ALL_LAST);
    expect(passedLine([task()], 'main', null, true)).not.toMatch(ONWARD);
  });

  it('a phase with one task and a phase after it: the same line, no Continue (the band carries it)', () => {
    expect(passedLine([task()], 'main', null, false)).toBe(ALL_NEXT);
    expect(passedLine([task()], 'main')).toBe(ALL_NEXT);
    expect(passedLine(undefined, undefined)).toBe(ALL_NEXT);
    expect(passedLine(undefined, undefined)).not.toMatch(ONWARD);
  });

  const one = [task(), openTask('b', 'B', 2)];
  const two = [task(), openTask('b', 'B', 2), openTask('c', 'C', 3)];
  const signing = [waitingTask(), openTask('b', 'B', 2)];
  const signingTwo = [waitingTask(), openTask('b', 'B', 2), openTask('c', 'C', 3)];

  it('a split last phase with required tasks still open', () => {
    expect(passedLine(one, 'main', null, true)).toBe(
      "This task's evidence is accepted. One required task in this phase is still open: B. The project can be completed once it passes.",
    );
    expect(passedLine(two, 'main', null, true)).toBe(
      "This task's evidence is accepted. 2 required tasks in this phase are still open: B and C. The project can be completed once they pass.",
    );
    expect(passedLine(signing, 'main', null, true)).toBe(
      "This task passed review and waits for your teacher's countersignature. One required task in this phase is still open: B. The project can be completed once it passes and your teacher has countersigned.",
    );
    expect(passedLine(signingTwo, 'main', null, true)).toBe(
      "This task passed review and waits for your teacher's countersignature. 2 required tasks in this phase are still open: B and C. The project can be completed once they pass and your teacher has countersigned.",
    );
  });

  it('the same split phases with a phase after them say the next phase opens once the rest pass', () => {
    expect(passedLine(one, 'main', null, false)).toBe(
      "This task's evidence is accepted. One required task in this phase is still open: B. The next phase opens once it passes.",
    );
    expect(passedLine(two, 'main')).toBe(
      "This task's evidence is accepted. 2 required tasks in this phase are still open: B and C. The next phase opens once they pass.",
    );
    expect(passedLine(signing, 'main')).toBe(
      "This task passed review and waits for your teacher's countersignature. One required task in this phase is still open: B. The next phase opens once it passes and your teacher has countersigned.",
    );
    expect(passedLine(signingTwo, 'main', null, false)).toBe(
      "This task passed review and waits for your teacher's countersignature. 2 required tasks in this phase are still open: B and C. The next phase opens once they pass and your teacher has countersigned.",
    );
  });

  it('the Review tab draws the last-phase line', () => {
    const passing = submission({
      id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 88, attempt: 1, createdAt: '2026-10-02T05:00:00.000Z',
      report: report({ overall: 88, passed: true, aiReview: { summary: 'Fine.', strengths: [], improvements: [], processNote: '', criteriaEvidence: [] } as unknown as ReturnType<typeof report>['aiReview'] }),
    } as Partial<SubmissionView>);
    act(() => root.render(<FeedbackPanel submission={passing} tasks={[task()]} isLast />));
    expect(byTestId('feedback-verdict')!.textContent).toBe(`Pass${ALL_LAST}`);
    act(() => root.render(<FeedbackPanel submission={passing} tasks={[task()]} />));
    expect(byTestId('feedback-verdict')!.textContent).toBe(`Pass${ALL_NEXT}`);
  });
});

describe("the feedback page's split hero (splitOpenLine)", () => {
  it('the last phase says the project can be completed', () => {
    expect(splitOpenLine('Maintenance', ['Check your understanding'], true, true)).toBe(
      'Still open in Maintenance: Check your understanding. The project can be completed once it passes and your teacher countersigns your work.',
    );
    expect(splitOpenLine('Maintenance', ['A', 'B'], false, true)).toBe(
      'Still open in Maintenance: A and B. The project can be completed once they pass.',
    );
  });

  it('a phase with one after it says the next phase opens once the rest pass', () => {
    expect(splitOpenLine('Requirements', ['Check your understanding'])).toBe(
      'Still open in Requirements: Check your understanding. The next phase opens once it passes and your teacher countersigns your work.',
    );
    expect(splitOpenLine('Requirements', ['Check your understanding'], false, false)).toBe(
      'Still open in Requirements: Check your understanding. The next phase opens once it passes.',
    );
    expect(splitOpenLine('Requirements', ['A', 'B'], true)).toBe(
      'Still open in Requirements: A and B. The next phase opens once they pass and your teacher countersigns your work.',
    );
  });

  const heroLine = async (keys: string[], key: string) => {
    const id = `ph-${key}`;
    const enrollment = enrollmentOf(keys, key, id, 'submitted');
    const phase = enrollment.phases.find((one) => one.key === key)!;
    const tasks = [waitingTask(), openTask('quiz', 'Check your understanding', 2)];
    rig.project = { loading: false, details: { [id]: { ...phase, tasks } }, enrollment };
    rig.reviews = [{ phase, submission: { id: 'rev-1', phaseStateId: id, status: 'completed', passed: true, verifiedPass: true, createdAt: '2026-10-02T05:00:00.000Z', reviewUnavailable: false, attempt: 1 } }];
    await act(async () => {
      root.render(<FeedbackPage />);
    });
    return host.querySelector('.exp-result-main p')!.textContent;
  };

  it('the page, mounted, on Testing as the last of a four-phase subset', async () => {
    expect(await heroLine(FOUR, 'testing')).toBe(
      'Still open in Testing: Check your understanding. The project can be completed once it passes and your teacher countersigns your work.',
    );
  });

  it('the page, mounted, on Testing of six', async () => {
    expect(await heroLine(SIX, 'testing')).toBe(
      'Still open in Testing: Check your understanding. The next phase opens once it passes and your teacher countersigns your work.',
    );
  });
});

/* -------------------------------------------- 3, 6: the IDE room, mounted */

describe("the IDE room's grading note (gradingPassLine)", () => {
  it('the words', () => {
    expect(gradingPassLine(false, true)).toBe('A Pass lets you complete the project. You may save an optional reflection before completing it.');
    expect(gradingPassLine(true, true)).toBe('A Pass records this task. The project can be completed once every required task has passed.');
  });

  it('a phase with one after it says a Pass opens the next phase', () => {
    expect(gradingPassLine(false, false)).toBe('A Pass opens the next phase. You may save an optional reflection before continuing.');
    expect(gradingPassLine(true, false)).toBe('A Pass records this task. The phase opens the next one when every required task has passed.');
  });
});

describe('the IDE room, mounted after a Pass', () => {
  const roomPhase = (key: string, title: string, order: number) => ({
    id: rig.phaseId, key, title, order, status: 'passed', projectSlug: 'tasktrackr', place: order, count: 6,
    workspaceUpdatedAt: '2026-10-02T05:00:00.000Z', files: [{ path: 'api/tasks.py', content: 'code', editable: true, language: 'python' }],
    attempts: 1, bestScore: 88, reflection: null, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
    tasks: [task({ artefactPath: 'api/tasks.py', primaryPath: 'api/tasks.py', files: ['api/tasks.py'] })],
    taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
    lastSubmission: submission({
      id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 88, attempt: 1, createdAt: '2026-10-02T05:00:00.000Z',
      report: report({ overall: 88, passed: true, aiReview: { summary: 'Fine.', strengths: [], improvements: [], processNote: '', criteriaEvidence: [] } as unknown as ReturnType<typeof report>['aiReview'] }),
    } as Partial<SubmissionView>),
    solution: { available: false, files: 0, readAt: null },
  });
  const openRoom = async (keys: string[], key: string, title: string) => {
    rig.phaseId = `onward-room-${key}-${keys.length}`;
    const detail = roomPhase(key, title, keys.indexOf(key) + 1);
    rig.project = { details: {}, enrollment: enrollmentOf(keys, key, rig.phaseId), analytics: null, currentPhase: null, loading: false, reload: vi.fn() };
    rig.load.mockImplementation(async () => detail);
    window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => (byTestId('gate-view-review') as HTMLButtonElement).click());
  };
  const READY_LAST = 'Ready to continue. Phase evidence accepted. Complete the project when ready; a reflection is optional.';
  const READY_NEXT = 'Ready to continue. Phase evidence accepted. Continue when ready; a reflection is optional.';

  for (const [keys, key, title, label] of [
    [SIX, 'maintenance', 'Maintenance', 'Maintenance, the last of six'],
    [FOUR, 'testing', 'Testing', 'Testing, the last of a four-phase subset'],
  ] as const) {
    it(`${label}: the grading note, the band and the Review tab`, async () => {
      await openRoom([...keys], key, title);
      expect(byTestId('grading-guide')!.textContent).toContain(
        'A Pass lets you complete the project. You may save an optional reflection before completing it.',
      );
      expect(byTestId('gate-banner')!.textContent).toContain(READY_LAST);
      expect(byTestId('open-reflection')!.textContent).toBe('Complete the project');
      expect(byTestId('feedback-verdict')!.textContent).toBe(`Pass${ALL_LAST}`);
      expect(host.textContent).not.toMatch(/next phase|next one|Continue when ready/);
    });
  }

  it('Testing of six says a Pass opens the next phase', async () => {
    await openRoom(SIX, 'testing', 'Testing');
    expect(byTestId('grading-guide')!.textContent).toContain(
      'A Pass opens the next phase. You may save an optional reflection before continuing.',
    );
    expect(byTestId('gate-banner')!.textContent).toContain(READY_NEXT);
    expect(byTestId('open-reflection')!.textContent).toBe('Continue to next phase');
    expect(byTestId('feedback-verdict')!.textContent).toBe(`Pass${ALL_NEXT}`);
  });
});

/* ------------------------------------------------------------- 6: the band */

describe('the ready band (PhaseGateBanner)', () => {
  const passed = { key: 'maintenance', title: 'Maintenance', order: 6, status: 'passed', bestScore: 88, reflection: null } as const;
  it('the last phase: Complete the project when ready', () => {
    const html = renderToStaticMarkup(<PhaseGateBanner phaseId="p6" phase={passed} isLast />);
    expect(html).toContain('Phase evidence accepted. Complete the project when ready; a reflection is optional.');
    expect(html).not.toContain('Continue when ready');
  });
  it('a phase with one after it says to continue when ready, and a recorded merge message is named', () => {
    const next = renderToStaticMarkup(<PhaseGateBanner phaseId="p5" phase={{ ...passed, key: 'deployment', title: 'Deployment', order: 5 }} isLast={false} />);
    expect(next).toContain('Phase evidence accepted. Continue when ready; a reflection is optional.');
    const noted = { ...passed, reflection: 'Shipped.' };
    expect(renderToStaticMarkup(<PhaseGateBanner phaseId="p6" phase={noted} isLast />)).toContain('Phase evidence accepted. Merge message recorded.');
    expect(renderToStaticMarkup(<PhaseGateBanner phaseId="p6" phase={noted} isLast={false} />)).toContain('Phase evidence accepted. Merge message recorded.');
  });
});

/* ------------------------------------------------- the brief's closing line */

describe("the brief's closing line (PhaseBriefIntro)", () => {
  const CARRY = 'Your saved work and real review evidence carry forward to the next phase.';
  // The phase passing, not its work passing review, completes the project.
  const LAST = "This is your project's last phase: once it passes, you can complete the project.";
  const draw = (keys: string[], key: string) => {
    rig.project = { details: {}, enrollment: enrollmentOf(keys, key, `ph-${key}`, 'in_progress'), loading: false };
    return renderToStaticMarkup(<PhaseBriefIntro phaseKey={key as 'maintenance'} />);
  };
  it('the last phase says what completes the project', () => {
    expect(draw(SIX, 'maintenance')).toContain(LAST.replace("'", '&#x27;'));
    expect(draw(SIX, 'maintenance')).not.toContain('next phase');
    expect(draw(FOUR, 'testing')).toContain(LAST.replace("'", '&#x27;'));
  });
  it('a phase with one after it, and a room with no enrolment held, read the carry-on line', () => {
    expect(draw(SIX, 'testing')).toContain(CARRY);
    rig.project = null;
    expect(renderToStaticMarkup(<PhaseBriefIntro phaseKey="maintenance" />)).toContain(CARRY);
  });
});

/* --------------------------------------------------- 4: the printed record */

describe("the printed record's credit lines (Dossier)", () => {
  const AWAITING = "Awaiting your teacher's sign-off";
  const SIGNOFF = [{ key: 'scope', awaitsSignOff: true }];
  const UNREVIEWED = [{ key: 'scope' }];
  /** The enrolment's phases in order; `credits` maps a key to the credit it carries (passed on the board), the rest locked. */
  const record = (keys: string[], credits: Record<string, { key: string; awaitsSignOff?: boolean }[]>): LearnerDossier => {
    const phases = keys.map((key, at) => {
      const credit = credits[key];
      return { ...summaryRow(key, at + 1, credit ? 'passed' : 'locked'), ...(credit ? { passKind: 'credit', creditTasks: credit } : {}) };
    });
    const details = Object.fromEntries(phases.map((one) => [one.id, { ...one, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null }])) as unknown as Record<string, PhaseDetail>;
    const enrollment = { phases, projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null } as unknown as EnrollmentView;
    // A credited phase counts on the cover only with a verified revision behind it (`phasesPassed`).
    const verified = (taskKey: string) => ({ id: `rev-${taskKey}`, taskKey, status: 'completed', passed: true, verifiedPass: true, score: 100, report: null, createdAt: '2026-10-11T00:00:00Z' });
    const records = Object.fromEntries(phases.map((one) => [one.id, { submissions: credits[one.key] ? [verified('story')] : [], runs: [], chat: [] }]));
    return buildDossier(enrollment, details, records as unknown as Record<string, PhaseRecords>, {}, null);
  };
  const draw = async (dossier: LearnerDossier) => {
    await act(async () => root.render(<Dossier dossier={dossier} />));
    return (id: string) => byTestId(id)?.textContent ?? null;
  };

  it('a countersignature on the last phase: the project can be completed', async () => {
    const text = await draw(record(['requirements', 'design'], { requirements: SIGNOFF.map((t) => ({ ...t, key: 'r' })), design: SIGNOFF }));
    // Requirements is not last and Design is: both are said.
    expect(text('dossier-awaiting')).toBe(
      ` ${AWAITING} on 2 phases: the work passed review; the next phase opens, or on the last phase the project can be completed, on the countersignature.`,
    );
    const only = await draw(record(['requirements', 'design'], { design: SIGNOFF }));
    expect(only('dossier-awaiting')).toBe(` ${AWAITING} on 1 phase: the work passed review; the project can be completed on the countersignature.`);
  });

  it('a credit on the last phase: the project can be completed on a reviewed pass', async () => {
    const text = await draw(record(['requirements', 'design'], { design: UNREVIEWED }));
    expect(text('dossier-credited')).toBe(
      " Credit awarded, review still needed on 1 phase: a teacher's credit counts on the board; the project can be completed on a reviewed pass.",
    );
    const both = await draw(record(['requirements', 'design'], { requirements: UNREVIEWED, design: UNREVIEWED }));
    expect(both('dossier-credited')).toBe(
      " Credit awarded, review still needed on 2 phases: a teacher's credit counts on the board; the next phase opens, or on the last phase the project can be completed, on a reviewed pass.",
    );
  });

  it('credits on phases with one after them say the next phase opens on the countersignature or a reviewed pass', async () => {
    const text = await draw(record(['requirements', 'design'], { requirements: SIGNOFF }));
    expect(text('dossier-awaiting')).toBe(` ${AWAITING} on 1 phase: the work passed review; the next phase opens on the countersignature.`);
    const credited = await draw(record(['requirements', 'design', 'implementation'], { requirements: UNREVIEWED, design: UNREVIEWED }));
    expect(credited('dossier-credited')).toBe(
      " Credit awarded, review still needed on 2 phases: a teacher's credit counts on the board; the next phase opens on a reviewed pass.",
    );
  });
});

/* ------------------------------------------------ 5: the teacher's question */

describe("the teacher's sign-off question (LearnerTasks)", () => {
  const revision = { id: 'rev-c', taskKey: 'criteria', status: 'completed', score: 80, passed: true, report: null, createdAt: '2026-09-18T09:00:00.000Z', attempt: 1 };
  const tTask = (over: Row) =>
    ({ key: 'story', order: 1, required: true, title: 'Write the user story', status: 'passed', bestScore: 82, attempts: 1, passedAt: '2026-09-18T09:00:00.000Z', awaitingSignOff: false, signedOffAt: null, lastSubmission: { ...revision, taskKey: 'story' }, ...over }) as unknown as InstructorTaskView;
  const waiting = tTask({ key: 'criteria', order: 2, title: 'Write the acceptance criteria', status: 'submitted', awaitingSignOff: true, passedAt: null, lastSubmission: revision });
  const view = (key: string, title: string) =>
    ({
      id: 'ps-1', key, order: 1, title, status: 'in_progress', bestScore: 82, attempts: 2, reflection: null, passedAt: null, opensAt: null, dueAt: null,
      hints: 0, relianceIndex: 0, passThreshold: 70, unlockedAt: '2026-09-10T09:00:00.000Z', lastSubmission: revision, tasks: [tTask({}), waiting],
    }) as unknown as InstructorPhaseView;
  const question = async (phase: InstructorPhaseView) => {
    await act(async () =>
      root.render(<LearnerTasks userId="learner-a" learnerName="Ada" phase={phase} onPhase={() => {}} onOpenSubmission={() => {}} />),
    );
    await act(async () => (byTestId('task-signoff-criteria') as HTMLButtonElement).click());
    return byTestId('task-lever-confirm-criteria')!.textContent ?? '';
  };

  it('says the open phase passes, never that it opens, on any phase, the last included', async () => {
    const words = await question(view('requirements', 'Requirements'));
    expect(words).toContain('Their reviewed pass is waiting on this countersignature, so Requirements passes once every required task has passed.');
    expect(words).not.toContain('opens');
    const last = await question(view('maintenance', 'Maintenance'));
    expect(last).toContain('Their reviewed pass is waiting on this countersignature, so Maintenance passes once every required task has passed.');
  });

  it('a phase already passed says the countersignature moves no gate', async () => {
    const words = await question({ ...view('requirements', 'Requirements'), status: 'passed' } as InstructorPhaseView);
    expect(words).toContain('Requirements is already passed, so this records the countersignature on their reviewed pass and moves no gate.');
  });
});
