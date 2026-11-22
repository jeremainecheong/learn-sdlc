// @vitest-environment jsdom
/**
 * The change request page of a Maintenance the learner has passed, drawn by the REAL page (the rig is
 * change-room-page.test.tsx's: the shell's held project and the network stood in for).
 *
 * - The Change impact card is a direct child of the document's scrolling flex column and clips its overflow,
 *   so it must not shrink (it could be squeezed to 2 px). Every child of that column that clips keeps its height.
 * - "Retry this task" on a passed change request is read inside the header's Details, not in the body under
 *   the Pass; pressing it keeps Details open. "Start this task over" on a task in progress stays in the body.
 * - Once the project is completed the pull request line says merged, and the band says the project is
 *   complete; before that both keep their in-progress words.
 * - On a passed phase the maintainer names a blank clause without calling the contract "not a contract".
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_OLDER_FORMAT_ROOM, CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest,
  type ChangeRequest, type EnrollmentView, type PhaseDetail, type PhaseKey, type PhaseSummary, type PhaseTaskView, type SubmissionView,
} from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import { readVersionedWorkspaceDraft } from '@/lib/api-workspace';
import { readChangeTouched, recordChangeTouched } from '@/components/workspace/panels/maintenance/change-edit';
import { NAME_THE_OPERATION_FIRST } from '@/components/workspace/panels/maintenance/contracts';
import { AGENT_ROOM_UNSAVED } from '@/components/workspace/mentor/roomUnsaved';

const PHASE_ID = 'change-room-page';
const rig = vi.hoisted(() => ({ project: null as unknown, request: vi.fn(), fetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 'change-room-page' }),
  usePathname: () => '/workspace/change-room-page/change',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    request: rig.request,
    getToken: () => 'change-token',
    api: {
      ...real.api,
      phase: (id: string) => rig.request('GET', `/phases/${id}`),
      submit: (id: string) => rig.request('POST', `/phases/${id}/submit`),
      getSubmission: (id: string) => rig.request('GET', `/submissions/${id}`),
      saveWorkspace: (id: string, files: Record<string, string>, baseVersion?: string) => rig.request('PUT', `/phases/${id}/workspace`, { files, baseVersion }),
      advance: (id: string) => rig.request('POST', `/phases/${id}/advance`),
    },
  };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'change-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
  getSession: () => ({ id: 'change-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));

import ChangeRequestPage from '@/app/(app)/workspace/[phaseId]/change/page';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const CODE = 'api/repository/comments.py';
const CONTRACTS = 'design/contracts.json';
const VERSION = '2026-10-16T00:50:00.000Z';
const CHANGE: NonNullable<PhaseDetail['change']> = {
  ticket: {
    id: 'CR-2',
    title: 'Comments on a task',
    summary: 'Users want to leave comments on a task.',
    acceptance: [
      { id: 'AC-1', line: 'A comment can be added to a task.' },
      { id: 'AC-2', line: 'The comments of a task are listed oldest first.' },
    ],
  },
  contract: true,
  floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true },
};
const V1 = { name: 'list_tasks(conn)', satisfies: 'US-1', inputs: 'A connection.', returns: 'Every task.', errors: 'None.' };
const contractsWith = (...operations: object[]) => `${JSON.stringify({ operations: [V1, ...operations] }, null, 2)}\n`;
const naming = (operation: string): ChangeRequest => ({ ...EMPTY_CHANGE_REQUEST, impact: { ...EMPTY_CHANGE_REQUEST.impact, operations: [operation] } });

const theTask = (): PhaseTaskView =>
  ({
    key: 'main', order: 1, required: true, title: 'The change', artefactType: 'code', primaryPath: CODE, files: [CODE],
    evidence: 'automated', sealed: true, status: 'in_progress', awaitingSignOff: false, attempts: 0, bestScore: null,
    passedAt: null, lastSubmissionId: null, resetAt: null, solution: { available: false, files: 0, readAt: null },
  }) as unknown as PhaseTaskView;

function changeDetail({ record, contracts = contractsWith(), mounted = true, lastSubmission = null }: { record?: string; contracts?: string; mounted?: boolean; lastSubmission?: SubmissionView | null } = {}): PhaseDetail {
  return {
    id: PHASE_ID, key: 'maintenance', order: 6, place: 6, count: 6, title: 'Maintenance', status: 'in_progress', attempts: 0, bestScore: null, reflection: null,
    passedAt: null, opensAt: null, dueAt: null, projectSlug: 'tasktrackr',
    intro: 'The change.', taskPanel: 'The brief.', objectives: [], artifactKind: 'code', change: CHANGE,
    files: [
      { path: CODE, content: 'def list_comments(conn, task_id):\n    return []\n', editable: true, language: 'python' },
      { path: CONTRACTS, content: contracts, editable: true, language: 'json' },
      ...(mounted ? [{ path: CHANGE_REQUEST_JSON, content: record ?? serialiseChangeRequest(EMPTY_CHANGE_REQUEST), editable: true, language: 'json' }] : []),
    ],
    rubric: { passThreshold: 70, criteria: [] },
    tasks: [theTask()],
    taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
    canRun: false, canPreview: false, runLabel: 'Run tests', links: [], lastSubmission,
    updatedAt: VERSION, workspaceUpdatedAt: VERSION, stakeholder: null, scenario: 'reference',
    provenance: { phaseKey: 'maintenance', referenceName: 'TaskTrackr', rollup: 'reference', intro: 'reference', interview: null, files: [], tasks: [], roomTask: 'main', application: 'TaskTrackr' },
  } as unknown as PhaseDetail;
}

function shell(detail: PhaseDetail) {
  const phases = KEYS.map((key, at) =>
    key === 'maintenance'
      ? ({ ...detail, view: undefined } as unknown as PhaseSummary)
      : ({ id: `p-${key}`, key, order: at + 1, title: key, status: 'passed', attempts: 1, bestScore: 90, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'reference' } as PhaseSummary),
  );
  const enrollment = {
    id: 'change-enrolment', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr — the reference', currentPhaseOrder: 6, completed: false,
    startedAt: '2026-10-16T00:00:00Z', completedAt: null, projectIsDefault: true, phases, releases: [],
  } as unknown as EnrollmentView;
  return { enrollment, currentPhase: phases[5], details: { [PHASE_ID]: detail }, analytics: null, loading: false, revalidating: false, error: '', reload: () => Promise.resolve() };
}

import { ProjectContext } from '@/lib/project-context';
import { settle } from './support/dom';

const calls: string[] = [];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  rig.request.mockReset();
  rig.fetch.mockReset();
  vi.stubGlobal('fetch', rig.fetch);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type Shell = ReturnType<typeof shell>;
async function mount(detail: PhaseDetail, project: (held: Shell) => Shell = (held) => held) {
  rig.project = project(shell(detail));
  rig.request.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail;
    // What a retry would change, as the API plans it.
    if (method === 'GET' && path.endsWith('/reset')) return { restores: [], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: { wholePhase: false, keeps: 'Your pass is kept.' } };
    return [];
  });
  rig.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify(String(input).endsWith(`/phases/${PHASE_ID}`) ? detail : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  // As the shell renders the page: inside the provider's context (which the gate band reads).
  await act(async () => { root.render(<ProjectContext.Provider value={rig.project as never}><ChangeRequestPage /></ProjectContext.Provider>); });
  await settle(6);
  expect(host.querySelector('[data-testid="change-page"]'), 'the change room is drawn').not.toBeNull();
}
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const tab = (label: string) => act(() => {
  [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
});

/** A Maintenance the learner passed: the phase, its one task and its first submission. */
function passedDetail(over: { contracts?: string } = {}): PhaseDetail {
  const submission = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: VERSION, report: null } as unknown as SubmissionView;
  const detail = changeDetail({ lastSubmission: submission, contracts: over.contracts });
  return {
    ...detail, status: 'passed', attempts: 1, bestScore: 100, passedAt: VERSION,
    tasks: [{ ...theTask(), files: [CODE, CHANGE_REQUEST_JSON], status: 'passed', attempts: 1, bestScore: 100, passedAt: VERSION, lastSubmissionId: 'rev-1' }],
    taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
  } as PhaseDetail;
}
const completed = (held: Shell): Shell => ({ ...held, enrollment: { ...held.enrollment, completed: true, completedAt: '2026-11-17T09:00:00Z' } as EnrollmentView });
const prLine = () => [...host.querySelectorAll('.label-sm')].map((el) => el.textContent ?? '').find((line) => /^PR-6 /.test(line));

/**
 * The flex items of the document's scrolling column: its children, looking through a box drawn `contents` (the
 * change page's hold box takes no part in the layout, so its children are the column's items).
 */
function columnItems(): HTMLElement[] {
  const column = host.querySelector<HTMLElement>('.phase-document-content')!;
  const items = (parent: Element): HTMLElement[] =>
    [...parent.children].flatMap((child) => (child.classList.contains('contents') ? items(child) : [child as HTMLElement]));
  return items(column);
}
const clips = (el: HTMLElement) => /(^|\s)overflow-(hidden|auto|x-auto|y-auto|scroll)(\s|$)/.test(el.className);

describe('the Change impact card keeps its height in the scrolling column', () => {
  it('the card is one of the column\'s own items, and it does not shrink', async () => {
    await mount(passedDetail());
    const impact = q('phase-maintenance-impact')!;
    expect(columnItems()).toContain(impact);
    expect(clips(impact)).toBe(true);
    expect(impact.classList.contains('shrink-0')).toBe(true);
  });

  it('no item of the column that clips its overflow can be squeezed, on every tab of the page', async () => {
    await mount(passedDetail());
    for (const label of ['Request', 'Contract', 'Checks', 'Release']) {
      await tab(label);
      const squeezable = columnItems().filter((item) => clips(item) && !item.classList.contains('shrink-0'));
      expect(squeezable.map((item) => item.getAttribute('data-testid') ?? item.className), label).toEqual([]);
    }
  });
});

describe('Retry on a passed change request is read in the header\'s Details', () => {
  it('passed: "Retry this task" sits inside Details, not in the body under the Pass', async () => {
    await mount(passedDetail());
    const retry = q('task-reset-open')!;
    expect(retry.textContent).toBe('Retry this task');
    expect(retry.closest('details.phase-strip-details')).not.toBeNull();
    expect(host.querySelector('.phase-document-content [data-testid="task-reset"]')).toBeNull();
    // a secondary control, as it was
    expect(retry.className).toContain('btn-secondary');
  });

  it('pressing it keeps Details open, so its confirm stays in view', async () => {
    await mount(passedDetail());
    const details = q('task-reset-open')!.closest('details') as HTMLDetailsElement;
    details.open = true;
    await act(async () => { q('task-reset-open')!.click(); });
    await settle(6);
    expect(details.open).toBe(true);
    // its confirm is up, inside the open Details
    expect(details.querySelector('[data-testid="task-reset-dialog"]')).not.toBeNull();
  });

  /*
   * A retry that goes ahead turns the task back to in progress. The control must stay where it was
   * pressed (inside Details) for the rest of the visit: moved back to the body it would be drawn afresh, losing its
   * own sentence ("This task is open for a new attempt. ...") and the focus its confirm hands back.
   */
  it('a retry pressed from Details keeps its own sentence and hands focus back to the control', async () => {
    const passed = passedDetail();
    await mount(passed);
    const reopened = { ...passed, status: 'in_progress', tasks: [{ ...passed.tasks![0], status: 'in_progress', resetAt: VERSION }] } as PhaseDetail;
    const base = rig.request.getMockImplementation()!;
    rig.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path.endsWith('/reset')) {
        calls.push(`${method} ${path}`);
        return { version: '2026-10-16T01:00:00.000Z', workspace: {}, task: reopened.tasks![0] };
      }
      if (method === 'GET' && path === `/phases/${PHASE_ID}`) {
        calls.push(`${method} ${path}`);
        return reopened;
      }
      return base(method, path, body);
    });
    const details = q('task-reset-open')!.closest('details') as HTMLDetailsElement;
    details.open = true;
    await act(async () => { q('task-reset-open')!.click(); });
    await settle(6);
    await act(async () => { q('task-reset-confirm')!.click(); });
    await settle(6);
    expect(calls).toContain(`POST /phases/${PHASE_ID}/tasks/main/reset`);
    // the task is in progress again, and the control is still the one in Details, with what it said
    const control = q('task-reset-open')!;
    expect(control.textContent).toBe('Start this task over');
    expect(control.closest('[data-testid="change-retry-details"]')).not.toBeNull();
    expect(q('task-reset-status')?.textContent).toBe('This task is open for a new attempt. Your earlier pass stays in your history.');
    expect(document.activeElement).toBe(control);
    expect(host.querySelectorAll('[data-testid="task-reset"]')).toHaveLength(1);
  });

  it('in progress: "Start this task over" stays in the body, where it was, and nothing is added to Details', async () => {
    const detail = changeDetail();
    await mount({ ...detail, tasks: [{ ...theTask(), files: [CODE, CHANGE_REQUEST_JSON] }] } as PhaseDetail);
    const reset = q('task-reset-open')!;
    expect(reset.textContent).toBe('Start this task over');
    expect(reset.closest('.phase-document-content')).not.toBeNull();
    expect(reset.closest('details')).toBeNull();
    expect(q('change-retry-details')).toBeNull();
  });
});

describe('a completed project reads as merged and complete on the change request', () => {
  it('before completion: "PR-6 open, submission 1" and the band offers Complete the project', async () => {
    await mount(passedDetail());
    expect(prLine()).toBe('PR-6 open, submission 1');
    expect(q('open-reflection')?.textContent).toBe('Complete the project');
  });

  /*
   * Complete the project pressed in this room. The advance's answer (the project completed) reaches
   * the shell's enrolment a moment before the router reaches /complete; in that moment the line under the title keeps
   * "open", as the band keeps "Ready to continue", until the next page replaces the room.
   */
  it('the moment after this room\'s own Complete the project: still "PR-6 open, submission 1" until /complete opens', async () => {
    const detail = passedDetail();
    await mount(detail);
    const base = rig.request.getMockImplementation()!;
    let answered: EnrollmentView | null = null;
    rig.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path.endsWith('/advance')) {
        calls.push(`${method} ${path}`);
        answered = completed(shell(detail)).enrollment;
        return answered;
      }
      return base(method, path, body);
    });
    await act(async () => { q('open-reflection')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!.click(); });
    await settle(6);
    expect(calls).toContain(`POST /phases/${PHASE_ID}/advance`);
    // the shell adopts the advance's answer, and the router has not left
    rig.project = completed(shell(detail));
    await act(async () => { root.render(<ProjectContext.Provider value={rig.project as never}><ChangeRequestPage /></ProjectContext.Provider>); });
    await settle(6);
    expect((rig.project as Shell).enrollment.completed).toBe(true);
    expect(prLine()).toBe('PR-6 open, submission 1');
    expect(q('gate-banner')?.getAttribute('data-gate')).toBeNull();
  });

  it('a Complete the project that failed lets the line go: once the project is completed elsewhere it reads merged', async () => {
    const detail = passedDetail();
    await mount(detail);
    const base = rig.request.getMockImplementation()!;
    rig.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path.endsWith('/advance')) throw new ApiError(500, 'The project could not be completed.');
      return base(method, path, body);
    });
    await act(async () => { q('open-reflection')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!.click(); });
    await settle(6);
    expect(prLine()).toBe('PR-6 open, submission 1');
    rig.project = completed(shell(detail));
    await act(async () => { root.render(<ProjectContext.Provider value={rig.project as never}><ChangeRequestPage /></ProjectContext.Provider>); });
    await settle(6);
    expect(prLine()).toBe('PR-6 merged, submission 1');
  });

  it('after completion: "PR-6 merged, submission 1" and the band says the project is complete, with no second Complete', async () => {
    await mount(passedDetail(), completed);
    expect(prLine()).toBe('PR-6 merged, submission 1');
    expect(q('gate-banner')?.getAttribute('data-gate')).toBe('complete');
    expect(q('gate-banner')?.textContent).toContain('The project is complete.');
    expect(q('open-reflection')).toBeNull();
    expect(host.textContent).not.toContain('Complete the project');
  });
});

describe('the maintainer\'s words on a passed phase', () => {
  const blank = { name: 'add_comment(conn, task_id, author, body)', satisfies: 'CR-2', inputs: '', returns: 'The comment.', errors: '' };
  it('passed: the blank clauses are named, without "is not a contract"', async () => {
    const detail = passedDetail({ contracts: contractsWith(blank) });
    detail.files = detail.files.map((file) => (file.path === CHANGE_REQUEST_JSON ? { ...file, content: serialiseChangeRequest(naming('add_comment')) } : file));
    await mount(detail);
    await tab('Contract');
    const card = q('phase-maintenance-contracts-v2')!.textContent ?? '';
    expect(card).toContain('Maintainer: “Inputs and Errors are still blank.”');
    expect(card).not.toContain('is not a contract');
  });
  it('in progress: the maintainer still says why a blank clause matters', async () => {
    await mount(changeDetail({ record: serialiseChangeRequest(naming('add_comment')), contracts: contractsWith(blank) }));
    await tab('Contract');
    expect(q('phase-maintenance-contracts-v2')!.textContent).toContain('Inputs and Errors are still blank. A contract the reader cannot check is not a contract.');
  });
});

/*
 * After the one press of Complete the project. The Release card's line under its heading says the merge happened,
 * not that the record is assembled "when PR-6 merges" over its own "PR-6 merged.". Details offers the retry and
 * "Submit PR-6 again" on a completed project: a retry after completion is a designed path ("Your project stays
 * complete.") and needs a Submit after it. A passed Maintenance not yet completed keeps its in-progress words.
 */
describe('the change request of a completed project', () => {
  /** The completed enrolment with the release row the merge wrote (no merge message), as the local look had it. */
  const finished = (held: Shell): Shell => {
    const done = completed(held);
    return { ...done, enrollment: { ...done.enrollment, releases: [{ id: 'r6', enrollmentId: 'change-enrolment', phaseKey: 'maintenance', phaseOrder: 6, version: '2.1.0', score: 100, notes: null, createdAt: '2026-11-17T09:00:00Z' }] } as unknown as EnrollmentView };
  };
  const purpose = () => q('phase-maintenance-release')!.querySelector('p')?.textContent ?? '';

  it('completed: Details still offers the retry and "Submit PR-6 again"; the Release card says PR-6 merged', async () => {
    await mount(passedDetail(), finished);
    expect(q('task-reset-open')?.textContent).toBe('Retry this task');
    expect(q('task-reset-open')!.closest('[data-testid="change-retry-details"]')).not.toBeNull();
    expect(q('phase-maintenance-submit')?.textContent).toContain('Submit PR-6 again');
    // the Regression card's own Submit, on the Checks tab
    await tab('Checks');
    const regression = q('phase-maintenance-regression') ?? q('phase-maintenance-regression-empty');
    expect(Array.from(regression!.querySelectorAll('button')).map((one) => one.textContent ?? '').some((word) => word.includes('Submit PR-6 again'))).toBe(true);
    await tab('Release');
    const card = q('phase-maintenance-release')!.textContent ?? '';
    expect(card).toContain('Assembled from CR-2 and your change request, published when PR-6 merged.');
    expect(card).toContain('PR-6 merged. No merge message was written.');
    expect(card).not.toContain('when PR-6 merges');
    // the doors that only read stay
    expect(q('open-workspace')?.textContent).toBe('Open the workspace');
  });

  it('passed and not completed, Details still offers the retry and "Submit PR-6 again", and the card waits on the merge', async () => {
    await mount(passedDetail());
    expect(q('task-reset-open')?.textContent).toBe('Retry this task');
    expect(q('phase-maintenance-submit')?.textContent).toContain('Submit PR-6 again');
    await tab('Release');
    expect(q('phase-maintenance-release')!.textContent).toContain('Assembled from CR-2, your change request and the merge message when PR-6 merges.');
    expect(purpose()).not.toBe('');
  });
});
