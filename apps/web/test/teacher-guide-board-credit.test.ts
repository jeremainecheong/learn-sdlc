/**
 * A teacher's Pass on a phase credits the class board, but the strict
 * gate still waits on a reviewed pass before the learner can move on. The
 * learner detail page already says so ("Waiting on a reviewed pass of …",
 * TeacherPortal.tsx); the teacher guide says it too, in section 9 next to the
 * sign-off queue. The generator cuts the guide at `## ` headings only, so the
 * `###` subsection lives inside section 9's entry.
 */
import { describe, expect, it } from 'vitest';
import { TEACHER_GUIDE_SECTIONS } from '../lib/teacher-guide-doc.generated';

const SECTION_ID = '9-sign-off-one-task-for-many-learners';

describe('the teacher guide on marking a phase as passed', () => {
  it("the teacher guide says a Pass credits the board and leaves the learner's advance waiting on a reviewed pass", () => {
    const section = TEACHER_GUIDE_SECTIONS.find((entry) => entry.id === SECTION_ID);
    expect(section).toBeDefined();
    const markdown = section!.markdown;
    const queue = markdown.indexOf('\n### The sign-off queue\n');
    const passed = markdown.indexOf('\n### When you mark a phase as passed\n');
    expect(queue).toBeGreaterThan(-1);
    expect(passed).toBeGreaterThan(queue);
    const paragraph = markdown.slice(passed).replace(/\s+/g, ' ');
    expect(paragraph).toContain('credits it on your class board at the pass mark');
    expect(paragraph).toContain('does not stand in for the review');
    expect(paragraph).toContain('Waiting on a reviewed pass of');
    // No section of its own: the generator cuts at `## ` only.
    expect(TEACHER_GUIDE_SECTIONS.some((entry) => entry.title.startsWith('When you mark'))).toBe(false);
  });
});
