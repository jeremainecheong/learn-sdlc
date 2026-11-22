/**
 * The mentor: the assistant chat, the customer interview, the mentor's
 * memory, instructor notes, the stuck flag, explaining a failing test and the
 * hint ladder.
 */

import type { PhaseKey } from '../phases';

/* -------------------------------- assistant ------------------------------ */

export interface AssistantMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  meta?: {
    provider?: string;
    cached?: boolean;
    redacted?: boolean;
    scopeRedirected?: boolean;
    budgetExceeded?: boolean;
    tokensIn?: number;
    tokensOut?: number;
  };
}

export interface AssistantChatResponse {
  reply: AssistantMessageView;
  usage: { todayTokens: number };
}

/* ========================================================================== */
/* The mentor: the interview, memory, instructor notes, the stuck flag. Their */
/* three audit names are in AuditEventView['event'] (./feedback).            */
/* ========================================================================== */

/* ---------------------------- the interview ------------------------------ */

/** One exchange with the customer: what was asked, what they said. */
export interface InterviewTurn {
  id: string;
  /** The learner's question, as they typed it, at most 500 characters. */
  question: string;
  /** The customer's answer, guardrails already applied. */
  answer: string;
  /** Fact ids this answer settled. Empty when the customer had nothing to give. */
  facts: string[];
  /** Which mentor produced it: 'openai', 'local-mentor' or 'guardrail'. */
  provider: string;
  askedAt: string;
}

/**
 * The interview as it is stored on the phase state. The persona, the opening
 * and the fact topics all live in the content pack and are read back from it,
 * so the row carries only what the learner actually did.
 */
export interface InterviewRecord {
  startedAt: string;
  turns: InterviewTurn[];
  /** Set once the pack's turn cap is reached; the room stays readable. */
  closedAt: string | null;
}

/** One thing the pack's truth document knows, as the checklist shows it. */
export interface InterviewFactView {
  id: string;
  /** A short label for the question it answers. Never the answer itself. */
  topic: string;
  uncovered: boolean;
}

/** The interview as the learner sees it, and as it is stored on the phase. */
export interface InterviewState {
  /** The customer, from the content pack. */
  persona: { name: string; role: string };
  /** What the customer says before the first question. */
  opening: string;
  startedAt: string | null;
  turns: InterviewTurn[];
  facts: InterviewFactView[];
  /** How many facts are worth settling before writing the story. */
  factsExpected: number;
  /** Questions left before the customer has to get back to work. */
  turnsLeft: number;
  /** Set once the cap is reached; the room stays readable, the composer does not. */
  closedAt: string | null;
}

export interface InterviewAskResponse {
  turn: InterviewTurn;
  state: InterviewState;
  usage: { todayTokens: number };
}

/** What the composer says when the customer has no more time. */
export const INTERVIEW_CLOSED_MESSAGE =
  'The customer has to get back to work. You have what you asked for, and the story is yours to write.';

/* --------------------------- the mentor's memory -------------------------- */

/** One thing the mentor carries out of a phase the learner has finished. */
export interface MentorMemoryItem {
  phaseKey: PhaseKey;
  /** What they decided, in their artefact's own words, at most 120 characters. */
  text: string;
  /** Where it was read from: a file name, or the check that produced it. */
  source: string;
}

export interface MentorMemoryView {
  items: MentorMemoryItem[];
  /** Questions the mentor declined to answer, newest first, at most three. */
  openQuestions: string[];
  /** The number of passed phases this memory was built from. */
  builtThrough: number;
}

/* --------------------------- instructor notes ----------------------------- */

/** A mentor note is quoted to the class; a lecture point is for the next session. */
export type InstructorNoteKind = 'mentor' | 'lecture';

export interface InstructorNoteView {
  id: string;
  kind: InstructorNoteKind;
  cohortId: string;
  cohortName: string | null;
  /** Null means every phase. */
  phaseKey: PhaseKey | null;
  /** Null means every project. */
  projectSlug: string | null;
  text: string;
  authorUserId: string;
  authorName: string | null;
  /** "<phaseKey>:<title>" when the note was pinned from a derived lecture point. */
  sourceId: string | null;
  /** Lecture points only: when it was ticked off. */
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------ the stuck flag ---------------------------- */

/** A learner's open request for help on one phase, and the answer to it. */
export interface StuckFlag {
  raisedAt: string;
  /** What they are stuck on, their words, 10 to 400 characters. */
  question: string;
  /** What they have already tried. Blank is allowed. */
  tried: string;
  answeredAt: string | null;
  answeredBy: string | null;
  answeredByName: string | null;
  /** The instructor's reply, at most 1000 characters. */
  answer: string | null;
  /** Set by the learner, never by the instructor: the flag has done its job. */
  clearedAt: string | null;
}

/** One row of the instructor's stuck list. */
export interface StuckItem {
  phaseStateId: string;
  userId: string;
  displayName: string;
  email: string;
  projectSlug: string;
  phaseKey: PhaseKey;
  phaseTitle: string;
  raisedAt: string;
  question: string;
  tried: string;
  answeredAt: string | null;
  answeredByName: string | null;
  answer: string | null;
}

/** What a learner is told the moment the flag is saved. */
export const STUCK_RAISED_MESSAGE =
  'Your instructor can see this. Keep working; their answer will appear here.';

/* --------------------------- explain a failure ----------------------------- */

/**
 * What the mentor was allowed to see about the failing test, echoed back so the
 * panel can name the subject without re-deriving it from a report the browser
 * may already have replaced.
 *
 * Deliberately not the whole `TestCaseResult`: no traceback, no hidden source,
 * no per-frame list. The mentor is told the name, the first line of the
 * assertion and where it landed, and so is this view.
 */
export interface ExplainSubjectView {
  /** The case's own name, as the runner reported it. */
  testName: string;
  /** True when the case comes from the hidden suite. */
  hidden: boolean;
  /** The first line of the assertion, capped at 160 characters, or ''. */
  assertion: string;
  /** "manager.py, line 56", or null when the traceback named no file of the learner's. */
  where: string | null;
  /**
   * Which run of a multi-run phase the case came from (`RunResult.steps`), or
   * null on a single-run result. A full-stack phase is graded twice, pytest
   * over the API, the DOM harness over the front end, and the same case name
   * can appear in both, so the subject says which half this answer is about.
   */
  step: string | null;
}

/**
 * One "explain this failure" turn. The reply is an ordinary mentor
 * message, same guardrail metadata, same hint numbering, same budget meter,
 * because that is what it is: the product typed the question on the learner's
 * behalf.
 */
export interface ExplainTestResponse {
  /**
   * The question as it was recorded, so the browser draws the learner's own
   * bubble from the server's words rather than guessing at the template.
   */
  question: string;
  reply: AssistantMessageView;
  usage: { todayTokens: number };
  subject: ExplainSubjectView;
}

/** Which result a failing test is being explained out of. */
export type ExplainSource = 'run' | 'submission';

/**
 * The sentence the product asks on the learner's behalf. Exported because the
 * browser matches on it to tell whether a test has already been explained, and
 * a template that lived in two files would drift apart on the first edit.
 */
export function explainQuestionFor(testName: string): string {
  return `Why does ${testName} fail?`;
}

/* ---------------------------------------------------------------------------
 * the hint ladder and what a question costs
 *
 * There is no fixed limit on hints such as "3 of 6 used". The rule is
 * `scoreProcess` in the API, and these three numbers are that rule. Both sides
 * import them, so the sentence a learner reads and the arithmetic that grades
 * them cannot drift.
 * They bite on the `process` rubric criterion, which only the code phases
 * carry (implementation and maintenance, weight 0.15 each). On a phase with no
 * process criterion a question costs no marks at all, which is a fact the
 * learner is owed rather than one to leave them to infer.
 * ------------------------------------------------------------------------- */

/** Questions that cost nothing, per phase. */
export const HINT_FREE_ALLOWANCE = 10;
/** Marks off the process criterion for each question past the allowance. */
export const HINT_MARK_STEP = 3;
/** The most hints can ever take off the process criterion. */
export const HINT_MARK_CAP = 30;

/**
 * Process marks lost to hints, out of the 100 that criterion is scored on.
 * Byte for byte the arithmetic `scoreProcess` has always used, in one place.
 */
export function hintMarksLost(hints: number): number {
  return Math.min(HINT_MARK_CAP, Math.max(0, (hints - HINT_FREE_ALLOWANCE) * HINT_MARK_STEP));
}

/** What the next question would cost. 0 while it is free, and 0 at the floor. */
export function nextHintCost(hints: number): number {
  return hintMarksLost(hints + 1) - hintMarksLost(hints);
}

/**
 * What happened to one reply, as one word. Exactly one applies, and the order
 * matters: a refusal that was replayed from the cache is still a refusal, so
 * what happened to the *question* wins over how the answer was served.
 */
export type MentorReplyOutcome = 'answered' | 'withheld' | 'redirected' | 'cached' | 'budget';

