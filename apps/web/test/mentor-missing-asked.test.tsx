// @vitest-environment jsdom
import { act } from 'react';
import { fireEvent, within } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHANGE_REQUEST_JSON } from '@learnsdlc/shared';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { ProposalCompare, type DesignCompareProps } from '@/components/workspace/mentor/ProposalCompare';
import {
  MISSING_NOTE, askedPaths, asksForPathNotHeld, inventoryCount, inventoryNoun, inventoryText, missingAsked, proposalInventory,
} from '@/components/workspace/mentor/proposalInventory';

/*
 * Maintenance request 1 named design/contracts.json; the
 * card held the change request and the three code files, and "Files in this
 * proposal" did not say the contract file was missing. A file of the phase the
 * request asks for and the proposal lacks is now listed "asked for, not in this
 * proposal" with the re-ask sentence, and the count is the files held.
 */

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn(), phase: vi.fn(), phaseSummary: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phase: mocks.phase, phaseSummary: mocks.phaseSummary } };
});
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-m' }), getSession: () => ({ id: 'owner-m' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));

/** A long Maintenance request (1,977 characters). */
const L7 = "Please propose code for CR-2's API side in api/repository/tasks.py, api/repository/comments.py, api/routes/comments.py and design/contracts.json, and return only these four files, keeping every other function, name and docstring, and leave no TODO(learner) line. In api/repository/tasks.py, replace the comment_count TODO in the task query with (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count, a subquery like tag_names so the query still returns one row per task, and in the row reader use record[\"comment_count\"] instead of 0. In api/repository/comments.py, list_comments first calls tasks.get_task(conn, task_id), which raises KeyError for an unknown task, then returns _to_comment of each row of COMMENT_SELECT + \" WHERE task_id = ? ORDER BY created_at DESC, id DESC\"; add_comment also calls get_task first, strips author and body, raises ValueError when either is empty, inserts (task_id, author, body, now()), commits and returns _to_comment of the row read back by its lastrowid. In api/routes/comments.py add GET /api/tasks/<int:task_id>/comments, 200 with the list, and POST on the same path reading request.get_json(silent=True) or {}, 201 with the comment; both answer 404 task_not_found \"No task has id {task_id}.\" on KeyError and the POST answers 400 invalid_comment \"A comment needs an author and a body.\" on ValueError, returned by fail(code, message, status); both pass connect() straight to the repository, as api/routes/tasks.py does, and never close the connection. Give each function you write a one-line docstring, the two route functions in api/routes/comments.py included. In design/contracts.json list two operations for CR-2: listComments(taskId), GET /api/tasks/{id}/comments returning Comment[] newest first, 404 task_not_found; and addComment(taskId, author, body), POST /api/tasks/{id}/comments returning the 201 Comment, 400 invalid_comment, 404 task_not_found. In your summary, name only the files this proposal changes.";
const CONTRACTS = 'design/contracts.json';
/** The Maintenance phase's editable files, as the phase detail lists them. */
const WORKSPACE = ['api/repository/comments.py', 'api/repository/tasks.py', 'api/routes/comments.py', 'api/routes/tasks.py', CONTRACTS, CHANGE_REQUEST_JSON, 'shared/contract/api.json', 'web/src/components/TaskRow.tsx'];
/** A card holding the change request in place of the contract file, beside the three code files. */
const heldFiles = { [CHANGE_REQUEST_JSON]: '{"impact":{}}', 'api/repository/tasks.py': 'tasks\n', 'api/repository/comments.py': 'comments\n', 'api/routes/comments.py': 'routes\n' };
const recordChanges = [{ path: 'change/impact/operations', before: '', after: 'listComments(taskId)' }, { path: 'change/release/summary', before: '', after: 'Adds task comments.' }];

describe('the files a request asks for', () => {
  test('the record card lists design/contracts.json as asked for and not held; the count is the four files held', () => {
    const inventory = proposalInventory({ files: heldFiles, changes: recordChanges, request: L7, workspace: WORKSPACE });
    expect(inventory.map(line => [line.path, line.status])).toEqual([
      [CHANGE_REQUEST_JSON, 'changed'], ['api/repository/tasks.py', 'uncounted'], ['api/repository/comments.py', 'uncounted'], ['api/routes/comments.py', 'uncounted'], [CONTRACTS, 'missing'],
    ]);
    expect(inventoryText(inventory[4])).toBe('design/contracts.json: asked for, not in this proposal');
    // The card holds code beside the record, so its noun is "file".
    expect(inventoryCount(inventory, inventoryNoun(inventory))).toBe('4 files, 1 missing');
    // Before the phase's files are read, nothing is guessed.
    expect(proposalInventory({ files: heldFiles, changes: recordChanges, request: L7 }).some(line => line.status === 'missing')).toBe(false);
  });

  test('a path written only as a pointer is not asked for: "as api/routes/tasks.py does", "Leave … as it is", a kept list', () => {
    expect(askedPaths(L7, WORKSPACE)).toEqual(['api/repository/tasks.py', 'api/repository/comments.py', 'api/routes/comments.py', CONTRACTS]);
    expect(askedPaths('Please propose api/repository/comments.py. Leave maintenance/change-request.json as it is: my third request fills it.', WORKSPACE)).toEqual(['api/repository/comments.py']);
    expect(askedPaths('Please add design/contracts.json to the proposal above. Keep api/repository/tasks.py, api/routes/comments.py and maintenance/change-request.json as they stand.', WORKSPACE)).toEqual([CONTRACTS]);
    expect(askedPaths('Change api/routes/comments.py without touching the api/routes/tasks.py file; do not change shared/contract/api.json.', WORKSPACE)).toEqual(['api/routes/comments.py']);
  });

  test('a path in backticks, quotes, brackets, with a leading ./, a backslash or sentence punctuation is the path; a longer path is not', () => {
    for (const request of ['Fill `design/contracts.json` too.', 'Fill "design/contracts.json", please.', 'Fill (design/contracts.json).', 'Fill ./design/contracts.json now', 'Fill design\\contracts.json now', 'The last file is design/contracts.json.', 'Fill design/contracts.json: two operations.']) {
      expect(askedPaths(request, WORKSPACE)).toEqual([CONTRACTS]);
    }
    expect(askedPaths('Fill design/contracts.json.bak and mydesign/contracts.json', WORKSPACE)).toEqual([]);
  });

  test('a path the workspace does not hold is never listed, and the file list is read only when the request asks for a path not held', () => {
    expect(missingAsked(heldFiles, 'Also fill docs/notes.md and api/routes/extra.py.', WORKSPACE)).toEqual([]);
    expect(asksForPathNotHeld('Also fill docs/notes.md.', Object.keys(heldFiles))).toBe(true);
    expect(asksForPathNotHeld(L7, Object.keys(heldFiles))).toBe(true);
    expect(asksForPathNotHeld('Keep the existing error code. Call request.get_json and tasks.get_task.', Object.keys(heldFiles))).toBe(false);
    expect(asksForPathNotHeld('Fill api/routes/comments.py and api/repository/tasks.py.', Object.keys(heldFiles))).toBe(false);
    // A path written after the opening sentence, or outside a "return only" list, is not asked for, so it reads nothing.
    expect(asksForPathNotHeld('Please propose api/routes/comments.py. It reads errors.py and api/routes/tasks.py.', ['api/routes/comments.py'])).toBe(false);
    expect(asksForPathNotHeld('Please propose my change request. Impact: files api/routes/comments.py. Return only maintenance/change-request.json.', [CHANGE_REQUEST_JSON])).toBe(false);
  });

  test('a room document this phase does not hold is never listed on a record card once the files are read', () => {
    const record = { [CHANGE_REQUEST_JSON]: '{}' };
    const request = 'Please propose my change request and deployment/runbook.json for CR-2.';
    const missingOf = (workspace: string[] | null, ask = request) => proposalInventory({ files: record, changes: recordChanges, request: ask, workspace }).filter(line => line.status === 'missing').map(line => line.path);
    expect(missingOf(WORKSPACE)).toEqual([]);
    // Before the read, the card's own rule stands (the read fires: the request asks for a path the card does not hold).
    expect(asksForPathNotHeld(request, [CHANGE_REQUEST_JSON])).toBe(true);
    expect(missingOf(null)).toEqual(['deployment/runbook.json']);
    // A room document the phase does hold is still listed.
    expect(missingOf(WORKSPACE, 'Please propose my change request and shared/contract/api.json for CR-2.')).toEqual(['shared/contract/api.json']);
  });
});

const proposal: AgentProposal = {
  id: 'proposal-m1', phaseStateId: 'phase-m', prompt: '{"context":true}', files: heldFiles,
  proposalHash: 'c'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] },
  explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null, createdAt: '2026-11-09T00:00:00Z', changes: recordChanges, carried: [],
};
const turnOf = (message: string, p: AgentProposal): AgentTurn => ({
  id: 'turn-m1', phaseStateId: 'phase-m', requestId: 'request-m1', kind: 'chat', status: 'completed', message, parentTurnId: null,
  parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'b'.repeat(64), proposalId: p.id,
  response: { kind: 'proposal', reply: 'Here is the proposal.', questions: [], proposal: p }, errorCode: null, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
});
const detail = { id: 'phase-m', change: {}, files: WORKSPACE.map(path => ({ path, content: path === CHANGE_REQUEST_JSON ? '{}' : 'saved\n', editable: path !== 'api/routes/tasks.py' })) };

let root: Root; let host: HTMLDivElement;
const card = () => host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;
const show = async (p: AgentProposal, message: string, phaseKey: 'maintenance' | 'implementation' = 'maintenance') => {
  mocks.list.mockResolvedValue([p]); mocks.proposal.mockResolvedValue(p);
  mocks.turns.mockResolvedValue({ items: [turnOf(message, p)], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
  await act(async () => root.render(<AgenticPanel phaseId="phase-m" phaseKey={phaseKey} />));
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  sessionStorage.clear();
  mocks.phase.mockResolvedValue(detail); mocks.phaseSummary.mockResolvedValue(detail);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the proposal card', () => {
  test('the card says design/contracts.json was asked for and is not held, with the re-ask sentence, and counts the four held', async () => {
    await show(proposal, L7);
    expect(mocks.phaseSummary).toHaveBeenCalledWith('phase-m');
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('4 files, 1 missing');
    const missing = card().querySelector<HTMLElement>('[data-testid="agentic-inventory"] [data-inventory-status="missing"]')!;
    expect(missing.getAttribute('data-inventory-path')).toBe(CONTRACTS);
    expect(missing.textContent).toBe(`design/contracts.json: asked for, not in this proposal${MISSING_NOTE}`);
  });

  test('a plain code card lists the asked-for file it lacks and counts the files it holds', async () => {
    const code = { ...proposal, id: 'proposal-c1', files: { 'api/routes/comments.py': 'routes\n' }, changes: undefined };
    await show(code, 'Please propose api/routes/comments.py and `api/repository/comments.py`, as api/routes/tasks.py does.', 'implementation');
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('1 file, 1 missing');
    const list = card().querySelector<HTMLElement>('[data-testid="agentic-inventory-missing"]')!;
    expect(list.getAttribute('aria-label')).toBe('Asked for, not in this proposal');
    expect(Array.from(list.querySelectorAll('li')).map(li => li.getAttribute('data-inventory-path'))).toEqual(['api/repository/comments.py']);
  });

  test('a request that names only the files held reads no file list and shows no missing line', async () => {
    const full = { ...proposal, id: 'proposal-m2', files: { ...heldFiles, [CONTRACTS]: '{}' } };
    await show(full, 'Please propose api/repository/tasks.py, api/repository/comments.py, api/routes/comments.py and design/contracts.json.');
    expect(mocks.phaseSummary).not.toHaveBeenCalled();
    expect(card().querySelector('[data-inventory-status="missing"]')).toBeNull();
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('5 files');
  });

  test('on a Maintenance change-request card, the runbook the request names is not listed once the files are read', async () => {
    const record = { ...proposal, id: 'proposal-r1', files: { [CHANGE_REQUEST_JSON]: '{}' } };
    await show(record, 'Please propose my change request and deployment/runbook.json for CR-2.');
    expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
    expect(card().querySelector('[data-inventory-status="missing"]')).toBeNull();
    expect(card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent).toBe('1 document');
  });
});

describe('the file-list read', () => {
  const countText = () => card().querySelector('[data-testid="agentic-proposal-count"]')!.textContent;
  const rerender = async () => { await act(async () => root.render(<AgenticPanel phaseId="phase-m" phaseKey="maintenance" onBusyChange={() => undefined} />)); };

  test('a failed read shows nothing: no missing line, no error, only the files held; it is not retried', async () => {
    mocks.phaseSummary.mockRejectedValue(new Error('offline'));
    await show(proposal, L7);
    expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
    expect(card().querySelector('[data-inventory-status="missing"]')).toBeNull();
    expect(card().querySelector('[role="alert"]')).toBeNull();
    expect(countText()).toBe('4 files');
    await rerender(); await rerender();
    expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
    expect(card().querySelector('[data-inventory-status="missing"]')).toBeNull();
  });

  test('the read happens once per pending proposal across re-renders and keystrokes, and is the summary view, never the full phase', async () => {
    await show(proposal, L7);
    expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
    await rerender(); await rerender();
    const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="agentic-input"]')!;
    for (const value of ['W', 'Wh', 'Why']) act(() => { fireEvent.change(composer, { target: { value } }); });
    expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
    expect(mocks.phase).not.toHaveBeenCalled();
    expect(countText()).toBe('4 files, 1 missing');
  });

  test('a poll that returns the same proposal reads nothing again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const waiting: AgentTurn = { ...turnOf('Thanks.', proposal), id: 'turn-m2', requestId: 'request-m2', status: 'pending', proposalId: null, response: null, createdAt: '2026-11-09T00:00:01Z', updatedAt: '2026-11-09T00:00:01Z' };
      mocks.list.mockResolvedValue([proposal]); mocks.proposal.mockResolvedValue({ ...proposal });
      mocks.turns.mockResolvedValue({ items: [turnOf(L7, proposal), waiting], nextCursor: null, currentWorkspaceHash: 'b'.repeat(64) });
      mocks.turn.mockResolvedValue({ ...waiting, status: 'completed', proposalId: proposal.id, updatedAt: '2026-11-09T00:00:02Z' });
      await act(async () => root.render(<AgenticPanel phaseId="phase-m" phaseKey="maintenance" />));
      await act(async () => { await Promise.resolve(); });
      expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      expect(mocks.turn).toHaveBeenCalledTimes(1);
      expect(mocks.proposal).toHaveBeenCalledWith('phase-m', proposal.id);
      expect(mocks.phaseSummary).toHaveBeenCalledTimes(1);
      expect(countText()).toBe('4 files, 1 missing');
    } finally { vi.useRealTimers(); }
  });

  test('only an asked path the card does not hold reads the list: a path written after the opening sentence reads nothing', async () => {
    const code = { ...proposal, id: 'proposal-c2', files: { 'api/routes/comments.py': 'routes\n' }, changes: undefined };
    await show(code, 'Please propose api/routes/comments.py. It is called next to api/repository/comments.py and design/contracts.json.');
    expect(mocks.phaseSummary).not.toHaveBeenCalled();
    expect(mocks.phase).not.toHaveBeenCalled();
    expect(card().querySelector('[data-testid="agentic-inventory-missing"]')).toBeNull();
    expect(countText()).toBe('1 file');
  });
});

describe('the plain code card and its comparison say the same', () => {
  const request = 'Please propose api/routes/comments.py and `api/repository/comments.py`, as api/routes/tasks.py does.';
  const code = { ...proposal, id: 'proposal-c3', files: { 'api/routes/comments.py': 'routes\n' }, changes: undefined };
  const texts = (list: Element) => Array.from(list.querySelectorAll('li > span')).map(span => span.textContent);

  test('the card offers no before/after overlay; its comparison with the saved files keeps the asked-for list, line for line', async () => {
    await show(code, request, 'implementation');
    const before = texts(card().querySelector('[data-testid="agentic-inventory-missing"]')!);
    expect(before).toEqual(['api/repository/comments.py: asked for, not in this proposal']);
    expect(within(card()).queryByRole('button', { name: 'Compare before and after' })).toBeNull();
    await act(async () => within(card()).getByRole('button', { name: 'Compare with saved files' }).click());
    await act(async () => { await Promise.resolve(); });
    expect(within(card()).getByRole('button', { name: 'Refresh saved-file comparison' })).toBeTruthy();
    expect(texts(card().querySelector('[data-testid="agentic-inventory-missing"]')!)).toEqual(before);
    expect(host.querySelector('dialog')).toBeNull();
  });

  test('the overlay, given those lines, draws them as the card does', async () => {
    const lines = missingAsked(code.files, request, WORKSPACE);
    const gate = { open: true, onClose: () => {}, mentorName: 'Arlo', carried: [] as string[], explanation: '', onExplanationChange: () => {}, canExplain: true, onExplain: () => {}, canApply: false, onApply: () => {}, busy: false };
    const overlay: DesignCompareProps = { ...gate, subject: 'design', documents: [], inventory: lines };
    await act(async () => root.render(<ProposalCompare {...overlay} />));
    expect(texts(host.querySelector('[data-testid="apv-inventory"]')!)).toEqual(['api/repository/comments.py: asked for, not in this proposal']);
  });
});
