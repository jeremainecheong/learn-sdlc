// @vitest-environment jsdom
/**
 * The review's wait.
 *
 * While a submission is queued or running the learner sees the fixed words for
 * what the review runs, for its checks kind, beside the time since the server
 * recorded the submission. The server reports only `queued` and `running`, so
 * the list is the work involved and nothing on it is ever marked done; there is
 * no percentage and no estimate. A typical-wait line is drawn only from a
 * measured value handed in, and no call site hands one in until a live read
 * has measured it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionView } from '@learnsdlc/shared';

const mocks = vi.hoisted(() => ({ evidence: vi.fn(), notes: vi.fn() }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherFeedback: mocks.notes, teacherEvidence: mocks.evidence } }));
vi.mock('@/lib/api', async original => ({ ...(await original<typeof import('@/lib/api')>()), api: { getSubmissionWithFiles: mocks.evidence } }));

import { REVIEW_STEPS, ReviewSteps, elapsedWords, reviewStepsFor } from '@/components/workspace/ReviewSteps';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { SubmissionEvidence } from '@/components/experience/SubmissionEvidence';

let host: HTMLDivElement;
let root: Root;
const NOW = Date.parse('2026-10-25T10:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.notes.mockResolvedValue([]);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const draw = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const items = () => [...host.querySelectorAll('[data-testid="review-steps"] li')].map(li => li.textContent);
const elapsed = () => host.querySelector('[data-testid="review-elapsed"]')?.textContent;

const KINDS = [
  ['code', ['Running your visible tests', 'Running the hidden tests', 'AI review']],
  ['tests', ['Running your suite on the reference', 'Running it against the planted bugs', 'AI review']],
  ['config', ['Checking the configuration', 'Running the smoke test', 'AI review']],
  ['story', ['Checking the record', 'AI review']],
  ['design', ['Checking the record', 'AI review']],
] as const;

describe('the review step list', () => {
  it.each(KINDS)('the review shows the step words for its checks kind (%s)', async (kind, words) => {
    expect(REVIEW_STEPS[kind]).toEqual(words);
    expect(reviewStepsFor(kind)).toEqual(words);
    await draw(<ReviewSteps kind={kind} status="running" since={ago(12)} />);
    expect(items()).toEqual(words);
  });

  it('draws the steps as one unordered group under "While the review runs:", with no numbering (the runs overlap)', async () => {
    for (const [kind, words] of KINDS) {
      await draw(<ReviewSteps kind={kind} status="running" since={ago(6)} />);
      const box = host.querySelector('[data-testid="review-steps"]')!;
      expect(box.querySelector('ol')).toBeNull();
      const list = box.querySelector('ul')!;
      expect(list).not.toBeNull();
      expect(list.className).not.toMatch(/decimal|list-\[?(decimal|numeric)/);
      expect(host.querySelector('[data-testid="review-steps-lead"]')?.textContent).toBe('While the review runs:');
      expect(list.getAttribute('aria-labelledby')).toBe(host.querySelector('[data-testid="review-steps-lead"]')!.id);
      expect([...list.children].map(li => li.textContent)).toEqual(words);
      // No step is numbered or put first in words.
      expect(list.textContent).not.toMatch(/\b(first|then|next|after|finally|step)\b|\d\./i);
    }
  });

  it('the Testing words name no count of planted bugs (TaskTrackr 6.0.0 plants eight, the starter and Shelf four)', () => {
    expect(REVIEW_STEPS.tests).toContain('Running it against the planted bugs');
    expect(Object.values(REVIEW_STEPS).flat().join(' ')).not.toMatch(/\d|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  });

  it.each(['failed', 'completed'] as const)('runs no clock once the review is %s (nothing drawn, no timer left)', async status => {
    await draw(<ReviewSteps kind="story" status={status} since={ago(8)} />);
    expect(host.querySelector('[data-testid="review-steps"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // A review back in flight starts the clock again, and leaving it stops it.
    await draw(<ReviewSteps kind="story" status="running" since={ago(8)} />);
    expect(vi.getTimerCount()).toBe(1);
    await draw(<ReviewSteps kind="story" status={status} since={ago(8)} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('draws no list for a kind with no fixed words, and keeps the elapsed time', async () => {
    expect(reviewStepsFor('quiz')).toBeNull();
    expect(reviewStepsFor(undefined)).toBeNull();
    await draw(<ReviewSteps kind="quiz" status="running" since={ago(3)} />);
    expect(host.querySelector('[data-testid="review-steps"] ul, [data-testid="review-steps"] ol')).toBeNull();
    expect(elapsed()).toBe('Running for 3 s');
  });

  it.each(['queued', 'running'] as const)('no step shows done while status is %s', async status => {
    for (const [kind] of KINDS) {
      await draw(<ReviewSteps kind={kind} status={status} since={ago(20)} />);
      const list = [...host.querySelectorAll('[data-testid="review-steps"] li')];
      expect(list.length).toBeGreaterThan(0);
      // One markup for every step: nothing separates a finished one from the rest.
      expect(new Set(list.map(li => li.className)).size).toBe(1);
      for (const li of list) {
        expect(li.attributes.length).toBe(li.hasAttribute('class') ? 1 : 0);
        expect(li.querySelector('svg, input, [aria-checked], [data-state]')).toBeNull();
      }
      expect(host.textContent).not.toMatch(/\bdone\b|complete|finished|✓|✔/i);
      expect(host.querySelector('[aria-checked], [aria-current], [data-done]')).toBeNull();
    }
  });

  it('no percentage and no estimate is rendered', async () => {
    for (const [kind] of KINDS) for (const status of ['queued', 'running'] as const) {
      await draw(<ReviewSteps kind={kind} status={status} since={ago(42)} />);
      expect(host.textContent).not.toContain('%');
      expect(host.textContent).not.toMatch(/about|usually|remaining|\bleft\b|estimate|nearly|almost/i);
      expect(host.querySelector('progress, [role="progressbar"], [aria-valuenow]')).toBeNull();
      expect(host.querySelector('[data-testid="review-typical"]')).toBeNull();
    }
  });

  it('a typical-wait line renders only when a measured value is passed', async () => {
    for (const typicalSeconds of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await draw(<ReviewSteps kind="tests" status="running" since={ago(5)} typicalSeconds={typicalSeconds} />);
      expect(host.querySelector('[data-testid="review-typical"]')).toBeNull();
      expect(host.textContent).not.toMatch(/usually/i);
    }
    await draw(<ReviewSteps kind="tests" status="running" since={ago(5)} typicalSeconds={31.6} />);
    expect(host.querySelector('[data-testid="review-typical"]')?.textContent).toBe('Usually about 32 s.');
  });

  it('no call site passes a typical-wait value until one is measured', () => {
    const web = resolve(__dirname, '..');
    const sources = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(entry) ? [full] : [];
    });
    const callers = [...sources(join(web, 'app')), ...sources(join(web, 'components'))]
      .filter(file => /typicalSeconds=\{/.test(readFileSync(file, 'utf8')));
    expect(callers).toEqual([]);
  });

  it('counts the elapsed time from the server-recorded submission time', async () => {
    await draw(<ReviewSteps kind="code" status="queued" since={ago(4)} />);
    expect(elapsed()).toBe('Queued for 4 s');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(elapsed()).toBe('Queued for 7 s');
    await draw(<ReviewSteps kind="code" status="running" since={ago(4)} />);
    expect(elapsed()).toBe('Running for 7 s');
    // A clock behind the server's never shows a negative wait.
    await draw(<ReviewSteps kind="code" status="running" since={new Date(NOW + 60_000).toISOString()} />);
    expect(elapsed()).toBe('Running for 0 s');
    // An unreadable time draws the status word alone, never an invented figure.
    await draw(<ReviewSteps kind="code" status="running" since="not a time" />);
    expect(elapsed()).toBe('Running');
  });

  it('words the elapsed time plainly', () => {
    expect(elapsedWords(0)).toBe('0 s');
    expect(elapsedWords(59_999)).toBe('59 s');
    expect(elapsedWords(60_000)).toBe('1 min 0 s');
    expect(elapsedWords(125_400)).toBe('2 min 5 s');
    expect(elapsedWords(3_600_000)).toBe('over an hour');
  });

  it('keeps the ticking time out of any live region', async () => {
    await draw(<ReviewSteps kind="tests" status="running" since={ago(9)} />);
    expect(host.querySelector('[data-testid="review-elapsed"]')?.closest('[role="status"], [aria-live]')).toBeNull();
  });
});

describe('where the review wait is drawn', () => {
  const pending = (status: 'queued' | 'running') => ({ id: 'revision-1', taskKey: '', status, passed: null, score: null, report: null, createdAt: ago(11) }) as unknown as SubmissionView;

  it('the workspace feedback panel draws the steps of the phase kind beside its sentence', async () => {
    await draw(<FeedbackPanel submission={pending('running')} kind="tests" />);
    const panel = host.querySelector('[data-testid="feedback-pending"]')!;
    expect(panel.textContent).toContain('Reviewing your submission…');
    expect(items()).toEqual([...REVIEW_STEPS.tests]);
    expect(elapsed()).toBe('Running for 11 s');
  });

  it('the feedback panel draws no steps on a settled submission', async () => {
    await draw(<FeedbackPanel submission={{ ...pending('running'), status: 'failed', error: 'The review failed to run. Submit again.' } as SubmissionView} kind="code" />);
    expect(host.querySelector('[data-testid="review-steps"]')).toBeNull();
  });

  it('the review evidence page draws the steps while the review runs', async () => {
    mocks.evidence.mockResolvedValue(pending('queued'));
    await draw(<SubmissionEvidence submissionId="revision-1" phase={{ id: 'phase-1', key: 'design', status: 'in_progress', artifactKind: 'design' }} />);
    expect(host.textContent).toContain('Your submission is being reviewed.');
    expect(items()).toEqual([...REVIEW_STEPS.design]);
    expect(elapsed()).toBe('Queued for 11 s');
  });

  // The requirements room's own mount of the steps is rendered in
  // `requirements-design-rooms.test.tsx`, with a review running.
});
