'use client';

/**
 * What the Health tab and the code's own underlines say, derived from the
 * analyzer report the API already stored with each verdict. Nothing here
 * fetches and nothing here is invented: every row is a finding the analyzer
 * wrote, moved into the shape the tab, the markers and the trend read.
 *
 * Sibling to `derive.ts`, and deliberately not folded into its `buildProblems`:
 * the Problems list means "what is failing", tests and contract claims, and
 * code health is a different question, with its own tab and its own markers.
 */
import { analysisNotMeasured } from '@/components/pr/analysisReach';
import type { AnalyzerIssue, AnalyzerReport, SubmissionView } from '@learnsdlc/shared';
import { ANALYZER_UNAVAILABLE_RULE, andList, codeQualityScore, numberWord } from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';

/** The severity of a finding, in the product's three verdict states. */
export const HEALTH_STATE: Record<AnalyzerIssue['severity'], StatusState> = {
  error: 'fail',
  warning: 'warn',
  info: 'now',
};

/** The word beside the square, so a row says its own severity out loud. */
export const HEALTH_WORD: Record<AnalyzerIssue['severity'], string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Note',
};

export interface HealthFinding {
  path: string;
  line: number;
  severity: AnalyzerIssue['severity'];
  state: StatusState;
  rule: string;
  message: string;
  /** "manager.py, line 56": the product's own way of naming a place. */
  where: string;
}

const RANK: Record<AnalyzerIssue['severity'], number> = { error: 0, warning: 1, info: 2 };

/** True when this report is the analyzer saying it could not run. */
export function analyzerUnavailable(analysis: AnalyzerReport | undefined): boolean {
  return Boolean(analysis?.issues.some((i) => i.rule === ANALYZER_UNAVAILABLE_RULE));
}

/**
 * The findings of one report, worst first then by file and line, with the
 * analyzer's own "I could not run" row taken out: it names no line, so it is a
 * notice rather than a finding.
 */
export function healthFindings(analysis: AnalyzerReport | undefined): HealthFinding[] {
  if (!analysis) return [];
  return analysis.issues
    .filter((i) => i.rule !== ANALYZER_UNAVAILABLE_RULE)
    .map((i) => ({
      path: i.path,
      line: i.line,
      severity: i.severity,
      state: HEALTH_STATE[i.severity],
      rule: i.rule,
      message: i.message,
      where: `${i.path}, line ${i.line}`,
    }))
    .sort(
      (a, b) =>
        RANK[a.severity] - RANK[b.severity] ||
        a.path.localeCompare(b.path) ||
        a.line - b.line ||
        a.rule.localeCompare(b.rule),
    );
}

export interface HealthMetrics {
  /** 0..100, the grader's own code-quality criterion. */
  quality: number;
  complexity: number;
  /** `metrics.docstringCoverage` read as a percentage. */
  docstrings: number;
  todos: number;
  /** Findings that are not notes: the same rule the notification bell uses. */
  findings: number;
}

export function healthMetrics(analysis: AnalyzerReport | undefined): HealthMetrics | null {
  if (!analysis) return null;
  const findings = healthFindings(analysis);
  return {
    quality: codeQualityScore(analysis),
    complexity: analysis.metrics.maxComplexity,
    docstrings: Math.round(analysis.metrics.docstringCoverage * 100),
    todos: analysis.metrics.todosRemaining,
    findings: findings.filter((f) => f.severity !== 'info').length,
  };
}

export interface HealthPoint extends HealthMetrics {
  attempt: number;
  createdAt: string;
}

/** The last twelve revisions is as much line as the panel can draw honestly. */
export const HEALTH_TREND_MAX = 12;

/**
 * One point per revision that carries an analyzer report, oldest first, the
 * last twelve. A revision graded before the analyzer ran, or one the analyzer
 * could not run for, is absent rather than zero: a gap in the line is honest
 * and a zero is a lie about the code.
 */
export function healthTrend(submissions: SubmissionView[]): HealthPoint[] {
  const points: HealthPoint[] = [];
  submissions.forEach((s, i) => {
    const analysis = s.report?.staticAnalysis;
    // A revision whose files the analyzer does not read measured nothing: no point is drawn for it.
    if (!analysis || analyzerUnavailable(analysis) || analysisNotMeasured(analysis)) return;
    const metrics = healthMetrics(analysis);
    if (!metrics) return;
    points.push({ ...metrics, attempt: s.attempt ?? i + 1, createdAt: s.createdAt });
  });
  return points.slice(-HEALTH_TREND_MAX);
}

/**
 * The line in place of the trend while fewer than two revisions were measured.
 * `revisions` is how many revisions carry a verdict: with two or more, the one
 * missing is a measured revision (the trend skips the rest), not a revision.
 */
export function trendWaitLine(revisions: number): string {
  return revisions >= 2 ? 'The trend needs a second measured revision.' : 'The trend needs a second revision.';
}

/**
 * The word for a change between two revisions: "up 1", "down 2", or null when
 * it did not move. Words rather than arrows, because down is good for
 * complexity and bad for docstrings and one glyph cannot say both.
 */
export function deltaWord(now: number, before: number | undefined, unit = ''): string | null {
  if (before === undefined || before === now) return null;
  const size = Math.abs(now - before);
  return `${now > before ? 'up' : 'down'} ${size}${unit}`;
}

/** "Code quality across four revisions: 45, 60, 62 and 78." */
export function trendSentence(points: HealthPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `Code quality on one revision: ${points[0].quality}.`;
  return `Code quality across ${numberWord(points.length)} revisions: ${andList(
    points.map((p) => String(p.quality)),
  )}.`;
}
