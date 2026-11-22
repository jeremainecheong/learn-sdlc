import {
  CLASSIFY_REASK_CLOSE,
  CLASSIFY_REASK_FLOOR_MS,
  CLASSIFY_REASK_MARGIN_MS,
  CLASSIFY_REASK_OPEN,
  classifyReaskFits,
  classifyReaskNote,
  readIntentRefusal,
} from './classify-reask';

/*
 * An agentic.classify answer the propose route cannot use would end a learner's revision with a 503 although the
 * provider answered in seconds, so the route asks once more inside the same call; this module reads which rule the refused answer broke and writes the one note the second ask adds.
 */
describe('the prompt assessment re-ask', () => {
  describe('readIntentRefusal: which rule the refused answer broke, as a fixed token', () => {
    it.each([
      ['an inadequate verdict with two questions (the questionnaire the rule forbids)', { adequate: false, feedback: 'Two things are unclear.', questions: ['Which page?', 'Which field?'] }],
      ['an inadequate verdict with no question', { adequate: false, feedback: 'Unclear.', questions: [] }],
      ['an adequate verdict that still asks', { adequate: true, feedback: 'Ready.', questions: ['What change?'] }],
      ['an adequate verdict with an empty feedback that still asks', { adequate: true, feedback: '', questions: ['What change?'] }],
    ])('one_question for %s', (_name, answer) => {
      expect(readIntentRefusal(answer)).toBe('one_question');
    });

    it.each([
      ['no answer', null],
      ['a list', [{ adequate: true }]],
      ['a text', 'adequate'],
      ['a verdict that is not true or false', { adequate: 'yes', feedback: 'Ready.', questions: [] }],
      ['no feedback field', { adequate: false, questions: ['Which page?'] }],
      ['questions that are not a list', { adequate: false, feedback: 'Unclear.', questions: 'Which page?' }],
      ['a blank question', { adequate: false, feedback: 'Unclear.', questions: [' '] }],
      ['a question that is not a text', { adequate: false, feedback: 'Unclear.', questions: [3] }],
      ['an inadequate verdict with an empty feedback and its one question', { adequate: false, feedback: ' ', questions: ['Which page?'] }],
    ])('assessment for %s', (_name, answer) => {
      expect(readIntentRefusal(answer)).toBe('assessment');
    });
  });

  describe('classifyReaskNote: fixed copy only, neutral on the verdict', () => {
    it('writes the open, one sentence for the rule, and the close, exactly', () => {
      expect(classifyReaskNote('one_question')).toBe(`${CLASSIFY_REASK_OPEN}\nIts questions did not match its verdict: an inadequate request takes exactly one question and an adequate one none.\n${CLASSIFY_REASK_CLOSE}`);
      expect(classifyReaskNote('assessment')).toBe(`${CLASSIFY_REASK_OPEN}\nIt was not one object holding adequate as true or false, feedback as a text and questions as a list of non-empty texts.\n${CLASSIFY_REASK_CLOSE}`);
    });

    it('never says which way the verdict should go and restates the one-question rule', () => {
      for (const note of [classifyReaskNote('one_question'), classifyReaskNote('assessment')]) {
        expect(note).toContain('this note does not say whether the request is adequate');
        expect(note).toContain('exactly one question');
        expect(note).toContain('{"adequate":boolean,"feedback":string,"questions":string[]}');
        expect(note).not.toMatch(/\{\{|undefined|null/);
      }
    });

    it('takes no part of the refused answer: its argument is the token alone', () => {
      expect(classifyReaskNote.length).toBe(1);
      const answer = { adequate: false, feedback: 'PLANTED FEEDBACK', questions: ['PLANTED ONE?', 'PLANTED TWO?'] };
      const note = classifyReaskNote(readIntentRefusal(answer));
      expect(note).not.toContain('PLANTED');
    });
  });

  describe('classifyReaskFits: the 14 s floor and the first ask\'s own duration plus 10 s', () => {
    it('states the floor and the margin', () => {
      expect([CLASSIFY_REASK_FLOOR_MS, CLASSIFY_REASK_MARGIN_MS]).toEqual([14_000, 10_000]);
    });

    it.each([
      [13_999, 0, false], [14_000, 0, true], [14_000, 3_900, true],
      [14_999, 5_000, false], [15_000, 5_000, true], [20_000, 35_000, false], [45_000, 35_000, true],
    ])('%i ms left after a first ask of %i ms: %s', (left, firstMs, fits) => {
      expect(classifyReaskFits(left, firstMs)).toBe(fits);
    });
  });
});
