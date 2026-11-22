/**
 * The words the teacher's console names a state with.
 *
 * One vocabulary for the learner's side and the teacher's, so a task row, a
 * phase banner, the class table and the completion record agree on each state:
 *
 * | Actual state                                              | Label |
 * |-----------------------------------------------------------|-------|
 * | Reviewed pass                                             | Review passed |
 * | Teacher credit (Mark as passed, sign-off), no reviewed pass | Credit awarded, review still needed |
 * | Reviewed pass waiting on the teacher's countersignature   | Awaiting your sign-off (teacher) / Awaiting your teacher's sign-off (learner) |
 * | Every prerequisite met                                    | Ready to continue |
 * | Review returned Needs revision                            | Needs revision |
 * | Open or being worked                                      | In progress |
 *
 * The labels only name what the API already says; the gate behind them
 * (`evidenceNeeded`, `awaitingSignOff`, the verdict) does not change.
 */
import type { InstructorPhaseView, SubmissionView } from "@learnsdlc/shared";
import type { SubmissionHistoryItem } from "@/lib/api-experience";
import { isPass, isReviewUnavailable, verdict } from "@/components/experience/shared";

export const STATE_LABEL = {
  reviewPassed: "Review passed",
  credited: "Credit awarded, review still needed",
  awaitingTeacherSignoff: "Awaiting your sign-off",
  awaitingLearnerSignoff: "Awaiting your teacher's sign-off",
  ready: "Ready to continue",
  needsRevision: "Needs revision",
  inProgress: "In progress",
} as const;

/** How a state is drawn: the badge's existing classes, nothing new. */
type StateTone = "pass" | "revision" | "locked" | "open";

export interface TeacherState {
  label: string;
  tone: StateTone;
}

/**
 * A revision's verdict in the teacher's words: a reviewed pass is "Review
 * passed", never a bare "Pass" that could be read as credit; every other
 * verdict keeps its own sentence ("Needs revision", "Review unavailable",
 * "Review in progress", "Earlier Pass / review required").
 */
export function teacherVerdict(submission: SubmissionView | SubmissionHistoryItem): TeacherState {
  if (isPass(submission)) return { label: STATE_LABEL.reviewPassed, tone: "pass" };
  const word = verdict(submission);
  const revision = submission.status === "completed" && submission.passed !== true && !isReviewUnavailable(submission);
  return { label: word, tone: revision ? "revision" : "open" };
}

/**
 * A phase cell on the class's phase map.
 *
 * - Locked is locked.
 * - A phase the board reads passed while the strict-evidence gate still wants
 *   a reviewed pass (`evidenceNeeded`) was credited by a teacher: "Credit
 *   awarded, review still needed", never drawn as a pass.
 * - A phase the board reads passed with nothing outstanding: "Review passed".
 * - A task waiting on this teacher's countersignature: "Awaiting your sign-off".
 * - The revision the cell may show (`shown`, from `phaseCellRevision`), in the
 *   teacher's words.
 * - Otherwise the phase is open: "In progress".
 */
export function phaseCellState(phase: InstructorPhaseView, shown: SubmissionView | undefined): TeacherState {
  if (phase.status === "locked") return { label: "Locked", tone: "locked" };
  if (phase.status === "passed") {
    return phase.evidenceNeeded?.length
      ? { label: STATE_LABEL.credited, tone: "open" }
      : { label: STATE_LABEL.reviewPassed, tone: "pass" };
  }
  if (phase.tasks?.some((task) => task.awaitingSignOff)) return { label: STATE_LABEL.awaitingTeacherSignoff, tone: "open" };
  if (shown) return teacherVerdict(shown);
  return { label: STATE_LABEL.inProgress, tone: "open" };
}

/**
 * A learner's latest submission in the class table and the Latest submissions
 * list. A reviewed pass of a task that now waits on this teacher's
 * countersignature reads "Awaiting your sign-off", as the phase map's cell and
 * the learner's own page ("Awaiting your teacher's sign-off") say, and turns
 * to "Review passed" once it is signed off; every other revision keeps its
 * verdict. The waiting test is `phaseCellState`'s, narrowed to the
 * submission's own task where the submission names one.
 */
export function latestSubmissionState(
  phase: Pick<InstructorPhaseView, "status" | "tasks">,
  submission: SubmissionView,
): TeacherState {
  const waiting =
    phase.status !== "passed" &&
    isPass(submission) &&
    (phase.tasks ?? []).some(
      (task) => task.awaitingSignOff && task.status !== "passed" && (!submission.taskKey || task.key === submission.taskKey),
    );
  return waiting ? { label: STATE_LABEL.awaitingTeacherSignoff, tone: "open" } : teacherVerdict(submission);
}

/**
 * Whether a class's records show it uses sign-off: a learner's task waiting on
 * the teacher's countersignature, or one already signed off. The sign-off
 * queue's empty state reads this, so it does not tell a teacher who has just
 * signed someone off how to set sign-off up.
 */
export function classUsesSignoff(
  enrollments: ReadonlyArray<{ phases: ReadonlyArray<Pick<InstructorPhaseView, "tasks">> } | null | undefined>,
): boolean {
  return enrollments.some((enrollment) =>
    (enrollment?.phases ?? []).some((phase) => (phase.tasks ?? []).some((task) => task.awaitingSignOff || Boolean(task.signedOffAt))),
  );
}

/** "14:05", the clock time a freshness line reads, on the teacher's own clock. */
export function clockTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
