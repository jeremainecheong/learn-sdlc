'use client';
import { sameSession } from '@/lib/session-token';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { MessagesSquare, ListTree } from 'lucide-react';
import type { PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { holdsPhase, isLastPhase, placeLabel } from '@learnsdlc/shared';
import { api, describeError, getStoredUser, getToken } from '@/lib/api';
import { workspaceApi } from '@/lib/api-workspace';
import { useRecoverWhenBack } from '@/lib/poll';
import { setActiveProject } from '@/lib/project';
import { railOf } from '@/lib/rail';
import { fullDetail, invalidateProject, useProject } from '@/lib/useProject';
import { statusState } from '@/lib/phase';
import { lessonsOfferedOn, useInterviewAbsent, useReferenceScaffolding } from '@/lib/scenario';
import { projectName } from '@/lib/project-name';
import { PersonaPanel, WorkPage } from '@/components/shell';
import { Button, Chip, Notice } from '@/components/ui';
import { AWAITING_SIGN_OFF, SIGN_OFF_SUBMIT_REASON, SIGN_OFF_TONE, awaitingSignOff, inFlightAgesOutIn, pendingRevision } from '../signoff-status';
import { PlainText } from '@/components/PlainText';
import { PhaseGateBanner } from '../PhaseGateBanner';
// The band's own rule for a phase the learner has left, read for the interview tab's word.
import { movedOnFrom } from '../PhaseGateBanner';
import { PhaseHeader } from '../PhaseHeader';
import { STATE_LABEL, STATE_TONE, isCredited, learnerState, phasePlace } from '../gate-state';
import { useClaimedQuickCheck } from '../QuickCheck';
import { FeedbackPanel } from '../FeedbackPanel';
import { IssueDesk, IssueDialog } from '../panels/requirements/IssueDesk';
import { STORY_JSON, serialiseStory, type Story } from '../panels/requirements/story';
import { clearTouched } from '../panels/requirements/touched';
import { OLDER_FORMAT_SENTENCE, useStoryFrom } from '../panels/requirements/useStory';
import { RoomFallback } from '../panels/RoomFallback';
import { PhaseBriefIntro } from '../PhaseBriefIntro';
import { TaskPanel, isSplit, submitArgs, taskForPath } from '../TaskPanel';
import { phaseHasPr, phaseSubmitLabel, submitLeads } from '../HeaderSubmit';
import { TaskResetControl } from '../TaskResetControl';
import { Checklist, interviewStoryName } from '../interview/Checklist';
import { useAgentWorkspace } from '../mentor/useAgentWorkspace';
import { useWorkspacePanels, WorkspacePanelControls, WorkspaceMentorBoundary } from '../WorkspacePanels';
import { useInterview } from './useInterview';
import { InterviewPanel } from './InterviewPanel';
import { useRequirementsSave } from './useRequirementsSave';
import { latestSubmission, reviewPending, useRequirementsReview } from './useRequirementsReview';
import { SaveConflictDialog } from './SaveConflictDialog';
import { ReviewSteps } from '@/components/workspace/ReviewSteps';
import './requirements-workspace.css';

const HEADLINE = 'Write US-4, the overdue report, with criteria a test can check';
/**
 * The headline above is the reference story's. A phase whose scenario is the
 * teacher's reads this one.
 */
const NEUTRAL_HEADLINE = 'Write your story, with criteria a test can check';

/** The room's headline, for a phase that is or is not the reference project's scenario. */
export function requirementsHeadline(reference: boolean): string {
  return reference ? HEADLINE : NEUTRAL_HEADLINE;
}

function RequirementsTabLabel({ children }: { children: string }) {
  return <span className="requirements-tab-label"><span aria-hidden="true" className="requirements-tab-size">{children}</span><span>{children}</span></span>;
}

/**
 * The one word beside a control that says whether the learner must use it:
 * the interview is where the story's evidence comes from, the mentor
 * is optional help. Drawn as the task list's own Required / Optional chip so
 * the room uses one vocabulary. The word is the control's description, not
 * part of its name, so "Stakeholder interview" and "Show mentor" stay the
 * names a screen reader, a voice command and every harness use.
 */
export function RequirementsQualifier({ id, tone, children }: { id: string; tone: 'accent' | 'outline'; children: string }) {
  return <span id={id} aria-hidden="true" className={`chip ${tone === 'accent' ? 'chip-accent' : 'chip-outline'} requirements-qualifier`} data-testid={id}>{children}</span>;
}

/**
 * The word an issue uses for where it stands, which is not the phase list's word.
 *
 * Not the **phase's** status: `submitted` is also where a failed verdict leaves
 * a phase; so the chip would say IN REVIEW beside a Needs revision strip, and
 * on a split phase it would follow siblings the story is not. It reads the
 * story's own task, and the revision the room is holding says whether a
 * review is still running or has landed without a Pass.
 *
 * `submitted` is also where a **passing** review leaves a
 * task the teacher must countersign (`awaitingSignOff`), and the next phase
 * stays shut until they do. That story is not to be revised: it reads the
 * countersignature wording, unless a newer revision is being marked. Without the third
 * argument every answer is the two-argument one.
 *
 * A passed story reads in the state words of `gate-state.ts`: "Review
 * passed", or, where the gate's `evidenceNeeded` says the pass is a teacher's
 * credit with no reviewed pass behind it (`credited`), "Credit awarded, review
 * still needed", never "Approved" over a review that came back Needs revision.
 *
 * "Review passed" is said only where the gate's answer is held, which is only
 * on a passed phase (`phasePassed`, the phase's own status). Inside a split
 * phase still in progress, the teacher's per-task sign-off can pass the story
 * with no review behind it and nothing on the payload tells the two apart, so
 * the story reads the neutral "Passed", as its task row does (TaskPanel's
 * statusWord). Without the fifth argument the phase is taken as not passed.
 */
export function storyStatusLabel(
  status: PhaseDetail['status'],
  latest?: Pick<SubmissionView, 'status' | 'passed'> | null,
  awaitingSignOff?: boolean,
  credited?: boolean,
  phasePassed = false,
): string {
  switch (status) {
    case 'passed':
      if (credited) return STATE_LABEL.credited;
      return phasePassed ? STATE_LABEL.reviewPassed : 'Passed';
    case 'locked':
      return 'Locked';
    default:
      if (latest && (latest.status === 'queued' || latest.status === 'running')) return 'In review';
      if (latest && latest.status === 'completed' && latest.passed === false) return 'Needs revision';
      if (awaitingSignOff) return AWAITING_SIGN_OFF;
      // `submitted` is where a verdict leaves a task it did not pass; handing a
      // revision in moves no task row. With no revision in the room to say one
      // is being marked, the last word known to be true is the verdict's.
      return status === 'submitted' ? 'Needs revision' : 'In progress';
  }
}

/** What the page says after an Agentic Apply, in the words and the place Design uses. */
export const APPLIED_NOTICE = 'The reviewed proposal is saved in this workspace.';

/** "Check the story"'s answer, in the form of Design's "Design checked: 9 of 9 checks pass.". */
export function storyCheckedNotice(passing: number, total: number): string {
  return total > 0 ? `Story checked: ${passing} of ${total} ${total === 1 ? 'check passes' : 'checks pass'}.` : 'Your story is saved.';
}

/**
 * The story's state chip in the tones the header's state chip uses for the
 * same words (`STATE_TONE` in gate-state.ts), so one state is one chip in the
 * header, on the backlog row and in the story dialog: a
 * teacher's credit, a pass, a pass waiting on the countersignature, "Needs
 * revision" as the header's accent, and every other word ("In progress",
 * "In review", "Locked") outlined.
 */
export function storyStatusTone(label: string, state: { credited: boolean; passed: boolean; awaiting: boolean }): 'accent' | 'pass' | 'warn' | 'neutral' | 'outline' {
  if (state.credited) return STATE_TONE.credited as 'warn';
  if (state.passed) return 'pass';
  if (state.awaiting) return SIGN_OFF_TONE;
  return label === STATE_LABEL.revise ? STATE_TONE.revise as 'accent' : STATE_TONE.inProgress as 'outline';
}

/**
 * The footer's save state, in the words and the clock Design's footer uses
 * ("Saving", "Unsaved", "Saved 11:02"), so the two rooms say one thing there.
 */
export function SaveState({ saving, dirty, savedVersion }: { saving: boolean; dirty: boolean; savedVersion?: string | null }) {
  return <>
    <span className="label-sm" data-testid="save-state">{saving ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}</span>
    {savedVersion && <span className="label-sm">{new Date(savedVersion).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
  </>;
}

/**
 * Which pane the room opens: the backlog on `/issue` or `?tab=phase`, else the
 * interview; and always the backlog when the phase holds no interview (the
 * tab is hidden when the stakeholder is null).
 */
export function requirementsPane(pathname: string, tab: string | null, noInterview: boolean): 'interview' | 'backlog' {
  if (noInterview) return 'backlog';
  return pathname.endsWith('/issue') || tab === 'phase' ? 'backlog' : 'interview';
}

/** The room's two tabs, or its one when the phase holds no interview. */
export function RequirementsTabs({ base, active, noInterview, movedOn = false, onKeyDown, onSelect }: {
  base: string;
  active: 'interview' | 'backlog';
  noInterview: boolean;
  /**
   * The phase is passed and the learner has already continued past
   * it (or completed the project). "Required" beside the interview would read
   * as a demand still open on a phase that is finished, so the word and the
   * description that names it are left out; the tab keeps its name, id, place
   * and address. Absent or false, the tabs are exactly what they were.
   */
  movedOn?: boolean;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onSelect: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  return <nav role="tablist" aria-label="Requirements workspace" className="requirements-tabs" onKeyDown={onKeyDown}>
    {!noInterview && <Link role="tab" id="requirements-interview-tab" aria-describedby={movedOn ? undefined : 'requirements-interview-required'} aria-selected={active === 'interview'} aria-controls="requirements-interview-panel" tabIndex={active === 'interview' ? 0 : -1} href={`${base}/interview`} scroll={false} onClick={onSelect}><MessagesSquare size={16} /><RequirementsTabLabel>Stakeholder interview</RequirementsTabLabel>{!movedOn && <RequirementsQualifier id="requirements-interview-required" tone="accent">Required</RequirementsQualifier>}</Link>}
    <Link role="tab" id="requirements-backlog-tab" aria-selected={active === 'backlog'} aria-controls="requirements-backlog-panel" tabIndex={active === 'backlog' ? 0 : -1} href={`${base}/issue`} scroll={false} onClick={onSelect}><ListTree size={16} /><RequirementsTabLabel>My backlog</RequirementsTabLabel></Link>
  </nav>;
}

/**
 * The "Saved Requirements evidence" dialog's body: one workspace file, named
 * and shown. A `.md` file is drawn like any other file, as its characters:
 * a teacher mounted it or a learner wrote it, and neither is
 * model output, so nothing in it is interpreted.
 */
export function SavedEvidenceFile({ path, text }: { path: string; text: string | undefined }) {
  return <div className="requirements-reference-document"><p>{path}</p>{text !== undefined ? <pre>{text}</pre> : <p>This file is not part of your Requirements workspace.</p>}</div>;
}

export function RequirementsWorkspace({ phaseId }: { phaseId: string }) {
  const panels = useWorkspacePanels();
  const roomRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const search = useSearchParams();
  const noInterview = useInterviewAbsent(phaseId);
  const active = requirementsPane(pathname, search.get('tab'), noInterview);
  const reference = useReferenceScaffolding('requirements');
  const interview = useInterview(phaseId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [briefTab, setBriefTab] = useState<'brief' | 'evidence'>('brief');
  const referenceFile = search.get('file');
  const router = useRouter();
  const { details, enrollment, analytics, currentPhase } = useProject();

  // What the shell already holds about this phase: the page opens on it and
  // refreshes behind the drawn page, so nothing here waits on the network.
  const seed = fullDetail(details, phaseId);
  const [fetched, setFetched] = useState<PhaseDetail | null>(null);
  usePhaseTutorialReady(fetched);
  const detail = fetched ?? seed ?? null;
  const { files, setFile, flushSave, saveError, saving, dirty, savedVersion, conflict, resolveConflict, currentVersion, adoptReset } = useRequirementsSave(phaseId, detail);
  const [showConflict, setShowConflict] = useState(false);
  const [submission, setSubmission] = useState<SubmissionView | null>(seed?.lastSubmission ?? null);
  const [starting, setStarting] = useState(false);
  // The review that holds Submit, by the code rooms' and Design's rule
  // (`revisionInFlight` is `pendingRevision(...) !== null`): the story's newest
  // revision while it is queued or running and inside the API's age-out
  // window. One past the window holds nothing, so the next Submit reaches the
  // API, which is what writes it off (or answers with it, where it is still alive).
  const heldReview = pendingRevision(submission, taskForPath(detail?.tasks, STORY_JSON)?.key, detail?.lastSubmission ?? null);
  const busy = starting || heldReview !== null;
  // The room draws again the moment the held review leaves the window, so
  // Submit comes back on its own, as the change room's watch ends there.
  const heldId = heldReview?.id;
  const heldSince = heldReview?.createdAt;
  const [, setAgedOut] = useState(0);
  useEffect(() => {
    if (!heldId || !heldSince) return;
    const timer = setTimeout(() => setAgedOut((n) => n + 1), inFlightAgesOutIn({ createdAt: heldSince }));
    return () => clearTimeout(timer);
  }, [heldId, heldSince]);
  const startingRef = useRef(false);
  const [pendingDialogDraft, setPendingDialogDraft] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, [phaseId]);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // The recovery loop: while the room is showing a failure it picks the
  // connection back up on its own, so a learner who reconnects does not have
  // to think about it.
  useRecoverWhenBack(Boolean(error) && !detail, retry);

  const load = useCallback(async () => {
    const owner = getToken();
    const d = await workspaceApi.phase(phaseId);
    if (!alive.current || !sameSession(getToken(), owner)) return;
    setActiveProject(d.projectSlug);
    setFetched(d);
    setSubmission((prev) => latestSubmission(prev, d.lastSubmission));
  }, [phaseId]);

  useEffect(() => {
    setError('');
    // `e.message` is whatever fetch rejected with: "Failed to fetch" is the
    // browser talking to itself. The room says it in the product's voice, and
    // `attempt` is what the Try again control moves.
    load().catch((e: unknown) =>
      setError(describeError(e, 'The issue could not be loaded. Try again.')),
    );
  }, [load, attempt]);

  const prepareAgent = useCallback(async () => {
    if (pendingDialogDraft) throw new Error('Save or cancel your open story or epic draft in My backlog before asking the mentor to change your work.');
    if (startingRef.current) throw new Error('Wait for your submission to be saved before starting an agentic operation.');
    await flushSave();
  }, [flushSave, pendingDialogDraft]);
  // An applied proposal is announced as Design announces one: the
  // saved workspace is read again, the page says so in its notice place, and
  // the room turns to the backlog, where the story the proposal wrote is.
  const base = `/workspace/${phaseId}`;
  const showBacklog = active !== 'backlog';
  const refreshApplied = useCallback(async () => {
    await load();
    if (!alive.current) return;
    setError('');
    setReviewOpen(false);
    setNotice(APPLIED_NOTICE);
    if (showBacklog) router.push(`${base}/issue`, { scroll: false });
  }, [load, showBacklog, router, base]);
  const agentBusy = useAgentWorkspace(phaseId, prepareAgent, refreshApplied);
  // Followed only while it holds Submit: a review past the age-out window is
  // not polled for ever; the next Submit writes it off and the new one is followed.
  const reviewConnectionError = useRequirementsReview(heldReview ? submission : null, result => setSubmission(previous => latestSubmission(previous, result)), () => {
    void load().catch((err: unknown) => { if (alive.current) setError(describeError(err, 'The review finished, but the phase could not refresh. Try again.')); });
    invalidateProject();
  });


  // The record is the story: the form reads it, writes it, and the review
  // grades it. A phase with no story spec still holds markdown, which this
  // room neither reads nor writes.
  const spec = detail?.story;
  const view = useStoryFrom(files[STORY_JSON] ?? '', spec);
  const setStory = useCallback((next: Story) => setFile(STORY_JSON, serialiseStory(next)), [setFile]);

  /** Save the record and open the Review view, where the checks read it. */
  const checkStory = useCallback(async () => {
    if (!spec || checking || busy || agentBusy || pendingDialogDraft || !view.started) return;
    setChecking(true);
    setError('');
    setReviewOpen(true);
    // The answer is said as Design's "Check the design" says it: how many of
    // the checks the saved story passes, counted from the rows the Review
    // view draws for the story being saved.
    const passing = view.results.filter((result) => result.passed).length;
    const total = view.results.length;
    try {
      await flushSave();
      setNotice(storyCheckedNotice(passing, total));
    } catch {
      setError('Your story did not save. Check your connection and try again.');
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [spec, checking, busy, agentBusy, pendingDialogDraft, flushSave, view.started, view.results]);

  const submit = useCallback(async () => {
    if (!spec || busy || checking || agentBusy || pendingDialogDraft || startingRef.current) return;
    const owner = getToken();
    const current = () => alive.current && sameSession(getToken(), owner);
    startingRef.current = true;
    setStarting(true);
    setError('');
    setNotice('');
    try {
      await flushSave();
    } catch {
      if (current()) { setError('Your last edits did not save, so the review was not started. Try again.'); setStarting(false); }
      startingRef.current = false;
      return;
    }
    if (!current()) { startingRef.current = false; return; }
    let started: SubmissionView;
    try {
      // Which task this revision answers: the one that owns the story this
      // room writes. A phase with one task is submitted with the plain phase
      // arguments.
      started = await api.submit(
        ...submitArgs(phaseId, undefined, detail?.tasks, taskForPath(detail?.tasks, STORY_JSON)?.key),
      );
    } catch (err) {
      if (current()) { setError(describeError(err, 'The review could not be started. Try again.')); setStarting(false); }
      startingRef.current = false;
      return;
    }
    if (!current()) { startingRef.current = false; return; }
    // A submitted story is the learner's: the marks of fields the assistant wrote end here.
    clearTouched(phaseId);
    setSubmission(started);
    setReviewOpen(true);
    startingRef.current = false;
    setStarting(false);
    if (!reviewPending(started)) { void load().catch(() => undefined); invalidateProject(); }
  }, [spec, busy, checking, agentBusy, pendingDialogDraft, flushSave, load, phaseId, detail?.tasks]);

  // What this room settles before it hands the learner on. The reflection,
  // the advance and the next phase's door belong to the shared banner, which
  // every room of a passed phase mounts.
  const continueGuard = useCallback(async () => {
    if (agentBusy || pendingDialogDraft) throw new Error('Finish the mentor operation and save or cancel your backlog draft before continuing.');
    await flushSave();
  }, [agentBusy, pendingDialogDraft, flushSave]);
  // Set when the band's Continue is pressed in this room. The advance's answer reaches the shell's
  // enrolment a moment before the router leaves, and the tabs must not drop their "Required" in that moment: the room
  // that pressed Continue stays as it was until the next one replaces it (as the band does).
  const [continuing, setContinuing] = useState(false);
  const bandContinueGuard = useCallback(async () => {
    setContinuing(true);
    await continueGuard();
  }, [continueGuard]);
  // A Continue that did not go ahead leaves the enrolment as it was: the hold is let go with the band's.
  const bandContinueFailed = useCallback(() => setContinuing(false), []);

  // Shortcuts act only on the visible backlog, never on a hidden pane or dialog.
  const actions = useRef({ check: checkStory, submit });
  actions.current = { check: checkStory, submit };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (active !== 'backlog' || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      if (workspaceShortcutBlocked(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) void actions.current.check();
      else void actions.current.submit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);


  const nav = railOf(enrollment, analytics, currentPhase);
  const summary = detail ?? enrollment?.phases.find(phase => phase.id === phaseId);
  // The name is the learner's project's, read from the enrolment; with none
  // known yet it is no project's in particular. Then the phase and the room, as
  // Design's crumbs read: "<project> › Requirements › Requirements workspace".
  const crumbs = [
    { label: projectName(enrollment?.projectTitle) || 'Your project', href: '/dashboard', testId: 'back-dashboard' },
    { label: 'Requirements', href: '/phases?phase=requirements' },
    { label: 'Requirements workspace' },
  ];
  const passed = detail?.status === 'passed';
  // The learner has left this passed phase (the band's own rule, `movedOnFrom`), and not by a Continue
  // pressed in this very room a moment ago.
  const movedOn = passed && !continuing && movedOnFrom(enrollment ?? null, phaseId) !== null;
  // On a phase the learner has left, the footer's Check the story and Submit again are quiet (ghost):
  // still there and still pressable, not two framed buttons under the "moved on" band. A learner still on the
  // phase sees the framed footer.
  const footerQuiet = movedOn;
  const verdictFailed = submission?.status === 'completed' && submission.passed === false;
  // Where the story stands is its own task's state on a split phase. On a
  // phase with one task the task is the phase, so nothing about that reads
  // differently; the revision is this room's own either way: it is the story's.
  const storyTask = isSplit(detail?.tasks) ? taskForPath(detail?.tasks, STORY_JSON) : undefined;
  const storyStatus = storyTask?.status ?? detail?.status ?? 'in_progress';
  const storyPassed = storyStatus === 'passed';
  const storyLatest = !storyTask || !submission?.taskKey || submission.taskKey === storyTask.key ? submission : null;
  // The story's task (or the phase's one task) passed its review and
  // waits on the teacher's countersignature. Nothing is to be revised, so
  // nothing is handed in either: not by the button, not by ⌘↵ (a resubmit
  // costs a review). The shortcut reads `actions`, so it is closed here too.
  // The held revision counts too: a verdict that has just landed waits before
  // the reload brings the task's flag.
  const storyAwaiting = !storyPassed && awaitingSignOff(detail, storyTask?.key, storyLatest);
  // A story passed on the board by a teacher's credit, with no reviewed
  // pass behind it, reads as credit, from the gate band's own source.
  const storyCredited = storyPassed && isCredited(phaseId, detail, storyTask?.key);
  if (storyAwaiting) actions.current = { ...actions.current, submit: async () => undefined };
  const storyLabel = storyStatusLabel(storyStatus, storyLatest, storyAwaiting, storyCredited, detail?.status === 'passed');
  // The room's one header row, as the code rooms draw it: the phase's
  // place, one state chip in the words of `gate-state.ts`, the quick check
  // inline, and every other door (Replay tutorial, the phase guide, Start
  // this task over) in its More menu.
  const quickCheck = useClaimedQuickCheck();
  const roomState = detail ? learnerState(phaseId, detail, { awaiting: storyAwaiting, verdict: storyLatest, task: storyTask ?? null }) : null;
  // The footer's Submit by the code rooms' rule. It is the primary button while there is
  // work to hand in (`submitLeads`, read from the state the header's chip says), secondary once the review passed or the
  // countersignature is awaited, so it never stands primary under the band's Continue; and it reads "Submit again" once
  // a submission exists (the phase's own record, or the one this room holds before the phase is read again).
  const submitPrimary = submitLeads(roomState);
  const submitLabel = phaseSubmitLabel({ key: 'requirements', place: detail?.place }, phaseHasPr(detail) || Boolean(storyLatest));
  const place = phasePlace(detail?.place, detail?.count)
    ?? (enrollment && holdsPhase(enrollment, 'requirements') ? placeLabel(enrollment, 'requirements') : null);
  const requestedMentor = search.get('tab') === 'mentor';
  const legacyBrief = pathname.endsWith('/brief');
  useEffect(() => { if (requestedMentor) panels.setMentorOpen(true); }, [requestedMentor, panels.setMentorOpen]);
  useEffect(() => { if (legacyBrief) panels.setBriefOpen(true); }, [legacyBrief, panels.setBriefOpen]);

  const revealSelectedPane = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const room = roomRef.current;
    const center = centerRef.current;
    if (!room || !center || getComputedStyle(room).flexDirection !== 'column') return;
    // A deliberate pane selection should leave the stacked mentor region.
    // Scroll only the outer room: preserve pane reading position and tab focus.
    const top = room.scrollTop + center.getBoundingClientRect().top - room.getBoundingClientRect().top - room.clientTop;
    room.scrollTo({ top, behavior: 'instant' });
  };
  const tabKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('[role="tab"]'));
    const next = tabs.length < 2 ? 0 : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : active === 'interview' ? 1 : 0;
    tabs[next]?.focus(); tabs[next]?.click();
  };
  const reviewContent = submission ? (
    submission.status === 'completed' && submission.report ? <FeedbackPanel submission={submission} tasks={detail?.tasks} floors={detail} isLast={Boolean(enrollment && detail && isLastPhase(enrollment, detail.key))} /> :
      <><Notice tone={submission.status === 'failed' ? 'fail' : 'info'}>{submission.status === 'failed' ? submission.error || 'The review could not complete. Revise or retry; no Pass was awarded.' : submission.status === 'completed' ? 'This review has no feedback evidence. No new Pass can be awarded from it.' : reviewConnectionError || 'Your requirements review is running. You can continue the interview while it finishes.'}</Notice>
      <ReviewSteps kind={detail?.artifactKind} status={submission.status} since={submission.createdAt} /></>
  ) : <p className="requirements-review-empty">No review yet. Submit your saved story for an evidence-based Pass or Needs revision.</p>;

  return <WorkPage crumbs={crumbs} nav={nav} testId="requirements-workspace"
    strip={<PhaseHeader phase={summary ?? { key: 'requirements', title: 'Requirements' }} place={place}
      state={roomState === 'ready' ? 'reviewPassed' : roomState} quickCheck={quickCheck}
      lessons={lessonsOfferedOn(enrollment, 'requirements', details)} headline={requirementsHeadline(reference)}
      chips={<Chip tone="neutral">Discover → define → review</Chip>}
      retry={<TaskResetControl phaseId={phaseId} tasks={detail?.tasks} task={taskForPath(detail?.tasks, STORY_JSON)}
        phaseStatus={detail?.status} prepare={flushSave} baseVersion={currentVersion}
        onReset={async (result, plan) => { clearTouched(phaseId); adoptReset(result.version, [...plan.restores, ...plan.reseeds]); invalidateProject(); await load().catch(() => undefined); }}
        onConflict={() => load().catch(() => undefined)} />} />}>
    {/* The shared chrome, as in the other five rooms. `requirements-gate`
        sizes its type at 11px for the needs-revision line below; over the
        shared banner it would only shrink the heading. */}
    <PhaseGateBanner phaseId={phaseId} phase={detail}
      isLast={Boolean(enrollment && detail && isLastPhase(enrollment, detail.key))} onBeforeContinue={bandContinueGuard}
      onContinueFailed={bandContinueFailed} />
    {!passed && verdictFailed && <div className="requirements-gate requirements-needs-revision" data-testid="review-strip"><div><strong>Needs revision</strong><p>Open the backlog’s Review view for the specific feedback, then revise and resubmit.</p></div></div>}
    <div className="requirements-toolbar">
      <RequirementsTabs base={base} active={active} noInterview={noInterview} movedOn={movedOn} onKeyDown={tabKey} onSelect={revealSelectedPane} />
      <WorkspacePanelControls panels={panels} mentorNote="Optional" />
    </div>
    {/* Where a teacher has split Requirements: which task this backlog belongs
        to, where its siblings have got to, and the door into each of them. It
        sits in the room rather than inside the case file, which is collapsed
        below 1440px: a learner whose phase has three tasks must be able to see
        that it has three without opening anything. Nothing at all on a phase
        with one task, which is every phase until a teacher splits one. */}
    {/* One row, opened on a press, so the backlog keeps the height.
        `evidenceNeeded` is the gate's own answer, so a credited task reads as
        credit here exactly as in the band above. "Start this task
        over" is in the header's More menu. */}
    <TaskPanel compact className="mx-3 my-1.5 shrink-0" tasks={detail?.tasks} phase={summary ? { id: phaseId, key: 'requirements', status: summary.status, evidenceNeeded: detail?.evidenceNeeded, lastSubmission: latestSubmission(detail?.lastSubmission ?? null, submission) } : undefined}
      selected={taskForPath(detail?.tasks, STORY_JSON)?.key ?? null} counts={detail?.taskCounts} onLeave={continueGuard} />
    {saveError && <div className="shrink-0 p-3"><Notice tone="fail">{saveError}{conflict ? <button type="button" className="ml-3 underline" onClick={() => setShowConflict(true)}>Compare versions</button> : <button type="button" className="ml-3 underline" disabled={saving} onClick={() => void flushSave().catch(() => undefined)}>Retry save</button>}</Notice></div>}
    <div ref={roomRef} className="requirements-workspace-room">
      <aside id={panels.briefId} data-workspace-panel="brief" hidden={!panels.briefOpen} className="requirements-shared-brief" aria-label="Requirements case file">
        <nav className="requirements-reference-tabs" aria-label="Case file sections"><button type="button" aria-pressed={briefTab === 'brief'} onClick={() => setBriefTab('brief')}>Brief</button>{!noInterview && <button type="button" aria-pressed={briefTab === 'evidence'} onClick={() => setBriefTab('evidence')}>Interview evidence</button>}</nav>
        <div hidden={briefTab !== 'brief'}><PhaseBriefIntro phaseKey="requirements" />
          {detail && <details className="requirements-full-brief"><summary>Full project brief and deliverables</summary><PlainText className="text-[12px] leading-[1.65] text-ink2" text={detail.taskPanel} commentsHidden /></details>}</div>
        <div hidden={briefTab !== 'evidence'}>{interview.state ? <Checklist facts={interview.state.facts} factsExpected={interview.state.factsExpected} issueHref={`${base}/issue`} story={interviewStoryName(files[STORY_JSON])} /> : <p className="p-4 text-sm">The stakeholder’s topics will appear when the interview opens.</p>}</div>
      </aside>
      <section ref={centerRef} className="requirements-workspace-center">
        {!noInterview && <div id="requirements-interview-panel" role="tabpanel" aria-labelledby="requirements-interview-tab" data-testid="requirements-interview-panel" className="requirements-pane" hidden={active !== 'interview'}><InterviewPanel interview={interview} backlogHref={`${base}/issue`} /></div>}
        <div id="requirements-backlog-panel" role="tabpanel" aria-labelledby="requirements-backlog-tab" data-testid="requirements-backlog-panel" className="requirements-pane" hidden={active !== 'backlog'}>
          {(error || notice) && <div className="shrink-0 p-3"><Notice tone={error ? 'fail' : 'info'}>{error || notice}</Notice></div>}
          {!detail ? <RoomFallback room="issue" error={error} onRetry={retry} /> : !spec ? <div className="shrink-0 p-3"><Notice tone="info" testId="phase-requirements-older-format">{OLDER_FORMAT_SENTENCE}</Notice></div> : <IssueDesk
            phaseId={phaseId} embedded active={active === 'backlog'} disabled={agentBusy} onPendingDraftChange={setPendingDialogDraft}
            view={view} spec={spec} providedStories={spec.providedStories}
            projectTitle={projectName(enrollment?.projectTitle) || 'Your project'}
            statusLabel={storyLabel} statusTone={storyStatusTone(storyLabel, { credited: storyCredited, passed: storyPassed, awaiting: storyAwaiting })}
            saveState={<SaveState saving={saving} dirty={dirty} savedVersion={savedVersion} />}
            storyState={statusState(detail.status, true)} assignedTo={getStoredUser()?.displayName || 'you'}
            canRecord={view.canRecord && detail.files.some(file => file.path === STORY_JSON && file.editable)}
            setStory={setStory} reviewOpen={reviewOpen} onReviewOpenChange={setReviewOpen} reviewContent={reviewContent}
            footerRight={<div className="flex flex-wrap items-center gap-2">
              <Button variant={footerQuiet ? 'ghost' : 'secondary'} size="sm" keys="⌘⇧↵" testId="phase-requirements-render" busy={checking} busyLabel="Checking" disabled={!view.started || agentBusy || busy || pendingDialogDraft} reason="Save a story first, then check its structure." onClick={checkStory}>Check the story</Button>
              <Button size="sm" variant={footerQuiet ? 'ghost' : submitPrimary ? undefined : 'secondary'} keys="⌘↵" testId="phase-requirements-submit" busy={busy} busyLabel="In review" disabled={storyAwaiting || agentBusy || checking || pendingDialogDraft} reason={storyAwaiting ? SIGN_OFF_SUBMIT_REASON : undefined} onClick={submit}>{submitLabel}</Button>
            </div>}
          />}
        </div>
      </section>
      <aside id={panels.mentorId} data-workspace-panel="mentor" hidden={!panels.mentorOpen} className="phase-requirements-mentor"><WorkspaceMentorBoundary panels={panels}><PersonaPanel phaseKey="requirements" phaseStateId={phaseId} interviewHref={`${base}/interview`} interviewStarted={Boolean(interview.state?.turns.length)} className="w-full min-h-0 flex-1" /></WorkspaceMentorBoundary></aside>
    </div>
    {referenceFile && <IssueDialog title="Saved Requirements evidence" onClose={() => { const next = new URLSearchParams(search.toString()); next.delete('file'); router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false }); }}><SavedEvidenceFile path={referenceFile} text={files[referenceFile]} /></IssueDialog>}
    {showConflict && conflict && <SaveConflictDialog conflict={conflict} files={files} saving={saving} onClose={() => setShowConflict(false)} onResolve={(choice, version) => { void resolveConflict(choice, version).then(() => { setShowConflict(false); setError(''); }).catch((err: unknown) => setError(describeError(err, 'The comparison changed. Review it again before choosing.'))); }} />}
  </WorkPage>;
}
