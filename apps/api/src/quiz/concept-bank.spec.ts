import { PHASE_ORDER } from '@learnsdlc/shared';
import { CONCEPT_BANK, CONCEPT_BANK_VERSION } from './concept/bank';

/**
 * The concept-check bank.
 *
 * Six phases, six questions each, on the chapter's learning points rather
 * than on any one project. Every question is a single-answer MCQ with four
 * options, exactly one keyed, and an explanation the learner reads afterwards.
 */
describe('the concept-check bank', () => {
  it('covers every phase with exactly six questions', () => {
    expect(Object.keys(CONCEPT_BANK).sort()).toEqual([...PHASE_ORDER].sort());
    for (const key of PHASE_ORDER) expect(CONCEPT_BANK[key].questions).toHaveLength(6);
    expect(CONCEPT_BANK_VERSION).toMatch(/^concept-bank@\d+$/);
  });

  it('gives every question a unique id, four options, one key and an explanation', () => {
    const ids = new Set<string>();
    for (const key of PHASE_ORDER) {
      expect(CONCEPT_BANK[key].title.trim()).not.toBe('');
      for (const question of CONCEPT_BANK[key].questions) {
        expect(question.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
        expect(ids.has(question.id)).toBe(false);
        ids.add(question.id);
        expect(question.stem.trim().length).toBeGreaterThan(10);
        expect(question.options).toHaveLength(4);
        const optionIds = question.options.map((option) => option.id);
        expect(new Set(optionIds).size).toBe(4);
        const texts = question.options.map((option) => option.text.trim().toLowerCase());
        expect(new Set(texts).size).toBe(4);
        expect(question.correct).toHaveLength(1);
        expect(optionIds).toContain(question.correct[0]);
        expect(question.explanation.trim().length).toBeGreaterThan(20);
        for (const text of texts) {
          expect(text).not.toMatch(/all of the above|none of the above|both a and b/);
        }
      }
    }
    expect(ids.size).toBe(36);
  });

  it('does not always key the same option position', () => {
    const positions = new Set<number>();
    for (const key of PHASE_ORDER) {
      for (const question of CONCEPT_BANK[key].questions) {
        positions.add(question.options.findIndex((option) => option.id === question.correct[0]));
      }
    }
    expect(positions.size).toBeGreaterThan(2);
  });
});
