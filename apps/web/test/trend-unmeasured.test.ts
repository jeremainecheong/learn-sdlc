/**
 * The Health panel's trend plotted a revision whose files the analyzer does not
 * read (metrics.files 0, no issue: analysisNotMeasured) as a measurement: 100
 * code quality and 100% docstrings. healthTrend (components/workspace/ide/health.ts)
 * now draws no point for such a revision, so the trend holds only measured
 * revisions, and none when no revision was measured; measured revisions give
 * one point each.
 */
import { describe, expect, it } from 'vitest';
import type { AnalyzerReport, SubmissionView } from '@learnsdlc/shared';
import { healthTrend } from '@/components/workspace/ide/health';

const NOTHING: AnalyzerReport = { issues: [], metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 1 } };
const READ: AnalyzerReport = { issues: [], metrics: { files: 2, functions: 5, todosRemaining: 1, maxComplexity: 3, docstringCoverage: 0.6 } };
const sub = (attempt: number, staticAnalysis: AnalyzerReport) =>
  ({ id: `s${attempt}`, attempt, status: 'completed', createdAt: `2026-11-1${attempt}T00:00:00Z`, report: { staticAnalysis } }) as unknown as SubmissionView;

describe('healthTrend', () => {
  it('draws no point for a revision that measured nothing', () => {
    expect(healthTrend([sub(1, READ), sub(2, NOTHING), sub(3, READ)]).map((p) => p.attempt)).toEqual([1, 3]);
    expect(healthTrend([sub(1, NOTHING), sub(2, NOTHING)])).toEqual([]);
  });
  it('measured revisions each give a point, and an unmeasured one between them gives none', () => {
    const points = healthTrend([sub(1, READ), sub(2, READ)]);
    expect(points.map((p) => p.attempt)).toEqual([1, 2]);
    expect(healthTrend([sub(1, READ), sub(2, NOTHING), sub(3, READ)])[1]).toEqual({ ...points[1], attempt: 3, createdAt: '2026-11-13T00:00:00Z' });
  });
});
