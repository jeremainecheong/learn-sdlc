// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_CONTRACT_JSON, CHANGE_REQUEST_JSON, DEFAULT_DESIGN_FLOOR, DESIGN_JSON, SCREEN_CONTRACT_JSON, STORY_JSON } from '@learnsdlc/shared';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { ProposalCompare, type DesignCompareProps } from '@/components/workspace/mentor/ProposalCompare';
import { designCompareDocuments } from '@/components/workspace/panels/design/designChanges';
import {
  changedDocuments, inventoryCount, inventoryText, proposalInventory, readReceipt, receiptKey, revealTarget,
} from '@/components/workspace/mentor/proposalInventory';

/*
 * The proposal card lists every file the proposal holds with
 * its status and count, a file the request named that the proposal lacks reads
 * missing, the overlay's Apply names only what changes, and the applied card
 * keeps the counts as they were at the Apply.
 */

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phase: mocks.phase } };
});
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

// The proposal holds the three design documents, and only the record's decisions change.
const decisionChanges = [
  { path: 'design/decision-1/title', before: 'Filter in the hook', after: 'Filter and order on the API' },
  { path: 'design/decision-1/choice', after: 'Filter and order on the API; render the returned order in the browser' },
];
const threeFiles = { [DESIGN_JSON]: '{"design":2}', [API_CONTRACT_JSON]: '{"api":1}', [SCREEN_CONTRACT_JSON]: '{"screens":1}' };
const request = 'Please propose the decisions of my design record and the contracts. The API contract: operations as listed. The screen contract: #/overdue (Overdue), empty state: Nothing is overdue.';

const proposal: AgentProposal = {
  id: 'proposal-d2', phaseStateId: 'phase-d', prompt: '{"context":true}', files: threeFiles,
  proposalHash: 'c'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: 'D1 now filters on the API.', explanationAssessment: { adequate: true, feedback: 'Explained.', questions: [] }, approvedAt: '2026-11-08T00:01:00Z',
  appliedAt: null, createdAt: '2026-11-08T00:00:00Z', changes: decisionChanges, carried: [],
};
const requestTurn: AgentTurn = {
  id: 'turn-d2', phaseStateId: 'phase-d', requestId: 'request-d2', kind: 'chat', status: 'completed', message: request, parentTurnId: null,
  parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'b'.repeat(64), proposalId: proposal.id,
  response: { kind: 'proposal', reply: 'Here is the proposal.', questions: [], proposal }, errorCode: null, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z',
};
const designDetail = {
  id: 'phase-d', design: { contracts: { api: true, screens: true }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR },
  files: [{ path: DESIGN_JSON, content: '{"design":1}', editable: true }, { path: API_CONTRACT_JSON, content: '{"api":1}', editable: true }, { path: SCREEN_CONTRACT_JSON, content: '{"screens":1}', editable: true }],
};

let root: Root; let host: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const card = () => host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
const lines = (scope: ParentNode, id = 'agentic-inventory') => Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"] > li`)).map(li => li.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  mocks.turns.mockResolvedValue({ items: [requestTurn], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
  mocks.phase.mockResolvedValue(designDetail);
  mocks.proposal.mockResolvedValue(proposal);
  mocks.list.mockResolvedValue([proposal]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the inventory, counted from the proposal', () => {
  test('one changed of three: the record counted, both contracts unchanged and named as asked for', () => {
    const inventory = proposalInventory({ files: threeFiles, changes: decisionChanges, request });
    expect(inventory.map(line => inventoryText(line))).toEqual([
      'Design record (design/design.json): changed, 2 changes',
      'API contract (shared/contract/api.json): unchanged, though your request named it',
      'Screen contract (shared/contract/screens.json): unchanged, though your request named it',
    ]);
    expect(inventoryCount(inventory)).toBe('1 of 3 documents changed');
    expect(changedDocuments(inventory)).toBe(1);
  });

  test('three changed: every document counted from its own changes', () => {
    const changes = [...decisionChanges, { path: 'api/operation-1/errors', before: '', after: 'invalid_date' }, { path: 'screens/screen-1/empty', before: 'None', after: 'Nothing is overdue.' }];
    const inventory = proposalInventory({ files: threeFiles, changes });
    expect(inventory.map(line => inventoryText(line, false))).toEqual(['Design record: changed, 2 changes', 'API contract: changed, 1 change', 'Screen contract: changed, 1 change']);
    expect(inventoryCount(inventory)).toBe('3 documents');
    expect(changedDocuments(inventory)).toBe(3);
  });

  test('a document the request named and the proposal does not hold reads missing, and is not counted as held', () => {
    const files = { [DESIGN_JSON]: '{}', [SCREEN_CONTRACT_JSON]: '{}' };
    const inventory = proposalInventory({ files, changes: [...decisionChanges, { path: 'screens/screen-1/empty', after: 'Nothing is overdue.' }], request });
    expect(inventory.map(line => [line.path, line.status])).toEqual([[DESIGN_JSON, 'changed'], [SCREEN_CONTRACT_JSON, 'changed'], [API_CONTRACT_JSON, 'missing']]);
    expect(inventoryText(inventory[2])).toBe('API contract (shared/contract/api.json): asked for, not in this proposal');
    expect(inventoryCount(inventory)).toBe('2 documents, 1 missing');
    // A request that never names it asks for nothing missing.
    expect(proposalInventory({ files, changes: decisionChanges, request: 'Only the decisions, please.' }).map(line => line.status)).toEqual(['changed', 'unchanged']);
  });

  test('a file beside the record is counted by its lines once the comparison has read it, and said so until then', () => {
    const files = { [CHANGE_REQUEST_JSON]: '{}', [API_CONTRACT_JSON]: 'a\nb\nc\n', 'web/src/App.tsx': 'x\n' };
    const changes = [{ path: 'change/impact/operations', before: '', after: 'listComments' }];
    const before = proposalInventory({ files, changes });
    expect(before.map(line => inventoryText(line))).toEqual([
      'Change request (maintenance/change-request.json): changed, 1 change',
      'API contract (shared/contract/api.json): counted when you compare before and after',
      'web/src/App.tsx: counted when you compare before and after',
    ]);
    expect(inventoryCount(before)).toBe('3 documents');
    expect(changedDocuments(before)).toBeNull();
    const after = proposalInventory({ files, changes, others: [{ path: API_CONTRACT_JSON, before: 'a\nc\n', after: 'a\nb\nc\n' }] });
    expect(after.map(line => inventoryText(line))).toEqual([
      'Change request (maintenance/change-request.json): changed, 1 change',
      'API contract (shared/contract/api.json): changed, 1 line',
      'web/src/App.tsx: unchanged',
    ]);
    expect(inventoryCount(after)).toBe('2 of 3 documents changed');
  });

  test('a story proposal counts the story as the overlay does: one per criterion, however many clauses moved', () => {
    const changes = [{ path: 'story/so-that', before: 'a', after: 'b' }, { path: 'story/ac-2/given', after: 'g' }, { path: 'story/ac-2/then', after: 't' }];
    expect(proposalInventory({ files: { [STORY_JSON]: '{}' }, changes }).map(line => inventoryText(line))).toEqual(['Your story (requirements/story.json): changed, 2 changes']);
  });

  test('a finding names a file by its path, its file name or its own name, and a line by its number', () => {
    const all = [...decisionChanges, { path: 'api/operation-1/errors', after: 'invalid_date' }, { path: 'screens/screen-1/empty', after: 'Nothing is overdue.' }];
    const inventory = proposalInventory({ files: threeFiles, changes: all });
    expect(revealTarget(['In design/design.json, decision D1 changes.'], inventory)).toEqual({ path: DESIGN_JSON });
    expect(revealTarget(['The screens.json empty state stays.'], inventory)).toEqual({ path: SCREEN_CONTRACT_JSON });
    expect(revealTarget(['The API contract keeps its errors, see line 12.'], inventory)).toEqual({ path: API_CONTRACT_JSON, line: 12 });
    expect(revealTarget(['It works.'], inventory)).toBeNull();
    // A file the proposal leaves unchanged has no change to show.
    expect(revealTarget(['The API contract keeps its errors.'], proposalInventory({ files: threeFiles, changes: decisionChanges }))).toBeNull();
  });
});

describe('the proposal card and its overlay', () => {
  const renderPanel = async () => { await render(<AgenticPanel phaseId="phase-d" phaseKey="design" />); };

  test('the card lists each held file with its status and count; a changed line opens Compare at it, an unchanged one is not a button', async () => {
    await renderPanel();
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('1 of 3 documents changed');
    expect(lines(card())).toEqual([
      'Design record: changed, 2 changes',
      'API contract: unchanged, though your request named it',
      'Screen contract: unchanged, though your request named it',
    ]);
    const buttons = within(card().querySelector<HTMLElement>('[data-testid="agentic-inventory"]')!).getAllByRole('button');
    expect(buttons.map(one => one.textContent)).toEqual(['Design record: changed, 2 changes']);
    await act(async () => buttons[0].click());
    expect(mocks.phase).toHaveBeenCalledWith('phase-d');
    const dialog = within(screen.getByRole('dialog'));
    // The overlay names the unchanged contracts too, and its Apply names only the document that changes.
    expect(lines(screen.getByRole('dialog'), 'apv-inventory')).toEqual([
      'Design record: changed, 2 changes',
      'API contract: unchanged, though your request named it',
      'Screen contract: unchanged, though your request named it',
    ]);
    expect(dialog.getByRole('button', { name: 'Apply to the design record' })).toBeTruthy();
    expect(dialog.queryByRole('button', { name: /3 documents/ })).toBeNull();
  });

  test('a file the request named and the proposal lacks reads missing on the card, with the re-ask named', async () => {
    const short = { ...proposal, files: { [DESIGN_JSON]: '{}', [SCREEN_CONTRACT_JSON]: '{}' }, changes: [...decisionChanges, { path: 'screens/screen-1/empty', after: 'Nothing is overdue.' }] };
    mocks.list.mockResolvedValue([short]); mocks.proposal.mockResolvedValue(short);
    mocks.turns.mockResolvedValue({ items: [{ ...requestTurn, response: { ...requestTurn.response!, proposal: short } }], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    await renderPanel();
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('2 documents, 1 missing');
    const missing = card().querySelector<HTMLElement>('[data-inventory-status="missing"]')!;
    expect(missing.textContent).toBe('API contract: asked for, not in this proposalYour request named it, but this proposal does not hold it. To have it changed, ask for it in a new message before you explain.');
    expect(within(missing).queryByRole('button')).toBeNull();
  });

  test('the Apply label is the write set: one changed document, or every changed one, never an unchanged one', async () => {
    const gate = { open: true, onClose: () => {}, mentorName: 'Arlo', carried: [] as string[], explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false };
    const one: DesignCompareProps = { ...gate, subject: 'design', documents: designCompareDocuments(decisionChanges, { api: true, screens: true }) };
    await render(<ProposalCompare {...one} />);
    expect(screen.getByRole('button', { name: 'Apply to the design record' })).toBeTruthy();
    const all = [...decisionChanges, { path: 'api/operation-1/errors', after: 'invalid_date' }, { path: 'screens/screen-1/empty', after: 'Nothing is overdue.' }];
    await render(<ProposalCompare {...one} documents={designCompareDocuments(all, { api: true, screens: true })} />);
    expect(screen.getByRole('button', { name: 'Apply all 3 documents' })).toBeTruthy();
  });

  test('the applied card keeps the counts of the Apply, after the proposal reads empty and after a reload', async () => {
    // As the API answers once the saved documents hold the proposal: its changes read empty.
    const applied = { ...proposal, appliedAt: '2026-11-08T00:02:00Z', changes: [] };
    mocks.apply.mockResolvedValue({ proposal: applied, workspace: threeFiles });
    await renderPanel();
    await act(async () => within(card()).getByRole('button', { name: 'Compare before and after' }).click());
    await act(async () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply to the design record' }).click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    const receipt = ['Design record: changed, 2 changes', 'API contract: unchanged, though your request named it', 'Screen contract: unchanged, though your request named it'];
    expect(card().querySelector('header')!.textContent).toBe('Applied proposal1 of 3 documents changed');
    expect(card().textContent).toContain('When you applied it');
    expect(lines(card())).toEqual(receipt);
    expect(readReceipt('phase-d', proposal.id)?.map(line => line.status)).toEqual(['changed', 'unchanged', 'unchanged']);
    // A reload: the list now holds the applied proposal with empty changes, and the receipt is read back.
    await act(async () => root.unmount());
    root = createRoot(host);
    mocks.list.mockResolvedValue([applied]); mocks.proposal.mockResolvedValue(applied);
    await renderPanel();
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('1 of 3 documents changed');
    expect(lines(card())).toEqual(receipt);
    expect(card().querySelector('[data-testid="agentic-structured-summary"]')!.textContent).toBe("Applied. Your saved work holds this proposal's changes.");
    expect(card().textContent).not.toContain('This proposal changed nothing');
  });

  test('without a kept receipt, an applied card says the documents it held and never that the Apply changed nothing', async () => {
    const applied = { ...proposal, appliedAt: '2026-11-08T00:02:00Z', changes: [] };
    mocks.list.mockResolvedValue([applied]); mocks.proposal.mockResolvedValue(applied);
    expect(sessionStorage.getItem(receiptKey('phase-d', proposal.id))).toBeNull();
    await renderPanel();
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('3 documents');
    expect(card().querySelector('[data-testid="agentic-inventory"]')).toBeNull();
    expect(card().textContent).not.toContain('This proposal changed nothing');
  });
});
