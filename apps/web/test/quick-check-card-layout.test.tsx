// @vitest-environment jsdom
/**
 * The quick-check card across the phase layout's own child routes.
 *
 * The phase layout stays mounted while the learner moves from the room to the
 * check's page (`/concept`) and back. It draws the card beside the room, and in
 * the requirements phase the room is `RequirementsWorkspace`, swapped in for
 * `children`. If the card and that room carry the same key (`phaseId`),
 * React's keyed reconcile loses the card's fiber on the way to `/concept` and
 * leaves its DOM behind: a stray "Quick check before you start" above the
 * check, and a second one back in the room after the check is taken. These cases
 * count the cards, on the layout, across that walk, and refuse React's
 * duplicate-key warning.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  request: vi.fn(),
  project: null as unknown,
  params: { phaseId: 'phase-1' },
  path: '/workspace/phase-1',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => rig.params,
  usePathname: () => rig.path,
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request };
});
vi.mock('@/lib/useProject', () => ({ useProject: () => rig.project }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner', role: 'LEARNER' }),
}));
vi.mock('@/components/shell', () => ({
  WorkPage: ({ heading, testId, children }: { heading: string; testId: string; children: ReactNode }) => (
    <main data-testid={testId}>
      <h1>{heading}</h1>
      {children}
    </main>
  ),
  doorWithTasks: (phase: unknown) => phase,
  phaseDoorHref: () => '/workspace/phase-1',
}));
vi.mock('@/components/workspace/requirements/RequirementsWorkspace', () => ({
  RequirementsWorkspace: () => <main data-testid="requirements-room">backlog</main>,
}));
vi.mock('@/components/shell/PhaseTutorial', () => ({ PhaseTutorialProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

import PhaseWorkspaceLayout from '@/app/(app)/workspace/[phaseId]/layout';
import { CONCEPT_BEFORE_TITLE, type ConceptQuizzes, type ConceptSlotStatus } from '@/lib/api-concept';

const quizzes = (before: ConceptSlotStatus, after: ConceptSlotStatus): ConceptQuizzes => ({
  phaseKey: 'requirements',
  before: { taskKey: 'concept-before', status: before, scorePct: before === 'taken' ? 67 : null, questionCount: 6 },
  after: { taskKey: 'concept-after', status: after, scorePct: after === 'taken' ? 83 : null, questionCount: 6 },
});

const phase = (id: string, key: PhaseSummary['key'], title: string): PhaseSummary =>
  ({ id, key, order: 1, title, status: 'in_progress', opensAt: null, dueAt: null }) as PhaseSummary;

let host: HTMLDivElement;
let root: Root;
let answer: () => Promise<unknown>;
let errors: string[];
let restoreError: () => void;

const all = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`);
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
/** The layout at an address, kept mounted the way the App Router keeps it across its child routes. */
async function at(path: string, page: ReactNode) {
  rig.path = path;
  await act(async () => root.render(<PhaseWorkspaceLayout>{page}</PhaseWorkspaceLayout>));
  await settle();
}
const roomPage = <main data-testid="phase-page">room page</main>;
const checkPage = <main data-testid="concept-page">the check</main>;

// The prompt loads the API client on its first ask; load it once here so a
// case reads the card rather than the module loader's timing.
beforeAll(async () => {
  await import('@/lib/api');
});

beforeEach(() => {
  rig.request.mockReset();
  rig.request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && /^\/phases\/[^/]+\/concept-quizzes$/.test(path)) return answer();
    throw new Error(`nothing answers ${method} ${path}`);
  });
  answer = async () => quizzes('open', 'locked');
  errors = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  restoreError = () => spy.mockRestore();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  restoreError();
});

describe('the quick-check card across the phase layout', () => {
  it('requirements: one card in the room, none on the check page, none back in the room once taken', async () => {
    rig.params = { phaseId: 'phase-1' };
    rig.project = { details: {}, enrollment: { phases: [phase('phase-1', 'requirements', 'Requirements')] }, currentPhase: null, loading: false, error: '', reload: vi.fn() };

    await at('/workspace/phase-1', roomPage);
    expect(all('requirements-room')).toHaveLength(1);
    expect(all('concept-prompt')).toHaveLength(1);
    expect(all('concept-prompt-title')[0]?.textContent).toBe(CONCEPT_BEFORE_TITLE);

    // Take the quick check: the layout stays, the check's page replaces the room.
    await at('/workspace/phase-1/concept', checkPage);
    expect(all('concept-page')).toHaveLength(1);
    expect(all('requirements-room')).toHaveLength(0);
    expect(all('concept-prompt')).toHaveLength(0);
    expect(host.textContent).not.toContain(CONCEPT_BEFORE_TITLE);

    // Handed in, then "Back to the phase": the before check is taken.
    answer = async () => quizzes('taken', 'locked');
    await at('/workspace/phase-1', roomPage);
    expect(all('requirements-room')).toHaveLength(1);
    expect(all('concept-prompt')).toHaveLength(0);
    expect(host.textContent).not.toContain(CONCEPT_BEFORE_TITLE);

    expect(errors.filter((line) => /same key/i.test(line))).toEqual([]);
  });

  it('requirements: back in the room without taking it, exactly one card again', async () => {
    rig.params = { phaseId: 'phase-1' };
    rig.project = { details: {}, enrollment: { phases: [phase('phase-1', 'requirements', 'Requirements')] }, currentPhase: null, loading: false, error: '', reload: vi.fn() };

    await at('/workspace/phase-1', roomPage);
    await at('/workspace/phase-1/concept', checkPage);
    await at('/workspace/phase-1', roomPage);
    expect(all('concept-prompt')).toHaveLength(1);
    expect(all('requirements-room')).toHaveLength(1);
    expect(errors.filter((line) => /same key/i.test(line))).toEqual([]);
  });

  it('a phase whose room is the page: one card in the room, none on the check page, none once taken', async () => {
    rig.params = { phaseId: 'phase-2' };
    rig.project = { details: {}, enrollment: { phases: [phase('phase-2', 'design', 'Design')] }, currentPhase: null, loading: false, error: '', reload: vi.fn() };

    await at('/workspace/phase-2', roomPage);
    expect(all('phase-page')).toHaveLength(1);
    expect(all('concept-prompt')).toHaveLength(1);

    await at('/workspace/phase-2/concept', checkPage);
    expect(all('concept-prompt')).toHaveLength(0);

    answer = async () => quizzes('taken', 'locked');
    await at('/workspace/phase-2', roomPage);
    expect(all('phase-page')).toHaveLength(1);
    expect(all('concept-prompt')).toHaveLength(0);
    expect(errors.filter((line) => /same key/i.test(line))).toEqual([]);
  });

  it('moving between a room\'s own sub-routes keeps the card and asks nothing new', async () => {
    rig.params = { phaseId: 'phase-1' };
    rig.project = { details: {}, enrollment: { phases: [phase('phase-1', 'requirements', 'Requirements')] }, currentPhase: null, loading: false, error: '', reload: vi.fn() };

    await at('/workspace/phase-1', roomPage);
    expect(all('concept-prompt')).toHaveLength(1);
    const asked = rig.request.mock.calls.length;
    await at('/workspace/phase-1/interview', roomPage);
    await at('/workspace/phase-1/issue', roomPage);
    expect(all('concept-prompt')).toHaveLength(1);
    expect(rig.request.mock.calls.length).toBe(asked);
  });
});
