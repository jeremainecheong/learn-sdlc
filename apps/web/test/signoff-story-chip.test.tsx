// @vitest-environment jsdom
/**
 * The words a learner reads after a passing review on a task that needs the
 * teacher's countersignature.
 *
 * The task row stays `submitted` with `awaitingSignOff` (`taskRollup`), and the
 * next phase stays shut until the teacher countersigns. Meanwhile the story
 * chip must not read NEEDS REVISION, the Review view's Pass line must not say
 * "Continue to the next phase when ready." over a shut phase, and the sibling
 * chips must not say Needs revision either. After the countersignature
 * (`passed`) every surface says what it says for any passed task.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PhaseDetail, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { storyStatusLabel } from '@/components/workspace/requirements/RequirementsWorkspace';
import { passedLine } from '@/components/workspace/FeedbackPanel';
import { MatrixCard } from '@/components/workspace/panels/testing/MatrixDoc';
import {
  AWAITING_SIGN_OFF,
  SIGN_OFF_PASS_LINE,
  awaitingSignOff,
  changeRoomChip,
  latestFeedbackLine,
  phaseAwaitingSignOff,
} from '@/components/workspace/signoff-status';

// The plain Pass line does not say how to continue; the gate band does.
const TODAY_PASS = 'All required evidence accepted.';

const task = (over: Partial<PhaseTaskView> & { key: string }): PhaseTaskView =>
  ({
    order: 1, required: true, title: over.key, artefactType: 'user-story', evidence: 'signed-off', sealed: true,
    status: 'in_progress', awaitingSignOff: false, attempts: 0, bestScore: null, passedAt: null,
    lastSubmissionId: null, resetAt: null, solution: { available: false, files: 0, readAt: null },
    ...over,
  }) as PhaseTaskView;

/** The one task passed its review and waits on the countersignature. */
const AWAITING = () => task({ key: 'main', status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88 });
/** After the countersignature. */
const SIGNED = () => task({ key: 'main', status: 'passed', awaitingSignOff: false, attempts: 1, bestScore: 88, passedAt: '2026-10-02T05:00:00Z' });
const PASSED_REVIEW: Pick<SubmissionView, 'status' | 'passed'> = { status: 'completed', passed: true };

describe('the story chip (storyStatusLabel)', () => {
  it('a passing review on a sign-off task reads the owner\'s words', () => {
    expect(storyStatusLabel('submitted', PASSED_REVIEW, true)).toBe("Awaiting your teacher's sign-off");
    expect(storyStatusLabel('submitted', PASSED_REVIEW, true)).toBe(AWAITING_SIGN_OFF);
    expect(storyStatusLabel('submitted', PASSED_REVIEW, true)).not.toBe('Needs revision');
    // No revision held in the room (a reload): the task row alone says it.
    expect(storyStatusLabel('submitted', null, true)).toBe(AWAITING_SIGN_OFF);
  });

  // "Approved" became the state words' "Review passed".
  // "Review passed" only once the phase has passed (the fifth argument).
  it('after the countersignature the chip is today\'s Review passed', () => {
    expect(storyStatusLabel('passed', PASSED_REVIEW, false, false, true)).toBe('Review passed');
    expect(storyStatusLabel('passed', PASSED_REVIEW, undefined, undefined, true)).toBe('Review passed');
  });

  // Titled for what it holds (the passed row reads "Passed").
  it('every two-argument answer is the table below (a passed story reads "Passed" with no word that the phase has passed)', () => {
    const latests: Array<Pick<SubmissionView, 'status' | 'passed'> | null | undefined> = [
      undefined, null,
      { status: 'queued', passed: null }, { status: 'running', passed: null },
      { status: 'completed', passed: true }, { status: 'completed', passed: false }, { status: 'completed', passed: null },
      { status: 'failed', passed: null },
    ];
    const statuses: PhaseDetail['status'][] = ['locked', 'in_progress', 'submitted', 'passed'];
    const table = statuses.map((status) => latests.map((latest) => storyStatusLabel(status, latest)));
    expect(table).toEqual([
      ['Locked', 'Locked', 'Locked', 'Locked', 'Locked', 'Locked', 'Locked', 'Locked'],
      ['In progress', 'In progress', 'In review', 'In review', 'In progress', 'Needs revision', 'In progress', 'In progress'],
      ['Needs revision', 'Needs revision', 'In review', 'In review', 'Needs revision', 'Needs revision', 'Needs revision', 'Needs revision'],
      // With no word that the phase has passed, a passed story is the neutral "Passed".
      ['Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Passed'],
    ]);
    // An explicit false is the two-argument answer.
    expect(statuses.map((status) => latests.map((latest) => storyStatusLabel(status, latest, false)))).toEqual(table);
  });

  it('a review still marking reads In review, and a refused one Needs revision, whatever the flag', () => {
    expect(storyStatusLabel('submitted', { status: 'running', passed: null }, true)).toBe('In review');
    expect(storyStatusLabel('submitted', { status: 'completed', passed: false }, false)).toBe('Needs revision');
  });
});

describe('the Review view\'s Pass line (passedLine)', () => {
  it('on a one-task phase awaiting the countersignature it never says Continue', () => {
    const line = passedLine([AWAITING()], undefined);
    expect(line).not.toContain('Continue to the next phase');
    expect(line).toBe(SIGN_OFF_PASS_LINE);
    expect(line).toBe("Your work passed review. Your teacher's countersignature opens the next phase.");
    // The verdict names its task: the same answer.
    expect(passedLine([AWAITING()], 'main')).toBe(SIGN_OFF_PASS_LINE);
  });

  it('on a split phase the verdict\'s own task decides, and the open siblings are still named', () => {
    const tasks = [
      task({ key: 'story', order: 1, title: 'The story', status: 'submitted', awaitingSignOff: true }),
      task({ key: 'quiz', order: 2, title: 'Story concepts', status: 'in_progress' }),
    ];
    const line = passedLine(tasks, 'story');
    expect(line).not.toContain('Continue to the next phase');
    expect(line).toContain("your teacher's countersignature");
    expect(line).toContain('Story concepts');
    // A sibling's verdict on the same phase is not the awaiting task's, and
    // the waiting story is not "still open" (a waiting task named as open
    // invites a resubmit). The countersignature is what opens the phase.
    expect(passedLine(tasks, 'quiz')).toBe(SIGN_OFF_PASS_LINE);
  });

  it('after the countersignature the line is today\'s', () => {
    expect(passedLine([SIGNED()], undefined)).toBe(TODAY_PASS);
    expect(passedLine([SIGNED()], 'main')).toBe(TODAY_PASS);
  });

  it('every phase with no awaiting task reads as today', () => {
    expect(passedLine(undefined, undefined)).toBe(TODAY_PASS);
    expect(passedLine([], undefined)).toBe(TODAY_PASS);
    expect(passedLine([task({ key: 'main', status: 'submitted' })], undefined)).toBe(TODAY_PASS);
    const split = [task({ key: 'a', order: 1, title: 'A' }), task({ key: 'b', order: 2, title: 'B' }), task({ key: 'c', order: 3, title: 'C', required: false })];
    expect(passedLine(split, 'a')).toBe(
      "This task's evidence is accepted. One required task in this phase is still open: B. The next phase opens once it passes.",
    );
  });
});

describe('awaitingSignOff(detail, taskKey?)', () => {
  it('the one task, the named task, and never a guess on a split phase', () => {
    expect(awaitingSignOff({ tasks: [AWAITING()] })).toBe(true);
    expect(awaitingSignOff({ tasks: [AWAITING()] }, 'main')).toBe(true);
    expect(awaitingSignOff({ tasks: [SIGNED()] })).toBe(false);
    expect(awaitingSignOff({ tasks: [] })).toBe(false);
    expect(awaitingSignOff({})).toBe(false);
    expect(awaitingSignOff(null)).toBe(false);
    const split = [task({ key: 'a', status: 'submitted', awaitingSignOff: true }), task({ key: 'b', order: 2 })];
    expect(awaitingSignOff({ tasks: split })).toBe(false);
    expect(awaitingSignOff({ tasks: split }, 'a')).toBe(true);
    expect(awaitingSignOff({ tasks: split }, 'b')).toBe(false);
    // The flag alone, on a row that is not `submitted`, is not the waiting state.
    expect(awaitingSignOff({ tasks: [task({ key: 'main', status: 'passed', awaitingSignOff: true })] })).toBe(false);
  });
});

describe('sibling chips while the countersignature is pending', () => {
  const phaseDetail = (over: Record<string, unknown>) =>
    ({
      id: 'p-testing', key: 'testing', order: 4, title: 'Testing', status: 'submitted', attempts: 1, bestScore: 88,
      reflection: null, passedAt: null, opensAt: null, dueAt: null, rubric: { passThreshold: 70, criteria: [] },
      runClock: null, files: [], tasks: [AWAITING()], ...over,
    }) as unknown as PhaseDetail;

  it('the change room\'s chip', () => {
    expect(changeRoomChip(phaseDetail({ key: 'maintenance' }))).toEqual({ label: AWAITING_SIGN_OFF, tone: 'neutral' });
    // After the countersignature, and every other state: the usual words and tone.
    expect(changeRoomChip(phaseDetail({ status: 'passed', tasks: [SIGNED()] }))).toEqual({ label: 'Pass', tone: 'pass' });
    expect(changeRoomChip(phaseDetail({ tasks: [task({ key: 'main', status: 'submitted' })] }))).toEqual({ label: 'Needs revision', tone: 'accent' });
    expect(changeRoomChip(phaseDetail({ status: 'in_progress', attempts: 0, tasks: [] }))).toEqual({ label: 'Not submitted', tone: 'accent' });
  });

  const matrix = (detail: PhaseDetail) =>
    renderToStaticMarkup(<MatrixCard view={{ columns: [], rows: [], killed: 0, total: 0, unrun: false }} detail={detail} />);

  it('the testing matrix chip', () => {
    const html = matrix(phaseDetail({}));
    expect(html).toContain(AWAITING_SIGN_OFF.replace("'", '&#x27;'));
    expect(html).not.toContain('All required evidence must be met');
  });

  it('the testing matrix chip after the countersignature, and before any sign-off, is today\'s', () => {
    expect(matrix(phaseDetail({ status: 'passed', tasks: [SIGNED()] }))).toContain('>Pass<');
    expect(matrix(phaseDetail({ tasks: [task({ key: 'main', status: 'submitted' })] }))).toContain('All required evidence must be met');
  });

  it('the dashboard\'s latest-feedback line', () => {
    expect(latestFeedbackLine('Requirements', true, true)).toBe(
      "Requirements: your work passed review. Your teacher's countersignature opens the next phase.",
    );
    expect(latestFeedbackLine('Requirements', true, true)).not.toContain('choose your next revision');
    expect(latestFeedbackLine('Requirements', true, false)).not.toContain('choose your next revision');
    // A refused review keeps the usual words.
    expect(latestFeedbackLine('Requirements', false, false)).toBe('Requirements: open the original review and choose your next revision.');
  });
});

/*
 * Further waiting shapes.
 *
 * - The e2e journey's shape: a split Requirements phase whose story task AND a
 *   second task both passed and both wait. A sibling that passed and waits is
 *   not "still open": naming it as open invites a resubmit that costs a review
 *   and, if it fails, takes the learner out of the teacher's sign-off queue.
 * - The moment a verdict lands: the room holds the new passing revision before
 *   the reload brings the task's flag. A signed-off task (evidence
 *   'signed-off') that is not passed, with a newer passing revision than the
 *   one the list knows, is waiting.
 * - Phase-level chips on a split phase whose required tasks have all passed or
 *   wait on the countersignature.
 */
const REV = (over: Partial<SubmissionView> = {}): SubmissionView =>
  ({ id: 'rev-2', taskKey: 'main', status: 'completed', passed: true, score: 88, report: null, createdAt: '2026-10-02T05:00:00.000Z', ...over }) as SubmissionView;

describe('a sibling waiting on the countersignature is not open', () => {
  const both = () => [
    task({ key: 'story', order: 1, title: 'Your story', status: 'submitted', awaitingSignOff: true }),
    task({ key: 'countersign', order: 2, title: 'What the member asked for, in their words', artefactType: 'document', status: 'submitted', awaitingSignOff: true }),
  ];

  it('both marked tasks passed and wait: the sign-off line, no task named open', () => {
    const line = passedLine(both(), 'story');
    expect(line).toBe(SIGN_OFF_PASS_LINE);
    expect(line).not.toContain('still open');
    expect(passedLine(both(), 'countersign')).toBe(SIGN_OFF_PASS_LINE);
  });

  it('a task that passed outright beside a sibling that waits: the countersignature still opens the phase', () => {
    const tasks = [
      task({ key: 'quiz', order: 1, title: 'Story concepts', evidence: 'automated', status: 'passed' }),
      task({ key: 'story', order: 2, title: 'Your story', status: 'submitted', awaitingSignOff: true }),
    ];
    expect(passedLine(tasks, 'quiz')).toBe(SIGN_OFF_PASS_LINE);
    expect(passedLine(tasks, 'quiz')).not.toContain('Continue to the next phase');
  });

  it('an open sibling that has not passed its review is still named', () => {
    const tasks = [
      task({ key: 'story', order: 1, title: 'Your story', status: 'submitted', awaitingSignOff: true }),
      task({ key: 'countersign', order: 2, title: 'Heard', status: 'in_progress' }),
    ];
    expect(passedLine(tasks, 'story')).toBe(
      "This task passed review and waits for your teacher's countersignature. One required task in this phase is still open: Heard. The next phase opens once it passes and your teacher has countersigned.",
    );
  });

  it('after both countersignatures the line is today\'s', () => {
    const tasks = both().map((one) => ({ ...one, status: 'passed' as const, awaitingSignOff: false }));
    expect(passedLine(tasks, 'story')).toBe(TODAY_PASS);
  });
});

describe('the verdict lands before the list catches up', () => {
  const stale = (over: Partial<PhaseTaskView> = {}) =>
    task({ key: 'main', status: 'submitted', awaitingSignOff: false, attempts: 1, lastSubmissionId: 'rev-1', ...over });

  it('a newer passing revision of a signed-off task that is not passed waits', () => {
    expect(awaitingSignOff({ tasks: [stale()] }, 'main', REV())).toBe(true);
    expect(awaitingSignOff({ tasks: [stale()] }, undefined, REV({ taskKey: '' }))).toBe(true);
    expect(awaitingSignOff({ tasks: [stale({ status: 'in_progress', attempts: 0, lastSubmissionId: null })] }, 'main', REV())).toBe(true);
    expect(passedLine([stale()], 'main', REV())).toBe(SIGN_OFF_PASS_LINE);
    expect(storyStatusLabel('submitted', REV(), awaitingSignOff({ tasks: [stale()] }, 'main', REV()))).toBe(AWAITING_SIGN_OFF);
  });

  it('the list\'s own word wins once it knows the revision, and nothing else reads as waiting', () => {
    // The list has caught up with this revision: its flag is the answer.
    expect(awaitingSignOff({ tasks: [stale()] }, 'main', REV({ id: 'rev-1' }))).toBe(false);
    // Not a pass, not completed, another task's, not a signed-off task, already passed, or reset after it.
    expect(awaitingSignOff({ tasks: [stale()] }, 'main', REV({ passed: false }))).toBe(false);
    expect(awaitingSignOff({ tasks: [stale()] }, 'main', REV({ status: 'running', passed: null }))).toBe(false);
    expect(awaitingSignOff({ tasks: [stale()] }, 'main', REV({ taskKey: 'other' }))).toBe(false);
    expect(awaitingSignOff({ tasks: [stale({ evidence: 'reviewed' })] }, 'main', REV())).toBe(false);
    expect(awaitingSignOff({ tasks: [stale({ status: 'passed' })] }, 'main', REV())).toBe(false);
    expect(awaitingSignOff({ tasks: [stale({ resetAt: '2026-10-02T06:00:00.000Z' })] }, 'main', REV())).toBe(false);
    expect(awaitingSignOff({ tasks: [stale()] }, 'main', null)).toBe(false);
    expect(passedLine([stale()], 'main')).toBe(TODAY_PASS);
    expect(passedLine([stale({ evidence: 'reviewed' })], 'main', REV())).toBe(TODAY_PASS);
  });
});

describe('phase-level chips on a split phase', () => {
  const split = (second: Partial<PhaseTaskView>) => [
    task({ key: 'story', order: 1, title: 'Your story', status: 'submitted', awaitingSignOff: true }),
    task({ key: 'countersign', order: 2, title: 'Heard', ...second }),
  ];
  const detail = (tasks: PhaseTaskView[], over: Record<string, unknown> = {}) =>
    ({
      id: 'p-m', key: 'maintenance', order: 6, title: 'Maintenance', status: 'submitted', attempts: 2, bestScore: 88,
      reflection: null, passedAt: null, opensAt: null, dueAt: null, rubric: { passThreshold: 70, criteria: [] },
      runClock: null, files: [], tasks, lastSubmission: null, ...over,
    }) as unknown as PhaseDetail;

  it('every required task passed or waits, one waits: the phase waits', () => {
    expect(phaseAwaitingSignOff(detail(split({ status: 'passed', evidence: 'automated' })))).toBe(true);
    expect(phaseAwaitingSignOff(detail(split({ status: 'submitted', awaitingSignOff: true })))).toBe(true);
    // An optional task left open moves no gate.
    expect(phaseAwaitingSignOff(detail(split({ status: 'in_progress', required: false })))).toBe(true);
    expect(changeRoomChip(detail(split({ status: 'passed' })))).toEqual({ label: AWAITING_SIGN_OFF, tone: 'neutral' });
    const matrix = renderToStaticMarkup(<MatrixCard view={{ columns: [], rows: [], killed: 0, total: 0, unrun: false }} detail={detail(split({ status: 'passed' }), { key: 'testing' })} />);
    expect(matrix).toContain(AWAITING_SIGN_OFF.replace("'", '&#x27;'));
  });

  it('a required task still open, none waiting, or the phase passed: today\'s words', () => {
    expect(phaseAwaitingSignOff(detail(split({ status: 'in_progress' })))).toBe(false);
    expect(phaseAwaitingSignOff(detail(split({ status: 'submitted' })))).toBe(false);
    expect(changeRoomChip(detail(split({ status: 'in_progress' })))).toEqual({ label: 'Needs revision', tone: 'accent' });
    const none = [task({ key: 'a', status: 'passed' }), task({ key: 'b', order: 2, status: 'submitted' })];
    expect(phaseAwaitingSignOff(detail(none))).toBe(false);
    expect(phaseAwaitingSignOff(detail(split({ status: 'passed' }), { status: 'passed' }))).toBe(false);
    expect(phaseAwaitingSignOff(detail([]))).toBe(false);
    expect(phaseAwaitingSignOff(null)).toBe(false);
    // One task: exactly the one-task answer.
    expect(phaseAwaitingSignOff(detail([AWAITING()]))).toBe(true);
    expect(phaseAwaitingSignOff(detail([SIGNED()], { status: 'passed' }))).toBe(false);
  });
});
