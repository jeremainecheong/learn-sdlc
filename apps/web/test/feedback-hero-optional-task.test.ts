/**
 * The feedback hero's line on a split
 * phase where only an OPTIONAL task waits and a required task is open. A
 * waiting optional task does not hold the phase, so the line never says the
 * teacher's countersignature is part of what opens the next phase there.
 */
import { describe, expect, it } from 'vitest';
import type { PhaseTaskView } from '@learnsdlc/shared';
import { openRequiredWhileWaiting, requiredTaskWaits, splitOpenLine } from '@/components/workspace/signoff-surfaces-copy';

const t = (over: Partial<PhaseTaskView>): PhaseTaskView =>
  ({ key: 'main', title: 'Write the stories', required: true, status: 'submitted', awaitingSignOff: true, ...over }) as PhaseTaskView;
const quizOpen = t({ key: 'quiz', title: 'Check your understanding', status: 'in_progress', awaitingSignOff: false });

describe('the countersign clause follows a waiting REQUIRED task', () => {
  it('a required task waits: the line names the open task and the countersignature', () => {
    const detail = { status: 'in_progress' as const, tasks: [t({}), quizOpen] };
    expect(openRequiredWhileWaiting(detail).map((x) => x.title)).toEqual(['Check your understanding']);
    expect(requiredTaskWaits(detail)).toBe(true);
    expect(splitOpenLine('Requirements', ['Check your understanding'], requiredTaskWaits(detail))).toBe(
      'Still open in Requirements: Check your understanding. The next phase opens once it passes and your teacher countersigns your work.',
    );
  });
  it('only an optional task waits: the line names the open task, no countersign clause', () => {
    const detail = { status: 'in_progress' as const, tasks: [t({ required: false }), quizOpen] };
    expect(openRequiredWhileWaiting(detail).map((x) => x.title)).toEqual(['Check your understanding']);
    expect(requiredTaskWaits(detail)).toBe(false);
    const line = splitOpenLine('Requirements', ['Check your understanding'], requiredTaskWaits(detail));
    expect(line).not.toContain('countersign');
    expect(line).toBe('Still open in Requirements: Check your understanding. The next phase opens once it passes.');
  });
});
