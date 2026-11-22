// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review } from '@/components/experience/shared';
import type { EnrollmentView, PhaseDetail, PhaseSummary, SubmissionView } from '@learnsdlc/shared';
import CompletionPage from '@/app/(app)/completion/page';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import type { PassKind } from '@/lib/pass-kind';
import type { PhaseRecords } from '@/lib/records';

/*
 * The completion page and the printable record count reviewed passes
 * by one rule (`holdsReviewedPass`). The page counted any passing revision of
 * a passed phase, while the record's cover takes the board's `passKind`; so a
 * teacher's credit over a passing revision (a reset then Mark as passed; a
 * split phase with one task reviewed and one only signed off; a phase-wide
 * Pass over a task awaiting its countersignature) read 6 and "All phases
 * passed" on the page beside 5 and "In progress" on the record. Each page here
 * is drawn from the same board and the same reviews. A learner who passed all
 * six phases by review reads the same on both.
 */
const state = vi.hoisted(() => ({
  phases: [] as (PhaseSummary & { passKind?: PassKind })[],
  reviews: [] as Review[],
  completed: false,
}));
const completedAt = () => (state.completed ? '2026-11-08T10:00:00Z' : null);
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    loading: false,
    enrollment: { id: 'enrollment', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', completed: state.completed, completedAt: completedAt(), phases: state.phases },
  }),
}));
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => ({ displayName: 'Recorded learner' }) }));
vi.mock('@/components/experience/shared', async original => ({
  ...await original<typeof import('@/components/experience/shared')>(),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useReviews: () => ({ reviews: state.reviews, loading: false, error: '', refresh: vi.fn() }),
}));

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
const submission = (phaseId: string, id: string, passed: boolean, attempt: number) => ({
  id, phaseStateId: phaseId, status: 'completed', passed, verifiedPass: passed, score: passed ? 100 : 40,
  report: null, reviewUnavailable: false, attempt, createdAt: `2026-11-08T0${attempt}:00:00Z`,
}) as unknown as Review['submission'];

let host: HTMLDivElement; let root: Root;
let paper: HTMLDivElement; let paperRoot: Root;
beforeEach(() => {
  state.completed = false;
  state.phases = KEYS.map((key, index) => ({
    id: key, key, title: key, order: index + 1, status: 'passed', attempts: 2, bestScore: 90,
    reflection: null, opensAt: null, dueAt: null, passedAt: '2026-11-08T01:00:00Z', passKind: 'reviewed',
  }) as PhaseSummary & { passKind?: PassKind });
  state.reviews = state.phases.flatMap(phase => [
    { phase, submission: submission(phase.id, `${phase.id}-0`, false, 1) },
    { phase, submission: submission(phase.id, `${phase.id}-1`, true, 2) },
  ]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  paper = document.createElement('div'); document.body.append(paper); paperRoot = createRoot(paper);
});
afterEach(() => {
  act(() => { root.unmount(); paperRoot.unmount(); });
  host.remove(); paper.remove();
});

/** The completion page, then the learner's printable record from the same board and reviews. */
const drawBoth = async () => {
  await act(async () => root.render(<CompletionPage />));
  const enrollment = {
    phases: state.phases, projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [],
    startedAt: '2026-10-10T00:00:00Z', completed: state.completed, completedAt: completedAt(),
  } as unknown as EnrollmentView;
  const details = Object.fromEntries(state.phases.map(phase => [phase.id, {
    ...phase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null,
  }])) as unknown as Record<string, PhaseDetail>;
  const records: Record<string, PhaseRecords> = Object.fromEntries(state.phases.map(phase => [phase.id, {
    submissions: state.reviews.filter(review => review.phase.id === phase.id).map(review => review.submission as unknown as SubmissionView),
    runs: [], chat: [],
  }]));
  await act(async () => paperRoot.render(<Dossier dossier={buildDossier(enrollment, details, records, {}, null)} />));
};
const page = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const record = (id: string) => paper.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
const seal = () => host.querySelector('.exp-certificate-seal')?.textContent ?? '';

describe('the completion page counts as the printable record does', () => {
  it('reads 6 of 6, All phases passed and the seal for six reviewed passes', async () => {
    await drawBoth();
    expect(host.textContent).toContain('PROJECT COMPLETION RECORD');
    expect(seal()).toBe('6 phases6 passes');
    expect(page('completion-closing')?.textContent).toContain('All 6 phases passed. The project is complete once you press Complete the project in maintenance.');
    expect(host.textContent).not.toContain('to bring it all together');
    expect(host.textContent).toContain('Export project record');
    expect(record('dossier-completion')).toBe('All phases passed');
    expect(paper.textContent).toContain('6 of 6');
    expect(paper.querySelector('[data-testid="dossier-credited"]')).toBeNull();
  });

  it('reads the sealed record once sealed, and the same words on an older payload with no passKind', async () => {
    state.completed = true;
    await drawBoth();
    expect(seal()).toBe('6 phases6 passes');
    expect(host.querySelector('.exp-certificate-footer')?.textContent).toContain('Recorded');
    expect(record('dossier-completion')).toBe('Complete');
    expect(record('dossier-standing')).toBe('All 6 phases passed. The project is complete.');

    state.completed = false;
    state.phases = state.phases.map(({ passKind: _drop, ...phase }) => phase);
    await drawBoth();
    expect(seal()).toBe('6 phases6 passes');
    expect(page('completion-closing')?.textContent).toContain('All 6 phases passed.');
    expect(record('dossier-completion')).toBe('All phases passed');
  });

  // Three shapes: on the web each is a passed
  // phase the board names credit while a revision of it passed its review.
  const shapes: [string, (typeof KEYS)[number], boolean[]][] = [
    ['a pass left behind, reset, then Mark as passed (m-11)', 'design', [false, true]],
    ['a split phase: one task reviewed, the other only signed off', 'requirements', [true]],
    ['a phase-wide Pass over a task awaiting its countersignature', 'maintenance', [false, true]],
  ];
  for (const [shape, key, verdicts] of shapes) {
    it(`agrees on ${shape}: 5 of 6 and in progress on both pages`, async () => {
      const index = KEYS.indexOf(key);
      state.phases[index] = { ...state.phases[index], passKind: 'credit' };
      const phase = state.phases[index];
      state.reviews = [
        ...state.reviews.filter(review => review.phase.id !== key),
        ...verdicts.map((passed, i) => ({ phase, submission: submission(key, `${key}-${i}`, passed, i + 1) })),
      ];
      await drawBoth();
      // The page: one phase still to bring together, no seal, no closing line.
      expect(host.textContent).toContain('1 phase to bring it all together.');
      expect(host.textContent).not.toContain('PROJECT COMPLETION RECORD');
      expect(page('completion-closing')).toBeNull();
      expect([...host.querySelectorAll('.exp-completion-mini-path > div')].map(tile => tile.getAttribute('data-passed')))
        .toEqual(KEYS.map(one => String(one !== key)));
      // The record: the same count and the same state.
      expect(paper.textContent).toContain('5 of 6');
      expect(record('dossier-completion')).toBe('In progress');
      expect(record('dossier-standing')).toBe('5 of 6 phases passed so far.');
    });
  }
});

/*
 * A sealed record whose phase a teacher later reset and
 * credited printed "All 6 phases passed. The project is complete." beside
 * "5 of 6". The headline now follows the count beside it.
 */
describe("the sealed record's headline", () => {
  it('follows the count once a sealed phase holds only a credit', async () => {
    state.completed = true;
    state.phases[1] = { ...state.phases[1], passKind: 'credit' };
    await drawBoth();
    expect(record('dossier-completion')).toBe('Complete');
    expect(paper.textContent).toContain('5 of 6');
    expect(record('dossier-standing')).toBe('5 of 6 phases passed. The project is complete.');
    expect(paper.textContent).not.toContain('All 6 phases passed');
  });

  it('still says all phases passed when every sealed phase holds a reviewed pass', async () => {
    state.completed = true;
    await drawBoth();
    expect(record('dossier-standing')).toBe('All 6 phases passed. The project is complete.');
  });
});
