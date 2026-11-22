/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseTaskView, SubmissionView } from '@learnsdlc/shared';

/**
 * Every revision of a split phase, read one task at a time.
 *
 * `GET /phases/:id/submissions` resolves the phase's **only** task, so on a
 * phase a teacher has split the API refuses it with 400, and the record cache
 * is what every room asks for its history, so a learner in a split phase paid a
 * refused request on each room they opened and saw no revisions at all. The
 * task-scoped route already exists; this is the reader learning to use it, once
 * per task, and to hand back the union in the order the journal's own bulk
 * route hands it back.
 */

const api = {
  runs: vi.fn(),
  submissions: vi.fn(),
  chatHistory: vi.fn(),
  phaseRecords: vi.fn(),
};

vi.mock('@/lib/api', () => ({ api }));

type Records = typeof import('@/lib/records');
let records: Records;

const task = (key: string, order: number): PhaseTaskView =>
  ({
    key,
    order,
    required: true,
    title: key,
    artefactType: 'user-story',
    evidence: 'reviewed',
    sealed: true,
    status: 'in_progress',
    awaitingSignOff: false,
    attempts: 1,
    bestScore: null,
    passedAt: null,
    lastSubmissionId: null,
    resetAt: null,
    solution: { available: false, files: 0, readAt: null },
  }) as PhaseTaskView;

const TASKS: PhaseTaskView[] = [task('main', 1), task('reminder-story', 2), task('story-concepts', 3)];

const revision = (id: string, taskKey: string, createdAt: string, attempt: number): SubmissionView =>
  ({ id, taskKey, createdAt, attempt, status: 'completed', passed: true, score: 80, report: null }) as SubmissionView;

/** One revision per task, out of order on purpose. */
const byTask: Record<string, SubmissionView[]> = {
  main: [
    revision('m1', 'main', '2026-09-20T09:00:00.000Z', 1),
    revision('m2', 'main', '2026-09-20T11:00:00.000Z', 2),
  ],
  'reminder-story': [revision('r1', 'reminder-story', '2026-09-20T10:00:00.000Z', 1)],
  'story-concepts': [revision('q1', 'story-concepts', '2026-09-20T12:00:00.000Z', 1)],
};

beforeEach(async () => {
  window.localStorage.clear();
  api.runs.mockReset().mockResolvedValue([]);
  api.chatHistory.mockReset().mockResolvedValue([]);
  api.submissions.mockReset().mockImplementation(async (_id: string, taskKey?: string) =>
    taskKey ? (byTask[taskKey] ?? []) : [],
  );
  api.phaseRecords.mockReset().mockResolvedValue({
    p1: { submissions: [], runs: [], chat: [] },
    p2: { submissions: [], runs: [], chat: [] },
  });
  vi.resetModules();
  records = await import('@/lib/records');
});

/** Every phase-wide revisions call this case made, by phase id. */
const phaseWide = () => api.submissions.mock.calls.filter((call) => call[1] === undefined).map((call) => call[0]);

/** Let whatever a fire-and-forget refresh started run to completion. */
const settle = async () => {
  for (let round = 0; round < 4; round += 1) await Promise.resolve();
};

describe('the records of a phase a teacher has split', () => {
  it('asks once per task and never asks the phase', async () => {
    const { records: held, partial } = await records.loadRecords('p1', { tasks: TASKS });

    expect(partial).toBe(false);
    expect(api.submissions).toHaveBeenCalledTimes(3);
    expect(api.submissions.mock.calls.map((call) => call[1])).toEqual([
      'main',
      'reminder-story',
      'story-concepts',
    ]);
    // Nothing went out on the route the API refuses for this phase.
    expect(api.submissions.mock.calls.every((call) => call[1] !== undefined)).toBe(true);
    expect(held.submissions.map((row) => row.id)).toEqual(['m1', 'r1', 'm2', 'q1']);
  });

  it('keeps each revision’s own attempt number through the union', async () => {
    const { records: held } = await records.loadRecords('p1', { tasks: TASKS });

    // A task's tries are counted on its own row, so two tasks both have a
    // first attempt and the concatenation must not renumber either.
    expect(held.submissions.map((row) => [row.taskKey, row.attempt])).toEqual([
      ['main', 1],
      ['reminder-story', 1],
      ['main', 2],
      ['story-concepts', 1],
    ]);
  });

  it('asks the phase, exactly as it always has, where the phase has one task', async () => {
    await records.loadRecords('p2', { tasks: [task('main', 1)] });

    expect(api.submissions).toHaveBeenCalledTimes(1);
    expect(api.submissions).toHaveBeenCalledWith('p2');
  });

  it('remembers the scope, so a refresh after a submission asks the same way', async () => {
    await records.loadRecords('p1', { tasks: TASKS });
    api.submissions.mockClear();

    records.refreshPhaseRecords('p1');
    await Promise.resolve();
    await Promise.resolve();

    expect(api.submissions).toHaveBeenCalledTimes(3);
    expect(api.submissions.mock.calls.every((call) => call[1] !== undefined)).toBe(true);
  });
});

/**
 * The scope is the **phase's**, not a past read's.
 *
 * Remembering what a room asked for is only as good as the room having asked.
 * Three paths reach the cache without one: the dossier fills every phase in a
 * single bulk request, `staleRecords` refreshes every phase the session has
 * ever held, and Home's idle prefetch warms the phase in hand. All three then
 * refreshed through the phase-wide route (the route the API refuses with 400
 * on a split phase) after which `partial` is true, the fresh copy is never
 * cached, and the room's revisions stay as they were before the hand-in for the
 * rest of the session.
 *
 * So the task keys are told once, from the project the provider has just
 * loaded, before any of those paths can run.
 */
describe('the scope a phase is read under, told by the project', () => {
  const project = [
    { id: 'p1', tasks: TASKS },
    { id: 'p2', tasks: TASKS },
    { id: 'p3', tasks: [task('main', 1)] },
  ];

  it('survives a bulk fill: the dossier’s refresh still asks one task at a time', async () => {
    records.rememberTaskScopes(project);
    await records.loadAllRecords('overdue-report');
    api.submissions.mockClear();

    records.refreshPhaseRecords('p1');
    await settle();

    expect(phaseWide()).toEqual([]);
    expect(api.submissions.mock.calls.map((call) => call[1])).toEqual([
      'main',
      'reminder-story',
      'story-concepts',
    ]);
  });

  it('covers a split phase whose room was never opened this session', async () => {
    records.rememberTaskScopes(project);
    await records.loadAllRecords('overdue-report');
    // Only p1's room was opened, with its tasks in hand.
    await records.loadRecords('p1', { force: true, tasks: TASKS });
    api.submissions.mockClear();

    records.staleRecords();
    await settle();

    // p2 is a split phase this session never opened a room in, and it is asked
    // for the same way p1 is.
    expect(phaseWide()).toEqual([]);
    expect(
      api.submissions.mock.calls.filter((call) => call[0] === 'p2').map((call) => call[1]),
    ).toEqual(['main', 'reminder-story', 'story-concepts']);
  });

  it('covers a first read with no tasks in hand — the dossier’s per-phase fallback', async () => {
    records.rememberTaskScopes(project);

    const { partial } = await records.loadRecords('p1');

    expect(partial).toBe(false);
    expect(phaseWide()).toEqual([]);
    expect(api.submissions.mock.calls.map((call) => call[1])).toEqual([
      'main',
      'reminder-story',
      'story-concepts',
    ]);
  });

  it('leaves a phase the project says has one task on the route it has always used', async () => {
    records.rememberTaskScopes(project);

    await records.loadRecords('p3');

    expect(api.submissions).toHaveBeenCalledTimes(1);
    expect(api.submissions).toHaveBeenCalledWith('p3');
  });

  it('forgets everything when the learner does', async () => {
    records.rememberTaskScopes(project);
    records.resetRecords();
    api.submissions.mockClear();

    await records.loadRecords('p1');

    // No scope survives a different learner, so the read falls back to the
    // route the API resolves for a phase with one task rather than to the last
    // learner's task list.
    expect(phaseWide()).toEqual(['p1']);
  });
});
