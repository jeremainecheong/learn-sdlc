/**
 * The Seal step and the sealed files' inline help say where a hidden test
 * goes. The seal door refuses a hidden test at a one-segment path, so the
 * guide tells the teacher to put it under a folder, such as tests/<name>, in
 * the door's own words. The copy lives in packages/shared/src/teacher-path.ts.
 */
import { describe, expect, it } from 'vitest';
import { GUIDE_STEPS, INLINE_HELP } from '@learnsdlc/shared';

/** The door sentence's words. */
const UNDER_A_FOLDER = 'under a folder, such as tests/<name>';

describe('the Seal step says where a hidden test goes', () => {
  it('the Seal step tells the teacher to put a hidden test under a folder, such as tests/<name>', () => {
    const seal = GUIDE_STEPS.find((step) => step.key === 'seal')!;
    expect(seal.help.join(' ')).toContain(`Put a hidden test ${UNDER_A_FOLDER}.`);
    // Still two to four sentences' worth of paragraphs, and the starter warning stays last.
    expect(seal.help.length).toBeGreaterThanOrEqual(2);
    expect(seal.help.length).toBeLessThanOrEqual(4);
    expect(seal.help[seal.help.length - 1]).toMatch(/^Replace the starter's hidden tests/);
  });

  it("the sealed files' inline help says the same", () => {
    expect(INLINE_HELP.sealedFiles.line).toContain(`Put a hidden test ${UNDER_A_FOLDER}.`);
    expect(INLINE_HELP.sealedFiles.line).toMatch(/^Sealed files are the hidden tests/);
  });

  it('neither line names a course or uses a separator', () => {
    const seal = GUIDE_STEPS.find((step) => step.key === 'seal')!;
    for (const text of [...seal.help, INLINE_HELP.sealedFiles.line]) {
      expect(text).not.toMatch(/[·|]/);
      expect(text).not.toMatch(/\b(course|module|CS\d{3,4})\b/i);
    }
  });
});
