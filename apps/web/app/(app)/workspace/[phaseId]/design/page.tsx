'use client';
import { sameSession } from '@/lib/session-token';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { useWorkspaceViewScroll } from '@/components/workspace/WorkspaceViews';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';

/**
 * Phase 2, the design.
 *
 * The IDE is where code is written; this is where the design is. The parts of
 * it stand down the left, the model, the contracts and the decisions are the
 * page itself, and the architect reads over your shoulder on the right. Every
 * part is a form over the design record and the contracts the teacher switched
 * on, saved the way the code pane saves: on a debounce, with the state of the
 * save always on screen. The learner never sees a file.
 */
import { useAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { DESIGN_JSON, DESIGN_OLDER_FORMAT_ROOM, SCREEN_CONTRACT_JSON, holdsPhase, isLastPhase, placeLabel, type EnrollmentView, type PhaseSummary, type SubmissionView } from '@learnsdlc/shared';
import { api, ApiError, describeError, getToken } from '@/lib/api';
import { getSession, useSession } from '@/lib/session';
import { clearCommitDraft, commitDraft } from '@/lib/commit';
import { refreshPhaseRecords } from '@/lib/records';
import { reviewHref } from '@/components/experience/shared';
import type { WorkspacePhaseDetail } from '@/lib/api-workspace';
import { useVersionedWorkspaceSave } from '@/components/workspace/useVersionedWorkspaceSave';
import { VersionedWorkspaceConflict } from '@/components/workspace/VersionedWorkspaceConflict';
import { setActiveProject } from '@/lib/project';
import { fullDetail, invalidateProject, useProject } from '@/lib/useProject';
import { useRecoverWhenBack } from '@/lib/poll';
import { Button, Notice } from '@/components/ui';
import {
  WorkPage,
  briefHref,
  usePersona,
  type ShellNav,
} from '@/components/shell';
import {
  Contradictions,
  DesignParts,
  DesignUnavailable,
  DrawnSection,
} from '@/components/workspace/panels/design/DesignBoard';
import { useDesign } from '@/components/workspace/panels/design/useDesign';
import { designTabs, type DesignTab } from '@/components/workspace/panels/design/model';
import { useOwnStoryRecord } from '@/components/workspace/panels/design/useStories';
import { clearDesignTouched } from '@/components/workspace/panels/requirements/touched';
import { ApiWorkbench } from '@/components/workspace/panels/design/ApiWorkbench';
import { DiagramStudio } from '@/components/workspace/panels/design/DiagramStudio';
import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { MissionDetails } from '@/components/phases/Brief';
import { PlainText } from '@/components/PlainText';
import { PhaseGateBanner } from '@/components/workspace/PhaseGateBanner';
// The band's own rule for a phase the learner has left, read for the footer's quiet buttons.
import { movedOnFrom } from '@/components/workspace/PhaseGateBanner';
import { PhaseHeader } from '@/components/workspace/PhaseHeader';
import { learnerState, phasePlace } from '@/components/workspace/gate-state';
import { phaseHasPr, phaseSubmitLabel, submitLeads } from '@/components/workspace/HeaderSubmit';
import { useClaimedQuickCheck } from '@/components/workspace/QuickCheck';
import { lessonsOfferedOn } from '@/lib/scenario';
import { UmlDiagram } from '@/components/workspace/panels/design/UmlDiagram';
import { EntitiesCard, NotesCard, RelationsCard } from '@/components/workspace/panels/design/BoardCards';
import { OperationsCard } from '@/components/workspace/panels/design/OperationsCard';
import { DecisionsCard } from '@/components/workspace/panels/design/DecisionsCard';
import { ScreensForm } from '@/components/workspace/panels/design/ScreensForm';
import { ChecksPanel } from '@/components/workspace/panels/design/ChecksPanel';
import { MentorSession } from '@/components/shell/PersonaPanel';
import { RoomFallback } from '@/components/workspace/panels/RoomFallback';
import { TaskPanel, submitArgs, taskForPath, taskKeyToSend } from '@/components/workspace/TaskPanel';
import { SIGN_OFF_SUBMIT_REASON, awaitingSignOff, inFlightAgesOutIn, pendingRevision } from '@/components/workspace/signoff-status';
import { TaskResetControl } from '@/components/workspace/TaskResetControl';
import { useWorkspacePanels, WorkspacePanelControls, WorkspaceMentorBoundary } from '@/components/workspace/WorkspacePanels';
import { scrollFocusRef } from '@/lib/scroll-focus';
import { revealInScroller } from '@/lib/reveal-in-view';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { latestSubmission, reviewPending, useRequirementsReview } from '@/components/workspace/requirements/useRequirementsReview';
import '@/components/workspace/requirements/requirements-workspace.css';
import '@/components/workspace/panels/design/design-frame.css';
import { projectName } from '@/lib/project-name';

/** Why Submit is off on a design whose record cannot be opened: nothing in the room could show its review. */
const DESIGN_BROKEN_SUBMIT_REASON = 'A design that cannot be opened cannot be submitted.';
/** A field a person types in: the check's shortcut pressed from one of these in the middle column scrolls nothing. */
const TYPING_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export default function DesignPage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  const session = useSession();
  return <DesignWorkspace key={`${session?.id ?? 'signed-out'}:${phaseId}`} phaseId={phaseId} />;
}

function DesignWorkspace({ phaseId }: { phaseId: string }) {
  const panels = useWorkspacePanels();
  const { view: chosenTab, select: setDesignTab, contentRef } = useWorkspaceViewScroll<DesignTab>('model');

  // The shell has already loaded the project, its analytics and every open
  // phase; this page reads them rather than asking again, and opens on the
  // copy it is given instead of on a blank board.
  const { details, enrollment: projectEnrollment, analytics } = useProject();
  const seed = fullDetail(details, phaseId);
  const [fetched, setFetched] = useState<WorkspacePhaseDetail | null>(null);
  usePhaseTutorialReady(fetched);
  const detail = fetched ?? seed ?? null;
  const [fetchedEnrollment, setFetchedEnrollment] = useState<EnrollmentView | null>(null);
  const enrollment =
    projectEnrollment && (!detail || projectEnrollment.projectSlug === detail.projectSlug)
      ? projectEnrollment
      : fetchedEnrollment;
  const saved = useVersionedWorkspaceSave(phaseId, detail);
  const { files, saveError, conflict } = saved;
  // An edit a form holds that the saved files do not (an unfinished API
  // field, a screen without a route) holds Check, Submit and an Agentic Apply,
  // which all save through `flushSave` first.
  const pendingApiDraft = useRef(false);
  const notePendingApiDraft = useCallback((pending: boolean) => { pendingApiDraft.current = pending; }, []);
  const pendingScreen = useRef(false);
  const notePendingScreen = useCallback((pending: boolean) => { pendingScreen.current = pending; }, []);
  const flushSave = useCallback(() => {
    // refusals shaped as the API's own (a 4xx speaks for itself), so Check, Submit, Apply and chat each say this sentence, never a generic one
    if (pendingApiDraft.current) return Promise.reject(new ApiError(400, 'Finish or repair the API contract fields before continuing. Your unfinished draft is kept in the workbench.'));
    if (pendingScreen.current) return Promise.reject(new ApiError(400, 'Give each screen a route before continuing. Your unfinished screen is kept in the form.'));
    return saved.flushSave();
  }, [saved.flushSave]);
  // Set when the band's Continue is pressed in this room, as Requirements does. The advance's
  // answer reaches the shell's enrolment a moment before the router leaves, and the footer must not turn quiet in that
  // moment: the room that pressed Continue keeps its footer until the next one replaces it. Let go if it did not go ahead.
  const [continuing, setContinuing] = useState(false);
  const bandContinue = useCallback(async () => {
    setContinuing(true);
    await flushSave();
  }, [flushSave]);
  const bandContinueFailed = useCallback(() => setContinuing(false), []);
  const [showConflict, setShowConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionUncertain, setSubmissionUncertain] = useState(false);
  const [receiptChecked, setReceiptChecked] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  // The review this room started or opened, held here so its verdict is read
  // in the room: the Review tab shows it, as Requirements' Review
  // view does, and the band brings the way on once the phase is read again.
  const [held, setHeld] = useState<SubmissionView | null>(null);

  const alive = useRef(true);
  const submitLock = useRef<symbol | null>(null);
  const openedReview = useRef<string | null>(null);
  const pendingReceipt = useRef<{ ids: Set<string>; message: string } | null>(null);
  const currentPhase = useRef(phaseId);
  currentPhase.current = phaseId;

  useEffect(() => {
    alive.current = true;
    submitLock.current = null;
    openedReview.current = null;
    pendingReceipt.current = null;
    setHeld(null);
    setSubmitting(false);
    setSubmissionUncertain(false);
    setReceiptChecked(false);
    return () => {
      alive.current = false;
    };
  }, [phaseId]);

  /* ------------------------------- the load ------------------------------- */

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // While the room is showing a failure it picks the connection back up on
  // its own, so a learner who reconnects does not have to think about it.
  useRecoverWhenBack(Boolean(error) && !detail, retry);

  useEffect(() => {
    let stale = false;
    const owner = getSession()?.id;
    const token = getToken();
    const mine = () => !stale && alive.current && getSession()?.id === owner && sameSession(getToken(), token);
    setError('');
    (async () => {
      try {
        // The phase says which project it belongs to; a bookmarked URL is not
        // necessarily the project this browser last remembered.
        const d = await api.phase(phaseId);
        if (!mine()) return;
        setActiveProject(d.projectSlug);
        setFetched(d);
        // The shell's enrolment is this project's every time the learner walked
        // here; only a design opened outside it costs a request.
        if (!projectEnrollment || projectEnrollment.projectSlug !== d.projectSlug) {
          // An enrolment that will not load is read as none: the phase itself has loaded.
          const e = await api.myEnrollment(d.projectSlug).catch(() => null);
          if (!mine()) return;
          setFetchedEnrollment(e && (e as EnrollmentView).id ? (e as EnrollmentView) : null);
        }
      } catch (err) {
        if (mine()) {
          setError(describeError(err, 'This phase could not be loaded. Try again.'));
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [phaseId, attempt]);

  const setFile = useCallback((path: string, content: string) => {
    openedReview.current = null;
    saved.setFile(path, content);
  }, [saved.setFile]);
  const refreshApplied = useCallback(async () => {
    const owner = getSession()?.id;
    const token = getToken();
    const fresh = await api.phase(phaseId);
    if (!alive.current || currentPhase.current !== phaseId || fresh.id !== phaseId || getSession()?.id !== owner || !sameSession(getToken(), token)) return;
    setFetched(fresh);
    // The saved design is not the one the held review read: the next Submit
    // asks the API again rather than showing that review.
    openedReview.current = null;
    setNotice('The reviewed proposal is saved in this workspace.');
  }, [phaseId]);
  const agentBusy = useAgentWorkspace(phaseId, flushSave, refreshApplied);
  // After a verdict: the phase read again (its status, its band), the notice
  // left as it was. A failed read is said as Requirements says it.
  const refreshAfterReview = useCallback(async () => {
    const owner = getSession()?.id;
    const token = getToken();
    try {
      const fresh = await api.phase(phaseId);
      if (!alive.current || currentPhase.current !== phaseId || fresh.id !== phaseId || getSession()?.id !== owner || !sameSession(getToken(), token)) return;
      setFetched(fresh);
    } catch (err) {
      if (alive.current && currentPhase.current === phaseId) setError(describeError(err, 'The review finished, but the phase could not refresh. Try again.'));
    }
  }, [phaseId]);

  /* ------------------------------ the record ------------------------------ */

  // The contradictions read the stories this phase lists and, beside them,
  // the learner's own story record from the Requirements phase, fetched once.
  const ownRecord = useOwnStoryRecord(enrollment);

  const design = useDesign({
    serverFiles: detail?.files ?? [],
    files,
    setFile,
    spec: detail?.design,
    flushSave,
    setNotice: (m) => {
      setError('');
      setNotice(m);
    },
    setError: (m) => {
      setNotice('');
      setError(m);
    },
    busy: checking,
    phaseId,
  });
  // The tabs the teacher's switches leave on; a tab a switch hides falls back to the model.
  const tabs = designTabs({ contracts: design.contracts, sequence: design.sequence });
  const designTab: DesignTab = tabs.some((t) => t.key === chosenTab) ? chosenTab : 'model';

  // The check's answer ("Design checked: 8 of 8 checks pass.", or why it could not save) is drawn at the top of
  // this column, and Check is often pressed with the column scrolled down to Operations, where an answer about
  // 600 px above the view would make the press look dead. Once the check answers, its notice is
  // brought into view in this column, instantly and only when it is out of view; the keyboard focus stays where it is.
  // With a field of this column holding the focus when the check answers, the notice is brought in
  // only when that keeps the field in view: the person typing there keeps their line.
  // Pressed by its shortcut while the person was typing in a field of this column, the column does not move at
  // all: the person stays where they were typing, and the notice is drawn in its place at the top. Whether they
  // were typing is read when the shortcut's key arrives, before anything moves the focus: a browser may take the
  // focus off the field by the time the check answers, so a read then would see no field and scroll it away.
  const noticesRef = useRef<HTMLDivElement | null>(null);
  const [checkAnswered, setCheckAnswered] = useState(0);
  // Set by the shortcut just before it starts the check, and taken over by the check at once (a press never sets it).
  const shortcutFromField = useRef(false);
  // The check that answered last was started by the shortcut from a field of this column.
  const answeredFromField = useRef(false);
  useEffect(() => {
    if (checkAnswered === 0 || !noticesRef.current || answeredFromField.current) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && active.matches(TYPING_FIELD) ? active : null;
    revealInScroller(noticesRef.current, undefined, typing);
  }, [checkAnswered]);
  const check = useCallback(async () => {
    const fromField = shortcutFromField.current;
    shortcutFromField.current = false;
    // The older format has no floor: the button is disabled, and the shortcut is refused here too.
    if (submitLock.current || design.olderFormat) return;
    setChecking(true);
    try {
      await design.check();
      if (alive.current) setShowChecks(true);
    } finally {
      if (alive.current) {
        setChecking(false);
        answeredFromField.current = fromField;
        setCheckAnswered((n) => n + 1);
      }
    }
  }, [design]);

  const designTask = taskForPath(detail?.tasks, DESIGN_JSON) ?? null;
  const savedVerdict = detail?.lastSubmission && (!detail.lastSubmission.taskKey || !designTask || detail.lastSubmission.taskKey === designTask.key)
    ? detail.lastSubmission : null;
  // The newer of the phase's last review of this board and the one this room holds.
  const designVerdict = latestSubmission(savedVerdict, held);
  // Whether that review is still queued or running, by the code rooms' rule
  // (`revisionInFlight`): one past the API's age-out window is not, so the
  // next Submit is what writes it off. While it is, Submit reads "In review"
  // and shows it; once it has settled, Submit starts a new review.
  const heldReview = pendingRevision(designVerdict, designTask?.key, savedVerdict);
  const reviewInFlight = heldReview !== null;
  // The room draws again the moment the held review leaves the window, so
  // Submit comes back on its own, as Requirements' does.
  const heldId = heldReview?.id;
  const heldSince = heldReview?.createdAt;
  const [, setAgedOut] = useState(0);
  useEffect(() => {
    if (!heldId || !heldSince) return;
    const timer = setTimeout(() => setAgedOut((n) => n + 1), inFlightAgesOutIn({ createdAt: heldSince }));
    return () => clearTimeout(timer);
  }, [heldId, heldSince]);
  // Followed to its verdict as Requirements follows its own, and only while it
  // holds Submit: a review past the age-out window is not polled for ever; the
  // next Submit writes it off and the new one is followed. Once it lands the
  // phase is read again, so the header's chip and the band say where it stands.
  const reviewConnectionError = useRequirementsReview(reviewInFlight ? designVerdict : null, (result) => setHeld((previous) => latestSubmission(previous, result)), () => {
    void refreshAfterReview();
    invalidateProject();
    refreshPhaseRecords(phaseId);
  });

  // Open the Review tab and bring the review into view with focus on it, once
  // the tab is drawn and the editor is no longer inert (a submit holds it
  // inert until it ends). The review itself, not the editor's scroll box: under
  // 1024 px the page scrolls, not the editor.
  const reviewRef = useRef<HTMLElement | null>(null);
  const revealReview = useRef(false);
  const [reveal, setReveal] = useState(0);
  const showReview = useCallback(() => {
    revealReview.current = true;
    setDesignTab('review');
    setReveal((n) => n + 1);
  }, [setDesignTab]);
  useEffect(() => {
    if (!revealReview.current || submitting) return;
    const target = reviewRef.current;
    if (!target) return;
    revealReview.current = false;
    target.scrollIntoView?.({ block: 'start' });
    target.focus({ preventScroll: true });
  }, [reveal, submitting]);

  /**
   * The task this room submits passed its review and waits on the teacher's
   * countersignature. No new attempt is made while
   * it does (the control, "Start a new submission" and ⌘↵ all end here),
   * because a refused resubmit clears the task's place in the sign-off queue.
   * Checking for a lost receipt is a read, so it stays. After the
   * countersignature this is false.
   */
  const designTaskKey = taskForPath(detail?.tasks, DESIGN_JSON)?.key;
  const taskAwaiting = awaitingSignOff(detail, taskKeyToSend(detail?.tasks, designTaskKey) ?? designTaskKey, detail?.lastSubmission ?? null);
  const submitHeld = taskAwaiting && !submissionUncertain;

  const submit = useCallback(async () => {
    if (taskAwaiting && !pendingReceipt.current) return;
    if (submitLock.current || checking || design.writing || agentBusy || design.olderFormat || design.broken ||
        !detail || detail.id !== phaseId || detail.key !== 'design' || detail.status === 'locked') return;
    const owner = getSession()?.id;
    const token = getToken();
    if (!owner || !token) return;
    // The review this room holds is still running: show it rather than start
    // another. Once it has settled, Submit starts a new review, as Requirements'
    // and the code rooms' Submit do.
    if (openedReview.current && reviewInFlight) {
      showReview();
      return;
    }
    const mine = () => alive.current && currentPhase.current === phaseId && getSession()?.id === owner && sameSession(getToken(), token);
    // Which task's revisions this room reads back when a receipt was lost:
    // the one that owns the design record, and nothing at all on a
    // phase with one task: the same key the submit below sends.
    const receiptKey = taskKeyToSend(detail?.tasks, taskForPath(detail?.tasks, DESIGN_JSON)?.key);
    const request = Symbol('design-submit');
    submitLock.current = request;
    setSubmitting(true);
    setError('');
    setNotice('');
    const openReview = (review: SubmissionView, message: string) => {
      if (!mine()) return;
      openedReview.current = review.id;
      pendingReceipt.current = null;
      // A submitted design is the learner's own: the assistant's marks end here.
      clearDesignTouched(phaseId);
      setSubmissionUncertain(false);
      setReceiptChecked(false);
      if (commitDraft(phaseId).trim() === message) clearCommitDraft(phaseId);
      invalidateProject();
      refreshPhaseRecords(phaseId);
      setHeld(review);
      // A review already settled is never polled, so the band is read here.
      if (!reviewPending(review)) void refreshAfterReview();
      showReview();
    };
    try {
      // When an enqueue response was lost, the next explicit action only
      // checks for its receipt. It must not silently create another attempt.
      if (pendingReceipt.current) {
        const known = pendingReceipt.current;
        const list = await api.submissions(phaseId, receiptKey);
        if (!mine()) return;
        const recovered = list.filter(row => !known.ids.has(row.id));
        if (recovered.length === 1) openReview(recovered[0], known.message);
        else {
          setReceiptChecked(recovered.length === 0);
          setError(recovered.length === 0
            ? 'No review was found for that request. Check again or explicitly start a new submission. A delayed review may still appear in your history.'
            : 'More than one new review was found. Open review history to choose the recorded submission.');
        }
        return;
      }
      try {
        await flushSave();
      } catch (err) {
        // the room's own refusal names what to finish; any other failed save says only that nothing was submitted
        if (mine()) setError(err instanceof ApiError && err.status < 500 ? `${err.message} Nothing was submitted.` : 'Your changes could not be saved, so nothing was submitted.');
        return;
      }
      if (!mine()) return;
      const before = await api.submissions(phaseId, receiptKey);
      if (!mine()) return;
      // Only a review still inside the API's age-out window is held. One past
      // it goes on to the submit below, which is what writes it off: the API
      // then starts a new review, or answers with that same one where it is
      // still alive, and the Review tab holds whichever it returns.
      const queued = before.find(row => (row.status === 'queued' || row.status === 'running') && inFlightAgesOutIn(row) > 0);
      if (queued) {
        // This is a read of the existing attempt, not a new submission of
        // the latest draft: the Review tab follows it to its verdict.
        invalidateProject();
        refreshPhaseRecords(phaseId);
        openedReview.current = queued.id;
        setHeld(queued);
        showReview();
        return;
      }
      const known = new Set(before.map(row => row.id));
      const message = commitDraft(phaseId).trim();
      try {
        // Which task this revision answers: the one that owns the design
        // record this room writes. A phase with one task is submitted without
        // a task key.
        const started = await api.submit(
          ...submitArgs(phaseId, message || undefined, detail?.tasks, taskForPath(detail?.tasks, DESIGN_JSON)?.key),
        );
        if (mine()) openReview(started, message);
      } catch (err) {
        if (!mine()) return;
        // A transport failure can occur after enqueue. Keep its baseline so
        // checking/reloading a review never repeats the write automatically.
        if (!(err instanceof ApiError && err.status >= 400 && err.status < 500)) {
          pendingReceipt.current = { ids: known, message };
          setSubmissionUncertain(true);
          setReceiptChecked(false);
        }
        setError(describeError(err, 'The submission response was lost. Check for the recorded review before submitting again.'));
      }
    } catch (err) {
      if (mine()) setError(describeError(err, 'Review history could not be checked. Your work is saved; try again.'));
    } finally {
      if (mine()) setSubmitting(false);
      if (submitLock.current === request) submitLock.current = null;
    }
  }, [agentBusy, checking, design.broken, design.olderFormat, design.writing, detail, flushSave, phaseId, refreshAfterReview, reviewInFlight, showReview, taskAwaiting]);

  /* The two shortcuts the footer draws. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      if (workspaceShortcutBlocked(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) {
        // Read now, while the focus is still where the person was typing.
        const active = document.activeElement;
        shortcutFromField.current = active instanceof HTMLElement && active.matches(TYPING_FIELD) && Boolean(contentRef.current?.contains(active));
        void check();
      } else void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [check, contentRef, submit]);

  /* ------------------------------- the chrome ------------------------------ */

  const phase: Pick<PhaseSummary, 'id' | 'key' | 'title'> = {
    id: phaseId,
    key: detail?.key ?? 'design',
    title: detail?.title ?? 'Design',
  };
  const operations = design.doc.operations;
  const decisions = design.doc.decisions;
  // The room's one header row, as the code rooms draw it: the phase's
  // place and one state chip in the words of `gate-state.ts`, the quick check
  // inline, every other door (the brief, Replay tutorial, Start this task
  // over) in its More menu.
  const quickCheck = useClaimedQuickCheck();
  const roomState = detail ? learnerState(phaseId, detail, { awaiting: taskAwaiting, verdict: designVerdict, task: designTask }) : null;
  // The footer's Submit by the code rooms' rule. It is the primary button while there is
  // work to hand in (`submitLeads`, read from the state the header's chip says) or while a lost receipt must be checked,
  // secondary once the review passed or the countersignature is awaited, so it never stands primary under the band's
  // Continue; and it reads "Submit again" once a submission exists (the phase's own record, or the review this room holds).
  const submitPrimary = submissionUncertain || submitLeads(roomState);
  const submitLabel = phaseSubmitLabel({ key: 'design', place: detail?.place }, phaseHasPr(detail) || Boolean(designVerdict));
  // On a phase the learner has left (the band's own rule, `movedOnFrom`, and not by a Continue pressed
  // here a moment ago), the footer's Check the design and Submit again are quiet (ghost): still there and pressable,
  // not two framed buttons under the "moved on" band. A learner still on the phase sees the footer's framed buttons.
  const footerQuiet = detail?.status === 'passed' && !continuing && movedOnFrom(enrollment ?? null, phaseId) !== null;
  const place = phasePlace(detail?.place, detail?.count)
    ?? (enrollment && holdsPhase(enrollment, 'design') ? placeLabel(enrollment, 'design') : null);

  // Show a form on its tab, then bring it into view once the tab is drawn.
  const openIn = useCallback((tab: DesignTab, testId: string) => {
    setDesignTab(tab);
    requestAnimationFrame(() => document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: 'center' }));
  }, [setDesignTab]);

  const nav: ShellNav = useMemo(
    () => {
      // Only groups with something in them: an empty group is a heading over
      // nothing, and the palette is a list of things you can actually go to.
      const go = (tab: DesignTab, testId: string) => () => openIn(tab, testId);
      return {
        projectTitle: enrollment ? projectName(enrollment.projectTitle) : undefined,
        phases: enrollment?.phases,
        currentPhaseId: phaseId,
        tokensToday: analytics?.tokensToday,
        paletteGroups: [
          ...(operations.length > 0
            ? [{
                label: 'Operations',
                items: operations.map((o, i) => ({
                  label: o.name.trim() || 'Unnamed operation',
                  detail: o.returns.trim() || 'No return yet',
                  icon: 'design' as const,
                  onSelect: go('model', `design-operation-${i}`),
                })),
              }]
            : []),
          ...(decisions.length > 0
            ? [{
                label: 'Decisions',
                items: decisions.map((d, i) => ({
                  label: d.title.trim() || 'Untitled decision',
                  detail: d.choice.trim() || 'No choice yet',
                  hint: d.status,
                  icon: 'design' as const,
                  onSelect: go('decisions', `design-decision-${i}`),
                })),
              }]
            : []),
        ],
      };
    },
    [analytics, decisions, enrollment, openIn, operations, phaseId],
  );

  /* One thread for the column: the feed and the composer are separated by the
     architect's card, so the panel is assembled here rather than dropped in. */
  // No question limit is shown: no route returns one, and past the free
  // allowance a question costs marks rather than being refused (`lib/hints.ts`),
  // so this room does not assert one.
  const thread = usePersona({ phaseKey: 'design', phaseStateId: detail?.id });

  return (
    <WorkPage
      crumbs={[
        ...(enrollment
          ? [
              {
                label: projectName(enrollment.projectTitle),
                href: '/dashboard',
                testId: 'back-dashboard',
              },
            ]
          : []),
        { label: 'Design', href: '/phases?phase=design' },
        { label: 'Design workspace' },
      ]}
      nav={nav}
      testId="design-page"
      strip={
        <PhaseHeader
          phase={phase}
          place={place}
          state={roomState === 'ready' ? 'reviewPassed' : roomState}
          quickCheck={quickCheck}
          lessons={lessonsOfferedOn(enrollment, 'design', details)}
          headline="Design the model, the operations and the decisions behind them"
          menu={
            <>
              <Button href={briefHref({ id: phaseId })} variant="ghost" size="sm" icon="doc" testId="open-brief">
                Brief
              </Button>
              {/* Only an older-format Design is worked in the IDE: a design-kind phase's documents are never shown as files. */}
              {design.olderFormat && (
                <Button href={`/workspace/${phaseId}`} variant="ghost" size="sm" testId="open-workspace">
                  Open the workspace
                </Button>
              )}
            </>
          }
          retry={
            /* "Start this task over" for the task this board is,
               on a teacher's authored list only (the control decides). */
            <TaskResetControl phaseId={phaseId} tasks={detail?.tasks} task={designTask ?? undefined}
              phaseStatus={detail?.status} prepare={flushSave} baseVersion={saved.currentVersion}
              onReset={(result, plan) => { openedReview.current = null; clearDesignTouched(phaseId); saved.adoptReset(result.version, [...plan.restores, ...plan.reseeds]); invalidateProject(); retry(); }}
              onConflict={() => retry()} />
          }
        />
      }
    >
      {/* The studio is where Design is worked, so a passed Design says so
          here too. The save is flushed before the
          advance: the next phase reads these contracts. */}
      <PhaseGateBanner
        phaseId={phaseId}
        phase={detail}
        isLast={Boolean(enrollment && detail && isLastPhase(enrollment, detail.key))}
        onBeforeContinue={bandContinue}
        onContinueFailed={bandContinueFailed}
      />
      {saveError && <div className="shrink-0 p-3"><Notice tone="fail">{saveError}{conflict
        ? <button type="button" className="ml-3 underline" onClick={() => setShowConflict(true)}>Compare versions</button>
        : <button type="button" className="ml-3 underline" disabled={saved.saving} onClick={() => void flushSave().catch(() => { /* A failed retry stays on the page as saveError. */ })}>Retry save</button>}</Notice></div>}
      {showConflict && conflict && <VersionedWorkspaceConflict title="Design" conflict={conflict} files={files} saving={saved.saving}
        onClose={() => setShowConflict(false)} onResolve={(choice, version) => {
          void saved.resolveConflict(choice, version).then(() => { setShowConflict(false); setError(''); }).catch(err => setError(describeError(err, 'Review the latest saved copy before choosing.')));
        }} />}

      {/* The model tabs and, at the row's end, Hide brief / Hide mentor: one
          full-width row above the room's three columns, as Requirements draws
          its tabs row (requirements-toolbar), so both rooms' columns start
          under the same row. */}
      <div className="design-tool-toolbar design-frame-toolbar">
        {/* no tabs over a design that cannot be read: there is nothing behind them */}
        {detail && !design.olderFormat && !design.broken && (
          <nav className="design-tool-tabs" aria-label="Design working area">
            {tabs.map((item) => (
              <button key={item.key} type="button" aria-pressed={designTab === item.key} data-testid={`design-tab-${item.key}`} onClick={() => setDesignTab(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>
        )}
        <WorkspacePanelControls panels={panels} mentorNote="Optional" />
      </div>
      {/* Where a teacher has split the design phase: which task this board
          belongs to, where its siblings have got to, and the door into each
          of them, under the row as in Requirements. Outside the editor,
          which is made inert while the mentor works or a review is being
          started, because a door out of a room must not go inert. Nothing at
          all on a phase with one task. One row, opened on a press;
          "Start this task over" is in the header's More menu. */}
      <TaskPanel compact tasks={detail?.tasks} phase={detail ?? undefined} selected={designTask?.key ?? null} counts={detail?.taskCounts} onLeave={flushSave} className="mx-3 my-1.5 shrink-0" />

      <div className="design-room flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* the parts */}
        {/* A design that never loaded has no parts to summarise: the rail must
            not read "Data model: No fields yet / Contracts: None yet /
            Decisions: Not written" over an unreachable API, about a design the
            learner may have written and scored 100 on. */}
          <aside ref={scrollFocusRef} id={panels.briefId} data-workspace-panel="brief" hidden={!panels.briefOpen} aria-busy={!detail && !error} className="shrink-0 border-b-1.5 border-edge bg-surface px-3 py-3.5 lg:w-[262px] lg:overflow-y-auto lg:border-b-0 lg:border-r-1.5">
            <PhaseBriefIntro phaseKey="design" />
            {/* The phase's brief, plain text: what the Design builder's Brief step writes. Served through `learnerText`, its comments already hidden. */}
            {/* One fold under the name Requirements gives its brief: the
                brief, then the mission, what the phase produces and the
                review criteria, all in that one fold. */}
            {detail && (
              <details className="requirements-full-brief" data-testid="phase-brief">
                <summary>Full project brief and deliverables</summary>
                {detail.taskPanel && <PlainText className="text-[12px] leading-[1.65] text-ink2" text={detail.taskPanel} commentsHidden />}
                <MissionDetails phase={{ key: 'design' }} detail={detail} lessons={lessonsOfferedOn(enrollment, 'design', details)} folded={false} />
              </details>
            )}
            {detail ? (!design.olderFormat && !design.broken && <DesignParts design={design} files={files} />) : <p className="p-3 text-sm text-muted">{error ? 'Your saved design is unavailable.' : 'Opening your saved design…'}</p>}
          </aside>

        {/* the design itself */}
        <section className="design-tool-room flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-4"
            data-testid="phase-design-editor"
            ref={node => { contentRef.current = node; if (node) node.inert = agentBusy || submitting; }}
          >
            {/* The notices in a box of their own: a notice that is itself a
                pane-level child is laid out as a pane (a column, 18 px apart),
                which would put its icon on a line of its own. */}
            {((error && detail) || (notice && !error)) && <div ref={noticesRef} className="design-room-notices" data-testid="design-room-notices">
              {error && detail && <Notice tone="fail">{error}</Notice>}
              {notice && !error && <Notice tone="info">{notice}</Notice>}
            </div>}
            {!detail ? (
              // A failed load is not an empty design: the room says so, keeps
              // its heading and offers the way back in.
              <RoomFallback room="design" error={error} onRetry={retry} />
            ) : design.olderFormat ? (
              <div className="design-room-notices"><Notice tone="info" testId="phase-design-older-format">{DESIGN_OLDER_FORMAT_ROOM}</Notice></div>
            ) : design.broken ? (
              <div className="design-room-notices"><DesignUnavailable design={design} /></div>
            ) : (
              <>
                {/* The forms are the only way into the design, and the diagram
                    redraws from the record as the learner types. */}
                <div hidden={designTab !== 'model'} className="flex flex-col gap-3.5">
                  <UmlDiagram doc={design.doc} />
                  <EntitiesCard design={design} />
                  <RelationsCard design={design} />
                  <OperationsCard design={design} />
                </div>
                {design.contracts.api && (
                  <div hidden={designTab !== 'api'} className="flex flex-col gap-3.5">
                    <ApiWorkbench files={files} setFile={setFile} onPendingDraftChange={notePendingApiDraft} assisted={design.assisted} />
                  </div>
                )}
                {design.contracts.screens && (
                  <div hidden={designTab !== 'screens'} className="flex flex-col gap-3.5">
                    <ScreensForm text={design.screensText} onChange={(t) => design.writeContract(SCREEN_CONTRACT_JSON, t)} editable={!design.busy} assisted={design.assisted} onPendingDraftChange={notePendingScreen} />
                  </div>
                )}
                {/* Off, nothing of the diagram is drawn and the saved source is left as it was. */}
                {design.sequence && (
                  <div hidden={designTab !== 'sequence'}>
                    <DiagramStudio design={design} />
                  </div>
                )}
                <div hidden={designTab !== 'decisions'} className="flex flex-col gap-3.5">
                  <DecisionsCard design={design} />
                  <NotesCard design={design} />
                </div>
                <div hidden={designTab !== 'review'} className="flex flex-col gap-3.5">
                  {/* The verdict, in the room: Submit opens this tab
                      and the review is read here, as in Requirements' Review
                      view; the feedback page stays the history. */}
                  {/* Focused when Submit opens it; its verdict is announced when it lands. */}
                  <section ref={reviewRef} tabIndex={-1} aria-live="polite" aria-label="Review" className="design-review-verdict" data-testid="design-review" data-submission={designVerdict?.id}>
                    {reviewConnectionError && <Notice tone="info">{reviewConnectionError}</Notice>}
                    {/* The report, or the wait, as the shared panel draws them; a
                        failed review and one with no report in the room's own
                        words, as Requirements' Review view says them. */}
                    {designVerdict
                      ? (designVerdict.status === 'completed' && designVerdict.report) || reviewPending(designVerdict)
                        ? <FeedbackPanel submission={designVerdict} tasks={detail.tasks} kind={detail.artifactKind} floors={detail} isLast={Boolean(enrollment && isLastPhase(enrollment, detail.key))} />
                        : <Notice tone={designVerdict.status === 'failed' ? 'fail' : 'info'}>{designVerdict.status === 'failed'
                          ? designVerdict.error || 'The review could not complete. Revise or retry; no Pass was awarded.'
                          : 'This review has no feedback evidence. No new Pass can be awarded from it.'}</Notice>
                      : <p className="text-[13px] text-muted" data-testid="design-review-empty">No review yet. Submit your saved design for an evidence-based Pass or Needs revision.</p>}
                    {designVerdict && <Button href={reviewHref(phaseId)} variant="ghost" size="sm" testId="design-review-history">Review history</Button>}
                  </section>
                  <Contradictions design={design} ownRecord={ownRecord} onOpen={(testId) => openIn('model', testId)} />
                  <DrawnSection design={design} files={files} />
                </div>
                {showChecks && design.floor && (
                  <ChecksPanel
                    results={design.results}
                    floor={design.floor}
                    contracts={design.contracts}
                    sequence={design.sequence}
                    onHide={() => setShowChecks(false)}
                  />
                )}
              </>
            )}
          </div>

          {/* the one line that says where it lives and what happens next; its
              buttons are the small size Requirements' footer uses */}
          {/* Nothing is saved in a room that never opened, and the two controls
              would act on a design this page does not hold. */}
            <footer className="flex min-h-[70px] flex-wrap items-center gap-x-3.5 gap-y-2 border-t-1.5 border-edge bg-surface px-[22px] py-3">
              {detail ? <>
              <span className="label-sm" data-testid="save-state">
                {saved.saving ? 'Saving' : saved.dirty ? 'Unsaved' : 'Saved'}
              </span>
              {saved.savedVersion && <span className="label-sm">{new Date(saved.savedVersion).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
              <span className="flex-1" />
              <Button
                variant={footerQuiet ? 'ghost' : 'secondary'}
                size="sm"
                keys="⌘⇧↵"
                busy={checking || design.writing}
                disabled={submitting || agentBusy || design.olderFormat}
                busyLabel="Checking"
                testId="phase-design-render"
                onClick={check}
              >
                Check the design
              </Button>
              {/* "In review" while the held review runs, as Requirements' Submit; never over "Check submission", which must stay pressable. */}
              <Button size="sm" variant={footerQuiet && !submissionUncertain ? 'ghost' : submitPrimary ? undefined : 'secondary'} keys="⌘↵" testId="design-submit" onClick={submit}
                busy={submitting || (reviewInFlight && !submissionUncertain)} busyLabel={submissionUncertain ? 'Checking submission' : submitting ? 'Submitting' : 'In review'}
                disabled={checking || design.writing || agentBusy || submitHeld || design.olderFormat || Boolean(design.broken)}
                reason={submitHeld ? SIGN_OFF_SUBMIT_REASON : design.broken ? DESIGN_BROKEN_SUBMIT_REASON : undefined}>
                {submissionUncertain ? 'Check submission' : submitLabel}
              </Button>
              {submissionUncertain && <Button href={reviewHref(phaseId)} variant="ghost" size="sm">Review history</Button>}
              {submissionUncertain && receiptChecked && <Button testId="design-submit-new" variant="secondary" size="sm"
                disabled={submitting || checking || design.writing || agentBusy || taskAwaiting}
                reason={taskAwaiting ? SIGN_OFF_SUBMIT_REASON : undefined} onClick={() => {
                  pendingReceipt.current = null;
                  setSubmissionUncertain(false);
                  setReceiptChecked(false);
                  void submit();
                }}>Start a new submission</Button>}
              </> : <span className="label-sm">{error ? 'Reconnect to open your saved work.' : 'Opening saved work…'}</span>}
            </footer>
        </section>

        {/* the architect */}
        <aside
          className="flex min-h-0 shrink-0 flex-col border-t-1.5 border-edge bg-surface lg:w-[340px] lg:border-l-1.5 lg:border-t-0"
          data-testid="persona-panel"
          id={panels.mentorId}
          data-workspace-panel="mentor"
          hidden={!panels.mentorOpen}
        >
          <WorkspaceMentorBoundary panels={panels}><MentorSession thread={thread} /></WorkspaceMentorBoundary>
        </aside>
      </div>

      {/* The room's tour, once: the design, the architect, the
          way out. Its targets exist only once the design has loaded, so an
          unreachable API draws no cards. */}
    </WorkPage>
  );
}
