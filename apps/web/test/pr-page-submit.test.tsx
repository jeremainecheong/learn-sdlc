// @vitest-environment jsdom
/**
 * A Submit pressed on the pull request page
 * puts the new submission into the pull request as soon as the API has taken
 * it, not when its review settles. The hook is mounted for real (only the API,
 * the poll and the threads are stood in for): while the review runs the newest
 * revision is the queued one, so the page's chip reads "Reviewing", the count
 * includes it and the queue line follows it; the list read after the verdict
 * replaces that row instead of adding a second; a submit the API refused adds
 * nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackReport, PhaseDetail, SubmissionView } from '@learnsdlc/shared';

const apiMock = vi.hoisted(() => ({ phase: vi.fn(), submissions: vi.fn(), getSubmissionWithFiles: vi.fn(), submit: vi.fn(), getSubmission: vi.fn() }));
const poll = vi.hoisted(() => ({ release: null as null | (() => void), pollUntil: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock, describeError: (error: Error) => error.message }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/useProject', () => ({ invalidateProject: vi.fn() }));
vi.mock('@/lib/commit', () => ({ clearCommitDraft: vi.fn(), commitDraft: () => '' }));
vi.mock('@/lib/job-signal', () => ({ jobWake: () => undefined }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: vi.fn(), pollUntil: poll.pollUntil, PollTimeoutError: class extends Error {} }));
vi.mock('@/components/pr/threads', () => ({ prThreads: () => [], carriedThreads: () => [], threadsOn: () => [] }));
const { usePullRequest } = await import('@/components/pr/usePullRequest');

let root: Root;
let host: HTMLDivElement;
let held: ReturnType<typeof usePullRequest>;
const report = (passed: boolean) => ({ passed, overall: passed ? 90 : 40, passThreshold: 70, checks: [], contract: [], aiReview: { assessmentError: false } }) as unknown as FeedbackReport;
const graded = (id: string, attempt: number): SubmissionView => ({ id, attempt, status: 'completed', passed: false, score: 40, report: report(false), createdAt: `2026-11-17T03:0${attempt}:00Z` });
// What `api.submit` returns: the API's `toView` of the new row, with no attempt number.
const queued = (id: string, minute: number): SubmissionView => ({ id, status: 'queued', passed: null, score: null, report: null, createdAt: `2026-11-17T03:0${minute}:00Z`, commitMessage: null });

function Probe() {
  held = usePullRequest('implementation-phase');
  return null;
}
async function mount() { await act(async () => root.render(<Probe />)); }
/** Press Submit; the API takes it, and the review stays running until `settle()`. */
async function press(): Promise<{ done: Promise<void> }> {
  let done!: Promise<void>;
  await act(async () => { done = held.submit(); });
  // Wrapped, so awaiting this does not wait for the review.
  return { done };
}
async function settle(done: Promise<void>) {
  await act(async () => { poll.release?.(); await done; });
}

beforeEach(() => {
  vi.clearAllMocks();
  poll.release = null;
  poll.pollUntil.mockImplementation(() => new Promise<void>((resolve) => { poll.release = resolve; }));
  apiMock.phase.mockResolvedValue({ id: 'implementation-phase', key: 'implementation', place: 3, count: 6, projectSlug: 'deadline', status: 'in_progress', rubric: { passThreshold: 70 }, tasks: [] } as unknown as PhaseDetail);
  apiMock.getSubmissionWithFiles.mockImplementation(async (id: string) => ({ id, workspaceSnapshot: {} }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('a Submit pressed on the pull request page is in the pull request while it is reviewed', () => {
  it('the first submission: one revision, attempt 1, in review, before its verdict; the read after the verdict replaces it', async () => {
    apiMock.submissions.mockResolvedValueOnce([]);
    await mount();
    expect(held.revisions).toEqual([]);
    apiMock.submit.mockResolvedValueOnce(queued('s1', 5));

    const { done } = await press();
    expect(held.busy).toBe(true);
    expect(poll.pollUntil).toHaveBeenCalledTimes(1);
    // The page's chip reads "Reviewing" off this state; the line "Opened …, 1 submission" off the count.
    expect(held.revisions.map((r) => [r.id, r.attempt, r.state])).toEqual([['s1', 1, 'now']]);
    expect(held.head).toBeNull();
    expect(held.openedAt).not.toBe('');

    apiMock.submissions.mockResolvedValueOnce([{ ...graded('s1', 1), createdAt: '2026-11-17T03:05:00Z' }]);
    await settle(done);
    expect(held.busy).toBe(false);
    expect(held.revisions.map((r) => [r.id, r.attempt, r.state])).toEqual([['s1', 1, 'fail']]);
    expect(held.head?.id).toBe('s1');
  });

  it('a later submission takes the next attempt and is the newest revision; the read after the verdict holds each once', async () => {
    apiMock.submissions.mockResolvedValueOnce([graded('r1', 1)]);
    await mount();
    apiMock.submit.mockResolvedValueOnce(queued('r2', 6));

    const { done } = await press();
    expect(held.revisions.map((r) => [r.id, r.attempt, r.state])).toEqual([['r1', 1, 'fail'], ['r2', 2, 'now']]);
    // The verdict on show is still the last one in.
    expect(held.head?.id).toBe('r1');

    apiMock.submissions.mockResolvedValueOnce([graded('r1', 1), graded('r2', 2)]);
    await settle(done);
    expect(held.revisions.map((r) => [r.id, r.attempt, r.state])).toEqual([['r1', 1, 'fail'], ['r2', 2, 'fail']]);
    expect(held.head?.id).toBe('r2');
  });

  it('a read of the list during the review, which already holds the queued row, keeps it once', async () => {
    apiMock.submissions.mockResolvedValueOnce([]);
    await mount();
    apiMock.submit.mockResolvedValueOnce(queued('s1', 5));
    const { done } = await press();
    expect(held.revisions).toHaveLength(1);

    apiMock.submissions.mockResolvedValueOnce([{ ...queued('s1', 5), status: 'running', attempt: 1 }]);
    await act(async () => { await held.reload(); });
    expect(held.revisions.map((r) => [r.id, r.attempt, r.state])).toEqual([['s1', 1, 'now']]);

    apiMock.submissions.mockResolvedValueOnce([graded('s1', 1)]);
    await settle(done);
    expect(held.revisions.map((r) => r.id)).toEqual(['s1']);
  });

  it('a submit the API refuses adds nothing: no revision, the error shown, nothing polled', async () => {
    apiMock.submissions.mockResolvedValueOnce([]);
    await mount();
    apiMock.submit.mockRejectedValueOnce(new Error('The review queue is full. Try again in a minute.'));

    await act(async () => { await held.submit(); });
    expect(held.revisions).toEqual([]);
    expect(held.error).toBe('The review queue is full. Try again in a minute.');
    expect(held.busy).toBe(false);
    expect(poll.pollUntil).not.toHaveBeenCalled();
  });
});
