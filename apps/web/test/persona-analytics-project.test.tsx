// @vitest-environment jsdom
/**
 * The mentor column's usage count names the project on screen.
 *
 * `GET /analytics/me` without a project answers the learner's OLDEST
 * enrolment: the server's documented rule is that callers say which. For a
 * learner whose class works another project, the oldest is the one set aside
 * for it. The column falls back to this read only when the shell has no
 * analytics in hand, and then asks for the project the shell is drawn around,
 * as `useProject` does.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  submissions: vi.fn(),
  runs: vi.fn(),
  chatHistory: vi.fn(),
  analyticsMe: vi.fn(),
  project: null as null | { slug: string; analytics: null | { tokensToday: number }; details: Record<string, unknown> },
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

let host: HTMLDivElement;
let root: Root;

async function renderColumn() {
  const { usePersona } = await import('@/components/shell/PersonaPanel');
  function Column() {
    usePersona({ phaseKey: 'requirements', phaseStateId: 'phase-1' });
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

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
  rig.submissions.mockReset().mockResolvedValue([]);
  rig.runs.mockReset().mockResolvedValue([]);
  rig.chatHistory.mockReset().mockResolvedValue([]);
  rig.analyticsMe.mockReset().mockResolvedValue({ tokensToday: 3 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('asks for the usage of the project the shell is drawn around', async () => {
  rig.project = { slug: 'library-desk', analytics: null, details: {} };
  await renderColumn();

  expect(rig.analyticsMe).toHaveBeenCalledTimes(1);
  expect(rig.analyticsMe).toHaveBeenCalledWith('library-desk');
});

it('asks nothing when the shell already holds the analytics', async () => {
  rig.project = { slug: 'library-desk', analytics: { tokensToday: 0 }, details: {} };
  await renderColumn();

  expect(rig.analyticsMe).not.toHaveBeenCalled();
});

it('names nothing where there is no project to name', async () => {
  rig.project = null;
  await renderColumn();

  expect(rig.analyticsMe).toHaveBeenCalledTimes(1);
  expect(rig.analyticsMe.mock.calls[0][0]).toBeUndefined();
});

it('names nothing for a learner who has not started the project the shell resolves', async () => {
  rig.project = { slug: '', analytics: null, details: {} };
  await renderColumn();

  expect(rig.analyticsMe).toHaveBeenCalledTimes(1);
  expect(rig.analyticsMe.mock.calls[0][0]).toBeUndefined();
});
