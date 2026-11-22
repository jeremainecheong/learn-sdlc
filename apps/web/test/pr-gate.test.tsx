import { describe, expect, it } from 'vitest';
import { mergeGateMet, reviewGateMet } from '@/components/workspace/TaskPanel';

/**
 * What lights Merge on a phase a teacher has split.
 *
 * Merge must not light on the newest revision alone. On a split phase the
 * newest revision can be the **optional** task's, and passing an optional
 * task moves no gate, so the button would light, the learner would press it,
 * and `api.advance` would answer "This phase must pass before advancing."
 *
 * A phase with one task lights on its newest verdict, deliberately. One task
 * is the phase, and every project in the product is a project of one-task
 * phases until a teacher splits one.
 */

const counts = (over: Partial<{ total: number; required: number; passed: number; passedRequired: number }> = {}) => ({
  total: 2,
  required: 1,
  passed: 0,
  passedRequired: 0,
  ...over,
});

describe('Merge lights on the required tasks, not the newest submission', () => {
  it('stays dark when the optional task is the one that passed', () => {
    const phase = { status: 'submitted' as const, taskCounts: counts({ passed: 1, passedRequired: 0 }) };
    // The newest revision passed (it is the optional task's) and a
    // newest-revision rule would read exactly this boolean.
    expect(mergeGateMet(phase, true)).toBe(false);
  });

  it('lights once every required task is in', () => {
    const phase = { status: 'submitted' as const, taskCounts: counts({ passed: 2, passedRequired: 1 }) };
    // Not on the newest verdict: the required task's own revision may be older.
    expect(mergeGateMet(phase, false)).toBe(true);
  });

  it('lights on a passed phase whatever its tasks say, because the phase is the roll-up', () => {
    expect(mergeGateMet({ status: 'passed', taskCounts: counts() }, false)).toBe(true);
  });

  it('is the expression it is today on a phase with one task', () => {
    const one = counts({ total: 1, required: 1, passed: 0, passedRequired: 0 });
    // A verdict in hand lights it, even before the shell's
    // copy of the phase has caught up with the status that verdict wrote.
    expect(mergeGateMet({ status: 'in_progress', taskCounts: one }, true)).toBe(true);
    expect(mergeGateMet({ status: 'in_progress', taskCounts: one }, false)).toBe(false);
  });

  it('is the expression it is today on a payload written before tasks existed', () => {
    expect(mergeGateMet({ status: 'in_progress' }, true)).toBe(true);
    expect(mergeGateMet({ status: 'in_progress' }, false)).toBe(false);
  });

  it('falls back to the verdict on a split phase whose tasks are all optional', () => {
    const none = counts({ total: 2, required: 0, passed: 1, passedRequired: 0 });
    expect(mergeGateMet({ status: 'submitted', taskCounts: none }, true)).toBe(true);
  });
});

describe('a phase passed ahead of the learner', () => {
  it('does not light Merge, because advance refuses a phase the learner has not reached', () => {
    expect(mergeGateMet({ status: 'passed', notReachedYet: true }, true)).toBe(false);
    expect(mergeGateMet({ status: 'passed' }, true)).toBe(true);
  });

  /*
   * The same `false` must not be read as the verdict, or a learner who earned
   * their own reviewed pass on a phase unlocked early is told "Needs
   * revision" under a review that passed. Whether the review is in and
   * whether Merge may be pressed are two questions.
   */
  it('still reads a review the learner passed ahead of time as a pass', () => {
    expect(reviewGateMet({ status: 'passed', notReachedYet: true }, true)).toBe(true);
    expect(reviewGateMet({ status: 'passed', notReachedYet: true }, false)).toBe(true);
  });

  it('does not read a board-only Pass ahead of the learner as a review', () => {
    const gaps = [{ key: '', title: 'Testing' }];
    expect(reviewGateMet({ status: 'passed', notReachedYet: true, evidenceNeeded: gaps }, true)).toBe(false);
    expect(mergeGateMet({ status: 'passed', notReachedYet: true, evidenceNeeded: gaps }, true)).toBe(false);
  });

  it('is the merge gate everywhere the learner stands on the phase', () => {
    for (const phase of [
      { status: 'passed' as const },
      { status: 'passed' as const, evidenceNeeded: [{ key: '', title: 'Design' }] },
      { status: 'in_progress' as const },
      { status: 'submitted' as const, taskCounts: counts({ passed: 2, passedRequired: 1 }) },
    ]) {
      for (const verdict of [true, false]) expect(reviewGateMet(phase, verdict)).toBe(mergeGateMet(phase, verdict));
    }
  });
});
