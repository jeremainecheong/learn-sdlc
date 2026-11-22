// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getByRole } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalComparison } from '@/components/workspace/mentor/ProposalComparison';
import { ProposalChangeSummary } from '@/components/workspace/mentor/ProposalChangeSummary';
import { MAX_LEAVES, analyseChange, type ChangeAnalysis } from '@/components/workspace/mentor/proposalChange';

const mocks = vi.hoisted(() => ({ phase: vi.fn(), owner: 'owner-a' }));
// Plain counters rather than spies: the suite's job is to pin how often the
// comparison measures, and a counter that delegates to the real module cannot
// change what any other case in this file sees.
const counted = vi.hoisted(() => ({ analyse: 0, quote: 0 }));
vi.mock('@/components/workspace/mentor/proposalChange', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/workspace/mentor/proposalChange')>();
  return {
    ...actual,
    analyseChange: (...args: Parameters<typeof actual.analyseChange>) => { counted.analyse += 1; return actual.analyseChange(...args); },
    narrowRequestSentence: (...args: Parameters<typeof actual.narrowRequestSentence>) => { counted.quote += 1; return actual.narrowRequestSentence(...args); },
  };
});
vi.mock('@/lib/api', () => ({ api: { phase: mocks.phase }, describeError: (err: Error) => err.message }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ id: mocks.owner }), getSession: () => ({ id: mocks.owner }) }));
let root: Root, host: HTMLDivElement;
const files = { 'code.ts': 'const first = 1;\nconst changed = true;\nconst last = 3;\n' };
const phase = (content = 'const first = 1;\nconst changed = false;\nconst last = 3;\n') => ({ id: 'phase-a', files: [{ path: 'code.ts', content, editable: true }, { path: 'private-reference.ts', content: 'Reference solution stays outside comparison.', editable: false }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const render = async (id = 'phase-a') => { await act(async () => root.render(<ProposalComparison key={`${mocks.owner}:${id}`} phaseId={id} files={files}/>)); };
const click = async (name: string) => { await act(async () => getByRole<HTMLButtonElement>(host, 'button', { name }).click()); };
beforeEach(() => { vi.clearAllMocks(); counted.analyse = 0; counted.quote = 0; mocks.owner = 'owner-a'; mocks.phase.mockResolvedValue(phase()); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('current saved-file proposal comparison', () => {
  it('loads only on request and displays real changed lines with context and explicit comparison provenance', async () => {
    await render(); expect(mocks.phase).not.toHaveBeenCalled();
    await click('Compare with saved files');
    expect(mocks.phase).toHaveBeenCalledExactlyOnceWith('phase-a');
    expect(host.textContent).toContain('1 removed, 1 added');
    expect(host.querySelector('tr[data-change="-"] code')?.textContent).toBe('const changed = false;');
    expect(host.querySelector('tr[data-change="+"] code')?.textContent).toBe('const changed = true;');
    expect(host.textContent).toContain('const first = 1;');
    expect(host.textContent).toContain('Unsaved workspace edits are not included.');
    expect(host.textContent).toContain('does not confirm that the proposal is still current.');
    expect(host.textContent).not.toContain('Reference solution');
    expect(getByRole(host, 'region', { name: 'Changed lines: code.ts' }).getAttribute('tabindex')).toBe('0');
  });
  it('keeps a failed comparison retryable without hiding or replacing the proposed files', async () => {
    mocks.phase.mockRejectedValueOnce(new Error('Saved files are offline.')).mockResolvedValueOnce(phase());
    await render(); await click('Compare with saved files');
    expect(getByRole(host, 'alert').textContent).toContain('Saved files are offline.');
    await click('Retry saved-file comparison');
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.textContent).toContain('1 removed, 1 added'); expect(files['code.ts']).toContain('changed = true');
  });
  it('shows accessible pending state and prevents duplicate reads', async () => {
    const pending = deferred<ReturnType<typeof phase>>(); mocks.phase.mockReturnValue(pending.promise);
    await render(); await click('Compare with saved files');
    expect(getByRole<HTMLButtonElement>(host, 'button', { name: 'Loading saved files…' }).disabled).toBe(true);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await click('Loading saved files…'); expect(mocks.phase).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(phase())); expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  });
  it.each(['phase', 'account'] as const)('ignores a late private saved copy after the %s changes', async kind => {
    const pending = deferred<ReturnType<typeof phase>>(); mocks.phase.mockReturnValue(pending.promise);
    await render(); await click('Compare with saved files');
    if (kind === 'account') mocks.owner = 'owner-b';
    await render(kind === 'phase' ? 'phase-b' : 'phase-a');
    await act(async () => pending.resolve(phase('Private old-owner bytes.')));
    expect(host.textContent).not.toContain('Private old-owner'); expect(host.querySelector('table')).toBeNull();
  });
  it('rejects a phase mismatch and labels newline-only differences without claiming identical bytes', async () => {
    mocks.phase.mockResolvedValueOnce({ ...phase(), id: 'phase-b' }).mockResolvedValueOnce(phase(files['code.ts'].replace(/\n$/, '')));
    await render(); await click('Compare with saved files'); expect(getByRole(host, 'alert').textContent).toContain('different phase');
    await click('Retry saved-file comparison'); expect(host.textContent).toContain('line endings or the final newline differ'); expect(host.textContent).not.toContain('contents match');
  });
});

const CONTRACT = 'shared/contract/api.json';
const operations = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `operation${index}`, method: 'GET', path: `/thing/${index}` }));
const savedContract = JSON.stringify({ version: 1, operations: operations(60) }, null, 2);
const proposedContract = JSON.stringify({ version: 1, operations: operations(60), tags: { created_at: '2026-09-17T00:00:00Z' } });
const phaseWith = (path: string, content: string) => ({ id: 'phase-a', files: [{ path, content, editable: true }, { path: 'private-reference.ts', content: 'Reference solution stays outside comparison.', editable: false }] });
const renderWith = async (proposed: Record<string, string>, request?: string) => {
  await act(async () => root.render(<ProposalComparison key={`${mocks.owner}:phase-a`} phaseId="phase-a" files={proposed} request={request} />));
};

describe('the proposal comparison in fields as well as lines', () => {
  it('names the JSON fields that differ beside the line summary, outside the line table', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    await renderWith({ [CONTRACT]: proposedContract });
    await click('Compare with saved files');
    expect(mocks.phase).toHaveBeenCalledExactlyOnceWith('phase-a');
    expect(host.textContent).toContain('tags.created_at');
    expect(host.textContent).toContain('1 field added');
    // The line table is what a recorded harness counts, so nothing new lives in
    // it and nothing of it moves into the field list.
    expect(host.querySelectorAll('.agentic-diff-scroll tr[data-change]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.agentic-diff-scroll tr[data-field-change]')).toHaveLength(0);
    expect(host.querySelectorAll('.agentic-structural-scroll tr[data-change]')).toHaveLength(0);
    expect(host.textContent).toContain(`${savedContract.split('\n').length} removed, 1 added`);
  });

  it('warns in plain words when the line churn dwarfs the field change', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    await renderWith({ [CONTRACT]: proposedContract });
    await click('Compare with saved files');
    const flag = host.querySelector('[data-testid="proposal-churn-flag"]')!;
    expect(flag).not.toBeNull();
    expect(flag.textContent).toContain(`${savedContract.split('\n').length + 1} changed lines`);
    expect(flag.textContent).toContain('only 1 field differs');
    // It is a note beside the comparison, never a second live region.
    expect(flag.getAttribute('role')).toBe('note');
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('quotes the learner’s own narrowing request when one was made', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    await renderWith({ [CONTRACT]: proposedContract }, 'Correct AC-2 only, change nothing else.');
    await click('Compare with saved files');
    expect(host.querySelector('[data-testid="proposal-churn-flag"]')!.textContent).toContain('change nothing else');
  });

  // A fragment lifted out of the sentence can drop the learner's scope: "Add
  // the tags and don't change anything else" quoted as "don't change" reads as
  // a blanket prohibition they never stated, under their own name.
  it('quotes the learner’s whole narrowing sentence, never a fragment of it', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    const request = 'Add the tags and don\'t change anything else.';
    await renderWith({ [CONTRACT]: proposedContract }, request);
    await click('Compare with saved files');
    const flag = host.querySelector('[data-testid="proposal-churn-flag"]')!;
    expect(flag.textContent).toContain(`Your request said “${request}”`);
    expect(flag.textContent).not.toContain('said “don\'t change”');
  });

  // The comparison is live against the bytes on screen, and the panel around it
  // re-renders on every keystroke in the composer and in every proposed-file
  // textarea. Measuring is per file and per byte, never per render.
  it('measures a file once and not again when a keystroke leaves its bytes alone', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    const request = 'Correct AC-2 only, change nothing else.';
    const proposed = { [CONTRACT]: proposedContract };
    await renderWith(proposed, request);
    await click('Compare with saved files');
    expect(counted.analyse).toBe(1);
    const quoted = counted.quote;
    expect(quoted).toBeGreaterThan(0);

    await renderWith({ ...proposed }, request);
    expect(counted.analyse).toBe(1);
    expect(counted.quote).toBe(quoted);

    await renderWith({ [CONTRACT]: `${proposedContract}\n` }, request);
    expect(counted.analyse).toBe(2);
  });

  it('never attributes a stored context envelope to the learner', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    const envelope = JSON.stringify({ selectedProposalOriginalRequest: 'Correct AC-2 only, change nothing else.', currentLearnerMessage: 'Add the tags.' });
    await renderWith({ [CONTRACT]: proposedContract }, envelope);
    await click('Compare with saved files');
    expect(host.textContent).not.toContain('change nothing else');
    expect(host.textContent).not.toContain('selectedProposalOriginalRequest');
  });

  // Regression guard: it passes before this change too, because the warning did
  // not exist. It pins that a small honest edit stays silent afterwards.
  it('says nothing about churn for a small honest edit', async () => {
    await render(); await click('Compare with saved files');
    expect(host.querySelector('[data-testid="proposal-churn-flag"]')).toBeNull();
    expect(host.querySelector('.agentic-structural-scroll')).toBeNull();
    expect(host.textContent).toContain('1 removed, 1 added');
  });

  it('says which side stopped being valid JSON instead of silently showing lines only', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    await renderWith({ [CONTRACT]: savedContract.slice(0, savedContract.length - 3) });
    await click('Compare with saved files');
    expect(host.textContent).toContain('The proposed file is not valid JSON, so only the line diff is shown.');
    expect(host.querySelector('.agentic-structural-scroll')).toBeNull();
  });

  it('keeps the field list inside its own bounded region, named apart from the line table', async () => {
    mocks.phase.mockResolvedValue(phaseWith(CONTRACT, savedContract));
    await renderWith({ [CONTRACT]: proposedContract });
    await click('Compare with saved files');
    const fields = getByRole(host, 'region', { name: `Fields that differ: ${CONTRACT}` });
    expect(fields.getAttribute('tabindex')).toBe('0');
    expect(fields.className).toContain('agentic-structural-scroll');
    expect(getByRole(host, 'region', { name: `Changed lines: ${CONTRACT}` })).not.toBe(fields);
  });
});

/**
 * Every sentence the per-file summary can print, read back verbatim.
 *
 * The comparison test above reaches two of them through the panel. The rest
 * (the flagship "only the file's layout changed", both word-occurrence forms,
 * each parse state and the cap) could carry a typo, a wrong plural or an
 * inverted condition with every suite still green.
 */
describe('one file’s change summary, sentence by sentence', () => {
  const summarise = async (analysis: ChangeAnalysis) => { await act(async () => root.render(<ProposalChangeSummary analysis={analysis} />)); };
  const reflowed = { version: 1, title: 'Contract', owner: 'team', updated: '2026-09-17', notes: 'kept' };

  it('says only the layout changed when a JSON file was reflowed and no field differs', async () => {
    await summarise(analyseChange('design/design.json', JSON.stringify(reflowed, null, 2), JSON.stringify(reflowed), { adds: 1, dels: 7 }));
    expect(host.textContent).toBe('Compared field by field: no JSON field differs. 7 lines removed and 1 added, so only the file’s layout changed.');
  });

  it('says no word differs when a text file was rewrapped and nothing else', async () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
    await summarise(analyseChange('notes.md', words.join('\n'), words.join(' '), { adds: 1, dels: 60 }));
    expect(host.textContent).toBe('60 lines removed and 1 added, and no word differs. Only the layout changed.');
  });

  it.each([
    ['alpha beta gamma', '20 lines removed and 20 added, but only 1 word occurrence differs. The rest is re-layout.'],
    ['alpha beta gamma delta', '20 lines removed and 20 added, but only 2 word occurrences differ. The rest is re-layout.'],
  ])('counts one word occurrence and two in their own words', async (proposed, sentence) => {
    await summarise(analyseChange('notes.md', 'alpha beta', proposed, { adds: 20, dels: 20 }));
    expect(host.textContent).toBe(sentence);
  });

  it.each([
    ['{oops', JSON.stringify({ a: 1 }), 'The saved file is not valid JSON, so only the line diff is shown.'],
    ['{oops', '{oops too', 'Neither copy is valid JSON, so only the line diff is shown.'],
  ])('names which copy stopped being valid JSON', async (saved, proposed, sentence) => {
    await summarise(analyseChange('story.json', saved, proposed, { adds: 2, dels: 2 }));
    expect(host.textContent).toBe(sentence);
  });

  // A partial field list under a heading reading "Fields that differ" is the
  // failure this component exists to prevent, so a capped comparison withholds
  // the list rather than drawing one that reads as complete.
  it('withholds the field list entirely when the comparison hit its cap', async () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_LEAVES + 1 }, (_, index) => [`k${index}`, index]));
    await summarise(analyseChange('wide.json', JSON.stringify(wide, null, 2), JSON.stringify({ ...wide, k0: 'changed' }), { adds: 900, dels: 900 }));
    expect(host.textContent).toBe('This file is too large to compare field by field, so only the line diff is shown.');
    expect(host.querySelector('.agentic-structural-scroll')).toBeNull();
  });

  it('numbers a moved entry against the entries kept in both copies, and says so', async () => {
    const saved = JSON.stringify({ operations: [{ name: 'a' }, { name: 'b' }] }, null, 2);
    const proposed = JSON.stringify({ operations: [{ name: 'b' }, { name: 'a' }] }, null, 2);
    await summarise(analyseChange('shared/contract/api.json', saved, proposed, { adds: 4, dels: 4 }));
    expect(host.textContent).toContain('Compared field by field: 2 entries moved.');
    expect(host.textContent).toContain('Moved entries are numbered by their order among the entries kept in both copies.');
    expect([...host.querySelectorAll('tr[data-field-change="moved"] code')].map(cell => cell.textContent)).toEqual(['1 → 2', '2 → 1']);
  });

  it('never says a document that was emptied was added', async () => {
    await summarise(analyseChange('design/contracts.json', JSON.stringify({ a: 1 }, null, 2), '{}', { adds: 1, dels: 3 }));
    expect(host.textContent).toContain('Compared field by field: 1 field removed and 1 field changed.');
    expect([...host.querySelectorAll('tr[data-field-change]')].map(row => row.getAttribute('data-field-change'))).toEqual(['removed', 'changed']);
    expect(host.querySelector('tr[data-field-change="changed"] td')?.textContent).toBe('the whole document');
    expect(host.textContent).not.toContain('field added');
  });

  it('says nothing at all for a file with nothing measured to say', async () => {
    await summarise(analyseChange('new.md', undefined, 'A brand new file.', { adds: 1, dels: 0 }));
    expect(host.innerHTML).toBe('');
  });
});
