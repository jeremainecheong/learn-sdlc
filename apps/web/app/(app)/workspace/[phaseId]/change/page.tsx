'use client';
import { sameSession } from '@/lib/session-token';
import { latestSubmission } from '@/components/workspace/requirements/useRequirementsReview';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';

/**
 * The change request: Maintenance's document, the room every Maintenance of the
 * code kind is read in.
 *
 * A change is a ticket, an amendment to a contract, a suite that has to stay
 * green and a release someone else will read: none of which is a file with a
 * cursor, so the change request is written here, through four tabs of forms
 * (Request, Contract, Checks, Release), and the code in the editor. The page
 * owns the two buffers the room writes (`design/contracts.json`, the
 * amendment, and `maintenance/change-request.json`, the record) and hands them
 * to the cards and the forms; every reading still comes from the panel's own
 * rules. A phase whose detail carries no change request (the older format)
 * draws the ticket card and the regression tab, with no Contract tab and no
 * record forms.
 */

import { useParams, useRouter } from 'next/navigation';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { HeaderSubmit, phaseHasPr } from '@/components/workspace/HeaderSubmit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, type ChangeRequest, type EnrollmentView, type ExecutionRunView, type PhaseDetail, type SubmissionView } from '@learnsdlc/shared';
import { api, describeError, getToken } from '@/lib/api';
import { getSession, useSession } from '@/lib/session';
import { useVersionedWorkspaceSave } from '@/components/workspace/useVersionedWorkspaceSave';
import { announceRoomUnsaved } from '@/components/workspace/mentor/roomUnsaved';
import { useAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { useAppliedReadBack } from '@/components/workspace/mentor/useAppliedReadBack';
import { VersionedWorkspaceConflict } from '@/components/workspace/VersionedWorkspaceConflict';
import { jobWake } from '@/lib/job-signal';
import { PollTimeoutError, pollUntil, useRecoverWhenBack } from '@/lib/poll';
import { setActiveProject } from '@/lib/project';
import { railOf } from '@/lib/rail';
import { fullDetail, invalidateProject, useProject } from '@/lib/useProject';
import { DocPage, briefHref, solutionHref, type ShellNav } from '@/components/shell';
import { opensChangeRoom } from '@/components/shell/routes';
import { Button, Chip, Notice } from '@/components/ui';
import {
  AcceptanceChecks,
  ChangeImpactCard,
  ChangeTicket,
  ContractV2,
  RegressionTable,
  ReleaseRecordCard,
} from '@/components/workspace/panels/maintenance/ChangeCards';
import {
  CONTRACTS_JSON,
  emptyOperation,
  serializeContracts,
  upsertOperation,
  type ContractOperation,
} from '@/components/workspace/panels/maintenance/contracts';
import { AmendmentsForm, ChangeFloorCheck, ChangeRecordUnreadable, ChangeRoomOlderNotice, ReleaseForm, RequestForm, TestsForm } from '@/components/workspace/panels/maintenance/ChangeForms';
import { clearChangeTouched, liveChangeMarks, readChangeTouched } from '@/components/workspace/panels/maintenance/change-edit';
import { useMaintenance } from '@/components/workspace/panels/maintenance/useMaintenance';
import { isRoomRecordPath, olderRecordSentence } from '@/components/workspace/records';
import { RoomFallback } from '@/components/workspace/panels/RoomFallback';
import { TaskPanel, submitArgs, taskForPath, taskKeyToSend } from '@/components/workspace/TaskPanel';
import { TaskResetControl } from '@/components/workspace/TaskResetControl';
import { retryOffered } from '@/components/workspace/TaskRetry';
import { RetryInDetails, changeMerged } from '@/components/workspace/panels/maintenance/RetryInDetails';
import { isCredited } from '@/components/workspace/gate-state';
import { PROPOSAL_HOLD_REASON, READ_BACK_HOLD_REASON, READ_BACK_NOTICE, awaitingSignOff, changeRoomChip, inFlightAgesOutIn, pendingRevision, submitOffReason } from '@/components/workspace/signoff-status';
import { solutionDoorOpen } from '@/components/solution/door';
import { MissionDetails } from '@/components/phases/Brief';
import { lessonsOfferedOn } from '@/lib/scenario';
import { projectName } from '@/lib/project-name';
import { settled } from '../workspace-helpers';

/** Whether this room is the phase's: a Maintenance the shell's door sends here. */
const changeRoomOf = (detail: PhaseDetail) => detail.key === 'maintenance' && opensChangeRoom(detail);

/** What the save readout says. "Saved" is exact: the suites read it. */
type Saving = 'idle' | 'dirty' | 'saving' | 'saved';
const SAVE_WORD: Record<Saving, string> = { idle: '', dirty: 'Unsaved', saving: 'Saving', saved: 'Saved' };
/**
 * Why the pass banner did not hand the learner on. It names the two controls
 * the save notice above already draws, which is where the edits are recovered.
 */
const CONTINUE_BLOCKED = 'Your last edits did not save, so this phase was not closed. Compare the versions or retry saving.';
/**
 * The same refusal, said at a task row's door rather than at Continue. The
 * learner asked to open another task of this phase, so the sentence is about
 * that task: the Continue sentence answered a question they had not asked.
 */
const LEAVE_BLOCKED = 'Your last edits did not save, so the other task was not opened. Compare the versions or retry saving.';
/**
 * What the page says once a proposal applied from its mentor has been read back: the words every room uses for it
 * (the design room's notice), in the page's notice place. The mentor says its own line beside it.
 */
const APPLIED_NOTICE = 'The reviewed proposal is saved in this workspace.';
/**
 * The learner's newest Run tests that counted any tests, oldest first as the run log keeps them. The log also holds
 * the review's own executions (`kind: 'submit'`), which are not the learner's run and are skipped.
 */
const newestCountedRun = (runs: ExecutionRunView[] | undefined): ExecutionRunView | null =>
  [...(Array.isArray(runs) ? runs : [])].reverse().find((run) => run.kind === 'run' && run.status === 'completed' && (run.result?.tests?.total ?? 0) > 0) ?? null;

export default function ChangeRequestPage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  const session = useSession();
  return <ChangeRequest key={`${session?.id ?? 'signed-out'}:${phaseId}`} phaseId={phaseId} />;
}

function ChangeRequest({ phaseId }: { phaseId: string }) {
  const router = useRouter();
  const { details, enrollment, analytics, currentPhase } = useProject();

  // What the shell already holds about this phase: the page opens on it and
  // refreshes behind the drawn page, so nothing here waits on the network.
  const seed = fullDetail(details, phaseId);
  const [fetched, setFetched] = useState<PhaseDetail | null>(null);
  usePhaseTutorialReady(fetched);
  const detail = fetched?.id === phaseId ? fetched : seed ?? null;
  const { files, setFile, flushSave, saveError, saving, dirty, savedVersion, currentVersion, conflict, resolveConflict, adoptReset } = useVersionedWorkspaceSave(phaseId, detail);
  // The room says while it holds an edit not yet saved, as the IDE does, which keeps the bridge truthful for the
  // assistant panel mounted beside the room. The room's mentor has both of its modes, as the
  // workspace's does, so a proposal can be asked for, explained and applied from here: the room takes part in the
  // same three signals the workspace and the design room do (`useAgentWorkspace`, below). The guard for an exit save
  // still in flight when the learner reaches the IDE is the server's compare-and-swap, which refuses whichever of
  // the save and the Apply lands second.
  useEffect(() => { announceRoomUnsaved(phaseId, dirty || saving); }, [phaseId, dirty, saving]);
  useEffect(() => () => announceRoomUnsaved(phaseId, false), [phaseId]);
  const [comparing, setComparing] = useState(false);
  const [submission, setSubmission] = useState<SubmissionView | null>(() => seed?.lastSubmission ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const alive = useRef(true);
  const loadRequest = useRef(0);
  const actionInFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; loadRequest.current += 1; };
  }, [phaseId]);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // While the room is showing a failure it picks the connection back up on
  // its own, so a learner who reconnects does not have to think about it.
  useRecoverWhenBack(Boolean(error) && !detail, retry);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    const owner = getSession()?.id;
    const token = getToken();
    const isCurrent = () => alive.current && request === loadRequest.current && getSession()?.id === owner && sameSession(getToken(), token);
    let d: PhaseDetail;
    try {
      d = await api.phase(phaseId);
    } catch (error) {
      if (isCurrent()) throw error;
      return;
    }
    if (!isCurrent() || d.id !== phaseId) return;
    setActiveProject(d.projectSlug);
    setFetched(d);
    setSubmission((prev) => prev ?? d.lastSubmission);
  }, [phaseId]);

  /**
   * The room beside an assistant that can change its files. Before a
   * proposal operation the room's own unsaved edits are saved (the operation
   * reads the saved workspace); while one runs the forms, the start-over
   * control and Submit are held (the forms keep their look: the box that
   * holds them is inert, so nothing is unmounted and nothing claims the files
   * cannot be edited); and when a proposal has been applied the phase is read
   * again, which is what puts the applied record and contract into the forms.
   * The save queue takes the newer copy because nothing of the room's is
   * unsaved by then.
   *
   * If that read fails, the forms, the
   * start-over control, "Start empty" and Submit stay held, and the page says
   * to retry the read in the mentor: the forms and the start-over control
   * write the saved workspace through a save queue whose version is still the
   * one from before the Apply, so an edit would be refused as a conflict whose
   * comparison could offer to write the older copy over the applied change.
   */
  const refreshApplied = useCallback(async () => {
    await load();
    if (!alive.current) return;
    invalidateProject();
    // Said only once the applied record is read back into the forms, so it is true when it shows.
    setNotice(APPLIED_NOTICE);
  }, [load]);
  const readBack = useAppliedReadBack(phaseId, refreshApplied);
  const agentBusy = useAgentWorkspace(phaseId, flushSave, readBack.readBack);
  const unread = agentBusy && readBack.failed;

  /*
   * The learner's own last run of the phase's tests (Run tests in the workspace), from the phase's run log, read
   * once per visit, so the Checks tab's regression card can say what it showed before any verdict.
   * A log that will not load leaves the card's sentence without that run.
   */
  const [lastRun, setLastRun] = useState<ExecutionRunView | null>(null);
  useEffect(() => {
    let active = true;
    setLastRun(null);
    // A run log that will not load leaves the card without that run.
    Promise.resolve()
      .then(() => api.runs(phaseId))
      .then((runs) => { if (active && alive.current) setLastRun(newestCountedRun(runs)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [phaseId]);

  useEffect(() => {
    let active = true;
    const owner = getSession()?.id;
    const token = getToken();
    setError('');
    load().catch((error: unknown) => {
      if (active && alive.current && getSession()?.id === owner && sameSession(getToken(), token)) setError(describeError(error, 'The change request could not be loaded. Try again.'));
    });
    return () => { active = false; };
  }, [load, attempt]);

  // A Maintenance whose door is this room (`opensChangeRoom`: a code Maintenance
  // with a change request, a teacher's own application included, or one in the
  // older format still running the reference application) is read here. Any
  // other phase that lands here goes to the room it belongs in rather than
  // showing an empty one.
  useEffect(() => {
    if (detail && !changeRoomOf(detail)) router.replace(`/workspace/${detail.id}`);
  }, [detail, router]);

  /**
   * The task this room submits passed its review and waits on the teacher's
   * countersignature. Nothing is handed in while it
   * does (the header control, the checks tab and ⌘↵ all end here), because a
   * refused resubmit clears the task's place in the sign-off queue. The key is
   * the one the submit below sends; after the countersignature this is false.
   */
  const changeTaskKey = taskForPath(detail?.tasks, CHANGE_REQUEST_JSON)?.key;
  const taskAwaiting = awaitingSignOff(detail, taskKeyToSend(detail?.tasks, changeTaskKey) ?? changeTaskKey, submission);
  /**
   * A newer revision of the task is still queued or being reviewed. The API
   * holds one in flight per task, so nothing
   * is handed in until its verdict is in (the same three controls). Read
   * against the phase's own newest revision, so a copy this room kept from
   * before a verdict never holds Submit off.
   */
  const pending = pendingRevision(submission, taskKeyToSend(detail?.tasks, changeTaskKey) ?? changeTaskKey, detail?.lastSubmission ?? null);
  const revisionPending = pending !== null;
  // An older-format Maintenance (no change request) is refused by the API, so Submit is off with its sentence.
  const submitOff = (detail ? olderRecordSentence(detail) : null) ?? submitOffReason(taskAwaiting, revisionPending) ?? (agentBusy ? (unread ? READ_BACK_HOLD_REASON : PROPOSAL_HOLD_REASON) : undefined);
  /**
   * While that revision is in flight and this room is not already watching
   * its own submit, the room watches it to its verdict (a
   * review that outlived the submit's own wait, or one in flight when the room
   * opened), so Submit comes back without a reload and the verdict lands here.
   * If it outlives the API's age-out window, the room draws again and Submit is
   * on: the next press is what writes the stalled revision off.
   */
  const pendingId = pending?.id ?? null;
  const [watchRound, setWatchRound] = useState(0);
  useEffect(() => {
    if (!pendingId || busy || !pending) return;
    let stopped = false;
    const owner = getSession()?.id;
    const token = getToken();
    const owns = () => !stopped && alive.current && getSession()?.id === owner && sameSession(getToken(), token);
    pollUntil(
      () => {
        if (!owns()) throw new Error('The editing session changed.');
        return api.getSubmission(pendingId);
      },
      settled,
      { wake: jobWake('submission', pendingId), timeoutMs: Math.max(1_000, inFlightAgesOutIn(pending)) },
    )
      .then(async (finished) => {
        if (!owns()) return;
        setSubmission(finished);
        await load();
        if (owns()) invalidateProject();
      })
      .catch(() => {
        if (owns()) setWatchRound((n) => n + 1);
      });
    return () => { stopped = true; };
    // `pending` is read for its age when the watch starts; the id is what it follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId, busy, load, watchRound]);

  const submit = useCallback(async () => {
    const owner = getSession()?.id;
    const token = getToken();
    if (actionInFlight.current || submitOff || !detail || !owner || !token) return;
    actionInFlight.current = true;
    const owns = () => alive.current && getSession()?.id === owner && sameSession(getToken(), token);
    setBusy(true);
    setError('');
    setNotice('');
    let stage: 'save' | 'submit' | 'review' = 'save';
    try {
      await flushSave();
      if (!owns()) return;
      stage = 'submit';
      // Which task this revision answers: the one that owns the change request
      // this room writes. A phase with one task is submitted without a task
      // key.
      const started = await api.submit(
        ...submitArgs(phaseId, undefined, detail.tasks, taskForPath(detail.tasks, CHANGE_REQUEST_JSON)?.key),
      );
      if (!owns()) return;
      // A submitted change request is the learner's own: the assistant's marks end here.
      clearChangeTouched(phaseId);
      setSubmission(started);
      stage = 'review';
      // The socket only shortens the wait; this reply is still the answer.
      const finished = await pollUntil(
        () => {
          if (!owns()) throw new Error('The editing session changed.');
          return api.getSubmission(started.id);
        },
        settled,
        { wake: jobWake('submission', started.id) },
      );
      if (!owns()) return;
      setSubmission(finished);
      await load();
      if (owns()) invalidateProject();
    } catch (error) {
      if (!owns()) return;
      if (stage === 'save') setError('Your last edits did not save, so the pull request was not opened. Compare the versions or retry saving.');
      else if (error instanceof PollTimeoutError) setNotice('The review is still running. It will land here.');
      else setError(describeError(error, 'The pull request could not be reviewed. Check its latest status before trying again.'));
    } finally {
      actionInFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [detail, flushSave, load, phaseId, submitOff]);

  /**
   * What this room settles before the pass banner hands the learner on.
   *
   * The amendment and the change request are saved on a debounce, and the
   * only other flush is the one that leaves with the page: unawaited, and
   * after the router has already moved. The reflection and the advance belong
   * to the banner; this is the write that has to land first, because the next
   * phase reads these files. A conflict is not flushable: only the comparison
   * can settle it, so the learner is kept here to make that choice.
   */
  const settleWith = useCallback(async (refusal: string) => {
    if (conflict) throw new Error(refusal);
    try {
      await flushSave();
    } catch {
      throw new Error(refusal);
    }
  }, [conflict, flushSave]);
  const continueGuard = useCallback(() => settleWith(CONTINUE_BLOCKED), [settleWith]);
  /** The same write, before a task row's door opens. */
  const leaveGuard = useCallback(() => settleWith(LEAVE_BLOCKED), [settleWith]);

  // ⌘↵ submits, the same key the editor uses, because it is the same act.
  const action = useRef(submit);
  action.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if (workspaceShortcutBlocked(e.target)) return;
      e.preventDefault();
      void action.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Empty until the enrolment lands: the trail omits a crumb it cannot name
  // rather than naming the wrong project for a frame or two.
  const project = projectName(enrollment?.projectTitle);
  const nav = railOf(enrollment, analytics, currentPhase);

  // The skeleton answers a different id on purpose: a suite that waits for
  // `change-page` is waiting for the document, and a `change-page` that is
  // visible before the phase has landed would hand it an empty one.
  if (!detail || !changeRoomOf(detail)) {
    return (
      <DocPage
        crumbs={[
          ...(project ? [{ label: project, href: '/dashboard', testId: 'back-dashboard' }] : []),
          { label: 'Maintenance', href: '/phases?phase=maintenance' },
          { label: 'Change request' },
        ]}
        active="work"
        nav={nav}
        testId="change-loading"
        title="Change request"
      >
        <RoomFallback room="change request" error={error} onRetry={retry} />
      </DocPage>
    );
  }

  return (
    <>
    <ChangeDocument
      detail={detail}
      files={files}
      submission={submission}
      lastRun={lastRun}
      enrollment={enrollment}
      nav={nav}
      project={project}
      busy={busy}
      agentBusy={agentBusy}
      unread={unread}
      submitOff={submitOff}
      revisionPending={revisionPending}
      saving={saving ? 'saving' : dirty ? 'dirty' : savedVersion !== null ? 'saved' : 'idle'}
      saveError={saveError}
      onRetrySave={() => { if (conflict) setComparing(true); else void flushSave().catch(() => { /* A failed retry stays on the page as saveError. */ }); }}
      hasConflict={Boolean(conflict)}
      notice={notice}
      error={error}
      onSubmit={() => void submit()}
      onBeforeContinue={continueGuard}
      onLeave={leaveGuard}
      setFile={setFile}
      setNotice={setNotice}
      onOpenFile={(path) => router.push(`/workspace/${detail.id}?file=${encodeURIComponent(path)}`)}
      // "Start this task over" for the task this change request
      // is, on a teacher's authored list only (the control decides).
      resetControl={
        <TaskResetControl className="mb-2" phaseId={phaseId} tasks={detail.tasks} task={taskForPath(detail.tasks, CHANGE_REQUEST_JSON)}
          phaseStatus={detail.status} prepare={flushSave} baseVersion={currentVersion}
          onReset={async (result, plan) => { clearChangeTouched(phaseId); adoptReset(result.version, [...plan.restores, ...plan.reseeds]); invalidateProject(); await load().catch(() => undefined); }}
          onConflict={() => load().catch(() => undefined)} />
      }
    />
    {comparing && conflict && <VersionedWorkspaceConflict title="change request" conflict={conflict} files={files} saving={saving}
      onClose={() => setComparing(false)}
      onResolve={(choice, version) => { void resolveConflict(choice, version).then(() => setComparing(false)).catch(() => { /* A refused choice leaves the comparison open to choose again. */ }); }} />}
    </>
  );
}

/**
 * The page once the phase has loaded. It is its own component because the
 * reading (the ticket, the contract, the suites, the record) needs a phase
 * to read, and a hook cannot be called only when one has arrived.
 */
function ChangeDocument({
  detail,
  files,
  submission,
  lastRun,
  enrollment,
  nav,
  project,
  busy,
  agentBusy,
  unread,
  submitOff,
  revisionPending,
  saving,
  saveError,
  onRetrySave,
  hasConflict,
  notice,
  error,
  onSubmit,
  onBeforeContinue,
  onLeave,
  setFile,
  setNotice,
  onOpenFile,
  resetControl,
}: {
  detail: PhaseDetail;
  files: Record<string, string>;
  submission: SubmissionView | null;
  /** The learner's newest run of the phase's tests that counted any, or null (the regression card reads it). */
  lastRun: ExecutionRunView | null;
  enrollment: EnrollmentView | null;
  nav: ShellNav | undefined;
  project: string;
  busy: boolean;
  /**
   * A proposal operation owns the saved workspace: until it ends, and until
   * the page has read back what it applied, the forms and the start-over
   * control are inert, and "Start empty" is not offered.
   */
  agentBusy: boolean;
  /** The proposal has finished but the page's read of it failed: the page says to retry it in the mentor. */
  unread: boolean;
  /**
   * Why Submit is off, or nothing while it is on: the phase is in the older
   * format, the task passed and waits on the countersignature, a newer
   * revision is in flight, or a proposal operation runs (or has not been read
   * back yet), each with its own sentence.
   */
  submitOff?: string;
  /** The page's own hold on a revision in flight (`pendingRevision`): the regression card says the review runs exactly then. */
  revisionPending: boolean;
  saving: Saving;
  saveError: string;
  onRetrySave: () => void;
  hasConflict: boolean;
  notice: string;
  error: string;
  onSubmit: () => void;
  onBeforeContinue: () => Promise<void>;
  /** What a task row's door settles first: the same write, its own sentence. */
  onLeave: () => Promise<void>;
  setFile: (path: string, content: string) => void;
  setNotice: (message: string) => void;
  onOpenFile: (path: string) => void;
  /** "Start this task over", built by the page that owns the save. */
  resetControl?: import('react').ReactNode;
}) {
  const m = useMaintenance({ detail, files, submission, enrollment });
  const [view,setView]=useState<'request'|'contract'|'checks'|'release'>('request');
  // The teacher's ticket, switch and floor; absent on a phase in the older format.
  const spec = detail.change;
  // `ContractV2` edits design/contracts.json, so it is drawn only where the phase mounts that file.
  const contractsMounted = detail.files.some((f) => f.path === CONTRACTS_JSON);
  // The Contract tab shows while the teacher's switch is on. A code Maintenance with no change request (the older
  // format) has no switch and no tab, so the room claims nothing about an operation. Its Checks tab stays:
  // the learner's last verdict reads there, and its Submit is off with the older sentence through `submitOff`.
  const contractTab = spec ? spec.contract : false;
  // A record that cannot be read is never overwritten by a form: the forms are read-only until it reads
  // again, or until the learner starts it empty (the one write over it, after a confirm line).
  const recordMounted = detail.files.find((f) => f.path === CHANGE_REQUEST_JSON)?.editable ?? false;
  const recordEditable = recordMounted && !m.recordError;
  const writeChange = (next: ChangeRequest) => setFile(CHANGE_REQUEST_JSON, serialiseChangeRequest(next));
  // The fields an applied proposal wrote, while each still holds the assistant's text.
  const assisted = liveChangeMarks(readChangeTouched(detail.id), m.recordText);
  // The file chips the Request tab offers: the phase's editable files, never a record.
  const impactFiles = detail.files.filter((f) => f.editable && !isRoomRecordPath(f.path)).map((f) => f.path);

  // Named by the phase's place in its own project, never its stored order.
  const pr = `PR-${detail.place}`;
  const attempt = submission?.attempt ?? (detail.attempts > 0 ? detail.attempts : null);
  /*
   * Once the learner has completed the project (or moved past this phase), the pull request is merged, as its
   * own page says, so the line says merged rather than open. Before that it says open.
   */
  /*
   * Complete the project pressed in this room. The advance's answer reaches the shell's enrolment a
   * moment before the router reaches /complete, and in that moment the line keeps "open", as the band keeps "Ready to
   * continue", until the next page replaces the room. Let go if the Continue does not go ahead.
   */
  const [continuing, setContinuing] = useState(false);
  const continueHere = useCallback(async () => {
    setContinuing(true);
    await onBeforeContinue();
  }, [onBeforeContinue]);
  const continueFailed = useCallback(() => setContinuing(false), []);
  const merged = !continuing && changeMerged(enrollment, detail);
  const prLine = submission ? `${pr} ${merged ? 'merged' : 'open'}, submission ${attempt ?? 1}` : `${pr} opens when you submit`;
  /*
   * On a task already passed, "Retry this task" is not drawn in the body right under the Pass: it is
   * read inside the header's Details, as the workspace keeps it in More. "Start this task over", on a task in
   * progress, stays in the body.
   *
   * Once the control is in Details it stays there for the rest of this visit. A retry that goes
   * ahead turns the task back to in progress; moved back to the body, the control would be drawn afresh and lose
   * its own sentence ("This task is open for a new attempt. ...") and the focus its confirm hands back. A fresh
   * visit to a task in progress still finds "Start this task over" in the body.
   */
  const offeredAside = retryOffered(detail.tasks, taskForPath(detail.tasks, CHANGE_REQUEST_JSON), detail.status);
  const [asideFor, setAsideFor] = useState<string | null>(null);
  if (offeredAside && asideFor !== detail.id) setAsideFor(detail.id);
  const retryAside = offeredAside || asideFor === detail.id;
  const contractsEditable = detail.files.find((f) => f.path === CONTRACTS_JSON)?.editable ?? false;

  const writeContracts = (op: ContractOperation, index: number) =>
    setFile(CONTRACTS_JSON, serializeContracts(upsertOperation(m.doc, index, op)));
  // While a proposal operation runs, the start-over control and the forms cannot be pressed, typed in or tabbed
  // into, and look as they did: `inert` on the box that holds them, as the design room does for its board.
  const hold = useCallback((node: HTMLDivElement | null) => { if (node) node.inert = agentBusy; }, [agentBusy]);

  return (
    <PhaseDocumentFrame phase={detail} view="change"
      onBeforeContinue={continueHere}
      onContinueFailed={continueFailed}
      mission={<MissionDetails phase={detail} detail={detail} lessons={lessonsOfferedOn(enrollment, 'maintenance', { [detail.id]: detail })} />}
      crumbs={[
        ...(project ? [{ label: project, href: '/dashboard', testId: 'back-dashboard' }] : []),
        { label: detail.title, href: '/phases?phase=maintenance' },
        { label: m.ticket.id },
      ]}
      active="work"
      nav={nav}
      testId="change-page"
      title={`${m.ticket.id}: ${m.ticket.title}`}
      titleTestId="change-title"
      // The working-area row is the frame's (the workspace's own row,
      // entry for entry); this page's own sections are a second row.
      subNav={<nav className="phase-room-nav phase-room-nav--sections" aria-label="Change request sections"><button type="button" aria-pressed={view==='request'} onClick={()=>setView('request')}>Request</button>{contractTab&&<button type="button" aria-pressed={view==='contract'} onClick={()=>setView('contract')}>Contract</button>}<button type="button" aria-pressed={view==='checks'} onClick={()=>setView('checks')}>Checks</button><button type="button" aria-pressed={view==='release'} onClick={()=>setView('release')}>Release</button></nav>}
      right={
        <>
          <Button href={briefHref(detail)} variant="ghost" size="sm" icon="doc" testId="open-brief">
            Brief
          </Button>
          <Button href={`/workspace/${detail.id}`} variant="secondary" size="sm" testId="open-workspace">
            Open the workspace
          </Button>
          {/* The door to the pack's own answer. It exists only
              once the gate is in: there is no greyed control, because a
              visible locked door is an invitation to look for the key. */}
          {solutionDoorOpen(detail) && (
            <Button
              href={solutionHref(detail)}
              variant="secondary"
              size="sm"
              icon="eye"
              testId="solution-open"
            >
              Read the reference solution
            </Button>
          )}
          {retryAside && <RetryInDetails held={agentBusy}>{resetControl}</RetryInDetails>}
          {/* Submit PR-<n>, "again" once one exists; inside Details where nothing is to resubmit. */}
          <HeaderSubmit phase={detail} keys="⌘↵" testId="phase-maintenance-submit" busy={busy} busyLabel="In review" onClick={onSubmit}
            disabled={Boolean(submitOff)} reason={submitOff} />
        </>
      }
    >
      {/* Current submission and save state, below the shared phase heading. */}
      <div className="-mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {/* A passing review waiting on the teacher's
            countersignature is not a revision to make. */}
        <Chip tone={changeRoomChip(detail, isCredited(detail.id, detail)).tone}>{changeRoomChip(detail, isCredited(detail.id, detail)).label}</Chip>
        <span className="label-sm">{prLine}</span>
        {saving !== 'idle' && (
          <span className="label-sm" data-testid="save-state">
            {SAVE_WORD[saving]}
          </span>
        )}
      </div>

      {saveError && <Notice tone="fail"><div className="flex flex-wrap items-center justify-between gap-3"><span>{saveError}</span><Button variant="secondary" disabled={saving === 'saving'} onClick={onRetrySave}>{hasConflict ? 'Compare versions' : 'Retry save'}</Button></div></Notice>}

      {(error || notice) && <Notice tone={error ? 'fail' : 'info'}>{error || notice}</Notice>}
      {unread && <Notice tone="warn" testId="applied-read-back">{READ_BACK_NOTICE}</Notice>}

      <ChangeRoomOlderNotice detail={detail} />

      {spec && m.recordError && <ChangeRecordUnreadable error={m.recordError} canStartEmpty={recordMounted && !agentBusy} onStartEmpty={() => writeChange(EMPTY_CHANGE_REQUEST)} />}

      {/* Which task this room's change request belongs to, where a teacher has split
          the phase. Nothing at all on a phase with one task, which is every
          maintenance phase while the wall keeps executable work single-task.
          This room writes one artefact, so the task it is on is whichever owns
          that file and never a chooser; a sibling's row is a door to the room
          that task is worked in.
          `onLeave` is the same guard Continue passes, for the same reason: the
          change request is written on a 700 ms debounce and the only other flush is
          the unawaited one that leaves with the page, which returns without
          saving at all while a conflict is open. A door that did not settle it
          would carry the learner out of the room holding the comparison. */}
      <TaskPanel tasks={detail.tasks} phase={{ ...detail, lastSubmission: latestSubmission(detail.lastSubmission ?? null, submission) }} selected={taskForPath(detail.tasks, CHANGE_REQUEST_JSON)?.key ?? null} counts={detail.taskCounts} onLeave={onLeave} />
      {/* `contents`: the box is for the hold alone and takes no part in the layout. */}
      <div ref={hold} className="contents" aria-busy={agentBusy || undefined} data-testid="change-held">
      {!retryAside && resetControl}

      <div className="phase-change-panels">
        <div hidden={view!=='request'}>
          {spec
            ? <RequestForm ticket={spec.ticket} change={m.record} files={impactFiles} editable={recordEditable} onChange={writeChange} assisted={assisted} />
            : <ChangeTicket m={m} pr={pr} />}
        </div>
        {contractTab && <div hidden={view!=='contract'} className="flex flex-col gap-4">
          {contractsMounted && <ContractV2
            m={m}
            editable={contractsEditable}
            onAdd={() => {
              // The contract added is the operation the change request names (its Request tab); none named, nothing added.
              if (!m.operation) return;
              writeContracts(emptyOperation(m.operation, m.ticket.id), -1);
              setNotice(`${m.operation} added to ${CONTRACTS_JSON}.`);
            }}
            onPatch={(part) => {
              if (!m.change) return;
              writeContracts({ ...m.change, ...part }, m.changeIndex);
            }}
          />}
          {spec && <AmendmentsForm change={m.record} editable={recordEditable} onChange={writeChange} assisted={assisted} />}
        </div>}
        <div hidden={view!=='checks'} className="flex flex-col gap-4">
          <RegressionTable m={m} pr={pr} onSubmit={onSubmit} busy={busy || Boolean(submitOff)} reason={submitOff} lastRun={lastRun} running={revisionPending} hasPr={phaseHasPr(detail)} />
          {/* The report's verdict on each acceptance line: the Request tab is a form here, not the ticket card that drew them. */}
          {spec && <AcceptanceChecks m={m} pr={pr} />}
          {spec && <TestsForm ticket={spec.ticket} change={m.record} editable={recordEditable} onChange={writeChange} assisted={assisted} />}
          {spec && <ChangeFloorCheck text={m.recordText} spec={{ contract: spec.contract, floor: spec.floor, ticket: spec.ticket }} />}
        </div>
        <div hidden={view!=='release'} className="flex flex-col gap-4">
          <ReleaseRecordCard m={m} pr={pr} />
          {spec && <ReleaseForm ticket={spec.ticket} change={m.record} editable={recordEditable} onChange={writeChange} assisted={assisted} />}
        </div>
      </div>
      </div>

      {view==='request'&&<ChangeImpactCard
        m={m}
        impact={submission?.report?.impact}
        functions={submission?.report?.staticAnalysis?.functions ?? []}
        onOpen={onOpenFile}
        pr={pr}
      />}
    </PhaseDocumentFrame>
  );
}
