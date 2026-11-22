// @vitest-environment jsdom
/**
 * The pull request page and the planted bugs page, each
 * sentence true for the state it is drawn in.
 *
 * - After an Apply, one notice in each state (nothing submitted yet; a
 *   revision whose review the change is not in; a revision waiting on the
 *   teacher), never "submit again" over "Nothing is submitted yet".
 * - The merge card's Submit is "Submit PR-<n>" /
 *   "Submit PR-<n> again" and leads only while handing in is the next step;
 *   the planted bugs page draws no second Submit in its empty grid.
 * - The standing line does not repeat the header's phase
 *   and place, says no "0 of 1 required done" on a phase with one task, and
 *   names the teacher's sign-off when it is the one thing missing.
 * - A first submission's files are drawn whole and said once.
 * - The planted bugs page has one name; no "Kill matrix".
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIX = vi.hoisted(() => ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
const mocks = vi.hoisted(() => ({
  submit: vi.fn(), reload: vi.fn(async () => undefined), reloadProject: vi.fn(async () => undefined),
  apiSubmit: vi.fn(), load: vi.fn(), invalidate: vi.fn(),
  card: [] as Record<string, unknown>[], diff: [] as Record<string, unknown>[], checks: [] as Record<string, unknown>[],
  phase: {} as Record<string, unknown>,
  pr: {} as Record<string, unknown>,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: mocks.phase.id }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => ({
  api: { chat: vi.fn(), submissions: vi.fn(async () => []), submit: mocks.apiSubmit, getSubmission: vi.fn() },
  describeError: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/api-workspace', () => ({ workspaceApi: { phase: mocks.load } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(() => new Promise(() => {})), useRecoverWhenBack: () => {} }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()], commitDraft: () => '', clearCommitDraft: vi.fn() }));
vi.mock('@/lib/useProject', () => ({
  // The six phases, Maintenance last, so the last phase's words are reached.
  useProject: () => ({ details: { [mocks.phase.id as string]: mocks.phase }, enrollment: { projectTitle: 'Deadline badge', phases: SIX.map((key, i) => ({ key, order: i + 1 })), releases: [], currentPhaseOrder: 1 }, analytics: null, currentPhase: null, reload: mocks.reloadProject }),
  fullDetail: () => mocks.phase, invalidateProject: mocks.invalidate,
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({ PhaseDocumentFrame: ({ children, right }: { children: ReactNode; right: ReactNode }) => <div><header>{right}</header>{children}</div> }));
vi.mock('@/components/shell', () => ({ DocPage: () => null, briefHref: () => '/brief', doorWithTasks: (phase: unknown) => phase, phaseDoorHref: () => '/workspace/next', solutionHref: () => '/solution', usePersona: () => null, PERSONA_NAME: {} }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => <div data-testid="mentor" /> }));
vi.mock('@/components/workspace/panels/testing/MatrixDoc', () => ({ MatrixCard: () => null, MatrixRead: () => null, MutantDiff: () => null, PlantedBugs: () => null, WhatToDo: () => null, matrixPurpose: () => '' }));
vi.mock('@/components/workspace/ExplainTest', () => ({ ExplainTestButton: () => null }));
vi.mock('@/components/pr', () => ({
  Conversation: () => null, ChecksCard: () => null, SubmissionsCard: () => null, HistoryCard: () => null,
  ChecksTab: (props: Record<string, unknown>) => { mocks.checks.push(props); return null; },
  DiffView: (props: Record<string, unknown>) => { mocks.diff.push(props); return <div data-testid="diff" />; },
  MergeCard: (props: Record<string, unknown>) => { mocks.card.push(props); return null; },
  gateReason: () => '', prHeadline: () => 'the work',
  usePullRequest: () => mocks.pr,
}));

const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');
const { default: MatrixPage } = await import('@/app/(app)/workspace/[phaseId]/matrix/page');
const { refreshAgentWorkspace } = await import('@/components/workspace/mentor/useAgentWorkspace');
const { AWAITING_SIGN_OFF, signOffPassLine } = await import('@/components/workspace/signoff-status');

const PLACE: Record<string, number> = { implementation: 3, testing: 4, deployment: 5, maintenance: 6 };
const TITLE: Record<string, string> = { implementation: 'Implementation', testing: 'Testing', deployment: 'Deployment', maintenance: 'Maintenance' };
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main', order: 1, required: true, title: 'The work', artefactType: 'code', evidence: 'reviewed', sealed: true,
  status: 'in_progress', awaitingSignOff: false, attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null,
  solution: { available: false, files: 0, readAt: null }, ...over,
});
const head = (passed: boolean) => ({ id: 'rev-1', attempt: 1, score: 100, createdAt: '2026-11-17T03:00:00Z', state: passed ? 'pass' : 'fail', report: { passed, aiReview: { assessmentError: false } } });
const phaseOf = (key: string, over: Record<string, unknown> = {}) => ({
  id: `phase-${key}`, key, title: TITLE[key], order: PLACE[key], place: PLACE[key], count: 6, status: 'in_progress', projectSlug: 'deadline',
  rubric: { criteria: [], passThreshold: 70 }, attempts: 0, reflection: null, files: [], tasks: [task()], taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
  lastSubmission: null, ...over,
});
const prOf = (revisions: unknown[], over: Record<string, unknown> = {}) => ({
  detail: mocks.phase, head: revisions.at(-1) ?? null, threads: [], diffs: [], revisions, gate: 70, fileRevision: revisions.at(-1) ?? null, fileBase: null,
  threadsFor: () => [], selectRevision: vi.fn(), submit: mocks.submit, reload: mocks.reload, retry: vi.fn(), retryFiles: vi.fn(), busy: false,
  filesKept: () => true, loading: false, filesLoading: false, filesPruned: false, baseFilesPruned: false, filesError: '', error: '', notice: '',
  baseAttempt: null, openedAt: '11:07', setError: vi.fn(), setNotice: vi.fn(), ...over,
});

let host: HTMLDivElement, root: Root;
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const drawPr = async (key: string, phase: Record<string, unknown> = {}, revisions: unknown[] = [], pr: Record<string, unknown> = {}) => {
  mocks.phase = phaseOf(key, phase);
  mocks.pr = prOf(revisions, pr);
  await act(async () => root.render(<PullRequestPage />));
};
const drawMatrix = async (phase: Record<string, unknown> = {}) => {
  mocks.phase = phaseOf('testing', phase);
  mocks.load.mockResolvedValue(mocks.phase);
  await act(async () => root.render(<MatrixPage />));
};
const apply = async () => { await act(async () => { await refreshAgentWorkspace(mocks.phase.id as string); }); };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.card.length = 0; mocks.diff.length = 0; mocks.checks.length = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the pull request page after an Apply, one true notice per state', () => {
  it('nothing submitted yet: one notice, no "submit again", no second "Nothing is submitted yet"', async () => {
    await drawPr('testing');
    await apply();
    const note = byTestId('pr-applied-note')!;
    expect(note.textContent).toBe('The reviewed proposal is saved in this workspace. Nothing is submitted yet: Submit PR-4 opens the pull request with it, or open Write tests to see it.');
    expect(host.textContent).not.toMatch(/submit again|last submitted/i);
    expect(host.textContent!.split('Nothing is submitted yet').length - 1).toBe(1);
  });
  it('before an Apply the files tab still says nothing is submitted', async () => {
    await drawPr('testing');
    expect(host.textContent).toContain('Nothing is submitted yet. Submitting opens the pull request and its diff.');
  });
  it('a revision the change is not in: what the page shows, and Submit PR-<n> again', async () => {
    await drawPr('implementation', { attempts: 1 }, [head(false)]);
    await apply();
    expect(byTestId('pr-applied-note')!.textContent).toBe('The reviewed proposal is saved in this workspace. This page shows what you last submitted: Submit PR-3 again to have the change reviewed, or open Code to see it.');
  });
  it('a revision waiting on the teacher: no invitation to hand in', async () => {
    const waiting = task({ evidence: 'signed-off', status: 'submitted', awaitingSignOff: true, attempts: 1, lastSubmissionId: 'rev-1' });
    await drawPr('maintenance', { attempts: 1, tasks: [waiting] }, [head(true)]);
    await apply();
    const note = byTestId('pr-applied-note')!.textContent!;
    expect(note).toContain('which waits for your teacher\'s sign-off');
    expect(note).not.toMatch(/Submit PR-6/);
  });
});

describe('the standing line and the merge card\'s Submit', () => {
  it('no "phase 4 of 6" under the header, no task count on a phase with one task', async () => {
    await drawPr('testing');
    const line = byTestId('pr-standing')!;
    expect(line.textContent).not.toMatch(/phase \d of \d/i);
    expect(line.textContent).not.toContain('Testing');
    expect(byTestId('pr-task-counts')).toBeNull();
    expect(host.textContent).not.toContain('required done');
  });
  it('a split phase keeps its task count', async () => {
    await drawPr('testing', { tasks: [task(), task({ key: 'quiz', order: 2, required: false, artefactType: 'quiz' })], taskCounts: { total: 2, required: 1, passed: 0, passedRequired: 0 } });
    expect(byTestId('pr-task-counts')!.textContent).toContain('0 of 1 required done');
  });
  it('the last phase after a Pass that waits on the teacher: the chip names the sign-off, no "0 of 1", Submit not leading', async () => {
    const waiting = task({ evidence: 'signed-off', status: 'submitted', awaitingSignOff: true, attempts: 1, lastSubmissionId: 'rev-1' });
    await drawPr('maintenance', { attempts: 1, tasks: [waiting] }, [head(true)]);
    expect(byTestId('pr-awaiting-sign-off')!.textContent).toBe(AWAITING_SIGN_OFF);
    expect(byTestId('pr-standing')!.textContent).not.toContain('Pass');
    expect(host.textContent).not.toContain('0 of 1 required done');
    const card = mocks.card.at(-1)!;
    expect(card.submitLabel).toBe('Submit PR-6 again');
    expect(card.submitLeads).toBe(false);
    expect(card.submitReason).toBeTruthy();
    // The phase is the project's last: the card is told so, and says the sign-off then completes the project.
    expect(card.isLast).toBe(true);
    expect(card.signOffPending).toBe(true);
    expect(card.waitLabel).toBe(signOffPassLine(true));
  });
  it('the last phase passed after the sign-off and not merged: "Pass", nothing awaited, Submit not leading, no count', async () => {
    const signed = task({ evidence: 'signed-off', status: 'passed', awaitingSignOff: false, attempts: 1, lastSubmissionId: 'rev-1', passedAt: '2026-11-17T04:00:00Z' });
    await drawPr('maintenance', { attempts: 1, status: 'passed', tasks: [signed], taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 } }, [head(true)]);
    expect(byTestId('pr-standing')!.textContent).toContain('Pass');
    expect(byTestId('pr-standing')!.textContent).not.toContain('Phase completed');
    expect(byTestId('pr-awaiting-sign-off')).toBeNull();
    expect(byTestId('pr-task-counts')).toBeNull();
    const card = mocks.card.at(-1)!;
    expect(card.isLast).toBe(true);
    expect(card.signOffPending).toBe(false);
    expect(card.submitLeads).toBe(false);
    expect(card.submitLabel).toBe('Submit PR-6 again');
  });
  it('a first submission still in review: the chip says Reviewing beside "Opened …, 1 submission"', async () => {
    const queued = { id: 'rev-1', attempt: 1, score: null, createdAt: '2026-11-17T03:00:00Z', state: 'now', report: null };
    await drawPr('implementation', { attempts: 1 }, [queued], { head: null, fileRevision: null });
    const line = byTestId('pr-standing')!.textContent!;
    expect(line).toContain('Reviewing');
    expect(line).toContain('Opened 11:07, 1 submission');
    expect(line).not.toContain('Not opened yet');
    // The Files tab, the default, does not say nothing is submitted under "Reviewing".
    expect(host.textContent).not.toContain('Nothing is submitted yet');
    expect(host.textContent).toContain('Your submission is being reviewed. Its files are shown here when the review is in.');
  });
  it('every submission came back without a report: "Review unavailable", not "Reviewing" or "Not opened yet"', async () => {
    const failed = { id: 'rev-1', attempt: 1, score: null, createdAt: '2026-11-17T03:00:00Z', state: 'fail', report: null };
    await drawPr('implementation', { attempts: 1 }, [failed], { head: null, fileRevision: null });
    const line = byTestId('pr-standing')!.textContent!;
    expect(line).toContain('Review unavailable');
    expect(line).not.toMatch(/Reviewing|Not opened yet/);
    // Nor under "Review unavailable".
    expect(host.textContent).not.toContain('Nothing is submitted yet');
    expect(host.textContent).toContain('No submission has been reviewed yet, so there are no files to compare. Submitting again has it reviewed.');
  });
  it('nothing submitted: the Files tab still says nothing is submitted', async () => {
    await drawPr('implementation');
    expect(host.textContent).toContain('Nothing is submitted yet. Submitting opens the pull request and its diff.');
    expect(host.textContent).not.toMatch(/being reviewed|No submission has been reviewed yet/);
  });
  it('nothing submitted: "Not opened yet"', async () => {
    await drawPr('implementation');
    expect(byTestId('pr-standing')!.textContent).toContain('Not opened yet');
  });
  it('"Submit PR-<n>" leads before a revision and after a review that asked for more; not after a Pass', async () => {
    await drawPr('implementation');
    expect(mocks.card.at(-1)).toMatchObject({ submitLabel: 'Submit PR-3', submitLeads: true });
    act(() => root.unmount()); root = createRoot(host);
    await drawPr('implementation', { attempts: 1 }, [head(false)]);
    expect(mocks.card.at(-1)).toMatchObject({ submitLabel: 'Submit PR-3 again', submitLeads: true });
    act(() => root.unmount()); root = createRoot(host);
    await drawPr('implementation', { attempts: 1, status: 'passed', tasks: [task({ status: 'passed', attempts: 1 })] }, [head(true)]);
    expect(mocks.card.at(-1)).toMatchObject({ submitLabel: 'Submit PR-3 again', submitLeads: false });
  });
});

describe('the first submission\'s files', () => {
  const diff = { path: 'web/src/lib/overdue.ts', adds: 13, dels: 0, hunks: [], lines: 13, added: true };
  it('are drawn whole and said once', async () => {
    await drawPr('implementation', { attempts: 1 }, [head(true)], { diffs: [diff] });
    expect(mocks.diff.at(-1)?.whole).toBe(true);
    const notice = byTestId('pr-files-revision')!.textContent!;
    expect(notice).toContain('Submission 1, the first: each file is shown whole, as you handed it in, not as a change.');
    expect(host.textContent).not.toContain('showing the saved files as additions');
    expect(host.textContent).not.toContain('No earlier submitted revision');
  });
  it('an earlier submission came back with no report: not "the first", and still drawn whole', async () => {
    const ungraded = { id: 'rev-1', attempt: 1, score: null, createdAt: '2026-11-17T02:00:00Z', state: 'fail', report: null };
    const graded = { ...head(true), id: 'rev-2', attempt: 2 };
    await drawPr('implementation', { attempts: 2 }, [ungraded, graded], { diffs: [diff] });
    expect(mocks.diff.at(-1)?.whole).toBe(true);
    const notice = byTestId('pr-files-revision')!.textContent!;
    expect(notice).toContain('Submission 2. No earlier reviewed submission to compare with: each file is shown whole, as you handed it in, not as a change.');
    expect(notice).not.toContain('the first');
  });
  it('past the newest 50 the list holds, an oldest listed submission numbered 51 is not "the first"', async () => {
    const listed = { ...head(true), id: 'rev-51', attempt: 51 };
    await drawPr('implementation', { attempts: 51 }, [listed], { diffs: [diff] });
    const notice = byTestId('pr-files-revision')!.textContent!;
    expect(notice).toContain('Submission 51. No earlier reviewed submission to compare with');
    expect(notice).not.toContain('the first');
  });
  it('a later submission is compared with the one before it, as a change', async () => {
    const first = head(false);
    const second = { ...head(true), id: 'rev-2', attempt: 2 };
    await drawPr('implementation', { attempts: 2 }, [first, second], { diffs: [diff], fileBase: first, baseAttempt: 1 });
    expect(mocks.diff.at(-1)?.whole).toBe(false);
    expect(byTestId('pr-files-revision')!.textContent).toContain('compared with submission 1.');
  });
  it('the checks are given the phase\'s floors', async () => {
    await drawPr('deployment', { attempts: 1, runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true } }, [head(true)]);
    await act(async () => byTestId('pr-tab-checks')!.click());
    expect((mocks.checks.at(-1)?.floors as { runbook?: unknown })?.runbook).toBeTruthy();
  });
});

describe('the planted bugs page', () => {
  it('before any submission: no second Submit, no "Kill matrix", and the empty grid says nothing has run', async () => {
    await drawMatrix();
    const grid = byTestId('phase-testing-matrix')!;
    expect(grid.querySelector('button')).toBeNull();
    expect(grid.textContent).toContain('No planted bugs have run yet');
    expect(grid.textContent).toContain('Submit PR-4, at the top of the page');
    // The page's document (the header's controls and their reasons are another builder's).
    const doc = [...host.querySelector('div')!.children].filter((one) => one.tagName !== 'HEADER').map((one) => one.textContent).join(' ');
    expect(doc).not.toMatch(/kill matrix/i);
    expect([...host.querySelectorAll('button')].filter((b) => /Submit PR-4/.test(b.textContent ?? ''))).toHaveLength(1);
  });
  it('after an Apply with nothing submitted: no planted bug has run, and no "submit again"', async () => {
    await drawMatrix();
    await apply();
    const note = byTestId('matrix-applied-note')!.textContent!;
    expect(note).toBe('The reviewed proposal is saved in this workspace. No planted bug has run yet: Submit PR-4 runs them against your tests, or open Write tests to see the change.');
    expect(note).not.toMatch(/last submitted|\bagain\b/);
  });
  it('after an Apply with a submission: the grid ran on the last one, and Submit PR-4 again', async () => {
    await drawMatrix({ attempts: 1 });
    await apply();
    expect(byTestId('matrix-applied-note')!.textContent).toBe('The reviewed proposal is saved in this workspace. The planted bugs here ran on what you last submitted: Submit PR-4 again to run them on the change, or open Write tests to see it.');
    expect(byTestId('phase-testing-matrix')!.textContent).toContain('Your last submission brought no grid back.');
  });
  it('no grid while the teacher\'s sign-off is awaited: no invitation to submit again', async () => {
    const waiting = task({ evidence: 'signed-off', status: 'submitted', awaitingSignOff: true, attempts: 1, lastSubmissionId: 'rev-1' });
    await drawMatrix({ attempts: 1, tasks: [waiting] });
    const grid = byTestId('phase-testing-matrix')!.textContent!;
    expect(grid).toContain("Your last submission brought no grid back, and it waits for your teacher's sign-off.");
    expect(grid).not.toMatch(/Submit PR-4|runs the planted bugs again/);
  });
  /*
   * The header's Submit is named by the page's own test (`hasPr={submitted}`:
   * a submission the page holds, or the phase's attempts), as the sentences under it are. Here the page holds the
   * submission its own Submit made while the phase it read still says no attempt and no last submission.
   */
  it('after the page\'s own Submit, with the phase still at no attempt, the header reads "Submit PR-4 again"', async () => {
    const { pollUntil } = await import('@/lib/poll');
    const settled = { id: 'rev-own', status: 'completed', passed: false, score: 40, attempt: 1, createdAt: '2026-11-17T03:00:00Z', report: null };
    mocks.apiSubmit.mockResolvedValueOnce({ ...settled, status: 'queued' });
    vi.mocked(pollUntil).mockResolvedValueOnce(settled as never);
    await drawMatrix();
    const header = () => byTestId('phase-testing-submit')!;
    expect(header().textContent).toBe('Submit PR-4');
    await act(async () => { header().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.phase).toMatchObject({ attempts: 0, lastSubmission: null });
    expect(header().textContent).toBe('Submit PR-4 again');
  });
});

/*
 * The header's Submit is `size="sm"` (HeaderSubmit), the workspace header's size, so every control
 * the page hands its header is too: "Open the workspace" and "Run the bugs again" on the row beside Submit, and the
 * Brief, the reference solution's door and the matrix's way back that are read in Details, as the workspace header
 * keeps every one of its controls sm. One left at the default size here is a row of two sizes again.
 */
describe('the header the pull request and planted bugs pages draw is one size', () => {
  const controls = () => [...host.querySelector('header')!.querySelectorAll<HTMLElement>('a, button')];
  it('the pull request page: Brief, Open the workspace and Submit PR-3, each sm', async () => {
    await drawPr('implementation');
    const drawn = controls();
    expect(drawn.map((one) => one.dataset.testid)).toEqual(expect.arrayContaining(['open-brief', 'pr-open-workspace', 'header-submit']));
    for (const one of drawn) expect(one.className, one.textContent ?? '').toContain('btn-sm');
  });
  it('the planted bugs page: Brief, Open the workspace, Run the bugs again and Submit PR-4, each sm', async () => {
    await drawMatrix({ attempts: 1 });
    const drawn = controls();
    expect(drawn.map((one) => one.textContent)).toEqual(expect.arrayContaining(['Run the bugs again', 'Submit PR-4 again']));
    expect(drawn.map((one) => one.dataset.testid)).toEqual(expect.arrayContaining(['open-brief', 'back-workspace', 'phase-testing-submit']));
    for (const one of drawn) expect(one.className, one.textContent ?? '').toContain('btn-sm');
  });
});
