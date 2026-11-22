// @vitest-environment jsdom
/**
 * A pack with one planted bug read "The one planted bugs". Every string
 * that puts a count before "planted bug" now follows the count; TaskTrackr's
 * eight keep their plural.
 */
import { repoPath } from './support/paths';
import { readdirSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FeedbackReport, MutantRow, SubmissionView } from '@learnsdlc/shared';
import { PlantedBugs, matrixPurpose } from '@/components/workspace/panels/testing/MatrixDoc';
import { twinDetail } from '@/components/workspace/panels/testing/Matrix';
import { caughtLine } from '@/components/dossier/Dossier';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { bugsAliveText, type MatrixView } from '@/components/workspace/panels/testing/lib';

/** TaskTrackr's planted bugs, counted from the content (8 today). */
const EIGHT = readdirSync(repoPath('content/tasktrackr/phases/04-testing/mutants')).length;

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const row = (i: number): MutantRow => ({ mutant: `m${i}`, description: `Bug ${i}`, killed: true, cases: [{ name: 'test_a', status: 'failed' }] });
const view = (total: number): MatrixView => ({
  columns: [{ key: 'test_a', label: 'T1', name: 'test_a', kills: [], verdict: 'load-bearing' }],
  rows: Array.from({ length: total }, (_, i) => ({ row: row(i + 1), id: `B${i + 1}`, killers: ['T1'], ran: ['T1'] })),
  killed: total,
  total,
  unrun: false,
});
const heading = () => host.querySelector('[data-testid="phase-testing-planted-bugs"]')?.textContent ?? '';

describe('one planted bug reads singular', () => {
  it('TaskTrackr has eight planted bugs', () => {
    expect(EIGHT).toBe(8);
  });
  it('the mutation evidence heading follows the count: one, four and eight', async () => {
    await act(async () => root.render(<PlantedBugs view={view(1)} />));
    expect(heading()).toContain('The one planted bug');
    expect(heading()).not.toContain('planted bugs');
    await act(async () => root.render(<PlantedBugs view={view(4)} />));
    expect(heading()).toContain('The four planted bugs');
    await act(async () => root.render(<PlantedBugs view={view(EIGHT)} />));
    expect(heading()).toContain('The 8 planted bugs');
  });
  it('the purpose line follows both counts, the verb included', () => {
    expect(matrixPurpose(view(1))).toMatch(/^Your one test runs against one planted bug\. /);
    expect(matrixPurpose(view(EIGHT))).toMatch(/^Your one test runs against 8 planted bugs\. /);
    const two: MatrixView = { ...view(EIGHT), columns: [...view(EIGHT).columns, { ...view(EIGHT).columns[0], key: 'test_b', label: 'T2', name: 'test_b' }] };
    expect(matrixPurpose(two)).toMatch(/^Your two tests run against 8 planted bugs\. /);
  });
  it('the Testing room\'s chip for the bugs still alive', () => {
    expect(bugsAliveText(1)).toBe('1 bug alive');
    expect(bugsAliveText(3)).toBe('3 bugs alive');
  });
  it('a twin test names "the same bug" for one bug and "the same bugs" for more', () => {
    expect(twinDetail(['B1'], 'T2')).toBe('Catches B1, the same bug as T2.');
    expect(twinDetail(['B1', 'B3'], 'T2')).toBe('Catches B1 and B3, the same bugs as T2.');
  });
  it('the dossier\'s caught line', () => {
    expect(caughtLine(1, 1)).toBe('1 of 1 planted bug was caught');
    expect(caughtLine(0, 1)).toBe('0 of 1 planted bug was caught');
    expect(caughtLine(7, EIGHT)).toBe('7 of 8 planted bugs were caught');
  });
  it('the feedback panel\'s planted-bug line', async () => {
    const report = (total: number): FeedbackReport => ({
      assessmentMode: 'strict_binary', overall: 100, passed: true, criteria: [], checks: [],
      mutation: { total, killed: total, survivors: [] },
      aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'fixture' },
      aiReliance: { hintsThisPhase: 0, index: 0 }, integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
    } as FeedbackReport);
    const submission = (total: number): SubmissionView => ({ id: 's', status: 'completed', score: 100, passed: true, verifiedPass: true, report: report(total), createdAt: '2026-11-10T00:00:00Z' } as SubmissionView);
    const line = () => [...host.querySelectorAll('[data-testid="mutation-report"] p')].map((p) => p.textContent ?? '').find((text) => text.includes('killed by'));
    await act(async () => root.render(<FeedbackPanel submission={submission(1)} />));
    expect(line()).toBe('1/1 planted bug killed by your tests.');
    await act(async () => root.render(<FeedbackPanel submission={submission(EIGHT)} />));
    expect(line()).toBe('8/8 planted bugs killed by your tests.');
  });
});
