// @vitest-environment jsdom
/**
 * The feedback page's hero, mounted as its route exports it, on a split
 * phase with one task waiting on the teacher's countersignature and a
 * required sibling still open.
 *
 * The hero must not say "<Phase> is ready to build on." or "This phase
 * passed its evidence review" while the phase has not passed. It reads the
 * dashboard's neutral words and names what is still open. The guard rows
 * hold single-task and fully-passed phases unchanged.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAxe } from './support/axe-bridge';

const task = (over: Record<string, unknown> = {}) => ({
  key: 'main',
  order: 1,
  required: true,
  title: 'Your test suite',
  artefactType: 'code',
  evidence: 'signed-off',
  sealed: true,
  status: 'submitted',
  awaitingSignOff: true,
  attempts: 1,
  bestScore: 88,
  passedAt: null,
  lastSubmissionId: 'rev-1',
  resetAt: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
const quiz = (over: Record<string, unknown> = {}) =>
  task({
    key: 'quiz',
    order: 2,
    title: 'Check your understanding',
    artefactType: 'quiz',
    evidence: 'automated',
    status: 'passed',
    awaitingSignOff: false,
    bestScore: 100,
    passedAt: '2026-10-02T04:00:00.000Z',
    lastSubmissionId: 'q-1',
    ...over,
  });
const openQuiz = () => quiz({ status: 'in_progress', attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null });

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
      // A locked Design after it, so Requirements is not the project's last phase.
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

const { default: FeedbackPage } = await import('@/app/(app)/feedback/page');

const TODAY_HEAD = 'Requirements is ready to build on.';
const TODAY_BODY = 'This phase passed its evidence review. Keep the decisions and their supporting artefacts together as you move forward.';
const story = (over: Record<string, unknown> = {}) => task({ title: 'Your story', artefactType: 'user-story', ...over });
const reqDetail = (tasks: unknown[], status = 'submitted') => ({ id: 'req', key: 'requirements', title: 'Requirements', order: 1, status, tasks });
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
  rig.details = { req: reqDetail([story(), openQuiz()]) };
  rig.reviews = [review('rev-1', true, '2026-10-02T05:00:00.000Z')];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a split phase with a task waiting and a required sibling still open', () => {
  it('does not say the phase is ready to build on; it reads neutrally and names what is still open', async () => {
    await mount();
    expect(hero().textContent).not.toContain('is ready to build on.');
    expect(hero().textContent).not.toContain('This phase passed its evidence review');
    expect(hero().querySelector('h2')!.textContent).toBe('Your work passed review.');
    expect(hero().querySelector('p')!.textContent).toBe(
      "Still open in Requirements: Check your understanding. The next phase opens once it passes and your teacher countersigns your work.",
    );
  });

  it('names every open required task, and never an optional one', async () => {
    rig.details = {
      req: reqDetail([
        story(),
        openQuiz(),
        task({ key: 'design', order: 3, title: 'Sketch the screens', evidence: 'reviewed', status: 'in_progress', awaitingSignOff: false, attempts: 0, lastSubmissionId: null }),
        task({ key: 'extra', order: 4, required: false, title: 'Optional reading', evidence: 'automated', status: 'in_progress', awaitingSignOff: false, attempts: 0, lastSubmissionId: null }),
      ]),
    };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe('Your work passed review.');
    expect(hero().querySelector('p')!.textContent).toBe(
      "Still open in Requirements: Check your understanding and Sketch the screens. The next phase opens once they pass and your teacher countersigns your work.",
    );
    expect(hero().textContent).not.toContain('Optional reading');
  });

  it('an earlier passing review opened from the history: the heading is neutral too', async () => {
    rig.reviews = [review('rev-1', true, '2026-10-02T05:00:00.000Z'), review('rev-2', true, '2026-10-02T06:00:00.000Z')];
    rig.search = 'phase=req&submission=rev-1';
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe('Your work passed review.');
    expect(hero().querySelector('p')!.textContent).toBe(
      'You are viewing an earlier review. Its feedback and submitted evidence stay in your revision history.',
    );
  });

  it('axe finds nothing on the hero', async () => {
    await mount();
    const axe = await loadAxe();
    const result = await axe.run(hero(), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('single-task and fully-passed phases read the sign-off and pass words', () => {
  it('one-task phase waiting: the sign-off words', async () => {
    rig.details = { req: reqDetail([story()]) };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe("Awaiting your teacher's sign-off.");
  });

  it('split phase, every required task passed or waiting: the sign-off words', async () => {
    rig.details = { req: reqDetail([story(), quiz()]) };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe("Awaiting your teacher's sign-off.");
  });

  it('a fully passed split phase: today\'s pass words', async () => {
    rig.details = { req: reqDetail([story({ status: 'passed', awaitingSignOff: false }), quiz()], 'passed') };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
    expect(hero().querySelector('p')!.textContent).toBe(TODAY_BODY);
  });

  it('a one-task phase after the countersignature: today\'s pass words', async () => {
    rig.details = { req: reqDetail([story({ status: 'passed', awaitingSignOff: false })], 'passed') };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
    expect(hero().querySelector('p')!.textContent).toBe(TODAY_BODY);
  });

  it('a split phase with a sibling open and no task waiting: today\'s words (not this item)', async () => {
    rig.details = { req: reqDetail([story({ evidence: 'reviewed', status: 'passed', awaitingSignOff: false }), openQuiz()]) };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
  });

  it('a refused review on the split phase: today\'s revision words', async () => {
    rig.reviews = [review('rev-2', false, '2026-10-02T06:00:00.000Z')];
    rig.details = { req: reqDetail([story({ awaitingSignOff: false }), openQuiz()]) };
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe('Use the feedback. Strengthen your work.');
  });

  it('no held detail: today\'s pass words', async () => {
    rig.details = {};
    await mount();
    expect(hero().querySelector('h2')!.textContent).toBe(TODAY_HEAD);
  });
});
