// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterviewAskResponse, InterviewState } from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import { clearSession, setAuthSession } from '@/lib/session';
import { InterviewPanel } from '@/components/workspace/requirements/InterviewPanel';
import { useInterview } from '@/components/workspace/requirements/useInterview';

const calls = vi.hoisted(() => ({ interview: vi.fn(), ask: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: calls }));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));

const state = (): InterviewState => ({
  persona: { name: 'Maya', role: 'Project stakeholder' }, opening: 'Help me understand the overdue report.',
  startedAt: null, turns: [], facts: [{ id: 'F2', topic: 'Due-date boundary', uncovered: false }],
  factsExpected: 1, turnsLeft: 6, closedAt: null,
});
const answer = (question: string): InterviewAskResponse => {
  const turn = { id: 'reviewed-turn', question, answer: 'A task due today is not overdue.', facts: ['F2'], provider: 'openai', askedAt: '2026-09-11T00:00:00Z' };
  return { turn, state: { ...state(), turns: [turn], facts: [{ id: 'F2', topic: 'Due-date boundary', uncovered: true }], turnsLeft: 5 }, usage: { todayTokens: 100 } };
};
const withheld = () => new ApiError(503, 'The stakeholder could not provide a reliable reply. Try again. (reference stakeholder-ref)', 'stakeholder-ref', { code: 'STAKEHOLDER_REPLY_WITHHELD' });
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let host: HTMLDivElement; let root: Root;
let current: ReturnType<typeof useInterview>;
function Panel({ phaseId = 'reviewed-stakeholder-phase' }: { phaseId?: string }) {
  current = useInterview(phaseId);
  return <InterviewPanel interview={current} backlogHref={`/workspace/${phaseId}/issue`} />;
}
const input = () => host.querySelector<HTMLTextAreaElement>('[data-testid="interview-input"]')!;
const send = () => host.querySelector<HTMLButtonElement>('[data-testid="interview-send"]')!;
const outgoing = () => host.querySelectorAll<HTMLElement>('[data-testid="interview-outgoing"]');
const retry = () => host.querySelector<HTMLButtonElement>('[data-testid="interview-retry-question"]')!;
const type = (question: string) => act(() => { fireEvent.change(input(), { target: { value: question } }); });
const mount = () => act(async () => { root.render(<Panel />); });

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); clearSession();
  setAuthSession('interview-test-token', { id: 'interview-test-user', email: 'interview@example.test', displayName: 'Interview verifier', role: 'LEARNER', cohort: 'default', createdAt: '2026-09-11T00:00:00Z' });
  calls.interview.mockReset().mockResolvedValue(state()); calls.ask.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearSession(); });

describe('a reviewed stakeholder reply', () => {
  it('renders a reviewed off-topic redirect as ordinary chat without an error or an invented undecided requirement', async () => {
    const question = 'What is the capital of France?';
    const turn = { id: 'scope-turn', question, answer: 'I am here to discuss TaskTrackr requirements. What would you like to clarify about the report?', facts: [], provider: 'openai', askedAt: '2026-09-14T00:00:00Z' };
    const response = { turn, state: { ...state(), turns: [turn], turnsLeft: 5 }, usage: { todayTokens: 100 } };
    calls.ask.mockResolvedValueOnce(response);
    await mount(); type(question); await act(async () => { send().click(); });
    expect(host.querySelector('[data-testid="interview-answer-1"]')?.textContent).toBe(turn.answer);
    expect(host.querySelector('[data-testid="interview-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="interview-settled-1"]')).toBeNull();
    expect(host.textContent).not.toContain('The customer has not decided that yet');
    expect(retry()).toBeNull(); expect(outgoing()).toHaveLength(0);
    expect(input().value).toBe(''); expect(current.state?.facts).toEqual(state().facts);
  });

  it('immediately shows a local pending bubble and clears the composer, then reconciles the saved turn once', async () => {
    const question = 'Is a task due today overdue?';
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    await mount(); type(question); act(() => { send().click(); });
    expect(input().value).toBe('');
    expect(input().disabled).toBe(false);
    expect(send().disabled).toBe(true);
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0].dataset.status).toBe('pending');
    expect(host.querySelector('[data-testid="interview-outgoing-question"]')?.textContent).toBe(question);
    expect(host.querySelector('[data-testid="interview-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="interview-persona"] [role="status"]')?.textContent).toContain('Thinking about your question');
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(0);
    expect(current.state).toEqual(state());
    expect(host.querySelector('[data-testid="interview-turns-left"]')?.textContent).toBe('6 questions left');
    await act(async () => { request.resolve(answer(question)); });
    expect(outgoing()).toHaveLength(0);
    expect(current.state?.turns.map(turn => turn.id)).toEqual(['reviewed-turn']);
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="interview-turn-1"]')?.textContent).toContain(question);
    expect(input().value).toBe('');
  });

  it('keeps a withheld question retryable without adding a turn, uncovering facts or consuming a question', async () => {
    const question = 'Is a task due today overdue?';
    calls.ask.mockRejectedValueOnce(withheld()).mockResolvedValueOnce(answer(question));
    await mount(); type(question); await act(async () => { send().click(); });
    expect(input().value).toBe(question);
    expect(host.querySelector('[data-testid="interview-error"]')?.textContent).toContain('reference stakeholder-ref');
    expect(host.querySelectorAll('[data-testid="interview-error"]')).toHaveLength(1);
    expect(outgoing()[0].querySelector('[data-testid="interview-error"]')?.textContent).toContain('Maya could not provide a reliable reply this time');
    expect(host.textContent).not.toContain('Check recent replies');
    expect(current.error).toBe('');
    expect(retry().getAttribute('aria-describedby')).toBe(outgoing()[0].querySelector('[data-testid="interview-error"]')?.id);
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="interview-turns-left"]')?.textContent).toBe('6 questions left');
    expect(current.state).toEqual(state());
    expect(send().disabled).toBe(false);
    expect(calls.ask).toHaveBeenCalledTimes(1);
    expect(calls.interview).toHaveBeenCalledTimes(2);
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0].dataset.status).toBe('failed');

    await act(async () => { send().click(); });
    expect(calls.ask.mock.calls).toEqual([['reviewed-stakeholder-phase', question], ['reviewed-stakeholder-phase', question]]);
    expect(input().value).toBe('');
    expect(host.querySelector('[data-testid="interview-error"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="interview-answer-1"]')?.textContent).toBe(answer(question).turn.answer);
    expect(current.state).toEqual(answer(question).state);
    expect(outgoing()).toHaveLength(0);
  });

  it('preserves a newer draft typed while a withheld response was pending', async () => {
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    await mount(); type('What makes a task overdue?'); act(() => { send().click(); });
    expect(send().disabled).toBe(true);
    type('Which date should the report use?');
    await act(async () => { request.reject(withheld()); });
    expect(input().value).toBe('Which date should the report use?');
    expect(current.state).toEqual(state());
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(0);
    expect(send().disabled).toBe(false);
    expect(calls.ask.mock.calls).toEqual([['reviewed-stakeholder-phase', 'What makes a task overdue?']]);
  });

  it('adds only the reviewed answer and keeps a newer draft when a pending request succeeds', async () => {
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    const question = 'Is a task due today overdue?';
    await mount(); type(question); act(() => { send().click(); });
    type('Should the report include completed tasks?');
    await act(async () => { request.resolve(answer(question)); });
    expect(input().value).toBe('Should the report include completed tasks?');
    expect(current.state).toEqual(answer(question).state);
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="interview-turn-1"]')?.textContent).toContain(question);
    expect(host.querySelector('[data-testid="interview-turn-1"]')?.textContent).not.toContain('Should the report include completed tasks?');
    expect(calls.ask).toHaveBeenCalledTimes(1);
  });

  it('ignores an old owner’s reply when the session changes while the request is pending', async () => {
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    const question = 'Is a task due today overdue?';
    await mount(); type(question); act(() => { send().click(); });
    act(() => clearSession());
    await act(async () => { request.resolve(answer(question)); });
    expect(current.state).toBeNull();
    expect(current.draft).toBe('');
    expect(current.busy).toBe(false);
    expect(outgoing()).toHaveLength(0);
    expect(host.textContent).not.toContain(question);
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(0);
  });

  it('does not erase an identical question deliberately retyped while the first reply is pending', async () => {
    const question = 'Is a task due today overdue?';
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    await mount(); type(question); act(() => { send().click(); });
    expect(input().value).toBe(''); type(question);
    await act(async () => { request.resolve(answer(question)); });
    expect(input().value).toBe(question);
    expect(outgoing()).toHaveLength(0);
    expect(current.state?.turns).toHaveLength(1);
  });

  it('respects a draft deliberately cleared while waiting and keeps the failed question available for retry', async () => {
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    await mount(); type('What makes a task overdue?'); act(() => { send().click(); });
    type('A different draft'); type('');
    await act(async () => { request.reject(withheld()); });
    expect(input().value).toBe('');
    expect(outgoing()).toHaveLength(1);
    expect(retry().disabled).toBe(false);
  });

  it('retries the captured failed question without clearing a newer composer draft', async () => {
    const question = 'Is a task due today overdue?';
    const first = deferred<InterviewAskResponse>(), second = deferred<InterviewAskResponse>();
    calls.ask.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount(); type(question); act(() => { send().click(); });
    type('What should happen to completed tasks?');
    await act(async () => { first.reject(withheld()); });
    act(() => { retry().click(); });
    expect(input().value).toBe('What should happen to completed tasks?');
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0].dataset.status).toBe('pending');
    expect(calls.ask.mock.calls).toEqual([['reviewed-stakeholder-phase', question], ['reviewed-stakeholder-phase', question]]);
    await act(async () => { second.resolve(answer(question)); });
    expect(input().value).toBe('What should happen to completed tasks?');
    expect(outgoing()).toHaveLength(0);
    expect(current.state?.turns).toHaveLength(1);
  });

  it('guards two synchronous sends before React commits the busy state', async () => {
    const question = 'Is a task due today overdue?';
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    await mount(); type(question);
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = current.send(); second = current.send(); });
    expect(calls.ask).toHaveBeenCalledTimes(1);
    expect(outgoing()).toHaveLength(1);
    await act(async () => { request.resolve(answer(question)); await Promise.all([first, second]); });
    expect(current.state?.turns).toHaveLength(1);
  });

  it('preserves a deliberately retyped identical draft when retrying a failed bubble', async () => {
    const question = 'Is a task due today overdue?';
    const request = deferred<InterviewAskResponse>();
    calls.ask.mockRejectedValueOnce(withheld()).mockReturnValueOnce(request.promise);
    await mount(); type(question); await act(async () => { send().click(); });
    expect(input().value).toBe(question);
    type('Another draft'); type(question);
    act(() => { retry().click(); });
    expect(input().value).toBe(question);
    expect(outgoing()).toHaveLength(1);
    await act(async () => { request.resolve(answer(question)); });
    expect(input().value).toBe(question);
    expect(outgoing()).toHaveLength(0);
  });

  it('rejects retained send and retry callbacks from the previous phase before making any request', async () => {
    const request = deferred<InterviewAskResponse>();
    calls.ask.mockRejectedValueOnce(withheld()).mockReturnValueOnce(request.promise);
    await mount(); type('Old phase question?'); await act(async () => { send().click(); });
    const oldSend = current.send, oldRetry = current.retry, oldId = current.outgoing[0].id;
    await act(async () => { root.render(<Panel phaseId="next-phase" />); });
    type('New phase question?'); act(() => { send().click(); });
    type('New phase draft while waiting');
    await act(async () => { await oldSend(); await oldRetry(oldId); });
    expect(calls.ask.mock.calls).toEqual([
      ['reviewed-stakeholder-phase', 'Old phase question?'], ['next-phase', 'New phase question?'],
    ]);
    expect(current.busy).toBe(true);
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0].textContent).toContain('New phase question?');
    expect(input().value).toBe('New phase draft while waiting');
    await act(async () => { request.resolve(answer('New phase question?')); });
    expect(current.busy).toBe(false); expect(outgoing()).toHaveLength(0);
  });

  it('reloads an abandoned pending phase from the server when returning, without resending', async () => {
    const question = 'Is a task due today overdue?';
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    calls.interview.mockResolvedValueOnce(state()).mockResolvedValueOnce(state()).mockResolvedValueOnce(answer(question).state);
    await mount(); type(question); act(() => { send().click(); });
    await act(async () => { root.render(<Panel phaseId="next-phase" />); });
    await act(async () => { request.resolve(answer(question)); });
    await act(async () => { root.render(<Panel />); });
    expect(calls.interview.mock.calls.map(([id]) => id)).toEqual(['reviewed-stakeholder-phase', 'next-phase', 'reviewed-stakeholder-phase']);
    expect(current.state).toEqual(answer(question).state);
    expect(outgoing()).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(1);
    expect(calls.ask).toHaveBeenCalledTimes(1);
  });

  it('renders cached history on return but prevents its background read from overwriting a newer answer', async () => {
    const refresh = deferred<InterviewState>(), request = deferred<InterviewAskResponse>();
    const old = answer('An older saved question?').state;
    calls.interview.mockResolvedValueOnce(old).mockResolvedValueOnce(state()).mockReturnValueOnce(refresh.promise);
    calls.ask.mockReturnValueOnce(request.promise);
    await mount();
    await act(async () => { root.render(<Panel phaseId="next-phase" />); });
    await act(async () => { root.render(<Panel />); });
    expect(current.state).toEqual(old);
    expect(current.loading).toBe(false);
    expect(calls.interview).toHaveBeenCalledTimes(3);
    type('A new question?'); act(() => { send().click(); });
    const saved = answer('A new question?');
    saved.turn.id = 'new-reviewed-turn'; saved.state.turns = [...old.turns, saved.turn];
    await act(async () => { request.resolve(saved); });
    await act(async () => { refresh.resolve(old); });
    expect(current.state).toEqual(saved.state);
    expect(current.state?.turns.map(turn => turn.id)).toEqual(['reviewed-turn', 'new-reviewed-turn']);
    expect(outgoing()).toHaveLength(0);
    expect(current.busy).toBe(false);
  });

  it('uses an authoritative new turn after a lost response without resending or duplicating the question', async () => {
    const question = 'Is a task due today overdue?';
    calls.interview.mockResolvedValueOnce(state()).mockResolvedValueOnce(answer(question).state);
    calls.ask.mockRejectedValueOnce(new ApiError(500, 'The response was interrupted.'));
    await mount(); type(question); await act(async () => { send().click(); });
    expect(calls.ask).toHaveBeenCalledTimes(1);
    expect(calls.interview).toHaveBeenCalledTimes(2);
    expect(current.state).toEqual(answer(question).state);
    expect(outgoing()).toHaveLength(0);
    expect(input().value).toBe('');
    expect(host.querySelector('[data-testid="interview-error"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid^="interview-turn-"]')).toHaveLength(1);
  });

  it('does not mistake an older equal question for delivery of the current request', async () => {
    const question = 'Is a task due today overdue?';
    const old = answer(question).state;
    calls.interview.mockResolvedValue(old); calls.ask.mockRejectedValueOnce(withheld());
    await mount(); type(question); await act(async () => { send().click(); });
    expect(current.state).toEqual(old);
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0].dataset.status).toBe('failed');
    expect(input().value).toBe(question);
    expect(host.querySelector('[data-testid="interview-error"]')).not.toBeNull();
  });

  it('retains the question when both delivery and its reconciliation read are unavailable', async () => {
    calls.interview.mockResolvedValueOnce(state()).mockRejectedValueOnce(new Error('offline'));
    calls.ask.mockRejectedValueOnce(new TypeError('Network request failed'));
    await mount(); type('What makes a task overdue?'); await act(async () => { send().click(); });
    expect(current.state).toEqual(state());
    expect(input().value).toBe('What makes a task overdue?');
    expect(outgoing()[0].textContent).toContain('could not confirm whether Maya replied');
    expect(outgoing()[0].textContent).toContain('recent replies are unavailable');
    expect(outgoing()[0].querySelector('[data-testid="interview-error"]')?.getAttribute('data-failure')).toBe('unconfirmed');
    expect(host.querySelectorAll('[data-testid="interview-error"]')).toHaveLength(1);
    expect(retry().disabled).toBe(false);
    expect(calls.ask).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit withheld result definite even when the history refresh also fails', async () => {
    calls.interview.mockResolvedValueOnce(state()).mockRejectedValueOnce(new TypeError('offline'));
    calls.ask.mockRejectedValueOnce(withheld());
    await mount(); type('hello'); await act(async () => { send().click(); });
    expect(outgoing()[0].textContent).toContain('Maya could not provide a reliable reply this time');
    expect(outgoing()[0].textContent).not.toContain('could not confirm');
    expect(outgoing()[0].textContent).not.toContain('Check recent replies');
    expect(outgoing()[0].querySelector('[data-testid="interview-error"]')?.getAttribute('data-failure')).toBe('withheld');
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(current.state).toEqual(state()); expect(input().value).toBe('hello');
    expect(calls.ask).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a failed transport followed by a successful read with no new reply', async () => {
    calls.ask.mockRejectedValueOnce(new ApiError(503, 'Upstream temporarily unavailable', 'transport-ref'));
    await mount(); type('Which tasks belong in the report?'); await act(async () => { send().click(); });
    expect(outgoing()[0].textContent).toContain('no new reply appeared when we checked');
    expect(outgoing()[0].textContent).toContain('reference transport-ref');
    expect(outgoing()[0].textContent).not.toContain('could not provide a reliable reply');
    expect(current.state).toEqual(state()); expect(calls.ask).toHaveBeenCalledTimes(1);
    expect(calls.interview).toHaveBeenCalledTimes(2);
  });

  it('keeps an opening failure in the header without inventing an outgoing question', async () => {
    calls.interview.mockRejectedValueOnce(new ApiError(503, 'The interview is temporarily unavailable.'));
    await mount();
    expect(current.error).toBe('The interview is temporarily unavailable.');
    expect(outgoing()).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="interview-error"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="room-retry"]')).not.toBeNull();
    expect(calls.ask).not.toHaveBeenCalled();
  });

  it('keeps concurrent server evidence on409 and disables retry when no questions remain', async () => {
    const concurrent = { ...answer('A different concurrent question?').state, turnsLeft: 0, closedAt: '2026-09-11T00:00:00Z' };
    calls.interview.mockResolvedValueOnce(state()).mockResolvedValueOnce(concurrent);
    calls.ask.mockRejectedValueOnce(new ApiError(409, 'The stakeholder answered another question.'));
    await mount(); type('My own question?'); await act(async () => { send().click(); });
    expect(current.state).toEqual(concurrent);
    expect(outgoing()[0].dataset.status).toBe('failed');
    expect(retry().disabled).toBe(true);
    expect(host.querySelector('[data-testid="interview-closed"]')).not.toBeNull();
    await act(async () => { await current.retry(current.outgoing[0].id); });
    expect(calls.ask).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('ignores stale phase %s without clearing the new phase request', async result => {
    const first = deferred<InterviewAskResponse>(), next = deferred<InterviewAskResponse>();
    const nextState = { ...state(), persona: { name: 'Next stakeholder', role: 'Next phase' } };
    calls.interview.mockImplementation((id: string) => Promise.resolve(id === 'next-phase' ? nextState : state()));
    calls.ask.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    await mount(); type('Old phase question?'); act(() => { send().click(); });
    await act(async () => { root.render(<Panel phaseId="next-phase" />); });
    expect(input().value).toBe(''); expect(outgoing()).toHaveLength(0);
    type('New phase question?'); act(() => { send().click(); });
    await act(async () => { if (result === 'success') first.resolve(answer('Old phase question?')); else first.reject(withheld()); });
    expect(current.state).toEqual(nextState);
    expect(current.busy).toBe(true);
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0].textContent).toContain('New phase question?');
    expect(host.textContent).not.toContain('Old phase question?');
    expect(calls.interview).toHaveBeenCalledTimes(2);
    const saved = answer('New phase question?');
    await act(async () => { next.resolve({ ...saved, state: { ...saved.state, persona: nextState.persona } }); });
    expect(current.busy).toBe(false); expect(outgoing()).toHaveLength(0);
  });

  it('does not expose an old owner’s pending question or response to a replacement session', async () => {
    const request = deferred<InterviewAskResponse>(); calls.ask.mockReturnValueOnce(request.promise);
    await mount(); type('Private previous learner question?'); act(() => { send().click(); });
    await act(async () => { setAuthSession('replacement-token', { id: 'replacement-user', email: 'replacement@example.test', displayName: 'Next learner', role: 'LEARNER', cohort: 'default', createdAt: '2026-09-11T00:00:00Z' }); });
    expect(current.draft).toBe(''); expect(outgoing()).toHaveLength(0);
    await act(async () => { request.reject(withheld()); });
    expect(current.state).toEqual(state()); expect(current.busy).toBe(false);
    expect(host.textContent).not.toContain('Private previous learner question?');
    expect(host.querySelector('[data-testid="interview-error"]')).toBeNull();
    expect(calls.interview).toHaveBeenCalledTimes(2);
  });
});
