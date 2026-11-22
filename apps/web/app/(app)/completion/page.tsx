"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Download,
  Route,
  BadgeCheck,
  ChartNoAxesCombined,
} from "lucide-react";
import { keptDossierHref, useRecordProject } from "@/lib/record-project";
import { useSession } from "@/lib/session";
import { api, describeError } from "@/lib/api";
import { repoApi } from "@/lib/api-repo";
import { projectRecordFilename, saveBlob } from "@/lib/download";
import { experienceApi } from "@/lib/api-experience";
import { ReviewRefreshNotice } from "@/components/experience/ReviewRefreshNotice";
import { projectName } from "@/lib/project-name";
import { PHASE_COMPLETION_REFUSAL, phaseListSentence, phasesInPlace, type PhaseSummary } from "@learnsdlc/shared";
import { AppShell } from "@/components/AppShell";
import {
  LoadingState,
  ReviewLoadError,
  formatDate,
  isPass,
  phaseArt,
  reviewHref,
  useReviews,
} from "@/components/experience/shared";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import {
  PHASE_DELIVERABLE,
  acceptingReview,
  closesLineFor,
  completionState,
  holdsReviewedPass,
  quizRevisionIds,
} from "@/components/dossier/completion";
import type { WithPassKind } from "@/lib/pass-kind";

/**
 * `?project=<slug>` opens the completion record of one of the learner's other
 * projects (a platform project set aside for their class's), read by name,
 * its export included. With no name, or a name that is not one of theirs, this
 * is the shell's current project.
 */
function CompletionContent() {
  const { enrollment, details, loading, revalidating, kept } = useRecordProject();
  const {
    reviews,
    loading: reviewsLoading,
    refreshing,
    error: reviewsError,
    refreshError,
    refresh: refreshReviews,
  } = useReviews({ enrollment, revalidating });
  const user = useSession();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // A phase holds a reviewed pass by the one rule the printable record's
  // cover counts by (`holdsReviewedPass`): the board's `passKind`
  // where it sends one, else a passed phase with a revision the review
  // accepted. So a teacher's credit over an old passing revision (a reset,
  // then Mark as passed) is not counted here while the record says 5.
  const phases: (PhaseSummary & WithPassKind)[] = enrollment?.phases ?? [];
  const reviewedPass = (phase: PhaseSummary & WithPassKind) =>
    holdsReviewedPass({
      status: phase.status,
      passKind: phase.passKind,
      revisions: reviews
        .filter((review) => review.phase.id === phase.id)
        .map((review) => review.submission),
    });
  const passedCount = phases.filter(reviewedPass).length;
  // Every phase of this project, each with a verified pass: a
  // project holds the phases its teacher chose, and it counts as its own.
  // Once the server has recorded the project complete, a phase the learner is
  // retrying (back in progress, its earlier verified pass kept) does not
  // withdraw the record: a retry never changes the completion record.
  const count = phases.length;
  const complete =
    !!enrollment &&
    count > 0 &&
    phases.every((phase) =>
      enrollment.completed
        ? reviews.some(
            (review) => review.phase.id === phase.id && isPass(review.submission),
          )
        : reviewedPass(phase),
    );
  // One state for the seal, its counts and the printable record's cover:
  // sealed by the learner's own last advance ("Complete the project"
  // on the last phase; the enrolment's completed flag), every phase passed but
  // not yet sealed, or in progress.
  const standing = completionState({
    completed: Boolean(enrollment?.completed),
    passed: passedCount,
    total: count,
  });
  const ordered = enrollment ? phasesInPlace(enrollment.phases) : [];
  const lastPhase = ordered.at(-1);
  async function exportRecord(kind: "record" | "repo") {
    if (!complete || !enrollment || busy) return;
    setBusy(kind);
    setError("");
    try {
      const fresh = await api.myEnrollment(enrollment.projectSlug);
      const records = await experienceApi.history(enrollment.projectSlug);
      if (
        !fresh?.phases.length ||
        !fresh.phases.every(
          (phase) =>
            (fresh.completed || phase.status === "passed") &&
            records.some(
              (review) =>
                review.phaseStateId === phase.id && review.verifiedPass,
            ),
        )
      )
        throw new Error(PHASE_COMPLETION_REFUSAL);
      if (kind === "repo") {
        const archive = await repoApi.download(enrollment.projectSlug);
        saveBlob(archive.blob, archive.filename);
      } else {
        const submissions = [];
        for (let index = 0; index < records.length; index += 4)
          submissions.push(
            ...(await Promise.all(
              records.slice(index, index + 4).map(async (submission) => {
                const evidence = await api.getSubmissionWithFiles(
                  submission.id,
                );
                const teacherFeedback = await experienceApi.teacherFeedback(
                  submission.id,
                );
                return {
                  phaseKey: fresh.phases.find(
                    (phase) => phase.id === submission.phaseStateId,
                  )?.key,
                  ...evidence,
                  teacherFeedback,
                };
              }),
            )),
          );
        const record = {
          format: "learnsdlc.project-record",
          version: 1,
          exportedAt: new Date().toISOString(),
          description:
            "LearnSDLC learning record containing phase status, recorded review evidence, teacher feedback, and retained submitted file snapshots. It is not an accredited certificate. Private mentor conversations are excluded. Missing source snapshots are explicitly null.",
          learner: { displayName: user?.displayName },
          project: fresh.projectSlug,
          completedAt: fresh.completedAt,
          phases: fresh.phases.map((phase) => ({
            key: phase.key,
            status: phase.status,
            passedAt: phase.passedAt,
          })),
          submissions,
        };
        saveBlob(
          new Blob([JSON.stringify(record, null, 2)], {
            type: "application/json",
          }),
          projectRecordFilename(fresh.projectSlug),
        );
      }
    } catch (err) {
      setError(
        describeError(
          err,
          err instanceof Error
            ? err.message
            : "Your export could not be prepared.",
        ),
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <CompletionFrame>
      {kept && (
        <p className="exp-caption" data-testid="kept-project-notice">
          {projectName(kept.title)} is kept in your record: this is
          its completion record, to read and export. Your dashboard opens the
          project you are on now.
        </p>
      )}
      <ReviewRefreshNotice message={refreshError} refreshing={refreshing} retry={refreshReviews} />
      {loading || reviewsLoading ? (
        <LoadingState />
      ) : reviewsError ? (
        <ReviewLoadError message={reviewsError} retry={refreshReviews} />
      ) : !complete ? (
        <section className="exp-panel exp-completion-locked">
          <span className="exp-completion-lock-mark">
            <Route size={30} />
          </span>
          <span className="exp-eyebrow">Still taking shape</span>
          <h2>
            {count - passedCount} phase{count - passedCount === 1 ? "" : "s"} to
            bring it all together.
          </h2>
          <p>
            The completion record becomes available after every phase has a
            Pass. Your optional learning guides do not hold it back.
          </p>
          <div className="exp-completion-mini-path">
            {enrollment?.phases.map((phase) => (
              <div
                key={phase.id}
                data-passed={reviewedPass(phase)}
              >
                <img src={phaseArt(phase.key)} alt="" width="51" height="51" />
                <strong>{phase.title}</strong>
              </div>
            ))}
          </div>
          <Link href="/dashboard" className="exp-button exp-primary">
            Back to my next step
            <ArrowRight size={16} />
          </Link>
        </section>
      ) : (
        <>
          <section className="exp-certificate">
            <header className="exp-certificate-top">
              <span className="exp-certificate-wordmark">
                <img
                  src="/artwork/learnsdlc-laptop-cap.svg"
                  alt=""
                  width="32"
                  height="32"
                />
                LearnSDLC
              </span>
              <span>PROJECT COMPLETION RECORD</span>
            </header>
            <div className="exp-certificate-body">
              <img
                className="exp-completion-art"
                src="/artwork/completion-3d.webp"
                alt="A finished project portfolio, laptop with graduation cap, and cyan glass completion trophy"
                width="200"
                height="180"
              />
              <span className="exp-eyebrow">A complete software lifecycle</span>
              <h2>You saw it all the way through.</h2>
              <p>A completion record for</p>
              <strong className="exp-certificate-name">
                {user?.displayName}
              </strong>
              {/* The phases this project holds, by name. */}
              <p>{phaseListSentence(phasesInPlace(enrollment.phases).map((phase) => phase.key))}.</p>
              <div className="exp-certificate-seal">
                <BadgeCheck size={41} />
                <span>
                  {count} phase{count === 1 ? "" : "s"}
                  <br />
                  <strong>
                    {count} pass{count === 1 ? "" : "es"}
                  </strong>
                </span>
              </div>
              {/* Every phase passed and the project not yet sealed: the one
                  press left is the last phase's "Complete the project", and
                  the link opens that phase, where its band draws the button.
                  Sealed, the footer carries the date instead. */}
              {standing === "all-passed" && (
                <p data-testid="completion-closing">
                  {closesLineFor(count, lastPhase?.title)}{" "}
                  {lastPhase && (
                    <Link
                      className="exp-text-link"
                      data-testid="completion-closing-open"
                      href={phaseDoorHref(doorWithTasks(lastPhase, details))}
                    >
                      Open {lastPhase.title}
                    </Link>
                  )}
                </p>
              )}
              <div className="exp-certificate-footer">
                {standing === "sealed" && enrollment.completedAt && (
                  <div>
                    <span>Recorded</span>
                    <strong>{formatDate(enrollment.completedAt)}</strong>
                  </div>
                )}
                <div>
                  <span>Project</span>
                  {/* The project this record is of. */}
                  <strong>{projectName(enrollment.projectTitle) || "Your project"}</strong>
                </div>
              </div>
            </div>
            <p className="exp-certificate-disclaimer">
              Based on your {count} passed evidence review{count === 1 ? "" : "s"}.
              This learning record is not an accredited certificate.
            </p>
          </section>
          <div className="exp-completion-actions">
            <div>
              <h2>You have a story worth showing.</h2>
              <p>
                Use the evidence from each phase to explain your decisions, the
                trade-offs, and what changed.
              </p>
            </div>
            <div className="exp-actions">
              <button
                className="exp-button exp-primary"
                disabled={Boolean(busy)}
                onClick={() => void exportRecord("record")}
              >
                <Download size={16} />
                {busy === "record"
                  ? "Preparing record…"
                  : "Export project record"}
              </button>
              <button
                className="exp-button"
                disabled={Boolean(busy)}
                onClick={() => void exportRecord("repo")}
              >
                {busy === "repo"
                  ? "Preparing repository…"
                  : "Download repository"}
              </button>
            </div>
          </div>
          {(error || reviewsError) && (
            <p role="alert" className="exp-error">
              {error || reviewsError}
            </p>
          )}
          <section className="exp-panel" data-testid="completion-evidence" aria-labelledby="completion-evidence-title">
            <header className="exp-section-heading">
              <div>
                <span className="exp-eyebrow">Your evidence</span>
                <h2 id="completion-evidence-title">Every phase. Evidence for each one.</h2>
              </div>
              <Link href="/progress" className="exp-text-link">
                All reviews
                <ArrowRight size={14} />
              </Link>
            </header>
            {/* The whole record from here: the printable record, the
                journal of every event and the portfolio of every revision, by
                their own routes. A kept project's journal and portfolio are
                the current project's pages, so only its record is linked. */}
            <nav
              className="exp-actions"
              style={{ justifyContent: "flex-start", margin: "4px 0 14px" }}
              aria-label="Your records"
              data-testid="completion-records"
            >
              <Link
                className="exp-button"
                href={kept ? keptDossierHref(kept.slug) : "/dossier"}
              >
                Printable record
                <ArrowRight size={14} />
              </Link>
              {!kept && (
                <>
                  <Link className="exp-button" href="/journal">
                    Journal
                    <ArrowRight size={14} />
                  </Link>
                  <Link className="exp-button" href="/artefacts">
                    Artefacts
                    <ArrowRight size={14} />
                  </Link>
                </>
              )}
            </nav>
            <div className="exp-completion-portfolio">
              {enrollment.phases.map((phase) => {
                const submissions = reviews.filter(
                  (review) => review.phase.id === phase.id,
                );
                // The review that accepted the phase's work: the newest pass
                // that is not a quiz paper. A quiz is a task of the
                // phase too, and its paper is a recorded review, but it is not
                // the deliverable the line names ("Your user story ...").
                const passed = acceptingReview(
                  submissions.filter((review) => isPass(review.submission)),
                  quizRevisionIds(details?.[phase.id]?.tasks),
                );
                return (
                  <Link
                    className="exp-completion-portfolio-item"
                    key={phase.id}
                    href={reviewHref(phase.id, passed?.submission.id)}
                  >
                    <img
                      src={phaseArt(phase.key)}
                      alt=""
                      width="78"
                      height="78"
                    />
                    <div className="exp-row-main">
                      <h3>{phase.title}</h3>
                      <p>
                        {submissions.length} recorded submission
                        {submissions.length === 1 ? "" : "s"}
                      </p>
                      {/* What the phase saved, and the review that accepted
                          it: the link opens that review, with its files. */}
                      <p data-testid={`completion-deliverable-${phase.key}`}>
                        {PHASE_DELIVERABLE[phase.key]}
                      </p>
                      {passed && (
                        <p data-testid={`completion-accepted-${phase.key}`}>
                          Accepted by review {passed.submission.attempt ?? submissions.indexOf(passed) + 1},{" "}
                          {formatDate(passed.submission.createdAt)}
                        </p>
                      )}
                      <span className="exp-text-link">
                        Inspect evidence
                        <ArrowRight size={13} />
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
          <details className="exp-export-details">
            <summary>What is included in your exports?</summary>
            <p>
              Your JSON export contains phase passes, review evidence, teacher
              feedback, and retained submitted file snapshots. Missing snapshots
              in older or imported records are marked unavailable. The
              repository ZIP contains retained submitted editable files, Git
              revision history, and activity summaries. It excludes starter
              infrastructure and is not a standalone runnable application. This
              learning record is not an accredited certificate.
            </p>
          </details>
        </>
      )}
    </CompletionFrame>
  );
}

/**
 * The page's frame: `ExperiencePage`'s heading and column, drawn here because
 * that frame names the page in the bar by its heading. Here the bar reads
 * "Progress › Completion record", not the heading a second time, and the
 * rail lights Progress, the learner's record this page belongs to and the
 * row that links here. The rail has no "dossier" row, so lighting that key
 * would leave no row current.
 */
const COMPLETION_CRUMBS = [{ label: "Progress", href: "/progress" }, { label: "Completion record" }];

function CompletionFrame({ children }: { children: React.ReactNode }) {
  return (
    <AppShell active="progress" crumbs={COMPLETION_CRUMBS}>
      <main id="main" tabIndex={-1} className="exp-page exp-completion-page">
        <header className="exp-heading">
          <div>
            <span className="exp-eyebrow">The complete lifecycle</span>
            <h1>Your project, from idea to improvement.</h1>
          </div>
          <div className="exp-actions">
            <Link href="/progress" className="exp-button">
              <ChartNoAxesCombined size={15} />
              My progress
            </Link>
          </div>
        </header>
        {children}
      </main>
    </AppShell>
  );
}

/** `useSearchParams` reads the query in the browser, so the page renders it inside a boundary. */
export default function CompletionPage() {
  return (
    <Suspense fallback={null}>
      <CompletionContent />
    </Suspense>
  );
}
