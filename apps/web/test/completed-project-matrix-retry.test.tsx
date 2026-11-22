// @vitest-environment jsdom
/**
 * The Planted bugs page of a completed project. After Complete the project, the page's
 * header offers "Run the bugs again" and "Submit PR-4 again". That is the product's design: a retry after completion
 * is a designed path and needs a Submit after it. A completed project's page offers both, exactly as a passed Testing
 * phase of a project not yet completed does.
 *
 * The rig is kill-matrix-in-flight-submit.test.tsx's, with the shell's enrolment held both where the page reads it
 * (`useProject`) and where the header's Submit reads it (`ProjectContext`).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ detail: {} as Record<string, unknown>, enrollment: null as unknown, submit: vi.fn(), poll: vi.fn() }));
const PASSED = '2026-11-17T09:00:00.000Z';
const passedTesting = () => ({
  id: 'phase-matrix', key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status: 'passed', projectSlug: 'tasktrackr',
  files: [], rubric: { criteria: [], passThreshold: 70 }, attempts: 1, bestScore: 100,
  lastSubmission: { id: 'rev-1', taskKey: '', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: PASSED, report: null },
  objectives: [], links: [], taskPanel: '', canRun: true, canPreview: false, runLabel: 'Run tests',
  solution: { available: false, files: 0, readAt: null },
  tasks: [{ key: '', order: 1, required: true, title: 'Testing', artefactType: 'code', evidence: 'automated', sealed: true, status: 'passed',
    awaitingSignOff: false, attempts: 1, bestScore: 100, passedAt: PASSED, lastSubmissionId: 'rev-1', resetAt: null, files: [],
    solution: { available: false, files: 0, readAt: null } }],
  taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
});
const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const enrolment = (completed: boolean) => ({
  id: 'e', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', currentPhaseOrder: completed ? 6 : 5, completed, releases: [],
  phases: KEYS.map((key, at) => ({ id: key === 'testing' ? 'phase-matrix' : `p-${key}`, key, order: at + 1, title: key, status: completed || at < 4 ? 'passed' : 'in_progress' })),
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
  useProject: () => ({ details: {}, enrollment: rig.enrollment, analytics: null, currentPhase: null }),
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
    Button: ({ children, testId, href, disabled, busy, onClick }: { children: ReactNode; testId?: string; href?: string; disabled?: boolean; busy?: boolean; onClick?: () => void }) =>
      href ? <a href={href} data-testid={testId}>{children}</a>
        : <button type="button" data-testid={testId} disabled={Boolean(disabled || busy)} onClick={onClick}>{children}</button>,
  };
});
vi.mock('@/components/ui/Term', () => ({ Term: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/panels/testing/MatrixDoc', () => ({
  MatrixCard: () => null, MatrixRead: () => null, MutantDiff: () => null, PlantedBugs: () => null, WhatToDo: () => null,
  matrixPurpose: () => 'purpose',
}));
vi.mock('@/components/workspace/ExplainTest', () => ({ ExplainTestButton: () => null }));
vi.mock('@/components/workspace/panels/RoomFallback', () => ({ RoomFallback: () => <p data-testid="room-fallback" /> }));
vi.mock('@/components/workspace/TaskPanel', async (importOriginal) => ({ chooseTask: (await importOriginal<typeof import('@/components/workspace/TaskPanel')>()).chooseTask, soleWorkTaskKey: () => undefined, submitArgs: (...args: unknown[]) => args }));

const { default: MatrixPage } = await import('@/app/(app)/workspace/[phaseId]/matrix/page');
const { ProjectContext } = await import('@/lib/project-context');

let host: HTMLDivElement, root: Root;
const mount = async (completed: boolean) => {
  rig.detail = passedTesting();
  rig.enrollment = enrolment(completed);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const held = { enrollment: rig.enrollment, details: {}, analytics: null };
  await act(async () => root.render(<ProjectContext.Provider value={held as never}><MatrixPage /></ProjectContext.Provider>));
  await act(async () => { await Promise.resolve(); });
};
const words = () => Array.from(host.querySelectorAll('button')).map((one) => one.textContent ?? '');

beforeEach(() => {
  rig.submit.mockReset(); rig.submit.mockRejectedValue(new Error('a resubmit reached the API'));
  rig.poll.mockReset(); rig.poll.mockImplementation(() => new Promise(() => undefined));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Planted bugs page of a completed project', () => {
  it('passed, the project not completed: Run the bugs again and Submit PR-4 again', async () => {
    await mount(false);
    expect(words()).toContain('Run the bugs again');
    expect(host.querySelector('[data-testid="phase-testing-submit"]')?.textContent).toContain('Submit PR-4 again');
  });

  it('completed: Run the bugs again and Submit PR-4 again are still offered, and nothing reaches the API unpressed', async () => {
    await mount(true);
    expect(words()).toContain('Run the bugs again');
    expect(host.querySelector('[data-testid="phase-testing-submit"]')?.textContent).toContain('Submit PR-4 again');
    expect(rig.submit).not.toHaveBeenCalled();
  });
});
