// @vitest-environment jsdom
/**
 * The Term popover and the glossary behind it.
 *
 * Two promises worth pinning. The glossary is the one list three surfaces
 * read, so it must hold exactly the ten words the brief names, in the product's
 * voice and naming no vendor. And a heading that carries a Term must still
 * read as the heading: the card is drawn only while it is open, so a spec that
 * reads `matrix-title` still reads "Kill matrix" and a screen reader still
 * hears the word, not the whole definition, as the heading's name.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { GLOSSARY, glossaryEntry } from '@/lib/glossary';
import { Term } from '@/components/ui/Term';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const TEN = [
  'gate',
  'process marks',
  'dossier',
  'artefacts',
  'kill matrix',
  'mutant',
  'runbook',
  'ledger',
  'pull request',
  'contract',
];

describe('glossary', () => {
  it('holds exactly the ten words the brief names, once each', () => {
    expect(GLOSSARY.map((e) => e.key)).toEqual(TEN);
  });

  it('writes every meaning as one or two plain sentences that name no vendor or course', () => {
    for (const entry of GLOSSARY) {
      expect(entry.meaning.length).toBeGreaterThan(40);
      expect(entry.meaning.length).toBeLessThan(320);
      expect(entry.meaning.endsWith('.')).toBe(true);
      expect(entry.meaning).not.toMatch(/!/);
      expect(entry.meaning).not.toMatch(/[·|]/);
      expect(entry.meaning).not.toMatch(/claude|openai|gpt|anthropic|cs\d{3}/i);
      expect(entry.word[0]).toBe(entry.word[0].toUpperCase());
    }
  });

  it('throws on a key it does not hold rather than drawing an empty card', () => {
    expect(() => glossaryEntry('widget' as never)).toThrow(/No glossary entry/);
  });
});

describe('Term', () => {
  it('draws the word and nothing else until it is focused', () => {
    const el = mount(
      <h1 data-testid="t">
        <Term term="kill matrix">Kill matrix</Term>
      </h1>,
    );
    expect(el.querySelector('h1')!.textContent).toBe('Kill matrix');
    expect(el.querySelector('[data-testid="term-card"]')).toBeNull();
    expect(el.querySelector('[data-testid="term-kill-matrix"]')).not.toBeNull();
  });

  it('opens the card on focus, describes the word by it, and closes it on Escape', () => {
    const el = mount(<Term term="gate" />);
    const word = el.querySelector<HTMLElement>('[data-testid="term-gate"]')!;
    expect(word.textContent).toBe('Gate');

    act(() => word.focus());
    const card = el.querySelector<HTMLElement>('[data-testid="term-card"]')!;
    expect(card).not.toBeNull();
    expect(card.getAttribute('role')).toBe('tooltip');
    expect(word.getAttribute('aria-describedby')).toBe(card.id);
    expect(card.textContent).toContain(glossaryEntry('gate').meaning);

    act(() => {
      word.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(el.querySelector('[data-testid="term-card"]')).toBeNull();
    expect(word.getAttribute('aria-describedby')).toBeNull();
  });

  it('opens on hover and closes when the pointer leaves', () => {
    const el = mount(<Term term="ledger">ledger</Term>);
    const wrap = el.querySelector<HTMLElement>('[data-testid="term-ledger"]')!.parentElement!;
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(el.querySelector('[data-testid="term-card"]')).not.toBeNull();
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(el.querySelector('[data-testid="term-card"]')).toBeNull();
  });
});
