// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionView } from '@learnsdlc/shared';
import { latestSubmission, useRequirementsReview } from '@/components/workspace/requirements/useRequirementsReview';

const mocks = vi.hoisted(() => ({ read: vi.fn(), token: 'learner-a', settled: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { getSubmission: mocks.read }, getToken: () => mocks.token }));
let root: Root; let host: HTMLDivElement;
const queued: SubmissionView = { id: 'review-a', status: 'queued', score: null, passed: null, report: null, createdAt: '2026-09-11T01:00:00Z' };
const revised: SubmissionView = { ...queued, status: 'completed', passed: false };
function Room({ initial = queued, tab = 'interview' }: { initial?: SubmissionView; tab?: string }) {
  const [submission, update] = useState(initial);
  const error = useRequirementsReview(submission, update, mocks.settled);
  return <div data-tab={tab}><span>{submission.status}</span><p>{error}</p><output>{String(submission.passed)}</output></div>;
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.token = 'learner-a'; mocks.read.mockReset(); mocks.settled.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
describe('Requirements review recovery', () => {
  it('resumes a persisted pending review on entry and updates an unchanged workspace across tabs', async () => {
    mocks.read.mockResolvedValueOnce({ ...queued, status: 'running' }).mockResolvedValue(revised);
    await act(async () => root.render(<Room />));
    expect(host.querySelector('span')!.textContent).toBe('running');
    await act(async () => root.render(<Room tab="backlog" />));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(host.querySelector('span')!.textContent).toBe('completed');
    expect(host.querySelector('output')!.textContent).toBe('false');
    expect(mocks.settled).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('keeps a network failure pending, backs off, and resumes on reconnect without creating another submission', async () => {
    mocks.read.mockRejectedValueOnce(new TypeError('network disconnected')).mockResolvedValue(revised);
    await act(async () => root.render(<Room />));
    expect(host.textContent).toContain('Reconnecting');
    expect(host.querySelector('span')!.textContent).toBe('queued');
    expect(host.querySelector('output')!.textContent).toBe('null');
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(host.querySelector('span')!.textContent).toBe('completed');
    expect(mocks.settled).toHaveBeenCalledTimes(1);
  });
  it('does not adopt a reply after the learner changes', async () => {
    let finish!: (value: SubmissionView) => void;
    mocks.read.mockReturnValue(new Promise<SubmissionView>(resolve => { finish = resolve; }));
    await act(async () => root.render(<Room />));
    mocks.token = 'learner-b';
    await act(async () => finish(revised));
    expect(host.querySelector('span')!.textContent).toBe('queued');
    expect(mocks.settled).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it('stops the watch on unmount and rejects a mismatched submission response', async () => {
    mocks.read.mockResolvedValue({ ...revised, id: 'someone-else' });
    await act(async () => root.render(<Room />));
    expect(host.querySelector('span')!.textContent).toBe('queued');
    expect(host.textContent).toContain('Reconnecting');
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.settled).not.toHaveBeenCalled();
  });
  it('does not regress a terminal verdict or newer revision when a delayed phase read arrives', () => {
    expect(latestSubmission(revised, queued)).toBe(revised);
    expect(latestSubmission(queued, revised)).toBe(revised);
    const newer = { ...queued, id: 'review-b', createdAt: '2026-09-11T02:00:00Z' };
    expect(latestSubmission(newer, revised)).toBe(newer);
  });
});
