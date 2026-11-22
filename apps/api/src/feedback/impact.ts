import type {
  AnalyzerFunction,
  AnalyzerReport,
  ImpactFunction,
  ImpactReport,
  TestCaseResult,
} from '@learnsdlc/shared';

/** Name fragments that would match half the suite, so they never carry a match. */
const GENERIC_TOKENS = new Set([
  'to',
  'of',
  'is',
  'as',
  'do',
  'on',
  'in',
  'at',
  'by',
  'for',
  'from',
  'with',
  'the',
  'and',
  'get',
  'set',
  'str',
  'repr',
  'init',
  'new',
  'main',
  'self',
  'task',
  'tasks',
  'test',
  'tests',
]);

/**
 * Words that mark a test as proving the old behaviour survived the change.
 * Matched against the name's words, not with `\b`: an underscore is a word
 * character, so `\buntouched\b` never fires inside `complete_untouched`.
 */
const REGRESSION_WORDS = new Set([
  'still',
  'unchanged',
  'untouched',
  'unaffected',
  'regression',
  'regressions',
]);

const MAX_FUNCTIONS = 200;
const MAX_REACHED_BY = 20;
const MAX_TEST_NAMES = 100;

const keyOf = (fn: AnalyzerFunction) => `${fn.path}::${fn.name}`;

/**
 * Lowercase words, splitting snake_case, kebab-case, dots and camelCase alike.
 * Exported because the contract ledger matches test names to functions the same
 * way, and the two reports must never disagree about what a name says.
 */
export const words = (value: string): string[] =>
  (value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The one token that identifies a function in a test name: its leading word,
 * skipping generic noise. `complete_task` and `completeTask` both reduce to
 * `complete`, which is what every hidden test for that operation is named after.
 */
export const subjectToken = (name: string): string | null => {
  const parts = words(name);
  for (const part of parts) {
    if (part.length >= 3 && !GENERIC_TOKENS.has(part)) return part;
  }
  return null;
};

/**
 * Test cases that reach a function by name: either the test name spells the
 * whole function name out, or it is named after the function's subject.
 */
function reachedBy(name: string, caseWords: { name: string; words: string[] }[]): string[] {
  const full = words(name);
  const subject = subjectToken(name);
  if (full.length === 0) return [];
  const hit: string[] = [];
  for (const testCase of caseWords) {
    const spellsItOut =
      full.length > 1 && testCase.words.join(' ').includes(full.join(' '));
    const namesSubject = subject !== null && testCase.words.includes(subject);
    if (spellsItOut || namesSubject) {
      hit.push(testCase.name);
      if (hit.length >= MAX_REACHED_BY) break;
    }
  }
  return hit;
}

/** The dotted class prefix Python case names carry, e.g. `ReopenChange`. */
const classPrefix = (name: string): string => {
  const parts = (name || '').split('.');
  return parts.length > 1 ? parts[parts.length - 2] : '';
};

/**
 * Split the suite into the tests that prove the change and the tests that prove
 * nothing else moved. Python case names arrive as `Class.method`, so the class
 * carries the intent (`ReopenChange` / `Regression`); JavaScript case names are
 * the bare `test()` string, where the words carry it ("complete still works").
 * Anything else counts towards the change, that is what the learner was asked
 * to write, and calling an unclassified test a regression would overstate it.
 */
function splitTests(cases: TestCaseResult[]): { change: string[]; regression: string[] } {
  const change: string[] = [];
  const regression: string[] = [];
  const seen = new Set<string>();

  for (const testCase of cases) {
    const name = typeof testCase?.name === 'string' ? testCase.name : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const cls = classPrefix(name);
    if (/^regression/i.test(cls)) {
      regression.push(name);
      continue;
    }
    if (/change$/i.test(cls)) {
      change.push(name);
      continue;
    }
    const namesRegression = words(name).some((word) => REGRESSION_WORDS.has(word));
    (namesRegression ? regression : change).push(name);
  }

  return { change: change.slice(0, MAX_TEST_NAMES), regression: regression.slice(0, MAX_TEST_NAMES) };
}

const row = (
  fn: AnalyzerFunction,
  change: ImpactFunction['change'],
  caseWords: { name: string; words: string[] }[],
): ImpactFunction => ({
  name: fn.name,
  path: fn.path,
  line: Number.isFinite(fn.line) ? fn.line : 0,
  endLine: Number.isFinite(fn.endLine) ? fn.endLine : 0,
  complexity: Number.isFinite(fn.complexity) ? fn.complexity : 0,
  change,
  reachedBy: reachedBy(fn.name, caseWords),
});

/**
 * Compare the analyzer's view of the learner's files against the same view of
 * the scaffold they started from, and say which functions the change touched and
 * which tests reach them.
 *
 * Classification is by `bodyHash`, so moving a function between files or
 * reindenting it does not read as a change. A function that lost its home file
 * but kept its name is matched by name, so a move reports `changed` rather than
 * one `added` plus one `removed`.
 *
 * Returns undefined when either side has no function facts: an analyzer that
 * cannot see functions cannot support an impact claim.
 *
 * Pure: no I/O, no clock, no randomness.
 */
export function buildImpactReport(
  baseline: AnalyzerReport | undefined,
  current: AnalyzerReport | undefined,
  cases: TestCaseResult[],
): ImpactReport | undefined {
  const currentFns = current?.functions ?? [];
  const baselineFns = baseline?.functions ?? [];
  if (currentFns.length === 0 || baselineFns.length === 0) return undefined;

  const caseList = Array.isArray(cases) ? cases : [];
  const caseWords = caseList
    .filter((testCase) => typeof testCase?.name === 'string' && testCase.name.length > 0)
    .map((testCase) => ({ name: testCase.name, words: words(testCase.name) }));

  const byKey = new Map<string, AnalyzerFunction>();
  const byName = new Map<string, AnalyzerFunction[]>();
  for (const fn of baselineFns) {
    byKey.set(keyOf(fn), fn);
    const bucket = byName.get(fn.name);
    if (bucket) bucket.push(fn);
    else byName.set(fn.name, [fn]);
  }

  const matched = new Set<string>();
  const functions: ImpactFunction[] = [];

  for (const fn of currentFns.slice(0, MAX_FUNCTIONS)) {
    let previous = byKey.get(keyOf(fn));
    if (previous && matched.has(keyOf(previous))) previous = undefined;
    if (!previous) {
      // The function may have moved file. Only an unambiguous name match counts.
      const sameName = (byName.get(fn.name) ?? []).filter((c) => !matched.has(keyOf(c)));
      if (sameName.length === 1) previous = sameName[0];
    }
    if (previous) matched.add(keyOf(previous));
    const change: ImpactFunction['change'] = !previous
      ? 'added'
      : previous.bodyHash && previous.bodyHash === fn.bodyHash
        ? 'unchanged'
        : 'changed';
    functions.push(row(fn, change, caseWords));
  }

  for (const fn of baselineFns) {
    if (matched.has(keyOf(fn))) continue;
    if (functions.length >= MAX_FUNCTIONS) break;
    functions.push(row(fn, 'removed', caseWords));
  }

  const { change, regression } = splitTests(caseList);

  return {
    baseline: 'scaffold',
    functions,
    changeTests: change,
    regressionTests: regression,
  };
}
