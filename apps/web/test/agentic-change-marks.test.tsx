// @vitest-environment jsdom
/**
 * The Apply records the change room's and the Runbook tab's "changed by the
 * assistant" marks (spec 5.4), and only after the Apply has landed.
 *
 * A record proposal (runbook or change request) is read as one before the
 * design test: a proposal that also edits `shared/contract/api.json`
 * (TaskTrackr's AC-7 asks for that edit) would otherwise read as a design
 * proposal, be offered the design comparison, record Design marks and none in
 * its own room. A pending record proposal is explained and applied in the
 * record comparison; a superseded one from its card.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, getByRole, screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseChangeRequest, serialiseRunbook } from '@learnsdlc/shared';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { AGENT_APPLIED, type AgentAppliedDetail } from '@/components/workspace/mentor/useAgentWorkspace';
import { readChangeTouched } from '@/components/workspace/panels/maintenance/change-edit';
import { readRunbookTouched, recordRunbookTouched } from '@/components/workspace/panels/deployment/runbook-edit';
import { announceRoomUnsaved } from '@/components/workspace/mentor/roomUnsaved';
import { readDesignTouched } from '@/components/workspace/panels/requirements/touched';

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, api: { ...real.api, phase: mocks.phase } };
});
vi.mock('@/lib/session', async (original) => ({ ...(await original<typeof import('@/lib/session')>()), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

const PHASE = 'phase-a';
const API_JSON = 'shared/contract/api.json';
const SAVED = serialiseChangeRequest(EMPTY_CHANGE_REQUEST);
const APPLIED = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, version: '2.1.0' } });

const proposalOf = (files: Record<string, string>): AgentProposal => ({
  id: 'proposal-a', phaseStateId: PHASE, prompt: 'Record the release.', files,
  changes: [{ path: 'change/release/version', after: '2.1.0' }],
  proposalHash: 'a'.repeat(64), baseWorkspaceHash: 'b'.repeat(64),
  assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: 'The release is 2.1.0.', explanationAssessment: { adequate: true, feedback: 'Explained.', questions: [] },
  approvedAt: '2026-10-16T00:00:00Z', appliedAt: null, createdAt: '2026-10-16T00:00:00Z',
} as AgentProposal);

let root: Root;
let host: HTMLDivElement;
// The workspace that takes the applied files, as the IDE's listener does.
const applied = (event: Event) => (event as CustomEvent<AgentAppliedDetail>).detail.waitUntil(Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.turns.mockResolvedValue({ items: [], nextCursor: null });
  mocks.phase.mockResolvedValue({ id: PHASE, change: {}, files: [{ path: CHANGE_REQUEST_JSON, content: SAVED, editable: true }] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  window.addEventListener(AGENT_APPLIED, applied);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.removeEventListener(AGENT_APPLIED, applied);
});

async function renderWith(proposal: AgentProposal, rows: AgentProposal[], result: () => Promise<unknown>) {
  mocks.list.mockResolvedValue(rows);
  mocks.proposal.mockResolvedValue(proposal);
  mocks.apply.mockImplementation(result);
  await act(async () => root.render(<AgenticPanel phaseId={PHASE} phaseKey="maintenance" />));
}
/** A pending record proposal: Compare before and after opens the record comparison, whose Apply is pressed. */
async function applyInComparison(proposal: AgentProposal, result: () => Promise<unknown>) {
  await renderWith(proposal, [proposal], result);
  // the card offers the comparison, never its own Apply, while the proposal is pending
  expect(within(host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!).queryByRole('button', { name: 'Apply this reviewed proposal' })).toBeNull();
  await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name: 'Compare before and after' }).click());
  const dialog = within(screen.getByRole('dialog'));
  await act(async () => dialog.getByRole<HTMLButtonElement>('button', { name: /^Apply (to the|all)/ }).click());
}
/** A superseded record proposal, chosen among the earlier ones and applied from its card. */
async function applyFromCard(proposal: AgentProposal, result: () => Promise<unknown>) {
  const later = { ...proposal, id: 'proposal-later', createdAt: '2026-10-16T01:00:00Z', approvedAt: null } as AgentProposal;
  await renderWith(proposal, [later, proposal], result);
  await act(async () => { const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Earlier proposals' }); select.value = proposal.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name: 'Apply this reviewed proposal' }).click());
}

describe('the change room marks recorded at Apply', () => {
  it('marks the field an applied change-request proposal wrote, against the saved record the comparison read', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED });
    await applyInComparison(proposal, async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED } }));
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, proposal);
    expect(readChangeTouched(PHASE)).toEqual({ 'release:version': '2.1.0' });
  });

  it('a change-request proposal that also edits shared/contract/api.json records its change marks, and no Design marks', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED, [API_JSON]: '{"paths":{}}\n' });
    await applyInComparison(proposal, async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED, [API_JSON]: '{"paths":{}}\n' } }));
    expect(readChangeTouched(PHASE)).toEqual({ 'release:version': '2.1.0' });
    expect(readDesignTouched(PHASE)).toEqual({});
    // One read of the saved record, the comparison's, and no second read for a design comparison.
    expect(mocks.phase).toHaveBeenCalledTimes(1);
  });

  it('a superseded change-request proposal applied from its card reads the saved record itself and marks the field', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED, [API_JSON]: '{"paths":{}}\n' });
    await applyFromCard(proposal, async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED } }));
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, proposal);
    expect(mocks.phase).toHaveBeenCalledTimes(1);
    expect(readChangeTouched(PHASE)).toEqual({ 'release:version': '2.1.0' });
    expect(readDesignTouched(PHASE)).toEqual({});
  });

  it('records no mark when the Apply is refused', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED });
    await applyInComparison(proposal, async () => { throw new Error('The proposal could not be applied.'); });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(readChangeTouched(PHASE)).toEqual({});
  });
});

describe('the Runbook tab marks recorded at Apply, before the design test', () => {
  const SAVED_RUNBOOK = serialiseRunbook(EMPTY_RUNBOOK);
  const APPLIED_RUNBOOK = serialiseRunbook({ ...EMPTY_RUNBOOK, notes: 'Watch the port.' });
  const runbookProposal = (files: Record<string, string>): AgentProposal => ({
    ...proposalOf(files), prompt: 'Add a note.', changes: [{ path: 'runbook/notes', before: '', after: 'Watch the port.' }],
  });
  beforeEach(() => {
    mocks.phase.mockResolvedValue({ id: PHASE, runbook: {}, files: [{ path: RUNBOOK_JSON, content: SAVED_RUNBOOK, editable: true }] });
  });

  it('a runbook proposal that also edits shared/contract/api.json records its runbook marks, and no Design marks', async () => {
    const files = { [RUNBOOK_JSON]: APPLIED_RUNBOOK, [API_JSON]: '{"paths":{}}\n' };
    const proposal = runbookProposal(files);
    await applyInComparison(proposal, async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: files }));
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, proposal);
    expect(readRunbookTouched(PHASE)).toEqual({ notes: 'Watch the port.' });
    expect(readDesignTouched(PHASE)).toEqual({});
    expect(mocks.phase).toHaveBeenCalledTimes(1);
  });

  it('a superseded runbook proposal that also edits the API contract, applied from its card, records runbook marks and no Design marks', async () => {
    const files = { [RUNBOOK_JSON]: APPLIED_RUNBOOK, [API_JSON]: '{"paths":{}}\n' };
    const proposal = runbookProposal(files);
    await applyFromCard(proposal, async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: files }));
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, proposal);
    expect(mocks.phase).toHaveBeenCalledTimes(1);
    expect(readRunbookTouched(PHASE)).toEqual({ notes: 'Watch the port.' });
    expect(readDesignTouched(PHASE)).toEqual({});
  });

  it('offers either record proposal that also edits the API contract its record, never the design comparison', async () => {
    for (const [record, text, word] of [[RUNBOOK_JSON, APPLIED_RUNBOOK, 'runbook'], [CHANGE_REQUEST_JSON, APPLIED, 'change request']] as const) {
      const proposal = proposalOf({ [record]: text, [API_JSON]: '{"paths":{}}\n' });
      mocks.list.mockResolvedValue([proposal]);
      mocks.proposal.mockResolvedValue(proposal);
      await act(async () => root.render(<AgenticPanel key={record} phaseId={PHASE} phaseKey={record === RUNBOOK_JSON ? 'deployment' : 'maintenance'} />));
      expect(host.textContent).toContain(`Applying saves your ${word}; it does not submit or pass the phase.`);
      expect(host.textContent).not.toContain('Applying saves your design');
    }
  });

  it('a second runbook Apply keeps the marks an earlier Apply recorded, as the change room does', async () => {
    recordRunbookTouched(PHASE, { 'incident:fix': 'Restart the worker.' });
    const files = { [RUNBOOK_JSON]: APPLIED_RUNBOOK };
    const proposal = runbookProposal(files);
    await applyInComparison(proposal, async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: files }));
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, proposal);
    expect(readRunbookTouched(PHASE)).toEqual({ 'incident:fix': 'Restart the worker.', notes: 'Watch the port.' });
  });

  it('records no runbook mark when the Apply is refused', async () => {
    const proposal = runbookProposal({ [RUNBOOK_JSON]: APPLIED_RUNBOOK });
    await applyInComparison(proposal, async () => { throw new Error('The proposal could not be applied.'); });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(readRunbookTouched(PHASE)).toEqual({});
  });
});

describe('a change-request proposal\'s Apply waits while the change room holds an unsaved edit', () => {
  afterEach(() => announceRoomUnsaved(PHASE, false));

  it('is held, with its sentence, until the room says its edit is saved, and only then applies on a press', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED });
    await renderWith(proposal, [proposal], async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED } }));
    await act(async () => announceRoomUnsaved(PHASE, true));
    expect(host.textContent).toContain('Apply waits until your last edit is saved.');
    await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name: 'Compare before and after' }).click());
    const apply = within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: /^Apply (to the|all)/ });
    expect(apply.disabled).toBe(true);
    await act(async () => apply.click());
    expect(mocks.apply).not.toHaveBeenCalled();
    // The room's save lands: Apply is offered again, and nothing was applied on its own.
    await act(async () => announceRoomUnsaved(PHASE, false));
    expect(host.textContent).not.toContain('Apply waits until your last edit is saved.');
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(apply.disabled).toBe(false);
    await act(async () => apply.click());
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, proposal);
  });
});

describe('the record comparison says why its Apply waits', () => {
  afterEach(() => announceRoomUnsaved(PHASE, false));

  it('draws the waits line in the overlay beside the disabled Apply, and drops it once the room has saved', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED });
    await renderWith(proposal, [proposal], async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED } }));
    await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name: 'Compare before and after' }).click());
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByTestId('agentic-record-waits-overlay')).toBeNull();
    await act(async () => announceRoomUnsaved(PHASE, true));
    expect(dialog.getByTestId('agentic-record-waits-overlay').textContent).toBe('Apply waits until your last edit is saved.');
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: /^Apply (to the|all)/ }).disabled).toBe(true);
    await act(async () => announceRoomUnsaved(PHASE, false));
    expect(dialog.queryByTestId('agentic-record-waits-overlay')).toBeNull();
  });
});

describe('a change-request proposal explained inside the record comparison', () => {
  it('keeps Apply locked until the explanation is accepted, then applies once and writes the marks', async () => {
    const approved = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED, [API_JSON]: '{"paths":{}}\n' });
    const unexplained = { ...approved, approvedAt: null, explanation: null, explanationAssessment: null } as AgentProposal;
    // the explanation call answers the request it was given, so the optimistic turn settles
    mocks.explainTurn.mockImplementation(async (_phase: string, selected: AgentProposal, message: string, requestId: string): Promise<AgentTurn> => {
      mocks.proposal.mockResolvedValue(approved);
      return {
        id: 'turn-explain', phaseStateId: PHASE, requestId, kind: 'explain', status: 'completed', message, parentTurnId: null,
        parentProposalId: selected.id, parentProposalHash: selected.proposalHash, baseWorkspaceHash: 'b'.repeat(64), proposalId: selected.id,
        response: { kind: 'explanation', reply: 'The explanation is accepted.', questions: [], proposal: approved }, errorCode: null,
        createdAt: '2026-10-16T00:00:30Z', updatedAt: '2026-10-16T00:00:30Z',
      } as AgentTurn;
    });
    await renderWith(unexplained, [unexplained], async () => ({ proposal: { ...approved, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED, [API_JSON]: '{"paths":{}}\n' } }));
    await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name: 'Compare before and after' }).click());
    const dialog = within(screen.getByRole('dialog'));
    const apply = () => dialog.getByRole<HTMLButtonElement>('button', { name: /^Apply (to the|all)/ });
    expect(apply().disabled).toBe(true);
    await act(async () => apply().click());
    expect(mocks.apply).not.toHaveBeenCalled();
    const field = dialog.getByRole<HTMLTextAreaElement>('textbox', { name: /Explain why the changes are right/ });
    await act(async () => { fireEvent.change(field, { target: { value: 'The release is 2.1.0 because the ticket adds a field.' } }); });
    await act(async () => dialog.getByRole<HTMLButtonElement>('button', { name: 'Explain to unlock Apply' }).click());
    expect(mocks.explainTurn).toHaveBeenCalledTimes(1);
    expect(mocks.explainTurn.mock.calls[0][1]).toMatchObject({ id: unexplained.id, proposalHash: unexplained.proposalHash });
    expect(apply().disabled).toBe(false);
    await act(async () => apply().click());
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(PHASE, approved);
    expect(readChangeTouched(PHASE)).toEqual({ 'release:version': '2.1.0' });
    expect(readDesignTouched(PHASE)).toEqual({});
  });
});

describe('a superseded record proposal on its card while the room holds an unsaved edit', () => {
  afterEach(() => announceRoomUnsaved(PHASE, false));

  it('says Apply waits beside the disabled Apply, and offers it again once the room has saved', async () => {
    const proposal = proposalOf({ [CHANGE_REQUEST_JSON]: APPLIED });
    const later = { ...proposal, id: 'proposal-later', createdAt: '2026-10-16T01:00:00Z', approvedAt: null } as AgentProposal;
    await renderWith(proposal, [later, proposal], async () => ({ proposal: { ...proposal, appliedAt: '2026-10-16T00:01:00Z' }, workspace: { [CHANGE_REQUEST_JSON]: APPLIED } }));
    await act(async () => { const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Earlier proposals' }); select.value = proposal.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => announceRoomUnsaved(PHASE, true));
    const card = () => within(host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!);
    expect(card().getByRole<HTMLButtonElement>('button', { name: 'Apply this reviewed proposal' }).disabled).toBe(true);
    expect(card().getByTestId('agentic-record-waits').textContent).toBe('Apply waits until your last edit is saved.');
    await act(async () => announceRoomUnsaved(PHASE, false));
    expect(card().queryByTestId('agentic-record-waits')).toBeNull();
    expect(card().getByRole<HTMLButtonElement>('button', { name: 'Apply this reviewed proposal' }).disabled).toBe(false);
  });
});
