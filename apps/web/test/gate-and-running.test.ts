/**
 * Two sentences that spoke of a state the system was not in.
 *
 * The teacher's lever note (components/staff/LearnerTasks.tsx, gateSentence and
 * the spent-quiz line) said "<Task> is required, so <Phase> stays shut until it
 * passes (again)" of a phase that is open: the learner is working in it. What
 * waits on the task is the phase's Pass. It now reads "<Task> is required, so
 * <Phase> cannot pass until <Task> passes (again)." (pinned by the changed
 * expectations in teacher-task-levers.test.tsx).
 *
 * The Change impact card (the change request page and the IDE's Change tab,
 * emptyImpact in maintenance/impact.ts) said "Submit PR-6 to get one." while a
 * submission was queued or running; it now says the review is running. Before
 * any submission, and after a review, the words are as they were.
 */
import { describe, expect, it } from 'vitest';
import { closureText, moduleText } from './support/source-text';
import { emptyImpact } from '@/components/workspace/panels/maintenance/impact';

describe('the Change impact card while a review runs', () => {
  it('says the review is running, not to submit', () => {
    expect(emptyImpact('PR-6', false, true)).toEqual({
      title: 'No call graph yet',
      body: 'The review of PR-6 is running. The graph is drawn from the static analysis in its verdict.',
    });
  });
  it('before any submission and after a review the card says there is no call graph yet, or none to draw', () => {
    expect(emptyImpact('PR-6', false)).toEqual({ title: 'No call graph yet', body: 'The graph is drawn from the static analysis in the verdict. Submit PR-6 to get one.' });
    expect(emptyImpact('PR-6', false, false)).toEqual(emptyImpact('PR-6', false));
    expect(emptyImpact('PR-6', true, true)).toEqual({ title: 'No call graph', body: 'The review of PR-6 read no function in your files, so there is no call graph to draw.' });
  });
  it('both cards and the model pass the queued or running state', () => {
    expect(closureText('MaintenanceTools')).toContain('{...emptyImpact(pr, !m.awaitingVerdict, m.reviewRunning, m.analysis)}');
    expect(closureText('ChangeImpactCard')).toContain('{...emptyImpact(pr, !m.awaitingVerdict, m.reviewRunning, m.analysis)}');
    expect(closureText('useMaintenance')).toContain("reviewRunning: submission?.status === 'queued' || submission?.status === 'running',");
  });
});

describe("the teacher's gate sentence", () => {
  it('never says an open phase stays shut', () => {
    expect(moduleText('LearnerTasks')).not.toContain('stays shut until it passes');
    const tasks = closureText('LearnerTasks');
    expect(tasks).toContain('is required, so ${phase.title} cannot pass until ${task.title} passes again.');
    expect(tasks).toContain('is required, so ${phase.title} cannot pass until ${task.title} passes.');
  });
});
