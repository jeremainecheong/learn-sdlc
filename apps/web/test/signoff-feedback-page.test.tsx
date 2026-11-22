// @vitest-environment jsdom
/**
 * The feedback page (where the dashboard's "Open feedback" goes), mounted as
 * its route exports it, on a phase whose review passed and which waits on the
 * teacher's countersignature.
 *
 * The hero must not say "<Phase> is ready to build on." or "This phase passed
 * its evidence review... as you move forward." while the next phase is still
 * shut. While the countersignature is pending the hero reads the sign-off
 * words (AWAITING_SIGN_OFF, SIGN_OFF_PASS_LINE), judged the way the dashboard
 * judges its line (`reviewAwaitsSignOff`); every other state is unaffected.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  details: {} as Record<string, unknown>,
  reviews: [] as unknown[],
  search: '',
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
  useProject: () => ({
    loading: false,
    details: rig.details,
    enrollment: {
      id: 'enrollment',
      projectSlug: 'shelf',
      // Requirements has a phase after it, so the sign-off words are the
      // ones that say the next phase opens (the project's last phase
      // reads its own, pinned in signoff-last-phase.test.tsx).
      phases: [
        { id: 'req', key: 'requirements', title: 'Requirements', order: 1, status: 'submitted', attempts: 1 },
        { id: 'des', key: 'design', title: 'Design', order: 2, status: 'locked', attempts: 0 },
      ],
    },
  }),
}));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({ reviews: rig.reviews, hasLoaded: true, loading: false, refreshing: false, refreshError: '', error: '', refresh: () => {} }),
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

import FeedbackPage from '@/app/(app)/feedback/page';
import { AWAITING_SIGN_OFF, SIGN_OFF_PASS_LINE } from '@/components/workspace/signoff-status';

const TODAY_HEAD = 'Requirements is ready to build on.';
const TODAY_BODY = 'This phase passed its evidence review. Keep the decisions and their supporting artefacts together as you move forward.';
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main', order: 1, required: true, title: 'Your story', artefactType: 'user-story', evidence: 'signed-off', sealed: true,
  status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88, passedAt: null, lastSubmissionId: 'rev-1', resetAt: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
const detail = (tasks: unknown[], status = 'submitted') => ({ id: 'req', key: 'requirements', title: 'Requirements', order: 1, status, tasks });
const review = (id: string, passed: boolean, createdAt: string) => ({
  phase: { id: 'req', key: 'requirements', title: 'Requirements', order: 1, status: 'submitted', attempts: 1 },
  submission: { id, phaseStateId: 'req', status: 'completed', passed, verifiedPass: passed, createdAt, reviewUnavailable: false, attempt: id === 'rev-1' ? 1 : 2 },
});

let host: HTMLDivElement, root: Root;
const hero = () => host.querySelector('.exp-result-main')!;
const mount = async () => {
  await act(async () => root.render(<FeedbackPage />));
};

beforeEach(() => {
  rig.search = '';
  rig.details = { req: detail([task()]) };
  rig.reviews = [review('rev-1', true, '2026-10-02T05:00:00.000Z')];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the feedback page while the phase waits on the countersignature', () => {
  it('one-task phase: the hero names the sign-off, never "ready to build on" or "move forward"', async () => {
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(`${AWAITING_SIGN_OFF}.`);
    expect(hero().querySelector('p')!.textContent).toBe(SIGN_OFF_PASS_LINE);
    expect(hero().textContent).not.toContain(TODAY_HEAD);
    expect(hero().textContent).not.toContain('move forward');
  });

  it('split phase whose required tasks all passed or wait: the same words', async () => {
    rig.details = { req: detail([task(), task({ key: 'quiz', order: 2, artefactType: 'quiz', evidence: 'automated', status: 'passed', awaitingSignOff: false })]) };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(`${AWAITING_SIGN_OFF}.`);
    expect(hero().querySelector('p')!.textContent).toBe(SIGN_OFF_PASS_LINE);
  });
});

describe("every other state of the page reads its own words, with no countersignature line", () => {
  it('after the countersignature: today\'s pass words', async () => {
    rig.details = { req: detail([task({ status: 'passed', awaitingSignOff: false })], 'passed') };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
    expect(hero().querySelector('p')!.textContent).toBe(TODAY_BODY);
  });

  it('a pass on a task nobody marked: today\'s pass words', async () => {
    rig.details = { req: detail([task({ evidence: 'reviewed', status: 'passed', awaitingSignOff: false })], 'passed') };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
  });

  it('a refused review: today\'s revision words, whatever the flag says', async () => {
    rig.details = { req: detail([task({ awaitingSignOff: false })]) };
    rig.reviews = [review('rev-2', false, '2026-10-02T06:00:00.000Z')];
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe('Use the feedback. Strengthen your work.');
    expect(hero().textContent).not.toContain(SIGN_OFF_PASS_LINE);
  });

  it('no held detail for the phase: today\'s pass words', async () => {
    rig.details = {};
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
    expect(hero().querySelector('p')!.textContent).toBe(TODAY_BODY);
  });

  // An earlier PASSING review opened from the history, on
  // a one-task phase whose newest review was refused. The learner has left
  // the sign-off queue (a refused verdict clears the flag), so the hero must
  // not say they are in it. Reached two ways: a refused resubmit after the
  // pass, and a teacher's reopen followed by a refused resubmit.
  for (const [shape, held] of [
    ['pass then a refused resubmit', task({ awaitingSignOff: false, lastSubmissionId: 'rev-2' })],
    // A teacher's reopen writes in_progress and clears the flag; it sets no resetAt.
    ['reopened, then a refused resubmit', task({ status: 'in_progress', awaitingSignOff: false, lastSubmissionId: 'rev-2', resetAt: null })],
  ] as const) {
    it(`an earlier passing review opened from the history (${shape}): today's pass heading, not the sign-off`, async () => {
      rig.details = { req: detail([held]) };
      rig.reviews = [review('rev-1', true, '2026-10-02T05:00:00.000Z'), review('rev-2', false, '2026-10-02T06:00:00.000Z')];
      rig.search = 'phase=req&submission=rev-1';
      await mount();
      expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
      expect(hero().textContent).not.toContain(AWAITING_SIGN_OFF);
      expect(hero().textContent).not.toContain(SIGN_OFF_PASS_LINE);
    });
  }

  it('an earlier passing review opened while the phase still waits: the heading names the sign-off', async () => {
    rig.reviews = [review('rev-1', true, '2026-10-02T05:00:00.000Z'), review('rev-2', true, '2026-10-02T06:00:00.000Z')];
    rig.details = { req: detail([task({ lastSubmissionId: 'rev-2' })]) };
    rig.search = 'phase=req&submission=rev-1';
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(`${AWAITING_SIGN_OFF}.`);
  });

  it('an earlier review opened by link: the earlier-review sentence stays', async () => {
    rig.reviews = [review('rev-1', true, '2026-10-02T05:00:00.000Z'), review('rev-2', true, '2026-10-02T06:00:00.000Z')];
    rig.search = 'phase=req&submission=rev-1';
    await mount();
    expect(hero().querySelector('p')!.textContent).toBe(
      'You are viewing an earlier review. Its feedback and submitted evidence stay in your revision history.',
    );
  });
});
