"use client";
import Link from "next/link";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import { useState } from "react";
import { Check, Clock3, RotateCcw, ArrowRight, UserRound } from "lucide-react";
import { ScrollRegion } from "@/components/experience/ScrollRegion";
import { Artwork } from "@/components/experience/Artwork";
import { ReviewRefreshNotice } from "@/components/experience/ReviewRefreshNotice";
import { useProject } from "@/lib/useProject";
import { keptProjects } from "@/lib/record-project";
import { useSession } from "@/lib/session";
import { KeptProjects } from "@/components/experience/KeptProjects";
import { phasesInPlace, placeOf } from "@learnsdlc/shared";
import { PHASE_META } from "@/lib/phase";
import { projectName } from "@/lib/project-name";
import {
  EmptyProject,
  ExperiencePage,
  LoadingState,
  ReviewLoadError,
  PhasePath,
  ReviewsBreakdown,
  StatusBadge,
  formatDate,
  isPass,
  isReviewUnavailable,
  reviewHref,
  useReviews,
  verdict,
} from "@/components/experience/shared";

export default function ProgressPage() {
  const { enrollment, details, loading, projects, slug } = useProject();
  // The learner's other projects (a platform project set aside for their
  // class's) open from their review history as they do from the portfolio.
  // Before the class's project is started, the
  // Start card below carries that door, so this is drawn once it is started.
  const others = keptProjects(projects, slug, useSession()?.role);
  const { reviews, loading: reviewsLoading, refreshing, error, refreshError, refresh } = useReviews();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewIndex = reviews.findIndex(review => review.submission.id === previewId);
  const preview = previewIndex < 0 ? null : reviews[previewIndex];
  const passed =
    enrollment?.phases.filter(
      (phase) =>
        phase.status === "passed" &&
        reviews.some(
          (review) => review.phase.id === phase.id && isPass(review.submission),
        ),
    ).length ?? 0;
  // The project's own phases, in their places: a project holds the ones its
  // teacher chose, and the journey is complete when every one has a pass.
  const count = enrollment?.phases.length ?? 0;
  const done = count > 0 && passed === count;
  return (
    <ExperiencePage
      title="Your progress, in view."
      eyebrow="Your learning record"
      active="progress"
      variant="progress"
      actions={
        <Link className="exp-button" href="/profile">
          <UserRound size={15} />
          My profile
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
                {projectName(enrollment.projectTitle) || "Your project"} / Your learning record
              </span>
              <h2>
                {done
                  ? "Every phase. One complete journey."
                  : "One thoughtful revision at a time."}
              </h2>
              <p>
                Follow your review history across every phase of your project.
                Open any review to see the exact work and feedback from that
                submission.
              </p>
              <div className="exp-stats">
                <div>
                  <strong>{reviews.length}</strong>
                  <span>Recorded submissions</span>
                </div>
                <div>
                  <strong>
                    {
                      reviews.filter(
                        (review) =>
                          review.submission.status === "completed" &&
                          review.submission.passed !== true &&
                          !isReviewUnavailable(review.submission),
                      ).length
                    }
                  </strong>
                  <span>Needs revision reviews</span>
                </div>
              </div>
              <div className="exp-actions">
                <Link
                  className="exp-button exp-primary"
                  href={
                    done
                      ? "/completion"
                      : phaseDoorHref(doorWithTasks(enrollment.phases.find((phase) => phase.status !== "passed" && phase.status !== "locked") ?? enrollment.phases[0], details))
                  }
                >
                  {done
                    ? "View completion record"
                    : "Continue my project"}
                  <ArrowRight size={15} />
                </Link>
                {!done && (
                  <Link className="exp-button" href="/completion">
                    View completion record
                  </Link>
                )}
              </div>
            </div>
            <div className="exp-progress-visual">
            <Artwork kind="journey" />
            <div
              className="exp-ring"
              style={
                {
                  "--progress": `${count ? (passed / count) * 360 : 0}deg`,
                } as React.CSSProperties
              }
            >
              <div>
                <strong>
                  {passed}
                  <span> / {count}</span>
                </strong>
                <span>phases passed</span>
              </div>
            </div>
            </div>
          </section>
          <div className="exp-grid">
            <section className="exp-panel">
              <header className="exp-section-heading">
                <div>
                  <h2>Your review journey</h2>
                  <p>One lane per phase. Every review, in order.</p>
                </div>
              </header>
              <ScrollRegion
                className="exp-scroll"
                label="Review history chart. Scroll horizontally for more reviews."
                hint="Scroll sideways to follow every review."
              >
                <div
                  className="exp-journey"
                  // One lane per phase of the project: the stylesheet sizes
                  // the lanes and the plot from this count.
                  style={{
                    minWidth: Math.max(400, 140 + reviews.length * 45),
                    "--phase-count": enrollment.phases.length,
                  } as React.CSSProperties}
                >
                  <div className="exp-journey-labels">
                    {phasesInPlace(enrollment.phases).map((phase) => (
                      <span key={phase.key}>{PHASE_META[phase.key].title}</span>
                    ))}
                  </div>
                  <div className="exp-journey-plot">
                    {reviews.length ? (
                      reviews.map((review, index) => {
                        // The lane is the phase's place in the project; a
                        // review on a phase the project does not hold has no
                        // lane, so it is not drawn off the plot.
                        const place = placeOf(enrollment, review.phase.key);
                        if (!place) return null;
                        const passed = isPass(review.submission);
                        const pending =
                          isReviewUnavailable(review.submission) ||
                          review.submission.status !== "completed" ||
                          (review.submission.passed === true && !passed);
                        const Mark = passed
                          ? Check
                          : pending
                            ? Clock3
                            : RotateCcw;
                        const left = `${((index + 1) / (reviews.length + 1)) * 100}%`;
                        return (
                          <span key={review.submission.id}>
                            <Link
                              className={`exp-review-dot ${passed ? "is-pass" : pending ? "is-pending" : ""}`}
                              style={{
                                top: 35 + (place - 1) * 44,
                                left,
                              }}
                              href={reviewHref(
                                review.phase.id,
                                review.submission.id,
                              )}
                              aria-label={`Review ${index + 1}, ${review.phase.title}, ${verdict(review.submission)}, ${formatDate(review.submission.createdAt)}`}
                              title={`${review.phase.title} / ${verdict(review.submission)}`}
                              data-active={previewId === review.submission.id ? "true" : undefined}
                              onFocus={() => setPreviewId(review.submission.id)}
                              onPointerEnter={() => setPreviewId(review.submission.id)}
                            >
                              <Mark size={15} />
                            </Link>
                            <span
                              className="exp-review-number"
                              style={{ left }}
                            >
                              {index + 1}
                            </span>
                          </span>
                        );
                      })
                    ) : (
                      <span className="exp-journey-empty">
                        Your first review will begin the journey.
                      </span>
                    )}
                  </div>
                </div>
              </ScrollRegion>
              <div className="exp-review-detail" aria-label="Review point details">
                {preview ? <>
                  <strong>{preview.phase.title} / Review {previewIndex + 1}</strong>
                  <span><StatusBadge submission={preview.submission} /><time dateTime={preview.submission.createdAt}>{formatDate(preview.submission.createdAt)}</time></span>
                </> : <p>Focus or hover over a point to see its review details. Select it to open that exact submission.</p>}
              </div>
            </section>
            <section className="exp-panel">
              <header className="exp-section-heading">
                <h2>Reviews by phase</h2>
              </header>
              <ReviewsBreakdown phases={enrollment.phases} reviews={reviews} />
            </section>
          </div>
          <section className="exp-panel">
            <h2>Your phase path</h2>
            <PhasePath phases={enrollment.phases} reviews={reviews} details={details} />
          </section>
          <section className="exp-panel">
            <header className="exp-section-heading">
              <h2>Submission history</h2>
              {done && (
                <Link href="/completion" className="exp-text-link">
                  View completion
                  <ArrowRight size={14} />
                </Link>
              )}
            </header>
            {reviews.length ? (
              <ul className="exp-list">
                {[...reviews].reverse().map((review) => (
                  <li key={review.submission.id}>
                    <Link
                      href={reviewHref(review.phase.id, review.submission.id)}
                      className="exp-row"
                    >
                      <div>
                        <strong>
                          {review.phase.title} / Review{" "}
                          {review.submission.attempt ??
                            reviews
                              .filter(
                                (item) => item.phase.id === review.phase.id,
                              )
                              .indexOf(review) + 1}
                        </strong>
                        <p>
                          {review.submission.commitMessage ||
                            "Phase submission"}
                        </p>
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
                No submissions yet. Your history begins when you submit your
                Requirements work.
              </p>
            )}
          </section>
          <KeptProjects projects={others} />
        </>
      )}
    </ExperiencePage>
  );
}
