// @vitest-environment jsdom
/**
 * The sign-off words on the project's LAST phase.
 *
 * While a reviewed pass waits on the teacher's countersignature, every learner
 * surface said "Your teacher's countersignature opens the next phase." On the
 * last phase of the learner's project there is no next phase: the
 * countersignature passes the phase (the task row and the phase roll up to
 * `passed`), and the learner's own "Complete the project" (or Merge on the PR
 * page) runs `advance()`, which marks the enrolment complete. So on the last
 * phase every surface says so; on every other phase the words are unchanged.
 *
 * "Last" is `isLastPhase` over the enrolment's whole phase list, so a project
 * that is a subset ending in Implementation reads the last-phase words there
 * and not in Maintenance it does not hold.
 *
 * Surfaces: the room's band (ReviewBand), the Review tab (FeedbackPanel /
 * passedLine), the PR page's Merge card (purpose and the label beside Merge),
 * the home plan's sign-off step (buildNextSteps), the feedback page's hero, and
 * the dashboard's latest-feedback line (latestFeedbackLine). The three pages
 * are mounted as their routes export them; only the network and the shell's
 * held project are stood in for.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail, PhaseSummary, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { report, sample, submission } from './fixtures';
import { stubMatchMedia } from './support/dom';

const rig = vi.hoisted(() => ({
  phaseId: 'last-room',
  token: 'owner-a',
  // The breadcrumbs the page last handed its WorkPage.
  crumbs: [] as { label: string; href?: string }[],
  // Whether the room's left column is open (shut unless a case opens it).
  briefOpen: false,
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
  useWorkspacePanels: () => ({ briefOpen: rig.briefOpen, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }),
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
  WorkPage: ({ children, strip, crumbs }: { children: ReactNode; strip: ReactNode; crumbs?: { label: string; href?: string }[] }) => {
    rig.crumbs = crumbs ?? [];
    return (
      <main>
        {strip}
        {children}
      </main>
    );
  },
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

const { SIGN_OFF_PASS_LINE, latestFeedbackLine } = await import('@/components/workspace/signoff-status');
const { passedLine, FeedbackPanel } = await import('@/components/workspace/FeedbackPanel');
const { ReviewBand } = await import('@/components/workspace/PhaseGateBanner');
const { MergeCard } = await import('@/components/pr/MergeCard');
const { buildNextSteps } = await import('@/components/home/derive');
const { default: WorkspacePage } = await import('@/app/(app)/workspace/[phaseId]/page');
const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');
const { default: FeedbackPage } = await import('@/app/(app)/feedback/page');
const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');

/** The words on every phase that has a phase after it: unchanged. */
const NEXT = "Your work passed review. Your teacher's countersignature opens the next phase.";
/** The words on the project's last phase. */
const LAST = "Your work passed review. Your teacher's countersignature passes this last phase; then you can complete the project.";
const NOTE = ' You may leave an optional note about what changed and why.';

type Row = Record<string, unknown>;
const task = (over: Row = {}): PhaseTaskView =>
  ({
    key: 'main', order: 1, required: true, title: 'The change', artefactType: 'code', evidence: 'signed-off', sealed: true,
    status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88, passedAt: null, lastSubmissionId: 'rev-1', resetAt: null,
    solution: { available: false, files: 0, readAt: null },
    ...over,
  }) as PhaseTaskView;
const passing = (): SubmissionView =>
  submission({
    id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 88, attempt: 1, createdAt: '2026-10-02T05:00:00.000Z',
    report: report({ overall: 88, passed: true, aiReview: { summary: 'Fine.', strengths: [], improvements: [], processNote: '', criteriaEvidence: [] } as unknown as ReturnType<typeof report>['aiReview'] }),
  } as Partial<SubmissionView>);

/** A summary row for an enrolment's phase list. */
const summaryRow = (key: string, order: number, status = 'passed'): PhaseSummary =>
  ({ id: `ph-${key}`, key, order, title: key[0].toUpperCase() + key.slice(1), status, bestScore: 88, attempts: 1, reflection: null, passedAt: null, opensAt: null, dueAt: null }) as PhaseSummary;
/** The whole six-phase project. */
const SIX = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
/** A subset project whose last phase is Implementation. */
const THREE = ['requirements', 'design', 'implementation'];
const enrollmentOf = (keys: string[], current: string, currentId: string) => ({
  id: 'e-last', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', currentPhaseOrder: keys.indexOf(current) + 1, completed: false,
  startedAt: '2026-10-01T00:00:00Z', completedAt: null, releases: [],
  phases: keys.map((key, at) => ({ ...summaryRow(key, at + 1, key === current ? 'submitted' : at < keys.indexOf(current) ? 'passed' : 'locked'), ...(key === current ? { id: currentId } : {}) })),
});

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  rig.briefOpen = false;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.save.mockResolvedValue({ saved: true, version: '2026-10-02T05:00:00.000Z' });
  rig.exit.mockResolvedValue({ version: '2026-10-02T05:00:00.000Z' });
  rig.reviews = [];
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

describe('the shared words', () => {
  it('the non-last line is byte-identical to before', () => {
    expect(SIGN_OFF_PASS_LINE).toBe(NEXT);
  });

  it('the Review line (passedLine): the last phase says it completes the project, never "next phase"', () => {
    expect(passedLine([task()], 'main', null, true)).toBe(LAST);
    expect(passedLine([task()], 'main', null, false)).toBe(NEXT);
    expect(passedLine([task()], 'main')).toBe(NEXT);
    // A split last phase whose required tasks all passed or wait.
    const split = [task(), task({ key: 'quiz', order: 2, evidence: 'automated', status: 'passed', awaitingSignOff: false })];
    expect(passedLine(split, 'main', null, true)).toBe(LAST);
    expect(passedLine(split, 'quiz', null, true)).toBe(LAST);
    expect(passedLine(split, 'main', null, false)).toBe(NEXT);
  });

  it("the dashboard's latest-feedback line", () => {
    expect(latestFeedbackLine('Maintenance', true, true, true)).toBe(
      "Maintenance: your work passed review. Your teacher's countersignature passes this last phase; then you can complete the project.",
    );
    expect(latestFeedbackLine('Testing', true, true, false)).toBe(
      "Testing: your work passed review. Your teacher's countersignature opens the next phase.",
    );
    expect(latestFeedbackLine('Testing', true, true)).toBe("Testing: your work passed review. Your teacher's countersignature opens the next phase.");
    // A pass not waiting and a refusal are unaffected by the place.
    expect(latestFeedbackLine('Maintenance', true, false, true)).toBe('Maintenance: your work passed review. Open it to see the evidence it accepted.');
    expect(latestFeedbackLine('Maintenance', false, false, true)).toBe('Maintenance: open the original review and choose your next revision.');
  });
});

describe('the components', () => {
  it('the band (ReviewBand)', () => {
    const last = renderToStaticMarkup(<ReviewBand state="awaiting" isLast />);
    expect(last).toContain(LAST.replace("'", '&#x27;').replace("'", '&#x27;'));
    expect(last).not.toContain('next phase');
    const next = renderToStaticMarkup(<ReviewBand state="awaiting" isLast={false} />);
    expect(next).toContain(NEXT.replace("'", '&#x27;'));
    expect(renderToStaticMarkup(<ReviewBand state="awaiting" />)).toBe(next);
  });

  it('the Review tab (FeedbackPanel)', () => {
    const verdict = (isLast?: boolean) => {
      act(() => root.render(<FeedbackPanel submission={passing()} tasks={[task()]} isLast={isLast} />));
      return byTestId('feedback-verdict')!.textContent ?? '';
    };
    expect(verdict(true)).toContain(LAST);
    expect(verdict(true)).not.toContain('next phase');
    expect(verdict(false)).toContain(NEXT);
    expect(verdict(undefined)).toContain(NEXT);
  });

  it("the PR page's Merge card: the purpose", () => {
    const card = (isLast?: boolean) => {
      act(() =>
        root.render(
          <MergeCard
            pr="PR-6" merged={false} gateMet={false} reviewPassed score={88} gate={70} attempt={1} reason="" reflection={null}
            next={null} nextHref="/dashboard" busy={false} submitLabel="Submit again" signOffPending isLast={isLast}
            waitLabel="wait" onMerge={async () => {}} onSubmitAgain={() => {}} commitMessage="" setCommitMessage={() => {}}
          />,
        ),
      );
      return host.querySelector('[data-testid="pr-merge"] .purpose')?.textContent ?? byTestId('pr-merge')!.textContent ?? '';
    };
    expect(card(true)).toContain(`${LAST}${NOTE}`);
    expect(card(true)).not.toContain('next phase');
    expect(card(false)).toContain(`${NEXT}${NOTE}`);
    expect(card(undefined)).toContain(`${NEXT}${NOTE}`);
  });

  it("the home plan's sign-off step (buildNextSteps)", () => {
    const step = (index: number) => {
      const { enrollment, details } = sample();
      const id = enrollment.phases[index].id;
      const current: PhaseSummary = { ...enrollment.phases[index], status: 'submitted', attempts: 1 };
      const held = { ...(details[id] ?? details.p4), id, key: current.key, title: current.title, status: 'submitted', lastSubmission: passing(), tasks: [task()] } as PhaseDetail;
      const phases = enrollment.phases.map((p, i) => (i === index ? current : p));
      return buildNextSteps({ ...enrollment, phases, currentPhaseOrder: index + 1 }, { ...details, [id]: held }, current).steps;
    };
    const last = step(5);
    expect(last.map((s) => s.key)).toEqual(['signoff']);
    expect(last[0].detail).toBe(LAST);
    expect(step(3)[0].detail).toBe(NEXT);
  });
});

describe('the pages, mounted', () => {
  const roomPhase = (key: string, title: string, order: number) => ({
    id: rig.phaseId, key, title, order, status: 'submitted', projectSlug: 'tasktrackr', place: order, count: 6,
    workspaceUpdatedAt: '2026-10-02T05:00:00.000Z', files: [{ path: 'api/tasks.py', content: 'code', editable: true, language: 'python' }],
    attempts: 1, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
    tasks: [task({ artefactPath: 'api/tasks.py', primaryPath: 'api/tasks.py', files: ['api/tasks.py'] })],
    taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
    lastSubmission: passing(),
    solution: { available: false, files: 0, readAt: null },
  });
  const openRoom = async (keys: string[], key: string, title: string, over: Row = {}, search = '', openReview = true) => {
    rig.phaseId = `last-room-${key}-${keys.length}`;
    const detail = { ...roomPhase(key, title, keys.indexOf(key) + 1), ...over };
    rig.project = { details: {}, enrollment: enrollmentOf(keys, key, rig.phaseId), analytics: null, currentPhase: null, loading: false, reload: vi.fn() };
    rig.load.mockImplementation(async () => detail);
    window.history.replaceState(null, '', `/workspace/${rig.phaseId}${search}`);
    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The band's "View review" opens the Review tab (Implementation keeps the
    // lower panel shut until something asks for it).
    if (openReview) act(() => (byTestId('gate-view-review') as HTMLButtonElement).click());
  };

  it('the IDE room on Maintenance, the last of six: the band and the Review tab', async () => {
    await openRoom(SIX, 'maintenance', 'Maintenance');
    expect(byTestId('review-band-text')!.textContent).toContain(LAST);
    expect(byTestId('feedback-verdict')!.textContent).toContain(LAST);
    expect(host.textContent).not.toContain('countersignature opens the next phase');
  });

  it('the IDE room on Implementation, the last of a three-phase subset', async () => {
    await openRoom(THREE, 'implementation', 'Implementation');
    expect(byTestId('review-band-text')!.textContent).toContain(LAST);
    expect(byTestId('feedback-verdict')!.textContent).toContain(LAST);
  });

  /*
   * The workspace's Review tab hands the shared review the phase it holds, so a
   * floor rule the teacher set to 0 reads "Not required" there as on the pull request page. Fails if the call site
   * stops passing `floors={detail}` (the row then reads Passed).
   */
  it('the Review tab reads a floor of 0 as "Not required", from the phase it holds', async () => {
    const zero = { id: 'runbook.data.min', label: 'At least 0 data entries', status: 'passed', detail: '0 data entries' };
    const held = passing();
    await openRoom(SIX, 'deployment', 'Deployment', {
      lastSubmission: { ...held, report: { ...held.report!, checks: [zero] } },
      runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true },
    });
    const chip = byTestId('check-not-required');
    expect(chip?.textContent).toBe('Not required');
    expect(chip!.closest('tr')!.textContent).toContain('At least 0 data entries');
  });

  /*
   * Implementation's file tree is the left column's tab, not a row entry,
   * so with it opened by address (`?panel=files`) the trail still ends with the row's entry for the view on screen.
   */
  it('Implementation with its file tree open reads "<project> › Implementation › Code", never "Files"', async () => {
    // The room as the address opens it, its left column open as `?panel=files` asks (setBriefOpen(true)); the Review
    // tab is not asked for (it would take the narrow screen's one pane).
    rig.briefOpen = true;
    await openRoom(SIX, 'implementation', 'Implementation', {}, '?panel=files', false);
    expect(host.querySelector('nav[aria-label="Phase context"] button[aria-pressed="true"]')?.textContent).toBe('Files');
    const trail = rig.crumbs.slice(-2).map((one) => [one.label, one.href ?? null]);
    expect(trail).toEqual([['Implementation', '/phases?phase=implementation'], ['Code', null]]);
  });

  it('the IDE room on Implementation of six names the next phase', async () => {
    await openRoom(SIX, 'implementation', 'Implementation');
    expect(byTestId('review-band-text')!.textContent).toContain(NEXT);
    expect(byTestId('feedback-verdict')!.textContent).toContain(NEXT);
  });

  const openPr = async (keys: string[]) => {
    rig.phaseId = `last-pr-${keys.length}`;
    rig.pr.phase = { ...roomPhase('implementation', 'Implementation', 3), reflection: null };
    rig.pr.head = { id: 'rev-1', attempt: 1, score: 88, state: 'done', createdAt: '2026-10-02T05:00:00.000Z', report: { passed: true, aiReview: { assessmentError: false } } };
    rig.project = {
      details: { [rig.phaseId]: rig.pr.phase }, enrollment: enrollmentOf(keys, 'implementation', rig.phaseId),
      analytics: null, currentPhase: null, reload: vi.fn(async () => undefined),
    };
    await act(async () => {
      root.render(<PullRequestPage />);
    });
  };

  it('the PR page on the last phase of a subset: the purpose and the label beside Merge', async () => {
    await openPr(THREE);
    const card = byTestId('pr-merge')!.textContent ?? '';
    expect(card).toContain(`${LAST}${NOTE}`);
    expect(card).not.toContain('next phase');
  });

  it('the PR page with a phase after it names the next phase', async () => {
    await openPr(SIX);
    expect(byTestId('pr-merge')!.textContent).toContain(`${NEXT}${NOTE}`);
  });

  const openFeedback = async (keys: string[], key: string) => {
    const id = `ph-${key}`;
    const enrollment = enrollmentOf(keys, key, id);
    const phase = enrollment.phases.find((one) => one.key === key)!;
    rig.project = { loading: false, details: { [id]: { ...phase, tasks: [task()] } }, enrollment };
    rig.reviews = [{ phase, submission: { id: 'rev-1', phaseStateId: id, status: 'completed', passed: true, verifiedPass: true, createdAt: '2026-10-02T05:00:00.000Z', reviewUnavailable: false, attempt: 1 } }];
    await act(async () => {
      root.render(<FeedbackPage />);
    });
    return host.querySelector('.exp-result-main p')!.textContent;
  };

  it("the feedback page's hero on the last phase", async () => {
    expect(await openFeedback(SIX, 'maintenance')).toBe(LAST);
  });

  it("the feedback page's hero on a phase with one after it", async () => {
    expect(await openFeedback(SIX, 'testing')).toBe(NEXT);
  });

  const dashboardLine = async (keys: string[], key: string) => {
    const id = `ph-${key}`;
    const enrollment = enrollmentOf(keys, key, id);
    const phase = enrollment.phases.find((one) => one.key === key)!;
    rig.project = {
      loading: false, revalidating: false, error: '', analytics: null, currentPhase: phase, reload: () => Promise.resolve(),
      details: { [id]: { ...phase, tasks: [task()] } }, enrollment,
    };
    rig.reviews = [{ phase, submission: { id: 'rev-1', phaseStateId: id, status: 'completed', passed: true, verifiedPass: true, createdAt: '2026-10-02T05:00:00.000Z', reviewUnavailable: false, attempt: 1, commitMessage: null } }];
    await act(async () => {
      root.render(<DashboardPage />);
    });
    const title = phase.title;
    return Array.from(host.querySelectorAll('p')).map((one) => one.textContent ?? '').find((text) => text.startsWith(`${title}:`)) ?? '';
  };

  it("the dashboard's latest-feedback line on the last phase of a subset", async () => {
    expect(await dashboardLine(THREE, 'implementation')).toBe(
      "Implementation: your work passed review. Your teacher's countersignature passes this last phase; then you can complete the project.",
    );
  });

  it("the dashboard's latest-feedback line on a phase with one after it", async () => {
    expect(await dashboardLine(SIX, 'implementation')).toBe(
      "Implementation: your work passed review. Your teacher's countersignature opens the next phase.",
    );
  });
});
