// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail, PhaseSummary, PhaseTaskView, QuizReport, SubmissionView } from '@learnsdlc/shared';
import { taskView } from './fixtures';

/**
 * The learner's quiz room.
 *
 * Accessibility is the specification here rather than a review note, so it is
 * asserted the way a specification is: native controls, a legend that is the
 * question, a live region for the verdict, a word for every outcome, and no
 * clock anywhere. Every one of those is something a screen reader or a
 * keyboard gives away for free and something a hand-rolled `role="radio"`
 * takes back.
 *
 * The other half of the file is the seal, from the browser's side. The answer
 * key never leaves the API, so there is nothing in the room that could draw it,
 * and the assertion that says so is that a **wrong** question gives a learner
 * no way to tell which option was right: the only mark on the paper is their
 * own.
 */

const held = vi.hoisted(() => ({
  request: vi.fn(),
  getSubmission: vi.fn(),
  /** Set to hold the marking wait open, for the one case that is about it. */
  hold: false,
  release: null as null | (() => void),
  /** The shell's "what is on screen is a phase behind" signal. */
  invalidate: vi.fn(),
}));

// The real provider module, with its invalidation signal watched: a verdict is
// the moment the phase's task counts move, and the panel above the room reads
// them from the shell's copy.
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/useProject')>()),
  invalidateProject: held.invalidate,
}));

// Partial, because the phase card at the foot of this file draws the real
// shell and the shell's own modules bind to this one on import.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  request: held.request,
  api: { getSubmission: held.getSubmission },
}));

// The verdict comes back through the ordinary submission watch; the wait
// itself is not what this file is about: except in the one case that asserts
// what is said *while* it lasts, which holds the wait open on `held.hold`.
vi.mock('@/lib/poll', () => ({
  pollUntil: async (fetcher: () => Promise<unknown>) => {
    if (held.hold) {
      await new Promise<void>((resolve) => {
        held.release = resolve;
      });
    }
    return fetcher();
  },
  useRecoverWhenBack: () => {},
}));

const { QuizPaper, RETURNED_SHEET_LINE, ANSWERS_KEPT_LINE } = await import('@/components/workspace/quiz/QuizPaper');
const { QuizResult } = await import('@/components/workspace/quiz/QuizResult');
const {
  QuizRoom,
  MARKING_LINE,
  NO_PAPERS_TITLE,
  RESET_NOTICE_LINE,
  RETURNED_SHEET_HELP_LINE,
  SPENT_LINE,
  SPENT_WHILE_MARKING_LINE,
  CREDIT_WORD,
  CREDITED_LINE,
  noPapersNextLine,
} = await import('@/components/workspace/quiz/QuizRoom');
const { quizTaskKey, scoreLine } = await import('@/components/workspace/quiz/contract');
const { solutionDoorOpen } = await import('@/components/solution/door');

/* --------------------------------- fixtures ------------------------------- */

/**
 * Option ids as the API serves them: opaque per-paper tokens,
 * `o` and 24 hex digits, derived on the server from the attempt, the question
 * and the authored option. Nothing in the room may read an authored id into
 * them (which letter a teacher wrote first would otherwise be on the page and
 * in the hand-in body) so the fixtures are token-shaped and an authored-id
 * assumption anywhere in the room fails a case here.
 */
const token = (hex: string) => `o${hex.padStart(24, '0')}`;
const B1 = token('b1');
const B2 = token('b2');
const B3 = token('b3');
const M1 = token('c1');
const M2 = token('c2');
const M3 = token('c3');

const paper = {
  attemptId: 'a1',
  startedAt: '2026-09-20T09:00:00.000Z',
  questions: [
    {
      id: 'boundary',
      stem: 'What does a boundary value test?',
      options: [
        { id: B1, text: 'The edge of a partition' },
        { id: B2, text: 'The middle of a partition' },
        { id: B3, text: 'The whole partition' },
      ],
      multiple: false,
    },
    {
      id: 'mutant',
      stem: 'What does a surviving mutant tell you?',
      options: [
        { id: M1, text: 'The suite is slow' },
        { id: M2, text: 'No test asserts that behaviour' },
        { id: M3, text: 'Coverage is below the bar' },
      ],
      multiple: true,
    },
  ],
};

/**
 * The same paper, handed in and never marked: what the API offers back.
 *
 * `handedInAt` is how a client tells the two apart, and `selected` is the
 * sheet already in the record. Handing this one in again re-enqueues **those**
 * answers: `handIn` writes a sheet only while the row is open, so anything
 * typed over them would be discarded without a word.
 */
const returned = {
  ...paper,
  handedInAt: '2026-09-20T09:30:00.000Z',
  selected: { boundary: [B1], mutant: [M2, M3] } as Record<string, string[]>,
};

const view = (over: Record<string, unknown> = {}) => ({
  taskKey: 'concepts',
  title: 'Concept check',
  brief: 'Five questions on what testing is for.',
  required: false,
  status: 'in_progress',
  drawn: 2,
  passMark: 60,
  attemptsUsed: 0,
  attemptsLeft: 3,
  cooldownSecondsLeft: null,
  bestScore: null,
  lastSubmissionId: null,
  paper: null,
  ...over,
});

const report = (over: Partial<QuizReport> = {}): QuizReport => ({
  correctCount: 1,
  drawn: 2,
  passMark: 60,
  attempt: 1,
  attemptsLeft: 2,
  questions: [
    {
      id: 'boundary',
      stem: 'What does a boundary value test?',
      options: [
        { id: B1, text: 'The edge of a partition' },
        { id: B2, text: 'The middle of a partition' },
        { id: B3, text: 'The whole partition' },
      ],
      selected: [B1],
      outcome: 'right',
      explanation: 'A partition is chosen so every value inside it behaves the same, so the edges are where it stops being true.',
      concept: 'Boundary values',
    },
    {
      id: 'mutant',
      stem: 'What does a surviving mutant tell you?',
      options: [
        { id: M1, text: 'The suite is slow' },
        { id: M2, text: 'No test asserts that behaviour' },
        { id: M3, text: 'Coverage is below the bar' },
      ],
      selected: [M3],
      outcome: 'wrong',
      explanation: null,
      concept: null,
    },
  ],
  ...over,
});

const submission = (over: Partial<SubmissionView> = {}): SubmissionView => ({
  id: 's1',
  status: 'completed',
  score: 50,
  passed: false,
  report: { quiz: report() } as SubmissionView['report'],
  createdAt: '2026-09-20T09:05:00.000Z',
  ...over,
});

/* ------------------------------- the paper -------------------------------- */

describe('the paper', () => {
  const html = () =>
    renderToStaticMarkup(
      <QuizPaper paper={paper} answers={{ boundary: [B1] }} onChange={() => {}} onHandIn={() => {}} busy={false} />,
    );

  it('puts every question in a fieldset whose legend is the stem', () => {
    const markup = html();
    expect(markup.match(/<fieldset/g)?.length).toBe(2);
    expect(markup.match(/<legend/g)?.length).toBe(2);
    // The stem is inside the legend, so a screen reader announces the question
    // again with every option under it.
    const legend = markup.slice(markup.indexOf('<legend'), markup.indexOf('</legend>'));
    expect(legend).toContain('What does a boundary value test?');
  });

  it('uses native radio for one answer and native checkbox for several, never a role', () => {
    const markup = html();
    expect(markup).toContain('type="radio"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain('role="radio"');
    expect(markup).not.toContain('role="checkbox"');
    expect(markup).not.toContain('role="radiogroup"');
    expect(markup).not.toContain('role="group"');
  });

  it('gives one question’s options one name, which is what arrow keys traverse', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper paper={paper} answers={{}} onChange={() => {}} onHandIn={() => {}} busy={false} />,
      );
    });
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    // One name across the group and a different one for the other question:
    // that grouping is the whole of arrow-key traversal and of "one of these",
    // and it is the thing a div with role="radio" has to re-implement.
    expect(new Set(radios.map((input) => input.name)).size).toBe(1);
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(3);
    expect(radios[0].name).not.toBe(boxes[0].name);
    // Every input is named by a label that points at it, so the hit target is
    // the whole row and the accessible name is the option.
    const labelled = new Set([...root.querySelectorAll('label')].map((label) => label.htmlFor));
    for (const input of [...radios, ...boxes]) expect(labelled.has(input.id)).toBe(true);
    act(() => tree.unmount());
    root.remove();
  });

  it('submits with a real button and never with a timer', () => {
    const markup = html();
    expect(markup).toMatch(/<button[^>]*type="submit"/);
    expect(markup).toContain('Nothing is timed');
    // Nothing counts anything down: there is no per-question clock in the
    // model at all, and the room must never invent one.
    expect(markup).not.toMatch(/time left|seconds left|countdown|expires/i);
  });

  it('carries one answer at a time on a radio and several on a checkbox', () => {
    const seen: Record<string, string[]>[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper
          paper={paper}
          answers={{ boundary: [B1], mutant: [M1] }}
          onChange={(next) => seen.push(next)}
          onHandIn={() => {}}
          busy={false}
        />,
      );
    });
    const radio = root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B2}"]`)!;
    act(() => radio.click());
    expect(seen.at(-1)?.boundary).toEqual([B2]);
    const box = root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-mutant-${M2}"]`)!;
    act(() => box.click());
    expect(seen.at(-1)?.mutant).toEqual([M1, M2]);
    act(() => tree.unmount());
    root.remove();
  });

  /**
   * The sheet that was written and never marked, drawn as what it is.
   *
   * A paper carrying `handedInAt` is already in the record, and the route that
   * takes it grades the answers stored on the row: it will not overwrite them.
   * So the controls here are not a lock that lifts: they are inputs that would
   * take answers nobody would ever mark. `disabled` rather than `busy`, and a
   * sentence saying why, is the difference between a read-only sheet and a
   * form that swallows what a learner types.
   */
  it('draws a sheet that was already handed in read-only, and says why', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper
          paper={returned}
          answers={returned.selected}
          onChange={() => {}}
          onHandIn={() => {}}
          busy={false}
        />,
      );
    });

    const inputs = [...root.querySelectorAll<HTMLInputElement>('fieldset input')];
    expect(inputs).toHaveLength(6);
    expect(inputs.every((input) => input.disabled)).toBe(true);
    // The sheet in the record, on the screen: their own answers, marked as
    // they wrote them, rather than a blank paper they would fill in twice.
    expect(root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B1}"]`)!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-mutant-${M2}"]`)!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-mutant-${M3}"]`)!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-mutant-${M1}"]`)!.checked).toBe(false);
    // And the words for it: what this paper is, and what the control does.
    expect(root.querySelector('[data-testid="quiz-returned"]')!.textContent).toBe(RETURNED_SHEET_LINE);
    expect(root.querySelector('[data-testid="quiz-hand-in"]')!.textContent).toContain('Hand in again');
    // The footer states the sheet rather than asking for it: there is nothing
    // left to answer and no time to take over it.
    expect(root.querySelector('[data-testid="quiz-remaining"]')!.textContent).toBe('All 2 answered.');
    expect(root.querySelector('[data-testid="quiz-no-clock"]')).toBeNull();

    act(() => tree.unmount());
    root.remove();
  });

  it('counts a blank on a re-offered sheet as a blank, not as something still to do', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper
          paper={returned}
          answers={{ boundary: [B1] }}
          onChange={() => {}}
          onHandIn={() => {}}
          busy={false}
        />,
      );
    });

    // "1 of 2 still to answer." would be asking a learner for something the
    // controls will not take. The sheet is written; a blank on it is a blank.
    expect(root.querySelector('[data-testid="quiz-remaining"]')!.textContent).toBe('1 of 2 left blank.');

    act(() => tree.unmount());
    root.remove();
  });

  it('leaves an open paper’s controls exactly as they were', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper paper={paper} answers={{}} onChange={() => {}} onHandIn={() => {}} busy={false} />,
      );
    });

    const inputs = [...root.querySelectorAll<HTMLInputElement>('fieldset input')];
    expect(inputs).toHaveLength(6);
    expect(inputs.some((input) => input.disabled)).toBe(false);
    expect(root.querySelector('[data-testid="quiz-returned"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-hand-in"]')!.textContent).toContain('Hand in');
    expect(root.querySelector('[data-testid="quiz-hand-in"]')!.textContent).not.toContain('again');
    expect(root.querySelector('[data-testid="quiz-remaining"]')!.textContent).toBe(
      '2 questions, none answered yet.',
    );
    expect(root.querySelector('[data-testid="quiz-no-clock"]')).not.toBeNull();
    // What happens to the answers if the learner goes somewhere else. They are
    // React state until the paper is handed in, and the room carries a task
    // panel whose rows read as movement inside the phase, so the page says so
    // rather than losing a half-answered paper without a word.
    expect(root.querySelector('[data-testid="quiz-kept-here"]')!.textContent).toBe(ANSWERS_KEPT_LINE);

    act(() => tree.unmount());
    root.remove();
  });

  it('says nothing about keeping answers on a sheet already written', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper paper={returned} answers={{ boundary: [B1] }} onChange={() => {}} onHandIn={() => {}} busy={false} />,
      );
    });

    // The answers on a re-offered sheet are the record's, and the controls will
    // not take a change to them, so there is nothing here to lose.
    expect(root.querySelector('[data-testid="quiz-kept-here"]')).toBeNull();

    act(() => tree.unmount());
    root.remove();
  });

  it('lets busy be the whole of the lock while a sheet is in flight', () => {
    let handIns = 0;
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(
        <QuizPaper
          paper={paper}
          answers={{ boundary: [B1] }}
          onChange={() => {}}
          onHandIn={() => {
            handIns += 1;
          }}
          busy
        />,
      );
    });
    // Two guards stand between a learner and a second sheet: the control is
    // off, and the form refuses the submit a keypress can still raise.
    expect(root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.disabled).toBe(true);
    const form = root.querySelector<HTMLFormElement>('[data-testid="quiz-paper"]')!;
    const submit = () =>
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    submit();
    expect(handIns).toBe(0);
    // And the paper itself holds no lock of its own, not even while the sheet
    // flies. Disabling the inputs would drop a keyboard learner out of the tab
    // order in the middle of a request, and there is no state such a lock
    // would serve anyway: the room puts the paper away the moment the sheet is
    // in the record.
    const inputs = [...root.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs).toHaveLength(6);
    for (const input of inputs) expect(input.disabled).toBe(false);
    // The same submit on a paper that is not in flight does hand in, so the
    // refusal above is the guard and not an event going nowhere.
    act(() => {
      tree.render(
        <QuizPaper
          paper={paper}
          answers={{ boundary: [B1] }}
          onChange={() => {}}
          onHandIn={() => {
            handIns += 1;
          }}
          busy={false}
        />,
      );
    });
    submit();
    expect(handIns).toBe(1);
    act(() => tree.unmount());
    root.remove();
  });
});

/* ------------------------------ the marked paper -------------------------- */

describe('the marked paper', () => {
  const markup = () => renderToStaticMarkup(<QuizResult report={report()} passed={false} />);

  it('announces the score through a polite live region', () => {
    const html = markup();
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain(scoreLine(1, 2, 60, false));
    expect(html).toContain('1 of 2 correct');
  });

  it('mounts that region empty, so the verdict is a change inside it and not a new node', () => {
    // A live region that arrives with its sentence already inside it is not
    // reliably read out: the region has to be in the accessibility tree
    // before the text changes, and this whole screen is mounted in one go the
    // moment the mark lands. So the first render carries the region and no
    // sentence, and there is exactly one region to fill.
    const doc = new DOMParser().parseFromString(`<div>${markup()}</div>`, 'text/html');
    const regions = [...doc.querySelectorAll('[aria-live]')];
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute('aria-live')).toBe('polite');
    expect(regions[0].getAttribute('role')).toBe('status');
    expect(regions[0].textContent).toBe('');
  });

  it('fills the region once it is mounted, and leaves the visible score an ordinary line', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tree = createRoot(root);
    act(() => {
      tree.render(<QuizResult report={report()} passed={false} />);
    });
    const regions = [...root.querySelectorAll('[aria-live]')];
    expect(regions).toHaveLength(1);
    expect(regions[0].textContent).toBe(scoreLine(1, 2, 60, false));
    // The sentence a sighted learner reads is a plain paragraph. A second
    // region holding the same words would announce the verdict twice.
    const score = root.querySelector('[data-testid="quiz-score"]')!;
    expect(score.getAttribute('aria-live')).toBeNull();
    expect(score.getAttribute('role')).toBeNull();
    expect(score.textContent).toBe(scoreLine(1, 2, 60, false));
    act(() => tree.unmount());
    root.remove();
  });

  it('carries every outcome as a word, not as a colour', () => {
    const html = markup();
    expect(html).toContain('>Right<');
    expect(html).toContain('>Wrong<');
    // Strip every class and the two words are still there to read.
    expect(html.replace(/class="[^"]*"/g, '')).toMatch(/Right[\s\S]*Wrong/);
  });

  it('marks the learner’s own answer and nothing else, on a question they got wrong', () => {
    const html = markup();
    // Two picks across the paper, so two marks, and not one more. A learner
    // who was wrong is told they were wrong and is not shown the key.
    expect(html.match(/Your answer/g)?.length).toBe(2);
    expect(html).not.toMatch(/correct answer|the answer is|right answer/i);
    // The wrong question's other options carry no mark at all.
    const wrong = html.slice(html.indexOf('data-testid="quiz-marked-mutant"'));
    expect(wrong.match(/Your answer/g)?.length).toBe(1);
  });

  it('draws an explanation only where the API released one', () => {
    const html = markup();
    expect(html).toContain('A partition is chosen so every value inside it behaves the same');
    expect(html).toContain('Boundary values');
    // The second question's explanation is still sealed: it arrives as null
    // and there is nothing here to draw. The room holds no flag of its own.
    expect(html).not.toContain('data-testid="quiz-concept-mutant"');
  });

  it('says what a blank was', () => {
    const blank = report({
      questions: report().questions.map((q) => (q.id === 'mutant' ? { ...q, selected: [] } : q)),
    });
    const html = renderToStaticMarkup(<QuizResult report={blank} passed={false} />);
    expect(html).toContain('You left this one blank.');
  });
});

/* -------------------------------- the room -------------------------------- */

describe('the quiz room', () => {
  let root: HTMLElement;
  let tree: Root;

  beforeEach(() => {
    held.request.mockReset();
    held.getSubmission.mockReset();
    held.hold = false;
    held.release = null;
    root = document.createElement('div');
    document.body.append(root);
    tree = createRoot(root);
  });

  afterEach(() => {
    held.release?.();
    // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
    expect(root.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
    act(() => tree.unmount());
    root.remove();
  });

  /**
   * The room, with the two facts the page hands it.
   *
   * They default to *no reset, nothing in the record*, which is what every
   * case below this one is about, so a case that does not name them draws no
   * reset notice.
   */
  const mount = async (record: { resetAt?: string | null; papersInRecord?: number } = {}) => {
    await act(async () => {
      tree.render(<QuizRoom phaseId="p4" taskKey="concepts" {...record} />);
    });
  };

  it('reads the quiz, then starts a paper on the learner’s word', async () => {
    held.request.mockImplementation(async (method: string) => (method === 'GET' ? view() : paper));
    await mount();

    expect(held.request).toHaveBeenCalledWith('GET', '/phases/p4/tasks/concepts/quiz');
    expect(root.querySelector('[data-testid="quiz-paper"]')).toBeNull();
    expect(root.textContent).toContain('Start the quiz');
    expect(root.textContent).toContain('Pass mark');

    const start = root.querySelector<HTMLButtonElement>('[data-testid="quiz-start"]')!;
    await act(async () => start.click());

    expect(held.request).toHaveBeenCalledWith('POST', '/phases/p4/tasks/concepts/quiz/attempts');
    expect(root.querySelector('[data-testid="quiz-paper"]')).not.toBeNull();
  });

  it('hands the sheet in as option ids and draws the mark it gets back', async () => {
    let reads = 0;
    held.request.mockImplementation(async (method: string) => {
      if (method !== 'GET') return submission();
      reads += 1;
      // The first read finds the paper open; the read after the hand-in finds
      // it closed, an attempt spent and a revision to draw back.
      return reads === 1 ? view({ paper }) : view({ attemptsUsed: 1, attemptsLeft: 2, lastSubmissionId: 's1' });
    });
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    const pick = root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B1}"]`)!;
    await act(async () => pick.click());
    const handIn = root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!;
    await act(async () => handIn.click());

    expect(held.request).toHaveBeenCalledWith('POST', '/phases/p4/tasks/concepts/quiz/attempts/a1', {
      answers: { boundary: [B1] },
    });
    expect(root.querySelector('[data-testid="quiz-result"]')).not.toBeNull();
    expect(root.textContent).toContain('1 of 2 correct');
    // And the counters are asked for again, because they have just moved.
    expect(held.request.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(2);
  });

  /**
   * The task list above the room hears about the verdict.
   *
   * The room re-reads its own counters, but the panel of the phase's tasks is
   * drawn from the shell's copy of the phase, so without a signal it would say
   * "0 of 3 required done" straight after a pass until the page was reloaded.
   * The verdict is
   * what moves those numbers, so the shell is told the moment it lands, and
   * not before, because a hand-in alone moves nothing the panel draws.
   */
  it('tells the shell its copy of the phase is behind once the verdict lands', async () => {
    held.hold = true;
    let reads = 0;
    held.request.mockImplementation(async (method: string) => {
      if (method !== 'GET') return submission({ status: 'queued', score: null, passed: null, report: null });
      reads += 1;
      return reads === 1 ? view({ paper }) : view({ attemptsUsed: 1, attemptsLeft: 2, lastSubmissionId: 's1' });
    });
    held.getSubmission.mockResolvedValue(submission({ passed: true, score: 100 }));
    await mount();

    await act(async () => root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B1}"]`)!.click());
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click());
    // Handed in and still being marked: nothing the panel draws has moved.
    expect(root.querySelector('[data-testid="quiz-marking"]')).not.toBeNull();
    expect(held.invalidate).not.toHaveBeenCalled();

    await act(async () => held.release?.());
    expect(root.querySelector('[data-testid="quiz-result"]')).not.toBeNull();
    expect(held.invalidate).toHaveBeenCalledTimes(1);
  });

  /**
   * The recovery the API offers, reached.
   *
   * A sheet whose marking never happened (the queue refused the job, or a
   * stall age-out wrote the revision off) is offered back on `view.paper`
   * with `handedInAt` set, so the learner can hand it in again rather than be
   * sent to an instructor for an outage they did not cause. The route grades
   * the answers **already in the record**: `handIn` writes a sheet only while
   * the row is open. A room that seeded blank inputs would therefore take a
   * whole paper of answers and throw them away without a word, which is the
   * one thing this state must not do.
   */
  it('seeds a re-offered sheet from the record rather than from a blank paper', async () => {
    held.request.mockImplementation(async (method: string) =>
      method === 'GET' ? view({ attemptsUsed: 1, attemptsLeft: 2, paper: returned }) : submission(),
    );
    await mount();

    expect(root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B1}"]`)!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-mutant-${M3}"]`)!.checked).toBe(true);
    expect(root.querySelector('[data-testid="quiz-returned"]')).not.toBeNull();
  });

  it('hands that sheet back in as written, because the record is what gets marked', async () => {
    let reads = 0;
    held.request.mockImplementation(async (method: string) => {
      if (method !== 'GET') return submission();
      reads += 1;
      return reads === 1
        ? view({ attemptsUsed: 1, attemptsLeft: 2, paper: returned })
        : view({ attemptsUsed: 1, attemptsLeft: 2, lastSubmissionId: 's1' });
    });
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click());

    // The sheet in the record, sent back at the id it was written under. An
    // empty body here is the room discarding a learner's paper.
    expect(held.request).toHaveBeenCalledWith('POST', '/phases/p4/tasks/concepts/quiz/attempts/a1', {
      answers: { boundary: [B1], mutant: [M2, M3] },
    });
  });

  /**
   * The room answers the paper it was served, by what each option says.
   *
   * Option ids are opaque tokens minted for this paper, and the hand-in is
   * refused unless it carries exactly those. So a learner (and a test, and a
   * browser script) picks an option by its words or its place on the page,
   * and the sheet sent back is the served tokens and nothing the room made up.
   */
  it('picks an option by what it says and hands in the tokens that paper served', async () => {
    let reads = 0;
    held.request.mockImplementation(async (method: string) => {
      if (method !== 'GET') return submission();
      reads += 1;
      return reads === 1 ? view({ paper }) : view({ attemptsUsed: 1, attemptsLeft: 2, lastSubmissionId: 's1' });
    });
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    const option = (text: string) => {
      const label = [...root.querySelectorAll('label')].find((row) => row.textContent?.includes(text))!;
      return document.getElementById(label.htmlFor) as HTMLInputElement;
    };
    await act(async () => option('The edge of a partition').click());
    await act(async () => option('No test asserts that behaviour').click());
    await act(async () => option('Coverage is below the bar').click());
    // Nothing on the paper is named by an authored letter.
    expect(root.innerHTML).not.toMatch(/quiz-option-[a-z]+-[a-f]"/);
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click());

    const sent = held.request.mock.calls.find(([method, path]) => method === 'POST' && String(path).endsWith('/attempts/a1'));
    expect(sent?.[2]).toEqual({ answers: { boundary: [B1], mutant: [M2, M3] } });
    const values = Object.values((sent?.[2] as { answers: Record<string, string[]> }).answers).flat();
    expect(values.every((id) => /^o[0-9a-f]{24}$/.test(id))).toBe(true);
  });

  /**
   * A retake is a fresh paper with fresh tokens, and it starts blank.
   *
   * The last paper's tokens are refused on any other paper, so a room that
   * carried the last sheet's picks into the next one would hand in a sheet the
   * route turns away, and would be telling the learner which options they
   * chose last time besides.
   */
  it('starts a retake blank and never hands in a token from the paper before it', async () => {
    const D1 = token('d1');
    const retake = {
      ...paper,
      attemptId: 'a2',
      questions: [
        { ...paper.questions[0], options: [{ id: D1, text: 'The edge of a partition' }, { id: token('d2'), text: 'The middle of a partition' }] },
        { ...paper.questions[1], options: [{ id: token('e1'), text: 'The suite is slow' }, { id: token('e2'), text: 'Coverage is below the bar' }] },
      ],
    };
    let reads = 0;
    held.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path.endsWith('/quiz/attempts')) return retake;
      if (method === 'POST') return submission({ id: 's2' });
      reads += 1;
      return reads === 1
        ? view({ attemptsUsed: 1, attemptsLeft: 2, lastSubmissionId: 's1' })
        : view({ attemptsUsed: 2, attemptsLeft: 1, lastSubmissionId: 's2' });
    });
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    // The marked paper is on screen, with the learner's own last picks on it.
    expect(root.querySelector('[data-testid="quiz-result"]')).not.toBeNull();
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-start"]')!.click());

    const inputs = [...root.querySelectorAll<HTMLInputElement>('fieldset input')];
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((input) => !input.checked)).toBe(true);
    await act(async () => root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${D1}"]`)!.click());
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click());

    const sent = held.request.mock.calls.find(([method, path]) => method === 'POST' && String(path).endsWith('/attempts/a2'));
    expect(sent?.[2]).toEqual({ answers: { boundary: [D1] } });
    expect(JSON.stringify(sent?.[2])).not.toContain(B1);
    expect(JSON.stringify(sent?.[2])).not.toContain(M3);
  });

  /**
   * A paper, its marking and a retake, against a fake that keeps the API's
   * token rules rather than fixtures that agree with the room by hand.
   *
   * `apps/api/test/quiz-journey.e2e-spec.ts` holds the API to four rules on
   * the wire: every paper names its options by tokens of its own, a reload is
   * the same paper under the same names, a sheet naming anything that paper
   * did not serve is refused with one sentence, and the marked paper names the
   * options and the learner's picks by the tokens the paper served. This fake
   * keeps exactly those four, so the room is asked across a whole sitting
   * (not one request) whether it ever sends a name it was not given, and
   * whether "Your answer" lands beside the option the learner chose once the
   * mark comes back in the paper's own names.
   */
  it('sits a paper, reads its mark and takes it again, sending only names each paper served', async () => {
    const { ApiError } = await import('@/lib/api');
    const SHEET_REFUSAL =
      'This answer sheet does not match the paper that was drawn. Open the quiz again and answer the paper that is there.';
    const bank = [
      { id: 'boundary', stem: 'What does a boundary value test?', texts: ['The edge of a partition', 'The middle of a partition'] },
      { id: 'mutant', stem: 'What does a surviving mutant tell you?', texts: ['No test asserts that behaviour', 'The suite is slow'] },
    ];
    type Paper = { attemptId: string; startedAt: string; questions: { id: string; stem: string; multiple: boolean; options: { id: string; text: string }[] }[] };
    // Every paper its own names: the attempt, the question and the option.
    const paperFor = (n: number): Paper => ({
      attemptId: `p${n}`,
      startedAt: '2026-09-20T09:00:00.000Z',
      questions: bank.map((one, q) => ({
        id: one.id,
        stem: one.stem,
        multiple: false,
        options: one.texts.map((text, o) => ({ id: token(`${n}0${q}0${o}`), text })),
      })),
    });
    let drawn = 0;
    let open: Paper | null = null;
    let used = 0;
    let last: string | null = null;
    const marks: Record<string, SubmissionView> = {};
    const served: string[][] = [];
    held.request.mockImplementation(async (method: string, path: string, body?: { answers: Record<string, unknown> }) => {
      if (method === 'GET') return view({ attemptsUsed: used, attemptsLeft: 3 - used, lastSubmissionId: last, paper: open });
      if (path.endsWith('/quiz/attempts')) {
        if (!open) {
          drawn += 1;
          open = paperFor(drawn);
          served.push(open.questions.flatMap((question) => question.options.map((option) => option.id)));
        }
        return open;
      }
      if (!open || !path.endsWith(`/attempts/${open.attemptId}`)) throw new ApiError(400, 'That paper has already been handed in.');
      const answers = body?.answers ?? {};
      for (const [questionId, picked] of Object.entries(answers)) {
        const names = new Set(open.questions.find((question) => question.id === questionId)?.options.map((option) => option.id));
        if (!Array.isArray(picked) || picked.some((id) => !names.has(id))) throw new ApiError(400, SHEET_REFUSAL);
      }
      // The first option the bank lists is the keyed one; the mark names
      // everything by this paper's tokens, as the API's report does.
      const questions = open.questions.map((question) => {
        const selected = (answers[question.id] as string[] | undefined) ?? [];
        return {
          id: question.id,
          stem: question.stem,
          options: question.options,
          selected,
          outcome: selected.length === 1 && selected[0] === question.options[0].id ? ('right' as const) : ('wrong' as const),
          explanation: null,
          concept: null,
        };
      });
      used += 1;
      const correctCount = questions.filter((question) => question.outcome === 'right').length;
      const id = `s${used}`;
      last = id;
      marks[id] = submission({
        id,
        passed: correctCount === 2,
        score: correctCount * 50,
        report: { quiz: report({ correctCount, attempt: used, attemptsLeft: 3 - used, questions }) } as SubmissionView['report'],
      });
      open = null;
      return submission({ id, status: 'queued', score: null, passed: null, report: null });
    });
    held.getSubmission.mockImplementation(async (id: string) => marks[id]);
    await mount();

    const option = (text: string) => {
      const label = [...root.querySelectorAll('label')].find((row) => row.textContent?.includes(text))!;
      return document.getElementById(label.htmlFor) as HTMLInputElement;
    };
    const markedRow = (text: string) =>
      [...root.querySelectorAll<HTMLElement>('[data-testid="quiz-result"] li[data-testid^="quiz-option-"]')].find((row) =>
        row.textContent?.includes(text),
      )!;
    const handIn = () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click();

    // THE FIRST PAPER, answered by what the options say.
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-start"]')!.click());
    await act(async () => option('The edge of a partition').click());
    await act(async () => option('The suite is slow').click());
    await act(async () => handIn());

    // Accepted, marked, and "Your answer" beside exactly the two picks.
    expect(root.querySelector('[data-testid="quiz-error"]')).toBeNull();
    expect(root.textContent).toContain('1 of 2 correct');
    expect(markedRow('The edge of a partition').textContent).toContain('Your answer');
    expect(markedRow('The suite is slow').textContent).toContain('Your answer');
    expect(markedRow('The middle of a partition').textContent).not.toContain('Your answer');
    expect(markedRow('No test asserts that behaviour').textContent).not.toContain('Your answer');

    // THE RETAKE: new names, blank inputs, and a sheet in the new names only.
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-start"]')!.click());
    expect([...root.querySelectorAll<HTMLInputElement>('fieldset input')].every((input) => !input.checked)).toBe(true);
    await act(async () => option('The edge of a partition').click());
    await act(async () => option('No test asserts that behaviour').click());
    await act(async () => handIn());

    expect(root.querySelector('[data-testid="quiz-error"]')).toBeNull();
    expect(root.textContent).toContain('2 of 2 correct');
    const sheets = held.request.mock.calls
      .filter(([method, path]) => method === 'POST' && /\/attempts\/p\d+$/.test(String(path)))
      .map(([, , sent]) => Object.values((sent as { answers: Record<string, string[]> }).answers).flat());
    expect(sheets).toHaveLength(2);
    sheets.forEach((names, at) => expect(names.every((name) => served[at].includes(name))).toBe(true));
    expect(sheets[1].some((name) => served[0].includes(name))).toBe(false);
  });

  it('mounts no editor, no run control and no propose surface', async () => {
    held.request.mockImplementation(async () => view({ paper }));
    await mount();
    const markup = root.innerHTML;
    for (const stray of ['monaco', 'Run tests', 'Run app', 'Propose', 'data-testid="submit"']) {
      expect(markup).not.toContain(stray);
    }
    // The only controls are the paper's own and the one that hands it in.
    const buttons = [...root.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'));
    expect(buttons).toEqual(['quiz-hand-in']);
  });

  it('says a spent limit rather than offering a paper that would be refused', async () => {
    held.request.mockImplementation(async () => view({ attemptsUsed: 3, attemptsLeft: 0 }));
    await mount();
    expect(root.querySelector('[data-testid="quiz-start"]')).toBeNull();
    expect(root.textContent).toContain('You have used every attempt on this quiz');
  });

  /**
   * The spent limit, said while the last paper is still being marked.
   *
   * A learner who reloads the room between the hand-in and the verdict meets
   * two sentences at once: *This paper is in the record. Its mark is not
   * readable here yet.* and, under it, *Your best score is the one that counts,
   * and it is already recorded.* The second is not true yet (the paper it is
   * about has not been scored) and the two are read together, so one of them
   * has to give. The room already holds the revision it is watching, so the
   * sentence is chosen on that rather than on a new request.
   */
  it('does not call the best score recorded while the last paper is still being marked', async () => {
    held.request.mockImplementation(async () =>
      view({ attemptsUsed: 3, attemptsLeft: 0, bestScore: 40, lastSubmissionId: 's1' }),
    );
    held.getSubmission.mockResolvedValue(
      submission({ status: 'running', score: null, passed: null, report: null }),
    );
    await mount();

    // The state the report was about: the two sentences on screen together.
    expect(root.querySelector('[data-testid="quiz-no-report"]')).not.toBeNull();
    const spent = root.querySelector('[data-testid="quiz-spent"]')!;
    expect(spent).not.toBeNull();
    expect(spent.textContent).toContain('You have used every attempt on this quiz');
    expect(spent.textContent).toContain(SPENT_WHILE_MARKING_LINE);
    // And the claim that is not true yet is not made.
    expect(root.textContent).not.toContain(SPENT_LINE);
    // Waiting for a mark is not a failure, and no control is offered that the
    // route would refuse.
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-start"]')).toBeNull();
  });

  it('says the best score is recorded once that paper has been marked', async () => {
    // The inverse: the verdict has landed, so the older sentence is true again
    // and is the one the room says.
    held.request.mockImplementation(async () =>
      view({ attemptsUsed: 3, attemptsLeft: 0, bestScore: 50, lastSubmissionId: 's1' }),
    );
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    expect(root.querySelector('[data-testid="quiz-result"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="quiz-spent"]')!.textContent).toContain(SPENT_LINE);
    expect(root.textContent).not.toContain(SPENT_WHILE_MARKING_LINE);
  });

  /**
   * The sheet that keeps coming back, and the one thing the room owed it.
   *
   * A paper whose marking never happened is offered back so the learner can
   * hand it in again, and while it is on screen every other control is hidden
   * and `needsInstructorReset` is false, because the attempts are not the
   * problem. A learner whose grading fails twice would therefore have one
   * button and nothing telling them anybody could help. The sentence says the two things
   * they cannot work out for themselves: the answers are safe, and their
   * instructor can see this paper.
   */
  it('tells a learner whose marking never happened that the answers are safe and who can help', async () => {
    held.request.mockImplementation(async (method: string) =>
      method === 'GET' ? view({ attemptsUsed: 1, attemptsLeft: 2, paper: returned }) : submission(),
    );
    await mount();

    const said = root.querySelector('[data-testid="quiz-returned-help"]')!;
    expect(said).not.toBeNull();
    expect(said.textContent).toBe(RETURNED_SHEET_HELP_LINE);
    expect(said.textContent).toMatch(/instructor/i);
    // Still one action, and the sentence adds no second one.
    expect([...root.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'))).toEqual([
      'quiz-hand-in',
    ]);
    // An outage the learner did not cause is not an error at the learner.
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-error"]')).toBeNull();
    expect(said.getAttribute('role')).toBeNull();
    // And it is said out loud, politely, through the room's one region.
    expect(root.querySelector('[data-testid="quiz-live"]')!.textContent).toContain(
      RETURNED_SHEET_HELP_LINE,
    );
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('says none of that over an open paper, which nobody has failed to mark', async () => {
    held.request.mockImplementation(async () => view({ paper }));
    await mount();

    expect(root.querySelector('[data-testid="quiz-returned-help"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-live"]')!.textContent).toBe('');
  });

  it('states a cooldown as a fact and never as a countdown', async () => {
    held.request.mockImplementation(async () => view({ attemptsUsed: 1, cooldownSecondsLeft: 300 }));
    await mount();
    expect(root.querySelector('[data-testid="quiz-start"]')).toBeNull();
    expect(root.textContent).toContain('Another paper can be started in about 5 minutes.');
    expect(root.textContent).not.toMatch(/\d+:\d\d/);
  });

  /* ------------ every paper handed in, and none of them a pass ------------ */

  /**
   * The state a learner cannot leave on their own.
   *
   * `needsInstructorReset` is the API's own answer over the rows
   * (`attemptsLeft === 0` and this task's row not passed) and a teacher's
   * per-task **reset** is the whole of the way out of it. What the room owes a
   * learner here is the truth in three parts: that there is no paper left, that
   * nothing they did has been thrown away, and who can give them another go.
   */
  /**
   * After a teacher's Sign off the room must not read a bare "Best score 50%"
   * beside two papers marked 0 of 2: the 50 is the sign-off's credit at the
   * pass mark, which no paper earned. `passCredited` is the API's word for
   * exactly that (the row reads passed and no paper has a pass the gate
   * accepts), and the room says whose number it is.
   */
  it('says a best score that only a teacher’s sign-off gave is a credit, not a paper’s mark', async () => {
    held.request.mockImplementation(async () =>
      view({
        required: true,
        status: 'passed',
        attemptsUsed: 2,
        attemptsLeft: 0,
        bestScore: 50,
        passMark: 50,
        passCredited: true,
        needsInstructorReset: true,
      }),
    );
    await mount();

    const best = root.querySelector('[data-testid="quiz-best-score"]')!;
    expect(best.textContent).toContain(`50%, ${CREDIT_WORD}`);
    const said = root.querySelector('[data-testid="quiz-credited"]')!;
    expect(said.textContent).toBe(CREDITED_LINE);
    expect(said.textContent).toMatch(/none of your papers has passed/i);
  });

  it('reads a best score a paper earned as it always has', async () => {
    held.request.mockImplementation(async () =>
      view({ status: 'passed', attemptsUsed: 1, attemptsLeft: 2, bestScore: 100 }),
    );
    await mount();

    expect(root.querySelector('[data-testid="quiz-best-score"]')!.textContent).toContain('100%');
    expect(root.textContent).not.toContain(CREDIT_WORD);
    expect(root.querySelector('[data-testid="quiz-credited"]')).toBeNull();
  });

  it('says the papers have run out, says nothing is lost, and names who can help', async () => {
    held.request.mockImplementation(async () =>
      view({ required: true, attemptsUsed: 3, attemptsLeft: 0, bestScore: 40, needsInstructorReset: true }),
    );
    await mount();

    const said = root.querySelector('[data-testid="quiz-needs-reset"]')!;
    expect(said).not.toBeNull();
    expect(said.textContent).toContain(NO_PAPERS_TITLE);
    expect(said.textContent).toContain(noPapersNextLine(true));
    // Their instructor, in as many words, and the promise that the papers stay.
    expect(said.textContent).toMatch(/instructor/i);
    // No dead control: the Start button would be refused by name, so it is not
    // drawn, and neither is the older sentence, which says the best score is
    // the one that counts and stops there.
    expect(root.querySelector('[data-testid="quiz-start"]')).toBeNull();
    expect(root.textContent).not.toContain('You have used every attempt on this quiz');
    // An expected state is not an error. Nothing here is alarmed at the learner.
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-error"]')).toBeNull();
  });

  it('tells an optional quiz’s learner that nothing else is waiting on it', async () => {
    held.request.mockImplementation(async () =>
      view({ required: false, attemptsUsed: 2, attemptsLeft: 0, needsInstructorReset: true }),
    );
    await mount();

    expect(root.querySelector('[data-testid="quiz-needs-reset"]')!.textContent).toContain(
      noPapersNextLine(false),
    );
    expect(root.textContent).not.toContain('the phase stays shut');
  });

  it('keeps the passed-quiz sentence for a spent quiz the learner has already passed', async () => {
    // `needsInstructorReset` is false on a passed quiz (a learner who is
    // through is not waiting for anybody) and absent altogether on an older
    // payload. Both read as *not in that state*.
    held.request.mockImplementation(async () =>
      view({ status: 'passed', attemptsUsed: 3, attemptsLeft: 0, bestScore: 80, needsInstructorReset: false }),
    );
    await mount();

    expect(root.querySelector('[data-testid="quiz-needs-reset"]')).toBeNull();
    expect(root.textContent).toContain('You have used every attempt on this quiz');
    expect(root.querySelector('[data-testid="quiz-start"]')).toBeNull();
  });

  it('offers a fresh paper once the teacher’s reset has landed', async () => {
    held.request.mockImplementation(async () =>
      view({ required: true, attemptsUsed: 3, attemptsLeft: 0, needsInstructorReset: true }),
    );
    await mount();
    expect(root.querySelector('[data-testid="quiz-start"]')).toBeNull();

    // The reset starts a new attempt epoch: the counters come back, the flag
    // clears, and the learner returning to the room is offered a paper again:
    // labelled as a first paper, because on this run it is one.
    held.request.mockImplementation(async () =>
      view({ required: true, attemptsUsed: 0, attemptsLeft: 3, bestScore: null, needsInstructorReset: false }),
    );
    // A new key, which is the learner coming back to the room: the counters are
    // the API's to say and the room asks again rather than holding a flag.
    await act(async () => {
      tree.render(<QuizRoom key="after-the-reset" phaseId="p4" taskKey="concepts" />);
    });

    expect(root.querySelector('[data-testid="quiz-needs-reset"]')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="quiz-start"]')!.textContent).toContain(
      'Start the quiz',
    );
  });

  /**
   * After a reset, and why the room needs a fact the quiz route does not carry.
   *
   * Everything the room reads from `GET …/quiz` is scoped to the attempt epoch,
   * which is exactly what hands the attempts back: `attemptsUsed` is 0,
   * `attemptsLeft` is the whole limit, `bestScore` is null because the reset
   * cleared it with the pass it belonged to, and `lastSubmissionId` is null
   * because no paper of this run has been handed in. Those are the same four
   * readings a learner gets on a quiz nobody has ever opened, and the locked
   * room promised the opposite, that every paper they handed in stays in
   * their record. So the two facts that are **not** scoped to the run come
   * from the task's own row, which the page already holds.
   */
  it('says a reset happened, so a fresh run is not drawn as a quiz nobody opened', async () => {
    held.request.mockImplementation(async () =>
      view({ required: true, attemptsUsed: 0, attemptsLeft: 3, bestScore: null }),
    );
    await mount({ resetAt: '2026-09-20T08:00:00.000Z', papersInRecord: 3 });

    const said = root.querySelector('[data-testid="quiz-was-reset"]');
    expect(said).not.toBeNull();
    expect(said!.textContent).toBe(RESET_NOTICE_LINE);
    // Said where the counters it accounts for are said, and not in a corner of
    // its own: the sentence is there to explain the zero above it.
    expect(root.querySelector('[data-testid="quiz-header"]')!.contains(said!)).toBe(true);
    expect(root.querySelector('[data-testid="quiz-attempts-available"]')!.textContent).toBe(
      '0 papers handed in. 3 attempts left.',
    );
    // A teacher helping is not an error, and the room is not alarmed at it.
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-error"]')).toBeNull();
  });

  it('says nothing about a reset on a quiz that has never been reset', async () => {
    held.request.mockImplementation(async () => view({ attemptsUsed: 0, attemptsLeft: 3 }));
    await mount({ resetAt: null, papersInRecord: 0 });

    expect(root.querySelector('[data-testid="quiz-was-reset"]')).toBeNull();
    expect(root.textContent).not.toContain('reset this quiz');
  });

  it('stops saying it once a paper of the new run is in, because the counters say it', async () => {
    held.request.mockImplementation(async () =>
      view({ attemptsUsed: 1, attemptsLeft: 2, bestScore: 50, lastSubmissionId: null }),
    );
    await mount({ resetAt: '2026-09-20T08:00:00.000Z', papersInRecord: 4 });

    // One paper of this run is in the counters, so they do not read as a
    // quiz nobody opened and the sentence has nothing left to account for.
    expect(root.querySelector('[data-testid="quiz-was-reset"]')).toBeNull();
    expect(root.querySelector('[data-testid="quiz-attempts-available"]')!.textContent).toBe(
      '1 paper handed in. 2 attempts left.',
    );
  });

  it('says nothing to a learner whose reset took nothing away from them', async () => {
    // A teacher may reset a task the learner never handed anything in on. The
    // record the sentence is about is empty, so the sentence would be about
    // nothing, and telling a learner their papers are kept when they have
    // none is the same kind of lie in the other direction.
    held.request.mockImplementation(async () => view({ attemptsUsed: 0, attemptsLeft: 3 }));
    await mount({ resetAt: '2026-09-20T08:00:00.000Z', papersInRecord: 0 });

    expect(root.querySelector('[data-testid="quiz-was-reset"]')).toBeNull();
  });
});

/* --------------------------- what the room says --------------------------- */

/**
 * The room's own announcer, and why it is one region rather than several.
 *
 * A live region that arrives with its sentence already inside it is not
 * reliably read out: the region has to be in the accessibility tree before the
 * text changes. `QuizResult` does that for the score; the room's two
 * sentences (the interim *Marking your paper.* and the one that says the
 * papers have run out) are the same case, and must not be created together
 * with their words. So the room carries **one** region, mounted with the room
 * and filled a commit later, and every visible copy of those sentences is an
 * ordinary paragraph beside it.
 */
describe('the room’s announcer', () => {
  let root: HTMLElement;
  let tree: Root;

  beforeEach(() => {
    held.request.mockReset();
    held.getSubmission.mockReset();
    held.hold = false;
    held.release = null;
    root = document.createElement('div');
    document.body.append(root);
    tree = createRoot(root);
  });

  afterEach(() => {
    held.release?.();
    // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
    expect(root.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
    act(() => tree.unmount());
    root.remove();
  });

  const mount = async () => {
    await act(async () => {
      tree.render(<QuizRoom phaseId="p4" taskKey="concepts" />);
    });
  };

  it('puts the interim line into a region that was already on the page', async () => {
    held.hold = true;
    let reads = 0;
    held.request.mockImplementation(async (method: string) => {
      if (method !== 'GET') return submission();
      reads += 1;
      return reads === 1 ? view({ paper }) : view({ attemptsUsed: 1, attemptsLeft: 2, lastSubmissionId: 's1' });
    });
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    const live = root.querySelector('[data-testid="quiz-live"]')!;
    expect(live).not.toBeNull();
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');

    const pick = root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B1}"]`)!;
    await act(async () => pick.click());
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click());

    // The same node, now holding the sentence: the message is a change inside a
    // region the screen reader is already watching, not a node that appears
    // with its words in it.
    expect(root.querySelector('[data-testid="quiz-live"]')).toBe(live);
    expect(live.textContent).toBe(MARKING_LINE);
    // The sentence a sighted learner reads is a plain paragraph, so the room
    // announces it once.
    const visible = root.querySelector('[data-testid="quiz-marking"]')!;
    expect(visible.textContent).toBe(MARKING_LINE);
    expect(visible.getAttribute('role')).toBeNull();
    expect(visible.getAttribute('aria-live')).toBeNull();
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);

    await act(async () => {
      held.release?.();
    });
  });

  it('says out loud that the last paper has gone in, through that same region', async () => {
    let reads = 0;
    held.request.mockImplementation(async (method: string) => {
      if (method !== 'GET') return submission();
      reads += 1;
      return reads === 1
        ? view({ required: true, attemptsUsed: 2, attemptsLeft: 1, paper })
        : view({
            required: true,
            attemptsUsed: 3,
            attemptsLeft: 0,
            bestScore: 50,
            lastSubmissionId: 's1',
            needsInstructorReset: true,
          });
    });
    held.getSubmission.mockResolvedValue(submission());
    await mount();

    const live = root.querySelector('[data-testid="quiz-live"]')!;
    expect(live.textContent).toBe('');

    const pick = root.querySelector<HTMLInputElement>(`[data-testid="quiz-option-boundary-${B1}"]`)!;
    await act(async () => pick.click());
    await act(async () => root.querySelector<HTMLButtonElement>('[data-testid="quiz-hand-in"]')!.click());

    expect(root.querySelector('[data-testid="quiz-live"]')).toBe(live);
    expect(live.textContent).toBe(`${NO_PAPERS_TITLE}. ${noPapersNextLine(true)}`);
    // The marked paper is drawn beside it, and its own region carries the
    // score: two facts, two sentences, neither of them said twice.
    expect(root.querySelector('[data-testid="quiz-result"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="quiz-needs-reset"]')).not.toBeNull();
  });
});

/* ------------------------- which quiz the room opens ---------------------- */

describe('which quiz a room opens on', () => {
  const tasks = [
    { key: 'main', artefactType: 'code' },
    { key: 'concepts', artefactType: 'quiz' },
    { key: 'extra', artefactType: 'quiz' },
  ];

  it('honours the key the link named', () => {
    expect(quizTaskKey(tasks, 'extra')).toBe('extra');
  });

  it('falls back to the phase’s first quiz for a key the version no longer declares', () => {
    expect(quizTaskKey(tasks, 'gone')).toBe('concepts');
    expect(quizTaskKey(tasks, null)).toBe('concepts');
  });

  it('answers nothing for a phase with no quiz at all', () => {
    expect(quizTaskKey([{ key: 'main', artefactType: 'code' }], null)).toBeUndefined();
  });
});

/* -------------- the answer door beside a quiz, on screen ------------------ */

/**
 * A quiz added beside a code task must not withdraw the answer door from a
 * learner who has already passed the work and earned it. The API's
 * `WorkflowService.solutionMeta` scopes the door to the phase's sole non-quiz
 * task rather than answering unavailable whenever a phase has more than one
 * task. `PhaseTaskView.solution` exists and nothing in `apps/web` reads it:
 * every learner surface for the door is phase-level and asks `solutionDoorOpen`,
 * which reads only the phase's status and the detail's `solution`.
 */
describe('the answer door a learner had already earned', () => {
  const summary: PhaseSummary = {
    id: 'p3',
    key: 'implementation',
    order: 3,
    title: 'Implementation',
    status: 'passed',
    bestScore: 88,
    attempts: 3,
    reflection: null,
    passedAt: '2026-09-18T10:00:00.000Z',
    opensAt: null,
    dueAt: null,
  };

  const task = (over: Partial<PhaseTaskView> & { key: string; order: number }): PhaseTaskView =>
    taskView({ artefactType: 'code', evidence: 'automated', status: 'passed', attempts: 2, bestScore: 88, passedAt: '2026-09-18T10:00:00.000Z', lastSubmissionId: 's9', ...over });

  it('is still open on a passed code phase whose detail holds a quiz', () => {
    const detail = {
      ...summary,
      place: 3,
      count: 6,
      rubric: { passThreshold: 70, criteria: [] },
      files: [],
      solution: { available: true, files: 3, readAt: null },
      tasks: [
        task({ key: 'main', order: 1 }),
        task({ key: 'concepts', order: 2, artefactType: 'quiz', required: false, status: 'in_progress' }),
      ],
    } as unknown as PhaseDetail;

    expect(solutionDoorOpen(detail)).toBe(true);
  });
});
