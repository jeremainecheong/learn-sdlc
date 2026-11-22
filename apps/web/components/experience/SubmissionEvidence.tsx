"use client";
import { sessionKey } from '@/lib/session-token';
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CheckCircle2, AlertCircle, CircleMinus, Send } from "lucide-react";
import type { SubmissionView } from "@learnsdlc/shared";
import { TEACHER_FEEDBACK_MAX, TEACHER_FEEDBACK_MIN } from "@learnsdlc/shared";
import { api, describeError } from "@/lib/api";
import { experienceApi, type SubmissionSignOff, type TeacherFeedback } from "@/lib/api-experience";
import { getToken, onSessionEnd } from "@/lib/session";
import { createTeacherDraftStore, EMPTY_TEACHER_DRAFT, teacherDraftKey, type TeacherDraftScope, type TeacherDraftStore } from "@/components/staff/console/teacher-feedback-drafts";
import { formatDate, isReviewUnavailable, LoadingState, StatusBadge } from "./shared";
import { reviewSummary } from "./review-summary";
import { citeChecks } from "@/components/pr/checkCitations";
import { CODE_QUALITY_KEY, MET_BY_REVIEWER_NOTE, NOT_MEASURED_CRITERION_NOTE, NOT_MEASURED_REASON, NOT_MEASURED_WORD, analysisNotMeasured } from "@/components/pr/analysisReach";
import { feedbackFileReferences, feedbackRevisionHref, submittedFileAnchor, type FeedbackPhase } from "./feedback-targets";
import { ReviewSteps } from "@/components/workspace/ReviewSteps";
import { withInlineCode } from "@/components/pr/inlineCode";
import { NOT_REQUIRED_WORD, withoutZeroFloor, zeroFloorChecks, type FloorSource } from "@/components/pr/floorZero";
import { SHARED_EVIDENCE_LEAD, sharedEvidence } from "@/components/pr/criteriaEvidence";

/** How often a queued or running submission is read again, and how many times: about two minutes in all. */
const EVIDENCE_POLL_MS = 4_000;
const EVIDENCE_POLL_LIMIT = 30;

export function SubmissionEvidence({
  submissionId,
  teacher = false,
  onFeedback,
  drafts,
  draftScope,
  phase,
  onReviewLoaded,
  floors,
}: {
  submissionId: string;
  teacher?: boolean;
  onFeedback?: (feedback: TeacherFeedback) => void;
  drafts?: TeacherDraftStore;
  draftScope?: TeacherDraftScope;
  phase?: FeedbackPhase;
  onReviewLoaded?: (submission: SubmissionView) => void;
  /** The phase's floors, so a rule the teacher set to 0 reads as not required (`zeroFloorChecks`). Left out, as recorded. */
  floors?: FloorSource;
}) {
  const [submission, setSubmission] = useState<SubmissionView | null>(null);
  const [notes, setNotes] = useState<TeacherFeedback[]>([]);
  const [error, setError] = useState("");
  const [notesError, setNotesError] = useState("");
  const [notesLoading, setNotesLoading] = useState(true);
  // The learner's view of a sign-off, which is not a note.
  const [signOff, setSignOff] = useState<SubmissionSignOff | null>(null);
  const [revision, setRevision] = useState(0);
  const handledFragment = useRef("");
  const onReviewLoadedRef = useRef(onReviewLoaded);
  onReviewLoadedRef.current = onReviewLoaded;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    handledFragment.current = "";
    setSubmission(null);
    setNotes([]);
    setError("");
    setNotesError("");
    setNotesLoading(true);
    setSignOff(null);
    async function load() {
      try {
        const result = teacher
          ? await experienceApi.teacherEvidence(submissionId)
          : await api.getSubmissionWithFiles(submissionId);
        if (!alive) return;
        if (result.id !== submissionId) throw new Error('The returned evidence belongs to a different submission.');
        setSubmission(result);
        onReviewLoadedRef.current?.(result);
        if (["queued", "running"].includes(result.status) && polls++ < EVIDENCE_POLL_LIMIT)
          timer = setTimeout(() => void load(), EVIDENCE_POLL_MS);
      } catch (err) {
        if (alive)
          setError(describeError(err, "This submission could not be loaded."));
      }
    }
    void load();
    void experienceApi
      .teacherFeedback(submissionId)
      .then((value) => {
        if (alive) setNotes(current => [
          ...value,
          ...current.filter(note => !value.some(saved => saved.id === note.id)),
        ]);
      })
      .catch((err) => {
        if (alive)
          setNotesError(
            describeError(err, "Teacher feedback could not be loaded."),
          );
      })
      .finally(() => {
        if (alive) setNotesLoading(false);
      });
    // Learner view only; the staff view is unchanged. A sign-off that cannot
    // be read is shown as none, never as an error: it adds to the page.
    if (!teacher)
      void Promise.resolve()
        .then(() => experienceApi.submissionSignOff(submissionId))
        .then((value) => {
          if (alive && value?.signedOff) setSignOff(value);
        })
        .catch(() => {});
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [submissionId, teacher, revision]);
  useEffect(() => {
    if (!submission || error) return;
    const anchors = new Set(Object.keys(submission.workspaceSnapshot ?? {}).map(path => submittedFileAnchor(submission.id, path)));
    const revealFragment = () => {
      let anchor: string;
      try { anchor = decodeURIComponent(window.location.hash.slice(1)); }
      catch { return; }
      const scope = `${submission.id}:${anchor}`;
      if (handledFragment.current === scope) return;
      if (!anchors.has(anchor)) { handledFragment.current = ""; return; }
      const details = document.getElementById(anchor);
      if (!(details instanceof HTMLDetailsElement)) return;
      handledFragment.current = scope;
      details.open = true;
      details.scrollIntoView?.({ block: 'start' });
      details.querySelector('summary')?.focus({ preventScroll: true });
    };
    // A copied link or new tab arrives before its asynchronous snapshot. Reveal
    // only a file from this exact submission once the saved evidence is present.
    revealFragment();
    window.addEventListener('hashchange', revealFragment);
    window.addEventListener('popstate', revealFragment);
    return () => {
      window.removeEventListener('hashchange', revealFragment);
      window.removeEventListener('popstate', revealFragment);
    };
  }, [submission, error]);
  if (error)
    return (
      <section className="exp-panel">
        <p className="exp-error" role="alert">
          {error}
        </p>
        <button
          className="exp-button"
          onClick={() => setRevision((value) => value + 1)}
        >
          Retry submission
        </button>
      </section>
    );
  if (!submission) return <LoadingState />;
  const report = submission.report;
  // A rule the teacher set to 0 is not listed as met; checks every criterion shares are listed once.
  const zero = zeroFloorChecks(floors);
  const lists = report ? report.criteria.map((criterion) => withoutZeroFloor(criterion.evidence, report.checks, zero)) : [];
  const shared = sharedEvidence(lists);
  const snapshotPaths = Object.keys(submission.workspaceSnapshot ?? {});
  function evidenceLinks(text: string) {
    const paths = feedbackFileReferences(text, snapshotPaths);
    if (!paths.length) return null;
    return <div className="mt-3 flex flex-wrap gap-3">
      {paths.map(path => {
        const anchor = submittedFileAnchor(submissionId, path);
        return <span key={path} className="flex min-w-0 flex-wrap gap-3">
          <a className="exp-text-link min-h-11 items-center break-all" href={`#${encodeURIComponent(anchor)}`} onClick={event => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const details = document.getElementById(anchor);
            if (details instanceof HTMLDetailsElement) {
              // Native fragment navigation focuses the details element after this
              // handler. Own this navigation so the usable disclosure keeps focus.
              event.preventDefault();
              details.open = true;
              handledFragment.current = `${submissionId}:${anchor}`;
              const hash = `#${encodeURIComponent(anchor)}`;
              if (window.location.hash !== hash) window.history.pushState(window.history.state, '', hash);
              details.scrollIntoView({ block: 'start' });
              details.querySelector('summary')?.focus({ preventScroll: true });
            }
          }}>Inspect submitted {path}</a>
          {!teacher && phase && phase.status !== 'locked' && <Link className="exp-text-link min-h-11 items-center break-all" href={feedbackRevisionHref(phase, path)}>Open current {path}</Link>}
        </span>;
      })}
    </div>;
  }
  return (
    <div className="exp-stack">
      <section className="exp-panel">
        <header className="exp-section-heading">
          <div>
            <span className="exp-eyebrow">
              Submitted {formatDate(submission.createdAt)}
            </span>
            <h2>Review evidence</h2>
          </div>
          <StatusBadge submission={submission} />
        </header>
        {submission.commitMessage && (
          <blockquote className="exp-quote">
            {submission.commitMessage}
          </blockquote>
        )}
        {submission.status === "failed" ? (
          <p role="alert" className="exp-error">
            {submission.error ||
              "The review could not be completed. No Pass was recorded. Return to your project to retry."}
          </p>
        ) : submission.status !== "completed" ? (
          <>
            <p role="status">
              Your submission is being reviewed. The result is recorded only
              when the review finishes.
            </p>
            <ReviewSteps kind={phase?.artifactKind} status={submission.status} since={submission.createdAt} />
            <button
              className="exp-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh review
            </button>
          </>
        ) : !report ? (
          <p className="exp-error" role="alert">
            The evidence report is missing. This result cannot be verified.
          </p>
        ) : (
          <>
            {isReviewUnavailable(submission) && (
              <section className="exp-inline-note" aria-label="Unavailable assessment">
                <h3>The assessment could not be completed.</h3>
                <p>No Pass was established by this review. The saved report and checks below are preserved as recorded; an unavailable AI assessment does not identify which parts of your work need revision.</p>
              </section>
            )}
            {report.assessmentMode !== "strict_binary" && (
              <p className="exp-inline-note">
                This earlier assessment is preserved in your history. Submit
                this phase again for a strict evidence review before advancing.
              </p>
            )}
            <p>{reviewSummary(report, teacher, submission.passed)}</p>
            {report.checks.map((check) => {
              // An analysis that read no file found nothing because it looked at nothing: the row
              // says "Not measured" as the IDE and the pull request page do. Its status is the API's.
              const notMeasured = check.id === "static-analysis" && analysisNotMeasured(report.staticAnalysis);
              // A rule whose floor is 0 passes whatever the record holds; it is not drawn as met.
              const notRequired = zero.has(check.id) && check.status === "passed";
              return (
              <article
                key={check.id}
                className={`exp-evidence-row ${check.status === "failed" ? "is-failed" : ""}`}
              >
                <header>
                  {notMeasured || notRequired ? (
                    <CircleMinus size={19} data-testid={notMeasured ? "evidence-not-measured-icon" : "evidence-not-required-icon"} />
                  ) : check.status === "failed" ? (
                    <AlertCircle size={19} />
                  ) : (
                    <CheckCircle2 size={19} />
                  )}
                  <div>
                    <strong>{check.label}</strong>
                    <p>{notMeasured ? NOT_MEASURED_REASON : withInlineCode(check.detail)}</p>
                    <span className="exp-caption">
                      {notMeasured
                        ? NOT_MEASURED_WORD
                        : notRequired
                        ? NOT_REQUIRED_WORD
                        : check.status === "passed"
                        ? "Criterion met"
                        : check.status === "failed"
                          ? "Needs attention"
                          : check.status}
                    </span>
                    {evidenceLinks(`${check.label}\n${check.detail}`)}
                  </div>
                </header>
              </article>
              );
            })}
            {report.criteria.map((criterion, index) => {
              // The checks every criterion shares are listed once, after the criteria.
              const lines = shared ? [] : lists[index];
              const finding = report.aiReview?.criteriaEvidence?.find(item => item.key === criterion.key);
              const unavailable = isReviewUnavailable(submission);
              // A criterion the reviewer left unmet on a report the gate passed
              // at a rule-based 100 is the reviewer's advice, not revision work.
              const advice = !unavailable && finding?.met === false && report.passed === true;
              const needsRevision = !unavailable && finding?.met === false && !advice;
              return (
                <article className={`exp-evidence-row ${needsRevision ? 'is-failed' : ''}`} key={criterion.key}>
                  <strong>{criterion.title}</strong>
                  <p className="exp-caption">{unavailable || !finding ? 'Recorded evidence' : finding.met ? 'Criterion met' : advice ? 'Reviewer advice' : 'Needs attention'}</p>
                  {lines.map((evidence, at) => (
                    <p key={at}>{withInlineCode(evidence)}</p>
                  ))}
                  {finding?.evidence && !criterion.evidence.includes(finding.evidence) && <p>{citeChecks(finding.evidence, report.checks)}</p>}
                  {finding?.issue && <p><strong>{unavailable ? 'Recorded issue' : advice ? 'Advice' : 'Evidence gap'}:</strong> {citeChecks(finding.issue, report.checks)}</p>}
                  {finding?.nextStep && <p><strong>{unavailable ? 'Recorded next step' : 'Next step'}:</strong> {citeChecks(finding.nextStep, report.checks)}</p>}
                  {criterion.key === CODE_QUALITY_KEY && analysisNotMeasured(report.staticAnalysis) && <p className="exp-caption" data-testid="criterion-not-measured">{NOT_MEASURED_CRITERION_NOTE}</p>}
                  {/* What a Met rests on beside "Not measured"; the reviewer's evidence for it is drawn above. */}
                  {criterion.key === CODE_QUALITY_KEY && analysisNotMeasured(report.staticAnalysis) && !unavailable && finding?.met === true && <p className="exp-caption" data-testid="criterion-met-by-reviewer">{MET_BY_REVIEWER_NOTE}</p>}
                  {evidenceLinks([...lines, finding?.evidence, finding?.issue, finding?.nextStep].filter(Boolean).join('\n'))}
                  {needsRevision && !teacher && phase && phase.status !== 'locked' && <Link className="exp-text-link mt-3 min-h-11 items-center" href={feedbackRevisionHref(phase)}>Revise this criterion in your project</Link>}
                </article>
              );
            })}
            {shared && (
              <article className="exp-evidence-row" data-testid="criteria-shared-evidence">
                <strong>{SHARED_EVIDENCE_LEAD}</strong>
                {shared.map((evidence, at) => (
                  <p key={at}>{withInlineCode(evidence)}</p>
                ))}
                {evidenceLinks(shared.join('\n'))}
              </article>
            )}
            {report.aiReview?.improvements.length > 0 && (
              <section className="mt-6">
                <h3>Your next steps</h3>
                <ol className="ml-5 mt-3 space-y-3 text-[13px]">
                  {report.aiReview.improvements.map((step, index) => (
                    <li key={index}>{citeChecks(step, report.checks)}{evidenceLinks(step)}</li>
                  ))}
                </ol>
              </section>
            )}
            <p className="exp-caption">
              Teacher comments are separate from this verdict.
            </p>
          </>
        )}
      </section>
      <section className="exp-panel exp-files">
        <header className="exp-section-heading">
          <div>
            <h2>Submitted files</h2>
            <p>The saved snapshot for this exact revision.</p>
          </div>
        </header>
        {submission.workspaceSnapshot &&
        Object.keys(submission.workspaceSnapshot).length ? (
          Object.entries(submission.workspaceSnapshot).map(
            ([path, content]) => (
              <details key={path} id={submittedFileAnchor(submissionId, path)}>
                <summary>{path}</summary>
                <pre>
                  <code>{content}</code>
                </pre>
              </details>
            ),
          )
        ) : (
          <p>
            The source snapshot is unavailable for this revision. Review
            evidence above is the retained record.
          </p>
        )}
      </section>
      <section className="exp-panel">
        <header className="exp-section-heading">
          <div>
            <h2>Teacher feedback</h2>
            <p>
              Follow-up on this submission. The AI verdict remains unchanged.
            </p>
          </div>
        </header>
        {notesError && (
          <p role="alert" className="exp-error">
            {notesError}
          </p>
        )}
        <div className="exp-note-list">
          {!teacher && signOff?.signedOff && (
            <div className="exp-signoff">
              <p>
                <CheckCircle2 aria-hidden="true" size={16} className="inline-block align-[-3px]" />{" "}
                Signed off by your teacher.
              </p>
              {signOff.reason && <blockquote>{signOff.reason}</blockquote>}
            </div>
          )}
          {notesLoading ? (
            <p role="status">Loading teacher feedback…</p>
          ) : notes.length ? (
            notes.map((note) => (
              <blockquote key={note.id}>
                <small>
                  {note.authorName},{" "}
                  {note.action === "acknowledge"
                    ? "Acknowledged"
                    : note.action === "request_revision"
                      ? "Revision requested"
                      : "Comment"}{" "}
                  / {formatDate(note.createdAt)}
                </small>
                {note.text}
              </blockquote>
            ))
          ) : notesError ? (
            <button
              type="button"
              className="exp-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry teacher feedback
            </button>
          ) : !teacher && signOff?.signedOff ? null : (
            <p>No teacher feedback on this submission yet.</p>
          )}
        </div>
        {teacher && (
          <TeacherFeedbackForm
            key={submissionId}
            submissionId={submissionId}
            drafts={drafts}
            draftScope={draftScope}
            onSaved={(note) => {
              setNotes((rows) =>
                rows.some((row) => row.id === note.id) ? rows : [...rows, note],
              );
              onFeedback?.(note);
            }}
          />
        )}
      </section>
    </div>
  );
}

function TeacherFeedbackForm({
  submissionId,
  onSaved,
  drafts,
  draftScope,
}: {
  submissionId: string;
  onSaved: (note: TeacherFeedback) => void;
  drafts?: TeacherDraftStore;
  draftScope?: TeacherDraftScope;
}) {
  const [localDrafts] = useState(() => createTeacherDraftStore(() => sessionKey(getToken())));
  const store = drafts ?? localDrafts;
  const key = teacherDraftKey(draftScope ?? { learnerId: "", phaseId: "", submissionId });
  useEffect(() => onSessionEnd(() => store.clear()), [store]);
  const current = useSyncExternalStore(store.subscribe, () => store.get(key), () => EMPTY_TEACHER_DRAFT);
  const { text, action, busy, error, saved } = current;
  const announcedNote = useRef("");
  useEffect(() => {
    const note = current.savedNote;
    if (note && note.id !== announcedNote.current && store.get(key).savedNote?.id === note.id) {
      announcedNote.current = note.id;
      onSaved(note);
    }
  }, [current.savedNote, key, onSaved, store]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = store.get(key);
    if (draft.busy || draft.text.trim().length < 2) return;
    const epoch = store.epoch();
    const content = `${draft.action}|${draft.text.trim()}`;
    const requestId = draft.requestContent === content && draft.requestId ? draft.requestId : crypto.randomUUID();
    store.update(key, value => ({ ...value, busy: true, error: "", saved: false, requestId, requestContent: content }), epoch);
    try {
      const note = await experienceApi.writeFeedback(submissionId, {
        text: draft.text.trim(), action: draft.action, requestId,
      });
      // A completion from another login must never publish into the current account.
      store.update(key, () => ({ ...EMPTY_TEACHER_DRAFT, saved: true, savedNote: note }), epoch);
    } catch (err) {
      store.update(key, value => ({ ...value, busy: false, error: describeError(err, "Your feedback could not be saved.") }), epoch);
    }
  }
  return (
    <form className="exp-form mt-5" onSubmit={submit} aria-busy={busy}>
      <label className="exp-field">
        Follow-up action
        <select
          disabled={busy}
          value={action}
          onChange={(event) => {
            const action = event.target.value as TeacherFeedback["action"];
            store.update(key, value => value.busy ? value : { ...value, action, saved: false, error: "" });
          }}
        >
          <option value="comment">Comment</option>
          <option value="acknowledge">Acknowledge this submission</option>
          <option value="request_revision">Request a revision</option>
        </select>
      </label>
      <label className="exp-field">
        Your feedback
        <textarea
          disabled={busy}
          required
          minLength={TEACHER_FEEDBACK_MIN}
          maxLength={TEACHER_FEEDBACK_MAX}
          value={text}
          onChange={(event) => {
            const text = event.target.value;
            store.update(key, value => value.busy ? value : { ...value, text, saved: false, error: "" });
          }}
          placeholder="Point to the evidence and give the learner a useful next step."
        />
      </label>
      {drafts && text && <p className="exp-muted">Your unsent note stays with this submission while you inspect other records on this page.</p>}
      {error && (
        <p role="alert" className="exp-error">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="exp-success">
          Feedback saved on this submission. The AI verdict is unchanged.
        </p>
      )}
      <button
        className="exp-button exp-primary"
        disabled={busy || text.trim().length < 2}
      >
        <Send size={15} />
        {busy ? "Saving…" : "Save feedback"}
      </button>
    </form>
  );
}
