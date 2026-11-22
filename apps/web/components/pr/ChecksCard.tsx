'use client';

/**
 * What ran on the revision the page is reading.
 *
 * The rows are the report's own checks, plus the conformance ledger's verdict,
 * which the report carries as a ledger rather than a check but which a
 * reviewer reads in the same list. The right-hand chip says the result in the
 * check's own units ("5 of 10", "1 error, 1 warning", "1 contradicted")
 * because "Failed" alone never tells a learner how far off they are.
 */
import { AI_REVIEW_BUSY_MESSAGE, pluralWord, type ContractClaim, type FeedbackCheck, type FeedbackReport } from '@learnsdlc/shared';
import { buildLedger } from '@/components/workspace/panels/implementation/pr';
import { CellTitle, Chip, Section, Table, type Tone } from '@/components/ui';
import type { StatusState } from '@/lib/phase';
import { NOT_MEASURED_REASON, NOT_MEASURED_WORD, analysisNotMeasured } from './analysisReach';
import { NOT_REQUIRED_WORD, zeroFloorChecks, type FloorSource } from './floorZero';
import { withInlineCode } from './inlineCode';

export interface CheckRow {
  key: string;
  label: string;
  detail: string;
  state: StatusState;
  tone: Tone;
  result: string;
}

const STATE: Record<FeedbackCheck['status'], StatusState> = {
  passed: 'pass',
  failed: 'fail',
  warning: 'warn',
  info: 'now',
};
const TONE: Record<FeedbackCheck['status'], Tone> = {
  passed: 'pass',
  failed: 'fail',
  warning: 'warn',
  info: 'accent',
};
const WORD: Record<FeedbackCheck['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  warning: 'Warning',
  info: 'Note',
};

/** "5 of 10" out of a check's own detail line, when it counts cases. */
function cases(detail: string): { passed: number; total: number } | null {
  const m = detail.match(/(\d+)\s*(?:\/|of)\s*(\d+)/);
  if (!m) return null;
  return { passed: Number(m[1]), total: Number(m[2]) };
}

function analyzerResult(report: FeedbackReport): string | null {
  const issues = report.staticAnalysis?.issues ?? [];
  if (issues.length === 0) return report.staticAnalysis ? 'Clean' : null;
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} ${pluralWord(errors, 'error')}`);
  if (warnings) parts.push(`${warnings} ${pluralWord(warnings, 'warning')}`);
  return parts.join(', ') || `${issues.length} ${pluralWord(issues.length, 'finding')}`;
}

/** The ledger as one row: one contract per row of the ledger, worst verdict first. */
function contractRow(contract: ContractClaim[]): CheckRow | null {
  if (contract.length === 0) return null;
  const groups = buildLedger(contract);
  const of = (v: ContractClaim['verdict']) => groups.filter((g) => g.verdict === v);
  const broken = of('broken');
  const contradicted = of('contradicted');
  const unclaimed = of('unclaimed');
  const kept = of('kept');
  const worst = broken.length ? 'fail' : contradicted.length || unclaimed.length ? 'warn' : 'pass';
  const named = [
    ...broken.map((g) => `${g.name} broken`),
    ...contradicted.map((g) => `${g.name} contradicted`),
    ...unclaimed.map((g) => `${g.name} unclaimed`),
  ];
  const detail =
    named.slice(0, 3).join('; ') ||
    `${kept.length === 1 ? 'One contract' : `${kept.length} contracts`} kept`;
  const result = broken.length
    ? `${broken.length} broken`
    : contradicted.length
      ? `${contradicted.length} contradicted`
      : unclaimed.length
        ? `${unclaimed.length} unclaimed`
        : `${kept.length} kept`;
  return {
    key: 'contract-conformance',
    label: 'Contract conformance',
    detail,
    state: worst as StatusState,
    tone: worst as Tone,
    result,
  };
}

/**
 * The reading order: the hidden suite decides the gate, so it leads; the
 * visible suite is what the learner already ran; then the analyzer, and the
 * ledger last because it is the argument, not the score. A check the API adds
 * later that is not in this list keeps its own place.
 */
const ORDER = ['hidden-tests', 'visible-tests', 'static-analysis', 'contract-conformance'];

/**
 * The four names the design gives them. The API's own labels spell out what
 * each suite is; the table has one column for the name and a second for the
 * result, so the spelling-out belongs on the detail line, not the label.
 */
const LABEL: Record<string, string> = {
  'hidden-tests': 'Hidden suite',
  'visible-tests': 'Visible suite',
  'static-analysis': 'Analyzer',
};

/**
 * Whether the learner ran the tests before submitting is process, not a check
 * the gate reads: it belongs with the conversation, not in the results table.
 */
const NOT_A_CHECK = new Set(['ran-before-submit']);
const rank = (key: string) => {
  // A per-run row ("hidden-tests-web") reads under the pooled row it splits.
  const i = ORDER.findIndex((id) => key === id || key.startsWith(`${id}-`));
  return i === -1 ? ORDER.length - 1 : i;
};

/**
 * Every row the Checks card and the Checks tab both read, in reading order.
 * `zero` holds the checks whose floor the teacher set to 0 (`zeroFloorChecks`):
 * such a rule passes whatever the record holds, so its row says Not required
 * in the neutral tone rather than Passed. Its status is the API's.
 */
export function checkRows(report: FeedbackReport | null, zero: ReadonlySet<string> = new Set()): CheckRow[] {
  if (!report) return [];
  const rows: CheckRow[] = report.checks
    .filter((c) => !NOT_A_CHECK.has(c.id))
    .map((c): CheckRow => {
      // An analysis that read no file found nothing because it looked at
      // nothing. The row says so in a neutral chip; the check's status is the
      // API's and is not changed, only how this row draws it.
      if (c.id === 'static-analysis' && analysisNotMeasured(report.staticAnalysis)) {
        return {
          key: c.id,
          label: LABEL[c.id] ?? c.label,
          detail: NOT_MEASURED_REASON,
          state: 'todo',
          tone: 'neutral',
          result: NOT_MEASURED_WORD,
        };
      }
      if (zero.has(c.id) && c.status === 'passed') {
        return { key: c.id, label: LABEL[c.id] ?? c.label, detail: c.detail, state: 'todo', tone: 'neutral', result: NOT_REQUIRED_WORD };
      }
      let result = WORD[c.status];
      if (c.id === 'static-analysis') result = analyzerResult(report) ?? result;
      else {
        const n = cases(c.detail);
        if (n)
          result = c.status === 'passed' ? `All ${n.total} passed` : `${n.passed} of ${n.total}`;
      }
      return {
        key: c.id,
        label: LABEL[c.id] ?? c.label,
        detail: c.detail,
        state: STATE[c.status],
        tone: TONE[c.status],
        result,
      };
    });
  const contract = contractRow(report.contract ?? []);
  if (contract) rows.push(contract);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.key) - rank(b.r.key) || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * What is between this submission and the gate, in the report's own terms.
 * A number alone ("69 of 70") does not tell a learner which lever to pull.
 */
export function gateReason(report: FeedbackReport | null): string {
  if (!report) return 'Submit to find out where you stand.';
  // A review the AI's queue turned away was the class's load, not a failed assessment.
  if (report.aiReview.assessmentError === AI_REVIEW_BUSY_MESSAGE) return 'The AI reviewer was busy with the rest of the class. Resubmit in a minute; no Pass was recorded.';
  if (report.aiReview.assessmentError) return 'The assessment could not be completed. Retry the review; no Pass was recorded.';
  return 'Resolve every failed criterion and missing piece of evidence, then submit a new revision.';
}

export function ChecksCard({
  report,
  attempt,
  gate,
  testId = 'phase-implementation-checks',
  floors,
}: {
  report: FeedbackReport | null;
  attempt: number | null;
  gate: number;
  testId?: string;
  /** The phase's floors, so a rule set to 0 reads as not required. Left out, every row is as the report has it. */
  floors?: FloorSource;
}) {
  const rows = checkRows(report, zeroFloorChecks(floors));
  return (
    <Section
      testId={testId}
      title="Checks"
      purpose={
        <>
          {attempt ? `What ran on submission ${attempt}, in the sandbox.` : 'Nothing has run yet.'} Every required criterion must be satisfied.
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="purpose">Submitting runs the suites and the analyzer, and fills this in.</p>
      ) : (
        <Table
          minWidth={280}
          cols={[{ label: 'Check' }, { label: 'Result', width: 'auto', align: 'right' }]}
          rows={rows.map((r) => [
            <CellTitle key="c" state={r.state} title={r.label} detail={withInlineCode(r.detail)} />,
            <Chip key="r" tone={r.tone}>
              {r.result}
            </Chip>,
          ])}
        />
      )}
    </Section>
  );
}
