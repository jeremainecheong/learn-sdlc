"use client";
import { Artwork } from "@/components/experience/Artwork";
import { Suspense } from "react";
import Link from "next/link";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, BookOpen } from "lucide-react";
import { useProject } from "@/lib/useProject";
import { lessonsOfferedOn } from "@/lib/scenario";
import { holdsPhase, isLastPhase, placeLabel } from "@learnsdlc/shared";
import {
  ExperiencePage,
  LoadingState,
  ReviewLoadError,
  StatusBadge,
  formatDate,
  reviewHref,
  useReviews,
  isPass,
  isReviewUnavailable,
  phaseArt,
} from "@/components/experience/shared";
import { updatePageQuery } from "@/lib/navigation";
import { SubmissionEvidence } from "@/components/experience/SubmissionEvidence";
import { feedbackRevisionHref } from "@/components/experience/feedback-targets";
import { ReviewRefreshNotice } from "@/components/experience/ReviewRefreshNotice";
import { AWAITING_SIGN_OFF, phaseAwaitingSignOff, reviewAwaitsSignOff, signOffPassLine } from "@/components/workspace/signoff-status";
import { SPLIT_OPEN_HEADLINE, openRequiredWhileWaiting, requiredTaskWaits, splitOpenLine } from "@/components/workspace/signoff-surfaces-copy";

function FeedbackContent() {
  const { enrollment, details, loading: projectLoading } = useProject();
  const query = useSearchParams();
  const requestedPhase = query.get("phase");
  const requestedSubmission = query.get("submission");
  // A review this page was sent to show (after Submit for review, the history
  // held from before it) is waited for, not reported missing.
  const { reviews, loading, awaitingWanted, refreshing, error, refreshError, refresh } = useReviews(undefined, requestedSubmission);
  const phase =
    enrollment?.phases.find((item) => item.id === requestedPhase) ??
    (!requestedPhase
      ? (requestedSubmission ? reviews.find(review => review.submission.id === requestedSubmission)?.phase : reviews.at(-1)?.phase ?? enrollment?.phases[0])
      : undefined);
  const history = phase
    ? reviews.filter((review) => review.phase.id === phase.id)
    : [];
  const selected = requestedSubmission
    ? history.find((review) => review.submission.id === requestedSubmission)
    : history.at(-1);
  const unavailable = selected ? isReviewUnavailable(selected.submission) : false;
  // A passing review whose phase waits on the teacher's countersignature is
  // not "ready to build on". Judged as the
  // dashboard's line is, so the two pages say the same thing. The dashboard
  // only ever reads the latest review; an earlier one opened from the history
  // is no "verdict that just landed", so it reads the phase's own state alone.
  const latestSelected = Boolean(selected && selected.submission.id === history.at(-1)?.submission.id);
  const awaiting = Boolean(
    selected &&
      phase &&
      isPass(selected.submission) &&
      (latestSelected
        ? reviewAwaitsSignOff(details?.[phase.id], selected.submission)
        : phaseAwaitingSignOff(details?.[phase.id])),
  );
  // A split phase with a task waiting on the countersignature and a required
  // sibling still open has not passed and
  // is not only waiting on the teacher, so a passing review there reads the
  // dashboard's neutral words and names what is still open.
  const stillOpen = selected && phase && isPass(selected.submission) && !awaiting
    ? openRequiredWhileWaiting(details?.[phase.id]).map((task) => task.title)
    : [];
  return (
    <ExperiencePage
      title={phase ? `${phase.title} feedback` : "Your feedback"}
      eyebrow="Reflect. Refine. Move forward."
      active="feedback"
      variant="feedback"
      actions={
        <Link href="/progress" className="exp-button">
          <ArrowLeft size={15} />
          All reviews
        </Link>
      }
    >
      <ReviewRefreshNotice message={refreshError} refreshing={refreshing} retry={refresh} />
      {projectLoading || loading || awaitingWanted ? (
        <LoadingState />
      ) : error ? (
        <ReviewLoadError message={error} retry={refresh} />
      ) : !phase ? (
        <section className="exp-panel">
          <h2>{requestedSubmission && !requestedPhase ? "That review is not in your learning record." : "That phase is not in your learning record."}</h2>
          <Link href="/dashboard" className="exp-text-link">
            Back to your project
          </Link>
        </section>
      ) : (
        <>
          <div className="exp-review-switch">
            <label className="exp-field">
              Phase
              <select
                value={phase.id}
                onChange={(event) =>
                  updatePageQuery({ phase: event.target.value, submission: null })
                }
              >
                {enrollment?.phases
                  .filter((item) => item.status !== "locked")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <section className="exp-result-hero">
            <div className="exp-result-main">
              {selected ? (
                <StatusBadge submission={selected.submission} />
              ) : (
                <span className="exp-status">Ready when you are</span>
              )}
              <h2>
                {selected
                  ? isPass(selected.submission)
                    ? awaiting ? `${AWAITING_SIGN_OFF}.` : stillOpen.length ? SPLIT_OPEN_HEADLINE : `${phase.title} is ready to build on.`
                    : unavailable
                      ? "Your review is unavailable."
                      : selected.submission.status !== "completed"
                        ? `Your ${phase.title.toLowerCase()} work is in review.`
                        : "Use the feedback. Strengthen your work."
                  : "Good feedback starts with your work."}
              </h2>
              <p>
                {selected
                  ? selected.submission.id !== history.at(-1)?.submission.id
                    ? "You are viewing an earlier review. Its feedback and submitted evidence stay in your revision history."
                    : unavailable
                      ? "This attempt could not produce a valid assessment. It does not establish a Pass or what needs revision. Your submitted evidence stays in history. Return to the project to request another review, and address any recorded check failures."
                    : selected.submission.status !== "completed"
                      ? "Your submitted files are being reviewed. Refresh the review evidence below to check its status; a revision verdict is recorded only when the review finishes."
                    : isPass(selected.submission)
                      ? awaiting ? signOffPassLine(Boolean(enrollment && isLastPhase(enrollment, phase.key))) : stillOpen.length ? splitOpenLine(phase.title, stillOpen, requiredTaskWaits(details?.[phase.id]), Boolean(enrollment && isLastPhase(enrollment, phase.key))) : "This phase passed its evidence review. Keep the decisions and their supporting artefacts together as you move forward."
                      : "Use the evidence below to decide what to change. Revise in your project space, then submit another review."
                  : "Finish your phase artefacts and request a review from the project space. Each outcome will stay in your history."}
              </p>
              <Link
                href={selected?.submission.status === "completed" && !isPass(selected.submission) && !unavailable ? feedbackRevisionHref(doorWithTasks(phase, details)) : phaseDoorHref(doorWithTasks(phase, details))}
                className="exp-button exp-primary"
              >
                {unavailable
                  ? "Return to phase project"
                  : selected?.submission.status === "completed" && !isPass(selected.submission)
                  ? "Revise your work"
                  : "Open phase project"}
                <ArrowRight size={15} />
              </Link>
            </div>
            {selected ? <img
              className="exp-result-art"
              src={phaseArt(phase.key)}
              alt=""
              width="180"
              height="180"
            /> : <Artwork kind="evidence" className="exp-result-art" />}
            <div className="exp-result-meta">
              <span>
                {/* "Phase 2 of 3": the phase's place in its own project. */}
                <strong>{phase.title}</strong>
                {enrollment && holdsPhase(enrollment, phase.key) && ` / ${placeLabel(enrollment, phase.key)}`}
              </span>
              <span>
                {selected
                  ? `Review ${selected.submission.attempt} / ${formatDate(selected.submission.createdAt)}`
                  : "No review recorded"}
              </span>
              {/* No fixed "Pass / Needs revision" here; the badge above says the shown review's verdict. */}
            </div>
          </section>
          <div className="exp-grid">
            <div>
              {selected ? (
                <SubmissionEvidence
                  key={selected.submission.id}
                  submissionId={selected.submission.id}
                  phase={doorWithTasks(phase, details)}
                  floors={details?.[phase.id]}
                  onReviewLoaded={loaded => {
                    if (loaded.id === selected.submission.id && loaded.status !== selected.submission.status)
                      refresh();
                  }}
                />
              ) : (
                <section className="exp-panel">
                  <h2>
                    {requestedSubmission
                      ? "This review is not in this phase."
                      : "Your first review starts here."}
                  </h2>
                  <p>
                    {requestedSubmission
                      ? "Choose a recorded review from the history."
                      : "Submit your phase work from the project space. Feedback and earlier revisions will appear here."}
                  </p>
                </section>
              )}
            </div>
            <aside className="exp-stack">
              <section className="exp-panel">
                <h2>Review history</h2>
                <p>
                  Earlier verdicts and submitted files stay in your history.
                </p>
                <ul className="exp-list">
                  {[...history].reverse().map((review, index) => (
                    <li key={review.submission.id}>
                      <Link
                        href={reviewHref(phase.id, review.submission.id)}
                        aria-current={
                          selected?.submission.id === review.submission.id
                            ? "true"
                            : undefined
                        }
                      >
                        <strong>
                          Review{" "}
                          {review.submission.attempt ?? history.length - index}
                        </strong>
                        <time>{formatDate(review.submission.createdAt)}</time>
                        <div className="mt-2">
                          <StatusBadge submission={review.submission} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {history.length === 0 && <p>No submissions yet.</p>}
              </section>
              {/* Only a phase that offers its lesson. */}
              {lessonsOfferedOn(enrollment, phase.key, details) && (
                <section className="exp-lesson-nudge">
                  <BookOpen size={23} />
                  <h3 className="mt-3">A guide when you need it.</h3>
                  <p>
                    Work through explanations and examples at your own pace.
                    Lessons are optional.
                  </p>
                  <Link className="exp-text-link" href={`/learn/${phase.key}`}>
                    Open the {phase.title.toLowerCase()} lesson
                    <ArrowRight size={14} />
                  </Link>
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </ExperiencePage>
  );
}
export default function FeedbackPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <FeedbackContent />
    </Suspense>
  );
}
