// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LessonReader, splitWhere } from '@/components/learn/LessonReader';
import { LESSONS } from '@/components/learn/content';

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => { window.addEventListener('popstate', notify); return () => window.removeEventListener('popstate', notify); };
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')) };
});

it('provides a distinct authored response for every available choice in all six guides', () => {
  for (const lesson of Object.values(LESSONS)) {
    for (const chapter of lesson.chapters) {
      expect(chapter.optionFeedback).toHaveLength(chapter.options.length);
      expect(new Set(chapter.optionFeedback).size).toBe(chapter.options.length);
      expect(chapter.optionFeedback[chapter.correct]).toBeTruthy();
    }
  }
});
vi.mock('@/components/shell', () => ({
  DocPage: ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => <><main>{children}</main>{aside}</>,
  PersonaPanel: ({ onClose }: { onClose: () => void }) => <><button onClick={onClose}>Close mentor</button><textarea data-testid="chat-input" aria-label="Mentor question" /></>,
  phaseDoorHref: () => '/workspace/phase',
  // The door reads the task list its caller already holds; this stand-in
  // holds none, so the join is the identity it is for every caller with no
  // details map.
  doorWithTasks: <T,>(phase: T) => phase,
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: { phases: [{ id: 'phase', key: 'requirements', status: 'current', order: 1 }] } }) }));

it('keeps one chapter walkthrough and practice exercise through mentor toggles and chapter navigation', () => {
  window.history.replaceState(null, '', '/learn/requirements');
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => { push(...args); window.dispatchEvent(new PopStateEvent('popstate')); });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  try {
    act(() => root.render(<LessonReader phaseKey="requirements" />));
    const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent?.trim() === label)!;
    for (let round = 0; round < 3; round += 1) {
      act(() => button('Ask Mira').click());
      const input = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
      input.value = 'An unsent lesson question';
      act(() => button('Close mentor').click());
      expect(host.querySelector('#lesson-mentor')?.hasAttribute('hidden')).toBe(true);
      expect(host.querySelector('[data-testid="chat-input"]')).toBe(input);
      expect(input.value).toBe('An unsent lesson question');
      expect(host.querySelectorAll('.lesson-study-walkthrough')).toHaveLength(1);
      expect(host.querySelectorAll('.lesson-practice')).toHaveLength(1);
    }
    const disclosure = host.querySelector<HTMLDetailsElement>('.lesson-transfer-practice details')!;
    act(() => disclosure.querySelector('summary')!.click());
    expect(disclosure.open).toBe(true);
    act(() => button('Next chapter').click());
    expect(host.querySelectorAll('.lesson-study-walkthrough')).toHaveLength(1);
    expect(host.querySelectorAll('.lesson-practice')).toHaveLength(1);
    expect(host.querySelector<HTMLDetailsElement>('.lesson-transfer-practice details')!.open).toBe(false);
    expect(document.activeElement).toBe(host.querySelector('#lesson-chapter-title'));
    expect(scroll).toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); }
});

/* ------------------------------ the chapter page ------------------------------ */

const openReader = (phaseKey: 'requirements' | 'design' | 'implementation' | 'testing' | 'deployment' | 'maintenance', chapter: number) => {
  window.history.replaceState(null, '', `/learn/${phaseKey}?chapter=${chapter}`);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<LessonReader phaseKey={phaseKey} />));
  return { host, done: () => { act(() => root.unmount()); host.remove(); } };
};

it('draws every chapter in one order: aim, where you use it, the idea, figures, worked example, check yourself, takeaway', async () => {
  const { PHASE_STUDY } = await import('@/components/learn/study');
  for (const phaseKey of ['requirements', 'testing', 'deployment'] as const) {
    for (let chapter = 1; chapter <= 4; chapter += 1) {
      const { host, done } = openReader(phaseKey, chapter);
      const article = host.querySelector('.lesson-article')!;
      const order = ['.lesson-study-objective', '.lesson-where', '.lesson-idea', '.lesson-study-walkthrough', '.lesson-check', '.lesson-chapter-takeaway', '.lesson-chapter-footer']
        .map((selector) => { const found = article.querySelectorAll(selector); expect(found, `${phaseKey} ${chapter} ${selector}`).toHaveLength(1); return found[0]; });
      for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const figure of article.querySelectorAll('[data-figure-id]')) {
        expect(order[2].compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(figure.compareDocumentPosition(order[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      const study = PHASE_STUDY[phaseKey].chapters[chapter - 1];
      expect(article.querySelector('.lesson-idea h3')?.textContent).toBe('The idea');
      expect(article.querySelector('.lesson-idea')?.textContent).toContain(study.explanation);
      expect(article.querySelector('.lesson-worked-example pre')?.textContent).toBe(study.example);
      expect(article.querySelectorAll('.lesson-worked-steps > li')).toHaveLength(study.steps.length);
      expect(order[4].querySelector('.lesson-practice')).not.toBeNull();
      expect(order[4].querySelector('.lesson-transfer-practice details')).not.toBeNull();
      expect(order[4].querySelector('h3')?.textContent).toBe('Check yourself');
      // The decorative render beside the worked example is gone (owner decision 5.1).
      expect(article.querySelector('.lesson-worked-example img')).toBeNull();
      expect(article.querySelectorAll('img[src*="-3d.webp"]')).toHaveLength(0);
      // The path is drawn once, above the chapters, not in each chapter.
      expect(article.querySelector('.lesson-flow')).toBeNull();
      expect(host.querySelectorAll('.lesson-path')).toHaveLength(1);
      // At most one guide term per chapter.
      expect(article.querySelectorAll('[data-lesson-term]').length).toBeLessThanOrEqual(1);
      done();
    }
  }
});

it('names where the chapter is used and links to the phase when the learner holds it', () => {
  const { host, done } = openReader('requirements', 1);
  const where = host.querySelector('[data-testid="lesson-where"]')!;
  expect(where.textContent).toContain('Where you use this:');
  expect(where.querySelector('a')?.getAttribute('href')).toBe('/workspace/phase');
  // Only the room is the link; the part of the room it names stays words.
  expect(where.querySelector('a')?.textContent).toBe('Requirements room');
  expect(where.textContent).toBe('Where you use this: Requirements room, Interview the customer');
  done();
  const other = openReader('testing', 1);
  const plain = other.host.querySelector('[data-testid="lesson-where"]')!;
  expect(plain.querySelector('a')).toBeNull();
  expect(plain.textContent).toContain('Testing room');
  other.done();
});

it('says where every one of the 24 chapters is used, once, in the chapter header and never in the fallback words', async () => {
  const { PHASE_STUDY } = await import('@/components/learn/study');
  for (const phaseKey of ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const) {
    for (let chapter = 1; chapter <= 4; chapter += 1) {
      const { host, done } = openReader(phaseKey, chapter);
      const article = host.querySelector('.lesson-article')!;
      const chips = article.querySelectorAll('[data-testid="lesson-where"]');
      expect(chips, `${phaseKey} ${chapter}`).toHaveLength(1);
      expect(chips[0].textContent).toBe(`Where you use this: ${PHASE_STUDY[phaseKey].chapters[chapter - 1].where}`);
      expect(chips[0].textContent).not.toContain('in your project space');
      // Drawn once: no figure on the chapter says it again.
      expect(article.textContent!.split('Where you use this').length - 1, `${phaseKey} ${chapter}`).toBe(1);
      done();
    }
  }
});

// The guide term each chapter marks: the chapter's own idea where the
// guides' list has a word for it, none where the only listed word is used in
// another sense (Implementation 1's function "contract", Testing 3's screen
// "readiness") or no listed word appears.
const MARKED_TERMS = {
  requirements: [null, 'epic', 'acceptance-criterion', 'contract'],
  design: ['contract', 'cardinality', null, 'contract'],
  implementation: [null, null, null, 'contract'],
  testing: [null, 'fixture', null, 'killed'],
  deployment: ['image', 'health-check', 'container', 'runbook'],
  maintenance: ['impact-analysis', 'cardinality', 'contract', 'regression'],
} as const;

it('marks the chosen guide term, or none, on each of the 24 chapters', () => {
  for (const [phaseKey, terms] of Object.entries(MARKED_TERMS) as [keyof typeof MARKED_TERMS, readonly (string | null)[]][]) {
    terms.forEach((term, i) => {
      const { host, done } = openReader(phaseKey, i + 1);
      const marked = [...host.querySelectorAll('.lesson-idea [data-lesson-term]')].map((el) => el.getAttribute('data-lesson-term'));
      expect(marked, `${phaseKey} ${i + 1}`).toEqual(term ? [term] : []);
      done();
    });
  }
});

it('marks no step in the path on any guide: the chapter cards mark the open chapter', () => {
  // Only Requirements has one path step per chapter; a mark there made its
  // path look different from the other five guides'.
  for (const phaseKey of ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const) {
    const { host, done } = openReader(phaseKey, 3);
    expect(host.querySelectorAll('.lesson-path li').length, phaseKey).toBeGreaterThan(0);
    expect(host.querySelector('.lesson-path li[aria-current]'), phaseKey).toBeNull();
    expect(host.querySelectorAll('.lesson-chapters > button[aria-current="step"]'), phaseKey).toHaveLength(1);
    done();
  }
});

it('shows the chosen option’s feedback under its card, in words, and clears it on a new choice', async () => {
  const { Practice } = await import('@/components/learn/LessonReader');
  const chapter = LESSONS.testing.chapters[3];
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<Practice chapter={chapter} />));
  const cards = [...host.querySelectorAll('.lesson-practice-option')];
  expect(cards).toHaveLength(3);
  expect(cards.map((card) => card.querySelector('.lesson-practice-letter')?.textContent)).toEqual(['A', 'B', 'C']);
  const wrong = [0, 1, 2].find((i) => i !== chapter.correct)!;
  act(() => cards[wrong].querySelector('input')!.click());
  act(() => host.querySelector('button')!.click());
  const status = cards[wrong].querySelector('[role="status"]')!;
  expect(status.textContent).toContain('Revisit the example.');
  expect(status.textContent).toContain(chapter.optionFeedback[wrong]);
  expect(status.getAttribute('data-fits')).toBe('false');
  act(() => cards[chapter.correct].querySelector('input')!.click());
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => host.querySelector('button')!.click());
  expect(cards[chapter.correct].querySelector('[role="status"]')?.textContent).toContain('That fits this example.');
  act(() => root.unmount());
});

it('defines a guide term on hover or focus from the guides’ own list, and closes on Escape', async () => {
  const { TermParagraphs, chooseTerm } = await import('@/components/learn/figures/LessonTerm');
  const { LESSON_TERMS } = await import('@/components/learn/figures/lesson-terms');
  const glossary = await import('@/lib/glossary');
  expect(Object.keys(LESSON_TERMS).length).toBeGreaterThanOrEqual(20);
  expect(chooseTerm(['A mutant survived.'])?.key).toBe('mutant');
  expect(chooseTerm(['A mutant survived.'], 'survived')?.key).toBe('survived');
  expect(chooseTerm(['Nothing to define here.'])).toBeNull();
  expect(chooseTerm(['A different idea.'])).toBeNull();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<TermParagraphs paragraphs={['Plain words first.', 'Then a volume keeps the rows, and another volume too.']} />));
  const words = host.querySelectorAll<HTMLElement>('[data-lesson-term]');
  expect(words).toHaveLength(1);
  expect(words[0].textContent).toBe('volume');
  // A real button, so the keyboard reaches it and a tap opens it.
  expect(words[0].tagName).toBe('BUTTON');
  expect(words[0].getAttribute('type')).toBe('button');
  expect(host.textContent).toBe('Plain words first.Then a volume keeps the rows, and another volume too.');
  act(() => words[0].focus());
  const card = host.querySelector('[role="tooltip"]')!;
  expect(card.textContent).toContain(LESSON_TERMS.volume.meaning);
  expect(words[0].getAttribute('aria-describedby')).toBe(card.id);
  act(() => { words[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
  act(() => { words[0].parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
  // The guides' list is their own: lib/glossary.ts is not where its words come from.
  expect(JSON.stringify(glossary)).not.toContain(LESSON_TERMS.volume.meaning);
  act(() => root.unmount());
  host.remove();
});

it('splits every chapter’s "Where you use this" into the room it links and the words after it', async () => {
  const { PHASE_STUDY } = await import('@/components/learn/study');
  for (const [phaseKey, study] of Object.entries(PHASE_STUDY)) {
    for (const chapter of study.chapters) {
      const { room, rest } = splitWhere(chapter.where!);
      expect(room, chapter.where).toBe(`${phaseKey[0].toUpperCase()}${phaseKey.slice(1)} room`);
      expect(room + rest).toBe(chapter.where);
      expect(rest === '' || rest.startsWith(', '), chapter.where).toBe(true);
    }
  }
  expect(splitWhere('The Testing room in your project space')).toEqual({ room: 'The Testing room', rest: ' in your project space' });
});

it('captions every worked example as the worked example, since several are illustrative', () => {
  for (const phaseKey of ['requirements', 'maintenance'] as const) {
    const { host, done } = openReader(phaseKey, 2);
    const card = host.querySelector('.lesson-worked-example')!;
    expect(card.querySelector('figcaption')?.textContent).toBe('The worked example');
    expect(card.querySelector('pre')?.getAttribute('aria-label')).toBe('The TaskTrackr worked example');
    done();
  }
});

it('keeps an open guide term inside a 390 px screen, so it never widens the page', async () => {
  const { LessonTerm } = await import('@/components/learn/figures/LessonTerm');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const css = readFileSync(resolve(__dirname, '../components/learn/lessons.css'), 'utf8');
  const card = css.slice(css.indexOf('.lesson-term-card {'), css.indexOf('}', css.indexOf('.lesson-term-card {')));
  expect(card).toContain('max-width: min(280px, calc(100vw - 32px))');
  const width = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 390 });
  const at = { left: 0 };
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const shift = parseFloat(this.style.left || '0');
    return { left: at.left + shift, right: at.left + shift + 280, top: 0, bottom: 0, width: 280, height: 60, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<LessonTerm term="regression" />));
    const word = host.querySelector<HTMLButtonElement>('.lesson-term-word')!;
    // A word near the right edge: the card would end at 580 px.
    at.left = 300;
    act(() => word.focus());
    const open = host.querySelector<HTMLElement>('.lesson-term-card')!;
    expect(open.style.left).toBe('-206px');
    expect(open.getBoundingClientRect().right).toBeLessThanOrEqual(390 - 16);
    act(() => word.blur());
    // A word near the left edge keeps the card under it.
    at.left = 20;
    act(() => word.focus());
    expect(host.querySelector<HTMLElement>('.lesson-term-card')!.style.left).toBe('0px');
  } finally {
    act(() => root.unmount()); host.remove(); rect.mockRestore();
    if (width) Object.defineProperty(document.documentElement, 'clientWidth', width); else Reflect.deleteProperty(document.documentElement, 'clientWidth');
  }
});

it('never ties the guides to a course: no "course", "module" or "class assignment" in any learner-facing word', async () => {
  const { PHASE_STUDY } = await import('@/components/learn/study');
  const { GUIDE_CARD, GUIDE_HERO } = await import('@/components/learn/hero');
  const { PHASE_MAKES } = await import('@/components/learn/phase-map');
  const words = JSON.stringify([LESSONS, PHASE_STUDY, GUIDE_HERO, GUIDE_CARD, PHASE_MAKES]);
  expect(words).not.toMatch(/\bcourses?\b|\bmodules?\b|class assignment/i);
});

it('spells the Requirements, Design, Deployment and Maintenance guides and the shared pages the UK way, as TaskTrackr does', async () => {
  const { GUIDE_CARD } = await import('@/components/learn/hero');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  // The sources themselves, so the words drawn in JSX are read too.
  const files = [
    ...['requirements', 'design', 'deployment', 'maintenance'].flatMap((p) => [`content/${p}.ts`, `study/${p}.ts`, `figures/${p}.tsx`]),
    'hero.ts', 'phase-map.ts', 'PhaseMap.tsx', 'HowChecksWork.tsx', 'HowChecksWorkSlot.tsx', 'LessonReader.tsx', 'StudyWalkthrough.tsx', 'figures/lesson-terms.ts',
  ].map((file) => `components/learn/${file}`).concat('app/(app)/learn/page.tsx');
  for (const file of files) {
    const text = readFileSync(resolve(__dirname, '..', file), 'utf8').replace(/Unified Modeling Language/g, '');
    expect(text, file).not.toMatch(/\b(behavior|neighbor|organiz|authoriz|analyz|recogniz|prioritiz|favor|modeling)\w*/i);
  }
  expect(GUIDE_CARD.implementation.topics[0]).toBe('Read the neighbourhood');
});

/* The videos row on every chapter says which chapter each
 * video goes with, and marks the open chapter's. */
it('says under each video which chapter it goes with, and marks the open chapter\'s', () => {
  const marks = (host: HTMLElement) => [...host.querySelectorAll<HTMLAnchorElement>('.lesson-videos a')].map((a) => [
    a.querySelector('[data-testid="video-chapter"]')?.textContent,
    a.hasAttribute('data-this-chapter'),
    a.querySelector('.lesson-video-here')?.textContent ?? null,
  ]);
  for (const chapter of [1, 2, 3, 4]) {
    const { host, done } = openReader('maintenance', chapter);
    try {
      expect(host.querySelectorAll('.lesson-videos a')).toHaveLength(2);
      expect(marks(host)).toEqual([
        ['Goes with chapter 2', chapter === 2, chapter === 2 ? 'This chapter' : null],
        ['Goes with chapter 3', chapter === 3, chapter === 3 ? 'This chapter' : null],
      ]);
    } finally { done(); }
  }
  const { host, done } = openReader('requirements', 2);
  try {
    expect(marks(host)).toEqual([['Goes with chapter 2', true, 'This chapter'], ['Goes with the whole guide', false, null]]);
    expect(host.querySelector('.lesson-videos a small')?.textContent).toBe('Atlassian: older Jira interface: Opens YouTube');
  } finally { done(); }
});

/* The chapter footer draws only the buttons that go somewhere (chapter 1 has
 * no "Previous chapter"), the forward one kept at the end. */
it('draws only the chapter buttons that go somewhere', () => {
  const footer = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.lesson-chapter-footer > *')].map((el) => [el.tagName, el.textContent, (el as HTMLButtonElement).disabled ?? false]);
  for (const [chapter, expected] of [
    [1, [['BUTTON', 'Next chapter', false]]],
    [2, [['BUTTON', 'Previous chapter', false], ['BUTTON', 'Next chapter', false]]],
    [4, [['BUTTON', 'Previous chapter', false], ['A', 'Back to the catalogue', false]]],
  ] as const) {
    const { host, done } = openReader('design', chapter);
    try {
      expect(footer(host), `chapter ${chapter}`).toEqual(expected);
      expect(host.querySelector('.lesson-chapter-footer button:disabled')).toBeNull();
    } finally { done(); }
  }
});

/* The page font joins `--` into one dash, so a code fragment
 * in the guides' words is drawn in code type (codeFragments in
 * figures/CodeText.tsx), whoever wrote the words: the reader marks every
 * word holding `--`, `->`, `<=`, `>=`, `!=` or `=>` (or an operator on its
 * own) in all 24 chapters, the figures' first states and the practice
 * feedback alike. Two cases are named below: Deployment 2's worked step
 * "--selfcheck" and Testing 3's "Both < and <= can pass". */
const LIGATURE = /--|->|<-|<=|>=|!=|=>|==/;
const drawnOutsideCode = (root: Element) => {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (LIGATURE.test(node.textContent ?? '') && !node.parentElement?.closest('code, pre, title, desc, .sr-only')) found.push(node.textContent!);
  }
  return found;
};

it('draws every code fragment of all 24 chapters in code type, never in the page font', async () => {
  const { PHASE_STUDY } = await import('@/components/learn/study');
  let fragments = 0;
  for (const phaseKey of ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const) {
    for (let chapter = 1; chapter <= 4; chapter += 1) {
      const { host, done } = openReader(phaseKey, chapter);
      const article = host.querySelector('.lesson-article')!;
      // The reasoning disclosure's words are in the page too, closed or open.
      expect(drawnOutsideCode(article), `${phaseKey} ${chapter}`).toEqual([]);
      fragments += article.querySelectorAll('code.code-fragment').length;
      // Every option's feedback, as "Check my reasoning" draws it.
      const options = Array.from(article.querySelectorAll<HTMLInputElement>('.lesson-practice input[type="radio"]'));
      for (const option of options) {
        act(() => option.click());
        act(() => Array.from(article.querySelectorAll('button')).find((b) => b.textContent === 'Check my reasoning')!.click());
        expect(drawnOutsideCode(article.querySelector('.lesson-practice')!), `${phaseKey} ${chapter} feedback`).toEqual([]);
      }
      done();
    }
  }
  expect(fragments).toBeGreaterThan(0);
  // The two named cases.
  const deployment = openReader('deployment', 2);
  expect(Array.from(deployment.host.querySelectorAll('.lesson-worked-steps code.code-fragment')).map((c) => c.textContent)).toContain('--selfcheck');
  deployment.done();
  expect(JSON.stringify(PHASE_STUDY.deployment.chapters[1].steps)).toContain('--selfcheck');
});
