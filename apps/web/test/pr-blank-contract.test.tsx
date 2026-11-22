// @vitest-environment jsdom
/**
 * A passed PR-6 must not open its Conversation on a red, Open thread from "Maintainer", "Errors. Boundary." / "Which
 * do you want: the contract changed, or the code? Say which in the merge message.", above "Pass. Every required
 * criterion has acceptable evidence.".
 *
 * The thread is the web's own reading of the review's conformance ledger (`report.contract`, which the API builds
 * and calls advisory): isOverdue's Errors line is blank (the Design box is optional and may be left empty) and
 * its Returns names no boundary, so both lines are `unclaimed` with no text. The thread is drawn, never stored,
 * graded, counted by the API or asked for by the merge. On a review that passed, a contract whose every open line
 * the design left blank is not raised as a thread; the ledger (the Checks tab) still lists it. A contract with a line
 * that is broken, contradicted or written-but-unverified, and every contract on a review that has not passed, is a
 * thread.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContractClaim, FeedbackReport } from '@learnsdlc/shared';
import { prThreads } from '@/components/pr/threads';
import { Conversation } from '@/components/pr/Conversation';
import { buildLedger } from '@/components/workspace/panels/implementation/pr';
import type { Revision } from '@/components/workspace/panels/implementation/pr';

const claim = (over: Partial<ContractClaim>): ContractClaim => ({ name: 'isOverdue', story: 'US-1', claim: 'inputs', text: 'task: Task; today: date', verdict: 'kept', evidence: [], ...over });
/** The Deadline badge ledger on PR-6: inputs and returns kept, errors and boundary blank. */
const DEMO: ContractClaim[] = [
  claim({ claim: 'inputs' }),
  claim({ claim: 'returns', text: 'boolean (true if task is overdue, otherwise false)' }),
  claim({ claim: 'errors', text: '', verdict: 'unclaimed', evidence: ['The errors line is present but empty, so there is no contract to check.'] }),
  claim({ claim: 'boundary', text: '', verdict: 'unclaimed', evidence: ['The design states no boundary for isOverdue.'] }),
];
const revision = (passed: boolean, contract: ContractClaim[]): Revision =>
  ({ id: 'rev-1', attempt: 1, createdAt: '2026-11-18T05:05:09Z', state: passed ? 'pass' : 'fail',
    report: { passed, overall: passed ? 100 : 40, checks: [], contract, tests: { passed: 3, total: 3, cases: [] }, staticAnalysis: { functions: [], issues: [] }, aiReview: { assessmentError: false } } as unknown as FeedbackReport,
  }) as unknown as Revision;

describe('a blank contract line is not an Open thread on a passed review', () => {
  it('the demo\'s passed PR-6: no thread, and the Conversation says there is none', () => {
    const threads = prThreads('maintenance', revision(true, DEMO), []);
    expect(threads).toEqual([]);
    const html = renderToStaticMarkup(<Conversation threads={threads} phaseKey="maintenance" showMentor={false} />);
    expect(html).toContain('No thread on this submission');
    expect(html).not.toContain('Errors. Boundary.');
    expect(html).not.toContain('Which do you want');
  });

  it('the ledger the Checks tab draws still holds isOverdue, unclaimed', () => {
    expect(buildLedger(DEMO).map((g) => [g.name, g.verdict])).toEqual([['isOverdue', 'unclaimed']]);
  });

  it('the same ledger on a review that did not pass: the contract thread, Open', () => {
    const threads = prThreads('maintenance', revision(false, DEMO), []);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ key: 'contract:isOverdue', state: 'open', message: 'Errors. Boundary.', severity: 'warning',
      ask: 'Which do you want: the contract changed, or the code? Say which in the merge message.' });
  });

  it('a line the design claimed and the code breaks, on a passed review: the contract thread, with every line', () => {
    const broken = [...DEMO.slice(0, 2), claim({ claim: 'ordering', text: 'Due today is not overdue.', verdict: 'broken' }), ...DEMO.slice(2)];
    const threads = prThreads('maintenance', revision(true, broken), []);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ state: 'open', severity: 'error', message: 'Ordering. Due today is not overdue. Errors. Boundary.' });
  });

  it('a line the design wrote that nothing in the run bore on (unclaimed, with its text), on a passed review: the contract thread', () => {
    const written = [claim({ claim: 'errors', text: '404 task_not_found', verdict: 'unclaimed' })];
    const threads = prThreads('maintenance', revision(true, written), []);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ state: 'open', message: 'Errors. 404 task_not_found.' });
  });

  it('the rule is any line the design left blank, not only an optional one: a blank Inputs line on a passed review is no thread either', () => {
    const blankInputs = [claim({ claim: 'inputs', text: '', verdict: 'unclaimed' }), ...DEMO.slice(1)];
    expect(prThreads('maintenance', revision(true, blankInputs), [])).toEqual([]);
    // and on a review that did not pass it is a thread, every blank line in it
    const threads = prThreads('maintenance', revision(false, blankInputs), []);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ state: 'open', message: 'Inputs. Errors. Boundary.' });
  });
});
