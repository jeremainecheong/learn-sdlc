// @vitest-environment jsdom
/**
 * The teacher's per-task view: one task of a phase, and the three levers.
 *
 * The API offers `POST …/override` with
 * `action: 'task-signoff' | 'task-reopen' | 'task-reset'` and a `taskKey`
 * (`apps/api/src/instructor/instructor.service.ts`), and
 * `InstructorPhaseView.tasks: InstructorTaskView[]` carries each task's own
 * status, score, attempts and newest revision. This suite holds the panel
 * that calls and draws them.
 *
 * What is asserted here is what a teacher can act on:
 *
 *  - a phase with several tasks draws one row per task, with its own status,
 *    score, attempts and a way into its newest revision;
 *  - a phase whose task list is the synthesised sole one draws **nothing new**,
 *    because on such a phase the phase's own levers are the levers
 *    (`SOLE_TASK_LEVER_REFUSAL`) and a row of controls the server refuses is a
 *    dead control;
 *  - each lever asks one question first, and that question says what the lever
 *    does to the phase gate, including that a reopen or a reset of a required
 *    task shuts a passed phase's onward door again;
 *  - a reason travels with every one of them, because the route refuses a
 *    shorter one;
 *  - a refusal from the server is shown word for word.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstructorPhaseView, InstructorTaskView, SubmissionView } from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import { LearnerTasks } from '@/components/staff/LearnerTasks';

const calls = vi.hoisted(() => ({ override: vi.fn() }));
vi.mock('@/lib/api-instructor', () => ({ instructorApi: { override: calls.override } }));

/* ---------------------------- contract fixtures --------------------------- */

const revision = (over: Partial<SubmissionView> = {}): SubmissionView => ({
  id: 'revision-story-3',
  taskKey: 'story',
  status: 'completed',
  score: 82,
  passed: true,
  report: null,
  createdAt: '2026-09-18T09:00:00.000Z',
  attempt: 3,
  ...over,
});

const task = (over: Partial<InstructorTaskView> = {}): InstructorTaskView => ({
  key: 'story',
  order: 1,
  required: true,
  title: 'Write the user story',
  status: 'passed',
  bestScore: 82,
  attempts: 3,
  passedAt: '2026-09-18T09:00:00.000Z',
  awaitingSignOff: false,
  signedOffAt: null,
  lastSubmission: revision(),
  ...over,
});

const SCOPE = task({
  key: 'scope',
  order: 2,
  required: false,
  title: 'Name what is out of scope',
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  passedAt: null,
  lastSubmission: null,
});

/**
 * A quiz the teacher capped, with every paper of this run handed in and none
 * of them a pass.
 *
 * `quizAttemptsSpent` is the console's half of `QuizRoomView.needsInstructorReset`
 * and is present **only** on a task that is a quiz whose teacher set a finite
 * `attempts.max`: absent entirely otherwise, so `false` never appears on a
 * written task. That presence is the only signal this screen has for *is this
 * row a quiz*, which is why the fixture below carries `false` rather than
 * omitting it: a capped quiz nobody is stuck on is a different row from a
 * written task.
 */
const QUIZ = task({
  key: 'concepts',
  order: 4,
  required: true,
  title: 'Concept check',
  status: 'in_progress',
  bestScore: 40,
  attempts: 3,
  passedAt: null,
  lastSubmission: revision({ id: 'revision-concepts-3', taskKey: 'concepts', score: 40, passed: false }),
  quizAttemptsSpent: true,
});

const CRITERIA = task({
  key: 'criteria',
  order: 3,
  required: true,
  title: 'Write the acceptance criteria',
  status: 'in_progress',
  bestScore: 40,
  attempts: 1,
  passedAt: null,
  lastSubmission: revision({ id: 'revision-criteria-1', taskKey: 'criteria', score: 40, passed: false, attempt: 1 }),
});

const phase = (over: Partial<InstructorPhaseView> = {}): InstructorPhaseView => ({
  id: 'phase-state-one',
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  status: 'passed',
  bestScore: 82,
  attempts: 4,
  reflection: null,
  passedAt: '2026-09-18T09:05:00.000Z',
  opensAt: null,
  dueAt: null,
  hints: 2,
  relianceIndex: 0.1,
  passThreshold: 70,
  unlockedAt: '2026-09-10T09:00:00.000Z',
  lastSubmission: revision(),
  tasks: [task(), SCOPE, CRITERIA],
  ...over,
});

/** The phase every shipped project has: one synthesised task, keyed ''. */
const SOLE = phase({
  tasks: [task({ key: '', order: 1, title: 'Requirements', lastSubmission: revision({ taskKey: '' }) })],
});

/**
 * The phase every *teacher-authored* project has until somebody splits one:
 * exactly one **authored** task, keyed `INHERITED_TASK_KEY`.
 *
 * `soleTaskList` is false here (`tasks.length === 1` alone is the test the
 * product refuses to write (`apps/api/src/content/task-units.ts:26-52`)) so
 * the server accepts all three levers on this phase, and the panel has to
 * offer them.
 */
const UNSPLIT = phase({
  status: 'in_progress',
  passedAt: null,
  tasks: [
    task({
      key: 'main',
      order: 1,
      title: 'Requirements',
      status: 'in_progress',
      passedAt: null,
      lastSubmission: revision({ id: 'revision-main-1', taskKey: 'main', passed: false, attempt: 1 }),
    }),
  ],
});

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];
const kept: InstructorPhaseView[] = [];

const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const must = <T extends HTMLElement>(id: string) => {
  const found = q<T>(id);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};
const click = async (id: string) => act(async () => must<HTMLButtonElement>(id).click());
const typeReason = async (key: string, value: string) =>
  act(async () => {
    fireEvent.change(must<HTMLTextAreaElement>(`task-lever-reason-${key}`), { target: { value: value } });
  });

const render = async (view: InstructorPhaseView = phase()) =>
  act(async () =>
    root.render(
      <LearnerTasks
        userId="learner-a"
        learnerName="Ada"
        phase={view}
        onPhase={(next) => kept.push(next)}
        onOpenSubmission={(id) => opened.push(id)}
      />,
    ),
  );

/**
 * The panel with the answer put back where the teacher is looking, which is
 * what `TeacherPortal`'s `applyPhase` does: the phase-state id does not move,
 * so the panel is re-rendered rather than remounted and it keeps its state.
 */
function Live({ initial }: { initial: InstructorPhaseView }) {
  const [view, setView] = useState(initial);
  return (
    <LearnerTasks
      userId="learner-a"
      learnerName="Ada"
      phase={view}
      onPhase={(next) => {
        kept.push(next);
        setView((current) => ({ ...current, ...next }));
      }}
      onOpenSubmission={(id) => opened.push(id)}
    />
  );
}

const renderLive = async (view: InstructorPhaseView = phase()) =>
  act(async () => root.render(<Live initial={view} />));

beforeEach(() => {
  vi.clearAllMocks();
  opened.length = 0;
  kept.length = 0;
  calls.override.mockResolvedValue(phase({ status: 'in_progress', passedAt: null }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/* ---------------------------------- tests --------------------------------- */

describe('a phase whose task list is the synthesised sole one', () => {
  it('draws nothing at all, because the phase levers are the levers there', async () => {
    await render(SOLE);

    expect(q('learner-tasks')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('draws nothing for a phase written before tasks existed', async () => {
    await render(phase({ tasks: undefined }));

    expect(q('learner-tasks')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('draws nothing when the board holds no task row at all', async () => {
    // A synthesised sole task is given no `task_states` row, so the view's
    // list is empty rather than one row keyed ''. Both shapes mean the same
    // thing and both have to stay silent.
    await render(phase({ tasks: [] }));

    expect(q('learner-tasks')).toBeNull();
    expect(host.textContent).toBe('');
  });
});

describe('a phase holding one authored task, which is every unsplit teacher project', () => {
  it('draws the task and all three levers, because the route accepts them there', async () => {
    await render(UNSPLIT);

    expect(q('learner-tasks')).not.toBeNull();
    expect(must('learner-task-main').textContent).toContain('Requirements');
    for (const id of ['task-signoff-main', 'task-reopen-main', 'task-reset-main'])
      expect(must<HTMLButtonElement>(id).disabled).toBe(id === 'task-reopen-main');
  });

  it('counts the one required task, so the gate is readable there too', async () => {
    await render(UNSPLIT);

    expect(must('learner-tasks-counts').textContent).toBe(
      '0 of 1 required passed, 0 of 1 tasks passed',
    );
  });

  it('sends that task’s own key, never the synthesised empty one', async () => {
    await render(UNSPLIT);

    await click('task-signoff-main');
    await typeReason('main', 'Countersigned after reading it with them in class.');
    await click('task-lever-do-main');

    expect(calls.override).toHaveBeenCalledWith(
      'learner-a',
      'phase-state-one',
      'task-signoff',
      'Countersigned after reading it with them in class.',
      'main',
    );
  });
});

describe('the tasks of a phase, as the teacher reads them', () => {
  it('gives every task its own status, score and attempts', async () => {
    await render();

    const story = must(`learner-task-story`).textContent ?? '';
    expect(story).toContain('Write the user story');
    expect(story).toContain('Required');
    expect(story).toContain('Review passed');
    expect(story).toContain('3 attempts');
    expect(story).toContain('Best 82');

    const scope = must(`learner-task-scope`).textContent ?? '';
    expect(scope).toContain('Optional');
    expect(scope).toContain('In progress');
    expect(scope).toContain('No attempt yet');
    expect(scope).toContain('Not scored yet');
  });

  /**
   * After a Reset the row must not read "In progress, Not scored yet, signed
   * off 05:21 today". A sign-off is part of a pass, and a task that is not
   * passed carries none: the stamp is said only beside a pass.
   */
  it('says “signed off” only beside a pass', async () => {
    const at = '2026-09-29T05:21:00.000Z';
    await render(
      phase({
        tasks: [
          task({ signedOffAt: at }),
          task({
            key: 'criteria',
            order: 3,
            title: 'Write the acceptance criteria',
            status: 'in_progress',
            bestScore: null,
            passedAt: null,
            signedOffAt: at,
          }),
        ],
      }),
    );

    expect(must('learner-task-story').textContent).toContain('signed off');
    expect(must('learner-task-criteria').textContent).not.toContain('signed off');
  });

  it('says how many required tasks have passed, so the gate is readable', async () => {
    await render();

    expect(must('learner-tasks-counts').textContent).toBe('1 of 2 required passed, 1 of 3 tasks passed');
  });

  it('opens a task’s own newest revision, never the phase’s', async () => {
    await render();

    await click('task-submission-criteria');

    expect(opened).toEqual(['revision-criteria-1']);
  });

  it('says so rather than offering a link when a task has never been submitted', async () => {
    await render();

    expect(q('task-submission-scope')).toBeNull();
    expect(must('learner-task-scope').textContent).toContain('No revision to open yet');
  });
});

describe('the three levers, and the question each asks first', () => {
  it('says what a sign-off scores, and that it does not stand in for the review', async () => {
    // The task's newest revision needs revision, so there is no reviewed pass
    // for a countersignature to complete. The sign-off credits the board and
    // the strict-evidence gate still wants a reviewed pass, so the question
    // must not promise the phase will open, or Continue is refused.
    await render(phase({ status: 'in_progress', passedAt: null }));

    await click('task-signoff-criteria');

    const question = must('task-lever-confirm-criteria').textContent ?? '';
    expect(question).toContain('Sign off Write the acceptance criteria for Ada?');
    expect(question).toContain(
      "It passes without a verdict, at this task's pass mark or the best score they already have, whichever is higher.",
    );
    expect(question).toContain(
      'A sign-off credits Write the acceptance criteria on the board; it does not stand in for the review, so Ada moves on from Requirements only once Write the acceptance criteria has a reviewed pass of its own.',
    );
    // Never an instruction the learner may not need. A task reopened
    // over a reviewed pass still holds that revision, and the gate counts it
    // once the row reads passed again, so "still submits it" is not always
    // true; the condition is. The lever's `note` says, after the fact, when a
    // review really is still owed.
    expect(question).not.toContain('still submits it');
    expect(question).not.toContain('opens once every required task has passed');
  });

  it('says the same on a phase a Pass already opened on the board', async () => {
    await render();

    await click('task-signoff-criteria');

    const question = must('task-lever-confirm-criteria').textContent ?? '';
    expect(question).toContain('it does not stand in for the review');
    expect(question).not.toContain('opens once every required task has passed');
    expect(question).not.toContain('moves no gate');
  });

  it('completes a reviewed pass that is waiting on the countersignature', async () => {
    // `awaitingSignOff`: the learner's reviewed pass is in, and this is its
    // second half: the one case a sign-off does open the gate.
    const waiting = { ...CRITERIA, status: 'submitted' as const, awaitingSignOff: true };
    await render(phase({ status: 'in_progress', passedAt: null, tasks: [task(), SCOPE, waiting] }));

    await click('task-signoff-criteria');

    const question = must('task-lever-confirm-criteria').textContent ?? '';
    expect(question).toContain(
      'Their reviewed pass is waiting on this countersignature, so Requirements passes once every required task has passed.',
    );
    expect(question).not.toContain('does not stand in for the review');
  });

  it('does not promise a passed phase will open, which is where a countersignature is reached', async () => {
    // `overridePhase`'s phase-wide Pass writes `status: 'passed'` and leaves
    // every `signOff` task for a countersignature: it says so in
    // `countersignatureNote` (`instructor.service.ts`). So a teacher reaches
    // Sign off on a phase that is ALREADY open, so the question must not tell
    // them the phase would open once the task passed.
    const waiting = { ...CRITERIA, status: 'submitted' as const, awaitingSignOff: true };
    await render(phase({ tasks: [task(), SCOPE, waiting] }));

    await click('task-signoff-criteria');

    const question = must('task-lever-confirm-criteria').textContent ?? '';
    expect(question).toContain(
      'Requirements is already passed, so this records the countersignature on their reviewed pass and moves no gate.',
    );
    expect(question).not.toContain('opens once every required task has passed');
  });

  it('says a reopen of a required task shuts a passed phase again', async () => {
    await render();

    await click('task-reopen-story');

    const question = must('task-lever-confirm-story').textContent ?? '';
    expect(question).toContain('Reopen Write the user story for Ada?');
    expect(question).toContain(
      'Requirements is passed, so it goes back to in progress and Ada cannot move on until Write the user story passes again.',
    );
  });

  it('says a reset keeps the files and the attempts, and moves no gate on an optional task', async () => {
    await render();

    await click('task-reset-scope');

    const question = must('task-lever-confirm-scope').textContent ?? '';
    expect(question).toContain(
      'Its verdict, its score and its answer door go, and the reset is counted on the record.',
    );
    expect(question).toContain('Their files stay, and so does the number of attempts they have had.');
    expect(question).toContain('Name what is out of scope is optional, so no gate and no phase score move.');
  });

  it('offers no sign-off on a passed task and no reopen on an open one, and says why', async () => {
    await render();

    const story = must<HTMLButtonElement>('task-signoff-story');
    const criteria = must<HTMLButtonElement>('task-reopen-criteria');
    expect(story.disabled).toBe(true);
    expect(story.title).toBe('Write the user story has already passed.');
    expect(criteria.disabled).toBe(true);
    expect(criteria.title).toBe('Write the acceptance criteria is already open.');
    expect(must('learner-task-story').textContent).toContain('Write the user story has already passed.');
    // A tooltip is not a sentence a keyboard reaches, so the same words are on
    // the page and the control points at them.
    const described = host.querySelector(`#${story.getAttribute('aria-describedby')}`);
    expect(described?.textContent?.trim()).toBe('Write the user story has already passed.');
  });

  it('still offers a reopen on a task in review, which is what the route allows', async () => {
    // The route refuses `task-reopen` on `row.status === 'in_progress'` and on
    // nothing else, so a task waiting on a verdict can be taken back.
    //
    // A marked, failed revision is not a task in review: the row reads that
    // as Needs revision. A task in review is one whose newest revision is
    // still being marked, so that is what this row holds.
    await render(
      phase({
        tasks: [
          task(),
          SCOPE,
          task({
            ...CRITERIA,
            status: 'submitted',
            lastSubmission: revision({ id: 'revision-criteria-2', taskKey: 'criteria', status: 'running', score: null, passed: null, attempt: 2 }),
          }),
        ],
      }),
    );

    expect(must('learner-task-criteria').textContent).toContain('In review');
    expect(must<HTMLButtonElement>('task-reopen-criteria').disabled).toBe(false);
  });

  it('says Needs revision on a task whose marked revision did not pass, and still offers the reopen', async () => {
    // `nextPhaseStatus` leaves the row `submitted` after a failed verdict.
    await render(phase({ tasks: [task(), SCOPE, task({ ...CRITERIA, status: 'submitted' })] }));

    expect(must('learner-task-criteria').textContent).toContain('Needs revision');
    expect(must('learner-task-criteria').textContent).not.toContain('In review');
    expect(must<HTMLButtonElement>('task-reopen-criteria').disabled).toBe(false);
  });
});

/* ----------------------- the quiz nobody can get past --------------------- */

/**
 * The teacher's half of the one state a learner cannot leave on their own.
 *
 * A required quiz with every allowed paper handed in and no pass shuts the
 * phase and the project, and the **only** way back is this panel's per-task
 * Reset, which starts a new attempt epoch. So two things are owed here: the
 * teacher has to be able to *see* which learner is stuck without opening the
 * quiz, and the reset question has to say what a reset of a quiz actually
 * does, which is not what it does to a written task.
 */
describe('a quiz whose papers have all been handed in', () => {
  it('says on the row that the learner has run out, and what gives them another go', async () => {
    await render(phase({ status: 'in_progress', passedAt: null, tasks: [task(), SCOPE, QUIZ] }));

    const row = must('learner-task-concepts').textContent ?? '';
    // Visible in the row's own summary, so a list of rows is scannable.
    expect(row).toContain('out of papers');
    const note = must('task-quiz-spent-concepts').textContent ?? '';
    expect(note).toContain('Ada has handed in every paper on Concept check and has not passed it.');
    expect(note).toContain('Reset');
    expect(note).toContain('the papers they have already handed in stay in the record');
    // Required, so the consequence is the gate and the note says so.
    expect(note).toContain('Concept check is required, so Requirements cannot pass until Concept check passes.');
  });

  it('does not tell a teacher a passed phase is shut, which is where an override left it', async () => {
    // A phase-wide Pass writes the phase `passed` and leaves a required task
    // unpassed underneath it. The learner is still stuck on the quiz, and the
    // gate is still open, and both of those are true at once.
    await render(phase({ tasks: [task(), QUIZ] }));

    const note = must('task-quiz-spent-concepts').textContent ?? '';
    expect(note).toContain('Requirements is already passed, so no gate is waiting on this one.');
    expect(note).not.toContain('stays shut');
  });

  it('says nothing of the sort on a quiz that still has papers, or on a written task', async () => {
    await render(
      phase({
        tasks: [task(), SCOPE, task({ ...QUIZ, quizAttemptsSpent: false })],
      }),
    );

    expect(q('task-quiz-spent-concepts')).toBeNull();
    expect(must('learner-task-concepts').textContent).not.toContain('out of papers');
    // A written task carries the field at all, so there is nothing to draw and
    // nothing to guess: `false` on a written row would read as a quiz nobody
    // has finished.
    expect(q('task-quiz-spent-story')).toBeNull();
    expect(must('learner-task-story').textContent).not.toContain('out of papers');
  });

  /*
   * A Sign off on a required quiz with
   * no paper left credits the board and opens nothing: the gate wants a
   * passing paper, and the room cannot hand one out until a Reset. Both the
   * question before the lever and the row after it have to say that.
   */
  it('warns before a sign-off that a quiz with no papers left cannot open the gate, and names Reset', async () => {
    await render(phase({ status: 'in_progress', passedAt: null, tasks: [task(), SCOPE, QUIZ] }));

    await click('task-signoff-concepts');

    const question = must('task-lever-confirm-concepts').textContent ?? '';
    expect(question).toContain(
      'Ada has no papers left on Concept check, so a sign-off credits it on the board but cannot open Requirements: the gate needs a passing paper, and only Reset gives them another.',
    );
    expect(question).not.toContain('has a reviewed pass of its own');
  });

  it('says a sign-off on a quiz with papers left still waits on a passing paper', async () => {
    await render(
      phase({ status: 'in_progress', passedAt: null, tasks: [task(), SCOPE, task({ ...QUIZ, quizAttemptsSpent: false })] }),
    );

    await click('task-signoff-concepts');

    expect(must('task-lever-confirm-concepts').textContent).toContain(
      'A sign-off credits Concept check on the board; it does not stand in for a passing paper, so Ada moves on from Requirements only once they pass a paper of it.',
    );
  });

  it('says the gate is still waiting on a signed-off quiz with no paper left, and that Reset is the way out', async () => {
    const credited = task({ ...QUIZ, status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', signedOffAt: '2026-09-18T10:00:00.000Z' });
    await render(
      phase({
        tasks: [task(), credited],
        evidenceNeeded: [{ key: 'concepts', title: 'Concept check', noPapersLeft: true }],
      }),
    );

    const note = must('task-quiz-spent-concepts').textContent ?? '';
    expect(note).toContain(
      'Requirements reads passed, but the gate still waits on a passing paper of Concept check, so Ada cannot move on until you reset it and they pass it.',
    );
    expect(note).not.toContain('no gate is waiting');
  });

  it('says no gate is waiting on an optional quiz that has run out', async () => {
    await render(phase({ tasks: [task(), task({ ...QUIZ, required: false })] }));

    expect(must('task-quiz-spent-concepts').textContent).toContain(
      'Concept check is optional, so no gate and no phase score move.',
    );
  });

  it('says what a reset of a quiz really does, and not what it does to a written task', async () => {
    await render(phase({ status: 'in_progress', passedAt: null, tasks: [task(), SCOPE, QUIZ] }));

    await click('task-reset-concepts');

    const question = must('task-lever-confirm-concepts').textContent ?? '';
    expect(question).toContain('Reset Concept check for Ada?');
    // The three truths the API's own recovery turns on: a fresh draw, the
    // attempts back, and not one paper deleted.
    expect(question).toContain('It starts the quiz over: a fresh paper, and a fresh set of attempts.');
    expect(question).toContain('Every paper they have already handed in stays in the record');
    expect(question).toContain('A passed quiz becomes not passed, and its best score goes.');
    // The written task's sentence is a lie on a quiz twice over: a quiz has no
    // files, and its attempts do come back.
    expect(question).not.toContain('Their files stay, and so does the number of attempts they have had.');
    expect(question).toContain(
      'Concept check is required, so Requirements cannot pass until Concept check passes again.',
    );
  });

  /**
   * The one cost of a reset that only the teacher can weigh.
   *
   * `releaseExplanations` (`feedback.service.ts`) opens the explanation for
   * every question on a paper once the learner is finished with it (their
   * paper passed, or their attempts are spent) and a learner is only ever
   * sent to a teacher *from* the spent state, so by the time this lever is
   * pressed the explanations have already been handed over. The fresh paper is
   * then drawn from the same sealed pool with no memory of which questions
   * that was (`drawPaper` reads the slice and a seed and nothing else), so on
   * a pool only a little larger than `drawn` the overlap is most of the paper.
   *
   * The API documents and pins that decision where the rule lives; this is
   * the half that reaches the person who is choosing it.
   */
  it('tells the teacher what the learner already holds the answers to', async () => {
    await render(phase({ status: 'in_progress', passedAt: null, tasks: [task(), SCOPE, QUIZ] }));

    await click('task-reset-concepts');

    const question = must('task-lever-confirm-concepts').textContent ?? '';
    expect(question).toContain(
      'They have already been shown the explanation for every question on their last paper, and ' +
        'the fresh paper is drawn from the same pool, so it may ask some of them again.',
    );
  });

  it('says it of a passed quiz too, because passing opens the explanations as well', async () => {
    await render(
      phase({
        tasks: [
          task(),
          task({ ...QUIZ, status: 'passed', bestScore: 80, quizAttemptsSpent: false, passedAt: '2026-09-18T09:00:00.000Z' }),
        ],
      }),
    );

    await click('task-reset-concepts');

    expect(must('task-lever-confirm-concepts').textContent).toContain(
      'They have already been shown the explanation for every question on their last paper',
    );
  });

  it('says nothing of the kind while the learner still has papers to draw', async () => {
    // Nothing has been released yet: they have not passed and they are not out
    // of papers, so the sentence would be describing something that has not
    // happened.
    await render(
      phase({
        status: 'in_progress',
        passedAt: null,
        tasks: [task(), SCOPE, task({ ...QUIZ, quizAttemptsSpent: false })],
      }),
    );

    await click('task-reset-concepts');

    const question = must('task-lever-confirm-concepts').textContent ?? '';
    expect(question).toContain('It starts the quiz over: a fresh paper, and a fresh set of attempts.');
    expect(question).not.toContain('already been shown the explanation');
  });

  it('asks the written task’s own reset question', async () => {
    await render(phase({ tasks: [task(), SCOPE, QUIZ] }));

    await click('task-reset-scope');

    const question = must('task-lever-confirm-scope').textContent ?? '';
    expect(question).toContain('Their files stay, and so does the number of attempts they have had.');
    expect(question).not.toContain('a fresh set of attempts');
  });

  it('does not promise a reopened quiz another paper, because a reopen returns none', async () => {
    // `task-reopen` withdraws the verdict and moves no epoch, so the papers
    // stay spent. "They submit it again" is the written task's truth, and on a
    // quiz with nothing left to draw it is an instruction a learner cannot
    // follow.
    // A reopen is refused on an open row, so the quiz a teacher reaches it on
    // is a passed one.
    await render(
      phase({
        tasks: [
          task(),
          task({ ...QUIZ, status: 'passed', passedAt: '2026-09-19T09:00:00.000Z', quizAttemptsSpent: false }),
        ],
      }),
    );

    await click('task-reopen-concepts');

    const question = must('task-lever-confirm-concepts').textContent ?? '';
    expect(question).toContain('Their pass on this quiz is withdrawn.');
    expect(question).toContain(
      'The papers they have already handed in stay spent, so if they have none left, Reset is the lever that gives them another.',
    );
    expect(question).not.toContain('they submit it again');
  });
});

describe('sending a lever', () => {
  it('will not send until a reason long enough to be recorded is written', async () => {
    await render();

    await click('task-signoff-criteria');
    expect(must<HTMLButtonElement>('task-lever-do-criteria').disabled).toBe(true);

    await typeReason('criteria', 'too short');
    expect(must<HTMLButtonElement>('task-lever-do-criteria').disabled).toBe(true);

    await typeReason('criteria', 'Countersigned after reading it with them in class.');
    expect(must<HTMLButtonElement>('task-lever-do-criteria').disabled).toBe(false);
  });

  it('names the action, the reason and the task key the pinned version declares', async () => {
    await render();

    await click('task-signoff-criteria');
    await typeReason('criteria', 'Countersigned after reading it with them in class.');
    await click('task-lever-do-criteria');

    expect(calls.override).toHaveBeenCalledWith(
      'learner-a',
      'phase-state-one',
      'task-signoff',
      'Countersigned after reading it with them in class.',
      'criteria',
    );
  });

  it('hands the phase the override answered back, and closes the question', async () => {
    await render();

    await click('task-reopen-story');
    await typeReason('story', 'Reopened after we found the story was the wrong one.');
    await click('task-lever-do-story');

    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe('in_progress');
    expect(q('task-lever-confirm-story')).toBeNull();
  });

  it('keeps the question open and shows a refusal word for word', async () => {
    calls.override.mockRejectedValue(new ApiError(409, 'this task is already passed'));
    await render();

    await click('task-signoff-criteria');
    await typeReason('criteria', 'Countersigned after reading it with them in class.');
    await click('task-lever-do-criteria');

    expect(must('task-lever-error-criteria').textContent).toBe('this task is already passed');
    expect(must('task-lever-error-criteria').getAttribute('role')).toBe('alert');
    expect(q('task-lever-confirm-criteria')).not.toBeNull();
    expect(kept).toHaveLength(0);
  });

  it('shows a reset refused while a revision is being marked, keeps the reason, and lets the same press through later', async () => {
    // The route refuses `task-reset` while a revision of that task
    // is queued or running: `inFlightResetRefusal` in
    // `apps/api/src/instructor/instructor.service.ts`, whose words are copied
    // here as the server sends them. This page cannot know that is still true
    // when the button is pressed (the row it holds may be seconds old either
    // way), so Reset stays offered and the route's own sentence is what the
    // teacher reads, inside the question, with their reason kept for the retry.
    const sentence =
      'Write the acceptance criteria cannot be reset while a revision of it is still being marked; try again once its verdict is in.';
    const why = 'They asked to start the criteria over after class.';
    calls.override.mockRejectedValueOnce(new ApiError(409, sentence));
    const beingMarked = phase({
      tasks: [
        task(),
        SCOPE,
        {
          ...CRITERIA,
          lastSubmission: revision({
            id: 'revision-criteria-2',
            taskKey: 'criteria',
            status: 'running',
            score: null,
            passed: null,
            attempt: 2,
          }),
        },
      ],
    });
    await renderLive(beingMarked);

    expect(must<HTMLButtonElement>('task-reset-criteria').disabled).toBe(false);
    await click('task-reset-criteria');
    await typeReason('criteria', why);
    await click('task-lever-do-criteria');

    expect(must('task-lever-error-criteria').textContent).toBe(sentence);
    expect(must('task-lever-error-criteria').getAttribute('role')).toBe('alert');
    expect(must<HTMLTextAreaElement>('task-lever-reason-criteria').value).toBe(why);
    expect(must<HTMLButtonElement>('task-lever-do-criteria').disabled).toBe(false);
    expect(kept).toHaveLength(0);

    // The verdict lands; the same press, with the same reason, goes through.
    await click('task-lever-do-criteria');
    expect(calls.override).toHaveBeenCalledTimes(2);
    expect(calls.override).toHaveBeenLastCalledWith('learner-a', 'phase-state-one', 'task-reset', why, 'criteria');
    expect(kept).toHaveLength(1);
    expect(q('task-lever-confirm-criteria')).toBeNull();
    expect(q('task-lever-error-criteria')).toBeNull();
  });

  it('lets the teacher back out, and asks again the next time', async () => {
    await render();

    await click('task-reset-scope');
    await typeReason('scope', 'Cleared it so they can try the optional one again.');
    await click('task-lever-cancel-scope');
    expect(q('task-lever-confirm-scope')).toBeNull();
    expect(calls.override).not.toHaveBeenCalled();

    await click('task-reset-scope');
    expect(must<HTMLTextAreaElement>('task-lever-reason-scope').value).toBe('');
  });
});

describe('the keyboard', () => {
  it('asks its question under the button that opened it, and says the button is expanded', async () => {
    await render();

    const button = must<HTMLButtonElement>('task-reset-scope');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    await click('task-reset-scope');

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const confirm = must('task-lever-confirm-scope');
    expect(button.getAttribute('aria-controls')).toBe(confirm.id);
    // The answer follows the question in the tab order, so nothing has to
    // steal focus: every control is a real button in document order.
    expect(button.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const id of ['task-lever-do-scope', 'task-lever-cancel-scope'])
      expect(must(id).tagName).toBe('BUTTON');
    // The button that goes through with it says what it does, in English.
    expect(must('task-lever-do-scope').textContent).toBe('Reset it');
    expect(must('task-lever-cancel-scope').textContent).toBe('Leave it as it is');
  });

  it('hands focus back to a live control on the row a lever was pulled from', async () => {
    // The button pressed lives inside the question block, and the question
    // block goes the moment the lever answers. Without handing focus on, the browser
    // drops focus to <body> and a keyboard teacher tabs the page from the top
    // after every override.
    await render();

    await click('task-signoff-criteria');
    await typeReason('criteria', 'Countersigned after reading it with them in class.');
    await click('task-lever-do-criteria');

    expect(document.activeElement).toBe(must('task-signoff-criteria'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('steps past a lever the answer turned off, rather than focusing a dead button', async () => {
    calls.override.mockResolvedValue(
      phase({ tasks: [task(), SCOPE, task({ ...CRITERIA, status: 'passed', passedAt: '2026-09-19T00:00:00.000Z' })] }),
    );
    await renderLive();

    await click('task-signoff-criteria');
    await typeReason('criteria', 'Countersigned after reading it with them in class.');
    await click('task-lever-do-criteria');

    // Sign off is refused on a passed task, so focus goes to the next
    // lever on the same row that is still live.
    expect(must<HTMLButtonElement>('task-signoff-criteria').disabled).toBe(true);
    expect(document.activeElement).toBe(must('task-reopen-criteria'));
  });

  it('says what happened, once, where a screen reader hears it', async () => {
    await render();

    const announcer = must('learner-tasks-live');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toBe('');

    await click('task-signoff-criteria');
    await typeReason('criteria', 'Countersigned after reading it with them in class.');
    await click('task-lever-do-criteria');

    expect(must('learner-tasks-live').textContent).toBe(
      'Signed off Write the acceptance criteria. Requirements now reads in progress.',
    );
  });

  it('reads the question out when it opens, the way every other in-page question does', async () => {
    await render();

    await click('task-reset-scope');

    // `NotesCard`'s own two-button question is a polite live region, and this
    // question carries the consequential sentence: what the lever does to the
    // gate.
    expect(must('task-lever-confirm-scope').getAttribute('role')).toBe('status');
  });

  it('names the task on every control, so a list of three rows is not three identical buttons', async () => {
    await render();

    expect(must('task-reset-scope').getAttribute('aria-label')).toBe('Reset Name what is out of scope');
    expect(must('task-signoff-criteria').getAttribute('aria-label')).toBe(
      'Sign off Write the acceptance criteria',
    );
    expect(must('task-reopen-story').getAttribute('aria-label')).toBe('Reopen Write the user story');
  });
});
