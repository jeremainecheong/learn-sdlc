'use client';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';

/**
 * The kill matrix: phase four's document, and the only page that says out loud
 * what a test is for.
 *
 * The IDE has the file; this page has the evidence. It reads the same verdict
 * the panel reads ({@link matrixView} over the newest report that carries a
 * matrix) and draws it transposed, tests down and planted bugs across, with
 * the QA lead beside it.
 */

import { useParams, useRouter } from 'next/navigation';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { MentorSession } from '@/components/shell/PersonaPanel';
import Link from 'next/link';
import { areaEntries, inWorkFrame } from '@/components/workspace/AreaNav';
import { useAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { useAppliedReadBack } from '@/components/workspace/mentor/useAppliedReadBack';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { api, describeError } from '@/lib/api';
import { HeaderSubmit } from '@/components/workspace/HeaderSubmit';
import { prSubmitLabel } from '@/components/pr/submitName';
import { clearCommitDraft, commitDraft } from '@/lib/commit';
import { workspaceApi } from '@/lib/api-workspace';
import { jobWake } from '@/lib/job-signal';
import { PollTimeoutError, pollUntil, useRecoverWhenBack } from '@/lib/poll';
import { setActiveProject } from '@/lib/project';
import { railOf } from '@/lib/rail';
import { fullDetail, invalidateProject, useProject } from '@/lib/useProject';
import { DocPage, briefHref, solutionHref, usePersona } from '@/components/shell';
import { Button, EmptyState, Notice } from '@/components/ui';
import {
  MatrixCard,
  MatrixRead,
  MutantDiff,
  PlantedBugs,
  WhatToDo,
  matrixPurpose,
} from '@/components/workspace/panels/testing/MatrixDoc';
import { ExplainTestButton } from '@/components/workspace/ExplainTest';
import { matrixView, parseTests, testFiles } from '@/components/workspace/panels/testing/lib';
import { latestMatrixSubmission } from '@/components/workspace/panels/testing/useTesting';
import { RoomFallback } from '@/components/workspace/panels/RoomFallback';
import { soleWorkTaskKey, submitArgs } from '@/components/workspace/TaskPanel';
import { PROPOSAL_HOLD_REASON, READ_BACK_HOLD_REASON, READ_BACK_NOTICE, awaitingSignOff, inFlightAgesOutIn, pendingRevision, submitOffReason } from '@/components/workspace/signoff-status';
import { solutionDoorOpen } from '@/components/solution/door';
import { revealFoldHead } from '@/lib/reveal-in-view';
import { projectName } from '@/lib/project-name';
import { settled } from '../workspace-helpers';


export default function MatrixPage() {
  const params = useParams<{ phaseId: string }>();
  const phaseId = params.phaseId;
  const router = useRouter();
  const { details, enrollment, analytics, currentPhase } = useProject();

  // What the shell already holds about this phase: the page opens on it and
  // refreshes behind the drawn page, so nothing here waits on the network.
  const seed = fullDetail(details, phaseId);
  const [fetched, setFetched] = useState<PhaseDetail | null>(null);
  usePhaseTutorialReady(fetched);
  const detail = fetched ?? seed ?? null;
  const [submissions, setSubmissions] = useState<SubmissionView[]>([]);
  const [submission, setSubmission] = useState<SubmissionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // While the room is showing a failure it picks the connection back up on
  // its own, so a learner who reconnects does not have to think about it.
  useRecoverWhenBack(Boolean(error) && !detail, retry);

  const load = useCallback(async () => {
    const d = await workspaceApi.phase(phaseId);
    if (!alive.current) return;
    setActiveProject(d.projectSlug);
    setFetched(d);
    setSubmission((prev) => prev ?? d.lastSubmission);
  }, [phaseId]);

  useEffect(() => {
    setError('');
    // `e.message` is whatever fetch rejected with: "Failed to fetch" is the
    // browser talking to itself. The room says it in the product's voice, and
    // `attempt` is what the Try again control moves.
    load().catch((e: unknown) =>
      setError(describeError(e, 'The planted bugs could not be loaded. Try again.')),
    );
  }, [load, attempt]);

  // The history is where the matrix lives: the newest report that carries one
  // wins, whichever revision made it.
  useEffect(() => {
    // The phase route resolves a phase's only task and refuses a
    // phase a teacher has split, so the read names the task it is about: the
    // phase's one piece of work, which is what that route would have resolved.
    // It waits for the phase, because the task list is what names it.
    if (!detail) return;
    let stale = false;
    // Submissions that will not load leave the grid to the phase's own last review.
    api
      .submissions(phaseId, soleWorkTaskKey(detail.tasks))
      .then((s) => {
        if (!stale && alive.current) setSubmissions(s);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [phaseId, submission?.id, detail]);

  // Testing is the only phase with a kill matrix. Anything else that lands
  // here goes to the room it belongs in.
  useEffect(() => {
    if (detail && detail.key !== 'testing') router.replace(`/workspace/${detail.id}`);
  }, [detail, router]);

  // The verdict the grid is drawn from, kept whole rather than reduced to its
  // rows: the clock it was graded at is read off the same report.
  const graded = useMemo(
    () => (detail ? latestMatrixSubmission(submission, submissions, detail.lastSubmission) : null),
    [detail, submission, submissions],
  );

  const view = useMemo(() => {
    if (!detail) return null;
    const tests = testFiles(detail)
      .flatMap((f) => parseTests(f.path, detail.files.find((x) => x.path === f.path)?.content ?? ''))
      .filter((t, i, all) => all.findIndex((o) => o.name === t.name) === i);
    return matrixView(graded?.report?.mutation?.matrix ?? [], tests);
  }, [detail, graded]);

  /**
   * The phase's task passed its review and waits on the teacher's
   * countersignature. Nothing is handed in while it does (the header's
   * Submit and "Run the bugs again" both end here),
   * because a refused resubmit clears the task's place in the sign-off queue.
   * After the countersignature this is false.
   */
  const taskAwaiting = awaitingSignOff(detail, soleWorkTaskKey(detail?.tasks), submission);
  /**
   * A newer revision of the task is still queued or being reviewed. The API
   * holds one in flight per task, so the
   * same two controls hand nothing in until its verdict is in. Read against
   * the phase's own newest revision, so a copy this room kept from before a
   * verdict never holds them off.
   */
  const pending = pendingRevision(submission, soleWorkTaskKey(detail?.tasks), detail?.lastSubmission ?? null);
  const revisionPending = pending !== null;
  /*
   * This page holds the workspace's mentor with both of its modes, so it
   * takes part in the assistant's signals. It writes no file, so it has
   * nothing to save before a proposal operation. While one runs nothing is
   * handed in from here (the header's Submit and "Run the bugs again", each
   * with the sentence): a submission taken in the middle of one
   * could be reviewed against the files from before the Apply. After an
   * Apply, which changes the saved workspace and no submitted revision, the
   * page reads the phase again and says that the planted bugs here ran on the
   * last submission. If that read fails, the two stay held (the mentor
   * refuses another proposal until the read is retried, and this page holds
   * no form), with a sentence that says to retry rather than to wait.
   */
  const nothingToSave = useCallback(async () => undefined, []);
  const [appliedHere, setAppliedHere] = useState(false);
  const refreshApplied = useCallback(async () => {
    setAppliedHere(true);
    await load();
    if (alive.current) invalidateProject();
  }, [load]);
  const readBack = useAppliedReadBack(phaseId, refreshApplied);
  const agentBusy = useAgentWorkspace(phaseId, nothingToSave, readBack.readBack);
  const unread = agentBusy && readBack.failed;
  useEffect(() => { if (busy) setAppliedHere(false); }, [busy]);
  const submitOff = submitOffReason(taskAwaiting, revisionPending) ?? (agentBusy ? (unread ? READ_BACK_HOLD_REASON : PROPOSAL_HOLD_REASON) : undefined);
  /**
   * While that revision is in flight and this room is not already watching
   * its own submit, the room watches it to its verdict (bugs
   * that outran the submit's own wait, or a run in flight when the room
   * opened), so the grid lands here and Submit comes back without a reload. If
   * it outlives the API's age-out window, the room draws again and Submit is
   * on: the next press is what writes the stalled revision off.
   */
  const pendingId = pending?.id ?? null;
  const [watchRound, setWatchRound] = useState(0);
  useEffect(() => {
    if (!pendingId || busy || !pending) return;
    let stopped = false;
    const owns = () => !stopped && alive.current;
    pollUntil(
      () => {
        if (!owns()) throw new Error('The room was left.');
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
    if (busy || submitOff) return;
    setBusy(true);
    setError('');
    setNotice('');
    let started: SubmissionView;
    // The commit message is the learner's own words about the revision, so it
    // rides with a submission made from here as much as with one made in the
    // IDE.
    const message = commitDraft(phaseId).trim();
    try {
      // Which task this revision answers: `submitArgs` names none on a phase
      // with one task, and on a phase with several (a quiz beside the work)
      // picks where the work is (`chooseTask`), since this room passes no choice.
      started = await api.submit(...submitArgs(phaseId, message || undefined, detail?.tasks, null));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      return;
    }
    clearCommitDraft(phaseId);
    setSubmission(started);
    try {
      // The socket only shortens the wait; this reply is still the answer.
      const finished = await pollUntil(() => api.getSubmission(started.id), settled, {
        wake: jobWake('submission', started.id),
      });
      if (!alive.current) return;
      setSubmission(finished);
      await load();
      invalidateProject();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof PollTimeoutError) setNotice('The bugs are still running. The grid lands here.');
      else setError((err as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [busy, load, phaseId, submitOff]);

  // The QA lead reads this page with you, so the thread is the page's own: 
  // taken apart, because the mockup puts their read of the grid between the
  // avatar and the hints.
  const thread = usePersona({ phaseKey: 'testing', phaseStateId: detail?.id });
  // The first case of the graded report that did not pass: why the
  // grid did not run, and the one case a learner would ask the QA lead about.
  const unrunCase = useMemo(() => {
    const failed = graded?.report?.tests?.cases.find((c) => c.status !== 'passed');
    return failed ? { name: failed.name, step: failed.step } : null;
  }, [graded]);

  const nav = railOf(enrollment, analytics, currentPhase);
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
    { label: detail?.title ?? 'Testing', href: '/phases?phase=testing' },
    { label: 'Planted bugs' },
  ];

  if (!detail || !view) {
    return (
      <DocPage crumbs={crumbs} active="work" nav={nav} testId="matrix-page" title="Planted bugs">
        <RoomFallback room="planted bugs" error={error} onRetry={retry} />
      </DocPage>
    );
  }

  /*
   * Whether the pull request has a revision, by the
   * workspace's own test (a revision this page holds, or the phase's count of
   * submissions), and the control's name by it: "Submit PR-4", then
   * "Submit PR-4 again".
   */
  const submitted = Boolean(submission) || detail.attempts > 0;
  const submitName = prSubmitLabel(detail.place, submitted);
  // The workspace's edit view, by the row's own address and word, where the applied change can be read.
  const editEntry = areaEntries(detail).find((entry) => entry.view === 'code');

  return (
    <PhaseDocumentFrame phase={detail} view="matrix" mentor={<MentorSession thread={thread} guidedOnly={!inWorkFrame(detail, 'matrix')}/>}
      crumbs={crumbs}
      active="work"
      nav={nav}
      testId="matrix-page"
      // The view is "Planted bugs"; "Kill matrix" is the grid's own heading inside it.
      title="Planted bugs"
      titleTestId="matrix-title"
      purpose={matrixPurpose(view)}
      right={
        <>
          <Button href={briefHref(detail)} variant="ghost" size="sm" icon="doc" testId="open-brief">
            Brief
          </Button>
          {/* The way back, drawn rather than implied. The working-area row's
              Write tests also goes to the workspace (it names the edit view;
              this door opens the workspace on the view last held), so the
              header reads this one inside Details: its row
              keeps one line. */}
          <Button
            href={`/workspace/${detail.id}`}
            variant="ghost"
            size="sm"
            icon="code"
            testId="back-workspace"
          >
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
          <Button
            variant="secondary"
            size="sm"
            busy={busy}
            busyLabel="Running the bugs"
            disabled={view.total === 0 || Boolean(submitOff)}
            reason={submitOff ?? 'There are no planted bugs to run until one has run against a submission.'}
            onClick={submit}
          >
            Run the bugs again
          </Button>
          {/* Submit PR-<n>, "again" once one exists; inside Details where nothing is to resubmit. */}
          <HeaderSubmit phase={detail} hasPr={submitted} busy={busy} busyLabel="In review" onClick={submit} testId="phase-testing-submit"
            disabled={Boolean(submitOff)} reason={submitOff} />
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {(error || notice) && <Notice tone={error ? 'fail' : 'info'}>{error || notice}</Notice>}
          {unread && <Notice tone="warn" testId="applied-read-back">{READ_BACK_NOTICE}</Notice>}
          {/* After an Apply: the notice every room shows, then one sentence true for the state:
              nothing submitted yet, so no planted bug has run; submitted and waiting for the teacher's sign-off, when
              nothing can be handed in; or submitted, with the grid from the last submission. */}
          {appliedHere && (
            <Notice tone="info">
              <span data-testid="matrix-applied-note">
                The reviewed proposal is saved in this workspace.{' '}
                {!submitted ? (
                  <>No planted bug has run yet: {submitName} runs them against your tests, or <Link href={editEntry?.href ?? `/workspace/${detail.id}`} className="underline">open {editEntry?.label ?? 'Write tests'}</Link> to see the change.</>
                ) : taskAwaiting ? (
                  <>The planted bugs here ran on what you last submitted, which waits for your teacher&apos;s sign-off. <Link href={editEntry?.href ?? `/workspace/${detail.id}`} className="underline">Open {editEntry?.label ?? 'Write tests'}</Link> to see the change.</>
                ) : (
                  <>The planted bugs here ran on what you last submitted: {submitName} to run them on the change, or <Link href={editEntry?.href ?? `/workspace/${detail.id}`} className="underline">open {editEntry?.label ?? 'Write tests'}</Link> to see it.</>
                )}
              </span>
            </Notice>
          )}
          {/* Before a grid: no second name for the page ("Kill matrix", "No kill matrix yet"), the
              same panel the grid is drawn in, and no second Submit: the page's Submit is in its header at every width. */}
          {view.total === 0 ? (
            <div className="panel flex min-w-0 flex-col gap-3.5 px-4 py-4" data-testid="phase-testing-matrix">
              <EmptyState
                icon="bug"
                title={submitted ? 'No grid yet' : 'No planted bugs have run yet'}
                body={!submitted
                  ? `The planted bugs run against your tests when you submit: ${submitName}, at the top of the page, and the grid lands here.`
                  : busy || revisionPending
                    ? 'The planted bugs are running on your submission. The grid lands here.'
                    : taskAwaiting
                      // Every Submit on the page is held while the teacher's sign-off is awaited.
                      ? "Your last submission brought no grid back, and it waits for your teacher's sign-off."
                      : `Your last submission brought no grid back. ${submitName} runs the planted bugs again, and the grid lands here.`}
              />
            </div>
          ) : (
            <>
              {view.unrun && (
                <div className="flex flex-col items-start gap-2">
                  <Notice tone="warn">
                    Your suite has to pass on the reference implementation before the planted bugs run. Every test has to
                    be green there first.
                  </Notice>
                  {/* The case that kept the grid from running is the
                      one thing worth asking about here. A surviving mutant is a
                      different question, and the grid answers that one itself. */}
                  {unrunCase && (
                    <ExplainTestButton
                      testName={unrunCase.name}
                      source="submission"
                      step={unrunCase.step}
                      thread={thread}
                      onOpenThread={() => {
                        document
                          .querySelector('[data-testid="mentor-chat"]')
                          ?.scrollIntoView({ block: 'center' });
                      }}
                    />
                  )}
                </div>
              )}
              <MatrixCard view={view} detail={detail} matrixClock={graded?.report?.runClock} />
              <WhatToDo view={view} />
              <FoldHeadReveal><details className="phase-evidence-detail"><summary>Read the mutation evidence</summary><MatrixRead view={view}/><PlantedBugs view={view}/><MutantDiff view={view}/></details></FoldHeadReveal>
            </>
          )}
        </div>
      </div>
    </PhaseDocumentFrame>
  );
}

/**
 * "Read the mutation evidence", the fold under the grid. It is the last line in view at 1440 by 900, so opening it
 * would draw its first sentence under the window's foot and nothing new would show. When the person
 * opens it by pressing its own summary (a click, or Enter or Space on it), it is brought into view in the page's
 * column by the least scroll (`revealFoldHead`). A fold that fits the column comes in whole, its foot just above the
 * column's foot (one bug and its "What B1 changes" show without a scroll; nothing moves when all of it shows
 * already). A fold taller than the column is brought in by its head only: the summary stays where it was when
 * its first lines already show under it, and otherwise the column moves only as far as the summary and those lines
 * need, so the grid above stays in view (a fold whose top sat at the column's top would hide the grid). Closing it, a fold opened any other way, and a fold inside it ("The 5 tests") move nothing.
 *
 * The fold's markup is written out where it is drawn. This box takes the press and the toggle around it:
 * `display: contents`, so the box adds nothing to the fold's layout. The toggle event does not bubble, so it is heard on the way down (capture).
 */
function FoldHeadReveal({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    let pressed: HTMLDetailsElement | null = null;
    const fold = (el: EventTarget | null) =>
      el instanceof HTMLDetailsElement && el.classList.contains('phase-evidence-detail') && node.contains(el) ? el : null;
    const onClick = (event: MouseEvent) => {
      const summary = event.target instanceof Element ? event.target.closest('summary') : null;
      pressed = summary ? fold(summary.parentElement) : null;
    };
    const onToggle = (event: Event) => {
      const opened = fold(event.target);
      if (!opened) return;
      const byPress = pressed === opened;
      pressed = null;
      if (opened.open && byPress) revealFoldHead(opened);
    };
    node.addEventListener('click', onClick);
    node.addEventListener('toggle', onToggle, true);
    return () => {
      node.removeEventListener('click', onClick);
      node.removeEventListener('toggle', onToggle, true);
    };
  }, []);
  return <div ref={box} className="contents">{children}</div>;
}
