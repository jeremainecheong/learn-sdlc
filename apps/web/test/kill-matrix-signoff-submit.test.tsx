// @vitest-environment jsdom
/**
 * Submit waits for the countersignature, in the kill-matrix room.
 *
 * The matrix room has three controls that hand a revision in: "Submit PR-4",
 * "Run the bugs again" and the empty grid's own submit. While the phase's
 * task has passed its review and waits on the teacher's countersignature, a
 * refused resubmit would clear the task's place in the sign-off queue. So
 * each is off with SIGN_OFF_SUBMIT_REASON and nothing reaches the API; after
 * the countersignature they are live again.
 *
 * The rig is kill-matrix-solution-door.test.tsx's: the REAL page, with the network, the
 * shell and visual-only children stood in for. The button stand-in keeps the
 * two things under test, `disabled` and `reason`.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ detail: {} as Record<string, unknown>, submit: vi.fn() }));
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main', order: 1, required: true, title: 'Your suite', artefactType: 'tests', evidence: 'signed-off', sealed: true,
  status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 90, passedAt: null, lastSubmissionId: 'rev-1', resetAt: null,
  files: [], solution: { available: false, files: 0, readAt: null }, ...over,
});
const base = (tasks: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  id: 'phase-matrix', key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status: 'submitted', projectSlug: 'room-desk',
  files: [], rubric: { criteria: [], passThreshold: 70 }, attempts: 1, bestScore: 90, lastSubmission: null,
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
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: () => undefined }));
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
const { SIGN_OFF_SUBMIT_REASON } = await import('@/components/workspace/signoff-status');

let host: HTMLDivElement, root: Root;
const mount = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MatrixPage />));
  await act(async () => { await Promise.resolve(); });
};
const handIns = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter((one) => /Submit PR-4|Run the bugs again/.test(one.textContent ?? ''));

beforeEach(() => { rig.submit.mockReset(); rig.submit.mockRejectedValue(new Error('a resubmit reached the API')); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the kill-matrix room while its task waits on the countersignature', () => {
  it('every control that hands a revision in is off with the sign-off reason, and none reaches the API', async () => {
    rig.detail = base([task()]);
    await mount();
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="phase-testing-submit"]');
    expect(submit, 'the matrix room is drawn').not.toBeNull();
    expect(submit!.disabled).toBe(true);
    expect(submit!.dataset.reason).toBe(SIGN_OFF_SUBMIT_REASON);
    const all = handIns();
    // The header's Submit and "Run the bugs again"; the empty grid draws no second Submit.
    expect(all.length).toBe(2);
    for (const one of all) {
      expect(one.disabled, one.textContent ?? '').toBe(true);
      expect(one.dataset.reason, one.textContent ?? '').toBe(SIGN_OFF_SUBMIT_REASON);
    }
    for (const one of all) act(() => one.click());
    expect(rig.submit).not.toHaveBeenCalled();
  });

  it('the verdict that just landed holds the slot before the row knows it', async () => {
    rig.detail = base([task({ awaitingSignOff: false })], {
      lastSubmission: { id: 'rev-2', taskKey: 'main', status: 'completed', passed: true, createdAt: '2026-10-02T05:00:00.000Z' },
    });
    await mount();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="phase-testing-submit"]')!.disabled).toBe(true);
  });

  it('after the countersignature Submit is on, and "Run the bugs again" keeps its own reason', async () => {
    rig.detail = base([task({ status: 'passed', awaitingSignOff: false })], { status: 'passed' });
    await mount();
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="phase-testing-submit"]')!;
    expect(submit.disabled).toBe(false);
    const again = handIns().find((one) => /Run the bugs again/.test(one.textContent ?? ''))!;
    expect(again.disabled).toBe(true);
    expect(again.dataset.reason).toBe('There are no planted bugs to run until one has run against a submission.');
  });

  it('a refused review leaves Submit on', async () => {
    rig.detail = base([task({ awaitingSignOff: false, bestScore: 40 })]);
    await mount();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="phase-testing-submit"]')!.disabled).toBe(false);
  });
});
