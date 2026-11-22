// @vitest-environment jsdom
/**
 * A score's threshold is called the pass mark, as the project editor's
 * "Pass mark" field and the quiz room call it, wherever Home and the
 * teacher's panels named it a "gate". The regrade's receipt counts learners
 * whose phase now reads passed (the API's `newPasses`), which is not a score
 * threshold, so it names the phase instead.
 *
 * The phase's own gate (a phase opens when the one before it is passed) keeps
 * its word: "Submit Testing for the gate" is pinned elsewhere
 * (bell-countersign-plan.test.ts, e2e/signoff-chip-a11y.spec.ts).
 */
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moduleText } from './support/source-text';
import type { RegradeBatchView } from '@learnsdlc/shared';
import { buildNextSteps } from '@/components/home/derive';
import { report, sample, submission } from './fixtures';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), start: vi.fn(), status: vi.fn() }));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: { regradePreview: mocks.preview, regradeStart: mocks.start, regradeStatus: mocks.status },
}));
import { RegradePanel } from '@/components/staff/RegradePanel';

describe('Home', () => {
  it('the step for a failed verdict reads "Bring Testing up to the pass mark", with "pass mark" in its detail', () => {
    const { enrollment, details } = sample();
    const current = enrollment.phases[3];
    const marked = {
      ...details,
      p4: {
        ...details.p4,
        lastSubmission: submission({
          status: 'completed',
          passed: false,
          report: report({
            overall: 62,
            passThreshold: 70,
            criteria: [{ key: 'a', title: 'Kill the mutants', score: 40, weight: 1, evidence: [] }],
            checks: [],
            aiReview: { summary: '', points: [], improvements: [] },
          } as never),
        }),
      },
    };
    const step = buildNextSteps(enrollment, marked, current).steps[0];
    expect(step.key).toBe('gate');
    expect(step.title).toBe('Bring Testing up to the pass mark');
    expect(step.detail).toBe('Scored 62, pass mark 70, on submission 1.');
  });

  it('a phase with nothing submitted still says "Submit <Phase> for the gate": the phase gate keeps its word', () => {
    const { enrollment, details } = sample();
    const current = enrollment.phases[3];
    const plan = buildNextSteps(enrollment, { ...details, p4: { ...details.p4, lastSubmission: null } }, current);
    expect(plan.steps.at(-1)!.title).toBe('Submit Testing for the gate');
  });

  it('no score threshold on Home is called a gate in the source', () => {
    const source = moduleText('buildNextSteps');
    expect(source).not.toMatch(/, gate \$\{/);
    expect(source).not.toContain('Below the gate');
  });
});

/**
 * A review can refuse work that scored at or above the pass mark: below 100
 * a "needs revision" refuses at any score, and a review that could not be done
 * refuses too. The bell's title says "up to the pass mark" only when the score
 * is below it; otherwise it names the phase's gate. The
 * detail states the facts in every case.
 */
describe('a refused review, by its score', () => {
  const refused = (overall: number, extra: Record<string, unknown> = {}) => {
    const { enrollment, details } = sample();
    const marked = {
      ...details,
      p4: {
        ...details.p4,
        lastSubmission: submission({
          status: 'completed',
          passed: false,
          report: report({
            overall,
            passThreshold: 70,
            criteria: [{ key: 'a', title: 'Kill the mutants', score: 40, weight: 1, evidence: [] }],
            checks: [],
            aiReview: { summary: '', points: [], improvements: [], ...extra },
          } as never),
        }),
      },
    };
    return { step: buildNextSteps(enrollment, marked, enrollment.phases[3]).steps[0] };
  };

  it('at 62, below the pass mark of 70: "up to the pass mark"', () => {
    const { step } = refused(62);
    expect(step.title).toBe('Bring Testing up to the pass mark');
    expect(step.detail).toBe('Scored 62, pass mark 70, on submission 1.');
  });

  it('at exactly the pass mark, refused: the gate, not "up to the pass mark"', () => {
    const { step } = refused(70);
    expect(step.key).toBe('gate');
    expect(step.title).toBe('Bring Testing up to the gate');
    expect(step.title).not.toContain('pass mark');
    expect(step.detail).toBe('Scored 70, pass mark 70, on submission 1.');
  });

  it('at 85, needs revision: the gate, not "up to the pass mark"', () => {
    const { step } = refused(85);
    expect(step.title).toBe('Bring Testing up to the gate');
    expect(step.detail).toBe('Scored 85, pass mark 70, on submission 1.');
  });

  it('a review that could not be done: the gate at any score, not "up to the pass mark"', () => {
    for (const overall of [100, 40]) {
      const { step } = refused(overall, { assessmentError: 'The review could not be completed.' });
      expect(step.title, String(overall)).toBe('Bring Testing up to the gate');
      expect(step.detail, String(overall)).toBe(`Scored ${overall}, pass mark 70, on submission 1.`);
    }
  });
});

describe("the teacher's panels", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    localStorage.clear();
  });

  const finished = (newPasses: number): RegradeBatchView => ({
    id: 'batch-1',
    status: 'finished',
    projectSlug: 'tasktrackr',
    phaseKey: 'requirements',
    scope: 'everyone',
    reason: 'the boundary test was wrong',
    packVersionTo: '2',
    requested: 3,
    done: 3,
    failed: 0,
    newPasses,
    skipped: [],
    createdAt: '2026-11-18T00:00:00.000Z',
    finishedAt: '2026-11-18T00:02:00.000Z',
  });

  const showFinished = async (newPasses: number) => {
    localStorage.setItem('lsdlc_regrade_tasktrackr', 'batch-1');
    mocks.status.mockResolvedValue(finished(newPasses));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<RegradePanel projectSlug="tasktrackr" phases={[{ key: 'requirements', title: 'Requirements' }]} />);
    });
    return host.querySelector('[data-testid="regrade-done"]')?.textContent ?? '';
  };

  it('the regrade receipt names the phase, not a gate, when nobody newly passes', async () => {
    const text = await showFinished(0);
    expect(text).toContain('Regrade finished. 3 revisions were graded on pack 2. Nobody passes Requirements who did not pass it before.');
    expect(text).toContain("Nobody's pass was withdrawn.");
    expect(text).not.toContain('gate');
  });

  it('the regrade receipt counts the learners who now pass the phase', async () => {
    expect(await showFinished(1)).toContain('1 learner now passes Requirements who did not before.');
  });

  it('and counts more than one', async () => {
    expect(await showFinished(2)).toContain('2 learners now pass Requirements who did not before.');
  });
});
