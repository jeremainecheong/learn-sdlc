'use client';

/**
 * The change request, as a document: the ticket, the contract it asks for, the
 * suites it has to leave green, the graph it moved and the release it will
 * write. Five cards, each one a section of the page at /workspace/:id/change.
 *
 * Every reading comes from {@link useMaintenance}; these components hold no
 * state of their own beyond the text a learner is typing into the contract.
 * The Change tab in the IDE draws the same model in a narrow column: the
 * shapes differ, the model does not.
 */
import { andList } from '@learnsdlc/shared';
import type { AnalyzerFunction, ExecutionRunView, ImpactReport } from '@learnsdlc/shared';
import { Avatar, Button, CellTitle, Chip, EmptyState, Notice, Section, Table } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { Thumb } from '@/components/shell';
import { ChangeImpact } from './ChangeImpact';
import { ClauseRow, Inline } from './Rows';
import { CONTRACTS_JSON, NAME_THE_OPERATION_FIRST, baseName, type ContractOperation } from './contracts';
import { caseLabel, firstLine } from './regression';
import { emptyImpact } from './impact';
import { AcceptanceEvidence } from './AcceptanceEvidence';
import { blanksSentence, mergedLine, releaseHeading, releasePurpose } from './release';
import { count } from './change-signature';
import { clockTime } from '../../preview/copy';
import type { MaintenanceModel } from './useMaintenance';

/**
 * A ticket's first sentence is the one that says why it was filed, so it is
 * the sentence that is read; the rest is what to do about it.
 */
function Lede({ text }: { text: string }) {
  const cut = text.search(/\.\s/);
  const head = cut === -1 ? text : text.slice(0, cut + 1);
  const rest = cut === -1 ? '' : text.slice(cut + 1).trim();
  return (
    <p className="wrap text-[13.5px] leading-[1.55] text-ink2">
      <span className="font-semibold text-ink">
        <Inline text={head} />
      </span>
      {rest && (
        <>
          {' '}
          <Inline text={rest} />
        </>
      )}
    </p>
  );
}

/* ------------------------------- the ticket ------------------------------- */

/**
 * One row per acceptance line of the ticket, in its order, named by its id:
 * its state, and what the change request's tests and the verdict say about it.
 */
function acceptanceRows(m: MaintenanceModel, pr: string): React.ReactNode[][] {
  return m.lines.map((line, i) => [
    <CellTitle
      key={`${line.text}-${i}`}
      state={line.state}
      title={<Inline text={m.ticket.acceptance[i] ? `${m.ticket.acceptance[i].id} ${line.text}` : line.text} />}
      detail={<AcceptanceEvidence evidence={line.evidence} pr={pr} stop={false} />}
    />,
  ]);
}

/**
 * What the record and the verdict say about each acceptance line, on the Checks tab: the rows
 * the ticket card draws, for a change request whose Request tab is a form.
 */
export function AcceptanceChecks({ m, pr }: { m: MaintenanceModel; pr: string }) {
  if (m.lines.length === 0) return null;
  return (
    <Section
      title="Acceptance"
      purpose="Each acceptance line of the ticket, and what its tests show."
      icon="testing"
      // No phase hue: the strip is neutral, and each row's own chip says what is known.
      testId="phase-maintenance-acceptance"
    >
      <Table cols={[{ label: 'Acceptance line' }]} rows={acceptanceRows(m, pr)} minWidth={0} />
    </Section>
  );
}

export function ChangeTicket({ m, pr }: { m: MaintenanceModel; pr: string }) {
  const v1Names = m.v1.map((op) => baseName(op.name) || op.name).filter(Boolean);
  const regressionDetail = m.regressionSuite
    ? `The regression suite from the earlier phases: ${m.regressionSuite.result.toLowerCase()}`
    : 'The regression suite from the earlier phases stays green';

  /* One column, because a constraint has no result of its own: it is either
     honoured or it is the reason a suite went red, and the suite says so. */
  const rows: React.ReactNode[][] = [
    [
      <CellTitle
        key="regression"
        state={m.regressionState}
        title={
          v1Names.length > 0
            ? `${andList(v1Names)} must not change behaviour`
            : 'The operations from the earlier phases must not change behaviour'
        }
        detail={regressionDetail}
      />,
    ],
    ...acceptanceRows(m, pr),
    [
      <CellTitle
        key="contract"
        state={m.contractState}
        title="The contract comes first"
        detail={
          <>
            Write <span className="mono">{m.changeName}</span> in the design before the code, or the code is unclaimed
          </>
        }
      />,
    ],
  ];

  return (
    <Section
      title={`${m.ticket.id}: ${m.ticket.title}`}
      purpose="The change request, as the maintainer filed it. Read it like a ticket: what, why, what must not change."
      icon="requirements"
      hue="maintenance"
      testId="phase-maintenance-ticket"
    >
      <div className="flex min-w-0 flex-col gap-2.5">
        {m.ticket.summary && <Lede text={m.ticket.summary} />}
        <Table cols={[{ label: 'Constraint' }]} rows={rows} minWidth={0} />
      </div>
    </Section>
  );
}

/* ------------------------------- contract v2 ------------------------------ */

/** The operation the card claims, said in a sentence: its name, or what the ticket adds while the record names none. */
const claimed = (m: MaintenanceModel) => m.operation ?? `the operation ${m.ticket.id} adds`;

export function ContractV2({
  m,
  editable,
  onAdd,
  onPatch,
}: {
  m: MaintenanceModel;
  /** The pack ships an editable contracts file. Without one the clauses are read-only. */
  editable: boolean;
  onAdd: () => void;
  onPatch: (part: Partial<ContractOperation>) => void;
}) {
  return (
    <Section
      title="Contract v2"
      purpose={`Your design amendment. Until this exists, the map shows ${claimed(m)} as unclaimed.`}
      testId="phase-maintenance-contracts-v2"
    >
      {m.contractsError && (
        <Notice tone="fail">
          <span className="mono">{CONTRACTS_JSON}</span> is not valid JSON, so this editor has stepped aside:{' '}
          {m.contractsError} Fix the file in the workspace and the card comes back.
        </Notice>
      )}

      {!m.contractsError && !editable && (
        <Notice tone="warn">
          This project does not carry an editable <span className="mono">{CONTRACTS_JSON}</span>, so the clauses below
          can be read but not changed.
        </Notice>
      )}

      {!m.contractsError && !m.change && (
        <EmptyState
          icon="maintenance"
          title={m.operation ? `${m.operation} has no contract yet` : `The operation ${m.ticket.id} adds has no contract yet`}
          body="Write the contract before the code: the conformance ledger holds your implementation against what is written here."
          action={
            <span className="flex flex-col items-start gap-1.5">
              <button
                type="button"
                className="btn btn-sm"
                onClick={onAdd}
                disabled={!editable || !m.operation}
                data-testid="phase-maintenance-contract-v2-add"
              >
                <Icon name="plus" size={14} />
                {m.operation ? `Add the ${m.operation} contract` : 'Add the contract'}
              </button>
              {!m.operation && <span className="label-sm wrap" data-testid="phase-maintenance-contract-v2-unnamed">{NAME_THE_OPERATION_FIRST}</span>}
            </span>
          }
        />
      )}

      {!m.contractsError && m.change && (
        <div className="panel flex flex-col gap-1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono flex-1 text-[13.5px] font-bold text-ink">
              {baseName(m.change.name) || m.change.name}
            </span>
            <Chip tone="outline">{m.change.satisfies || m.ticket.id}</Chip>
            <Chip tone={m.contractWritten ? 'pass' : 'accent'}>{m.contractWritten ? 'Written' : 'Draft'}</Chip>
          </div>

          <ClauseRow label="Signature">
            <span className="mono wrap text-[12.5px] text-ink">{m.signature ?? m.change.name}</span>
          </ClauseRow>
          <ClauseRow label="Inputs">
            <textarea
              className="field text-[13px]"
              rows={2}
              value={m.change.inputs}
              readOnly={!editable}
              aria-label={`Inputs for ${baseName(m.change.name) || m.change.name}`}
              placeholder="What the caller passes, and what counts as valid"
              data-testid="phase-maintenance-contract-inputs"
              onChange={(e) => onPatch({ inputs: e.target.value })}
            />
          </ClauseRow>
          <ClauseRow label="Returns">
            <textarea
              className="field text-[13px]"
              rows={2}
              value={m.change.returns}
              readOnly={!editable}
              aria-label={`Returns for ${baseName(m.change.name) || m.change.name}`}
              placeholder="What comes back, in the caller's terms"
              data-testid="phase-maintenance-contract-returns"
              onChange={(e) => onPatch({ returns: e.target.value })}
            />
          </ClauseRow>
          <ClauseRow label="Raises">
            <textarea
              className="field text-[13px]"
              rows={2}
              value={m.change.errors}
              readOnly={!editable}
              aria-label={`Errors for ${baseName(m.change.name) || m.change.name}`}
              placeholder="Which call raises what, and when"
              data-testid="phase-maintenance-contract-errors"
              onChange={(e) => onPatch({ errors: e.target.value })}
            />
          </ClauseRow>
          <ClauseRow label="Example">
            <textarea
              className="field text-[13px]"
              rows={2}
              value={m.change.example ?? ''}
              readOnly={!editable}
              aria-label={`Example for ${baseName(m.change.name) || m.change.name}`}
              placeholder="One call, and what it leaves behind"
              onChange={(e) => onPatch({ example: e.target.value })}
            />
          </ClauseRow>
        </div>
      )}

      <div className="flex items-start gap-2.5">
        <Avatar initials="MT" phaseKey="maintenance" size={24} title="Maintainer" />
        <p className="wrap text-[13px] leading-[1.45] text-ink2">Maintainer: &ldquo;{m.maintainer}&rdquo;</p>
      </div>
    </Section>
  );
}

/* -------------------------------- regression ------------------------------ */

/**
 * The learner's own last run of the phase's tests, as the run log keeps it, in
 * words: "Your last run: 3 of 3 passed at 11:17." Null for a run that counted
 * no tests (a run that did not start, say), so nothing is claimed about it.
 */
export function lastRunLine(run: Pick<ExecutionRunView, 'createdAt' | 'result'> | null | undefined): string | null {
  const tests = run?.result?.tests;
  if (!run || !tests || tests.total === 0) return null;
  return `Your last run: ${tests.passed} of ${tests.total} passed at ${clockTime(run.createdAt)}.`;
}

export function RegressionTable({
  m,
  pr,
  onSubmit,
  busy,
  reason,
  lastRun,
  running = m.reviewRunning,
  hasPr = !m.awaitingVerdict,
}: {
  m: MaintenanceModel;
  pr: string;
  onSubmit: () => void;
  busy: boolean;
  /**
   * Whether the phase has a submission, by the header's own test (`phaseHasPr`: a last submission or any attempt),
   * so the card's Submit and the header's carry one name. Without it, whether a verdict is held.
   */
  hasPr?: boolean;
  /**
   * Whether the page holds a revision in flight (its own `pendingRevision`, which ages out and gives way to a
   * newer read and to another task's revision), so the card says the review is running exactly while the
   * header's Submit says so. Without it, the held submission's raw status.
   */
  running?: boolean;
  /**
   * The learner's newest completed run of the phase's tests (Run tests in the
   * workspace), read from the run log. Before any verdict the card says what
   * that run showed rather than that nothing has run.
   */
  lastRun?: Pick<ExecutionRunView, 'createdAt' | 'result'> | null;
  /**
   * Why the control is off, as the room's own
   * Submit says it (the countersignature, or a revision in flight). Carried as
   * the button's tooltip and accessible description; nothing while it is on.
   */
  reason?: string;
}) {
  const killedAll = m.mutation ? m.mutation.killed === m.mutation.total : false;

  /* A red row names what went red. The failing case is the detail: the whole
     trace belongs to the run panel in the editor, not to a summary table. */
  const rows: React.ReactNode[][] = m.suites.map((suite) => {
    const failing = suite.cases.filter((c) => c.status !== 'passed');
    return [
      <CellTitle
        key={suite.id}
        state={suite.state}
        title={suite.title}
        detail={
          <>
            {suite.detail}
            {failing.length > 0 && (
              <>
                {' — '}
                <span className="mono">{failing.slice(0, 3).map((c) => caseLabel(c.name)).join(', ')}</span>
                {failing.length > 3 && ` and ${failing.length - 3} more`}
                {failing.length === 1 && failing[0].message && `: ${firstLine(failing[0].message)}`}
              </>
            )}
          </>
        }
      />,
      <Chip key={`${suite.id}-r`} tone={suite.state === 'pass' ? 'pass' : 'fail'}>
        {suite.result}
      </Chip>,
    ];
  });

  if (m.mutation) {
    rows.push([
      <CellTitle
        key="mutation"
        state={killedAll ? 'pass' : 'fail'}
        title={`Planted bugs for ${m.ticket.id}`}
        detail={`${count(m.mutation.total, 'mutant')} run against your tests`}
      />,
      <Chip key="mutation-r" tone={killedAll ? 'pass' : 'fail'}>
        {killedAll ? `All ${m.mutation.total} caught` : `${m.mutation.killed} of ${m.mutation.total} caught`}
      </Chip>,
    ]);
  }

  const ranLine = lastRunLine(lastRun);
  return (
    <Section
      title="Regression"
      purpose="Every test from earlier phases, run again against your change. Green means nothing you already promised has broken."
      icon="testing"
      // No phase hue: green is what this card's own sentence says a pass looks like, so the strip stays neutral
      // and the rows' chips carry the verdict once there is one.
      testId="phase-maintenance-regression"
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="testing"
          title="No verdict yet"
          body={
            // While the review runs, the learner has just submitted: the card says so, and offers no Submit (the
            // header holds its own, with the reason).
            running
              ? `${ranLine ? `${ranLine} ` : ''}The review is running these tests now, with the hidden change tests.`
              : ranLine
                ? `${ranLine} The review runs these tests again, with the hidden change tests, when you submit ${pr}.`
                : `The change tests and the regression suite run when you submit ${pr}.`
          }
          testId="phase-maintenance-regression-empty"
          action={
            // It submits, so it says so, by the name every submit control of the phase carries;
            // the header's Submit is the page's primary, so this one is secondary.
            running ? undefined : (
              <Button size="sm" variant="secondary" icon="pr" onClick={onSubmit} disabled={busy} reason={reason}>
                {hasPr ? `Submit ${pr} again` : `Submit ${pr}`}
              </Button>
            )
          }
        />
      ) : (
        <Table
          cols={[{ label: 'Suite' }, { label: 'Result', width: 'auto', align: 'right' }]}
          rows={rows}
          minWidth={300}
        />
      )}
    </Section>
  );
}

/* ------------------------------ release record ---------------------------- */

/**
 * The release record as the merge will publish it, drawn from the change
 * request's release and the other artefacts. It writes no file: the release is
 * written in the Release tab's form beside it.
 */
export function ReleaseRecordCard({ m, pr }: { m: MaintenanceModel; pr: string }) {
  // A blank line is never printed as written: a reading where nothing moved has text ("Added: nothing. ...") but is
  // blank (`todo`), and the closing line names it as blank.
  const written = m.release.lines.filter((l) => l.state !== 'todo' && l.text.trim());
  return (
    <Section
      title={releaseHeading(m.release)}
      purpose={releasePurpose(m.release, m.ticket.id, pr)}
      testId="phase-maintenance-release"
    >
      {/* The record itself is not a form. It is the paragraph the merge will
          publish, drawn as the artefact it becomes, so a blank line reads as a
          piece of work rather than an empty field. */}
      <div className="flex items-start gap-3 rounded-ctl border-1.5 border-dashed border-edge2 p-3">
        {/* The tag names this record's version, or none while it is blank: never the drawing's own "1.1". */}
        <Thumb kind="release" size={96} hue="maintenance" label={m.release.versioned ? m.release.version : ''} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="wrap text-[13px] font-semibold text-ink">{m.release.title}</span>
          {written.length > 0 && (
            <p className="wrap text-[13px] leading-[1.45] text-ink2">
              {written.map((line) => (
                <span key={line.label}>
                  <span className="font-medium text-ink">{line.label}:</span> {line.text}{' '}
                </span>
              ))}
            </p>
          )}
          <span className="label-sm wrap">
            {/* The blank lines are written by the review on Submit, not by the merge; the merge publishes the record. */}
            {mergedLine(m.release, pr) ?? `${blanksSentence(m.release)} The record is published when ${pr} merges.`}
          </span>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------ change impact ----------------------------- */

export function ChangeImpactCard({
  m,
  impact,
  functions,
  onOpen,
  pr,
}: {
  m: MaintenanceModel;
  impact: ImpactReport | undefined;
  functions: AnalyzerFunction[];
  onOpen: (path: string) => void;
  pr: string;
}) {
  return (
    <Section
      // The change page draws this card straight in the document's scrolling column, a flex column. A
      // Section clips its overflow, and a flex item that clips has no minimum height, so a long page squeezed the
      // card to its borders (2 px at 1440 x 900, the graph unseen). It keeps its own height; the column scrolls.
      className="shrink-0"
      title="Change impact"
      purpose="The call graph before and after. Drawn from your code; nothing to fill in."
      testId="phase-maintenance-impact"
    >
      {m.impactCount === 0 ? (
        <EmptyState
          icon="diagram"
          {...emptyImpact(pr, !m.awaitingVerdict, m.reviewRunning, m.analysis)}
        />
      ) : (
        <ChangeImpact impact={impact} functions={functions} editablePaths={m.editablePaths} onOpen={onOpen} />
      )}
    </Section>
  );
}
