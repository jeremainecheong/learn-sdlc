// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EMPTY_STORY, LEARNER_PICKS, STORY_JSON, serialiseStory, type Story } from '@learnsdlc/shared';
import type { AgentProposal } from '@/lib/api-mentor';
import { ApiError } from '@/lib/api';
import { ProposalCompare, type ProposalCompareProps } from '@/components/workspace/mentor/ProposalCompare';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { readTouched, touchedKey } from '@/components/workspace/panels/requirements/touched';

/*
 * The before/after overlay for an Agentic proposal that touches the story
 * record. The first three cases are the brief's, in this suite's tooling: the
 * web suite has no @testing-library/react or jest-dom, so it renders with
 * `createRoot` under `act` and asserts with plain matchers.
 */

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phase: mocks.phase } };
});
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

const before: Story = { ...EMPTY_STORY, id: 'US-4', title: 'Overdue', benefit: 'see what slipped' };
const after: Story = { ...before, benefit: 'chase it first', criteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'boundary' as const }] };
const base: ProposalCompareProps = {
  open: true, onClose: () => {}, mentorName: 'Mira', storyId: 'US-4', before, after, otherFiles: [],
  changes: [{ path: 'story/so-that', before: 'see what slipped', after: 'chase it first' }, { path: 'story/ac-1/given', after: 'g' }],
  explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false,
};

let root: Root; let host: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const click = async (name: string | RegExp) => { await act(async () => button(name).click()); };

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the before/after overlay', () => {
  test('shows BEFORE and AFTER with the changed field marked and Apply locked', async () => {
    await render(<ProposalCompare {...base} />);
    expect(screen.getByText(/Mira's proposal for US-4/)).toBeTruthy();
    expect(screen.getByText('BEFORE')).toBeTruthy();
    expect(screen.getByText('AFTER')).toBeTruthy();
    expect(screen.getAllByText('Changed')).toHaveLength(1);
    expect(screen.getByText('New')).toBeTruthy();
    expect(button(/Apply to US-4/).disabled).toBe(true);
    expect(screen.queryByText(/floor/i)).toBeNull();
  });

  test('names the id, the epics and the parent epic as kept, never as changes', async () => {
    const epics = [{ id: 'EP-1', title: 'Overdue work', outcome: 'Leads see slipped work' }];
    await render(<ProposalCompare {...base} before={{ ...before, epics, parentEpicId: 'EP-1' }} after={{ ...after, epics, parentEpicId: 'EP-1' }} />);
    expect(screen.getByTestId('apv-carried').textContent).toBe('Kept as you saved them: the story id US-4, 1 epic and the parent epic EP-1.');
    expect(screen.getByText(/Mira's proposal for US-4 \(2 changes\)/)).toBeTruthy();
  });

  test('a proposal with no field change says so instead of 0 changes', async () => {
    await render(<ProposalCompare {...base} after={before} changes={[]} />);
    expect(screen.getByText("Mira's proposal for US-4 (no field changes)")).toBeTruthy();
    expect(screen.queryByText(/0 changes/)).toBeNull();
    expect(screen.getByTestId('apv-carried').textContent).toBe('Kept as you saved it: the story id US-4.');
  });

  test('shows the proposal summary above the diff when one is given, and nothing otherwise', async () => {
    const summary = 'Changes the benefit and adds AC-1. Check AC-1 against the overdue boundary.';
    await render(<ProposalCompare {...base} summary={summary} />);
    const block = screen.getByTestId('agentic-compare-summary');
    expect(block.textContent).toContain('What this proposal changes');
    expect(block.textContent).toContain(summary);
    expect(block.textContent).toContain('Check it against the proposal before you explain the change in your own words.');
    // Above the diff: before the BEFORE column in document order.
    expect(block.compareDocumentPosition(screen.getByText('BEFORE')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const none of [undefined, null, '']) {
      await render(<ProposalCompare {...base} summary={none} />);
      expect(screen.queryByTestId('agentic-compare-summary')).toBeNull();
    }
    await render(<ProposalCompare subject="design" open onClose={() => {}} mentorName="Mira" documents={[]} carried={[]} explanation="" onExplanationChange={() => {}} canExplain onExplain={() => {}} canApply={false} onApply={() => {}} busy={false} summary={summary} />);
    expect(screen.getByTestId('agentic-compare-summary').textContent).toContain(summary);
  });

  test('flip view shows one column at a time', async () => {
    await render(<ProposalCompare {...base} />);
    await click('Flip');
    expect(button(/AFTER/)).toBeTruthy();
    expect(screen.getByText('see what slipped')).toBeTruthy();
    expect(screen.queryByText('chase it first')).toBeNull();
    await click(/AFTER/);
    expect(screen.getByText('chase it first')).toBeTruthy();
    expect(screen.queryByText('see what slipped')).toBeNull();
  });

  test('the rail appears only when more than one thing is touched', async () => {
    await render(<ProposalCompare {...base} />);
    expect(screen.queryByText('Touched by this proposal')).toBeNull();
    await render(<ProposalCompare {...base} otherFiles={[{ path: 'design/notes.md', after: 'x' }]} />);
    expect(screen.getByText('Touched by this proposal')).toBeTruthy();
  });

  test('the rail opens another touched file in the existing diff, and back to the story', async () => {
    await render(<ProposalCompare {...base} otherFiles={[{ path: 'design/notes.md', before: 'old line\n', after: 'new line\n' }]} />);
    const rail = screen.getByRole('navigation', { name: 'What this proposal touches' });
    await act(async () => within(rail).getByRole('button', { name: /design\/notes\.md/ }).click());
    expect(screen.queryByText('BEFORE')).toBeNull();
    expect(screen.getByRole('region', { name: 'Changed lines: design/notes.md' }).textContent).toContain('new line');
    await act(async () => within(rail).getByRole('button', { name: /US-4/ }).click());
    expect(screen.getByText('BEFORE')).toBeTruthy();
    expect(button(/Apply all/)).toBeTruthy();
  });

  test('with no saved story the BEFORE column says so in place of a story', async () => {
    await render(<ProposalCompare {...base} before={null} />);
    expect(screen.getByText('No story saved yet.')).toBeTruthy();
    expect(screen.getByText('chase it first')).toBeTruthy();
  });

  test('marks a changed field in both columns, and draws an entry whose sides only differ by absence as unchanged', async () => {
    await render(<ProposalCompare {...base} changes={[...base.changes, { path: 'story/notes', before: '' }]} />);
    const beforeColumn = screen.getByRole('region', { name: 'BEFORE' });
    const afterColumn = screen.getByRole('region', { name: 'AFTER' });
    expect(within(beforeColumn).getByText('Will change')).toBeTruthy();
    expect(within(beforeColumn).getByText('not in your story yet')).toBeTruthy();
    expect(within(afterColumn).getByText('Changed')).toBeTruthy();
    expect(within(afterColumn).queryByText('Open questions')).toBeNull();
    expect(within(beforeColumn).queryByText('Open questions')).toBeNull();
  });

  test('lists the untouched sections and shows them on request, drawn plain', async () => {
    await render(<ProposalCompare {...base} />);
    const line = screen.getByText(/Unchanged, so not shown/);
    expect(line.textContent).toContain('As a');
    expect(line.textContent).toContain('Out of scope');
    expect(screen.queryByText('Overdue')).toBeNull();
    await click('Show them');
    expect(screen.getAllByText('Overdue')).toHaveLength(2);
    expect(screen.getAllByText('Changed')).toHaveLength(1);
  });

  test('the footer holds the gate: the explanation, Explain, and Apply only once accepted', async () => {
    const onExplain = vi.fn(); const onApply = vi.fn(); const onExplanationChange = vi.fn();
    await render(<ProposalCompare {...base} onExplain={onExplain} onApply={onApply} onExplanationChange={onExplanationChange} />);
    expect(button('Explain to unlock Apply').disabled).toBe(true);
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Explain why the changes are right/ });
    await act(async () => { fireEvent.change(field, { target: { value: 'AC-1 is the boundary.' } }); });
    expect(onExplanationChange).toHaveBeenCalledWith('AC-1 is the boundary.');
    await render(<ProposalCompare {...base} explanation="AC-1 is the boundary." onExplain={onExplain} onApply={onApply} />);
    await click('Explain to unlock Apply');
    expect(onExplain).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    await render(<ProposalCompare {...base} canApply onExplain={onExplain} onApply={onApply} />);
    await click(/Apply to US-4/);
    expect(onApply).toHaveBeenCalledTimes(1);
    await render(<ProposalCompare {...base} canApply busy explanation="x" onExplain={onExplain} onApply={onApply} />);
    expect(button(/Apply to US-4/).disabled).toBe(true);
    expect(button('Explain to unlock Apply').disabled).toBe(true);
  });

  test('closes on Close and on Escape without applying', async () => {
    const onClose = vi.fn(); const onApply = vi.fn();
    await render(<ProposalCompare {...base} canApply onClose={onClose} onApply={onApply} />);
    await click('Close');
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });

  test('draws the feedback row only when there is something to say', async () => {
    await render(<ProposalCompare {...base} />);
    expect(document.querySelector('.apv-feedback')).toBeNull();
    await render(<ProposalCompare {...base} feedback={<p>Mira is reviewing your explanation.</p>} />);
    expect(document.querySelector('.apv-feedback')?.textContent).toBe('Mira is reviewing your explanation.');
  });

  test('draws nothing when closed', async () => {
    await render(<ProposalCompare {...base} open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

const savedStory: Story = { ...EMPTY_STORY, title: 'Overdue report', persona: 'planner', capability: 'an overdue report', benefit: 'I can see what slipped',
  criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the overdue report', then: 'the task is listed', tag: 'happy' }] };
const proposedStory: Story = { ...savedStory, benefit: 'I catch what slipped before the day starts',
  criteria: [...savedStory.criteria, { id: 'AC-2', given: 'a task due today', when: 'I open the overdue report', then: 'it is not listed', tag: 'boundary' }] };
const storyProposal: AgentProposal = {
  id: 'proposal-s', phaseStateId: 'phase-a', prompt: 'Add the boundary case.', files: { [STORY_JSON]: serialiseStory(proposedStory) },
  proposalHash: 'a'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null, createdAt: '2026-10-14T00:00:00Z',
  changes: [
    { path: 'story/so-that', before: 'I can see what slipped', after: 'I catch what slipped before the day starts' },
    { path: 'story/ac-2/given', after: 'a task due today' }, { path: 'story/ac-2/when', after: 'I open the overdue report' },
    { path: 'story/ac-2/then', after: 'it is not listed' }, { path: 'story/ac-2/tag', after: 'boundary' },
  ],
};
const approvedProposal: AgentProposal = { ...storyProposal, explanation: 'AC-2 is the boundary.', explanationAssessment: { adequate: true, feedback: 'The boundary is explained.', questions: [] }, approvedAt: '2026-10-14T00:01:00Z' };
const phaseDetail = { id: 'phase-a', story: { id: 'US-4', hints: {}, floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true }, providedStories: [] },
  files: [{ path: STORY_JSON, content: serialiseStory(savedStory), editable: true }] };

describe('the Agentic card for a story proposal', () => {
  const renderPanel = async () => { await render(<AgenticPanel phaseId="phase-a" phaseKey="requirements" />); };
  beforeEach(() => {
    mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    mocks.phase.mockResolvedValue(phaseDetail);
    mocks.proposal.mockResolvedValue(storyProposal);
  });

  test('offers Compare before and after in place of the file comparison, and opens the overlay from the saved record', async () => {
    mocks.list.mockResolvedValue([storyProposal]);
    await renderPanel();
    expect(screen.queryByRole('button', { name: 'Compare with saved files' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Proposed file: inspect or edit' })).toBeNull();
    const compare = button('Compare before and after');
    compare.focus();
    await act(async () => compare.click());
    expect(mocks.phase).toHaveBeenCalledWith('phase-a');
    expect(mocks.proposal).toHaveBeenCalledWith('phase-a', storyProposal.id);
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.apv-feedback')).toBeNull();
    expect(within(dialog).getByText('I can see what slipped')).toBeTruthy();
    expect(within(dialog).getByText('I catch what slipped before the day starts')).toBeTruthy();
    expect(within(dialog).getByText('New')).toBeTruthy();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: /Apply to US-4/ }).disabled).toBe(true);
    await act(async () => within(dialog).getByRole('button', { name: 'Close' }).click());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Compare before and after'));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  test('passes the proposal summary to the overlay', async () => {
    const summary = 'Changes the story benefit and adds AC-2. Check AC-2 keeps a task due today off the report.';
    mocks.list.mockResolvedValue([{ ...storyProposal, summary }]);
    mocks.proposal.mockResolvedValue({ ...storyProposal, summary });
    await renderPanel();
    await click('Compare before and after');
    expect(within(screen.getByRole('dialog')).getByTestId('agentic-compare-summary').textContent).toContain(summary);
  });

  test('the card of a pending story proposal offers only Compare before and after and Discard; the gate is the overlay', async () => {
    mocks.list.mockResolvedValue([approvedProposal]);
    await renderPanel();
    const card = within(host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!);
    // The story's inventory line opens Compare; nothing on the card explains or applies.
    // The room's document by its name alone, as the card names it once it is not pending.
    expect(card.getAllByRole('button').map(one => one.textContent)).toEqual(['Your story: changed, 2 changes', 'Compare before and after', 'Discard']);
    expect(card.queryByRole('button', { name: 'Explain this proposal' })).toBeNull();
    expect(card.queryByRole('button', { name: 'Apply this reviewed proposal' })).toBeNull();
    await act(async () => card.getByRole('button', { name: 'Discard' }).click());
    expect(host.querySelector('[data-testid="agentic-proposal"]')).toBeNull();
    expect(host.textContent).toContain('The proposal is set aside.');
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  test('sends the explanation from the overlay through the explanation call, not the chat', async () => {
    mocks.list.mockResolvedValue([storyProposal]);
    mocks.explainTurn.mockReturnValue(new Promise(() => {}));
    await renderPanel();
    await click('Compare before and after');
    const dialog = screen.getByRole('dialog');
    const field = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: /Explain why the changes are right/ });
    await act(async () => { fireEvent.change(field, { target: { value: 'AC-2 keeps a task due today off the report.' } }); });
    await act(async () => within(dialog).getByRole('button', { name: 'Explain to unlock Apply' }).click());
    expect(mocks.explainTurn).toHaveBeenCalledTimes(1);
    expect(mocks.explainTurn.mock.calls[0][1]).toMatchObject({ id: storyProposal.id, proposalHash: storyProposal.proposalHash });
    expect(mocks.explainTurn.mock.calls[0][2]).toBe('AC-2 keeps a task due today off the report.');
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/reviewing your explanation/)).toBeTruthy();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: /Apply to US-4/ }).disabled).toBe(true);
  });

  test('applies an accepted proposal from the overlay and remembers the changed fields for the form', async () => {
    mocks.list.mockResolvedValue([approvedProposal]);
    mocks.proposal.mockResolvedValue(approvedProposal);
    mocks.apply.mockResolvedValue({ proposal: { ...approvedProposal, appliedAt: '2026-10-14T00:02:00Z' }, workspace: {} });
    await renderPanel();
    await click('Compare before and after');
    const dialog = screen.getByRole('dialog');
    await act(async () => within(dialog).getByRole('button', { name: /Apply to US-4/ }).click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare before and after' })).toBeNull();
    // Focus does not fall to the page: the card takes it.
    expect(document.activeElement).toBe(host.querySelector('[data-testid="agentic-proposal"]'));
    expect(sessionStorage.getItem(touchedKey('phase-a'))).not.toBeNull();
    const marks = readTouched('phase-a');
    expect(Object.keys(marks).sort()).toEqual(['story/ac-2/given', 'story/ac-2/tag', 'story/ac-2/then', 'story/ac-2/when', 'story/so-that']);
    expect(marks['story/so-that']).toBe('I catch what slipped before the day starts');
    // A criterion is recorded whole, under each of its paths.
    expect(marks['story/ac-2/given']).toBe(JSON.stringify(['boundary', 'a task due today', 'I open the overdue report', 'it is not listed']));
    expect(marks['story/ac-2/tag']).toBe(marks['story/ac-2/given']);
  });

  test('says in the overlay why an accepted version is still locked while an explanation draft is kept', async () => {
    mocks.list.mockResolvedValue([approvedProposal]);
    mocks.proposal.mockResolvedValue(approvedProposal);
    await renderPanel();
    await click('Compare before and after');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: /Apply to US-4/ }).disabled).toBe(false);
    // Accepted with no draft, the overlay draws the accepted words read-only and no field or Explain.
    expect(within(dialog).queryByRole('textbox', { name: /Explain why the changes are right/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Explain to unlock Apply' })).toBeNull();
    expect(within(dialog).getByTestId('apv-accepted-explanation')).toBeTruthy();
    // A draft kept for this version (typed before a reload) brings the field back, holding Apply.
    await act(async () => { root.render(null); });
    sessionStorage.setItem(`learnsdlc:explain-draft:owner-a:phase-a:${approvedProposal.id}`, 'One more thought.');
    await renderPanel();
    await click('Compare before and after');
    const again = screen.getByRole('dialog');
    expect(within(again).getByRole<HTMLTextAreaElement>('textbox', { name: /Explain why the changes are right/ }).value).toBe('One more thought.');
    expect(within(again).getByRole<HTMLButtonElement>('button', { name: /Apply to US-4/ }).disabled).toBe(true);
    expect(within(again).getByText(/An explanation draft is kept/)).toBeTruthy();
    await act(async () => within(again).getByRole('button', { name: 'discard the explanation draft' }).click());
    expect(within(again).getByRole<HTMLButtonElement>('button', { name: /Apply to US-4/ }).disabled).toBe(false);
  });

  test('an unconfirmed explanation can be checked from the overlay', async () => {
    mocks.list.mockResolvedValue([storyProposal]);
    mocks.explainTurn.mockRejectedValue(new Error('The connection dropped.'));
    mocks.turn.mockRejectedValue(new Error('Still offline.'));
    await renderPanel();
    await click('Compare before and after');
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.change(within(dialog).getByRole('textbox', { name: /Explain why the changes are right/ }), { target: { value: 'AC-2 is the boundary.' } }); });
    await act(async () => within(dialog).getByRole('button', { name: 'Explain to unlock Apply' }).click());
    expect(within(dialog).getByRole('alert').textContent).toContain('Delivery could not be confirmed');
    const turnLookups = mocks.turn.mock.calls.length;
    // The server now has it: the check settles it as pending, the recovery
    // block goes away, and focus stays in the dialog rather than the page.
    mocks.turn.mockImplementation(async (_phase: string, requestId: string) => ({
      id: requestId, phaseStateId: 'phase-a', requestId, kind: 'explain', status: 'pending', message: 'AC-2 is the boundary.', parentTurnId: null,
      parentProposalId: storyProposal.id, parentProposalHash: storyProposal.proposalHash, baseWorkspaceHash: storyProposal.baseWorkspaceHash,
      proposalId: null, response: null, errorCode: null, createdAt: '2026-10-14T00:05:00Z', updatedAt: '2026-10-14T00:05:01Z',
    }));
    const check = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Check message status' });
    check.focus();
    await act(async () => check.click());
    expect(mocks.turn.mock.calls.length).toBe(turnLookups + 1);
    expect(mocks.explainTurn).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole('button', { name: 'Check message status' })).toBeNull();
    expect(within(dialog).getByText(/reviewing your explanation/)).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('retrying a failed explanation from the overlay keeps focus in the overlay, not the composer behind it', async () => {
    mocks.list.mockResolvedValue([storyProposal]);
    mocks.explainTurn.mockRejectedValueOnce(new ApiError(422, 'The explanation could not be reviewed.')).mockReturnValue(new Promise(() => {}));
    mocks.turn.mockRejectedValue(new ApiError(404, 'No such turn.'));
    await renderPanel();
    await click('Compare before and after');
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.change(within(dialog).getByRole('textbox', { name: /Explain why the changes are right/ }), { target: { value: 'AC-2 is the boundary.' } }); });
    await act(async () => within(dialog).getByRole('button', { name: 'Explain to unlock Apply' }).click());
    const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Retry this message' });
    retry.focus();
    await act(async () => retry.click());
    expect(mocks.explainTurn).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(screen.getByTestId('agentic-input'));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('a failed comparison read is forgotten once the selection changes', async () => {
    mocks.list.mockResolvedValue([storyProposal]);
    mocks.phase.mockRejectedValueOnce(new Error('The saved files could not be read.'));
    await renderPanel();
    await click('Compare before and after');
    expect(host.querySelector('[data-testid="agentic-proposal"] [role="alert"]')?.textContent).toContain('could not be loaded for the comparison');
    await click('Discard');
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Earlier proposals' }), { target: { value: storyProposal.id } }); });
    expect(button('Compare before and after')).toBeTruthy();
    expect(host.querySelector('[data-testid="agentic-proposal"] [role="alert"]')).toBeNull();
  });

  test('a story with no id yet is named "your story", never left blank', async () => {
    const unnamed = { ...storyProposal, files: { [STORY_JSON]: serialiseStory({ ...proposedStory, id: '' }) } };
    mocks.list.mockResolvedValue([unnamed]);
    mocks.proposal.mockResolvedValue(unnamed);
    mocks.phase.mockResolvedValue({ ...phaseDetail, story: { ...phaseDetail.story, id: LEARNER_PICKS }, files: [{ path: STORY_JSON, content: serialiseStory({ ...savedStory, id: '' }), editable: true }] });
    await renderPanel();
    await click('Compare before and after');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/proposal for your story \(/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Apply to your story' })).toBeTruthy();
  });

  test('an applied story proposal offers no overlay and is drawn by its changed fields, never as files', async () => {
    mocks.list.mockResolvedValue([{ ...approvedProposal, appliedAt: '2026-10-14T00:02:00Z' }]);
    await renderPanel();
    expect(screen.queryByRole('button', { name: 'Compare before and after' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare with saved files' })).toBeNull();
    expect(host.querySelector('[data-testid="agentic-structured-summary"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="agentic-proposal"] textarea')).toBeNull();
  });

  test('a story proposal superseded by a later proposal offers no overlay, and keeps the card gate', async () => {
    const later = { ...storyProposal, id: 'proposal-later', createdAt: '2026-10-14T01:00:00Z' };
    mocks.list.mockResolvedValue([later, storyProposal]);
    await renderPanel();
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Earlier proposals' }), { target: { value: storyProposal.id } }); });
    expect(host.querySelector('[data-testid="agentic-proposal"]')?.getAttribute('data-proposal-id')).toBe(storyProposal.id);
    expect(screen.queryByRole('button', { name: 'Compare before and after' })).toBeNull();
    expect(button('Explain this proposal')).toBeTruthy();
  });

  test('a story proposal overtaken by a later apply offers no overlay', async () => {
    const appliedEarlier = { ...storyProposal, id: 'proposal-applied', createdAt: '2026-10-13T00:00:00Z', appliedAt: '2026-10-14T01:00:00Z' };
    mocks.list.mockResolvedValue([storyProposal, appliedEarlier]);
    await renderPanel();
    expect(host.querySelector('[data-testid="agentic-proposal"]')?.getAttribute('data-proposal-id')).toBe(storyProposal.id);
    expect(screen.queryByRole('button', { name: 'Compare before and after' })).toBeNull();
    expect(button('Explain this proposal')).toBeTruthy();
  });

  test('a stale story proposal offers no overlay', async () => {
    mocks.list.mockResolvedValue([storyProposal]);
    mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'c'.repeat(64) });
    await renderPanel();
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Earlier proposals' }), { target: { value: storyProposal.id } }); });
    expect(screen.queryByRole('button', { name: 'Compare before and after' })).toBeNull();
    expect(button('Explain this proposal')).toBeTruthy();
    expect(button('Apply this reviewed proposal')).toBeTruthy();
  });

  test('a proposal the conversation has just produced is offered the overlay, though the workspace moved since history loaded', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.turns.mockResolvedValue({ items: [], nextCursor: null, currentWorkspaceHash: 'c'.repeat(64) });
    const fresh = { ...storyProposal, baseWorkspaceHash: 'd'.repeat(64) };
    mocks.proposal.mockResolvedValue(fresh);
    mocks.chat.mockImplementation(async (_phase: string, body: { requestId: string; message: string }) => ({
      id: 'turn-s', phaseStateId: 'phase-a', requestId: body.requestId, kind: 'chat', status: 'completed', message: body.message, parentTurnId: null, parentProposalId: null, parentProposalHash: null,
      baseWorkspaceHash: fresh.baseWorkspaceHash, proposalId: fresh.id, response: { kind: 'proposal', reply: 'Here is a boundary case.', questions: [], proposal: fresh }, errorCode: null,
      createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
    }));
    await renderPanel();
    await act(async () => { fireEvent.change(screen.getByTestId('agentic-input'), { target: { value: 'Add the boundary case.' } }); });
    await click('Send');
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(button('Compare before and after')).toBeTruthy();
  });

  test('a proposal for a phase without a story keeps the file comparison', async () => {
    mocks.list.mockResolvedValue([{ ...storyProposal, files: { 'code.ts': 'x' }, changes: undefined }]);
    await renderPanel();
    expect(button('Compare with saved files')).toBeTruthy();
    expect(button('Explain this proposal')).toBeTruthy();
    expect(button('Apply this reviewed proposal')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Proposed file: inspect or edit' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare before and after' })).toBeNull();
  });
});
