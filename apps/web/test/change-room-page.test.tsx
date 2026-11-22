// @vitest-environment jsdom
/**
 * The change room over the teacher's change request, drawn by the REAL page.
 *
 * - The Contract card claims and adds the operation the record's impact names
 *   (`impact.operations`), never a contract path and never the ticket id; with
 *   none named, Add is off and one sentence points at the Request tab.
 * - A record that cannot be read leaves the forms read-only, and "Start empty"
 *   (after a confirm line) writes the empty record through the same save.
 * - An unmounted record leaves the forms read-only.
 * - The Checks tab lists the report's verdict on each acceptance line, and stays in
 *   the older format with its control off and the older sentence (spec 5.3).
 * - Submit ends the assistant's marks.
 * - The room says while it holds an unsaved edit, so a record proposal's
 *   Apply waits for the change request's save (the `roomUnsaved` bridge).
 *
 * The rig is change-room-in-flight-submit.test.tsx's: the shell's held project and the
 * network stood in for.
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
import { WORKSPACE_SAVE_DELAY_MS } from '@/components/workspace/useVersionedWorkspaceSave';

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
import { settle, typeInto } from './support/dom';

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

async function mount(detail: PhaseDetail, network: { submit?: () => SubmissionView } = {}) {
  rig.project = shell(detail);
  rig.request.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail;
    if (path.includes('/submit') && network.submit) return network.submit();
    return [];
  });
  rig.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify(String(input).endsWith(`/phases/${PHASE_ID}`) ? detail : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await act(async () => { root.render(<ChangeRequestPage />); });
  await settle(6);
  expect(host.querySelector('[data-testid="change-page"]'), 'the change room is drawn').not.toBeNull();
}
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const tab = (label: string) => act(() => {
  [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
});
const press = (testId: string) => act(() => { q(testId)!.click(); });
const drafted = (path: string) => readVersionedWorkspaceDraft(PHASE_ID)?.files[path];
const text = () => host.textContent ?? '';

describe('the Contract card claims the operation the change request names', () => {
  it('a fresh record names none: Add is off, one sentence points at the Request tab, and the ticket id is never the operation', async () => {
    await mount(changeDetail());
    await tab('Contract');
    const add = q('phase-maintenance-contract-v2-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.textContent).toBe('Add the contract');
    expect(q('phase-maintenance-contract-v2-unnamed')?.textContent).toBe(NAME_THE_OPERATION_FIRST);
    expect(text()).not.toContain('Add the CR-2 contract');
    expect(text()).not.toContain('Nothing claims CR-2');
    expect(text()).toContain('Nothing claims the operation CR-2 adds yet.');
    expect(drafted(CONTRACTS)).toBeUndefined();
  });

  it('a record naming add_comment finds add_comment(...) in design/contracts.json by its name', async () => {
    const written = { name: 'add_comment(conn, task_id, author, body)', satisfies: 'CR-2', inputs: 'A task id.', returns: 'The comment.', errors: 'Unknown task.' };
    await mount(changeDetail({ record: serialiseChangeRequest(naming('add_comment')), contracts: contractsWith(written) }));
    await tab('Contract');
    expect(q('phase-maintenance-contract-v2-add')).toBeNull();
    expect(q('phase-maintenance-contracts-v2')?.textContent).toContain('add_comment');
    expect((q('phase-maintenance-contract-inputs') as HTMLTextAreaElement).value).toBe('A task id.');
    expect(text()).toContain('The contract answers what CR-2 asked for.');
  });

  it('a record naming add_comment with no contract for it: Add writes add_comment into design/contracts.json', async () => {
    await mount(changeDetail({ record: serialiseChangeRequest(naming('add_comment')) }));
    await tab('Contract');
    const add = q('phase-maintenance-contract-v2-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(add.textContent).toBe('Add the add_comment contract');
    expect(q('phase-maintenance-contract-v2-unnamed')).toBeNull();
    expect(text()).toContain('Nothing claims add_comment yet.');
    await press('phase-maintenance-contract-v2-add');
    const operations = JSON.parse(drafted(CONTRACTS)!).operations as { name: string; satisfies: string }[];
    expect(operations.map((op) => op.name)).toEqual(['list_tasks(conn)', 'add_comment']);
    expect(operations[1].satisfies).toBe('CR-2');
    expect(text()).toContain(`add_comment added to ${CONTRACTS}.`);
  });
});

describe('a record the room cannot write over', () => {
  it('an unreadable record: the forms are read-only, and Start empty writes the empty record after its confirm line', async () => {
    await mount(changeDetail({ record: '{' }));
    const notice = q('change-record-unreadable')!;
    expect(notice.textContent).toMatch(/^The change request cannot be read \(the change request record is not valid JSON\)\./);
    // Read-only: no impact input, no Add, and an amendment field that does not take typing.
    expect(q('change-impact-operations-input')).toBeNull();
    expect(q('change-impact-operations-add')).toBeNull();
    await tab('Contract');
    expect(q('change-amendment-add')).toBeNull();
    // The confirm line first; Keep it writes nothing.
    await press('change-start-empty');
    expect(q('change-start-empty-line')?.textContent).toContain('replaces the change request with an empty one');
    await press('change-start-empty-keep');
    expect(q('change-start-empty-line')).toBeNull();
    expect(drafted(CHANGE_REQUEST_JSON)).toBeUndefined();
    // Start empty writes the empty record through the page's save, and the forms take typing again.
    await press('change-start-empty');
    await press('change-start-empty-confirm');
    expect(drafted(CHANGE_REQUEST_JSON)).toBe(serialiseChangeRequest(EMPTY_CHANGE_REQUEST));
    expect(q('change-record-unreadable')).toBeNull();
    expect(q('change-amendment-add')).not.toBeNull();
    await tab('Request');
    expect(q('change-impact-operations-input')).not.toBeNull();
  });

  it('an unmounted record: the forms are read-only, and nothing offers to write it', async () => {
    await mount(changeDetail({ mounted: false }));
    expect(q('change-ticket')).not.toBeNull();
    expect(q('change-impact-operations-input')).toBeNull();
    expect(q('change-start-empty')).toBeNull();
    await tab('Release');
    expect((q('change-release-version') as HTMLInputElement).readOnly).toBe(true);
    expect(q('change-line-add')).toBeNull();
  });
});

describe('the Checks tab', () => {
  it('lists each acceptance line with its verdict: before a submit, and from the report once the change tests ran', async () => {
    await mount(changeDetail());
    await tab('Checks');
    let card = q('phase-maintenance-acceptance')!;
    expect(card.textContent).toContain('AC-1 A comment can be added to a task.');
    expect(card.textContent).toContain('AC-2 The comments of a task are listed oldest first.');
    expect(card.textContent).toContain('Checked by the hidden change tests when you submit PR-6');
    act(() => root.unmount());
    root = createRoot(host);
    const report = {
      passed: false, score: 40,
      tests: { passed: 0, failed: 1, total: 1, cases: [{ name: 'test_change_comments', status: 'failed', hidden: true }] },
      impact: { changeTests: ['test_change_comments'] },
    };
    const verdict = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: false, score: 40, attempt: 1, createdAt: VERSION, report } as unknown as SubmissionView;
    await mount(changeDetail({ lastSubmission: verdict }));
    await tab('Checks');
    card = q('phase-maintenance-acceptance')!;
    expect(card.textContent).toContain('Checked by the change tests, failed');
  });

  it('a record that covers nothing reads the change tests\' result', async () => {
    const report = {
      passed: true, score: 100,
      tests: { passed: 1, failed: 0, total: 1, cases: [{ name: 'test_change_comments', status: 'passed', hidden: true }] },
      impact: { changeTests: ['test_change_comments'] },
    };
    const verdict = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: VERSION, report } as unknown as SubmissionView;
    await mount(changeDetail({ lastSubmission: verdict }));
    await tab('Checks');
    const card = q('phase-maintenance-acceptance')!.textContent ?? '';
    expect(card).toContain('AC-1 A comment can be added to a task.Checked by the change tests, passedAC-2');
    expect(card).toMatch(/AC-2 The comments of a task are listed oldest first\.Checked by the change tests, passed$/);
    expect(card).not.toContain('Checked by test_change_comments');
    expect(card).toContain('Each acceptance line of the ticket, and what its tests show.');
  });

  it('TaskTrackr, a filled record: T1 names tests/test_comments_api.py for AC-1 and AC-2, so both rows read the entry and the visible run, five names and the rest counted', async () => {
    const record: ChangeRequest = {
      ...EMPTY_CHANGE_REQUEST,
      impact: { operations: ['add_comment', 'list_comments'], screens: [], files: [CODE] },
      tests: [{ id: 'T1', suite: 'tests/test_comments_api.py', covers: ['AC-1', 'AC-2'], result: 'pass' }],
    };
    const visible = [
      'CommentsApi.test_add_comment_returns_the_comment', 'CommentsApi.test_list_comments_oldest_first', 'CommentsApi.test_unknown_task_is_404',
      'TasksApi.test_list_tasks', 'TasksApi.test_create_task', 'ListsApi.test_list_lists', 'ListsApi.test_create_list',
    ];
    const change = ['CommentChange.test_a_comment_is_stored_with_its_author_and_body', 'CommentChange.test_comments_come_back_newest_first'];
    const cases = [...visible.map((name) => ({ name, status: 'passed' })), ...change.map((name) => ({ name, status: 'passed', hidden: true }))];
    const report = { passed: true, score: 100, tests: { passed: 9, failed: 0, total: 9, cases }, impact: { changeTests: change } };
    const verdict = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: VERSION, report } as unknown as SubmissionView;
    await mount(changeDetail({ record: serialiseChangeRequest(record), lastSubmission: verdict }));
    await tab('Checks');
    const card = q('phase-maintenance-acceptance')!.textContent ?? '';
    const evidence =
      'T1 (tests/test_comments_api.py) covers AC-1 and AC-2 together. Your visible tests, 7 of 7 passed: test_add_comment_returns_the_comment; test_list_comments_oldest_first; test_unknown_task_is_404; test_list_tasks; test_create_task and 2 more.';
    expect(card).toBe(
      `AcceptanceEach acceptance line of the ticket, and what its tests show.Acceptance lineAC-1 A comment can be added to a task.${evidence}AC-2 The comments of a task are listed oldest first.${evidence}`,
    );
  });

  it('one entry covering both items reads the entry and the visible run under each, never one case alone', async () => {
    const deadline: NonNullable<PhaseDetail['change']> = {
      ...CHANGE,
      ticket: {
        id: 'CR-1', title: 'Completed tasks are not overdue', summary: 'A task that is done never shows the overdue badge, whatever its due date.',
        acceptance: [
          { id: 'AC-1', line: 'A completed task is never overdue, whatever its due date.' },
          { id: 'AC-2', line: 'An open task is overdue only when its due date is before today, as before.' },
        ],
      },
      contract: false,
    };
    const record: ChangeRequest = {
      ...EMPTY_CHANGE_REQUEST,
      impact: { operations: ['isOverdue'], screens: [], files: ['web/src/lib/overdue.ts'] },
      tests: [{ id: 'T1', suite: 'overdue regression tests', covers: ['AC-1', 'AC-2'], result: 'pass' }],
    };
    const visible = ['a task due yesterday is overdue', 'a task due today is not overdue', 'a completed task due yesterday is not overdue'];
    const hidden = [visible[0], visible[1], 'a task due tomorrow is not overdue', 'a task with no due date is not overdue', visible[2]];
    const cases = [...visible.map((name) => ({ name, status: 'passed' })), ...hidden.map((name) => ({ name, status: 'passed', hidden: true }))];
    const report = { passed: true, score: 100, tests: { passed: 8, failed: 0, total: 8, cases }, impact: { changeTests: [visible[2]] } };
    const verdict = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: VERSION, report } as unknown as SubmissionView;
    await mount({ ...changeDetail({ record: serialiseChangeRequest(record), lastSubmission: verdict }), change: deadline } as unknown as PhaseDetail);
    await tab('Checks');
    const card = q('phase-maintenance-acceptance')!.textContent ?? '';
    const evidence =
      'T1 (overdue regression tests) covers AC-1 and AC-2 together. Your visible tests, 3 of 3 passed: a task due yesterday is overdue; a task due today is not overdue; a completed task due yesterday is not overdue.';
    expect(card).toContain(`AC-1 A completed task is never overdue, whatever its due date.${evidence}`);
    expect(card).toContain(`AC-2 An open task is overdue only when its due date is before today, as before.${evidence}`);
    expect(card).not.toContain('Checked by a completed task due yesterday is not overdue');
  });

  it('stays in the older format (no change request) with its control off and the older sentence, and the Contract tab does not', async () => {
    await mount({ ...changeDetail({ mounted: false }), change: undefined } as unknown as PhaseDetail);
    expect(q('change-older-format')!.textContent).toContain(CHANGE_OLDER_FORMAT_ROOM);
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('Checks');
    expect(labels).not.toContain('Contract');
    await tab('Checks');
    const control = host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-regression"] button')!;
    expect(control.disabled).toBe(true);
    expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toBe(CHANGE_OLDER_FORMAT_ROOM);
    // The learner's last verdict still reads there, read-only.
    act(() => root.unmount());
    root = createRoot(host);
    const report = { passed: false, score: 40, tests: { passed: 1, failed: 1, total: 2, cases: [{ name: 'test_list_tasks', status: 'passed' }, { name: 'test_add_task', status: 'failed', hidden: true }] } };
    const verdict = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: false, score: 40, attempt: 1, createdAt: VERSION, report } as unknown as SubmissionView;
    await mount({ ...changeDetail({ mounted: false, lastSubmission: verdict }), change: undefined } as unknown as PhaseDetail);
    await tab('Checks');
    const card = q('phase-maintenance-regression')!;
    expect(card.textContent).not.toContain('No verdict yet');
    expect(card.textContent).toContain('Suite');
  });
});

describe('the assistant\'s marks', () => {
  it('end at the change room\'s Submit', async () => {
    recordChangeTouched(PHASE_ID, { 'release:version': '2.1.0' });
    const started = { id: 'rev-1', taskKey: 'main', status: 'queued', passed: null, score: null, attempt: 1, createdAt: VERSION, report: null } as unknown as SubmissionView;
    await mount(changeDetail(), { submit: () => started });
    expect(readChangeTouched(PHASE_ID)).toEqual({ 'release:version': '2.1.0' });
    await act(async () => { q('phase-maintenance-submit')!.click(); });
    await settle(6);
    expect(calls.some((call) => call.includes('/submit'))).toBe(true);
    expect(readChangeTouched(PHASE_ID)).toEqual({});
  });
});

describe('the room\'s unsaved state', () => {
  it('says unsaved from the first keystroke until the change request\'s save is acknowledged, then saved, and saved again when the room closes', async () => {
    const said: boolean[] = [];
    const listen = (event: Event) => { const detail = (event as CustomEvent<{ phaseId: string; unsaved: boolean }>).detail; if (detail.phaseId === PHASE_ID) said.push(detail.unsaved); };
    window.addEventListener(AGENT_ROOM_UNSAVED, listen);
    try {
      await mount(changeDetail());
      // The save is held open, so the room is seen saving before the server answers.
      let answer!: (saved: { saved: boolean; version: string }) => void;
      const held = new Promise<{ saved: boolean; version: string }>((resolve) => { answer = resolve; });
      const loaded = rig.request.getMockImplementation()!;
      rig.request.mockImplementation((method: string, path: string, ...rest: unknown[]) => {
        if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) { calls.push(`${method} ${path}`); return held; }
        return loaded(method, path, ...rest);
      });
      expect(said.at(-1) ?? false).toBe(false);
      await tab('Release');
      const version = q('change-release-version') as HTMLInputElement;
      await act(async () => {
        typeInto(version, '2.1.0');
      });
      expect(said.at(-1)).toBe(true);
      // Past the autosave delay: the save is sent and still unanswered, so the room is still unsaved.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, WORKSPACE_SAVE_DELAY_MS + 200)); });
      expect(calls.some((call) => call.startsWith('PUT ') && call.endsWith('/workspace'))).toBe(true);
      expect(said.at(-1)).toBe(true);
      await act(async () => { answer({ saved: true, version: '2026-10-16T00:51:00.000Z' }); });
      await settle(6);
      expect(said.at(-1)).toBe(false);
      said.length = 0;
      act(() => root.render(<></>));
      expect(said).toEqual([]);
      // a room left while unsaved stops saying so
      await mount(changeDetail());
      await tab('Release');
      const again = q('change-release-version') as HTMLInputElement;
      await act(async () => {
        typeInto(again, '2.2.0');
      });
      expect(said.at(-1)).toBe(true);
      act(() => root.render(<></>));
      expect(said.at(-1)).toBe(false);
    } finally {
      window.removeEventListener(AGENT_ROOM_UNSAVED, listen);
    }
  });

  for (const [status, words] of [[500, 'The server could not save.'], [409, 'The workspace changed since it was read.']] as const) {
    it(`stays unsaved when the change request's save is refused with a ${status}, so a record proposal's Apply stays held`, async () => {
      const said: boolean[] = [];
      const listen = (event: Event) => { const detail = (event as CustomEvent<{ phaseId: string; unsaved: boolean }>).detail; if (detail.phaseId === PHASE_ID) said.push(detail.unsaved); };
      window.addEventListener(AGENT_ROOM_UNSAVED, listen);
      try {
        await mount(changeDetail());
        const loaded = rig.request.getMockImplementation()!;
        rig.request.mockImplementation((method: string, path: string, ...rest: unknown[]) => {
          if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) { calls.push(`${method} ${path}`); return Promise.reject(new ApiError(status, words)); }
          return loaded(method, path, ...rest);
        });
        await tab('Release');
        const version = q('change-release-version') as HTMLInputElement;
        await act(async () => {
          typeInto(version, '2.1.0');
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, WORKSPACE_SAVE_DELAY_MS + 200)); });
        await settle(6);
        expect(calls.some((call) => call.startsWith('PUT ') && call.endsWith('/workspace'))).toBe(true);
        expect(said.at(-1)).toBe(true);
        act(() => root.render(<></>));
        expect(said.at(-1)).toBe(false);
      } finally {
        window.removeEventListener(AGENT_ROOM_UNSAVED, listen);
      }
    });
  }
});
