// @vitest-environment jsdom
/**
 * The figure registry: each phase registers its figures, one line each, in
 * components/learn/figures/<phase>.tsx; registry.ts joins the six; the
 * reader draws a chapter's figures between "The idea" and "TaskTrackr,
 * worked". Every chapter of every guide has a figure, every id is unique,
 * every figure renders, and each chapter listed below draws its key fact
 * (each figure's own behaviour is
 * pinned in its phase's test file: guides-requirements-design, guides-implementation-testing,
 * guides-deployment-maintenance, mutation-table).
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';
import { FIGURES, figuresFor } from '@/components/learn/figures/registry';
import { ChapterFigures } from '@/components/learn/figures/ChapterFigures';
import { LessonReader } from '@/components/learn/LessonReader';
import { HowChecksWork } from '@/components/learn/HowChecksWork';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => { window.addEventListener('popstate', notify); return () => window.removeEventListener('popstate', notify); };
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')) };
});
vi.mock('@/components/shell', () => ({
  DocPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PersonaPanel: () => null,
  phaseDoorHref: () => '/workspace/phase',
  doorWithTasks: <T,>(phase: T) => phase,
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: null }) }));

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const render = (node: ReactNode) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, done: () => { act(() => root.unmount()); host.remove(); } };
};

describe('the figure registry', () => {
  it('holds all six phases, chapters 1 to 4, with ids unique across the guides', () => {
    expect(Object.keys(FIGURES)).toEqual(KEYS);
    const ids = KEYS.flatMap((k) => Object.keys(FIGURES[k]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of KEYS) for (const [id, entry] of Object.entries(FIGURES[k])) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(id.startsWith(`${k}-`)).toBe(true);
      expect([1, 2, 3, 4]).toContain(entry.chapter);
    }
  });

  it('gives every chapter of every guide at least one figure', () => {
    for (const k of KEYS) for (let chapter = 1; chapter <= 4; chapter += 1) {
      expect(figuresFor(k, chapter).length, `${k} ${chapter}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders every registered figure on its own without throwing, as a figure with a caption and an honesty tag', () => {
    for (const k of KEYS) for (const [id, entry] of Object.entries(FIGURES[k])) {
      const Component = entry.component;
      const { host, done } = render(<Component />);
      expect(host.querySelector('figure figcaption'), id).not.toBeNull();
      // None of the figures is the learner's own data or a run of it, so each says so.
      expect(host.querySelector('figcaption .fig-model-tag')?.textContent, id).toBeTruthy();
      done();
    }
  });

  it('answers a chapter with its figures in registration order', () => {
    expect(figuresFor('testing', 1).map((f) => f.id)).toEqual(['testing-pyramid']);
    expect(figuresFor('testing', 2).map((f) => f.id)).toEqual(['testing-fixture-isolation', 'testing-response-read-restart']);
    expect(figuresFor('testing', 4).map((f) => f.id)).toEqual(['testing-mutation-table']);
    expect(figuresFor('implementation', 4).map((f) => f.id)).toEqual(['implementation-evidence-ledger', 'implementation-propose-explain-apply']);
    expect(figuresFor('design', 2).map((f) => f.id)).toEqual(['design-list-cardinality']);
  });

  // A key fact each of these chapters must draw, as words in its figure.
  const CHAPTER_FIGURE_FACTS: [PhaseKey, number, string][] = [
    ['requirements', 2, 'this picture does not create backlog records'],
    ['design', 2, 'every task requires one parent list'],
    ['design', 3, 'the route returns 400 with invalid_name'],
    ['implementation', 3, 'Cleanup makes the former request context inactive so its later callbacks cannot overwrite the current state.'],
    ['testing', 2, 'These are proposed observations, not recorded executions.'],
    ['deployment', 3, 'not evidence that a deployment ran'],
    ['maintenance', 1, 'A changed file can affect a view you did not open.'],
  ];
  it('draws each of those facts in its chapter’s figures', () => {
    for (const [phaseKey, chapter, fact] of CHAPTER_FIGURE_FACTS) {
      const { host, done } = render(<ChapterFigures phaseKey={phaseKey} chapterIndex={chapter - 1} />);
      expect(host.textContent, `${phaseKey} ${chapter}`).toContain(fact);
      done();
    }
  });

  it('wraps each figure in a slot carrying its id and no box of its own', () => {
    const { host, done } = render(<ChapterFigures phaseKey="design" chapterIndex={2} />);
    const slots = host.querySelectorAll('.lesson-figure');
    expect([...slots].map((slot) => slot.getAttribute('data-figure-id'))).toEqual(figuresFor('design', 3).map((f) => f.id));
    const slot = host.querySelector('.lesson-figure[data-figure-id="design-invalid-name-sequence"]')!;
    expect(slot.querySelector('svg[role="img"]')).not.toBeNull();
    expect(slot.firstElementChild?.tagName).toBe('FIGURE');
    done();
  });
});

describe('the reader draws the registered figures in the chapter', () => {
  const open = (phaseKey: PhaseKey, chapter: number) => {
    window.history.replaceState(null, '', `/learn/${phaseKey}?chapter=${chapter}`);
    return render(<LessonReader phaseKey={phaseKey} />);
  };

  it('draws every chapter’s figures, in order, after "The idea" and before "TaskTrackr, worked"', () => {
    for (const phaseKey of KEYS) for (let chapter = 1; chapter <= 4; chapter += 1) {
      const { host, done } = open(phaseKey, chapter);
      const article = host.querySelector('.lesson-article')!;
      const slots = [...article.querySelectorAll('[data-figure-id]')];
      expect(slots.map((slot) => slot.getAttribute('data-figure-id')), `${phaseKey} ${chapter}`).toEqual(figuresFor(phaseKey, chapter).map((f) => f.id));
      const idea = article.querySelector('.lesson-idea')!;
      const worked = article.querySelector('.lesson-worked-example')!;
      for (const slot of slots) {
        expect(idea.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING, `${phaseKey} ${chapter}`).toBeTruthy();
        expect(slot.compareDocumentPosition(worked) & Node.DOCUMENT_POSITION_FOLLOWING, `${phaseKey} ${chapter}`).toBeTruthy();
      }
      done();
    }
  });

  it('keeps the testing pyramid on Testing chapter 1', () => {
    const { host, done } = open('testing', 1);
    expect(host.querySelector('[data-figure-id="testing-pyramid"] .testing-pyramid')).not.toBeNull();
    done();
  });

  it('draws the mutation table on Testing chapter 4 and nowhere else', () => {
    for (const phaseKey of KEYS) for (let chapter = 1; chapter <= 4; chapter += 1) {
      const { host, done } = open(phaseKey, chapter);
      const here = phaseKey === 'testing' && chapter === 4;
      expect(host.querySelectorAll('[data-figure-id="testing-mutation-table"]'), `${phaseKey} ${chapter}`).toHaveLength(here ? 1 : 0);
      // By what it draws too, so the table registered under another id is caught.
      expect(host.querySelectorAll('.fig-mutation-controls'), `${phaseKey} ${chapter}`).toHaveLength(here ? 1 : 0);
      if (here) expect(host.querySelector('[data-figure-id="testing-mutation-table"] table')).not.toBeNull();
      done();
    }
    const registered = KEYS.flatMap((k) => Object.entries(FIGURES[k]).filter(([id]) => id === 'testing-mutation-table').map(([, e]) => `${k} ${e.chapter}`));
    expect(registered).toEqual(['testing 4']);
  });
});

describe('phone width and keyboard, in markup and CSS', () => {
  // Every figure, and the catalogue's walk through propose, explain, apply,
  // with each step of a step-through visited.
  const all: [string, () => ReactNode][] = [
    ...KEYS.flatMap((k) => Object.entries(FIGURES[k]).map(([id, entry]) => [id, () => { const C = entry.component; return <C />; }] as [string, () => ReactNode])),
    ['how-checks-work', () => <HowChecksWork />],
  ];
  const visit = (host: HTMLElement, check: () => void) => {
    check();
    for (let i = 0; i < 6; i += 1) {
      const next = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Next' && !b.disabled);
      if (!next) break;
      act(() => next.click());
      check();
    }
  };
  const nameOf = (el: HTMLElement) =>
    el.getAttribute('aria-label')?.trim() || (el.id && el.ownerDocument.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) || el.closest('label')?.textContent?.trim() || el.textContent?.trim() || '';

  it('puts every table inside a figure in its own scrolling box', () => {
    let tables = 0;
    for (const [id, make] of all) {
      const { host, done } = render(make());
      visit(host, () => {
        for (const table of host.querySelectorAll('table')) {
          tables += 1;
          expect(table.closest('.experience-scroll-viewport, .fig-scroll'), `${id}: ${table.querySelector('caption')?.textContent}`).not.toBeNull();
        }
      });
      done();
    }
    // The eight figure tables, and the review table on the propose step-through.
    expect(tables).toBeGreaterThanOrEqual(9);
  });

  it('makes every control a real button or input with a name', () => {
    for (const [id, make] of all) {
      const { host, done } = render(make());
      visit(host, () => {
        for (const el of host.querySelectorAll<HTMLElement>('[role="button"], [tabindex]:not([tabindex="-1"])')) {
          if (el.getAttribute('role') === 'region' || el.tagName === 'svg') continue;
          expect(['BUTTON', 'INPUT', 'A', 'SELECT', 'SUMMARY'], `${id}: ${el.outerHTML.slice(0, 80)}`).toContain(el.tagName);
        }
        for (const el of host.querySelectorAll<HTMLElement>('button, input, select, a')) expect(nameOf(el), `${id}: ${el.outerHTML.slice(0, 80)}`).not.toBe('');
      });
      done();
    }
  });

  it('draws a focus ring on every kind of control a figure holds, and the phone-width table rule', () => {
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/figures.css'), 'utf8');
    expect(css).toMatch(/\.fig :is\(button, a, input, select, summary, \[tabindex="0"\]\):focus-visible \{ outline: 2px solid/);
    const phone = css.slice(css.indexOf('@media (max-width: 520px)'));
    expect(phone).toContain('.fig-table:has(thead th:nth-child(4)) { min-width: 480px; }');
  });
});
