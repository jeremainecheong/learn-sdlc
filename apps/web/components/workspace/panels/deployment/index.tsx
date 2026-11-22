'use client';

/**
 * Deployment: the pipeline, the incident drill and the runbook.
 *
 * Everything here reads the learner's own files and the last verdict: the
 * pipeline is drawn from `ci.yml` as they type, the drill from the three drill
 * routes, and the runbook from the record (`deployment/runbook.json`) in the
 * Runbook view when the phase carries one. The panel never fetches: the props
 * carry it.
 */
import { useEffect, useId, useMemo, useReducer, useState } from 'react';
import {
  DRILL_ANSWER_MAX, DRILL_ANSWER_MIN, RUNBOOK_JSON, evaluateRunbookFloor, filledRunbookCounts, runbookFloorSentence, validateRunbookRecord,
  type DrillState,
} from '@learnsdlc/shared';
import type { DrillHealthResult } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { TechMark } from '@/components/TechMark';
import { Chip, Detail, EmptyState, Notice, Section, Steps, StatusSquare, Tabs, tabPanelProps } from '@/components/ui';
import type { StatusState } from '@/lib/phase';
import { scrollFocusRef } from '@/lib/scroll-focus';
import { runsReferenceApplication } from '@/components/workspace/application';
import type { PhasePanel, PhasePanelProps } from '../types';
import { readPipeline, type Pipeline } from './ci';
import {
  CI_PATH,
  DOCKERFILE_PATH,
  brokenFor,
  clock,
  errorText,
  exitWord,
  pathIn,
  shippedPath,
  timelineEvents,
  DRILL_CARD_PURPOSE,
  DRILL_CARD_TITLE,
  DRILL_NOT_STARTED,
  DRILL_NOT_STARTED_CHIP,
  drillNotStartedBody,
  faultedPurpose,
  faultedRow,
  healthOutputTitle,
  healthRow,
  pagedChip,
  resolveSteps,
} from './drill';
import { PipelineDrawing } from './Pipeline';
import { IncidentTimeline } from './Timeline';
import { RunbookTab } from './RunbookTab';
import { rememberDrillAlert, useHeldDrillAlert } from './alert-text';
import { olderRecordSentence } from '@/components/workspace/records';

const TH = 'label-sm border-b-1.5 border-edge2 pb-1.5 text-left font-medium';
const TD = 'border-b-1.5 border-edge py-2.5 align-top';

/** The path this phase actually uses, so a project that moves a file still resolves. */
const pathFor = (props: PhasePanelProps, wanted: string): string => pathIn(props.detail, wanted);

/* -------------------------------- pipeline ------------------------------- */

type ChipTone = 'pass' | 'fail' | 'warn' | 'neutral';

/** The status square that matches a chip, so a row's glyph and its result agree. */
const squareFor = (tone: ChipTone): StatusState =>
  tone === 'pass' ? 'pass' : tone === 'fail' ? 'fail' : tone === 'warn' ? 'warn' : 'todo';

function pipelineChip(pipe: Pipeline): { tone: ChipTone; label: string } {
  const todo = pipe.jobs.reduce((n, j) => n + j.steps.filter((s) => s.todo).length, 0);
  if (todo > 0) return { tone: 'warn', label: `${todo} step${todo === 1 ? '' : 's'} to write` };
  if (pipe.jobs.some((j) => j.state === 'fail')) return { tone: 'fail', label: 'Failed' };
  if (pipe.jobs.length > 0 && pipe.jobs.every((j) => j.state === 'pass')) {
    return { tone: 'pass', label: 'Passed' };
  }
  return { tone: 'neutral', label: 'Not run' };
}

function PipelineSection({ props, pipe }: { props: PhasePanelProps; pipe: Pipeline }) {
  const ciPath = pathFor(props, CI_PATH);
  const chip = pipelineChip(pipe);
  const stepCount = pipe.jobs.reduce((n, j) => n + j.steps.length, 0);
  const ran = Boolean(props.submission?.report?.ci?.length ?? props.detail.lastSubmission?.report?.ci?.length);
  return (
    <Section
      title="Pipeline"
      purpose={`Workflow declared in ${ciPath}. Review findings describe the configuration; workflow steps are not executed here.`}
      icon="deployment"
      hue="deployment"
      testId="phase-deployment-pipeline"
      className="deployment-pipeline-section"
      right={<Chip tone={chip.tone}>{chip.label}</Chip>}
    >
      {pipe.problem ? (
        <EmptyState
          icon="warn"
          title="No jobs to draw"
          body={`${pipe.problem} The workflow needs a jobs: block with at least one job.`}
          action={
            <button type="button" className="btn-secondary btn-sm" onClick={() => props.helpers.openFile(ciPath)}>
              <TechMark name="actions" size={14} />
              Open {ciPath}
            </button>
          }
        />
      ) : (
        <>
          <PipelineDrawing jobs={pipe.jobs} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="label-sm wrap">
              {pipe.jobs.length} job{pipe.jobs.length === 1 ? '' : 's'}, {stepCount} step
              {stepCount === 1 ? '' : 's'}.{' '}
              {ran
                ? 'Configuration findings are from your last review. Test and build execution remains unverified.'
                : 'The local selfcheck does not run GitHub Actions, build Docker images, or start Compose services.'}
            </p>
            <button
              type="button"
              className="btn-secondary btn-sm shrink-0"
              onClick={() => props.helpers.openFile(ciPath)}
            >
              <TechMark name="actions" size={14} />
              Open the workflow
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

/* ---------------------------------- drill -------------------------------- */

/**
 * What a selfcheck printed. Its lines wrap, as the drill page's do (DrillDoc's
 * Terminal): one long fault line ran off the panel's edge behind a sideways
 * scroll.
 */
function TerminalBlock({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'fail' }) {
  return (
    <pre
      className={`m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-ctl border-1.5 border-edge p-3 font-mono text-[11.5px] leading-relaxed ${
        tone === 'fail' ? 'bg-failtint text-fail' : 'bg-code text-ink2'
      }`}
    >
      {text}
    </pre>
  );
}

function IncidentField({
  id,
  label,
  hint,
  value,
  onChange,
  testId,
  rows = 3,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  rows?: number;
  disabled?: boolean;
}) {
  const written = value.trim().length;
  const short = written > 0 && written < DRILL_ANSWER_MIN;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <p className="label-sm wrap">{hint}</p>
      <textarea
        id={id}
        data-testid={testId}
        className="field"
        rows={rows}
        maxLength={DRILL_ANSWER_MAX}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className={`label-sm wrap ${short ? 'text-warn' : ''}`}>
        At least {DRILL_ANSWER_MIN} characters. {written} written.
      </p>
    </div>
  );
}

/**
 * Which drill route this panel is waiting on, or null.
 *
 * One flag for all three, shared with the resolve form below: start, health
 * and resolve all run a container check that takes seconds and all write the
 * same record, so two of them in flight together is a learner pressing two
 * buttons rather than a race they had to be unlucky to hit. The server merges
 * the two writes, which is what makes the record safe; this is what
 * stops the panel inviting the overlap in the first place.
 */
type DrillBusy = 'start' | 'health' | 'resolve' | null;

function ResolveForm({
  props,
  busy,
  setBusy,
}: {
  props: PhasePanelProps;
  busy: DrillBusy;
  setBusy: (busy: DrillBusy) => void;
}) {
  const [rootCause, setRootCause] = useState('');
  const [fix, setFix] = useState('');
  const [actionItem, setActionItem] = useState('');
  const [error, setError] = useState('');

  const saving = busy === 'resolve';
  const ok = (v: string) => v.trim().length >= DRILL_ANSWER_MIN && v.trim().length <= DRILL_ANSWER_MAX;
  const ready = ok(rootCause) && ok(fix) && ok(actionItem);
  // An older-format Deployment is not resolved, as the drill page and the API answer: the room's
  // sentence is drawn beside the button and given as its reason.
  const older = olderRecordSentence(props.detail);
  const reasonId = useId();

  const submit = async () => {
    if (older) return;
    setBusy('resolve');
    setError('');
    try {
      // The runbook and the Dockerfile are what the check reads, so anything
      // still in the editor has to reach the server before it runs.
      await props.helpers.flushSave();
      await props.drillApi.resolve({
        rootCause: rootCause.trim(),
        fix: fix.trim(),
        actionItem: actionItem.trim(),
      });
      // No page notice: the card under the steps says "INCIDENT-1 was resolved at …" where the learner is
      // looking, and a full-width notice over the room pushed all three columns down to repeat it.
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <IncidentField
        id="incident-root-cause"
        label="Root cause"
        hint="What went wrong, in your words. Name the directive that caused it."
        value={rootCause}
        onChange={setRootCause}
        testId="phase-deployment-incident-root-cause"
      />
      <IncidentField
        id="incident-fix"
        label="Fix"
        hint="The line you changed, and why the selfcheck accepts it now."
        value={fix}
        onChange={setFix}
        testId="phase-deployment-incident-fix"
      />
      <IncidentField
        id="incident-action"
        label="Action item"
        hint="What would have caught this before a person did."
        value={actionItem}
        onChange={setActionItem}
        testId="phase-deployment-incident-action"
      />
      {error && <Notice tone="fail">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-sm"
          data-testid="phase-deployment-drill-resolve"
          disabled={!ready || busy !== null || Boolean(older)}
          title={older ?? undefined}
          aria-describedby={older ? reasonId : undefined}
          onClick={submit}
        >
          <Icon name="check" size={14} />
          {saving ? 'Checking the fix…' : 'Resolve INCIDENT-1'}
        </button>
        {older ? (
          <p id={reasonId} className="label-sm wrap" data-testid="phase-deployment-drill-resolve-older">
            {older}
          </p>
        ) : (
          <p className="label-sm wrap">
            The platform runs the isolated selfcheck against your files before it accepts this, and only
            accepts it after a check has gone from failing to passing.
          </p>
        )}
      </div>
    </div>
  );
}

export function IncidentRecord({ props, drill }: { props: PhasePanelProps; drill: DrillState }) {
  // The incident is in the runbook record, and no runbook diff is drawn.
  const events = useMemo(() => timelineEvents(drill, drill.healthExit === 0), [drill]);
  const incident = drill.incident;
  return (
    <Section
      title="INCIDENT-1"
      /* Paged to the fix the health check recorded, the span the timeline
         draws; the card is drawn only once resolved, so the clock
         is never read here. */
      purpose={`${brokenFor(drill, Date.parse(drill.pagedAt))}. The two lines a machine cannot write are yours.`}
      icon="journal"
      hue="deployment"
      testId="phase-deployment-incident-record"
      right={<Chip tone="pass">Resolved</Chip>}
    >
      <IncidentTimeline events={events} />
      {incident && (
        <div className="flex min-w-0 flex-col gap-3">
          <Detail label="Root cause">{incident.rootCause}</Detail>
          <Detail label="Fix">{incident.fix}</Detail>
          <Detail label="Action item">{incident.actionItem}</Detail>
        </div>
      )}
    </Section>
  );
}

function DrillSection({ props, drill, openRunbook }: {
  props: PhasePanelProps;
  drill: DrillState | null;
  /** A phase with the runbook record: "Open the runbook" switches to the Runbook view rather than opening a file. */
  openRunbook?: () => void;
}) {
  const report = props.submission?.report ?? props.detail.lastSubmission?.report ?? null;
  const dockerPath = pathFor(props, DOCKERFILE_PATH);
  // A teacher's own application names only the files
  // it ships, and its selfcheck is its own, not TaskTrackr's Compose check.
  const reference = runsReferenceApplication(props.detail.provenance);
  const [busy, setBusy] = useState<DrillBusy>(null);
  const [error, setError] = useState('');
  const [startedStderr, setStartedStderr] = useState('');
  const [health, setHealth] = useState<DrillHealthResult | null>(null);
  // What the paged run printed, kept for this tab by whichever page of the phase started this drill.
  const heldAlert = useHeldDrillAlert(props.detail.id, drill);
  const starting = busy === 'start';
  const checking = busy === 'health';

  // A phase swap reuses this component; nothing from the last drill may show.
  useEffect(() => {
    setStartedStderr('');
    setHealth(null);
    setError('');
  }, [props.detail.id]);

  const start = async () => {
    setBusy('start');
    setError('');
    try {
      const state = await props.drillApi.start();
      setStartedStderr(state.beforeStderr ?? '');
      rememberDrillAlert(props.detail.id, state.pagedAt, state.beforeStderr ?? '');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const runHealth = async () => {
    setBusy('health');
    setError('');
    try {
      await props.helpers.flushSave();
      setHealth(await props.drillApi.health());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (!drill) {
    return (
      <Section
        title={DRILL_CARD_TITLE}
        purpose={DRILL_CARD_PURPOSE}
        icon="warn"
        hue="deployment"
        right={<Chip>{DRILL_NOT_STARTED_CHIP}</Chip>}
      >
        {error && <Notice tone="fail">{error}</Notice>}
        <EmptyState
          icon="warn"
          title={DRILL_NOT_STARTED}
          body={drillNotStartedBody(reference)}
          action={
            <button
              type="button"
              className="btn btn-sm"
              data-testid="phase-deployment-drill-start"
              disabled={busy !== null || props.helpers.busy}
              onClick={start}
            >
              <Icon name="play" size={14} />
              {starting ? 'Paging…' : 'Start the drill'}
            </button>
          }
        />
      </Section>
    );
  }

  const resolved = Boolean(drill.resolvedAt);
  // What the run against the faulted copy said when the learner was paged.
  // The API records it, so this panel draws the incident rather
  // than asserting it, and the server can refuse a write-up over a drill that
  // was never red. The two rows and the card's chip are said as the drill page
  // says them (`faultedRow`, `healthRow` in drill.ts).
  const faulted = faultedRow(drill);
  const checkRow = healthRow(drill);
  const paged = pagedChip(drill);
  const before = startedStderr || heldAlert || report?.drill?.beforeStderr || '';
  const faultDescription =
    report?.drill?.faultDescription ??
    'Read what the check printed, then read the file it names.';

  // The same three steps, in the same words, as the drill page's checklist.
  const steps = resolveSteps(drill);

  return (
    <>
      <Section
        title="The faulted configuration"
        purpose={faultedPurpose(reference, Boolean(openRunbook))}
        icon="warn"
        hue="deployment"
        right={<Chip tone={paged.tone}>{paged.label}</Chip>}
      >
        {error && <Notice tone="fail">{error}</Notice>}

        <div ref={scrollFocusRef} className="w-full overflow-x-auto">
          <table className="w-full min-w-[300px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Selfcheck
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={`${TD} pr-3`}>
                  <div className="flex items-start gap-2">
                    <span className="pt-[3px]">
                      <StatusSquare state={faulted.state} size={11} />
                    </span>
                    <div className="min-w-0">
                      <p className="wrap text-[13px] font-semibold text-ink">{faulted.title}</p>
                      <p className="wrap text-[12.5px] leading-[1.45] text-muted">{faultDescription}</p>
                    </div>
                  </div>
                </td>
                <td className={`${TD} text-right`}>
                  <Chip tone={faulted.tone} title={faulted.chipTitle}>
                    {faulted.chip}
                  </Chip>
                </td>
              </tr>
              <tr>
                <td className={`${TD} pr-3`}>
                  <div className="flex items-start gap-2">
                    <span className="pt-[3px]">
                      <StatusSquare state={checkRow.state} size={11} />
                    </span>
                    <div className="min-w-0">
                      <p className="wrap text-[13px] font-semibold text-ink">{checkRow.title}</p>
                      <p className="wrap text-[12.5px] leading-[1.45] text-muted">{checkRow.detail}</p>
                    </div>
                  </div>
                </td>
                <td className={`${TD} text-right`}>
                  <Chip tone={checkRow.tone}>{checkRow.chip}</Chip>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {reference && <Notice tone="warn">
          This selfcheck imports the API, initializes its database schema, and checks the Compose
          service address. It does not probe a running web proxy or prove container health.
        </Notice>}

        <div className="flex min-w-0 flex-col gap-1.5" data-testid="phase-deployment-drill-before">
          <p className="group-title">What the faulted copy printed</p>
          {before ? (
            <TerminalBlock text={before} tone="fail" />
          ) : (
            <p className="label-sm wrap">
              You were paged at {clock(drill.pagedAt)}. This tab no longer holds the alert text; your
              next review brings it back.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm"
            data-testid="phase-deployment-drill-health"
            disabled={busy !== null || props.helpers.busy}
            onClick={runHealth}
          >
            <Icon name="run" size={14} />
            {checking ? 'Running…' : 'Run the selfcheck'}
          </button>
          {shippedPath(props.detail, DOCKERFILE_PATH) !== null && <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => props.helpers.openFile(dockerPath)}
          >
            <TechMark name="docker" size={14} />
            Open the Dockerfile
          </button>}
          {openRunbook && <button
            type="button"
            className="btn-secondary btn-sm"
            data-testid="phase-deployment-open-runbook"
            onClick={openRunbook}
          >
            <Icon name="journal" size={14} />
            Open the runbook
          </button>}
        </div>

        {health && (
          <div
            className="flex min-w-0 flex-col gap-1.5"
            data-testid="phase-deployment-drill-health-result"
            aria-live="polite"
          >
            {/* What it printed; its verdict is the row above, so it is not said again here. */}
            <p className="group-title">{healthOutputTitle(health.exit)}</p>
            {health.startedBy && (
              <p className="label-sm wrap">
                Started by <span className="mono">{health.startedBy}</span>, the command your
                Dockerfile names.
              </p>
            )}
            {health.stdout && <TerminalBlock text={health.stdout} />}
            {health.stderr && <TerminalBlock text={health.stderr} tone="fail" />}
            {!health.stdout && !health.stderr && (
              <p className="label-sm wrap">The check printed nothing.</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Declare it resolved"
        purpose="All three must be true. The platform checks the first two by running them."
        icon="clipboard"
        hue="deployment"
      >
        <Steps items={steps} className="drill-steps" />
        {resolved ? (
          <Notice tone="pass">
            INCIDENT-1 was resolved at {clock(drill.resolvedAt)}. The record is below.
          </Notice>
        ) : (
          <ResolveForm props={props} busy={busy} setBusy={setBusy} />
        )}
      </Section>

      {resolved && <IncidentRecord props={props} drill={drill} />}
    </>
  );
}

/* --------------------------------- slots --------------------------------- */

function drillWord(drill: DrillState | null): { state: StatusState; label: string; detail: string } {
  if (!drill) {
    return {
      state: 'todo',
      label: 'Not started',
      detail: 'One outage against a faulted copy of your image, then the write-up.',
    };
  }
  if (drill.resolvedAt) {
    return {
      state: 'pass',
      label: 'Resolved',
      detail: `Paged at ${clock(drill.pagedAt)}, resolved at ${clock(drill.resolvedAt)}.`,
    };
  }
  return {
    state: 'warn',
    label: 'Paged',
    detail: `Paged at ${clock(drill.pagedAt)}. The container is still down.`,
  };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The brief's runbook line: the record's filled counts and the floor in words, and whether every floor rule is met. */
function runbookLine(floor: Parameters<typeof runbookFloorSentence>[0], text: string): { detail: string; met: boolean } {
  const runbook = validateRunbookRecord(text).runbook;
  const met = evaluateRunbookFloor(text, floor).every((result) => result.passed);
  const floorWords = `To pass, the runbook needs ${runbookFloorSentence(floor)}.`;
  if (!runbook) return { detail: `The runbook record is missing or not valid. ${floorWords}`, met };
  const n = filledRunbookCounts(runbook);
  return {
    detail: `${counted(n.environment, 'environment entry', 'environment entries')}, ${counted(n.health, 'health check', 'health checks')}, ${counted(n.rollback, 'rollback step', 'rollback steps')} and ${counted(n.data, 'data entry', 'data entries')} filled in the Runbook tab. ${floorWords}`,
    met,
  };
}

function Brief(props: PhasePanelProps) {
  const ciPath = pathFor(props, CI_PATH);
  // No workflow file, no pipeline row.
  const ci = shippedPath(props.detail, CI_PATH) !== null;
  const report = props.submission?.report ?? props.detail.lastSubmission?.report ?? null;
  const ciText = props.helpers.fileText(ciPath);
  const pipe = useMemo(() => readPipeline(ciText, report?.ci), [ciText, report]);
  const chip = pipelineChip(pipe);
  const drill = drillWord(props.drill);
  const stepCount = pipe.jobs.reduce((n, j) => n + j.steps.length, 0);
  const record = props.detail.runbook ? runbookLine(props.detail.runbook.floor, props.helpers.fileText(RUNBOOK_JSON)) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="phase-deployment-brief">
      <div className="min-w-0">
        <h2 className="h3">{ci ? 'Drill and pipeline' : 'Incident drill'}</h2>
        <p className="purpose">{ci ? 'INCIDENT-1 and the workflow you wrote, both on the Drill tab.' : 'INCIDENT-1, on the Drill tab.'}</p>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        <li className="flex items-start justify-between gap-3 border-t-1.5 border-edge py-2.5 first:border-t-0">
          <div className="flex min-w-0 items-start gap-2">
            <span className="pt-[3px]">
              <StatusSquare state={drill.state} size={11} />
            </span>
            <div className="min-w-0">
              <p className="wrap text-[13px] font-semibold text-ink">INCIDENT-1</p>
              <p className="wrap text-[12.5px] leading-[1.45] text-muted">{drill.detail}</p>
            </div>
          </div>
          <Chip
            tone={drill.state === 'pass' ? 'pass' : drill.state === 'warn' ? 'warn' : 'neutral'}
            className="shrink-0"
          >
            {drill.label}
          </Chip>
        </li>
        {ci && <li className="flex items-start justify-between gap-3 border-t-1.5 border-edge py-2.5">
          <div className="flex min-w-0 items-start gap-2">
            <span className="pt-[3px]">
              <StatusSquare state={squareFor(chip.tone)} size={11} />
            </span>
            <div className="min-w-0">
              <p className="wrap text-[13px] font-semibold text-ink">Pipeline</p>
              <p className="wrap text-[12.5px] leading-[1.45] text-muted">
                {pipe.problem
                  ? pipe.problem
                  : `${pipe.jobs.length} job${pipe.jobs.length === 1 ? '' : 's'}, ${stepCount} step${
                      stepCount === 1 ? '' : 's'
                    } in ${ciPath}.`}
              </p>
            </div>
          </div>
          <Chip tone={chip.tone} className="shrink-0">
            {chip.label}
          </Chip>
        </li>}
        {record && <li className="flex items-start justify-between gap-3 border-t-1.5 border-edge py-2.5" data-testid="phase-deployment-brief-runbook">
          <div className="flex min-w-0 items-start gap-2">
            <span className="pt-[3px]">
              <StatusSquare state={record.met ? 'pass' : 'todo'} size={11} />
            </span>
            <div className="min-w-0">
              <p className="wrap text-[13px] font-semibold text-ink">Runbook</p>
              <p className="wrap text-[12.5px] leading-[1.45] text-muted">{record.detail}</p>
            </div>
          </div>
          <Chip tone={record.met ? 'pass' : 'neutral'} className="shrink-0">
            {record.met ? 'Floor met' : 'Not yet'}
          </Chip>
        </li>}
      </ul>
      <div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={() => {
            props.helpers.setTab('phase');
            props.helpers.setPane('panel');
          }}
        >
          <Icon name="deployment" size={14} />
          Open the drill
        </button>
      </div>
    </div>
  );
}

function Tools(props: PhasePanelProps) {
  const ciPath = pathFor(props, CI_PATH);
  const report = props.submission?.report ?? props.detail.lastSubmission?.report ?? null;
  const ciText = props.helpers.fileText(ciPath);
  const pipe = useMemo(() => readPipeline(ciText, report?.ci), [ciText, report]);
  const [view, setView] = useState<'drill' | 'runbook'>(props.initialView === 'runbook' ? 'runbook' : 'drill');
  // The IDE keeps the tools mounted while `?panel=` moves, so a later `?panel=runbook` opens the Runbook view
  // too; any other value leaves the view the learner chose.
  useEffect(() => {
    if (props.initialView === 'runbook') setView('runbook');
  }, [props.initialView]);
  // A detail with a runbook draws the Runbook view beside the pipeline and the drill. An older-format one (a config
  // Deployment with no runbook) keeps the switch, and its Runbook view is the older-format notice; any other detail
  // without a runbook draws the pipeline and the drill alone.
  const hasRecord = Boolean(props.detail.runbook);
  const hasSwitch = hasRecord || olderRecordSentence(props.detail) !== null;
  // `fileText` answers the newest typed text of a room record at once, but the
  // IDE keeps that text in a ref and its own state settles after the first
  // keystroke, so the Tools redraw themselves on each write to show it.
  const runbookText = props.helpers.fileText(RUNBOOK_JSON);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const writeRunbook = (text: string) => {
    props.setFile(RUNBOOK_JSON, text);
    redraw();
  };

  const views = (
    <>
      {(view === 'drill' || !hasSwitch) && shippedPath(props.detail, CI_PATH) !== null && <PipelineSection props={props} pipe={pipe} />}
      {(view === 'drill' || !hasSwitch) && <DrillSection props={props} drill={props.drill} openRunbook={hasRecord ? () => setView('runbook') : undefined} />}
      {view === 'runbook' && hasSwitch && (
        <RunbookTab detail={props.detail} text={runbookText} onChange={writeRunbook}
          editable={!props.helpers.busy && !props.helpers.agentBusy} assisted={props.assisted} drillHref={`/workspace/${props.detail.id}/drill`} />
      )}
    </>
  );
  return (
    <div className="deployment-tool-evidence flex min-w-0 flex-col gap-4 p-4">
      {hasSwitch ? (
        <>
          {/* The product's tablist: one tab stop, arrows between the views, the selected view said to a reader. */}
          <Tabs
            label="Deployment tools"
            panelId="phase-deployment-view"
            value={view}
            onChange={(key) => setView(key === 'runbook' ? 'runbook' : 'drill')}
            items={[
              { key: 'drill', label: 'Pipeline and drill', testId: 'phase-deployment-tab-drill' },
              { key: 'runbook', label: 'Runbook', testId: 'phase-deployment-tab-runbook' },
            ]}
          />
          <div {...tabPanelProps('phase-deployment-view', view)} className="flex min-w-0 flex-col gap-4">{views}</div>
        </>
      ) : views}
    </div>
  );
}

const panel: PhasePanel = {
  Brief,
  Tools,
  toolsLabel: 'Drill',
  toolsIcon: 'deployment',
};

export default panel;
