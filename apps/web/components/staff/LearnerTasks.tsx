'use client';

/**
 * The tasks of one phase, for the teacher looking at one learner.
 *
 * A written phase can hold several tasks, each with its own verdict, its own
 * score and its own door, and the teacher has three levers over one of them:
 * `task-signoff`, `task-reopen` and `task-reset`
 * (`apps/api/src/instructor/instructor.service.ts`, the tail of
 * `overridePhase`). This panel draws them.
 *
 * Two rules decide everything here.
 *
 * **A phase whose compiled list is the synthesised sole task draws nothing.**
 * The server refuses all three levers on such a phase by name: *"This phase
 * has one task, so the phase's own levers are the levers: use Pass, Reopen or
 * Reset phase."*, so drawing them would be three dead controls. A phase
 * written before tasks existed carries no list at all and is the same case.
 * That refusal is `soleTaskList` and nothing wider: a phase holding one
 * *authored* task takes all three levers, and that is every phase of every
 * teacher-authored project nobody has split yet. `hasTaskLevers` below is the
 * server's predicate rather than a count, which is the distinction
 * `apps/api/src/content/task-units.ts` exists to keep.
 *
 * **Every question says what it does to the phase gate.** A reopen or a reset
 * of a *required* task writes the phase row back down (`patch = task.required
 * && held.status === 'passed' ? { status: 'in_progress', passedAt: null } :
 * {}`), so a passed phase's onward door shuts again and the learner cannot
 * advance until the task passes. An optional task moves no gate and no phase
 * score, and the question says that too rather than leaving a teacher to guess
 * which of the two they are about to do.
 *
 * **Quizzes.** A quiz is a task a learner can run out of: every allowed paper
 * handed in, none of them a pass, and no way to draw another. The route this
 * panel calls (`task-reset`) is the whole of the recovery, because it starts
 * a new attempt epoch. So a row whose learner is in that state says so, and
 * the reset question tells a quiz's truth rather than a written task's
 * (see {@link isCappedQuiz} for what this screen can and cannot tell apart).
 * That question also carries the one cost of a reset nobody else can weigh,
 * that a learner who has run out, or who passed, already holds the explanation
 * for every question on their last paper, and the next paper is drawn from the
 * same pool.
 *
 * On the portal's own `exp-` tokens, like `StuckList` and `NotesCard` beside
 * it, and with the in-page two-button question `NotesCard` asks before a note
 * goes: the answer follows the question in the tab order, so opening one
 * steals no focus. Answering one has to hand focus back, because the button
 * pressed is inside the block that then goes.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { InstructorPhaseView, InstructorTaskView } from '@learnsdlc/shared';
import { OVERRIDE_REASON_MIN, SOLE_TASK_KEY } from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { StatusSquare } from '@/components/ui';
import type { StatusState } from '@/lib/phase';
import { ReasonCount, whenShort } from '@/components/staff/primitives';

/** The three levers, in the order a teacher reaches for them. */
type TaskLever = 'task-signoff' | 'task-reopen' | 'task-reset';

const TASK_LEVERS: TaskLever[] = ['task-signoff', 'task-reopen', 'task-reset'];

/** What each lever is called on screen. */
const TASK_LEVER_WORD: Record<TaskLever, string> = {
  'task-signoff': 'Sign off',
  'task-reopen': 'Reopen',
  'task-reset': 'Reset',
};

/** What the button that goes through with it says, once the question is asked. */
const TASK_LEVER_DO: Record<TaskLever, string> = {
  'task-signoff': 'Sign it off',
  'task-reopen': 'Reopen it',
  'task-reset': 'Reset it',
};

/**
 * Is this a phase with tasks a teacher can act on?
 *
 * **The server's own predicate, not a length test.** `overridePhase` refuses
 * the three levers on `soleTaskList(tasks)` and on nothing else (*"This phase
 * has one task, so the phase's own levers are the levers"*) and
 * `soleTaskList` is `tasks.length === 1 && tasks[0].taskKey === SOLE_TASK_KEY`
 * (`apps/api/src/content/task-units.ts`). Its doc says in as many words why a
 * length test alone is wrong: every phase of every teacher-authored project
 * holds exactly one **authored** task, keyed `main`, and the route accepts all
 * three levers there. A length test would hide them on every such phase, which
 * is every phase of every project nobody has split.
 *
 * The two are told apart by the payload this screen already has:
 * `InstructorTaskView.key` is the row's own `taskKey`, `''` for the
 * synthesised sole task and the authored key otherwise.
 *
 * An empty list is the same silence. A synthesised sole task is given no
 * `task_states` row at all, so the view's list is `[]` rather than one row
 * keyed `''`; both shapes mean *this phase was never split* and neither draws
 * a control the server would refuse.
 */
function hasTaskLevers(tasks: InstructorTaskView[] | undefined): boolean {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  return !(tasks.length === 1 && tasks[0].key === SOLE_TASK_KEY);
}

/**
 * The word for where a task stands, in the console's state vocabulary: a
 * written task's reviewed pass is "Review passed"; a task the board
 * reads passed while the gate still wants its reviewed pass (the phase's
 * `evidenceNeeded`), or that a teacher signed off with no passing revision, is
 * "Credit awarded, review still needed", never drawn as a pass; a reviewed
 * pass waiting on this teacher's countersignature is "Awaiting your sign-off".
 * A quiz's pass is its marked paper, not a review, and stays "Passed".
 */
export function taskStatusWord(task: InstructorTaskView, phase?: Pick<InstructorPhaseView, 'evidenceNeeded'>): string {
  if (task.awaitingSignOff) return 'Awaiting your sign-off';
  // A marked quiz paper that did not pass leaves the row `submitted`, and
  // "In review" would say a paper is being marked when it has been, and failed:
  // on the row of a learner who may be out of papers. Only a paper still in
  // the queue is in review.
  const last = task.lastSubmission;
  const marked = last?.status === 'completed' || last?.status === 'failed';
  if (isCappedQuiz(task) && task.status === 'submitted' && marked) return 'Not passed';
  // The same holds for every task, not only a capped quiz: a revision that was
  // marked and did not pass leaves the row `submitted` too, and nobody is
  // reviewing it. A quiz with no limit says so as a quiz does; written work
  // says what the learner reads on it.
  if (task.status === 'submitted' && last?.status === 'completed' && last.passed === false) {
    return isQuizRevision(last) ? 'Not passed' : 'Needs revision';
  }
  // "In review" only while a revision is queued or
  // running. A `submitted` row has had a verdict without a pass, and one whose
  // newest revision failed to grade, or whose revision is not held, still
  // needs revision, which is what its learner reads on it.
  const marking = last?.status === 'queued' || last?.status === 'running';
  switch (task.status) {
    case 'passed': {
      if (isCappedQuiz(task) || (last && isQuizRevision(last))) return 'Passed';
      const waited = (phase?.evidenceNeeded ?? []).some((gap) => !gap.phaseId && gap.key === task.key);
      const reviewed = last?.status === 'completed' && last.passed === true;
      return waited || (task.signedOffAt && !reviewed) ? 'Credit awarded, review still needed' : 'Review passed';
    }
    case 'submitted':
      if (marking) return 'In review';
      return last && isQuizRevision(last) ? 'Not passed' : 'Needs revision';
    case 'locked':
      return 'Locked';
    default:
      return marking ? 'In review' : 'In progress';
  }
}

/** The row's mark, read from the word the row says, so the two cannot disagree. */
function taskMark(word: string): StatusState {
  if (word === 'Passed' || word === 'Review passed') return 'pass';
  if (word === 'Needs revision' || word === 'Not passed') return 'fail';
  if (word === 'In review') return 'warn';
  if (word === 'Locked') return 'todo';
  return 'now';
}

function attemptsWord(attempts: number): string {
  if (attempts === 0) return 'No attempt yet';
  return attempts === 1 ? '1 attempt' : `${attempts} attempts`;
}

/**
 * The task's best score, where it is one.
 *
 * A written task's `bestScore` before it passes is the score of the rules its
 * teacher wrote, which is not a verdict: the review can still say Needs
 * revision, and "Best 100" beside it would read as a pass. So a written task shows
 * a best only once it has passed. A quiz's is its best paper's mark, which is
 * the quiz's own measure, and is shown either way.
 */
function scoreWord(task: InstructorTaskView): string {
  if (task.bestScore === null) return 'Not scored yet';
  const quiz = isCappedQuiz(task) || Boolean(task.lastSubmission && isQuizRevision(task.lastSubmission));
  if (task.status !== 'passed' && !quiz) return 'No pass yet';
  return `Best ${Math.round(task.bestScore)}`;
}

/**
 * How far the required set has got, and how far everything has.
 *
 * Two numbers because only the required tasks gate: a phase reading "2 of 3
 * passed" while its gate is shut is the one sentence this screen must not
 * write.
 */
function taskCountsLine(tasks: InstructorTaskView[]): string {
  const required = tasks.filter((one) => one.required);
  const passedRequired = required.filter((one) => one.status === 'passed').length;
  const passed = tasks.filter((one) => one.status === 'passed').length;
  return `${passedRequired} of ${required.length} required passed, ${passed} of ${tasks.length} tasks passed`;
}

/**
 * What a reopen or a reset does to the gate, from where this task and this
 * phase actually stand. Both levers write the same patch, so both say this.
 */
function gateSentence(task: InstructorTaskView, phase: InstructorPhaseView, name: string): string {
  if (!task.required) return `${task.title} is optional, so no gate and no phase score move.`;
  if (phase.status === 'passed')
    return `${phase.title} is passed, so it goes back to in progress and ${name} cannot move on until ${task.title} passes again.`;
  // The phase is open (the learner is working in it); what waits is its Pass, and with it the way on.
  return `${task.title} is required, so ${phase.title} cannot pass until ${task.title} passes again.`;
}

/**
 * Is this row a quiz whose teacher set a limit on the papers?
 *
 * `quizAttemptsSpent` is served **only** on a task that is a quiz *and* whose
 * `attempts.max` is finite, and is absent entirely otherwise, so its presence
 * is the one thing this screen knows about a task's kind, and `false` on it
 * means *a capped quiz nobody is stuck on* rather than *not a quiz*.
 * `InstructorTaskView` carries no `artefactType`, so this is the whole of the
 * signal.
 *
 * **What that leaves blind, said out loud.** A quiz its teacher left uncapped
 * looks exactly like a written task here, so it takes the written task's
 * wording for a reset. That is the smaller wrong of the two available ones:
 * the sentence it gets is true about the record and the gate and only silent
 * about the paper, where guessing *quiz* from a missing field would put the
 * quiz wording on every written task in the product. Widening it needs
 * `artefactType` on the view, which is the API's to add and is recorded as
 * such rather than guessed at here.
 */
function isCappedQuiz(task: InstructorTaskView): boolean {
  return typeof task.quizAttemptsSpent === 'boolean';
}

/**
 * Whether a revision is a quiz paper's. `quizAttemptsSpent` names only a quiz
 * with a limit, so a quiz with none is told by its report, which carries the
 * marked paper under `quiz`.
 */
function isQuizRevision(revision: NonNullable<InstructorTaskView['lastSubmission']>): boolean {
  return Boolean((revision.report as { quiz?: unknown } | null | undefined)?.quiz);
}

/**
 * The sentence on a row whose learner has run out of papers.
 *
 * A required quiz with every paper handed in and no pass shuts the phase and
 * every phase behind it, and this panel's Reset is the only way back, so the
 * teacher has to be able to see it here rather than by opening the quiz. The
 * gate clause is the present tense of `gateSentence`: what *is* true now, not
 * what a lever would do, because a phase a teacher has already passed by hand
 * is not waiting on this quiz even though the learner still is.
 */
function quizSpentLine(
  task: InstructorTaskView,
  phase: InstructorPhaseView,
  name: string,
): string {
  // A phase that reads passed over a quiz the gate still
  // waits on (a Sign off wrote the quiz's row without a paper) is not "no
  // gate waiting". The phase's own `evidenceNeeded` names it when it is so.
  const waitedOn = (phase.evidenceNeeded ?? []).some((gap) => !gap.phaseId && gap.key === task.key);
  const gate = !task.required
    ? `${task.title} is optional, so no gate and no phase score move.`
    : waitedOn
      ? `${phase.title} reads passed, but the gate still waits on a passing paper of ${task.title}, so ${name} cannot move on until you reset it and they pass it.`
      : phase.status === 'passed'
        ? `${phase.title} is already passed, so no gate is waiting on this one.`
        : `${task.title} is required, so ${phase.title} cannot pass until ${task.title} passes.`;
  return (
    `${name} has handed in every paper on ${task.title} and has not passed it. They cannot draw ` +
    `another, so Reset is what gives them a fresh paper and a fresh set of attempts; the papers ` +
    `they have already handed in stay in the record. ${gate}`
  );
}

/** The one question each lever asks before it acts. */
function leverQuestion(
  lever: TaskLever,
  task: InstructorTaskView,
  phase: InstructorPhaseView,
  name: string,
): string {
  if (lever === 'task-signoff') {
    // A sign-off writes the board: the task, and the
    // phase once its required set is passed. It is the second half of a pass,
    // never the first, so the strict-evidence gate still wants a reviewed pass
    // of the task before the learner can advance. Only a task whose reviewed
    // pass is waiting on this countersignature (`awaitingSignOff`) has one; on
    // every other required task the sentence says the review is still owed,
    // rather than promising a phase that "opens" while Continue is refused.
    // On a waiting task the phase is already open: the countersignature passes
    // the task, and the phase passes once every required task has, which is
    // what the sentence says, on the project's last phase too.
    //
    // A capped quiz's "review" is a passing paper, and a
    // quiz with none left cannot get one until a Reset starts a new run, so a
    // sign-off there credits the board and opens nothing, and the question
    // says so before the lever is pulled rather than after.
    const gate = !task.required
      ? `${task.title} is optional, so no gate and no phase score move.`
      : task.awaitingSignOff
        ? phase.status === 'passed'
          ? `${phase.title} is already passed, so this records the countersignature on their reviewed pass and moves no gate.`
          : `Their reviewed pass is waiting on this countersignature, so ${phase.title} passes once every required task has passed.`
        : isCappedQuiz(task)
          ? task.quizAttemptsSpent
            ? `${name} has no papers left on ${task.title}, so a sign-off credits it on the board but cannot open ` +
              `${phase.title}: the gate needs a passing paper, and only Reset gives them another.`
            : `A sign-off credits ${task.title} on the board; it does not stand in for a passing paper, so ${name} ` +
              `moves on from ${phase.title} only once they pass a paper of it.`
          : // The condition, never an instruction the learner may not need: a
            // task reopened over a reviewed pass still holds that revision, and
            // the gate counts it once the row reads passed again. The lever's
            // `note` says afterwards whether a review is really still owed.
            `A sign-off credits ${task.title} on the board; it does not stand in for the review, so ${name} ` +
            `moves on from ${phase.title} only once ${task.title} has a reviewed pass of its own.`;
    return (
      `Sign off ${task.title} for ${name}? It passes without a verdict, at this task's pass mark ` +
      `or the best score they already have, whichever is higher. ${gate}`
    );
  }
  if (lever === 'task-reopen') {
    // A reopen withdraws the verdict and moves no attempt epoch, so a quiz's
    // papers stay spent. "They submit it again" is the written task's truth;
    // on a quiz with nothing left to draw it is an instruction the learner
    // cannot follow, and Reset is the lever that means it.
    if (isCappedQuiz(task)) {
      return (
        `Reopen ${task.title} for ${name}? Their pass on this quiz is withdrawn. The papers they ` +
        `have already handed in stay spent, so if they have none left, Reset is the lever that ` +
        `gives them another. ${gateSentence(task, phase, name)}`
      );
    }
    return (
      `Reopen ${task.title} for ${name}? Their pass on this task is withdrawn and they submit it ` +
      `again. ${gateSentence(task, phase, name)}`
    );
  }
  // A reset of a quiz is a different act from a reset of a written task, and
  // the written sentence is wrong about it twice: a quiz owns no files, and a
  // reset is exactly what hands its attempts back, it starts a new attempt
  // epoch, so the next paper is a fresh draw counted from one. What it does
  // not do is delete anything: every paper the learner sat stays for this
  // teacher's view and for the export.
  if (isCappedQuiz(task)) {
    // The cost only the teacher can weigh, and the one thing on this lever
    // that bears on grading integrity. `releaseExplanations`
    // (`feedback.service.ts`) opens the explanation for every question on a
    // paper once the learner is finished with it (their paper passed, or
    // their attempts are spent) and `quizAttemptsSpent` is the console's own
    // reading of the second. The fresh paper is drawn from the same sealed
    // pool with no memory of which questions those were, so on a pool a little
    // larger than `drawn` the overlap is most of the paper. Said only where
    // this page can see that it happened: a learner with papers left has been
    // shown nothing, and telling a teacher otherwise would be a worry they do
    // not owe. Why the release itself stays as it is is argued at
    // `releaseExplanations` and pinned in
    // `quiz-gates.spec.ts`.
    const shown =
      task.quizAttemptsSpent === true || task.status === 'passed'
        ? ` They have already been shown the explanation for every question on their last paper, ` +
          `and the fresh paper is drawn from the same pool, so it may ask some of them again.`
        : '';
    return (
      `Reset ${task.title} for ${name}? It starts the quiz over: a fresh paper, and a fresh set ` +
      `of attempts. Every paper they have already handed in stays in the record, and so does the ` +
      `reset. A passed quiz becomes not passed, and its best score goes.${shown} ` +
      `${gateSentence(task, phase, name)}`
    );
  }
  return (
    `Reset ${task.title} for ${name}? Its verdict, its score and its answer door go, and the reset ` +
    `is counted on the record. Their files stay, and so does the number of attempts they have had. ` +
    `${gateSentence(task, phase, name)}`
  );
}

/**
 * Why a lever is not offered on this task, or null when it is.
 *
 * Each sentence is the fact the route would answer with, said before the press
 * rather than after it, and each predicate is the route's own: `task-signoff`
 * conflicts on `row.status === 'passed'` and `task-reopen` on
 * `row.status === 'in_progress'`. A task in review can still be reopened, so
 * the test is that status and not "has not passed".
 *
 * A reset has one rule, and it is not said here: the route
 * refuses `task-reset` while a revision of the task is still queued or running,
 * because that verdict would land on the fresh start. Whether one is in flight
 * is a fact of the moment the lever is pulled, and the row this page holds may
 * be seconds old either way, a Reset turned off on it would stay off after the
 * verdict landed, with nothing on the page to turn it on again. So Reset stays
 * offered, and the route's own sentence is what the teacher reads, in the
 * question, with their reason kept for the press that goes through.
 */
/** How a finished lever is said, for the sentence a screen reader hears. */
const TASK_LEVER_DONE: Record<TaskLever, string> = {
  'task-signoff': 'Signed off',
  'task-reopen': 'Reopened',
  'task-reset': 'Reset',
};

/**
 * Where the phase stands afterwards, in the words its learner reads.
 *
 * A split phase reads `submitted` after ANY verdict that
 * leaves its gate shut, and the learner's tile says "In progress" there. So
 * this says "in review" only while the phase's newest revision is queued or
 * running (the one state it is true of) and "in progress" otherwise.
 */
export function phaseStatusWord(phase: Pick<InstructorPhaseView, 'status' | 'lastSubmission'>): string {
  const marking = phase.lastSubmission?.status === 'queued' || phase.lastSubmission?.status === 'running';
  switch (phase.status) {
    case 'passed':
      return 'passed';
    case 'locked':
      return 'locked';
    default:
      return marking ? 'in review' : 'in progress';
  }
}

function leverUnavailable(lever: TaskLever, task: InstructorTaskView): string | null {
  if (lever === 'task-signoff' && task.status === 'passed') return `${task.title} has already passed.`;
  if (lever === 'task-reopen' && task.status === 'in_progress')
    return `${task.title} is already open.`;
  return null;
}

export function LearnerTasks({
  userId,
  learnerName,
  phase,
  onPhase,
  onOpenSubmission,
}: {
  userId: string;
  /** What to call the learner in a question about their work. */
  learnerName: string;
  phase: InstructorPhaseView;
  /** The phase as the override left it, so the page around this redraws. */
  onPhase: (phase: InstructorPhaseView) => void;
  /** Open one revision in the evidence panel, where the page has one. */
  onOpenSubmission?: (submissionId: string) => void;
}) {
  const base = useId().replace(/[^\w-]/g, '');
  const [asking, setAsking] = useState<{ key: string; lever: TaskLever } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** What a finished lever left behind, for a reader who cannot see the rows change. */
  const [live, setLive] = useState('');
  /**
   * The lever's own sentence about what it could not do: the
   * override answers with a `note` when, say, a sign-off left the phase
   * reading passed while the gate still waits on a reviewed pass. It is drawn,
   * not only announced, because it is the thing the teacher has to act on.
   */
  const [note, setNote] = useState('');
  const section = useRef<HTMLElement>(null);
  /**
   * The controls to hand focus to once a finished lever has re-rendered, best
   * first.
   *
   * The button the teacher pressed lives inside the question block, and the
   * question block goes the moment the lever answers, so without a handover
   * the browser drops focus to `<body>` and a keyboard teacher tabs the page
   * from the top after every override. The row is still there, so focus goes
   * to a control on it that is still live; it is a list rather than one id
   * because the answer may well be what turned the obvious one off (a signed
   * off task refuses Sign off), and an effect because the row only takes its
   * new state on the render after the send. `ProjectEditor` keeps the same
   * `focusWanted` for the same reason.
   */
  const [focusWanted, setFocusWanted] = useState<string[]>([]);

  useEffect(() => {
    if (focusWanted.length === 0) return;
    const host = section.current;
    for (const id of focusWanted) {
      const control = host?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (control && !(control as HTMLButtonElement).disabled) {
        control.focus();
        break;
      }
    }
    setFocusWanted([]);
  }, [focusWanted]);

  if (!hasTaskLevers(phase.tasks)) return null;
  const tasks = [...(phase.tasks ?? [])].sort((a, b) => a.order - b.order);

  const ask = (task: InstructorTaskView, lever: TaskLever) => {
    setAsking({ key: task.key, lever });
    setReason('');
    setError('');
    setLive('');
    setNote('');
  };

  /**
   * Where focus goes once `lever` on `task` has answered: the lever just
   * pressed if the answer left it live, else the other two in the order a
   * teacher reaches for them, else the way into the task's newest revision,
   * else the section's own heading.
   */
  const focusAfter = (task: InstructorTaskView, lever: TaskLever): string[] => [
    `${lever}-${task.key}`,
    ...TASK_LEVERS.filter((one) => one !== lever).map((one) => `${one}-${task.key}`),
    `task-submission-${task.key}`,
    'learner-tasks-heading',
  ];

  const send = async (task: InstructorTaskView, lever: TaskLever) => {
    const trimmed = reason.trim();
    if (busy || trimmed.length < OVERRIDE_REASON_MIN) return;
    setBusy(true);
    setError('');
    try {
      const next = await instructorApi.override(userId, phase.id, lever, trimmed, task.key);
      onPhase(next);
      setAsking(null);
      setReason('');
      // The row's status word, the counts line and the phase around them all
      // change on this render, and none of it is announced by changing. The
      // sentence names the task and where the phase now stands, because the
      // second is the thing a lever was pulled to move, and then whatever the
      // lever says it could not do on its own.
      const said = next.note?.trim() ?? '';
      setNote(said);
      setLive(
        `${TASK_LEVER_DONE[lever]} ${task.title}. ${phase.title} now reads ${phaseStatusWord(next)}.` +
          (said ? ` ${said}` : ''),
      );
      setFocusWanted(focusAfter(task, lever));
    } catch (err) {
      // The typed reason is kept: the question stays open with it in place, so
      // a refused lever is one press from being tried again.
      setError(describeError(err, 'That did not go through. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      ref={section}
      className="exp-panel"
      data-testid="learner-tasks"
      aria-labelledby={`${base}-heading`}
    >
      <header className="exp-section-heading">
        <div>
          <span className="exp-eyebrow">Inside this phase</span>
          {/* The last place focus can land after a lever: still on this
              panel, and it names the phase the teacher is acting on. */}
          <h2 id={`${base}-heading`} tabIndex={-1} data-testid="learner-tasks-heading">
            Tasks in {phase.title}
          </h2>
          <p>
            Each task carries its own verdict, its own score and its own answer door. Only the
            required ones open the phase.
          </p>
        </div>
      </header>
      <p className="exp-caption" data-testid="learner-tasks-counts">
        {taskCountsLine(tasks)}
      </p>
      <p aria-live="polite" role="status" className="sr-only" data-testid="learner-tasks-live">
        {live}
      </p>
      {note && (
        <p className="exp-inline-note" data-testid="learner-tasks-note">
          {note}
        </p>
      )}
      <ul className="exp-list">
        {tasks.map((task) => {
          const open = asking?.key === task.key ? asking.lever : null;
          const slug = task.key || 'sole';
          const confirmId = `${base}-confirm-${slug}`;
          const whyId = (lever: TaskLever) => `${base}-why-${slug}-${lever}`;
          const reasons = TASK_LEVERS.map((lever) => [lever, leverUnavailable(lever, task)] as const)
            .filter((pair): pair is readonly [TaskLever, string] => pair[1] !== null);
          return (
            <li key={task.key} data-testid={`learner-task-${task.key}`}>
              <strong className="inline-flex items-center gap-2">
                <StatusSquare state={taskMark(taskStatusWord(task, phase))} size={11} />
                {task.title}
              </strong>
              <small>
                {task.required ? 'Required' : 'Optional'}, {taskStatusWord(task, phase)},{' '}
                {attemptsWord(task.attempts)}, {scoreWord(task)}
                {/* A sign-off is part of a pass, so it is
                    said only beside one, a Reset or a Reopen withdraws it. */}
                {task.signedOffAt && task.status === 'passed' ? `, signed off ${whenShort(task.signedOffAt)}` : ''}
                {/* In the row's own summary, so a list of rows can be scanned
                    for the one learner who is stuck. The sentence under it
                    says what to do about it. */}
                {task.quizAttemptsSpent ? ', out of papers' : ''}
              </small>
              {task.quizAttemptsSpent && (
                <p className="exp-caption" data-testid={`task-quiz-spent-${task.key}`}>
                  {quizSpentLine(task, phase, learnerName)}
                </p>
              )}
              <div className="exp-actions">
                <span className="flex flex-wrap items-center gap-2">
                  {task.lastSubmission && onOpenSubmission ? (
                    <button
                      type="button"
                      className="exp-button"
                      data-testid={`task-submission-${task.key}`}
                      aria-label={`Open the newest revision of ${task.title}`}
                      onClick={() => onOpenSubmission(task.lastSubmission!.id)}
                    >
                      Open the newest revision, {whenShort(task.lastSubmission.createdAt)}
                    </button>
                  ) : (
                    <span className="exp-caption">No revision to open yet.</span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {TASK_LEVERS.map((lever) => {
                    const off = leverUnavailable(lever, task);
                    return (
                      <button
                        key={lever}
                        type="button"
                        className="exp-button"
                        data-testid={`${lever}-${task.key}`}
                        disabled={Boolean(off) || busy}
                        title={off ?? undefined}
                        aria-label={`${TASK_LEVER_WORD[lever]} ${task.title}`}
                        aria-describedby={off ? whyId(lever) : undefined}
                        aria-expanded={open === lever}
                        aria-controls={open === lever ? confirmId : undefined}
                        onClick={() => ask(task, lever)}
                      >
                        {TASK_LEVER_WORD[lever]}
                      </button>
                    );
                  })}
                </span>
              </div>
              {reasons.length > 0 && (
                <p className="exp-caption">
                  {/* Why a lever is off, said on the page as well as on the
                      control: a tooltip is not a sentence a keyboard reaches. */}
                  {reasons.map(([lever, why]) => (
                    <span key={lever} id={whyId(lever)}>
                      {why}{' '}
                    </span>
                  ))}
                </p>
              )}
              {open && (
                <div
                  className="exp-inline-note mt-2"
                  // The question carries the consequential sentence (what the
                  // lever does to the gate) so it is read out when it opens,
                  // exactly as `NotesCard`'s own two-button question is.
                  role="status"
                  id={confirmId}
                  data-testid={`task-lever-confirm-${task.key}`}
                >
                  <div>
                    <span className="block">{leverQuestion(open, task, phase, learnerName)}</span>
                    <label className="exp-field mt-2">
                      Your reason, kept on the record of changes
                      <textarea
                        rows={3}
                        required
                        minLength={OVERRIDE_REASON_MIN}
                        value={reason}
                        disabled={busy}
                        data-testid={`task-lever-reason-${task.key}`}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="exp-caption">
                        At least {OVERRIDE_REASON_MIN} characters. It is recorded with your name.
                      </p>
                      <ReasonCount value={reason} min={OVERRIDE_REASON_MIN} />
                    </div>
                    {error && (
                      <p role="alert" className="exp-error" data-testid={`task-lever-error-${task.key}`}>
                        {error}
                      </p>
                    )}
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="exp-button exp-primary"
                        disabled={busy || reason.trim().length < OVERRIDE_REASON_MIN}
                        data-testid={`task-lever-do-${task.key}`}
                        onClick={() => void send(task, open)}
                      >
                        {busy ? 'Recording…' : TASK_LEVER_DO[open]}
                      </button>
                      <button
                        type="button"
                        className="exp-button"
                        disabled={busy}
                        data-testid={`task-lever-cancel-${task.key}`}
                        onClick={() => {
                          setAsking(null);
                          setReason('');
                          setError('');
                        }}
                      >
                        Leave it as it is
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* A declared limit of split phases, said where a teacher would otherwise look for a
          lever that does not exist: the workspace belongs to the phase. */}
      <p className="exp-caption">
        A reset clears one task&apos;s verdict, not the phase workspace. The files belong to the
        phase, so resetting them is the phase&apos;s own lever.
      </p>
    </section>
  );
}
