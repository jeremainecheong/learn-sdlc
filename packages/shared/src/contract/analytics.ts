/**
 * Analytics: per-phase and per-learner numbers and the instructor's class
 * overview.
 */

import type { PhaseKey, PhaseStatus } from '../phases';

/* -------------------------------- analytics ------------------------------ */

/*
 * Two quiz-era numbers sit on the three analytics shapes below, and neither
 * replaces anything.
 *
 * `checklistPercent` is *how much of the checklist is done*: required tasks
 * passed over required tasks declared, task weighted, computed over the
 * **pinned version's** tasks. `progressPercent` is a different question over a
 * different denominator (the `phase_states` rows an enrolment holds); the two
 * agree on a board whose rows are complete and disagree on
 * one short a row, where `checklistPercent` is the one that is right.
 *
 * `masteryPercent` is *how well the concepts are understood*: the mean of the
 * best score over quiz tasks that have one. It is `null`, never `0`, when there
 * is no quiz or none has been attempted: a blank and a zero are different
 * facts, which is the gradebook's own rule. A required quiz already moves the
 * phase's score once, through the roll-up's mean over required keys, so this is
 * a second reading of the same rows for a different question and never a new
 * summand of `averageScore`.
 *
 * Both are optional on all three shapes, in the idiom the shared contract uses
 * for a field with external readers.
 */

export interface PhaseAnalytics {
  key: PhaseKey;
  order: number;
  title: string;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  hints: number;
  relianceIndex: number; // 0..100
  /** 0..100: this phase's required tasks passed over its required tasks. */
  checklistPercent?: number;
  /** 0..100, or null when this phase declares no quiz or none was attempted. */
  masteryPercent?: number | null;
}

export interface LearnerAnalytics {
  /**
   * Which project these figures describe. Both reference projects carry
   * six phases with identical keys, so nothing else in this payload tells them
   * apart: a scoping bug that returned the wrong project's numbers would be
   * invisible without it.
   */
  projectSlug: string;
  progressPercent: number;
  phasesPassed: number;
  totalPhases: number;
  averageScore: number | null;
  totalHints: number;
  tokensToday: number;
  /** Adaptive-difficulty tier: 'guided' | 'standard' | 'challenge'. */
  difficultyTier: string;
  relianceIndex: number;
  /** 0..100 across the pinned version's phases, task weighted. See above. */
  checklistPercent?: number;
  /** 0..100 across every quiz task of the pinned version, or null when there are none. */
  masteryPercent?: number | null;
  phases: PhaseAnalytics[];
}

export interface InstructorLearnerRow {
  userId: string;
  displayName: string;
  email: string;
  cohort: string;
  /** The class's name, resolved from the cohorts table; null for 'default' or a class since deleted. */
  cohortName: string | null;
  /**
   * One row per enrolment, so a learner in two projects appears twice. Null
   * when the learner is in the class but has not started any project (or, with
   * a project filter, not that one): they still belong in the roll call.
   */
  projectSlug: string | null;
  progressPercent: number;
  phasesPassed: number;
  averageScore: number | null;
  totalHints: number;
  relianceIndex: number;
  tokensToday: number;
  completed: boolean;
  /** Over-reliance / integrity flag: high AI-reliance or a flagged submission. */
  integrityFlag: boolean;
  difficultyTier: string;
  /** 0..100 across the pinned version's phases, task weighted. See `PhaseAnalytics`. */
  checklistPercent?: number;
  /** 0..100 across every quiz task of the pinned version, or null when there are none. */
  masteryPercent?: number | null;
}

export interface InstructorOverview {
  learners: InstructorLearnerRow[];
  /** Distinct learners, not rows: a learner in two projects counts once. */
  cohortSize: number;
  averageProgress: number;
  averageReliance: number;
  aiProvider: string;
}
