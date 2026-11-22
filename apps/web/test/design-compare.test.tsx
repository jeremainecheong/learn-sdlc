// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DESIGN_FLOOR, DESIGN_JSON, DESIGN_OLDER_FORMAT_ROOM, EMPTY_DESIGN, SCREEN_CONTRACT_JSON, designChangeSet, designReviewProjection, serialiseDesign, type Design,
} from '@learnsdlc/shared';
import type { AgentProposal } from '@/lib/api-mentor';
import { ProposalCompare, type DesignCompareProps } from '@/components/workspace/mentor/ProposalCompare';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { designProposalPending } from '@/components/workspace/mentor/useDesignComparison';
import { designCompareDocuments, designFieldLabel, documentOfPath } from '@/components/workspace/panels/design/designChanges';
import { isTouched, readDesignTouched, recordDesignTouched } from '@/components/workspace/panels/requirements/touched';

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phase: mocks.phase } };
});
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

/*
 * The before/after overlay for a design proposal: the brief's cases, in this
 * suite's tooling (no @testing-library/react or jest-dom, so `createRoot`
 * under `act` and plain matchers).
 */

const changes = [
  { path: 'design/operation-3/name', after: 'listTasks(listId)' },
  { path: 'design/notes', before: 'old', after: 'new' },
  { path: 'screens/screen-1/empty', after: 'Nothing is overdue. You are all caught up.' },
];
const documents = designCompareDocuments(changes, { api: true, screens: true });
const base: DesignCompareProps = {
  subject: 'design', open: true, onClose: () => {}, mentorName: 'Arlo', documents, carried: ['entity E1', 'the status of D1'],
  explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false,
};

let root: Root; let host: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('designChanges', () => {
  test('labels a path in words and groups the changes by document, record first', () => {
    expect(designFieldLabel('design/entity-2/attributes')).toBe('Entity 2, attributes');
    expect(designFieldLabel('design/decision-1/trade-off')).toBe('Decision 1, trade-off');
    expect(designFieldLabel('screens/screen-1/empty')).toBe('Screen 1, empty-state sentence');
    expect(designFieldLabel('design/notes')).toBe('Notes');
    expect(designFieldLabel('design/relation-1')).toBe('Relation 1');
    expect(designFieldLabel('design/entity-1/responsibilities')).toBe('Entity 1, responsibilities');
    expect(designFieldLabel('design/operation-2/note')).toBe('Operation 2, note');
    expect(designFieldLabel('design/decision-1/consequences')).toBe('Decision 1, consequences');
    expect(designFieldLabel('design/decision-1/superseded-by')).toBe('Decision 1, superseded by');
    expect(designFieldLabel('design/sequence')).toBe('Sequence diagram');
    expect(designFieldLabel('api/errors')).toBe('Error catalogue');
    expect(documents.map((d) => [d.label, d.changes.length])).toEqual([['Design record', 2], ['Screen contract', 1]]);
  });

  test("a contract's own keys belong to its contract, and a switched-off contract draws nothing", () => {
    expect(documentOfPath('api/document')).toBe('shared/contract/api.json');
    expect(documentOfPath('screens/document')).toBe('shared/contract/screens.json');
    expect(designFieldLabel('api/document')).toBe('The contract itself');
    expect(designFieldLabel('screens/document')).toBe('The contract itself');
    const off = designCompareDocuments([...changes, { path: 'api/document', before: '{"base":"/api"}', after: '{"base":"/v2"}' }], { api: true, screens: false });
    expect(off.map((d) => [d.label, d.changes.length])).toEqual([['Design record', 2], ['API contract', 1]]);
  });
});

describe('the design overlay', () => {
  test('rails the touched documents, names the next one and applies them all', async () => {
    await render(<ProposalCompare {...base} />);
    // Over several documents the title says the card's total in the card's noun.
    expect(screen.getByText(/Arlo's proposal for your design \(2 documents\)/)).toBeTruthy();
    expect(screen.getByText('Touched by this proposal')).toBeTruthy();
    expect(button(/Design record/).textContent).toContain('2 changes');
    expect(button(/^Screen contract/).textContent).toContain('1 change');
    expect(button('Next: Screen contract')).toBeTruthy();
    expect(button('Apply all 2 documents').disabled).toBe(true);
    expect(screen.getByTestId('apv-carried').textContent).toBe('Kept as you saved them: entity E1 and the status of D1.');
    expect(screen.queryByText(/floor/i)).toBeNull();
    expect(document.body.textContent).not.toContain('·');
  });

  test('shows BEFORE and AFTER for the selected document, and flips', async () => {
    await render(<ProposalCompare {...base} />);
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.getByText('new')).toBeTruthy();
    // an added field: nothing on the BEFORE side, marked New on the AFTER side
    expect(screen.getByText('listTasks(listId)')).toBeTruthy();
    expect(screen.getByText('not in your design yet')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    await act(async () => { fireEvent.click(button('Next: Screen contract')); });
    expect(screen.getByText('Nothing is overdue. You are all caught up.')).toBeTruthy();
    expect(button(/^Screen contract/).getAttribute('aria-current')).toBe('true');
    expect(button('Next: Design record')).toBeTruthy();
    await act(async () => { fireEvent.click(button('Flip')); });
    expect(button(/AFTER/)).toBeTruthy();
    await act(async () => { fireEvent.click(button(/AFTER/)); });
    expect(screen.getByText('Nothing is overdue. You are all caught up.')).toBeTruthy();
  });

  test('an id that is the name in other case and punctuation is not shown; one that differs more stays', async () => {
    const named = designCompareDocuments([
      { path: 'design/entity-1/name', after: 'Task Item (task-item)' },
      { path: 'design/operation-1/name', after: 'is-overdue: isOverdue(task, today)' },
      { path: 'design/operation-2/name', after: 'O3: getOverdue(today)' },
      { path: 'design/relation-1', after: 'Task Item (task_item) uses List (E2)' },
    ], { api: false, screens: false });
    await render(<ProposalCompare {...base} documents={named} carried={[]} />);
    const text = document.body.textContent ?? '';
    expect(screen.getByText('Task Item')).toBeTruthy();
    expect(screen.getByText('isOverdue(task, today)')).toBeTruthy();
    expect(screen.getByText('O3: getOverdue(today)')).toBeTruthy();
    expect(screen.getByText('Task Item uses List (E2)')).toBeTruthy();
    expect(text).not.toContain('is-overdue');
    expect(text).not.toContain('task-item');
    expect(text).not.toContain('task_item');
  });

  test('one document: no rail, and Apply names it', async () => {
    await render(<ProposalCompare {...base} documents={designCompareDocuments([changes[1]], { api: true, screens: true })} carried={['entity E1']} />);
    expect(screen.queryByText('Touched by this proposal')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Next:/ })).toBeNull();
    expect(button('Apply to the design record')).toBeTruthy();
    expect(screen.getByTestId('apv-carried').textContent).toBe('Kept as you saved it: entity E1.');
  });

  test('a removed field reads as removed, and the gate forwards Explain and Apply', async () => {
    let explained = 0; let applied = 0;
    const removed = designCompareDocuments([{ path: 'design/operation-2/returns', before: 'the tasks' }], { api: true, screens: false });
    await render(<ProposalCompare {...base} documents={removed} explanation="Because." canApply onExplain={() => { explained += 1; }} onApply={() => { applied += 1; }} />);
    expect(screen.getAllByText('Operation 2, returns')).toHaveLength(2);
    expect(screen.getByText('Removed')).toBeTruthy();
    await act(async () => { fireEvent.click(button('Explain to unlock Apply')); fireEvent.click(button('Apply to the design record')); });
    expect([explained, applied]).toEqual([1, 1]);
  });
});

/* ------------------------- the Agentic card for a design ------------------------- */

const op = (id: string, name: string) => ({ id, name, inputs: ['listId'], returns: 'the tasks', errors: [], satisfies: ['US-3'] });
const savedDesign: Design = { ...EMPTY_DESIGN, operations: [op('O1', 'listTasks(listId)'), op('O2', 'completeTask(id)')], notes: 'old' };
// the proposal removes O1 and adds O3: in the change set O3 is operation 3 (after the saved two), in the applied record operation 2
const proposedDesign: Design = { ...savedDesign, operations: [op('O2', 'completeTask(id)'), op('O3', 'getOverdue(today)')], notes: 'new' };
const savedScreens = '{\n  "screens": [\n    { "route": "#/overdue", "title": "Overdue" }\n  ]\n}\n';
const proposedScreens = '{\n  "screens": [\n    { "route": "#/overdue", "title": "Overdue", "empty": "Nothing is overdue. You are all caught up." }\n  ]\n}\n';
const switches = { contracts: { api: false, screens: true }, sequence: false };
const saved = { [DESIGN_JSON]: serialiseDesign(savedDesign), [SCREEN_CONTRACT_JSON]: savedScreens };
const proposedFiles = { [DESIGN_JSON]: serialiseDesign(proposedDesign), [SCREEN_CONTRACT_JSON]: proposedScreens };
const designProposal: AgentProposal = {
  id: 'proposal-d', phaseStateId: 'phase-d', prompt: 'Add the overdue report.', files: proposedFiles,
  proposalHash: 'c'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: 'O3 reports what slipped.', explanationAssessment: { adequate: true, feedback: 'Explained.', questions: [] }, approvedAt: '2026-10-15T00:01:00Z',
  appliedAt: null, createdAt: '2026-10-15T00:00:00Z',
  changes: designChangeSet(saved, proposedFiles, switches),
  // the API keeps only the ids the proposal still holds
  carried: ['operation O2'],
};
const designDetail = {
  id: 'phase-d', design: { ...switches, stories: [], floor: DEFAULT_DESIGN_FLOOR },
  files: [{ path: DESIGN_JSON, content: saved[DESIGN_JSON], editable: true }, { path: SCREEN_CONTRACT_JSON, content: savedScreens, editable: true }],
};

describe('the Agentic card for a design proposal', () => {
  const renderPanel = async () => { await render(<AgenticPanel phaseId="phase-d" phaseKey="design" />); };
  beforeEach(() => {
    mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    mocks.phase.mockResolvedValue(designDetail);
    mocks.proposal.mockResolvedValue(designProposal);
    mocks.list.mockResolvedValue([designProposal]);
  });

  test('a design proposal still to decide on is pending; an applied or a stale one is not', () => {
    expect(designProposalPending(designProposal, [designProposal], 'b'.repeat(64))).toBe(true);
    expect(designProposalPending({ ...designProposal, appliedAt: '2026-10-15T00:02:00Z' }, [], null)).toBe(false);
    expect(designProposalPending(designProposal, [], 'e'.repeat(64))).toBe(false);
    expect(designProposalPending({ ...designProposal, files: { 'notes.md': 'x' } }, [], null)).toBe(false);
  });

  test('a phase still in the older format says so when the comparison is asked for, and opens no overlay', async () => {
    mocks.phase.mockResolvedValue({ ...designDetail, design: undefined });
    await renderPanel();
    await act(async () => button('Compare before and after').click());
    expect(screen.queryByRole('dialog')).toBeNull();
    const card = within(host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!);
    expect(card.getByRole('alert').textContent).toBe(DESIGN_OLDER_FORMAT_ROOM);
  });

  test('offers Compare before and after, opens the overlay over both touched documents, and applies them all', async () => {
    mocks.apply.mockResolvedValue({ proposal: { ...designProposal, appliedAt: '2026-10-15T00:02:00Z' }, workspace: proposedFiles });
    await renderPanel();
    const card = within(host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!);
    // The two changed documents' inventory lines open Compare at their document; the gate stays in the overlay.
    expect(card.getAllByRole('button').map(one => one.textContent)).toEqual(['Design record: changed, 9 changes', 'Screen contract: changed, 1 change', 'Compare before and after', 'Discard']);
    expect(host.querySelector('[data-testid="agentic-compare"]')).toBeTruthy();
    expect(card.getByText(/Applying saves your design/)).toBeTruthy();
    await act(async () => button('Compare before and after').click());
    expect(mocks.phase).toHaveBeenCalledWith('phase-d');
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByTestId('apv-carried').textContent).toBe('Kept as you saved it: operation O2.');
    expect(dialog.getByText('Touched by this proposal')).toBeTruthy();
    // the removed O1 and the added O3, each read whole from its own sides and marked as what happens to it
    expect(dialog.getByText('O1: listTasks(listId)')).toBeTruthy();
    expect(dialog.getByText('O3: getOverdue(today)')).toBeTruthy();
    const row = (side: RegExp, label: string) => within(dialog.getByRole('region', { name: side })).getByText(label).closest('.apv-row')!.textContent;
    expect(row(/AFTER/, 'Operation 1, name')).toBe('Operation 1, nameRemovedremoved by this proposal');
    expect(row(/BEFORE/, 'Operation 1, name')).toBe('Operation 1, nameWill be removedO1: listTasks(listId)');
    expect(row(/AFTER/, 'Operation 3, name')).toBe('Operation 3, nameNewO3: getOverdue(today)');
    expect(row(/BEFORE/, 'Operation 3, name')).toBe('Operation 3, namenot in your design yet');
    expect(dialog.getByRole('button', { name: 'Next: Screen contract' })).toBeTruthy();
    await act(async () => dialog.getByRole('button', { name: 'Apply all 2 documents' }).click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    // the room marks each field the assistant wrote, where the applied record holds it
    const marks = readDesignTouched('phase-d');
    expect(marks['design/operation-2/name']).toBe('O3: getOverdue(today)');
    expect(marks['design/operation-3/name']).toBeUndefined();
    expect(marks['design/notes']).toBe('new');
    expect(marks['screens/screen-1/empty']).toBe('Nothing is overdue. You are all caught up.');
  });
});

describe('a superseded design proposal applied from its card (Task 11 fix 1)', () => {
  test('reads the saved documents itself and marks the fields it wrote', async () => {
    mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    mocks.phase.mockResolvedValue(designDetail);
    const later = { ...designProposal, id: 'proposal-later', createdAt: '2026-10-15T01:00:00Z', approvedAt: null };
    mocks.list.mockResolvedValue([later, designProposal]); mocks.proposal.mockResolvedValue(designProposal);
    mocks.apply.mockResolvedValue({ proposal: { ...designProposal, appliedAt: '2026-10-15T00:02:00Z' }, workspace: proposedFiles });
    await render(<AgenticPanel phaseId="phase-d" phaseKey="design" />);
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Earlier proposals' }), { target: { value: designProposal.id } }); });
    await act(async () => button('Apply this reviewed proposal').click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.phase).toHaveBeenCalledWith('phase-d');
    expect(readDesignTouched('phase-d')['design/notes']).toBe('new');
  });
});

/* ---------- a structured proposal that is not pending is never drawn as files ---------- */
describe('the Agentic card for a structured proposal that is no longer pending', () => {
  const noFiles = (card: HTMLElement) => {
    expect(card.querySelector('textarea')).toBeNull();
    expect(card.querySelector('summary')?.textContent ?? '').not.toMatch(/\//);
    expect(card.textContent).not.toMatch(/\.json|\.md\b/);
  };
  beforeEach(() => { mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) }); mocks.phase.mockResolvedValue(designDetail); });

  test('an applied design proposal shows its documents by name and the fields it changed', async () => {
    const applied = { ...designProposal, appliedAt: '2026-10-15T00:02:00Z' };
    mocks.list.mockResolvedValue([applied]); mocks.proposal.mockResolvedValue(applied);
    await render(<AgenticPanel phaseId="phase-d" phaseKey="design" />);
    const card = host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
    noFiles(card);
    const summary = within(card.querySelector<HTMLElement>('[data-testid="agentic-structured-summary"]')!);
    expect(summary.getByRole('region', { name: 'Design record' })).toBeTruthy();
    expect(summary.getByRole('region', { name: 'Screen contract' })).toBeTruthy();
    expect(summary.getByText('Changed: Notes')).toBeTruthy();
    expect(card.textContent).toContain('2 documents');
  });

  test('a superseded story proposal shows the story and its changed sections, no path and no textarea', async () => {
    const story: AgentProposal = { ...designProposal, id: 'proposal-s', approvedAt: null, files: { 'requirements/story.json': '{}' },
      changes: [{ path: 'story/title', before: 'Old', after: 'New' }, { path: 'story/ac-2/then', after: 'it is listed' }], carried: [] };
    const later = { ...story, id: 'proposal-later', createdAt: '2026-10-15T01:00:00Z' };
    mocks.list.mockResolvedValue([later, story]); mocks.proposal.mockResolvedValue(story);
    await render(<AgenticPanel phaseId="phase-r" phaseKey="requirements" />);
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Earlier proposals' }), { target: { value: story.id } }); });
    const card = host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
    noFiles(card);
    const summary = within(card.querySelector<HTMLElement>('[data-testid="agentic-structured-summary"]')!);
    expect(summary.getByRole('region', { name: 'Your story' })).toBeTruthy();
    expect(summary.getByText('Changed: Title')).toBeTruthy();
    expect(summary.getByText('Added: Acceptance criterion 2, then')).toBeTruthy();
  });

  /*
   * The server measures `changes` against the saved work at
   * every read, so an applied proposal read again (a reload, Saved proposals, a
   * repeat Apply) has nothing left to diff. Its card says it is applied, never
   * that it changed nothing; an unapplied proposal with nothing to diff keeps
   * the old sentence. The test id stays and the copy names no file.
   */
  const NOTHING = 'This proposal changed nothing in your saved work.';
  const APPLIED = "Applied. Your saved work holds this proposal's changes.";
  test('an applied design proposal read again with nothing left to diff says it is applied, not that it changed nothing', async () => {
    const applied = { ...designProposal, appliedAt: '2026-10-15T00:02:00Z', changes: [] };
    mocks.list.mockResolvedValue([applied]); mocks.proposal.mockResolvedValue(applied);
    await render(<AgenticPanel phaseId="phase-d" phaseKey="design" />);
    const card = host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
    noFiles(card);
    const summary = card.querySelector<HTMLElement>('[data-testid="agentic-structured-summary"]')!;
    expect(summary.textContent).toBe(APPLIED);
    expect(card.textContent).not.toContain(NOTHING);
    expect(card.textContent).toContain('Applied proposal');
  });

  test('an applied story proposal read again with nothing left to diff says it is applied, with no empty story group', async () => {
    const story: AgentProposal = { ...designProposal, id: 'proposal-s', appliedAt: '2026-10-15T00:02:00Z', files: { 'requirements/story.json': '{}' }, changes: [], carried: [] };
    mocks.list.mockResolvedValue([story]); mocks.proposal.mockResolvedValue(story);
    await render(<AgenticPanel phaseId="phase-r" phaseKey="requirements" />);
    const card = host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
    noFiles(card);
    const summary = card.querySelector<HTMLElement>('[data-testid="agentic-structured-summary"]')!;
    expect(summary.textContent).toBe(APPLIED);
    expect(within(card).queryByRole('region', { name: 'Your story' })).toBeNull();
  });

  test('an unapplied (superseded) design proposal with nothing to diff says there is nothing to compare', async () => {
    const older = { ...designProposal, changes: [] }; // approved, never applied
    const later = { ...designProposal, id: 'proposal-later', createdAt: '2026-10-15T01:00:00Z' };
    mocks.list.mockResolvedValue([later, older]); mocks.proposal.mockResolvedValue(older);
    await render(<AgenticPanel phaseId="phase-d" phaseKey="design" />);
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Earlier proposals' }), { target: { value: older.id } }); });
    const card = host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
    noFiles(card);
    const summary = card.querySelector<HTMLElement>('[data-testid="agentic-structured-summary"]')!;
    expect(summary.textContent).toBe(NOTHING);
    expect(card.textContent).not.toContain(APPLIED);
    expect(card.textContent).toContain('Proposed changes');
  });
});

/* ------------------- the assistant's marks, matched by item id ------------------- */

describe("the assistant's marks on a design", () => {
  const all = { contracts: { api: true, screens: true }, sequence: true };
  const four = (id: string, returns: string) => ({ id, name: `${id.toLowerCase()}()`, inputs: [], returns, errors: [], satisfies: ['US-3'] });
  const savedFour = { [DESIGN_JSON]: serialiseDesign({ ...EMPTY_DESIGN, operations: [four('O1', 'Task'), four('O2', 'Task'), four('O3', 'Task'), four('O4', 'Task[]')] }) };
  // the proposal removes O1 and sets O3's returns to what O4 already returns
  const appliedFour = { [DESIGN_JSON]: serialiseDesign({ ...EMPTY_DESIGN, operations: [four('O2', 'Task'), four('O3', 'Task[]'), four('O4', 'Task[]')] }) };
  const projection = designReviewProjection(appliedFour, all);

  test("marks O3's returns where the applied record holds O3, never O4 at the change's own number", () => {
    const changes = designChangeSet(savedFour, appliedFour, all);
    expect(changes).toContainEqual({ path: 'design/operation-3/returns', before: 'Task', after: 'Task[]' });
    recordDesignTouched('phase-m', changes, savedFour, appliedFour);
    const marks = readDesignTouched('phase-m');
    // in the applied record O3 is operation 2 and O4 is operation 3
    expect(projection['design/operation-2/name']).toBe('O3: o3()');
    expect(isTouched(marks, projection, 'design/operation-2/returns')).toBe(true);
    expect(isTouched(marks, projection, 'design/operation-3/returns')).toBe(false);
    expect(Object.keys(marks)).toEqual(['design/operation-2/returns']);
  });

  test("an earlier mark follows its item, and a removed item's mark goes with it", () => {
    // marks an earlier apply left, numbered by the saved record: O1's name and O4's returns
    sessionStorage.setItem('learnsdlc:touched:phase-m', JSON.stringify({ 'design/operation-1/name': 'O1: o1()', 'design/operation-4/returns': 'Task[]', 'design/notes': 'kept' }));
    recordDesignTouched('phase-m', designChangeSet(savedFour, appliedFour, all), savedFour, appliedFour);
    expect(readDesignTouched('phase-m')).toEqual({ 'design/operation-2/returns': 'Task[]', 'design/operation-3/returns': 'Task[]', 'design/notes': 'kept' });
  });

  test("a change that empties a field clears that item's mark at its applied number, and leaves the others", () => {
    const noted = (id: string, note: string) => ({ ...four(id, 'Task'), note });
    const saved = { [DESIGN_JSON]: serialiseDesign({ ...EMPTY_DESIGN, operations: [four('O1', 'Task'), noted('O2', 'ordering: newest first'), noted('O3', 'boundary: today')] }) };
    // O1 removed and O3's note emptied: O2 is operation 1 in the applied record, O3 operation 2
    const applied = { [DESIGN_JSON]: serialiseDesign({ ...EMPTY_DESIGN, operations: [noted('O2', 'ordering: newest first'), four('O3', 'Task')] }) };
    sessionStorage.setItem('learnsdlc:touched:phase-m', JSON.stringify({ 'design/operation-2/note': 'ordering: newest first', 'design/operation-3/note': 'boundary: today' }));
    recordDesignTouched('phase-m', designChangeSet(saved, applied, all), saved, applied);
    expect(readDesignTouched('phase-m')).toEqual({ 'design/operation-1/note': 'ordering: newest first' });
  });
});
