/**
 * Quizzes: the sealed checks that score a quiz task, the report a learner
 * gets back, and the HTTP contract of the quiz room.
 */

import type { PhaseStatus } from '../phases';

/* --------------------------------- quizzes -------------------------------- */

/*
 * A quiz is a task of kind `quiz`, and `QuizChecks` is the slice that scores
 * it: it lives in `CompiledTask.checks`, inside `project_versions.compiled`,
 * which is a column the server reads and **never** a learner payload.
 * `taskViews` builds a `PhaseTaskView` field by field and carries `brief`,
 * `objectives`, `files` and `rubric` and nothing else, which is the same
 * construction that keeps hidden tests and the customer interview's answers out
 * of the browser.
 *
 * Two words are load-bearing in the names below, and the reason is a grep.
 * `QuizQuestion.correct` is the sealed key and is the only field in the shared
 * contract that ever holds it. A learner's report says `outcome: 'right' | 'wrong'` and
 * not `correct: boolean`, so *"the string `correct` appears nowhere in a
 * learner-facing payload"* is a sentence a spec can assert over the whole
 * serialised response rather than field by field, which is how the API's seal
 * tests are written. It also matches what the screen draws: a word beside the
 * input, not a colour.
 */

export interface QuizOption {
  id: string;
  /** Plain text. Learner-visible. */
  text: string;
}

export interface QuizQuestion {
  /** Unique within the phase: it is a graded unit's id. `^[a-z][a-z0-9-]{0,31}$`. */
  id: string;
  /** Plain text. Learner-visible. */
  stem: string;
  /** 2..8. Ids unique within the question. */
  options: QuizOption[];
  /**
   * SEALED, and never released to a learner on any route, at any time, passed
   * or failed. A failing hidden test names *what* failed; an MCQ key **is** the
   * passing answer, and the platform's own rule for serving an answer is a
   * gate, a stamp and an audit row (`solution.service.ts`). A learner who wants
   * to understand has `explanation`; a learner who wants to pass has the
   * questions.
   */
  correct: string[];
  /**
   * SEALED until this learner is finished with this question: their attempt
   * passed, their attempts are spent, or the quiz is an optional one with no
   * limit. Computed server-side from the attempt row and `attempts.max`, never
   * sent as a flag a browser could flip.
   */
  explanation: string;
  /** What this question tests, in the teacher's words. Released with `explanation`. */
  concept?: string;
}

export interface QuizChecks {
  kind: 'quiz';
  questions: QuizQuestion[];
  /**
   * How many of `questions` one paper draws. Absent draws them all, in order:
   * which `quiz-retake-is-a-new-paper` refuses on a *required* quiz, because a
   * whole-pool draw plus a retake is the same paper twice.
   *
   * A subset is seeded per paper and **prefers the questions the learner's
   * last paper did not ask**, the previous paper of the run, or the paper a
   * teacher's reset ended the last run on, so a retake repeats
   * `max(0, 2·drawn − questions.length)` of them and is never that paper's
   * set again.
   */
  drawn?: number;
  shuffleOptions: boolean;
  /** 0..100. `DEFAULT_QUIZ_PASS_MARK` when the teacher names none. */
  passMark: number;
  /**
   * `max: null` is unlimited and is refused on a required quiz by
   * `quiz-retake-is-a-new-paper`. The default the editor writes is
   * `{ max: 3, cooldownSeconds: null }` on a required quiz and
   * `{ max: null, cooldownSeconds: null }` on an optional one.
   */
  attempts: { max: number | null; cooldownSeconds: number | null };
  /** The single rubric key this quiz scores. `'concepts'` by default. */
  criterion: string;
  // The practice-quiz reveal.
  /**
   * When an **optional** quiz releases its explanations:
   *
   * - `'on-pass'`: after a pass, or when the attempts run out;
   * - `'always'`: after every marked paper.
   *
   * Absent keeps the default rule (a pass or the last attempt releases them,
   * and an unlimited optional quiz releases them after every paper). A
   * required quiz ignores the field at runtime and refuses it at authoring.
   */
  revealExplanation?: QuizRevealExplanation;
}

/** The two reveal rules a teacher can choose for an optional quiz. */
export type QuizRevealExplanation = 'on-pass' | 'always';

/** Every `QuizRevealExplanation`, in the order the editor offers them: the one list a DTO's `@IsIn` reads. */
export const QUIZ_REVEAL_EXPLANATIONS: readonly QuizRevealExplanation[] = ['on-pass', 'always'];

/** One drawn question, as the learner's own scored report shows it back. */
export interface QuizQuestionResult {
  /** The question's id, which is also its graded unit's id. */
  id: string;
  /** The stem, so the report redraws the paper that was taken. */
  stem: string;
  /**
   * The options as this paper drew them, in display order. Never marked.
   *
   * Each `id` is **the paper's token** for the option, the same token
   * `QuizOpenPaper` served it by, and never the id the teacher wrote, which
   * is the order they wrote the options in. Opaque: a client
   * matches it against `selected` and nothing else.
   */
  options: QuizOption[];
  /** The options this learner picked, by the same per-paper tokens as `options`. */
  selected: string[];
  /**
   * Right or wrong, as a word. Deliberately not a `correct: boolean`: the key
   * is the one thing that never leaves the API, and a field of that name in a
   * learner payload would make the seal unassertable by substring.
   */
  outcome: 'right' | 'wrong';
  /** Released under `QuizQuestion.explanation`'s rule; null while still sealed. */
  explanation: string | null;
  /** Released with `explanation`; null while still sealed. */
  concept: string | null;
}

/**
 * The per-question half of a scored quiz, carried as a **section** rather than
 * as checks.
 *
 * `report.checks` is quantified over by `strictTaskEvidencePassed`, which
 * `advance`, project completion and three instructor readers ask of a *stored*
 * report long after `buildReport` has finished with it. One `failed` check per
 * wrong answer would make 100% the real pass mark for ever, silently replacing
 * the teacher's. So the paper contributes exactly one `FeedbackCheck` (id
 * `quiz`) and everything a learner reads per question rides here, in the idiom
 * `contract`, `ci`, `drill` and `impact` already use. Nothing quantifies over
 * an optional section.
 */
export interface QuizReport {
  /** How many drawn questions were right. */
  correctCount: number;
  /** How many were drawn: the denominator `overall` was rounded from. */
  drawn: number;
  /** The mark this paper was judged against, 0..100. */
  passMark: number;
  /**
   * Which attempt of this task's quiz this paper was, 1-based.
   *
   * **As of the paper, not as of now.** Counted over the closed papers of this
   * paper's own attempt epoch handed in no later than it was, so a regrade
   * months and two papers later still reads the number that was true when this
   * sheet went in. Numbering restarts at 1 after a teacher's reset, because
   * that is what a returned attempt means.
   */
  attempt: number;
  /**
   * Attempts left after this one; null when the teacher set no limit.
   *
   * As-of, for the same reason and with sharper consequences: `attemptsLeft
   * === 0` is one of the three doors `releaseExplanations` opens on, so a
   * number read at regrade time could release explanations the revision being
   * regraded withheld.
   */
  attemptsLeft: number | null;
  /** One row per drawn question, in the order the paper drew them. */
  questions: QuizQuestionResult[];
}

/* --------------------- the quiz room's HTTP contract --------------------- */

/*
 * The three shapes the learner's quiz routes serve.
 *
 * They live here rather than as two declarations written to agree by hand
 * (one in `apps/api/src/quiz/quiz.dto.ts`, one in
 * `apps/web/components/workspace/quiz/contract.ts`): with two copies, each
 * side's specs would hold only its own, and a field renamed on either side
 * would be `undefined` in the room at runtime with both suites green. Here
 * the compiler holds them together, exactly as it does every other payload
 * both halves read.
 *
 * **The seal is structural, not filtered.** `QuizPaperQuestion` has no field a
 * key or an explanation could travel in, so *"the answer key is not on this
 * route"* is a statement about the type rather than about the care taken at a
 * call site. See `QuizQuestion` for the three-tier rule these are the top tier
 * of.
 */

/**
 * One drawn question, as a learner reads it: the stem, and the options in the
 * order **this paper** drew them.
 *
 * Nothing marks an option. A learner submits option **ids** and never indices,
 * which is what makes a shuffled paper and an unshuffled one score identically
 * on the same picks, and it is why the permutation can be recorded on the row
 * without ever being a fact the browser has to be trusted with.
 *
 * **An option's `id` here is a per-paper token, not the authored id.** The
 * ids a teacher writes are the order they wrote the options in, so
 * serving them would hand back the authored order on every shuffled paper:
 * the key by position, for a teacher who writes the right answer first. The
 * API names each option `o` + 24 lowercase hex characters, derived on the
 * server from the attempt, the question and the option, and maps the tokens a
 * sheet sends back to authored ids at hand-in. A token is stable for one paper
 * (reload, offered-back sheet, marked report) and shared with no other paper
 * or learner. A client treats it as opaque, sends back exactly what it was
 * given, and must not depend on authored ids anywhere, test ids included.
 */
export interface QuizPaperQuestion {
  /** The question's authored id, which question was asked, never which option answers it. */
  id: string;
  /** Markdown. */
  stem: string;
  /** In this paper's display order; each `id` is this paper's opaque token for the option. */
  options: QuizOption[];
  /**
   * May more than one option be picked?
   *
   * **This is the one thing the paper says about the key, and it says the
   * least a usable control can be built on: _how many_, never _which_.** A
   * question that admits one answer is a radio group and a question that
   * admits several is a checkbox group; guessing wrong in either direction is
   * a control that lies about what it will accept, and re-implementing one
   * with `role="radio"` to avoid saying it would cost arrow-key navigation and
   * Space, which the platform gives for free. A teacher who writes *"select
   * all that apply"* into a stem has already said it in prose.
   *
   * It is `correct.length > 1`, and it is the only expression anywhere outside
   * the scorer and the audited key route that reads `QuizQuestion.correct` at
   * all. Scoring is exact set equality either way, so it changes nothing about
   * what passes.
   */
  multiple: boolean;
}

/**
 * The paper this learner has in front of them on this quiz, in display order.
 *
 * **Usually open, and sometimes a sheet already written.** The mainline is the
 * paper they have open and have not handed in. The second case is a paper that
 * *was* handed in and whose marking never happened, the queue refused the job,
 * or a stall age-out or a pipeline failure wrote the revision off, which the
 * API offers back so the learner can hand it in again. `handedInAt` is how the
 * two are told apart, and a client that cannot tell them apart will present the
 * second one wrongly: see there.
 */
export interface QuizOpenPaper {
  attemptId: string;
  /** ISO, and a fact rather than a clock: nothing counts down while they read. */
  startedAt: string;
  questions: QuizPaperQuestion[];
  /**
   * ISO, and present **only** on a paper that has already been handed in and
   * is being offered back because its marking never happened. Absent on an
   * open paper, which is the mainline.
   *
   * **A client must draw this paper read-only.** The sheet in the record is
   * the one that will be graded: handing in a paper that is already closed
   * re-enqueues the answers already stored and does not overwrite them, so
   * inputs a learner could type into would be discarded without a word. Draw
   * `selected` beside each question and offer *hand in again*, nothing else.
   */
  handedInAt?: string;
  /**
   * The sheet in the record, this paper's option tokens per question id, the
   * same tokens `questions[].options[].id` carries, on a paper being offered
   * back. Absent on an open paper, where the learner's picks are the
   * browser's until they hand in.
   *
   * It is the learner's own answers and nothing else. The key is not here, is
   * not derivable from here, and is nowhere in this payload under any name.
   */
  selected?: Record<string, string[]>;
}

/**
 * The quiz room in one request.
 *
 * `drawn` is how many questions **one paper** asks, never how many the pool
 * holds: a learner who knew the pool was larger would know a retake is a
 * different subset, and a pool exists precisely so that it is.
 */
export interface QuizRoomView {
  taskKey: string;
  title: string;
  /** Markdown: the task panel a learner reads before they start. */
  brief: string;
  /** Whether the phase's roll-up quantifies over this quiz. */
  required: boolean;
  /** This task's own row: never the phase's. */
  status: PhaseStatus;
  drawn: number;
  /** 0..100. */
  passMark: number;
  /**
   * Papers **handed in**. Closed rows only, so an open paper has spent nothing:
   * and only the papers of the current attempt epoch, so a teacher's reset
   * hands the attempts back without deleting a single row of the history.
   */
  attemptsUsed: number;
  /** Null when the teacher set no limit. */
  attemptsLeft: number | null;
  /**
   * Every allowed paper handed in, none of them passed, and **nothing left for
   * the learner to press**.
   *
   * **The one state a learner cannot leave on their own.** No further paper can
   * be drawn, so the room offers nothing to press and says to ask their
   * instructor instead; the teacher's per-task **reset** starts a new attempt
   * epoch and is what opens it again. Computed on the server from the rows,
   * never a flag a browser could flip.
   *
   * Four conjuncts, and the last two are what keep it from saying *ask a
   * person* over a state a person cannot help with:
   *
   * - `attemptsLeft === 0`, and this task's row is not `passed`;
   * - **no paper is being offered back.** A sheet whose marking never happened
   *   is handed in again, not reset: a reset would start an epoch that leaves
   *   that sheet behind, and the learner needs the hand-in control rather than
   *   an instructor. `paper` carries it, with `handedInAt` set;
   * - **the newest sheet is not still being marked.** `attemptsUsed` counts a
   *   paper the instant it is written, while the row only reads `passed` once
   *   the grading job lands, so the two disagree for as long as a verdict is
   *   in flight, and that paper may well pass.
   *
   * It is a fact about the **paper** and not about the gate: an optional quiz
   * in this state has also run out of papers, and whether that blocks anything
   * is what `required` beside it says. A client reads it absent as *not in
   * that state*.
   */
  needsInstructorReset?: boolean;
  /** Seconds until another paper may be started, or null when none is owed. */
  cooldownSecondsLeft: number | null;
  /** The task's own best score, or null before anything has been scored. */
  bestScore: number | null;
  /**
   * The revision the **newest handed-in paper** was scored as, so the room can
   * open that paper's report. Read off the attempt row rather than off
   * `task_states`, because it is that paper's revision that is wanted and not
   * the task's most recent one.
   */
  lastSubmissionId: string | null;
  /**
   * The paper in front of the learner: the one they have open, or, where
   * there is none, a sheet they handed in whose marking never happened,
   * offered back so they can hand it in again. `handedInAt` tells the two
   * apart and says how the second must be drawn.
   */
  paper: QuizOpenPaper | null;
  // Declared once here, so the API's `quiz/quiz.dto.ts` and the web's
  // `components/workspace/quiz/contract.ts` read the same field by the same
  // name.
  /**
   * Present, and true, only where this task's row reads `passed` on a
   * teacher's credit, a Sign off, or a phase-wide Pass, and no paper has a
   * pass the strict-evidence gate accepts. `bestScore` is then that credit
   * (the pass mark the lever wrote), not a mark any paper earned. Asked of the
   * gate's own predicate; absent everywhere else, which is also what an older
   * API says.
   */
  passCredited?: true;
}
