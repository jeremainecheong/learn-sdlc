/**
 * The verdict's test cases, read as three suites: the change tests that prove
 * CR-1, the regression suite that proves nothing else moved, and the visible
 * tests the learner can run themselves.
 *
 * The report ships one flat list, so the split is done here. The API's impact
 * section names the two hidden suites when it is present and that naming wins;
 * otherwise the case names carry it: Python reports `Class.test_name`, and the
 * JavaScript harness reports the sentence the test was written with.
 */
import type { FeedbackReport, TestCaseResult } from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';
import { count } from './change-signature';

export type SuiteId = 'regression' | 'visible' | 'change';

export interface Suite {
  id: SuiteId;
  title: string;
  detail: string;
  cases: TestCaseResult[];
  passed: number;
  failed: number;
  state: StatusState;
  /** "All 4 passed" / "2 of 4 passed": the right-hand result. */
  result: string;
}

/** `ReopenChange.test_reopen_unknown_id_raises` → `ReopenChange`. */
export function suiteOf(name: string): string {
  const cut = name.indexOf('.');
  if (cut <= 0) return '';
  const head = name.slice(0, cut);
  return /^[A-Z]/.test(head) ? head : '';
}

/** The part a reader recognises: the method name, or the whole sentence. */
export function caseLabel(name: string): string {
  const cut = name.indexOf('.');
  return cut > 0 && /^[A-Z]/.test(name.slice(0, cut)) ? name.slice(cut + 1) : name;
}

const CHANGE_SUITE = /change/i;
const REGRESSION_SUITE = /regression/i;

/** `reopen_task` / `reopenTask` → `reopen`, the word both packs' test names use. */
export function changeWord(changeName: string): string {
  const parts = changeName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (parts[0] ?? changeName).toLowerCase();
}

function isChangeCase(c: TestCaseResult, word: string): boolean {
  const suite = suiteOf(c.name);
  if (suite) return CHANGE_SUITE.test(suite) || (!REGRESSION_SUITE.test(suite) && c.name.toLowerCase().includes(word));
  return c.name.toLowerCase().includes(word);
}

const stateOf = (cases: TestCaseResult[]): StatusState => {
  if (cases.length === 0) return 'todo';
  return cases.every((c) => c.status === 'passed') ? 'pass' : 'fail';
};

const resultOf = (cases: TestCaseResult[]): string => {
  if (cases.length === 0) return 'None ran';
  const passed = cases.filter((c) => c.status === 'passed').length;
  // A suite of one reads as itself: "All 1 passed" is not a sentence.
  if (cases.length === 1) return passed === 1 ? 'Passed' : 'Failed';
  if (passed === cases.length) return `All ${cases.length} passed`;
  return `${passed} of ${cases.length} passed`;
};

function suite(id: SuiteId, title: string, detail: string, cases: TestCaseResult[]): Suite {
  return {
    id,
    title,
    detail,
    cases,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status !== 'passed').length,
    state: stateOf(cases),
    result: resultOf(cases),
  };
}

/**
 * The three suites, in the order the change is read: what still works, what
 * the learner can run, then what CR-1 asked for.
 */
export function buildSuites(
  report: FeedbackReport | null,
  changeName: string,
  visiblePath: string | null,
): Suite[] {
  const cases = report?.tests?.cases ?? [];
  if (cases.length === 0) return [];
  const word = changeWord(changeName);
  const named = new Set((report?.impact?.changeTests ?? []).map((n) => n));
  const hidden = cases.filter((c) => c.hidden === true);
  const visible = cases.filter((c) => c.hidden !== true);
  const change = hidden.filter((c) => (named.size > 0 ? named.has(c.name) : isChangeCase(c, word)));
  const changed = new Set(change.map((c) => c.name));
  const regression = hidden.filter((c) => !changed.has(c.name));

  const out: Suite[] = [];
  if (regression.length > 0) {
    out.push(
      suite(
        'regression',
        'Regression suite',
        `${count(regression.length, 'hidden case')} over the operations the earlier phases graded.`,
        regression,
      ),
    );
  }
  if (visible.length > 0) {
    out.push(
      suite(
        'visible',
        'Your visible tests',
        visiblePath ? `${visiblePath}, ${count(visible.length, 'case')}.` : `${count(visible.length, 'case')}.`,
        visible,
      ),
    );
  }
  if (change.length > 0) {
    out.push(suite('change', 'Change tests', `${count(change.length, 'hidden case')} for the change request.`, change));
  }
  return out;
}

/* ------------------------- the ticket, line by line ------------------------ */

/**
 * What the record and the verdict establish about one acceptance item.
 *
 * The change request's tests (`ChangeRequest.tests`) tie acceptance items to a
 * suite the learner names; the verdict says which cases ran. Neither says which
 * case proves which item, so a case is named only when the record ties the item
 * to that case alone: an entry that covers this item and nothing else, and
 * whose suite is that case's own name.
 */
export type AcceptanceEvidence =
  /** An entry covering this item alone names this case of the verdict. */
  | { kind: 'case'; name: string }
  /**
   * The record's entries cover this item but name no single case of it (one
   * entry covering several items, or a suite that is a file or a phrase): the
   * verdict's run of the learner's visible tests, case by case, and nothing
   * that says which case checks which item.
   */
  | {
      kind: 'suite';
      item: string;
      entries: { id: string; suite: string; covers: string[] }[];
      run: SuiteRun | null;
      /** The change tests' result when they ran and did not all pass, else null. */
      change: string | null;
      /** Covered ids the ticket does not have, so the words can say so. */
      unknown: string[];
    }
  /** No entry covers this item: the change tests' result, as the suite reports it. */
  | { kind: 'change'; result: string }
  /** No verdict yet. */
  | { kind: 'pending' };

/** A suite's run, read from the verdict: every case name, and the ones that did not pass. */
export interface SuiteRun {
  total: number;
  passed: number;
  names: string[];
  failed: string[];
}

export interface ContractLine {
  /** The acceptance item's id (`AC-1`). */
  id: string;
  text: string;
  state: StatusState;
  evidence: AcceptanceEvidence;
}

/** One test entry of the change request, as the lines read it. */
export interface CoveringTest {
  id: string;
  suite: string;
  covers: string[];
}

const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

function runOf(suite: Suite): SuiteRun {
  return {
    total: suite.cases.length,
    passed: suite.passed,
    names: suite.cases.map((c) => caseLabel(c.name)),
    failed: suite.cases.filter((c) => c.status !== 'passed').map((c) => caseLabel(c.name)),
  };
}

/**
 * Each acceptance item of the ticket, in the ticket's order, with what the
 * record and the verdict say about it (see {@link AcceptanceEvidence}).
 *
 * - No verdict yet: pending, for every item.
 * - An entry covers this item alone and its suite is a case's name: that case,
 *   green only when every case of that name passed.
 * - Otherwise, entries that cover it: the visible run, green when every case of
 *   it passed and the change tests (when they ran) passed too; red when the
 *   visible run failed; not yet green otherwise, with the change tests' result
 *   in the words. The record's own Result field is never read: the learner
 *   typed it.
 * - No entry covers it: the change tests' result, green only when they passed.
 */
export function acceptanceLines(
  acceptance: { id: string; line: string }[],
  tests: CoveringTest[],
  suites: Suite[],
): ContractLine[] {
  const ids = acceptance.map((a) => a.id);
  const ordered = (covers: string[]) => ids.filter((id) => covers.includes(id));
  const cases = suites.flatMap((s) => s.cases);
  const visible = suites.find((s) => s.id === 'visible') ?? null;
  const change = suites.find((s) => s.id === 'change') ?? null;
  const verdict = suites.length > 0;

  return acceptance.map(({ id, line }) => {
    if (!verdict) return { id, text: line, state: 'todo', evidence: { kind: 'pending' } };

    const covering = tests.filter((t) => t.covers.includes(id));
    for (const t of covering) {
      if (new Set(t.covers).size !== 1 || !t.suite.trim()) continue;
      const named = cases.filter((c) => norm(c.name) === norm(t.suite) || norm(caseLabel(c.name)) === norm(t.suite));
      if (named.length === 0) continue;
      return {
        id,
        text: line,
        state: named.every((c) => c.status === 'passed') ? 'pass' : 'fail',
        evidence: { kind: 'case', name: caseLabel(named[0].name) },
      };
    }

    if (covering.length > 0) {
      return {
        id,
        text: line,
        // Green only when the visible run passed and the change tests, if any ran, passed too.
        state:
          visible?.state === 'fail'
            ? 'fail'
            : visible?.state === 'pass' && (!change || change.state === 'pass')
              ? 'pass'
              : 'todo',
        evidence: {
          kind: 'suite',
          item: id,
          // An id the ticket does not have stays in the sentence, after the ticket's own, so it never vanishes.
          entries: covering.map((t) => ({
            id: t.id,
            suite: t.suite.trim(),
            covers: [...ordered(t.covers), ...[...new Set(t.covers)].filter((c) => !ids.includes(c))],
          })),
          run: visible ? runOf(visible) : null,
          change: change && change.state !== 'pass' ? change.result : null,
          unknown: [...new Set(covering.flatMap((t) => t.covers))].filter((c) => !ids.includes(c)),
        },
      };
    }

    if (change) {
      return { id, text: line, state: change.state === 'pass' ? 'pass' : 'todo', evidence: { kind: 'change', result: change.result } };
    }
    return { id, text: line, state: 'todo', evidence: { kind: 'pending' } };
  });
}

/** The first line of a failure message; the rest belongs in the case list. */
export function firstLine(message: string | undefined, max = 160): string {
  const line = (message ?? '').split('\n').find((l) => l.trim()) ?? '';
  const flat = line.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
