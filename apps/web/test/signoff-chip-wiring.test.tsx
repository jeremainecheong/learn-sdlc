// @vitest-environment jsdom
/**
 * The REAL RequirementsWorkspace on an own Requirements phase with one task
 * the teacher marked "Needs your sign-off".
 *
 * Fixture A: the review passed, the task row is `submitted` with
 * `awaitingSignOff`, the next phase is shut. The room must not say NEEDS
 * REVISION on the story or "Continue to the next phase when ready." in the
 * Review view, and must not leave "Submit for review" on, a resubmit that
 * costs a review. Fixture B is the same phase after the countersignature,
 * which reads as any passed phase does.
 *
 * The shell is the seam, as in own-story-record: `useProject` answers the
 * enrolment and the held phase, and `request` answers the room's own reads.
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
import { AWAITING_SIGN_OFF, SIGN_OFF_PASS_LINE, SIGN_OFF_SUBMIT_REASON } from '@/components/workspace/signoff-status';
import ChangeRequestPage from '@/app/(app)/workspace/[phaseId]/change/page';
import DashboardPage from '@/app/(app)/dashboard/page';

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

describe('A: a passing review on a one-task phase awaiting the countersignature', () => {
  it('the story chip reads the owner\'s words, never Needs revision', async () => {
    await mountRoom(false);
    expect(byTestId('requirements-workspace') ?? host.firstElementChild).not.toBeNull();
    expect(rowChip()).toBe(AWAITING_SIGN_OFF);
    expect(rowChip()).toBe("Awaiting your teacher's sign-off");
    expect(rowChip()).not.toBe('Needs revision');
    expect(headerChip()).toContain(AWAITING_SIGN_OFF);
    expect(host.textContent ?? '').not.toMatch(/needs revision/i);
  });

  it('the Review view says the work passed and the countersignature opens the next phase; no Continue anywhere', async () => {
    await mountRoom(false);
    const verdict = openReview();
    expect(verdict).toContain('Pass');
    expect(verdict).toContain(SIGN_OFF_PASS_LINE);
    expect(host.textContent ?? '').not.toMatch(/Continue to (the )?next phase/);
    // No door out into the shut phase, of any kind.
    expect(Array.from(host.querySelectorAll('a, button')).map((one) => one.textContent ?? '').filter((text) => /^\s*Continue/.test(text))).toEqual([]);
    expect(host.textContent ?? '').not.toMatch(/needs revision/i);
  });

  it('Submit for review is off with a plain reason, and neither the button nor the shortcut hands anything in', async () => {
    await mountRoom(false);
    const submit = byTestId('phase-requirements-submit') as HTMLButtonElement;
    expect(submit).not.toBeNull();
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe(SIGN_OFF_SUBMIT_REASON);
    const described = submit.getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe(SIGN_OFF_SUBMIT_REASON);
    act(() => submit.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      await Promise.resolve();
    });
    expect(calls.filter((call) => call.startsWith('POST') && call.includes('/submit'))).toEqual([]);
  });
});

describe('B: the same phase after the countersignature reads as today', () => {
  // "Approved" became the state words' "Review passed".
  it('Review passed, today\'s Pass line, and Submit for review as today', async () => {
    await mountRoom(true);
    expect(rowChip()).toBe('Review passed');
    expect(headerChip()).toContain('Review passed');
    const verdict = openReview();
    expect(verdict).toContain(TODAY_PASS);
    expect(verdict).not.toContain(SIGN_OFF_PASS_LINE);
    const submit = byTestId('phase-requirements-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.title).toBe('');
    expect(host.textContent ?? '').not.toContain(AWAITING_SIGN_OFF);
  });
});

/* ------------------------ more waiting shapes, mounted -------------------- */

/**
 * The e2e journey's shape: a teacher split Requirements into the story and a
 * document task, and marked both. Both passed their reviews and both wait.
 */
const splitTask = (key: string, order: number, signed: boolean, over: Partial<PhaseTaskView> = {}): PhaseTaskView =>
  ({
    ...theTask(signed), key, order, title: key === 'story' ? 'Your story' : 'What the member asked for, in their words',
    lastSubmissionId: `rev-${key}`, ...over,
  }) as PhaseTaskView;

function splitDetail(signed: boolean): PhaseDetail {
  const base = phaseDetail(signed);
  return {
    ...base,
    tasks: [
      splitTask('story', 1, signed),
      splitTask('countersign', 2, signed, { artefactType: 'document', artefactPath: 'requirements/heard.md', primaryPath: 'requirements/heard.md', files: ['requirements/heard.md'] } as Partial<PhaseTaskView>),
    ],
    taskCounts: { total: 2, required: 2, passed: signed ? 2 : 0, passedRequired: signed ? 2 : 0 },
    lastSubmission: { ...passingReview(), id: 'rev-story', taskKey: 'story' },
  } as unknown as PhaseDetail;
}

async function mountDetail(detail: PhaseDetail) {
  rig.project = shell(detail);
  serve(detail);
  await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
  await act(async () => { await Promise.resolve(); });
}

describe('C: the e2e shape, a split Requirements phase with both tasks marked and waiting', () => {
  it('the story chip, the sign-off Pass line naming no task open, no Continue, Submit off', async () => {
    await mountDetail(splitDetail(false));
    expect(rowChip()).toBe("Awaiting your teacher's sign-off");
    const verdict = openReview();
    expect(verdict).toContain(SIGN_OFF_PASS_LINE);
    expect(verdict).not.toContain('still open');
    expect(host.textContent ?? '').not.toMatch(/Continue to (the )?next phase/);
    const submit = byTestId('phase-requirements-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe(SIGN_OFF_SUBMIT_REASON);
  });

  it('after both countersignatures: Review passed and today\'s Pass line', async () => {
    await mountDetail(splitDetail(true));
    expect(rowChip()).toBe('Review passed');
    expect(openReview()).toContain(TODAY_PASS);
  });
});

describe('D: the verdict has landed and the list has not caught up', () => {
  it('a newer passing revision of a signed-off task reads as waiting before the reload', async () => {
    const detail = phaseDetail(false);
    // The list is a moment behind: the flag is not set yet and it knows an older revision.
    (detail.tasks as PhaseTaskView[])[0] = { ...theTask(false), awaitingSignOff: false, lastSubmissionId: 'rev-0' };
    await mountDetail(detail);
    expect(rowChip()).toBe("Awaiting your teacher's sign-off");
    expect(openReview()).toContain(SIGN_OFF_PASS_LINE);
    const submit = byTestId('phase-requirements-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe('E: the shortcut alone', () => {
  it('⌘↵ on the backlog hands nothing in while the countersignature is pending', async () => {
    await mountRoom(false);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      await Promise.resolve();
    });
    for (let round = 0; round < 10; round += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // No attempt at all: nothing written or sent, and no hand-in started. Without
    // the guard the shortcut starts one (it saves first; in this rig the save
    // refuses, so the room says the review was not started).
    expect(calls.filter((call) => !call.startsWith('GET '))).toEqual([]);
    expect(host.textContent ?? '').not.toContain('the review was not started');
    expect((byTestId('phase-requirements-submit') as HTMLButtonElement).textContent).not.toContain('In review');
  });
});

/** The change room's phase: one Maintenance task, marked, passed its review. */
const CHANGE_ID = 'fc-maintenance';
function changeDetail(signed: boolean): PhaseDetail {
  return {
    ...phaseDetail(signed), id: CHANGE_ID, key: 'maintenance', order: 6, title: 'Maintenance', artifactKind: 'code',
    files: [{ path: 'src/app.ts', content: 'export const x = 1;\n', editable: true, language: 'typescript' }],
    tasks: [{ ...theTask(signed), artefactType: 'code', artefactPath: undefined, primaryPath: 'src/app.ts', files: ['src/app.ts'] } as unknown as PhaseTaskView],
    lastSubmission: null,
  } as unknown as PhaseDetail;
}

describe('F: the change room, mounted', () => {
  async function mountChange(signed: boolean) {
    rig.phaseId = CHANGE_ID;
    const detail = changeDetail(signed);
    const project = shell(detail);
    rig.project = { ...project, details: { [CHANGE_ID]: detail } };
    serve(detail);
    rig.request.mockImplementation(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === `/phases/${CHANGE_ID}`) return detail;
      return [];
    });
    await act(async () => { root.render(<ChangeRequestPage />); });
    for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
  }
  const chipTexts = () => Array.from(host.querySelectorAll('span')).map((one) => (one.textContent ?? '').trim());

  it('its chip reads the owner\'s words, never Needs revision', async () => {
    await mountChange(false);
    expect(chipTexts()).toContain(AWAITING_SIGN_OFF);
    expect(chipTexts()).not.toContain('Needs revision');
  });

  it('after the countersignature its chip is today\'s Pass', async () => {
    await mountChange(true);
    expect(chipTexts()).toContain('Pass');
    expect(chipTexts()).not.toContain(AWAITING_SIGN_OFF);
  });
});

describe('G: the dashboard\'s latest-feedback line, mounted', () => {
  async function mountDashboard(detail: PhaseDetail, taskKey: string) {
    rig.project = shell(detail);
    // A history row as the API sends it: no task key (submission-feedback.service history()).
    const { taskKey: _drop, report: _report, ...row } = { ...passingReview(), id: `rev-${taskKey}` };
    rig.reviews = [{ phase: (rig.project as { enrollment: EnrollmentView }).enrollment.phases[0], submission: { ...row, phaseStateId: PHASE_ID, verifiedPass: true, commitMessage: null } }];
    serve(detail);
    await act(async () => { root.render(<DashboardPage />); });
    await act(async () => { await Promise.resolve(); });
  }
  const line = () => Array.from(host.querySelectorAll('p')).map((one) => one.textContent ?? '').find((text) => text.startsWith('Requirements:')) ?? '';

  it('one task waiting: the countersignature opens the next phase, never a revision', async () => {
    await mountDashboard(phaseDetail(false), 'main');
    expect(line()).toBe("Requirements: your work passed review. Your teacher's countersignature opens the next phase.");
  });

  it('a split phase, the review names its task: the same line', async () => {
    await mountDashboard(splitDetail(false), 'story');
    expect(line()).toBe("Requirements: your work passed review. Your teacher's countersignature opens the next phase.");
  });

  it('a split phase with a required task still open: the work passed, nothing promised of the countersignature', async () => {
    const detail = splitDetail(false);
    (detail.tasks as PhaseTaskView[])[1] = { ...(detail.tasks as PhaseTaskView[])[1], status: 'in_progress', awaitingSignOff: false };
    await mountDashboard(detail, 'story');
    expect(line()).toBe('Requirements: your work passed review. Open it to see the evidence it accepted.');
  });

  it('after the countersignature: the work passed, no revision asked for', async () => {
    await mountDashboard(phaseDetail(true), 'main');
    expect(line()).toBe('Requirements: your work passed review. Open it to see the evidence it accepted.');
  });
});
