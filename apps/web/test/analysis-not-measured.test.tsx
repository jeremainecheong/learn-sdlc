// @vitest-environment jsdom
/**
 * The analyzer reads Python (.py) and JavaScript (.js, .jsx) only
 * (apps/api/runner/analyzer.py, `analyzer_for`), so a phase whose files are all
 * TypeScript comes back with `metrics.files === 0`, no issues and a docstring
 * coverage of 1.0. The review surfaces printed that as a measurement: "0
 * functions across 0 files, 0 to do, complexity up to 0, docstrings on 100%"
 * with a "Clean" chip in the IDE's Review tab, and "Clean" on the pull
 * request's Checks card and Analyzer section. They now say it was not
 * measured, with a neutral chip, and the Code quality criterion row carries one
 * note. Its level chip stays as the API sent it. A report that read files
 * renders exactly as recorded (a file snapshot of the whole rendered HTML).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzerReport, FeedbackReport, SubmissionView } from '@learnsdlc/shared';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { ChecksTab } from '@/components/pr/ChecksTab';
import { checkRows } from '@/components/pr/ChecksCard';
import { markupLines } from './support/markup-snapshot';

const PURPOSE = "Not measured: the analyzer reads Python and JavaScript, and none of this phase's files is one it reads.";
const NOTE = 'No file in this phase is one the analyzer reads, so nothing was measured for this criterion.';

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

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
/** The criterion row whose title is `title`. */
const criterionRow = (title: string) =>
  [...host.querySelectorAll('tr')].find((tr) => tr.querySelector('p')?.textContent === title) as HTMLElement;

describe('the IDE Review tab (FeedbackPanel)', () => {
  it('says the static analysis read nothing, with a neutral chip, and never Clean or docstrings on 100%', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(NOTHING_READ))} />));
    const section = q('static-analysis');
    expect(section.querySelector('.purpose')?.textContent).toBe(PURPOSE);
    const chip = section.querySelector('.chip') as HTMLElement;
    expect(chip.textContent).toBe('Not measured');
    expect(chip.className.trim()).toBe('chip');
    expect(host.textContent).not.toContain('Clean');
    expect(host.textContent).not.toContain('docstrings on 100%');
    expect(host.textContent).not.toContain('0 functions across 0 files');
  });

  it('puts one note under Code quality and leaves its level chip as the API sent it', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(NOTHING_READ))} />));
    const row = criterionRow('Code quality');
    expect(row.textContent).toContain(NOTE);
    expect(row.querySelector('.chip')?.textContent).toBe('Met');
    expect(row.querySelector('.chip')?.className.trim()).toBe('chip chip-pass');
    expect(criterionRow('Hidden tests').textContent).not.toContain(NOTE);
    expect(host.textContent?.split(NOTE).length).toBe(2);
  });

  it('a report that read two files matches its snapshot byte for byte', async () => {
    await act(async () => root.render(<FeedbackPanel submission={submission(report(TWO_FILES))} />));
    expect(q('static-analysis').querySelector('.purpose')?.textContent).toBe(
      '5 functions across 2 files, 0 to do, complexity up to 3, docstrings on 80%.',
    );
    expect(q('static-analysis').querySelector('.chip')?.textContent).toBe('Clean');
    expect(host.textContent).not.toContain(NOTE);
    await expect(markupLines(host.innerHTML)).toMatchFileSnapshot('__snapshots__/feedback-panel-two-files-read.html');
  });

  it('an analyzer that could not run (no file read, one issue) keeps its finding count', async () => {
    const broken: AnalyzerReport = {
      ...NOTHING_READ,
      issues: [{ path: '', line: 0, severity: 'info', rule: 'analyzer-unavailable', message: 'The analyzer did not run.' }],
    };
    await act(async () => root.render(<FeedbackPanel submission={submission(report(broken))} />));
    expect(q('static-analysis').querySelector('.chip')?.textContent).toBe('1 finding');
    expect(host.textContent).not.toContain('Not measured');
  });
});

describe('the pull request Checks tab (ChecksCard and Analyzer)', () => {
  it('the Analyzer row of the Checks card reads Not measured, neutral, with the reason', () => {
    const row = checkRows(report(NOTHING_READ)).find((r) => r.key === 'static-analysis');
    expect(row).toMatchObject({ label: 'Analyzer', result: 'Not measured', tone: 'neutral', state: 'todo' });
    expect(row?.detail).toBe("The analyzer reads Python and JavaScript, and none of this phase's files is one it reads.");
  });

  it('the Analyzer section says not measured with a neutral chip, and nothing reads Clean', async () => {
    await act(async () => root.render(<ChecksTab report={report(NOTHING_READ)} attempt={3} gate={0} />));
    const section = q('pr-analyzer');
    expect(section.querySelector('.purpose')?.textContent).toBe(PURPOSE);
    const chip = section.querySelector('.chip') as HTMLElement;
    expect(chip.textContent).toBe('Not measured');
    expect(chip.className.trim()).toBe('chip');
    expect(host.textContent).not.toContain('Clean');
    expect(host.textContent).not.toContain('100% documented');
    expect(host.textContent).not.toContain('0 functions read');
  });

  it('a report that read two files matches its snapshot byte for byte', async () => {
    await act(async () => root.render(<ChecksTab report={report(TWO_FILES)} attempt={3} gate={0} />));
    expect(checkRows(report(TWO_FILES)).find((r) => r.key === 'static-analysis')).toMatchObject({
      result: 'Clean', tone: 'pass', state: 'pass', detail: 'No findings.',
    });
    expect(q('pr-analyzer').querySelector('.purpose')?.textContent).toBe('5 functions read, worst complexity 3, 80% documented.');
    await expect(markupLines(host.innerHTML)).toMatchFileSnapshot('__snapshots__/checks-tab-two-files-read.html');
  });
});
