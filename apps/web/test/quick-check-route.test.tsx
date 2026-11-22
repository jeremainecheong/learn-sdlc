// @vitest-environment jsdom
/**
 * /workspace/[phaseId]/concept?kind=before|after.
 *
 * The route opens the quick check on the existing quiz doors with the task key
 * `concept-before` or `concept-after`: read the room, start a paper, hand it
 * in, then show the score and the explanations and lead back to the phase. A
 * check already taken shows its score and the way back, never a second Start.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  request: vi.fn(),
  getSubmission: vi.fn(),
  search: '',
  crumbs: [] as { label: string }[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ phaseId: 'phase-1' }),
  usePathname: () => '/workspace/phase-1/concept',
  useSearchParams: () => new URLSearchParams(rig.search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The page's breadcrumbs, as the frame declares them to the shell.
vi.mock('@/components/shell/ShellProvider', async (original) => {
  const real = await original<typeof import('@/components/shell/ShellProvider')>();
  return {
    ...real,
    useShellConfig: (config: Parameters<typeof real.useShellConfig>[0]) => {
      rig.crumbs = (config.crumbs ?? []) as { label: string }[];
      real.useShellConfig(config);
    },
  };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-1', role: 'LEARNER', displayName: 'Ada' }),
}));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request, api: { ...actual.api, getSubmission: rig.getSubmission } };
});
const phase = { id: 'phase-1', key: 'requirements', title: 'Requirements', order: 1, status: 'in_progress' };
const projectState = () => ({
  enrollment: { id: 'enrolment-1', projectTitle: 'Shelf', projectSlug: 'shelf', phases: [phase] },
  currentPhase: phase,
  details: { 'phase-1': { ...phase, tasks: [] } },
  analytics: null,
  loading: false,
  error: '',
  reload: vi.fn(),
});
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => projectState(),
  useProjectMaybe: () => projectState(),
}));

import ConceptPage from '@/app/(app)/workspace/[phaseId]/concept/page';
import { ApiError } from '@/lib/api';

const room = (taskKey: string, over: Record<string, unknown> = {}) => ({
  taskKey,
  title: taskKey === 'concept-after' ? 'What did you learn?' : 'Quick check before you start',
  brief: '',
  required: false,
  status: 'not_started',
  drawn: 2,
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
const paper = {
  attemptId: 'attempt-1',
  startedAt: '2026-10-06T14:00:00.000Z',
  questions: [
    {
      id: 'req-1',
      stem: 'Which is the usual form of a user story?',
      multiple: false,
      options: [
        { id: 'oa', text: 'As a <role>, I want <goal>, so that <benefit>.' },
        { id: 'ob', text: 'Given, When, Then.' },
      ],
    },
    {
      id: 'req-2',
      stem: 'What is an epic?',
      multiple: false,
      options: [
        { id: 'oc', text: 'A large body of work split into stories.' },
        { id: 'od', text: 'A single bug ticket.' },
      ],
    },
  ],
};
const marked = (status = 'completed') => ({
  id: 'sub-1',
  status,
  passed: true,
  report:
    status === 'completed'
      ? {
          quiz: {
            correctCount: 1,
            drawn: 2,
            passMark: 0,
            attempt: 1,
            attemptsLeft: 0,
            questions: [
              {
                id: 'req-1',
                stem: paper.questions[0].stem,
                options: paper.questions[0].options,
                selected: ['oa'],
                outcome: 'right',
                explanation: 'A story names who wants what, and why.',
                concept: 'User story',
              },
              {
                id: 'req-2',
                stem: paper.questions[1].stem,
                options: paper.questions[1].options,
                selected: ['od'],
                outcome: 'wrong',
                explanation: 'An epic is big work that is split into stories.',
                concept: 'Epic vs story vs ticket',
              },
            ],
          },
        }
      : null,
});

let host: HTMLDivElement;
let root: Root;
let view: Record<string, unknown>;
let calls: { method: string; path: string; body?: unknown }[];
let handInAnswer: () => unknown;

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
async function open(kind: string | null) {
  rig.search = kind === null ? '' : `?kind=${kind}`;
  await act(async () => root.render(<ConceptPage />));
  await settle();
}

beforeEach(() => {
  calls = [];
  view = room('concept-before');
  handInAnswer = () => marked();
  rig.request.mockReset();
  rig.getSubmission.mockReset();
  rig.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const m = path.match(/^\/phases\/phase-1\/tasks\/(concept-before|concept-after)\/quiz(\/attempts(\/attempt-1)?)?$/);
    if (m && method === 'GET' && !m[2]) return { ...view, taskKey: m[1] };
    if (m && method === 'POST' && m[2] && !m[3]) return paper;
    if (m && method === 'POST' && m[3]) return handInAnswer();
    if (method === 'GET' && path === '/phases/phase-1/concept-quizzes') {
      return {
        phaseKey: 'requirements',
        before: { taskKey: 'concept-before', status: 'open', scorePct: null, questionCount: 2 },
        after: { taskKey: 'concept-after', status: 'locked', scorePct: null, questionCount: 2 },
      };
    }
    throw new Error(`nothing answers ${method} ${path}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the concept route passes the right task key', () => {
  it('kind=before reads the concept-before quiz', async () => {
    await open('before');
    expect(calls[0]).toEqual({ method: 'GET', path: '/phases/phase-1/tasks/concept-before/quiz', body: undefined });
    expect(text(q('concept-title'))).toBe('Quick check before you start');
  });

  it('kind=after reads the concept-after quiz', async () => {
    await open('after');
    expect(calls[0]?.path).toBe('/phases/phase-1/tasks/concept-after/quiz');
    expect(text(q('concept-title'))).toBe('What did you learn?');
  });

  it('no kind, or an unknown kind, is the before check', async () => {
    await open(null);
    expect(calls[0]?.path).toBe('/phases/phase-1/tasks/concept-before/quiz');
  });
});

describe('the breadcrumb names the check, never the address', () => {
  const leaf = () => rig.crumbs.map((crumb) => crumb.label);
  it('kind=before ends in the before check\'s name', async () => {
    await open('before');
    expect(leaf()).toEqual(['Shelf', 'Requirements', 'Quick check before you start']);
  });

  it('kind=after ends in the after check\'s name', async () => {
    await open('after');
    expect(leaf()).toEqual(['Shelf', 'Requirements', 'What did you learn?']);
  });

  it('no kind, or an unknown kind, ends in the before check\'s name', async () => {
    await open(null);
    expect(leaf().at(-1)).toBe('Quick check before you start');
    await open('later');
    expect(leaf().at(-1)).toBe('Quick check before you start');
    expect(leaf().join(' ')).not.toMatch(/check (after|before)$/);
  });
});

describe('taking the check', () => {
  it('starts, hands in, then shows the score, the explanations and the way back', async () => {
    await open('before');
    expect(text(q('concept-intro'))).toContain('not graded');
    await act(async () => q('concept-start')?.click());
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /phases/phase-1/tasks/concept-before/quiz/attempts');
    expect(q('quiz-paper')).not.toBeNull();
    await act(async () => q('quiz-option-req-1-oa')?.click());
    await act(async () => q('quiz-option-req-2-od')?.click());
    await act(async () => q('quiz-hand-in')?.click());
    await settle();
    const handIn = calls.find((c) => c.path.endsWith('/quiz/attempts/attempt-1'));
    expect(handIn).toEqual({
      method: 'POST',
      path: '/phases/phase-1/tasks/concept-before/quiz/attempts/attempt-1',
      body: { answers: { 'req-1': ['oa'], 'req-2': ['od'] } },
    });
    expect(text(q('concept-score'))).toBe('You got 1 of 2 right (50%).');
    expect(text(q('concept-marked-req-1'))).toContain('Right');
    expect(text(q('concept-marked-req-2'))).toContain('Wrong');
    expect(text(q('concept-marked-req-2'))).toContain('An epic is big work that is split into stories.');
    expect(text(q('concept-marked-req-2'))).toContain('Epic vs story vs ticket');
    const back = q('concept-back-to-phase');
    expect(text(back)).toBe('Back to the phase');
    expect(back?.getAttribute('href')).toBe('/workspace/phase-1');
    // Never a pass mark or a second paper on a check that is not graded.
    expect(text(host)).not.toContain('pass mark');
    expect(q('concept-start')).toBeNull();
  });

  it('a hand-in still being marked is watched until it lands', async () => {
    handInAnswer = () => marked('queued');
    rig.getSubmission.mockResolvedValueOnce(marked('completed'));
    await open('before');
    await act(async () => q('concept-start')?.click());
    await settle();
    await act(async () => q('quiz-option-req-1-oa')?.click());
    await act(async () => q('quiz-hand-in')?.click());
    await settle(12);
    expect(rig.getSubmission).toHaveBeenCalledWith('sub-1');
    expect(text(q('concept-score'))).toBe('You got 1 of 2 right (50%).');
  });

  it('a before check answered with the score only says the answers come with the after check', async () => {
    handInAnswer = () => {
      const view = marked();
      (view.report as { quiz: { questions: unknown[] } }).quiz.questions = [];
      return view;
    };
    await open('before');
    await act(async () => q('concept-start')?.click());
    await settle();
    await act(async () => q('quiz-option-req-1-oa')?.click());
    await act(async () => q('quiz-hand-in')?.click());
    await settle();
    expect(text(q('concept-score'))).toBe('You got 1 of 2 right (50%).');
    expect(host.querySelectorAll('[data-testid^="concept-marked-"]')).toHaveLength(0);
    expect(text(q('concept-answers-later'))).toBe('The answers and explanations come with the check after this phase.');
    expect(q('concept-back-to-phase')?.getAttribute('href')).toBe('/workspace/phase-1');
  });

  it('a check already taken shows its score and the way back, not a Start', async () => {
    view = room('concept-before', { attemptsUsed: 1, attemptsLeft: 0, bestScore: 66.7, lastSubmissionId: null });
    await open('before');
    expect(q('concept-start')).toBeNull();
    expect(text(q('concept-taken'))).toContain('67%');
    expect(q('concept-back-to-phase')?.getAttribute('href')).toBe('/workspace/phase-1');
  });

  it('a 409 on start (taken in another tab) reads the room again instead of failing', async () => {
    await open('before');
    let first = true;
    rig.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === 'POST' && path.endsWith('/quiz/attempts')) throw new ApiError(409, 'You have already taken this check.');
      if (method === 'GET' && path.endsWith('/quiz')) {
        const out = first ? room('concept-before') : room('concept-before', { attemptsUsed: 1, attemptsLeft: 0, bestScore: 50 });
        first = false;
        return { ...out, attemptsUsed: 1, attemptsLeft: 0, bestScore: 50 };
      }
      throw new Error(`nothing answers ${method} ${path}`);
    });
    await act(async () => q('concept-start')?.click());
    await settle();
    expect(text(q('concept-taken'))).toContain('50%');
    expect(q('room-error')).toBeNull();
  });
});
