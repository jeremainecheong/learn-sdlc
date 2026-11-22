/**
 * When every paper of a required quiz is spent, the room must not say "This
 * quiz is required, so the phase stays shut until it passes.": the phase is
 * open (the learner is working in it). What waits on a required quiz is the
 * phase's Pass, and with it the next phase or the project's completion. The
 * line says that, as the teacher's lever note does. The optional line has
 * its own words.
 */
import { describe, expect, it } from 'vitest';
import { noPapersNextLine } from '@/components/workspace/quiz/QuizRoom';

const KEPT = 'Every paper you handed in stays in your record. Your instructor can reset this quiz, which draws a fresh paper and gives you your attempts back.';

describe('the spent-quiz line', () => {
  it('a required quiz: the phase cannot pass until this quiz passes', () => {
    expect(noPapersNextLine(true)).toBe(`${KEPT} This quiz is required, so the phase cannot pass until this quiz passes.`);
    expect(noPapersNextLine(true)).not.toContain('stays shut');
  });
  it('an optional quiz says nothing else is waiting on it', () => {
    expect(noPapersNextLine(false)).toBe(`${KEPT} This quiz is optional, so nothing else is waiting on it.`);
  });
});
