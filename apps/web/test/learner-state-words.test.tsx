// @vitest-environment jsdom
/**
 * The learner's state words, the task rows
 * that use them, the one-line quick check, the Tests tab's summary line and
 * the split's arithmetic.
 *
 * The words are labels only; nothing here reads the gate differently from
 * the rooms that already did. A credited task is the one the API's own
 * `evidenceNeeded` names, which is the same source the gate band reads.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseTaskView, RunResult } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({ status: vi.fn(), pathname: '/workspace/p1' }));
vi.mock('next/navigation', () => ({ usePathname: () => rig.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api-concept', async (original) => ({
  ...(await original<typeof import('@/lib/api-concept')>()),
  conceptApi: { status: rig.status },
}));

import { CREDIT_EXPLANATION, STATE_LABEL, creditedTaskKeys, learnerState, phasePlace } from '@/components/workspace/gate-state';
import { TaskPanel, taskCountLine } from '@/components/workspace/TaskPanel';
import { QuickCheckLine, QuickCheckProvider, quickCheckSentence, useClaimedQuickCheck } from '@/components/workspace/QuickCheck';
import { TestingRunEvidence, testsSummaryLine } from '@/components/workspace/TestingRunEvidence';
import { EDITOR_MIN, RESULTS_BAR, RESULTS_MIN, isShortArea, splitFor } from '@/components/workspace/useResultsSplit';
import { PhaseGateBanner, ReviewBand } from '@/components/workspace/PhaseGateBanner';

/** Static markup with its apostrophes read back, so the copy is compared as written. */
const markup = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/&#x27;/g, "'");

const task = (over: Partial<PhaseTaskView> = {}): PhaseTaskView => ({
  key: 'main', order: 1, required: true, title: 'The repository', artefactType: 'code', evidence: 'reviewed', sealed: true,
  status: 'in_progress', awaitingSignOff: false, attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null,
  solution: { available: false, files: 0, readAt: null } as PhaseTaskView['solution'],
  ...over,
});

describe('one vocabulary for the learner states', () => {
  it('names the six states in the agreed words', () => {
    expect(STATE_LABEL).toEqual({
      reviewPassed: 'Review passed',
      credited: 'Credit awarded, review still needed',
      awaiting: "Awaiting your teacher's sign-off",
      ready: 'Ready to continue',
      revise: 'Needs revision',
      inProgress: 'In progress',
    });
    expect(CREDIT_EXPLANATION).toBe('Passed on the board, not yet reviewed');
  });

  it('reads each state from the gate the API already answers', () => {
    expect(learnerState('p', { status: 'passed' })).toBe('ready');
    expect(learnerState('p', { status: 'passed', evidenceNeeded: [{ key: '', title: 'Testing' }] })).toBe('credited');
    expect(learnerState('p', { status: 'passed', notReachedYet: true })).toBe('reviewPassed');
    // A gap in another phase (the completion arm) holds Continue but is not this phase's credit.
    expect(learnerState('p', { status: 'passed', key: 'maintenance', evidenceNeeded: [{ key: '', title: 'Design', phaseId: 'other', phaseKey: 'design' }] })).toBe('reviewPassed');
    expect(learnerState('p', { status: 'submitted' }, { awaiting: true })).toBe('awaiting');
    // On a passed phase the gate decides, not the room's reading of a sign-off.
    expect(learnerState('p', { status: 'passed' }, { awaiting: true })).toBe('ready');
    expect(learnerState('p', { status: 'passed', evidenceNeeded: [{ key: '', title: 'Testing' }] }, { awaiting: true })).toBe('credited');
    expect(learnerState('p', { status: 'in_progress' }, { verdict: { status: 'completed', passed: false } })).toBe('revise');
    expect(learnerState('p', { status: 'in_progress' }, { verdict: { status: 'running' } })).toBe('inProgress');
    // A task passed on the board in a phase still in progress may be the
    // teacher's per-task sign-off, with no review behind it: never "Review passed".
    expect(learnerState('p', { status: 'in_progress' }, { task: { key: 'a', status: 'passed' } })).toBe('inProgress');
    expect(learnerState('p', { status: 'in_progress' }, { task: { key: 'a', status: 'submitted' } })).toBe('revise');
    expect(learnerState('p', { status: 'in_progress' })).toBe('inProgress');
  });

  it('credits only this phase’s tasks', () => {
    const keys = creditedTaskKeys('p', {
      status: 'passed',
      key: 'testing',
      evidenceNeeded: [{ key: 'suite', title: 'Suite' }, { key: 'x', title: 'Elsewhere', phaseId: 'q' }],
    });
    expect([...keys]).toEqual(['suite']);
  });

  it('says "Phase n of m" from the place and count the detail carries', () => {
    expect(phasePlace(4, 6)).toBe('Phase 4 of 6');
    expect(phasePlace(undefined, 6)).toBeNull();
  });
});

describe('the task rows agree with the band', () => {
  const phase = (evidenceNeeded?: { key: string; title: string }[]) => ({
    id: 'p', key: 'testing' as const, status: 'passed' as const, lastSubmission: null, evidenceNeeded,
  });
  const rows = (html: string) => html;

  it('a credited task reads "Credit awarded, review still needed", in the waiting tone, with no Best score', () => {
    const html = markup(
      <TaskPanel
        tasks={[task({ key: 'suite', status: 'passed', bestScore: 100 }), task({ key: 'quiz', order: 2, required: false, artefactType: 'quiz', status: 'passed', bestScore: 80 })]}
        phase={phase([{ key: 'suite', title: 'Suite' }])}
        selected={null}
      />,
    );
    expect(rows(html)).toContain('Credit awarded, review still needed');
    expect(html).toMatch(/chip-warn[^>]*>Credit awarded, review still needed/);
    expect(html).not.toContain('Best 100');
    // The quiz keeps its own word and its paper's mark.
    expect(html).toContain('Best 80');
  });

  it('a reviewed pass reads "Review passed"; a countersignature reads the sign-off words', () => {
    const html = markup(
      <TaskPanel
        tasks={[task({ key: 'a', status: 'passed', bestScore: 90 }), task({ key: 'b', order: 2, status: 'submitted', awaitingSignOff: true })]}
        phase={phase()}
        selected={null}
      />,
    );
    expect(html).toContain('Review passed');
    expect(html).toContain('Best 90');
    expect(html).toContain("Awaiting your teacher's sign-off");
    expect(html).not.toContain('Credit awarded');
  });

  it('a split phase still in progress: a task the teacher signed off reads "Passed", never "Review passed", and the chip says In progress', () => {
    // The API serves `evidenceNeeded` only for a passed phase, so the per-task
    // sign-off lever leaves nothing on the payload that tells it from a review.
    const open = { id: 'p', key: 'implementation' as const, status: 'in_progress' as const, lastSubmission: null };
    const signedOff = task({ key: 'api', status: 'passed', attempts: 1, bestScore: 70 });
    const html = markup(
      <TaskPanel
        tasks={[signedOff, task({ key: 'ui', order: 2, title: 'The screens', status: 'in_progress' })]}
        phase={open}
        selected={null}
      />,
    );
    expect(html).toMatch(/chip-pass[^>]*>Passed</);
    expect(html).not.toContain('Review passed');
    expect(html).not.toContain('Credit awarded');
    // The sign-off over a failed verdict is neither a review nor a refusal.
    for (const verdict of [null, { status: 'completed', passed: false }, { status: 'completed', passed: true }]) {
      const state = learnerState('p', open, { task: signedOff, verdict });
      expect(state).toBe('inProgress');
      expect(STATE_LABEL[state]).toBe('In progress');
    }
    // Once the phase itself has passed, the gate's answer is held and the row says so.
    const passed = markup(<TaskPanel tasks={[signedOff, task({ key: 'ui', order: 2, status: 'passed' })]} phase={{ ...open, status: 'passed' }} selected={null} />);
    expect(passed).toContain('Review passed');
  });

  it('counts required work and optional tasks as two separate facts', () => {
    expect(taskCountLine({ total: 3, required: 2, passed: 2, passedRequired: 1 })).toBe('1 of 2 required done. Optional: 1 of 1 done');
    expect(taskCountLine({ total: 2, required: 2, passed: 1, passedRequired: 1 })).toBe('1 of 2 required done');
  });
});

describe('the gate band is one slim strip in the same words', () => {
  it('a passed phase: "Ready to continue", its sentence, View review and Continue together', () => {
    const html = markup(
      <PhaseGateBanner phaseId="p" phase={{ status: 'passed', title: 'Testing', order: 4, bestScore: 100, reflection: null }} isLast={false} onViewReview={() => {}} />,
    );
    expect(html).toContain('Ready to continue.');
    expect(html).toContain('Phase evidence accepted.');
    expect(html).toContain('data-testid="gate-view-review"');
    expect(html).toContain('Continue to next phase');
  });

  it('credit awarded: the label, then the pass sentence as its explanation; the room’s own Submit is not repeated', () => {
    const html = markup(
      <PhaseGateBanner
        phaseId="p"
        phase={{ status: 'passed', key: 'testing', title: 'Testing', order: 4, bestScore: 100, reflection: null, evidenceNeeded: [{ key: '', title: 'Testing' }] }}
        isLast={false}
        roomTaskKey=""
      />,
    );
    expect(html).toContain('Credit awarded, review still needed');
    expect(html).toContain('Passed on the board, not yet reviewed.');
    expect(html).not.toContain('gate-evidence-submit-phase');
    expect(html).not.toContain('Continue to next phase');
  });

  it('a phase marked passed ahead of time does not repeat the header\'s Submit either', () => {
    // A split phase the teacher passed ahead of the learner, two tasks without a
    // reviewed pass: the room's own task (its Submit is the header's) and
    // another task worked in the same room by ?task=.
    const ahead = {
      status: 'passed' as const, key: 'testing' as const, title: 'Testing', order: 4, bestScore: 100, reflection: null, notReachedYet: true as const,
      evidenceNeeded: [{ key: 'unit', title: 'Unit tests' }, { key: 'edge', title: 'Edge cases' }],
    };
    const withHeader = markup(<PhaseGateBanner phaseId="p" phase={ahead} isLast={false} roomTaskKey="unit" />);
    expect(withHeader).toContain('Marked passed ahead of time');
    expect(withHeader).not.toContain('gate-evidence-submit-unit');
    expect(withHeader).toContain('gate-evidence-submit-edge');
    // The sentence still names both, and says to submit both.
    expect(withHeader).toContain('Unit tests and Edge cases');
    // Where the header does not lead with Submit, the band keeps every door.
    const without = markup(<PhaseGateBanner phaseId="p" phase={ahead} isLast={false} />);
    expect(without).toContain('gate-evidence-submit-unit');
    expect(without).toContain('gate-evidence-submit-edge');
    // A one-task phase: the gap is the phase itself (key ''), the header's door.
    const single = markup(<PhaseGateBanner phaseId="p" phase={{ ...ahead, evidenceNeeded: [{ key: '', title: 'Testing' }] }} isLast={false} roomTaskKey="" />);
    expect(single).not.toContain('gate-evidence-submit-phase');
    expect(single).toContain('Marked passed ahead of time');
  });

  it('needs revision and awaiting sign-off bands say so and offer View review only', () => {
    const revise = markup(<ReviewBand state="revise" onViewReview={() => {}} />);
    expect(revise).toContain('Needs revision.');
    expect(revise).toContain('View review');
    const awaiting = markup(<ReviewBand state="awaiting" />);
    expect(awaiting).toContain("Awaiting your teacher's sign-off.");
    expect(awaiting).not.toContain('View review');
    expect(awaiting).not.toContain('Continue');
  });
});

describe('the quick check is one optional line', () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    rig.status.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('says it is optional and not graded: "Optional" as its label, the rest in one sentence', () => {
    expect(quickCheckSentence(6)).toBe('6 questions, not graded.');
    expect(quickCheckSentence(1)).toBe('1 question, not graded.');
    expect(quickCheckSentence(0)).toBe('Not graded.');
    const html = markup(<QuickCheckLine offer={{ phaseId: 'p1', kind: 'after', questions: 6, putAway: () => {} }} />);
    expect(html).toContain('What did you learn?');
    expect(html).toContain('6 questions, not graded.');
    // "Optional" is the line's label, before its title, outside the sentence the
    // header hides first, so it reads as optional at every width.
    expect(html).toMatch(/data-testid="concept-prompt-optional"[^>]*>Optional<\/span> <strong data-testid="concept-prompt-title">/);
    expect(html).toContain('Take the quick check');
    expect(html).toContain('Later');
    // Optional in look as in words: the start is not the room's primary button.
    expect(html).toMatch(/class="btn-secondary[^"]*"[^>]*data-testid="concept-prompt-start"|data-testid="concept-prompt-start"[^>]*class="btn-secondary/);
  });

  it('the layout draws the line until a room claims it, and Later puts it away for the visit', async () => {
    rig.status.mockResolvedValue({ phaseKey: 'testing', before: { status: 'taken', questionCount: 6 }, after: { status: 'open', questionCount: 6 } });
    function Claimer() {
      const offer = useClaimedQuickCheck();
      return <div data-testid="claimed"><QuickCheckLine offer={offer} inline /></div>;
    }
    await act(async () => {
      root.render(<QuickCheckProvider phaseId="p1" phaseStatus="passed"><p>room</p></QuickCheckProvider>);
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelectorAll('[data-testid="concept-prompt"]')).toHaveLength(1);
    expect(host.textContent).toContain('Optional What did you learn? 6 questions, not graded.');

    await act(async () => {
      root.render(<QuickCheckProvider phaseId="p1" phaseStatus="passed"><Claimer /></QuickCheckProvider>);
    });
    await act(async () => { await Promise.resolve(); });
    const lines = host.querySelectorAll('[data-testid="concept-prompt"]');
    expect(lines).toHaveLength(1);
    expect(lines[0].closest('[data-testid="claimed"]')).not.toBeNull();
    expect(lines[0].className).toContain('quick-check-line-inline');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="concept-prompt-skip"]')!.click();
    });
    expect(host.querySelector('[data-testid="concept-prompt"]')).toBeNull();
  });

  it('offers nothing on the check’s own page', async () => {
    rig.pathname = '/workspace/p1/concept';
    rig.status.mockResolvedValue({ phaseKey: 'testing', before: { status: 'open', questionCount: 6 }, after: { status: 'locked', questionCount: 6 } });
    await act(async () => {
      root.render(<QuickCheckProvider phaseId="p1" enabled={false}><p>room</p></QuickCheckProvider>);
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="concept-prompt"]')).toBeNull();
    rig.pathname = '/workspace/p1';
  });
});

describe('the Tests tab leads with one summary line, failures first', () => {
  const result = (statuses: ('passed' | 'failed')[]): RunResult => ({
    ok: statuses.every((s) => s === 'passed'), exitKind: 'ok', stdout: '', stderr: '', durationMs: 12,
    tests: {
      total: statuses.length,
      passed: statuses.filter((s) => s === 'passed').length,
      failed: statuses.filter((s) => s !== 'passed').length,
      cases: statuses.map((status, i) => ({ name: `test_case_number_${i}_with_a_rather_long_descriptive_name`, status })),
    },
  } as unknown as RunResult);

  it('says "11 of 11 passed", or "2 of 11 failed, failures first"', () => {
    expect(testsSummaryLine(Array.from({ length: 11 }, () => ({ status: 'passed' as const })))).toBe('11 of 11 passed');
    expect(testsSummaryLine([...Array.from({ length: 9 }, () => ({ status: 'passed' as const })), { status: 'failed' }, { status: 'errored' }])).toBe('2 of 11 failed, failures first');
    expect(testsSummaryLine([])).toBe('No test cases reported');
  });

  it('draws the line above the tree, lists the failures first and keeps each full name', () => {
    const html = markup(<TestingRunEvidence result={result(['passed', 'failed', 'passed'])} />);
    expect(html).toContain('data-testid="tests-summary-line"');
    expect(html).toContain('1 of 3 failed, failures first');
    expect(html.indexOf('tests-summary-line')).toBeLessThan(html.indexOf('testing-suite-tree'));
    const order = [...html.matchAll(/title="(test_case_number_\d)/g)].map((m) => m[1]);
    expect(order).toEqual(['test_case_number_1', 'test_case_number_0', 'test_case_number_2']);
  });
});

describe('the split keeps a floor for the editor and for the results', () => {
  it('clamps the results between their floor and what leaves the editor its own', () => {
    expect(splitFor(800, 100)).toEqual({ results: RESULTS_MIN, collapsed: false, measured: true });
    expect(splitFor(800, 700)).toEqual({ results: 800 - EDITOR_MIN, collapsed: false, measured: true });
    expect(splitFor(500, 220)).toEqual({ results: 220, collapsed: false, measured: true });
  });

  it('folds the results to their tab bar when both floors cannot fit', () => {
    expect(splitFor(EDITOR_MIN + RESULTS_MIN - 1, 220)).toEqual({ results: RESULTS_BAR, collapsed: true, measured: true });
  });

  it('is unmeasured, and changes nothing, before the column has a height', () => {
    expect(splitFor(0, 220)).toEqual({ results: 220, collapsed: false, measured: false });
  });

  it('opens the focused mode under 520 px of pane area, never before a measurement', () => {
    expect(isShortArea(519)).toBe(true);
    expect(isShortArea(520)).toBe(false);
    expect(isShortArea(0)).toBe(false);
  });
});
