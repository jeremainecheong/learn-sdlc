import { describe, expect, it } from 'vitest';
import type { PhaseDetail, PhaseSummary } from '@learnsdlc/shared';
import { solutionDoorOpen } from '@/components/solution';

/**
 * The reference-solution door follows the gate.
 *
 * A teacher's Pass or Sign off reads `passed` on the board with no reviewed
 * revision behind it, so a board-only door would show "Read the reference
 * solution" next to "Submit Implementation for review". The API opens the
 * answer only on the strict gate's own evidence, and says so on the phase
 * detail (`solution.awaitingReview`); no room draws a door the route refuses.
 * A pass the review accepted carries no such field, so the door is drawn as
 * soon as that pass stands.
 */

const summary = (over: Partial<PhaseSummary> = {}): PhaseSummary => ({
  id: 'phase-3',
  key: 'implementation',
  order: 3,
  title: 'Implementation',
  status: 'passed',
  bestScore: 70,
  attempts: 0,
  reflection: null,
  passedAt: '2026-09-29T01:00:00.000Z',
  opensAt: null,
  dueAt: null,
  ...over,
});

const detail = (solution: PhaseDetail['solution']) =>
  ({
    ...summary(),
    rubric: { passThreshold: 70, criteria: [] },
    files: [],
    objectives: [],
    tasks: [],
    solution,
  }) as unknown as PhaseDetail;

describe('the answer-key door', () => {
  it('is open on a passed phase the review accepted', () => {
    const held = detail({ available: true, files: 4, readAt: null });
    expect(solutionDoorOpen(held)).toBe(true);
  });

  it('is closed where the board reads passed but no reviewed pass stands behind it', () => {
    const held = detail({ available: true, files: 4, readAt: null, awaitingReview: true });
    expect(solutionDoorOpen(held)).toBe(false);
  });

  it('is closed before the phase passes, and where the pack answers nothing', () => {
    expect(solutionDoorOpen({ status: 'in_progress', solution: { available: true, files: 4, readAt: null } })).toBe(false);
    expect(solutionDoorOpen({ status: 'passed', solution: { available: false, files: 0, readAt: null } })).toBe(false);
    expect(solutionDoorOpen({ status: 'passed' })).toBe(false);
    expect(solutionDoorOpen(null)).toBe(false);
  });
});
