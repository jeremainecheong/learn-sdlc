// @vitest-environment jsdom
/**
 * The teacher's quiz editor, and the four things it must not get wrong.
 *
 * **The key is never read off the draft payload.** `DraftTaskView.quiz` is
 * `AuthoredQuizView`: stems, options, settings and a *count* of the keyed
 * options, and neither `correct` nor `explanation`, because `readDraft` is
 * guarded by `requireVisibleProject` and that admits every instructor on the
 * deployment to a platform-owned project's draft. So a quiz opens **sealed**,
 * the answers arrive only from the audited `tasks.quizKey` route behind an
 * explicit action, and a save that has not been given them sends no `quiz` at
 * all rather than replacing every explanation with an empty string.
 *
 * **A quiz is the fifth kind of task, not a fifth form.** The branch is on
 * artefact type, beside the rules panel: a quiz draws no rules, no derived
 * criteria, no word floor and no artefact path, because it writes no file.
 *
 * **Five refusals are the editor's own**, spoken before the network, one per
 * row of the fast tier a save would fail. `quiz-pass-mark-reachable` is not
 * among them: it *warns*, and a warning is a note under the box.
 *
 * **And one sentence no compile rule can say.** Marking a quiz required on a
 * project that has published shuts that phase again for a cohort that already
 * passed it: `requiredKeysOf` gains a key with no `task_states` row, and a
 * required key with no row is a failing key. The compiler cannot see a cohort.
 * The editor can, so it says so at the moment the switch is flipped.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthoredQuiz,
  AuthoredQuizView,
  DraftTaskView,
  UpdateTaskBody,
} from '@learnsdlc/shared';
import { DEFAULT_QUIZ_CRITERION, DEFAULT_QUIZ_PASS_MARK } from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import {
  QUIZ_REQUIRED_ON_PUBLISHED,
  QUIZ_WRITES_NO_FILE,
  TaskEditor,
} from '@/components/staff/projects/TaskEditor';
import {
  QUIZ_ATTEMPTS_INVALID,
  QUIZ_NEEDS_A_QUESTION,
  QUIZ_PASS_MARK_INVALID,
  quizDrawRefusal,
  quizRetakeRefusal,
} from '@/components/staff/projects/QuizEditor';

/* ---------------------------- contract fixtures ---------------------------
 * Deliberately empty of teaching: the starter questions are a content task
 * with a reviewer, and a fixture that invented five plausible ones would be
 * unreviewed content wearing a reviewed one's clothes. These say what shape a
 * question is and nothing about what a learner should know.
 */

const VIEW: AuthoredQuizView = {
  questions: [
    {
      id: 'concepts-1',
      stem: 'The first question, as a fixture writes it.',
      options: [
        { id: 'a', text: 'The first option.' },
        { id: 'b', text: 'The second option.' },
        { id: 'c', text: 'The third option.' },
      ],
      answerCount: 1,
      concept: 'the shape of a question',
    },
    {
      id: 'concepts-2',
      stem: 'The second question, as a fixture writes it.',
      options: [
        { id: 'a', text: 'The first option.' },
        { id: 'b', text: 'The second option.' },
      ],
      answerCount: 1,
    },
  ],
  drawn: 1,
  shuffleOptions: true,
  passMark: 60,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
};

/** What the audited key route answers, and the only place `correct` exists. */
const KEY: AuthoredQuiz = {
  questions: [
    {
      id: 'concepts-1',
      stem: 'The first question, as a fixture writes it.',
      options: [
        { id: 'a', text: 'The first option.' },
        { id: 'b', text: 'The second option.' },
        { id: 'c', text: 'The third option.' },
      ],
      correct: ['b'],
      explanation: 'The explanation the fixture carries.',
      concept: 'the shape of a question',
    },
    {
      id: 'concepts-2',
      stem: 'The second question, as a fixture writes it.',
      options: [
        { id: 'a', text: 'The first option.' },
        { id: 'b', text: 'The second option.' },
      ],
      correct: ['a'],
      explanation: 'The second explanation the fixture carries.',
    },
  ],
  drawn: 1,
  shuffleOptions: true,
  passMark: 60,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
};

function quizTask(over: Partial<DraftTaskView> = {}): DraftTaskView {
  return {
    taskKey: 'concepts',
    order: 2,
    required: false,
    title: 'The concept check',
    brief: 'Answer the questions.',
    artefactType: 'quiz',
    artefactPath: null,
    checkKind: 'quiz',
    quiz: VIEW,
    rubric: {
      passThreshold: DEFAULT_QUIZ_PASS_MARK,
      criteria: [
        { key: 'concepts', title: 'Concepts', weight: 1, description: 'What this quiz scores.' },
      ],
    },
    objectives: [],
    owns: [],
    authorable: true,
    notice: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const onAdd = vi.fn();
const onSave = vi.fn();
const onCancel = vi.fn();
const readKey = vi.fn();

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  readKey.mockResolvedValue(KEY);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => host?.textContent ?? '';

async function mount(
  over: {
    task?: DraftTaskView | null;
    published?: boolean;
    withKeyRoute?: boolean;
  } = {},
) {
  await act(async () => {
    root?.render(
      <TaskEditor
        task={over.task ?? null}
        busy={false}
        error=""
        published={over.published ?? false}
        onAdd={onAdd}
        onSave={onSave}
        onCancel={onCancel}
        onReadQuizKey={over.withKeyRoute === false ? undefined : readKey}
      />,
    );
  });
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

/** One finished question, written into the form. */
async function writeQuestion(at: number, stem: string, answer: 0 | 1) {
  await act(async () => {
    type(byId(`quiz-question-stem-${at}`), stem);
    type(byId(`quiz-option-${at}-0`), 'The first option.');
    type(byId(`quiz-option-${at}-1`), 'The second option.');
    type(byId(`quiz-question-explanation-${at}`), 'Why that is the answer.');
  });
  await click(`quiz-option-correct-${at}-${answer}`);
}

/** A new quiz, filled in far enough to be saved. */
async function newQuiz({ questions = 1, required = true }: { questions?: number; required?: boolean } = {}) {
  await mount();
  await act(async () => {
    type(byId('task-form-key'), 'concepts');
    type(byId('task-form-title'), 'The concept check');
    type(byId('task-form-brief'), 'Answer the questions.');
  });
  if (!required) await click('task-form-required');
  for (let at = 0; at < questions; at += 1) {
    if (at > 0) await click('quiz-question-add');
    await writeQuestion(at, `Question ${at + 1}, as a fixture writes it.`, 0);
  }
}

describe('the teacher’s quiz editor', () => {
  it('opens on a quiz, and draws no rules, no criteria and no path', async () => {
    await mount();
    expect(byId('task-form-type')).toBeNull();
    expect(byId('quiz-editor')).not.toBeNull();
    expect(byId('task-rule-0')).toBeNull();
    expect(byId('task-rule-add')).toBeNull();
    expect(byId('task-rubric')).toBeNull();
    expect(byId('task-form-min-words')).toBeNull();
    // A quiz writes no workspace file at all, which is `quiz-owns-no-file`.
    expect(byId('task-form-path')).toBeNull();
    expect(byId('task-form-no-path')?.textContent).toBe(QUIZ_WRITES_NO_FILE);
  });

  it('adds a quiz through the contract body: the key travels, the rules do not', async () => {
    await newQuiz({ questions: 2 });
    await act(async () => {
      type(byId('quiz-drawn'), '1');
    });
    await click('task-form-submit');

    expect(onAdd).toHaveBeenCalledTimes(1);
    const body = onAdd.mock.calls[0][0];
    expect(body).toEqual({
      taskKey: 'concepts',
      required: true,
      title: 'The concept check',
      brief: 'Answer the questions.',
      artefactType: 'quiz',
      objectives: undefined,
      quiz: {
        questions: [
          {
            id: 'concepts-1',
            stem: 'Question 1, as a fixture writes it.',
            options: [
              { id: 'a', text: 'The first option.' },
              { id: 'b', text: 'The second option.' },
            ],
            correct: ['a'],
            explanation: 'Why that is the answer.',
          },
          {
            id: 'concepts-2',
            stem: 'Question 2, as a fixture writes it.',
            options: [
              { id: 'a', text: 'The first option.' },
              { id: 'b', text: 'The second option.' },
            ],
            correct: ['a'],
            explanation: 'Why that is the answer.',
          },
        ],
        drawn: 1,
        shuffleOptions: true,
        passMark: DEFAULT_QUIZ_PASS_MARK,
        attempts: { max: 3, cooldownSeconds: null },
        criterion: 'concepts',
      },
    });
    // `AddTaskBody` takes rules **or** a quiz, and the route branches on which
    // before it mints anything, so an empty rules array would be the editor
    // asking for a file the task does not write.
    expect('rules' in body).toBe(false);
    expect('minWords' in body).toBe(false);
  });

  it('defaults the attempts to the gate: finite when it gates, open when it does not', async () => {
    await newQuiz({ questions: 1, required: false });
    expect((byId('quiz-attempts') as HTMLInputElement).value).toBe('');
    await click('task-form-submit');
    expect(onAdd.mock.calls[0][0].quiz.attempts).toEqual({ max: null, cooldownSeconds: null });
  });

  it('pre-fills and falls back to the criterion the contract declares', async () => {
    await newQuiz({ questions: 1, required: false });
    // The key the box shows untouched and the key the route writes when a quiz
    // names none are one string, in `@learnsdlc/shared`. A second copy of the
    // word here is how an editor comes to pre-fill one default and the route to
    // write another, so this holds the editor to the contract's, not to
    // `'concepts'`: the literal is pinned on the wire body above.
    expect((byId('quiz-criterion') as HTMLInputElement).value).toBe(DEFAULT_QUIZ_CRITERION);
    expect(byId('quiz-rubric-note')?.textContent).toContain(`“${DEFAULT_QUIZ_CRITERION}”`);

    // Emptied, the note and the save fall back to the same one rather than to a
    // blank key or to a word this file keeps for itself.
    await act(async () => {
      type(byId('quiz-criterion'), '   ');
    });
    expect(byId('quiz-rubric-note')?.textContent).toContain(`“${DEFAULT_QUIZ_CRITERION}”`);

    await click('task-form-submit');
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].quiz.criterion).toBe(DEFAULT_QUIZ_CRITERION);
  });

  it('adds, reorders and removes a question, and says so in a polite region', async () => {
    await newQuiz({ questions: 1, required: false });
    await click('quiz-question-add');
    await writeQuestion(1, 'Question 2, as a fixture writes it.', 1);
    expect(host?.querySelectorAll('[data-testid^="quiz-question-stem-"]')).toHaveLength(2);

    await click('quiz-question-down-0');
    expect((byId('quiz-question-stem-0') as HTMLTextAreaElement).value).toBe(
      'Question 2, as a fixture writes it.',
    );
    const live = byId('quiz-live');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toContain('moved down');

    await click('quiz-question-remove-1');
    expect(host?.querySelectorAll('[data-testid^="quiz-question-stem-"]')).toHaveLength(1);
    expect((byId('quiz-question-stem-0') as HTMLTextAreaElement).value).toBe(
      'Question 2, as a fixture writes it.',
    );
  });

  it('adds and removes an option, and keys the answer with a native checkbox', async () => {
    await newQuiz({ questions: 1, required: false });
    await click('quiz-option-add-0');
    await act(async () => {
      type(byId('quiz-option-0-2'), 'The third option.');
    });

    const keyed = byId('quiz-option-correct-0-2') as HTMLInputElement;
    expect(keyed.tagName).toBe('INPUT');
    expect(keyed.type).toBe('checkbox');
    // Every question is a fieldset with its own legend, so a screen reader
    // announces the question with each option rather than three loose boxes.
    const group = byId('quiz-question-0');
    expect(group?.tagName).toBe('FIELDSET');
    expect(group?.querySelector('legend')?.textContent).toContain('Question 1');
    expect(host?.querySelector('[role="radio"]')).toBeNull();

    await click('quiz-option-correct-0-2');
    // The answer moves from the first option to the third, and the second goes.
    await click('quiz-option-correct-0-0');
    await click('quiz-option-remove-0-1');
    await click('task-form-submit');

    const question = onAdd.mock.calls[0][0].quiz.questions[0];
    expect(question.options.map((one: { id: string }) => one.id)).toEqual(['a', 'c']);
    expect(question.correct).toEqual(['c']);
  });

  it('opens a quiz it was handed sealed: counts, no answers, and a save that changes nothing', async () => {
    await mount({ task: quizTask() });

    expect(byId('quiz-answers-sealed')).not.toBeNull();
    expect(byId('quiz-answer-count-0')?.textContent).toBe(
      '1 of these 3 options is the answer.',
    );
    // Nothing on the screen is the key, and nothing on it is editable either:
    // a box that saved nothing would be a control that lies.
    expect(byId('quiz-question-stem-0')).toBeNull();
    expect(byId('quiz-option-correct-0-0')).toBeNull();
    expect(byId('quiz-question-explanation-0')).toBeNull();
    expect(text()).not.toContain('The explanation the fixture carries.');

    await act(async () => {
      type(byId('task-form-title'), 'The concept check, renamed');
    });
    await click('task-form-submit');

    expect(readKey).not.toHaveBeenCalled();
    const body = onSave.mock.calls[0][0] as UpdateTaskBody;
    expect(body.title).toBe('The concept check, renamed');
    expect('quiz' in body).toBe(false);
  });

  it('reads the answers back from the audited route, behind an explicit action', async () => {
    await mount({ task: quizTask() });
    await click('quiz-answers-show');

    expect(readKey).toHaveBeenCalledTimes(1);
    expect(byId('quiz-answers-open')).not.toBeNull();
    expect((byId('quiz-question-explanation-0') as HTMLTextAreaElement).value).toBe(
      'The explanation the fixture carries.',
    );
    expect((byId('quiz-option-correct-0-0') as HTMLInputElement).checked).toBe(false);
    expect((byId('quiz-option-correct-0-1') as HTMLInputElement).checked).toBe(true);

    await act(async () => {
      type(byId('quiz-option-0-1'), 'The second option, reworded.');
    });
    await click('task-form-submit');

    const body = onSave.mock.calls[0][0] as UpdateTaskBody;
    expect(body.quiz?.questions[0].correct).toEqual(['b']);
    expect(body.quiz?.questions[0].options[1].text).toBe('The second option, reworded.');
    expect(body.quiz?.questions[0].explanation).toBe('The explanation the fixture carries.');
    // The ids a learner's answers are recorded against are kept, never re-minted.
    expect(body.quiz?.questions.map((one) => one.id)).toEqual(['concepts-1', 'concepts-2']);
  });

  it('reads a refusal at that route back word for word, and stays sealed', async () => {
    const refusal = 'This project is not yours, so its answer key is not yours to read.';
    readKey.mockRejectedValue(new ApiError(403, refusal));
    await mount({ task: quizTask() });
    await click('quiz-answers-show');

    expect(byId('quiz-answers-error')?.textContent).toBe(refusal);
    expect(byId('quiz-answers-sealed')).not.toBeNull();
    expect(byId('quiz-question-explanation-0')).toBeNull();
  });

  it('draws no answer panel at all where there is no route to ask', async () => {
    await mount({ task: quizTask(), withKeyRoute: false });
    expect(byId('quiz-answers-sealed')).not.toBeNull();
    expect(byId('quiz-answers-show')).toBeNull();
  });

  it('offers no type swap an edit cannot make', async () => {
    // A quiz stays a quiz, so an edit draws no type to pick at all.
    await mount({ task: quizTask() });
    expect(byId('task-form-type')).toBeNull();
    expect(byId('quiz-editor')).not.toBeNull();
  });

  it('draws nothing for an edit of a task that is not a quiz', async () => {
    // The editor opens only the quiz door: a story is edited in its builder.
    const story = quizTask({
      taskKey: 'story',
      artefactType: 'user-story',
      artefactPath: null,
      checkKind: 'story',
      quiz: undefined,
    });
    await mount({ task: story });
    expect(byId('task-form')).toBeNull();
    expect(byId('quiz-editor')).toBeNull();
  });

  it('refuses a quiz with no questions, in its own words', async () => {
    await newQuiz({ questions: 1, required: false });
    await click('quiz-question-remove-0');
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toBe(QUIZ_NEEDS_A_QUESTION);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('refuses a question that could not be answered, one sentence at a time', async () => {
    await newQuiz({ questions: 1, required: false });

    await act(async () => {
      type(byId('quiz-question-stem-0'), '  ');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toContain('Question 1 has no text');

    await act(async () => {
      type(byId('quiz-question-stem-0'), 'Question 1, as a fixture writes it.');
      type(byId('quiz-question-explanation-0'), '');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toContain('Question 1 has no explanation');

    await act(async () => {
      type(byId('quiz-question-explanation-0'), 'Why that is the answer.');
      type(byId('quiz-option-0-1'), '');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toContain('an option with nothing written on it');

    await act(async () => {
      type(byId('quiz-option-0-1'), 'The second option.');
    });
    await click('quiz-option-correct-0-0');
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toContain('marks no option as an answer');

    await click('quiz-option-correct-0-0');
    await click('quiz-option-correct-0-1');
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toContain('marks every option as an answer');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('refuses a paper the pool cannot fill', async () => {
    await newQuiz({ questions: 1, required: false });
    await act(async () => {
      type(byId('quiz-drawn'), '4');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toBe(quizDrawRefusal('4', 1));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('refuses a pass mark and an attempt count that are not numbers', async () => {
    await newQuiz({ questions: 1, required: false });
    await act(async () => {
      type(byId('quiz-pass-mark'), 'most of it');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toBe(QUIZ_PASS_MARK_INVALID);

    await act(async () => {
      type(byId('quiz-pass-mark'), '60');
      type(byId('quiz-attempts'), 'twice');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toBe(QUIZ_ATTEMPTS_INVALID);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('refuses a required quiz that is the same paper every time, or can be re-sat for ever', async () => {
    await newQuiz({ questions: 2 });
    await click('task-form-submit');
    // Two questions, no draw: the whole pool every time.
    expect(byId('task-form-error')?.textContent).toBe(quizRetakeRefusal(2, false));

    await act(async () => {
      type(byId('quiz-drawn'), '1');
      type(byId('quiz-attempts'), '');
    });
    await click('task-form-submit');
    expect(byId('task-form-error')?.textContent).toBe(quizRetakeRefusal(2, true));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('warns about a pass mark no paper can land on, and lets it through anyway', async () => {
    await newQuiz({ questions: 1, required: false });
    await act(async () => {
      type(byId('quiz-pass-mark'), '70');
    });
    expect(byId('quiz-pass-mark-note')?.textContent).toContain('70% is 100% under another name');

    await click('task-form-submit');
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].quiz.passMark).toBe(70);
  });

  it('says what a required quiz does to a cohort that has already passed the phase', async () => {
    await mount({ published: true });
    expect(byId('task-form-quiz-required-note')?.textContent).toBe(QUIZ_REQUIRED_ON_PUBLISHED);

    await click('task-form-required');
    expect(byId('task-form-quiz-required-note')).toBeNull();
  });

  it('says nothing about a cohort on a project that has never published', async () => {
    await mount({ published: false });
    expect(byId('task-form-required')).not.toBeNull();
    expect(byId('task-form-quiz-required-note')).toBeNull();
  });
});
