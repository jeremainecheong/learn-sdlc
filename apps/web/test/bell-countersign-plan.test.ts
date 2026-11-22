/**
 * The bell's plan while a phase waits on the teacher's countersignature.
 *
 * `buildNextSteps` (the plan the bell counts on every learner page) needs an
 * arm for a phase whose work passed and waits: a passing verdict is neither
 * "queued", "refused" nor "failed to run", so without one it would fall to
 * the "nothing submitted" arm and list "Submit <Phase> for the gate", a
 * resubmit invitation that costs a review and, refused, clears the learner's
 * place in the sign-off queue. While the phase waits the bell lists one
 * neutral step (the wait itself), never a failure and never a submit. The
 * guard rows hold every other state unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { PhaseDetail, PhaseSummary } from '@learnsdlc/shared';
import { sample, submission } from './fixtures';
import { buildNextSteps, type NextPlan } from '@/components/home/derive';

const task = (over: Record<string, unknown> = {}) => ({
  key: 'main',
  order: 1,
  required: true,
  title: 'Your test suite',
  artefactType: 'code',
  evidence: 'signed-off',
  sealed: true,
  status: 'submitted',
  awaitingSignOff: true,
  attempts: 1,
  bestScore: 88,
  passedAt: null,
  lastSubmissionId: 'rev-1',
  resetAt: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
const quiz = (over: Record<string, unknown> = {}) =>
  task({
    key: 'quiz',
    order: 2,
    title: 'Check your understanding',
    artefactType: 'quiz',
    evidence: 'automated',
    status: 'passed',
    awaitingSignOff: false,
    bestScore: 100,
    passedAt: '2026-10-02T04:00:00.000Z',
    lastSubmissionId: 'q-1',
    ...over,
  });
const openQuiz = () => quiz({ status: 'in_progress', attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null });

const passedRev = submission({ id: 'rev-1', status: 'completed', passed: true, score: 88, createdAt: '2026-10-02T05:00:00.000Z' });
const refusedRev = submission({ id: 'rev-2', status: 'completed', passed: false, score: 41, createdAt: '2026-10-02T06:00:00.000Z' });

/** The sample's Testing phase (p4), holding `tasks`, its last submission and status. */
const plan = (tasks: unknown[] | undefined, last = passedRev, status: PhaseSummary['status'] = 'submitted'): NextPlan => {
  const { enrollment, details } = sample();
  const current: PhaseSummary = { ...enrollment.phases[3], status, attempts: 1 };
  const held: PhaseDetail = {
    ...details.p4,
    status,
    objectives: ['Write one test per criterion', 'See each one fail first'],
    lastSubmission: last,
    ...(tasks ? { tasks: tasks as PhaseDetail['tasks'] } : {}),
  } as PhaseDetail;
  const phases = enrollment.phases.map((p, i) => (i === 3 ? current : p));
  return buildNextSteps({ ...enrollment, phases }, { ...details, p4: held }, current);
};
const submitInvitation = (p: NextPlan) =>
  p.steps.filter((s) => /^Submit\b/.test(s.title) || s.key === 'submit' || s.key === 'resubmit' || s.key === 'retry');

describe('the plan while the phase waits on the countersignature', () => {
  for (const [shape, tasks, last] of [
    ['one-task phase, the task flagged', () => [task()], passedRev],
    ['split phase, every required task passed or waiting', () => [task(), quiz()], passedRev],
    // The verdict landed before the task row knew it: the row names an older
    // revision and is not flagged yet; the newest graded revision passed on a
    // task the teacher marked.
    ['one-task phase, the verdict just landed', () => [task({ awaitingSignOff: false, lastSubmissionId: 'rev-0' })], passedRev],
  ] as const) {
    it(`${shape}: no "Submit ... for the gate", no resubmit, one neutral waiting step`, () => {
      const p = plan(tasks(), last);
      expect(p.steps.map((s) => s.title)).not.toContain('Submit Testing for the gate');
      expect(submitInvitation(p)).toEqual([]);
      expect(p.steps).toHaveLength(1);
      const [step] = p.steps;
      expect(step.key).toBe('signoff');
      expect(step.title).toBe("Waiting for your teacher's sign-off on Testing");
      expect(step.detail).toBe("Your work passed review. Your teacher's countersignature opens the next phase.");
      // Neutral: never a failure or a warning, and still listed (not 'pass').
      expect(step.state).toBe('now');
      expect(p.purpose).not.toMatch(/Nothing has been submitted/);
      expect(p.purpose).toBe('Your Testing work passed review.');
    });
  }
});

describe('every other state of the bell reads its own arm, with no countersignature step', () => {
  it('nothing submitted on an unmarked task: the brief arm, ending in "Submit Testing for the gate"', () => {
    const p = plan([task({ evidence: 'reviewed', status: 'in_progress', awaitingSignOff: false, attempts: 0, lastSubmissionId: null })], null as never, 'in_progress');
    expect(p.purpose).toContain('Nothing has been submitted yet');
    expect(p.steps.at(-1)!.title).toBe('Submit Testing for the gate');
  });

  it('a refused review: the marked-down arm, ending in "Submit again"', () => {
    const p = plan([task({ awaitingSignOff: false, lastSubmissionId: 'rev-2' })], {
      ...refusedRev,
      report: sample().details.p4.lastSubmission!.report,
    } as never);
    expect(p.steps[0].key).toBe('gate');
    expect(p.steps.at(-1)!.key).toBe('resubmit');
  });

  it('a split phase with a task waiting and a required sibling still open: the brief arm, as today', () => {
    const p = plan([task(), openQuiz()]);
    expect(p.steps.at(-1)!.title).toBe('Submit Testing for the gate');
    expect(p.steps.map((s) => s.key)).not.toContain('signoff');
  });

  it('a payload without tasks: as today', () => {
    const p = plan(undefined);
    expect(p.steps.map((s) => s.key)).not.toContain('signoff');
    expect(p.steps.at(-1)!.title).toBe('Submit Testing for the gate');
  });

  it('a submission in review while the task is flagged: the pending arm, as today', () => {
    const p = plan([task()], submission({ id: 'rev-2', status: 'queued' }));
    expect(p.steps.map((s) => s.key)).toEqual(['pending']);
  });

  it('after the countersignature (phase passed): the reflection arm, as today', () => {
    const p = plan([task({ status: 'passed', awaitingSignOff: false })], passedRev, 'passed');
    expect(p.steps[0].key).toBe('passed');
    expect(p.steps.map((s) => s.key)).not.toContain('signoff');
  });
});
