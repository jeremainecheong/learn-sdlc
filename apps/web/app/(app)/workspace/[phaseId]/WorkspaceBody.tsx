/**
 * The workspace room's half that draws: the header row, the brief, the
 * explorer and file strip, the editor and its results, the mentor column and
 * the status bar. The page's other half loads the phase, saves, runs and
 * submits, and hands everything it holds down as props.
 */
import Link from 'next/link';
import { ImplementationTaskPanel } from '@/components/workspace/ImplementationTaskPanel';
import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { MissionDetails } from '@/components/phases/Brief';
import { runsReferenceApplication } from '@/components/workspace/application';
import {
  useWorkspacePanels,
  WorkspacePanelControls,
  WorkspaceMentorBoundary,
} from '@/components/workspace/WorkspacePanels';
import type { AppliedReveal } from '@/components/workspace/applied-reveal';
import { recordInWords } from '@/components/workspace/mentor/recordFieldLabel';
import { isRoomRecordPath } from '@/components/workspace/records';
import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type {
  EnrollmentView,
  ExecutionRunView,
  FeedbackReport,
  LearnerAnalytics,
  PhaseDetail,
  PhaseKey,
  PhaseLink,
  PhaseTaskView,
  SubmissionView,
  WorkspaceFile,
} from '@learnsdlc/shared';
import { holdsPhase, isLastPhase, placeLabel } from '@learnsdlc/shared';
import { phaseSubmitLabel } from '@/components/workspace/HeaderSubmit';
import { API_URL } from '@/lib/api';
import { useCommitDraft } from '@/lib/commit';
import { shortcutWord } from '@/lib/keys';
import { useSocketPaused } from '@/lib/socket';
import { useFocusPanels } from '@/components/workspace/useFocusPanels';
import { useScrollKeeper } from '@/components/workspace/useScrollKeeper';
import { revealTabInStrip, useArrivalReveal } from '@/lib/room-arrival';
import { lessonsOfferedOn, roomIsReference } from '@/lib/scenario';
import { roomResultsHeight, useResultsSplit } from '@/components/workspace/useResultsSplit';
import { scrollFocusRef } from '@/lib/scroll-focus';
import { MentorSession } from '@/components/shell/PersonaPanel';
import { Icon } from '@/components/Icon';
import { PlainText } from '@/components/PlainText';
import { ConsolePane } from '@/components/workspace/ConsolePane';
import { PreviewPanel } from '@/components/workspace/preview/PreviewPanel';
import type { PreviewController } from '@/components/workspace/usePreview';
import { initialImplementationView } from '@/components/workspace/implementation-view';
import {
  ActivityBar,
  BottomPanel,
  Explorer,
  usePersona,
  StatusBar,
  WorkPage,
  briefHref,
  phaseDocHref,
  phaseDocLabel,
  type BottomTab,
  type ExplorerNode,
} from '@/components/shell';
import { PERSONA_NAME } from '@/lib/phase';
import { opensChangeRoom, solutionHref } from '@/components/shell/routes';
import {
  Button,
  CellTitle,
  Chip,
  Notice,
  SectionHead,
  StatusSquare,
  Steps,
  Table,
  useEdgeFade,
  useTabs,
} from '@/components/ui';
import { TechMark, techForPath } from '@/components/TechMark';
import type { EditorMarker, EditorNote } from '@/components/workspace/CodeEditor';
import { CommitField } from '@/components/workspace/CommitField';
import { HealthPanel } from '@/components/workspace/HealthPanel';
import { healthFindings } from '@/components/workspace/ide/health';
import { ExplainTestButton } from '@/components/workspace/ExplainTest';
import { RunPanel } from '@/components/workspace/RunPanel';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { PhaseGateBanner, ReviewBand } from '@/components/workspace/PhaseGateBanner';
import { PhaseHeader } from '@/components/workspace/PhaseHeader';
import { solutionDoorOpen } from '@/components/solution/door';
import { useClaimedQuickCheck } from '@/components/workspace/QuickCheck';
import { isCredited, learnerState, phasePlace } from '@/components/workspace/gate-state';
import { appPreviewPaneOf, previewMode, previewSurface, previewViewLabel } from '@/components/workspace/preview/rooms';
import { AREA_REVIEW_LABEL, AREA_VIEW_PARAM, WORKING_AREA_LABELS } from '@/components/workspace/AreaNav';
import { AREA_ROW_STATUS, AreaRowCompact, useAreaRowFit } from '@/components/workspace/area-row-fit';
import { ClientPagePreview } from '@/components/workspace/preview/client/ClientPagePreview';
import { TaskPanel, chooseTask, isSplit, phaseRoomTaskKey } from '@/components/workspace/TaskPanel';
import { loadedEditor } from '@/components/workspace/preload';
import { gradingPassLine } from '@/components/workspace/onward-copy';
import { useCaret, type Caret, type CaretStore } from '@/components/workspace/caret-store';
import { PHASE_PANELS } from '@/components/workspace/panels';
import type { PhasePanelProps } from '@/components/workspace/panels/types';
import { useTesting } from '@/components/workspace/panels/testing/useTesting';
import { PLANTED_BUGS_EMPTY } from '@/components/workspace/panels/testing/Matrix';
import {
  bugsAliveText,
  clockWords,
  failingFirstWords,
  nextLinks,
  unlinkedChip,
  unlinkedLine,
} from '@/components/workspace/panels/testing/lib';
import {
  buildLedger,
  claimSentence,
  emptyLedgerLine,
  VERDICT_STATE,
} from '@/components/workspace/panels/implementation/pr';
import {
  breadcrumb,
  functionChips,
  functionsIn,
  headlineFor,
  hiddenLabel,
  shortNames,
  sourceLines,
  terminalLines,
  type FnSpan,
  type Problem,
} from '@/components/workspace/ide/derive';
import {
  type RightTab,
  type Pane,
  PANES,
  narrowWorkspaceSnapshot,
  wideWorkspaceServerSnapshot,
  subscribeWorkspaceWidth,
  phoneWorkspaceSnapshot,
  subscribePhoneWidth,
  pickNewer,
  languageLabel,
} from './workspace-helpers';
import { projectName } from '@/lib/project-name';

/**
 * The editor, for the visit that arrives before the warm-up has finished. Home
 * and Phases fetch this chunk while they are being read, and a page that has
 * one in memory renders {@link loadedEditor} instead: same component, but in
 * the first commit rather than a tick later behind a placeholder.
 */
const CodeEditorLazy = dynamic(
  () => import('@/components/workspace/CodeEditor').then((m) => m.CodeEditor),
  // The column keeps its shape while the chunk arrives; the editor's own
  // placeholder is the same one, so the two are indistinguishable.
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col gap-2.5 px-4 py-4" aria-hidden>
        {['w-[52%]', 'w-[36%]', 'w-[44%]', 'w-[28%]', 'w-[48%]', 'w-[32%]', 'w-[40%]', 'w-[24%]'].map(
          (w, i) => (
            <span key={i} className={`skeleton block h-3 ${w}`} />
          ),
        )}
      </div>
    ),
  },
);

/* -------------------------------------------------------------------------- */
/* The render, kept apart from the machinery above so each is readable.        */
/* -------------------------------------------------------------------------- */

/**
 * The task list and the IDE row, as one scroll region on a phase that has a
 * list.
 *
 * The row keeps a floor (`.workspace-room-floor` in phase-experience.css), so
 * a stack taller than the window pushes the editor down the page rather than
 * squeezing it shut. A phase with one task draws no list, and this is a
 * fragment there, adding no wrapper to its room's DOM.
 */
function RoomStack({
  scroll,
  regionRef,
  children,
}: {
  scroll: boolean;
  /** The region, for the arrival placement. */
  regionRef?: React.Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  if (!scroll) return <>{children}</>;
  return (
    <div
      ref={regionRef}
      className="workspace-room-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="workspace-room-scroll"
    >
      {children}
    </div>
  );
}

/**
 * The status bar, reading the caret from its store:
 * a keystroke that moves the caret redraws this bar and nothing else of the
 * room.
 */
function CaretStatusBar({ caret, ...rest }: { caret: CaretStore } & Omit<ComponentProps<typeof StatusBar>, 'line' | 'col'>) {
  const at = useCaret(caret);
  return <StatusBar {...rest} line={at.line} col={at.col} />;
}

/** What the room's half that draws is handed by the half that loads, saves and acts. */
interface WorkspaceBodyProps {
  agentBusy: boolean;
  requestedView: string | null;
  onViewOpened: () => void;
  detail: PhaseDetail;
  error: string;
  notice: string;
  appliedNote: boolean;
  panelProps: PhasePanelProps;
  isTesting: boolean;
  enrollment: EnrollmentView | null;
  analytics: LearnerAnalytics | null;
  activeFile: WorkspaceFile | undefined;
  activeText: string;
  editorText: string;
  files: Record<string, string>;
  liveFiles: () => Record<string, string>;
  activePath: string;
  setActivePath: Dispatch<SetStateAction<string>>;
  openPaths: string[];
  tree: ExplorerNode[];
  problems: Problem[];
  spans: FnSpan[];
  allSpans: FnSpan[];
  focusedFn: FnSpan;
  report: FeedbackReport | null;
  submission: SubmissionView | null;
  followingKeys: ReadonlySet<string>;
  run: ExecutionRunView | null;
  runs: ExecutionRunView[];
  links: PhaseLink[];
  saveLinks: (next: PhaseLink[]) => Promise<void>;
  runClock: string | null;
  caret: CaretStore;
  setCursor: (next: Caret) => void;
  focusLine: { line: number; nonce: number; quiet?: boolean } | null;
  restore: { line: number; col: number; scrollTop: number } | null;
  revealApplied: (AppliedReveal & { nonce: number; since: number }) | null;
  onRevealedApplied: () => void;
  onEditorScroll: (top: number) => void;
  openAt: (path: string, line: number) => void;
  onEdit: (path: string, content: string) => void;
  saving: 'idle' | 'dirty' | 'saving' | 'saved';
  conflict: { paths: string[]; version: string; recovered?: boolean } | null;
  takeTheirs: () => Promise<void>;
  keepMine: () => Promise<void>;
  editedSinceVerdict: boolean;
  running: boolean;
  submitting: boolean;
  busy: boolean;
  taskAwaiting: boolean;
  roomTask: PhaseTaskView | undefined;
  heldDetails: Record<string, PhaseDetail>;
  submitOff: string | undefined;
  olderRoom: string | null;
  selectedTask: string | null;
  setSelectedTask: (key: string) => void;
  onLeaveRoom: () => Promise<void>;
  resetControl: ReactNode;
  unknownTask: boolean;
  doRun: () => void;
  doRunApp: () => void;
  preview: PreviewController;
  runAppPressed: boolean;
  doSubmit: (focus?: string) => void;
  onBeforeContinue: () => Promise<void>;
  onAdvanced: () => void;
  tab: RightTab;
  setTab: Dispatch<SetStateAction<RightTab>>;
  bottom: string;
  setBottom: Dispatch<SetStateAction<string>>;
  pane: Pane;
  setPane: Dispatch<SetStateAction<Pane>>;
  showReflection: boolean;
  setShowReflection: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
}

export function WorkspaceBody(p: WorkspaceBodyProps) {
  const storedPanels = useWorkspacePanels();
  const narrowWorkspace = useSyncExternalStore(subscribeWorkspaceWidth, narrowWorkspaceSnapshot, wideWorkspaceServerSnapshot);
  const phoneWorkspace = useSyncExternalStore(subscribePhoneWidth, phoneWorkspaceSnapshot, wideWorkspaceServerSnapshot);
  const [runtimeView, setRuntimeView] = useState<'code'|'evidence'|'preview'>(p.detail.key === 'deployment' ? 'evidence' : 'code');
  const [implementationView, setImplementationView] = useState<'code'|'split'|'preview'>('code');
  // Code below 1600 px, Split from 1600 px, set after mount so hydration matches; Run app from Code opens Split so the app is on screen.
  useEffect(() => { setImplementationView((view) => (view !== 'code' ? view : p.runAppPressed ? 'split' : initialImplementationView(window.innerWidth))); }, [p.runAppPressed]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  useEffect(() => {
    if (p.detail.key === 'implementation' && p.running) setConsoleOpen(true);
  }, [p.detail.key, p.running]);
  // The left column opens on what the room's held pane shows: a phone that comes back to the room on its Files
  // pane finds the file tree under the lit Files, not the brief.
  const [labLeftTab, setLabLeftTab] = useState<'brief'|'files'>(() => (p.pane === 'files' ? 'files' : 'brief'));
  const agentBusy = p.agentBusy;
  const socketPaused = useSocketPaused();
  const {
    detail,
    error,
    notice,
    appliedNote,
    panelProps,
    isTesting,
    enrollment,
    analytics,
    activeFile,
    activeText,
    editorText,
    files,
    liveFiles,
    activePath,
    setActivePath,
    openPaths,
    tree,
    problems,
    spans,
    allSpans,
    focusedFn,
    report,
    submission,
    followingKeys,
    run,
    links,
    saveLinks,
    runClock,
    caret,
    setCursor,
    focusLine,
    restore,
    revealApplied,
    onRevealedApplied,
    onEditorScroll,
    openAt,
    onEdit,
    saving,
    conflict,
    takeTheirs,
    keepMine,
    editedSinceVerdict,
    running,
    submitting,
    busy,
    taskAwaiting,
    submitOff,
    olderRoom,
    selectedTask,
    setSelectedTask,
    onLeaveRoom,
    unknownTask,
    doRun,
    doRunApp,
    preview,
    runAppPressed,
    doSubmit,
    onBeforeContinue,
    onAdvanced,
    tab,
    setTab,
    bottom,
    setBottom,
    pane: requestedPane,
    setPane,
    showReflection,
    setShowReflection,
  } = p;
  /*
   * The working area by its height. Under 520 px of pane area the room
   * opens focused (the brief and the mentor collapsed, their toggles opening
   * them for this visit without touching the stored preference, the centre
   * showing the code or the results), and the split between the editor and
   * the results is the learner's to drag, with floors for both.
   */
  const areaRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** The implementation room's results, full height (its other rooms use their evidence view). */
  const [implResults, setImplResults] = useState(false);
  const isImplementation = detail.key === 'implementation';
  const resultsSplit = useResultsSplit({
    areaRef,
    sectionRef,
    // A run's results and a review are read whole, in every code room (`roomResultsHeight`).
    defaultResults: (avail) => roomResultsHeight({ implementation: isImplementation, bottom, hasRun: Boolean(run), avail }),
    remeasure: `${runtimeView}|${implementationView}|${consoleOpen}|${bottom}|${implResults}|${narrowWorkspace}|${appliedNote}`,
    // The console the learner opened keeps its height on a short column (the
    // preview and its controls stay above it) instead of folding to the bar.
    holdOpen: consoleOpen && bottom === 'console',
  });
  const focused = resultsSplit.focused && !narrowWorkspace;
  // The brief and the mentor in the focused mode, and never a native modal
  // left open in a column the mode hides, entering it or leaving it
  // (useFocusPanels).
  const panels = useFocusPanels(focused, storedPanels);
  // A remembered mobile pane may now be closed. Keep the editor visible while
  // preserving the requested pane and all mounted content for reopening.
  const pane: Pane = ((requestedPane === 'task' || requestedPane === 'files') && !panels.briefOpen)
    || ((requestedPane === 'panel' || requestedPane === 'preview') && !panels.mentorOpen)
    ? 'code' : requestedPane;
  const workingAreaLabels = WORKING_AREA_LABELS[detail.key as PhaseKey];
  // On a narrow viewport, a remembered open side can be behind the selected
  // pane. Its toolbar says Show and selects that pane in one click, rather
  // than incorrectly announcing an invisible region as expanded.
  const visiblePanels = { ...panels,
    briefOpen: panels.briefOpen && (!narrowWorkspace || pane === 'task' || pane === 'files'),
    mentorOpen: panels.mentorOpen && (!narrowWorkspace || pane === 'panel' || pane === 'preview'),
  };
  // The pane switcher (Brief, Files, Code, Mentor) under 1024 px, drawn while
  // either side is open or selected. Its Brief and Mentor do what the panel
  // switches' Show brief and Show mentor do, so the switches' own row is drawn
  // only while the switcher is not.
  const paneSwitcherShown = !(pane === 'code' && !panels.briefOpen && !panels.mentorOpen);
  const revealPanel = (panel: 'brief' | 'mentor') => {
    if (panel === 'brief') {
      setLabLeftTab('brief');
      setPane('task');
    } else {
      setTab('mentor');
      setPane('panel');
    }
  };
  // Hide brief or Hide mentor on a side pane under 1024 px sends the room back
  // to the code pane, and the row the switch sat on goes with it; focus
  // goes to what stands in for it: the switcher's Code tab while the other side
  // is open, else the same switch, now Show, at the right end of the view tabs.
  const refocusAfterHide = (label: string) => requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    [...document.querySelectorAll<HTMLElement>('[data-testid="pane-code"], .workspace-panel-controls button')]
      .find((el) => el.offsetParent !== null && (el.dataset.testid === 'pane-code' || el.textContent?.trim() === label))?.focus();
  });
  const rowPanels = { ...visiblePanels,
    setBriefOpen: (update: Parameters<typeof panels.setBriefOpen>[0]) => { panels.setBriefOpen(update); if (update === false) refocusAfterHide('Show brief'); },
    setMentorOpen: (update: Parameters<typeof panels.setMentorOpen>[0]) => { panels.setMentorOpen(update); if (update === false) refocusAfterHide('Show mentor'); },
  };
  useEffect(() => {
    if (detail.key === 'deployment') setBottom('pipeline');
    if (detail.key === 'testing') setBottom('tests');
  }, [detail.id]);
  useEffect(() => {
    if (!narrowWorkspace || detail.key === 'implementation' || (!running && !submitting)) return;
    // Mobile Code gives the editor the full working area. A newly started
    // run or review reveals its evidence, including keyboard-triggered work.
    // Manual view changes during that operation remain the learner's choice.
    setRuntimeView('evidence');
    setPane('code');
  }, [narrowWorkspace, detail.key, running, submitting, setPane]);

  const testing = useTesting(panelProps);
  // Fixed at the first render: the warmed component when the chunk is already
  // in memory, the lazy one otherwise. Choosing again later would tear the
  // editor down and build it back up under the learner's cursor.
  const [Editor] = useState(() => loadedEditor() ?? CodeEditorLazy);

  // Undefined rather than a guess: the crumb and the rail both leave the
  // project out until the enrolment says which one it is.
  const projectTitle = enrollment ? projectName(enrollment.projectTitle) : undefined;
  // The project's last phase, by key, and the pull request named by
  // the phase's place in its own project.
  const isLast = enrollment ? isLastPhase(enrollment, detail.key) : false;
  const hasPr = Boolean(submission) || detail.attempts > 0;
  const pr = `PR-${detail.place}`;
  const attempt = submission?.attempt ?? (detail.attempts || undefined);
  const persona = PERSONA_NAME[detail.key as keyof typeof PERSONA_NAME] ?? 'Mentor';
  // Where this room draws an app, if it draws one at all. Testing and
  // maintenance report `canPreview: true` and the API starts a preview for
  // both, so they get the third working view below as their control.
  const previewRoom = previewSurface(detail);
  const hasPreview = previewRoom !== 'none';
  // 'client' is the page preview (uploaded projects,
  // and the reference project where the sandbox preview cannot run). It needs
  // no Run app: it draws from the open files.
  const previewKind = previewMode(detail);
  // The reference project keeps its App preview pane, reason and all, where
  // the sandbox preview cannot run; the page preview draws under it.
  const appPreviewPane = appPreviewPaneOf(detail);
  const previewLabel = previewViewLabel(detail);
  // The control is still drawn on a deployment that cannot preview: it is
  // where the learner is told why, but there is nothing to press.
  const canRunApp = hasPreview && previewKind === 'server' && !detail.previewUnsupported;
  // The fourth right-hand tab, and a fifth pane on a narrow screen.
  // Both belong to the one room whose preview is a column of its own, and
  // `PANES` says why: a switcher entry that selects an empty column is worse
  // than four buttons.
  const previewPane = previewRoom === 'section';
  const panes = previewPane ? PANES : PANES.filter(([key]) => key !== 'preview');
  /** The mentor column is holding the app, and needs the row's width for it. */
  const previewColumn = previewPane && tab === 'preview';
  // Run app is pressed in the phase strip and by ⌘⇧A, both of which are drawn
  // by the component above this one, and `tab` is the one signal it can set.
  // A room whose preview is a working view follows that signal here rather
  // than lifting `runtimeView` up into the component above.
  useEffect(() => {
    if (previewRoom === 'view' && tab === 'preview') setRuntimeView('preview');
  }, [previewRoom, tab]);
  /**
   * The centre column's view, and the signal that selected it.
   *
   * Choosing the edit or evidence view gives the signal back, or the room
   * would reopen on a preview the learner had already left.
   */
  const selectRuntimeView = (view: 'code' | 'evidence' | 'preview') => {
    setRuntimeView(view);
    setPane('code');
    if (view === 'preview') {
      setTab('preview');
      // The app gets the working area, the way the implementation room's own
      // view tabs give it: reopening the preview is how a console opened from
      // inside the panel is closed again.
      setConsoleOpen(false);
    } else if (tab === 'preview') setTab('mentor');
  };
  /*
   * The views of a code phase's workspace that have an address (Maintenance,
   * Implementation, Testing and Deployment). The phase's
   * document pages draw this room's working-area row and left tabs as links,
   * so each view opens here on the view its address names (`?panel=`), as its
   * own button would open it. Read once as the room opens on that address, and
   * then taken out of the address (`onViewOpened`), so the learner's next
   * press decides and neither Back nor a reload brings the named view back.
   * Any other value (Deployment's `?panel=runbook`, read above and by the
   * Pipeline's tools, among them) moves nothing here and keeps its address.
   */
  const askedView = p.requestedView as string | null | undefined;
  const openedOnAsked = useRef<string | null>(null);
  useEffect(() => {
    if (!askedView) { openedOnAsked.current = null; return; }
    if (openedOnAsked.current === askedView) return;
    if (detail.key === 'implementation') {
      if (askedView === AREA_VIEW_PARAM.code || askedView === AREA_VIEW_PARAM.split || askedView === AREA_VIEW_PARAM.preview) {
        // As the view's own button does; a room with no preview stays on its view.
        if (askedView !== AREA_VIEW_PARAM.preview || previewRoom !== 'none') {
          setImplementationView(askedView);
          setImplResults(false);
          if (askedView === AREA_VIEW_PARAM.preview) setConsoleOpen(false);
        }
      } else if (askedView === AREA_VIEW_PARAM.files) { panels.setBriefOpen(true); setLabLeftTab('files'); setPane('files'); }
      else return;
    } else if (detail.key === 'maintenance' || detail.key === 'testing' || detail.key === 'deployment') {
      if (askedView === AREA_VIEW_PARAM.code) selectRuntimeView('code');
      else if (askedView === AREA_VIEW_PARAM.evidence) { if (detail.key === 'deployment') setBottom('pipeline'); selectRuntimeView('evidence'); }
      else if (askedView === AREA_VIEW_PARAM.preview) { if (previewRoom === 'view') selectRuntimeView('preview'); }
      else if (askedView === AREA_VIEW_PARAM.files) { setLabLeftTab('files'); setPane('files'); }
      else return;
    } else return;
    openedOnAsked.current = askedView;
    (p.onViewOpened as (() => void) | undefined)?.();
    // `selectRuntimeView` is rebuilt each render; the address is what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedView, detail.key, previewRoom]);
  /**
   * The room's full App preview view, which the preview panel offers when its
   * pane is too short to show the app. Only the Implementation room
   * draws the panel outside that view (its section under the editor in Split);
   * the runtime rooms draw it only in their own App preview view, where there
   * is nothing further to open, so nothing is offered there.
   */
  const openAppView =
    isImplementation && implementationView !== 'preview'
      ? () => {
          // As the view tab itself does.
          setImplementationView('preview');
          setImplResults(false);
          setConsoleOpen(false);
          setPane('code');
        }
      : undefined;
  /** Whether the centre column is showing the results rather than the code. */
  const showingResults = isImplementation ? implResults : runtimeView === 'evidence';
  // The results' and the column's scroll positions survive the switch.
  useScrollKeeper(sectionRef, showingResults ? 'results' : 'code');
  const showCode = () => {
    if (isImplementation) setImplResults(false);
    else selectRuntimeView('code');
  };
  const showResults = () => {
    setPane('code');
    if (isImplementation) {
      setImplResults(true);
      setConsoleOpen(true);
    } else selectRuntimeView('evidence');
  };
  /**
   * The review in the working area, in one press. The full-height
   * results and the Review tab together, so the verdict and its first
   * criteria are on screen without scrolling.
   */
  const viewReview = () => {
    setBottom('feedback');
    showResults();
  };
  /**
   * Submit from this room. In the focused mode the results are a pane of their
   * own, so the review the learner just asked for comes forward first instead
   * of staying behind the code (the merged-head e2e at 1280 by 720 found it
   * hidden); then the submission itself, as doSubmit does everywhere.
   */
  const submitHere = (focus?: string) => {
    if (focused) showResults();
    return doSubmit(focus);
  };
  /**
   * A verdict that lands can add a band above the panes (Ready to continue,
   * a saved-copy notice) and tip the room into the focused mode on Code,
   * hiding the review it just produced (the merged-head e2e, journey at 1280
   * by 720). A verdict that lands after the room opened is remembered for a
   * short while; entering the focused mode inside that while, with the Review
   * tab selected, brings the results forward. The mount's own verdict is not
   * a landing, so a passed room opened on a short screen still opens on Code.
   */
  const verdictLandedAt = useRef(0);
  const verdictSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const key = submission && submission.status === 'completed' ? submission.id : null;
    if (verdictSeen.current === undefined) {
      verdictSeen.current = key;
      return;
    }
    if (key && key !== verdictSeen.current) verdictLandedAt.current = Date.now();
    verdictSeen.current = key;
  }, [submission?.id, submission?.status]);
  useEffect(() => {
    if (focused && bottom === 'feedback' && Date.now() - verdictLandedAt.current < 20_000) showResults();
    // showResults is the room's own, stable in what it does; the trigger is the mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);
  // One thread for the whole room: the mentor session in the reviewer's tab
  // draws its feed and its composer, and the run panel and the failing-test
  // buttons ask it about a test.
  const personaThread = usePersona({ phaseKey: detail.key, phaseStateId: detail.id });

  // The two tablists here need keyboard support as well as their roles.
  // `useTabs` supplies the ids, the roving tabindex and the arrow, Home and End
  // handling, and points each tab at the panel it actually switches. The panes
  // are three columns rather than one panel, so that one names no panel.
  const paneTabs = useTabs({
    keys: panes.map(([key]) => key),
    // The active pane may be the safe editor fallback after a side was hidden.
    value: pane,
    onChange: (key) => {
      setPane(key as Pane);
      if (key === 'files' || key === 'task') {
        panels.setBriefOpen(true);
        setLabLeftTab(key === 'files' ? 'files' : 'brief');
      }
      // Selecting a side from the mobile switcher also restores that panel.
      if (key === 'panel' || key === 'preview') panels.setMentorOpen(true);
      if (key === 'panel') setTab('mentor');
      if (key === 'preview') setTab('preview');
    },
    label: 'Workspace pane',
  });
  const fileTabs = useTabs({
    keys: openPaths,
    value: activePath,
    onChange: setActivePath,
    controls: 'workspace-editor-panel',
    label: 'Files',
  });
  // The strip is the one row in the room that runs out of width, and this pack
  // holds two files called tasks.py, so it says which edge has more behind it
  // and gives the repeated basenames enough path to tell apart.
  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabFade = useEdgeFade(tabStripRef as React.RefObject<HTMLElement | null>, [openPaths.join('|')]);
  const tabLabels = useMemo(() => shortNames(openPaths), [openPaths]);
  // Selecting a tab that is off the edge must bring it into view; without this
  // the fade is honest and the strip is still unusable by keyboard.
  // Sideways, and only the strip. `scrollIntoView` would also scroll the room
  // region of a split phase until the strip sat at its bottom edge, leaving
  // the editor out of view on arrival.
  useEffect(() => {
    const strip = tabStripRef.current;
    const el = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (strip && el) revealTabInStrip(strip, el);
  }, [activePath, openPaths]);
  // The room of a split phase opens with the editor's first lines on screen,
  // never scrolled past the top of the IDE row; once per task, and it stands
  // down the moment the learner scrolls.
  const roomRef = useRef<HTMLDivElement>(null);
  useArrivalReveal(roomRef, `${detail.id}\u0000${selectedTask ?? ''}`, isSplit(detail.tasks));

  // The two shortcuts, written the way the buttons write them, read once so a
  // Mac says ⌘ and everything else says Ctrl.
  const [runKeys, setRunKeys] = useState('⌘⇧↵');
  const [submitKeys, setSubmitKeys] = useState('⌘↵');
  useEffect(() => {
    setRunKeys(shortcutWord('⇧↵'));
    setSubmitKeys(shortcutWord('↵'));
  }, []);

  // ⌘K over this workspace: the criteria the phase is judged on, the files, and
  // the cases the last verdict ran: each row goes where it belongs.
  const paletteGroups = useMemo(
    () =>
      [
    {
      label: 'Criteria',
      items: (report?.contract ?? []).slice(0, 12).map((c) => ({
        label: c.text,
        detail: [c.name, c.story].filter(Boolean).join(', '),
        hint: c.verdict === 'kept' ? 'passing' : c.verdict,
        icon: 'requirements' as const,
        onSelect: () => {
          const span = allSpans.find((sp: FnSpan) => sp.name === c.name);
          if (span) openAt(span.path, span.line);
          setTab('map');
        },
      })),
    },
    {
      // The two records are forms in their rooms and are never listed as
      // files.
      label: 'Code',
      items: detail.files.filter((f) => !isRoomRecordPath(f.path)).map((f) => ({
        label: f.path,
        detail: f.editable ? 'You write this one' : 'Read only',
        hint: 'open file',
        icon: 'code' as const,
        onSelect: () => openAt(f.path, 1),
      })),
    },
    {
      label: 'Tests',
      items: (report?.tests?.cases ?? []).slice(0, 12).map((c) => ({
        label: c.name,
        detail: c.hidden ? 'Hidden suite' : 'Visible suite',
        hint: c.status === 'passed' ? 'passing' : 'failing',
        icon: 'testing' as const,
        onSelect: () => setBottom('tests'),
      })),
    },
    {
      // The two verbs this room owns. The palette's own footer promises
      // actions, so typing "submit" must answer with something.
      label: 'Actions',
      items: [
        {
          label: 'Run the tests',
          detail: 'The visible suite, in the sandbox',
          hint: runKeys,
          icon: 'run' as const,
          keywords: 'run tests execute',
          onSelect: () => void doRun(),
        },
        {
          label: 'Submit for review',
          // While there is nothing to hand in the row
          // stays findable, is off (aria-disabled; choosing it does nothing)
          // and its second line is the reason the header's Submit gives.
          detail: submitOff ?? 'Graded against the phase gate',
          hint: submitKeys,
          icon: 'merge' as const,
          keywords: 'submit review grade gate',
          disabled: Boolean(submitOff),
          onSelect: () => void submitHere(),
        },
      ],
    },
  ].filter((g) => g.items.length > 0),
    [report, detail.files, allSpans, openAt, setTab, setBottom, doRun, doSubmit, focused, runKeys, submitKeys, submitOff],
  );

  const nav = useMemo(
    () => ({
      projectTitle,
      phases: enrollment?.phases,
      currentPhaseId: detail.id,
      tokensToday: analytics?.tokensToday,
      notifications: problems.length,
      paletteGroups,
    }),
    [
      projectTitle,
      enrollment?.phases,
      detail.id,
      analytics?.tokensToday,
      problems.length,
      paletteGroups,
    ],
  );

  const crumbs = useMemo(
    () => [
      ...(projectTitle ? [{ label: projectTitle, href: '/dashboard', testId: 'back-dashboard' }] : []),
      // <project> › <Phase> › the working-area row's entry for the view on screen, not a file name.
      { label: detail.title, href: `/phases?phase=${detail.key}` },
      {
        label: detail.key === 'implementation'
          // The row's entry for the view: Files is the left column's tab, not a row entry, so it names no leaf.
          ? implementationView === 'split' ? 'Split' : implementationView === 'preview' ? previewLabel : 'Code'
          : runtimeView === 'evidence' ? workingAreaLabels.evidence : runtimeView === 'preview' ? previewLabel : workingAreaLabels.edit,
      },
    ],
    [projectTitle, detail.title, detail.key, implementationView, runtimeView, previewLabel, workingAreaLabels],
  );

  /* --------------------------------- chips -------------------------------- */

  const linkedCount = testing.tests.filter((t) => testing.linked[t.name]).length;
  // Tests written but not yet pointed at a criterion: what "Pick a test"
  // offers, and what the explorer warns about.
  const orphanTests = testing.tests.length - linkedCount;
  // The Failing first tab's words for this phase's state.
  const firstWords = failingFirstWords(detail.status === 'passed');
  const aliveBugs = testing.view.total - testing.view.killed;
  const chips = useMemo(
    () =>
      isTesting
    ? [
        { tone: 'neutral' as const, text: `${testing.tests.length} tests in suite` },
        // What it counts, in words, and quiet once the phase has passed.
        ...[unlinkedChip(testing.tests.length - linkedCount, detail.status === 'passed')].filter((chip) => chip !== null),
        ...(testing.view.total > 0
          ? [
              aliveBugs > 0
                ? { tone: 'fail' as const, text: bugsAliveText(aliveBugs) }
                : { tone: 'pass' as const, text: 'All bugs caught' },
            ]
          : [{ tone: 'neutral' as const, text: 'Bugs not yet run' }]),
      ]
    : (() => {
        // The strip is about the phase's work, so a file with no functions in
        // it (a package marker, a README you opened to read) falls back to
        // the file you are asked to change rather than going blank.
        const own = functionChips(spans, activeText, report);
        if (own.length > 0) return own;
        // …but never over a file the learner is writing: an editable .tsx
        // with nothing parsed yet would otherwise draw the Python file's
        // functions, so the strip would describe a file nobody was looking
        // at. Empty is the honest answer there.
        if (activeFile?.editable) return own;
        const edit = detail.files.find((f) => f.editable);
        if (!edit || edit.path === activePath) return own;
        const text = files[edit.path] ?? edit.content;
        return functionChips(
          functionsIn(edit.path, text, report?.staticAnalysis?.functions ?? []),
          text,
          report,
        );
      })(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTesting, testing, spans, activeText, report, detail.files, detail.status, activePath, activeFile, files],
  );

  /* -------------------------------- problems ------------------------------ */

  const notes: EditorNote[] = useMemo(() => {
    if (!activeFile) return [];
    if (isTesting) {
      const unlinked = testing.tests.filter(
        (t) => t.path === activeFile.path && !testing.linked[t.name],
      );
      return unlinked.slice(0, 6).map((t) => ({
        key: `link-${t.name}`,
        line: t.line,
        tone: 'neutral' as const,
        label: 'Not linked',
        // This page draws no map: the choice links the test to the criterion it checks.
        text: 'This test has no criterion. Which one does it check? Pick one to link it.',
        choices: testing.criteria.slice(0, 4).map((c) => ({
          label: c.id,
          selected: false,
          onSelect: () => {
            const draft: Record<string, string> = { ...testing.linked, [t.name]: c.id };
            void saveLinks(nextLinks(links, draft, testing.tests, new Date().toISOString()));
          },
        })),
      }));
    }
    return problems
      .filter((x: Problem) => x.path === activeFile.path)
      .slice(0, 6)
      .map((x: Problem) => ({
        key: `${x.path}:${x.line}:${x.what}`,
        line: x.line,
        tone: x.note.tone,
        label: x.note.label,
        text: x.note.text,
        test: x.note.test,
        // A note tied to a test asks the reviewer to explain it, in the
        // thread the learner already has; any other note opens the verdict
        // in the bottom panel.
        onExplain: x.test
          ? () => {
              setTab('mentor');
              void personaThread.explain({ testName: x.test as string, source: 'submission' });
            }
          : () => setBottom('feedback'),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path, isTesting, problems, testing.tests, testing.linked, testing.criteria, links]);

  /* ------------------------------ code health ----------------------------- */

  // The verdict's findings describe the code as it was graded, so
  // they are drawn on it only while the workspace has not moved on. A marker
  // whose line number is one edit stale points at the wrong code, which is
  // worse than pointing at nothing.
  const healthIsStale =
    editedSinceVerdict ||
    saving === 'dirty' ||
    Boolean(
      detail.workspaceUpdatedAt &&
        submission &&
        String(detail.workspaceUpdatedAt) > String(submission.createdAt),
    );
  const healthFor = useMemo(() => healthFindings(report?.staticAnalysis), [report?.staticAnalysis]);
  const markers = useMemo<EditorMarker[]>(
    () =>
      healthIsStale || !activeFile
        ? []
        : healthFor
            .filter((f: { path: string }) => f.path === activeFile.path)
            .map((f) => ({ line: f.line, severity: f.severity, message: f.message, rule: f.rule })),
    [healthFor, healthIsStale, activeFile?.path],
  );

  /* ----------------------------- bottom panel ----------------------------- */

  /*
   * One name for the run, wherever it is pressed in the room: the header's word ("Run tests", or "Run selfcheck" in
   * Deployment), not the pack's own label ("Run my tests", "Run regression tests", "Run visible tests"), which named the
   * same act differently in each phase and on each control of one phase.
   */
  const runWord = detail.key === 'deployment' ? 'Run selfcheck' : 'Run tests';
  const terminal = useMemo(
    () => terminalLines(run, report, attempt, runWord),
    [run, report, attempt, runWord],
  );
  const ledger = useMemo(() => buildLedger(report?.contract ?? []), [report]);
  // The commit message for the next revision, and the last one that carried
  // words. The same draft the pull request's field writes.
  const [commitMessage, setCommitMessage] = useCommitDraft(detail.id);
  const withMessage = useMemo(
    () => (panelProps.submissions as SubmissionView[]).filter((x) => x.commitMessage),
    [panelProps.submissions],
  );
  const lastMessage = withMessage[withMessage.length - 1]?.commitMessage ?? null;

  /*
   * Memoised. The panel holds the terminal, the run, the planted bugs, the
   * ledger, the code health, the commit message and the review (six of them
   * parse or tabulate something) so it must not be rebuilt for every
   * character typed in the editor.
   */
  const PhaseTools = PHASE_PANELS[detail.key as keyof typeof PHASE_PANELS]?.Tools;

  const bottomTabs: BottomTab[] = useMemo(() => [
    {
      key: 'terminal',
      label: 'Terminal',
      content: (
        <pre className="mono whitespace-pre-wrap px-3.5 py-2 text-[12px] leading-[1.6] text-ink2">
          {terminal.map((l, i) => (
            <span
              key={i}
              className={`block ${l.tone === 'fail' ? 'font-semibold text-fail' : l.tone === 'ink' ? 'text-ink' : ''}`}
            >
              {l.text}
            </span>
          ))}
        </pre>
      ),
    },
    // What the learner's own application printed. Beside Terminal
    // rather than in a drawer inside the preview, which would have eaten the
    // app it is about.
    ...(hasPreview
      ? [
          {
            key: 'console',
            // The learner's own application talking, "Console" in every phase.
            // What a test run printed, inside the Testing room's
            // recorded evidence, is "Run output", so the two never share a name.
            label: 'Console',
            testId: 'tab-console',
            count: preview.errors || undefined,
            content: <ConsolePane lines={preview.console} />,
          },
        ]
      : []),
    {
      key: 'tests',
      label: 'Tests',
      testId: 'tab-tests',
      content: (
        <RunPanel
          run={run}
          appearance={isTesting ? 'testing' : 'standard'}
          canRun={detail.canRun}
          runLabel={runWord}
          busy={running}
          onRun={doRun}
          // The fast loop is where a failing test is read, so it is
          // where the reviewer is asked about one.
          thread={personaThread}
          onOpenThread={() => setTab('mentor')}
        />
      ),
    },
    isTesting
      ? {
          key: 'first',
          label: 'Failing first',
          testId: 'tab-failing-first',
          // On a passed phase the words say why every test is green from its first run; while the
          // phase is worked they say what to fix first (failingFirstWords).
          content: (
            <div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-[12.5px]">
              <p className="purpose">
                {firstWords.purpose}
              </p>
              {testing.first.length === 0 && <p className="label">No runs yet.</p>}
              {testing.first.map((r) => (
                <div key={r.name} className="flex items-center gap-2.5">
                  <StatusSquare
                    state={r.state === 'red-first' ? 'pass' : r.state === 'unseen' ? 'todo' : r.state === 'still-red' ? 'fail' : r.state === 'never-red' ? firstWords.neverRedState : 'warn'}
                    size={11}
                  />
                  <span className="mono text-[12px] text-ink">{r.name}</span>
                  <span className="text-muted">
                    {r.state === 'red-first'
                      ? `Red on run ${r.firstRed}, green on run ${r.firstGreen}`
                      : r.state === 'still-red'
                        ? `Red on run ${r.firstRed}. No run has it green yet`
                        : r.state === 'never-red'
                          ? firstWords.neverRed
                          : r.state === 'green-first'
                            ? `Green on run ${r.firstGreen} before it was ever red`
                            : 'Not in any run yet'}
                  </span>
                </div>
              ))}
            </div>
          ),
        }
      : {
          key: 'problems',
          label: 'Problems',
          count: problems.length,
          testId: 'tab-problems',
          content: (
            <div className="flex flex-col">
              {problems.length === 0 ? (
                <p className="label px-3.5 py-3">Nothing is failing in this workspace.</p>
              ) : (
                problems.map((x: Problem, i: number) => (
                  // The row itself is the button that opens the
                  // line, so the explain control is its sibling: a button
                  // inside a button is not a thing a browser will draw.
                  <div
                    key={i}
                    className="flex items-start gap-2.5 border-b-1.5 border-edge px-3.5 py-2 last:border-b-0 hover:bg-raised"
                  >
                    <button
                      type="button"
                      onClick={() => openAt(x.path, x.line)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <StatusSquare state={x.state} size={11} className="mt-[3px]" />
                      <span className="wrap min-w-0 flex-1 text-[12.5px] text-ink2">
                        <span className="mono text-ink">{x.where}</span> {x.what}
                      </span>
                      <span className="mono shrink-0 text-[11.5px] text-muted">{x.path}</span>
                    </button>
                    {x.test && (
                      <ExplainTestButton
                        testName={x.test}
                        source="submission"
                        thread={personaThread}
                        onOpenThread={() => setTab('mentor')}
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          ),
        },
    isTesting
      ? {
          key: 'bugs',
          label: 'Planted bugs',
          testId: 'tab-planted-bugs',
          content: (
            <div className="px-3.5 py-2.5" data-testid="planted-bugs">
              {testing.view.total === 0 ? (
                <p className="label">{PLANTED_BUGS_EMPTY}</p>
              ) : (
                <Table
                  cols={[{ label: 'Bug', width: '1fr', mono: true }, { label: '', width: 'auto', align: 'right' }]}
                  rows={testing.view.rows.map((r) => [
                    r.row.mutant,
                    <Chip key={r.id} tone={r.row.killed ? 'pass' : 'fail'}>
                      {r.row.killed ? 'Caught' : 'Alive'}
                    </Chip>,
                  ])}
                  minWidth={320}
                />
              )}
            </div>
          ),
        }
      : {
          key: 'ledger',
          label: 'Ledger',
          testId: 'tab-ledger',
          content: (
            <div className="px-3.5 py-2.5" data-testid="phase-implementation-ledger">
              {ledger.length === 0 ? (
                // Only Implementation and Maintenance reviews build a ledger;
                // after a review, an empty one is a review that checked no
                // claim, not one still to come.
                <p className="label">{emptyLedgerLine(detail.key, Boolean(report))}</p>
              ) : (
                <Table
                  cols={[{ label: 'Claim', width: '1fr' }, { label: 'Verdict', width: 'auto', align: 'right' }]}
                  rows={ledger.flatMap((g) =>
                    g.claims.map((c) => [
                      <CellTitle
                        key={`${g.name}-${c.claim}`}
                        state={VERDICT_STATE[c.verdict as keyof typeof VERDICT_STATE]}
                        title={<span className="mono">{g.name}</span>}
                        detail={claimSentence(c)}
                      />,
                      <Chip key={`${g.name}-${c.claim}-v`} tone={c.verdict === 'kept' ? 'pass' : c.verdict === 'contradicted' ? 'warn' : 'fail'}>
                        {c.verdict}
                      </Chip>,
                    ]),
                  )}
                  minWidth={340}
                />
              )}
            </div>
          ),
        },
    ...(detail.key === 'deployment' && PhaseTools
      ? [{ key: 'pipeline', label: 'Pipeline', testId: 'tab-pipeline', content: <PhaseTools {...panelProps} /> }]
      : []),
    // Code health. Only on a phase the analyzer runs for: implementation and
    // maintenance, because a tab that is always empty is worse than no tab.
    ...(detail.artifactKind === 'code'
      ? [
          {
            key: 'health',
            label: 'Health',
            // The bell's own rule for "the analyzer had something to say"
            // (notifications.service.ts, line 816), so the two never disagree.
            count: healthFor.filter((f: { severity: string }) => f.severity !== 'info').length,
            testId: 'tab-health',
            content: (
              <HealthPanel
                analysis={report?.staticAnalysis}
                submissions={panelProps.submissions as SubmissionView[]}
                attempt={attempt}
                stale={healthIsStale}
                onOpen={openAt}
              />
            ),
          },
        ]
      : []),
    {
      key: 'commit',
      label: 'Commit',
      // The number of revisions that carry a message, so a learner who has
      // never written one sees "Commit 0" rather than a count of attempts.
      count: withMessage.length,
      testId: 'tab-commit',
      content: (
        <div className="flex flex-col gap-3 px-3.5 py-3">
          <p className="purpose">
            One line saying what this revision changes, recorded with it. It is not a gate:
            submitting with the field empty records the revision with no message.
          </p>
          <CommitField value={commitMessage} onChange={setCommitMessage} last={lastMessage} reference={runsReferenceApplication(detail.provenance)} />
        </div>
      ),
    },
    {
      key: 'feedback',
      label: 'Review',
      testId: 'tab-feedback',
      content: (
        <div className="h-full overflow-y-auto">
          <FeedbackPanel submission={submission} tasks={detail.tasks} kind={detail.artifactKind} isLast={isLast} floors={detail} />
        </div>
      ),
    },
  ],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [
    terminal,
    hasPreview,
    preview.console,
    preview.errors,
    run,
    running,
    doRun,
    detail,
    personaThread,
    setTab,
    isTesting,
    testing,
    problems,
    openAt,
    report,
    attempt,
    healthIsStale,
    panelProps,
    PhaseTools,
    submission,
    isLast,
    ledger,
    commitMessage,
    setCommitMessage,
    lastMessage,
    withMessage.length,
  ]);

  /* -------------------------------- the render ---------------------------- */

  // A tab whose save was refused must never read "Saved" over a file the
  // server does not hold.
  const saveLabel = conflict
    ? 'Not saved'
    : saving === 'dirty'
      ? 'Unsaved'
      : saving === 'saving'
        ? 'Saving…'
        : 'Saved';
  // 14:32, as the status bar is drawn: a 12-hour clock with "PM" is two more
  // words on a line that is already all facts.
  // `workspaceUpdatedAt` and not `updatedAt`: the row stamp moves on every
  // drill step, link, run clock and grading, so the status bar would claim a
  // save the learner had not made. Null until the first autosave, and the bar
  // then shows "Saved" with no time, which is the true thing to say when
  // nothing was written.
  const savedAt = detail.workspaceUpdatedAt
    ? new Date(detail.workspaceUpdatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : undefined;

  // The right end of the status bar: how the hidden suite stood on the build
  // phases, and how the suite you wrote stands on the testing phase.
  // The runner names a case by its class as well as its function
  // ("TestOverdue.test_due_today_is_not_overdue"); the file only knows the
  // function, so a case belongs to a test when it ends with its name.
  const testCases = (report?.tests?.cases ?? []).filter((c) =>
    testing.tests.some((t) => c.name === t.name || String(c.name).endsWith(`.${t.name}`)),
  );
  const passingCount =
    testCases.length > 0
      ? testCases.filter((c) => c.status === 'passed').length
      : ((report?.tests?.passed ?? null) as number | null);
  const statusRight = isTesting
    ? testing.tests.length === 0
      ? undefined
      : `${testing.tests.length} ${testing.tests.length === 1 ? 'test' : 'tests'}${
          passingCount !== null ? `, ${passingCount} passing` : ''
        }`
    : hiddenLabel(report);

  // The maintenance card reads the change request (the teacher's ticket and
  // the learner's record); a Maintenance without one, in the older format,
  // has nothing for it to read, and its task panel is the brief.
  const PhaseBrief =
    detail.key === 'maintenance' && !detail.change
      ? undefined
      : PHASE_PANELS[detail.key as keyof typeof PHASE_PANELS]?.Brief;

  // Whether this phase's room task is still the reference project's
  // (lib/scenario.ts). The strip's Requirements headline names the reference
  // story only then, and only on that room task.
  const roomReference = roomIsReference(
    detail.provenance,
    enrollment?.phases?.find((one: { key: string }) => one.key === detail.key),
    enrollment,
  );
  /**
   * The task this room is working in, where it is **not** the phase's own.
   *
   * A teacher's authored task carries its own brief, its own objectives and
   * (where they narrowed it) its own rubric, all of them on the payload the
   * room already has. If nothing here read them, a learner sent to this room
   * by an authored task's door would open the right artefact and hand in to
   * the right route while being told the inherited task's instructions and
   * shown the phase's criteria, which a narrowed task rubric is not. So a room
   * on an authored task states that task's work, and the phase's brief (which
   * is about the artefact the phase's own room writes) stands down.
   *
   * The task `phaseRoomTaskKey` names as the phase room's own, and every phase
   * with one task, keeps the room unchanged: this is `undefined` and nothing
   * below it moves. A split Implementation or Testing phase has no room built
   * around one record, so `phaseRoomTaskKey` names none there and every task
   * selected on it, its first one included, is read as authored.
   */
  const authoredTask: PhaseTaskView | undefined = useMemo(() => {
    if (!isSplit(detail.tasks)) return undefined;
    const here = chooseTask(detail.tasks, selectedTask);
    if (!here || here.key === phaseRoomTaskKey(detail.key as PhaseKey, detail.tasks)) return undefined;
    return here;
  }, [detail.tasks, detail.key, selectedTask]);

  // A task passed on the board by the teacher's credit, with no reviewed pass
  // behind it, does not tick its objectives as passed: they read in the
  // credit's warn tone, as its row and the band do.
  const authoredCredited = authoredTask?.status === 'passed' && isCredited(detail.id, detail, authoredTask.key);
  const taskObjectiveSteps = useMemo(
    () =>
      (authoredTask?.objectives ?? []).map((o: string) => ({
        title: o,
        state: (authoredTask?.status === 'passed' ? (authoredCredited ? 'warn' : 'pass') : 'todo') as 'pass' | 'warn' | 'todo',
      })),
    [authoredTask, authoredCredited],
  );

  /** What this task asks for, in the panel where the phase's brief is read. */
  const taskBriefBlock = useMemo(
    () =>
      authoredTask ? (
        <section className="border-b-1.5 border-edge px-4 py-4" data-testid="task-brief">
          <h2 className="text-[19px] font-semibold leading-tight tracking-[-0.02em] text-ink">
            {authoredTask.title}
          </h2>
          {authoredTask.brief && (
            <div className="mt-2">
              <PlainText text={authoredTask.brief} commentsHidden />
            </div>
          )}
          {taskObjectiveSteps.length > 0 && (
            <>
              <div className="mt-3">
                <SectionHead title="What to do" purpose="In order. The review checks each one." />
              </div>
              <div className="mt-2">
                <Steps items={taskObjectiveSteps} />
              </div>
            </>
          )}
        </section>
      ) : null,
    [authoredTask, taskObjectiveSteps],
  );

  /*
   * The file tree, hoisted: it is a column of its own and
   * has nothing to say about the caret, so it keeps its element across a
   * commit that only the editor caused.
   */
  const explorer = useMemo(
    () => (
      <Explorer
        className="flex !w-full min-h-0 flex-1"
        tree={tree}
        sourceControl={{
          pr,
          changes: (() => {
            const paths = detail.files
              .filter((f) => f.editable)
              .slice(0, 3)
              .map((f) => f.path as string);
            // Same reason as the tab strip: two rows both reading "tasks.py"
            // name two different files.
            const names = shortNames(paths);
            return paths.map((path: string) => ({ name: names.get(path) ?? path, state: 'now' as const }));
          })(),
          lines: [
            // How many tests have no link to a criterion. A link is a traceability claim the review does not
            // grade, so on a passed phase the line is quiet, as the room's chip is (unlinkedLine).
            ...(isTesting && orphanTests > 0 ? [unlinkedLine(orphanTests, detail.status === 'passed')!] : []),
            ...sourceLines(report, attempt),
          ],
        }}
        problems={problems.slice(0, 6).map((x: Problem) => ({
          state: x.state,
          where: x.where,
          what: x.what,
          onSelect: () => openAt(x.path, x.line),
        }))}
      />
    ),
    [tab, pane, tree, pr, detail.files, detail.status, isTesting, orphanTests, report, attempt, problems, openAt],
  );

  /*
   * The aside's "Phase requirements and review" block, hoisted: the phase's
   * brief, the panel's own card and the grading guide have nothing to do with
   * the caret. The grading guide alone is 42 elements a keystroke would
   * otherwise redraw.
   */
  /*
   * The phase's brief, plain text, in every phase the IDE hosts:
   * Implementation, Testing, Deployment and Maintenance. The API served it
   * through `learnerText`, so its comments are hidden already. Memoised on the
   * brief alone. Nothing on a room that is on an authored task, whose own brief
   * is read above the block.
   */
  const phaseTextBrief = useMemo(
    () =>
      !authoredTask && detail.taskPanel ? (
        <section className="border-b-1.5 border-edge px-4 py-4" data-testid="phase-brief">
          <h3 className="text-[13.5px] font-semibold text-ink">The brief</h3>
          <div className="mt-2">
            <PlainText className="text-[13px] leading-[1.65] text-ink2" text={detail.taskPanel} commentsHidden />
          </div>
        </section>
      ) : null,
    [authoredTask, detail.taskPanel],
  );

  /*
   * The panel's own card, memoised apart from the block around it: it is the
   * one part of the block that reads the phase's working state, so it is the
   * only one that should be rebuilt when that state moves.
   */
  const phaseBriefBlock = useMemo(
    () =>
      PhaseBrief && panelProps ? (
        <div className="border-b-1.5 border-edge px-4 py-4" data-testid="phase-panel-brief">
          <PhaseBrief {...panelProps} />
        </div>
      ) : null,
    [PhaseBrief, panelProps],
  );

  /*
   * What this hand-in is marked against. A teacher's authored task inherits the
   * phase's rubric until they narrow it, so on a room that is on an authored
   * task the phase's criteria can be criteria this hand-in is **not** graded
   * against, and the guide would then be a list of the wrong requirements.
   */
  const gradedBy = authoredTask?.rubric ?? detail.rubric;
  /*
   * Whether a Pass here is one task's rather than the phase's.
   * On a teacher's task it always is. On the phase's own task of a split phase
   * it is too wherever another required task is still in the phase: the Pass
   * records this task, and the phase opens only once every required task has
   * passed. A phase with one task keeps the phase-level sentence.
   */
  const passIsTheTasks = Boolean(
    authoredTask ||
      (isSplit(detail.tasks) &&
        detail.tasks!.some(
          (task: PhaseTaskView) =>
            task.required && task.key !== phaseRoomTaskKey(detail.key as PhaseKey, detail.tasks),
        )),
  );
  const gradingGuide = useMemo(
    () => (
      <>
              <details
                className="group px-4 py-4"
                data-testid="grading-guide"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                  {authoredTask ? 'How this task is graded' : 'How this phase is graded'}
                  <Icon
                    name="chevron-down"
                    size={14}
                    className="shrink-0 text-dim transition group-open:rotate-180"
                  />
                </summary>
                <p className="purpose mt-1.5">
                  Every required criterion needs correct evidence. Verdicts are Pass or Needs revision.
                </p>
                <Table
                  className="mt-3"
                  cols={[
                    { label: 'Criterion', width: '1fr' },
                    { label: 'Requirement', width: 'auto', align: 'right' },
                  ]}
                  rows={gradedBy.criteria.map((c) => [
                    <CellTitle key={c.key} state="todo" title={c.title} detail={c.description} />,
                    'Required',
                  ])}
                  minWidth={280}
                />
                <p className="purpose mt-3">
                  {/* On the project's last phase no phase follows: the words say the project can be completed. */}
                  {gradingPassLine(passIsTheTasks, isLast)}
                </p>
              </details>
      </>
    ),
    [gradedBy, authoredTask, passIsTheTasks, isLast],
  );

  const bottomPanel = useMemo(
    () => (
      <BottomPanel
        tabs={bottomTabs}
        value={bottom}
        onChange={setBottom}
        height={
          bottom === 'feedback' || bottom === 'tests' || bottom === 'pipeline'
            ? 320
            : bottom === 'health'
              ? 300
              : isTesting
                ? 168
                : 150
        }
      />
    ),
    [bottomTabs, bottom, setBottom, isTesting],
  );

  /*
   * The room's one header row, hoisted: the phase, its
   * place, its state and at most one primary action, with every other door in
   * the row's "More" menu. Rebuilding it for a keystroke would redraw the
   * menu's doors and their busy states with it.
   */
  const quickCheck = useClaimedQuickCheck();
  const roomTask: PhaseTaskView | undefined = p.roomTask;
  // The verdict the room holds speaks for the task it is working in; one for
  // a sibling task of a split phase does not.
  const roomVerdict =
    submission && (!submission.taskKey || !roomTask || submission.taskKey === roomTask.key) ? submission : null;
  const state = learnerState(detail.id, detail, { awaiting: taskAwaiting, verdict: roomVerdict, task: roomTask });
  /*
   * The one primary action. Submit leads while there is work to hand in (in
   * progress, a review that asked for more, credit still wanting its review);
   * once Continue is open the gate band carries it, and while the
   * countersignature is pending there is nothing to hand in. Submit is then in
   * the menu, with its reason where it is off.
   */
  const submitLeads = state === 'inProgress' || state === 'revise' || state === 'credited';
  const place =
    phasePlace(detail.place, detail.count) ??
    (enrollment && holdsPhase(enrollment, detail.key) ? placeLabel(enrollment, detail.key) : null);
  const lessons = lessonsOfferedOn(enrollment, detail.key as PhaseKey, p.heldDetails);
  const hasReview = Boolean(submission);
  const strip = useMemo(() => {
    const submitButton = (
      <Button
        size="sm"
        variant={submitLeads ? 'primary' : 'secondary'}
        keys="⌘↵"
        testId="header-submit"
        busy={submitting}
        busyLabel="Reviewing"
        disabled={busy || Boolean(submitOff)}
        reason={submitOff}
        onClick={() => void submitHere()}
      >
        {/* "Submit PR-<n> again" once a submission exists, the words every page of the phase uses. */}
        {phaseSubmitLabel(detail, hasPr)}
      </Button>
    );
    return (
      <PhaseHeader
        phase={detail}
        place={place}
        // The chip says where the review stands; once Continue is open, the
        // band's own label says so ("Ready to continue"), so the two rows
        // never repeat one another.
        state={state === 'ready' ? 'reviewPassed' : state}
        lessons={lessons}
        quickCheck={quickCheck}
        headline={headlineFor(detail.key, detail.files, roomReference && !authoredTask, roomReference ? null : { intro: detail.intro })}
        chips={chips.map((c, i) => (
          <Chip key={i} tone={c.tone === 'neutral' ? 'outline' : c.tone}>
            {c.text}
          </Chip>
        ))}
        // Run tests and Run app stay on the row: they are the room's fast loop,
        // pressed far more often than anything in the menu (⌘⇧↵ and ⌘⇧A), and
        // in the Implementation room's Code view the app's own section is
        // hidden, so the row is the one place Run app can be seen.
        visible={
          detail.canRun || canRunApp ? (
            <span className="phase-header-secondary">
              {detail.canRun && (
                <Button
                  variant="secondary"
                  size="sm"
                  keys="⌘⇧↵"
                  testId="header-run"
                  busy={running}
                  busyLabel="Running"
                  disabled={busy || Boolean(olderRoom)}
                  reason={olderRoom ?? undefined}
                  onClick={doRun}
                >
                  {detail.key === 'deployment' ? 'Run selfcheck' : 'Run tests'}
                </Button>
              )}
              {canRunApp && (
                <Button
                  variant="secondary"
                  size="sm"
                  keys="⌘⇧A"
                  testId="header-run-app"
                  busy={preview.starting || runAppPressed}
                  busyLabel="Building"
                  disabled={busy}
                  onClick={() => void doRunApp()}
                >
                  Run app
                </Button>
              )}
            </span>
          ) : null
        }
        menu={
          <>
            {/* The way back to the brief: what this stage is, what to do, how it is judged. */}
            <Button
              href={briefHref(detail)}
              variant="ghost"
              size="sm"
              icon="book"
              ariaLabel="Read the brief"
              title="Read the brief"
              testId="open-brief"
            >
              <span>Brief</span>
            </Button>
            {detail.key === 'deployment' && <Button variant="secondary" size="sm" icon="deployment" testId="open-pipeline" onClick={() => { setBottom('pipeline'); setPane('code'); }}>View pipeline</Button>}
            {/* Maintenance's document is its change room, where the shell's
                door opens it (`opensChangeRoom`). */}
            {(detail.key !== 'maintenance' || opensChangeRoom(detail)) && (
              <Button
                href={phaseDocHref(detail)}
                variant="ghost"
                size="sm"
                icon="doc"
                ariaLabel={isTesting ? 'Planted bugs' : phaseDocLabel(detail)}
                title={isTesting ? 'Planted bugs' : phaseDocLabel(detail)}
                testId="open-document"
              >
                <span>{isTesting ? 'Planted bugs' : phaseDocLabel(detail)}</span>
              </Button>
            )}
            {/* The door to the pack's own answer, once the gate is in, as every page of the phase offers it in
                its header's Details (the review, the change request, the planted bugs, the incident drill). */}
            {solutionDoorOpen(detail) && (
              <Button href={solutionHref(detail)} variant="secondary" size="sm" icon="eye" testId="solution-open">
                Read the reference solution
              </Button>
            )}
            {isTesting && (
              <Button
                variant="secondary"
                size="sm"
                testId="header-mutants"
                disabled={busy || Boolean(submitOff)}
                reason={submitOff}
                title="Run the planted bugs (⌘⇧M)"
                onClick={() => void submitHere('bugs')}
              >
                Run the planted bugs
                <kbd className="kbd btn-kbd">⌘⇧M</kbd>
              </Button>
            )}
            {!submitLeads && submitButton}
          </>
        }
        retry={p.resetControl}
        primary={submitLeads ? submitButton : null}
      />
    );
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail, chips, running, submitting, busy, taskAwaiting, submitOff, canRunApp, preview.starting, runAppPressed, isTesting, doRun, doRunApp, doSubmit, focused, hasPr, pr, roomReference, authoredTask, state, submitLeads, place, lessons, quickCheck, p.resetControl, olderRoom],
  );

  /** Whether the results are drawn under (or instead of) the code at all. */
  const bottomShown =
    detail.key !== 'implementation' || consoleOpen || implResults || ['feedback', 'tests', 'problems', 'health'].includes(bottom);
  /*
   * The right end of the centre column's view tabs: the Code / Results switch
   * in the focused mode, and the brief and mentor switches from 1024 px up,
   * which have no row of their own there, and from 701 px while the pane
   * switcher is not drawn. From 1024 px the row is one line: where it is too narrow for its entries and the switches' words,
   * the row says so (`areaRow.compact`) and the switches drop their words.
   */
  const areaRow = useAreaRowFit();
  const stripTools = (
    <AreaRowCompact.Provider value={areaRow.compact}>
      {focused && (
        <span className="focus-switch" role="group" aria-label="Code or results">
          <button type="button" aria-pressed={!showingResults} onClick={showCode} data-testid="focus-show-code">
            Code
          </button>
          <button type="button" aria-pressed={showingResults} onClick={showResults} data-testid="focus-show-results">
            Results
          </button>
        </span>
      )}
      {(!narrowWorkspace || (!phoneWorkspace && !paneSwitcherShown)) && <WorkspacePanelControls panels={visiblePanels} onReveal={revealPanel} placement="strip" />}
    </AreaRowCompact.Provider>
  );

  // The results (the handle and the panel under the code) and the preview, placed by the centre column below.
  const previewFirst = isImplementation && implementationView !== 'preview';
  const resultsBlock = (
    <>
      {/* The split between the code and the results is the learner's to
          drag; where both floors cannot fit, the results fold to
          their tabs and this is the way to them. */}
      {bottomShown && resultsSplit.split.measured && (resultsSplit.split.collapsed ? (
        <div className="results-split-handle results-split-collapsed">
          <button type="button" onClick={showResults} data-testid="show-results">Show results</button>
        </div>
      ) : (
        <div className="results-split-handle" data-testid="results-split-handle" {...resultsSplit.handleProps} />
      ))}
      {bottomShown && bottomPanel}
    </>
  );
  const previewBlock = (
    <>
      {(previewRoom === 'section' || (previewRoom === 'view' && runtimeView === 'preview')) && appPreviewPane && <section className="implementation-app" aria-label="Running application from your saved workspace" style={previewKind === 'client' ? { height: 'auto', flex: 'none' } : undefined}><header>Running application from your saved workspace</header><div>              <PreviewPanel
            status={preview.status}
            session={preview.session}
            apiUrl={API_URL}
            url={preview.url}
            nonce={preview.nonce}
            errors={preview.errors}
            starting={preview.starting || runAppPressed}
            error={preview.error}
            unsupported={detail.previewUnsupported ?? null}
            onStart={() => void doRunApp()}
            onStop={() => void preview.stop()}
            onRefresh={preview.refresh}
            onOpenConsole={() => {
              setConsoleOpen(true);
              setBottom('console');
              // In the focused mode the results are hidden behind the
              // code: bring them forward as Submit does. On a folded split
              // the hook holds the console open under the preview instead
              // (holdOpen), so the app and its Stop button stay on screen.
              if (focused) showResults();
              setPane('code');
            }}
            // The newest save this tab knows, held in state (a save's
            // answer and an Apply's reload both move it), so the stale
            // line shows at once instead of at the next status poll.
            savedVersion={detail.workspaceUpdatedAt ?? null}
            onOpenAppView={openAppView}
          /></div></section>}
      {(previewRoom === 'section' || (previewRoom === 'view' && runtimeView === 'preview')) && previewKind === 'client' && <section className="implementation-app" aria-label="Page preview from your open files">{/* No heading of its own: the preview's first line says what it is. */}<div><ClientPagePreview files={files} liveFiles={liveFiles} /></div></section>}
    </>
  );

  return (
    <WorkPage
      crumbs={crumbs}
      nav={nav}
      testId="workspace-page"
      /* The room's one heading is the strip's, not the brief tab's, so it
         does not leave with the tab. */
      strip={strip}
    >
      {/* The same banner every other room of a passed phase draws.
          This room keeps whether the merge sheet is up, because three of its
          keyboard shortcuts stand down while it is. */}
      {/* The gate band: one slim strip, only when the gate has
          something to say, its action on the right and never the header's. */}
      {state === 'revise' || state === 'awaiting' ? (
        <ReviewBand state={state} isLast={isLast} onViewReview={hasReview ? viewReview : undefined} />
      ) : (
        <PhaseGateBanner
          phaseId={detail.id}
          phase={detail}
          isLast={isLast}
          onBeforeContinue={onBeforeContinue}
          onAdvanced={onAdvanced}
          open={showReflection}
          onOpenChange={setShowReflection}
          onViewReview={hasReview ? viewReview : undefined}
          roomTaskKey={submitLeads ? (roomTask?.key ?? '') : undefined}
        />
      )}
      {/* A link named a task this phase does not have. The room opens on the
          task the phase says the work is in, and says why it is not the one
          that was asked for.
          The second sentence is about the page, so it is only said where the
          page holds it: a phase with one task draws no list at all, and a
          stale bookmark or a phase a teacher re-cut lands exactly there. */}
      {unknownTask && (
        <div className="shrink-0 border-b-1.5 border-edge bg-surface px-4 py-2.5">
          <Notice tone="warn" testId="workspace-unknown-task">
            That task is not part of this phase. Your phase opened on the task you are working in
            {isSplit(detail.tasks) ? '; the task list below has every task this phase asks for.' : '.'}
          </Notice>
        </div>
      )}
      {conflict && (
        <div className="shrink-0 border-b-1.5 border-edge bg-surface px-4 py-2.5">
          <Notice tone="warn" testId="workspace-conflict">
            <span className="flex flex-wrap items-center gap-2.5">
              <span className="wrap">
                {conflict.recovered
                  ? 'Your last edits were retained in this browser but were not confirmed saved. Load the saved copy or keep your draft.'
                  : <>{conflict.paths.length === 1
                  ? `${recordInWords(conflict.paths[0]) ?? conflict.paths[0]} was saved somewhere else after you opened this room.`
                  : `${conflict.paths.length} files were saved somewhere else after you opened this room.`}{' '}
                Nothing of yours has been written over it, and nothing of yours is saved yet.</>}
              </span>
              <Button size="sm" variant="secondary" testId="conflict-theirs" onClick={() => void takeTheirs()}>
                Load the other copy
              </Button>
              <Button size="sm" testId="conflict-mine" onClick={() => void keepMine()}>
                Keep mine
              </Button>
            </span>
          </Notice>
        </div>
      )}
      {olderRoom && (
        <div className="shrink-0 border-b-1.5 border-edge bg-surface px-4 py-2.5">
          <Notice tone="info" testId="workspace-older-format">{olderRoom}</Notice>
        </div>
      )}
      {(error || notice) && (
        <div className="shrink-0 border-b-1.5 border-edge bg-surface px-4 py-2.5">
          <Notice tone={error ? 'fail' : 'info'} testId={error ? 'workspace-error' : 'workspace-notice'}>
            {error || notice}
          </Notice>
        </div>
      )}

      {/* On a phone the panel switches keep a row of their own; from 701 px
          they sit at the right end of the centre column's view tabs. While the pane switcher is up and
          the code pane is chosen, its Brief and Mentor stand in for the
          switches; on the Brief, Files or Mentor pane (no editor on screen)
          the switches' row is back, so Hide brief and Hide mentor stay
          reachable. */}
      {narrowWorkspace && (pane !== 'code' || (phoneWorkspace && !paneSwitcherShown)) && <WorkspacePanelControls panels={rowPanels} onReveal={revealPanel} />}

      {/* Below lg the three columns do not fit, so they become one and this
          switches between them. From lg up all three show at once. */}
      {/* Preview needs 560px, which the row cannot spare until `xl`: with the
          Preview tab selected the switcher stays out to 1280 so the pane can
          take the whole width, exactly as the explorer already steps out for
          the editor's floor. */}
      <div
        className={`workspace-pane-switcher shrink-0 border-b-1.5 border-edge bg-surface px-3 py-2 ${
          !paneSwitcherShown
            ? 'hidden'
            : previewColumn ? 'xl:hidden' : 'lg:hidden'
        }`}
      >
        <div {...paneTabs.tablistProps} className="flex gap-0.5 rounded-ctl bg-raised p-0.5">
          {panes.map(([key, label]) => (
            <button
              key={key}
              {...paneTabs.tabProps(key)}
              data-testid={`pane-${key}`}
              className={`flex-1 rounded-chip py-1.5 text-[13px] font-medium transition ${
                // Below `lg` the rail's own Preview tab is
                // the way in, four pixels above this row. Two controls with
                // the same word, side by side, meaning different things, is
                // one too many on a phone.
                key === 'preview' ? 'hidden lg:block' : ''
              } ${
                pane === key ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* The phase's tasks, in the room rather than inside the brief, which
          is collapsed below 1440px and for anyone who has ever pressed Hide
          brief. It sits here for the same reason the backlog's and the design
          board's do. Nothing at all on a phase with one task, which is every
          phase until a teacher adds a concept quiz beside its work. */}
      {/* The list and the IDE row scroll together on a phase that has a
          list. If the row were the only flexible track in a page that does
          not scroll, a long list would squeeze the editor; so the row keeps a
          floor (`workspace-room-floor`) and the stack above it scrolls away.
          A phase with one task draws neither, and adds no wrapper. */}
      <RoomStack scroll={isSplit(detail.tasks)} regionRef={roomRef}>
      <TaskPanel
        className="mx-3 mt-3 shrink-0"
        tasks={detail.tasks}
        // The room's own revision, which is newer than the detail's for the
        // whole time it is marked.
        phase={{ ...detail, lastSubmission: pickNewer(detail.lastSubmission ?? null, submission) }}
        marking={followingKeys}
        // The room this panel is drawn on: a task whose work is files is taken
        // in place, and a task belonging to the backlog, the design board or
        // the change request is a door out to it.
        roomPath={`/workspace/${detail.id}`}
        selected={selectedTask}
        onSelect={setSelectedTask}
        onLeave={onLeaveRoom}
        counts={detail.taskCounts}
      />
      {/* "Start this task over", for the task this room is
          working in, where this room is the one that task is worked in. Drawn
          only on a teacher's authored list and never on TaskTrackr, a quiz, a
          passed task or one a teacher is reviewing. */}
      <div ref={areaRef} data-active-pane={pane} data-focused={focused ? 'true' : undefined} className={`flex ${isSplit(detail.tasks) ? 'workspace-room-floor' : 'min-h-0'} flex-1 overflow-hidden phase-lab-workspace ${detail.key === 'implementation' ? 'implementation-workspace' : ''}`}>
        {/* The modes down the left: what you are looking at, rather than where
            you are in the project, that is the rail's job. No 'Jump to' and
            no 'Map' here. The top bar's Jump to is the one search box, and the
            map is the right column's own tab; a strip that repeated both would
            be a third way to say two things. */}
        <ActivityBar
          className={`phase-activity ${pane === 'code' || pane === 'files' ? 'flex' : 'hidden'} lg:flex`}
          active={
            pane === 'files'
              ? 'files'
              : previewColumn
                ? 'preview'
                : tab === 'mentor'
                  ? 'mentor'
                  : 'files'
          }
          items={[
            // Reveals the explorer rather than setting the pane it is already
            // on. Below `xl` the tree has a pane of its own; from `xl`
            // it is in the row anyway and this is where it is named.
            {
              key: 'files',
              icon: 'code',
              label: 'Files',
              onSelect: () => {
                panels.setBriefOpen(true);
                setPane('files');
                setLabLeftTab('files');
                // Between 1024 and 1280 the tree stays out of the row so the
                // editor keeps its floor, and the jump-to is what opens a file
                // there, so the button does something at every width.
                if (
                  typeof window !== 'undefined' &&
                  window.matchMedia('(min-width: 1024px) and (max-width: 1279.98px)').matches
                ) {
                  (document.querySelector('[data-testid="jump-to"]') as HTMLElement | null)?.click();
                }
              },
            },
            {
              key: 'problems',
              icon: 'bug',
              label: isTesting ? 'Failing first' : 'Problems',
              onSelect: () => { setBottom(isTesting ? 'first' : 'problems'); setConsoleOpen(true); },
            },
            {
              key: 'mentor',
              icon: 'sparkles',
              label: `Ask the ${persona.toLowerCase()}`,
              onSelect: () => {
                panels.setMentorOpen(true);
                setTab('mentor');
                setPane('panel');
              },
            },
            // The same shape as `mentor`: the tab and the pane, so
            // one press works at every width.
            ...(previewPane
              ? [
                  {
                    key: 'preview',
                    icon: 'run' as const,
                    label: 'Preview',
                    onSelect: () => {
                      setTab('preview');
                      setPane('preview');
                    },
                  },
                ]
              : []),
          ]}
        />
        {/* From `xl` only. Between 1024 and 1280 there is not room for four
            columns beside a full sidebar: 212 + 48 + 232 + 372 leaves the
            editor 160px, which is not an editor. The explorer is the column
            whose work is done elsewhere as well (the file strip above the
            code opens files, ⌘K jumps to them, and the bottom panel carries
            the same problems) so it is the one that steps out. */}
        {/* …and on its own pane below `lg`, where there is no row to step out
            of: without it a phone would have no file tree at all and could
            only reach files already open. It fills that pane, and is still the
            232px column from `xl`. */}
        <aside id={panels.briefId} data-workspace-panel="brief" hidden={!panels.briefOpen} className="phase-workspace-brief">
          {/* "Your task | Files" over the left column in every code room, Implementation included, so the
              file tree is found in one place in every phase; Implementation's row carries no Files entry. */}
          <nav className="phase-room-nav" aria-label="Phase context"><button type="button" aria-pressed={labLeftTab==='brief'} onClick={()=>{setLabLeftTab('brief');setPane('task');}}>Your task</button><button type="button" aria-pressed={labLeftTab==='files'} onClick={()=>{setLabLeftTab('files');setPane('files');}}>Files</button></nav>
          <div className="phase-workspace-context" hidden={labLeftTab !== 'brief'}>
            {/* What this task asks for, above whatever the phase's own panel
                draws: a room on an authored task is a room whose statement of
                work is the task's, and it is read here, where the phase's is
                read on every other phase. Nothing at all on the phase room's
                own task or on a phase with one task; on a split
                Implementation or Testing phase every task is read here. */}
            {taskBriefBlock}
            {/* TaskTrackr's five-task brief is true of the
                reference application only. A teacher's own application reads
                the phase's own brief, the way every other room does. */}
            {detail.key === 'implementation' && runsReferenceApplication(detail.provenance)
              ? <><ImplementationTaskPanel files={detail.files} focusedName={focusedFn?.name} onOpen={openAt} />{!authoredTask && <div className="phase-task-content max-h-[50%] shrink-0">{phaseTextBrief && <details className="phase-contract-detail"><summary>Phase requirements and review</summary>{phaseTextBrief}</details>}<MissionDetails phase={detail} detail={detail} lessons={lessons} introCard={false} /></div>}</>
              : <div ref={scrollFocusRef} className="phase-task-content"><PhaseBriefIntro phaseKey={detail.key} phaseSteps={!authoredTask}/>{!authoredTask && <MissionDetails phase={detail} detail={detail} lessons={lessons} />}<details className="phase-contract-detail"><summary>{authoredTask ? 'Task requirements and review' : 'Phase requirements and review'}</summary>{phaseTextBrief}{!authoredTask && phaseBriefBlock}{gradingGuide}</details></div>}
          </div>
          <div className="phase-workspace-files" hidden={labLeftTab !== 'files'}>{explorer}</div>
        </aside>

        {/* The editor is the only flexible track, so every fixed column beside
            it comes out of the code. 420px is the floor: below it Monaco's
            line numbers, the code and the mentor's inline notes stop fitting
            on one line. The columns above and below step down to hold it at
            1024 and at 1280; the floor is what says so out loud. */}
        <section
          className={`phase-code-surface min-h-0 min-w-0 flex-1 flex-col bg-code lg:min-w-[420px] ${
            // Preview needs 560px and the editor needs 420, which do not both
            // fit until `xl`. Below it the pane switcher decides which of the
            // two the row is showing.
            previewColumn
              ? pane === 'code'
                ? 'flex xl:flex'
                : 'hidden xl:flex'
              : pane === 'code'
                ? 'flex lg:flex'
                : 'hidden lg:flex'
          }`}
          ref={sectionRef}
          data-workspace-view={detail.key === 'implementation' ? implementationView : runtimeView}
          data-console-open={consoleOpen}
          data-focused={focused ? 'true' : undefined}
          data-focus-show={showingResults ? 'results' : 'code'}
          data-results-sized={resultsSplit.split.measured ? 'true' : undefined}
          data-results-collapsed={resultsSplit.split.collapsed ? 'true' : undefined}
          style={{ '--results-h': `${resultsSplit.split.results}px` } as React.CSSProperties}
        >
          {/* Each view button says which view it is (`data-view`, the name its document page's link carries and
              the tutorial aims at), and the row ends with its review page, as its pull request page's row does. */}
          {detail.key === 'implementation' && <nav ref={areaRow.ref} className="implementation-view-tabs" aria-label="Implementation working area">{(['code','split','preview'] as const).filter(view=>view!=='preview'||previewRoom!=='none').map(view=><button key={view} type="button" data-view={view} aria-pressed={implementationView===view&&!implResults} onClick={()=>{setImplementationView(view);setImplResults(false);if(view==='preview')setConsoleOpen(false);}}><Icon name={view==='code'?'code':view==='split'?'panel-bottom':'run'} size={14}/>{view==='preview'?previewLabel:view[0].toUpperCase()+view.slice(1)}</button>)}{/* No Files here: the file tree is the left column's Files tab, as in the other code rooms
              (`?panel=files` still opens it). */}<Link href={`/workspace/${detail.id}/pr`}><Icon name="pr" size={14}/>{AREA_REVIEW_LABEL.implementation}</Link><span className={AREA_ROW_STATUS}>Saved workspace</span>{stripTools}</nav>}
          {/* Testing and Deployment end their row with the review page their document pages' rows lead to, "Pull request". */}
          {detail.key !== 'implementation' && <nav ref={areaRow.ref} className="implementation-view-tabs runtime-view-tabs" aria-label="Phase working area">{/* Maintenance leads with its Change request, in the order the change page and the review page draw (Change request, Edit files, Execution evidence, preview, Pull request). */}{detail.key==='maintenance'&&opensChangeRoom(detail)&&<Link href={phaseDocHref(detail)}><Icon name="pr" size={14}/>{workingAreaLabels.document}</Link>}<button type="button" data-view="code" aria-pressed={runtimeView==='code'} onClick={()=>selectRuntimeView('code')}><Icon name="code" size={14}/>{workingAreaLabels.edit}</button><button type="button" data-view="evidence" aria-pressed={runtimeView==='evidence'} onClick={()=>{if(detail.key==='deployment')setBottom('pipeline');selectRuntimeView('evidence')}}><Icon name={detail.key==='deployment'?'deployment':'testing'} size={14}/>{workingAreaLabels.evidence}</button>{/* The rooms whose pack ships an app get a view that starts and shows it. */}{previewRoom==='view'&&<button type="button" data-view="preview" aria-pressed={runtimeView==='preview'} onClick={()=>selectRuntimeView('preview')}><Icon name="run" size={14}/>{previewLabel}</button>}{detail.key!=='maintenance'&&<Link href={phaseDocHref(detail)}><Icon name="doc" size={14}/>{workingAreaLabels.document}</Link>}{detail.key==='maintenance'&&<Link href={`/workspace/${detail.id}/pr`}><Icon name="pr" size={14}/>Pull request</Link>}{(detail.key==='testing'||detail.key==='deployment')&&<Link href={`/workspace/${detail.id}/pr`}><Icon name="pr" size={14}/>{AREA_REVIEW_LABEL[detail.key as PhaseKey]}</Link>}{stripTools}</nav>}
          {/* An applied proposal is announced in the centre column, under its working-area row, as the
              design room draws it in its editor column: the brief, the row and the mentor do not move. `chromeOf`
              counts it, so the split between the code and the results is measured again (`remeasure`). */}
          {appliedNote && (
            <div className="shrink-0 border-b-1.5 border-edge bg-surface px-3 py-2">
              <Notice tone="info" testId="workspace-applied-note">The reviewed proposal is saved in this workspace.</Notice>
            </div>
          )}
          <div
            {...fileTabs.tablistProps}
            ref={tabStripRef}
            className={`flex shrink-0 items-stretch overflow-x-auto border-b-1.5 border-edge bg-surface ${tabFade}`}
          >
            {/* The file you are asked to change leads, as the mockup draws it,
                then the one or two you check it against. The Explorer opens
                the rest, and each one opened joins the strip. */}
            {(openPaths
              .map((p: string) => detail.files.find((f) => f.path === p))
              .filter(Boolean) as WorkspaceFile[])
              .map((f) => {
              const on = f.path === activePath;
              return (
                <button
                  key={f.path}
                  {...fileTabs.tabProps(f.path)}
                  data-testid={`file-tab-${f.path.replace(/[/.]/g, '-')}`}
                  title={f.editable ? f.path : `${f.path} (read only)`}
                  className={`flex h-[38px] shrink-0 items-center gap-2 whitespace-nowrap border-r-1.5 border-t-2 border-r-edge px-3.5 font-mono text-[12.5px] transition ${
                    on ? 'border-t-accent bg-code text-ink' : 'border-t-transparent text-muted hover:text-ink'
                  }`}
                >
                  <TechMark name={techForPath(f.path)} size={13} />
                  {tabLabels.get(f.path) ?? f.path.split('/').pop()}
                  {!f.editable && <Icon name="lock" size={11} title="Read only" className="text-muted" />}
                </button>
              );
              })}
          </div>

          <div className="mono flex shrink-0 items-center gap-1.5 border-b-1.5 border-edge px-3.5 py-1.5 text-[11.5px] text-muted">
            {breadcrumb(activePath, focusedFn).map((c: string, i: number, all: string[]) => (
              <span key={`${c}-${i}`} className="inline-flex items-center gap-1.5">
                <span className={i === all.length - 1 ? 'text-ink2' : ''}>{c}</span>
                {i < all.length - 1 && <Icon name="chevron-right" size={10} className="text-dim" />}
              </span>
            ))}
          </div>

          <div
            className="min-h-0 min-w-0 flex-1"
            data-testid="editor-host"
            role="tabpanel"
            id="workspace-editor-panel"
            aria-labelledby={fileTabs.tabId(activePath)}
          >
            {activeFile && (
              <Editor
                appearance="graphite"
                path={activeFile.path}
                // The buffer, not the committed copy: `files` catches up when
                // the autosave fires, and Monaco must never be handed text
                // older than what it is showing.
                value={editorText}
                language={activeFile.language}
                readOnly={!activeFile.editable || agentBusy}
                onChange={(v: string) => onEdit(activeFile.path, v)}
                notes={notes}
                markers={markers}
                onCursor={(line: number, col: number) => setCursor({ line, col })}
                focusLine={focusLine}
                restore={restore}
                onScroll={onEditorScroll}
                revealOnce={revealApplied}
                onRevealed={onRevealedApplied}
              />
            )}
          </div>

          {/* Split draws the code, then the page preview, then the results (its icon draws the code over the
              preview), and the page holds them in that order too, so the reading order and Tab order follow what
              is seen (WCAG 2.4.3). The Page preview view keeps its console above the preview.
              Three fixed places, not a reordered list: the preview always sits in the middle one, so a switch
              between Code, Split and Page preview never moves or remounts it (a frame that is moved in the page
              reloads and loses what the learner did in it); only the results change place. Code view does not draw
              the preview (display:none), so Code and Split share one order. */}
          {!previewFirst && resultsBlock}
          {previewBlock}
          {previewFirst && resultsBlock}
          {detail.key === 'implementation' && <footer className="implementation-console-bar"><span>{running ? 'Tests are running…' : run ? 'Execution result available' : 'No tests run this visit'}</span><button type="button" aria-expanded={consoleOpen} onClick={()=>{setConsoleOpen(!consoleOpen);setBottom('console')}}><Icon name="terminal" size={14}/>Console</button><button type="button" onClick={()=>{setConsoleOpen(true);void doRun()}} disabled={running}><Icon name="run" size={14}/>{runWord}</button></footer>}
        </section>

        {/* Full width on a phone (the pane switcher decides which pane shows),
            then a column that widens with the room: 320 beside the editor
            alone, 352 once the explorer is back at 1280, and the design's own
            372 from 1536. */}
        <aside
          id={panels.mentorId}
          data-workspace-panel="mentor"
          hidden={!panels.mentorOpen}
          className={`min-h-0 w-full shrink-0 flex-col border-l-1.5 border-edge bg-surface ${
            // An app in a 320px pane is not a preview. From `xl` the column is
            // 560, and below it the preview takes the whole row rather than
            // squeezing the editor under its floor.
            previewColumn
              ? 'lg:w-auto lg:min-w-0 lg:flex-1 xl:w-[560px] xl:flex-none 2xl:w-[640px]'
              : 'lg:flex lg:w-[320px] xl:w-[352px] 2xl:w-[372px]'
          } ${
            pane === 'code' || pane === 'files' || pane === 'task'
              ? previewColumn
                ? 'hidden xl:flex'
                : 'hidden lg:flex'
              : 'flex'
          }`}
        >
          <WorkspaceMentorBoundary panels={panels} onExpand={() => { setTab('mentor'); setPane('panel'); }}><MentorSession thread={personaThread} /></WorkspaceMentorBoundary>
        </aside>
      </div>
      </RoomStack>

      <CaretStatusBar
        caret={caret}
        // The save state and the result read at 12 px.
        className="text-[12px]!"
        branch="main"
        live={!socketPaused}
        language={languageLabel(activeFile?.language)}
        problems={problems.length}
        hidden={statusRight}
        // The day the tests are run on, in words: the pinned date, or today's.
        clock={isTesting ? (runClock ? `Tests dated ${clockWords(runClock)}` : "Tests use today's date") : undefined}
        saveState={saveLabel}
        savedAt={savedAt}
      />

      {/* The IDE's tour, once: files, editor, Run tests, the
          reviewer, Submit. Mounted in the live frame only. */}
    </WorkPage>
  );
}
