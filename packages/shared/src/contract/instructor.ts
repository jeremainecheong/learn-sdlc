/**
 * The instructor's console: a learner's detail, phase overrides, classes,
 * regrades, the class schedule and the view-as session.
 */

import type { PhaseKey } from '../phases';
import type { SubmissionView } from './feedback';
import type { InstructorTaskView, PhaseEvidenceGap, PhaseSummary } from './phase-detail';

/* --------------------------- instructor detail --------------------------- */

/** A phase as the instructor sees it: the learner's PhaseSummary plus usage and the latest verdict. */
export interface InstructorPhaseView extends PhaseSummary {
  hints: number;
  relianceIndex: number;
  passThreshold: number;
  unlockedAt: string | null;
  /** Includes report.integrity: the mentor-paste signal the Terms promise reaches instructors. */
  lastSubmission: SubmissionView | null;
  /**
   * This phase's tasks, each with its own status, score, attempts and newest
   * revision. `lastSubmission` above means *the newest revision on this phase*.
   */
  tasks?: InstructorTaskView[];
  /**
   * The learner's `PhaseDetail.evidenceNeeded`, for the teacher: the required tasks the
   * strict-evidence gate would still refuse this learner's Continue over, on
   * the passed phase they stand on. Absent when Continue will be accepted.
   * A Sign off or a Pass writes the board; it does not stand in for the review,
   * so a phase that reads passed here can still be waiting on these.
   */
  evidenceNeeded?: PhaseEvidenceGap[];
}

export interface InstructorEnrollmentView {
  id: string;
  projectSlug: string;
  projectTitle: string;
  currentPhaseOrder: number;
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  phases: InstructorPhaseView[];
  /**
   * `true` on a project this learner started that is
   * set aside because their class works another project; absent otherwise.
   * The row is still theirs, whole and pinned, and is listed after the one
   * they are working now (see `InstructorLearnerDetail.enrollments`).
   */
  setAside?: true;
}

export interface InstructorLearnerDetail {
  userId: string;
  /** The learner's selected generated portrait. */
  avatar?: number;
  email: string;
  displayName: string;
  cohort: string;
  cohortName: string | null;
  createdAt: string;
  tokensToday: number;
  /**
   * Every project the learner started. The one the server resolves
   * for them now, their class's project once they have started it, comes
   * first, then the rest oldest first, so a roster drawing `enrollments[0]`
   * shows the learner on the project they are working.
   */
  enrollments: InstructorEnrollmentView[];
  /**
   * Requirements only: how far the customer interview got. Recorded, never
   * graded: it is the one place an instructor can see
   * whether a learner asked the customer anything before writing US-4.
   */
  interview?: { questions: number; settled: number } | null;
}

// `reset-phase` starts the phase over rather than nudging its gate; see the
// regrade and schedule section further down this file.
// The `task-` levers are the three a teacher has over one task of a split
// phase. Each refuses a phase whose task
// list is the synthesised sole one by name: on such a phase the phase's own
// levers are the levers, and `task-signoff` on the empty key would otherwise
// flip the phase past `pass`'s already-passed refusal and its threshold floor.
export type PhaseOverrideAction =
  | 'pass'
  | 'reopen'
  | 'reset-workspace'
  | 'reset-phase'
  | 'task-signoff'
  | 'task-reset'
  | 'task-reopen';

/**
 * The same list as a value, so a DTO validates against one copy rather than a
 * second literal union that can drift from this one.
 */
export const PHASE_OVERRIDE_ACTIONS: PhaseOverrideAction[] = [
  'pass',
  'reopen',
  'reset-workspace',
  'reset-phase',
  'task-signoff',
  'task-reset',
  'task-reopen',
];

/* --------------------------------- cohorts ------------------------------- */

/** A class as its instructor sees it: the code learners join by, and how many have. */
export interface CohortView {
  id: string;
  name: string;
  joinCode: string;
  createdAt: string;
  memberCount: number;
}

/* --------------------------- instructor tooling -------------------------- */

/** Who a regrade covers. `stale-pack` is everyone whose newest verdict came from an older pack. */
export type RegradeScope = 'stale-pack' | 'everyone';

export type RegradeBatchStatus = 'running' | 'finished' | 'stopped';

/** One learner a regrade could not include, and the sentence saying why. */
export interface RegradeSkip {
  userId: string;
  displayName: string;
  /** Sentence case, learner-safe, e.g. "Their newest revision's files were pruned." */
  reason: string;
}

/** One learner a regrade would include, as the dry run reports them. */
export interface RegradeCandidate {
  userId: string;
  displayName: string;
  phaseStateId: string;
  submissionId: string;
  /** 1-based revision number of the submission that would be re-run. */
  attempt: number;
  score: number | null;
  passed: boolean | null;
  /** The pack that produced the verdict being replaced; null on a verdict recorded without one. */
  packVersion: string | null;
  // A candidate is a (learner, task) pair, not a learner: a split phase puts one learner
  // on the preview once per task, and a panel that prints only a name shows
  // the same person twice with nothing to tell the rows apart.
  /** The task this revision is about, as the pinned version keys it. `''` on a sole-task phase. */
  taskKey?: string;
  /** That task's title, which is what a teacher reading the preview needs. */
  taskTitle?: string;
}

/** What a regrade would do, or is doing, or did. */
export interface RegradeBatchView {
  id: string;
  status: RegradeBatchStatus;
  projectSlug: string;
  phaseKey: PhaseKey;
  scope: RegradeScope;
  reason: string;
  /** The pack on disk when the batch started. */
  packVersionTo: string | null;
  requested: number;
  done: number;
  failed: number;
  /**
   * How many learners now pass the gate who did not before. Only ever upward:
   * a regrade cannot lower a score or withdraw a pass, so this is the whole of
   * what a batch changed about who has passed.
   */
  newPasses: number;
  skipped: RegradeSkip[];
  createdAt: string;
  finishedAt: string | null;
  /** Only on the dry run, which never writes a batch: `id` is the empty string there. */
  candidates?: RegradeCandidate[];
}

/** When a phase opens for a class, and when its work is due. Both optional. */
export interface CohortPhaseSchedule {
  phaseKey: PhaseKey;
  /** ISO instant. Before this, the phase is shut whatever the learner has passed. */
  opensAt: string | null;
  /** ISO instant. A due date marks work late; it never blocks a submission. */
  dueAt: string | null;
}

/**
 * The learner an instructor is currently looking at. Held in memory by the
 * console for the life of the tab and never stored: a view-as session that
 * survived a reload is a session an instructor could forget they were in.
 */
export interface ViewAsSession {
  userId: string;
  displayName: string;
  email: string;
  cohort: string;
}

export interface CohortScheduleView {
  cohortId: string;
  projectSlug: string;
  phases: CohortPhaseSchedule[];
  /** The IANA zone the instructor set these in, for the line under the table. */
  timezone: string | null;
}
