// @vitest-environment jsdom
/**
 * The practice-quiz reveal, from the teacher's side.
 *
 * `QuizChecks.revealExplanation` is an **optional** quiz's choice of when its
 * explanations are released: `'on-pass'` (after a pass, or when the attempts
 * run out) or `'always'` (after every marked paper). Absent keeps the default
 * rule, which is `'on-pass'` on a capped quiz and `'always'` on an unlimited
 * one, because an unlimited optional quiz is formative and opens at once.
 *
 * What the editor must get right:
 *
 * - **The control is drawn only on an optional quiz.** A required quiz ignores
 *   the field at runtime and the route refuses it (`quiz-reveal-optional-only`),
 *   so a required quiz shows no control and its save never carries the field.
 * - **Untouched means absent.** The control shows the rule a learner actually
 *   gets, but a teacher who never touches it saves a body with no
 *   `revealExplanation` key, so a re-save changes no stored byte.
 * - **A sealed quiz reads it back, never offers it.** A sealed quiz saves no
 *   `quiz` at all, so the reveal on it is a readout like the other settings.
 * - **The explanation's own note follows the rule** rather than naming a rule
 *   the quiz does not have.
 *
 * The last block is the learner room's half, a regression **guard**: the room
 * decides nothing and draws exactly what the report released, so an `'always'`
 * quiz's failed paper shows the explanation and a sealed one shows none.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredQuiz, AuthoredQuizView, DraftTaskView, QuizReport } from '@learnsdlc/shared';
import { DEFAULT_QUIZ_PASS_MARK } from '@learnsdlc/shared';
import { TaskEditor } from '@/components/staff/projects/TaskEditor';
import {
  blankQuiz,
  quizDraftOfKey,
  quizDraftOfView,
  revealLabel,
  revealShown,
  toAuthoredQuiz,
} from '@/components/staff/projects/QuizEditor';
import { QuizResult } from '@/components/workspace/quiz/QuizResult';

/* ------------------------------- fixtures -------------------------------- */

const VIEW: AuthoredQuizView = {
  questions: [
    {
      id: 'concepts-1',
      stem: 'The first question, as a fixture writes it.',
      options: [
        { id: 'a', text: 'The first option.' },
        { id: 'b', text: 'The second option.' },
      ],
      answerCount: 1,
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

const KEY: AuthoredQuiz = {
  questions: [
    {
      id: 'concepts-1',
      stem: 'The first question, as a fixture writes it.',
      options: [
        { id: 'a', text: 'The first option.' },
        { id: 'b', text: 'The second option.' },
      ],
      correct: ['b'],
      explanation: 'The explanation the fixture carries.',
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

/* -------------------------------- harness -------------------------------- */

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
const radio = (id: string) => byId(id) as HTMLInputElement | null;

async function mount(task: DraftTaskView | null = null) {
  await act(async () => {
    root?.render(
      <TaskEditor
        task={task}
        busy={false}
        error=""
        published={false}
        onAdd={onAdd}
        onSave={onSave}
        onCancel={onCancel}
        onReadQuizKey={readKey}
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

/** A new one-question quiz, filled in far enough to be saved. */
async function newQuiz({ required }: { required: boolean }) {
  await mount();
  await act(async () => {
    type(byId('task-form-key'), 'concepts');
    type(byId('task-form-title'), 'The concept check');
    type(byId('task-form-brief'), 'Answer the questions.');
  });
  // The form opens required; one click makes it optional.
  if (!required) await click('task-form-required');
  // A required quiz needs a pool larger than its paper, so write two and draw one.
  for (let at = 0; at < 2; at += 1) {
    if (at > 0) await click('quiz-question-add');
    await act(async () => {
      type(byId(`quiz-question-stem-${at}`), `Question ${at + 1}, as a fixture writes it.`);
      type(byId(`quiz-option-${at}-0`), 'The first option.');
      type(byId(`quiz-option-${at}-1`), 'The second option.');
      type(byId(`quiz-question-explanation-${at}`), 'Why that is the answer.');
    });
    await click(`quiz-option-correct-${at}-0`);
  }
  await act(async () => {
    type(byId('quiz-drawn'), '1');
  });
}

/* --------------------------------- tests --------------------------------- */

describe('the reveal control: drawn only on an optional quiz', () => {
  it('an optional quiz shows two labelled options in a fieldset with a legend', async () => {
    await newQuiz({ required: false });
    const group = byId('quiz-reveal');
    expect(group, 'no reveal control on an optional quiz').not.toBeNull();
    expect(group?.tagName).toBe('FIELDSET');
    expect(group?.querySelector('legend')?.textContent).toBe('When a learner reads the explanations');

    const onPass = radio('quiz-reveal-on-pass');
    const always = radio('quiz-reveal-always');
    expect(onPass?.type).toBe('radio');
    expect(always?.type).toBe('radio');
    expect(onPass?.name).toBe(always?.name);
    // Each option is named by its own label, not by a neighbour's text.
    // Unlimited: attempts never run out, so the label does not promise they do.
    expect(host?.querySelector(`label[for="${onPass?.id}"]`)?.textContent).toBe('After a pass');
    expect(host?.querySelector(`label[for="${always?.id}"]`)?.textContent).toBe(
      'After every attempt, pass or fail',
    );
    await act(async () => {
      type(byId('quiz-attempts'), '2');
    });
    expect(host?.querySelector(`label[for="${onPass?.id}"]`)?.textContent).toBe(
      'After a pass, or when their attempts run out',
    );
  });

  it('a required quiz shows no control, and says the explanations wait for a pass', async () => {
    await newQuiz({ required: true });
    expect(byId('quiz-reveal')).toBeNull();
    expect(radio('quiz-reveal-on-pass')).toBeNull();
    expect(byId('quiz-explanation-note-0')?.textContent).toBe(
      'Released when they pass, or when their attempts are spent. The answer itself never is.',
    );
  });
});

describe('untouched means absent: the control shows the rule a learner gets', () => {
  it('an unlimited optional quiz shows "every attempt" and saves no field', async () => {
    await newQuiz({ required: false });
    expect((byId('quiz-attempts') as HTMLInputElement).value).toBe('');
    expect(radio('quiz-reveal-always')?.checked).toBe(true);
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(false);
    await click('task-form-submit');
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect('revealExplanation' in onAdd.mock.calls[0][0].quiz).toBe(false);
  });

  it('a capped optional quiz shows "after a pass" and saves no field', async () => {
    await newQuiz({ required: false });
    await act(async () => {
      type(byId('quiz-attempts'), '2');
    });
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(true);
    expect(radio('quiz-reveal-always')?.checked).toBe(false);
    await click('task-form-submit');
    expect('revealExplanation' in onAdd.mock.calls[0][0].quiz).toBe(false);
  });
});

describe('a chosen rule travels on the save of an optional quiz', () => {
  it('"after a pass" on an unlimited quiz closes the formative door, and the save says so', async () => {
    await newQuiz({ required: false });
    await click('quiz-reveal-on-pass');
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(true);
    expect(byId('quiz-explanation-note-0')?.textContent).toBe(
      'Released when they pass. The answer itself never is.',
    );
    await click('task-form-submit');
    expect(onAdd.mock.calls[0][0].quiz.revealExplanation).toBe('on-pass');
  });

  it('"every attempt" on a capped quiz opens every marked paper, and the save says so', async () => {
    await newQuiz({ required: false });
    await act(async () => {
      type(byId('quiz-attempts'), '2');
    });
    await click('quiz-reveal-always');
    expect(byId('quiz-explanation-note-0')?.textContent).toBe(
      'Released after every marked attempt, pass or fail. The answer itself never is.',
    );
    await click('task-form-submit');
    expect(onAdd.mock.calls[0][0].quiz.revealExplanation).toBe('always');
  });

  it('a click on "every attempt" while it is already shown is a choice, kept when attempts are capped', async () => {
    await newQuiz({ required: false });
    expect(radio('quiz-reveal-always')?.checked).toBe(true);
    await click('quiz-reveal-always');
    await act(async () => {
      type(byId('quiz-attempts'), '3');
    });
    expect(radio('quiz-reveal-always')?.checked).toBe(true);
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(false);
    await click('task-form-submit');
    expect(onAdd.mock.calls[0][0].quiz.revealExplanation).toBe('always');
  });

  it('a click on "after a pass" while it is already shown is a choice, kept when the limit is cleared', async () => {
    await newQuiz({ required: false });
    await act(async () => {
      type(byId('quiz-attempts'), '2');
    });
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(true);
    await click('quiz-reveal-on-pass');
    await act(async () => {
      type(byId('quiz-attempts'), '');
    });
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(true);
    await click('task-form-submit');
    expect(onAdd.mock.calls[0][0].quiz.revealExplanation).toBe('on-pass');
  });

  it('a rule chosen and then made required is dropped from the save', async () => {
    await newQuiz({ required: false });
    await click('quiz-reveal-on-pass');
    await act(async () => {
      type(byId('quiz-attempts'), '3');
    });
    await click('task-form-required');
    expect(byId('quiz-reveal')).toBeNull();
    await click('task-form-submit');
    expect(onAdd).toHaveBeenCalledTimes(1);
    const body = onAdd.mock.calls[0][0];
    expect(body.required).toBe(true);
    expect('revealExplanation' in body.quiz).toBe(false);
  });
});

describe('an existing quiz: sealed reads it back, keyed offers it', () => {
  it('a sealed optional quiz reads the rule back and offers no control', async () => {
    await mount(quizTask({ quiz: { ...VIEW, revealExplanation: 'always' } }));
    expect(byId('quiz-reveal')).toBeNull();
    expect(byId('quiz-reveal-readout')?.textContent).toBe('After every attempt, pass or fail.');
  });

  it('a sealed optional quiz with no rule reads back the one it has today', async () => {
    await mount(quizTask());
    expect(byId('quiz-reveal-readout')?.textContent).toBe(
      'After a pass, or when their attempts run out.',
    );
    // A fresh form: the editor reads its task once, when it mounts.
    await act(async () => {
      root?.render(<></>);
    });
    await mount(quizTask({ quiz: { ...VIEW, attempts: { max: null, cooldownSeconds: null } } }));
    expect(byId('quiz-reveal-readout')?.textContent).toBe('After every attempt, pass or fail.');
  });

  it('a sealed unlimited quiz with a stored "after a pass" does not promise attempts run out', async () => {
    await mount(
      quizTask({
        quiz: { ...VIEW, attempts: { max: null, cooldownSeconds: null }, revealExplanation: 'on-pass' },
      }),
    );
    expect(byId('quiz-reveal-readout')?.textContent).toBe('After a pass.');
  });

  it('a sealed required quiz has no reveal line at all', async () => {
    await mount(quizTask({ required: true }));
    expect(byId('quiz-reveal-readout')).toBeNull();
    expect(byId('quiz-reveal')).toBeNull();
  });

  it('the key route opens the control on the stored rule, and the save carries it', async () => {
    readKey.mockResolvedValue({ ...KEY, revealExplanation: 'always' });
    await mount(quizTask({ quiz: { ...VIEW, revealExplanation: 'always' } }));
    await click('quiz-answers-show');
    expect(radio('quiz-reveal-always')?.checked).toBe(true);
    await click('quiz-reveal-on-pass');
    await click('task-form-submit');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].quiz.revealExplanation).toBe('on-pass');
  });

  it('a key payload without the field keeps the rule the view carried, so a re-save erases nothing', async () => {
    readKey.mockResolvedValue(KEY);
    await mount(quizTask({ quiz: { ...VIEW, revealExplanation: 'always' } }));
    await click('quiz-answers-show');
    expect(radio('quiz-reveal-always')?.checked).toBe(true);
    await click('task-form-submit');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].quiz.revealExplanation).toBe('always');
  });

  it('a key payload that carries the field wins over the view', async () => {
    readKey.mockResolvedValue({ ...KEY, revealExplanation: 'on-pass' });
    await mount(quizTask({ quiz: { ...VIEW, revealExplanation: 'always' } }));
    await click('quiz-answers-show');
    expect(radio('quiz-reveal-on-pass')?.checked).toBe(true);
    await click('task-form-submit');
    expect(onSave.mock.calls[0][0].quiz.revealExplanation).toBe('on-pass');
  });

  it('a stored rule the teacher leaves alone is saved back as it was', async () => {
    readKey.mockResolvedValue({ ...KEY, revealExplanation: 'always' });
    await mount(quizTask({ quiz: { ...VIEW, revealExplanation: 'always' } }));
    await click('quiz-answers-show');
    await click('task-form-submit');
    expect(onSave.mock.calls[0][0].quiz.revealExplanation).toBe('always');
  });
});

describe('the pure pieces', () => {
  it('revealShown follows the stored rule, else today’s rule from the attempts', () => {
    const blank = blankQuiz();
    expect(revealShown(blank, false)).toBe('always');
    expect(revealShown({ ...blank, attemptsMax: '3' }, false)).toBe('on-pass');
    expect(revealShown({ ...blank, revealExplanation: 'on-pass' }, false)).toBe('on-pass');
    expect(revealShown({ ...blank, attemptsMax: '3', revealExplanation: 'always' }, false)).toBe('always');
    // A required quiz ignores the field, as the runtime does.
    expect(revealShown({ ...blank, attemptsMax: '3', revealExplanation: 'always' }, true)).toBe('on-pass');
  });

  it('the two readers carry the field, and the absent field stays absent', () => {
    expect(quizDraftOfView(VIEW).revealExplanation).toBeNull();
    expect(quizDraftOfView({ ...VIEW, revealExplanation: 'always' }).revealExplanation).toBe('always');
    expect(quizDraftOfKey(KEY).revealExplanation).toBeNull();
    expect(quizDraftOfKey({ ...KEY, revealExplanation: 'on-pass' }).revealExplanation).toBe('on-pass');
    // The key reader falls back to the rule already held, and only when the key lacks one.
    expect(quizDraftOfKey(KEY, 'always').revealExplanation).toBe('always');
    expect(quizDraftOfKey({ ...KEY, revealExplanation: 'on-pass' }, 'always').revealExplanation).toBe('on-pass');
    expect(quizDraftOfKey(KEY, null).revealExplanation).toBeNull();
  });

  it('the on-pass label names the last attempt only when attempts are capped', () => {
    const blank = blankQuiz();
    expect(revealLabel('on-pass', blank, false)).toBe('After a pass');
    expect(revealLabel('on-pass', { ...blank, attemptsMax: '3' }, false)).toBe(
      'After a pass, or when their attempts run out',
    );
    expect(revealLabel('always', blank, false)).toBe('After every attempt, pass or fail');
  });

  it('toAuthoredQuiz sends the field on an optional quiz only', () => {
    const draft = { ...quizDraftOfKey(KEY), revealExplanation: 'always' as const };
    expect(toAuthoredQuiz(draft, 'concepts', false).revealExplanation).toBe('always');
    expect('revealExplanation' in toAuthoredQuiz(draft, 'concepts', true)).toBe(false);
    expect('revealExplanation' in toAuthoredQuiz(quizDraftOfKey(KEY), 'concepts', false)).toBe(false);
  });
});

/* ----------------------- the learner room: a guard ------------------------ */

function report(
  explanation: string | null,
  concept: string | null = explanation ? 'the shape of a question' : null,
): QuizReport {
  return {
    correctCount: 0,
    drawn: 1,
    passMark: 60,
    attempt: 1,
    attemptsLeft: 2,
    questions: [
      {
        id: 'concepts-1',
        stem: 'The first question, as a fixture writes it.',
        options: [
          { id: 'o1', text: 'The first option.' },
          { id: 'o2', text: 'The second option.' },
        ],
        selected: ['o1'],
        outcome: 'wrong',
        explanation,
        concept,
      },
    ],
  };
}

describe('the learner room draws what the report released', () => {
  it('a failed paper with attempts left shows the explanation the API released', async () => {
    await act(async () => {
      root?.render(<QuizResult report={report('The explanation the fixture carries.')} passed={false} />);
    });
    const item = byId('quiz-marked-concepts-1');
    expect(item?.textContent).toContain('The explanation the fixture carries.');
    expect(byId('quiz-concept-concepts-1')?.textContent).toBe('the shape of a question');
  });

  it('a sealed explanation draws nothing, and no option is marked right', async () => {
    await act(async () => {
      // A concept beside a sealed explanation: the whole block keys on the
      // explanation, so neither is drawn.
      root?.render(<QuizResult report={report(null, 'a concept that must not show')} passed={false} />);
    });
    const item = byId('quiz-marked-concepts-1');
    expect(item?.textContent).not.toContain('a concept that must not show');
    expect(byId('quiz-concept-concepts-1')).toBeNull();
    expect(item?.textContent).not.toMatch(/correct answer/i);
  });
});
