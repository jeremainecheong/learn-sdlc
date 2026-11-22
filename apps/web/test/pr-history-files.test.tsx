// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackReport, PhaseDetail, SubmissionView } from '@learnsdlc/shared';

const apiMock = vi.hoisted(() => ({ phase: vi.fn(), submissions: vi.fn(), getSubmissionWithFiles: vi.fn(), submit: vi.fn(), getSubmission: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock, describeError: (error: Error) => error.message }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/useProject', () => ({ invalidateProject: vi.fn() }));
vi.mock('@/lib/commit', () => ({ clearCommitDraft: vi.fn(), commitDraft: () => '' }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: vi.fn(), pollUntil: vi.fn(), PollTimeoutError: class extends Error {} }));
vi.mock('@/components/pr/threads', () => ({ prThreads: () => [], carriedThreads: () => [], threadsOn: () => [] }));
const { usePullRequest } = await import('@/components/pr/usePullRequest');
const { HistoryCard } = await import('@/components/pr/HistoryCard');

let root: Root;
let host: HTMLDivElement;
let held: ReturnType<typeof usePullRequest>;
const path = 'api/repository/comments.py';
const report = (passed: boolean) => ({ passed, overall: 100, checks: [], contract: [], aiReview: { assessmentError: false } }) as unknown as FeedbackReport;
const submissions: SubmissionView[] = [1, 2, 3].map(attempt => ({ id: `r${attempt}`, attempt, status: 'completed', passed: attempt === 1, score: 100, report: report(attempt === 1), createdAt: `2026-09-10T10:0${attempt}:00Z` }));
const full = (id: string, files: Record<string, string> | null = { [path]: `saved ${id}\n` }): SubmissionView => ({ ...submissions.find(row => row.id === id)!, workspaceSnapshot: files });
function Probe() {
  held = usePullRequest('maintenance-phase');
  return <HistoryCard revisions={held.revisions} filesKept={held.filesKept} onOpenFiles={held.selectRevision} />;
}
async function mount() { await act(async () => root.render(<Probe />)); }
async function select(id: string | null) { await act(async () => held.selectRevision(id)); }
beforeEach(() => {
  vi.clearAllMocks();
  apiMock.phase.mockResolvedValue({ id: 'maintenance-phase', key: 'maintenance', place: 6, count: 6, projectSlug: 'tasktrackr', status: 'in_progress', rubric: {} } as PhaseDetail);
  apiMock.submissions.mockResolvedValue(submissions);
  apiMock.getSubmissionWithFiles.mockImplementation(async id => full(id));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
  expect(host.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
  act(() => root.unmount()); host.remove(); expect(apiMock.submit).not.toHaveBeenCalled();
});

describe('historical pull-request files remain independent of the current gate', () => {
  it('opens an unfetched historical row by its exact id and returns to latest without changing the latest failed verdict', async () => {
    await mount();
    expect(held.fileRevision?.id).toBe('r3'); expect(held.fileBase?.id).toBe('r2');
    expect(apiMock.getSubmissionWithFiles.mock.calls.map(args => args[0]).sort()).toEqual(['r2', 'r3']);
    const oldButton = host.querySelector<HTMLButtonElement>('[data-testid="pr-history-files-1"]')!;
    expect(oldButton).not.toBeNull();
    await act(async () => oldButton.click());
    expect(held.fileRevision?.id).toBe('r1'); expect(held.fileBase).toBeNull();
    expect(held.diffs[0].hunks.flatMap(hunk => hunk.lines).map(line => line.text)).toEqual(['saved r1']);
    expect(held.head?.id).toBe('r3'); expect(held.head?.report?.passed).toBe(false);
    expect(held.detail?.status).toBe('in_progress');
    await select(null);
    expect(held.fileRevision?.id).toBe('r3'); expect(held.baseAttempt).toBe(2);
    expect(held.diffs[0].hunks.flatMap(hunk => hunk.lines).map(line => [line.kind, line.text])).toEqual([['-', 'saved r2'], ['+', 'saved r3']]);
    expect(apiMock.getSubmissionWithFiles).toHaveBeenCalledTimes(3);
  });

  it('compares the chosen revision with its own previous snapshot, including deleted files', async () => {
    apiMock.getSubmissionWithFiles.mockImplementation(async id => full(id, id === 'r1' ? { [path]: 'old\n', 'removed.txt': 'retained historical text\n' } : { [path]: `${id}\n` }));
    await mount(); await select('r2');
    expect(held.fileBase?.id).toBe('r1'); expect(held.head?.id).toBe('r3');
    const changed = held.diffs.find(diff => diff.path === path)!;
    expect(changed.hunks.flatMap(hunk => hunk.lines).map(line => [line.kind, line.text])).toEqual([['-', 'old'], ['+', 'r2']]);
    expect(held.diffs.find(diff => diff.path === 'removed.txt')?.dels).toBe(1);
  });

  it('does not turn a missing historical base into a fabricated all-added diff', async () => {
    apiMock.getSubmissionWithFiles.mockImplementation(async id => full(id, id === 'r1' ? null : { [path]: `${id}\n` }));
    await mount(); await select('r2');
    expect(held.baseFilesPruned).toBe(true); expect(held.filesPruned).toBe(false);
    expect(held.diffs).toEqual([]); expect(held.filesLoading).toBe(false);
    await select('r1'); expect(held.filesPruned).toBe(true); expect(held.diffs).toEqual([]);
    expect(held.head?.report?.passed).toBe(false);
  });

  it('exposes and retries a snapshot read failure while preserving the selected id and gate', async () => {
    let failed = false;
    apiMock.getSubmissionWithFiles.mockImplementation(async id => {
      if (id === 'r1' && !failed) { failed = true; throw new Error('Connection interrupted'); }
      return full(id);
    });
    await mount(); await select('r1');
    expect(held.filesError).toBe('Connection interrupted'); expect(held.diffs).toEqual([]);
    await act(async () => held.retryFiles());
    expect(held.filesError).toBe(''); expect(held.fileRevision?.id).toBe('r1');
    expect(held.diffs[0].hunks[0].lines[0].text).toBe('saved r1');
    expect(held.head?.id).toBe('r3');
  });

  it.each([
    ['Connection interrupted', 'Connection interrupted', 'Connection interrupted'],
    ['Latest revision unavailable', 'Earlier revision unavailable', 'Latest revision unavailable Earlier revision unavailable'],
  ])('shows concurrent snapshot failures without repeating identical messages', async (latest, earlier, expected) => {
    apiMock.getSubmissionWithFiles.mockImplementation(async id => {
      throw new Error(id === 'r3' ? latest : earlier);
    });
    await mount();
    expect(held.filesError).toBe(expected);
    expect(held.fileRevision?.id).toBe('r3');
    expect(held.fileBase?.id).toBe('r2');
    expect(held.diffs).toEqual([]);
    expect(held.head?.report?.passed).toBe(false);
  });

  it('never lists a room record in the diff: the change request and the runbook are written through forms', async () => {
    apiMock.getSubmissionWithFiles.mockImplementation(async id => full(id, {
      'api/x.py': `x = '${id}'\n`,
      'maintenance/change-request.json': `{"notes": "${id}"}\n`,
      'deployment/runbook.json': `{"notes": "${id}"}\n`,
    }));
    await mount();
    expect(held.fileRevision?.id).toBe('r3'); expect(held.fileBase?.id).toBe('r2');
    expect(held.diffs.map(diff => diff.path)).toEqual(['api/x.py']);
  });

  it('ignores an old snapshot response after the learner returns to latest', async () => {
    let resolve!: (value: SubmissionView) => void;
    const pending = new Promise<SubmissionView>(done => { resolve = done; });
    apiMock.getSubmissionWithFiles.mockImplementation(id => id === 'r1' ? pending : Promise.resolve(full(id)));
    await mount(); await select('r1'); expect(held.filesLoading).toBe(true);
    await select(null);
    await act(async () => resolve(full('r1')));
    expect(held.fileRevision?.id).toBe('r3'); expect(held.fileBase?.id).toBe('r2');
    expect(held.filesKept('r1')).toBeUndefined();
    expect(held.diffs[0].hunks.flatMap(hunk => hunk.lines).some(line => line.text === 'saved r1')).toBe(false);
  });
});
