import { describe, expect, it } from 'vitest';
import type { AnalyzerIssue, AnalyzerReport, SubmissionView } from '@learnsdlc/shared';
import { codeQualityScore } from '@learnsdlc/shared';
import {
  analyzerUnavailable,
  deltaWord,
  healthFindings,
  healthMetrics,
  healthTrend,
  trendSentence,
} from '@/components/workspace/ide/health';

const issue = (over: Partial<AnalyzerIssue> = {}): AnalyzerIssue => ({
  path: 'api/repository/tasks.py',
  line: 71,
  severity: 'warning',
  rule: 'todo-remaining',
  message: 'A TODO(learner) marker is still in place.',
  ...over,
});

const report = (
  issues: AnalyzerIssue[],
  metrics: Partial<AnalyzerReport['metrics']> = {},
): AnalyzerReport => ({
  issues,
  metrics: {
    files: 2,
    functions: 24,
    todosRemaining: 3,
    maxComplexity: 8,
    docstringCoverage: 0.75,
    ...metrics,
  },
});

const submission = (attempt: number, analysis?: AnalyzerReport): SubmissionView => ({
  id: `s${attempt}`,
  status: 'completed',
  score: 60,
  passed: false,
  attempt,
  createdAt: `2026-09-0${Math.min(9, attempt)}T09:00:00.000Z`,
  report: (analysis ? { staticAnalysis: analysis } : {}) as SubmissionView['report'],
});

describe('the findings the editor draws', () => {
  it('orders findings worst first, then by file and line', () => {
    const found = healthFindings(
      report([
        issue({ path: 'api/routes/tasks.py', line: 164 }),
        issue({ path: 'api/repository/tasks.py', line: 91, severity: 'error', rule: 'not-implemented' }),
        issue({ path: 'api/repository/tasks.py', line: 12, severity: 'info', rule: 'missing-docstring' }),
        issue({ path: 'api/repository/tasks.py', line: 71 }),
        issue({ path: 'api/repository/tasks.py', line: 74, severity: 'error', rule: 'not-implemented' }),
      ]),
    );
    expect(found.map((f) => `${f.severity} ${f.path}:${f.line}`)).toEqual([
      'error api/repository/tasks.py:74',
      'error api/repository/tasks.py:91',
      'warning api/repository/tasks.py:71',
      'warning api/routes/tasks.py:164',
      'info api/repository/tasks.py:12',
    ]);
  });

  it('keeps the analyzer’s own failure out of the findings', () => {
    const down = report([
      issue({
        line: 1,
        severity: 'error',
        rule: 'analyzer-unavailable',
        message: 'Static analysis could not run for this submission.',
      }),
    ]);
    expect(healthFindings(down)).toEqual([]);
    expect(analyzerUnavailable(down)).toBe(true);
    expect(analyzerUnavailable(report([issue()]))).toBe(false);
    // and it costs the learner nothing
    expect(healthMetrics(down)?.quality).toBe(100);
  });

  it('writes a place the way the product writes one', () => {
    expect(healthFindings(report([issue({ path: 'manager.py', line: 56 })]))[0].where).toBe(
      'manager.py, line 56',
    );
  });

  it('reads docstring coverage as a percentage', () => {
    const metrics = healthMetrics(report([issue()], { docstringCoverage: 0.8 }));
    expect(metrics?.docstrings).toBe(80);
    expect(metrics?.complexity).toBe(8);
    expect(metrics?.todos).toBe(3);
    // notes are findings, but they are not the number the tab counts
    expect(healthMetrics(report([issue({ severity: 'info' })]))?.findings).toBe(0);
    expect(metrics?.findings).toBe(1);
  });

  it('has nothing to say about a phase with no analysis', () => {
    expect(healthMetrics(undefined)).toBeNull();
    expect(healthFindings(undefined)).toEqual([]);
    expect(analyzerUnavailable(undefined)).toBe(false);
  });
});

describe('the trend across revisions', () => {
  it('leaves a gap for a revision the analyzer never ran on', () => {
    const points = healthTrend([
      submission(1, report([issue({ severity: 'error' })])),
      submission(2),
      submission(3, report([issue()])),
      submission(4, report([])),
    ]);
    expect(points.map((p) => p.attempt)).toEqual([1, 3, 4]);
    expect(points.map((p) => p.quality)).toEqual([75, 90, 100]);
  });

  it('leaves a gap for a revision the analyzer could not run for', () => {
    const down = report([issue({ severity: 'error', rule: 'analyzer-unavailable' })]);
    expect(healthTrend([submission(1, down), submission(2, report([]))]).map((p) => p.attempt)).toEqual([2]);
  });

  it('keeps the last twelve revisions', () => {
    const many = Array.from({ length: 15 }, (_, i) => submission(i + 1, report([])));
    const points = healthTrend(many);
    expect(points).toHaveLength(12);
    expect(points[0].attempt).toBe(4);
    expect(points[11].attempt).toBe(15);
  });

  it('says which way a number moved, in words', () => {
    expect(deltaWord(9, 7)).toBe('up 2');
    expect(deltaWord(7, 9)).toBe('down 2');
    expect(deltaWord(80, 75, '%')).toBe('up 5%');
    expect(deltaWord(9, 9)).toBeNull();
    expect(deltaWord(9, undefined)).toBeNull();
  });

  it('reads the trend as a sentence', () => {
    const points = [45, 60, 62, 78].map((quality, i) => ({
      quality,
      complexity: 8,
      docstrings: 75,
      todos: 3,
      findings: 1,
      attempt: i + 1,
      createdAt: '2026-09-06T09:00:00.000Z',
    }));
    expect(trendSentence(points)).toBe('Code quality across four revisions: 45, 60, 62 and 78.');
    expect(trendSentence(points.slice(0, 1))).toBe('Code quality on one revision: 45.');
    expect(trendSentence([])).toBe('');
  });
});

describe('the score the grader uses', () => {
  it('is the code quality score the editor shows', () => {
    expect(codeQualityScore(report([]))).toBe(100);
    expect(
      codeQualityScore(
        report([
          issue({ severity: 'error' }),
          issue({ severity: 'warning' }),
          issue({ severity: 'info' }),
        ]),
      ),
    ).toBe(63);
    expect(
      codeQualityScore(report(Array.from({ length: 6 }, () => issue({ severity: 'error' })))),
    ).toBe(0);
  });
});
