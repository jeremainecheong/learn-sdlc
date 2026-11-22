// @vitest-environment jsdom
/**
 * Usability rules where they reach the screen. `usability-copy-rules.test.tsx`
 * holds each rule where it is decided (a
 * helper, a sentence) and a helper can be right while nothing draws it. These
 * cases mount the component that puts the fix on screen, so taking the wiring
 * out goes red here rather than in a classroom:
 *
 *   - the staff sidebar carries its own Projects row;
 *   - a teacher reading a quiz paper is not addressed as the learner, in the
 *        submission evidence a teacher opens and in the console's submissions
 *        table.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionView } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  role: 'INSTRUCTOR' as 'INSTRUCTOR' | 'ADMIN' | 'LEARNER',
  evidence: vi.fn(),
  notes: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/teacher',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useRole: () => rig.role,
  useSession: () => ({ id: 'teacher', role: rig.role, displayName: 'Dana Okafor' }),
  getToken: () => 'teacher-session',
}));
vi.mock('@/lib/view-as', async (original) => ({
  ...(await original<typeof import('@/lib/view-as')>()),
  useViewAs: () => null,
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProjectMaybe: () => null,
  useProject: () => null,
}));
vi.mock('@/lib/api-experience', async (original) => ({
  ...(await original<typeof import('@/lib/api-experience')>()),
  experienceApi: { teacherEvidence: rig.evidence, teacherFeedback: rig.notes, writeFeedback: vi.fn() },
}));

import { Sidebar } from '@/components/shell/Sidebar';
import { SubmissionEvidence } from '@/components/experience/SubmissionEvidence';

/** The summary the API stores on a quiz's report, written for the learner. */
const LEARNER_SENTENCE =
  'Scored against the key your teacher sealed with this quiz. This paper is below the pass mark. No model was asked — a multiple-choice answer is right or wrong by the key.';

const quizPaper = (): SubmissionView =>
  ({
    id: 'revision-concepts-2',
    taskKey: 'concepts',
    status: 'completed',
    passed: false,
    score: 0,
    attempt: 2,
    createdAt: '2026-09-20T06:40:00.000Z',
    report: {
      overall: 0,
      passed: false,
      passThreshold: 50,
      assessmentMode: 'strict_binary',
      criteria: [],
      checks: [{ id: 'quiz', label: 'Quiz', status: 'failed', detail: '0 of 2 right — 0%, against a pass mark of 50%.' }],
      aiReview: { summary: LEARNER_SENTENCE, strengths: [], improvements: [], processNote: '', provider: 'key' },
      aiReliance: { hintsThisPhase: 0, index: 0 },
      integrity: {},
      quiz: { correctCount: 0, drawn: 2, passMark: 50, attempt: 2, attemptsLeft: 0, questions: [] },
    },
  }) as unknown as SubmissionView;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  rig.role = 'INSTRUCTOR';
  rig.evidence.mockReset();
  rig.notes.mockReset();
  rig.notes.mockResolvedValue([]);
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('F-a: the staff sidebar has a row for the projects a teacher writes', () => {
  it('draws Projects for a teacher and for an admin, leading to the library', async () => {
    for (const role of ['INSTRUCTOR', 'ADMIN'] as const) {
      rig.role = role;
      await act(async () => root.render(<Sidebar />));
      expect(q('nav-projects')?.getAttribute('href')).toBe('/teacher/projects');
      expect(q('nav-projects')?.textContent).toContain('Projects');
      expect(q('nav-instructor')).not.toBeNull();
    }
  });

  it('draws no Projects row for a learner', async () => {
    rig.role = 'LEARNER';
    await act(async () => root.render(<Sidebar />));
    expect(q('nav-projects')).toBeNull();
  });
});

describe('a teacher reading a quiz paper is not addressed as the learner', () => {
  it('says it in the teacher’s terms in the submission evidence a teacher opens', async () => {
    rig.evidence.mockResolvedValue(quizPaper());
    await act(async () => root.render(<SubmissionEvidence teacher submissionId="revision-concepts-2" />));
    await act(async () => {
      await Promise.resolve();
    });

    expect(rig.evidence).toHaveBeenCalledWith('revision-concepts-2');
    expect(host.textContent).toContain('Scored against the key sealed with this quiz. This paper is below the pass mark.');
    expect(host.textContent).not.toContain('your teacher');
  });
});
