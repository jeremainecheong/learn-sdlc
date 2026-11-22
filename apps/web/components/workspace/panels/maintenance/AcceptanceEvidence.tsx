/**
 * The words under one acceptance item: what the change request's tests and the
 * verdict establish about it, and nothing more (see `acceptanceLines` in
 * ./regression). The Change tab and the change request page draw the same
 * words from this one component.
 */
import { andList } from '@learnsdlc/shared';
import { Fragment } from 'react';
import type { AcceptanceEvidence as Evidence, SuiteRun } from './regression';

/** Case names listed before the rest are counted. */
const LISTED = 5;
/** A suite name the learner typed is shown up to this many characters. */
const SUITE_CHARS = 80;

function Names({ names }: { names: string[] }) {
  const shown = names.slice(0, LISTED);
  return (
    <>
      {shown.map((name, i) => (
        <Fragment key={`${name}-${i}`}>
          {i > 0 && '; '}
          <span className="mono">{name}</span>
        </Fragment>
      ))}
      {names.length > LISTED && ` and ${names.length - LISTED} more`}
    </>
  );
}

function Run({ run }: { run: SuiteRun | null }) {
  if (!run || run.total === 0) return <>Your visible tests did not run in this review.</>;
  const head = `Your visible tests, ${run.passed} of ${run.total} passed: `;
  if (run.failed.length === 0) {
    return (
      <>
        {head}
        <Names names={run.names} />.
      </>
    );
  }
  return (
    <>
      {head}
      <Names names={run.failed} /> failed.
    </>
  );
}

const suiteWords = (suite: string) =>
  suite ? ` (${suite.length > SUITE_CHARS ? `${suite.slice(0, SUITE_CHARS - 1)}…` : suite})` : '';

/**
 * "T1 (overdue regression tests) covers AC-1 and AC-2 together." / "T1 and T2
 * cover AC-2." An id the ticket does not have is listed after the ticket's own
 * and said to be unknown: "T1 covers AC-1 and AC-9 together (AC-9 is not on the
 * ticket)."
 */
function lead(evidence: Extract<Evidence, { kind: 'suite' }>): string {
  const { entries, item } = evidence;
  if (entries.length === 1) {
    const [entry] = entries;
    const covers = entry.covers.length > 0 ? entry.covers : [item];
    const unknown = evidence.unknown.filter((id) => covers.includes(id));
    const aside = unknown.length > 0 ? ` (${andList(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not on the ticket)` : '';
    return `${entry.id}${suiteWords(entry.suite)} covers ${andList(covers)}${covers.length > 1 ? ' together' : ''}${aside}.`;
  }
  return `${andList(entries.map((e) => e.id))} cover ${item}.`;
}

export function AcceptanceEvidence({
  evidence,
  pr,
  stop = true,
}: {
  evidence: Evidence;
  pr: string;
  /**
   * End the one-sentence lines with a full stop. The change request page's
   * table has always drawn them without one; the run's words are two
   * sentences and always end with one.
   */
  stop?: boolean;
}) {
  const end = stop ? '.' : '';
  switch (evidence.kind) {
    case 'case':
      return (
        <>
          Checked by <span className="mono">{evidence.name}</span>
          {end}
        </>
      );
    case 'suite':
      return (
        <>
          {lead(evidence)} <Run run={evidence.run} />
          {evidence.change ? ` The change tests, ${evidence.change.toLowerCase()}.` : ''}
        </>
      );
    case 'change':
      return <>{`Checked by the change tests, ${evidence.result.toLowerCase()}${end}`}</>;
    default:
      return <>{`Checked by the hidden change tests when you submit ${pr}${end}`}</>;
  }
}
