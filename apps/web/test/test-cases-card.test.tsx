// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FeedbackReport, SubmissionView, TestCaseResult } from '@learnsdlc/shared';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { ChecksTab } from '@/components/pr/ChecksTab';
import { suiteCounts, suiteParts } from '@/components/pr/suiteCounts';

/*
 * A submission's run carries the visible and the hidden suite together. A
 * card titled "Hidden test suite" saying 28 of 28 beside a rubric saying
 * hidden 22 of 22 and visible 6 of 6 would disagree, so both places that
 * count a run's cases say "Test cases" and the three numbers apart, in the
 * same words.
 */

const cases = (n: number, hidden: boolean, failed = 0): TestCaseResult[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `${hidden ? 'hidden' : 'visible'}_case_${i + 1}`,
    status: i < failed ? ('failed' as const) : ('passed' as const),
    hidden: hidden || undefined,
    message: i < failed ? 'AssertionError: expected 404' : undefined,
  }));

const tests = (visible: TestCaseResult[], hidden: TestCaseResult[]): NonNullable<FeedbackReport['tests']> => {
  const all = [...visible, ...hidden];
  const passed = all.filter((c) => c.status === 'passed').length;
  return { total: all.length, passed, failed: all.length - passed, errored: 0, cases: all };
};

const report = (t: NonNullable<FeedbackReport['tests']>): FeedbackReport => ({
  assessmentMode: 'strict_binary',
  overall: 100,
  passed: true,
  criteria: [],
  checks: [],
  tests: t,
  aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'fixture' },
  aiReliance: { hintsThisPhase: 0, index: 0 },
  integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
});

const submission = (r: FeedbackReport): SubmissionView => ({
  id: 'sub',
  status: 'completed',
  score: 100,
  passed: true,
  verifiedPass: true,
  report: r,
  createdAt: '2026-11-08T00:00:00Z',
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const card = () => host.querySelector('[data-testid="hidden-suite"]') as HTMLElement;
const parts = () => [...card().querySelectorAll('[data-testid="suite-counts"] li')].map((li) => li.textContent);

describe('the counts', () => {
  it('splits a run into visible, hidden and total, which always add up', () => {
    const c = suiteCounts(tests(cases(6, false), cases(22, true)));
    expect(c).toEqual({ visible: { passed: 6, total: 6 }, hidden: { passed: 22, total: 22 }, total: { passed: 28, total: 28 } });
    expect(suiteParts(c).map((p) => p.text)).toEqual(['Visible 6 of 6', 'Hidden 22 of 22', 'Total 28 of 28']);
  });

  it('leaves out a part with no cases and always says the total', () => {
    expect(suiteParts(suiteCounts(tests(cases(6, false), []))).map((p) => p.text)).toEqual(['Visible 6 of 6', 'Total 6 of 6']);
    expect(suiteParts(suiteCounts(tests([], cases(3, true, 1)))).map((p) => p.text)).toEqual(['Hidden 2 of 3', 'Total 2 of 3']);
  });

  it('counts a failure in the suite it came from', () => {
    const c = suiteCounts(tests(cases(50, false, 2), cases(33, true, 1)));
    expect(suiteParts(c).map((p) => p.text)).toEqual(['Visible 48 of 50', 'Hidden 32 of 33', 'Total 80 of 83']);
  });
});

describe('the workspace feedback card', () => {
  it('is titled Test cases and says visible 6, hidden 22 and total 28 apart; the chip shows the total', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(tests(cases(6, false), cases(22, true))))} />));
    expect(card().querySelector('h3')?.textContent).toBe('Test cases');
    expect(card().textContent).not.toContain('Hidden test suite');
    expect(parts()).toEqual(['Visible 6 of 6', 'Hidden 22 of 22', 'Total 28 of 28']);
    expect(card().textContent).toContain('All 28 cases pass.');
    expect(card().textContent).toContain('28 of 28');
  });

  it('lists every failure by name, visible or hidden', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(tests(cases(6, false, 1), cases(22, true, 2))))} />));
    expect(parts()).toEqual(['Visible 5 of 6', 'Hidden 20 of 22', 'Total 25 of 28']);
    const rows = card().querySelector('[data-testid="failed-cases"]')?.textContent ?? '';
    expect(rows).toContain('visible_case_1');
    expect(rows).toContain('hidden_case_1');
    expect(rows).toContain('hidden_case_2');
  });
});

describe('the review Checks tab', () => {
  it('uses the same title and the same words as the workspace card', async () => {
    await act(async () => root.render(<ChecksTab report={report(tests(cases(6, false), cases(22, true)))} attempt={1} gate={0} />));
    expect(card().textContent).toContain('Test cases');
    expect(card().textContent).not.toContain('Hidden test suite');
    expect(parts()).toEqual(['Visible 6 of 6', 'Hidden 22 of 22', 'Total 28 of 28']);
    expect(card().textContent).toContain('28 of 28');
  });

  it('lists a failing visible case too, so the chip and the list agree', async () => {
    await act(async () => root.render(<ChecksTab report={report(tests(cases(6, false, 1), cases(22, true)))} attempt={1} gate={0} />));
    expect(parts()).toEqual(['Visible 5 of 6', 'Hidden 22 of 22', 'Total 27 of 28']);
    expect(card().querySelector('[data-testid="failed-cases"]')?.textContent).toContain('visible_case_1');
  });
});
