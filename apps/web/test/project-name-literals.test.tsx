// @vitest-environment jsdom
/**
 * Two project-name literals that must follow the learner's own project: the
 * Design room's API collection header (not "TaskTrackr: Saved with your
 * design" for everyone), and the file name the completion page saves the
 * record under (not `learnsdlc-tasktrackr-project-record.json` for everyone).
 * Both read the learner's own project, so a TaskTrackr learner's are unchanged.
 *
 * The story content the backlog shows (US-4, the overdue report) is the
 * inherited Requirements task's own content and is not asserted here.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';

const state = vi.hoisted(() => ({
  slug: 'room-desk',
  title: 'RoomDesk — book a meeting room',
  phases: [] as PhaseSummary[],
  saved: [] as string[],
}));
const enrollment = () => ({ id: 'enrollment', projectSlug: state.slug, projectTitle: state.title, completed: true, phases: state.phases });
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ loading: false, enrollment: enrollment() }),
  useProjectMaybe: () => ({ loading: false, enrollment: enrollment() }),
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ displayName: 'Recorded learner' }),
}));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useReviews: () => ({
    reviews: state.phases.map((phase) => ({
      phase,
      submission: { id: `${phase.id}-pass`, phaseStateId: phase.id, status: 'completed', passed: true, verifiedPass: true, reviewUnavailable: false, attempt: 1, createdAt: '2026-09-14T00:00:00Z' },
    })),
    loading: false,
    error: '',
    refresh: vi.fn(),
  }),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: {
    myEnrollment: vi.fn(async () => ({ ...enrollment(), completedAt: '2026-09-14T02:00:00Z' })),
    getSubmissionWithFiles: vi.fn(async (id: string) => ({ id })),
  },
}));
vi.mock('@/lib/api-experience', async (original) => ({
  ...(await original<typeof import('@/lib/api-experience')>()),
  experienceApi: {
    history: vi.fn(async () => state.phases.map((phase) => ({ id: `${phase.id}-pass`, phaseStateId: phase.id, verifiedPass: true }))),
    teacherFeedback: vi.fn(async () => []),
  },
}));
vi.mock('@/lib/download', async (original) => ({
  ...(await original<typeof import('@/lib/download')>()),
  saveBlob: (_blob: Blob, name: string) => state.saved.push(name),
}));

import CompletionPage from '@/app/(app)/completion/page';
import { ApiWorkbench } from '@/components/workspace/panels/design/ApiWorkbench';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const keys = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
  state.phases = keys.map((key, index) => ({ id: key, key, title: key, order: index + 1, status: 'passed', attempts: 1, bestScore: 90, reflection: null, opensAt: null, dueAt: null, passedAt: '2026-09-14T01:00:00Z' }));
  state.saved = [];
  state.slug = 'room-desk';
  state.title = 'RoomDesk — book a meeting room';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const exportRecord = async () => {
  await act(async () => root.render(<CompletionPage />));
  const button = [...host.querySelectorAll('button')].find((one) => one.textContent?.includes('Export project record'));
  expect(button).toBeDefined();
  await act(async () => {
    fireEvent.click(button!);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('the completion record is named for the learner’s project', () => {
  it('saves a RoomDesk learner’s record under RoomDesk’s name', async () => {
    await exportRecord();
    expect(state.saved).toEqual(['learnsdlc-room-desk-project-record.json']);
  });

  it('keeps TaskTrackr’s file name for a TaskTrackr learner', async () => {
    state.slug = 'tasktrackr';
    state.title = 'TaskTrackr — a task manager you can run';
    await exportRecord();
    expect(state.saved).toEqual(['learnsdlc-tasktrackr-project-record.json']);
  });
});

describe('the Design room’s API collection names the learner’s project', () => {
  const contract = JSON.stringify({ operations: [{ id: 'bookRoom', method: 'POST', path: '/api/bookings', success: {}, errors: [] }], errors: {} });
  it('says RoomDesk on RoomDesk and TaskTrackr on TaskTrackr', async () => {
    await act(async () => root.render(<ApiWorkbench files={{ 'shared/contract/api.json': contract }} setFile={vi.fn()} />));
    expect(host.textContent).toContain('RoomDesk: Saved with your design');
    expect(host.textContent).not.toContain('TaskTrackr');
    state.title = 'TaskTrackr — a task manager you can run';
    await act(async () => root.render(<ApiWorkbench files={{ 'shared/contract/api.json': contract, x: '' }} setFile={vi.fn()} />));
    expect(host.textContent).toContain('TaskTrackr: Saved with your design');
  });
});
