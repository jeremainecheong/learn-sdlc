import { describe, expect, it } from 'vitest';
import {
  PHASE_KEYS,
  PHASE_META,
  PHASE_REVIEWER,
  phaseHue,
  phaseTint,
  scoreLabel,
  statusState,
  statusWord,
} from '@/lib/phase';
import { PHASE_ORDER } from '@learnsdlc/shared';

/**
 * The vocabulary every list in the product shares. It is small, and it decides
 * what colour a phase is drawn in and what a score is called, everywhere.
 */

describe('the phase table', () => {
  it('names the six phases the API names, in the same order', () => {
    expect(PHASE_KEYS).toEqual(PHASE_ORDER);
    expect(PHASE_KEYS.map((k) => PHASE_META[k].order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives every phase a reviewer with initials and a job', () => {
    PHASE_KEYS.forEach((key) => {
      const reviewer = PHASE_REVIEWER[key];
      expect(reviewer.initials).toMatch(/^[A-Z]{2}$/);
      expect(reviewer.role.length).toBeGreaterThan(0);
      expect(reviewer.does.length).toBeGreaterThan(0);
    });
  });

  it('reads its colours from the theme rather than hard-coding one', () => {
    expect(phaseHue('testing')).toBe('rgb(var(--hue-testing))');
    expect(phaseTint('design')).toBe('rgb(var(--tint-design))');
  });
});

describe('statusState', () => {
  it('is pass for a phase that cleared its gate, whether or not it is current', () => {
    expect(statusState('passed', false)).toBe('pass');
    expect(statusState('passed', true)).toBe('pass');
  });

  it('is warn for a submitted phase, because the last attempt fell short', () => {
    expect(statusState('submitted', true)).toBe('warn');
  });

  it('separates the phase being worked on from one merely open', () => {
    expect(statusState('in_progress', true)).toBe('now');
    expect(statusState('in_progress', false)).toBe('todo');
  });

  it('is todo for a locked phase even if something calls it current', () => {
    expect(statusState('locked', true)).toBe('todo');
  });
});

describe('scoreLabel', () => {
  it('says how a score sat against the gate it was marked to', () => {
    expect(scoreLabel(86)).toBe('Passed with 86');
    expect(scoreLabel(64)).toBe('Scored 64 of 70');
    expect(scoreLabel(64, 60)).toBe('Passed with 64');
    // Exactly on the gate passes.
    expect(scoreLabel(70)).toBe('Passed with 70');
  });

  it('rounds rather than showing a grader’s decimal', () => {
    expect(scoreLabel(69.6)).toBe('Passed with 70');
    expect(scoreLabel(69.4)).toBe('Scored 69 of 70');
  });

  it('says nothing was submitted rather than showing a zero', () => {
    expect(scoreLabel(null)).toBe('Not submitted');
    expect(scoreLabel(undefined)).toBe('Not submitted');
    expect(scoreLabel(Number.NaN)).toBe('Not submitted');
    // A real zero is a score, not an absence.
    expect(scoreLabel(0)).toBe('Scored 0 of 70');
  });
});

describe('statusWord', () => {
  it('turns a status into the plain word the interface uses', () => {
    expect(statusWord('passed')).toBe('Passed');
    expect(statusWord('locked')).toBe('Locked');
    expect(statusWord('submitted')).toBe('Submitted');
    expect(statusWord('in_progress')).toBe('In progress');
  });
});
