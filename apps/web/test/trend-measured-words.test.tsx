/**
 * The Health panel's trend draws measured revisions only, so a learner with
 * three revisions, one of them measured, must not be told "The trend needs a
 * second revision." though they have made it. With two or more revisions and
 * fewer than two measured, the line says "The trend needs a second measured
 * revision."; with one revision it says "The trend needs a second revision."
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnalyzerReport, SubmissionView } from '@learnsdlc/shared';
import { HealthPanel } from '@/components/workspace/HealthPanel';
import { trendWaitLine } from '@/components/workspace/ide/health';

const NOTHING: AnalyzerReport = { issues: [], metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 1 } };
const READ: AnalyzerReport = { issues: [], metrics: { files: 2, functions: 5, todosRemaining: 1, maxComplexity: 3, docstringCoverage: 0.6 } };
const sub = (attempt: number, staticAnalysis: AnalyzerReport) =>
  ({ id: `s${attempt}`, attempt, status: 'completed', createdAt: `2026-11-1${attempt}T00:00:00Z`, report: { staticAnalysis } }) as unknown as SubmissionView;
const OLD = 'The trend needs a second revision.';
const NEW = 'The trend needs a second measured revision.';
const panel = (submissions: SubmissionView[]) =>
  renderToStaticMarkup(<HealthPanel analysis={READ} submissions={submissions} attempt={submissions.length} stale={false} onOpen={() => {}} />);

describe('the trend line when fewer than two revisions were measured', () => {
  it('several revisions, one measured: asks for a second measured revision', () => {
    expect(trendWaitLine(3)).toBe(NEW);
    const html = panel([sub(1, NOTHING), sub(2, NOTHING), sub(3, READ)]);
    expect(html).toContain(NEW);
    expect(html).not.toContain(OLD);
  });
  it('one revision reads the wait line, and two measured draw the trend', () => {
    expect(trendWaitLine(1)).toBe(OLD);
    expect(panel([sub(1, READ)])).toContain(OLD);
    expect(panel([sub(1, READ), sub(2, READ)])).not.toContain('The trend needs');
  });
});
