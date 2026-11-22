/**
 * The dossier: the whole project as one printable document.
 */

import type { ChangeTicket } from '../change-record';
import type { DesignContracts, DesignStory } from '../design-record';
import type { PhaseKey, PhaseStatus } from '../phases';
import type { DrillState, PhaseLink, ReleaseRecordView, SubmissionView } from './feedback';

/* -------------------------------------------------------------------------- */
/* the dossier: the whole project as one printable document                    */
/* -------------------------------------------------------------------------- */

/**
 * Who the dossier is being rendered for. It decides one thing: whether the
 * learner's mentor questions appear, or only how many there were.
 *
 * It is never chosen by the client. A learner's own copy is assembled in their
 * browser from what they can already read, so it is `'learner'` by
 * construction; an instructor's copy comes from the API, which sets
 * `'instructor'` because of who called it.
 */
export type DossierAudience = 'learner' | 'instructor';

/** One phase as the dossier prints it: what the learner wrote, and how it stood. */
export interface DossierPhase {
  phaseStateId: string;
  key: PhaseKey;
  order: number;
  title: string;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  hints: number;
  passedAt: string | null;
  /**
   * The editable files at the revision that was merged, or the current
   * workspace for a phase still in progress. Empty for a locked phase, and
   * empty for a revision whose snapshot retention has pruned.
   */
  files: { path: string; content: string; language: string }[];
  /** Every revision, oldest first, with its commit message and what it scored. */
  revisions: SubmissionView[];
  /** The verdict the phase was merged on, with its full report. */
  merged: SubmissionView | null;
  /** The merge message, from the release record. */
  mergeMessage: string | null;
  /** Deployment only. */
  drill: DrillState | null;
  /** Learner-made links (test to criterion), for the coverage table. */
  links: PhaseLink[];
  /**
   * When the learner read the pack's reference answer for this phase, or null.
   * The reference itself is not printed: it is the pack's own content, the
   * same on every learner's copy, and printing it would treble the document to
   * say nothing about this learner.
   */
  solutionReadAt?: string | null;
  /**
   * Design only: the stories the phase lists, which the dossier reads the
   * contract against. Both copies take them from the phase spec of the
   * version the enrolment holds (the teacher's from `phase.checks`, the
   * learner's from `PhaseDetail.design`, that spec's own view). Absent on a
   * phase still in the older format.
   */
  designStories?: DesignStory[];
  /**
   * Design only: the contracts the teacher switched on, from the same spec as
   * `designStories`. The dossier draws a contract's table only when its switch
   * is on. Absent on a phase still in the older format, and the dossier then
   * draws every table by what the files hold.
   */
  designContracts?: DesignContracts;
  /**
   * Maintenance only: the teacher's ticket, which section 9 prints beside the
   * snapshot's change request. Both copies take it from the phase spec of the
   * version the enrolment holds (the teacher's from `checks.ticket`, the
   * learner's from `PhaseDetail.change`), as `designStories`. Absent on a
   * Maintenance still in the older format.
   */
  changeTicket?: ChangeTicket;
}

/** One line of the dossier's timeline, as a row rather than as a component. */
export interface DossierJournalRow {
  at: string;
  phaseKey: PhaseKey;
  // 'solution' lets the learner's own timeline carry the day they opened the
  // pack's answer, and 'decision' makes an accepted architecture decision
  // record an event on both timelines. Add kinds at the end of the union.
  kind: 'run' | 'submission' | 'hint' | 'release' | 'drill' | 'solution' | 'decision';
  title: string;
  detail: string;
  result: string | null;
}

/**
 * Everything one dossier prints. Assembled in the browser for a learner's own
 * copy, and by InstructorService for an instructor's.
 */
export interface LearnerDossier {
  audience: DossierAudience;
  /** The learner named on the cover. */
  userId: string;
  displayName: string;
  email: string;
  /** The class, or null for a learner who has not joined one. */
  cohortName: string | null;
  projectSlug: string;
  projectTitle: string;
  /**
   * The content pack the work was done against; null for work recorded
   * without a pack version, which is what a null packVersion means, and null
   * on a learner's own copy, which has no route that carries it.
   */
  packVersion: string | null;
  startedAt: string;
  completedAt: string | null;
  phasesPassed: number;
  totalPhases: number;
  averageScore: number | null;
  phases: DossierPhase[];
  releases: ReleaseRecordView[];
  /**
   * The journal, as rows rather than as components, so both copies render the
   * same thing. On an instructor's copy every mentor row carries a count and
   * no text.
   */
  journal: DossierJournalRow[];
  /** When this dossier was assembled. */
  generatedAt: string;
}
