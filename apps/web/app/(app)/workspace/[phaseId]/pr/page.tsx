'use client';
import { RetainedWorkspaceView, useWorkspaceViewScroll } from '@/components/workspace/WorkspaceViews';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';

/**
 * The pull request: one per phase, one revision per submission.
 *
 * The IDE is where the code is written; this is where it is reviewed. The page
 * reads three ways (the conversation with the reviewer, the diff the review is
 * about, and the checks that scored it) and it is the only place the merge
 * happens: the gate, the message that becomes docs/pr/PR-n.md, and the phase it
 * opens next.
 *
 * Everything derived here comes from `panels/implementation/pr.ts`, which the
 * IDE uses too; the page adds the diff between two revisions and the merge.
 */
import { useParams, useRouter } from 'next/navigation';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { HeaderSubmit } from '@/components/workspace/HeaderSubmit';
import Link from 'next/link';
import { MentorSession } from '@/components/shell/PersonaPanel';
import { WORKING_AREA_LABELS, areaEntries, inWorkFrame } from '@/components/workspace/AreaNav';
import { useAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { useAppliedReadBack } from '@/components/workspace/mentor/useAppliedReadBack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PHASE_TITLES, isLastPhase, nextPhaseOf, placeOf, type PhaseKey } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { DocPage, briefHref, doorWithTasks, phaseDoorHref, solutionHref, usePersona } from '@/components/shell';
import { Button, Chip, Notice, Tabs, tabPanelProps } from '@/components/ui';
import { Term } from '@/components/ui/Term';
import {
  ChecksTab,
  Conversation,
  DiffView,
  HistoryCard,
  MergeCard,
  gateReason,
  prHeadline,
  usePullRequest,
  type PrThread,
} from '@/components/pr';
import { openTasksWaitLabel } from '@/components/pr/MergeCard';
import { prSubmitLabel, prSubmitLeads } from '@/components/pr/submitName';
import { count } from '@/components/workspace/panels/implementation/pr';
import {
  TaskPanel,
  isSplit,
  mergeGateMet,
  reviewGateMet,
  soleWorkTaskKey,
  taskCountLine,
  taskKeyToSend,
} from '@/components/workspace/TaskPanel';
import { RoomFallback } from '@/components/workspace/panels/RoomFallback';
import { QueueLine } from '@/components/workspace/QueueLine';
import { api } from '@/lib/api';
import { useCommitDraft } from '@/lib/commit';
import { railOf } from '@/lib/rail';
import { invalidateProject, useProject } from '@/lib/useProject';
import { solutionDoorOpen } from '@/components/solution/door';
import { runsReferenceApplication } from '@/components/workspace/application';
import { roomIsReference } from '@/lib/scenario';
import {
  PROPOSAL_HOLD_REASON,
  READ_BACK_HOLD_REASON,
  READ_BACK_NOTICE,
  AWAITING_SIGN_OFF,
  SIGN_OFF_SUBMIT_REASON,
  SIGN_OFF_TONE,
  awaitingSignOff,
  phaseAwaitingSignOff,
  signOffPassLine,
} from '@/components/workspace/signoff-status';
import { STATE_LABEL, isCredited } from '@/components/workspace/gate-state';
import { projectName } from '@/lib/project-name';

type Tab = 'conversation' | 'files' | 'checks' | 'history';

export default function PullRequestPage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  const router = useRouter();
  const { details, enrollment, analytics, currentPhase, reload: reloadProject } = useProject();

  const { view: tab, select: setTab, contentRef } = useWorkspaceViewScroll<Tab>('files');
  const [merging, setMerging] = useState(false);

  /**
   * Which task of a split phase this room is reviewing. Nothing is
   * selected until a learner picks one, and on a phase with one task (every
   * phase this room draws while coding, testing and deployment phases stay
   * single-task) nothing is ever drawn to pick with.
   */
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const pr = usePullRequest(phaseId, selectedTask);
  const { head, threads, diffs, revisions, gate } = pr;
  // The same draft the IDE's Commit tab writes: one sentence about one
  // revision, wherever the learner happens to be typing it.
  const [commitMessage, setCommitMessage] = useCommitDraft(phaseId);
  // The shell already holds this phase, so the page opens on its header and
  // its state rather than on the word "loading"; the revisions and the diff
  // fill in when they arrive.
  const detail = pr.detail ?? details[phaseId] ?? null;

  // A merge is a release row, or the project having moved past this phase: 
  // both written by advance(). Crossing the gate is not merging.
  const merged = Boolean(
    detail &&
      enrollment &&
      (enrollment.releases?.some((r) => r.phaseKey === detail.key) ||
        enrollment.completed ||
        enrollment.currentPhaseOrder > detail.order),
  );

  const phaseKey = (detail?.key ?? 'implementation') as PhaseKey;
  // One conversation behind two tabs. The Checks tab draws an
  // explain button on every failed case and the Conversation tab draws the
  // thread it lands in, so the page holds it rather than each tab opening one.
  const thread = usePersona({ phaseKey, phaseStateId: phaseId });
  /*
   * One mentor on every page of a code phase, with both of its modes, so the
   * assistant does not change when a learner goes from the editor to the
   * review: a Maintenance whose door is the change room, and
   * Implementation, Testing and Deployment, whose review pages are
   * drawn in the workspace's frame (`inWorkFrame`). This page writes no file,
   * so it has nothing to save before a proposal operation; when a proposal has
   * been applied it reads the pull request and the project again. On every
   * other phase the review's mentor stays guided only and none of these
   * signals is sent.
   */
  const workMentor = Boolean(detail && inWorkFrame(detail, 'pr'));
  const nothingToSave = useCallback(async () => undefined, []);
  const reloadPr = pr.reload;
  // An Apply writes the saved workspace and makes no revision, and this page draws revisions: nothing on it would
  // change. So the page says where the change went and what has it reviewed, until the next submission is sent.
  const [appliedHere, setAppliedHere] = useState(false);
  const refreshApplied = useCallback(async () => {
    setAppliedHere(true);
    await reloadPr();
    // The pull request is read again above; a project refresh that fails only leaves the shell's copy as it was.
    await reloadProject().catch(() => undefined);
  }, [reloadPr, reloadProject]);
  // While a proposal operation runs, nothing is handed in from here either (the header's Submit, the card's and ⌘↵).
  // If the read after an Apply fails, Submit stays held (the mentor refuses another proposal until the read is
  // retried, and a hand-in should not overtake an operation the page has not seen finish), and the page says to retry.
  const readBack = useAppliedReadBack(phaseId, refreshApplied);
  const agentBusy = useAgentWorkspace(phaseId, nothingToSave, readBack.readBack);
  const unread = agentBusy && readBack.failed;
  const submitting = pr.busy;
  useEffect(() => { if (submitting) setAppliedHere(false); }, [submitting]);
  // The pull request and the phase after it go by place and key:
  // a stored version numbered 3 and 5 still names PR-1 and opens its second.
  const name = `PR-${detail?.place ?? ''}`;
  const workHref = detail ? `/workspace/${detail.id}` : '/dashboard';
  // The workspace's edit view by the row's own address and word (Edit files, Code, Write tests, Configuration),
  // which the note after an Apply links to: the saved workspace is where the applied change can be read.
  const editEntry = detail ? areaEntries(detail).find((entry) => entry.view === 'code') : undefined;
  const editHref = editEntry?.href ?? workHref;
  const editWord = editEntry?.label ?? (detail ? WORKING_AREA_LABELS[detail.key].edit : 'Edit files');
  const next = useMemo(
    () => (enrollment && detail ? nextPhaseOf(enrollment, detail.key) : null),
    [enrollment, detail],
  );
  const nextPlace = next && enrollment ? placeOf(enrollment, next.key) : undefined;
  // The project's last phase (by key over the whole list): its sign-off words
  // say the project can then be completed, not that a next phase opens.
  const isLast = Boolean(enrollment && detail && isLastPhase(enrollment, detail.key));
  // The next phase's door: its room, in one step.
  const nextHref = next ? phaseDoorHref(doorWithTasks(next, details)) : '/dashboard';
  const openThreads = threads.filter((t) => t.state === 'open').length;
  /**
   * The task passed its review and waits on the teacher's
   * countersignature. The gate is not met until it lands (the
   * countersignature opens the next phase, and `advance()` refuses before it),
   * and a resubmit is not offered: a failed one clears the task's place in the
   * sign-off queue.
   *
   * The task asked about is the one a submit from this room would hand in
   * (`taskKeyToSend`): on a split phase with nothing selected that is
   * `chooseTask`'s pick, which can be the waiting task. The newest graded
   * revision is read too, for the moment a verdict lands before the task row
   * knows it, but only when it is the newest revision of all (one still in
   * review, or one whose review failed to run, is newer than any verdict) and
   * only for the task this room's revisions belong to.
   */
  const tasks = detail?.tasks;
  const waitKey = taskKeyToSend(tasks, selectedTask) ?? selectedTask;
  const revisionsTask = tasks?.length === 1 ? tasks[0].key : soleWorkTaskKey(tasks);
  const waiting = awaitingSignOff(
    detail,
    waitKey,
    head && revisionsTask && revisions[revisions.length - 1]?.id === head.id
      ? {
          id: head.id,
          status: 'completed',
          passed: head.report?.passed === true,
          createdAt: head.createdAt,
          taskKey: revisionsTask,
        }
      : null,
  );
  // The phase's countersignature is the one thing missing (every required
  // task passed or waits). On a split phase the counts keep Merge off; this
  // is what the chip and the card say about it, as the dashboard does.
  const phaseWaiting = waiting || phaseAwaitingSignOff(detail);
  // On a split phase the gate is the required set's counts; a waiting
  // optional task does not hold the phase, so only a waiting required task
  // (or the one task) turns the gate off here.
  const waitHolds = waiting && (!isSplit(tasks) || tasks?.find((t) => t.key === waitKey)?.required !== false);
  // The card speaks of the countersignature only when
  // it is the one thing missing. On a split phase with a required task still
  // open the work waits but the phase does not; the label names what is open.
  const signOffOnly = phaseAwaitingSignOff(detail) || (waiting && !isSplit(tasks));
  const stillOpen = phaseWaiting && !signOffOnly && detail?.status !== 'passed'
    ? (tasks ?? [])
        .filter((t) => t.required && t.status !== 'passed' && !(t.status === 'submitted' && t.awaitingSignOff))
        .map((t) => t.title)
    : [];

  const reply = useCallback(
    async (thread: PrThread, text: string) => {
      if (!detail) return '';
      const where = thread.line > 0 ? `${thread.path} line ${thread.line}` : thread.path || 'this pull request';
      const res = await api.chat(detail.id, `On ${where}: ${text}`);
      return res.reply.content;
    },
    [detail],
  );

  const merge = useCallback(
    async (message: string) => {
      if (!detail || merging) return;
      setMerging(true);
      pr.setError('');
      try {
        if (message.trim()) await api.reflect(detail.id, message);
        const updated = await api.advance(detail.id);
        invalidateProject();
        // The advance has been recorded; a refresh that fails here is repeated by the invalidation above.
        await reloadProject().catch(() => undefined);
        if (updated.completed) {
          router.push('/complete');
          return;
        }
        await pr.reload();
        pr.setNotice(`${name} is merged. ${next ? `${next.title} is open.` : ''}`);
      } catch (err) {
        pr.setError((err as Error).message);
      } finally {
        setMerging(false);
      }
    },
    [detail, merging, name, next, pr, reloadProject, router],
  );

  // ⌘↵ submits again, ⌘O opens what the page is pointing at: the workspace
  // while the review is open, the next phase once it is merged.
  // Why Submit is off: the task waits on the countersignature, or a proposal operation runs.
  const submitHold = waiting ? SIGN_OFF_SUBMIT_REASON : agentBusy ? (unread ? READ_BACK_HOLD_REASON : PROPOSAL_HOLD_REASON) : undefined;
  const submitShortcut = submitHold ? async () => undefined : pr.submit;
  const keys = useRef({ submit: submitShortcut, go: merged ? nextHref : workHref });
  keys.current = { submit: submitShortcut, go: merged ? nextHref : workHref };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (workspaceShortcutBlocked(e.target)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void keys.current.submit();
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        router.push(keys.current.go);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [router]);

  const nav = {
    ...railOf(enrollment, analytics, currentPhase),
    notifications: openThreads,
    notificationsHref: detail ? `/workspace/${detail.id}/pr` : undefined,
  };
  const crumbs = [
    ...(enrollment
      ? [
          {
            label: projectName(enrollment.projectTitle),
            href: '/dashboard',
            testId: 'back-dashboard',
          },
        ]
      : []),
    // <project> › <Phase> › PR-<n>, as every page of the phase reads.
    { label: detail?.title ?? PHASE_TITLES[phaseKey], href: `/phases?phase=${phaseKey}` },
    { label: name },
  ];

  if (!detail) {
    return (
      <DocPage crumbs={crumbs} active="work" nav={nav} testId="pr-page" title="Pull request">
        <RoomFallback room="pull request" error={pr.error} onRetry={pr.retry} />
      </DocPage>
    );
  }

  // What the last revision that carried one said, so the field can show it
  // under itself rather than making the learner remember.
  const lastMessage = [...revisions].reverse().find((r) => r.message)?.message ?? null;
  const score = head?.score != null ? Math.round(head.score) : null;
  /**
   * What the newest revision says about itself. On a phase a teacher has
   * split it is one task's answer and the gate is the required set's, so
   * `mergeGateMet` reads the counts where there are several tasks and this
   * boolean where there is one, which is every phase this room draws, since
   * coding, testing and deployment phases stay single-task.
   */
  const verdictGate = head?.report?.passed === true && !head.report.aiReview.assessmentError;
  const gateMet = mergeGateMet(detail, verdictGate) && !waitHolds;
  // Whether the review is in, which is what the chip and the merge card
  // report. It differs from `gateMet` only on a phase ahead of the
  // learner, where a review that passed still waits for them to reach it, and
  // on a phase whose countersignature is the one thing missing: every required
  // task's review passed, so the room does not say "Needs revision".
  const reviewPassed = reviewGateMet(detail, verdictGate) || phaseWaiting;
  /*
   * The header already says the phase and its place, so the
   * standing line does not repeat them; and on a phase with one task, which is
   * every phase this room draws, "0 of 1 required done" beside a Pass that
   * waits on the teacher would count the waiting task as not done and name no
   * noun. The count is drawn only where a phase has several tasks, as the
   * workspace's header draws it.
   */
  const taskLine = isSplit(tasks) ? taskCountLine(detail.taskCounts) : '';
  const credited = isCredited(detail.id, detail);
  /*
   * The page's own Submit (the merge card's)
   * reads "Submit PR-<n>" before the pull request has a revision and
   * "Submit PR-<n> again" once it has one, and it is the primary control only
   * while handing in is the next step (the workspace's rule): never after a
   * Pass, while the countersignature is awaited, or once merged.
   */
  const docSubmitLabel = prSubmitLabel(detail.place, revisions.length > 0);
  const submitLeads = prSubmitLeads({ merged, reviewPassed, credited });

  return (
    <PhaseDocumentFrame phase={detail} view="pr" contentRef={contentRef} mentor={<MentorSession thread={thread} guidedOnly={!workMentor}/>}
      crumbs={crumbs}
      active="work"
      nav={nav}
      testId="pr-page"
      titleTestId="pr-title"
      title={
        <span className="inline-flex items-center gap-2.5">
          <Icon
            name={merged ? 'merge' : 'pr'}
            size={22}
            strokeWidth={1.7}
            className={merged ? 'shrink-0 text-pass' : 'shrink-0 text-accent'}
          />
          {name}: {prHeadline(detail, roomIsReference(detail.provenance, enrollment?.phases.find((one) => one.key === detail.key), enrollment))}
        </span>
      }
      right={
        <>
          {detail && (
            <Button href={briefHref(detail)} variant="ghost" size="sm" icon="doc" testId="open-brief">
              Brief
            </Button>
          )}
          <Button href={workHref} variant="secondary" size="sm" testId="pr-open-workspace">
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
          {/* Submit PR-<n>, "again" once one is open; inside Details where nothing is to resubmit. */}
          {!merged && (
            <HeaderSubmit phase={detail} hasPr={revisions.length > 0} keys="⌘↵" busy={pr.busy} busyLabel="In review"
              disabled={Boolean(submitHold)} reason={submitHold} onClick={() => void pr.submit()} testId="header-submit" />
          )}
        </>
      }
    >
      {/* Where this submission sits in the class's line, while it
          is in one. The newest revision is the one in flight: `head` is the
          newest revision that has already produced a report. */}
      <div role="status">
        <QueueLine
          kind="submission"
          id={revisions[revisions.length - 1]?.id ?? null}
          active={pr.busy}
          testId="pr-queue-line"
        />
      </div>

      {/* The pull request's standing, on its own line under the title: which
          phase it belongs to, where the review got to, and when it opened. */}
      <div className="-mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5" data-testid="pr-standing">
        {merged ? (
          <Chip tone="pass">Pass. Phase completed</Chip>
        ) : credited ? (
          /* Passed on the board by the teacher's credit, the gate still
             wanting a reviewed pass: the band's words, not "Needs revision"
             or "Reviewing". */
          <Chip tone="warn" testId="pr-credit">{STATE_LABEL.credited}</Chip>
        ) : signOffOnly && !detail.notReachedYet ? (
          /* The work passed and the teacher's countersignature is the one thing
             missing: the chip says so, as the workspace's header does. */
          <Chip tone={SIGN_OFF_TONE} testId="pr-awaiting-sign-off">{AWAITING_SIGN_OFF}</Chip>
        ) : head ? (
          <Chip tone={reviewPassed ? 'pass' : 'accent'}>
            {/* "100 of 70" reads as a fraction. Two facts, the way the verdict
                banner already writes them. */}
            {reviewPassed ? 'Pass' : head.state === 'now' ? 'Reviewing' : 'Needs revision'}
          </Chip>
        ) : revisions.some((r) => r.state === 'now') ? (
          /* No review is in yet, but a submission is queued or running: the line beside the chip already says
             "Opened …, 1 submission", so "Not opened yet" would contradict it. */
          <Chip tone="accent">Reviewing</Chip>
        ) : revisions.length > 0 ? (
          /* Every submission so far came back without a report (`buildRevisions` marks it "Review unavailable"):
             nothing is being reviewed, and the pull request is open. */
          <Chip tone="warn">Review unavailable</Chip>
        ) : (
          <Chip tone="outline">Not opened yet</Chip>
        )}
        {taskLine && (
          <span className="label-sm" data-testid="pr-task-counts">
            {taskLine}
          </span>
        )}
        <span className="label-sm">
          {revisions.length > 0 ? (
            `Opened ${pr.openedAt}, ${count(revisions.length, 'submission')}`
          ) : (
            <>
              Submitting opens the <Term term="pull request">pull request</Term>
            </>
          )}
        </span>
      </div>

      {/* Which task of this phase is being reviewed. Nothing is drawn on a
          phase with one task, which is every phase this room draws. */}
      <TaskPanel
        tasks={detail.tasks}
        phase={detail}
        selected={selectedTask}
        onSelect={setSelectedTask}
        counts={detail.taskCounts}
      />

      {/* The tabs name what they switch, and the
          column below names the tab it is showing. */}
      <Tabs
        value={tab}
        onChange={(k) => setTab(k as Tab)}
        label="Pull request"
        panelId="pr-panel"
        items={[
          { key: 'conversation', label: 'Conversation', testId: 'pr-tab-conversation' },
          { key: 'files', label: 'Files changed', testId: 'pr-tab-files' },
          { key: 'checks', label: 'Checks', testId: 'pr-tab-checks' },
          { key: 'history', label: 'History', testId: 'pr-tab-history' },
        ]}
      />

      {(pr.error || pr.notice) && (
        <Notice tone={pr.error ? 'fail' : 'info'}>{pr.error || pr.notice}</Notice>
      )}

      {unread && <Notice tone="warn" testId="applied-read-back">{READ_BACK_NOTICE}</Notice>}

      {/* After an Apply: the notice every room shows, then one sentence true for the state the pull
          request is in: nothing submitted yet; submitted, with the applied change not yet in a revision; or
          submitted and waiting for the teacher's sign-off, when nothing can be handed in. */}
      {appliedHere && (
        <Notice tone="info">
          <span data-testid="pr-applied-note">
            The reviewed proposal is saved in this workspace.{' '}
            {revisions.length === 0 ? (
              <>Nothing is submitted yet: {docSubmitLabel} opens the pull request with it, or <Link href={editHref} className="underline">open {editWord}</Link> to see it.</>
            ) : waiting ? (
              <>This page shows what you last submitted, which waits for your teacher&apos;s sign-off. <Link href={editHref} className="underline">Open {editWord}</Link> to see the change.</>
            ) : (
              <>This page shows what you last submitted: {docSubmitLabel} to have the change reviewed, or <Link href={editHref} className="underline">open {editWord}</Link> to see it.</>
            )}
          </span>
        </Notice>
      )}

      <div className="phase-pr-evidence">
        <div className="flex min-w-0 flex-col gap-3.5" {...tabPanelProps('pr-panel', tab)}>
          <RetainedWorkspaceView active={tab === 'conversation'} className="flex min-w-0 flex-col gap-3.5">
            <Conversation
              threads={threads}
              phaseKey={phaseKey}
              phaseStateId={detail.id}
              closedByMerge={merged}
              onReply={reply}
              thread={thread}
              showMentor={false}
            />
          </RetainedWorkspaceView>
          <RetainedWorkspaceView active={tab === 'files'} className="flex min-w-0 flex-col gap-3.5">
            <>
              {pr.fileRevision && <div data-testid="pr-files-revision" data-submission-id={pr.fileRevision.id} data-base-submission-id={pr.fileBase?.id ?? ''}>
                <Notice tone="info">
                  {pr.fileRevision.id !== head?.id ? 'Historical files: ' : 'Latest files: '}Submission {pr.fileRevision.attempt}
                  {/* With no earlier reviewed submission there is nothing to compare with, and the
                      page holds no copy of the files the phase started from; each file is drawn whole, said once here.
                      `fileBase` is the previous reviewed revision, so an earlier submission that came back without a
                      report leaves it empty: then this one is not "the first". The attempt counts from the
                      first submission ever made, so it says so past the newest 50 the list holds too. */}
                  {pr.fileBase
                    ? ` compared with submission ${pr.fileBase.attempt}.`
                    : pr.fileRevision.attempt > 1
                      ? '. No earlier reviewed submission to compare with: each file is shown whole, as you handed it in, not as a change.'
                      : ', the first: each file is shown whole, as you handed it in, not as a change.'}
                  {' '}Checks and phase advancement use the latest review.
                  {pr.fileRevision.id !== head?.id && <Button variant="ghost" size="sm" testId="pr-files-latest" onClick={() => pr.selectRevision(null)}>Back to latest files</Button>}
                </Notice>
              </div>}
              {pr.filesError && <Notice tone="fail">{pr.filesError} <Button variant="ghost" size="sm" onClick={pr.retryFiles}>Retry saved files</Button></Notice>}
              {diffs.length === 0 ? (
                // After an Apply with nothing submitted, the note above already says so.
                appliedHere && revisions.length === 0 && !pr.fileRevision ? null : <Notice tone="info">
                  {pr.loading || pr.filesLoading
                    ? 'Reading the revision…'
                    : pr.filesPruned
                      ? 'The files for this revision are no longer kept. The verdict and feedback remain.'
                      : pr.baseFilesPruned
                        ? 'The previous submission snapshot is unavailable. The comparison cannot be shown.'
                      : pr.filesError
                        ? 'The saved comparison is unavailable until its files can be read.'
                      : pr.fileRevision
                        ? 'This submission changed no file the review can read.'
                      /* No reviewed submission: one in review, or every one back without a report, is not "nothing
                         submitted" under the "Reviewing" or "Review unavailable" chip. */
                      : revisions.some((r) => r.state === 'now')
                        ? 'Your submission is being reviewed. Its files are shown here when the review is in.'
                      : revisions.length > 0
                        ? 'No submission has been reviewed yet, so there are no files to compare. Submitting again has it reviewed.'
                        : 'Nothing is submitted yet. Submitting opens the pull request and its diff.'}
                </Notice>
              ) : (
                diffs.map((d, i) => (
                  <DiffView
                    key={`${pr.fileRevision?.id ?? 'none'}:${d.path}`}
                    diff={d}
                    threads={pr.threadsFor(d.path)}
                    phaseKey={phaseKey}
                    firstThreadIndex={
                      diffs.slice(0, i).reduce((n, prev) => n + pr.threadsFor(prev.path).length, 1)
                    }
                    closedByMerge={merged}
                    onReply={pr.fileRevision?.id === head?.id ? reply : undefined}
                    whole={!pr.fileBase}
                  />
                ))
              )}
            </>
          </RetainedWorkspaceView>
          <RetainedWorkspaceView active={tab === 'checks'} className="flex min-w-0 flex-col gap-3.5">
            <ChecksTab
              report={head?.report ?? null}
              attempt={head?.attempt ?? null}
              gate={gate}
              floors={detail}
              thread={thread}
              onOpenThread={() => setTab('conversation', 'pr-panel-tab-conversation')}
            />
          </RetainedWorkspaceView>
          {/* The pull request's own log: every revision, what the learner said
              it changes, and what it scored. */}
          <RetainedWorkspaceView active={tab === 'history'} className="flex min-w-0 flex-col gap-3.5">
            <HistoryCard
              revisions={revisions}
              filesKept={pr.filesKept}
              onOpenFiles={(id) => { pr.selectRevision(id); setTab('files', 'pr-panel-tab-files'); }}
            />
          </RetainedWorkspaceView>
        </div>

        <details className="phase-pr-review-state" open={gateMet || phaseWaiting}><summary>Submission status and phase advancement</summary>
          <MergeCard
            reference={runsReferenceApplication(detail.provenance)}
            pr={name}
            merged={merged}
            gateMet={gateMet}
            reviewPassed={reviewPassed}
            waitLabel={detail.notReachedYet ? 'Available once you reach this phase' : signOffOnly ? signOffPassLine(isLast) : stillOpen.length ? openTasksWaitLabel(stillOpen) : undefined}
            // The only gate on the card's "Submit again" while the task a
            // submit would send waits. `pr.submit`
            // has no wait check of its own, so without it that button is live.
            submitReason={submitHold}
            score={score}
            gate={gate}
            attempt={head?.attempt ?? null}
            reason={gateReason(head?.report ?? null)}
            reflection={detail.reflection ?? null}
            next={next}
            nextPlace={nextPlace}
            nextHref={nextHref}
            busy={merging}
            submitLabel={docSubmitLabel}
            submitLeads={submitLeads}
            onMerge={merge}
            onSubmitAgain={pr.submit}
            signOffPending={signOffOnly && !detail.notReachedYet}
            isLast={isLast}
            commitMessage={commitMessage}
            setCommitMessage={setCommitMessage}
            lastCommitMessage={lastMessage}
          />
        </details>
      </div>
    </PhaseDocumentFrame>
  );
}
