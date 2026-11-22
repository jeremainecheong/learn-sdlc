// @vitest-environment jsdom
/**
 * The review's "Mentor activity" tile said "0 Questions asked" right after the learner
 * applied an Agentic proposal (Requirements, Testing, Deployment). Its count, `aiReliance.hintsThisPhase`, is the
 * grader's `hintsForPhase`: Guided messages only. The tile now names it as the process criterion's evidence does
 * ("Guided hints this phase"); where the report carries that criterion's Agentic sentence (the code grader's
 * `process` row) the tile shows it too, and where it does not, the tile says it does not count Agentic proposals.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CriterionScore, FeedbackReport, SubmissionView } from '@learnsdlc/shared';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';

const AGENTIC = 'One Agentic proposal this phase, applied after its explanation was accepted.';
const report = (hints: number, extra: CriterionScore[] = []): FeedbackReport => ({
  assessmentMode: 'strict_binary', overall: 100, passed: true,
  criteria: [{ key: 'tests_pass', title: 'Tests pass on the working helper', weight: 1, score: 100, evidence: ['2/2 passed.'] }, ...extra],
  checks: [{ id: 'tests', label: 'Tests', status: 'passed', detail: '2/2 passed' }],
  aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'fixture', criteriaEvidence: [] },
  aiReliance: { hintsThisPhase: hints, index: 0 },
  integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
});
const submission = (r: FeedbackReport): SubmissionView => ({ id: 'sub', status: 'completed', score: 100, passed: true, verifiedPass: true, report: r, createdAt: '2026-11-17T07:00:00Z' });

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const draw = (r: FeedbackReport) => act(() => root.render(<FeedbackPanel submission={submission(r)} />));
const tile = () => host.querySelector<HTMLElement>('[data-testid="reliance-note"]')!;

it('a report with no process criterion (Requirements, Testing, Deployment): Guided hints, and Agentic not counted here', () => {
  draw(report(0));
  expect(tile().textContent).toContain('0Guided hints this phase');
  expect(tile().textContent).toContain('Guided hints are learning activity.');
  expect(host.querySelector('[data-testid="reliance-agentic"]')?.textContent).toBe('Agentic proposals are not counted here.');
  expect(host.textContent).not.toMatch(/Questions? asked/);
  draw(report(1));
  expect(tile().textContent).toContain('1Guided hint this phase');
});

it('a report whose process criterion carries the Agentic sentence (Implementation): the tile says it too', () => {
  draw(report(0, [{ key: 'process', title: 'Process', weight: 0.1, score: 100, evidence: ['Ran tests before submitting.', 'No Guided hints this phase.', AGENTIC] }]));
  expect(host.querySelector('[data-testid="reliance-agentic"]')?.textContent).toBe(AGENTIC);
  expect(tile().textContent).not.toContain('not counted here');
});

it('a process criterion without an Agentic sentence (the proposals could not be read): not counted here, nothing invented', () => {
  draw(report(2, [{ key: 'process', title: 'Process', weight: 0.1, score: 100, evidence: ['Ran tests before submitting.', '2 Guided hints this phase.'] }]));
  expect(tile().textContent).toContain('2Guided hints this phase');
  expect(host.querySelector('[data-testid="reliance-agentic"]')?.textContent).toBe('Agentic proposals are not counted here.');
});
