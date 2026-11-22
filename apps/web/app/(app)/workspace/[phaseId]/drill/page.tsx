'use client';
import { sameSession } from '@/lib/session-token';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';

/**
 * The incident drill: phase five's document, and the only page in the product
 * that is timed.
 *
 * A faulted copy of the learner's image is already down. This page gives them
 * what an on-call engineer has (the health check, the logs, the runbook)
 * and nothing else: the SRE watches, and only answers when asked. The three
 * drill routes are the same ones the IDE's Drill tab calls; the derivations
 * are the deployment panel's.
 */

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { HeaderSubmit, HeaderSubmitVerdict } from '@/components/workspace/HeaderSubmit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RUNBOOK_JSON, type DrillState, type PhaseDetail, type SubmissionView } from '@learnsdlc/shared';
import { api, describeError, getToken, type DrillHealthResult } from '@/lib/api';
import { getSession, useSession } from '@/lib/session';
import { useVersionedWorkspaceSave } from '@/components/workspace/useVersionedWorkspaceSave';
import { VersionedWorkspaceConflict } from '@/components/workspace/VersionedWorkspaceConflict';
import { setActiveProject } from '@/lib/project';
import { railOf } from '@/lib/rail';
import { fullDetail, invalidateProject, useProject } from '@/lib/useProject';
import { DocPage } from '@/components/shell';
import { Button, Chip, EmptyState, Notice, Section } from '@/components/ui';
import { useRecoverWhenBack } from '@/lib/poll';
import {
  FaultedDeployment,
  IncidentWriteUp,
  ResolveChecklist,
  RunbookTabLink,
  writeUpReady,
  type WriteUp,
} from '@/components/workspace/panels/deployment/DrillDoc';
import { DRILL_CARD_PURPOSE, DRILL_CARD_TITLE, DRILL_NOT_STARTED, DRILL_NOT_STARTED_CHIP, brokenFor, drillNotStartedBody, errorText, resolveAndReload, resolvedSentence } from '@/components/workspace/panels/deployment/drill';
import { runsReferenceApplication } from '@/components/workspace/application';
import { RoomFallback } from '@/components/workspace/panels/RoomFallback';
import { olderRecordSentence } from '@/components/workspace/records';
import { useAgentWorkspace } from '@/components/workspace/mentor/useAgentWorkspace';
import { PROPOSAL_HOLD_RESOLVE_REASON, PROPOSAL_HOLD_RUN_REASON, READ_BACK_HOLD_RESOLVE_REASON, READ_BACK_HOLD_RUN_REASON, READ_BACK_NOTICE } from '@/components/workspace/signoff-status';
import { useAppliedReadBack } from '@/components/workspace/mentor/useAppliedReadBack';
import { areaEntries } from '@/components/workspace/AreaNav';
import { solutionHref } from '@/components/shell/routes';
import { solutionDoorOpen } from '@/components/solution/door';
import { PROPOSAL_HOLD_REASON, READ_BACK_HOLD_REASON, awaitingSignOff, revisionInFlight, submitOffReason } from '@/components/workspace/signoff-status';
import { chooseTask } from '@/components/workspace/TaskPanel';
import { rememberDrillAlert, useHeldDrillAlert } from '@/components/workspace/panels/deployment/alert-text';
import { MissionDetails } from '@/components/phases/Brief';
import { lessonsOfferedOn } from '@/lib/scenario';
import { projectName } from '@/lib/project-name';

const EMPTY: WriteUp = { rootCause: '', fix: '', actionItem: '' };
/**
 * Why the pass banner did not hand the learner on. It names the two controls
 * the save notice above already draws, which is where the edits are recovered.
 */
const CONTINUE_BLOCKED = 'Your last edits did not save, so this phase was not closed. Compare the versions or retry saving.';

export default function DrillPage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  const session = useSession();
  return <DrillWorkspace key={`${session?.id ?? 'signed-out'}:${phaseId}`} phaseId={phaseId} />;
}

function DrillWorkspace({ phaseId }: { phaseId: string }) {
  const router = useRouter();
  const { details, enrollment, analytics, currentPhase } = useProject();

  // What the shell already holds about this phase: the page opens on it and
  // refreshes behind the drawn page, so nothing here waits on the network.
  const seed = fullDetail(details, phaseId);
  const [fetched, setFetched] = useState<PhaseDetail | null>(null);
  usePhaseTutorialReady(fetched);
  const detail = fetched?.id === phaseId ? fetched : seed ?? null;
  const { files, flushSave, saveError, saving, dirty, conflict, resolveConflict } = useVersionedWorkspaceSave(phaseId, detail);
  const [comparing, setComparing] = useState(false);
  const [drill, setDrill] = useState<DrillState | null>(() => seed?.drill ?? null);
  const [submission, setSubmission] = useState<SubmissionView | null>(() => seed?.lastSubmission ?? null);
  // The verdict of the header Submit's own submission, drawn in the header's controls: held here, as a pass moves Submit into Details.
  const [verdict, setVerdict] = useState<SubmissionView | null>(null);
  const [beforeStderr, setBeforeStderr] = useState('');
  // What the paged run printed, kept for this tab by whichever page of the phase started this drill.
  const heldAlert = useHeldDrillAlert(phaseId, drill);
  const [health, setHealth] = useState<DrillHealthResult | null>(null);
  const [writeUp, setWriteUp] = useState<WriteUp>(EMPTY);
  const [view,setView]=useState<'diagnosis'|'runbook'|'record'>('diagnosis');
  // One flag for all three drill routes: each runs a container check that
  // takes seconds and each writes the same record, so two in flight together
  // is a learner pressing two buttons (or ⌘⇧H then ⌘↵) rather than a race
  // they had to be unlucky to hit.
  const [drillBusy, setDrillBusy] = useState<'start' | 'health' | 'resolve' | null>(null);
  const starting = drillBusy === 'start';
  const checking = drillBusy === 'health';
  const resolving = drillBusy === 'resolve';
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // The chip counts up while the deployment is down, so the cost of the outage
  // is on the page rather than in the learner's head.
  const [now, setNow] = useState(() => Date.now());

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
    setDrill(d.drill ?? null);
    setSubmission((prev) => prev ?? d.lastSubmission);
  }, [phaseId]);

  useEffect(() => {
    let active = true;
    const owner = getSession()?.id;
    const token = getToken();
    setError('');
    load().catch((error: unknown) => {
      if (active && alive.current && getSession()?.id === owner && sameSession(getToken(), token)) setError(describeError(error, 'The drill could not be loaded. Try again.'));
    });
    return () => { active = false; };
  }, [load, attempt]);

  /*
   * The drill page holds the workspace's mentor with both of its modes,
   * so it takes part in the assistant's three signals, as the change room and
   * the workspace do. Before a proposal operation its save buffer is saved
   * (a runbook edit recovered here from the workspace's Runbook tab is the
   * one thing it can hold), because the operation reads the saved workspace.
   * While one runs nothing is started or declared from here (Start the drill,
   * Run the selfcheck, Declare resolved and their keys) and the incident's
   * form is held: its box is inert, so nothing is unmounted and the layout
   * does not move. After an Apply the phase is read again, which the save
   * buffer takes as its new base, and the page says that what the drill shows
   * was taken before the change.
   *
   * Start the drill is not inside the held box
   * (its own `disabled` and sentence hold it, as Run the selfcheck's do, so the
   * sentence can be read). If the read after an Apply fails, the page says so
   * and what to do, and keeps holding Start, the selfcheck and Declare resolved
   * (each runs or records against the saved workspace, which this page has not
   * read back, and the mentor refuses another proposal until it is), but
   * not the incident's form: its three lines are the learner's own words,
   * held in this page and sent only with Declare resolved, which neither the
   * failed read nor the save queue touches, so holding them would hold nothing.
   */
  const [appliedHere, setAppliedHere] = useState(false);
  const refreshApplied = useCallback(async () => {
    setAppliedHere(true);
    await load();
    if (alive.current) invalidateProject();
  }, [load]);
  const readBack = useAppliedReadBack(phaseId, refreshApplied);
  const agentBusy = useAgentWorkspace(phaseId, flushSave, readBack.readBack);
  // The proposal has finished; only the page's read of it is missing.
  const unread = agentBusy && readBack.failed;
  const holding = useRef(false);
  holding.current = agentBusy;
  // The box that holds the drill's panels and the incident's form: inert while a proposal operation runs, not once
  // only the read-back is missing (see above).
  const formHeld = agentBusy && !unread;
  const hold = useCallback((node: HTMLDivElement | null) => { if (node) node.inert = formHeld; }, [formHeld]);
  const runHold = agentBusy ? (unread ? READ_BACK_HOLD_RUN_REASON : PROPOSAL_HOLD_RUN_REASON) : undefined;

  // Deployment is the only phase with a drill; anything else goes to its room.
  useEffect(() => {
    if (detail && detail.key !== 'deployment') router.replace(`/workspace/${detail.id}`);
  }, [detail, router]);

  useEffect(() => {
    if (!drill || drill.resolvedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [drill]);

  const start = useCallback(async () => {
    const owner = getSession()?.id;
    const token = getToken();
    if (actionInFlight.current || holding.current || !detail || !owner || !token) return;
    const owns = () => alive.current && getSession()?.id === owner && sameSession(getToken(), token);
    if (drillBusy) return;
    actionInFlight.current = true;
    setAppliedHere(false);
    setDrillBusy('start');
    setError('');
    try {
      await flushSave();
      if (!owns()) return;
      const state = await api.drillStart(phaseId);
      if (!owns()) return;
      setDrill(state);
      setBeforeStderr(state.beforeStderr ?? '');
      rememberDrillAlert(phaseId, state.pagedAt, state.beforeStderr ?? '');
      await load();
    } catch (err) {
      if (owns()) setError(errorText(err));
    } finally {
      actionInFlight.current = false;
      if (alive.current) setDrillBusy(null);
    }
  }, [detail, drillBusy, flushSave, load, phaseId]);

  const runHealth = useCallback(async () => {
    const owner = getSession()?.id;
    const token = getToken();
    if (actionInFlight.current || holding.current || !detail || !owner || !token) return;
    const owns = () => alive.current && getSession()?.id === owner && sameSession(getToken(), token);
    if (drillBusy || !drill) return;
    actionInFlight.current = true;
    setAppliedHere(false);
    setDrillBusy('health');
    setError('');
    setNotice('');
    try {
      // The check reads the files as saved, so anything still in the editor
      // has to reach the server before it runs.
      await flushSave();
      if (!owns()) return;
      const result = await api.drillHealth(phaseId);
      if (!owns()) return;
      setHealth(result);
      setNotice(
        result.exit === 0
          ? 'The health check passes on your files.'
          : `The health check still fails on your files: exit ${result.exit}.`,
      );
      await load();
    } catch (err) {
      if (owns()) setError(errorText(err));
    } finally {
      actionInFlight.current = false;
      if (alive.current) setDrillBusy(null);
    }
  }, [detail, drill, drillBusy, flushSave, load, phaseId]);

  const resolve = useCallback(async () => {
    const owner = getSession()?.id;
    const token = getToken();
    if (actionInFlight.current || holding.current || !detail || !owner || !token) return;
    const owns = () => alive.current && getSession()?.id === owner && sameSession(getToken(), token);
    if (drillBusy || !drill || drill.resolvedAt) return;
    // An older-format Deployment is not resolved here, as its room is not submitted; ⌘↵ stays quiet too.
    if (olderRecordSentence(detail)) return;
    if (!writeUpReady(writeUp)) {
      setError('All three lines need at least 20 characters before INCIDENT-1 can be closed.');
      return;
    }
    actionInFlight.current = true;
    setAppliedHere(false);
    setDrillBusy('resolve');
    setError('');
    setNotice('');
    try {
      await flushSave();
      if (!owns()) return;
      // The resolve writes the record's incident and a new save stamp: the
      // resolve answers its own new save stamp, so the next save quotes it, and
      // the phase is reloaded after it answers.
      await resolveAndReload(async () => {
        const state = await api.drillResolve(phaseId, {
          rootCause: writeUp.rootCause.trim(),
          fix: writeUp.fix.trim(),
          actionItem: writeUp.actionItem.trim(),
        });
        if (owns()) setDrill(state);
        return state;
      }, load);
      if (!owns()) return;
      setNotice(resolvedSentence(Boolean(detail.runbook)));
    } catch (err) {
      if (owns()) setError(errorText(err));
    } finally {
      actionInFlight.current = false;
      if (alive.current) setDrillBusy(null);
    }
  }, [detail, drill, drillBusy, flushSave, load, phaseId, writeUp]);

  /**
   * What this room settles before the pass banner hands the learner on.
   *
   * The runbook is saved on a debounce, and the only other flush is the one
   * that leaves with the page: unawaited, and after the router has already
   * moved. The reflection and the advance belong to the banner; this is the
   * write that has to land first, because the runbook is the record the next
   * phase and the incident report read. A conflict is not flushable: only the
   * comparison can settle it, so the learner is kept here to make that choice.
   */
  const continueGuard = useCallback(async () => {
    if (conflict) throw new Error(CONTINUE_BLOCKED);
    try {
      await flushSave();
    } catch {
      throw new Error(CONTINUE_BLOCKED);
    }
  }, [conflict, flushSave]);

  // ⌘⇧H runs the health check, ⌘↵ declares it resolved: the same two acts the
  // buttons name, bound in the capture phase so a textarea cannot eat them.
  const actions = useRef({ health: runHealth, resolve });
  actions.current = { health: runHealth, resolve };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (workspaceShortcutBlocked(e.target)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void actions.current.resolve();
        return;
      }
      if (e.shiftKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        void actions.current.health();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const nav = railOf(enrollment, analytics, currentPhase);
  // No fallback name: naming the wrong project until the enrolment loads is
  // worse than a trail that starts at the phase.
  const projectTitle = projectName(enrollment?.projectTitle);
  const crumbs = [
    ...(projectTitle
      ? [{ label: projectTitle, href: '/dashboard', testId: 'back-dashboard' }]
      : []),
    { label: detail?.title ?? 'Deployment', href: '/phases?phase=deployment' },
    { label: 'Incident drill' },
  ];

  if (!detail) {
    return (
      <DocPage crumbs={crumbs} active="work" nav={nav} testId="drill-page" title="Incident drill">
        <RoomFallback room="drill" error={error} onRetry={retry} />
      </DocPage>
    );
  }

  // A phase with the runbook record writes it in the IDE's Runbook tab: its
  // view here is a link to that tab, and no runbook diff is drawn.
  // A detail without the record (an older pinned version) has no runbook view.
  const record = Boolean(detail.runbook);
  const runbookNow = record ? files[RUNBOOK_JSON] ?? '' : '';
  const report = submission?.report?.drill ?? detail.lastSubmission?.report?.drill ?? null;
  const resolved = Boolean(drill?.resolvedAt);
  // A config Deployment with no runbook (an older pinned version): the room's sentence, drawn and given as Resolve's reason.
  const older = olderRecordSentence(detail);
  // The header's Submit is held by the rules every other page of the phase holds it by (the workspace's
  // `submitOff`, the planted bugs page's): an older record, the countersignature awaited, a revision still in review, an
  // assistant operation or its read-back, read from the same helpers for the task a submission from here answers.
  const submitTask = chooseTask(detail.tasks, null)?.key;
  const submitHold = older ?? submitOffReason(awaitingSignOff(detail, submitTask, submission), revisionInFlight(submission, submitTask, detail.lastSubmission ?? null)) ?? (agentBusy ? (unread ? READ_BACK_HOLD_REASON : PROPOSAL_HOLD_REASON) : undefined);
  // The workspace's edit view (Configuration), by the row's own address and word, where the applied change can be read.
  const editEntry = areaEntries(detail).find((entry) => entry.view === 'code');

  return (
    <>
    <PhaseDocumentFrame phase={detail} view="drill" title="Incident drill" titleTestId="drill-title"
      onBeforeContinue={continueGuard}
      // The working-area row is the frame's (the workspace's own row, entry for entry, Incident drill current);
      // this page's own sections are a second row under the heading, as the change request's are. Its name
      // ends in " working area", like the frame's row, so a step that looks for "Incident record" in a working area finds it.
      // The door to the pack's own answer, read in the header's Details as on the phase's other pages.
      // What the phase's other pages have, the way to the workspace and the phase's Submit, which
      // here submits by itself (the drill's own save first, then the page reads the phase again for the verdict, dropping
      // the revision it held so the drill report is the new one's).
      right={<><Button href={`/workspace/${detail.id}`} variant="secondary" size="sm" testId="open-workspace">Open the workspace</Button>{solutionDoorOpen(detail) && <Button href={solutionHref(detail)} variant="secondary" size="sm" icon="eye" testId="solution-open">Read the reference solution</Button>}<HeaderSubmit phase={detail} testId="header-submit" disabled={Boolean(drillBusy) || Boolean(submitHold)} reason={submitHold} submit={{ before: async () => { setVerdict(null); await flushSave(); }, after: async (settled) => { setVerdict(settled); setSubmission(null); await load(); } }} />{verdict && <HeaderSubmitVerdict phaseId={detail.id} settled={verdict} />}</>}
      subNav={<nav className="phase-room-nav phase-room-nav--sections" aria-label="Incident drill working area"><button type="button" aria-pressed={view==='diagnosis'} onClick={()=>setView('diagnosis')}>Diagnosis</button>{record && <button type="button" aria-pressed={view==='runbook'} onClick={()=>setView('runbook')}>Runbook</button>}<button type="button" aria-pressed={view==='record'} onClick={()=>setView('record')}>Incident record</button></nav>}
      // The brief column holds what the workspace's does, so the page needs no Brief link of its own.
      mission={<MissionDetails phase={detail} detail={detail} lessons={lessonsOfferedOn(enrollment, 'deployment', { [detail.id]: detail })} />}
      crumbs={crumbs}
      active="work"
      nav={nav}
      testId="drill-page"
    >
      {/* The title carries the state of the outage on the line under it: which
          phase this is, how long it has been broken, and who is watching. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {drill && (
              <Chip tone={resolved ? 'pass' : 'warn'} testId="drill-clock">
                {brokenFor(drill, now)}
              </Chip>
            )}

          </div>
        </div>
        <span className="flex-1" aria-hidden />
        {/* No "Brief" or "Back to the workspace" here. The frame draws the working-area row at every width, and
            its Configuration and Pipeline open the workspace; its brief column (with its switch at every width)
            holds the brief's words under "Mission and review criteria", as the workspace's does. */}
        {drill && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              keys="⌘⇧H"
              testId="phase-deployment-drill-health"
              busy={checking}
              busyLabel="Running"
              disabled={drillBusy !== null || agentBusy}
              reason={runHold}
              onClick={runHealth}
            >
              Run the selfcheck
            </Button>
            <Button
              keys="⌘↵"
              testId="phase-deployment-drill-resolve"
              busy={resolving}
              busyLabel="Checking the fix"
              disabled={resolved || drillBusy !== null || Boolean(older) || agentBusy}
              reason={older ?? (agentBusy && !resolved ? (unread ? READ_BACK_HOLD_RESOLVE_REASON : PROPOSAL_HOLD_RESOLVE_REASON) : undefined)}
              onClick={resolve}
            >
              {resolved ? 'Resolved' : 'Declare resolved'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3"><span className="label-sm" role="status" data-testid="save-state">{saving ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}</span></div>
      {saveError && <Notice tone="fail"><div className="flex flex-wrap items-center justify-between gap-3"><span>{saveError}</span><Button variant="secondary" disabled={saving} onClick={() => { if (conflict) setComparing(true); else void flushSave().catch(() => { /* A failed retry stays on the page as saveError. */ }); }}>{conflict ? 'Compare versions' : 'Retry save'}</Button></div></Notice>}

      {older && <Notice tone="info" testId="drill-older-format">{older}</Notice>}
      {(error || notice) && <Notice tone={error ? 'fail' : 'info'}>{error || notice}</Notice>}
      {unread && <Notice tone="warn" testId="applied-read-back">{READ_BACK_NOTICE}</Notice>}
      {/* The notice every room gives after an Apply. Once there is a drill to show, a second sentence:
          what it shows was taken before the change. Before the drill starts, the first sentence alone: the drill runs
          on the saved workspace as it is then (Start clears the notice). */}
      {appliedHere && (
        <Notice tone="info">
          <span data-testid="drill-applied-note">
            The reviewed proposal is saved in this workspace.{drill && (
              <> What this drill shows was taken before it, so run the selfcheck again to check the change, or <Link href={editEntry?.href ?? `/workspace/${detail.id}`} className="underline">open {editEntry?.label ?? 'Configuration'}</Link> to see it.</>
            )}
          </span>
        </Notice>
      )}

      {!drill ? (
        // The card the workspace's Pipeline tab draws before the drill, in the same words.
        <Section
          // A direct child of the document's scrolling flex column, which clips its overflow, so
          // on a short window it could otherwise be squeezed to its borders; it keeps its own height and the column scrolls.
          className="shrink-0"
          title={DRILL_CARD_TITLE}
          purpose={DRILL_CARD_PURPOSE}
          icon="warn"
          hue="deployment"
          right={<Chip>{DRILL_NOT_STARTED_CHIP}</Chip>}
        >
          <EmptyState
            icon="warn"
            title={DRILL_NOT_STARTED}
            body={drillNotStartedBody(runsReferenceApplication(detail.provenance))}
            action={
              <Button
                testId="phase-deployment-drill-start"
                busy={starting}
                busyLabel="Paging"
                disabled={agentBusy}
                reason={runHold}
                onClick={start}
                icon="play"
              >
                Start the drill
              </Button>
            }
          />
        </Section>
      ) : (
        // `contents`: the box is for the hold alone and takes no part in the layout.
        <div ref={hold} className="contents" aria-busy={formHeld || undefined} data-testid="drill-held">
        <div className="phase-drill-panels"><div hidden={view!=='diagnosis'}>
          <FaultedDeployment
            detail={detail}
            drill={drill}
            report={report}
            runbook={runbookNow}
            beforeStderr={beforeStderr || heldAlert || report?.beforeStderr || ''}
            health={health}
          />
          </div>{record && <div hidden={view!=='runbook'}><RunbookTabLink detail={detail} /></div>}
          <div hidden={view!=='record'} className="flex min-w-0 flex-col gap-3.5">
            <ResolveChecklist drill={drill} />
            <IncidentWriteUp drill={drill} value={writeUp} onChange={setWriteUp} disabled={resolved} />
          </div>
        </div>
        </div>
      )}
    </PhaseDocumentFrame>
    {comparing && conflict && <VersionedWorkspaceConflict title="runbook" conflict={conflict} files={files} saving={saving}
      onClose={() => setComparing(false)}
      onResolve={(choice, version) => { void resolveConflict(choice, version).then(() => setComparing(false)).catch(() => { /* A refused choice leaves the comparison open to choose again. */ }); }} />}
    </>
  );
}
