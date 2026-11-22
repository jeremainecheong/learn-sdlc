import { BadRequestException } from '@nestjs/common';
import type {
  AiRubricReview,
  QuizChecks,
  QuizQuestion,
  QuizQuestionResult,
  QuizRevealExplanation,
} from '@learnsdlc/shared';
import type { CompiledTask } from '../content/pack-compiler';
import { optionToken } from '../quiz/quiz-attempts.service';
import { quizPassed } from './strict-evidence';

/*
 * A quiz paper from hand-in to report: the refusals a hand-in can earn, the
 * scoring of a sheet against the sealed key, the door that releases
 * explanations, the renaming into the paper's own option tokens, and the
 * review a quiz report carries where a model's verdict would be. Pure: no
 * repository and no service.
 */

/* --------------- a quiz is handed in as a paper, or not at all ------------- */

/**
 * A quiz task named on a submit that carries no paper.
 *
 * **The layer no client can walk around.** The IDE room's Submit sends the
 * selected task's key, and `chooseTask` selects *the first required task still
 * to pass, then the first task still to pass*, so a required quiz ordered
 * first is selected before the learner has written a line, and ⌘↵ would hand
 * it in: a real `submissions` row on a quiz task, two counters spent, and a
 * verdict enqueued with no sheet to score. The room's opening selection skips
 * quizzes and the panel routes to the quiz room, and both of those are
 * behaviour a saved script or a stale tab is not bound by. This is the one that
 * is.
 */
export function quizNeedsAPaperRefusal(task: CompiledTask): BadRequestException {
  return new BadRequestException(
    `"${task.title}" is a quiz. Open it and answer the paper — a quiz is handed in from the quiz itself, not from Submit.`,
  );
}

/**
 * A paper named on a task that is not a quiz.
 *
 * Refused rather than ignored: a caller that thinks it is handing in a paper
 * and is in fact submitting an artefact has misunderstood something, and a
 * silently dropped argument is how that misunderstanding reaches a learner's
 * record.
 */
export function notAQuizRefusal(task: CompiledTask): BadRequestException {
  return new BadRequestException(
    `"${task.title}" is not a quiz, so it cannot be handed in as a paper.`,
  );
}

/**
 * The paper named is not this learner's latest handed-in sheet on this task.
 *
 * **One sentence for four facts**, and deliberately: an id that does not exist,
 * an id belonging to somebody else, a paper still open and a paper already
 * superseded each read the same, so a refusal is not an oracle a caller can
 * probe a table with. It is the same rule the scoring refusals follow.
 */
export const QUIZ_PAPER_REFUSAL =
  'That paper is not the one waiting to be handed in on this quiz. Open the quiz and answer the paper that is there.';

/** What one scored paper came to, before the seal decides what is released. */
export interface ScoredPaper {
  correctCount: number;
  drawn: number;
  questions: QuizQuestionResult[];
}

/**
 * Score a sheet against the pinned version's sealed key.
 *
 * **Exact set equality over option ids**, and over ids rather than indices,
 * which is what makes a shuffled paper and an unshuffled one score identically
 * on the same picks. No partial credit: partial credit on a
 * multiple-answer question needs a policy and a teacher control, and
 * all-or-nothing is the rule every learner already expects.
 *
 * **One pass, and no early return.** Every drawn question is compared whether
 * or not the sheet is already lost, and the per-question comparison counts
 * matches rather than stopping at the first miss. The verdict is produced by
 * the submission job rather than by the request, so this is belt and braces,
 * and it is the cheap half of the promise that an answer sheet's handling
 * carries no information about the key.
 *
 * `explanation` and `concept` come back **filled**; `releaseExplanations`
 * decides whether the learner reads them. `correct` never leaves this
 * function in any form but the word `right` or `wrong`.
 */
export function scorePaper(
  checks: QuizChecks,
  paper: readonly { questionId: string; optionIds: string[] }[],
  answers: Record<string, string[]>,
): ScoredPaper {
  const pool = new Map<string, QuizQuestion>(
    checks.questions.map((question) => [question.id, question]),
  );
  const questions: QuizQuestionResult[] = [];
  let correctCount = 0;
  for (const drawn of paper) {
    const question = pool.get(drawn.questionId);
    if (!question) {
      // The pin is on the attempt row, so this is only reachable across a
      // re-pin, and a paper asking a question the pinned version no longer
      // declares is refused by name rather than scored against a guess.
      throw new Error(
        `this paper asks ${drawn.questionId}, which the pinned version of this quiz no longer declares`,
      );
    }
    const byId = new Map(question.options.map((option) => [option.id, option]));
    const selected = answers[question.id] ?? [];
    const picked = new Set(selected);
    const wanted = new Set(question.correct);
    const matched = [...wanted].filter((id) => picked.has(id)).length;
    const right = matched === wanted.size && picked.size === wanted.size;
    correctCount += right ? 1 : 0;
    // The pinned version's texts as stored: a reader converts the result where it serves it (`learnerReport`), so a
    // report is read the same way whenever it was stored, and the results export pays for no conversion.
    questions.push({
      id: question.id,
      stem: question.stem,
      // The options as **this paper** drew them, in display order, so the
      // report redraws the paper that was taken rather than the pool's order.
      options: drawn.optionIds
        .map((id) => byId.get(id))
        .filter((option): option is NonNullable<typeof option> => !!option)
        .map((option) => ({ id: option.id, text: option.text })),
      selected: [...picked],
      // A word, never a `correct: boolean`. The key is the one thing that
      // never leaves the API, and a field of that name in a learner payload
      // would make the seal unassertable by substring.
      outcome: right ? 'right' : 'wrong',
      explanation: question.explanation,
      concept: question.concept ?? null,
    });
  }
  return { correctCount, drawn: paper.length, questions };
}

/** A scored paper's mark: the share of drawn questions answered right, as a whole percentage. */
export function paperPercent(scored: Pick<ScoredPaper, 'correctCount' | 'drawn'>): number {
  return scored.drawn ? Math.round((100 * scored.correctCount) / scored.drawn) : 0;
}

/**
 * The answer door for an explanation.
 *
 * Right or wrong is always released; the key never is; and the explanation is
 * released when the learner is **finished with that question**:
 *
 * - their paper **passed**, there is nothing left to work out;
 * - their attempts are **spent**, there is no next paper to protect;
 * - the quiz is **formative**: optional, with no limit, where telling them
 *   straight away is the whole point of setting it.
 *
 * Computed here from the attempt row and the task, never sent as a flag a
 * browser could flip. A learner who is not finished reads `null`, and a pool's
 * **undrawn** explanations are not in this list at all, because the list is
 * built from the paper.
 *
 * A teacher's reveal choice (`reveal` below) applies to an optional quiz
 * only; a required quiz has no reveal-on-a-failing-attempt control.
 *
 * ---
 *
 * **What the teacher's reset costs, written down rather than left implicit.**
 *
 * The second door's premise (*there is no next paper to protect*) is
 * conditional. `task-reset` (`instructor.service.ts`) starts a new attempt epoch, so there
 * **is** a next paper, and it is drawn from the same sealed pool. Put
 * together:
 *
 * - the last allowed paper of a run always releases the explanation for every
 *   question it drew, because `attemptsLeft` is `max - attemptNumberOf(paper)`;
 * - `QuizRoomView.needsInstructorReset` is a **narrowing** of that same state,
 *   the same two counters, minus the two cases a person cannot help with, so
 *   a learner is only ever sent to a teacher from a state in which the
 *   explanations have just been handed over;
 * - a reset then re-draws, and the new run's first paper **prefers the
 *   questions that last paper did not ask** (`drawPaper`): it
 *   repeats `max(0, 2·drawn − pool)` of the questions whose explanations were
 *   just released, and none at all once the pool is twice the paper. On a pool
 *   only a little larger than `drawn` that is still most of the paper.
 *
 * **This behaviour stands, and stands deliberately.** The three-clause door
 * is a product rule and *attempts spent* is one of its clauses: a learner
 * who has used up a required quiz has earned the explanation for the paper
 * they sat, and that is the whole pedagogical return on a failed run. Nothing
 * here retracts it either: a report already written is the learner's record,
 * and this codebase does not rewrite one behind them.
 *
 * What follows from it is not a code change here but two facts that belong
 * where they are acted on:
 *
 * 1. **The teacher is choosing this**, so the reset control must say so. That
 *    sentence lives beside the lever, not beside the scorer.
 * 2. **The pool is what bounds the overlap.** `quiz-retake-is-a-new-paper`
 *    requires only `drawn < questions.length`; how much larger a required
 *    quiz's pool must be is a policy number, and changing that wall would
 *    refuse content teachers have already authored: a product decision,
 *    not this function's.
 *
 * Pinned by *the explanations a spent run released are not taken back, and a
 * fresh run withholds again* in `quiz-gates.spec.ts`, so if the policy
 * changes, the change is a red test rather than a silent drift.
 */
export function releaseExplanations(
  questions: readonly QuizQuestionResult[],
  gate: {
    passed: boolean;
    attemptsLeft: number | null;
    formative: boolean;
    /**
     * The teacher's reveal rule for an OPTIONAL quiz, from
     * {@link revealRuleFor}. `'always'` opens after every marked paper;
     * `'on-pass'` waits for a pass or the last attempt, even on an unlimited
     * quiz; absent keeps the default rule (`formative` opens).
     */
    reveal?: QuizRevealExplanation;
  },
): QuizQuestionResult[] {
  const open =
    gate.passed ||
    gate.attemptsLeft === 0 ||
    gate.reveal === 'always' ||
    (gate.reveal === undefined && gate.formative);
  return questions.map((question) =>
    open ? { ...question } : { ...question, explanation: null, concept: null },
  );
}

/**
 * The reveal rule a paper is marked under. A required
 * quiz ignores the teacher's choice: its explanations stay sealed until a
 * pass or the last attempt, and authoring refuses the field there anyway, so
 * only an optional quiz's `revealExplanation` reaches `releaseExplanations`.
 */
export function revealRuleFor(
  task: Pick<CompiledTask, 'required'>,
  checks: Pick<QuizChecks, 'revealExplanation'>,
): QuizRevealExplanation | undefined {
  return task.required ? undefined : checks.revealExplanation;
}

/**
 * A scored paper's rows, with every option and every pick named by **that
 * paper's** token rather than the teacher's id.
 *
 * The report is a learner payload, and the options it lists are in the order
 * the paper drew them: named by authored ids, a shuffled paper's report would
 * hand back the order the teacher wrote them in, the key by position, for a
 * teacher who writes the right answer first. So the report speaks the paper's
 * language, the language the learner was shown and answered in: the tokens
 * `quizOpenPaper` served, from the same `optionToken` over the same attempt
 * id, so *"your answer"* on the marked paper is the option they picked. A
 * regrade builds from the same row and names every option identically.
 *
 * Scoring has already happened, in authored ids, by the time this runs; this
 * renames and decides nothing.
 */
export function inPaperTokens(
  attemptId: string,
  questions: readonly QuizQuestionResult[],
): QuizQuestionResult[] {
  return questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({
      id: optionToken(attemptId, question.id, option.id),
      text: option.text,
    })),
    selected: question.selected.map((optionId) => optionToken(attemptId, question.id, optionId)),
  }));
}

/**
 * What a quiz's report says where a model's verdict would be.
 *
 * `FeedbackReport.aiReview` is **not** optional and `buildReport` is its only
 * producer, so "no model was asked" has to be a value. It must not be the
 * `'unavailable'` stub: that word means *a model was asked and did not
 * answer*, it draws the degraded-grading banner over a paper that scored 100,
 * and `strictTaskEvidencePassed`'s first clause refuses it outright, left
 * alone, a perfect quiz would never pass and a deployment with no provider
 * could not pass one at all.
 *
 * `verdict` is `'pass'` on every paper, and the paper's own answer is carried
 * by `met` and `issue` on the criterion. That is what makes
 * `strictTaskEvidencePassed` answer exactly `quizPassed` at the four sites
 * that never call `buildReport`: clause 1 wants a verdict of `pass`, clause 4
 * refuses an unmet criterion or a non-empty issue, and clause 5 reads the one
 * `quiz` check, three tests of one fact.
 *
 * The evidence is built over **the task's own rubric criteria** rather than
 * over a single hard-coded key, so the length conjunct in clause 3 holds by
 * construction rather than by the compile rule agreeing with this function.
 */
export function quizReview(task: CompiledTask, overall: number, passMark: number): AiRubricReview {
  const passed = quizPassed(overall, passMark);
  return {
    provider: 'not-applicable',
    verdict: 'pass',
    summary: passed
      ? 'Scored against the key your teacher sealed with this quiz. No model was asked — a multiple-choice answer is right or wrong by the key.'
      : 'Scored against the key your teacher sealed with this quiz. This paper is below the pass mark. No model was asked — a multiple-choice answer is right or wrong by the key.',
    strengths: [],
    improvements: [],
    processNote: '',
    criteriaEvidence: task.rubric.criteria.map((criterion) => ({
      key: criterion.key,
      met: passed,
      evidence: `${overall}% on this paper, against a pass mark of ${passMark}%.`,
      issue: passed ? '' : 'This paper is below the pass mark.',
      nextStep: passed ? '' : 'Read what you missed, then take it again.',
    })),
  };
}
