// @vitest-environment jsdom
/**
 * The answer-key door in the kill-matrix room.
 *
 * The reference solution stays shut until a strictly reviewed pass stands
 * behind the board: a teacher's Pass or Sign off writes `passed` with no
 * review, and the API then answers `solution.awaitingReview`. This file makes
 * a board-only condition in the matrix room turn red, as the pull request
 * room's own suite does for that room. The page is mounted as its
 * route exports it and the real door check runs; only the network, the
 * shell's held project and visual-only children are stood in for. The change
 * room's door is tested beside that room's own rig, in
 * versioned-document-pages.test.tsx.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ detail: {} as Record<string, unknown> }));
const base = () => ({
  id: 'phase-matrix', key: 'testing', title: 'Testing', order: 4, status: 'passed', projectSlug: 'room-desk',
  files: [], rubric: { criteria: [], passThreshold: 100 }, attempts: 1, bestScore: 100, lastSubmission: null,
  objectives: [], links: [], taskPanel: '', canRun: true, canPreview: false, runLabel: 'Run tests',
  solution: { available: true, files: 3, readAt: null },
});

vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-matrix' }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  api: { submissions: vi.fn(async () => []), submit: vi.fn(), getSubmission: vi.fn() },
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
  PhaseDocumentFrame: ({ right }: { right?: ReactNode }) => <div data-testid="frame-right">{right}</div>,
}));
vi.mock('@/components/ui', () => {
  const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Notice: Block, Section: Block, EmptyState: Block,
    Button: ({ children, testId, href }: { children: ReactNode; testId?: string; href?: string }) =>
      <a href={href} data-testid={testId}>{children}</a>,
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
vi.mock('@/components/workspace/TaskPanel', async (importOriginal) => ({ chooseTask: (await importOriginal<typeof import('@/components/workspace/TaskPanel')>()).chooseTask, soleWorkTaskKey: () => undefined, submitArgs: vi.fn() }));

const { default: MatrixPage } = await import('@/app/(app)/workspace/[phaseId]/matrix/page');

let host: HTMLDivElement, root: Root;
const door = () => host.querySelector('[data-testid="solution-open"]');
const mount = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MatrixPage />));
};

beforeEach(() => { rig.detail = base(); });
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the answer-key door in the kill-matrix room', () => {
  it('is drawn on a pass the review accepted', async () => {
    await mount();
    expect(host.querySelector('[data-testid="frame-right"]')).not.toBeNull();
    expect(door()).not.toBeNull();
  });

  it('is not drawn where the board reads passed but no reviewed pass stands behind it', async () => {
    rig.detail = { ...base(), solution: { available: true, files: 3, readAt: null, awaitingReview: true } };
    await mount();
    expect(host.querySelector('[data-testid="frame-right"]')).not.toBeNull();
    expect(door()).toBeNull();
  });

  it('is not drawn before the phase is passed', async () => {
    rig.detail = { ...base(), status: 'in_progress' };
    await mount();
    expect(door()).toBeNull();
  });
});
