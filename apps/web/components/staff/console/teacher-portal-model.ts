/**
 * What the teacher's console reads off the class it has loaded: which
 * enrolment a roster row draws, how a class row is matched to it, the roster's
 * sorts and filters, what a phase cell shows, and the sentences a passed phase
 * still waiting on a reviewed pass carries. Pure, and drawn by TeacherPortal.
 */
import type {
  InstructorEnrollmentView,
  InstructorLearnerDetail,
  InstructorPhaseView,
  PhaseEvidenceGap,
  SubmissionView,
} from "@learnsdlc/shared";
import { andList } from "@learnsdlc/shared";
import { isPass, isReviewUnavailable } from "@/components/experience/shared";

/**
 * The enrolment the roster draws for a learner: the project they are working.
 *
 * `learnerDetail` decides the order: the project the server resolves for the
 * learner comes first once they have started it, then the rest oldest first.
 * Picking their oldest alone could draw a project their class is not
 * working; picking the enrolment matching the deployment's default slug would
 * read as "not enrolled" for every learner whose class is on another project.
 *
 * A first row marked `setAside` is a platform project the learner started
 * before their class worked on another one, and they have not started the
 * class's project yet. The row is still theirs, whole and pinned, but it is
 * not this class's work. So the roster draws the learner as not started
 * rather than drawing that board, its revisions or its checklist as the
 * class's, and {@link awaitingClassProject} says why.
 */
export const enrollmentOf = (
  learner: InstructorLearnerDetail,
): InstructorEnrollmentView | undefined => {
  const first = learner.enrollments[0];
  return first && !first.setAside ? first : undefined;
};

/** Joined a class that works on another project, and has not started it yet. */
export const awaitingClassProject = (learner: InstructorLearnerDetail): boolean =>
  learner.enrollments[0]?.setAside === true;

/**
 * The printable dossier of the project the roster draws for this learner.
 *
 * It names that project. With no name the dossier route answers
 * the learner's OLDEST enrolment. For a learner whose class works on another
 * project, that is the one set aside for it, not the evidence on screen.
 */
export function dossierHref(learner: InstructorLearnerDetail, returnTo: string): string {
  const query = new URLSearchParams();
  const project = enrollmentOf(learner)?.projectSlug;
  if (project) query.set("project", project);
  query.set("returnTo", returnTo);
  return `/instructor/learners/${learner.userId}/dossier?${query}`;
}

/**
 * How a class row is matched to the learner it belongs to.
 *
 * The overview answers **one row per enrolment**, so a learner in two projects
 * has two, and a key of the learner's id alone would show one project's
 * checklist against the other project's phases. The table draws
 * `enrollmentOf(learner)` (the project they are working) so the key is that
 * enrolment's project, and a learner who has started nothing matches the row
 * whose `projectSlug` is null on the empty string both sides produce. A
 * learner who has not started their class's project matches no row, because
 * the overview's rows for them are their set-aside projects'. They get a dash
 * rather than another project's number.
 */
export const rowKey = (userId: string, projectSlug: string | null | undefined) =>
  JSON.stringify([userId, projectSlug ?? ""]);

/** What a percentage column draws where the number has not arrived. */
export const NO_PERCENT = "—";

/**
 * The roster's order. `name` is the default; the two numbers sort highest first, because the question a
 * teacher opens them with is *who is furthest along*, and a learner the API
 * has no number for sorts last rather than as a zero, which is the same rule
 * the cells draw with.
 */
export type RosterSort = "name" | "checklist" | "mastery";
export const ROSTER_SORTS: { value: RosterSort; label: string }[] = [
  { value: "name", label: "Learner name" },
  { value: "checklist", label: "Checklist, highest first" },
  { value: "mastery", label: "Quiz mastery, highest first" },
];

/** The "Latest verdict" filter's choices, as `?verdict=` names them, beside "All results". */
export const VERDICT_FILTERS: { value: string; label: string }[] = [
  { value: "pass", label: "Review passed" },
  { value: "revision", label: "Needs revision" },
  { value: "unavailable", label: "Review unavailable" },
  { value: "none", label: "No submission" },
];

/**
 * How much of one learner's trail the evidence panel reads.
 *
 * Enough to cover a term's overrides on one learner without paging, and small
 * enough that opening a learner is one cheap read beside their submissions.
 */
export const AUDIT_ROWS = 25;

/**
 * Teacher feedback reads in flight at once while the page reads the notes on
 * every queued submission: a few at a time, so a long queue stays inside the
 * route's rate limit.
 */
export const FEEDBACK_READ_BATCH = 4;

/** At most this many rows of the "to acknowledge" list are drawn. */
export const ACKNOWLEDGE_ROWS_SHOWN = 6;

/**
 * The revision a phase cell may show its verdict for, or nothing when the
 * cell should say the phase itself.
 *
 * The cell does not draw `phase.lastSubmission`, which is the newest revision
 * **on the phase**. On a split phase that can be an optional task's (so a
 * phase passed and left would read "Needs revision") or one task's pass on a
 * phase whose gate is still shut, which would read "Pass". So:
 *
 *  - a passed or locked phase says so, whatever any revision said: a
 *    teacher's Pass or Sign off writes the board, and the board is the phase;
 *  - a phase with one task is that task, so its newest revision is still its
 *    verdict while it is open;
 *  - a split phase shows a "Needs revision" only when a **required** task that
 *    has not passed was last marked that way, and otherwise says where the
 *    phase stands. One task's pass is never the phase's.
 */
export function phaseCellRevision(phase: InstructorPhaseView): SubmissionView | undefined {
  if (phase.status === "passed" || phase.status === "locked") return undefined;
  const tasks = phase.tasks ?? [];
  if (tasks.length <= 1) return phase.lastSubmission ?? undefined;
  // Each unpassed required task is asked about ITS newest revision, and the
  // cell shows the newest of those that came back Needs revision. Taking the
  // newest revision across the tasks first would let a queued or
  // review-unavailable revision of one task hide another task that is waiting
  // on a revision.
  return tasks
    .filter((task) => task.required && task.status !== "passed" && task.lastSubmission)
    .map((task) => task.lastSubmission!)
    .filter((last) => last.status === "completed" && !isPass(last) && !isReviewUnavailable(last))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * The board table's "Current phase" cell. A completed project stays on its
 * last phase (the enrolment's current phase does not move past it), so the
 * cell says the project is complete there: "Maintenance" alone reads as
 * work still under way. Every other learner's cell is the phase's title.
 */
export function currentPhaseWords(title: string, completed: boolean | undefined): string {
  return completed ? `${title}, project complete` : title;
}

/**
 * The task a revision of a split phase was, where this page knows it: the
 * newest revision of each task (`lastSubmission`) is named, as "Story
 * concepts, ". The history numbers a phase's reviews across all its tasks,
 * while each task row above it counts that task's own attempts ("1 attempt"
 * twice beside "Review 1" and "Review 2"), so naming the task is what makes
 * the two read alike. A phase with one task, and an older revision the page
 * holds no task for, carry no name.
 */
export function revisionTaskPrefix(phase: InstructorPhaseView | undefined, revisionId: string): string {
  const tasks = phase?.tasks ?? [];
  if (tasks.length < 2) return "";
  const task = tasks.find((one) => one.lastSubmission?.id === revisionId);
  return task ? `${task.title}, ` : "";
}

/**
 * The class's name as the class export's file name carries it, the same rule
 * as the API's `classFileLabel`: `-class-tuesday-class`.
 */
export function classFileLabel(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `-class-${slug || id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "class"}`;
}

/**
 * "Waiting on a reviewed pass of …": the tasks the
 * strict-evidence gate still wants a reviewed pass of on a phase the board
 * reads as passed, which is what a Sign off or a phase-wide Pass leaves. Empty
 * when Continue will be accepted.
 */
export function evidenceWaitLine(phase: Pick<InstructorPhaseView, "evidenceNeeded">): string {
  const gaps = phase.evidenceNeeded ?? [];
  if (!gaps.length) return "";
  return `Waiting on a reviewed pass of ${andList(gaps.map(gapName))}`;
}

/**
 * A gap by the name a teacher knows it by: a task of an EARLIER phase (the
 * last phase's completion arm) is named with its phase.
 */
function gapName(gap: PhaseEvidenceGap): string {
  if (!gap.phaseId) return gap.title;
  return gap.key ? `${gap.title} in ${gap.phaseTitle ?? "an earlier phase"}` : (gap.phaseTitle ?? gap.title);
}

/**
 * What the teacher can do about the wait, after {@link evidenceWaitLine}.
 *
 * A written task is submitted for review again; a quiz with no paper left
 * (`noPapersLeft`) cannot be, and only a Reset of it gives the learner another
 * paper, so the line never says "still submits it" of a quiz whose room
 * refuses to hand one out.
 */
export function evidenceWaitAdvice(phase: Pick<InstructorPhaseView, "evidenceNeeded">, name: string): string {
  const gaps = phase.evidenceNeeded ?? [];
  if (!gaps.length) return "";
  const submittable = gaps.filter((gap) => !gap.noPapersLeft);
  const spent = gaps.filter((gap) => gap.noPapersLeft);
  const head = "A sign-off or a Pass credits the work on the board; it does not stand in for the review";
  const submit = !submittable.length
    ? "."
    : `, so ${name} still submits ${
        submittable.length === gaps.length
          ? gaps.length === 1
            ? "it"
            : "each of them"
          : andList(submittable.map(gapName))
      } for one before they can move on.`;
  const reset = spent.length
    ? ` ${andList(spent.map(gapName))} ${spent.length === 1 ? "has" : "have"} no papers left, so Reset ${
        spent.length === 1 ? "it" : "each of them"
      } to give ${name} a fresh set of attempts.`
    : "";
  return `${head}${submit}${reset}`;
}

/**
 * How often returning to the tab may read the class again: a
 * teacher flicking between windows does not cost a class read each time.
 */
export const CLASS_REFRESH_THROTTLE_MS = 15_000;
