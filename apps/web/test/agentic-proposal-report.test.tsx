// @vitest-environment jsdom
/**
 * The Agentic panel tells its mentor whether the proposal it shows
 * is open, so the phase's next page opens on Agentic while one is
 * (`mentorMode.ts`). It says so only once its conversation has loaded: before
 * the load, or after a load that failed, it knows nothing and says nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getByRole } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProposal } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/session', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/session')>()), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

const approved: AgentProposal = { id: 'proposal-a', phaseStateId: 'phase-a', prompt: 'Keep the existing error code.', files: { 'code.ts': 'export const result = true;' }, proposalHash: 'a'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] }, explanation: 'The error code stays unchanged.', explanationAssessment: { adequate: true, feedback: 'All boundaries are explained.', questions: [] }, approvedAt: '2026-09-10T00:00:00Z', appliedAt: null, createdAt: '2026-09-10T00:00:00Z' };

let root: Root;
let host: HTMLDivElement;
const report = vi.fn();
const render = async () => { await act(async () => root.render(<AgenticPanel phaseId="phase-a" onProposalOpen={report} />)); };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.turns.mockResolvedValue({ items: [], nextCursor: null });
  mocks.proposal.mockResolvedValue(approved);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Agentic panel reports an open proposal to its mentor', () => {
  it('nothing while the conversation loads; then that no proposal is open', async () => {
    let release!: () => void;
    mocks.turns.mockReturnValue(new Promise((resolve) => { release = () => resolve({ items: [], nextCursor: null }); }));
    await render();
    expect(report).not.toHaveBeenCalled();
    await act(async () => release());
    expect(report).toHaveBeenLastCalledWith(false);
  });

  it('an unapplied proposal in the loaded conversation is open; applying it closes it', async () => {
    mocks.list.mockResolvedValue([approved]);
    await render();
    expect(report).toHaveBeenLastCalledWith(true);
    mocks.apply.mockResolvedValue({ proposal: { ...approved, appliedAt: '2026-09-15T00:00:00Z' }, workspace: approved.files });
    await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name: 'Apply this reviewed proposal' }).click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(false);
  });

  it('an applied proposal is not open', async () => {
    mocks.list.mockResolvedValue([{ ...approved, appliedAt: '2026-09-15T00:00:00Z' }]);
    await render();
    expect(report).toHaveBeenLastCalledWith(false);
    expect(report).not.toHaveBeenCalledWith(true);
  });

  it('a conversation that could not be loaded says nothing', async () => {
    mocks.turns.mockRejectedValue(new Error('Conversation unavailable.'));
    await render();
    expect(host.textContent).toContain('Retry loading conversation');
    expect(report).not.toHaveBeenCalled();
  });
});
