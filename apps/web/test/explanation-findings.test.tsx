// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExplanationFindings, explanationFindings } from '@/components/workspace/mentor/ExplanationFindings';

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Dimension = Record<string, unknown>;
const dimension = (key: string, patch: Dimension = {}): Dimension => ({
  key, met: false, finding: 'missing', learnerEvidence: [], reasoning: 'Private rationale.', ...patch,
});
const assessment = (dimensions: Dimension[], adequate = false) => ({
  adequate, feedback: 'A cited claim conflicts with the current proposal or recorded workflow.',
  questions: ['How does the cited claim compare with the current proposal?'], dimensions,
});
const render = async (value: unknown) => { await act(async () => root.render(<ExplanationFindings assessment={value} />)); };

describe('which of the learner’s own sentences the review cited', () => {
  it('shows the learner’s own cited sentence beside each rejected dimension', async () => {
    await render(assessment([
      dimension('effects', { met: true, finding: 'supported', learnerEvidence: ['The handler now returns the stored code.'] }),
      dimension('constraints', { met: true, finding: 'supported', learnerEvidence: ['It changes nothing outside that handler.'] }),
      dimension('verification', { met: true, finding: 'supported', learnerEvidence: ['I have not run the tests yet.'] }),
      dimension('consistency', { finding: 'contradicted', learnerEvidence: ['I already ran every test.'] }),
    ]));
    expect(host.textContent).toContain('I already ran every test.');
    expect(host.textContent).toContain('Conflicts with the proposal or a record');
    expect(host.textContent).toContain('These are the sentences from your own explanation that the review looked at.');
  });

  it('distinguishes a claim the review could not see from one it says conflicts', async () => {
    await render(assessment([dimension('verification', { finding: 'unsupported', learnerEvidence: ['INCIDENT-1 matched the resolved drill.'] })]));
    expect(host.textContent).toContain('Not visible to this review');
    expect(host.textContent).not.toContain('Conflicts with');
    expect(host.textContent).toContain('It does not mean the sentence is false.');
  });

  // The guard for every stored assessment that predates dimensioned records.
  it('renders nothing at all for an assessment without dimensions', async () => {
    const legacy = { adequate: false, feedback: 'Explain the change.', questions: ['What does it do?'] };
    expect(explanationFindings(legacy)).toEqual([]);
    expect(explanationFindings(null)).toEqual([]);
    expect(explanationFindings('a string')).toEqual([]);
    expect(explanationFindings({ dimensions: 'not an array' })).toEqual([]);
    await render(legacy);
    expect(host.innerHTML).toBe('');
  });

  it('renders nothing when every dimension cites nothing', async () => {
    const empty = assessment([dimension('effects'), dimension('constraints'), dimension('verification'), dimension('consistency')]);
    expect(explanationFindings(empty)).toEqual([]);
    await render(empty);
    expect(host.innerHTML).toBe('');
  });

  it('shows the cited sentences for an accepted explanation too', async () => {
    await render(assessment([dimension('effects', { met: true, finding: 'supported', learnerEvidence: ['The guard now rejects an empty title.'] })], true));
    expect(host.textContent).toContain('The guard now rejects an empty title.');
    expect(host.textContent).toContain('Supported');
  });

  it('never renders the reasoning field', async () => {
    await render(assessment([dimension('effects', { finding: 'contradicted', learnerEvidence: ['One cited sentence.'], reasoning: 'PRIVATE-RATIONALE-SENTINEL' })]));
    expect(host.textContent).toContain('One cited sentence.');
    expect(host.textContent).not.toContain('PRIVATE-RATIONALE-SENTINEL');
  });

  it('renders the four dimensions in their fixed order whatever order the API sent', async () => {
    await render(assessment([
      dimension('consistency', { finding: 'contradicted', learnerEvidence: ['Fourth sentence.'] }),
      dimension('verification', { finding: 'unsupported', learnerEvidence: ['Third sentence.'] }),
      dimension('constraints', { met: true, finding: 'supported', learnerEvidence: ['Second sentence.'] }),
      dimension('effects', { met: true, finding: 'supported', learnerEvidence: ['First sentence.'] }),
    ]));
    const quotes = [...host.querySelectorAll('blockquote')].map(node => node.textContent);
    expect(quotes).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.', 'Fourth sentence.']);
  });

  it('survives an unknown dimension key, an unknown finding and a non-string quote', async () => {
    await render(assessment([
      dimension('mood', { finding: 'supported', learnerEvidence: ['Dropped sentence.'] }),
      dimension('effects', { finding: 'undecided', learnerEvidence: ['Kept sentence.', 7, '', null] }),
    ]));
    expect(host.textContent).toContain('Kept sentence.');
    expect(host.textContent).not.toContain('Dropped sentence.');
    expect([...host.querySelectorAll('blockquote')]).toHaveLength(1);
    expect(explanationFindings(assessment([dimension('mood', { learnerEvidence: ['x'] })]))).toEqual([]);
  });

  // A newer server may name a finding in its own words. Whatever label string
  // arrives is what the learner reads; this build never overrides it with one
  // of the five values it knows.
  it('renders a label the API supplies rather than this release’s vocabulary', async () => {
    await render(assessment([dimension('verification', {
      finding: 'unsupported', label: 'unsupported by what the assessor can see', learnerEvidence: ['The drill was resolved.'],
    })]));
    expect(host.textContent).toContain('unsupported by what the assessor can see');
    expect(host.textContent).not.toContain('Not visible to this review');
  });

  it('quotes the learner verbatim without re-wrapping or truncating the sentence', async () => {
    const sentence = 'I kept the café threshold — and the guard — unchanged. ';
    await render(assessment([dimension('effects', { finding: 'contradicted', learnerEvidence: [sentence] })]));
    expect(host.querySelector('blockquote')?.textContent).toBe(sentence);
  });

  // jsdom lays nothing out and the runner replaces the stylesheet import with
  // nothing, so no case here can measure a pane. The 390px promise belongs to
  // the small-screen capture. What this one owns is the structure that promise
  // rests on: the quote sits inside the bounded region rather than beside it,
  // it carries no width of its own, and the rules that bound and wrap it are
  // still in the stylesheet the component imports.
  it('puts a long cited sentence inside the bounded region, under the rules that wrap it', async () => {
    const long = `${'word '.repeat(120)}end.`;
    await render(assessment([dimension('effects', { finding: 'contradicted', learnerEvidence: [long] })]));
    const quote = host.querySelector('blockquote')!;
    expect(quote.closest('.agentic-findings-scroll')).not.toBeNull();
    expect(quote.getAttribute('style')).toBeNull();
    const css = readFileSync(resolve(__dirname, '../components/workspace/mentor/ExplanationFindings.css'), 'utf8');
    expect(css).toMatch(/\.agentic-findings-scroll\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.agentic-findings-scroll\s*\{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.agentic-findings-scroll blockquote\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
