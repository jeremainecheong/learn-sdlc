// @vitest-environment jsdom
/**
 * The "Your request names <path>. This proposal does not
 * change it. ..." line needs the phase's editable paths. The card read them
 * only when the request's opening sentence (or a "return only" list) asked for
 * a path the proposal does not hold, so a request whose opening path is held
 * never drew the line though it named a missing file further on. The room
 * already holds the phase's detail (the project context's `details`, keyed by
 * the phase state id, with every file's path and editable flag), so the card
 * reads the paths from there, with no new request. These tests mount the real
 * AgenticPanel with the phase's summary read left unanswered, so the line on
 * screen can only come from the room's own copy.
 */
import { act } from 'react';
import { within } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHANGE_REQUEST_JSON } from '@learnsdlc/shared';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { ProposalCompare, type DesignCompareProps, type StoryCompareProps } from '@/components/workspace/mentor/ProposalCompare';
import { EMPTY_STORY, type Story } from '@learnsdlc/shared';

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
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-d' }), getSession: () => ({ id: 'owner-d' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

const OVERDUE = 'web/src/lib/overdue.ts';
const OVERDUE_TEST = 'web/src/lib/overdue.test.ts';
/** The request seen on the preview, byte for byte. */
const LIVE = 'Update overdue.ts so completed tasks return false; keep the date rule. Add one regression test in overdue.test.ts for a completed task due yesterday. Draft the change request with both files in impact and tests not run. Include all three documents.';
/** The reviewer's case: the opening path is one the proposal holds. */
const HELD_OPENING = `Update ${OVERDUE} so completed tasks return false. Add one regression test in ${OVERDUE_TEST}.`;
const LINE = `Your request names ${OVERDUE_TEST}. This proposal does not change it. If you wanted it changed, discard this proposal and ask again.`;

/** The room's copy of the Maintenance phase: two editable code files, the record beside them. */
const roomDetail = {
  id: 'phase-d', change: {},
  files: [
    { path: OVERDUE, content: 'saved\n', editable: true },
    { path: OVERDUE_TEST, content: 'saved\n', editable: true },
    { path: CHANGE_REQUEST_JSON, content: '{}', editable: false },
  ],
};
const recordChanges = [{ path: 'change/impact/files', before: '', after: `${OVERDUE}, ${OVERDUE_TEST}` }];
const proposalOf = (files: Record<string, string>, extra: Partial<AgentProposal> = {}): AgentProposal => ({
  id: 'proposal-d1', phaseStateId: 'phase-d', prompt: '{"context":true}', files,
  proposalHash: 'c'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null, createdAt: '2026-11-17T00:00:00Z', changes: recordChanges, carried: [],
  ...extra,
});
const HELD = { [CHANGE_REQUEST_JSON]: '{"impact":{}}', [OVERDUE]: 'export const isOverdue = () => false;\n' };
const turnOf = (message: string, p: AgentProposal): AgentTurn => ({
  id: 'turn-d1', phaseStateId: 'phase-d', requestId: 'request-d1', kind: 'chat', status: 'completed', message, parentTurnId: null,
  parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'b'.repeat(64), proposalId: p.id,
  response: { kind: 'proposal', reply: 'Here is the proposal.', questions: [], proposal: p }, errorCode: null, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
});

let root: Root; let host: HTMLDivElement;
const card = () => host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
const line = () => card().querySelector('[data-testid="agentic-named-not-held"]')?.textContent ?? null;
const show = async (p: AgentProposal, message: string) => {
  mocks.list.mockResolvedValue([p]); mocks.proposal.mockResolvedValue(p);
  mocks.turns.mockResolvedValue({ items: [turnOf(message, p)], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
  await act(async () => root.render(<AgenticPanel phaseId="phase-d" phaseKey="maintenance" />));
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  // The summary read never answers: whatever the card says about the phase's files came from the room.
  mocks.phaseSummary.mockReturnValue(new Promise(() => {}));
  mocks.phase.mockResolvedValue(roomDetail);
  mocks.project.current = { details: { 'phase-d': roomDetail } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the "Your request names" line, mounted', () => {
  test('the live request against a proposal without overdue.test.ts names web/src/lib/overdue.test.ts', async () => {
    await show(proposalOf(HELD), LIVE);
    expect(line()).toBe(LINE);
  });

  test('a request whose opening path is held still names the missing test file', async () => {
    await show(proposalOf(HELD), HELD_OPENING);
    expect(line()).toBe(LINE);
  });

  test('the Compare window says it in its head too, with the same words', async () => {
    await show(proposalOf(HELD), HELD_OPENING);
    await act(async () => within(card()).getByTestId('agentic-compare').click());
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="apv-named-not-held"]')?.textContent).toBe(LINE);
  });

  test('no line when the proposal holds every file the request names', async () => {
    await show(proposalOf({ ...HELD, [OVERDUE_TEST]: 'test\n' }), LIVE);
    expect(card()).toBeTruthy();
    expect(line()).toBeNull();
  });

  test('no line when the API\'s own summary sentence already names the missing file, which the card shows once', async () => {
    const said = `Files in this proposal: ${CHANGE_REQUEST_JSON}, ${OVERDUE}. The mentor's answer also named ${OVERDUE_TEST}; this proposal does not change it. If you wanted it changed, ask again for it.`;
    await show(proposalOf(HELD, { summary: said }), LIVE);
    expect(line()).toBeNull();
    // The file sentence leaves the summary where the list under it names the files; the API's
    // sentence about the named file stays.
    const named = said.slice(said.indexOf("The mentor's answer"));
    expect(card().querySelector('[data-testid="agentic-proposal-summary"] p')?.textContent).toBe(named);
    expect(card().textContent!.split(OVERDUE_TEST)).toHaveLength(2);
  });

  test('the line stays when the summary is the model\'s own words about the file', async () => {
    await show(proposalOf(HELD, { summary: `Changes ${OVERDUE} and ${OVERDUE_TEST}.` }), LIVE);
    expect(line()).toBe(LINE);
  });

  test('no line when the request names no file of the phase', async () => {
    await show(proposalOf(HELD), 'Make completed tasks never overdue and record the change.');
    expect(line()).toBeNull();
  });

  test('no line when neither the room nor the summary read has the phase files', async () => {
    mocks.project.current = null;
    await show(proposalOf(HELD), HELD_OPENING);
    expect(line()).toBeNull();
  });

  test('no line once the proposal is applied', async () => {
    await show(proposalOf(HELD, { appliedAt: '2026-11-17T01:00:00Z', approvedAt: '2026-11-17T00:30:00Z' }), LIVE);
    expect(line()).toBeNull();
  });

  test('the design Compare window draws the note it is given in its head', async () => {
    const gate = { open: true, onClose: () => {}, mentorName: 'Arlo', carried: [] as string[], explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false };
    const overlay: DesignCompareProps = { ...gate, subject: 'design', documents: [], requestNote: LINE };
    await act(async () => root.render(<ProposalCompare {...overlay} />));
    expect(document.querySelector('[data-testid="apv-named-not-held"]')?.textContent).toBe(LINE);
    await act(async () => root.render(<ProposalCompare {...overlay} requestNote={null} />));
    expect(document.querySelector('[data-testid="apv-named-not-held"]')).toBeNull();
  });
});

/**
 * The plain code card's
 * line (its own ending, "ask again for it", since that card has no Compare to
 * discard from) and the story/files Compare window forwarding the note to its
 * head. Both are pinned here on the mounted components.
 */
describe('the line on the plain code card and in the story Compare window, mounted', () => {
  const PLAIN_LINE = `Your request names ${OVERDUE_TEST}. This proposal does not change it. If you wanted it changed, ask again for it.`;

  test('an Implementation code proposal (no structured changes) says it on its card, ending "ask again for it"', async () => {
    const plain = proposalOf({ [OVERDUE]: 'export const isOverdue = () => false;\n' }, { changes: undefined, carried: undefined });
    mocks.list.mockResolvedValue([plain]); mocks.proposal.mockResolvedValue(plain);
    mocks.turns.mockResolvedValue({ items: [turnOf(HELD_OPENING, plain)], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    await act(async () => root.render(<AgenticPanel phaseId="phase-d" phaseKey="implementation" />));
    await act(async () => { await Promise.resolve(); });
    expect(card().querySelector('[data-testid="agentic-compare"]')).toBeNull();
    expect(line()).toBe(PLAIN_LINE);
  });

  test('no line on the plain card when it holds every file the request names', async () => {
    const plain = proposalOf({ [OVERDUE]: 'a\n', [OVERDUE_TEST]: 'b\n' }, { changes: undefined, carried: undefined });
    mocks.list.mockResolvedValue([plain]); mocks.proposal.mockResolvedValue(plain);
    mocks.turns.mockResolvedValue({ items: [turnOf(HELD_OPENING, plain)], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
    await act(async () => root.render(<AgenticPanel phaseId="phase-d" phaseKey="implementation" />));
    await act(async () => { await Promise.resolve(); });
    expect(card()).toBeTruthy();
    expect(line()).toBeNull();
  });

  test('the story Compare window draws the note it is given in its head', async () => {
    const story: Story = { ...EMPTY_STORY, id: 'US-1', title: 'Overdue', benefit: 'see what slipped' };
    const overlay: StoryCompareProps = {
      open: true, onClose: () => {}, mentorName: 'Arlo', explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false,
      storyId: 'US-1', before: story, after: { ...story, benefit: 'chase it first' }, changes: [{ path: 'story/so-that', before: 'see what slipped', after: 'chase it first' }], otherFiles: [],
      requestNote: LINE,
    };
    await act(async () => root.render(<ProposalCompare {...overlay} />));
    expect(document.querySelector('[data-testid="apv-named-not-held"]')?.textContent).toBe(LINE);
    await act(async () => root.render(<ProposalCompare {...overlay} requestNote={null} />));
    expect(document.querySelector('[data-testid="apv-named-not-held"]')).toBeNull();
  });
});
