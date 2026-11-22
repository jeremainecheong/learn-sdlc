'use client';

/**
 * Writing a concept quiz, the one task a teacher adds or edits here.
 *
 * Every phase holds the work it came with: Requirements its story and Design
 * its design, each built in its own builder, and every other phase the work
 * its grader runs. So the add door opens on a quiz and nothing else, and the
 * sentence beside it is the one the API refuses any other body with
 * (`QUIZ_ONLY_ADD_REFUSAL`). An edit opens only a quiz too; a task of any
 * other kind is edited where it is built, and this form draws nothing for it.
 *
 * **It never asks for an artefact path.** A quiz writes no file, so there is
 * no path to mint and the readout says so.
 *
 * The key is checked here against `isAuthoredTaskKey` before the network is
 * asked, because the contract already told us the answer and a task key is the
 * one field a teacher cannot change afterwards: a learner's work follows the
 * task across versions by its key, so moving it would strand their work.
 *
 * The answer key is not in the draft payload, so an edit asks the audited
 * route for it before the answers can be changed (see `QuizEditor`).
 */
import { useState } from 'react';
import type { AddTaskBody, AuthoredQuiz, DraftTaskView, UpdateTaskBody } from '@learnsdlc/shared';
import { QUIZ_ONLY_ADD_REFUSAL, TASK_KEY_INVALID, isAuthoredTaskKey } from '@learnsdlc/shared';
import { Field } from '@/components/Field';
import { Button, Notice, Section } from '@/components/ui';
import {
  QuizEditor,
  blankQuiz,
  quizDraftOfKey,
  quizDraftOfView,
  quizRefusal,
  toAuthoredQuiz,
  type QuizDraft,
} from '@/components/staff/projects/QuizEditor';
import { describeError } from '@/lib/api';
import { PLAIN_TEXT_HINT } from './PlainTextHint';

/**
 * The one thing about a required quiz no compile rule can say.
 *
 * `phaseRollup` opens a phase when every key in `requiredKeysOf(tasks)` has
 * passed, and a required key with no `task_states` row is a failing key. So
 * marking a quiz required on a phase a cohort has already passed shuts that
 * phase again for them: correct behaviour for a new gate, and a surprise.
 * The compiler cannot see a cohort, and the validation report cannot either,
 * so this is the editor's sentence at the moment the teacher flips the switch
 * on a project that has published.
 */
export const QUIZ_REQUIRED_ON_PUBLISHED =
  'This project has already published. A required quiz gates the phase, and a learner who passed that phase before the quiz existed has no attempt behind it, so the phase shuts again for them until they take it. An optional quiz changes nothing for anybody.';

/** Why a quiz has no artefact path: it writes no file at all. */
export const QUIZ_WRITES_NO_FILE =
  'A quiz writes no file. It is answered in its own room and scored on its questions, so there is no path to mint and nothing for a rule to read.';

/* --------------------------- the sign-off mark --------------------------- */

/** The mark's label. */
export const SIGN_OFF_LABEL = 'Needs your sign-off';

/**
 * What the mark does, and only that. A passing verdict on a marked
 * task leaves it awaiting a countersignature (`taskRollup`), the class's queue
 * lists exactly those learners, and the phase rolls up only once it is signed,
 * so a required one holds the next phase shut. The mark is a draft's: a
 * published version never changes, and the export carries the task's mark. No
 * notice is sent to anyone and nothing expires, so neither is promised.
 */
export const SIGN_OFF_HELP =
  'A learner who passes a task marked “Needs your sign-off” waits in their class’s sign-off queue until you sign it off. Until then the task does not count as passed, so a required one keeps the next phase shut. A mark is saved as soon as you change it and reaches only the versions you publish from now on, because a published version never changes. An export of the version carries it.';

/**
 * Whether the mark is offered on this task at all.
 *
 * A quiz is scored by its key in its own room, and the queue is about work a
 * teacher countersigns, so a quiz row draws no mark rather than a dead one.
 */
export function takesSignOff(task: Pick<DraftTaskView, 'checkKind'>): boolean {
  return task.checkKind !== 'quiz';
}

/** The `id` of a task's sign-off checkbox, which the step row's Sign-off entry goes to. */
export function signOffBoxId(taskKey: string): string {
  return `task-signoff-${taskKey}`;
}

/** The ids of the help, and of the read-only reason where there is one. */
export function signOffHelpIds(helpId: string, readOnlyReason: string | null): string {
  return readOnlyReason === null ? helpId : `${helpId} ${helpId}-reason`;
}

/**
 * What every mark in a phase is described by, drawn once above its tasks
 * rather than once per row: the help, and on a version that cannot change,
 * the editor's own read-only reason.
 */
export function SignOffHelp({ id, readOnlyReason }: { id: string; readOnlyReason: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p id={id} className="m-0 text-[12.5px] leading-relaxed text-muted" data-testid={id}>
        {SIGN_OFF_HELP}
      </p>
      {readOnlyReason !== null && (
        <p id={`${id}-reason`} className="m-0 text-[12.5px] leading-relaxed text-muted" data-testid={`${id}-reason`}>
          {readOnlyReason}
        </p>
      )}
    </div>
  );
}

/**
 * The mark on one task, as a native checkbox, labelled on its row and
 * described by `SignOffHelp` (`describedBy`).
 *
 * It saves itself, alone: a change hands `onChange` the new value and nothing
 * else, and the caller sends `{ signOff }` with no other member. While the save
 * is out the box shows what was asked and stays focusable (a disabled control
 * would drop focus to the page); the draft the save answers with is what it
 * shows next. Where the version cannot change, it is drawn off, and the reason
 * is among what describes it.
 */
export function SignOffToggle({
  task,
  off,
  describedBy,
  busy,
  onChange,
}: {
  task: Pick<DraftTaskView, 'taskKey' | 'title' | 'signOff'>;
  /** True where the version cannot change. */
  off: boolean;
  /** The ids `signOffHelpIds` gives. */
  describedBy: string;
  busy: boolean;
  onChange: (signOff: boolean) => Promise<void> | void;
}) {
  const [asked, setAsked] = useState<boolean | null>(null);
  const id = signOffBoxId(task.taskKey);
  const checked = asked ?? task.signOff === true;

  const change = (next: boolean) => {
    if (off || busy || asked !== null) return;
    setAsked(next);
    void Promise.resolve(onChange(next)).finally(() => setAsked(null));
  };

  return (
    <span className="flex min-w-0 items-start gap-2.5" data-testid={`task-signoff-box-${task.taskKey}`}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={off}
        aria-describedby={describedBy}
        data-testid={id}
        onChange={(e) => change(e.target.checked)}
      />
      <label htmlFor={id} className="min-w-0 text-[13px] font-medium text-ink">
        {SIGN_OFF_LABEL}
      </label>
    </span>
  );
}


/** Whether a task is a quiz, the one kind this form opens. */
function isQuizTask(task: Pick<DraftTaskView, 'checkKind' | 'artefactType'>): boolean {
  return task.checkKind === 'quiz' || task.artefactType === 'quiz';
}

interface TaskEditorProps {
  /** The quiz being edited, or null when this is a new one. */
  task: DraftTaskView | null;
  busy: boolean;
  /** The API's refusal, read back word for word. */
  error: string;
  /**
   * Whether this project has ever published, which is the only way a cohort
   * can already have passed the phase a quiz is being added to.
   */
  published?: boolean;
  onAdd: (body: AddTaskBody) => void;
  onSave: (body: UpdateTaskBody) => void;
  onCancel: () => void;
  /**
   * Reads this quiz's key back through the audited `tasks.quizKey` route.
   *
   * A prop rather than a call, because the key is the one thing this form
   * cannot read off the draft it was handed, and the page that mounts the form
   * is the half that knows the project and the version. Absent, the answers
   * stay sealed and the quiz saves nothing, which is the honest shape, not a
   * degraded one.
   */
  onReadQuizKey?: () => Promise<AuthoredQuiz>;
  /**
   * Set on the add form: a new task here is a concept quiz, and the reason is
   * drawn beside the form.
   */
  quizOnly?: boolean;
  /** Why only a quiz is offered, where `quizOnly` is set: the door's own sentence. */
  quizOnlyReason?: string;
}

/**
 * The quiz door: a new quiz, or an existing one. A task of any other kind
 * draws nothing here, because it is edited where it is built.
 */
export function TaskEditor(props: TaskEditorProps) {
  if (props.task !== null && !isQuizTask(props.task)) return null;
  return <QuizTaskForm {...props} />;
}

function QuizTaskForm({
  task,
  busy,
  error,
  published = false,
  onAdd,
  onSave,
  onCancel,
  onReadQuizKey,
  quizOnly = true,
  quizOnlyReason = QUIZ_ONLY_ADD_REFUSAL,
}: TaskEditorProps) {
  const editing = task !== null;
  const [taskKey, setTaskKey] = useState(task?.taskKey ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [brief, setBrief] = useState(task?.brief ?? '');
  const [required, setRequired] = useState(task?.required ?? true);
  const [objectives, setObjectives] = useState((task?.objectives ?? []).join('\n'));
  const [own, setOwn] = useState('');
  /**
   * The quiz this form is writing.
   *
   * A task the draft handed back carries `AuthoredQuizView` (no key, no
   * explanations), so it opens sealed and only the audited route can open it.
   * A new one is the teacher's own words from the first keystroke, so it opens
   * keyed.
   */
  const [quiz, setQuiz] = useState<QuizDraft>(() =>
    task?.quiz ? quizDraftOfView(task.quiz) : blankQuiz(),
  );
  const [readingKey, setReadingKey] = useState(false);
  const [keyError, setKeyError] = useState('');

  /** Whether the save carries the quiz. A sealed one is not this form's to send. */
  const sendsQuiz = quiz.keyed;

  /** Ask the audited route for the key, and open the form on what it answers. */
  const showAnswers = () => {
    if (!onReadQuizKey || readingKey) return;
    setOwn('');
    setKeyError('');
    setReadingKey(true);
    void onReadQuizKey()
      // A key payload without the reveal rule keeps the one the view carried.
      .then((full) => setQuiz((held) => quizDraftOfKey(full, held.revealExplanation)))
      .catch((err: unknown) =>
        setKeyError(
          describeError(err, 'The answers could not be read. Try again in a moment.'),
        ),
      )
      .finally(() => setReadingKey(false));
  };

  const submit = () => {
    if (!editing && !isAuthoredTaskKey(taskKey.trim())) {
      setOwn(TASK_KEY_INVALID);
      return;
    }
    if (!title.trim()) {
      setOwn('Give the task a title. It is the line a learner reads first.');
      return;
    }
    if (!brief.trim()) {
      setOwn('Write the brief. It is the task panel a learner works from, in plain text.');
      return;
    }

    const lines = objectives
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // A quiz is scored by its key, so the artefact path is absent from the
    // body rather than empty in it.
    const wrong = sendsQuiz ? quizRefusal(quiz, required) : null;
    if (wrong) {
      setOwn(wrong);
      return;
    }
    setOwn('');
    const shared = {
      title: title.trim(),
      brief: brief.trim(),
      artefactType: 'quiz' as const,
      objectives: lines.length > 0 ? lines : undefined,
    };
    if (editing) {
      // A sealed quiz sends no `quiz` key at all, so the save leaves the
      // questions, the answers and the explanations exactly as they are.
      onSave(
        sendsQuiz
          ? { ...shared, quiz: toAuthoredQuiz(quiz, task?.taskKey ?? '', required) }
          : shared,
      );
    } else {
      onAdd({
        taskKey: taskKey.trim(),
        required,
        ...shared,
        quiz: toAuthoredQuiz(quiz, taskKey.trim(), required),
      });
    }
  };

  const shown = own || error;

  return (
    <Section
      title={editing ? `Edit ${task?.title}` : 'Add a concept quiz'}
      purpose="A quiz is a brief and the questions that score it. It writes no file, so it owns no path, and it sits beside the phase’s own work rather than instead of it."
      testId="task-form"
    >
      {shown && (
        <Notice tone="fail" role="alert" testId="task-form-error">
          {shown}
        </Notice>
      )}

      <div className="flex min-w-0 flex-col gap-3">
        {!editing && quizOnly && (
          <p className="m-0 text-[12.5px] leading-relaxed text-muted" data-testid="task-form-quiz-only">
            {quizOnlyReason}
          </p>
        )}
        <Field
          id="task-form-key"
          label="Task key"
          hint="Lower case, opening on a letter. A learner's work follows the task by its key, so it never changes."
          value={taskKey}
          disabled={editing}
          data-testid="task-form-key"
          onChange={(e) => {
            setOwn('');
            setTaskKey(e.target.value);
          }}
        />
        <Field
          id="task-form-title"
          label="Title"
          value={title}
          data-testid="task-form-title"
          onChange={(e) => {
            setOwn('');
            setTitle(e.target.value);
          }}
        />
        <div className="min-w-0">
          <label htmlFor="task-form-brief" className="block text-[13px] font-medium text-ink">
            Brief
          </label>
          <textarea
            id="task-form-brief"
            className="field mt-1.5 min-h-[120px]"
            data-testid="task-form-brief"
            value={brief}
            onChange={(e) => {
              setOwn('');
              setBrief(e.target.value);
            }}
          />
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{PLAIN_TEXT_HINT}</p>
        </div>

        <div className="min-w-0 rounded-ctl border-1.5 border-edge px-3 py-2.5">
          <span className="label-sm font-medium">Artefact path</span>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink" data-testid="task-form-no-path">
            {QUIZ_WRITES_NO_FILE}
          </p>
        </div>

        {!editing && (
          <label className="flex items-start gap-2.5" htmlFor="task-form-required">
            <input
              id="task-form-required"
              type="checkbox"
              className="mt-0.5"
              data-testid="task-form-required"
              checked={required}
              onChange={(e) => {
                setOwn('');
                setRequired(e.target.checked);
              }}
            />
            <span className="min-w-0 text-[13px] text-ink">
              Required. A required task gates the phase, and an optional one never does.
            </span>
          </label>
        )}

        {!editing && required && published && (
          <Notice tone="warn" role="status" testId="task-form-quiz-required-note">
            {QUIZ_REQUIRED_ON_PUBLISHED}
          </Notice>
        )}
      </div>

      <QuizEditor
        value={quiz}
        required={required}
        editing={editing}
        busy={busy}
        reading={readingKey}
        answersError={keyError}
        onChange={(next) => {
          setOwn('');
          setQuiz(next);
        }}
        onShowAnswers={onReadQuizKey ? showAnswers : undefined}
      />

      <details className="min-w-0">
        <summary className="cursor-pointer text-[13px] font-medium text-ink">Objectives</summary>
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          <div className="min-w-0">
            <label htmlFor="task-form-objectives" className="block text-[13px] font-medium text-ink">
              Objectives
            </label>
            <textarea
              id="task-form-objectives"
              className="field mt-1.5 min-h-[80px]"
              data-testid="task-form-objectives"
              value={objectives}
              onChange={(e) => setObjectives(e.target.value)}
            />
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">One per line.</p>
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button onClick={submit} busy={busy} busyLabel="Saving…" testId="task-form-submit">
          {editing ? 'Save the task' : 'Add the task'}
        </Button>
        <Button variant="ghost" onClick={onCancel} testId="task-form-cancel">
          Cancel
        </Button>
      </div>
    </Section>
  );
}
