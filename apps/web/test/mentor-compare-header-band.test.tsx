// @vitest-environment jsdom
/**
 * The mentor, Compare, the header and the band: each case is written to fail
 * when the behaviour it names breaks.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, getByRole, screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, moduleText, webSource } from './support/source-text';
import type { AgentProposal, AgentTurn } from '@/lib/api-mentor';
import type { PhaseTaskView } from '@learnsdlc/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), proposal: vi.fn(), turns: vi.fn(), turn: vi.fn(), chat: vi.fn(), edit: vi.fn(), explainTurn: vi.fn(), apply: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ agentApi: mocks }));
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner-a' }), getSession: () => ({ id: 'owner-a' }) }));
vi.mock('@/components/DeferredMarkdown', () => ({ DeferredMarkdown: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/workspace/phase-a' }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { AgenticPanel } from '@/components/workspace/mentor/AgenticPanel';
import { ExplanationFindings, groupQuotes, assessmentDimensions } from '@/components/workspace/mentor/ExplanationFindings';
import { ReviewDimensions } from '@/components/workspace/mentor/ReviewDimensions';
import { ProposalCompare, applyAllLabel, proposalTotal } from '@/components/workspace/mentor/ProposalCompare';
import { ProposalChangeSummary } from '@/components/workspace/mentor/ProposalChangeSummary';
import { analyseChange } from '@/components/workspace/mentor/proposalChange';
import { fileDiff } from '@/components/pr/diff';
import type { InventoryLine } from '@/components/workspace/mentor/proposalInventory';
import { MergePanel } from '@/components/workspace/MergePanel';
import { PhaseGateBanner, signedOffTitles } from '@/components/workspace/PhaseGateBanner';
import { HeaderSubmit, phaseSubmitLabel, submitLeads } from '@/components/workspace/HeaderSubmit';
import { PhaseStrip } from '@/components/shell/WorkPage';
import { phaseTutorialMarks } from '@/components/shell/tours';
import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { CHANGE_REQUEST_JSON } from '@learnsdlc/shared';

const read = (path: string) => webSource(path);

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  mocks.list.mockResolvedValue([]); mocks.turns.mockResolvedValue({ items: [], nextCursor: null });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };

const proposal: AgentProposal = { id: 'proposal-a', phaseStateId: 'phase-a', prompt: 'Fix it.', files: { 'code.ts': 'export const result = true;' }, proposalHash: 'a'.repeat(64), baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: true, feedback: 'Intent is grounded.', questions: [] }, explanation: 'The boundary stays at today.', explanationAssessment: { adequate: true, feedback: 'Accepted.', questions: [] }, approvedAt: '2026-11-17T00:00:00Z', appliedAt: null, createdAt: '2026-11-17T00:00:00Z' };
const unapproved: AgentProposal = { ...proposal, approvedAt: null, explanation: null, explanationAssessment: null };
const turn = (patch: Partial<AgentTurn> = {}): AgentTurn => ({ id: 'turn-a', phaseStateId: 'phase-a', requestId: 'request-a', kind: 'chat', status: 'completed', message: 'Fix it.', parentTurnId: null, parentProposalId: null, parentProposalHash: null, baseWorkspaceHash: 'b'.repeat(64), proposalId: 'proposal-a', response: { kind: 'proposal', reply: 'Here is a proposal.', questions: [], proposal }, errorCode: null, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', ...patch });
const card = () => host.querySelector<HTMLElement>('[data-testid="agentic-proposal"]')!;

describe('the Continue drawer is drawn above the top bar', () => {
  it('is mounted on the document body, not inside the band that opens it, and still closes on Escape', async () => {
    const onClose = vi.fn();
    await render(<div data-testid="band-host"><MergePanel phaseTitle="Requirements" score={100} isLast={false} onSubmit={async () => undefined} onClose={onClose} /></div>);
    const sheet = document.querySelector<HTMLElement>('[data-testid="reflection-modal"]')!;
    expect(sheet.parentElement).toBe(document.body);
    expect(host.contains(sheet)).toBe(false);
    expect(within(sheet).getByRole('dialog', { name: 'Continue from this phase' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.keyDown(within(sheet).getByTestId('reflection-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const dim = (key: string, patch: Record<string, unknown> = {}) => ({ key, met: true, finding: 'supported', learnerEvidence: [], ...patch });
const verdict = (dimensions: Record<string, unknown>[], adequate = true) => ({ adequate, feedback: 'f', questions: [], dimensions });

describe('one set of names, one order, for the explanation verdict', () => {
  it('the overlay row names the four checks by the mentor list’s long names, in the order the checks run', async () => {
    const assessment = verdict([dim('consistency'), dim('verification'), dim('constraints'), dim('effects')]);
    await render(<><ReviewDimensions assessment={assessment} inventory={[]} /><ExplanationFindings assessment={verdict([dim('consistency', { learnerEvidence: ['d'] }), dim('verification', { learnerEvidence: ['c'] }), dim('constraints', { learnerEvidence: ['b'] }), dim('effects', { learnerEvidence: ['a'] })])} /></>);
    const row = screen.getByRole('group', { name: 'The explanation review, dimension by dimension' });
    expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual([
      'What the change does: supported', 'Why it meets the request: supported', 'What is and is not verified: supported', 'Whether the claims match the proposal: supported',
    ]);
    expect([...host.querySelectorAll('[data-testid="explanation-findings"] dt')].map(dt => dt.textContent)).toEqual([
      'What the change does', 'Why it meets the request', 'What is and is not verified', 'Whether the claims match the proposal',
    ]);
  });
});

describe('a sentence two checks quote is drawn once, both checks named', () => {
  it('draws the shared sentence under the first check, names the second beside it, and points back from the second', async () => {
    const shared = 'The helper uses <, so a task due today is not overdue.';
    await render(<ExplanationFindings assessment={verdict([dim('effects', { learnerEvidence: [shared] }), dim('constraints', { learnerEvidence: [shared, 'Only that helper changed.'] }), dim('verification', { learnerEvidence: ['I have not run it yet.'] })])} />);
    const quotes = [...host.querySelectorAll('blockquote')].map(quote => quote.textContent);
    expect(quotes.filter(quote => quote === shared)).toHaveLength(1);
    expect(quotes).toEqual([shared, 'Only that helper changed.', 'I have not run it yet.']);
    expect(screen.getByTestId('finding-quote-also').textContent).toBe('Also cited for Why it meets the request.');
    expect(screen.getByTestId('finding-quote-repeat').textContent).toBe('Also cites the sentence under What the change does.');
  });
  it('a check whose only sentence was drawn above says so and keeps its own chip', () => {
    const findings = assessmentDimensions(verdict([dim('effects', { learnerEvidence: ['x'] }), dim('constraints', { learnerEvidence: ['x'] })]));
    const { drawn, repeated } = groupQuotes(findings);
    expect(drawn.get('constraints')).toEqual([]);
    expect(repeated.get('constraints')).toEqual({ under: ['effects'], count: 1 });
    expect(drawn.get('effects')).toEqual([{ quote: 'x', also: ['constraints'] }]);
  });
});

describe('"Not explained yet" only where nothing was said', () => {
  it('chips a refused check that quotes the learner "Needs more", and one with no sentence "Not explained yet"', () => {
    const [quoted, silent] = assessmentDimensions(verdict([
      dim('effects', { met: false, finding: 'missing', learnerEvidence: ['Nothing has run yet.'] }),
      dim('verification', { met: false, finding: 'missing' }),
    ], false));
    expect(quoted.label).toBe('Needs more');
    expect(silent.label).toBe('Not explained yet');
  });
});

const recordInventory: InventoryLine[] = [
  { path: 'maintenance/change-request.json', label: 'Change request', status: 'changed', count: 9, unit: 'change', requested: false },
  { path: 'web/src/lib/overdue.ts', label: null, status: 'changed', count: 1, unit: 'line', requested: false },
  { path: 'web/src/lib/overdue.test.ts', label: null, status: 'changed', count: 4, unit: 'line', requested: false },
];
const gate = { open: true, onClose: () => undefined, mentorName: 'Sage', explanation: '', onExplanationChange: () => undefined, canExplain: true, onExplain: () => undefined, canApply: false, onApply: () => undefined, busy: false };
const recordProps = {
  ...gate, subject: 'record' as const, label: 'Change request' as const, carried: [], inventory: recordInventory,
  changes: Array.from({ length: 9 }, (_, i) => ({ path: `change/release/field-${i}`, before: '', after: `v${i}` })),
  files: [
    { path: 'web/src/lib/overdue.ts', before: 'a\nreturn false;\nc\n', after: 'a\nreturn task.done;\nc\n' },
    { path: 'web/src/lib/overdue.test.ts', before: 'a\n', after: 'a\nb\nc\nd\ne\n' },
  ],
};

describe('one proposal, one count and one noun', () => {
  it('the overlay title and Apply say the card’s total in the card’s noun', async () => {
    await render(<ProposalCompare {...recordProps} />);
    expect(document.querySelector('dialog > header > span')?.textContent).toBe('Sage\'s proposal for your change request (3 files)');
    expect(screen.getByRole('button', { name: 'Apply all 3 files' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /documents/ })).toBeNull();
  });
  it('counts what Apply changes, and falls back to the dialog’s own entries without an inventory', () => {
    expect(proposalTotal([...recordInventory.slice(0, 2), { ...recordInventory[2], status: 'unchanged', count: 0 }], { count: 0, noun: 'file' })).toEqual({ words: '2 of 3 files changed', apply: 'Apply all 2 files' });
    expect(proposalTotal(undefined, { count: 2, noun: 'document' })).toEqual({ words: '2 documents', apply: 'Apply all 2 documents' });
  });
  it('Apply never says "all 1 file" or "all 0 files": one changed of several is "the changed file", none is plain "Apply"', async () => {
    const unchanged = (line: InventoryLine): InventoryLine => ({ ...line, status: 'unchanged', count: 0 });
    await render(<ProposalCompare {...recordProps} inventory={[recordInventory[0], unchanged(recordInventory[1]), unchanged(recordInventory[2])]} />);
    expect(document.querySelector('dialog > header > span')?.textContent).toBe('Sage\'s proposal for your change request (1 of 3 files changed)');
    expect(screen.getByRole('button', { name: 'Apply the changed file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Apply all/ })).toBeNull();
    expect([applyAllLabel(3, 'file'), applyAllLabel(1, 'document'), applyAllLabel(0, 'file')]).toEqual(['Apply all 3 files', 'Apply the changed document', 'Apply']);
  });
});

describe('Compare nits', () => {
  it('a file’s count is on its own line under its path, a one-line edit is "1 line", and the name keeps both for a screen reader', async () => {
    await render(<ProposalCompare {...recordProps} />);
    const rail = screen.getByTestId('record-compare-rail-web/src/lib/overdue.ts');
    expect(rail.querySelector('.apv-rail-name')?.textContent).toBe('web/src/lib/overdue.ts');
    expect(rail.querySelector('.apv-rail-count')?.textContent).toBe('1 line');
    expect(rail.textContent).not.toContain(',');
    expect(rail.getAttribute('aria-label')).toBe('web/src/lib/overdue.ts, 1 line');
    expect(screen.getByTestId('record-compare-rail-web/src/lib/overdue.test.ts').querySelector('.apv-rail-count')?.textContent).toBe('4 lines');
  });
  it('the explanation box has the footer’s whole width, so the "Next:" label beside the buttons cannot change it', () => {
    const css = read('components/workspace/mentor/ProposalCompare.css');
    expect(css).toMatch(/\.apv-foot > \.apv-gate \{ flex-basis: 100%; \}/);
  });
});

describe('an accepted explanation is shown, not asked for again', () => {
  it('the overlay draws the accepted words read-only, with no field and no Explain', async () => {
    await render(<ProposalCompare {...recordProps} canApply acceptedExplanation="The done guard comes first." />);
    expect(screen.queryByRole('textbox', { name: /Explain why the changes are right/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Explain to unlock Apply' })).toBeNull();
    expect(screen.getByTestId('apv-accepted-explanation').textContent).toContain('The done guard comes first.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply all 3 files' }).disabled).toBe(false);
  });
  it('before acceptance the explanation field and "Explain to unlock Apply" are drawn', async () => {
    await render(<ProposalCompare {...recordProps} />);
    expect(screen.getByRole('textbox', { name: /Explain why the changes are right/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Explain to unlock Apply' })).toBeTruthy();
  });
});

const listenApplied = () => {
  const listener = (event: Event) => (event as CustomEvent<{ waitUntil: (p: Promise<unknown>) => void }>).detail.waitUntil(Promise.resolve());
  window.addEventListener('learnsdlc:agent-applied', listener);
  return () => window.removeEventListener('learnsdlc:agent-applied', listener);
};

describe('the proposal card', () => {
  it('once accepted, the card drops Explain and the sentence about Apply becoming available', async () => {
    mocks.list.mockResolvedValue([proposal]); mocks.proposal.mockResolvedValue(proposal);
    await render(<AgenticPanel phaseId="phase-a" />);
    expect(within(card()).queryByRole('button', { name: 'Explain this proposal' })).toBeNull();
    expect(within(card()).getByRole<HTMLButtonElement>('button', { name: 'Apply this reviewed proposal' }).disabled).toBe(false);
    expect(screen.getByTestId('agentic-apply-note').textContent).toBe('Applying saves files; it does not run, submit or pass the phase.');
  });
  it('before acceptance both are there', async () => {
    mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(unapproved);
    await render(<AgenticPanel phaseId="phase-a" />);
    expect(within(card()).getByRole('button', { name: 'Explain this proposal' })).toBeTruthy();
    expect(screen.getByTestId('agentic-apply-note').textContent).toContain('Apply becomes available after your explanation is accepted.');
  });
  it('no "Review this proposal" beside the card that already shows the same proposal', async () => {
    mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(unapproved);
    mocks.turns.mockResolvedValue({ items: [turn({ response: { kind: 'proposal', reply: 'Here is a proposal.', questions: [], proposal: unapproved } })], nextCursor: null });
    await render(<AgenticPanel phaseId="phase-a" />);
    expect(card()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review this proposal' })).toBeNull();
  });
  it('a turn whose proposal is not the one on the card keeps its door', async () => {
    const other = { ...unapproved, id: 'proposal-b' };
    mocks.list.mockResolvedValue([unapproved, other]); mocks.proposal.mockResolvedValue(unapproved);
    mocks.turns.mockResolvedValue({ items: [turn({ proposalId: 'proposal-b', response: { kind: 'proposal', reply: 'Older.', questions: [], proposal: other } })], nextCursor: null });
    await render(<AgenticPanel phaseId="phase-a" />);
    expect(screen.getByRole('button', { name: 'Review this proposal' })).toBeTruthy();
  });
  it('a refused explanation goes back into the box; an accepted one ends the explaining', async () => {
    const refused = { ...unapproved, explanation: 'It works.', explanationAssessment: { adequate: false, feedback: 'Say what is verified.', questions: [] } };
    mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(refused);
    mocks.explainTurn.mockImplementation(async (_p, selected, message, requestId) => turn({ requestId, kind: 'explain', message, parentProposalId: selected.id, parentProposalHash: selected.proposalHash, response: { kind: 'explanation', reply: 'Say what is verified.', questions: [], proposal: refused } }));
    await render(<AgenticPanel phaseId="phase-a" />);
    await act(async () => getByRole(card(), 'button', { name: 'Explain this proposal' }).click());
    const box = () => host.querySelector<HTMLTextAreaElement>('[data-testid="agentic-input"]')!;
    act(() => { fireEvent.change(box(), { target: { value: 'It works.' } }); });
    await act(async () => screen.getByRole('button', { name: 'Send explanation' }).click());
    expect(box().value).toBe('It works.');
    // Accepted: the composer is back to the conversation and holds nothing of the explanation.
    mocks.proposal.mockResolvedValue(proposal);
    mocks.explainTurn.mockImplementation(async (_p, selected, message, requestId) => turn({ requestId, kind: 'explain', message, parentProposalId: selected.id, parentProposalHash: selected.proposalHash, response: { kind: 'explanation', reply: 'Accepted.', questions: [], proposal } }));
    act(() => { fireEvent.change(box(), { target: { value: 'The boundary stays at today.' } }); });
    await act(async () => screen.getByRole('button', { name: 'Send explanation' }).click());
    expect(box().getAttribute('aria-label')).toBe('Message Nova');
    expect(box().value).toBe('');
  });
  it('Apply after a comparison brings the applied notice into view, with no "Latest messages" left waiting', async () => {
    const stop = listenApplied();
    try {
      mocks.list.mockResolvedValue([proposal]); mocks.proposal.mockResolvedValue(proposal);
      mocks.apply.mockResolvedValue({ proposal: { ...proposal, appliedAt: '2026-11-17T00:01:00Z' }, workspace: proposal.files });
      await render(<AgenticPanel phaseId="phase-a" />);
      // Opening the saved-file comparison stops the log following its newest entry.
      await act(async () => screen.getByRole('button', { name: 'Compare with saved files' }).click());
      await act(async () => screen.getByRole('button', { name: 'Apply this reviewed proposal' }).click());
      expect(host.textContent).toContain('Proposal applied. Your saved workspace is up to date.');
      expect(screen.queryByRole('button', { name: /Latest messages/ })).toBeNull();
    } finally { stop(); }
  });
  it('a new card taller than the log opens at its heading, not at its foot', async () => {
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = this.getAttribute('data-testid') === 'agentic-proposal' ? -300 : this.getAttribute('data-testid') === 'agentic-transcript' ? 100 : 0;
      return { top, bottom: top + 10, left: 0, right: 0, width: 0, height: 10, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(unapproved);
      await render(<AgenticPanel phaseId="phase-a" />);
      const log = screen.getByTestId('agentic-transcript');
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
      Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 });
      // The card is the one already seen: drawing it again moves nothing. A new version is a new card.
      const next = { ...unapproved, proposalHash: 'c'.repeat(64) };
      mocks.list.mockResolvedValue([next]); mocks.proposal.mockResolvedValue(next);
      log.scrollTop = 1600;
      await act(async () => root.render(<AgenticPanel phaseId="phase-b" />));
      await act(async () => root.render(<AgenticPanel phaseId="phase-a" />));
      const after = screen.getByTestId('agentic-transcript');
      Object.defineProperty(after, 'scrollHeight', { configurable: true, value: 2000 });
      expect(after.scrollTop).toBe(0);
    } finally { Element.prototype.getBoundingClientRect = rect; }
  });
  it('the box holding an explanation is three lines tall', async () => {
    mocks.list.mockResolvedValue([unapproved]); mocks.proposal.mockResolvedValue(unapproved);
    await render(<AgenticPanel phaseId="phase-a" />);
    await act(async () => getByRole(card(), 'button', { name: 'Explain this proposal' }).click());
    expect(host.querySelector('[data-testid="agentic-input"]')?.getAttribute('data-explaining')).toBe('true');
    expect(read('components/workspace/mentor/AgenticPanel.css')).toContain('.agentic-compose-row textarea[data-explaining] { min-height: 86px; }');
  });
  it('the card names the room’s documents without their paths; a file beside the record keeps its path', async () => {
    const record: AgentProposal = { ...unapproved, files: { [CHANGE_REQUEST_JSON]: '{}', 'web/src/App.tsx': 'x\n' }, changes: [{ path: 'change/impact/operations', before: '', after: 'listComments' }], carried: [] };
    mocks.list.mockResolvedValue([record]); mocks.proposal.mockResolvedValue(record);
    await render(<AgenticPanel phaseId="phase-a" phaseKey="maintenance" />);
    const listed = card().querySelector<HTMLElement>('[data-testid="agentic-inventory"]')!;
    const lines = Array.from(listed.querySelectorAll('li')).map(li => li.textContent ?? '');
    expect(lines[0]).toMatch(/^Change request: changed/);
    expect(lines.join('\n')).not.toContain('maintenance/');
    expect(lines[1]).toMatch(/^web\/src\/App\.tsx/);
  });
  it('Compare’s list names the room’s documents without their paths too', async () => {
    await render(<ProposalCompare {...recordProps} />);
    const listed = screen.getByTestId('apv-inventory');
    expect(listed.textContent).toContain('Change request: changed, 9 changes');
    expect(listed.textContent).not.toContain('maintenance/');
    expect(listed.textContent).toContain('web/src/lib/overdue.ts');
  });
});

describe('the change is readable whole at the mentor’s width', () => {
  it('a code line wraps inside a fixed content column instead of being cut', () => {
    const css = read('components/workspace/mentor/AgenticPanel.css');
    expect(css).toContain('.agentic-diff-scroll table { table-layout: fixed; }');
    expect(css).toContain('.agentic-diff-scroll code { white-space: pre-wrap; overflow-wrap: break-word;');
    expect(css).not.toContain('.agentic-diff-scroll code { white-space: pre;');
  });
  it('a field’s key breaks only at dots and underscores, its value after slashes, colons and dots', async () => {
    const before = '{"services":{"web":{"env":{"API_URL":"http://localhost:8000"}}}}';
    const after = '{"services":{"web":{"env":{"API_URL":"http://api:8000"}}}}';
    await render(<ProposalChangeSummary analysis={analyseChange('deploy/services.json', before, after, fileDiff('deploy/services.json', before, after))} />);
    const key = host.querySelector<HTMLElement>('td.agentic-field-key');
    if (!key) throw new Error('no field table');
    expect(key.textContent).toBe('services.web.env.API_URL');
    expect(key.innerHTML.split('<wbr>').length).toBe(5);
    const value = key.nextElementSibling!.querySelector('code')!;
    expect(value.textContent).toContain('http://localhost:8000');
    expect(value.innerHTML).toContain('localhost:<wbr>');
    expect(read('components/workspace/mentor/ProposalChangeSummary.css')).toMatch(/td\.agentic-field-key[^{]*\{ overflow-wrap: normal; word-break: normal; \}/);
  });
});

const task = (patch: Partial<PhaseTaskView>): PhaseTaskView => ({ key: 'main', order: 1, required: true, title: 'Maintenance', artefactType: 'code', evidence: 'reviewed', sealed: false, status: 'passed', awaitingSignOff: false, attempts: 1, bestScore: 100, passedAt: null, lastSubmissionId: null, resetAt: null, solution: { available: false } as never, ...patch } as PhaseTaskView);
const passed = (tasks: PhaseTaskView[]) => ({ status: 'passed' as const, title: 'Maintenance', order: 6, bestScore: 100, reflection: null, key: 'maintenance' as const, tasks });

describe('the band', () => {
  it('after the teacher signs off, the band says so by the task’s name', async () => {
    await render(<PhaseGateBanner phaseId="phase-6" phase={passed([task({ evidence: 'signed-off' })])} isLast />);
    expect(screen.getByTestId('gate-banner').textContent).toContain('Your teacher signed off Maintenance. Complete the project when ready');
    expect(screen.getByTestId('gate-banner').textContent).not.toContain('Phase evidence accepted');
  });
  it('a phase with no sign-off keeps "Phase evidence accepted"', async () => {
    expect(signedOffTitles(passed([task({})]))).toEqual([]);
    await render(<PhaseGateBanner phaseId="phase-6" phase={passed([task({})])} isLast={false} />);
    expect(screen.getByTestId('gate-banner').textContent).toContain('Phase evidence accepted. Continue when ready');
  });
  /** The workspace's code surface (`data-focus-show`) holding the lower panel's Review tab. */
  const surface = (show: 'code' | 'results', selected: boolean) => {
    const section = document.createElement('section'); section.setAttribute('data-focus-show', show);
    const tab = document.createElement('button'); tab.setAttribute('data-testid', 'tab-feedback'); tab.setAttribute('aria-selected', String(selected));
    section.append(tab); document.body.append(section);
    return { section, tab };
  };
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  it('"View review" is not drawn while the review is on screen (Review selected in the results view), and comes back when it is not', async () => {
    const { section, tab } = surface('code', false);
    try {
      // what the workspace's viewReview does: the Review tab, and the results view
      const view = vi.fn(() => { tab.setAttribute('aria-selected', 'true'); section.setAttribute('data-focus-show', 'results'); });
      await render(<PhaseGateBanner phaseId="phase-6" phase={passed([task({})])} isLast={false} onViewReview={view} />);
      await act(async () => screen.getByTestId('gate-view-review').click());
      await settle();
      expect(screen.queryByTestId('gate-view-review')).toBeNull();
      expect(document.activeElement).toBe(tab);
      await act(async () => { tab.setAttribute('aria-selected', 'false'); });
      await settle();
      expect(screen.getByTestId('gate-view-review')).toBeTruthy();
    } finally { section.remove(); }
  });
  it('with Review selected but the code on screen (focused Code, a collapsed split, the code view after a Submit), the door stays', async () => {
    const { section } = surface('code', true);
    try {
      await render(<PhaseGateBanner phaseId="phase-6" phase={passed([task({})])} isLast={false} onViewReview={() => undefined} />);
      expect(screen.getByTestId('gate-view-review')).toBeTruthy();
      // the learner shows the results: the review is on screen, the door goes
      await act(async () => { section.setAttribute('data-focus-show', 'results'); });
      await settle();
      expect(screen.queryByTestId('gate-view-review')).toBeNull();
      // and back to the code (the e2e's focus-show-code): the door is there to press again
      await act(async () => { section.setAttribute('data-focus-show', 'code'); });
      await settle();
      expect(screen.getByTestId('gate-view-review')).toBeTruthy();
    } finally { section.remove(); }
  });
});

describe('the header’s Submit', () => {
  it('is named Submit PR-<n>, and Submit PR-<n> again once a submission exists', () => {
    expect(phaseSubmitLabel({ key: 'testing', place: 4 }, false)).toBe('Submit PR-4');
    expect(phaseSubmitLabel({ key: 'testing', place: 4 }, true)).toBe('Submit PR-4 again');
    expect(phaseSubmitLabel({ key: 'design', place: 2 }, false)).toBe('Submit for review');
    expect([submitLeads('inProgress'), submitLeads('revise'), submitLeads('credited'), submitLeads('reviewPassed'), submitLeads('awaiting')]).toEqual([true, true, true, false, false]);
  });
  it('leads on the strip’s row while there is work to hand in, and is read inside Details once the review passed', async () => {
    const inProgress = { id: 'p4', key: 'testing' as const, title: 'Testing', place: 4, count: 6, status: 'in_progress' as const, tasks: [task({ title: 'Testing', status: 'in_progress', attempts: 0 })], attempts: 0 };
    await render(<PhaseStrip phase={inProgress} workHeader right={<HeaderSubmit phase={inProgress} testId="header-submit" onClick={() => undefined} />} />);
    expect(host.querySelector('.phase-strip-primary [data-testid="header-submit"]')?.textContent).toBe('Submit PR-4');
    const done = { ...inProgress, status: 'passed' as const, attempts: 1, tasks: [task({ title: 'Testing' })], lastSubmission: { id: 's1', status: 'completed', passed: true, createdAt: '2026-11-17T00:00:00Z' } as never };
    await render(<PhaseStrip phase={done} workHeader right={<HeaderSubmit phase={done} testId="header-submit" onClick={() => undefined} />} />);
    expect(host.querySelector('.phase-strip-primary [data-testid="header-submit"]')).toBeNull();
    expect(host.querySelector('details.phase-strip-details [data-testid="header-submit"]')?.textContent).toBe('Submit PR-4 again');
  });
  it('on a document page\'s header it is the workspace header\'s size, `btn-sm`, leading or not', async () => {
    const inProgress = { id: 'p4', key: 'testing' as const, title: 'Testing', place: 4, count: 6, status: 'in_progress' as const, tasks: [task({ title: 'Testing', status: 'in_progress', attempts: 0 })], attempts: 0 };
    await render(<PhaseStrip phase={inProgress} workHeader right={<HeaderSubmit phase={inProgress} testId="header-submit" onClick={() => undefined} />} />);
    expect(host.querySelector('[data-testid="header-submit"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['btn', 'btn-sm']));
    const done = { ...inProgress, status: 'passed' as const, attempts: 1, tasks: [task({ title: 'Testing' })], lastSubmission: { id: 's1', status: 'completed', passed: true, createdAt: '2026-11-17T00:00:00Z' } as never };
    await render(<PhaseStrip phase={done} workHeader right={<HeaderSubmit phase={done} testId="header-submit" onClick={() => undefined} />} />);
    expect(host.querySelector('[data-testid="header-submit"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['btn-secondary', 'btn-sm']));
  });
  it('in each state of a phase, mounted on the strip: its name and whether it leads or is read inside Details', async () => {
    const base = { id: 'p4', key: 'testing' as const, title: 'Testing', place: 4, count: 6 };
    const revision = (passed: boolean) => ({ id: 's1', status: 'completed', passed, createdAt: '2026-11-17T00:00:00Z' }) as never;
    type Phase = Parameters<typeof HeaderSubmit>[0]['phase'];
    const states: [string, Phase, 'row' | 'details', string][] = [
      ['in progress', { ...base, status: 'in_progress' as const, attempts: 0, tasks: [task({ title: 'Testing', status: 'in_progress', attempts: 0 })] }, 'row', 'Submit PR-4'],
      ['needs revision', { ...base, status: 'in_progress' as const, attempts: 1, tasks: [task({ title: 'Testing', status: 'submitted' })], lastSubmission: revision(false) }, 'row', 'Submit PR-4 again'],
      ['awaiting the sign-off', { ...base, status: 'in_progress' as const, attempts: 1, tasks: [task({ title: 'Testing', status: 'submitted', awaitingSignOff: true, evidence: 'signed-off' })], lastSubmission: revision(true) }, 'details', 'Submit PR-4 again'],
      ['passed', { ...base, status: 'passed' as const, attempts: 1, tasks: [task({ title: 'Testing' })], lastSubmission: revision(true) }, 'details', 'Submit PR-4 again'],
    ];
    for (const [name, phase, where, label] of states) {
      await render(<PhaseStrip phase={phase} workHeader right={<HeaderSubmit phase={phase} testId="header-submit" onClick={() => undefined} />} />);
      const inRow = host.querySelector('.phase-strip-primary [data-testid="header-submit"]');
      const inDetails = host.querySelector('details.phase-strip-details [data-testid="header-submit"]');
      expect([name, (where === 'row' ? inRow : inDetails)?.textContent], name).toEqual([name, label]);
      expect([name, where === 'row' ? inDetails : inRow], name).toEqual([name, null]);
    }
  });
  it('every page says "Open the workspace"', () => {
    // Each page's own text for what it must not say; a page and what it draws for what it must.
    const page = (name: string) => `app/(app)/workspace/[phaseId]/${name}/page.tsx`;
    expect(moduleText(page('pr'))).not.toContain('Open in the workspace');
    expect(moduleText(page('matrix'))).not.toContain('Back to the workspace');
    expect(closureText(page('drill'))).toContain('testId="open-workspace">Open the workspace</Button>');
    expect(closureText('app/(app)/workspace/[phaseId]/page.tsx')).toContain('{phaseSubmitLabel(detail, hasPr)}');
  });
});

describe('breadcrumbs', () => {
  it('no page of a code phase has a "Work" level or a file name; the leaf is the record or the view', () => {
    const own = (name: string) => moduleText(`app/(app)/workspace/[phaseId]/${name}page.tsx`);
    const page = (name: string) => closureText(`app/(app)/workspace/[phaseId]/${name}page.tsx`);
    // The workspace room is split into modules the page imports, and its
    // breadcrumbs are drawn by one of them, so the whole room is read.
    expect(page('')).not.toContain("{ label: 'Work', href: '/phases' }");
    expect(page('')).not.toContain("activePath.split('/').pop()");
    expect(page('')).toMatch(/runtimeView === 'evidence' \? workingAreaLabels\.evidence : runtimeView === 'preview' \? previewLabel : workingAreaLabels\.edit/);
    expect(own('pr/')).not.toContain("{ label: 'Work', href: workHref }");
    expect(page('pr/')).toContain('{ label: detail?.title ?? PHASE_TITLES[phaseKey], href: `/phases?phase=${phaseKey}` },\n    { label: name },');
  });
});

describe('the Maintenance tour’s first step is true for the page as it opens', () => {
  it('points at the change request itself first, and names no control that opens it', () => {
    for (const application of [undefined, null]) {
      const [first] = phaseTutorialMarks('maintenance', true, application === undefined ? undefined : { application });
      expect(first.selector).toBe('[data-testid="change-title"]');
      expect(first.body).not.toMatch(/Show brief|Open Change request/);
    }
  });
});

describe('Deployment’s kicker stays on one line', () => {
  it('the project name is one truncated span after the phase, and the whole kicker is its title', async () => {
    await render(<PhaseBriefIntro phaseKey="deployment" />);
    const project = screen.getByTestId('phase-brief-kicker-project');
    const kicker = project.closest('small')!;
    expect(kicker.getAttribute('title')).toBe('DEPLOYMENT / YOUR PROJECT');
    expect(kicker.className.split(' ')).toEqual(['flex', 'min-w-0']);
    expect(project.textContent).toBe('YOUR PROJECT');
    expect(project.className.split(' ')).toEqual(['min-w-0', 'truncate']);
    expect(project.previousElementSibling?.textContent).toBe('DEPLOYMENT / ');
    expect(project.previousElementSibling?.className.split(' ')).toContain('shrink-0');
  });
});
