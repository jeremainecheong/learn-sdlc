// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail, PhaseTaskView } from '@learnsdlc/shared';
import { taskView } from './fixtures';

/**
 * The answer door, on a phase a teacher has split.
 *
 * The room asks `GET /phases/:id/solution` with a task key: without one, the
 * moment a phase holds more than one task the route cannot tell which answer
 * is wanted and refuses by name. The gate is per task too: a learner who has
 * passed one task of two must be refused the other's answer, on **that task's**
 * row, and must not be walked into a 403 to find out.
 *
 * What a written task's door contains is a separate fact and is not this
 * room's doing: the pack ships no model answer to prose, so `available` is
 * false and the room says so in the words it already says it in.
 */

const held = vi.hoisted(() => ({ detail: null as PhaseDetail | null, crumbs: [] as { label: string; href?: string }[] }));

vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'p1' }) }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    details: held.detail ? { p1: held.detail } : {},
    enrollment: { id: 'e1', projectTitle: 'TaskTrackr', projectSlug: 'tasktrackr', phases: [] },
    analytics: null,
    currentPhase: null,
  }),
}));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children, right, crumbs }: { children: ReactNode; right?: ReactNode; crumbs?: { label: string; href?: string }[] }) => {
    held.crumbs = crumbs ?? [];
    return (
      <div>
        {right}
        {children}
      </div>
    );
  },
}));
vi.mock('@/lib/api-solution', () => ({ solutionApi: { read: vi.fn() } }));

const { solutionApi } = await import('@/lib/api-solution');
const read = solutionApi.read as unknown as ReturnType<typeof vi.fn>;
const SolutionPage = (await import('@/app/(app)/workspace/[phaseId]/solution/page')).default;

const task = taskView;

const phase = (tasks?: PhaseTaskView[]): PhaseDetail =>
  ({
    id: 'p1',
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    status: 'submitted',
    bestScore: null,
    attempts: 1,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    view: 'full',
    files: [],
    tasks,
  }) as unknown as PhaseDetail;

const view = (over: Record<string, unknown> = {}) => ({
  phaseStateId: 'p1',
  phaseKey: 'requirements',
  phaseTitle: 'Requirements',
  available: false,
  unavailableReason: 'prose',
  files: [],
  bestScore: 90,
  passedAt: '2026-09-19T09:00:00.000Z',
  readAt: null,
  packVersion: '2.0.1',
  ...over,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  read.mockReset().mockResolvedValue(view());
  held.detail = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.matchMedia =
    window.matchMedia ??
    ((() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as never);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the reference room on a split phase', () => {
  it('hands the task list the phase, so a quiz row is a door to the quiz room', async () => {
    held.detail = phase([
      task({ key: 'story', order: 1, status: 'passed' }),
      task({ key: 'quiz', order: 2, artefactType: 'quiz', evidence: 'automated' }),
    ]);
    await act(async () => root.render(<SolutionPage />));
    // Without the phase every row is a statement, and the quiz could not be opened from here.
    expect(host.querySelector('[data-testid=task-open-quiz]')?.tagName).toBe('A');
  });

  it('sends no key at all for a phase with one task, exactly as it always has', async () => {
    held.detail = phase([task({ key: 'main', order: 1, status: 'passed' })]);
    await act(async () => root.render(<SolutionPage />));
    expect(read).toHaveBeenCalledWith('p1', undefined);
    // Nothing to choose between, so nothing is drawn to choose with.
    expect(host.querySelector('[data-testid=task-switcher]')).toBeNull();
  });

  it('sends no key for a phase the shell holds no tasks for', async () => {
    held.detail = phase(undefined);
    await act(async () => root.render(<SolutionPage />));
    expect(read).toHaveBeenCalledWith('p1', undefined);
  });

  it('sends the selected task’s key, and opens on a task there is an answer to read for', async () => {
    held.detail = phase([
      task({ key: 'story', order: 1 }),
      task({ key: 'scope', order: 2, required: false, status: 'passed' }),
    ]);
    await act(async () => root.render(<SolutionPage />));
    // The room opens on the passed task: it is the one with an answer behind
    // it, and the other would be a 403 the learner did not ask for.
    expect(read).toHaveBeenCalledWith('p1', 'scope');

    const choose = host.querySelector<HTMLButtonElement>('[data-testid=task-choose-story]')!;
    await act(async () => choose.click());
    // Picking the unpassed task is answered from the row rather than by walking
    // the learner into a refusal.
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid=solution-locked]')).not.toBeNull();
  });

  it('offers no door where the task has not passed, and never asks for one', async () => {
    held.detail = phase([task({ key: 'story', order: 1 }), task({ key: 'scope', order: 2 })]);
    await act(async () => root.render(<SolutionPage />));
    expect(read).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid=solution-locked]')).not.toBeNull();
  });

  it('says a written task ships no model answer, in the words it already uses', async () => {
    held.detail = phase([
      task({ key: 'story', order: 1, status: 'passed' }),
      task({ key: 'scope', order: 2, required: false }),
    ]);
    read.mockResolvedValue(view({ taskKey: 'story', taskTitle: 'The user story' }));
    await act(async () => root.render(<SolutionPage />));
    expect(read).toHaveBeenCalledWith('p1', 'story');
    expect(host.querySelector('[data-testid=solution-empty-prose]')).not.toBeNull();
  });
});

/**
 * Three reasons, three sentences.
 *
 * `SolutionUnavailable` has a reason for quizzes as well as `'prose'` and
 * `'config'`. A two-arm branch (`prose`, or everything else) would tell a
 * learner their quiz paper was *"configuration you wrote for your own
 * machine"*, which is the `default:` arm's word said about a task that writes
 * no file at all. The pack's true reason reaches the screen.
 */
describe('the reference room on a quiz', () => {
  it('says a quiz has no answer key to read, rather than the configuration sentence', async () => {
    held.detail = phase([
      task({ key: 'main', order: 1, status: 'passed' }),
      task({ key: 'concepts', order: 2, artefactType: 'quiz', required: false, status: 'passed' }),
    ]);
    read.mockResolvedValue(
      view({ unavailableReason: 'quiz', taskKey: 'concepts', taskTitle: 'Check the concepts' }),
    );
    await act(async () => root.render(<SolutionPage />));
    expect(host.querySelector('[data-testid=solution-empty-quiz]')).not.toBeNull();
    expect(host.querySelector('[data-testid=solution-empty-config]')).toBeNull();
    expect(host.textContent).toContain('there is no answer key to read');
    // And it says what a learner does have instead, which is the whole of the
    // three-tier answer door: right or wrong always, the explanation once they
    // are finished with the question, the key never.
    expect(host.textContent).toContain('explains each one once you are finished');
  });

  /**
   * The door the phase card advertises is the door this room opens.
   *
   * `solutionMeta` reads the phase's sole **non-quiz** task, so a quiz beside a
   * code task leaves the card drawing *Read the reference solution*. Opening on
   * the first passed task in the list would, on a quiz-first phase, open the
   * quiz, so a learner who pressed a button promising an answer would be told
   * there is no answer key to read. The default prefers a task that has one.
   */
  it('opens on the task that has an answer, not on a quiz ordered before it', async () => {
    held.detail = phase([
      task({ key: 'concepts', order: 1, artefactType: 'quiz', required: false, status: 'passed' }),
      task({
        key: 'build',
        order: 2,
        status: 'passed',
        solution: { available: true, files: 1, readAt: null },
      }),
    ]);
    read.mockImplementation(async (_phaseId: string, key?: string) =>
      key === 'build'
        ? view({
            available: true,
            unavailableReason: null,
            taskKey: 'build',
            taskTitle: 'Build the endpoint',
            files: [{ path: 'api/tasks.py', language: 'python', yours: 'a', theirs: 'b' }],
          })
        : view({ unavailableReason: 'quiz', taskKey: 'concepts', taskTitle: 'Check the concepts' }),
    );
    await act(async () => root.render(<SolutionPage />));
    expect(read).toHaveBeenCalledWith('p1', 'build');
    expect(host.querySelector('[data-testid=solution-empty-quiz]')).toBeNull();
    expect(host.querySelector('[data-testid=solution-standing]')).not.toBeNull();
  });

  /**
   * And where nothing passed has an answer, the room lands on the first
   * passed task, saying that task's own reason.
   */
  it('keeps the first passed task when no passed task ships an answer', async () => {
    held.detail = phase([
      task({ key: 'concepts', order: 1, artefactType: 'quiz', required: false, status: 'passed' }),
      task({ key: 'story', order: 2, status: 'passed' }),
    ]);
    read.mockResolvedValue(view({ unavailableReason: 'quiz', taskKey: 'concepts' }));
    await act(async () => root.render(<SolutionPage />));
    expect(read).toHaveBeenCalledWith('p1', 'concepts');
    expect(host.querySelector('[data-testid=solution-empty-quiz]')).not.toBeNull();
  });

  it('leaves the configuration sentence exactly where it was', async () => {
    held.detail = phase([task({ key: 'main', order: 1, status: 'passed' })]);
    read.mockResolvedValue(view({ unavailableReason: 'config' }));
    await act(async () => root.render(<SolutionPage />));
    expect(host.querySelector('[data-testid=solution-empty-config]')).not.toBeNull();
    expect(host.querySelector('[data-testid=solution-empty-quiz]')).toBeNull();
  });
});

/*
 * The reference solution page draws the trail every page of
 * a phase draws, "<project> › <Phase> › <leaf>" with the phase linked to its place on the phases page and the leaf
 * capitalised; on Testing its way back names the page the row calls "Planted bugs".
 */
describe('the reference solution page\'s trail and its way back', () => {
  it('Testing: "TaskTrackr › Testing › Reference solution", and "Open Planted bugs" back to the planted bugs page', async () => {
    held.detail = { ...phase([task({ key: 'main', order: 1, status: 'passed' })]), key: 'testing', title: 'Testing' } as PhaseDetail;
    read.mockResolvedValue(view({ phaseKey: 'testing', phaseTitle: 'Testing' }));
    await act(async () => root.render(<SolutionPage />));
    expect(held.crumbs.map((one) => [one.label, one.href ?? null])).toEqual([
      ['TaskTrackr', '/dashboard'],
      ['Testing', '/phases?phase=testing'],
      ['Reference solution', null],
    ]);
    const back = host.querySelector<HTMLAnchorElement>('[data-testid="solution-back"]')!;
    expect(back.textContent).toBe('Open Planted bugs');
    expect(back.getAttribute('href')).toBe('/workspace/p1/matrix');
    expect(host.textContent!.toLowerCase()).not.toContain('kill matrix');
  });
});
