// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StuckItem } from '@learnsdlc/shared';
import { StuckList } from '@/components/staff/StuckList';
import { ApiError } from '@/lib/api';

const calls = vi.hoisted(() => ({ stuckList: vi.fn(), answerStuck: vi.fn(), session: { id: 'teacher-a', role: 'INSTRUCTOR' } as { id: string; role: string } | null }));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: calls }));
vi.mock('@/lib/session', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => calls.session, getSession: () => calls.session }));
const item = (userId: string, phaseStateId: string): StuckItem => ({ userId, phaseStateId, displayName: `Learner ${userId}`, email: `${userId}@example.test`, projectSlug: 'tasktrackr', phaseKey: 'requirements', phaseTitle: 'Requirements', question: `Question shared by ${userId}`, tried: 'Compared the boundary examples.', raisedAt: '2026-09-11T00:00:00Z', answeredAt: null, answeredByName: null, answer: null });
const first = item('one', 'phase-one');
const other = item('two', 'phase-two');
let root: Root;
let host: HTMLDivElement;
const inspect = vi.fn();
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const render = async (learnerIds?: string[], cohortId?: string) => { await act(async () => root.render(<StuckList project="tasktrackr" learnerIds={learnerIds} cohortId={cohortId} onInspect={inspect} />)); };
const click = async (id: string) => { await act(async () => q<HTMLButtonElement>(id).click()); };
const type = (value: string) => { act(() => { const node = q<HTMLTextAreaElement>('stuck-answer-input'); fireEvent.change(node, { target: { value: value } }); }); };
const submit = async () => { await act(async () => fireEvent.submit(host.querySelector('form')!)); };
beforeEach(() => {
  vi.clearAllMocks(); calls.session = { id: 'teacher-a', role: 'INSTRUCTOR' };
  calls.stuckList.mockReset().mockResolvedValue([first, other]); calls.answerStuck.mockReset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('class-scoped teacher help', () => {
  it('renders only associated learners and opens the exact submitted phase inspector', async () => {
    await render(['one'], 'class-one');
    expect(q('stuck-row-one')).not.toBeNull(); expect(q('stuck-row-two')).toBeNull();
    expect(calls.stuckList).toHaveBeenCalledWith({ project: 'tasktrackr', state: 'open', cohortId: 'class-one' });
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Inspect submitted Requirements evidence for Learner one"]')!;
    await act(async () => button.click()); expect(inspect).toHaveBeenCalledExactlyOnceWith(first);
  });
  it('preserves a failed answer for an explicit retry and never marks an unsaved reply answered', async () => {
    calls.answerStuck.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(undefined);
    await render(['one']); await click('stuck-reply-phase-one');
    expect(document.activeElement).toBe(q('stuck-answer-input'));
    type('Compare the returned state with your recorded observation.'); await submit();
    expect(q<HTMLTextAreaElement>('stuck-answer-input').value).toBe('Compare the returned state with your recorded observation.');
    expect(q('stuck-answer-error')).not.toBeNull(); expect(q('stuck-list-error')).toBeNull(); expect(q('stuck-answered')).toBeNull();
    expect(q('stuck-answer-error').closest('form')).toBe(q('stuck-answer-input').closest('form'));
    expect(q('stuck-answer-input').getAttribute('aria-describedby')).toBe(q('stuck-answer-error').id);
    // A successful queue refresh must not erase an unsent answer's failure.
    const failedReply = q('stuck-answer-error').textContent;
    expect(failedReply).toContain('The answer did not send. Your draft is kept for retry.');
    await click('stuck-refresh'); expect(q('stuck-answer-error').textContent).toBe(failedReply);
    calls.stuckList.mockResolvedValue([{ ...first, answeredAt: '2026-09-11T00:05:00Z', answeredByName: 'Teacher A', answer: 'Compare the returned state with your recorded observation.' }]);
    await submit(); expect(calls.answerStuck.mock.calls).toEqual(Array(2).fill(['phase-one', 'Compare the returned state with your recorded observation.']));
    expect(q('stuck-answer-input')).toBeNull(); expect(q('stuck-answered').textContent).toContain('Compare the returned state');
    expect(q('stuck-answered-toggle').textContent).toContain('waiting for learner acknowledgment');
    expect(host.textContent).not.toContain('Answered today');
  });
  it('does not show an empty success state for an unavailable list and retries the actual read', async () => {
    calls.stuckList.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([first]);
    await render(['one']); expect(q('stuck-list-error')).not.toBeNull(); expect(q('stuck-empty')).toBeNull();
    expect(host.textContent).toContain('status is unavailable'); await click('stuck-refresh');
    expect(q('stuck-list-error')).toBeNull(); expect(q('stuck-row-one')).not.toBeNull();
  });
  it('keeps list-refresh errors at the section header even while a reply is open', async () => {
    await render(['one']); await click('stuck-reply-phase-one'); type('A draft that has not been submitted.');
    calls.stuckList.mockRejectedValueOnce(new Error('Queue read unavailable'));
    await click('stuck-refresh');
    expect(q('stuck-list-error').textContent).toContain('Help requests could not be loaded. Try again.');
    expect(q('stuck-list-error').closest('form')).toBeNull();
    expect(q('stuck-answer-error')).toBeNull();
    expect(q<HTMLTextAreaElement>('stuck-answer-input').value).toBe('A draft that has not been submitted.');
  });
  it('keeps a conflicting reply refusal visible when the refreshed request has been cleared', async () => {
    await render(['one']); await click('stuck-reply-phase-one'); type('Check the story against one concrete boundary example.');
    calls.answerStuck.mockRejectedValueOnce(new ApiError(409, 'The learner cleared this request. Your answer was not saved.'));
    calls.stuckList.mockResolvedValueOnce([]);
    await submit();
    expect(q('stuck-answer-input')).toBeNull();
    expect(q('stuck-row-one')).toBeNull();
    expect(q('stuck-answer-error').textContent).toContain('Your answer was not saved');
    expect(q('stuck-answer-error').getAttribute('role')).toBe('alert');
    expect(q('stuck-answer-error').closest('form')).toBeNull();
    expect(q('stuck-answered')).toBeNull();
    expect(calls.answerStuck).toHaveBeenCalledTimes(1);
  });
  it('discards a delayed previous-class response and resets its draft when the class changes', async () => {
    let resolve!: (rows: StuckItem[]) => void;
    calls.stuckList.mockImplementationOnce(() => new Promise<StuckItem[]>(yes => { resolve = yes; })).mockResolvedValueOnce([other]);
    await render(['one']); await render(['two']); await act(async () => resolve([first]));
    expect(q('stuck-row-one')).toBeNull(); expect(q('stuck-row-two')).not.toBeNull();
    await click('stuck-reply-phase-two'); type('An answer for this particular learner.');
    calls.stuckList.mockResolvedValue([first]); await render(['one']); expect(q('stuck-answer-input')).toBeNull();
    await click('stuck-reply-phase-one'); expect(q<HTMLTextAreaElement>('stuck-answer-input').value).toBe('');
  });
  it('prevents delayed data from a previous teacher session appearing in the next session', async () => {
    let resolve!: (rows: StuckItem[]) => void;
    calls.stuckList.mockImplementationOnce(() => new Promise<StuckItem[]>(yes => { resolve = yes; })).mockResolvedValueOnce([]);
    await render(); calls.session = { id: 'teacher-b', role: 'INSTRUCTOR' }; await render();
    await act(async () => resolve([first])); expect(q('stuck-row-one')).toBeNull(); expect(q('stuck-empty')).not.toBeNull();
  });
  it('changes the server cohort filter even when two class views temporarily share the same local IDs', async () => {
    let resolve!: (rows: StuckItem[]) => void;
    calls.stuckList.mockImplementationOnce(() => new Promise<StuckItem[]>(yes => { resolve = yes; })).mockResolvedValueOnce([]);
    await render(['one'], 'class-one'); await render(['one'], 'class-two');
    await act(async () => resolve([first]));
    expect(calls.stuckList.mock.calls.map(([options]) => options.cohortId)).toEqual(['class-one', 'class-two']);
    expect(q('stuck-row-one')).toBeNull();
  });
  it('does not load teacher help for a learner or a logged-out session', async () => {
    calls.session = { id: 'learner', role: 'LEARNER' }; await render(); expect(host.textContent).toBe(''); expect(calls.stuckList).not.toHaveBeenCalled();
    calls.session = null; await render(); expect(calls.stuckList).not.toHaveBeenCalled();
  });
});
