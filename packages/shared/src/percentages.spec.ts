/**
 * The two overview percentages, as arithmetic.
 *
 * This file pins the definitions and nothing else. The half that cannot be
 * asserted here is the one that needs rows: that `checklistPercent` equals
 * `progressPercent` on a TaskTrackr enrolment whose `phase_states` rows are
 * **complete**, and differs on one short a row. That check belongs beside
 * `analytics.forLearner`, which is the reader that calls neither
 * `reconcileToPack` nor `fillMissingPhaseStates` and is therefore the reader
 * where the disagreement is reachable.
 */

import {
  checklistPercentOf,
  masteryPercentOf,
  overallChecklistPercent,
} from './percentages';

describe('the checklist percentage', () => {
  it('is required tasks passed over required tasks declared', () => {
    expect(checklistPercentOf({ required: 4, passedRequired: 1 })).toBe(25);
    expect(checklistPercentOf({ required: 4, passedRequired: 4 })).toBe(100);
    expect(checklistPercentOf({ required: 2, passedRequired: 0 })).toBe(0);
  });

  it('is 0 and not 100 for a phase that declares no required task', () => {
    // A phase with nothing required has no checklist to be done with. Answering
    // 100 would make the overall number climb when a teacher removes work,
    // which is the one direction this figure must never move on its own.
    expect(checklistPercentOf({ required: 0, passedRequired: 0 })).toBe(0);
  });

  it('rounds the way progressPercent rounds, because the agreement is the point', () => {
    // `progressPercent` is `Math.round((passed / phases.length) * 100)`. A
    // different rounding here would make the two disagree by a point on a board
    // where they are asking the same question, and the row-level check in the
    // analytics spec would be pinning a rounding rule rather than an identity.
    expect(checklistPercentOf({ required: 3, passedRequired: 1 })).toBe(33);
    expect(checklistPercentOf({ required: 3, passedRequired: 2 })).toBe(67);
    expect(checklistPercentOf({ required: 6, passedRequired: 1 })).toBe(17);
  });

  it('is task weighted across a version, not phase weighted', () => {
    // Four required tasks in one phase and one in another: the checklist is 5
    // items long, and finishing the four is 80% done: not 50%, which is what
    // a mean of the per-phase percentages would say.
    const phases = [
      { required: 4, passedRequired: 4 },
      { required: 1, passedRequired: 0 },
    ];
    expect(overallChecklistPercent(phases)).toBe(80);
    const phaseWeighted = Math.round(
      phases.reduce((sum, phase) => sum + checklistPercentOf(phase), 0) / phases.length,
    );
    expect(overallChecklistPercent(phases)).not.toBe(phaseWeighted);
  });

  it('agrees with passed-over-phases when every phase declares exactly one required task', () => {
    // Which is the shape of every phase of the shipped project, and therefore
    // of every copy of it. This is the arithmetic half of the identity; the
    // half that needs rows is in the analytics spec.
    const six = [1, 1, 1, 1, 1, 1];
    for (let passed = 0; passed <= 6; passed += 1) {
      const phases = six.map((required, at) => ({
        required,
        passedRequired: at < passed ? 1 : 0,
      }));
      expect(overallChecklistPercent(phases)).toBe(Math.round((passed / 6) * 100));
    }
  });

  it('is 0 for a version that declares nothing required at all', () => {
    expect(overallChecklistPercent([])).toBe(0);
    expect(overallChecklistPercent([{ required: 0, passedRequired: 0 }])).toBe(0);
  });
});

describe('the mastery percentage', () => {
  it('is the mean best score over the quizzes that have one', () => {
    expect(masteryPercentOf([80, 100])).toBe(90);
    expect(masteryPercentOf([60])).toBe(60);
    expect(masteryPercentOf([0, 100, 50])).toBe(50);
  });

  it('is null and never 0 when there is no quiz, and null when none has been attempted', () => {
    // A blank and a zero are different facts: the gradebook's own stated rule.
    // A learner whose project declares no quiz has not scored 0 on anything,
    // and a tile that drew 0% would be reporting a failure nobody had.
    expect(masteryPercentOf([])).toBeNull();
    expect(masteryPercentOf([null, null])).toBeNull();
    expect(masteryPercentOf([undefined])).toBeNull();
  });

  it('leaves an unattempted quiz out of the mean rather than counting it as a zero', () => {
    // An unanswered question is not an answer scored badly. Counting the null
    // would drag a learner who has taken one quiz well below the score they
    // actually earned, on a number whose label says *concepts*.
    expect(masteryPercentOf([80, null])).toBe(80);
    expect(masteryPercentOf([80, 0])).toBe(40);
  });

  it('rounds the way averageScore rounds', () => {
    expect(masteryPercentOf([80, 100, 90])).toBe(90);
    expect(masteryPercentOf([80, 100, 91])).toBe(90);
    expect(masteryPercentOf([60, 80])).toBe(70);
  });
});
