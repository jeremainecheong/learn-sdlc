"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { doorWithTasks, heldNoInterview, phaseDoorHref } from "@/components/shell/routes";
import { ArrowRight, BookOpen, FileCode2 } from "lucide-react";
import { useProject } from "@/lib/useProject";
import { anyLessonsOffered, lessonsOfferedOn, scenarioIsReference } from "@/lib/scenario";
import { projectName } from "@/lib/project-name";
import { chooseTask, isSplit } from "@/components/workspace/TaskPanel";
import { latestFeedbackLine, reviewAwaitsSignOff } from "@/components/workspace/signoff-status";
import type { PhaseKey, PhaseTaskView } from "@learnsdlc/shared";
import { firstPhaseOf, isLastPhase, phasesInPlace, placeOf } from "@learnsdlc/shared";
import { phaseCountUnit } from "@/lib/subset";
import { useSession } from "@/lib/session";
import { useViewAs } from "@/lib/view-as";
import { ReviewRefreshNotice } from "@/components/experience/ReviewRefreshNotice";
import { YourNumbers } from "@/components/home/YourNumbers";
import { HomeProjectMap } from "@/components/home/HomeProjectMap";
import { COMPLETE_CONTROL } from "@/components/dossier/completion";
import { takeJoinedClass } from "./joined-class";
import {
  EmptyProject,
  ExperiencePage,
  LoadingState,
  ProjectNameLine,
  ReviewLoadError,
  PhasePath,
  ReviewsBreakdown,
  StatusBadge,
  formatDate,
  isPass,
  phaseArt,
  reviewHref,
  useReviews,
} from "@/components/experience/shared";

const HERO_COPY = {
  requirements: {
    greeting: "Every good project starts with a good question.",
    title: "Start with the right problem.",
    // Neutral on purpose: a line naming the reference project's own story
    // (TaskTrackr's overdue report) would be wrong on every other project.
    copy: "Interview your stakeholder, then write a user story with acceptance criteria a test could check.",
    task: "Write your user story",
  },
  design: {
    greeting: "You’ve found the problem. Now give the solution a shape.",
    title: "Make the pieces fit.",
    copy: "Design the data, the HTTP operations and the screens against the agreed stories, then explain one tradeoff.",
    task: "Define the contracts and screens",
  },
  implementation: {
    greeting: "You’ve laid the groundwork. Let’s bring it to life.",
    title: "Your project is taking shape.",
    copy: "Complete five gaps across the Python API and TypeScript front end so the contracts become working behaviour.",
    task: "Implement the five feature gaps",
  },
  testing: {
    greeting: "It works. Now let’s find out where it might break.",
    title: "Get curious. Try the edges.",
    copy: "Prove completion, filters, the overdue report, and the late marker with acceptance tests on both sides of the contract.",
    task: "Prove the stories with acceptance tests",
  },
  deployment: {
    greeting: "Your work is nearly out in the world. Make it a careful launch.",
    title: "Ready the project for takeoff.",
    copy: "Finish the API image, connect the two services, wire both test suites into CI, and prepare the operator’s runbook.",
    task: "Prepare the two-service release",
  },
  maintenance: {
    greeting: "The first release is a beginning. Keep making it better.",
    title: "Good software keeps growing.",
    copy: "Deliver CR-2: comments on a task and a comment-count badge, while keeping existing lists, filters, and overdue behaviour working.",
    task: "Add comments without regressions",
  },
};

/**
 * The hero's line for a phase that is not the reference project's scenario.
 * The copy above for the last four
 * phases describes the reference application's work (its five gaps, its
 * overdue report, its CR-2), true of a teacher's copy only while the phase is
 * still the reference's. Otherwise the phase's own opening is read from its
 * summary; a payload without one gets a sentence true of any project.
 * Requirements' and Design's lines above already are.
 */
const NEUTRAL_HERO: Record<PhaseKey, { copy: string; task: string }> = {
  requirements: { copy: HERO_COPY.requirements.copy, task: HERO_COPY.requirements.task },
  design: { copy: HERO_COPY.design.copy, task: HERO_COPY.design.task },
  implementation: { copy: "Build what this phase’s tasks ask for, so the agreed contracts become working behaviour.", task: "Complete this phase’s tasks" },
  testing: { copy: "Prove the agreed stories with tests that would fail on a wrong answer.", task: "Prove the stories with tests" },
  deployment: { copy: "Package the project, check it in a pipeline, and prepare the operator’s runbook.", task: "Prepare the release" },
  maintenance: { copy: "Change what this phase asks for while keeping existing behaviour working.", task: "Make the change without regressions" },
};

/**
 * The first required task of this phase still to pass, by its title, where the
 * phase has a list: the task a class's teacher actually set.
 */
function nextTaskTitle(tasks: PhaseTaskView[] | undefined): string | undefined {
  if (!isSplit(tasks)) return undefined;
  const next = chooseTask(tasks, null);
  return next && next.status !== "passed" ? next.title : undefined;
}

export default function DashboardPage() {
  const project = useProject();
  const user = useSession();
  // While a teacher views a learner's work, the page is the learner's, and so
  // is the greeting: the teacher's own name over the learner's board would
  // misread whose work it is.
  const viewing = useViewAs();
  const greeted = viewing?.displayName ?? user?.displayName;
  const { reviews, loading: reviewsLoading, refreshing, error, refreshError, refresh } = useReviews();
  // The class the first-run page just joined, said once on arrival.
  // Read after mount: the server render has no session storage.
  const [joinedClass, setJoinedClass] = useState<string | null>(null);
  useEffect(() => {
    const name = takeJoinedClass();
    if (name) setJoinedClass(name);
  }, []);
  const phase = project.currentPhase;
  const latest = reviews.at(-1);
  const heroKey: PhaseKey = phase?.key ?? "requirements";
  // The step line names the task the phase actually waits on where it has a
  // list: on a teacher's project that is their task, not the reference's.
  // The reference story's line shows only on a phase that is still the
  // reference's (the default project, or a copy's inherited phase).
  const referenceHero = !phase || scenarioIsReference(phase, project.enrollment);
  const heroLine = referenceHero
    ? HERO_COPY[heroKey]
    : { copy: phase?.intro?.trim() || NEUTRAL_HERO[heroKey].copy, task: NEUTRAL_HERO[heroKey].task };
  const heroCopy = {
    ...HERO_COPY[heroKey],
    copy: heroLine.copy,
    task:
      nextTaskTitle(phase ? project.details?.[phase.id]?.tasks : undefined) ??
      heroLine.task,
  };
  // The lessons teach the reference project, so a project that offers none
  // draws no door to them, and the guide link
  // follows the phase it names.
  const lessons = anyLessonsOffered(project.enrollment, project.details);
  const guideKey: PhaseKey = phase?.key ?? "requirements";
  const guide = lessonsOfferedOn(project.enrollment, guideKey, project.details);
  // The held Requirements detail says whether its phase holds no interview (a
  // bare summary says nothing, and keeps the interview line).
  const requirementsPhase = project.enrollment?.phases.find((item) => item.key === "requirements");
  const noInterview = requirementsPhase
    ? heldNoInterview(doorWithTasks(requirementsPhase, project.details))
    : false;
  const passed =
    project.enrollment?.phases.filter(
      (item) =>
        item.status === "passed" &&
        reviews.some(
          (review) => review.phase.id === item.id && isPass(review.submission),
        ),
    ).length ?? 0;
  // The project's own phases: a project holds the ones its teacher chose, so
  // the journey is complete when every one of them has a verified pass.
  const count = project.enrollment?.phases.length ?? 0;
  const done = count > 0 && passed === count;
  // Every phase passed is not yet a complete project: the learner's own
  // "Complete the project" on the last phase seals it (the enrolment's
  // completed flag). Until then the hero says so and opens that phase, rather
  // than calling the journey complete (the completion page's closing line says
  // the same).
  const sealed = done && Boolean(project.enrollment?.completed);
  const unsealed = done && !sealed;
  const lastPhase = project.enrollment ? phasesInPlace(project.enrollment.phases).at(-1) : undefined;
  const first = project.enrollment ? firstPhaseOf(project.enrollment) : null;
  return (
    <ExperiencePage
      title={`Welcome${greeted ? `, ${greeted.split(" ")[0]}` : ""}.`}
      eyebrow={heroCopy.greeting}
      variant="dashboard"
      actions={
        lessons ? (
          <Link href="/learn" className="exp-button">
            <BookOpen size={16} />
            Explore lessons
          </Link>
        ) : undefined
      }
    >
      <ReviewRefreshNotice message={refreshError} refreshing={refreshing} retry={refresh} />
      {joinedClass && (
        <p role="status" className="exp-success" data-testid="dashboard-joined-class">
          You joined {joinedClass}.
        </p>
      )}
      {project.loading || reviewsLoading ? (
        <LoadingState />
      ) : error ? (
        <ReviewLoadError message={error} retry={refresh} />
      ) : !project.enrollment ? (
        <EmptyProject />
      ) : (
        <>
          {project.error && (
            <p className="exp-error" role="alert">
              {project.error}
            </p>
          )}
          <div className="exp-dashboard-top">
            <section className="exp-panel exp-hero exp-resume">
              <div>
                <span className="exp-resume-label">
                  <i />
                  Phase {String(phase ? placeOf(project.enrollment, phase.key) : 1).padStart(2, "0")} /{" "}
                  {phase?.title ?? (projectName(project.enrollment.projectTitle) || "Your project")}
                </span>
                <ProjectNameLine title={project.enrollment.projectTitle} />
                <h2>
                  {sealed
                    ? "A complete journey. A project to show for it."
                    : unsealed
                      ? "Every phase passed. One step left."
                      : phase
                        ? heroCopy.title
                        : "Turn your ideas into working software."}
                </h2>
                <p>
                  {sealed
                    ? "Your phase passes tell the story of what you built. Revisit your evidence and take your project with you."
                    : unsealed
                      ? `Press ${COMPLETE_CONTROL} in ${lastPhase?.title ?? "the last phase"} to complete your project.`
                      : heroCopy.copy}
                </p>
                <div className="exp-actions">
                  <Link
                    className="exp-button exp-primary"
                    href={
                      sealed
                        ? "/completion"
                        : unsealed && lastPhase
                          ? phaseDoorHref(doorWithTasks(lastPhase, project.details))
                          : phase
                          ? // The phase's task list where this page holds one,
                            // so "Continue my project" opens the quiz room on
                            // a phase whose quiz is the last thing left to
                            // pass. Without it the door opens the phase as
                            // if it had no quiz.
                            phaseDoorHref(doorWithTasks(phase, project.details))
                          : "/phases"
                    }
                  >
                    {sealed
                      ? "View completion record"
                      : unsealed && lastPhase
                        ? `Open ${lastPhase.title}`
                        : "Continue my project"}
                    <ArrowRight size={16} />
                  </Link>
                  {latest && (
                    <Link
                      className="exp-text-link"
                      href={reviewHref(latest.phase.id, latest.submission.id)}
                    >
                      Latest feedback
                      <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
                {guide && (
                  <Link
                    className="exp-resume-guide"
                    href={`/learn/${guideKey}`}
                  >
                    <BookOpen size={15} />
                    Read the optional guide
                  </Link>
                )}
                <div className="exp-resume-foot">
                  <FileCode2 size={17} />
                  <span>
                    <small>
                      {sealed
                        ? "Your record"
                        : unsealed
                          ? "Your last step"
                          : reviews.length
                            ? "Pick up where you left off"
                            : "Your first step"}
                    </small>
                    <strong>
                      {sealed
                        ? "View your completion record"
                        : unsealed
                          ? COMPLETE_CONTROL
                          : heroCopy.task}
                    </strong>
                  </span>
                </div>
              </div>
              <img
                src={
                  done
                    ? "/artwork/completion-3d.webp"
                    : phaseArt(phase?.key ?? "requirements")
                }
                alt=""
                width="220"
                height="220"
              />
            </section>
            <section className="exp-panel exp-learning-record">
              <header className="exp-section-heading">
                <h2>Your learning record</h2>
                <Link href="/progress" className="exp-text-link">
                  View
                  <ArrowRight size={14} />
                </Link>
              </header>
              <div className="exp-record-total">
                <strong>{passed}</strong>
                {/* The line after the number: "/ 3 phases passed". */}
                <span>{phaseCountUnit(count)}</span>
              </div>
              <p>
                {reviews.length} recorded{" "}
                {reviews.length === 1 ? "review" : "reviews"}
              </p>
              <ReviewsBreakdown
                phases={project.enrollment.phases}
                reviews={reviews}
              />
            </section>
          </div>
          {/* The project as a map: every phase's work and the lines between
              what was promised and what proves it, between the project's own
              line above and the phase list below. */}
          <HomeProjectMap
            enrollment={project.enrollment}
            details={project.details ?? {}}
            map={project.map ?? null}
            // The first load is covered by the page's own LoadingState above,
            // and a refresh never puts a skeleton over a drawing
            // (lib/useProject): only a refresh with neither a map nor a phase
            // detail in hand waits on one.
            pending={project.revalidating && Object.keys(project.details ?? {}).length === 0}
            done={done}
          />
          <section className="exp-dashboard-journey">
            <header className="exp-section-heading">
              <div>
                <h2>One project. Every phase connected.</h2>
                <p>See how each step builds on the last.</p>
              </div>
              <Link href="/progress" className="exp-text-link">
                View progress
                <ArrowRight size={14} />
              </Link>
            </header>
            <PhasePath phases={project.enrollment.phases} reviews={reviews} details={project.details} />
          </section>
          {/* The sponsor's "overview of the checklist as one intuitive
              percentage", on the page a learner opens. It is drawn from
              `project.analytics`, which this page already holds: the panel
              formats and never computes, and the two definitions it shows
              come from the one percentages module the class table shares. */}
          {project.analytics && <YourNumbers analytics={project.analytics} />}
          <div className="exp-grid exp-grid-even">
            <section className="exp-panel">
              <header className="exp-section-heading">
                <div className="exp-art-heading">
                  <span className="exp-support-art" aria-hidden="true" />
                  <div>
                    <h2>
                      {latest
                        ? "Your latest feedback"
                        : "Your first review starts here"}
                    </h2>
                    <p>Make an attempt, then use the feedback.</p>
                  </div>
                </div>
              </header>
              <p>
                {/* A passing review never asks for a revision, and one
                    waiting on the teacher's countersignature says what it
                    opens: the next phase, or on the project's last phase the
                    way to complete it. A refused review asks for the next revision. */}
                {latest
                  ? latestFeedbackLine(latest.phase.title, isPass(latest.submission), reviewAwaitsSignOff(project.details?.[latest.phase.id], latest.submission), Boolean(project.enrollment && isLastPhase(project.enrollment, latest.phase.key)))
                  : "Your review record begins when you submit phase work. Specific feedback will help you decide what to improve."}
              </p>
              <Link
                className="exp-text-link"
                href={
                  latest
                    ? reviewHref(latest.phase.id, latest.submission.id)
                    : phase ? phaseDoorHref(doorWithTasks(phase, project.details)) : "/progress"
                }
              >
                {latest ? "Open feedback" : `Start in ${first?.title ?? "your first phase"}`}
                <ArrowRight size={14} />
              </Link>
            </section>
            <section className="exp-panel">
              <header className="exp-section-heading">
                <div className="exp-art-heading">
                  <span
                    className="exp-support-art is-artefacts"
                    aria-hidden="true"
                  />
                  <h2>Your recent work</h2>
                </div>
              </header>
              {reviews.length ? (
                <ul className="exp-list">
                  {reviews
                    .slice(-4)
                    .reverse()
                    .map((review) => (
                      <li key={review.submission.id}>
                        <Link
                          className="exp-row"
                          href={reviewHref(
                            review.phase.id,
                            review.submission.id,
                          )}
                        >
                          <div>
                            <strong>{review.phase.title}</strong>
                            <time dateTime={review.submission.createdAt}>
                              {formatDate(review.submission.createdAt)}
                            </time>
                          </div>
                          <StatusBadge submission={review.submission} />
                        </Link>
                      </li>
                    ))}
                </ul>
              ) : (
                <p>
                  {/* A project whose Requirements holds no
                      interview starts at its brief. */}
                  {noInterview
                    ? "Your first submission will appear here. Start with the Requirements brief."
                    : "Your first submission will appear here. Start by talking with stakeholders in Requirements."}
                </p>
              )}
              <Link className="exp-text-link" href="/progress">
                Open your review history
                <ArrowRight size={14} />
              </Link>
            </section>
          </div>
        </>
      )}
    </ExperiencePage>
  );
}
