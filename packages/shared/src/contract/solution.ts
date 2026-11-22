/**
 * The reference solution a learner may read after a phase's gate passes.
 */

import type { PhaseKey } from '../phases';

/* ---------------------------------------------------------------------------
 * the reference solution
 *
 * After a phase's gate passes, the learner may read the answer the pack was
 * written against, beside their own merged files. Two texts per file and
 * nothing derived: the diff is a pure function of them and it runs in the
 * browser, where the pull request's diff already runs.
 * ------------------------------------------------------------------------- */

/** One file of the pack's answer, beside the learner's own copy of the same path. */
export interface SolutionFileView {
  /** The workspace path both texts sit at, e.g. "api/repository/tasks.py". */
  path: string;
  /** The pack's answer. Always present: a file with no answer is not listed. */
  theirs: string;
  /**
   * The learner's file at the revision the phase was merged on, or null when
   * that revision's snapshot has been pruned and the workspace no longer holds
   * the path. Null is a real answer: the copy is gone, not empty.
   */
  yours: string | null;
  /** The language for the listing, from the phase's own file spec. */
  language: string;
}

/**
 * Why a passed phase has no reference to show.
 *
 * `prose` is a written phase: requirements and design, where the answer is
 * the learner's own writing and the pack ships no model story to hold it
 * against. `config` is deployment, where the pack ships no model configuration.
 *
 * `quiz` is a quiz task, which owns no file and
 * therefore has no reference to show. It is its own word because `referenceFiles`
 * reads `checksOf(phase, task)` and a quiz slice would otherwise fall to the
 * same `default:` arm `config` answers for, so without it the screen would tell a
 * learner in an implementation phase that the pack ships no model
 * configuration, which is true of nothing they are looking at.
 */
export type SolutionUnavailable = 'prose' | 'config' | 'quiz' | null;

/** The reference answer for one phase, after its gate has passed. */
export interface SolutionView {
  phaseStateId: string;
  phaseKey: PhaseKey;
  phaseTitle: string;
  /**
   * Which task's answer this is, and what that task is called. The gate, the stamp and the
   * three numbers below are all read from **this** task's row.
   */
  taskKey?: string;
  taskTitle?: string;
  /** The pack ships an answer for this phase. */
  available: boolean;
  /** Why not, when it does not. Null when it does. */
  unavailableReason: SolutionUnavailable;
  /** Empty when `available` is false. */
  files: SolutionFileView[];
  /** The score the phase passed at, and when: the standing line's two facts. */
  bestScore: number | null;
  passedAt: string | null;
  /** When this learner first opened it. Stamped by the very request that answers. */
  readAt: string | null;
  /** The pack version the answer comes from, so an appeal can say which answer. */
  packVersion: string | null;
}

/** What a phase knows about its reference, for the doors that lead to it. */
export interface PhaseSolutionMeta {
  /** The pack ships an answer for this phase. */
  available: boolean;
  /** How many files it answers. 0 when there is none. */
  files: number;
  /** When this learner first read it, or null. */
  readAt: string | null;
  /**
   * Present, and true, only when the board reads the door's task passed but
   * no strictly reviewed pass stands behind it: a teacher's Pass or Sign off
   * with no revision of the learner's own. The answer opens on the strict
   * gate's evidence and nothing less, so the door stays shut and no room
   * draws it. Absent on a pass the review accepted, which is every
   * TaskTrackr pass, and on a phase that has not passed.
   */
  awaitingReview?: true;
}

/** The refusal before the gate is in. One sentence, so the route and the page agree. */
export const SOLUTION_LOCKED_MESSAGE =
  'the reference opens when this phase passes its gate';
