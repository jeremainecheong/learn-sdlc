/**
 * Feedback: a submission's report, its checks and scores, the AI rubric
 * review, the integrity signals, the release record and the audit event view.
 */

import type { AuthoringAuditEvent } from '../authoring';
import type { PhaseKey } from '../phases';
import type { AnalyzerReport, CiStep, ContractClaim, DrillReport, ImpactReport, MutationReport } from './analysis';
import type { AcceptedScreenCopy } from './phase-detail';
import type { QuizReport } from './quizzes';
import type { JobStatus, RunExitKind, RunResult } from './runs';

/* -------------------------------- feedback ------------------------------- */

export interface FeedbackCheck {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  detail: string;
}

export interface CriterionScore {
  key: string;
  title: string;
  weight: number;
  score: number; // 0..100
  evidence: string[];
}

export interface AiRubricReview {
  verdict?: 'pass' | 'needs_revision';
  criteriaEvidence?: Array<{ key: string; met: boolean; evidence: string; issue: string; nextStep: string }>;
  assessmentError?: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  processNote: string;
  /**
   * Which provider answered, or one of two words that say no provider did.
   *
   * `'unavailable'` means a model was asked and did not answer: the verdict is
   * degraded, `strictTaskEvidencePassed` refuses on it by its first clause, and
   * the learner's report draws the degraded-grading banner.
   *
   * `'not-applicable'` means no model was
   * needed. Scoring a multiple-choice answer is set equality, so a quiz spends
   * no token and consults no guardrail, but `aiReview` is not optional on a
   * `FeedbackReport`, and an `'unavailable'` stub would draw a degraded banner
   * over a paper that scored 100. The two are different facts and the screen
   * renders them differently; the banner keys on `'unavailable'` alone.
   */
  provider: string;
}

/** Academic-integrity and over-reliance signals for a submission. */
export interface IntegritySignals {
  /** AI-reliance index for the phase is high (leaning on the mentor). */
  relianceFlag: boolean;
  relianceIndex: number;
  /** The artefact reproduces a chunk of a mentor reply verbatim (paste). */
  mentorPasteFlag: boolean;
  /** Passed on the first attempt with no run and heavy hint use. */
  noEffortFlag: boolean;
  note: string;
}

/**
 * How long one sandbox-backed step of a graded report took.
 *
 * Observability only: nothing scores it, gates on it, hashes it or compares
 * two reports by it. The graders hold one duration per sandbox job; recording
 * them here is what lets the share of a Submit that is sandbox time be read
 * rather than estimated.
 */
export interface ReportStepTiming {
  /**
   * A stem fixed in the grader, 'visible', 'hidden', 'reference', 'mutant',
   * 'smoke', with the pack's own `checks.runs[].id` appended where a phase
   * declares more than one run, the same way its per-run check line is named.
   * Never a file name, a hidden test name or anything a learner wrote; a
   * `mutant` row per planted mutant, in the order `mutation.matrix` uses.
   */
  step: string;
  /**
   * The runner's own in-guest duration for that job, as `RunResult.durationMs`
   * reports it. It is not the wall clock the caller waited: the fresh machine
   * every job gets (~2.5 s by the controller's own measurements) and the queue
   * behind the runner slots are both outside it. That wall clock is
   * `sandbox_execution_duration_seconds`, so the two are read together and
   * neither of them is a Submit's sandbox share on its own.
   */
  durationMs: number;
  /**
   * How the run ended, where the grader holds the runner's exit kind, reduced
   * to the five `RunExitKind` declares. Absent on a step whose result keeps a
   * shape of its own that carries no exit kind, as the deployment smoke check
   * does.
   */
  outcome?: RunExitKind;
}

export interface FeedbackReport {
  assessmentMode?: 'strict_binary';
  overall: number; // 0..100 weighted
  passed: boolean;
  /** Legacy reports only; strict binary assessments have no threshold. */
  passThreshold?: number;
  criteria: CriterionScore[];
  checks: FeedbackCheck[];
  staticAnalysis?: AnalyzerReport;
  tests?: RunResult['tests'];
  mutation?: MutationReport;
  aiReview: AiRubricReview;
  aiReliance: { hintsThisPhase: number; index: number };
  integrity: IntegritySignals;
  /** Implementation and maintenance: contract conformance ledger. */
  contract?: ContractClaim[];
  /** Deployment: the pipeline drawn from ci.yml with each step's outcome. */
  ci?: CiStep[];
  /** Deployment: the incident drill outcome. */
  drill?: DrillReport;
  /** Maintenance: change impact against the scaffold baseline. */
  impact?: ImpactReport;
  // The paper, per question.
  /**
   * A quiz task's per-question outcome. Absent on every other kind of report
   * and on an older report written without it. The paper's verdict is a
   * single `FeedbackCheck` with id `quiz`; this is what the learner reads, and
   * nothing quantifies over it: see `QuizReport`.
   */
  quiz?: QuizReport;
  // The day this report was graded at.
  /**
   * The clock the sandbox ran under for this report, ISO date or null. On the
   * kill matrix it is what makes two submissions comparable or not: every
   * mutant in one report saw this same day. Set by the testing grader only;
   * absent on a report from a phase that has no clock.
   */
  runClock?: string | null;
  // Where the wait went.
  /**
   * One row per sandbox job the grader ran to build this verdict, in the order
   * it ran them. Absent on a report from a phase with no sandbox job, and on
   * an older report graded without it. Nothing may branch on it.
   *
   * One job is deliberately not here: the incident drill's run against the
   * pack's faulted copy, which happens after this object is assembled and is
   * about a planted fault rather than about the learner's verdict. So the rows
   * are a Submit's graded sandbox work, not every machine the request started:
   * `sandbox_execution_duration_seconds` counts all of them, with the fresh
   * machine and the slot queue that `durationMs` leaves out.
   */
  timings?: ReportStepTiming[];
}

export interface SubmissionView {
  /** Server-verified strict verdict with retained submission evidence. */
  verifiedPass?: boolean;
  /**
   * Which task of the phase this revision is about. `''` on a phase whose task
   * is the synthesised sole one, which is also what an older revision without
   * a task key reads as. Optional because this shape has external readers.
   */
  taskKey?: string;
  id: string;
  status: JobStatus;
  score: number | null;
  passed: boolean | null;
  report: FeedbackReport | null;
  createdAt: string;
  error?: string;
  /** 1-based revision number within the phase, oldest first. */
  attempt?: number;
  /** The editable files as they were at submission time. Only on the single-submission route. */
  workspaceSnapshot?: Record<string, string> | null;
  /** Read-only presentation context retained with this exact submission. */
  acceptedScreenCopy?: AcceptedScreenCopy | null;
  // What the learner said about this revision, and the day the sandbox ran it at.
  /**
   * What the learner said this revision changes: one line, at most 140
   * characters, the shape of a commit subject. Null on a revision submitted
   * with the field empty and on an older revision recorded without one:
   * to a reader the two are the same, so there is one column and no flag.
   */
  commitMessage?: string | null;
  /** The clock this revision was graded at; null means the machine's clock. */
  runClock?: string | null;
}

/** A learner's manual link from a test (or other node) to the criterion it proves. */
export interface PhaseLink {
  from: string;
  to: string;
  kind: 'verifies' | 'covers';
  at: string;
}

/**
 * Deployment drill state, written as the learner works through INCIDENT-1.
 * `incident` is read from the runbook record (`drillWithIncident`) wherever a
 * drill is handed out; the stored key is never written again.
 */
export interface DrillState {
  fault: string;
  pagedAt: string;
  /** Null for a phase with a runbook record; an older drill's markdown, read only by the dossier's legacy reader. */
  runbookBefore: string | null;
  /**
   * The exit of the smoke run against the faulted copy when the learner was
   * paged: the drill's own red. Absent on an older drill that did not record
   * it, which is read as red: the pack declares the faulted copy must
   * fail, and the run did happen.
   */
  pagedExit?: number | null;
  healthRanAt: string | null;
  healthExit: number | null;
  fixAppliedAt: string | null;
  resolvedAt: string | null;
  incident: { rootCause: string; fix: string; actionItem: string } | null;
}

export interface ReleaseRecordView {
  id: string;
  enrollmentId: string;
  phaseKey: PhaseKey;
  phaseOrder: number;
  /** v1 … v6, one per merged phase; the maintenance merge is also labelled 1.1.0 in the UI. */
  version: string;
  score: number | null;
  /** The merge message. */
  notes: string | null;
  createdAt: string;
}

export interface AuditEventView {
  id: string;
  event:
    | 'phase.override'
    | 'budget.override'
    | 'budget.default'
    | 'admin.user.update'
    | 'admin.password.set'
    // An admin moved a class to another instructor, because the owner was
    // leaving and the join code had to stay live.
    | 'admin.cohort.owner'
    // The class itself: made, and joined with a code. A learner moving into or
    // out of an instructor's view is a change of who can read their work.
    | 'cohort.create'
    | 'cohort.join'
    | 'cohort.leave'
    // What the account holder did to their own credentials and account: three
    // writes that must leave a trace like every other change of access.
    | 'password.change'
    | 'password.reset'
    | 'account.delete'
    // A Google sign-in took over a row nobody had ever confirmed: the password
    // was cleared and earlier sessions were signed out.
    | 'account.claimed'
    // Four instructor levers. A regrade batch is one `regrade.start` and one `phase.regrade` per
    // learner it re-ran; view-as and the class dates are single rows.
    | 'regrade.start'
    | 'phase.regrade'
    | 'instructor.view-as'
    | 'cohort.schedule'
    // An instructor answered a learner who
    // raised a stuck flag from the workspace, and what they said is the record
    // of the help given.
    | 'stuck.answer'
    // A note written for a whole class, quoted by the mentor or held
    // for the next lecture. The text of the note is the reason.
    | 'note.write'
    | 'note.delete'
    // A whole class left this machine as one
    // file, arrived on it as one, or an account appeared because an import
    // carried a learner nobody here had registered.
    | 'cohort.export'
    | 'cohort.import'
    | 'account.import'
    // An instructor wrote to one learner.
    // The note itself is in `detail`, so an appeal reads what was actually
    // said rather than that something was said.
    | 'instructor.note'
    // An instructor printed a learner's whole project: the one route that
    // hands them the learner's own files as a document rather than the scores
    // drawn from them (the rule: a change in who can read a learner's work
    // leaves a row).
    | 'dossier.read'
    // A learner started or stopped
    // their own application inside the runner. Two rows a session, never one
    // per proxied request: that is the access log's job, and the capability
    // is redacted out of it (loggablePath).
    | 'preview.start'
    | 'preview.stop'
    // A learner took their whole project
    // away as a git repository. It is the one route that hands the whole of
    // their work out as a file, so it is on the record for the same reason a
    // class export is.
    | 'repo.export'
    // A learner opened the pack's own answer
    // to a phase they had already passed. It changes no score and no file; it
    // is on the record because a class needs to be able to say who has seen the
    // answer and when, and because the learner's own dossier says so too.
    | 'solution.read'
    // The three levers a teacher has over one task of a split phase. Each moves a gate
    // (a countersignature passes a task no verdict may pass, and a reopen or a
    // reset takes the phase's own row down with it), so each leaves a row for
    // the same reason `phase.override` does.
    | 'task.signoff'
    | 'task.reset'
    | 'task.reopen'
    // The boot moved a learner pinned to a version whose Requirements or
    // Design was still markdown onto their project's head, whose phase is a
    // story or a design record, converting those phases' workspaces with the
    // move. A pin is a promise that content never moves under an attempt, so
    // the one audited migrate of it leaves a row per learner, its reason
    // naming the phases moved (`StoryRepinService`).
    | 'enrolment.repin'
    // The boot left a learner on their version because the head holds a different set of phases:
    // one row per pin and head, its reason the sentence the learner's teacher reads (`StoryRepinService`).
    | 'enrolment.repin.stranded'
    // The same boot moved a class whose active assignment was a version with
    // a markdown Requirements or Design onto the head, so learners who join
    // from then on start on it. One row per class, actor the first admin,
    // target the class (`StoryRepinService`).
    | 'cohort.project.repin'
    // A teacher opened a quiz's answer
    // key. It is a read that changes nothing, and it is on the record for the
    // same reason `solution.read` is: an MCQ key *is* the passing answer, so a
    // class has to be able to say who has seen one and when.
    | 'project.quiz-key'
    // Every authoring event, so a writer of an authoring row needs no cast.
    // `AUTHORING_AUDIT_EVENTS` stays the one list of their names.
    // 'project.quiz-key' above is also one of them; the union takes it once
    // either way, so its own line documents the read (the comment above it)
    // and does not widen the type.
    | AuthoringAuditEvent;
  actorUserId: string;
  actorName: string | null;
  /** Null once the subject asked for their account to be deleted. */
  subjectUserId: string | null;
  subjectName: string | null;
  targetId: string | null;
  action: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Whether the AI reviewer's verdict on a report is advice rather than a gate:
 * the rule-based score is exactly 100 and the reviewer found strictly more than
 * half of the criteria met (`met * 2 > evidence.length`: two or three of three,
 * both of two, the one of one). A reviewer that finds most criteria unmet is
 * refusing the work, so its verdict still decides. The API's gate reads it only
 * after every rule-based clause has been met, and the learner's and teacher's
 * pages read it to show such a report as the Pass the API gave it.
 */
export function reviewerVerdictIsAdvice(
  overall: number | null | undefined,
  evidence: ReadonlyArray<{ met: boolean }>,
): boolean {
  if (overall !== 100) return false;
  const met = evidence.filter((item) => item.met === true).length;
  return met * 2 > evidence.length;
}
