import { describe, expect, it } from 'vitest';
import { unlinkedChip } from '@/components/workspace/panels/testing/lib';

/**
 * A passed Testing room's More menu showed a red
 * "13 not linked" beside "All bugs caught". It counts the tests with no
 * `verifies` link to a criterion: real, and something the learner can act on
 * (the editor's gutter offers the criteria), but a traceability claim the
 * review does not grade. So the chip says what it counts, and on a passed
 * phase it is quiet rather than a warning.
 */
describe('the suite\'s link chip', () => {
  it('says what it counts', () => {
    expect(unlinkedChip(13, false)?.text).toBe('13 tests not linked to a criterion');
    expect(unlinkedChip(1, false)?.text).toBe('1 test not linked to a criterion');
  });
  it('on a passed phase, the neutral tone, never the warning', () => {
    expect(unlinkedChip(13, true)).toEqual({ tone: 'neutral', text: '13 tests not linked to a criterion' });
  });
  it('while the phase is worked, the warning tone', () => {
    expect(unlinkedChip(13, false)?.tone).toBe('warn');
  });
  it('nothing when every test is linked', () => {
    expect(unlinkedChip(0, true)).toBeNull();
    expect(unlinkedChip(0, false)).toBeNull();
  });
});
