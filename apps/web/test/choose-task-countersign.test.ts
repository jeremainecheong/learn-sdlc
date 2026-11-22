/**
 * Which task `chooseTask` lands on.
 *
 * On a split phase with one task waiting on the teacher's countersignature
 * and a required sibling still open, the waiting task must not be treated as
 * still to pass: the generic room and the pull-request room without `?task=`
 * would land on it (Submit off, with the reason) and the dashboard's
 * next-task title would name it. It lands where the work is: a required task
 * still to pass that is not waiting, then any task still to pass that is not
 * waiting, then the general fallbacks, so a phase where every open task waits
 * still lands on one.
 */
import { describe, expect, it } from 'vitest';
import type { PhaseTaskView } from '@learnsdlc/shared';
import { chooseTask, taskKeyToSend } from '@/components/workspace/TaskPanel';
import { taskView } from './fixtures';

const task = taskView;
const waiting = (key: string, order: number, over: Partial<PhaseTaskView> = {}) =>
  task({ key, order, evidence: 'signed-off', status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88, lastSubmissionId: 'rev-1', ...over });

describe('chooseTask on a split phase with a task waiting on the countersignature', () => {
  it('lands on the required sibling still open, not on the waiting task', () => {
    const tasks = [waiting('countersign', 1), task({ key: 'scope', order: 2 })];
    expect(chooseTask(tasks, null)?.key).toBe('scope');
    expect(chooseTask(tasks, undefined)?.key).toBe('scope');
    expect(taskKeyToSend(tasks, null)).toBe('scope');
  });

  it('a waiting required task gives way to an optional task still open', () => {
    const tasks = [waiting('countersign', 1), task({ key: 'extra', order: 2, required: false })];
    expect(chooseTask(tasks, null)?.key).toBe('extra');
  });

  it('a required task still open comes before an optional one, waiting tasks aside', () => {
    const tasks = [waiting('countersign', 1), task({ key: 'extra', order: 2, required: false }), task({ key: 'scope', order: 3 })];
    expect(chooseTask(tasks, null)?.key).toBe('scope');
  });

  it('a phase where every open task waits still lands on one (the first required)', () => {
    const tasks = [task({ key: 'done', order: 1, status: 'passed', passedAt: '2026-10-04T00:00:00.000Z' }), waiting('countersign', 2), waiting('second', 3)];
    expect(chooseTask(tasks, null)?.key).toBe('countersign');
  });

  it('a named task is always the answer, waiting or not', () => {
    const tasks = [waiting('countersign', 1), task({ key: 'scope', order: 2 })];
    expect(chooseTask(tasks, 'countersign')?.key).toBe('countersign');
    expect(taskKeyToSend(tasks, 'countersign')).toBe('countersign');
  });

  it('a refused review on a marked task (submitted, not waiting) is still work to do', () => {
    const tasks = [task({ key: 'refused', order: 1, evidence: 'signed-off', status: 'submitted', awaitingSignOff: false, attempts: 1 }), task({ key: 'scope', order: 2 })];
    expect(chooseTask(tasks, null)?.key).toBe('refused');
  });

  it('a quiz still open is never landed on in place of the waiting task (its submit would name the quiz)', () => {
    const tasks = [waiting('main', 1, { artefactType: 'code' }), task({ key: 'quiz', order: 2, artefactType: 'quiz', evidence: 'automated' })];
    expect(chooseTask(tasks, null)?.key).toBe('main');
    expect(taskKeyToSend(tasks, null)).toBe('main');
  });

  it('a landing that is not waiting is unchanged, a quiz included', () => {
    const tasks = [task({ key: 'quiz', order: 1, artefactType: 'quiz', evidence: 'automated' }), waiting('main', 2), task({ key: 'scope', order: 3 })];
    expect(chooseTask(tasks, null)?.key).toBe('quiz');
  });

  it('with nothing waiting the landing is the first task, open or passed', () => {
    const tasks = [task({ key: 'story', order: 1 }), task({ key: 'scope', order: 2 })];
    expect(chooseTask(tasks, null)?.key).toBe('story');
    const done = tasks.map((one) => ({ ...one, status: 'passed' as const }));
    expect(chooseTask(done, null)?.key).toBe('story');
  });
});
