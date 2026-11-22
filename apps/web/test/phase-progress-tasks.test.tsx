// @vitest-environment jsdom
/**
 * What the pages a learner actually opens say about a phase's tasks.
 *
 * "n of m required" and the submission-count sentence must reach a learner of
 * a split phase outside the two room headers. These cases render the real
 * pages the routes export, so deleting the line from a mounted tile fails
 * here.
 *
 * The first case of each pair is the equivalence one. Every phase of every
 * imported project, and every phase of a teacher's project until somebody
 * splits one, holds a single task; the tile for it has to draw exactly what it
 * drew before the field existed, to the byte. A locked phase has no work in it
 * to count and stays silent for the same reason.
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSummary, PhaseTaskCounts } from '@learnsdlc/shared';
import DashboardPage from '@/app/(app)/dashboard/page';
import ProgressPage from '@/app/(app)/progress/page';
import PortfolioPage from '@/app/(app)/artefacts/page';
import ProfilePage from '@/app/(app)/profile/page';
import { CompactPhasePath } from '@/components/experience/shared';
import type { SubmissionHistoryItem } from '@/lib/api-experience';
import { taskCountLine } from '@/components/workspace/TaskPanel';

type ReviewRow = { phase: PhaseSummary; submission: SubmissionHistoryItem };

const mocks = vi.hoisted(() => ({ phases: [] as PhaseSummary[], reviews: [] as ReviewRow[], map: null as unknown, revalidating: false }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
// Home's project map opens a block's phase door through the app router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ enrollment: { id: 'enrollment', phases: mocks.phases }, currentPhase: mocks.phases[0], loading: false, map: mocks.map, revalidating: mocks.revalidating }),
}));
vi.mock('@/lib/session', async original => ({
  ...await original<typeof import('@/lib/session')>(),
  useSession: () => ({ id: 'owner', role: 'LEARNER', displayName: 'Learner', email: 'learner@example.test', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/components/experience/shared', async original => ({
  ...await original<typeof import('@/components/experience/shared')>(),
  useReviews: () => ({ reviews: mocks.reviews, hasLoaded: true, loading: false, refreshing: false, refreshError: '', error: '', refresh: vi.fn() }),
}));

const SOLE: PhaseTaskCounts = { total: 1, required: 1, passed: 0, passedRequired: 0 };
const SPLIT: PhaseTaskCounts = { total: 3, required: 2, passed: 1, passedRequired: 1 };

const phase = (over: Partial<PhaseSummary> = {}): PhaseSummary => ({
  id: 'phase-one',
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
  ...over,
});

/** A recorded revision of that phase, verified-passing unless a case says otherwise. */
const review = (over: Partial<SubmissionHistoryItem> = {}): ReviewRow => ({
  phase: phase(),
  submission: {
    id: 'submission-one',
    phaseStateId: 'phase-one',
    status: 'completed',
    passed: true,
    verifiedPass: true,
    createdAt: '2026-09-18T09:00:00.000Z',
    commitMessage: null,
    attempt: 1,
    ...over,
  },
});

/**
 * The page a route exports, drawn once: its whole markup, and the first tile
 * of the six-tile path on its own.
 *
 * `useId` mints a fresh token for every root this file creates (the progress
 * page's scroll region owns one) so two drawings of the same page never agree
 * on it. It is React's own handle and not a word of the page, so it is the one
 * thing normalised before two drawings are compared.
 *
 * The tile is read separately because a page carries other panels that word a
 * verdict too (the dashboard's latest-feedback card is one) and a claim about
 * what a tile says has to be read off the tile.
 */
const drawn = async (
  Page: () => ReactNode,
  phases: PhaseSummary[],
  reviews: ReviewRow[] = [],
): Promise<{ html: string; step: string }> => {
  mocks.phases = phases;
  mocks.reviews = reviews;
  const box = document.createElement('div');
  document.body.append(box);
  const tree = createRoot(box);
  await act(async () => tree.render(<Page /> as never));
  const html = box.innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_');
  const step = box.querySelector('.exp-phase-step')?.textContent ?? '';
  await act(async () => tree.unmount());
  box.remove();
  return { html, step };
};

const draw = async (
  Page: () => ReactNode,
  phases: PhaseSummary[],
  reviews: ReviewRow[] = [],
): Promise<string> => (await drawn(Page, phases, reviews)).html;

const pages = [
  ['home', DashboardPage],
  ['progress', ProgressPage],
  ['portfolio', PortfolioPage],
] as const;
/** The two pages that mount the six-tile path. The portfolio draws its own panels. */
const tiles = pages.filter(([name]) => name !== 'portfolio');

beforeEach(() => { mocks.phases = []; mocks.reviews = []; mocks.map = null; mocks.revalidating = false; });
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

describe('the phase tiles a route mounts', () => {
  it.each(pages)('says nothing about tasks on %s where the phase holds one', async (_name, Page) => {
    // A payload written before the field existed, and one written after it on a
    // phase with a single authored task: the same markup, to the byte.
    const before = await draw(Page, [phase({ attempts: 3 })]);
    const sole = await draw(Page, [phase({ attempts: 3, taskCounts: SOLE })]);

    expect(sole).toBe(before);
    expect(sole).not.toContain(taskCountLine(SOLE));
    expect(sole).not.toContain('submissions across');
  });

  it.each(pages)('says how far a split phase has got on %s, in the words every other surface uses', async (_name, Page) => {
    const html = await draw(Page, [phase({ attempts: 4, taskCounts: SPLIT })]);

    // Character for character `taskCountLine`'s answer: the tile derives no
    // second wording for the same numbers.
    expect(html).toContain(taskCountLine(SPLIT));
    expect(html).toContain('1 of 2 required done. Optional: 0 of 1 done');
  });

  it.each(tiles)('says on %s what the submission count of a split phase is counting', async (_name, Page) => {
    // A declared looseness of split phases, on screen rather than in a
    // document: `phase_states.attempts` stays one incremental counter for the
    // whole phase, so on a split phase it is a sum over its tasks.
    const html = await draw(Page, [phase({ attempts: 4, taskCounts: SPLIT })]);

    expect(html).toContain('4 submissions across 3 tasks');
  });

  it.each(tiles)('says nothing about a sum on %s before there is one', async (_name, Page) => {
    // The sentence exists to say that a count is a sum over the tasks. With no
    // submissions there is no count to misread, and "0 submissions across 3
    // tasks" under a tile that already says "Ready to begin" is the same
    // nothing said twice. How far the tasks have got is still worth a line.
    const html = await draw(Page, [phase({ attempts: 0, taskCounts: { total: 3, required: 2, passed: 0, passedRequired: 0 } })]);

    expect(html).toContain('0 of 2 required done. Optional: 0 of 1 done');
    expect(html).not.toContain('submissions across');
  });

  it.each(tiles)('counts one submission as one on %s', async (_name, Page) => {
    const html = await draw(Page, [phase({ attempts: 1, taskCounts: { total: 2, required: 2, passed: 0, passedRequired: 0 } })]);

    expect(html).toContain('1 submission across 2 tasks');
    expect(html).not.toContain('1 submissions');
  });

  it.each(tiles)('keeps one task\'s verdict out of a split phase\'s standing line on %s', async (_name, Page) => {
    // A verified pass on one required task of a split phase is routine while
    // the phase stays shut (the roll-up is quantified over every
    // required key) and the newest revision of the phase is then a Pass. The
    // slot the five sibling tiles use for where the *phase* stands would read
    // "Pass" on a tile whose next phase is still locked. It says what the phase
    // itself says instead, and the counts line below carries how far it has got.
    const { step } = await drawn(
      Page,
      [phase({ status: 'submitted', attempts: 2, taskCounts: SPLIT })],
      [review()],
    );

    // Not "In review". A split phase reads `submitted` after ANY verdict that
    // leaves its gate shut (`phaseRollup` writes it over a passed task as
    // readily as over a refused one) so "In review" here would be the phase's
    // status word and not a fact: the newest revision has been marked, and passed. What the tile says
    // is that the phase is still being worked, which is true.
    expect(step).toContain('In progress');
    expect(step).not.toContain('In review');
    expect(step).toContain('1 of 2 required done. Optional: 0 of 1 done');
    expect(step).not.toContain('Pass');
  });

  it.each(tiles)('says In review on a split phase only while its newest revision is being marked on %s', async (_name, Page) => {
    // The one state the words are true of, read off the revision the tile
    // already holds rather than off the phase's status.
    for (const status of ['queued', 'running'] as const) {
      const { step } = await drawn(
        Page,
        [phase({ status: 'submitted', attempts: 3, taskCounts: SPLIT })],
        [review(), review({ id: 'submission-two', status, passed: null, verifiedPass: false, attempt: 2 })],
      );
      expect(step).toContain('In review');
      expect(step).toContain('1 of 2 required done. Optional: 0 of 1 done');
    }
    // and not once the verdict is in, whichever it was.
    const refused = await drawn(
      Page,
      [phase({ status: 'submitted', attempts: 3, taskCounts: SPLIT })],
      [review(), review({ id: 'submission-two', passed: false, verifiedPass: false, attempt: 2 })],
    );
    expect(refused.step).toContain('In progress');
    expect(refused.step).not.toContain('In review');
  });

  it.each(tiles)('leaves a one-task phase’s standing line to its newest verdict on %s', async (_name, Page) => {
    // The equivalence the fix above must not disturb: where the phase is its
    // one task, the tile has always printed that revision's verdict ("Review
    // in progress" while it is marked) and it still does, to the word.
    const marking = await drawn(
      Page,
      [phase({ status: 'submitted', attempts: 2 })],
      [review({ status: 'running', passed: null, verifiedPass: false })],
    );
    expect(marking.step).toContain('Review in progress');
    const refused = await drawn(
      Page,
      [phase({ status: 'submitted', attempts: 2 })],
      [review({ passed: false, verifiedPass: false })],
    );
    expect(refused.step).toContain('Needs revision');
  });

  it.each(tiles)('says a split phase is in progress while a required task is unfinished on %s', async (_name, Page) => {
    const { step } = await drawn(Page, [phase({ attempts: 2, taskCounts: SPLIT })], [review()]);

    expect(step).toContain('In progress');
    expect(step).toContain('1 of 2 required done. Optional: 0 of 1 done');
    expect(step).not.toContain('Pass');
  });

  it.each(tiles)('still reads the latest verdict on a one-task phase on %s', async (_name, Page) => {
    // The equivalence case for the line above: where the phase *is* the task,
    // the newest revision's verdict is the phase's standing and the tile draws
    // exactly what it drew before the field existed.
    const reviews = [review({ passed: false, verifiedPass: false })];
    const before = await draw(Page, [phase({ attempts: 1 })], reviews);
    const sole = await draw(Page, [phase({ attempts: 1, taskCounts: SOLE })], reviews);

    expect(sole).toBe(before);
    expect(sole).toContain('Needs revision');
  });

  it.each(pages)('keeps the count off a locked phase on %s, which has no work in it yet', async (_name, Page) => {
    const before = await draw(Page, [phase({ status: 'locked' })]);
    const locked = await draw(Page, [phase({ status: 'locked', attempts: 0, taskCounts: SPLIT })]);

    expect(locked).toBe(before);
    expect(locked).not.toContain('required');
    expect(locked).not.toContain('submissions across');
  });
});

/**
 * The six-step strip on the profile page, which makes the same claim in one word.
 *
 * `CompactPhasePath` marks a phase passed from the reviews alone. Before this
 * block that was the phase's standing said another way (a phase with one task
 * passes when its one verified pass lands) and on a split phase it is one
 * task's pass, on a phase the roll-up has deliberately left shut. The mark is
 * read by assistive technology as the phase's status, so it is decided by the
 * phase's status once there is more than one task to be wrong about.
 */
describe('the compact path the profile page mounts', () => {
  const strip = async (phases: PhaseSummary[], reviews: ReviewRow[]): Promise<HTMLAnchorElement> => {
    const box = document.createElement('div');
    document.body.append(box);
    const tree = createRoot(box);
    await act(async () => tree.render(<CompactPhasePath phases={phases} reviews={reviews} /> as never));
    const link = box.querySelector('a')!;
    const clone = link.cloneNode(true) as HTMLAnchorElement;
    await act(async () => tree.unmount());
    box.remove();
    return clone;
  };

  it('is drawn by the profile page, so the claim is one a learner reads', async () => {
    const box = document.createElement('div');
    document.body.append(box);
    const tree = createRoot(box);
    mocks.phases = [phase({ status: 'submitted', taskCounts: SPLIT })];
    mocks.reviews = [review()];
    await act(async () => tree.render(<ProfilePage />));
    const link = box.querySelector('a[aria-label="Requirements, In progress"]');
    await act(async () => tree.unmount());
    box.remove();

    expect(link).not.toBeNull();
  });

  it('does not mark a split phase passed on one task\'s pass', async () => {
    const link = await strip([phase({ status: 'submitted', taskCounts: SPLIT })], [review()]);

    expect(link.getAttribute('aria-label')).toBe('Requirements, In progress');
    expect(link.className).not.toContain('is-pass');
  });

  it('marks a one-task phase from its verified pass, as it marks a phase with no task counts', async () => {
    // The equivalence pin. A phase that is its one task is marked from its
    // verified pass, including while the enrolment payload in hand still says
    // `in_progress`, which is what a TaskTrackr learner must keep seeing.
    const passed = await strip([phase({ status: 'passed', taskCounts: SOLE })], [review()]);
    const lagging = await strip([phase()], [review()]);

    expect(passed.getAttribute('aria-label')).toBe('Requirements, Passed');
    expect(passed.className).toContain('is-pass');
    expect(lagging.className).toContain('is-pass');
  });
});

describe('Home\'s project map', () => {
  const home = async () => {
    const box = document.createElement('div');
    document.body.append(box);
    const tree = createRoot(box);
    await act(async () => tree.render(<DashboardPage />));
    return box;
  };

  it('sits between the project line and the phase path', async () => {
    mocks.phases = [phase()];
    const box = await home();
    const top = box.querySelector('.exp-dashboard-top');
    const map = box.querySelector('[data-testid="home-project-map"]');
    const journey = box.querySelector('section.exp-dashboard-journey');
    expect([top, map, journey].every(Boolean)).toBe(true);
    expect(top!.compareDocumentPosition(map!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(map!.compareDocumentPosition(journey!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(journey!.querySelector('.exp-phase-step')).not.toBeNull();
  });

  it('is handed the map the project loader holds: a refresh with one in hand draws it, with none waits on a skeleton', async () => {
    mocks.phases = [phase()];
    mocks.revalidating = true;
    expect((await home()).querySelector('[data-testid="home-project-map-loading"]')).not.toBeNull();
    document.body.replaceChildren();
    mocks.map = { nodes: [], edges: [] };
    expect((await home()).querySelector('[data-testid="home-project-map-loading"]')).toBeNull();
  });
});
