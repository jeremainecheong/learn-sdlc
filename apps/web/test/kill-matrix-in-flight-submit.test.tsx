// @vitest-environment jsdom
/**
 * A revision in flight holds the hand-in controls off, in the kill-matrix room.
 *
 * The matrix room's three hand-in controls ("Submit PR-4", "Run the bugs
 * again" and the empty grid's submit) are off while its task waits on the
 * teacher's countersignature, and also while a newer revision is still queued
 * or being reviewed, because the API refuses a second revision in flight for
 * a task. They are off with REVISION_IN_FLIGHT_REASON while the held revision is
 * queued or running, and on again once its verdict is in.
 *
 * The rig is kill-matrix-signoff-submit.test.tsx's.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ detail: {} as Record<string, unknown>, submit: vi.fn(), poll: vi.fn() }));
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main', order: 1, required: true, title: 'Your suite', artefactType: 'tests', evidence: 'signed-off', sealed: true,
  status: 'submitted', awaitingSignOff: false, attempts: 1, bestScore: 40, passedAt: null, lastSubmissionId: 'rev-1', resetAt: null,
  files: [], solution: { available: false, files: 0, readAt: null }, ...over,
});
const base = (tasks: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  id: 'phase-matrix', key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status: 'submitted', projectSlug: 'room-desk',
  files: [], rubric: { criteria: [], passThreshold: 70 }, attempts: 1, bestScore: 40, lastSubmission: null,
  objectives: [], links: [], taskPanel: '', canRun: true, canPreview: false, runLabel: 'Run tests',
  solution: { available: false, files: 0, readAt: null }, tasks,
  taskCounts: { total: tasks.length, required: tasks.length, passed: 0, passedRequired: 0 }, ...over,
});

vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-matrix' }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  api: { submissions: vi.fn(async () => []), submit: rig.submit, getSubmission: vi.fn() },
  describeError: (_e: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/api-workspace', () => ({ workspaceApi: { phase: vi.fn(async () => rig.detail) } }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn() }));
vi.mock('@/lib/job-signal', () => ({ jobWake: vi.fn() }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: rig.poll, useRecoverWhenBack: () => undefined }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: {}, enrollment: null, analytics: null, currentPhase: null }),
  fullDetail: () => rig.detail,
  invalidateProject: vi.fn(),
}));
vi.mock('@/components/shell/PhaseTutorial', () => ({ usePhaseTutorialReady: () => undefined }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/shell', () => ({
  DocPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PersonaComposer: () => null, PersonaFeed: () => null, PersonaHeader: () => null,
  briefHref: () => '/brief', solutionHref: () => '/solution', usePersona: () => ({}),
}));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ right, children }: { right?: ReactNode; children?: ReactNode }) => <div data-testid="frame">{right}{children}</div>,
}));
vi.mock('@/components/ui', () => {
  const Block = ({ children, action }: { children?: ReactNode; action?: ReactNode }) => <div>{children}{action}</div>;
  return {
    Notice: Block, Section: Block, EmptyState: Block,
    Button: ({ children, testId, href, disabled, reason, busy, onClick }: { children: ReactNode; testId?: string; href?: string; disabled?: boolean; reason?: string; busy?: boolean; onClick?: () => void }) =>
      href ? <a href={href} data-testid={testId}>{children}</a>
        : <button type="button" data-testid={testId} disabled={Boolean(disabled || busy)} data-reason={disabled && !busy ? reason ?? '' : undefined} onClick={onClick}>{children}</button>,
  };
});
vi.mock('@/components/ui/Term', () => ({ Term: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/panels/testing/MatrixDoc', () => ({
  MatrixCard: () => null, MatrixRead: () => null, MutantDiff: () => null, PlantedBugs: () => null, WhatToDo: () => null,
  matrixPurpose: () => 'purpose',
}));
vi.mock('@/components/workspace/ExplainTest', () => ({ ExplainTestButton: () => null }));
vi.mock('@/components/workspace/panels/RoomFallback', () => ({ RoomFallback: () => <p data-testid="room-fallback" /> }));
// The header's Submit reads where it goes from the phase (frameState), which picks the task with the real `chooseTask`.
vi.mock('@/components/workspace/TaskPanel', async (importOriginal) => ({ chooseTask: (await importOriginal<typeof import('@/components/workspace/TaskPanel')>()).chooseTask, soleWorkTaskKey: () => undefined, submitArgs: (...args: unknown[]) => args }));

const { default: MatrixPage } = await import('@/app/(app)/workspace/[phaseId]/matrix/page');
const signoff = await import('@/components/workspace/signoff-status');
/** Read through the namespace so a missing export fails an assertion, not the import. */
const IN_FLIGHT = () => (signoff as Record<string, unknown>).REVISION_IN_FLIGHT_REASON as string | undefined;

let host: HTMLDivElement, root: Root;
const mount = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MatrixPage />));
  await act(async () => { await Promise.resolve(); });
};
const handIns = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter((one) => /Submit PR-4|Run the bugs again/.test(one.textContent ?? ''));
const submitButton = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-testing-submit"]')!;
/** Revisions are made a minute or two ago: one in flight older than the API's
 * age-out window (IN_FLIGHT_MAX_AGE_MS) does not hold Submit off. */
const FRESH = new Date(Date.now() - 120_000).toISOString();
const LATER = new Date(Date.now() - 60_000).toISOString();
const revision = (id: string, status: string, passed: boolean | null = null, createdAt = FRESH) =>
  ({ id, taskKey: 'main', status, passed, createdAt, attempt: 2, report: null });

beforeEach(() => {
  rig.submit.mockReset(); rig.submit.mockRejectedValue(new Error('a resubmit reached the API'));
  rig.poll.mockReset(); rig.poll.mockImplementation(() => new Promise(() => undefined));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the kill-matrix room while a newer revision is in flight', () => {
  for (const status of ['queued', 'running']) {
    it(`${status}: every control that hands a revision in is off with the in-flight reason, and none reaches the API`, async () => {
      rig.detail = base([task()], { lastSubmission: revision('rev-2', status) });
      await mount();
      expect(IN_FLIGHT(), 'REVISION_IN_FLIGHT_REASON is exported').toEqual(expect.any(String));
      const all = handIns();
      // The header's Submit and "Run the bugs again"; the empty grid draws no second Submit.
      expect(all.length).toBe(2);
      for (const one of all) {
        expect(one.disabled, one.textContent ?? '').toBe(true);
        expect(one.dataset.reason, one.textContent ?? '').toBe(IN_FLIGHT());
      }
      for (const one of all) act(() => one.click());
      expect(rig.submit).not.toHaveBeenCalled();
    });
  }

  it('the verdict lands after a submit and Submit is on again, with no reason', async () => {
    const landed = revision('rev-2', 'completed', false, LATER);
    rig.detail = base([task()], { lastSubmission: revision('rev-1', 'completed', false) });
    rig.submit.mockReset();
    rig.submit.mockResolvedValue(revision('rev-2', 'queued', null, LATER));
    let land: (value: unknown) => void = () => undefined;
    rig.poll.mockImplementation(() => new Promise((resolve) => { land = resolve; }));
    await mount();
    expect(submitButton().disabled).toBe(false);
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(rig.submit).toHaveBeenCalledTimes(1);
    expect(submitButton().disabled, 'in review').toBe(true);
    rig.detail = base([task({ lastSubmissionId: 'rev-2' })], { lastSubmission: landed });
    await act(async () => { land(landed); });
    for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().dataset.reason).toBeUndefined();
  });

  it('waiting on the countersignature keeps the sign-off reason', async () => {
    rig.detail = base([task({ awaitingSignOff: true, bestScore: 90 })], { lastSubmission: revision('rev-1', 'completed', true) });
    await mount();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().dataset.reason).toBe(signoff.SIGN_OFF_SUBMIT_REASON);
  });

  it('a refused review with nothing in flight leaves Submit on, and "Run the bugs again" keeps its own reason', async () => {
    rig.detail = base([task()], { lastSubmission: revision('rev-1', 'completed', false) });
    await mount();
    expect(submitButton().disabled).toBe(false);
    const again = handIns().find((one) => /Run the bugs again/.test(one.textContent ?? ''))!;
    expect(again.disabled).toBe(true);
    expect(again.dataset.reason).toBe('There are no planted bugs to run until one has run against a submission.');
  });
});

const poll = (await import('@/lib/poll')) as unknown as { PollTimeoutError: new (message?: string) => Error };
describe('the matrix room watches a revision in flight to its verdict', () => {
  it('opened while a revision is queued: the room follows it, the grid lands and Submit is on again without a reload', async () => {
    const landed = revision('rev-2', 'completed', false, LATER);
    rig.detail = base([task()], { lastSubmission: revision('rev-2', 'queued') });
    let land: (value: unknown) => void = () => undefined;
    rig.poll.mockImplementation(() => new Promise((resolve) => { land = resolve; }));
    await mount();
    expect(submitButton().disabled).toBe(true);
    expect(rig.poll, 'the room watches the revision it found in flight').toHaveBeenCalled();
    rig.detail = base([task({ lastSubmissionId: 'rev-2' })], { lastSubmission: landed });
    await act(async () => { land(landed); });
    for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().dataset.reason).toBeUndefined();
  });
  it('a submit whose own wait timed out is watched on to its verdict', async () => {
    const landed = revision('rev-2', 'completed', false, LATER);
    rig.detail = base([task()], { lastSubmission: revision('rev-1', 'completed', false) });
    rig.submit.mockReset();
    rig.submit.mockResolvedValue(revision('rev-2', 'queued', null, LATER));
    let land: (value: unknown) => void = () => undefined;
    rig.poll
      .mockImplementationOnce(() => Promise.reject(new poll.PollTimeoutError('slow')))
      .mockImplementation(() => new Promise((resolve) => { land = resolve; }));
    await mount();
    await act(async () => { submitButton().click(); });
    for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
    expect(submitButton().disabled, 'still in review').toBe(true);
    expect(rig.poll).toHaveBeenCalledTimes(2);
    rig.detail = base([task({ lastSubmissionId: 'rev-2' })], { lastSubmission: landed });
    await act(async () => { land(landed); });
    for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
    expect(submitButton().disabled).toBe(false);
  });
  it('a revision older than the API\'s age-out window no longer holds Submit off', async () => {
    rig.detail = base([task()], { lastSubmission: revision('rev-2', 'queued', null, new Date(Date.now() - 11 * 60_000).toISOString()) });
    await mount();
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().dataset.reason).toBeUndefined();
  });
});

describe("the kill-matrix room names its pull request by the phase's place (spec 4.2)", () => {
  it('a Testing that opens its project says "Submit PR-1", not "Submit for review"', async () => {
    rig.detail = base([task({ attempts: 0 })], { order: 1, place: 1, count: 1, attempts: 0, lastSubmission: null });
    await mount();
    expect(submitButton().textContent).toBe('Submit PR-1');
  });
  // Once the phase has a submission, the same control reads "again", as the workspace header does.
  it('says "Submit PR-1 again" once there is a submission to resubmit', async () => {
    rig.detail = base([task()], { order: 1, place: 1, count: 1, lastSubmission: null });
    await mount();
    expect(submitButton().textContent).toBe('Submit PR-1 again');
  });
});
