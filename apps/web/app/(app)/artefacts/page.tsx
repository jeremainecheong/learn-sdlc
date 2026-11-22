"use client";

import Link from "next/link";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import { ArrowRight, FolderOpen, LockKeyhole } from "lucide-react";
import { useProject } from "@/lib/useProject";
import { keptProjects } from "@/lib/record-project";
import { useSession } from "@/lib/session";
import { KeptProjects } from "@/components/experience/KeptProjects";
import { phasesInPlace, placeOf } from "@learnsdlc/shared";
import { PHASE_META } from "@/lib/phase";
import { ReviewRefreshNotice } from "@/components/experience/ReviewRefreshNotice";
import { projectName } from "@/lib/project-name";
import {
  EmptyProject,
  ExperiencePage,
  LoadingState,
  ReviewLoadError,
  StatusBadge,
  formatDate,
  isPass,
  phaseArt,
  phaseTaskLines,
  reviewHref,
  useReviews,
} from "@/components/experience/shared";

export default function PortfolioPage() {
  const { enrollment, details, loading, projects, slug } = useProject();
  // The learner's other projects (a platform project set aside for their
  // class's) open from their portfolio too.
  const others = keptProjects(projects, slug, useSession()?.role);
  const { reviews, loading: reviewsLoading, refreshing, error, refreshError, refresh } = useReviews();
  // Every phase of this project, each with a verified pass: a
  // project holds the phases its teacher chose.
  const completed =
    !!enrollment &&
    enrollment.phases.length > 0 &&
    enrollment.phases.every(
      (phase) =>
        phase.status === "passed" &&
        reviews.some(
          (review) => review.phase.id === phase.id && isPass(review.submission),
        ),
    );
  return (
    <ExperiencePage
      title="Your project portfolio"
      eyebrow="A connected record of what you built"
      active="artefacts"
      variant="portfolio"
      actions={
        <Link href="/progress" className="exp-button">
          Review history
          <ArrowRight size={15} />
        </Link>
      }
    >
      <ReviewRefreshNotice message={refreshError} refreshing={refreshing} retry={refresh} />
      {loading || reviewsLoading ? (
        <LoadingState />
      ) : error ? (
        <ReviewLoadError message={error} retry={refresh} />
      ) : !enrollment ? (
        <EmptyProject />
      ) : (
        <>
          <section className="exp-panel exp-hero">
            <div>
              <span className="exp-eyebrow">
                {/* The learner's project, not the reference one. */}
                {projectName(enrollment.projectTitle) || "Your project"} / The evidence of each phase
              </span>
              <h2>From a first idea to a maintained release.</h2>
              <p>
                Your portfolio connects each phase to its submitted files and
                feedback. Open a revision to inspect exactly what you submitted
                at that point.
              </p>
              {completed && (
                <Link className="exp-button exp-primary" href="/completion">
                  View completion and exports
                  <ArrowRight size={16} />
                </Link>
              )}
            </div>
            <img
              src="/artwork/phase-artefacts-3d.webp"
              alt="A 3D collection of project artefacts"
              width="220"
              height="220"
            />
          </section>
          <div className="exp-grid exp-grid-even">
            {/* The project's own phases, in their places: a phase the project
                does not hold is not drawn, locked or otherwise. */}
            {phasesInPlace(enrollment.phases).map((phase) => {
              const key = phase.key;
              const history = reviews.filter(
                (review) => review.phase.key === key,
              );
              const latest = history.at(-1);
              const tasks = phaseTaskLines(phase, details?.[phase.id]?.tasks);
              // Where the phase stands, in the path tile's words for it: a
              // one-task phase that has been marked shows its newest verdict,
              // and otherwise "In review" only while that revision is marked.
              // Whatever the phase's status, its first revision is marked
              // while it is still in progress. One case
              // stays apart from the tile: an in-progress one-task phase whose
              // newest revision has settled (a reopened or reset phase) reads
              // In progress here, where the tile shows that old verdict.
              const marking =
                latest?.submission.status === "queued" ||
                latest?.submission.status === "running";
              const verdictShown =
                (phase.status === "submitted" || (phase.status === "in_progress" && marking)) && !!latest && !tasks;
              return (
                <section className="exp-panel" key={key}>
                  <header className="exp-section-heading">
                    <div className="exp-row">
                      <img src={phaseArt(key)} width="78" height="78" alt="" />
                      <div>
                        <span className="exp-eyebrow">
                          Phase {placeOf(enrollment, key)}
                        </span>
                        <h2>{PHASE_META[key].title}</h2>
                      </div>
                    </div>
                    {verdictShown && latest ? (
                      <StatusBadge submission={latest.submission} />
                    ) : (
                      <StatusBadge status={phase.status} reviewing={marking} />
                    )}
                  </header>
                  {/* A teacher may split a written phase into several pieces
                      of work, and then the evidence below is the phase's, not
                      one task's. How far its tasks have got is the fact that
                      says which. */}
                  {tasks && (
                    <p data-testid={`portfolio-tasks-${key}`}>{tasks.counts}</p>
                  )}
                  {latest ? (
                    <>
                      <p>
                        {history.length} recorded revision
                        {history.length === 1 ? "" : "s"}. Your submitted
                        snapshots remain linked to their original reviews.
                      </p>
                      <ul className="exp-list">
                        {history
                          .slice(-3)
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
                                  <strong>
                                    {review.submission.commitMessage ||
                                      `Review ${review.submission.attempt}`}
                                  </strong>
                                  <time>
                                    {formatDate(review.submission.createdAt)}
                                  </time>
                                </div>
                                <StatusBadge submission={review.submission} />
                              </Link>
                            </li>
                          ))}
                      </ul>
                      <Link
                        className="exp-text-link mt-4"
                        href={reviewHref(latest.phase.id, latest.submission.id)}
                      >
                        Open phase evidence
                        <ArrowRight size={14} />
                      </Link>
                    </>
                  ) : (
                    <>
                      <p>
                        {phase.status === "locked"
                          ? "This part of your portfolio opens after the preceding phase passes."
                          : "Submit your phase work to add the first evidence to this part of your portfolio."}
                      </p>
                      {phase.status !== "locked" ? (
                        <Link
                          className="exp-text-link"
                          href={phaseDoorHref(doorWithTasks(phase, details))}
                        >
                          <FolderOpen size={16} />
                          Open project space
                          <ArrowRight size={14} />
                        </Link>
                      ) : (
                        <span className="exp-status is-locked">
                          <LockKeyhole size={14} />
                          Evidence to come
                        </span>
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>
          <section className="exp-panel">
            <h2>Every revision has its own story.</h2>
            <p>
              Snapshots show the files retained from each submitted revision. If
              source files are unavailable for an older or imported record, the
              review clearly says so. Course completion and the complete project
              record require a recorded pass in every phase of the project.
            </p>
            <Link href="/dossier" className="exp-text-link">
              Print project evidence
              <ArrowRight size={14} />
            </Link>
          </section>
          <KeptProjects projects={others} />
        </>
      )}
    </ExperiencePage>
  );
}
