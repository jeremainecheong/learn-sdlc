// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_CONTRACT_JSON, CHANGE_REQUEST_JSON, EMPTY_STORY, STORY_JSON, serialiseStory, type Story } from '@learnsdlc/shared';
import type { AgentProposal } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { EXPLANATION_ROWS, ProposalCompare, changeAnchor, growToFit } from '@/components/workspace/mentor/ProposalCompare';
import type { RecordCompareProps } from '@/components/workspace/mentor/RecordCompare';
import { explainDraftKey, proposalInventory } from '@/components/workspace/mentor/proposalInventory';

/*
 * The review-and-explain dialog sizes to the window with one
 * scrolling body, the explanation starts at six rows and grows, the four
 * review dimensions sit in one row above it with the failed one open and a
 * "Show the change" that scrolls to the change it names, and the learner's
 * own draft survives closing, reopening and a reload. The gate is unchanged:
 * nothing is written into the field, and nothing is sent until Explain.
 */

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phase: mocks.phase } };
});
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

const dimension = (key: string, met: boolean, finding: string, learnerEvidence: string[] = []) => ({ key, met, finding, learnerEvidence, reasoning: 'Private rationale.' });
// A refusal: effects and verification not yet, the cited sentence naming the record and a line.
const refusal = {
  adequate: false, feedback: 'Your explanation does not yet establish what the proposed change does.', questions: ['What do the changed lines actually establish?'],
  dimensions: [
    dimension('effects', false, 'missing', ['In shared/contract/api.json the GET is added, see line 3.']),
    dimension('constraints', true, 'supported', ['This meets CR-2.']),
    dimension('verification', false, 'unsupported', ['I already ran the regression suite: 50/50 passed.']),
    dimension('consistency', true, 'supported'),
  ],
};
const recordChanges = [{ path: 'change/impact/operations', before: '', after: 'listComments\naddComment' }, { path: 'change/impact/screens', before: '', after: '#/lists/{id}' }];
const files = [{ path: API_CONTRACT_JSON, before: '{\n  "a": 1\n}\n', after: '{\n  "a": 1,\n  "b": 2\n}\n' }];
const inventory = proposalInventory({ files: { [CHANGE_REQUEST_JSON]: '{}', [API_CONTRACT_JSON]: files[0].after }, changes: recordChanges, others: files });
const record: RecordCompareProps = {
  subject: 'record', open: true, onClose: () => {}, mentorName: 'Sage', label: 'Change request', changes: recordChanges, carried: [], files,
  explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false,
  inventory, assessment: refusal,
};

let root: Root; let host: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Explain why the changes are right/ });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('room to read and write', () => {
  test('the explanation starts empty at six rows, keeps its resize handle, and grows to its text up to its limit without shrinking', async () => {
    await render(<ProposalCompare {...record} />);
    expect(EXPLANATION_ROWS).toBe(6);
    expect(field().rows).toBe(6);
    expect(field().value).toBe('');
    expect(field().className).toContain('resize-y');
    const area = document.createElement('textarea');
    area.style.maxHeight = '200px';
    document.body.append(area);
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(area, 'offsetHeight', { configurable: true, value: 102 });
    Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 150 });
    growToFit(area);
    expect(area.style.height).toBe('152px');
    Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 900 });
    growToFit(area);
    expect(area.style.height).toBe('200px');
    // Text that fits leaves a height the learner set alone.
    area.style.height = '180px';
    Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 100 });
    growToFit(area);
    expect(area.style.height).toBe('180px');
    area.remove();
  });

  test('the comparison is one scrolling body, and Side by side and Flip are both still there', async () => {
    await render(<ProposalCompare {...record} />);
    const dialog = screen.getByRole('dialog');
    const body = dialog.querySelector<HTMLElement>('[data-testid="apv-scroll"]')!;
    expect(body.classList.contains('apv-scroll')).toBe(true);
    expect(body.querySelector('.apv-cols')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Side by side' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Flip' })).toBeTruthy();
    // The actions sit in the footer after the explanation, not inside the scrolling body.
    expect(body.contains(within(dialog).getByRole('button', { name: 'Explain to unlock Apply' }))).toBe(false);
  });

  test('the four dimensions in one row, the first one not yet open with its cited sentence, the others on a press', async () => {
    await render(<ProposalCompare {...record} />);
    const row = screen.getByRole('group', { name: 'The explanation review, dimension by dimension' });
    // The long names, in the order the checks run, as the mentor's list names them.
    expect(row.textContent).toBe('What the change does: not yet; Why it meets the request: supported; What is and is not verified: not yet; Whether the claims match the proposal: supported');
    const detail = () => screen.getByTestId('apv-dimension-detail');
    expect(detail().getAttribute('data-dimension')).toBe('effects');
    expect(detail().textContent).toContain('What the change does');
    // A sentence was given under this check and did not satisfy it, so the chip asks for more.
    expect(detail().textContent).toContain('Needs more');
    expect(detail().textContent).not.toContain('Not explained yet');
    expect(within(detail()).getByText('In shared/contract/api.json the GET is added, see line 3.')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'What the change does: not yet' }).getAttribute('aria-expanded')).toBe('true');
    await act(async () => within(row).getByRole('button', { name: 'What is and is not verified: not yet' }).click());
    expect(detail().getAttribute('data-dimension')).toBe('verification');
    expect(detail().textContent).toContain('Not visible to this review');
    expect(detail().textContent).toContain('It does not mean the sentence is false.');
    // Its sentence names no file and no line, so there is nothing to show.
    expect(within(detail()).queryByRole('button', { name: 'Show the change' })).toBeNull();
    // Private reasoning is never drawn.
    expect(document.body.textContent).not.toContain('Private rationale.');
  });

  test('"Show the change" opens the file the sentence names and scrolls to the line it names', async () => {
    await render(<ProposalCompare {...record} />);
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(screen.getByRole('button', { name: /Change request, 2 changes/ }).getAttribute('aria-current')).toBe('true');
    await act(async () => within(screen.getByTestId('apv-dimension-detail')).getByRole('button', { name: 'Show the change' }).click());
    expect(screen.getByRole('button', { name: /shared\/contract\/api\.json, 2 lines/ }).getAttribute('aria-current')).toBe('true');
    expect(scroll).toHaveBeenCalledTimes(1);
    const target = scroll.mock.contexts[0] as HTMLElement;
    expect(target.tagName).toBe('TR');
    expect(target.getAttribute('data-change')).toBe('+');
    expect(target.querySelector('td')?.textContent).toBe('3');
  });

  test('without a line, the anchor is the first changed line or, for a record, the first changed field after the change', () => {
    const region = document.createElement('div');
    region.innerHTML = '<dd class="apv-was">old</dd><dd class="apv-changed">new</dd>';
    expect(changeAnchor(region)?.className).toBe('apv-changed');
    region.innerHTML = '<table><tr data-change=" "><td>1</td></tr><tr data-change="-"><td>4</td></tr><tr data-change="+"><td>9</td></tr></table>';
    expect(changeAnchor(region)?.querySelector('td')?.textContent).toBe('4');
    expect(changeAnchor(region, 9)?.querySelector('td')?.textContent).toBe('9');
    expect(changeAnchor(region, 77)?.querySelector('td')?.textContent).toBe('4');
  });

  test('opening a dimension leaves the comparison where the learner was reading', async () => {
    await render(<ProposalCompare {...record} />);
    const body = screen.getByTestId('apv-scroll');
    body.scrollTop = 140;
    await act(async () => screen.getByRole('button', { name: 'What is and is not verified: not yet' }).click());
    await act(async () => screen.getByRole('button', { name: 'Why it meets the request: supported' }).click());
    expect(screen.getByTestId('apv-scroll')).toBe(body);
    expect(body.scrollTop).toBe(140);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test('the overlay lists the file beside the record and the record by their counts', async () => {
    await render(<ProposalCompare {...record} />);
    expect(Array.from(screen.getByTestId('apv-inventory').querySelectorAll('li')).map(li => li.textContent)).toEqual([
      // Each by its room's name alone. One line edited in place and one added is two lines.
      'Change request: changed, 2 changes',
      'API contract: changed, 2 lines',
    ]);
  });
});

/* ------------- the learner's own draft, through the real panel ------------- */

const savedStory: Story = { ...EMPTY_STORY, title: 'Overdue report', persona: 'planner', capability: 'an overdue report', benefit: 'I can see what slipped',
  criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the overdue report', then: 'the task is listed', tag: 'happy' }] };
const proposedStory: Story = { ...savedStory, benefit: 'I catch what slipped before the day starts' };
const storyProposal: AgentProposal = {
  id: 'proposal-s', phaseStateId: 'phase-a', prompt: 'Sharpen the benefit.', files: { [STORY_JSON]: serialiseStory(proposedStory) },
  proposalHash: 'a'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null, createdAt: '2026-11-08T00:00:00Z',
  changes: [{ path: 'story/so-that', before: 'I can see what slipped', after: 'I catch what slipped before the day starts' }],
};
const phaseDetail = { id: 'phase-a', story: { id: 'US-4', hints: {}, floor: { minCriteria: 1, requiredTags: ['happy'], minExclusions: 0, requireSentence: true }, providedStories: [] },
  files: [{ path: STORY_JSON, content: serialiseStory(savedStory), editable: true }] };

describe('the explanation draft is kept, and only ever the learner’s own', () => {
  const renderPanel = async () => { await render(<AgenticPanel phaseId="phase-a" phaseKey="requirements" />); };
  const openCompare = async () => { await act(async () => screen.getByRole('button', { name: 'Compare before and after' }).click()); };
  beforeEach(() => {
    mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    mocks.phase.mockResolvedValue(phaseDetail);
    mocks.proposal.mockResolvedValue(storyProposal);
    mocks.list.mockResolvedValue([storyProposal]);
  });

  test('survives Flip, closing and reopening, and a reload; nothing is sent until Explain', async () => {
    await renderPanel();
    await openCompare();
    expect(field().value).toBe('');
    await act(async () => { fireEvent.change(field(), { target: { value: 'The benefit now says when the slip is caught.' } }); });
    await act(async () => screen.getByRole('button', { name: 'Flip' }).click());
    expect(field().value).toBe('The benefit now says when the slip is caught.');
    await act(async () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }).click());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sessionStorage.getItem(explainDraftKey('owner-a:phase-a', storyProposal.id))).toBe('The benefit now says when the slip is caught.');
    await openCompare();
    expect(field().value).toBe('The benefit now says when the slip is caught.');
    // A reload.
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderPanel();
    await openCompare();
    expect(field().value).toBe('The benefit now says when the slip is caught.');
    expect(mocks.explainTurn).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  test('sending empties the kept draft; a draft of one learner is never put back for another proposal', async () => {
    sessionStorage.setItem(explainDraftKey('owner-a:phase-a', 'another-proposal'), 'Not about this proposal.');
    mocks.explainTurn.mockImplementation(async (_phase, selected, message, requestId) => ({
      id: 'turn-x', phaseStateId: 'phase-a', requestId, kind: 'explain', status: 'pending', message, parentTurnId: null, parentProposalId: selected.id,
      parentProposalHash: selected.proposalHash, baseWorkspaceHash: 'b'.repeat(64), proposalId: null, response: null, errorCode: null,
      createdAt: '2026-11-08T00:01:00Z', updatedAt: '2026-11-08T00:01:00Z',
    }));
    mocks.turn.mockImplementation(() => new Promise(() => {}));
    await renderPanel();
    await openCompare();
    expect(field().value).toBe('');
    await act(async () => { fireEvent.change(field(), { target: { value: 'My own words.' } }); });
    await act(async () => screen.getByRole('button', { name: 'Explain to unlock Apply' }).click());
    expect(mocks.explainTurn).toHaveBeenCalledTimes(1);
    expect(mocks.explainTurn.mock.calls[0][2]).toBe('My own words.');
    expect(sessionStorage.getItem(explainDraftKey('owner-a:phase-a', storyProposal.id))).toBeNull();
  });
});
