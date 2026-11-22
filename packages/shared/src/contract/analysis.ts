/**
 * Static analysis, the per-phase report sections, and the code-health
 * score the editor and the grader agree on.
 */

/* ---------------------------- static analysis ---------------------------- */

export interface AnalyzerIssue {
  path: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
}

export interface AnalyzerFunction {
  name: string;
  /** Dotted path through the enclosing class or function: `TaskManager.add_task`. */
  qualname?: string;
  path: string;
  line: number;
  endLine: number;
  complexity: number;
  /** Names called from the body, in source order, de-duplicated. */
  calls: string[];
  /** Stable hash of the normalised body, so a rerun can tell a change from a move. */
  bodyHash: string;
}

export interface AnalyzerImport {
  module: string;
  names: string[];
  /** The file the import was read from; absent on an older report that did not record it. */
  path?: string;
  line: number;
}

export interface AnalyzerReport {
  issues: AnalyzerIssue[];
  metrics: {
    files: number;
    functions: number;
    todosRemaining: number;
    maxComplexity: number;
    docstringCoverage: number; // 0..1
  };
  /** Every function the analyzer could resolve, capped at 200. */
  functions?: AnalyzerFunction[];
  imports?: AnalyzerImport[];
}

export interface MutationReport {
  total: number;
  killed: number;
  survivors: { name: string; description: string }[];
  /** One row per mutant with the learner's per-test outcome against it (the kill matrix). */
  matrix?: MutantRow[];
}

export interface MutantRow {
  mutant: string;
  description: string;
  killed: boolean;
  /** The criterion the mutant proves, e.g. "US-4/AC-2", when the content pack declares it. */
  covers?: string;
  cases: { name: string; status: 'passed' | 'failed' | 'errored' }[];
}

/* ------------------------- per-phase report sections ---------------------- */

/** Conformance ledger: what the learner's design contract claimed versus what the code did. */
export interface ContractClaim {
  /** Function name from the design contract, e.g. filter_tasks. */
  name: string;
  story?: string;
  claim: 'inputs' | 'returns' | 'errors' | 'ordering' | 'boundary';
  text: string;
  verdict: 'kept' | 'broken' | 'unclaimed' | 'contradicted';
  evidence: string[];
}

export interface CiStep {
  job: string;
  step: string;
  ok: boolean | null;
  detail: string;
}

/** The deployment drill: the smoke run against the faulted copy, then against the learner's fix. */
export interface DrillReport {
  fault: string;
  faultDescription: string;
  /** The faulted copy must fail; true means it did. */
  failedBeforeFix: boolean;
  /** The learner's files pass the same smoke run. */
  passedAfterFix: boolean;
  /** The runbook diagnosis names the faulted directive. */
  diagnosisNamesFault: boolean;
  beforeStderr: string;
  afterStdout: string;
}

export interface ImpactFunction {
  name: string;
  path: string;
  line: number;
  endLine: number;
  complexity: number;
  change: 'added' | 'changed' | 'unchanged' | 'removed';
  /** Test case names that reach this function by name. */
  reachedBy: string[];
}

export interface ImpactReport {
  baseline: string;
  functions: ImpactFunction[];
  changeTests: string[];
  regressionTests: string[];
}

/* ---------------------------------------------------------------------------
 * code health in the editor
 *
 * The analyzer's report is already stored on every code submission and already
 * crosses the wire. This block adds no shape: it adds the one number the editor
 * and the grader must agree on, and the name of the analyzer's own failure.
 * ------------------------------------------------------------------------- */

/**
 * The rule the API writes when the analyzer could not run at all
 * (`sandbox.service.ts`). It is a transport failure wearing an issue's clothes:
 * it names no real line, so the editor draws it as a notice rather than as a
 * marker on line 1, and it counts towards nothing, not the score, not the tab
 * count, not the trend.
 */
export const ANALYZER_UNAVAILABLE_RULE = 'analyzer-unavailable';

/**
 * The rubric's code-quality score for one analyzer report: 100, less 25 for
 * each error, 10 for each warning and 2 for each note, floored at 0.
 *
 * It lives here rather than in the API's `checkers.ts` because the editor's
 * Health tab shows this number to the learner and says the arithmetic out loud,
 * that is the point of showing it, and a second copy in the browser would be
 * one edit away from teaching a sum the grader does not use.
 *
 * `analyzer-unavailable` is skipped: counted as an error it would cost a
 * learner whose sandbox hiccuped a quarter of the criterion, and a report
 * about the platform never costs a learner a score.
 */
export function codeQualityScore(analysis: Pick<AnalyzerReport, 'issues'>): number {
  let score = 100;
  for (const issue of analysis.issues) {
    if (issue.rule === ANALYZER_UNAVAILABLE_RULE) continue;
    score -= issue.severity === 'error' ? 25 : issue.severity === 'warning' ? 10 : 2;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}
