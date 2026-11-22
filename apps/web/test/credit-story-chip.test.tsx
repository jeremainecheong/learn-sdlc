// @vitest-environment jsdom
/**
 * The teacher's Mark as passed over a
 * story whose review came back Needs revision. The gate band already said
 * "Credit awarded, review still needed"; the other places in the learner's
 * rooms that name a task's or a story's state now say the same, from the same
 * source (the gate's `evidenceNeeded`), and a reviewed pass still reads as one.
 * Nothing here changes what any gate decides.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MatrixView } from '@/components/workspace/panels/testing/lib';
import type { PhaseDetail } from '@learnsdlc/shared';
import { STATE_LABEL, isCredited, learnerState } from '@/components/workspace/gate-state';
import { CREDIT_AWARDED, changeRoomChip } from '@/components/workspace/signoff-status';
import { storyStatusLabel } from '@/components/workspace/requirements/RequirementsWorkspace';
import { MatrixCard } from '@/components/workspace/panels/testing/MatrixDoc';

const FAILED = { status: 'completed', passed: false } as const;
const gap = (key: string) => ({ key, title: 'The task' });

describe('isCredited: the one reading of credit, from the gate band\'s source', () => {
  it('a passed phase whose evidenceNeeded names the task is credit; one it does not name is a reviewed pass', () => {
    const phase = { status: 'passed', key: 'requirements', evidenceNeeded: [gap('story')] };
    expect(isCredited('p', phase, 'story')).toBe(true);
    expect(isCredited('p', phase, 'concepts')).toBe(false);
  });

  it('with no task key, the phase\'s one task: credit exactly where the band says so', () => {
    const phase = { status: 'passed', key: 'requirements', evidenceNeeded: [gap('')] };
    expect(isCredited('p', phase)).toBe(true);
    expect(learnerState('p', phase)).toBe('credited');
    expect(isCredited('p', { status: 'passed', key: 'requirements' })).toBe(false);
  });

  it('never on a phase that has not passed, and a gap in another phase is not this one\'s', () => {
    expect(isCredited('p', { status: 'submitted', evidenceNeeded: [gap('story')] }, 'story')).toBe(false);
    expect(isCredited('p', { status: 'passed', key: 'maintenance', evidenceNeeded: [{ ...gap('story'), phaseId: 'other' }] }, 'story')).toBe(false);
    expect(isCredited('p', null)).toBe(false);
  });

  it('the credit words are the band\'s', () => {
    expect(CREDIT_AWARDED).toBe('Credit awarded, review still needed');
    expect(STATE_LABEL.credited).toBe(CREDIT_AWARDED);
  });
});

describe('the story chip (storyStatusLabel) with credit', () => {
  it('credited after a Needs revision: credit, never Approved or Review passed', () => {
    expect(storyStatusLabel('passed', FAILED, false, true)).toBe(CREDIT_AWARDED);
    expect(storyStatusLabel('passed', null, false, true)).toBe(CREDIT_AWARDED);
  });

  it('a reviewed pass reads in the state words, Review passed', () => {
    expect(storyStatusLabel('passed', { status: 'completed', passed: true }, false, false, true)).toBe('Review passed');
    expect(storyStatusLabel('passed', null, undefined, undefined, true)).toBe('Review passed');
  });

  it('a story passed in a phase that has not passed (a per-task sign-off) is Passed, never Review passed', () => {
    expect(storyStatusLabel('passed', FAILED, false, false, false)).toBe('Passed');
    expect(storyStatusLabel('passed', { status: 'completed', passed: true }, false, false, false)).toBe('Passed');
    expect(storyStatusLabel('passed', null)).toBe('Passed');
    for (const latest of [FAILED, null, { status: 'completed', passed: true } as const]) {
      expect(storyStatusLabel('passed', latest, false, false, false)).not.toBe('Review passed');
    }
    // Credit still wins on a passed phase.
    expect(storyStatusLabel('passed', FAILED, false, true, true)).toBe(CREDIT_AWARDED);
  });

  it('credit says nothing about a story that has not passed', () => {
    expect(storyStatusLabel('submitted', FAILED, false, true)).toBe('Needs revision');
    expect(storyStatusLabel('in_progress', null, false, true)).toBe('In progress');
  });
});

describe('the change room\'s verdict chip with credit', () => {
  it('credited: the credit words in the warn tone', () => {
    expect(changeRoomChip({ status: 'passed', attempts: 1 }, true)).toEqual({ label: CREDIT_AWARDED, tone: 'warn' });
  });
  it('without credit: Pass on a pass, Needs revision on a refused revision', () => {
    expect(changeRoomChip({ status: 'passed', attempts: 1 })).toEqual({ label: 'Pass', tone: 'pass' });
    expect(changeRoomChip({ status: 'in_progress', attempts: 1 }, true)).toEqual({ label: 'Needs revision', tone: 'accent' });
  });
});

describe('Testing\'s planted-bug page chip with credit', () => {
  const view: MatrixView = { rows: [], columns: [], killed: 0, total: 0, unrun: false } as unknown as MatrixView;
  const detail = (over: Partial<PhaseDetail> = {}) =>
    ({ id: 'testing-1', key: 'testing', status: 'passed', tasks: [], runClock: null, ...over }) as unknown as PhaseDetail;

  it('credited: the credit words, not Pass', () => {
    const html = renderToStaticMarkup(<MatrixCard view={view} detail={detail({ evidenceNeeded: [gap('')] } as Partial<PhaseDetail>)} />);
    expect(html).toContain(CREDIT_AWARDED);
    expect(html).not.toMatch(/>Pass</);
  });

  it('a reviewed pass still reads Pass', () => {
    const html = renderToStaticMarkup(<MatrixCard view={view} detail={detail()} />);
    expect(html).toMatch(/>Pass</);
    expect(html).not.toContain(CREDIT_AWARDED);
  });
});
