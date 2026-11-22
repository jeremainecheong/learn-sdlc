import type { FeedbackCheck } from '@learnsdlc/shared';
import { soleTaskFor } from '../src/content/pack-compiler';
import type { CorpusCase } from './contracts';
import { gradeWorkspace } from './grader';
import { SeatbeltSandbox, seatbeltAvailable, seatbeltPreflight } from './seatbelt-sandbox';
import { phaseFor } from './world';

/**
 * Executable truth for one Agentic proposal: the proposal is
 * applied over the case's workspace in memory (the runner writes it into a
 * fresh scratch directory per job), then the product's own grader runs the
 * pack's visible and hidden suites and the static analyser through the
 * Seatbelt sandbox (network denied, writes confined, 60 s wall clock), and
 * the analyser is run once more on the changed files for the complexity
 * numbers (limit 8, `runner/analyzer.py` MAX_COMPLEXITY). No model-written code
 * runs anywhere else. Without sandbox-exec this returns `not_run`.
 */

export interface ExecTruth {
  status: 'run' | 'not_run' | 'not_applicable';
  reason: string | null;
  appliesCleanly: boolean;
  editableOnly: boolean;
  changedPaths: string[];
  changedLines: number;
  checks: Array<{ id: string; status: string }>;
  visiblePass: boolean | null;
  hiddenPass: boolean | null;
  staticAnalysis: string | null;
  maxComplexity: number | null;
  highComplexityIssues: number | null;
  structuralOverall: number | null;
  jobs: number;
  unavailableJobs: number;
  ms: number;
}

const lineDiff = (before: string, after: string): number => {
  const a = before.split('\n');
  const b = after.split('\n');
  const setA = new Map<string, number>();
  for (const line of a) setA.set(line, (setA.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) { const n = setA.get(line) ?? 0; if (n > 0) { common += 1; setA.set(line, n - 1); } }
  return (a.length - common) + (b.length - common);
};

const allOf = (checks: FeedbackCheck[], re: RegExp): boolean | null => {
  const hit = checks.filter((c) => re.test(c.id));
  return hit.length ? hit.every((c) => c.status === 'passed') : null;
};

export async function execTruth(c: CorpusCase, files: Record<string, string> | null, rawPaths: string[], scratch: string): Promise<ExecTruth> {
  const empty: ExecTruth = { status: 'not_applicable', reason: null, appliesCleanly: false, editableOnly: false, changedPaths: [], changedLines: 0, checks: [], visiblePass: null, hiddenPass: null, staticAnalysis: null, maxComplexity: null, highComplexityIssues: null, structuralOverall: null, jobs: 0, unavailableJobs: 0, ms: 0 };
  if (!c.input.executable) return { ...empty, reason: 'the case is not a code phase' };
  if (!files) return { ...empty, reason: 'no accepted proposal' };
  const started = Date.now();
  const workspace = (c.input.workspace ?? {}) as Record<string, string>;
  const editable = new Set<string>(c.input.editablePaths ?? Object.keys(workspace));
  const changedPaths = Object.keys(files).filter((p) => files[p] !== workspace[p]).sort();
  const changedLines = changedPaths.reduce((n, p) => n + lineDiff(workspace[p] ?? '', files[p]), 0);
  const base = { ...empty, appliesCleanly: true, editableOnly: rawPaths.every((p) => editable.has(p)), changedPaths, changedLines };
  if (!seatbeltAvailable()) return { ...base, status: 'not_run', reason: 'sandbox-exec unavailable: model-written code is never run unsandboxed', ms: Date.now() - started };
  const preflight = await seatbeltPreflight(scratch);
  if (!preflight.ok) return { ...base, status: 'not_run', reason: `Seatbelt preflight canary failed (${preflight.failures.join(', ')}): model-written code is never run behind a fence that has not been proved`, ms: Date.now() - started };
  const { phase, world } = await phaseFor(c);
  if (!world) return { ...base, status: 'not_run', reason: 'no pack' };
  const sandbox = new SeatbeltSandbox(scratch);
  const task = soleTaskFor(phase);
  const merged = { ...workspace, ...files };
  const { report } = await gradeWorkspace(world.content, world.slug, phase, task, [task], merged, true, sandbox);
  const py = changedPaths.filter((p) => p.endsWith('.py'));
  const analysis = py.length ? await sandbox.analyze(merged, py, 'python') : null;
  const checks = report.checks as FeedbackCheck[];
  return {
    ...base,
    status: 'run',
    checks: checks.map((x) => ({ id: x.id, status: x.status })),
    visiblePass: allOf(checks, /^visible-tests/),
    hiddenPass: allOf(checks, /^hidden-tests/),
    staticAnalysis: checks.find((x) => x.id === 'static-analysis')?.status ?? null,
    maxComplexity: analysis ? analysis.metrics.maxComplexity : null,
    highComplexityIssues: analysis ? analysis.issues.filter((i) => i.rule === 'high-complexity').length : null,
    structuralOverall: report.overall,
    jobs: sandbox.jobs.length,
    unavailableJobs: sandbox.jobs.filter((j) => j.exitKind === 'unavailable').length,
    ms: Date.now() - started,
  };
}
