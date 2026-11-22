'use client';

/**
 * The work IDE: the room the three build phases are done in, and the room
 * Requirements, Design and Maintenance open their files in.
 *
 * The shape is the one every learner already knows (explorer, tabs, code,
 * a panel underneath, a status line) carrying this product's facts. The
 * explorer's source-control block is the pull request and the hidden suite;
 * Problems are criteria that are not met; the note between two lines names the
 * contract the line contradicts; the right column is the brief and the
 * reviewer for the phase.
 *
 * Nothing here derives what a panel already derives: the pull request, the kill
 * matrix, the criteria and the ledger all come from
 * `components/workspace/panels/*` and from the last verdict.
 *
 * This page loads the phase, saves, runs and submits; WorkspaceBody.tsx draws
 * the room from what it hands down, WorkspaceFrame.tsx draws it before the
 * phase has arrived, and the module-level helpers and the session's view cache
 * sit beside them (workspace-helpers.ts, view-cache.ts).
 */

import { sameSession } from '@/lib/session-token';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';
import { clearChangeTouched } from '@/components/workspace/panels/maintenance/change-edit';

import { useAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { appliedReveal, type AppliedReveal } from '@/components/workspace/applied-reveal';
import { announceRoomUnsaved } from '@/components/workspace/mentor/roomUnsaved';
import { WORKSPACE_SAVE_DELAY_MS } from '@/components/workspace/useVersionedWorkspaceSave';
import { isRoomRecordPath, olderRecordSentence } from '@/components/workspace/records';
import { resolveAndReload, writtenByOwnResolve, type OwnResolve } from '@/components/workspace/panels/deployment/drill';
import {
  clearRunbookTouched,
  liveRunbookMarks,
  readRunbookTouched,
} from '@/components/workspace/panels/deployment/runbook-edit';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DrillState,
  EnrollmentView,
  ExecutionRunView,
  JobEvent,
  PhaseLink,
  SubmissionView,
} from '@learnsdlc/shared';
import { RETIRED_WRITTEN_PHASE_ROOM, RUNBOOK_JSON } from '@learnsdlc/shared';
import { ApiError, api, getToken, onSessionLeaving, signInHref } from '@/lib/api';
import { clearCommitDraft, commitDraft } from '@/lib/commit';
import {
  acknowledgeVersionedWorkspaceSave,
  discardVersionedWorkspaceDraft,
  readVersionedWorkspaceDraft,
  rememberVersionedWorkspaceDraft,
  saveVersionedWorkspaceOnExit,
  workspaceApi,
  type WorkspacePhaseDetail,
} from '@/lib/api-workspace';
import { jobWake } from '@/lib/job-signal';
import { PollTimeoutError, useRecoverWhenBack } from '@/lib/poll';
import { getSocket } from '@/lib/socket';
import { getActiveProject, setActiveProject } from '@/lib/project';
import { cachedRecords, loadRecords, refreshPhaseRecords, refreshingRecords } from '@/lib/records';
import { getSession } from '@/lib/session';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';
import { THEME_EVENT, THEME_KEY, useTheme, type Theme } from '@/lib/theme';
import { fullDetail, invalidateProject, learnerMessage, useProject } from '@/lib/useProject';
// The hook that owns the live preview's session.
import { stopPreviewOnExit, usePreview } from '@/components/workspace/usePreview';
import {
  phaseDocHref,
  quizHref,
} from '@/components/shell';
import { previewOffered, previewSurface } from '@/components/workspace/preview/rooms';
import {
  chooseTask,
  isSplit,
  isWorkSplit,
  submitArgs,
  taskActivePath,
  taskKeyToSend,
  taskPaths,
  taskRoomHref,
  viewKeyFor,
  workTasks,
} from '@/components/workspace/TaskPanel';
import { preloadEditor } from '@/components/workspace/preload';
import { TaskResetControl } from '@/components/workspace/TaskResetControl';
import { awaitingSignOff, revisionInFlight, submitOffReason } from '@/components/workspace/signoff-status';
import { createCaretStore, type Caret } from '@/components/workspace/caret-store';
import { PHASE_PANELS } from '@/components/workspace/panels';
import type { DrillApi, PhasePanelProps } from '@/components/workspace/panels/types';
import {
  buildProblems,
  buildTree,
  defaultCollapsed,
  fnAt,
  functionsIn,
  type FnSpan,
  type Problem,
} from '@/components/workspace/ide/derive';
import { changeFirst } from '@/components/workspace/opening-file';
import {
  seedTabs,
  readCollapsed,
  keepCollapsed,
  type RightTab,
  type Pane,
  NO_ANALYZER_FNS,
  SAVE_FAILED_SUBMIT,
  SAVE_FAILED_RUN,
  SAVE_FAILED_RUN_APP,
  SAVE_FAILED_ADVANCE,
  STILL_RUNNING,
  GAVE_UP,
  settled,
  pickNewer,
  readVerdict,
  rememberVerdict,
  loadFailure,
  isTextField,
  wantedTab,
  follow,
} from './workspace-helpers';
import { projectName } from '@/lib/project-name';
import { WorkspaceFrame } from './WorkspaceFrame';
import { WorkspaceBody } from './WorkspaceBody';
import {
  type WorkspaceView,
  DETAILS,
  heldView,
  keepView,
  heldDetail,
  keepDetail,
  withSaved,
} from './view-cache';

export default function WorkspacePage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  // Keyed by the phase, so moving from one phase's workspace to another's is a
  // fresh room rather than the old room's state being unpicked field by field.
  // Everything a phase holds (the open file, the caret, the verdict being
  // watched, the edits waiting to be saved) belongs to that phase and is
  // restored from, or written back to, {@link VIEWS} on the way in and out.
  return <PhaseWorkspace key={phaseId} phaseId={phaseId} />;
}

function PhaseWorkspace({ phaseId }: { phaseId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const requestedFile = search.get('file');
  /**
   * Which task this room was opened on.
   *
   * On a phase with no record room (Implementation, Testing) every
   * task that is not a quiz is worked here, reached by `?task=` exactly as the
   * quiz room is, so the query is the room's subject the way `?file=` is its
   * open file: a link a learner was sent, a back button and the panel's own
   * `aria-current` all have to agree about it.
   */
  const asked = search.get('task');
  /** The view a room's tools open on (`?panel=runbook`: Deployment's Runbook view, linked from the drill page). */
  const requestedView = search.get('panel');
  const { analytics, details, enrollment: projectEnrollment } = useProject();

  /**
   * What the shell already knows about this phase.
   *
   * The provider loaded every open phase's detail when the session began, so
   * the IDE opens on the copy in memory and refreshes it behind the drawn page
   * rather than showing a blank document while the network decides what the
   * learner is looking at. `fetched` wins once it arrives, and only for the
   * phase it was fetched for: the sidebar swaps phases without remounting.
   */
  const seed = heldDetail(phaseId) ?? fullDetail(details, phaseId);
  const [fetched, setFetched] = useState<WorkspacePhaseDetail | null>(null);
  usePhaseTutorialReady(fetched);
  const detail = fetched && fetched.id === phaseId ? fetched : (seed ?? null);

  // The phase says which project it belongs to, so the provider's enrolment is
  // used when it is that project's, which it is every time the learner walked
  // here rather than opening a link to someone else's project.
  const [fetchedEnrollment, setFetchedEnrollment] = useState<EnrollmentView | null>(null);
  const enrollment =
    projectEnrollment && (!detail || projectEnrollment.projectSlug === detail.projectSlug)
      ? projectEnrollment
      : fetchedEnrollment;
  const providerEnrollment = useRef(projectEnrollment);
  providerEnrollment.current = projectEnrollment;

  /**
   * Which task of this phase the room is working in.
   *
   * Nothing is selected until the learner picks one, and `chooseTask` answers
   * where the work is: the first required task still to pass. On a phase with
   * one task everything below is the identity: `viewKey` is the phase id,
   * `submitKey` is nothing at all, and the seed, the active file and the
   * folded folders are keyed by the phase alone.
   */
  const [selectedTask, setSelectedTask] = useState<string | null>(asked);
  const tasks = detail?.tasks;
  const task = chooseTask(tasks, selectedTask);
  const viewKey = viewKeyFor(phaseId, tasks, selectedTask);
  /** The keys this phase's records are read under, as one stable value. */
  const taskScope = (tasks ?? []).map((row) => row.key).join(',');
  const submitKey = taskKeyToSend(tasks, selectedTask);
  /**
   * The key an in-flight submission is held under. A split phase may have two
   * at once (one per task, which is what the per-task in-flight guard allows)
   * and a phase with one task has a single slot.
   *
   * Keyed on the boolean, never on the list. Every read of the phase parses a
   * new `tasks` array, even a 304 of the same bytes, and a callback over the
   * array would be a new `flightKey` per read, so a new `watchSubmission`, so
   * the mount effect would run again, so another read: about two hundred
   * `GET /phases/:id` a second, for as long as the room was open.
   * Whether the phase is split is all this callback answers, and that is a
   * value that only changes when a teacher re-cuts the phase.
   */
  const split = isSplit(tasks);
  const flightKey = useCallback(
    (key?: string) => (split ? (key ?? '') : ''),
    [split],
  );

  // Where this phase was left: the file, the caret, the panel. Read before the
  // first render, so coming back draws the room as it was rather than the
  // phase's opening view. Keyed by the task on a split phase, or switching
  // task would restore the previous task's caret into this task's file.
  const held = heldView(viewKey);
  const heldRecords = cachedRecords([phaseId])[phaseId];

  /** What the learner has typed, over the copy the phase came with. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [chosenPath, setActivePath] = useState(requestedFile ?? held?.path ?? '');
  // The tab strip is the editors that are open, not the phase's whole tree:
  // the file you are asked to change plus the one or two you check it against.
  // Everything else is a click away in the Explorer, which lists them all.
  // This holds only the ones opened beyond that; the seed is derived.
  const [extraPaths, setExtraPaths] = useState<string[]>(held?.extra ?? []);
  const appliedFileRequest = useRef<string | null>(null);
  useIsoLayoutEffect(() => {
    if (appliedFileRequest.current === requestedFile || (!detail && requestedFile)) return;
    appliedFileRequest.current = requestedFile;
    if (requestedFile && detail?.files.some(file => file.path === requestedFile)) {
      setActivePath(requestedFile);
      setExtraPaths(paths => paths.includes(requestedFile) ? paths : [...paths, requestedFile]);
    }
  }, [requestedFile, detail]);
  const [saving, setSaving] = useState<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
  /**
   * Has the workspace moved on since the verdict the code health describes?
   * `saving` settles back to "saved" a second after a keystroke
   * and `workspaceUpdatedAt` changes only when the save is acknowledged, so
   * neither alone describes an unsaved edit. This flag is set by every edit
   * and cleared by every submission, which is exactly the question the
   * analyzer's line numbers depend on.
   */
  const [editedSinceVerdict, setEditedSinceVerdict] = useState(false);
  const [run, setRun] = useState<ExecutionRunView | null>(null);
  const [running, setRunning] = useState(false);
  const [submission, setSubmission] = useState<SubmissionView | null>(seed?.lastSubmission ?? null);
  /**
   * Which submissions this room has in flight, by task.
   *
   * A single boolean would, on a phase a teacher has split, make one task's
   * review disable the other task's Submit, while the API's own guard is one
   * in-flight revision per **task**. A phase with one task holds a set of at
   * most one under a single key, which behaves as a boolean.
   */
  const [submittingKeys, setSubmittingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markSubmitting = useCallback((key: string, on: boolean) => {
    setSubmittingKeys((held) => {
      if (held.has(key) === on) return held;
      const next = new Set(held);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const submitting = submittingKeys.has(flightKey(submitKey));
  /**
   * The tasks whose revision this room is following while it is marked: from
   * the moment a revision is handed back queued or running until its verdict
   * lands. The phase detail is not
   * reloaded inside that window, and a split phase may have two revisions in
   * it at once, so the task list reads "In review" off this as well as off
   * the phase's newest revision.
   */
  const [followingKeys, setFollowingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markFollowing = useCallback((key: string, on: boolean) => {
    setFollowingKeys((held) => {
      if (held.has(key) === on) return held;
      const next = new Set(held);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [tab, setTab] = useState<RightTab>(held?.tab && held.tab !== 'brief' ? held.tab : 'mentor');
  const [bottom, setBottom] = useState(held?.bottom ?? (seed?.key === 'deployment' ? 'pipeline' : seed?.key === 'testing' ? 'tests' : 'terminal'));
  // Which of the three panes is showing on a narrow screen. Above lg all
  // three are visible at once and this is ignored.
  const [pane, setPane] = useState<Pane>(held?.pane ?? 'code');
  // `?panel=runbook` names the Runbook view of the room's tools (the drill page's "Open the Runbook tab"):
  // Deployment's tools are the Pipeline tab, brought into view on a narrow screen too. Any other value moves nothing.
  useEffect(() => {
    if (requestedView !== 'runbook' || detail?.key !== 'deployment') return;
    setBottom('pipeline');
    setPane('code');
  }, [requestedView, detail?.key]);
  // The room says when it holds an unsaved edit: a record proposal's Apply waits on it.
  useEffect(() => { announceRoomUnsaved(phaseId, saving === 'dirty' || saving === 'saving'); }, [phaseId, saving]);
  useEffect(() => () => announceRoomUnsaved(phaseId, false), [phaseId]);
  const [showReflection, setShowReflection] = useState(false);
  /**
   * Run app has been pressed and nothing has been sent yet. Without it the
   * preview pane would sit on its idle copy for 1.7 s (the save round trip
   * plus the POST) while the button beside it already read "Building".
   */
  const [runAppPressed, setRunAppPressed] = useState(false);
  // The caret is a store the status bar reads, not page state: Monaco
  // reports it on every character, and a new `{ line, col }` here would render
  // the whole room again per keystroke. The page
  // keeps the caret's line, which the function map follows.
  const [caret] = useState(() => createCaretStore(held?.cursor ?? { line: 1, col: 1 }));
  const [cursorLine, setCursorLine] = useState(caret.get().line);
  const setCursor = useCallback((next: Caret) => {
    caret.set(next);
    setCursorLine(next.line);
  }, [caret]);
  const [focusLine, setFocusLine] = useState<{ line: number; nonce: number; quiet?: boolean } | null>(
    null,
  );
  /**
   * After an Apply: the first and last lines it changed in the
   * open file, which the editor brings into view once, as the applied text arrives in it (`appliedReveal`). Dropped once shown, on a keystroke, and when
   * another file is opened first; nothing else sets it, so a reload, a save or a switch of view never scrolls the code.
   */
  const [revealApplied, setRevealApplied] = useState<(AppliedReveal & { nonce: number; since: number }) | null>(null);
  const revealAppliedRef = useRef(revealApplied);
  revealAppliedRef.current = revealApplied;
  const dropRevealApplied = useCallback(() => setRevealApplied(null), []);
  /** The file the editor is showing and its text, read when an Apply lands, before the applied copy replaces it. */
  const shownRef = useRef<{ path: string; text: string } | null>(null);
  const [error, setError] = useState('');
  // Neutral, non-alarming status: a slow job, or a copy refreshed from another
  // tab. Kept apart from `error` so it never renders red.
  const [notice, setNotice] = useState('');
  /**
   * An applied proposal, read back. Drawn in the centre column, where the design room draws the
   * same notice, not in the full-width strip above the three columns, so nothing outside the centre moves when it
   * comes or goes. Cleared wherever the notice is cleared: a run and a submission, when they start and when they end.
   */
  const [appliedNote, setAppliedNote] = useState(false);
  /**
   * A save the API refused because the row moved on under it. Without it both
   * tabs would read "Saved" while the server held one of the two texts; the
   * tab that lost is told, by name, and nothing of theirs has been written
   * over anything of anybody else's.
   */
  const [conflict, setConflict] = useState<{ paths: string[]; version: string; recovered?: boolean } | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const [theme] = useTheme();
  const [submissions, setSubmissions] = useState<SubmissionView[]>(heldRecords?.submissions ?? []);
  const [runs, setRuns] = useState<ExecutionRunView[]>(heldRecords?.runs ?? []);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [links, setLinksState] = useState<PhaseLink[]>(seed?.links ?? []);
  // What the sandbox calls today for this phase: an ISO date, or null for the
  // machine's clock. Testing only, and the learner's own.
  const [runClock, setRunClockState] = useState<string | null>(seed?.runClock ?? null);
  const [drill, setDrill] = useState<DrillState | null>(seed?.drill ?? null);
  // The folders the learner has closed. Null until the phase's own default has
  // been worked out and whatever they last did has been read back.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null);
  /**
   * The files this session has typed into, for the explorer's changed dot.
   *
   * State rather than a read of `touchedRef` keyed off the save state: a tree
   * that listed `saving` among its dependencies to notice a new dot would
   * rebuild itself on every idle -> unsaved -> saving -> saved cycle. This
   * moves when a file is touched for the first time, which is exactly when a
   * dot appears.
   */
  const [modifiedPaths, setModifiedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef<Record<string, string>>({});
  /**
   * The newest text of every file typed into this session, a moment before
   * `typed` holds it.
   *
   * If a character were page state, every keystroke would rebuild the file
   * map, the analyzer's spans, the problems, the panel props and every column
   * that reads them: 390 elements outside the editor for one character. The
   * keystroke goes in here instead and `typed` is committed when the autosave
   * fires, which is the moment the page has to catch up anyway. The editor
   * reads this buffer, so what is on screen is always the newest text: it is
   * `typed` that lags, by less than a second, and only for the readouts.
   */
  const liveRef = useRef<Record<string, string>>({});
  /** Is there a keystroke in the buffer that `typed` has not been told about? */
  const pendingText = useRef(false);
  // Every path this session has typed into, for the explorer's changed dot.
  const touchedRef = useRef<Set<string>>(new Set());
  // The server's copy of each file as this page last saw it, so a change made
  // in another tab can be told from the learner's own.
  const serverRef = useRef<Record<string, string>>({});
  /**
   * The `workspaceUpdatedAt` this tab last saw, quoted on every save so the API
   * can refuse to write over a save this tab never saw. Null until the phase
   * has loaded, which is the only state where this tab has no version to
   * quote, and then the save is sent without one.
   */
  const versionRef = useRef<string | null>(null);
  const alive = useRef(true);
  const actions = useRef<{
    run: () => void;
    submit: () => void;
    mutants: () => void;
    runApp: () => void;
  }>({
    run: () => {},
    submit: () => {},
    mutants: () => {},
    runApp: () => {},
  });
  // The phase the page is on right now. The sidebar swaps phases without
  // remounting, so anything that resumes after an await compares the phase it
  // was started for against this before it writes any state.
  const phaseIdRef = useRef(phaseId);
  phaseIdRef.current = phaseId;
  // Whether this learner has an application running right now. Held
  // in a ref so the way out can stop it without the leave effect depending on
  // the preview panel's state and being rebuilt on every poll.
  const previewLiveRef = useRef(false);
  const pendingTab = useRef<RightTab | null>(wantedTab());
  // The scroll position of the code, reported by the editor and handed back to
  // it on the next visit.
  const scrollRef = useRef(held?.scrollTop ?? 0);
  // Which phase has already been opened at its first problem. A phase being
  // returned to has been: the learner's own view of it is what to restore.
  const revealedRef = useRef(held ? viewKey : '');
  // Which phase's folded folders have been read back. Seeded once per phase,
  // then the learner's own.
  const seededTreeFor = useRef('');

  /* --------------------------- what is on screen -------------------------- */

  /**
   * The file the editor shows. The state is what the learner picked; this is
   * what the phase can honour: a pick that is not in this phase falls back to
   * the file the phase asks them to change, so the first commit of a phase
   * that has only just arrived is already showing something.
   */
  const activePath = useMemo(() => {
    if (!detail) return '';
    // A room record (the runbook, the change request) is written through forms and never opened as a file.
    const shown = detail.files.filter((f) => !isRoomRecordPath(f.path));
    const has = (path: string) => shown.some((f) => f.path === path);
    if (chosenPath && has(chosenPath)) return chosenPath;
    return (
      (requestedFile && has(requestedFile) && requestedFile) ||
      // On a split phase the file this room opens on is the selected task's
      // own, not the phase's first editable one, which is a sibling's work as
      // often as not. The question is whether the **work** was split, so a
      // quiz beside the code task leaves this room opening on the phase's
      // usual file.
      taskActivePath(isWorkSplit(tasks) ? task : undefined, shown) ||
      (detail.key === 'implementation' && has('api/routes/tasks.py') ? 'api/routes/tasks.py' : '') ||
      // The first file the brief asks to change, not its test, where both are editable.
      changeFirst(shown)[0]?.path ||
      shown[0]?.path ||
      ''
    );
  }, [detail, chosenPath, requestedFile, tasks, task]);

  /** The tab strip: what the phase opens on, then anything opened since. */
  const openPaths = useMemo(() => {
    if (!detail) return [];
    // The opening tabs never hold a room record.
    const shown = detail.files.filter((f) => !isRoomRecordPath(f.path));
    const has = (path: string) => shown.some((f) => f.path === path);
    const seeded = seedTabs(
      shown,
      detail.key,
      // `isWorkSplit`, so a quiz does not reseed the strip.
      isWorkSplit(tasks) ? taskPaths(task, shown) : undefined,
    );
    return [...seeded, ...extraPaths.filter((path) => has(path) && !seeded.includes(path))];
  }, [detail, extraPaths, tasks, task]);

  /** The phase's files, with anything the learner has typed written over them. */
  const files = useMemo(() => {
    if (!detail) return typed;
    const out: Record<string, string> = {};
    for (const f of detail.files) out[f.path] = typed[f.path] ?? f.content;
    return out;
  }, [detail, typed]);

  // The room as it stands, for the moment it is left. Written during the
  // render because this component holds one phase and one only: everything in
  // it belongs to `phaseId` and goes back under that key.
  const viewRef = useRef<WorkspaceView>({
    path: '',
    extra: [],
    cursor: caret.get(),
    scrollTop: scrollRef.current,
    tab,
    bottom,
    pane,
  });
  viewRef.current = {
    path: activePath,
    extra: extraPaths,
    // Read when the room is left, not when it last rendered (the caret moves
    // without a render).
    get cursor() {
      return caret.get();
    },
    scrollTop: scrollRef.current,
    tab,
    bottom,
    pane,
  };

  /**
   * Leaving one task for another.
   *
   * The room's memory is keyed by task, so switching puts this task's room
   * back where it was and opens the other where it was left. Without it the
   * learner would arrive in a task with the previous task's file open and the
   * previous task's caret restored into it.
   */
  const viewKeyRef = useRef(viewKey);
  useEffect(() => {
    const leaving = viewKeyRef.current;
    if (leaving === viewKey) return;
    if (viewRef.current.path) keepView(leaving, { ...viewRef.current, scrollTop: scrollRef.current });
    viewKeyRef.current = viewKey;
    const next = heldView(viewKey);
    setActivePath(next?.path ?? '');
    setExtraPaths(next?.extra ?? []);
    setCursor(next?.cursor ?? { line: 1, col: 1 });
    setPane(next?.pane ?? 'code');
    if (next?.bottom) setBottom(next.bottom);
  }, [viewKey]);

  /**
   * Pin the task the room opened on, once this phase's tasks are known.
   *
   * `chooseTask` answers *where the work is*, which is the right room to open
   * in and the wrong thing to keep re-deciding: a verdict that passes the task
   * a learner is working in would otherwise move their opening answer to the
   * next task and take the room with it, mid-session, under their hands.
   *
   * **It is asked of the phase's work, not of its rows.**
   * `chooseTask` answers *the first required task still to pass, then the
   * first task still to pass*, so a required quiz ordered first would be
   * selected before the learner had written a line, and an optional one the
   * moment the code passed, and this room's Submit would then name the quiz's
   * key and hand in a paper that was never drawn. `chooseTask` itself counts
   * quizzes, because the panel and the quiz room both need it to; this room
   * asks it about `workTasks` only. The API refuses that hand-in by name as well,
   * which is the layer no client can walk around.
   */
  useEffect(() => {
    if (selectedTask || !isSplit(tasks)) return;
    const opening = chooseTask(workTasks(tasks), null);
    if (opening) setSelectedTask(opening.key);
  }, [tasks, selectedTask]);

  /**
   * The task named in the URL, once the phase has said which tasks it has.
   *
   * Three answers, and the last two are why this is not one line. A task this
   * phase declares and can draw is opened. A **quiz** is not something this
   * room draws at all, so the learner is sent to the room that does rather than
   * left in an IDE seeded on a task with no files. A key this phase does not
   * declare (a stale link, another learner's, a phase the teacher has re-cut)
   * is said out loud and left to `chooseTask`, because silently opening some
   * other task would have them work on something they did not ask for.
   */
  const unknownTask = Boolean(asked) && Boolean(tasks?.length) && !tasks?.some((row) => row.key === asked);
  useEffect(() => {
    if (!asked || !tasks?.length) return;
    const named = tasks.find((row) => row.key === asked);
    if (!named) return;
    if (named.artefactType === 'quiz') {
      router.replace(quizHref({ id: phaseId }, named.key));
      return;
    }
    setSelectedTask((held) => (held === asked ? held : asked));
  }, [asked, tasks, phaseId, router]);

  /**
   * The learner picked a task in the panel: the room re-keys and the URL is
   * rewritten to say so, keeping whatever else was in it (`?file=`).
   *
   * `replace` rather than `push`: switching task inside one room is the same
   * act as opening a file there, and a back button that walked a learner's
   * choices one by one would not take them out of the room.
   */
  const chooseRoomTask = useCallback(
    (key: string) => {
      setSelectedTask(key);
      const next = new URLSearchParams(search.toString());
      next.set('task', key);
      router.replace(`/workspace/${phaseId}?${next}`, { scroll: false });
    },
    [phaseId, router, search],
  );

  /**
   * A workspace opened on a view its address named (`?panel=code`, `split`,
   * `evidence`, `preview` or `files`, in any code phase) takes the name out of the address once it has opened there,
   * keeping whatever else was in it (`?file=`, `?task=`). Left in, Back and a
   * reload would open that view again over the one the learner chose
   * afterwards. `?panel=runbook` is not one of these and stays.
   */
  const clearRequestedView = useCallback(() => {
    const next = new URLSearchParams(search.toString());
    next.delete('panel');
    const query = next.toString();
    router.replace(query ? `/workspace/${phaseId}?${query}` : `/workspace/${phaseId}`, { scroll: false });
  }, [phaseId, router, search]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Whichever way this page was reached, the editor's chunk is now in memory:
  // say so, so the next visit renders it in its first commit instead of behind
  // the lazy placeholder.
  useEffect(() => {
    void preloadEditor();
  }, []);

  /**
   * The way out: whatever is typed is saved, and where the learner was is kept.
   *
   * Typing is written on a seven-tenths-of-a-second debounce, so clicking the
   * sidebar straight after a keystroke would drop it: the timer's owner is
   * gone before it fires. The save is remade here as one request that does not
   * wait for an answer (there is nothing left to show it to) and is marked
   * `keepalive`, so it survives the document being torn down as well as a
   * route change. Leaving is also the moment the room is worth remembering.
   *
   * There is a third way out, and it is the one most likely to lose work: a
   * token that stops working. Any 401 ends the session and sends the browser
   * to /login, and by the time that navigation's `pagehide` arrives the token
   * is already gone, so a save sent then would go out unsigned and be thrown
   * away. So it is
   * registered as something to do *before* the session is torn down, and it
   * hands back its promise for the 401 handler to wait on.
   */
  useEffect(() => {
    const ownerId = getSession()?.id;
    const token = getToken();
    const leave = (): Promise<void> => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const pending = dirtyRef.current;
      dirtyRef.current = {};
      let written = Promise.resolve();
      if (ownerId && token && getSession()?.id === ownerId && sameSession(getToken(), token) && Object.keys(pending).length) {
        const baseVersion = versionRef.current ?? '';
        rememberVersionedWorkspaceDraft(phaseId, pending, baseVersion, ownerId);
        // A known conflict leaves only a private local draft. An ordinary exit
        // still quotes the editing base, so a previously unseen save is safe.
        if (!conflictRef.current) written = saveVersionedWorkspaceOnExit(phaseId, pending, { baseVersion, ownerId, token })
          .then(({ version }) => {
            if (getSession()?.id !== ownerId || !sameSession(getToken(), token)) return;
            acknowledgeVersionedWorkspaceSave(phaseId, pending, version, ownerId);
            const known = heldDetail(phaseId);
            if (known && (!known.workspaceUpdatedAt || Date.parse(version) >= Date.parse(known.workspaceUpdatedAt))) {
              keepDetail(phaseId, { ...withSaved(known, pending), workspaceUpdatedAt: version });
            }
          })
          .catch(() => undefined); // The versioned draft remains for explicit recovery.
      }
      const view = viewRef.current;
      if (view.path) keepView(viewKeyRef.current, { ...view, scrollTop: scrollRef.current });
      // A learner who closes the tab is not coming back to the app they left
      // running, and it holds one of very few seats. Best effort, and never
      // waited on: the session's own idle sweep is the real bound.
      if (previewLiveRef.current) stopPreviewOnExit(phaseId);
      return written;
    };
    const onPageHide = () => {
      void leave();
    };
    window.addEventListener('pagehide', onPageHide);
    const stopLeaving = onSessionLeaving(leave);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      stopLeaving();
      void leave();
    };
  }, [phaseId]);

  const reload = useCallback(async (appliedWorkspace?: Record<string, string>, ownResolve?: OwnResolve) => {
    const owner = getToken();
    const mine = () => alive.current && phaseIdRef.current === phaseId && sameSession(getToken(), owner);
    // The phase is authoritative about which project this workspace belongs
    // to: a bookmarked or shared URL can easily be for the project that is not
    // the remembered one, and reading the preference here would show the wrong
    // phase list. Fetch the phase first, then ask for its enrolment.
    const d = await workspaceApi.phase(phaseId);
    if (!mine()) return null;
    const knownVersion = heldDetail(phaseId)?.workspaceUpdatedAt;
    if (knownVersion && (!d.workspaceUpdatedAt || Date.parse(d.workspaceUpdatedAt) < Date.parse(knownVersion))) return null;
    const slug = d.projectSlug || getActiveProject();
    setActiveProject(slug);
    keepDetail(phaseId, d);
    // The stamp this tab is now working from; every save quotes it back so a
    // second tab cannot write over this one in silence.
    const incomingVersion = d.workspaceUpdatedAt ?? '';
    const retained = Object.keys(dirtyRef.current).length ? null : readVersionedWorkspaceDraft(phaseId);
    const restored = retained && Object.fromEntries(Object.entries(retained.files).filter(([path, content]) =>
      d.files.some(file => file.path === path && file.editable && file.content !== content)));
    const restoring = retained && restored && Object.keys(restored).length > 0;
    if (restoring) {
      dirtyRef.current = restored;
      liveRef.current = { ...liveRef.current, ...restored };
      setTyped(prev => ({ ...prev, ...restored }));
      versionRef.current = retained.baseVersion;
      setConflict({ paths: Object.keys(restored).sort(), version: incomingVersion, recovered: true });
      setSaving('dirty');
    } else if (retained) {
      const ownerId = getSession()?.id;
      if (ownerId) discardVersionedWorkspaceDraft(phaseId, ownerId);
    }
    const pendingPaths = Object.keys(dirtyRef.current).filter(path =>
      d.files.find(file => file.path === path)?.content !== dirtyRef.current[path]);
    if (!restoring && versionRef.current !== null && incomingVersion !== versionRef.current && pendingPaths.length) {
      // The draft was written against the earlier copy. Showing a newer GET
      // must not silently authorize overwriting it on the next debounce.
      setConflict({ paths: pendingPaths.sort(), version: incomingVersion });
      setSaving('dirty');
    } else if (!restoring) {
      versionRef.current = incomingVersion;
    }
    setFetched(d);
    setLinksState(d.links ?? []);
    setRunClockState(d.runClock ?? null);
    setDrill(d.drill ?? null);

    // The server copy wins for every file the learner has not touched since
    // their last acknowledged save: another tab may have written it. A file
    // with pending keystrokes keeps them.
    const previous = serverRef.current;
    let changedElsewhere = false;
    const nowServer: Record<string, string> = {};
    // Written by somebody else since this page last looked: another tab of the
    // learner's own, or the same account on another machine. Their copy is
    // the newer one, so it is the one this room shows.
    const takeOver = new Set<string>();
    for (const f of d.files) {
      nowServer[f.path] = f.content;
      if (dirtyRef.current[f.path] !== undefined) continue;
      if (previous[f.path] !== undefined && previous[f.path] !== f.content) {
        // The acknowledged Apply can explain these exact bytes. A different
        // saved revision still needs a notice, including during refresh retry.
        // So can this page's own resolve, for the runbook record it writes:
        // `writtenByOwnResolve` says when the record read is that
        // write and nothing else.
        if (appliedWorkspace?.[f.path] !== f.content
          && !(ownResolve && writtenByOwnResolve(f.path, previous[f.path], f.content, d.workspaceUpdatedAt, ownResolve))) changedElsewhere = true;
        takeOver.add(f.path);
      }
    }
    serverRef.current = nowServer;
    const superseded = (path: string, content: string | undefined) =>
      dirtyRef.current[path] === undefined &&
      (takeOver.has(path) || nowServer[path] === content || nowServer[path] === undefined);
    // A file the server has caught up with is no longer an edit of ours, and a
    // file another tab has moved on is no longer ours either; drop both so the
    // newer copy is visible rather than masked by what this tab typed.
    for (const [path, content] of Object.entries(liveRef.current)) {
      if (superseded(path, content)) delete liveRef.current[path];
    }
    setTyped((prev) => {
      let next = prev;
      for (const [path, content] of Object.entries(prev)) {
        if (superseded(path, content)) {
          if (next === prev) next = { ...prev };
          delete next[path];
        }
      }
      return next;
    });
    if (changedElsewhere) {
      // The save stamp, not the row stamp: `updatedAt` moves on a drill
      // step or a grading too, so it would date the sentence wrongly.
      const when = d.workspaceUpdatedAt
        ? ` at ${new Date(d.workspaceUpdatedAt).toLocaleTimeString()}`
        : '';
      setNotice(`The saved workspace changed${when}. Showing the latest saved copy.`);
    }

    let last = d.lastSubmission;
    const seen = readVerdict(phaseId);
    if (seen && last && seen.id !== last.id && String(last.createdAt) <= String(seen.createdAt)) {
      last = await api.getSubmission(seen.id).catch(() => last);
    }
    if (!mine()) return null;
    setSubmission((prev) => pickNewer(prev, last));

    // The shell's enrolment is this project's every time the learner walked
    // here, and it is already loaded; only a workspace opened outside it costs
    // a request.
    const shellHas = providerEnrollment.current;
    if (!shellHas || shellHas.projectSlug !== slug) {
      // An enrolment that will not load is read as none: the phase itself has loaded.
      const e = await api.myEnrollment(slug).catch(() => null);
      if (!mine()) return null;
      setFetchedEnrollment(e && (e as EnrollmentView).id ? (e as EnrollmentView) : null);
    }
    return d;
  }, [phaseId]);

  /*
   * `splitNow` is told, not closed over. The mount effect below depends on
   * this callback, and `split` flips from false to true after the first read
   * of a phase the shell held no detail for, so a callback over `flightKey`
   * would be a new callback on that render, the effect would run a second
   * time, and two pollers would follow one revision (the first with the stale
   * key `''`). The caller knows whether the phase is split: the
   * mount effect from the detail it has just read, a submit from the render it
   * was pressed in. `flightKey`'s formula, applied to that answer.
   */
  const watchSubmission = useCallback(
    async (started: SubmissionView, splitNow: boolean) => {
      const mine = () => alive.current && phaseIdRef.current === phaseId;
      const key = splitNow ? (started.taskKey ?? '') : '';
      markSubmitting(key, true);
      const following = started.taskKey ?? '';
      markFollowing(following, true);
      try {
        const finished = await follow(
          () => api.getSubmission(started.id),
          (last) => {
            if (!mine()) return;
            if (last) setSubmission(last);
            setNotice(STILL_RUNNING);
          },
          jobWake('submission', started.id),
        );
        rememberVerdict(phaseId, finished);
        if (!mine()) return;
        setSubmission(finished);
        setNotice('');
        setAppliedNote(false);
        invalidateProject();
        setHistoryEpoch((n) => n + 1);
        await reload();
      } catch (err) {
        if (!mine()) return;
        if (err instanceof PollTimeoutError) setNotice(GAVE_UP);
        // Never the raw fetch message. A 5xx says nothing a learner
        // can act on, so it is replaced by the sentence that fits what they
        // were doing; a 4xx still speaks for itself.
        else setError(learnerMessage(err, 'The review could not be checked on. Your submission is safe.'));
      } finally {
        if (alive.current) {
          markSubmitting(key, false);
          markFollowing(following, false);
        }
      }
    },
    [reload, phaseId, markSubmitting, markFollowing],
  );

  useEffect(() => {
    if (!getToken()) {
      {
      // The sign-in page, told where the learner was, and nothing at all when
      // the session has just ended, because `request()` is already navigating
      // there with the reason as well.
      const to = signInHref();
      if (to) router.replace(to);
    };
      return;
    }
    reload()
      .then((d) => {
        if (!d) return;
        // Without this, a reload mid-review would leave the panel frozen on
        // "reviewing…" with nothing ever coming back to update it. Pick the
        // watch back up.
        const last = d.lastSubmission;
        if (last && !settled(last) && alive.current && phaseIdRef.current === phaseId) {
          setBottom('feedback');
          void watchSubmission(last, isSplit(d.tasks));
          pendingTab.current = null;
          return;
        }
        const asked = pendingTab.current;
        pendingTab.current = null;
        if (!asked || !alive.current || phaseIdRef.current !== phaseId) return;
        setTab(asked);
        setPane('panel');
      })
      .catch((err) => {
        if (!alive.current || phaseIdRef.current !== phaseId) return;
        setError(loadFailure(err));
      });
  }, [phaseId, reload, router, watchSubmission]);

  // A tab that was in the background may be holding a copy an hour older than
  // what the other tab saved since; refetch the moment it comes back.
  useEffect(() => {
    const onVisible = () => {
      // A failed refetch keeps the copy on screen; the next return or event reads it again.
      if (document.visibilityState === 'visible') reload().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  // live updates: refresh run/submission state the moment a job completes
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onJob = (event: JobEvent) => {
      if (event.phaseStateId !== phaseId || event.status !== 'completed') return;
      // The socket only shortens the wait: a read that fails here leaves the poll to bring the result.
      if (event.type === 'run') api.getRun(event.id).then(setRun).catch(() => undefined);
      if (event.type === 'submission') {
        // As with a run: a read that fails here leaves the poll and the next reload to bring the verdict.
        api
          .getSubmission(event.id)
          .then((s) => {
            rememberVerdict(phaseId, s);
            setSubmission((prev) => pickNewer(prev, s));
          })
          .catch(() => undefined);
        invalidateProject();
        setHistoryEpoch((n) => n + 1);
        reload().catch(() => undefined);
      }
    };
    socket.on('job.update', onJob);
    return () => {
      socket.off('job.update', onJob);
    };
  }, [phaseId, reload]);

  // ⌘↵ opens or updates the pull request, ⌘⇧↵ runs, ⌘⇧M runs the planted bugs,
  // ⌘⇧A starts the learner's own application.
  // Bound in the capture phase so Monaco, which owns ⌘↵ as "insert line
  // below", never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      // Native modal dialogs make the workspace inert, but window capture
      // listeners still receive their keys. Never execute behind a dialog.
      if (workspaceShortcutBlocked(e.target)) return;
      if (e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        if (isTextField(e.target) && !e.target.closest('[data-testid="editor-host"]')) return;
        e.preventDefault();
        actions.current.mutants();
        return;
      }
      // ⌘⇧A, because it is free: ⌘K is the palette, ⌘↵ submit, ⌘⇧↵ run tests,
      // ⌘⇧M the planted bugs, ⌘O the phase document. A form's own field keeps
      // its keystroke; Monaco is the exception, as it is for ⌘↵ below.
      if (e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        if (isTextField(e.target) && !e.target.closest('[data-testid="editor-host"]')) return;
        e.preventDefault();
        actions.current.runApp();
        return;
      }
      if (e.key !== 'Enter') return;
      // A field outside the editor keeps its own ⌘↵: a phase panel's form, the
      // mentor's message box. Monaco is the exception: it binds ⌘↵ to "insert
      // line below", and running the phase has to win there.
      if (isTextField(e.target) && !e.target.closest('[data-testid="editor-host"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) actions.current.run();
      else actions.current.submit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Monaco cannot read the theme tokens, so the editor follows the THEME_EVENT
  // the toggle fires. A switch made in another tab arrives here as a `storage`
  // event instead, which the editor never hears; republish it as the event it
  // is listening for.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      const next = e.newValue;
      if (next !== 'paper' && next !== 'graphite') return;
      window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: next }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /**
   * Hand the buffer to the page: the file map, the analyzer and the panels
   * catch up with what has been typed. Called where a save is, so the page
   * moves on exactly when the work is written.
   */
  const commitTyped = useCallback(() => {
    if (!pendingText.current) return;
    pendingText.current = false;
    setTyped((f) => ({ ...f, ...liveRef.current }));
  }, []);

  const persist = useCallback(
    async (payload: Record<string, string>) => {
      const owner = getToken();
      const ownerId = getSession()?.id;
      const mine = () => alive.current && phaseIdRef.current === phaseId && sameSession(getToken(), owner);
      const baseVersion = versionRef.current;
      let acknowledgedVersion: string | undefined;
      setSaving('saving');
      try {
        const { version } = await api.saveWorkspace(
          phaseId,
          payload,
          baseVersion ?? undefined,
        );
        if (!mine()) return;
        // A refresh may already have observed a later save while this response
        // was travelling. Never move the next save's version or its time back.
        const latestVersion = heldDetail(phaseId)?.workspaceUpdatedAt ?? versionRef.current;
        if (!latestVersion || Date.parse(version) >= Date.parse(latestVersion)) {
          versionRef.current = version;
          acknowledgedVersion = version;
          setConflict(null);
        } else {
          const differing = Object.keys(payload).filter(path => serverRef.current[path] !== payload[path]);
          if (differing.length) {
            setConflict({ paths: differing.sort(), version: latestVersion });
            setSaving('dirty');
            return;
          }
        }
      } catch (err) {
        if (!mine()) return;
        setSaving('dirty');
        // 409: somebody else (another tab of this learner's, or the same
        // account on another machine) saved after this page loaded. Nothing
        // was written, and the room says so rather than claiming "Saved"
        // over a file the server does not hold.
        if (err instanceof ApiError && err.status === 409) {
          const body = (err.body ?? {}) as { version?: string };
          setConflict({ paths: Object.keys(payload).sort(), version: body.version ?? '' });
          return;
        }
        throw err;
      }
      for (const [path, content] of Object.entries(payload)) {
        if (dirtyRef.current[path] === content) delete dirtyRef.current[path];
      }
      if (ownerId) {
        acknowledgeVersionedWorkspaceSave(phaseId, payload, versionRef.current ?? '', ownerId);
      }
      const known = heldDetail(phaseId);
      if (known && acknowledgedVersion) {
        const saved = { ...withSaved(known, payload), workspaceUpdatedAt: acknowledgedVersion };
        keepDetail(phaseId, saved);
        // Keep the editor's buffer and all panes mounted; only the acknowledged
        // save metadata needs to catch up without waiting for another GET.
        setFetched((current) => mine()
          ? { ...(current ?? saved), workspaceUpdatedAt: acknowledgedVersion }
          : current);
      }
      setSaving(Object.keys(dirtyRef.current).length > 0 ? 'dirty' : 'saved');
    },
    [phaseId],
  );

  const scheduleSave = useCallback(
    (path: string, content: string) => {
      dirtyRef.current[path] = content;
      const ownerId = getSession()?.id;
      if (ownerId && readVersionedWorkspaceDraft(phaseId)) {
        rememberVersionedWorkspaceDraft(phaseId, dirtyRef.current, versionRef.current ?? '', ownerId);
      }
      setSaving('dirty');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        commitTyped();
        // A failed autosave has already marked the room unsaved and kept the edits for the next save.
        persist({ ...dirtyRef.current }).catch(() => undefined);
      }, WORKSPACE_SAVE_DELAY_MS);
    },
    [commitTyped, persist, phaseId],
  );

  /**
   * "Load the other copy": drop what this tab typed into the files that clashed
   * and take the server's, which is the newer one.
   */
  const takeTheirs = useCallback(async () => {
    const stale = conflict?.paths ?? [];
    for (const path of stale) {
      delete dirtyRef.current[path];
      delete liveRef.current[path];
    }
    setTyped((prev) => {
      const next = { ...prev };
      for (const path of stale) delete next[path];
      return next;
    });
    setConflict(null);
    const ownerId = getSession()?.id;
    if (ownerId) discardVersionedWorkspaceDraft(phaseId, ownerId);
    setSaving('idle');
    await reload().catch(() => undefined);
  }, [conflict, reload, phaseId]);

  /** "Keep mine": save again against the version the API just named. */
  const keepMine = useCallback(async () => {
    if (conflict) versionRef.current = conflict.version;
    setConflict(null);
    // A refused save marks the room unsaved (or opens a new conflict) before it rejects.
    await persist({ ...dirtyRef.current }).catch(() => undefined);
  }, [conflict, persist]);

  /** Rejects when the save fails; the pending edits stay pending. */
  const flushSave = useCallback(async () => {
    const owner = getToken();
    const mine = () => alive.current && phaseIdRef.current === phaseId && sameSession(getToken(), owner);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    commitTyped();
    if (conflictRef.current) throw new Error('Resolve the saved copy and your draft before continuing.');
    if (Object.keys(dirtyRef.current).length === 0) return;
    await persist({ ...dirtyRef.current });
    if (!mine()) throw new Error('The editing session changed. Reopen the workspace before continuing.');
    if (Object.keys(dirtyRef.current).length || conflictRef.current) {
      throw new Error('Resolve the saved copy and your draft before continuing.');
    }
  }, [commitTyped, persist, phaseId]);
  /**
   * When the assistant last readied an operation (the Apply's press among them). The editor gives way to a scroll the
   * person makes after that press and before the applied text arrives: the line is handed over with
   * this time, and the editor reveals nothing if the person scrolled the code since. Taken once: a later read-back
   * ("Retry loading") counts from its own start.
   */
  const pressedAtRef = useRef<number | null>(null);
  const readyForAgent = useCallback(() => {
    pressedAtRef.current = Date.now();
    return flushSave();
  }, [flushSave]);
  const refreshApplied = useCallback(async (appliedWorkspace?: Record<string, string>) => {
    const shown = shownRef.current;
    const since = pressedAtRef.current ?? Date.now();
    pressedAtRef.current = null;
    const fresh = await reload(appliedWorkspace);
    if (!fresh) return;
    if (!alive.current || phaseIdRef.current !== phaseId) return;
    // The lines this Apply changed in the open file, first to last, for the editor to show once.
    const reveal = appliedReveal(shown, fresh.files, dirtyRef.current);
    setRevealApplied(reveal ? { ...reveal, nonce: Date.now(), since } : null);
    setEditedSinceVerdict(true);
    setSaving('saved');
    // Every room announces an applied proposal the same way (the design room's words), once the
    // applied files are read back, in the centre column as the design room does (`appliedNote`); the mentor keeps
    // its own receipt beside it. A run or a submission clears it, as it clears every notice here.
    setAppliedNote(true);
  }, [phaseId, reload]);
  const agentBusy = useAgentWorkspace(phaseId, readyForAgent, refreshApplied);

  /**
   * The learner started this task over. The control has
   * already flushed the buffer, so nothing typed is dropped here: the reset's
   * paths leave the buffer, the local draft and the changed dots, the version
   * the reset answered is the one every later save quotes, and the phase is
   * read again so the editor shows the starter and the task list its new run.
   */
  const adoptReset = useCallback(async (version: string, paths: readonly string[]) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    for (const path of paths) {
      delete dirtyRef.current[path];
      delete liveRef.current[path];
      delete serverRef.current[path];
      touchedRef.current.delete(path);
    }
    setTyped((prev) => {
      const next = { ...prev };
      for (const path of paths) delete next[path];
      return next;
    });
    setModifiedPaths((prev) => new Set([...prev].filter((path) => !paths.includes(path))));
    const ownerId = getSession()?.id;
    if (ownerId) discardVersionedWorkspaceDraft(phaseId, ownerId);
    const before = versionRef.current;
    versionRef.current = version;
    setConflict(null);
    // The starter files are not the reviewed proposal: the applied note goes with the reset.
    setAppliedNote(false);
    setSaving('idle');
    setEditedSinceVerdict(true);
    invalidateProject();
    await reload().catch(() => {
      // The screen still holds the words the reset replaced. Quoting the
      // version before the reset makes any save of them the API's 409, so
      // the room compares instead of writing them over the starter.
      if (versionRef.current === version) versionRef.current = before;
    });
  }, [phaseId, reload]);

  useEffect(() => {
    if (detail?.key === 'implementation' && tab === 'preview') { setTab('mentor'); setPane('code'); }
  }, [detail?.key, tab]);

  const phasePanel = detail && detail.id === phaseId ? PHASE_PANELS[detail.key] : undefined;
  const hasPanel = Boolean(phasePanel?.Brief || phasePanel?.Tools);

  // The phase's history (its verdicts, its runs and the reviewer's thread)
  // is one record, cached for the session and shared with the journal and the
  // reviewer's column, so coming back to a phase costs nothing and a submission
  // that dropped the cache costs one round of three.
  useEffect(() => {
    if (!hasPanel) return;
    let stale = false;
    const apply = (list: SubmissionView[], log: ExecutionRunView[]) => {
      if (stale || !alive.current || phaseIdRef.current !== phaseId) return;
      setSubmissions(list);
      setRuns(log);
      // Coming back to a phase, the Tests tab and the terminal should show
      // the run that already happened rather than "nothing has been run in
      // this browser": the sandbox kept it, so the page shows it.
      setRun((prev) => {
        if (prev) return prev;
        const done = [...log].reverse().find((x) => x.status === 'completed' || x.status === 'failed');
        return done ?? prev;
      });
    };
    const known = cachedRecords([phaseId])[phaseId];
    if (known) {
      apply(known.submissions, known.runs);
      // A verdict marks this copy stale and starts its refresh before this
      // runs (invalidateProject), and a verdict arrives twice, by the socket
      // and by the poll. When the second arrives before the first one's
      // refresh has landed, the copy drawn above is still the list from
      // before the revision; with nothing following the refresh the room kept
      // it, and the Commit tab's count, the review history and the health
      // trend stayed one revision behind. So a refresh in the air is followed
      // to its answer. Nothing is asked for here: with none in the air the
      // copy is the newest there is.
      const refresh = refreshingRecords(phaseId);
      if (!refresh) return;
      refresh
        .then(({ records, partial }) => {
          // A read that lost one of its three leaves the room what it holds.
          if (!partial) apply(records.submissions, records.runs);
        })
        .catch(() => undefined);
      return () => {
        stale = true;
      };
    }
    // With the phase's tasks in hand the revisions are read one task
    // at a time, because the phase-wide route is refused on a split phase.
    // History that will not load leaves the room with the runs and review it already holds.
    loadRecords(phaseId, { tasks: detail?.tasks })
      .then(({ records }) => apply(records.submissions, records.runs))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // `taskScope` rather than the list itself: the scope of the read is the
    // task keys, and a fresh array of the same tasks (which is what a phase
    // refreshed behind the page hands over) must not send the three requests
    // again.
  }, [phaseId, hasPanel, historyEpoch, taskScope]);

  /**
   * The revisions the room is about: the selected task's, where a teacher has
   * split the phase.
   *
   * The commit count, the health panel and the review history are all this one
   * list, and a sibling task's verdicts in them would say a learner had tried
   * this piece of work more often than they have, and would put another task's
   * feedback under this task's editor. A phase with one task uses the whole
   * list.
   */
  const taskSubmissions = useMemo(
    () => (submitKey ? submissions.filter((row) => row.taskKey === submitKey) : submissions),
    [submissions, submitKey],
  );

  const reloadPhase = useCallback(async () => {
    await reload();
  }, [reload]);

  /** Saves first: the props keep the old set when the write fails. */
  const saveLinks = useCallback(
    async (next: PhaseLink[]) => {
      await api.saveLinks(phaseId, next);
      if (!alive.current || phaseIdRef.current !== phaseId) return;
      setLinksState(next);
    },
    [phaseId],
  );

  /**
   * Saves first: the props keep the old value when the write fails, exactly as
   * the links do. Pinning the clock spends no attempt and invalidates no
   * verdict: it is a parameter of the next run, not an event.
   */
  const setRunClock = useCallback(
    async (date: string | null) => {
      const saved = await api.setClock(phaseId, date);
      if (!alive.current || phaseIdRef.current !== phaseId) return;
      setRunClockState(saved.runClock);
    },
    [phaseId],
  );

  const drillApi = useMemo<DrillApi>(
    () => ({
      start: async () => {
        const state = await api.drillStart(phaseId);
        if (alive.current && phaseIdRef.current === phaseId) setDrill(state);
        return state;
      },
      health: async () => {
        const result = await api.drillHealth(phaseId);
        await reload().catch(() => undefined);
        return result;
      },
      // The drill writes the record's incident and a new save stamp, so the
      // phase is reloaded after it answers: the resolve answers its own new
      // save stamp, so the next autosave quotes it, as `health` does. The
      // reload is told what the resolve answered, so the record it wrote is
      // taken up as this page's own write, not as a change from elsewhere.
      resolve: async (incident) => {
        let answered: OwnResolve | undefined;
        return resolveAndReload(async () => {
          const state = await api.drillResolve(phaseId, incident);
          answered = { version: state.workspaceUpdatedAt, incident };
          if (alive.current && phaseIdRef.current === phaseId) setDrill(state);
          return state;
        }, () => reload(undefined, answered));
      },
    }),
    [phaseId, reload],
  );

  // The path the editor is showing, readable from a callback that was bound a
  // render ago. Monaco fires a change for the incoming file when it swaps
  // models, and a callback still holding the outgoing path would write one
  // file's text into the other.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  const onEdit = useCallback(
    (path: string, content: string) => {
      // Monaco swaps models when the active tab changes, and that fires onChange
      // for the incoming file: `readOnly` stops keystrokes, not this. A room
      // record is never an editor model (`openFile` refuses it): its writes
      // come from its forms (Deployment's Runbook tab), so it is let through.
      if (path !== activePathRef.current && !isRoomRecordPath(path)) return;
      if (!detail?.files.find((f) => f.path === path)?.editable) return;
      if (!touchedRef.current.has(path)) {
        touchedRef.current.add(path);
        setModifiedPaths((m) => new Set(m).add(path));
      }
      setEditedSinceVerdict(true);
      liveRef.current[path] = content;
      pendingText.current = true;
      // A keystroke before the applied line was shown: the editor is the learner's from here.
      if (revealAppliedRef.current) setRevealApplied(null);
      scheduleSave(path, content);
    },
    [detail, scheduleSave],
  );

  const doRun = async () => {
    // Every way in (the header, ⌘⇧↵, the palette) ends here for a phase in an older form.
    if (olderRoom) return;
    const mine = () => alive.current && phaseIdRef.current === phaseId;
    setRunning(true);
    // The last run's verdict is not the answer to this press, and on a busy
    // queue it would stand for half a minute with its own stamp on it. It
    // goes on the same frame as the press; the run the
    // API hands back replaces it a moment later, queued, and the pane says so
    // until the sandbox picks it up.
    setRun(null);
    setBottom('tests');
    setPane('code');
    setError('');
    setNotice('');
    setAppliedNote(false);
    try {
      // Grading the server's stale copy while the editor shows newer text is
      // worse than not running at all, so an unsaved workspace stops here.
      try {
        await flushSave();
      } catch {
        setError(SAVE_FAILED_RUN);
        return;
      }
      const started = await api.run(phaseId);
      if (!mine()) return;
      setRun(started);
      const finished = await follow(
        () => api.getRun(started.id),
        (last) => {
          if (!mine()) return;
          if (last) setRun(last);
          setNotice(STILL_RUNNING);
        },
        jobWake('run', started.id),
      );
      if (!mine()) return;
      setRun(finished);
      setNotice('');
      setAppliedNote(false);
      // The run log this phase's records hold is now a run short; drop it so
      // the journal and Home ask again rather than showing yesterday's list.
      refreshPhaseRecords(phaseId);
    } catch (err) {
      if (!mine()) return;
      if (err instanceof PollTimeoutError) setNotice(GAVE_UP);
      else setError(learnerMessage(err, 'The run could not be checked on. Your work is saved.'));
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  /**
   * This room's task passed its review and waits on the teacher's
   * countersignature. Nothing is handed in while it
   * does (the header control, ⌘↵, the palette and the planted bugs all end
   * here) because a failed resubmit clears the task's place in the sign-off
   * queue. After the countersignature the task is `passed` and this is false.
   */
  const taskAwaiting = awaitingSignOff(detail, task?.key, submission);
  /**
   * A newer revision of this room's task is still queued or being reviewed,
   * whether this room is following it
   * or not (the watch gave up, another tab handed it in). The API holds one in
   * flight per task, so nothing is handed in until its verdict is in, by the
   * same four ways in. Read against the phase's own newest revision, so a copy
   * this room kept from before a verdict never holds Submit off.
   */
  const revisionPending = revisionInFlight(submission, task?.key, detail?.lastSubmission ?? null);
  /**
   * A phase its pinned version holds in an older form, which the API refuses
   * to run or grade: a Deployment or Maintenance with no
   * record, or a written phase under a retired key. `ArtifactKind` holds no
   * `'markdown'`, so the retired written kind is read as the string a
   * stored older version still sends. Check and Submit are off with its
   * sentence, and the room draws it.
   */
  const olderRoom = detail
    ? olderRecordSentence(detail) ??
      ((detail.artifactKind as string) === 'markdown' && detail.key !== 'requirements' && detail.key !== 'design' ? RETIRED_WRITTEN_PHASE_ROOM : null)
    : null;
  /** Why Submit is off: an older form, else the countersignature, else a revision in flight; nothing while it is on. */
  const submitOff = olderRoom ?? submitOffReason(taskAwaiting, revisionPending);
  const doSubmit = async (focus: string = 'feedback') => {
    if (submitOff) return;
    // Which task this revision answers, and the slot it is held in while it
    // grades. Both are nothing at all on a phase with one task.
    const key = flightKey(submitKey);
    markSubmitting(key, true);
    setBottom(focus);
    setPane('code');
    setError('');
    setNotice('');
    setAppliedNote(false);
    try {
      await flushSave();
    } catch {
      setError(SAVE_FAILED_SUBMIT);
      markSubmitting(key, false);
      return;
    }
    let started: SubmissionView;
    // What the learner said this revision changes. Read here rather than held
    // by the Commit tab: the field is one of three ways to submit, and the
    // other two (⌘↵ and the header button) must send the same words.
    const message = commitDraft(phaseId).trim();
    try {
      started = await api.submit(...submitArgs(phaseId, message || undefined, tasks, selectedTask));
    } catch (err) {
      // A message the API refuses lands in the same notice every other refusal
      // does, and nothing was submitted, so the words stay in the field.
      setError(learnerMessage(err, 'This could not be submitted. Your work is saved; try again in a moment.'));
      markSubmitting(key, false);
      return;
    }
    // Recorded on the revision now. A failed enqueue never reaches this line,
    // so a submission that did not happen keeps what the learner typed.
    clearCommitDraft(phaseId);
    // A submitted runbook carries no "changed by the assistant" marks (they last until the field is edited or submitted).
    clearRunbookTouched(phaseId);
    // A submitted change request is the learner's own: the assistant's marks end here, as at the change room's Submit.
    if (detail?.key === 'maintenance') clearChangeTouched(phaseId);
    setSubmission(started);
    // The revision now being graded is the buffer as it stands, so the health
    // that comes back describes these very lines.
    setEditedSinceVerdict(false);
    await watchSubmission(started, split);
  };

  /**
   * What this room settles before it hands the learner on.
   *
   * The reflection, the advance and the next phase's door belong to
   * `PhaseGateBanner`, which every room of a passed phase mounts.
   * What is left is this room's own business: the unsaved buffer.
   */
  const beforeContinue = async () => {
    // The next phase may read this one's files; leaving with edits unsaved
    // would silently hand it the older copy.
    try {
      await flushSave();
    } catch {
      throw new Error(SAVE_FAILED_ADVANCE);
    }
  };

  /**
   * And what it settles once the learner has been handed on.
   *
   * Merging changes this phase and opens the next one, so the copies this
   * module is holding of both are no longer what the server would say. This
   * runs after the advance, never in the guard above: the guard runs before
   * the reflection and the advance, a read taken in that window would refill
   * the cache with the phase as it still was, and nothing would be left to
   * clear it.
   */
  const afterContinue = () => {
    DETAILS.clear();
  };

  /**
   * The learner's own application.
   *
   * The hook lives here rather than in the body because everything that
   * touches it does: Run app, ⌘⇧A, and the way out of the workspace. The body
   * is unmounted every time the phase detail is missing, and a preview that
   * stopped itself because the learner's connection dropped for a second would
   * be a worse bug than the one it fixes.
   */
  const preview = usePreview({
    phaseId,
    canPreview: previewOffered(detail),
    unsupported: detail?.previewUnsupported ?? null,
  });
  previewLiveRef.current = preview.status === 'starting' || preview.status === 'ready';
  // `?tab=preview` on a phase with no application, or a phase swapped under a
  // learner who was on the tab: the room is remembered per phase, and a
  // remembered tab that this phase does not have would draw a blank column.
  useEffect(() => {
    // A room with the page preview keeps the tab too.
    if (!detail || previewSurface(detail) !== 'none') return;
    setTab((t) => (t === 'preview' ? 'brief' : t));
    setPane((x) => (x === 'preview' ? 'panel' : x));
  }, [detail]);

  /**
   * Build the front end and start the API, and show what was started.
   *
   * The sibling of `doRun`, with two differences that are the whole point of
   * it: it saves first, because the runner builds the *server's* copy of the
   * workspace and previewing the code the learner had a moment ago would be
   * worse than not previewing at all; and it does not call
   * `invalidateProject()`, because a preview changes no graded state: no
   * score, no attempt, no verdict.
   */
  const doRunApp = async () => {
    if (!detail || !previewOffered(detail) || detail.previewUnsupported) return;
    // The preview is drawn in the CENTRE column in every room that has one:
    // its own pane under the editor in implementation, the third working view
    // elsewhere. The right column has no preview surface, so the pane stays
    // on the code column and `tab` is only the signal the body below follows.
    setTab(detail.key === 'implementation' ? 'mentor' : 'preview');
    setPane('code');
    setError('');
    setRunAppPressed(true);
    try {
      try {
        await flushSave();
      } catch {
        setError(SAVE_FAILED_RUN_APP);
        return;
      }
      await preview.start();
    } finally {
      if (alive.current) setRunAppPressed(false);
    }
  };

  const busy = running || submitting;
  // The four long operations, as handles that keep their identity. The
  // functions themselves are rebuilt on every render (they close over the
  // state they read), so a panel or a column given them directly would be
  // rebuilt with them.
  const doRef = useRef({ run: doRun, submit: doSubmit, beforeContinue, afterContinue, runApp: doRunApp });
  doRef.current = { run: doRun, submit: doSubmit, beforeContinue, afterContinue, runApp: doRunApp };
  const runNow = useCallback(() => {
    void doRef.current.run();
  }, []);
  const submitNow = useCallback((focus?: string) => {
    void doRef.current.submit(focus);
  }, []);
  const runAppNow = useCallback(() => {
    void doRef.current.runApp();
  }, []);
  const beforeContinueNow = useCallback(() => doRef.current.beforeContinue(), []);
  const afterContinueNow = useCallback(() => doRef.current.afterContinue(), []);
  const canRun = Boolean(detail?.canRun);
  const canPreview = previewOffered(detail);
  // The tab is still drawn on a deployment that cannot preview: it is where
  // the learner is told why, but there is nothing to press.
  const canRunApp = canPreview && !detail?.previewUnsupported;
  useEffect(() => {
    actions.current = {
      run: () => {
        if (canRun && !busy && !showReflection) void doRun();
      },
      submit: () => {
        if (!busy && !showReflection) void doSubmit();
      },
      mutants: () => {
        if (!busy && !showReflection) void doSubmit('bugs');
      },
      runApp: () => {
        if (canRunApp && !busy && !showReflection) void doRunApp();
      },
    };
  });

  const openFile = useCallback((path: string) => {
    // A room record is written through its forms, never in the editor.
    if (isRoomRecordPath(path)) return;
    setActivePath(path);
    setExtraPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setPane('code');
  }, []);

  const openAt = useCallback(
    (path: string, line: number) => {
      openFile(path);
      setFocusLine({ line, nonce: Date.now() });
    },
    [openFile],
  );

  const activeFile = useMemo(
    () => detail?.files.find((f) => f.path === activePath),
    [detail, activePath],
  );

  /** Where the learner left this very file, if this is the file they left on. */
  const restore = useMemo(
    () =>
      held && held.path === activePath
        ? { line: held.cursor.line, col: held.cursor.col, scrollTop: held.scrollTop }
        : null,
    [held, activePath],
  );
  const onEditorScroll = useCallback((top: number) => {
    scrollRef.current = top;
  }, []);
  const activeText = activeFile ? (files[activeFile.path] ?? activeFile.content) : '';
  /**
   * What Monaco is given. `activeText` is the committed copy, which lags the
   * buffer by one autosave; the editor must never be handed a value older than
   * the one it is showing, because @monaco-editor/react replaces the whole
   * model when the value it is given differs from the text in it.
   */
  const editorText = activeFile ? (liveRef.current[activeFile.path] ?? activeText) : '';
  shownRef.current = activeFile ? { path: activeFile.path, text: editorText } : null;
  // An applied line waits for its own file: opening another file first drops it, so it never shows later.
  const revealHere = revealApplied && activeFile && revealApplied.path === activeFile.path ? revealApplied : null;
  useEffect(() => {
    if (revealApplied && revealApplied.path !== activePath) setRevealApplied(null);
  }, [revealApplied, activePath]);
  const report = submission?.report ?? null;

  /* ------------------------------- derivations ------------------------------ */

  const analyzerFns = report?.staticAnalysis?.functions ?? NO_ANALYZER_FNS;
  const spans = useMemo<FnSpan[]>(
    () => (activeFile ? functionsIn(activeFile.path, activeText, analyzerFns) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFile?.path, activeText, analyzerFns],
  );
  // The function the map is drawn around: the one the caret is in, and before
  // the caret has been anywhere, the one that has something to say.
  const focusedFn = useMemo(() => {
    const at = fnAt(spans, cursorLine);
    if (at) return at;
    const named = new Set((report?.contract ?? []).map((c) => c.name));
    return spans.find((s) => named.has(s.name)) ?? spans[0] ?? null;
  }, [spans, cursorLine, report]);

  const editable = useCallback(
    (path: string) => Boolean(detail?.files.find((f) => f.path === path)?.editable),
    [detail],
  );
  const allSpans = useMemo<FnSpan[]>(() => {
    if (!detail) return [];
    if (analyzerFns.length > 0) {
      return analyzerFns.map((f) => ({
        name: f.name,
        qualname: f.qualname,
        path: f.path,
        line: f.line,
        endLine: f.endLine,
      }));
    }
    return spans;
  }, [detail, analyzerFns, spans]);

  const problems = useMemo<Problem[]>(
    () => buildProblems(report, allSpans, editable),
    [report, allSpans, editable],
  );

  /**
   * The IDE opens where the work is. Monaco only draws a view zone that is on
   * screen, so a note about line 65 does not exist until line 65 does: without
   * this the first thing a learner sees is the top of the file and an empty
   * gutter, while the verdict's notes sit below the fold. Fires once per phase,
   * and never once the learner has typed: their caret is theirs.
   */
  useEffect(() => {
    if (!detail || revealedRef.current === viewKey) return;
    if (touchedRef.current.size > 0) return;
    const first = problems.find((p) => p.path === activePath);
    const initialGap = detail.key === 'implementation' && activePath === 'api/routes/tasks.py'
      ? (detail.files.find(file => file.path === activePath)?.content.split('\n').findIndex(line => /^def complete_task\b/.test(line)) ?? -1) + 1
      : 0;
    if (!first && !initialGap) return;
    revealedRef.current = viewKey;
    setFocusLine({ line: first?.line ?? initialGap, nonce: Date.now(), quiet: true });
  }, [detail, problems, activePath, viewKey]);

  // The explorer never lists a room record (the runbook, the change request): it is written through forms.
  const explorerFiles = useMemo(() => (detail ? detail.files.filter((f) => !isRoomRecordPath(f.path)) : []), [detail]);

  // A phase's folders start folded where there is nothing to write, and stay
  // however the learner last left them.
  useEffect(() => {
    if (!detail || seededTreeFor.current === viewKey) return;
    seededTreeFor.current = viewKey;
    const kept = typeof window === 'undefined' ? null : readCollapsed(viewKey);
    setCollapsed(new Set(kept ?? [...defaultCollapsed(explorerFiles)]));
  }, [detail, explorerFiles, viewKey]);

  const collapsedRef = useRef<ReadonlySet<string> | null>(null);
  collapsedRef.current = collapsed;
  const toggleFolder = useCallback((path: string) => {
    const next = new Set(collapsedRef.current ?? []);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
    keepCollapsed(viewKeyRef.current, next);
  }, []);

  const tree = useMemo(
    () =>
      detail
        ? buildTree(explorerFiles, {
            activePath,
            modified: (path) =>
              modifiedPaths.has(path) ||
              Boolean(
                editable(path) &&
                  detail.workspaceUpdatedAt &&
                  submission &&
                  String(detail.workspaceUpdatedAt) > String(submission.createdAt),
              ),
            onOpen: openFile,
            // Before the seed lands the phase's own default is the honest
            // answer; every folder open for a frame is a wall that flickers.
            collapsed: collapsed ?? defaultCollapsed(explorerFiles),
            onToggle: toggleFolder,
          })
        : [],
    [detail, explorerFiles, activePath, modifiedPaths, submission, editable, openFile, collapsed, toggleFolder],
  );

  const isTesting = detail?.key === 'testing';
  // A panel asks for one of four tabs. Three of them are here: the
  // reviewer, the run, the verdict, and the fourth, the panel's own tools,
  // is a page of its own.
  const panelSetTab = useCallback(
    (t: string) => {
      if (t === 'phase') {
        if (detail) router.push(phaseDocHref(detail));
        return;
      }
      if (t === 'tests' || t === 'feedback') {
        setBottom(t);
        return;
      }
      setTab('mentor');
    },
    [detail, router],
  );
  const loadSubmission = useCallback((id: string) => api.getSubmissionWithFiles(id), []);
  // The testing derivations are the panel's own; the IDE moves them, it does
  // not repeat them.
  //
  // Memoised: every panel, and `useTesting` behind them,
  // is rebuilt when this object is, so it must change when the phase does and
  // not when the caret moves.
  const panelProps: PhasePanelProps | null = useMemo(
    () =>
      detail
        ? {
            detail,
            files,
            setFile: onEdit,
            activePath,
            submission,
            run,
            enrollment,
            theme,
            links,
            setLinks: saveLinks,
            runClock,
            setRunClock,
            submissions: taskSubmissions,
            runs,
            drill,
            drillApi,
            reloadPhase,
            initialView: requestedView ?? undefined,
            // The marks an applied runbook proposal left, each only while its field still holds the assistant's text.
            assisted: detail.runbook
              ? liveRunbookMarks(readRunbookTouched(phaseId), files[RUNBOOK_JSON] ?? detail.files.find((f) => f.path === RUNBOOK_JSON)?.content ?? '')
              : undefined,
            helpers: {
              runNow,
              submitNow,
              flushSave,
              openFile,
              // A record's forms read the newest typed text, so forms drawn again
              // within the autosave window start from it, never from an older copy.
              fileText: (path) =>
                (isRoomRecordPath(path) ? liveRef.current[path] : undefined) ?? files[path] ?? detail.files.find((f) => f.path === path)?.content ?? '',
              loadSubmission,
              setPane,
              setTab: panelSetTab as PhasePanelProps['helpers']['setTab'],
              setNotice,
              setError,
              busy,
              saving,
              agentBusy,
            },
          }
        : null,
    [
      detail,
      files,
      onEdit,
      activePath,
      submission,
      run,
      enrollment,
      theme,
      links,
      saveLinks,
      runClock,
      setRunClock,
      taskSubmissions,
      runs,
      drill,
      drillApi,
      reloadPhase,
      requestedView,
      phaseId,
      runNow,
      submitNow,
      flushSave,
      openFile,
      loadSubmission,
      panelSetTab,
      busy,
      agentBusy,
      // `saving` is deliberately not a dependency. It
      // moves idle -> dirty -> saving -> saved around every keystroke, and no
      // panel reads it: `helpers.busy` is what the testing tools disable
      // themselves on, and every panel that shows a save state holds its own.
      // Rebuilding six panels four times a keystroke for a field nobody draws
      // would be most of the room's render cost. If a panel ever reads it,
      // add it here.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
  );

  // A room whose phase never landed finishes opening itself when the server
  // answers again: nothing pressed. `locked` is not a
  // failure, so it is left alone.
  useRecoverWhenBack(Boolean(error) && !detail && !/locked/i.test(error), () => {
    setError('');
    void reload().catch(() => undefined);
  });

  if (!detail || !panelProps) {
    return (
      <WorkspaceFrame
        phase={enrollment?.phases.find((p) => p.id === phaseId)}
        projectTitle={enrollment ? projectName(enrollment.projectTitle) : undefined}
        error={error}
        onRetry={() => {
          setError('');
          void reload().catch(() => undefined);
        }}
      />
    );
  }

  return (
    <WorkspaceBody
      agentBusy={agentBusy}
      requestedView={requestedView}
      onViewOpened={clearRequestedView}
      detail={detail}
      error={error}
      notice={notice}
      appliedNote={appliedNote}
      panelProps={panelProps}
      isTesting={Boolean(isTesting)}
      enrollment={enrollment}
      analytics={analytics}
      activeFile={activeFile}
      activeText={activeText}
      editorText={editorText}
      files={files}
      // What the editor shows now (keystrokes reach files at the autosave):
      // read only when the page preview's Open in a new tab is pressed.
      liveFiles={() => {
        const out = { ...files };
        for (const path of Object.keys(out)) if (liveRef.current[path] !== undefined) out[path] = liveRef.current[path];
        return out;
      }}
      activePath={activePath}
      setActivePath={setActivePath}
      openPaths={openPaths}
      tree={tree}
      problems={problems}
      spans={spans}
      allSpans={allSpans}
      focusedFn={focusedFn}
      report={report}
      submission={submission}
      followingKeys={followingKeys}
      run={run}
      runs={runs}
      links={links}
      saveLinks={saveLinks}
      runClock={runClock}
      caret={caret}
      setCursor={setCursor}
      focusLine={focusLine}
      restore={restore}
      revealApplied={revealHere}
      onRevealedApplied={dropRevealApplied}
      onEditorScroll={onEditorScroll}
      openAt={openAt}
      onEdit={onEdit}
      saving={saving}
      conflict={conflict}
      takeTheirs={takeTheirs}
      keepMine={keepMine}
      editedSinceVerdict={editedSinceVerdict}
      running={running}
      submitting={submitting}
      busy={busy}
      taskAwaiting={taskAwaiting}
      roomTask={task}
      heldDetails={details}
      submitOff={submitOff}
      olderRoom={olderRoom}
      selectedTask={selectedTask}
      setSelectedTask={chooseRoomTask}
      // A door out of this room flushes the buffer before it opens, exactly as
      // Continue does, and `unknownTask` is a `?task=` this phase never
      // declared: said out loud rather than quietly opening another task.
      onLeaveRoom={flushSave}
      // "Start this task over", for the task this room is working in, where
      // this room is the one that task is worked in, or "Retry this task" /
      // "Retry this phase" once it has passed. Never on a quiz or a task a
      // teacher is reviewing, and a start-over never on TaskTrackr (the
      // control decides). Keyed by the task, so what it last said ("Task
      // started over", on the header row and in More) clears on a switch to
      // another task of this room.
      resetControl={
        task && taskRoomHref(detail, detail.tasks, task).split('?')[0] === `/workspace/${detail.id}` ? (
          <TaskResetControl
            key={task.key}
            phaseId={detail.id}
            tasks={detail.tasks}
            task={task}
            phaseStatus={detail.status}
            prepare={flushSave}
            baseVersion={() => versionRef.current}
            onReset={(result, plan) => adoptReset(result.version, [...plan.restores, ...plan.reseeds])}
            onConflict={() => reload().then(() => undefined, () => undefined)}
          />
        ) : null
      }
      unknownTask={unknownTask}
      doRun={runNow}
      doRunApp={runAppNow}
      preview={preview}
      runAppPressed={runAppPressed}
      doSubmit={submitNow}
      onBeforeContinue={beforeContinueNow}
      onAdvanced={afterContinueNow}
      tab={tab}
      setTab={setTab}
      bottom={bottom}
      setBottom={setBottom}
      pane={pane}
      setPane={setPane}
      showReflection={showReflection}
      setShowReflection={setShowReflection}
      setNotice={setNotice}
      setError={setError}
    />
  );
}
