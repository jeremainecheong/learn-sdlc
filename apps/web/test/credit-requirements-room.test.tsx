// @vitest-environment jsdom
/**
 * The REAL RequirementsWorkspace. The rig is
 * signoff-chip-wiring's: `useProject` answers the enrolment and the held
 * phase, `request` answers the room's own reads.
 *
 * - A story the teacher credited (Mark as passed) after its review came
 *   back Needs revision reads "Credit awarded, review still needed" on its
 *   task row, its backlog row and its editor header, never "Review passed" or
 *   "Approved"; the gate's `evidenceNeeded` is the one source, as in the band.
 * - The room's header carries the phase's place and the same state chip
 *   the code rooms draw.
 * - The task list is one row that opens on a press, with every task row
 *   still there; "Start this task over" / "Retry this task" is in More.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, STORY_JSON, serialiseStory } from '@learnsdlc/shared';
import { report } from './fixtures';

const PHASE_ID = 'fc-requirements';
const rig = vi.hoisted(() => ({
  project: null as unknown,
  request: vi.fn(),
  fetch: vi.fn(),
  phaseId: 'fc-requirements',
  reviews: [] as unknown[],
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: rig.phaseId }),
  usePathname: () => `/workspace/${rig.phaseId}/issue`,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  request: rig.request,
}));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
// The change room and the dashboard are mounted too, so their wiring is tested.
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'fc-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({ reviews: rig.reviews, hasLoaded: true, loading: false, refreshing: false, refreshError: '', error: '', refresh: () => {} }),
}));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value }: { value: string }) => <textarea aria-label="Code" value={value} readOnly />,
}));
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: () => {}, start: () => {} }),
  stopPreviewOnExit: () => {},
}));

import { RequirementsWorkspace } from '@/components/workspace/requirements/RequirementsWorkspace';
import { CREDIT_AWARDED } from '@/components/workspace/signoff-status';
import { STATE_LABEL } from '@/components/workspace/gate-state';

// The plain Pass line does not say how to continue; the gate band does.
const TODAY_PASS = 'All required evidence accepted.';
const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const STORY = serialiseStory({
  ...EMPTY_STORY,
  id: 'SH-5',
  title: 'Free books by an author',
  persona: 'member',
  capability: "to see which of an author's books are free to borrow right now",
  benefit: 'I do not walk to the shelf for a book that is out',
});

const OWN_REQUIREMENTS: PhaseProvenanceView = {
  phaseKey: 'requirements', referenceName: null, rollup: 'own', intro: 'own', interview: null, files: [], tasks: [], roomTask: 'other',
} as unknown as PhaseProvenanceView;

const theTask = (signed: boolean): PhaseTaskView =>
  ({
    key: 'main', order: 1, required: true, title: 'Your story', artefactType: 'user-story', artefactPath: STORY_JSON,
    primaryPath: STORY_JSON, files: [STORY_JSON], evidence: 'signed-off', sealed: true,
    status: signed ? 'passed' : 'submitted', awaitingSignOff: !signed, attempts: 1, bestScore: 88,
    passedAt: signed ? '2026-10-02T05:10:00.000Z' : null, lastSubmissionId: 'rev-1', resetAt: null,
    solution: { available: false, files: 0, readAt: null },
  }) as PhaseTaskView;

const passingReview = (): SubmissionView =>
  ({
    id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 88, attempt: 1, createdAt: '2026-10-02T05:00:00.000Z',
    report: report({
      overall: 88,
      passed: true,
      criteria: [{ key: 'c1', title: 'Acceptance criteria are checkable', weight: 1, score: 88, evidence: ['Two criteria, each a check.'] }],
      aiReview: {
        summary: 'The story names the actor, the want and the why.',
        strengths: ['Every criterion is a check a test could run.'],
        improvements: [],
        processNote: '',
        provider: 'openai',
        criteriaEvidence: [{ key: 'c1', met: true }],
      } as unknown as ReturnType<typeof report>['aiReview'],
    }),
  }) as unknown as SubmissionView;

function phaseDetail(signed: boolean): PhaseDetail {
  return {
    id: PHASE_ID, key: 'requirements', order: 1, title: 'Requirements', status: signed ? 'passed' : 'submitted',
    attempts: 1, bestScore: 88, reflection: null, passedAt: signed ? '2026-10-02T05:10:00.000Z' : null, opensAt: null, dueAt: null,
    projectSlug: 'shelf', intro: 'Write the story for the shelf.', taskPanel: 'The brief.', objectives: [], artifactKind: 'story',
    files: [
      { path: STORY_JSON, content: STORY, editable: true, language: 'json' },
    ],
    story: {
      id: 'SH-5', hints: {}, floor: DEFAULT_STORY_FLOOR,
      providedStories: [{ id: 'SH-1', title: 'Browse the shelf', persona: 'member', capability: 'to browse the shelf', benefit: 'I find a book' }],
    },
    rubric: { passThreshold: 70, criteria: [{ key: 'c1', title: 'Acceptance criteria are checkable', description: '', weight: 1 }] },
    tasks: [theTask(signed)],
    taskCounts: { total: 1, required: 1, passed: signed ? 1 : 0, passedRequired: signed ? 1 : 0 },
    canRun: false, canPreview: false, runLabel: 'Run tests', links: [],
    lastSubmission: passingReview(),
    updatedAt: '2026-10-02T05:00:00.000Z', workspaceUpdatedAt: '2026-10-02T04:50:00.000Z',
    provenance: OWN_REQUIREMENTS, stakeholder: null, scenario: 'own',
  } as unknown as PhaseDetail;
}

function shell(detail: PhaseDetail) {
  const phases = KEYS.map((key, at) =>
    at === 0
      ? ({ ...detail, view: undefined } as unknown as PhaseSummary)
      : ({ id: `fc-${key}`, key, order: at + 1, title: key[0].toUpperCase() + key.slice(1), status: 'locked', attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'own' } as PhaseSummary),
  );
  const enrollment = {
    id: 'fc-enrolment', projectSlug: 'shelf', projectTitle: 'Shelf — a teacher’s project', currentPhaseOrder: 1, completed: false,
    startedAt: '2026-10-02T00:00:00Z', completedAt: null, projectIsDefault: false, phases,
  } as unknown as EnrollmentView;
  return {
    enrollment, currentPhase: phases[0], details: { [PHASE_ID]: detail }, analytics: null,
    loading: false, revalidating: false, error: '', reload: () => Promise.resolve(),
  };
}

/** Every request the room makes, and what the server answers. */
const calls: string[] = [];
function serve(detail: PhaseDetail) {
  rig.request.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail;
    if (path.includes('/submit')) throw new Error('a resubmit reached the API');
    return [];
  });
  rig.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(url.endsWith(`/phases/${PHASE_ID}`) ? detail : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

let host: HTMLDivElement;
let root: Root;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;
beforeEach(() => {
  rig.phaseId = PHASE_ID;
  rig.reviews = [];
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  rig.request.mockReset();
  rig.fetch.mockReset();
  vi.stubGlobal('fetch', rig.fetch);
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
});

async function mountRoom(signed: boolean) {
  const detail = phaseDetail(signed);
  rig.project = shell(detail);
  serve(detail);
  await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
  await act(async () => { await Promise.resolve(); });
}
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const clickButton = (pattern: RegExp, scope: ParentNode = host) => {
  const button = Array.from(scope.querySelectorAll('button')).find((one) => pattern.test((one.textContent ?? '').trim()));
  expect(button, String(pattern)).toBeDefined();
  act(() => button!.click());
};
/** The story's own row on the backlog: the chip a learner reads first. */
// The backlog row's state is the app's chip, in the header's words and case.
const rowChip = () => host.querySelector('.jira-own-story [data-testid="phase-requirements-story-status"]')?.textContent;
/** The chip in the story's own header, in the editor the row opens. */
function headerChip(): string {
  act(() => host.querySelector<HTMLButtonElement>('.jira-own-story')!.click());
  const header = host.querySelector('dialog[open] .jira-story-editor header');
  expect(header, 'the story editor header').not.toBeNull();
  const chips = Array.from(header!.querySelectorAll('span')).map((one) => one.textContent ?? '');
  clickButton(/^Cancel$/);
  return chips.join(' | ');
}
function openReview(): string {
  const nav = host.querySelector('nav[aria-label="Backlog views"]')!;
  clickButton(/^Review$/, nav);
  return byTestId('feedback-verdict')?.textContent ?? '';
}

/* ------------------------------ the fixtures ------------------------------ */

/** A split phase: the story (required) and a concept quiz (optional). */
const storyTask = (over: Partial<PhaseTaskView> = {}): PhaseTaskView =>
  ({ ...theTask(true), key: 'story', order: 1, title: 'Requirements (class edit)', evidence: 'review', awaitingSignOff: false, ...over }) as PhaseTaskView;
const quizTask = (): PhaseTaskView =>
  ({
    ...theTask(false), key: 'concepts', order: 2, required: false, title: 'Story concepts', artefactType: 'quiz', artefactPath: '', primaryPath: '',
    files: [], status: 'in_progress', awaitingSignOff: false, attempts: 0, bestScore: null, lastSubmissionId: null,
  }) as unknown as PhaseTaskView;

const failingReview = (): SubmissionView =>
  ({ ...passingReview(), id: 'rev-fail', taskKey: 'story', passed: false, score: 40 }) as unknown as SubmissionView;

/** Passed on the board by the teacher's Mark as passed; the last review said Needs revision. */
function creditedSplit(): PhaseDetail {
  const base = phaseDetail(true);
  return {
    ...base,
    status: 'passed',
    tasks: [storyTask({ bestScore: 100, attempts: 1 }), quizTask()],
    taskCounts: { total: 2, required: 1, passed: 1, passedRequired: 1 },
    lastSubmission: failingReview(),
    evidenceNeeded: [{ key: 'story', title: 'Requirements (class edit)' }],
  } as unknown as PhaseDetail;
}

/** The same phase once the story has a reviewed pass of its own. */
function reviewedSplit(): PhaseDetail {
  return { ...creditedSplit(), lastSubmission: { ...passingReview(), taskKey: 'story' }, evidenceNeeded: undefined } as unknown as PhaseDetail;
}

/** One task, credited: the gap names the phase's one task by `''`. */
function creditedSingle(): PhaseDetail {
  return {
    ...phaseDetail(true),
    tasks: [{ ...theTask(true), evidence: 'review' }],
    lastSubmission: { ...failingReview(), taskKey: 'main' },
    evidenceNeeded: [{ key: '', title: 'Requirements' }],
  } as unknown as PhaseDetail;
}

/** In progress, nothing handed in. */
function openSplit(): PhaseDetail {
  return {
    ...creditedSplit(),
    status: 'in_progress',
    tasks: [storyTask({ status: 'in_progress', attempts: 0, bestScore: null, passedAt: null } as Partial<PhaseTaskView>), quizTask()],
    taskCounts: { total: 2, required: 1, passed: 0, passedRequired: 0 },
    lastSubmission: null,
    evidenceNeeded: undefined,
  } as unknown as PhaseDetail;
}

async function mount(detail: PhaseDetail) {
  rig.project = shell(detail);
  serve(detail);
  await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
  await act(async () => { await Promise.resolve(); });
}
const switcher = () => byTestId('task-switcher')!;
const rowState = (key: string) => {
  const row = host.querySelector(`[data-testid="task-open-${key}"], [data-testid="task-choose-${key}"], [data-testid="task-row-${key}"]`);
  expect(row, `the row of ${key}`).not.toBeNull();
  return row!.textContent ?? '';
};

describe('credit without a reviewed pass reads as credit everywhere in the room', () => {
  it('the task row, the backlog row and the story header say credit; nothing says Review passed or Approved', async () => {
    await mount(creditedSplit());
    expect(rowState('story')).toContain(CREDIT_AWARDED);
    expect(rowState('story')).not.toContain(STATE_LABEL.reviewPassed);
    // Its score was never a reviewed pass, so no "Best 100" beside it.
    expect(rowState('story')).not.toContain('Best 100');
    expect(rowChip()).toBe(CREDIT_AWARDED);
    expect(headerChip()).toContain(CREDIT_AWARDED);
    expect(headerChip()).not.toMatch(/Approved|Review passed/);
    // The compact row's own summary says the same.
    expect(byTestId('task-switcher-current')?.textContent).toContain(CREDIT_AWARDED);
    // The room's header chip agrees with the band.
    expect(byTestId('phase-state')?.textContent).toBe(CREDIT_AWARDED);
    expect(byTestId('gate-banner')?.textContent ?? '').toContain(CREDIT_AWARDED);
    expect(host.textContent ?? '').not.toMatch(/APPROVED|Approved/);
  });

  it('a phase with one task, credited: the story says credit, by the gap that names the phase', async () => {
    await mount(creditedSingle());
    expect(rowChip()).toBe(CREDIT_AWARDED);
    expect(byTestId('phase-state')?.textContent).toBe(CREDIT_AWARDED);
  });

  it('a reviewed pass still reads Review passed on the row, the story and the header', async () => {
    await mount(reviewedSplit());
    expect(rowState('story')).toContain(STATE_LABEL.reviewPassed);
    expect(rowState('story')).toContain('Best 100');
    expect(rowChip()).toBe(STATE_LABEL.reviewPassed);
    expect(byTestId('phase-state')?.textContent).toBe(STATE_LABEL.reviewPassed);
  });
});

describe('a story signed off by the teacher alone, in a phase that has not passed', () => {
  /** The teacher's per-task sign-off passed the story; the phase is still in progress (no gate answer). */
  function signedOffSplit(): PhaseDetail {
    return {
      ...openSplit(),
      tasks: [storyTask({ status: 'passed', attempts: 1, bestScore: 40 }), quizTask()],
      taskCounts: { total: 2, required: 1, passed: 1, passedRequired: 1 },
      lastSubmission: failingReview(),
    } as unknown as PhaseDetail;
  }

  it('the backlog row and the story header read Passed, never Review passed; the task row agrees', async () => {
    await mount(signedOffSplit());
    expect(rowChip()).toBe('Passed');
    const header = headerChip();
    expect(header).toContain('Passed');
    expect(header).not.toMatch(/Review passed|Approved/);
    expect(rowState('story')).toContain('Passed');
    expect(rowState('story')).not.toContain(STATE_LABEL.reviewPassed);
    expect(byTestId('phase-state')?.textContent).toBe(STATE_LABEL.inProgress);
    expect(host.textContent ?? '').not.toMatch(/REVIEW PASSED|Review passed/);
  });
});

describe('Requirements draws the same header chip as every room', () => {
  it('"Phase 1 of 6" and "In progress" beside the name, before More', async () => {
    await mount(openSplit());
    const strip = byTestId('phase-strip')!;
    expect(strip.classList.contains('phase-header')).toBe(true);
    expect(strip.querySelector('[data-testid="phase-place"]')?.textContent).toBe('Phase 1 of 6');
    expect(strip.querySelector('[data-testid="phase-state"]')?.textContent).toBe(STATE_LABEL.inProgress);
    expect(strip.querySelector('[data-testid="phase-more-toggle"]')).not.toBeNull();
  });
});

describe('the task list is one row, and every control is still one press away', () => {
  it('folded by default, with the current task, its state and the totals on the row', async () => {
    await mount(openSplit());
    const list = switcher();
    expect(list.dataset.compact).toBe('true');
    expect(list.getAttribute('aria-label')).toBe('Tasks in this phase');
    const details = list.querySelector('details')!;
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toContain('Tasks in this phase');
    expect(summary.textContent).toContain('Requirements (class edit)');
    expect(summary.textContent).toContain('Ready to start');
    expect(summary.querySelector('[data-testid="task-counts"]')?.textContent).toBe('0 of 1 required done. Optional: 0 of 1 done');
  });

  it('one press opens every row, each still a door to its room', async () => {
    await mount(openSplit());
    const details = switcher().querySelector('details')!;
    act(() => { details.querySelector('summary')!.click(); });
    expect(details.open).toBe(true);
    const quiz = details.querySelector<HTMLAnchorElement>('[data-testid="task-open-concepts"]');
    expect(quiz, 'the quiz row is a door to its paper').not.toBeNull();
    expect(quiz!.getAttribute('href')).toContain('concept');
    expect(details.querySelector('[data-testid="task-row-story"], [data-testid="task-open-story"], [data-testid="task-choose-story"]')).not.toBeNull();
  });

  it('Retry this task / Start this task over lives in More, not in a band of its own', async () => {
    await mount(creditedSplit());
    const door = byTestId('task-reset-open');
    expect(door, 'the retry door is drawn').not.toBeNull();
    expect(door!.textContent).toBe('Retry this task');
    expect(door!.closest('[data-testid="phase-more"]'), 'inside the header\'s More menu').not.toBeNull();
    expect(host.querySelectorAll('[data-testid="task-reset"]').length).toBe(1);
  });

  it('the quick check, where offered, is on the header row, not a band above it (no layout provider here: nothing drawn)', async () => {
    await mount(openSplit());
    expect(host.querySelectorAll('.quick-check-line:not(.quick-check-line-inline)').length).toBe(0);
  });
});
