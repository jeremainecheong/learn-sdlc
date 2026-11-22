// @vitest-environment jsdom
/**
 * The quick-check line and the phase tutorial, and the before check's
 * `closed` slot.
 *
 * On first entry to a phase the tutorial (a modal) and the quick-check line
 * must not both appear, or the learner puts away two things in a row. The
 * phase tutorial provider says whether its tutorial is open
 * (`usePhaseTutorialOpen`, fed by CoachMarks' `onOpenChange`), and the line
 * draws nothing while it is: it shows once the tutorial is put away, from the
 * status it already read (no second request).
 *
 * The before check closes once work for the phase is handed in: a `closed`
 * slot is never offered, and the check's own page says why instead of offering
 * a Start that the API refuses.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  request: vi.fn(),
  pathname: '/workspace/phase-1',
  user: { id: 'rg-owner', role: 'LEARNER' },
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
  usePathname: () => rig.pathname,
  useParams: () => ({ phaseId: 'phase-1' }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request };
});
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => rig.user,
}));
vi.mock('@/lib/view-as', () => ({ useViewAs: () => null }));

import { CoachMarks } from '@/components/shell/CoachMarks';
import { PhaseTutorialProvider, PhaseTutorialReplay, usePhaseTutorialOpen, usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { markPhaseTutorialSeen } from '@/components/shell/tours';
import { QuickCheckProvider } from '@/components/workspace/QuickCheck';
import { ConceptRoom } from '@/components/workspace/concept/ConceptRoom';
import { CONCEPT_BEFORE_TITLE, conceptToOffer, type ConceptQuizzes, type ConceptSlotStatus } from '@/lib/api-concept';

const PHASE = 'phase-1';
const STATUS_PATH = `/phases/${PHASE}/concept-quizzes`;

const quizzes = (before: ConceptSlotStatus, after: ConceptSlotStatus): ConceptQuizzes => ({
  phaseKey: 'requirements',
  before: { taskKey: 'concept-before', status: before, scorePct: before === 'taken' ? 67 : null, questionCount: 6 },
  after: { taskKey: 'concept-after', status: after, scorePct: after === 'taken' ? 83 : null, questionCount: 6 },
});

let host: HTMLDivElement;
let root: Root;
let answer: () => Promise<unknown> = async () => quizzes('open', 'locked');
let serial = 0;

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const statusReads = () => rig.request.mock.calls.filter(([method, path]) => method === 'GET' && path === STATUS_PATH).length;

const realRect = Element.prototype.getBoundingClientRect;
const realScroll = Element.prototype.scrollIntoView;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;

/** A room that has finished its phase GET, with the tools the tutorial points at. */
function LoadedRoom({ phase }: { phase: PhaseDetail }) {
  usePhaseTutorialReady(phase);
  return (
    <main data-testid="room">
      <button id="requirements-interview-tab">Stakeholder interview</button>
      <nav aria-label="Phase working area">
        <button>Write tests</button>
        <button>Evidence</button>
      </nav>
      <PhaseTutorialReplay />
    </main>
  );
}

/** The phase layout's shape: the tutorial provider, the quick check's provider (its line above the room), the room. */
function layout(phaseStatus = 'in_progress') {
  const phase = { id: PHASE, key: 'requirements', status: phaseStatus, files: [] } as unknown as PhaseDetail;
  return (
    <PhaseTutorialProvider key={`${rig.user.id}:${PHASE}`} phaseId={PHASE} phaseKey="requirements">
      <QuickCheckProvider key={`concept-prompt:${PHASE}`} phaseId={PHASE} phaseStatus={phaseStatus}>
        <LoadedRoom phase={phase} />
      </QuickCheckProvider>
    </PhaseTutorialProvider>
  );
}

beforeEach(() => {
  rig.user = { id: `rg-owner-${++serial}`, role: 'LEARNER' };
  rig.pathname = `/workspace/${PHASE}`;
  rig.request.mockReset();
  rig.request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === STATUS_PATH) return answer();
    throw new Error(`nothing answers ${method} ${path}`);
  });
  answer = async () => quizzes('open', 'locked');
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 20, left: 20, right: 220, bottom: 60, width: 200, height: 40, x: 20, y: 20, toJSON() {} }) as DOMRect;
  Element.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = realRect;
  Element.prototype.scrollIntoView = realScroll;
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
});

describe('the quick-check line waits for the phase tutorial', () => {
  it('on first entry the tutorial is open and the line is hidden; after Skip the line shows, with no second status read', async () => {
    await act(async () => root.render(layout()));
    await settle();
    expect(q('coach')).not.toBeNull();
    expect(q('concept-prompt')).toBeNull();
    expect(statusReads()).toBe(1);

    await act(async () => q('coach-skip')!.click());
    await settle();
    expect(q('coach')).toBeNull();
    expect(text(q('concept-prompt-title'))).toBe(CONCEPT_BEFORE_TITLE);
    expect(statusReads()).toBe(1);
  });

  it('after Done on the last step the line shows', async () => {
    await act(async () => root.render(layout()));
    await settle();
    expect(q('concept-prompt')).toBeNull();
    for (let guard = 0; guard < 12 && q('coach'); guard++) await act(async () => q('coach-next')!.click());
    await settle();
    expect(q('coach')).toBeNull();
    expect(q('concept-prompt')).not.toBeNull();
  });

  it('a tutorial already seen leaves the line in place on entry', async () => {
    markPhaseTutorialSeen({ ownerId: rig.user.id, phaseId: PHASE, phaseKey: 'requirements', ready: true });
    await act(async () => root.render(layout()));
    await settle();
    expect(q('coach')).toBeNull();
    expect(q('concept-prompt')).not.toBeNull();
  });

  it('Replay tutorial hides the line while it runs and gives it back after', async () => {
    markPhaseTutorialSeen({ ownerId: rig.user.id, phaseId: PHASE, phaseKey: 'requirements', ready: true });
    await act(async () => root.render(layout()));
    await settle();
    expect(q('concept-prompt')).not.toBeNull();
    await act(async () => q('phase-tutorial-replay')!.click());
    expect(q('coach')).not.toBeNull();
    expect(q('concept-prompt')).toBeNull();
    await act(async () => q('coach-skip')!.click());
    expect(q('concept-prompt')).not.toBeNull();
    expect(statusReads()).toBe(1);
  });

  it('usePhaseTutorialOpen is false outside a provider', async () => {
    let seen: boolean | null = null;
    function Probe() {
      seen = usePhaseTutorialOpen();
      return null;
    }
    await act(async () => root.render(<Probe />));
    expect(seen).toBe(false);
  });

  it('CoachMarks reports its open state through the optional onOpenChange', async () => {
    const changes: boolean[] = [];
    const marks = [{ target: 'nav-user', title: 'Your account', body: 'Return here for help.' }];
    await act(async () =>
      root.render(
        <>
          <button data-testid="nav-user">Account</button>
          <CoachMarks marks={marks} force onOpenChange={(open) => changes.push(open)} />
        </>,
      ),
    );
    expect(q('coach')).not.toBeNull();
    expect(changes.at(-1)).toBe(true);
    await act(async () => q('coach-skip')!.click());
    expect(q('coach')).toBeNull();
    expect(changes.at(-1)).toBe(false);
    // Without the prop nothing changes for the other users.
    await act(async () =>
      root.render(
        <>
          <button data-testid="nav-user">Account</button>
          <CoachMarks key="without-listener" marks={marks} force />
        </>,
      ),
    );
    expect(q('coach')).not.toBeNull();
  });
});

describe('the before check closes once work is handed in', () => {
  it('conceptToOffer never offers a closed before check', () => {
    expect(conceptToOffer(quizzes('closed', 'locked'))).toBeNull();
    expect(conceptToOffer(quizzes('closed', 'open'))).toBe('after');
    expect(conceptToOffer(quizzes('closed', 'taken'))).toBeNull();
  });

  it('a closed before check hides the line', async () => {
    answer = async () => quizzes('closed', 'locked');
    markPhaseTutorialSeen({ ownerId: rig.user.id, phaseId: PHASE, phaseKey: 'requirements', ready: true });
    await act(async () => root.render(layout('submitted')));
    await settle();
    expect(statusReads()).toBe(1);
    expect(q('concept-prompt')).toBeNull();
  });

  const roomView = (taskKey: string, over: Record<string, unknown> = {}) => ({
    taskKey,
    title: taskKey === 'concept-after' ? 'What did you learn?' : 'Quick check before you start',
    brief: '',
    required: false,
    status: 'in_progress',
    drawn: 6,
    passMark: 0,
    attemptsUsed: 0,
    attemptsLeft: 1,
    needsInstructorReset: false,
    cooldownSecondsLeft: null,
    bestScore: null,
    lastSubmissionId: null,
    paper: null,
    ...over,
  });

  async function openRoom(kind: 'before' | 'after', view: Record<string, unknown>) {
    rig.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path.includes(`/concept-${kind}/quiz`)) return view;
      throw new Error(`nothing answers ${method} ${path}`);
    });
    await act(async () => root.render(<ConceptRoom phaseId={PHASE} kind={kind} backHref={`/workspace/${PHASE}`} />));
    await settle();
  }

  it('the check page says the before check is closed, and offers no Start', async () => {
    await openRoom('before', roomView('concept-before', { status: 'locked' }));
    expect(text(q('concept-closed'))).toBe('The before check closes once you have handed in work for this phase.');
    expect(q('concept-start')).toBeNull();
    expect(q('concept-back-to-phase')).not.toBeNull();
  });

  it('the check page says the after check opens once the phase is passed, and offers no Start', async () => {
    await openRoom('after', roomView('concept-after', { status: 'locked' }));
    expect(text(q('concept-closed'))).toBe('The "What did you learn?" check opens once you have passed this phase.');
    expect(q('concept-start')).toBeNull();
  });

  it('a before paper started while the check was open is still drawn, so it can be handed in', async () => {
    const paper = {
      attemptId: 'attempt-1',
      startedAt: '2026-10-07T08:00:00.000Z',
      questions: [{ id: 'q1', stem: 'Which?', multiple: false, options: [{ id: 'o1', text: 'This' }, { id: 'o2', text: 'That' }] }],
    };
    await openRoom('before', roomView('concept-before', { status: 'locked', paper }));
    expect(q('quiz-paper')).not.toBeNull();
    expect(q('concept-closed')).toBeNull();
  });

  it('an open before check still offers Start', async () => {
    await openRoom('before', roomView('concept-before'));
    expect(q('concept-start')).not.toBeNull();
    expect(q('concept-closed')).toBeNull();
  });
});
