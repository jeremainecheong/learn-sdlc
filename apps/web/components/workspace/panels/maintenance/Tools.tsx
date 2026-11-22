'use client';

/**
 * The Change tab: CR-1 as a ticket, the contract amendment it asks for, the
 * regression and change suites from the verdict, the call graph the change
 * moved, and the release record the merge will write.
 *
 * Everything is read from props or written back into a workspace file. The
 * panel fetches nothing.
 */
import { andList } from '@learnsdlc/shared';
import Link from 'next/link';
import { Chip, EmptyState, Notice, Section, StatusSquare } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { StatusState } from '@/lib/phase';
import type { PhasePanelProps } from '../types';
import { ClauseRow, Inline, ListHead, ListRow, SubHead } from './Rows';
import { ImpactGraph } from './ImpactGraph';
import {
  CONTRACTS_JSON,
  NAME_THE_OPERATION_FIRST,
  NO_CONTRACT_CHANGE,
  amendmentPurpose,
  baseName,
  emptyOperation,
  serializeContracts,
  upsertOperation,
  MARK_GLYPH as DIFF_GLYPH,
  MARK_WORD as DIFF_WORD,
  type ContractOperation,
  type DiffMark,
} from './contracts';
import { MARK_WORD, emptyImpact } from './impact';
import { caseLabel, firstLine } from './regression';
import { AcceptanceEvidence } from './AcceptanceEvidence';
import { mergedLine, releaseHeading, releasePurpose } from './release';
import { count } from './change-signature';
import { useMaintenance } from './useMaintenance';

/** The diff mark decides the square: an amendment is settled, a gap is not. */
const DIFF_STATE: Record<DiffMark, StatusState> = { added: 'pass', unchanged: 'done', missing: 'todo' };

export function MaintenanceTools(props: PhasePanelProps) {
  const { detail, setFile, helpers } = props;
  const m = useMaintenance(props);
  // Named by the phase's place in its own project, never its stored order.
  const pr = `PR-${detail.place}`;
  const contractsEditable = detail.files.find((f) => f.path === CONTRACTS_JSON)?.editable ?? false;
  // The teacher's contract switch: off, the change request asks for no contract (Deadline badge).
  const contractOff = detail.change?.contract === false;

  const writeContracts = (op: ContractOperation, index: number) => {
    setFile(CONTRACTS_JSON, serializeContracts(upsertOperation(m.doc, index, op)));
  };
  const patch = (part: Partial<ContractOperation>) => {
    if (!m.change) return;
    writeContracts({ ...m.change, ...part }, m.changeIndex);
  };
  // The contract added is the operation the change request names; with none named there is nothing to add.
  const addContract = () => {
    if (!m.operation) return;
    writeContracts(emptyOperation(m.operation, m.ticket.id), -1);
    helpers.setNotice(`${m.operation} added to ${CONTRACTS_JSON}.`);
  };

  // The header counts what the change did; "unchanged" is the legend's job.
  const moved = m.marks.filter((r) => r.mark !== 'unchanged');
  const v1Names = m.v1.map((op) => baseName(op.name) || op.name).filter(Boolean);
  const regressionDetail = m.regressionSuite
    ? `The regression suite from the earlier phases: ${m.regressionSuite.result.toLowerCase()}.`
    : 'The regression suite from the earlier phases runs when you submit.';

  return (
    // The shape every phase panel uses in this slot: one surface, a 16px
    // inset, 16px between sections. Six panels share the container, so the
    // chrome cannot be six different insets.
    <div className="flex min-w-0 flex-col gap-4 p-4">
      {/* ------------------------------- the ticket ------------------------------ */}
      <Section
        title={`${m.ticket.id}: ${m.ticket.title}`}
        purpose="The change request, as the maintainer filed it. Read it like a ticket: what, why, what must not change."
        right={<Chip tone="outline">{pr}</Chip>}
        pad={false}
        testId="phase-maintenance-ticket"
      >
        <div className="flex flex-col gap-3">
          {m.ticket.summary && <p className="wrap px-4 text-[13.5px] leading-[1.55] text-ink2">{m.ticket.summary}</p>}

          <div className="flex flex-col">
            <ListHead left="Constraint" />
            <ListRow
              state={m.regressionState}
              title={
                v1Names.length > 0
                  ? `${andList(v1Names)} must not change behaviour`
                  : 'The operations from the earlier phases must not change behaviour'
              }
              detail={regressionDetail}
            />
            {m.lines.map((line, i) => (
              <ListRow
                key={`${line.text}-${i}`}
                state={line.state}
                title={<Inline text={m.ticket.acceptance[i] ? `${m.ticket.acceptance[i].id} ${line.text}` : line.text} />}
                detail={<AcceptanceEvidence evidence={line.evidence} pr={pr} />}
              />
            ))}
            {/* With the contract switch off the change request asks for no contract, so there is none to write first. */}
            {!contractOff && (
              <ListRow
                state={m.contractState}
                title="The contract comes first"
                detail={
                  <>
                    Write <span className="mono">{m.changeName}</span> in{' '}
                    <span className="mono">{CONTRACTS_JSON}</span> before the code, or the code is unclaimed.
                  </>
                }
              />
            )}
          </div>
        </div>
      </Section>

      {/* ------------------------------ contract v2 ------------------------------ */}
      <Section
        title="Contract v2"
        purpose={
          contractOff
            ? NO_CONTRACT_CHANGE
            : `Your design amendment. Until ${m.operation ?? `the operation ${m.ticket.id} adds`} is written here, the ledger reads the code as unclaimed.`
        }
        pad={false}
        testId="phase-maintenance-contracts-v2"
      >
        {/* With the contract switch off there is nothing to list or write: the
            purpose line above says so, and no seeded list or empty contract is drawn. */}
        {!contractOff && m.contractsError && (
          <div className="px-4">
            <Notice tone="fail">
              <span className="mono">{CONTRACTS_JSON}</span> is not valid JSON, so this editor has stepped aside:{' '}
              {m.contractsError} Fix the file in the editor and the cards come back.
            </Notice>
          </div>
        )}

        {!contractOff && !m.contractsError && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col">
              <ListHead left="Version 1, from your design" right="Clauses" />
              {m.v1.length === 0 ? (
                <div className="px-4">
                  <EmptyState
                    icon="design"
                    title="No operations were seeded"
                    body={
                      <>
                        <span className="mono">{CONTRACTS_JSON}</span> carries the contracts your design phase promised.
                        This workspace opened without them.
                      </>
                    }
                  />
                </div>
              ) : (
                m.v1.map((op) => (
                  <ListRow
                    key={op.name}
                    state="done"
                    mono
                    title={baseName(op.name) || op.name}
                    detail={op.returns || op.inputs || 'The design phase wrote no clause for this operation.'}
                    right={<Chip tone="outline">{op.satisfies || 'design'}</Chip>}
                  />
                ))
              )}
            </div>

            <div className="flex flex-col gap-3 px-4">
              <SubHead
                pad={false}
                title="Version 2, the amendment"
                purpose={amendmentPurpose(m.ticket.id, m.v1.length)}
              />
              {/* The clauses below go read-only when the pack does not ship an
                  editable contract file. Said out loud, because a locked field
                  still takes focus and a tooltip reaches nobody on a tablet. */}
              {!contractsEditable && (
                <Notice tone="warn">
                  This project does not carry an editable <span className="mono">{CONTRACTS_JSON}</span>, so the
                  clauses below can be read but not changed.
                </Notice>
              )}
              {!m.change ? (
                <EmptyState
                  icon="maintenance"
                  title={m.operation ? `${m.operation} has no contract yet` : `The operation ${m.ticket.id} adds has no contract yet`}
                  body="Write the contract before the code: the conformance ledger holds your implementation against what is written here."
                  action={
                    <span className="flex flex-col items-start gap-1.5">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={addContract}
                        disabled={!contractsEditable || !m.operation}
                        data-testid="phase-maintenance-contract-v2-add"
                      >
                        <Icon name="plus" size={14} />
                        {m.operation ? `Add the ${m.operation} contract` : 'Add the contract'}
                      </button>
                      {!m.operation && <span className="label-sm wrap" data-testid="phase-maintenance-contract-v2-unnamed">{NAME_THE_OPERATION_FIRST}</span>}
                    </span>
                  }
                />
              ) : (
                <div className="panel flex flex-col gap-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono flex-1 text-[13.5px] font-bold text-ink">
                      {baseName(m.change.name) || m.change.name}
                    </span>
                    <Chip tone="outline">{m.change.satisfies || m.ticket.id}</Chip>
                    <Chip tone={m.contractWritten ? 'pass' : 'warn'}>{m.contractWritten ? 'Written' : 'Draft'}</Chip>
                  </div>

                  <ClauseRow label="Signature">
                    <span className="mono wrap text-ink">{m.signature ?? m.change.name}</span>
                  </ClauseRow>
                  <ClauseRow label="Inputs">
                    <textarea
                      className="field text-[13px]"
                      rows={2}
                      value={m.change.inputs}
                      readOnly={!contractsEditable}
                      aria-label={`Inputs for ${baseName(m.change.name) || m.change.name}`}
                      placeholder="What the caller passes, and what counts as valid"
                      data-testid="phase-maintenance-contract-inputs"
                      onChange={(e) => patch({ inputs: e.target.value })}
                    />
                  </ClauseRow>
                  <ClauseRow label="Returns">
                    <textarea
                      className="field text-[13px]"
                      rows={2}
                      value={m.change.returns}
                      readOnly={!contractsEditable}
                      aria-label={`Returns for ${baseName(m.change.name) || m.change.name}`}
                      placeholder="What comes back, in the caller's terms"
                      data-testid="phase-maintenance-contract-returns"
                      onChange={(e) => patch({ returns: e.target.value })}
                    />
                  </ClauseRow>
                  <ClauseRow label="Errors">
                    <textarea
                      className="field text-[13px]"
                      rows={2}
                      value={m.change.errors}
                      readOnly={!contractsEditable}
                      aria-label={`Errors for ${baseName(m.change.name) || m.change.name}`}
                      placeholder="Which call raises what, and when"
                      data-testid="phase-maintenance-contract-errors"
                      onChange={(e) => patch({ errors: e.target.value })}
                    />
                  </ClauseRow>
                  <ClauseRow label="Example">
                    <textarea
                      className="field text-[13px]"
                      rows={2}
                      value={m.change.example ?? ''}
                      readOnly={!contractsEditable}
                      aria-label={`Example for ${baseName(m.change.name) || m.change.name}`}
                      placeholder="One call, and what it leaves behind"
                      onChange={(e) => patch({ example: e.target.value })}
                    />
                  </ClauseRow>
                </div>
              )}

              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-muted">
                  <Icon name="people" size={16} />
                </span>
                <p className="wrap text-[13px] leading-[1.45] text-ink2">Maintainer: {m.maintainer}</p>
              </div>
            </div>

            <div className="flex flex-col">
              <ListHead left="Version 1 to version 2" right="Change" />
              {m.diff.map((row) => (
                <ListRow
                  key={`${row.name}-${row.mark}`}
                  state={DIFF_STATE[row.mark]}
                  mono
                  title={
                    <>
                      {DIFF_GLYPH[row.mark] && <span className="mr-1.5 text-muted">{DIFF_GLYPH[row.mark]}</span>}
                      {row.name}
                    </>
                  }
                  detail={row.detail}
                  right={<Chip tone={row.mark === 'added' ? 'pass' : 'outline'}>{DIFF_WORD[row.mark]}</Chip>}
                  below={
                    row.clauses.length > 0 ? (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {row.clauses.map((c) => (
                          <li key={c.label} className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-2">
                            <span className="label-sm shrink-0 font-medium sm:w-[64px]">{c.label}</span>
                            <span className="wrap text-[12.5px] leading-[1.4] text-ink2">{c.text}</span>
                          </li>
                        ))}
                      </ul>
                    ) : undefined
                  }
                />
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ------------------------------- regression ------------------------------ */}
      <Section
        title="Regression"
        purpose="Every test from the earlier phases, run again against your change. Green means nothing you already promised has broken."
        pad={false}
        testId="phase-maintenance-regression"
      >
        <div className="flex flex-col">
          {m.suites.length === 0 ? (
            <div className="px-4">
              <EmptyState
                icon="testing"
                title="No verdict yet"
                body={`The change tests and the regression suite run when you submit ${pr}.`}
                action={
                  <button type="button" className="btn btn-sm" onClick={helpers.submitNow} disabled={helpers.busy}>
                    <Icon name="pr" size={14} />
                    {detail.lastSubmission ? `Update ${pr}` : `Open ${pr}`}
                  </button>
                }
              />
            </div>
          ) : (
            <>
              <ListHead left="Suite" right="Result" />
              {m.suites.map((suite) => (
                <ListRow
                  key={suite.id}
                  state={suite.state}
                  title={suite.title}
                  detail={suite.detail}
                  right={<Chip tone={suite.state === 'pass' ? 'pass' : 'fail'}>{suite.result}</Chip>}
                  below={
                    suite.failed > 0 ? (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {suite.cases
                          .filter((c) => c.status !== 'passed')
                          .map((c) => (
                            <li key={c.name} className="flex min-w-0 items-start gap-2">
                              <StatusSquare state="fail" size={9} className="mt-[5px]" />
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="mono wrap text-ink">{caseLabel(c.name)}</span>
                                {c.message && (
                                  <span className="wrap text-[12.5px] leading-[1.4] text-ink2">
                                    {firstLine(c.message)}
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                      </ul>
                    ) : undefined
                  }
                />
              ))}
              {m.mutation && (
                <ListRow
                  state={m.mutation.killed === m.mutation.total ? 'pass' : 'fail'}
                  title={`Planted bugs for ${m.ticket.id}`}
                  detail={`${count(m.mutation.total, 'mutant')} run against your tests.`}
                  right={
                    <Chip tone={m.mutation.killed === m.mutation.total ? 'pass' : 'fail'}>
                      {m.mutation.killed === m.mutation.total
                        ? `All ${m.mutation.total} caught`
                        : `${m.mutation.killed} of ${m.mutation.total} caught`}
                    </Chip>
                  }
                />
              )}
            </>
          )}
        </div>
      </Section>

      {/* ------------------------------ change impact ---------------------------- */}
      <Section
        title="Change impact"
        purpose="The call graph after your change. Drawn from your code; nothing to fill in."
        right={
          m.impactCount > 0 ? (
            <Chip tone="outline">
              {moved.length > 0
                ? moved.map((r) => `${r.n} ${MARK_WORD[r.mark].toLowerCase()}`).join(', ')
                : 'Nothing moved'}
            </Chip>
          ) : undefined
        }
        pad={false}
        testId="phase-maintenance-impact"
      >
        {m.impactCount === 0 ? (
          <div className="px-4">
            <EmptyState
              icon="diagram"
              {...emptyImpact(pr, !m.awaitingVerdict, m.reviewRunning, m.analysis)}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="px-4">
              <ImpactGraph
                impact={props.submission?.report?.impact}
                functions={props.submission?.report?.staticAnalysis?.functions ?? []}
                editablePaths={m.editablePaths}
                onOpen={helpers.openFile}
              />
            </div>
            <div className="flex flex-col">
              <ListHead left="What the change touched" right="Reached by" />
              {m.touched.length === 0 ? (
                <div className="px-4 pb-1">
                  <p className="purpose wrap">
                    Nothing is added or changed against the baseline yet. Write {m.changeName} and submit {pr}.
                  </p>
                </div>
              ) : (
                m.touched.map((fn) => (
                  <ListRow
                    key={fn.name}
                    state={fn.reachedBy.length > 0 ? 'pass' : 'warn'}
                    mono
                    title={fn.name}
                    detail={
                      fn.reachedBy.length > 0 ? (
                        <span className="mono">{fn.reachedBy.map((n) => caseLabel(n)).join(', ')}</span>
                      ) : (
                        'No test in this verdict is named for it.'
                      )
                    }
                    right={
                      <Chip tone={fn.change === 'added' ? 'pass' : 'warn'}>
                        {fn.reachedBy.length === 0 ? 'No test by name' : count(fn.reachedBy.length, 'test')}
                      </Chip>
                    }
                  />
                ))
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ------------------------------ release record --------------------------- */}
      <Section
        title={releaseHeading(m.release)}
        purpose={releasePurpose(m.release, m.ticket.id, pr)}
        right={<Chip tone={m.release.merged ? 'pass' : 'outline'}>{m.release.merged ? 'Merged' : 'Draft'}</Chip>}
        pad={false}
        testId="phase-maintenance-release"
      >
        <div className="flex flex-col gap-4 px-4">
          <div
            className={`flex flex-col gap-2 rounded-ctl border-1.5 p-3 ${
              m.release.merged ? 'border-edge2 bg-raised' : 'border-dashed border-edge2'
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-muted">
                <Icon name="merge" size={16} />
              </span>
              <span className="h3 flex-1 wrap">{m.release.title}</span>
            </div>

            <div className="flex flex-col">
              {m.release.lines.map((line) => (
                <ClauseRow key={line.label} label={line.label}>
                  <span className="flex min-w-0 items-start gap-2">
                    <StatusSquare state={line.state} size={9} className="mt-[5px]" />
                    <span className={`wrap text-[13px] leading-[1.45] ${line.text ? 'text-ink' : 'text-muted'}`}>
                      {line.text || line.todo}
                    </span>
                  </span>
                </ClauseRow>
              ))}
            </div>

            <p className="label-sm wrap">
              {mergedLine(m.release, pr) ?? `Written when ${pr} merges. You will not type this.`}
            </p>
          </div>

          {m.release.earlier.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="label-sm shrink-0 font-medium">Merged before this</span>
              {m.release.earlier.map((r) => (
                <Chip key={r.id} tone="outline">
                  {r.version}
                </Chip>
              ))}
            </div>
          )}

          {/* The release itself is written in the change room's Release tab, into the change request record. */}
          <p className="label-sm wrap" data-testid="phase-maintenance-release-door">
            The release is written in the change room&apos;s Release tab.{' '}
            <Link className="text-accent underline underline-offset-2 hover:text-ink" href={`/workspace/${detail.id}/change`}>
              Open the change room
            </Link>
          </p>
        </div>
      </Section>
    </div>
  );
}
