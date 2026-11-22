// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, getByRole, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import { ApiError } from '@/lib/api';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { AGENT_PREPARE, useAgentWorkspace, type AgentPrepareDetail } from '@/components/workspace/mentor/useAgentWorkspace';
const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), owner: 'owner-a' }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: mocks.owner }), getSession: () => ({ id: mocks.owner }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));
// The real comparison, with the one prop below held exactly as it is handed
// over. The panel's quote of the learner's own request is not drawn anywhere
// else, and the comparison is what would print it.
const seen = vi.hoisted(() => ({ requests: [] as (string | null | undefined)[] }));
vi.mock('@/components/workspace/mentor/ProposalComparison', async importOriginal => {
 const actual = await importOriginal<typeof import('@/components/workspace/mentor/ProposalComparison')>();
 return { ProposalComparison: (props: Parameters<typeof actual.ProposalComparison>[0]) => { seen.requests.push(props.request); return <actual.ProposalComparison {...props} />; } };
});
const proposal: AgentProposal = { id: 'proposal-a', phaseStateId: 'phase-a', prompt: 'Keep the existing error code.', files: { 'code.ts': 'export const result = true;' }, proposalHash: 'a'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] }, explanation: 'The error code stays unchanged.', explanationAssessment: { adequate: true, feedback: 'All boundaries are explained.', questions: [] }, approvedAt: '2026-09-10T00:00:00Z', appliedAt: null, createdAt: '2026-09-10T00:00:00Z' };
const unapproved = { ...proposal, approvedAt: null, explanation: null, explanationAssessment: null };
const turn = (patch: Partial<AgentTurn> = {}): AgentTurn => ({ id: 'turn-a', phaseStateId: 'phase-a', requestId: 'request-a', kind: 'chat', status: 'completed', message: 'Keep the existing error code.', parentTurnId: null, parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'b'.repeat(64), proposalId: null, response: { kind: 'discussion', reply: 'Which boundary do you want to discuss?', questions: [], proposal: null }, errorCode: null, createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z', ...patch });
let root: Root; let host: HTMLDivElement;
const button = (name: string) => getByRole<HTMLButtonElement>(host, 'button', { name });
const input = () => host.querySelector<HTMLTextAreaElement>('[data-testid="agentic-input"]')!;
const waitStatus = () => host.querySelector<HTMLDivElement>('.agentic-turn-status');
const change = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(() => { fireEvent.change(element, { target: { value } }); });
const click = async (name: string) => { await act(async () => button(name).click()); };
const render = async (phaseId = 'phase-a') => { await act(async () => root.render(<AgenticPanel phaseId={phaseId} />)); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
 vi.clearAllMocks(); mocks.owner = 'owner-a'; seen.requests = []; mocks.list.mockResolvedValue([]); mocks.turns.mockResolvedValue({ items: [], nextCursor: null }); mocks.proposal.mockResolvedValue(proposal);
 host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
 Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
 // An unsent explanation is kept in this tab's storage; each case starts without one.
 sessionStorage.clear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('one conversational Agentic interface', () => {
 it('keeps a conversation retry visibly pending and preserves a typed question until history is loaded', async () => {
  const history = deferred<{ items: AgentTurn[]; nextCursor: null }>();
  mocks.turns.mockRejectedValueOnce(new Error('Conversation unavailable.')).mockReturnValueOnce(history.promise);
  await render(); change(input(), 'Keep my question.'); await click('Retry loading conversation');
  expect(host.textContent).toContain('Loading your conversation…'); expect(button('Send').disabled).toBe(true); expect(input().value).toBe('Keep my question.');
  await act(async () => history.resolve({ items: [], nextCursor: null }));
  expect(host.textContent).not.toContain('Loading your conversation…'); expect(button('Send').disabled).toBe(false); expect(input().value).toBe('Keep my question.'); expect(mocks.chat).not.toHaveBeenCalled();
 });
 it('lets a pending explanation check its saved status without sending another AI request or granting Apply', async () => {
  const pending = turn({ kind: 'explain', status: 'pending', response: null, parentProposalId: proposal.id, parentProposalHash: proposal.proposalHash });
  mocks.list.mockResolvedValue([unapproved]); mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null });
  mocks.turn.mockResolvedValue({ ...pending, updatedAt: '2026-09-15T00:00:01Z' }); mocks.proposal.mockResolvedValue(unapproved);
  await render(); expect(host.textContent).toContain('reviewing your explanation'); expect(button('Apply this reviewed proposal').disabled).toBe(true);
  change(input(), 'Keep my next question.'); await click('Check saved message status');
  expect(mocks.turn).toHaveBeenCalledExactlyOnceWith('phase-a', pending.requestId); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.explainTurn).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  expect(input().value).toBe('Keep my next question.'); expect(button('Apply this reviewed proposal').disabled).toBe(true);
 });
 it('clears reported activity on phase change and ignores the former phase response', async () => {
  const response = deferred<AgentTurn>(); mocks.chat.mockReturnValue(response.promise); const reportA = vi.fn(); const reportB = vi.fn();
  await act(async () => root.render(<AgenticPanel phaseId="phase-a" onBusyChange={reportA}/>));
  change(input(), 'An in-flight question.'); await click('Send'); expect(reportA).toHaveBeenLastCalledWith(true);
  await act(async () => root.render(<AgenticPanel phaseId="phase-b" onBusyChange={reportB}/>));
  expect(reportA).toHaveBeenLastCalledWith(false); expect(reportB).toHaveBeenLastCalledWith(false);
  const request = mocks.chat.mock.calls[0][1]; await act(async () => response.resolve(turn({ requestId: request.requestId })));
  expect(reportB).toHaveBeenLastCalledWith(false); expect(host.textContent).not.toContain('Which boundary');
  await act(async () => root.render(null)); expect(reportB).toHaveBeenLastCalledWith(false);
 });
 it('sends from the normal composer, immediately shows the learner bubble, clears it and retains newer typing while pending', async () => {
  const response = deferred<AgentTurn>(); mocks.chat.mockReturnValue(response.promise);
  await render(); const composer = input(); change(composer, 'Keep the response status unchanged.');
  await click('Send');
  expect(composer.value).toBe(''); expect(host.querySelector('[data-testid="msg-user"]')?.textContent).toContain('Keep the response status unchanged.');
  expect(composer.disabled).toBe(false); change(composer, 'A newer unsent question.');
  await act(async () => fireEvent.keyDown(composer, { key: 'Enter' })); expect(mocks.chat).toHaveBeenCalledTimes(1);
  const request = mocks.chat.mock.calls[0][1]; expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  await act(async () => response.resolve(turn({ requestId: request.requestId, message: request.message })));
  expect(input()).toBe(composer); expect(composer.value).toBe('A newer unsent question.');
  expect(host.querySelector('[data-testid="msg-assistant"]')?.textContent).toContain('Which boundary'); expect(mocks.explainTurn).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('uses the stored parent turn for a short clarification, not a client-authored history array', async () => {
  const clarification = turn({ id: 'clarification-a', response: { kind: 'clarification', reply: 'Which file should change?', questions: [], proposal: null } });
  mocks.turns.mockResolvedValue({ items: [clarification], nextCursor: null }); mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message }));
  await render(); change(input(), 'Only code.ts.'); await click('Send');
  expect(mocks.chat.mock.calls[0][1]).toMatchObject({ message: 'Only code.ts.', parentTurnId: clarification.id });
  expect(mocks.chat.mock.calls[0][1]).not.toHaveProperty('history'); expect(mocks.explainTurn).not.toHaveBeenCalled();
 });
 it('keeps normal discussion separate from explicit explanation and preserves both drafts', async () => {
  mocks.list.mockResolvedValue([unapproved]); mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message }));
  await render(); change(input(), 'Why this approach?'); await click('Explain this proposal');
  expect(input().value).toBe(''); change(input(), 'The error path still returns the existing code.'); await click('Back to chat'); expect(input().value).toBe('Why this approach?');
  await click('Send'); expect(mocks.chat).toHaveBeenCalledTimes(1); expect(mocks.explainTurn).not.toHaveBeenCalled();
  await click('Explain this proposal'); expect(input().value).toBe('The error path still returns the existing code.');
 });
 it('requires authoritative current approval after a saved explanation turn and applies only on explicit click', async () => {
  mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(proposal);
  mocks.explainTurn.mockImplementation(async (_phase, selected, explanation, requestId) => turn({ requestId, kind: 'explain', message: explanation, parentProposalId: selected.id, parentProposalHash: selected.proposalHash, proposalId: selected.id, response: { kind: 'explanation', reply: 'The explanation is accepted.', questions: [], proposal } }));
  await render(); expect(button('Apply this reviewed proposal').disabled).toBe(true); await click('Explain this proposal'); change(input(), 'The error code stays unchanged.'); await click('Send explanation');
  expect(mocks.explainTurn.mock.calls[0].slice(0,3)).toEqual(['phase-a', unapproved, 'The error code stays unchanged.']); expect(mocks.proposal).toHaveBeenCalledWith('phase-a', proposal.id);
  expect(button('Apply this reviewed proposal').disabled).toBe(false); expect(mocks.apply).not.toHaveBeenCalled();
  const applied = { ...proposal, appliedAt: '2026-09-15T00:00:00Z' }; mocks.apply.mockResolvedValue({ proposal: applied, workspace: applied.files });
  await click('Apply this reviewed proposal'); expect(mocks.apply).toHaveBeenCalledExactlyOnceWith('phase-a', proposal);
 });
 it('never authorizes from an old approved transcript snapshot when current files changed', async () => {
  const current = { ...unapproved, proposalHash: 'c'.repeat(64) }; mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(current);
  mocks.explainTurn.mockImplementation(async (_phase, _selected, message, requestId) => turn({ requestId, kind: 'explain', message, proposalId: proposal.id, response: { kind: 'explanation', reply: 'Previously accepted.', questions: [], proposal } }));
  await render(); await click('Explain this proposal'); change(input(), 'Old explanation.'); await click('Send explanation');
  expect(button('Apply this reviewed proposal').disabled).toBe(true); expect(host.querySelector('[data-testid="agentic-proposal"]')?.getAttribute('data-proposal-hash')).toBe(current.proposalHash);
 });
 it('keeps Apply closed when the semantic understanding assessment rejects the explanation', async () => {
  const rejected = { ...unapproved, explanation: 'It works.', explanationAssessment: { adequate: false, feedback: 'Explain the failure boundary.', questions: ['What happens on missing input?'] } };
  mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(rejected); mocks.explainTurn.mockImplementation(async (_phase, _selected, message, requestId) => turn({ requestId, kind: 'explain', message, proposalId: proposal.id, response: { kind: 'explanation', reply: rejected.explanationAssessment.feedback, questions: [], proposal: rejected } }));
  await render(); await click('Explain this proposal'); change(input(), 'It works.'); await click('Send explanation');
  expect(host.textContent).toContain('Explain the failure boundary.'); expect(button('Apply this reviewed proposal').disabled).toBe(true); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('explains why an earlier accepted explanation without current approval needs renewal', async () => {
  mocks.list.mockResolvedValue([{ ...proposal, approvedAt: null }]);
  await render();
  expect(host.textContent).toContain('This saved version needs a new explanation before it can be applied.');
  expect(button('Apply this reviewed proposal').disabled).toBe(true); expect(button('Explain this proposal').disabled).toBe(false); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('shows the proposal summary under the review header, and nothing when the proposal has none', async () => {
  const summary = 'Changes code.ts so result is true. Check the error path still returns the existing code.';
  mocks.list.mockResolvedValue([{ ...unapproved, summary }]); mocks.proposal.mockResolvedValue({ ...unapproved, summary });
  await render();
  const card = host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
  const block = card.querySelector<HTMLElement>('[data-testid="agentic-proposal-summary"]');
  expect(block?.textContent).toContain('What this proposal changes');
  expect(block?.textContent).toContain(summary);
  expect(block?.textContent).toContain('Check it against the proposal before you explain the change in your own words.');
  // Under the header, before anything else in the card.
  expect(card.querySelector('header')?.nextElementSibling).toBe(block);
  act(() => root.unmount()); root = createRoot(host);
  for (const none of [undefined, null, '']) {
   mocks.list.mockResolvedValue([{ ...unapproved, summary: none }]); mocks.proposal.mockResolvedValue({ ...unapproved, summary: none });
   await render();
   expect(host.querySelector('[data-testid="agentic-proposal"]')).toBeTruthy();
   expect(host.querySelector('[data-testid="agentic-proposal-summary"]')).toBeNull();
   act(() => root.unmount()); root = createRoot(host);
  }
 });
 it('drops the summary once the learner saves an edit, since the edited proposal comes back without one', async () => {
  const summary = 'Changes code.ts so result is true. Check the error path still returns the existing code.';
  const summarised = { ...unapproved, summary };
  mocks.list.mockResolvedValue([summarised]); mocks.proposal.mockResolvedValue(summarised);
  await render();
  expect(host.querySelector('[data-testid="agentic-proposal-summary"]')?.textContent).toContain(summary);
  const file = within(host.querySelector('[data-testid="agentic-proposal"]')!).getByLabelText<HTMLTextAreaElement>('Proposed file: inspect or edit', { exact: true });
  change(file, 'export const result = false;');
  const edited = { ...unapproved, proposalHash: 'c'.repeat(64), files: { 'code.ts': file.value }, summary: null }; mocks.edit.mockResolvedValue(edited); mocks.proposal.mockResolvedValue(edited);
  await click('Save changed proposal');
  expect(host.querySelector('[data-testid="agentic-proposal"]')?.getAttribute('data-proposal-hash')).toBe(edited.proposalHash);
  expect(host.querySelector('[data-testid="agentic-proposal-summary"]')).toBeNull();
  expect(host.textContent).not.toContain(summary);
 });
 it('invalidates Apply for a new unsent explanation and uses the exact edited hash for a fresh review', async () => {
  mocks.list.mockResolvedValue([proposal]); await render(); expect(button('Apply this reviewed proposal').disabled).toBe(false);
  // An accepted version with no draft offers no second explanation; a kept draft (here, one typed before a reload) brings Explain back.
  expect(within(host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!).queryByRole('button', { name: 'Explain this proposal' })).toBeNull();
  await act(async () => root.render(null)); sessionStorage.setItem(`learnsdlc:explain-draft:owner-a:phase-a:${proposal.id}`, 'A kept draft.'); await render();
  await click('Explain this proposal'); change(input(), 'A different explanation.'); expect(button('Apply this reviewed proposal').disabled).toBe(true);
  const file = within(host.querySelector('[data-testid="agentic-proposal"]')!).getByLabelText<HTMLTextAreaElement>('Proposed file: inspect or edit', { exact: true });
  change(file, 'export const result = false;');
  const edited = { ...unapproved, proposalHash: 'c'.repeat(64), files: { 'code.ts': file.value } }; mocks.edit.mockResolvedValue(edited);
  await click('Save changed proposal'); expect(mocks.edit).toHaveBeenCalledWith('phase-a', proposal, edited.files); expect(button('Apply this reviewed proposal').disabled).toBe(true);
  mocks.proposal.mockResolvedValue(edited); mocks.explainTurn.mockImplementation(async (_phase, selected, message, requestId) => turn({ requestId, kind: 'explain', message, parentProposalId: selected.id, parentProposalHash: selected.proposalHash, proposalId: selected.id, response: { kind: 'explanation', reply: 'Explain more.', questions: [], proposal: edited } }));
  await click('Explain this proposal'); change(input(), 'The changed boundary requires this value.'); await click('Send explanation');
  expect(mocks.explainTurn.mock.calls[0][1].proposalHash).toBe(edited.proposalHash);
 });
 it('retains file drafts per proposal and keeps populated JSON out of accessible names', async () => {
  const a = { ...unapproved, files: { 'api.json': '{"status":200}' } }; const b = { ...unapproved, id: 'proposal-b', proposalHash: 'c'.repeat(64), files: { 'api.json': '{"status":404}' } };
  mocks.list.mockResolvedValue([a,b]); mocks.proposal.mockImplementation(async (_phase, id) => id === a.id ? a : b);
  await render(); const file = () => within(host.querySelector('[data-testid="agentic-proposal"]')!).getByLabelText<HTMLTextAreaElement>('Proposed file: inspect or edit', { exact: true }); change(file(), '{"status":201}');
  const selector = getByRole<HTMLSelectElement>(host, 'combobox', { name: 'Earlier proposals', hidden: true }); change(selector, b.id); await act(async () => {}); expect(file().value).toBe('{"status":404}');
  change(selector, a.id); await act(async () => {}); expect(file().value).toBe('{"status":201}'); expect(mocks.edit).not.toHaveBeenCalled(); expect(button('Apply this reviewed proposal').disabled).toBe(true);
 });
 it('reconciles a lost chat response by request ID without another mutation or overwriting newer typing', async () => {
  const first = deferred<AgentTurn>(); mocks.chat.mockReturnValue(first.promise); mocks.turn.mockImplementation(async (_phase, requestId) => turn({ requestId, message: 'Original question.' }));
  await render(); change(input(), 'Original question.'); await click('Send'); change(input(), 'A newer draft.'); await act(async () => first.reject(new Error('Response lost')));
  expect(mocks.chat).toHaveBeenCalledTimes(1); expect(mocks.turn).toHaveBeenCalledExactlyOnceWith('phase-a', mocks.chat.mock.calls[0][1].requestId); expect(input().value).toBe('A newer draft.'); expect(host.querySelector('[data-testid="agentic-turn-error"]')).toBeNull();
 });
 it('keeps an unconfirmed message separate from a new draft and only checks status on recovery', async () => {
  mocks.chat.mockRejectedValue(new Error('Connection lost')); mocks.turn.mockRejectedValue(new Error('Offline'));
  await render(); change(input(), 'Keep this request.'); await click('Send'); expect(input().value).toBe('Keep this request.'); change(input(), 'Newer request, do not replace.');
  await click('Check message status'); expect(mocks.chat).toHaveBeenCalledTimes(1); expect(mocks.turn).toHaveBeenCalledTimes(2); expect(input().value).toBe('Newer request, do not replace.'); expect(button('Send').disabled).toBe(true); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('retains a failed turn and creates a new ID only for explicit retry', async () => {
  mocks.chat.mockImplementationOnce(async (_phase, body) => turn({ requestId: body.requestId, message: body.message, status: 'failed', response: null, errorCode: 'AI_UNAVAILABLE' })).mockImplementationOnce(async (_phase, body) => turn({ id: 'turn-retry', requestId: body.requestId, message: body.message }));
  await render(); change(input(), 'Retry exactly these words.'); await click('Send'); expect(input().value).toBe('Retry exactly these words.'); change(input(), 'Keep a newer draft.');
  await click('Retry this message'); expect(mocks.chat).toHaveBeenCalledTimes(2); expect(mocks.chat.mock.calls[0][1].requestId).not.toBe(mocks.chat.mock.calls[1][1].requestId); expect(mocks.chat.mock.calls[1][1].message).toBe('Retry exactly these words.'); expect(input().value).toBe('Keep a newer draft.'); expect(host.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(2);
 });
 // The API's pre-call read-only refusal says retryable:false; the same words would be refused again.
 it('offers no retry of a request the API marked not retryable, and keeps its sentence and the draft', async () => {
  const sentence = 'api/errors.py is read-only in this phase, so the mentor cannot propose a change to it; ask for a change to one of your editable files instead.';
  mocks.chat.mockRejectedValueOnce(new ApiError(400, sentence, undefined, { statusCode: 400, error: 'Bad Request', message: sentence, retryable: false })); mocks.turn.mockRejectedValue(new ApiError(404, 'Not found'));
  await render(); change(input(), 'Add a docstring to api/errors.py.'); await click('Send');
  const failure = host.querySelector<HTMLDivElement>('[data-testid="agentic-turn-error"]')!;
  expect(failure.textContent).toContain(sentence); expect(within(failure).queryByRole('button', { name: 'Retry this message' })).toBeNull();
  expect(input().value).toBe('Add a docstring to api/errors.py.'); expect(mocks.chat).toHaveBeenCalledTimes(1);
 });
 it('still offers a retry of a rejected request whose body does not say it is not retryable', async () => {
  mocks.chat.mockRejectedValueOnce(new ApiError(400, 'Invalid request.', undefined, { statusCode: 400, message: 'Invalid request.' })); mocks.turn.mockRejectedValue(new ApiError(404, 'Not found'));
  await render(); change(input(), 'Some request.'); await click('Send');
  expect(button('Retry this message').disabled).toBe(false);
 });
 it('does not contact the AI endpoint when workspace saving fails and keeps the unsent request recoverable', async () => {
  const listener = (event: Event) => (event as CustomEvent<AgentPrepareDetail>).detail.waitUntil(Promise.reject(new ApiError(409, 'Save conflict')));
  await render(); window.addEventListener(AGENT_PREPARE, listener);
  try { change(input(), 'Use my saved work.'); await click('Send'); expect(mocks.chat).not.toHaveBeenCalled(); expect(input().value).toBe('Use my saved work.'); expect(host.textContent).toContain('Save conflict'); expect(button('Retry this message').disabled).toBe(false); }
  finally { window.removeEventListener(AGENT_PREPARE, listener); }
 });
 it.each(['phase', 'account'])('ignores late private replies after a %s change', async kind => {
  const response = deferred<AgentTurn>(); mocks.chat.mockReturnValue(response.promise); await render(); change(input(), 'Private old-owner request.'); await click('Send');
  if (kind === 'account') mocks.owner = 'owner-b'; await render(kind === 'phase' ? 'phase-b' : 'phase-a');
  await act(async () => response.resolve(turn({ message: 'Private old-owner request.', response: { kind: 'discussion', reply: 'Private old reply.', questions: [], proposal: null } })));
  expect(host.textContent).not.toContain('Private old'); expect(input().value).toBe('');
 });
 it('retries only workspace GET refresh after a committed Apply, preserving the editor and selected view', async () => {
  mocks.list.mockResolvedValue([proposal]); const refresh = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(undefined); const flush = vi.fn().mockResolvedValue(undefined);
  function Workspace() { const [view] = useState('selected-view'); const disabled = useAgentWorkspace('phase-a', flush, refresh); return <><output>{view}</output><input data-testid="workspace-editor" disabled={disabled}/><AgenticPanel phaseId="phase-a"/></>; }
  await act(async () => root.render(<Workspace/>)); const editor = host.querySelector<HTMLInputElement>('[data-testid="workspace-editor"]')!; const composer = input();
  mocks.apply.mockResolvedValue({ proposal: { ...proposal, appliedAt: '2026-09-15T00:00:00Z' }, workspace: proposal.files }); await click('Apply this reviewed proposal');
  expect(editor.disabled).toBe(true); expect(host.textContent).toContain('Your proposal was saved, but the workspace could not refresh.'); expect(input()).toBe(composer);
  await click('Retry workspace refresh'); expect(mocks.apply).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(2); expect(host.querySelector('[data-testid="workspace-editor"]')).toBe(editor); expect(editor.disabled).toBe(false); expect(host.textContent).toContain('selected-view'); expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(refresh.mock.calls).toEqual([[proposal.files], [proposal.files]]);
 });
 it('does not send on composition Enter or Shift+Enter', async () => {
  await render(); change(input(), 'A composed message'); await act(async () => { fireEvent.keyDown(input(), { key: 'Enter', isComposing: true }); fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true }); }); expect(mocks.chat).not.toHaveBeenCalled(); expect(input().value).toBe('A composed message');
 });
 it('replays a confirmed absent delivery only on explicit request, with the identical ID and original parent context', async () => {
  const parent = turn({ id: 'saved-parent' }); mocks.turns.mockResolvedValue({ items: [parent], nextCursor: null }); mocks.list.mockResolvedValue([unapproved]);
  mocks.chat.mockRejectedValueOnce(new TypeError('Network lost')).mockImplementationOnce(async (_phase, body) => turn({ requestId: body.requestId, message: body.message })); mocks.turn.mockRejectedValue(new ApiError(404, 'No saved turn'));
  await render(); change(input(), 'Retain the boundary.'); await click('Send'); const original = mocks.chat.mock.calls[0][1]; expect(button('Retry delivery')).toBeDefined();
  change(input(), 'A newer message, not the retry.'); await click('Retry delivery'); expect(mocks.chat.mock.calls[1][1]).toEqual(original); expect(input().value).toBe('A newer message, not the retry.'); expect(mocks.chat).toHaveBeenCalledTimes(2);
 });
 it('polls an authoritative pending turn by GET and never repeats its POST', async () => {
  mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message, status: 'pending', response: null })); mocks.turn.mockImplementation(async (_phase, requestId) => turn({ requestId }));
  await render(); vi.useFakeTimers(); change(input(), 'One operation only.'); await click('Send'); expect(button('Send').disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(mocks.turn).toHaveBeenCalledTimes(1); expect(mocks.chat).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Which boundary');
 });
 it('retains explanation lineage and keeps failed replacement approval closed even if a history read is stale', async () => {
  const parent = turn({ id: 'parent-before-explanation' }); mocks.list.mockResolvedValue([proposal]); mocks.turns.mockResolvedValue({ items: [parent], nextCursor: null }); mocks.proposal.mockResolvedValue(proposal);
  // Explain is offered on an accepted version only while a draft is kept.
  sessionStorage.setItem(`learnsdlc:explain-draft:owner-a:phase-a:${proposal.id}`, 'A kept draft.');
  mocks.explainTurn.mockImplementation(async (_phase, selected, message, requestId, parentTurnId) => turn({ requestId, kind: 'explain', message, status: 'failed', parentTurnId, parentProposalId: selected.id, parentProposalHash: selected.proposalHash, response: null, errorCode: 'REVIEW_UNAVAILABLE' }));
  await render(); await click('Explain this proposal'); change(input(), 'I need to revisit the boundary.'); await click('Send explanation');
  expect(mocks.explainTurn.mock.calls[0][4]).toBe(parent.id); expect(button('Apply this reviewed proposal').disabled).toBe(true); expect(input().value).toBe('I need to revisit the boundary.'); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('starts the next message with a fresh base after Apply while retaining visible conversation evidence', async () => {
  const parent = turn({ id: 'before-apply' }); mocks.turns.mockResolvedValue({ items: [parent], nextCursor: null }); mocks.list.mockResolvedValue([proposal]);
  const listener = (event: Event) => (event as CustomEvent<AgentPrepareDetail>).detail.waitUntil(Promise.resolve());
  window.addEventListener('learnsdlc:agent-applied', listener);
  try {
   mocks.apply.mockResolvedValue({ proposal: { ...proposal, appliedAt: '2026-09-15T01:00:00Z' }, workspace: proposal.files }); await render(); await click('Apply this reviewed proposal');
   mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message })); change(input(), 'Now discuss a different change.'); await click('Send');
   expect(mocks.chat.mock.calls[0][1]).not.toHaveProperty('parentTurnId'); expect(mocks.chat.mock.calls[0][1]).not.toHaveProperty('proposalId'); expect(mocks.chat.mock.calls[0][1]).not.toHaveProperty('proposalHash'); expect(host.textContent).toContain(parent.message);
  } finally { window.removeEventListener('learnsdlc:agent-applied', listener); }
 });
 it('resumes the current saved workspace when an applied proposal is outside the newest thirty', async () => {
  const olderDrafts = Array.from({ length: 30 }, (_, index) => ({ ...unapproved, id: `older-draft-${index}` }));
  mocks.list.mockResolvedValue(olderDrafts);
  mocks.turns.mockResolvedValue({ items: [turn()], nextCursor: null, currentWorkspaceHash: 'c'.repeat(64) });
  mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message, baseWorkspaceHash: 'c'.repeat(64) }));
  await render();
  expect(host.querySelector('[data-testid="agentic-proposal"]')).toBeNull();
  expect(host.querySelectorAll('select[aria-label="Earlier proposals"] option')).toHaveLength(31);
  change(input(), 'Discuss the current saved code.'); await click('Send');
  const sent = mocks.chat.mock.calls[0][1];
  expect(sent.message).toBe('Discuss the current saved code.');
  expect(sent).not.toHaveProperty('parentTurnId'); expect(sent).not.toHaveProperty('proposalId');
  expect(mocks.explainTurn).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('retains matching discussion lineage while excluding later turns and drafts from another workspace version', async () => {
  const matching = turn({ id: 'current-base-turn', requestId: 'current-request', baseWorkspaceHash: 'c'.repeat(64) });
  const stale = turn({ id: 'stale-turn', requestId: 'stale-request', createdAt: '2026-09-15T01:00:00Z' });
  const currentProposal = { ...unapproved, id: 'current-proposal', baseWorkspaceHash: 'c'.repeat(64) };
  mocks.list.mockResolvedValue([unapproved, currentProposal]);
  mocks.turns.mockResolvedValue({ items: [stale, matching], nextCursor: null, currentWorkspaceHash: 'c'.repeat(64) });
  mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message, baseWorkspaceHash: 'c'.repeat(64) }));
  await render(); change(input(), 'Only the existing error message.'); await click('Send');
  expect(mocks.chat.mock.calls[0][1]).toMatchObject({ parentTurnId: matching.id, proposalId: currentProposal.id, proposalHash: currentProposal.proposalHash });
  expect(host.querySelectorAll('[data-agent-turn]')).toHaveLength(3);
 });
 it('does not revive pre-Apply conversation context when saved history is reloaded', async () => {
  mocks.list.mockResolvedValue([{ ...proposal, appliedAt: '2026-09-15T01:00:00Z' }]); mocks.turns.mockResolvedValue({ items: [turn({ createdAt: '2026-09-15T00:00:00Z' })], nextCursor: null });
  mocks.chat.mockImplementation(async (_phase, body) => turn({ requestId: body.requestId, message: body.message })); await render(); change(input(), 'A new request after returning.'); await click('Send');
  expect(mocks.chat.mock.calls[0][1]).not.toHaveProperty('parentTurnId'); expect(mocks.chat.mock.calls[0][1]).not.toHaveProperty('proposalId');
 });
 it('fails closed if the current proposal lookup is unavailable after an approved historical response', async () => {
  mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockRejectedValue(new ApiError(503, 'Current proposal unavailable'));
  mocks.explainTurn.mockImplementation(async (_phase, _selected, message, requestId) => turn({ requestId, kind: 'explain', message, proposalId: proposal.id, response: { kind: 'explanation', reply: 'Historical accepted explanation.', questions: [], proposal } }));
  await render(); await click('Explain this proposal'); change(input(), 'Explain the boundary.'); await click('Send explanation'); expect(button('Apply this reviewed proposal').disabled).toBe(true); expect(host.textContent).toContain('Current proposal unavailable'); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it.each(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const)('uses the shared conversational composer for the %s phase', async phaseKey => {
  await act(async () => root.render(<AgenticPanel phaseId="phase-a" phaseKey={phaseKey}/>));
  expect(host.querySelectorAll('[data-testid="agentic-input"]')).toHaveLength(1); expect(host.querySelector('[role="log"]')).not.toBeNull(); expect(host.querySelector('.agentic-panel')).toBeNull(); expect(input().getAttribute('aria-label')).toMatch(/^Message /);
 });

 it('offers a fresh current-workspace request after a confirmed stale-base rejection, preserving draft and history', async () => {
  const parent = turn({ id: 'old-base-parent' }); mocks.turns.mockResolvedValue({ items: [parent], nextCursor: null }); mocks.list.mockResolvedValue([unapproved]);
  mocks.chat.mockRejectedValueOnce(new ApiError(409, 'The saved workspace changed. Start a new conversation against the current files.')).mockImplementationOnce(async (_phase, body) => turn({ requestId: body.requestId, message: body.message })); mocks.turn.mockRejectedValue(new ApiError(404, 'No saved turn'));
  await render(); change(input(), 'Use my new saved file.'); await click('Send'); expect(host.textContent).toContain('The saved workspace changed.'); expect(input().value).toBe('Use my new saved file.'); expect(button('New request').disabled).toBe(false);
  await click('New request'); expect(input().value).toBe('Use my new saved file.'); await click('Send');
  expect(mocks.chat).toHaveBeenCalledTimes(2); expect(mocks.chat.mock.calls[1][1]).not.toHaveProperty('parentTurnId'); expect(mocks.chat.mock.calls[1][1]).not.toHaveProperty('proposalId'); expect(host.textContent).toContain(parent.message);
 });

 it('keeps a legacy plain-text request collapsed instead of repeating it in the default proposal card', async () => {
  mocks.list.mockResolvedValue([{ ...unapproved, prompt: 'Original request and bounded clarifications. '.repeat(300) }]); await render();
  const request = host.querySelector<HTMLDetailsElement>('.agentic-request-context')!; expect(request.open).toBe(false); expect(request.querySelector('summary')?.textContent).toBe('Original request'); expect(request.querySelector('p')?.textContent?.length).toBeGreaterThan(10000);
  expect(host.querySelectorAll('[data-testid="agentic-input"]')).toHaveLength(1);
 });

 it('places the proposal with its explanation before later discussion, preserving the composer and chronological replies', async () => {
  const explanation = turn({ id: 'explanation', requestId: 'explanation-request', kind: 'explain', proposalId: proposal.id, response: { kind: 'explanation', reply: 'The boundaries are explained.', questions: [], proposal } });
  mocks.list.mockResolvedValue([proposal]); mocks.turns.mockResolvedValue({ items: [explanation], nextCursor: null });
  mocks.chat.mockImplementation(async (_phase, body) => turn({ id: 'later-discussion', requestId: body.requestId, message: body.message, createdAt: '2026-09-15T00:01:00Z', proposalId: proposal.id, response: { kind: 'discussion', reply: 'Here is the newer answer.', questions: [], proposal } }));
  await render(); const composer = input(); change(composer, 'Can you discuss the next boundary?'); await click('Send');
  const card = host.querySelector('[data-testid="agentic-proposal"]')!;
  const lastTurn = host.querySelector('[data-agent-turn="later-discussion"]')!;
  expect(card.compareDocumentPosition(lastTurn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelector('[role="log"]')?.lastElementChild).toBe(lastTurn);
  expect(host.querySelector('[role="log"]')?.firstElementChild).toBe(host.querySelector('.agentic-saved-proposals'));
  expect(input()).toBe(composer); expect(mocks.explainTurn).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
 });

 it('says the proposed files are being written once the server reports that stage, and keeps the reading sentence until then', async () => {
  const pending = turn({ status: 'pending', response: null });
  mocks.list.mockResolvedValue([unapproved]); mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null }); mocks.proposal.mockResolvedValue(unapproved);
  await render();
  expect(waitStatus()!.textContent).toContain('is reading your message… You can keep drafting below.');
  mocks.turn.mockResolvedValue({ ...pending, stage: 'proposing', updatedAt: '2026-09-15T00:00:01Z' });
  await click('Check saved message status');
  expect(waitStatus()!.textContent).toContain('is writing the proposed files… Nothing in your workspace changes yet.');
  expect(waitStatus()!.textContent).not.toContain('is reading your message');
  expect(mocks.turn).toHaveBeenCalledExactlyOnceWith('phase-a', pending.requestId);
  expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.explainTurn).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  expect(button('Apply this reviewed proposal').disabled).toBe(true);
 });

 it('keeps the writing sentence when a later poll cannot tell the stage, never walking the wait backwards', async () => {
  const pending = turn({ status: 'pending', response: null });
  mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null });
  await render();
  // The stage is best effort and held in memory, so a poll answered after a
  // restart carries none: that means "nothing to report", never "that step
  // stopped". Saying "is reading" again would report finished work as unstarted
  // and announce an earlier sentence a second time.
  mocks.turn.mockResolvedValueOnce({ ...pending, stage: 'proposing', updatedAt: '2026-09-15T00:00:01Z' })
   .mockResolvedValueOnce({ ...pending, updatedAt: '2026-09-15T00:00:02Z' })
   .mockResolvedValueOnce(turn({ requestId: pending.requestId, updatedAt: '2026-09-15T00:00:03Z' }));
  await click('Check saved message status');
  expect(waitStatus()!.textContent).toContain('is writing the proposed files… Nothing in your workspace changes yet.');
  await click('Check saved message status');
  expect(waitStatus()!.textContent).toContain('is writing the proposed files… Nothing in your workspace changes yet.');
  expect(waitStatus()!.textContent).not.toContain('is reading your message');
  // A held stage decorates a wait; it can never keep the wait on screen.
  await click('Check saved message status');
  expect(waitStatus()).toBeNull();
  expect(host.querySelector('[data-testid="msg-assistant"]')?.textContent).toContain('Which boundary');
  expect(mocks.turn).toHaveBeenCalledTimes(3);
  expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.explainTurn).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
 });

 // Regression guard: the stage is read only on a pending turn, so a settled
 // turn renders the same whether or not a stage is present.
 it('ignores a stage unless the turn is pending, keeping a settled reply and a settled error as they are', async () => {
  const completed = turn({ stage: 'proposing' });
  const failed = turn({ id: 'turn-failed', requestId: 'request-failed', status: 'failed', response: null, errorCode: 'AI_UNAVAILABLE', stage: 'proposing', createdAt: '2026-09-15T00:00:01Z', updatedAt: '2026-09-15T00:00:01Z' });
  mocks.turns.mockResolvedValue({ items: [completed, failed], nextCursor: null });
  await render();
  expect(waitStatus()).toBeNull();
  expect(host.querySelector('[data-testid="msg-assistant"]')?.textContent).toContain('Which boundary');
  expect(host.querySelector('[data-testid="agentic-turn-error"]')).not.toBeNull();
  expect(host.textContent).not.toContain('is writing the proposed files'); expect(host.textContent).not.toContain('is reading your message');
 });

 // A failed turn the server gives no sentence of its own says which of its known causes it was, in one
 // line, and keeps the retry in place; the catch-all and an unknown code keep the generic sentence.
 it.each([
  ['chat', 'assessment_unavailable', 'The mentor did not answer in time, or its answer could not be read. Nothing was proposed and your work is unchanged.'],
  ['explain', 'assessment_unavailable', 'The review of your explanation did not come back in time, or could not be read. Your explanation is kept and Apply stays locked.'],
  ['chat', 'request_expired', 'This request ran past its time limit and was stopped. Nothing was proposed and your work is unchanged.'],
  ['explain', 'request_expired', 'This explanation ran past its time limit and was stopped. Your explanation is kept and Apply stays locked.'],
  ['chat', 'proposal_changed', 'Your saved work or the proposal changed while the mentor was working, so nothing was proposed. Send your request again as a new message to use your current work.'],
  ['chat', 'provider_busy', 'The mentor is busy with the rest of the class, so nothing was proposed. Your work is unchanged; try again in a minute.'],
  ['explain', 'provider_busy', 'The mentor is busy with the rest of the class, so your explanation was not reviewed. It is kept and Apply stays locked; try again in a minute.'],
  ['chat', 'request_failed', 'The mentor could not complete this reply. Your message is kept. Retry when you are ready.'],
  ['explain', 'request_failed', 'Your explanation is kept, but its review could not be completed. Apply stays locked. Retry when you are ready.'],
  ['chat', 'SOMETHING_NEW', 'The mentor could not complete this reply. Your message is kept. Retry when you are ready.'],
 ] as const)('a failed %s turn with %s says so in one line and offers the retry in place', async (kind, errorCode, sentence) => {
  const explain = kind === 'explain' ? { parentProposalId: proposal.id, parentProposalHash: proposal.proposalHash } : {};
  mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(unapproved);
  mocks.turns.mockResolvedValue({ items: [turn({ id: 'turn-failed', kind, status: 'failed', response: null, errorCode, ...explain })], nextCursor: null });
  await render();
  const failure = host.querySelector<HTMLDivElement>('[data-testid="agentic-turn-error"]')!;
  expect(failure.querySelector('p')?.textContent).toBe(sentence);
  expect(within(failure).getByRole<HTMLButtonElement>('button', { name: 'Retry this message' }).disabled).toBe(false);
 });
 // An explanation refused because the proposal moved cannot be retried (the panel refuses the old
 // hash), so it says to explain the current version and offers no retry button.
 it('a failed explain turn with proposal_changed says to explain the current version and offers no retry', async () => {
  mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(unapproved);
  mocks.turns.mockResolvedValue({ items: [turn({ id: 'turn-failed', kind: 'explain', status: 'failed', response: null, errorCode: 'proposal_changed', parentProposalId: proposal.id, parentProposalHash: proposal.proposalHash })], nextCursor: null });
  await render();
  const failure = host.querySelector<HTMLDivElement>('[data-testid="agentic-turn-error"]')!;
  expect(failure.querySelector('p')?.textContent).toBe('The proposal changed while your explanation was being reviewed. Apply stays locked; explain the current version.');
  expect(within(failure).queryByRole('button', { name: 'Retry this message' })).toBeNull();
 });
 // P1: a refused story or design proposal says its fixed sentence, never the generic failure.
 it.each([
  ['story_proposal_refused', "The assistant's proposal was not a valid story and was discarded."],
  ['design_proposal_refused', "The assistant's proposal was not a valid design and was discarded."],
  ['design_proposal_unchanged', "The assistant's proposal changed nothing and was discarded."],
 ])('a turn failed with %s shows its own sentence', async (errorCode, sentence) => {
  mocks.turns.mockResolvedValue({ items: [turn({ id: 'turn-refused', status: 'failed', response: null, errorCode, errorMessage: sentence })], nextCursor: null });
  await render();
  expect(host.querySelector('[data-testid="agentic-turn-error"]')?.textContent).toContain(sentence);
  expect(host.textContent).not.toContain('The mentor could not complete this reply');
 });

 // Regression guard: an explanation turn makes one model call, so it has no
 // second stage to report and its wait sentence is the same either way.
 it('keeps the explanation wait sentence, which no stage replaces', async () => {
  const pending = turn({ kind: 'explain', status: 'pending', response: null, parentProposalId: proposal.id, parentProposalHash: proposal.proposalHash, stage: 'proposing' });
  mocks.list.mockResolvedValue([unapproved]); mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null }); mocks.proposal.mockResolvedValue(unapproved);
  await render();
  expect(waitStatus()!.textContent).toContain('is reviewing your explanation… Apply stays locked while you wait.');
  expect(host.textContent).not.toContain('is writing the proposed files');
  expect(button('Apply this reviewed proposal').disabled).toBe(true);
 });

 // Regression guard: only the one stage value the panel knows may change a
 // word, so an older or quieter API renders the plain markup, byte for byte.
 it('renders identical wait markup for an absent, null or unrecognised stage', async () => {
  const pending = turn({ status: 'pending', response: null });
  mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null });
  await render();
  const absent = waitStatus()!.outerHTML;
  expect(absent).toContain('is reading your message… You can keep drafting below.');
  // The second row carries a stage name the panel does not know, which is
  // what a later API could answer with.
  mocks.turn.mockResolvedValueOnce({ ...pending, stage: null, updatedAt: '2026-09-15T00:00:01Z' })
   .mockResolvedValueOnce({ ...pending, stage: 'reviewing', updatedAt: '2026-09-15T00:00:02Z' } as unknown as AgentTurn);
  await click('Check saved message status'); expect(waitStatus()!.outerHTML).toBe(absent);
  await click('Check saved message status'); expect(waitStatus()!.outerHTML).toBe(absent);
  expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.explainTurn).not.toHaveBeenCalled();
 });

 it('never exposes internal assembled JSON, including an orphaned saved proposal, and avoids repeating a journaled request', async () => {
  const prompt = JSON.stringify({ selectedProposalOriginalRequest: 'Internal prior request', precedingConversation: [{ learner: 'Earlier words', mentor: 'Internal response' }], currentLearnerMessage: 'Newest words' });
  mocks.list.mockResolvedValue([{ ...unapproved, prompt }]); await render();
  expect(host.querySelector('.agentic-request-context')).toBeNull(); expect(host.textContent).not.toContain('selectedProposalOriginalRequest');
  mocks.list.mockResolvedValue([unapproved]); mocks.turns.mockResolvedValue({ items: [turn({ proposalId: proposal.id, response: { kind: 'proposal', reply: 'Here are the changes.', questions: [], proposal: unapproved } })], nextCursor: null });
  await render('phase-b'); await render();
  expect(host.querySelector('.agentic-request-context')).toBeNull(); expect(host.textContent).toContain('Here are the changes.');
 });

 it('names which of the learner’s own sentences the explanation review cited, and never its rationale', async () => {
  const cited = { ...unapproved, explanation: 'I already ran every test.', explanationAssessment: {
   adequate: false, feedback: 'A cited claim conflicts with the current proposal or recorded workflow.', questions: ['How does the cited claim compare with the current proposal?'],
   dimensions: [
    { key: 'effects', met: true, finding: 'supported', learnerEvidence: ['The handler returns the stored code.'], reasoning: 'PRIVATE-RATIONALE-SENTINEL' },
    { key: 'verification', met: false, finding: 'unsupported', learnerEvidence: ['INCIDENT-1 matched the resolved drill.'], reasoning: 'PRIVATE-RATIONALE-SENTINEL' },
    { key: 'consistency', met: false, finding: 'contradicted', learnerEvidence: ['I already ran every test.'], reasoning: 'PRIVATE-RATIONALE-SENTINEL' },
   ],
  } };
  mocks.list.mockResolvedValue([cited]); mocks.proposal.mockResolvedValue(cited);
  await render();
  expect(host.textContent).toContain('INCIDENT-1 matched the resolved drill.');
  expect(host.textContent).toContain('Not visible to this review');
  expect(host.textContent).toContain('Conflicts with the proposal or a record');
  expect(host.textContent).not.toContain('PRIVATE-RATIONALE-SENTINEL');
  expect(button('Apply this reviewed proposal').disabled).toBe(true);
 });

 // Regression guard: a stored assessment that carries no dimensions is what
 // every other fixture here renders, and it must add nothing to the card.
 it('adds no cited-sentence block to an assessment that carries no dimensions', async () => {
  mocks.list.mockResolvedValue([proposal]); await render();
  expect(host.querySelector('[data-testid="explanation-findings"]')).toBeNull();
  expect(host.textContent).toContain('All boundaries are explained.');
 });

 // The quote is read out of the whole conversation, and this panel re-renders
 // on every keystroke in the composer. Whatever it is held in, the words handed
 // to the comparison have to be the same words afterwards.
 it('hands the comparison the same request words across a keystroke', async () => {
  const asked = turn({ id: 'turn-proposal', message: 'Correct AC-2 only, change nothing else.', proposalId: proposal.id,
   response: { kind: 'proposal', reply: 'Here are the proposed files.', questions: [], proposal } });
  mocks.list.mockResolvedValue([proposal]); mocks.turns.mockResolvedValue({ items: [asked], nextCursor: null });
  await render();
  const quoted = seen.requests.at(-1);
  expect(quoted).toBe('Correct AC-2 only, change nothing else.');
  const before = seen.requests.length;
  await change(input(), 'A'); await change(input(), 'An');
  const after = seen.requests.slice(before);
  expect(after.length).toBeGreaterThan(0);
  expect(after).toEqual(after.map(() => quoted));
 });

 // A phase may hold several tasks, but this panel is not scoped to one of
 // them: a proposal is scoped to the phase's editable files and the
 // explanation that unlocks it is approved for the phase. The learner must
 // read that on screen, and without a case here the sentence can be deleted
 // with every suite still green.
 it('says on the proposal card that a proposal is approved for the phase, not for one task', async () => {
  mocks.list.mockResolvedValue([proposal]); await render();
  const card = host.querySelector('[data-testid="agentic-proposal"]')!;
  expect(card.textContent).toContain('A proposal can touch any file you can edit in this phase, and you approve it for the phase.');
 });

 // The reach is the phase's **editable** files and never the rest of it:
 // `agentic.service.ts` builds the set from `phase.files.filter(f => f.editable)`
 // and refuses anything outside it, and every TaskTrackr phase has read-only
 // files in it: 28 of the 32 in implementation. A sentence offering the whole
 // phase promises a learner something the server answers 400 to.
 it('does not offer a proposal over files the phase does not let the learner edit', async () => {
  mocks.list.mockResolvedValue([proposal]); await render();
  expect(host.querySelector('[data-testid="agentic-proposal"]')!.textContent)
   .not.toContain('any file in this phase');
 });

 // The limit is a fact about the unit of approval, so it does not stop being
 // true once the proposal has been applied, and that is the card a learner
 // comes back to.
 it('keeps the phase-wide sentence on an applied proposal', async () => {
  mocks.list.mockResolvedValue([{ ...proposal, appliedAt: '2026-09-10T01:00:00Z' }]); await render();
  expect(host.querySelector('[data-testid="agentic-proposal"]')!.textContent)
   .toContain('A proposal can touch any file you can edit in this phase, and you approve it for the phase.');
 });

});

// The step the server has reported, in fixed words, beside the seconds since
// the request was recorded. The words follow the `stage` field only; nothing is ever marked done, and no
// percentage or estimate is drawn. The ticking time sits outside the status
// sentence, so a screen reader is never handed a count.
describe('the Agentic wait steps', () => {
 const steps = () => host.querySelector<HTMLElement>('[data-testid="agentic-wait-step"]');
 const clock = (seconds: number) => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(Date.parse('2026-09-15T00:00:00Z') + seconds * 1000); };
 it('the agentic panel shows Reading your request, then Writing the proposal on stage proposing, with elapsed seconds', async () => {
  clock(4);
  const pending = turn({ status: 'pending', response: null });
  mocks.list.mockResolvedValue([unapproved]); mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null }); mocks.proposal.mockResolvedValue(unapproved);
  await render();
  expect(steps()!.querySelector('[data-testid="agentic-wait-step-name"]')!.textContent).toBe('Reading your request');
  expect(steps()!.querySelector('[data-testid="agentic-wait-elapsed"]')!.textContent).toBe('4 s');
  mocks.turn.mockResolvedValue({ ...pending, stage: 'proposing', updatedAt: '2026-09-15T00:00:05Z' });
  await click('Check saved message status');
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(steps()!.querySelector('[data-testid="agentic-wait-step-name"]')!.textContent).toBe('Writing the proposal');
  expect(steps()!.querySelector('[data-testid="agentic-wait-elapsed"]')!.textContent).toBe('7 s');
  expect(steps()!.textContent).not.toContain('Reading your request');
  expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('the explanation check shows Checking your explanation, whatever the stage', async () => {
  clock(2);
  const pending = turn({ kind: 'explain', status: 'pending', response: null, parentProposalId: proposal.id, parentProposalHash: proposal.proposalHash, stage: 'proposing' });
  mocks.list.mockResolvedValue([unapproved]); mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null }); mocks.proposal.mockResolvedValue(unapproved);
  await render();
  const shown = [...host.querySelectorAll('[data-testid="agentic-wait-step-name"]')].map(node => node.textContent);
  expect(shown.length).toBeGreaterThan(0);
  expect(new Set(shown)).toEqual(new Set(['Checking your explanation']));
 });
 it('draws no step, percentage or estimate once the turn is settled, and none while it waits', async () => {
  clock(30);
  const pending = turn({ status: 'pending', response: null });
  mocks.turns.mockResolvedValue({ items: [pending], nextCursor: null });
  await render();
  const wait = steps()!;
  expect(wait.textContent).not.toMatch(/%|about|usually|remaining|\bleft\b|estimate|\bdone\b|✓/i);
  expect(wait.querySelector('progress, [role="progressbar"], [aria-valuenow], svg')).toBeNull();
  // Never a status of its own; inside the transcript's live log only while that log is busy, which holds every change until the reply lands.
  expect(wait.closest('[role="status"]')).toBeNull();
  const live = wait.closest('[aria-live]'); expect(!live || live.getAttribute('aria-busy') === 'true').toBe(true);
  expect(waitStatus()!.querySelector('[data-testid="agentic-wait-elapsed"]')).toBeNull();
  mocks.turn.mockResolvedValue(turn({ requestId: pending.requestId, updatedAt: '2026-09-15T00:00:31Z' }));
  await click('Check saved message status');
  expect(steps()).toBeNull();
 });
});
