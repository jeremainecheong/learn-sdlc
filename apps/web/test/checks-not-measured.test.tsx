// @vitest-environment jsdom
/**
 * The IDE Review tab's Checks table, for a phase whose files the analyzer does
 * not read (metrics.files 0, no issue: analysisNotMeasured). The Static
 * analysis section below it already read "Not measured" with a neutral chip,
 * but the table's "Static analysis" row still drew the API's status as a green
 * "Passed". That one row now draws a neutral "Not measured" chip and a todo
 * square; the API's status is untouched, every other row is drawn from the API, and a
 * report that read files renders byte for byte as recorded (the file snapshot
 * analysis-not-measured.test.tsx holds, re-checked here).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzerReport, FeedbackReport, SubmissionView } from '@learnsdlc/shared';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { markupLines } from './support/markup-snapshot';

const NOTHING_READ: AnalyzerReport = {
  issues: [],
  metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 1 },
  functions: [],
  imports: [],
};
const TWO_FILES: AnalyzerReport = {
  issues: [],
  metrics: { files: 2, functions: 5, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 0.8 },
};

const report = (staticAnalysis: AnalyzerReport): FeedbackReport => ({
  assessmentMode: 'strict_binary',
  overall: 100,
  passed: true,
  criteria: [
    { key: 'correctness_hidden', title: 'Hidden tests', weight: 0.4, score: 100, evidence: ['8/8 passed'] },
    { key: 'code_quality', title: 'Code quality', weight: 0.15, score: 100, evidence: [] },
  ],
  checks: [
    { id: 'hidden-tests', label: 'Hidden test suite (edge cases)', status: 'passed', detail: '8/8 passed' },
    { id: 'static-analysis', label: 'Static analysis', status: 'passed', detail: 'No findings.' },
  ],
  staticAnalysis,
  aiReview: {
    verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'fixture',
    criteriaEvidence: [
      { key: 'correctness_hidden', met: true, evidence: 'ok', issue: '', nextStep: '' },
      { key: 'code_quality', met: true, evidence: 'ok', issue: '', nextStep: '' },
    ],
  },
  aiReliance: { hintsThisPhase: 0, index: 0 },
  integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
});
const submission = (r: FeedbackReport): SubmissionView => ({
  id: 'sub', status: 'completed', score: 100, passed: true, verifiedPass: true, report: r, createdAt: '2026-11-08T00:00:00Z',
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

/** The Checks table's row whose label is `label`. */
const checkRow = (label: string) =>
  [...host.querySelectorAll('tr')].find((tr) => tr.querySelector('p')?.textContent === label) as HTMLElement;

describe('the Checks table in the IDE Review tab', () => {
  it('draws the Static analysis row as a neutral Not measured when the analyzer read no file', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(NOTHING_READ))} />));
    const row = checkRow('Static analysis');
    const chip = row.querySelector('.chip') as HTMLElement;
    expect(chip.textContent).toBe('Not measured');
    expect(chip.className.trim()).toBe('chip');
    expect(row.textContent).not.toContain('Passed');
    const hidden = checkRow('Hidden test suite (edge cases)');
    expect(hidden.querySelector('.chip')?.textContent).toBe('Passed');
    expect(hidden.querySelector('.chip')?.className.trim()).toBe('chip chip-pass');
  });

  it('a report that read files keeps Passed on the row and matches its snapshot byte for byte', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(TWO_FILES))} />));
    const chip = checkRow('Static analysis').querySelector('.chip') as HTMLElement;
    expect(chip.textContent).toBe('Passed');
    expect(chip.className.trim()).toBe('chip chip-pass');
    await expect(markupLines(host.innerHTML)).toMatchFileSnapshot('__snapshots__/feedback-panel-two-files-read.html');
  });
});
