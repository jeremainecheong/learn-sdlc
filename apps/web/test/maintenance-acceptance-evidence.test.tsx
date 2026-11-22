// @vitest-environment jsdom
/**
 * The evidence under each acceptance item names a test case only when
 * the change request ties that item to that case alone.
 *
 * A record can have one test entry, T1, covering AC-1 and AC-2 together. A
 * word match would read "Checked by a completed task due yesterday is not
 * overdue" under AC-2, the open-task date rule that case does not exercise.
 * The record never says which case checks which item, so each item covered by
 * a shared entry reads the entry and the visible run, case by case. The words
 * come from `acceptanceLines` (./regression) through `AcceptanceEvidence`, the
 * one component the Change tab and the change request page both draw.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest,
  type FeedbackReport, type PhaseDetail, type SubmissionView, type TestCaseResult,
} from '@learnsdlc/shared';
import { acceptanceLines, buildSuites, type CoveringTest } from '@/components/workspace/panels/maintenance/regression';
import { AcceptanceEvidence } from '@/components/workspace/panels/maintenance/AcceptanceEvidence';
import { MaintenanceTools } from '@/components/workspace/panels/maintenance/Tools';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

/** Deadline badge's CR-1, as the pack's phase.json carries it. */
const ACCEPTANCE = [
  { id: 'AC-1', line: 'A completed task is never overdue, whatever its due date.' },
  { id: 'AC-2', line: 'An open task is overdue only when its due date is before today, as before.' },
];
const YESTERDAY = 'a task due yesterday is overdue';
const TODAY = 'a task due today is not overdue';
const COMPLETED = 'a completed task due yesterday is not overdue';

const pass = (name: string, hidden = false): TestCaseResult => ({ name, status: 'passed', ...(hidden ? { hidden } : {}) });
const fail = (name: string, hidden = false): TestCaseResult => ({ name, status: 'failed', message: 'expected false', ...(hidden ? { hidden } : {}) });

/** A passing verdict: the learner's three visible cases, the four hidden regression cases and the one hidden change case, all passed. */
function run6(visible: TestCaseResult[] = [pass(YESTERDAY), pass(TODAY), pass(COMPLETED)]): FeedbackReport {
  const hidden = [YESTERDAY, TODAY, 'a task due tomorrow is not overdue', 'a task with no due date is not overdue', COMPLETED].map((n) => pass(n, true));
  const cases = [...visible, ...hidden];
  return {
    passed: true,
    score: 100,
    tests: { passed: cases.filter((c) => c.status === 'passed').length, failed: cases.filter((c) => c.status !== 'passed').length, total: cases.length, cases },
    impact: { baseline: 'scaffold', functions: [], changeTests: [COMPLETED], regressionTests: [] },
  } as unknown as FeedbackReport;
}

const T1_BOTH: CoveringTest[] = [{ id: 'T1', suite: 'overdue regression tests', covers: ['AC-1', 'AC-2'] }];

function linesFor(tests: CoveringTest[], report: FeedbackReport | null) {
  return acceptanceLines(ACCEPTANCE, tests, buildSuites(report, 'isOverdue', null));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Each line's words, as the row's detail draws them. */
function words(tests: CoveringTest[], report: FeedbackReport | null): string[] {
  const lines = linesFor(tests, report);
  act(() => {
    root.render(
      <>
        {lines.map((line) => (
          <p key={line.id} data-id={line.id}>
            <AcceptanceEvidence evidence={line.evidence} pr="PR-6" />
          </p>
        ))}
      </>,
    );
  });
  return [...host.querySelectorAll('p')].map((p) => p.textContent ?? '');
}

const RUN6_LINE =
  'T1 (overdue regression tests) covers AC-1 and AC-2 together. Your visible tests, 3 of 3 passed: a task due yesterday is overdue; a task due today is not overdue; a completed task due yesterday is not overdue.';

describe('one entry covering two items', () => {
  it('both items read the entry and the visible run, case by case, and neither is credited to the completed-task case alone', () => {
    const said = words(T1_BOTH, run6());
    expect(said).toEqual([RUN6_LINE, RUN6_LINE]);
    for (const line of said) expect(line).not.toContain(`Checked by ${COMPLETED}`);
    expect(linesFor(T1_BOTH, run6()).map((l) => l.state)).toEqual(['pass', 'pass']);
  });

  it('the pack\'s own drafted record (suite named by its file) reads the same run', () => {
    const said = words([{ id: 'T1', suite: 'web/src/lib/overdue.test.ts', covers: ['AC-1', 'AC-2'] }], run6());
    expect(said[1]).toBe(
      'T1 (web/src/lib/overdue.test.ts) covers AC-1 and AC-2 together. Your visible tests, 3 of 3 passed: a task due yesterday is overdue; a task due today is not overdue; a completed task due yesterday is not overdue.',
    );
  });

  it('visible tests passed but the hidden change test failed: not green, and the words say the change tests failed', () => {
    const report = run6();
    report.tests!.cases = report.tests!.cases.map((c) => (c.hidden && c.name === COMPLETED ? { ...c, status: 'failed' } : c));
    expect(linesFor(T1_BOTH, report).map((l) => l.state)).toEqual(['todo', 'todo']);
    expect(words(T1_BOTH, report)).toEqual([`${RUN6_LINE} The change tests, failed.`, `${RUN6_LINE} The change tests, failed.`]);
    // The passing verdict stays green, and its words carry no change-test sentence.
    expect(linesFor(T1_BOTH, run6()).map((l) => l.state)).toEqual(['pass', 'pass']);
    expect(words(T1_BOTH, run6())[0]).toBe(RUN6_LINE);
  });

  it('an acceptance id the ticket does not have is said, not dropped', () => {
    const said = words([{ id: 'T1', suite: 'overdue tests', covers: ['AC-9', 'AC-1'] }], run6());
    expect(said[0]).toMatch(/^T1 \(overdue tests\) covers AC-1 and AC-9 together \(AC-9 is not on the ticket\)\. Your visible tests, 3 of 3 passed: /);
  });

  it('a partly failed run names the failed case and is red', () => {
    const report = run6([pass(YESTERDAY), fail(TODAY), pass(COMPLETED)]);
    expect(words(T1_BOTH, report)[1]).toBe(
      'T1 (overdue regression tests) covers AC-1 and AC-2 together. Your visible tests, 2 of 3 passed: a task due today is not overdue failed.',
    );
    expect(linesFor(T1_BOTH, report).map((l) => l.state)).toEqual(['fail', 'fail']);
  });

  it('a verdict with no visible run says so, and the record\'s "Passes" is not read', () => {
    const report = run6([]);
    expect(words(T1_BOTH, report)[0]).toBe(
      'T1 (overdue regression tests) covers AC-1 and AC-2 together. Your visible tests did not run in this review.',
    );
    expect(linesFor(T1_BOTH, report).map((l) => l.state)).toEqual(['todo', 'todo']);
  });

  it('before any verdict every item reads the sentence it read before', () => {
    expect(words(T1_BOTH, null)).toEqual([
      'Checked by the hidden change tests when you submit PR-6.',
      'Checked by the hidden change tests when you submit PR-6.',
    ]);
    expect(linesFor(T1_BOTH, null).map((l) => l.state)).toEqual(['todo', 'todo']);
  });

  it('lists five case names and counts the rest', () => {
    const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    const said = words(T1_BOTH, run6(names.map((n) => pass(n))));
    expect(said[0]).toBe(
      'T1 (overdue regression tests) covers AC-1 and AC-2 together. Your visible tests, 7 of 7 passed: one; two; three; four; five and 2 more.',
    );
  });
});

describe('one entry per item', () => {
  it('an entry covering one item and naming one case reads "Checked by <case>."', () => {
    const tests: CoveringTest[] = [
      { id: 'T1', suite: COMPLETED, covers: ['AC-1'] },
      { id: 'T2', suite: TODAY, covers: ['AC-2'] },
    ];
    expect(words(tests, run6())).toEqual([`Checked by ${COMPLETED}.`, `Checked by ${TODAY}.`]);
    expect(linesFor(tests, run6()).map((l) => l.state)).toEqual(['pass', 'pass']);
    const red = run6([pass(YESTERDAY), fail(TODAY), pass(COMPLETED)]);
    expect(linesFor(tests, red).map((l) => l.state)).toEqual(['pass', 'fail']);
  });

  it('a Python case is named by its method, matched with or without its class', () => {
    const report = {
      passed: true, score: 100,
      tests: { passed: 1, failed: 0, total: 1, cases: [pass('CommentChange.test_comments_come_back_newest_first', true)] },
      impact: { baseline: 'scaffold', functions: [], changeTests: ['CommentChange.test_comments_come_back_newest_first'], regressionTests: [] },
    } as unknown as FeedbackReport;
    const lines = acceptanceLines(
      [{ id: 'AC-4', line: "list_comments returns a task's comments newest first." }],
      [{ id: 'T1', suite: 'test_comments_come_back_newest_first', covers: ['AC-4'] }],
      buildSuites(report, 'list_comments', null),
    );
    expect(lines[0].evidence).toEqual({ kind: 'case', name: 'test_comments_come_back_newest_first' });
  });

  it('an entry covering one item whose suite is not a case names the entry and the run, never a case by its words', () => {
    const tests: CoveringTest[] = [
      { id: 'T1', suite: 'overdue tests', covers: ['AC-1'] },
      { id: 'T2', suite: 'overdue tests', covers: ['AC-2'] },
    ];
    const said = words(tests, run6());
    expect(said[1]).toBe(
      'T2 (overdue tests) covers AC-2. Your visible tests, 3 of 3 passed: a task due yesterday is overdue; a task due today is not overdue; a completed task due yesterday is not overdue.',
    );
    expect(said[1]).not.toContain(`Checked by ${COMPLETED}`);
  });

  it('two entries covering one item name both', () => {
    const tests: CoveringTest[] = [
      { id: 'T1', suite: 'overdue tests', covers: ['AC-1', 'AC-2'] },
      { id: 'T2', suite: '', covers: ['AC-2'] },
    ];
    expect(words(tests, run6())[1]).toMatch(/^T1 and T2 cover AC-2\. Your visible tests, 3 of 3 passed: /);
  });
});

describe('an item no entry covers (the older sentences)', () => {
  it('reads the change tests\' result, green only when they passed', () => {
    expect(words([], run6())).toEqual(['Checked by the change tests, passed.', 'Checked by the change tests, passed.']);
    expect(linesFor([], run6()).map((l) => l.state)).toEqual(['pass', 'pass']);
    const report = run6();
    report.tests!.cases = report.tests!.cases.map((c) => (c.name === COMPLETED && c.hidden ? { ...c, status: 'failed' } : c));
    expect(words([], report)[0]).toBe('Checked by the change tests, failed.');
    expect(linesFor([], report).map((l) => l.state)).toEqual(['todo', 'todo']);
  });
});

describe('the Change tab in the workspace draws the same words', () => {
  it('both items read the entry and the visible run, with a full stop, and the ticket rows stay in place', () => {
    const record = { ...EMPTY_CHANGE_REQUEST, impact: { operations: ['isOverdue'], screens: [], files: ['web/src/lib/overdue.ts'] }, tests: [{ id: 'T1', suite: 'overdue regression tests', covers: ['AC-1', 'AC-2'], result: 'pass' as const }] };
    const detail = {
      id: 'p-m', key: 'maintenance', title: 'Maintenance', order: 6, place: 6, count: 6, projectSlug: 'deadline-badge', attempts: 0,
      change: { ticket: { id: 'CR-1', title: 'Completed tasks are not overdue', summary: '', acceptance: ACCEPTANCE }, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } },
      files: [
        { path: 'web/src/lib/overdue.ts', content: 'export const isOverdue = () => false;\n', editable: true, language: 'typescript' },
        { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(record), editable: true, language: 'json' },
      ],
    } as unknown as PhaseDetail;
    const submission = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: '2026-11-10T13:32:00Z', report: run6() } as unknown as SubmissionView;
    const props = {
      detail, files: {}, submission, submissions: [submission], enrollment: null, setFile: vi.fn(),
      helpers: { openFile: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), fileText: () => '', submitNow: vi.fn(), setNotice: vi.fn(), busy: false },
    } as unknown as PhasePanelProps;
    act(() => root.render(<MaintenanceTools {...props} />));
    const ticket = host.querySelector('[data-testid="phase-maintenance-ticket"]')!.textContent ?? '';
    expect(ticket).toContain(`AC-1 A completed task is never overdue, whatever its due date.${RUN6_LINE}`);
    expect(ticket).toContain(`AC-2 An open task is overdue only when its due date is before today, as before.${RUN6_LINE}`);
    expect(ticket).not.toContain(`Checked by ${COMPLETED}`);
  });
});
