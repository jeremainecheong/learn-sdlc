// @vitest-environment jsdom
/**
 * The reviewer's column reads its phase's records one task at a time on a
 * split phase (the task-rooms build's fourth minor).
 *
 * The column's thread comes from the record cache, and the record cache's
 * revisions leg asks `GET /phases/:id/submissions` unless it is told the
 * phase's task keys: the phase-wide route the API refuses with 400 on a phase
 * a teacher has split. `usePersona` hands over the task list the provider
 * holds, and asks again once the provider has said what it is. The record
 * cache's own suite (`records-task-scope.test.ts`) proves the cache honours a
 * scope; this proves the column gives it one.
 */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageView, PhaseTaskView } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  submissions: vi.fn(),
  runs: vi.fn(),
  chatHistory: vi.fn(),
  analyticsMe: vi.fn(),
  project: { analytics: { tokensToday: 0 }, details: {} as Record<string, { tasks?: PhaseTaskView[] }> },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      submissions: rig.submissions,
      runs: rig.runs,
      chatHistory: rig.chatHistory,
      analyticsMe: rig.analyticsMe,
    },
  };
});
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/useProject')>()),
  useProjectMaybe: () => rig.project,
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

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
    attempts: 0,
    bestScore: null,
    passedAt: null,
    lastSubmissionId: null,
    resetAt: null,
    solution: { available: false, files: 0, readAt: null },
  }) as PhaseTaskView;

const SPLIT = [task('main', 1), task('reminder-story', 2), task('story-concepts', 3)];
const THREAD: AssistantMessageView[] = [
  { id: 'u1', role: 'user', content: 'What does the product owner want?', createdAt: '2026-09-20T09:00:00.000Z' },
  { id: 'a1', role: 'assistant', content: 'A report of what is overdue.', createdAt: '2026-09-20T09:00:05.000Z' },
];

let host: HTMLDivElement;
let root: Root;
let seen: AssistantMessageView[] = [];

async function renderColumn(phaseStateId: string) {
  const { usePersona } = await import('@/components/shell/PersonaPanel');
  function Column() {
    const thread = usePersona({ phaseKey: 'requirements', phaseStateId });
    useEffect(() => {
      seen = thread.messages;
    });
    return null;
  }
  await act(async () => {
    root.render(<Column />);
  });
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Every revisions read the column caused, as [phase, task key]. */
const reads = () => rig.submissions.mock.calls.map((call) => [call[0], call[1]]);

beforeEach(async () => {
  window.localStorage.clear();
  vi.resetModules();
  seen = [];
  rig.project = { analytics: { tokensToday: 0 }, details: {} };
  // The API as it answers a split phase: the phase-wide route is refused, the
  // task-scoped one answers.
  rig.submissions.mockReset().mockImplementation(async (_phase: string, taskKey?: string) => {
    if (!taskKey) throw new Error('phase-has-several-tasks');
    return [];
  });
  rig.runs.mockReset().mockResolvedValue([]);
  rig.chatHistory.mockReset().mockResolvedValue(THREAD);
  rig.analyticsMe.mockReset().mockResolvedValue({ tokensToday: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the reviewer’s column on a phase a teacher has split', () => {
  it('reads each task’s revisions and never the phase-wide route', async () => {
    rig.project.details = { p1: { tasks: SPLIT } };
    await renderColumn('p1');

    expect(reads()).toEqual([
      ['p1', 'main'],
      ['p1', 'reminder-story'],
      ['p1', 'story-concepts'],
    ]);
    expect(reads().some(([, key]) => key === undefined)).toBe(false);
    // And the thread it was reading for is on the column.
    expect(seen.map((message) => message.id)).toEqual(['u1', 'a1']);
  });

  it('asks again, task by task, once the provider has said what the tasks are', async () => {
    // Mounted before the provider answered, and the first read came back with
    // nothing: no task list in hand, and no thread held to fall back on.
    rig.chatHistory.mockRejectedValueOnce(new Error('offline'));
    await renderColumn('p2');
    expect(seen).toEqual([]);
    rig.submissions.mockClear();

    rig.project = { ...rig.project, details: { p2: { tasks: SPLIT } } };
    await renderColumn('p2');

    expect(reads()).toEqual([
      ['p2', 'main'],
      ['p2', 'reminder-story'],
      ['p2', 'story-concepts'],
    ]);
    expect(seen.map((message) => message.id)).toEqual(['u1', 'a1']);
  });

  it('keeps the phase-wide route on a phase with one task', async () => {
    rig.submissions.mockReset().mockResolvedValue([]);
    rig.project.details = { p3: { tasks: [task('main', 1)] } };
    await renderColumn('p3');

    expect(reads()).toEqual([['p3', undefined]]);
  });
});
