'use client';

/**
 * The paper: one page of questions, answered with the controls the platform
 * already gives away for free.
 *
 * Accessibility here is the specification and not a review note, so the
 * reasons are written beside the elements:
 *
 * - **`<fieldset>` and `<legend>` per question**, with the stem as the legend,
 *   so a screen reader announces the question again with every option rather
 *   than reading five unattached phrases.
 * - **Native `<input type="radio">` and `<input type="checkbox">`, never a
 *   `div` with `role="radio"`.** Arrow-key traversal inside a radio group,
 *   Space on a checkbox, the focus ring, the forced-colours outline and the
 *   grouping semantics are all free from the platform and all expensive to
 *   re-implement correctly. Which control is drawn comes from the paper's
 *   `multiple` flag, so a question that accepts several answers never offers a
 *   control that silently drops one.
 * - **One page, no auto-advance**, so a learner can read the whole paper, go
 *   back and change an answer before handing it in.
 * - **A real `<button>` inside a real `<form>`**, so Enter from any field
 *   submits and the control is reachable by keyboard without a handler.
 * - **No timer anywhere.** Nothing counts down while a learner reads: there is
 *   no per-question clock in the model at all, and the cooldown between papers
 *   is a fact the room states, never a countdown it runs.
 *
 * **Two papers, and the second one is read-only.** The mainline is the paper a
 * learner has open. The other is a sheet they already handed in whose marking
 * never happened, offered back so they can hand it in again; `handedInAt` is
 * how the two are told apart, and everything that follows from it is at
 * {@link RETURNED_SHEET_LINE}.
 */

import { useId, useMemo } from 'react';
import { PlainText } from '@/components/PlainText';
import { Button, Chip, Notice } from '@/components/ui';
import type { QuizAnswers, QuizOpenPaper } from './contract';

/**
 * The sheet nobody marked, said in the room it is drawn in.
 *
 * A paper carrying `handedInAt` is one the learner already handed in and whose
 * marking never happened: the queue refused the job, or a stall age-out or a
 * pipeline failure wrote the revision off. The API offers it back so the
 * learner can hand it in again for an outage they did not cause.
 *
 * **It has to be drawn read-only, and the sentence is part of that.** The
 * route grades the answers already stored on the row: `handIn` writes a sheet
 * only while the row is open, so anything typed over them would be taken and
 * discarded without a word. Live inputs would make that a silent loss of a
 * whole paper, which is why the controls below are `disabled`, a real
 * disabled control, not a `busy` that lifts, and why the sentence says what
 * happened, that the answers are the record's, and what the button now does.
 */
export const RETURNED_SHEET_LINE =
  'This is the paper you handed in. Its marking did not finish, so it has not been scored. The answers below are the ones in your record and cannot be changed. Hand it in again to have it marked.';

/**
 * Where an open paper's answers live, said where the learner can act on it.
 *
 * The attempt is open on the server and is resumable; the **answers** are this
 * page's state until the paper is handed in, and the read on the way back in
 * reseeds from `paper.selected`, which an open paper does not carry. Leaving
 * and returning therefore gives a learner their paper back blank. That is true
 * of the header's way back and of the crumbs, and the room carries a task
 * panel whose rows read as movement inside the phase: so the
 * page states it rather than losing half a paper without a word.
 */
export const ANSWERS_KEPT_LINE = 'Your answers stay on this page until you hand in.';

/** How many of the paper's questions have at least one option picked. */
export function answeredCount(paper: QuizOpenPaper, answers: QuizAnswers): number {
  return paper.questions.filter((question) => (answers[question.id] ?? []).length > 0).length;
}

/**
 * What is left to answer, said as a fact rather than as a warning.
 *
 * A blank is scored wrong, so it is worth naming: but a learner is allowed to
 * hand in an incomplete paper, and a control that refused would be a second
 * gate nobody asked for.
 *
 * On a sheet already in the record there is nothing *still* to answer, and the
 * same count has to be read in the past tense: the blanks are blanks, and
 * asking for them would be asking for something the controls will not take.
 */
export function remainingLine(total: number, answered: number, handedIn = false): string {
  const left = total - answered;
  if (left === 0) return `All ${total} answered.`;
  if (handedIn) {
    return left === total ? `${total} questions, all left blank.` : `${left} of ${total} left blank.`;
  }
  if (left === total) return `${total} questions, none answered yet.`;
  return left === 1 ? `1 of ${total} still to answer.` : `${left} of ${total} still to answer.`;
}

export function QuizPaper({
  paper,
  answers,
  onChange,
  onHandIn,
  busy,
}: {
  paper: QuizOpenPaper;
  answers: QuizAnswers;
  onChange: (answers: QuizAnswers) => void;
  onHandIn: () => void;
  /**
   * The sheet is in flight. This is an **open** paper's whole lock: the Hand
   * in control goes off and the form refuses a second submit. The questions
   * stay live, because disabling them would take a keyboard learner out of the
   * tab order mid-request, and the room puts the paper away the moment the
   * sheet is in the record.
   *
   * It is not the lock a re-offered sheet needs and must not be mistaken for
   * one: `busy` is a moment that passes, and a paper already in the record can
   * never be typed into again. That one is `disabled`, off `handedInAt`.
   */
  busy: boolean;
}) {
  const group = useId();
  const answered = useMemo(() => answeredCount(paper, answers), [paper, answers]);
  // Already in the record, and being offered back because nothing marked it.
  // The field is present only when it is true, so there is no way to read it
  // the wrong way round.
  const handedIn = Boolean(paper.handedInAt);

  const pick = (questionId: string, optionId: string, multiple: boolean, on: boolean) => {
    const held = answers[questionId] ?? [];
    if (!multiple) {
      onChange({ ...answers, [questionId]: on ? [optionId] : [] });
      return;
    }
    const next = on ? [...held.filter((id) => id !== optionId), optionId] : held.filter((id) => id !== optionId);
    onChange({ ...answers, [questionId]: next });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3.5"
      data-testid="quiz-paper"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onHandIn();
      }}
    >
      {handedIn && (
        // Before the questions, so it is met before the sheet it describes:
        // by a screen reader as much as by an eye. Informational rather than
        // failed: the paper is safe, and nothing here is the learner's doing.
        <Notice tone="info" testId="quiz-returned">
          {RETURNED_SHEET_LINE}
        </Notice>
      )}
      {paper.questions.map((question, index) => {
        const picked = answers[question.id] ?? [];
        return (
          <fieldset
            key={question.id}
            className="flex min-w-0 flex-col gap-2 rounded-panel border-1.5 border-edge bg-surface p-3"
            data-testid={`quiz-question-${question.id}`}
          >
            {/* The stem is the legend, so the question is announced with every
                option below it. The number and the "pick one" or "pick every"
                instruction are part of it for the same reason. */}
            <legend className="flex min-w-0 flex-col gap-1 px-1">
              <span className="label-sm">
                Question {index + 1} of {paper.questions.length}
              </span>
              <PlainText className="text-[13.5px] leading-[1.65] text-ink" text={question.stem} commentsHidden />
              <span className="label-sm" data-testid={`quiz-how-${question.id}`}>
                {question.multiple ? 'Pick every answer that applies.' : 'Pick one answer.'}
              </span>
            </legend>
            <ul className="flex min-w-0 list-none flex-col gap-1.5 p-0">
              {question.options.map((option) => {
                const id = `${group}-${question.id}-${option.id}`;
                const on = picked.includes(option.id);
                return (
                  <li key={option.id} className="min-w-0">
                    <label
                      htmlFor={id}
                      className={`flex min-w-0 items-start gap-2.5 rounded-ctl border-1.5 px-2.5 py-2 transition-colors ${
                        handedIn
                          ? // Nothing here can be clicked, so nothing here
                            // offers to be. The learner's own picks keep the
                            // one mark on the paper.
                            `${on ? 'border-accent bg-tint' : 'border-edge'}`
                          : 'cursor-pointer border-edge hover:border-edge2'
                      }`}
                    >
                      <input
                        id={id}
                        type={question.multiple ? 'checkbox' : 'radio'}
                        name={`${group}-${question.id}`}
                        value={option.id}
                        checked={on}
                        // A real disabled control, and deliberately not the
                        // `busy` lock above: `busy` lifts, and this does not.
                        // The route grades the sheet already in the record, so
                        // an input that accepted a change here would be taking
                        // an answer it knows will be thrown away.
                        disabled={handedIn}
                        className="mt-0.5 shrink-0"
                        data-testid={`quiz-option-${question.id}-${option.id}`}
                        onChange={(event) => pick(question.id, option.id, question.multiple, event.target.checked)}
                      />
                      <PlainText className="flex-1 text-[13px] leading-[1.65] text-ink" text={option.text} commentsHidden />
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="submit" busy={busy} busyLabel="Handing in" testId="quiz-hand-in">
          {handedIn ? 'Hand in again' : 'Hand in'}
        </Button>
        <Chip tone="outline" testId="quiz-remaining">
          {remainingLine(paper.questions.length, answered, handedIn)}
        </Chip>
        {!handedIn && (
          // Both belong to a paper that can still be answered. On a sheet
          // already written there is no time left to take and no answer left
          // to lose: its answers are the record's.
          <>
            <span className="label-sm" data-testid="quiz-no-clock">
              Nothing is timed. Take as long as you need.
            </span>
            <span className="label-sm" data-testid="quiz-kept-here">
              {ANSWERS_KEPT_LINE}
            </span>
          </>
        )}
      </div>
    </form>
  );
}
