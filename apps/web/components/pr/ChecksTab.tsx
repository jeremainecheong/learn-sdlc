'use client';

/**
 * Checks: the whole verdict, not the summary the right-hand card carries.
 *
 * What ran, which hidden cases did not pass and where, what the analyzer
 * found, and the conformance ledger, the design contract against what the
 * code actually did. The derivations are the implementation panel's; this is
 * the reading order a reviewer wants them in.
 */
import { pluralWord, type ContractClaim, type FeedbackReport, type TestCaseResult } from '@learnsdlc/shared';
import type { PersonaThread } from '@/components/shell';
import { CellTitle, Chip, Section, Table, type Tone } from '@/components/ui';
import { Term } from '@/components/ui/Term';
import { ExplainTestButton } from '@/components/workspace/ExplainTest';
import {
  VERDICT_STATE,
  buildLedger,
  claimSentence,
} from '@/components/workspace/panels/implementation/pr';
import { ChecksCard } from './ChecksCard';
import type { FloorSource } from './floorZero';
import { NOT_MEASURED_PURPOSE, NOT_MEASURED_WORD, analysisNotMeasured } from './analysisReach';
import { SuiteCountsLine, TEST_CASES_TITLE, suiteCounts } from './suiteCounts';

const VERDICT_WORD: Record<ContractClaim['verdict'], string> = {
  kept: 'Kept',
  broken: 'Broken',
  unclaimed: 'Unclaimed',
  contradicted: 'Contradicted',
};
const VERDICT_TONE: Record<ContractClaim['verdict'], Tone> = {
  kept: 'pass',
  broken: 'fail',
  unclaimed: 'neutral',
  contradicted: 'warn',
};

/** The first line carries the point; the rest is the traceback. */
function firstLine(text: string | undefined): string {
  return (text ?? '').trim().split('\n')[0] ?? '';
}

function HiddenSuite({
  tests,
  thread,
  onOpenThread,
}: {
  tests: NonNullable<FeedbackReport['tests']>;
  /** The phase's one conversation, when the page is holding it. */
  thread?: PersonaThread | null;
  onOpenThread?: () => void;
}) {
  // The run carries both suites, so the section is titled for both and says
  // visible, hidden and total apart, never "28 of 28" under a hidden-suite
  // title where the rubric says hidden 22 of 22 and visible 6 of 6.
  // Every case that did not pass is listed, whichever suite it came from.
  const counts = suiteCounts(tests);
  const failed = tests.cases.filter((c: TestCaseResult) => c.status !== 'passed');
  return (
    <Section
      testId="hidden-suite"
      title={TEST_CASES_TITLE}
      purpose={
        failed.length > 0
          ? 'The cases that did not pass, by name. Each one is a thread on the diff.'
          : `All ${counts.total.total} cases pass.`
      }
      right={
        <Chip tone={failed.length > 0 ? 'fail' : 'pass'}>
          {counts.total.passed} of {counts.total.total}
        </Chip>
      }
    >
      <SuiteCountsLine counts={counts} className="mb-2.5" />
      {failed.length === 0 ? (
        <p className="purpose">Nothing left to fix in the suite.</p>
      ) : (
        <Table
          testId="failed-cases"
          cols={[
            { label: 'Case' },
            { label: 'Where', width: 'auto', align: 'right' },
            // No heading, because the column is a control rather
            // than a fact about the case.
            { label: '', width: 'auto', align: 'right' },
          ]}
          rows={failed.map((c) => [
            <CellTitle
              key="c"
              state={c.status === 'failed' ? 'fail' : 'warn'}
              title={<span className="mono text-[12.5px]">{c.name}</span>}
              detail={firstLine(c.message)}
            />,
            <span key="w" className="mono text-[12px] text-muted">
              {c.frames?.[0] ? `${c.frames[0].path}:${c.frames[0].line}` : '—'}
            </span>,
            <ExplainTestButton
              key="x"
              testName={c.name}
              source="submission"
              step={c.step}
              thread={thread}
              onOpenThread={onOpenThread}
            />,
          ])}
        />
      )}
    </Section>
  );
}

function Analyzer({ report }: { report: FeedbackReport }) {
  const analysis = report.staticAnalysis;
  if (!analysis) return null;
  // No file read is not a clean reading; see analysisReach.ts.
  if (analysisNotMeasured(analysis)) {
    return <Section testId="pr-analyzer" title="Analyzer" purpose={NOT_MEASURED_PURPOSE} right={<Chip>{NOT_MEASURED_WORD}</Chip>} />;
  }
  const issues = analysis.issues.filter((i) => i.severity !== 'info');
  return (
    <Section
      testId="pr-analyzer"
      title="Analyzer"
      purpose={`${analysis.metrics.functions} functions read, worst complexity ${analysis.metrics.maxComplexity}, ${Math.round(
        analysis.metrics.docstringCoverage * 100,
      )}% documented.`}
      right={
        <Chip tone={issues.length === 0 ? 'pass' : issues.some((i) => i.severity === 'error') ? 'fail' : 'warn'}>
          {issues.length === 0 ? 'Clean' : `${issues.length} ${pluralWord(issues.length, 'finding')}`}
        </Chip>
      }
    >
      {issues.length === 0 ? (
        <p className="purpose">Nothing to answer for here.</p>
      ) : (
        <Table
          cols={[{ label: 'Finding' }, { label: 'Where', width: 'auto', align: 'right' }]}
          rows={issues.map((i) => [
            <CellTitle
              key="f"
              state={i.severity === 'error' ? 'fail' : 'warn'}
              title={i.message}
              detail={i.rule}
            />,
            <span key="w" className="mono text-[12px] text-muted">
              {i.path}:{i.line}
            </span>,
          ])}
        />
      )}
    </Section>
  );
}

function Ledger({ contract }: { contract: ContractClaim[] }) {
  const groups = buildLedger(contract);
  return (
    <Section
      testId="phase-implementation-ledger"
      title={
        <>
          Conformance <Term term="ledger">ledger</Term>
        </>
      }
      purpose={
        <>
          What your design <Term term="contract">contract</Term> claimed, and what the code did. Where the two
          disagree, decide which one to change and say so in the merge message.
        </>
      }
    >
      {groups.map((g) => (
        <div key={g.name} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="mono text-[12.5px] font-semibold text-ink">{g.name}</span>
            {g.story && <span className="label-sm">{g.story}</span>}
          </div>
          <Table
            cols={[{ label: 'Claim' }, { label: 'Verdict', width: 'auto', align: 'right' }]}
            rows={g.claims.map((c) => [
              <CellTitle
                key="c"
                state={VERDICT_STATE[c.verdict]}
                title={claimSentence(c)}
                detail={c.evidence.length > 0 ? c.evidence.join(' ') : undefined}
              />,
              <Chip key="v" tone={VERDICT_TONE[c.verdict]}>
                {VERDICT_WORD[c.verdict]}
              </Chip>,
            ])}
          />
        </div>
      ))}
    </Section>
  );
}

export function ChecksTab({
  report,
  attempt,
  gate,
  thread,
  onOpenThread,
  floors,
}: {
  report: FeedbackReport | null;
  attempt: number | null;
  gate: number;
  /** The phase's floors, so a rule set to 0 reads as not required (`ChecksCard`). */
  floors?: FloorSource;
  /** The phase's thread, so a failed case here can be asked about. */
  thread?: PersonaThread | null;
  onOpenThread?: () => void;
}) {
  if (!report) {
    return (
      <Section title="Checks" purpose="Nothing has run yet. Every required criterion needs correct evidence.">
        <p className="purpose">
          Submitting runs the visible suite, the hidden suite and the analyzer, and fills this in.
        </p>
      </Section>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      <ChecksCard report={report} attempt={attempt} gate={gate} floors={floors} />
      {report.tests && (
        <HiddenSuite tests={report.tests} thread={thread} onOpenThread={onOpenThread} />
      )}
      <Analyzer report={report} />
      {(report.contract ?? []).length > 0 && <Ledger contract={report.contract ?? []} />}
    </div>
  );
}
