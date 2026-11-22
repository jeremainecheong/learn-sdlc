"use client";

import { sameSession } from '@/lib/session-token';
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { doorWithTasks, phaseDoorHref } from "@/components/shell/routes";
import {
  ArrowRight,
  Check,
  Circle,
  Clock3,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";
import type { EnrollmentView, PhaseKey, PhaseSummary, PhaseTaskView, SubmissionView } from "@learnsdlc/shared";
import { AppShell } from "@/components/AppShell";
import type { NavKey } from "@/components/shell/types";
import { describeError } from "@/lib/api";
import type { SubmissionHistoryItem } from "@/lib/api-experience";
import { useProject } from "@/lib/useProject";
// The one place a phase's task counts
// become a sentence, so the tile, the portfolio panel and the room header
// cannot word the same numbers differently.
import { taskAttemptsLine, taskCountLine } from "@/components/workspace/TaskPanel";
import { cachedReviewHistory, loadReviewHistory, ReviewHistorySuperseded } from "@/lib/review-history";
import { getToken, useRole } from "@/lib/session";
import { keptDossierHref } from "@/lib/record-project";
import { PHASE_META, phaseArt } from "@/lib/phase";
import { andList, phasesInPlace, pluralWord, reviewerVerdictIsAdvice } from "@learnsdlc/shared";
import { projectName } from "@/lib/project-name";
import "./experience.css";

export type Review = { phase: PhaseSummary; submission: SubmissionHistoryItem };
export { phaseArt };
export const reviewHref = (phase: string, submission?: string) =>
  `/feedback?phase=${encodeURIComponent(phase)}${submission ? `&submission=${encodeURIComponent(submission)}` : ""}`;
export const formatDate = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
/**
 * A verified pass, as the API decides it. The reviewer's verdict is advice,
 * not a gate, on the rule `reviewerVerdictIsAdvice` (the API's own), so a
 * report the API passed on that rule is never shown as anything but a Pass.
 */
export const isPass = (submission: SubmissionView | SubmissionHistoryItem) =>
  submission.status === "completed" &&
  submission.passed === true &&
  ("verifiedPass" in submission
    ? submission.verifiedPass === true
    : submission.report?.assessmentMode === "strict_binary" &&
      submission.report.passed === true &&
      submission.workspaceSnapshot !== null &&
      !submission.report.aiReview?.assessmentError &&
      Boolean(submission.report.aiReview?.criteriaEvidence?.length) &&
      (reviewerVerdictIsAdvice(submission.report.overall, submission.report.aiReview?.criteriaEvidence ?? []) ||
        (submission.report.aiReview?.verdict === "pass" &&
          submission.report.aiReview.criteriaEvidence!.every(
            (item) => item.met && item.evidence?.trim() && !item.issue?.trim(),
          ))) &&
      submission.report.checks?.some((item) => item.id !== "process") &&
      submission.report.checks
        .filter((item) => item.id !== "process")
        .every((item) => item.status === "passed" || item.status === "info"));
/** A failed review cannot establish that the learner's work needs revision. */
export const isReviewUnavailable = (submission: SubmissionView | SubmissionHistoryItem) =>
  submission.status === "failed" ||
  (submission.status === "completed" &&
    ("report" in submission
      ? !submission.report || Boolean(submission.report.aiReview?.assessmentError)
      : submission.reviewUnavailable === true));
export const verdict = (submission: SubmissionView | SubmissionHistoryItem) =>
  isPass(submission)
    ? "Pass"
    : isReviewUnavailable(submission)
      ? "Review unavailable"
    : submission.status === "completed" && submission.passed === true
      ? "Earlier Pass / review required"
      : submission.status === "completed"
        ? "Needs revision"
        : submission.status === "failed"
          ? "Review unavailable"
          : "Review in progress";

export function ExperiencePage({
  title,
  eyebrow,
  children,
  actions,
  active = "home",
  variant,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  active?: NavKey;
  variant?:
    | "dashboard"
    | "progress"
    | "profile"
    | "teacher"
    | "classroom"
    | "account"
    | "dossier"
    | "completion"
    | "feedback"
    | "portfolio";
}) {
  return (
    <AppShell active={active} crumbs={[{ label: title }]}>
      <main
        id="main"
        tabIndex={-1}
        className={`exp-page${variant ? ` exp-${variant}-page` : ""}`}
      >
        <header className="exp-heading">
          <div>
            {eyebrow && <span className="exp-eyebrow">{eyebrow}</span>}
            <h1>{title}</h1>
          </div>
          {actions && <div className="exp-actions">{actions}</div>}
        </header>
        {children}
      </main>
    </AppShell>
  );
}

/**
 * A verdict's badge, or a phase's where there is no one revision to show.
 *
 * On the status-only arm, `submitted` is where a verdict leaves a phase whose
 * gate it did not open (`nextPhaseStatus`, `phaseRollup`); handing a revision
 * in moves no status. So "In review" is said only when the caller knows a
 * revision is still queued or running (`reviewing`), and the phase is otherwise
 * "In progress", which is true of it whatever its revisions hold.
 */
export function StatusBadge({
  submission,
  status,
  reviewing = false,
}: {
  submission?: SubmissionView | SubmissionHistoryItem;
  status?: PhaseSummary["status"];
  reviewing?: boolean;
}) {
  const passed = submission ? isPass(submission) : status === "passed";
  const locked = status === "locked";
  const needsRevision =
    submission?.status === "completed" && submission.passed !== true && !isReviewUnavailable(submission);
  const Mark = passed
    ? Check
    : locked
      ? LockKeyhole
      : needsRevision
        ? RotateCcw
        : Clock3;
  return (
    <span
      className={`exp-status ${passed ? "is-pass" : needsRevision ? "is-revision" : locked ? "is-locked" : ""}`}
    >
      <Mark size={14} />
      {submission
        ? verdict(submission)
        : passed
          ? "Pass"
          : locked
            ? "Locked"
            : (status === "submitted" || status === "in_progress") && reviewing
              ? "In review"
              : "In progress"}
    </span>
  );
}

/**
 * The review history of the shell's project, or, for a record page reading
 * one of the learner's other projects by name, of the
 * enrolment that page hands in. Keyed by the enrolment either way, so a kept
 * project's history is never mixed with the current one's.
 *
 * `wanted` is a submission the page was sent to show (the feedback page's
 * `submission=`). While the held history does not contain it and no read has
 * completed that could bring it, `awaitingWanted` is true, so the page can
 * say it is loading instead of saying the review is not there (after Submit
 * for review the page can mount on the history from before the submit, held
 * through the project's revalidation and then a background read). A
 * history that comes back without it, from the cache or the server, is asked
 * of the server once; when that read completes (or fails) without it, the
 * wait ends and the page's own words stand.
 */
export function useReviews(record?: { enrollment: EnrollmentView | null; revalidating: boolean }, wanted?: string | null) {
  const shell = useProject();
  const enrollment = record ? record.enrollment : shell.enrollment;
  const revalidating = record ? record.revalidating : shell.revalidating;
  const owner = getToken();
  const historyKey = enrollment ? `${enrollment.id}:${enrollment.projectSlug}` : '';
  const held = historyKey ? cachedReviewHistory(historyKey) : undefined;
  const [records, setRecords] = useState<SubmissionHistoryItem[] | undefined>(held);
  const [loading, setLoading] = useState(held === undefined);
  const [loadedFor, setLoadedFor] = useState(held === undefined ? '' : historyKey);
  const [loadedOwner, setLoadedOwner] = useState(owner);
  const [failedFor, setFailedFor] = useState("");
  const [failedOwner, setFailedOwner] = useState(owner);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // The wanted submission as of now (read when a read lands), the one
  // the server has been asked for, the one a completed read has answered,
  // and the read in flight, if any (so a second one is not started beside it).
  const wantedNow = useRef(wanted);
  const askedFor = useRef<string | null | undefined>(undefined);
  const [answeredFor, setAnsweredFor] = useState<string | null | undefined>(undefined);
  const inFlight = useRef<object | null>(null);
  useEffect(() => {
    wantedNow.current = wanted;
  });
  const key =
    enrollment?.phases
      .map((phase) => `${phase.id}:${phase.attempts}:${phase.status}`)
      .join("|") ?? "";
  useEffect(() => {
    let alive = true;
    if (!enrollment) {
      setRecords(undefined);
      setLoadedFor("");
      setFailedFor("");
      setError("");
      setLoading(false);
      return;
    }
    if (revalidating) return;
    setLoading(true);
    const read = {};
    inFlight.current = read;
    const forced = revision > 0;
    void loadReviewHistory(historyKey, enrollment.projectSlug, forced, key)
      .then((next) => {
        if (!alive || !sameSession(getToken(), owner)) return;
        setRecords(next);
        setLoadedOwner(owner);
        setError("");
        setFailedFor("");
        setLoadedFor(historyKey);
        const want = wantedNow.current;
        if (want && !next.some((item) => item.id === want)) {
          // A forced read went to the server. Anything else may be the cache
          // from before the submission: ask the server, once.
          if (forced) setAnsweredFor(want);
          else if (askedFor.current !== want) {
            askedFor.current = want;
            setRevision((value) => value + 1);
          }
        }
      })
      .catch((err) => {
        if (err instanceof ReviewHistorySuperseded) return;
        if (alive && sameSession(getToken(), owner)) {
          setError(describeError(err, "Review history could not be loaded."));
          setFailedFor(historyKey);
          setFailedOwner(owner);
          setAnsweredFor(wantedNow.current);
        }
      })
      .finally(() => {
        if (inFlight.current === read) inFlight.current = null;
        if (alive && sameSession(getToken(), owner)) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Enrollment field changes are represented by key; stable pages reuse their records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, historyKey, owner, revalidating, revision]);
  const shown = owner === loadedOwner && loadedFor === historyKey ? records : held;
  const loaded = Boolean(enrollment && shown !== undefined);
  const failed = Boolean(enrollment && failedFor === historyKey && owner === failedOwner);
  const wantedMissing = Boolean(wanted && loaded && !(shown ?? []).some((item) => item.id === wanted));
  // A page whose wanted submission changes while nothing is being read asks
  // the server for it here; on mount, and after any read, the read above does.
  useEffect(() => {
    if (!wantedMissing || !wanted || revalidating || inFlight.current || askedFor.current === wanted) return;
    askedFor.current = wanted;
    setRevision((value) => value + 1);
    // Only a change of the wanted submission starts this; reads start above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  const reviews: Review[] = (shown ?? []).flatMap(submission => {
    const phase = enrollment?.phases.find(item => item.id === submission.phaseStateId);
    return phase ? [{ phase, submission }] : [];
  });
  return {
    reviews: loaded ? reviews : [],
    loading: Boolean(enrollment) && !loaded && (loading || !failed),
    refreshing: loading && loaded,
    error: failed && !loaded ? error : "",
    refreshError: failed && loaded ? error : "",
    hasLoaded: loaded,
    awaitingWanted: wantedMissing && answeredFor !== wanted,
    refresh: () => setRevision((value) => value + 1),
  };
}

export function ReviewLoadError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <section className="exp-panel">
      <p className="exp-error" role="alert">
        {message}
      </p>
      <button type="button" className="exp-button mt-4" onClick={retry}>
        <RotateCcw size={15} /> Retry reviews
      </button>
    </section>
  );
}

/**
 * What a phase tile may say about its tasks, or nothing at all.
 *
 * Two facts, and only where they are a second fact rather than the same one
 * twice. A phase with one task (every phase of an imported project, and every
 * phase of a teacher's until somebody splits one) would read "0 of 1 required
 * done" under a standing line that already says where it stands, six times
 * across one row; a locked phase has no work in it to count. Both stay silent,
 * which also keeps the tiles of a project with one task per phase free of a
 * counts line.
 *
 * `attempts` is empty until there is a count to read. The sentence is there to
 * say that the phase's submission count is a **sum** over its tasks rather than
 * a revision number for any one of them, and before the first submission there
 * is no number to take the wrong way.
 */
export function phaseTaskLines(
  phase: PhaseSummary | undefined,
  tasks?: readonly Pick<PhaseTaskView, "artefactType">[],
): { counts: string; attempts: string } | null {
  if (!phase || phase.status === "locked") return null;
  const total = phase.taskCounts?.total ?? 0;
  if (total < 2) return null;
  return {
    counts: taskCountLine(phase.taskCounts),
    attempts: phase.attempts > 0 ? phaseAttemptsLine(phase.attempts, total, tasks) : "",
  };
}

/**
 * The sum's sentence, true of a phase that holds a quiz.
 *
 * The phase's counter (`phase_states.attempts`) counts every submission except
 * a quiz's papers, so "1 submission across 2 tasks" over a story and its quiz,
 * beside "2 recorded reviews", would count the quiz in the tasks and not in the
 * submissions. Where the page holds the phase's task list and it has a quiz,
 * the sentence counts the other tasks and says the quiz is left out. Without
 * a task list, or with no quiz in it, it is `taskAttemptsLine`'s.
 */
export function phaseAttemptsLine(
  attempts: number,
  total: number,
  tasks?: readonly Pick<PhaseTaskView, "artefactType">[],
): string {
  const quizzes = tasks?.filter((task) => task.artefactType === "quiz").length ?? 0;
  if (!tasks || quizzes === 0) return taskAttemptsLine(attempts, total);
  const others = tasks.length - quizzes;
  const left = `not counting ${quizzes === 1 ? "the quiz" : "the quizzes"}`;
  return others >= 2
    ? `${taskAttemptsLine(attempts, others)}, ${left}`
    : `${attempts} ${pluralWord(attempts, "submission")}, ${left}`;
}

/**
 * The board's tiles, one per phase the project holds.
 *
 * `details` is optional and carries the phase task lists the caller already
 * holds, keyed by phase id. It exists for one reason:
 * `phaseDoorHref` sends a learner to a quiz room when the quiz is
 * the only thing a phase has left to pass, and it can only answer that from a
 * task list. A `PhaseSummary` has none, so without this the door's quiz arm is
 * unreachable from the board and a quiz is a task panel row and nothing else.
 *
 * A caller that passes no details (and a phase whose tasks hold no quiz)
 * gets the phase's ordinary href.
 */
export function PhasePath({
  phases,
  reviews = [],
  details,
}: {
  phases: PhaseSummary[];
  reviews?: Review[];
  details?: Record<string, { tasks?: readonly PhaseTaskView[] }>;
}) {
  return (
    <div className="exp-phase-path" style={{ "--phase-count": phases.length } as React.CSSProperties}>
      {/* The project's own phases, in their places: a phase it does not hold
          is not drawn, locked or otherwise. */}
      {phasesInPlace(phases).map((phase) => {
        const key = phase.key;
        const latest = reviews
          .filter((item) => item.phase.key === key)
          .at(-1)?.submission;
        const tasks = phaseTaskLines(phase, details?.[phase.id]?.tasks);
        const content = (
          <>
            <img src={phaseArt(key)} alt="" width="100" height="100" />
            <strong>{PHASE_META[key].title}</strong>
            {/* Where this phase stands, in the slot every tile uses for it.
                On a phase that is its one task the newest revision's verdict is
                that standing; on a split phase it is one task's verdict, and a
                verified pass on one required task while the others are still
                open is routine once a phase has several tasks, so the tile would
                read "Pass" beside a next phase that is still locked. There it
                says the phase is still being worked, and the counts line below
                carries how far it has got.

                Not "In review" off the phase's status. A split phase
                reads `submitted` after ANY verdict that leaves its gate shut
                (the roll-up writes it over a passed task as readily as over a
                refused one) so the word would say a revision is being marked
                when it already has been. It is said only while the newest revision the tile
                already holds is still queued or running, which is the one
                state it is true of. */}
            <span>
              {phase?.status === "passed"
                ? "Passed"
                : phase.status === "locked"
                  ? "Locked"
                  : !latest
                    ? "Ready to begin"
                    : !tasks
                      ? verdict(latest)
                      : latest.status === "queued" || latest.status === "running"
                        ? "In review"
                        : "In progress"}
            </span>
            {/* A teacher may split a written phase into several pieces of
                work. Where they have, the tile says how far the phase has got
                through them, and what the submission count beside it is
                actually a count of. */}
            {tasks && (
              <>
                <span data-testid={`phase-path-tasks-${key}`}>{tasks.counts}</span>
                {tasks.attempts && (
                  <span data-testid={`phase-path-attempts-${key}`}>{tasks.attempts}</span>
                )}
              </>
            )}
          </>
        );
        return phase.status === "locked" ? (
          <div className="exp-phase-step is-locked" key={key}>
            {content}
            <LockKeyhole size={13} />
          </div>
        ) : (
          <Link
            className="exp-phase-step"
            key={key}
            href={
              latest
                ? reviewHref(phase.id, latest.id)
                : phaseDoorHref(doorWithTasks(phase, details))
            }
          >
            {content}
            <ArrowRight size={13} />
          </Link>
        );
      })}
    </div>
  );
}

/** Each phase's short name on the profile's strip, read by key. */
const SHORT_LABELS: Record<PhaseKey, string> = {
  requirements: "Reqs",
  design: "Design",
  implementation: "Code",
  testing: "Test",
  deployment: "Deploy",
  maintenance: "Maint.",
};

export function CompactPhasePath({
  phases,
  reviews,
}: {
  phases: PhaseSummary[];
  reviews: Review[];
}) {
  return (
    <div
      className="exp-profile-phase-strip"
      aria-label="Project progress"
      style={{ "--phase-count": phases.length } as React.CSSProperties}
    >
      {/* The project's own phases, numbered by their places. */}
      {phasesInPlace(phases).map((phase, index) => {
        const key = phase.key;
        const latest = reviews
          .filter((row) => row.phase.id === phase.id)
          .at(-1);
        // A verified pass on a phase that holds one task is that phase's pass,
        // which is why the mark is read off the reviews. A teacher may split a
        // written phase, and then one task's pass is not the phase's: the
        // roll-up keeps the phase shut until every required task has one.
        // Where there is more than one task to be wrong about, the phase's own
        // standing decides the mark; a phase with one task is marked off its
        // reviews.
        const split = (phase.taskCounts?.total ?? 0) > 1;
        const passed =
          reviews.some(
            (row) => row.phase.id === phase.id && isPass(row.submission),
          ) && (!split || phase.status === "passed");
        const current = phase.status !== "locked" && phase.status !== "passed";
        return (
          <Link
            key={key}
            href={
              latest ? reviewHref(phase.id, latest.submission.id) : "/progress"
            }
            className={passed ? "is-pass" : current ? "is-current" : ""}
            aria-label={`${PHASE_META[key].title}, ${passed ? "Passed" : current ? "In progress" : "Not started"}`}
            aria-current={current ? "step" : undefined}
          >
            <span>
              {passed ? (
                <Check size={13} />
              ) : current ? (
                <Circle size={11} />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <strong>{SHORT_LABELS[key]}</strong>
          </Link>
        );
      })}
    </div>
  );
}

export function ReviewsBreakdown({
  phases,
  reviews,
}: {
  phases: PhaseSummary[];
  reviews: Review[];
}) {
  const max = Math.max(
    1,
    ...phases.map(
      (phase) =>
        reviews.filter((review) => review.phase.id === phase.id).length,
    ),
  );
  return (
    <div className="exp-breakdown">
      <div className="exp-legend">
        <span>
          <i className="is-pass" />
          Pass
        </span>
        <span>
          <i className="is-revision" />
          Needs revision
        </span>
        <span>
          <i />
          Pending / unavailable
        </span>
      </div>
      {phasesInPlace(phases).map(({ key }) => {
        const rows = reviews.filter((review) => review.phase.key === key);
        const passed = rows.filter((review) =>
          isPass(review.submission),
        ).length;
        const revised = rows.filter(
          (review) =>
            review.submission.status === "completed" &&
            review.submission.passed !== true &&
            !isReviewUnavailable(review.submission),
        ).length;
        return (
          <div className="exp-bar-row" key={key}>
            <span>{PHASE_META[key].title}</span>
            <div
              className="exp-bar"
              role="img"
              aria-label={`${PHASE_META[key].title}: ${passed} passes, ${revised} needs revision, ${rows.length - passed - revised} pending or unavailable`}
            >
              <i
                className="is-pass"
                style={{ width: `${(passed / max) * 100}%` }}
              />
              <i
                className="is-revision"
                style={{ width: `${(revised / max) * 100}%` }}
              />
              <i
                style={{
                  width: `${((rows.length - passed - revised) / max) * 100}%`,
                }}
              />
            </div>
            <strong>{rows.length}</strong>
          </div>
        );
      })}
      <p className="exp-caption">
        Counts reflect recorded submissions. Pending and unavailable reviews
        never count as a Pass.
      </p>
    </div>
  );
}

/**
 * The project the Start panel may name, or none.
 *
 * Start itself names nothing (the server starts the project it resolves for
 * this account) so this is only what the panel says. A learner's catalogue is
 * the server's own answer: the project it resolves for them, first, then
 * any other they hold, so its lead is theirs. Anybody else reads every
 * published project in content order, where the first entry is only the one
 * that sorted first, so nothing is named and the sentence stays general.
 */
function startPanelProject(
  projects: { title: string }[] | undefined,
  role: string | undefined,
): string {
  const lead = role === "LEARNER" ? projects?.[0] : undefined;
  return lead ? projectName(lead.title) : "";
}

/** A project's name without the subtitle after its dash, as the Start panel reads it. */

/**
 * The one sentence a learner is told when their class works on another
 * project, or "" when there is nothing to tell.
 *
 * When a learner's class is actively assigned another project, a platform
 * project they started on their own is set aside so that they can start the
 * class's. The
 * row is not deleted and its pin does not move. The server marks it on the
 * learner's own catalogue (`ProjectMeta.setAside`) and leads that catalogue
 * with the class's project, which is what Start begins. The sentence sits on
 * the Start card only, which is drawn only while the learner has not started,
 * so it goes away once they start. That is the "told once".
 *
 * Only a learner's catalogue is theirs. Staff read every published project,
 * and their first entry is only the one that sorted first, so they are told
 * nothing here.
 */
function setAsideNotice(
  projects: { title: string; setAside?: true }[] | undefined,
  role: string | undefined,
): string {
  if (role !== "LEARNER" || !projects?.length) return "";
  const [lead, ...rest] = projects;
  if (lead.setAside) return "";
  const kept = rest.filter((project) => project.setAside).map((project) => projectName(project.title));
  if (!kept.length) return "";
  return `Your class works on ${projectName(lead.title)}, so that is what you start here. Your work on ${andList(kept)} stays in your record.`;
}

export function EmptyProject() {
  const { projects, start, enrolling, error, reload, loading, revalidating } =
    useProject();
  const role = useRole();
  const named = startPanelProject(projects, role);
  const moved = setAsideNotice(projects, role);
  // The project's first phase, where the learner's catalogue names the
  // project Start begins: a project holds the phases its teacher chose, so
  // that is not always Requirements. Staff, and a catalogue not read yet,
  // are told Requirements, LearnSDLC's first.
  const lead = role === "LEARNER" ? projects?.[0] : undefined;
  const first = lead?.phaseTitles?.length ? phasesInPlace(lead.phaseTitles)[0] : undefined;
  const firstKey: PhaseKey = first?.key ?? "requirements";
  const firstTitle = first?.title ?? "Requirements";
  const kept = (projects ?? []).filter((project) => project.setAside);
  if (error) {
    const retrying = loading || revalidating || Boolean(enrolling);
    return (
      <section className="exp-panel" aria-busy={retrying}>
        <p role="alert" className="exp-error">{error}</p>
        <button
          type="button"
          className="exp-button mt-4"
          disabled={retrying}
          onClick={() => void reload()}
        >
          <RotateCcw size={15} />
          {retrying ? "Loading your project…" : "Retry project"}
        </button>
      </section>
    );
  }
  return (
    <section className="exp-panel exp-hero">
      <div>
        <span className="exp-eyebrow">One project. Every phase connected.</span>
        <h2>Your next chapter starts here.</h2>
        <p>
          {`Build ${named || "your project"} from the first stakeholder conversation to a maintained release. Begin with ${firstTitle} and earn each next phase through review.`}
        </p>
        {moved && (
          <p className="exp-caption" data-testid="set-aside-notice">
            {moved}
          </p>
        )}
        {/* The record the sentence promises, one step
            away: read by name and read only; Start below is unchanged. */}
        {moved && kept.length > 0 && (
          <p className="exp-caption">
            <Link
              className="exp-text-link"
              href={kept.length === 1 ? keptDossierHref(kept[0].slug) : "/dossier"}
              data-testid="set-aside-record"
            >
              {kept.length === 1 ? `See your ${projectName(kept[0].title)} record` : "See the work you kept"}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </p>
        )}
        {/* The request names no project: the server starts the one it
            resolves for this account (their class's assignment where they
            have one, and the deployment's default where they do not)
            and the tab holds its answer. */}
        <button
          className="exp-button exp-primary"
          disabled={Boolean(enrolling)}
          onClick={() => void start()}
        >
          {enrolling ? "Preparing your project…" : `Start ${firstTitle}`}
          <ArrowRight size={16} />
        </button>
      </div>
      <img
        src={phaseArt(firstKey)}
        alt={`${firstTitle} illustration`}
        width="220"
        height="220"
      />
    </section>
  );
}

/**
 * The project a learner is on, named on their dashboard.
 *
 * Naming only the phase is not enough: with teachers' projects a learner in a
 * class may be on one that is not the default, so
 * the page says which, from the enrolment the server resolved.
 */
export function ProjectNameLine({ title }: { title: string | null | undefined }) {
  const name = projectName(title);
  if (!name) return null;
  return (
    <p className="exp-caption" data-testid="dashboard-project">
      Your project: <strong>{name}</strong>
    </p>
  );
}

export function LoadingState() {
  return (
    <div className="exp-panel exp-loading" role="status">
      <Circle size={20} />
      Loading your learning record…
    </div>
  );
}
