'use client';

/**
 * INCIDENT-1 as a document: the three columns an on-call engineer works in.
 *
 * Left, what the isolated selfcheck inspected and printed. Middle, the door to
 * the runbook: a phase with the runbook record (`detail.runbook`) writes it in
 * the IDE's Runbook tab, never here, and the health command is read from the
 * record's first health check. Right, the things that have to be true and the
 * two lines a machine cannot write.
 *
 * The derivations are the panel's: {@link timelineEvents} reads the drill,
 * {@link IncidentTimeline} draws it.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { DRILL_ANSWER_MAX, DRILL_ANSWER_MIN, validateRunbookRecord, type DrillReport, type DrillState, type PhaseDetail } from '@learnsdlc/shared';
import type { DrillHealthResult } from '@/lib/api';
import { Chip, Section, StatusSquare, Steps, Table, CellTitle } from '@/components/ui';
import { IncidentTimeline } from './Timeline';
import {
  clock,
  faultedPurpose,
  faultedRow,
  healthOutputTitle,
  healthRow,
  resolveSteps,
  shippedName,
  timelineEvents,
} from './drill';
import { runsReferenceApplication } from '@/components/workspace/application';

/* ------------------------------- terminals ------------------------------- */

export function Terminal({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'fail' }) {
  return (
    <pre
      className={`m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-ctl px-3 py-2.5 font-mono text-[12px] leading-[1.65] ${
        tone === 'fail' ? 'bg-code text-fail' : 'bg-code text-ink2'
      }`}
    >
      {text}
    </pre>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="label-sm">{label}</span>
      {children}
    </div>
  );
}

/* -------------------------- the faulted deployment ----------------------- */

/** The command the record's first health check names, or null when it names none. */
function recordHealthCommand(text: string): string | null {
  const how = validateRunbookRecord(text).runbook?.health[0]?.how.trim();
  return how ? how : null;
}

export function FaultedDeployment({
  detail,
  drill,
  report,
  runbook,
  beforeStderr,
  health,
}: {
  detail: PhaseDetail;
  drill: DrillState;
  report: DrillReport | null;
  runbook: string;
  beforeStderr: string;
  health: DrillHealthResult | null;
}) {
  // On a teacher's own application, only the files it
  // ships are named, and its selfcheck is not TaskTrackr's Compose check.
  const reference = runsReferenceApplication(detail.provenance);
  // `runbook` is the record's text, and the runbook is named in words, never by a file name.
  // A detail without the record (an older pinned version) names no runbook here.
  const record = Boolean(detail.runbook);
  const dockerPath = shippedName(detail, 'Dockerfile', 'the image definition');
  const command = record ? recordHealthCommand(runbook) : null;
  // The rows the workspace's Pipeline tab draws, in the same words and colours: the faulted copy is
  // named in words, its image tag kept as the name's title; the check on the learner's files says since when.
  const faulted = faultedRow(drill);
  const checkRow = healthRow(drill);

  return (
    <Section
      title="The faulted configuration"
      purpose={faultedPurpose(reference, record)}
      testId="phase-deployment-faulted"
    >
      {/* At 1280 a compressing table would crush its own status column,
          "Ex…" and "Reports hea…", and break the health-check URL inside
          the word. The row scrolls rather than compressing, the chips never
          shrink, and the command is one unbroken line in its own box. */}
      <Table
        minWidth={420}
        cols={[
          { label: 'Selfcheck', width: 'minmax(0,1fr)' },
          { label: '', width: 'auto', align: 'right' },
        ]}
        rows={[
          [
            <CellTitle
              key="c"
              state={faulted.state}
              title={<span title={`${detail.projectSlug}:faulted`}>{faulted.title}</span>}
              detail={`Launcher read from ${dockerPath}, checked ${clock(drill.pagedAt)}`}
            />,
            <Chip key="r" tone={faulted.tone} title={faulted.chipTitle} className="shrink-0">
              {faulted.chip}
            </Chip>,
          ],
          [
            // The command the runbook names is printed once, in its own box below, not again in this row.
            <CellTitle key="h" state={checkRow.state} title={checkRow.title} detail={checkRow.detail} />,
            <Chip key="r" tone={checkRow.tone} className="shrink-0">
              {checkRow.chip}
            </Chip>,
          ],
        ]}
      />

      {record && (
        <Labelled label="Your documented health command (not executed by this drill)">
          <Terminal
            text={
              command
                ? `$ ${command}`
                : `No health check in your runbook yet. A check that only prints healthy will report healthy on a container that is already dead.`
            }
          />
        </Labelled>
      )}

      <div data-testid="phase-deployment-drill-before">
        <Labelled label="Selfcheck output">
          {beforeStderr ? (
            <Terminal text={beforeStderr} tone="fail" />
          ) : (
            <p className="label-sm wrap">
              You were paged at {clock(drill.pagedAt)}. This page no longer holds the alert text; your next review
              brings it back.
            </p>
          )}
        </Labelled>
      </div>

      {report?.faultDescription && <p className="purpose wrap">{report.faultDescription}</p>}

      {health && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="phase-deployment-drill-health-result" aria-live="polite">
          {/* What it printed; its verdict is the row above. */}
          <p className="group-title">{healthOutputTitle(health.exit)}</p>
          {health.startedBy && (
            <p className="label-sm wrap">
              Started by <span className="mono">{health.startedBy}</span>, the command {dockerPath.startsWith('the ') ? dockerPath : `your ${dockerPath}`} names.
            </p>
          )}
          {health.stdout && <Terminal text={health.stdout} />}
          {health.stderr && <Terminal text={health.stderr} tone="fail" />}
          {!health.stdout && !health.stderr && <p className="label-sm wrap">The check printed nothing.</p>}
        </div>
      )}
    </Section>
  );
}

/* --------------------------------- runbook ------------------------------- */

/** A phase with the runbook record: the runbook is written in the IDE's Runbook tab, and this is the door to it. */
export function RunbookTabLink({ detail }: { detail: Pick<PhaseDetail, 'id'> }) {
  return (
    <Section title="Runbook" purpose="The runbook is written in the Runbook tab." testId="drill-runbook-tab">
      <Link href={`/workspace/${detail.id}?panel=runbook`} className="btn-secondary btn-sm self-start" data-testid="drill-open-runbook">
        Open the Runbook tab
      </Link>
    </Section>
  );
}

/* ------------------------------ declare it resolved ---------------------- */

export function ResolveChecklist({
  drill,
}: {
  drill: DrillState;
}) {
  // The workspace's three steps, in its words.
  const items = resolveSteps(drill);
  return (
    <Section
      title="Declare it resolved"
      purpose="Resolution records the failing and recovered selfcheck plus your incident write-up."
      testId="phase-deployment-drill-checklist"
    >
      <Steps items={items} className="drill-steps" />
    </Section>
  );
}

/* -------------------------------- the write-up --------------------------- */

export interface WriteUp {
  rootCause: string;
  fix: string;
  actionItem: string;
}

function Field({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
  testId,
  rows,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  rows: number;
  disabled?: boolean;
}) {
  const written = value.trim().length;
  const short = written > 0 && written < DRILL_ANSWER_MIN;
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1">
      <span className="label-sm text-ink2">{label}</span>
      {hint && <span className="label-sm">{hint}</span>}
      <textarea
        id={id}
        data-testid={testId}
        className="field text-[13px]"
        rows={rows}
        maxLength={DRILL_ANSWER_MAX}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className={`label-sm wrap ${short ? 'text-warn' : ''}`}>
        At least {DRILL_ANSWER_MIN} characters. {written} written.
      </span>
    </label>
  );
}

/** The drawn timeline, then the lines the drill cannot write for you. */
export function IncidentWriteUp({
  drill,
  value,
  onChange,
  disabled = false,
}: {
  drill: DrillState;
  value: WriteUp;
  onChange: (next: WriteUp) => void;
  disabled?: boolean;
}) {
  const events = useMemo(() => timelineEvents(drill, drill.healthExit === 0), [drill]);
  const written = drill.incident;
  return (
    <Section
      title="INCIDENT-1"
      purpose="Drawn from the drill. You write the two lines that a machine cannot."
      testId="phase-deployment-incident-record"
      right={
        drill.resolvedAt ? (
          <Chip tone="pass">Resolved</Chip>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <StatusSquare state="warn" size={10} />
            <span className="label-sm">Open</span>
          </span>
        )
      }
    >
      <IncidentTimeline events={events} />
      <div className="flex min-w-0 flex-col gap-3">
        <Field
          id="incident-root-cause"
          label="Root cause"
          placeholder="What went wrong, in your words. Name the directive that caused it."
          value={written ? written.rootCause : value.rootCause}
          onChange={(v) => onChange({ ...value, rootCause: v })}
          testId="phase-deployment-incident-root-cause"
          rows={3}
          disabled={disabled}
        />
        <Field
          id="incident-fix"
          label="The fix"
          placeholder="The line you changed, and why the selfcheck accepts it now."
          value={written ? written.fix : value.fix}
          onChange={(v) => onChange({ ...value, fix: v })}
          testId="phase-deployment-incident-fix"
          rows={2}
          disabled={disabled}
        />
        <Field
          id="incident-action"
          label="What would have caught it earlier"
          placeholder="One or two sentences."
          value={written ? written.actionItem : value.actionItem}
          onChange={(v) => onChange({ ...value, actionItem: v })}
          testId="phase-deployment-incident-action"
          rows={2}
          disabled={disabled}
        />
      </div>
    </Section>
  );
}

/** True when every field the API demands is inside the window it enforces. */
export function writeUpReady(v: WriteUp): boolean {
  const ok = (s: string) => s.trim().length >= DRILL_ANSWER_MIN && s.trim().length <= DRILL_ANSWER_MAX;
  return ok(v.rootCause) && ok(v.fix) && ok(v.actionItem);
}
