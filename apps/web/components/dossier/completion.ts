/**
 * Where a project stands at its end, said one way on every page that says it.
 *
 * A project is sealed only by the learner's own last advance, the button the
 * last phase draws as "Complete the project": the API marks
 * the enrolment completed when the learner advances from the last phase with
 * a strict pass in every phase (`workflow.service.ts`, the advance), never by
 * a teacher's countersignature. Between the two the record was truthful and
 * unclear on its own, so the completion page, its seal and the dossier's cover
 * read the same three states from the same facts, and a record never says
 * "6 of 6 phases passed" beside "In progress" and "Finished: Not yet": the
 * enrolment's completed flag (or the completion date it carries) and how many
 * of its phases hold a reviewed pass.
 *
 * Pure: no React, no fetch, no clock.
 */
import type { LearnerDossier, PhaseKey, PhaseTaskView } from "@learnsdlc/shared";
import { isPass } from "@/components/experience/shared";
import type { PassKind } from "@/lib/pass-kind";

export type CompletionState = "sealed" | "all-passed" | "in-progress";

export interface CompletionFacts {
  /** The enrolment is marked completed (its completion date is set). */
  completed: boolean;
  /** Phases that hold a reviewed pass. */
  passed: number;
  /** Phases the project holds. */
  total: number;
}

export function completionState({ completed, passed, total }: CompletionFacts): CompletionState {
  if (completed) return "sealed";
  if (total > 0 && passed >= total) return "all-passed";
  return "in-progress";
}

/**
 * A phase with its revisions, and the board's `passKind` where the learner's
 * copy carries it: a dossier phase, or the completion page's board phase with
 * the reviews it lists (both pages count by one rule).
 */
type PassedPhase = {
  status: string;
  revisions: ReadonlyArray<Parameters<typeof isPass>[0]>;
  passKind?: PassKind;
};

/**
 * Whether a phase holds a reviewed pass: passed on the board AND a reviewed
 * pass behind it. A teacher's sign-off or Mark as passed alone credits the
 * board (`phasesPassed` counts it) but opens nothing.
 *
 * Where the board says which (`passKind`, the gate's own predicate, on the
 * learner's copy), that answer is taken: it also knows a pass the learner left
 * behind that a reset and a later Mark as passed turned into credit. Without
 * it (the teacher's copy, which already prints such a phase as not passed), a
 * revision the review accepted decides. The completion page counts by this
 * same predicate, so the page, its seal and the dossier's cover agree.
 */
export const holdsReviewedPass = (phase: PassedPhase): boolean =>
  phase.status === "passed" &&
  (phase.passKind ? phase.passKind === "reviewed" : phase.revisions.some((revision) => isPass(revision)));

/** A phase passed on the board by a teacher's credit, with no reviewed pass behind it. */
export const creditedWithoutReview = (phase: PassedPhase): boolean =>
  phase.status === "passed" && !holdsReviewedPass(phase);

/** How many phases hold a reviewed pass ({@link holdsReviewedPass}). */
export const reviewedPasses = (phases: ReadonlyArray<PassedPhase>): number =>
  phases.filter(holdsReviewedPass).length;

/** The dossier's facts, in the shape `completionState` reads. */
export const dossierCompletion = (dossier: Pick<LearnerDossier, "completedAt" | "phases" | "totalPhases">): CompletionState =>
  completionState({
    completed: Boolean(dossier.completedAt),
    passed: reviewedPasses(dossier.phases),
    total: dossier.totalPhases,
  });

/**
 * The press that seals a project whose every phase has passed: the band on the
 * last phase draws it as "Complete the project" (`PhaseGateBanner`), and that
 * press is the advance that marks the enrolment completed. Every sentence about
 * the step names that button by its own words.
 */
export const COMPLETE_CONTROL = "Complete the project";

/** What closes a project whose every phase has passed, for the learner and for their teacher. */
export const CLOSES_LINE_LEARNER =
  `All phases passed. The project is complete once you press ${COMPLETE_CONTROL} on the last phase.`;
export const CLOSES_LINE_TEACHER =
  `All phases passed. The project is complete once the learner presses ${COMPLETE_CONTROL} on the last phase.`;

export const closesLine = (audience: LearnerDossier["audience"]): string =>
  audience === "learner" ? CLOSES_LINE_LEARNER : CLOSES_LINE_TEACHER;

/**
 * The completion page's own closing line, which knows the count and the last
 * phase's title: "All 6 phases passed. The project is complete once you press
 * Complete the project in Maintenance."
 */
export const closesLineFor = (total: number, lastTitle: string | undefined): string => {
  const head = total === 1 ? "The phase passed." : `All ${total} phases passed.`;
  return `${head} The project is complete once you press ${COMPLETE_CONTROL} in ${lastTitle ?? "the last phase"}.`;
};

/** The cover's "Finished" fact while every phase has passed and the project is not sealed. */
export const finishedWhen = (audience: LearnerDossier["audience"]): string =>
  audience === "learner"
    ? `When you press ${COMPLETE_CONTROL} on the last phase`
    : `When the learner presses ${COMPLETE_CONTROL} on the last phase`;

/** The cover chip's word for each state. */
export const COMPLETION_CHIP: Record<CompletionState, string> = {
  sealed: "Complete",
  "all-passed": "All phases passed",
  "in-progress": "In progress",
};

/**
 * The work each phase saves, in the words the completion page lists it by:
 * the story, the design, the code, the test evidence, the deployment record
 * and the change record. The review that accepted it holds the files.
 */
export const PHASE_DELIVERABLE: Record<PhaseKey, string> = {
  requirements: "Your user story and its acceptance criteria",
  design: "Your design record and its contracts",
  implementation: "Your implementation, as merged",
  testing: "Your tests and their planted-bug evidence",
  deployment: "Your deployment record: runbook, drill and incident",
  maintenance: "Your change record and the release it shipped in",
};

/**
 * The revisions this page knows to be quiz papers: each quiz task's newest
 * one (`lastSubmissionId`), from the phase's task list where the page holds
 * it. Empty where it holds none, and on a phase with no quiz.
 */
export function quizRevisionIds(tasks: readonly Pick<PhaseTaskView, "artefactType" | "lastSubmissionId">[] | undefined): ReadonlySet<string> {
  return new Set(
    (tasks ?? [])
      .filter((task) => task.artefactType === "quiz" && task.lastSubmissionId)
      .map((task) => task.lastSubmissionId as string),
  );
}

/**
 * The review that accepted a phase's work, for the completion page's
 * "Accepted by review n": the newest pass that is not a quiz paper, else the
 * newest pass. On a phase with no quiz that is simply the newest pass; on a
 * phase whose quiz was passed after the story (Review 2 the quiz, Review 1 the
 * story) the line names the story's review, the deliverable it sits under.
 */
export function acceptingReview<T extends { submission: { id: string } }>(
  passes: readonly T[],
  quizIds: ReadonlySet<string>,
): T | undefined {
  return passes.filter((review) => !quizIds.has(review.submission.id)).at(-1) ?? passes.at(-1);
}
