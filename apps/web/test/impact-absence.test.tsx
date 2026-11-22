/**
 * The empty Change impact card ("The review of PR-6 read no
 * function in your files ...") and the release record's "What changed" line
 * ("No function-level reading of the changed files was made ...") were said on
 * every verdict without an impact reading. The API gives no impact reading when
 * either side has no function (apps/api/src/feedback/impact.ts, buildImpactReport),
 * so it is also missing when the review read functions but had no earlier
 * reading to compare with, and when the analyzer could not run. Each sentence
 * now says which of these happened, from the verdict's own static analysis.
 * With no static analysis, or a reading of files with no function in them,
 * the card reads its usual empty line.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ANALYZER_UNAVAILABLE_RULE, EMPTY_CHANGE_REQUEST, type AnalyzerReport, type ChangeRequest, type FeedbackReport } from '@learnsdlc/shared';
import { emptyImpact } from '@/components/workspace/panels/maintenance/impact';
import { NO_FUNCTION_READING, buildRelease, type ReleaseInput } from '@/components/workspace/panels/maintenance/release';
import { ChangeImpactCard } from '@/components/workspace/panels/maintenance/ChangeCards';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';

const metrics = (files: number, functions: number) => ({ files, functions, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 });
/** The analyzer could not run: its one notice, nothing read. */
const unavailable: AnalyzerReport = { issues: [{ rule: ANALYZER_UNAVAILABLE_RULE, severity: 'info', message: 'The analyzer could not run.', path: '', line: 0 } as unknown as AnalyzerReport['issues'][number]], metrics: metrics(0, 0) };
/** A TypeScript phase: no file the analyzer reads. */
const unread: AnalyzerReport = { issues: [], metrics: metrics(0, 0), functions: [] };
/** A Python phase read in full, with no earlier reading to compare with. */
const readFns: AnalyzerReport = {
  issues: [], metrics: metrics(2, 1),
  functions: [{ name: 'is_overdue', path: 'api/overdue.py', line: 1, endLine: 4, complexity: 2 } as NonNullable<AnalyzerReport['functions']>[number]],
};
/** Files read, no function in them. */
const noFns: AnalyzerReport = { issues: [], metrics: metrics(2, 0), functions: [] };

const OLD_CARD = { title: 'No call graph', body: 'The review of PR-6 read no function in your files, so there is no call graph to draw.' };

describe('the empty Change impact card after a review', () => {
  it('the analyzer could not run', () => {
    expect(emptyImpact('PR-6', true, false, unavailable)).toEqual({ title: 'No call graph', body: 'The analyzer could not run in the review of PR-6, so there is no call graph to draw.' });
  });
  it('no file the analyzer reads', () => {
    expect(emptyImpact('PR-6', true, false, unread)).toEqual({
      title: 'No call graph',
      body: "The analyzer reads Python and JavaScript, and none of this phase's files is one it reads, so the review of PR-6 has no call graph to draw.",
    });
  });
  it('functions read but no earlier reading to compare with', () => {
    expect(emptyImpact('PR-6', true, false, readFns)).toEqual({
      title: 'No call graph',
      body: 'The review of PR-6 had no earlier reading of these functions to compare with, so there is no call graph to draw.',
    });
  });
  it('files read with no function, or no static analysis, read the no-call-graph card; the states before a verdict read their own words', () => {
    expect(emptyImpact('PR-6', true, false, noFns)).toEqual(OLD_CARD);
    expect(emptyImpact('PR-6', true, false, null)).toEqual(OLD_CARD);
    expect(emptyImpact('PR-6', true)).toEqual(OLD_CARD);
    expect(emptyImpact('PR-6', false, false, unread)).toEqual({ title: 'No call graph yet', body: 'The graph is drawn from the static analysis in the verdict. Submit PR-6 to get one.' });
    expect(emptyImpact('PR-6', false, true, unread).body).toBe('The review of PR-6 is running. The graph is drawn from the static analysis in its verdict.');
  });
  it("the change request page's card passes the verdict's analysis", () => {
    const card = (analysis: AnalyzerReport | null) => renderToStaticMarkup(
      <ChangeImpactCard m={{ impactCount: 0, awaitingVerdict: false, reviewRunning: false, analysis } as unknown as MaintenanceModel} impact={undefined} functions={[]} onOpen={() => {}} pr="PR-6" />,
    );
    expect(card(unavailable)).toContain('The analyzer could not run in the review of PR-6');
    expect(card(null)).toContain(OLD_CARD.body);
  });
});

const TAIL = " The pull request's Files changed tab shows what changed.";
const releaseOf = (staticAnalysis?: AnalyzerReport) => {
  const report = { passed: true, tests: { passed: 1, failed: 0, errored: 0, total: 1, cases: [] }, ...(staticAnalysis ? { staticAnalysis } : {}) } as unknown as FeedbackReport;
  const input: ReleaseInput = {
    projectTitle: 'Deadline badge', ticket: { id: 'CR-1', title: 'T', summary: '' }, change: null, signature: 'isOverdue(task)', contractTab: false,
    report, impactRead: false, marks: [], added: [], record: EMPTY_CHANGE_REQUEST as ChangeRequest, enrollment: null, phaseOrder: 6,
  };
  return buildRelease(input).lines.find((l) => l.label === 'What changed')!;
};

describe("the release record's What changed line with no impact reading", () => {
  it('the analyzer could not run', () => {
    expect(releaseOf(unavailable).text).toBe(`The analyzer could not run in this review, so this line names no function.${TAIL}`);
  });
  it('no file the analyzer reads', () => {
    expect(releaseOf(unread).text).toBe(`The analyzer reads Python and JavaScript, and none of this phase's files is one it reads, so this line names no function.${TAIL}`);
  });
  it('functions read but no earlier reading to compare with', () => {
    expect(releaseOf(readFns).text).toBe(`The review read the functions in your files but had no earlier reading of them to compare with, so this line names no function.${TAIL}`);
  });
  it('files read with no function in them', () => {
    expect(releaseOf(noFns).text).toBe(`The analyzer read your files and found no function in them, so this line names no function.${TAIL}`);
  });
  it('no static analysis reads the no-function line, and the line stays done', () => {
    expect(releaseOf().text).toBe(NO_FUNCTION_READING);
    for (const a of [undefined, unavailable, unread, readFns, noFns]) expect(releaseOf(a).state).toBe('done');
  });
});
