// @vitest-environment jsdom
/**
 * The feedback page does not say "No submissions yet" about the
 * review it was sent to show.
 *
 * After Submit for review the Design room calls invalidateProject (which
 * marks the held review history stale and starts the project's revalidation)
 * and sends the learner to /feedback?phase=<id>&submission=<id>. The page
 * mounts on the held history, which predates the submission. While the
 * project revalidates, useReviews holds its read back (`revalidating`), so it
 * reported loading: false and refreshing: false; then the history read ran
 * with refreshing: true. Through both, the page drew its empty state about
 * the phase ("Ready when you are", "Good feedback starts with your work.",
 * "No review recorded", "This review is not in this phase.", "No submissions
 * yet."), all false at that moment, until the read landed with the Pass.
 *
 * Now, while the URL names a submission the held list does not contain and a
 * read that could bring it has not completed since the page asked, the page
 * draws its loading state. When the history it holds was served from the
 * cache, the hook asks the server once. Once a read has completed and the
 * submission is still not there, today's words stand (then they are true).
 *
 * The real useReviews and the real review-history cache, with the history
 * request and the session's token stubbed.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  search: '',
  revalidating: false,
  enrollment: null as unknown,
  history: vi.fn(),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(rig.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/feedback',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ loading: false, revalidating: rig.revalidating, details: {}, enrollment: rig.enrollment }),
}));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { history: rig.history } }));
// The review-history cache keeps nothing without a token; one fixed token, and no owner change.
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getToken: () => 'learner-token',
  ownedByToken: () => () => {},
  onSessionEnd: () => () => {},
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: ({ submissionId }: { submissionId: string }) => <p data-testid="evidence">{`evidence of ${submissionId}`}</p>,
}));

import FeedbackPage from '@/app/(app)/feedback/page';
import { loadReviewHistory, resetReviewHistory, staleReviewHistory } from '@/lib/review-history';

const LOADING = 'Loading your learning record…';
const EMPTY_WORDS = [
  'Ready when you are',
  'Good feedback starts with your work.',
  'No review recorded',
  'This review is not in this phase.',
  'No submissions yet.',
];
const PASS_HEAD = 'Design is ready to build on.';

type Phase = { id: string; key: string; title: string; order: number; status: string; attempts: number };
const enrollmentOf = (design: Partial<Phase> = {}) => ({
  id: 'enrollment',
  projectSlug: 'shelf',
  phases: [
    { id: 'req', key: 'requirements', title: 'Requirements', order: 1, status: 'passed', attempts: 1 },
    { id: 'design', key: 'design', title: 'Design', order: 2, status: 'in_progress', attempts: 0, ...design },
  ] as Phase[],
});
/** useReviews' signature for the held history: each phase's id, attempts and status. */
const signatureOf = (enrollment: ReturnType<typeof enrollmentOf>) => enrollment.phases.map((p) => `${p.id}:${p.attempts}:${p.status}`).join('|');
const row = (id: string, phaseStateId: string, createdAt: string) => ({
  id, phaseStateId, status: 'completed', passed: true, verifiedPass: true, createdAt, reviewUnavailable: false, attempt: 1,
});
const REQ = row('req-1', 'req', '2026-11-16T09:00:00.000Z');
const DESIGN = row('design-1', 'design', '2026-11-17T09:00:00.000Z');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? '';
const draw = async () => {
  await act(async () => root.render(<FeedbackPage />));
};
const expectLoadingOnly = () => {
  expect(text()).toContain(LOADING);
  for (const words of EMPTY_WORDS) expect(text(), words).not.toContain(words);
};

/** The history a Design submit leaves behind: held before the submission, then marked stale by invalidateProject. */
async function holdHistoryBeforeTheSubmit(stale: boolean) {
  const before = enrollmentOf();
  rig.history.mockResolvedValueOnce([REQ]);
  await loadReviewHistory('enrollment:shelf', 'shelf', false, signatureOf(before));
  if (stale) staleReviewHistory();
  rig.history.mockClear();
}

beforeEach(() => {
  resetReviewHistory();
  rig.history.mockReset();
  rig.search = '';
  rig.revalidating = false;
  rig.enrollment = enrollmentOf();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the feedback page for a review it was sent to show', () => {
  it('draws the loading state, not the empty state, while the project revalidates and then while the history read is in flight; then the review', async () => {
    await holdHistoryBeforeTheSubmit(true);
    rig.search = 'phase=design&submission=design-1';
    rig.revalidating = true;
    await draw();
    expectLoadingOnly();

    // The project lands: Design now has its attempt. The history read goes out and is in flight.
    const read = deferred<unknown[]>();
    rig.history.mockReturnValueOnce(read.promise);
    rig.revalidating = false;
    rig.enrollment = enrollmentOf({ status: 'submitted', attempts: 1 });
    await draw();
    expect(rig.history).toHaveBeenCalledTimes(1);
    expectLoadingOnly();

    await act(async () => read.resolve([REQ, DESIGN]));
    expect(text()).toContain(PASS_HEAD);
    expect(host.querySelector('[data-testid="evidence"]')?.textContent).toBe('evidence of design-1');
    expect(text()).not.toContain(LOADING);
    for (const words of EMPTY_WORDS) expect(text(), words).not.toContain(words);
  });

  it('says today\'s words once a read has completed and the review is still not there', async () => {
    await holdHistoryBeforeTheSubmit(true);
    rig.search = 'phase=design&submission=design-1';
    rig.revalidating = true;
    await draw();
    expectLoadingOnly();

    rig.history.mockResolvedValue([REQ]);
    rig.revalidating = false;
    rig.enrollment = enrollmentOf({ status: 'submitted', attempts: 1 });
    await draw();
    // Two reads, no more: the held history was stale, so the first read goes to the server
    // (not forced); it comes back without the review, so the hook forces one more, once
    // (askedFor), and that read answering without it ends the wait.
    expect(rig.history).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain(LOADING);
    for (const words of EMPTY_WORDS) expect(text(), words).toContain(words);
  });

  it('asks the server once when the history it holds was served fresh from the cache without the review', async () => {
    await holdHistoryBeforeTheSubmit(false);
    const read = deferred<unknown[]>();
    rig.history.mockReturnValueOnce(read.promise);
    rig.search = 'phase=design&submission=design-1';
    await draw();
    expect(rig.history, 'the fresh cache did not answer for a review it does not hold').toHaveBeenCalledTimes(1);
    expectLoadingOnly();

    await act(async () => read.resolve([REQ, DESIGN]));
    expect(text()).toContain(PASS_HEAD);
    expect(rig.history).toHaveBeenCalledTimes(1);
  });

  it('keeps today\'s empty state for a phase with no reviews and no submission in the address, with one read', async () => {
    rig.history.mockResolvedValue([REQ]);
    rig.search = 'phase=design';
    await draw();
    expect(text()).not.toContain(LOADING);
    for (const words of ['Ready when you are', 'Good feedback starts with your work.', 'No review recorded', 'Your first review starts here.', 'No submissions yet.']) {
      expect(text(), words).toContain(words);
    }
    expect(text()).not.toContain('This review is not in this phase.');
    expect(rig.history).toHaveBeenCalledTimes(1);
  });

  it('does not read again when the review it was sent to show is already held', async () => {
    const after = enrollmentOf({ status: 'submitted', attempts: 1 });
    rig.enrollment = after;
    rig.history.mockResolvedValueOnce([REQ, DESIGN]);
    await loadReviewHistory('enrollment:shelf', 'shelf', false, signatureOf(after));
    rig.history.mockClear();
    rig.search = 'phase=design&submission=design-1';
    await draw();
    expect(text()).toContain(PASS_HEAD);
    expect(text()).not.toContain(LOADING);
    expect(rig.history).not.toHaveBeenCalled();
  });
});
