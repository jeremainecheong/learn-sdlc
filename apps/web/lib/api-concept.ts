'use client';

/**
 * The quick concept checks before and after a phase.
 *
 * Two short MCQ checks per phase, on what the chapter teaches (user stories,
 * Given/When/Then, epic vs story vs ticket, and so on), not on the project.
 * The learner takes one before starting the phase and one after passing it,
 * so the class can see whether the phase taught anything. They are not graded
 * and lock nothing: no gate, task list or progress figure reads them.
 *
 * The checks are quizzes on the existing quiz doors under two fixed task keys
 * (`concept-before`, `concept-after`); this file adds the one status read, the
 * teacher's learning-gain shapes, and which of the two to offer.
 */

import type { request as Request } from './api';
import { seg } from './api-fetch';

export type ConceptKind = 'before' | 'after';
/**
 * `closed`: the before check, once work for the phase is
 * handed in. It is never offered.
 */
export type ConceptSlotStatus = 'locked' | 'open' | 'taken' | 'closed';

export interface ConceptSlot {
  taskKey: 'concept-before' | 'concept-after';
  status: ConceptSlotStatus;
  scorePct: number | null;
  questionCount: number;
}

export interface ConceptQuizzes {
  phaseKey: string;
  before: ConceptSlot;
  after: ConceptSlot;
}

export interface LearningGainLearner {
  learner: string;
  beforePct: number | null;
  afterPct: number | null;
  deltaPct: number | null;
}

export interface LearningGainPhase {
  phaseKey: string;
  title: string;
  /** Learners who took both checks; the averages are over these alone. */
  n: number;
  beforeAvgPct: number | null;
  afterAvgPct: number | null;
  deltaPct: number | null;
  learners: LearningGainLearner[];
}

export interface LearningGain {
  phases: LearningGainPhase[];
}

export const CONCEPT_BEFORE_TITLE = 'Quick check before you start';
export const CONCEPT_AFTER_TITLE = 'What did you learn?';
export const LEARNING_GAIN_EMPTY = 'No learner has taken both checks yet.';
/** What the check's page says in place of Start when the slot is shut. */
export const CONCEPT_BEFORE_CLOSED = 'The before check closes once you have handed in work for this phase.';
export const CONCEPT_AFTER_LOCKED = 'The "What did you learn?" check opens once you have passed this phase.';

export function conceptTaskKey(kind: ConceptKind): 'concept-before' | 'concept-after' {
  return kind === 'after' ? 'concept-after' : 'concept-before';
}

/** The kind in the address; anything else is the before check. */
export function conceptKindFrom(value: string | null | undefined): ConceptKind {
  return value === 'after' ? 'after' : 'before';
}

export function conceptTitle(kind: ConceptKind): string {
  return kind === 'after' ? CONCEPT_AFTER_TITLE : CONCEPT_BEFORE_TITLE;
}

export function conceptHref(phaseId: string, kind: ConceptKind): string {
  return `/workspace/${seg(phaseId)}/concept?kind=${kind}`;
}

/**
 * The client is loaded when the prompt first asks, not when the phase layout
 * module loads: the layout is imported by many room tests that stand in only
 * the modules the layout reaches without this client, and the check must never be
 * the reason a room fails to load.
 */
async function send<T>(...args: Parameters<typeof Request>): Promise<T> {
  const { request } = await import('./api');
  return request<T>(...args);
}

export const conceptApi = {
  /** Which of the phase's two checks is locked, open or taken. */
  status: (phaseId: string) => send<ConceptQuizzes>('GET', `/phases/${seg(phaseId)}/concept-quizzes`),
};

/**
 * Which check to offer now, if any. The after check wins: once the phase is
 * passed, a "before" score would be taken after the learning and skew the
 * before/after pair, so the before check is offered only while the after
 * check is still locked. A `closed` before check (work already handed in) is
 * not `open`, so it is never offered. "Later" is the prompt's own state for one visit, so
 * nothing about a put-away offer is stored here.
 */
export function conceptToOffer(quizzes: ConceptQuizzes): ConceptKind | null {
  if (quizzes.after?.status === 'open') return 'after';
  if (quizzes.before?.status === 'open' && quizzes.after?.status === 'locked') return 'before';
  return null;
}

/* ----------------------------- learning gain ----------------------------- */

export function learningGainPath(cohortId?: string): string {
  return `/instructor/quiz-results/learning-gain${cohortId ? `?cohort=${seg(cohortId)}` : ''}`;
}

export function learningGainCsvPath(cohortId?: string): string {
  return `/instructor/quiz-results/learning-gain.csv${cohortId ? `?cohort=${seg(cohortId)}` : ''}`;
}

/** A percentage for reading: rounded, never regraded. */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : `${Math.round(value)}%`;
}

/** A change in points, with its sign. */
export function signedPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'No change yet';
  const rounded = Math.round(value);
  if (rounded === 0) return '0 points';
  return `${rounded > 0 ? '+' : ''}${rounded} points`;
}
