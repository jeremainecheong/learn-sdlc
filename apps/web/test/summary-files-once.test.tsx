// @vitest-environment jsdom
/**
 * "Files in this proposal" is said once.
 *
 * When a model's summary names a file the proposal does not hold, the API
 * stores the file sentence in its place (`proposalFilesSentence` in
 * apps/api/src/assistant/proposal-edits.ts): "Files in this proposal: a, b.",
 * the held paths in the proposal's own order. The card and the Compare window
 * drew it under "What this proposal changes" and then, one line down, the
 * inventory headed "Files in this proposal" listing the same files. Now a
 * summary that is exactly that sentence is not drawn where the inventory
 * right below lists every held file; where no inventory is drawn it stays, so
 * each surface says which files the proposal holds once. Any other summary
 * (the model's own words, the sentence after them, the paths in another
 * order) is drawn in full.
 *
 * The real AgenticPanel and ProposalCompare, the API stubbed.
 */
import { repoFile } from './support/paths';
import { resolve } from 'node:path';
import { act } from 'react';
import { within } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHANGE_REQUEST_JSON, DESIGN_JSON, EMPTY_STORY, STORY_JSON, type Story } from '@learnsdlc/shared';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { ProposalCompare, type DesignCompareProps, type StoryCompareProps } from '@/components/workspace/mentor/ProposalCompare';
import type { InventoryLine } from '@/components/workspace/mentor/proposalInventory';
import { PROPOSAL_FILES_LEAD, isProposalFilesSentence } from '@/components/workspace/mentor/proposalFilesSentence';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn(), phaseSummary: vi.fn(),
  project: { current: null as unknown },
}));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phase: mocks.phase, phaseSummary: mocks.phaseSummary } };
});
vi.mock('@/lib/useProject', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/useProject')>(), useProjectMaybe: () => mocks.project.current }));
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-e' }), getSession: () => ({ id: 'owner-e' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

const OVERDUE = 'web/src/lib/overdue.ts';
const SENTENCE = `Files in this proposal: ${CHANGE_REQUEST_JSON}, ${OVERDUE}.`;
const WORDS = 'Marks completed tasks as never overdue and records the change.';
const PHRASE = 'Files in this proposal';

const roomDetail = {
  id: 'phase-e', change: {},
  files: [
    { path: OVERDUE, content: 'saved\n', editable: true },
    { path: CHANGE_REQUEST_JSON, content: '{}', editable: false },
  ],
};
const recordChanges = [{ path: 'change/impact/files', before: '', after: OVERDUE }];
const TWO = { [CHANGE_REQUEST_JSON]: '{"impact":{}}', [OVERDUE]: 'export const isOverdue = () => false;\n' };
const ONE = { [CHANGE_REQUEST_JSON]: '{"impact":{}}' };
const proposalOf = (files: Record<string, string>, summary: string | null, extra: Partial<AgentProposal> = {}): AgentProposal => ({
  id: 'proposal-e1', phaseStateId: 'phase-e', prompt: '{"context":true}', files,
  proposalHash: 'c'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null, createdAt: '2026-11-17T00:00:00Z', changes: recordChanges, carried: [],
  summary,
  ...extra,
});
const turnOf = (p: AgentProposal): AgentTurn => ({
  id: 'turn-e1', phaseStateId: 'phase-e', requestId: 'request-e1', kind: 'chat', status: 'completed', message: 'Make completed tasks never overdue.', parentTurnId: null,
  parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'b'.repeat(64), proposalId: p.id,
  response: { kind: 'proposal', reply: 'Here is the proposal.', questions: [], proposal: p }, errorCode: null, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
});

let root: Root; let host: HTMLDivElement;
const card = () => host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
const cardSummary = () => card().querySelector('[data-testid="agentic-proposal-summary"] p')?.textContent ?? null;
const compareBody = () => document.querySelector<HTMLElement>('[data-testid="apv-scroll"]')!;
const compareSummary = () => compareBody().querySelector('[data-testid="agentic-compare-summary"] p')?.textContent ?? null;
const times = (text: string, words: string) => text.split(words).length - 1;
const show = async (p: AgentProposal) => {
  mocks.list.mockResolvedValue([p]); mocks.proposal.mockResolvedValue(p);
  mocks.turns.mockResolvedValue({ items: [turnOf(p)], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
  await act(async () => root.render(<AgenticPanel phaseId="phase-e" phaseKey="maintenance" />));
  await act(async () => { await Promise.resolve(); });
};
const openCompare = async () => {
  await act(async () => within(card()).getByTestId('agentic-compare').click());
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  mocks.phaseSummary.mockReturnValue(new Promise(() => {}));
  mocks.phase.mockResolvedValue(roomDetail);
  mocks.project.current = { details: { 'phase-e': roomDetail } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the recogniser is the API\'s sentence, exactly', () => {
  test('the lead and the sentence\'s shape are the API\'s own, read from its source', () => {
    const api = repoFile('apps/api/src/assistant/proposal-edits.ts');
    expect(api).toContain(`export const PROPOSAL_FILES_LEAD = '${PROPOSAL_FILES_LEAD}';`);
    expect(api).toContain('return `${PROPOSAL_FILES_LEAD}${held.join(\', \')}.`;');
  });

  test('only the whole sentence over the held paths, in their order, is recognised', () => {
    const held = [CHANGE_REQUEST_JSON, OVERDUE];
    expect(isProposalFilesSentence(SENTENCE, held)).toBe(true);
    expect(isProposalFilesSentence(`Files in this proposal: ${OVERDUE}, ${CHANGE_REQUEST_JSON}.`, held)).toBe(false);
    expect(isProposalFilesSentence(`${WORDS} ${SENTENCE}`, held)).toBe(false);
    expect(isProposalFilesSentence(`Files in this proposal: ${CHANGE_REQUEST_JSON}.`, held)).toBe(false);
    expect(isProposalFilesSentence(SENTENCE.slice(0, -1), held)).toBe(false);
    expect(isProposalFilesSentence(`${SENTENCE} `, held)).toBe(false);
    expect(isProposalFilesSentence('Files in this proposal: .', [])).toBe(false);
    expect(isProposalFilesSentence(null, held)).toBe(false);
  });
});

describe('"Files in this proposal" is said once', () => {
  test('on the card: the file sentence is left out where the inventory below lists the files', async () => {
    await show(proposalOf(TWO, SENTENCE));
    expect(cardSummary()).toBeNull();
    expect(card().querySelector('[data-testid="agentic-proposal-summary"]')).toBeNull();
    expect(times(card().textContent ?? '', PHRASE)).toBe(1);
    const listed = [...card().querySelectorAll('[data-testid="agentic-inventory"] li')].map(li => li.getAttribute('data-inventory-path'));
    expect(listed).toEqual([CHANGE_REQUEST_JSON, OVERDUE]);
    // The record is listed by its name, the file beside it by its path.
    for (const name of ['Change request', OVERDUE]) expect(card().querySelector('[data-testid="agentic-inventory"]')!.textContent).toContain(name);
  });

  test('in the Compare window: the same, under its head', async () => {
    await show(proposalOf(TWO, SENTENCE));
    await openCompare();
    expect(compareSummary()).toBeNull();
    expect(times(compareBody().textContent ?? '', PHRASE)).toBe(1);
    const inventory = compareBody().querySelector('[data-testid="apv-inventory"]')!;
    for (const name of ['Change request', OVERDUE]) expect(inventory.textContent).toContain(name);
  });

  test('a one-file Compare draws no inventory, so it keeps the sentence; the card, which lists the file, does not', async () => {
    await show(proposalOf(ONE, `Files in this proposal: ${CHANGE_REQUEST_JSON}.`));
    expect(cardSummary()).toBeNull();
    expect(times(card().textContent ?? '', PHRASE)).toBe(1);
    await openCompare();
    expect(compareBody().querySelector('[data-testid="apv-inventory"]')).toBeNull();
    expect(compareSummary()).toBe(`Files in this proposal: ${CHANGE_REQUEST_JSON}.`);
    expect(times(compareBody().textContent ?? '', PHRASE)).toBe(1);
  });

  test('the model\'s own words are drawn on the card and in Compare', async () => {
    await show(proposalOf(TWO, WORDS));
    expect(cardSummary()).toBe(WORDS);
    await openCompare();
    expect(compareSummary()).toBe(WORDS);
  });

  test('the sentence after the model\'s words is drawn', async () => {
    await show(proposalOf(TWO, `${WORDS} ${SENTENCE}`));
    expect(cardSummary()).toBe(`${WORDS} ${SENTENCE}`);
    await openCompare();
    expect(compareSummary()).toBe(`${WORDS} ${SENTENCE}`);
  });

  test('the paths in another order than the proposal holds them are not the API\'s sentence, and are drawn', async () => {
    const other = `Files in this proposal: ${OVERDUE}, ${CHANGE_REQUEST_JSON}.`;
    await show(proposalOf(TWO, other));
    expect(cardSummary()).toBe(other);
    await openCompare();
    expect(compareSummary()).toBe(other);
  });

  test('an applied proposal draws no inventory heading, so its card keeps the sentence', async () => {
    await show(proposalOf(TWO, SENTENCE, { appliedAt: '2026-11-17T01:00:00Z', approvedAt: '2026-11-17T00:30:00Z' }));
    expect(cardSummary()).toBe(SENTENCE);
    expect(times(card().textContent ?? '', PHRASE)).toBe(1);
  });

  // The API now stores the file sentence followed by its own sentence about a file the answer
  // named and the proposal does not change. Where the list is drawn, the file sentence leaves the summary and the
  // second sentence stays, so the heading is said once; where it is not, the summary is drawn whole.
  const NAMED = "The mentor's answer also named web/src/lib/overdue.test.ts; this proposal does not change it. If you wanted it changed, ask again for it.";
  test('a summary that carries the named sentence: card and Compare keep that sentence and say the heading once', async () => {
    await show(proposalOf(TWO, `${SENTENCE} ${NAMED}`));
    expect(cardSummary()).toBe(NAMED);
    expect(times(card().textContent ?? '', PHRASE)).toBe(1);
    await openCompare();
    expect(compareSummary()).toBe(NAMED);
    expect(times(compareBody().textContent ?? '', PHRASE)).toBe(1);
  });

  test('a summary that carries the named sentence on a card with no list is drawn whole', async () => {
    await show(proposalOf(TWO, `${SENTENCE} ${NAMED}`, { changes: undefined }));
    expect(cardSummary()).toBe(`${SENTENCE} ${NAMED}`);
    expect(times(card().textContent ?? '', PHRASE)).toBe(1);
  });

  test('a plain code proposal draws no inventory, so its card keeps the sentence', async () => {
    await show(proposalOf(TWO, SENTENCE, { changes: undefined }));
    expect(cardSummary()).toBe(SENTENCE);
    expect(times(card().textContent ?? '', PHRASE)).toBe(1);
  });
});

describe('each Compare window passes the held paths to its head', () => {
  const gate = { open: true, onClose: () => {}, mentorName: 'Arlo', explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false };
  const lineOf = (path: string, label: string | null): InventoryLine => ({ path, label, status: 'changed', count: 1, unit: 'line', requested: false });
  const story: Story = { ...EMPTY_STORY, id: 'US-1', title: 'Overdue', benefit: 'see what slipped' };
  const NOTES = 'web/src/notes.md';

  test('the story window: the sentence is left out under the list, and drawn without the held paths', async () => {
    const held = [STORY_JSON, NOTES];
    const sentence = `Files in this proposal: ${STORY_JSON}, ${NOTES}.`;
    const overlay: StoryCompareProps = {
      ...gate, storyId: 'US-1', before: story, after: { ...story, benefit: 'chase it first' }, changes: [{ path: 'story/so-that', before: 'see what slipped', after: 'chase it first' }],
      otherFiles: [{ path: NOTES, before: 'a\n', after: 'b\n' }], summary: sentence, inventory: [lineOf(STORY_JSON, 'Your story'), lineOf(NOTES, null)], held,
    };
    await act(async () => root.render(<ProposalCompare {...overlay} />));
    expect(compareSummary()).toBeNull();
    expect(times(compareBody().textContent ?? '', PHRASE)).toBe(1);
    await act(async () => root.render(<ProposalCompare {...overlay} held={undefined} />));
    expect(compareSummary()).toBe(sentence);
  });

  test('the design window: the same', async () => {
    const API = 'shared/contract/api.json';
    const held = [DESIGN_JSON, API];
    const sentence = `Files in this proposal: ${DESIGN_JSON}, ${API}.`;
    const overlay: DesignCompareProps = { ...gate, subject: 'design', documents: [], carried: [], summary: sentence, inventory: [lineOf(DESIGN_JSON, 'Design record'), lineOf(API, 'API contract')], held };
    await act(async () => root.render(<ProposalCompare {...overlay} />));
    expect(compareSummary()).toBeNull();
    expect(times(compareBody().textContent ?? '', PHRASE)).toBe(1);
    await act(async () => root.render(<ProposalCompare {...overlay} held={undefined} />));
    expect(compareSummary()).toBe(sentence);
  });

  test('a list that does not hold every held file keeps the sentence', async () => {
    const API = 'shared/contract/api.json';
    const sentence = `Files in this proposal: ${DESIGN_JSON}, ${API}.`;
    const overlay: DesignCompareProps = { ...gate, subject: 'design', documents: [], carried: [], summary: sentence, inventory: [lineOf(DESIGN_JSON, 'Design record'), { ...lineOf(API, 'API contract'), status: 'missing' }], held: [DESIGN_JSON, API] };
    await act(async () => root.render(<ProposalCompare {...overlay} />));
    expect(compareSummary()).toBe(sentence);
  });
});
