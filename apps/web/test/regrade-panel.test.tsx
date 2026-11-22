// @vitest-environment jsdom
/**
 * The regrade dry run's two lists, once a phase can hold several tasks.
 *
 * `plan()` skips per (learner, task): one learner with three unsubmitted tasks
 * pushes three `RegradeSkip` rows, and `RegradeSkip` carries only a name and a
 * sentence. Drawn one row per entry, that is the same person three times with
 * nothing to tell the rows apart, under a line calling them three learners:
 * the defect the candidate list was already corrected for, one paragraph down.
 *
 * On a board of sole-task phases a learner is a candidate or a skip and never
 * both, so the first test here is the sentence and the row exactly as they have
 * always read: the grouping must be invisible where there is nothing to group.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegradeBatchView, RegradeCandidate } from '@learnsdlc/shared';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), start: vi.fn(), status: vi.fn() }));

vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    regradePreview: mocks.preview,
    regradeStart: mocks.start,
    regradeStatus: mocks.status,
  },
}));

import { RegradePanel } from '@/components/staff/RegradePanel';

const NO_SUBMISSION = 'No submission in this phase yet.';
const PRUNED = 'Their newest revision lacks its original source or execution context.';
const IN_FLIGHT = 'A submission is still being graded.';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const rows = () => [...(host?.querySelectorAll('[data-testid="regrade-skipped-list"] > li') ?? [])];

/** The controlled-input write React listens to, as the editor's suite does it. */
function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLTextAreaElement | HTMLSelectElement;
  const proto =
    node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

let submissions = 0;
const candidate = (userId: string, displayName: string, taskKey?: string): RegradeCandidate => ({
  userId,
  displayName,
  phaseStateId: `ps-${userId}`,
  submissionId: `sub-${(submissions += 1)}`,
  attempt: 1,
  score: 40,
  passed: false,
  packVersion: '1',
  ...(taskKey ? { taskKey, taskTitle: taskKey } : {}),
});

function dryRun(over: Partial<RegradeBatchView>): RegradeBatchView {
  const candidates = over.candidates ?? [];
  return {
    id: '',
    status: 'running',
    projectSlug: 'tasktrackr',
    phaseKey: 'requirements',
    scope: 'everyone',
    reason: 'the boundary test was wrong',
    packVersionTo: '2',
    requested: candidates.length,
    done: 0,
    failed: 0,
    newPasses: 0,
    skipped: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

async function showPreview(view: RegradeBatchView) {
  mocks.preview.mockResolvedValue(view);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <RegradePanel
        projectSlug="tasktrackr"
        phases={[{ key: 'requirements', title: 'Requirements' }]}
      />,
    );
  });
  await act(async () => type(byId('regrade-phase'), 'requirements'));
  await act(async () => type(byId('regrade-reason'), 'the boundary test was wrong'));
  await act(async () => {
    (byId('regrade-preview') as HTMLButtonElement).click();
  });
}

describe('the regrade\'s reason says it is the regrade\'s', () => {
  it('its visible label and its accessible name start "Reason for the regrade", never a bare "Reason"', async () => {
    await showPreview(dryRun({ candidates: [candidate('u2', 'Bo Tan')], skipped: [] }));
    const field = byId('regrade-reason') as HTMLTextAreaElement;
    expect(field.labels[0].querySelector('.label')?.textContent).toBe('Reason for the regrade');
    expect(field.labels[0].textContent?.startsWith('Reason for the regrade')).toBe(true);
  });
});

describe('the regrade panel’s skipped list', () => {
  it('reads on a sole-task board exactly as it always has', async () => {
    await showPreview(
      dryRun({
        candidates: [candidate('u2', 'Bo Tan')],
        skipped: [{ userId: 'u1', displayName: 'Ada Lovelace', reason: NO_SUBMISSION }],
      }),
    );

    expect(byId('regrade-skipped')?.textContent).toBe('1 learner is not included:');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Ada Lovelace');
    expect(rows()[0].textContent).toContain(NO_SUBMISSION);
  });

  it('counts a learner skipped once per task once, and draws them once', async () => {
    await showPreview(
      dryRun({
        skipped: [
          { userId: 'u1', displayName: 'Ada Lovelace', reason: NO_SUBMISSION },
          { userId: 'u1', displayName: 'Ada Lovelace', reason: NO_SUBMISSION },
          { userId: 'u2', displayName: 'Bo Tan', reason: PRUNED },
        ],
      }),
    );

    // Three entries, two people: the sentence says two, or it tells a teacher
    // three people when it means one person's two tasks.
    expect(byId('regrade-skipped')?.textContent).toBe('2 learners are not included:');
    expect(rows()).toHaveLength(2);
    expect(rows().filter((row) => row.textContent?.includes('Ada Lovelace'))).toHaveLength(1);
  });

  it('keeps both reasons a learner was skipped for', async () => {
    await showPreview(
      dryRun({
        skipped: [
          { userId: 'u1', displayName: 'Ada Lovelace', reason: PRUNED },
          { userId: 'u1', displayName: 'Ada Lovelace', reason: IN_FLIGHT },
        ],
      }),
    );

    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain(PRUNED);
    expect(rows()[0].textContent).toContain(IN_FLIGHT);
  });

  it('does not say a learner is left out when one of their tasks is being regraded', async () => {
    await showPreview(
      dryRun({
        candidates: [candidate('u1', 'Ada Lovelace', 'brief')],
        skipped: [{ userId: 'u1', displayName: 'Ada Lovelace', reason: NO_SUBMISSION }],
      }),
    );

    // Ada is in the list above this one. Saying she is not included is false.
    expect(byId('regrade-skipped')?.textContent).not.toContain('1 learner is not included');
    expect(byId('regrade-skipped')?.textContent).toBe('1 learner has work that is not included:');
  });
});

describe('the regrade panel’s start button', () => {
  it('counts revisions rather than learners', async () => {
    await showPreview(
      dryRun({
        candidates: [candidate('u1', 'Ada Lovelace', 'brief'), candidate('u1', 'Ada Lovelace', 'plan')],
      }),
    );

    // One learner, two tasks. "Regrade 2 learners" is a head count of a number
    // that is not heads, which is what the paragraph above it guards against.
    expect(byId('regrade-start')?.textContent).toBe('Regrade 2 revisions');
  });
});
