/**
 * The design-claim vocabulary the review and the Design editor share: each
 * pattern fires on the claim it names and stays quiet on a hedged sentence or
 * a correct contract line.
 */

import {
  CLAIMS_LOW_FIRST,
  CLAIMS_NO_ERRORS,
  CLAIMS_NO_INPUTS,
  CLAIMS_NO_ORDER,
  CLAIMS_NO_RETURN,
  CLAIMS_TODAY_OVERDUE,
  claimAsserted,
  claimSentences,
} from './index';

describe('design claims', () => {
  it('splits a line into trimmed sentences at punctuation and line breaks', () => {
    expect(claimSentences('Returns a list.  Raises nothing; ok!\nNext line ')).toEqual([
      'Returns a list.',
      'Raises nothing;',
      'ok!',
      'Next line',
    ]);
    expect(claimSentences('  ')).toEqual([]);
  });

  it('finds each claim it names', () => {
    expect(claimAsserted('Raises nothing.', CLAIMS_NO_ERRORS)).toBe(true);
    expect(claimAsserted('None', CLAIMS_NO_INPUTS)).toBe(true);
    expect(claimAsserted('Returns nothing.', CLAIMS_NO_RETURN)).toBe(true);
    expect(claimAsserted('A task due today is overdue.', CLAIMS_TODAY_OVERDUE)).toBe(true);
    expect(claimAsserted('Lowest priority first.', CLAIMS_LOW_FIRST)).toBe(true);
    expect(claimAsserted('Tasks come back in insertion order.', CLAIMS_NO_ORDER)).toBe(true);
  });

  it('ignores a sentence a hedge walks back', () => {
    expect(claimAsserted('It never raises nothing unless asked.', CLAIMS_NO_ERRORS)).toBe(false);
    expect(claimAsserted('Not in insertion order.', CLAIMS_NO_ORDER)).toBe(false);
  });

  it('ignores a correct contract line', () => {
    expect(claimAsserted('Overdue means the due date is before today.', CLAIMS_TODAY_OVERDUE)).toBe(false);
    expect(claimAsserted('filter_tasks(tasks, keyword=None)', CLAIMS_NO_INPUTS)).toBe(false);
  });

  it('keeps no state between calls', () => {
    expect([1, 2, 3].map(() => CLAIMS_NO_ERRORS.test('no errors'))).toEqual([true, true, true]);
  });
});
