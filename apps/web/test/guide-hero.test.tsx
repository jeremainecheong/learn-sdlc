// @vitest-environment jsdom
/**
 * Every study guide has the first screen the Requirements guide had. One
 * navy banner with the guide's own eyebrow, two-line headline, lead and 3D
 * picture (`components/learn/hero.ts`), the "Your phase brief" heading, and
 * the four chapters as a row of cards over the full-width chapter, the same
 * for all six (`components/learn/LessonReader.tsx`, `lessons.css`,
 * `lesson-hero.css`). And the catalogue on `/learn` draws one card for each
 * offered guide, in phase order, all in the design the Requirements card had
 * (`app/(app)/learn/page.tsx`, `GUIDE_CARD` in `hero.ts`).
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleText } from './support/source-text';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LessonReader } from '@/components/learn/LessonReader';
import { LESSONS } from '@/components/learn/content';
import { GUIDE_CARD, GUIDE_HERO } from '@/components/learn/hero';
import { PHASE_MAKES, PHASE_NAMES, PHASE_ORDER } from '@/components/learn/phase-map';
import { marksFor } from '@/components/shell/tours';
import { lessonsOfferedOn } from '@/lib/scenario';
import type { PhaseSummary } from '@learnsdlc/shared';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/components/shell', () => ({
  DocPage: ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => <><main>{children}</main>{aside}</>,
  PersonaPanel: () => null,
  phaseDoorHref: () => '/workspace/phase',
  doorWithTasks: <T,>(phase: T) => phase,
}));
const READER_ENROLMENT = { phases: [{ id: 'phase', key: 'requirements', status: 'in_progress', order: 1 }] };
const shell = vi.hoisted(() => ({ enrollment: null as unknown }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: shell.enrollment, details: undefined, loading: false }) }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({ ...(await original<typeof import('@/lib/session')>()), useSession: () => ({ id: 'learner', role: 'STUDENT' }) }));
import LearnPage from '@/app/(app)/learn/page';

const WEB = resolve(__dirname, '..');
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });
const render = (node: ReactNode) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
};

describe('the guide reader: one first screen for all six guides', () => {
  beforeEach(() => { shell.enrollment = READER_ENROLMENT; });
  it.each(PHASE_ORDER)('%s draws the navy banner with its own words and picture', (key) => {
    const hero = GUIDE_HERO[key];
    const host = render(<LessonReader phaseKey={key} />);
    const banner = host.querySelector<HTMLElement>('header.lesson-hero')!;
    expect(banner).not.toBeNull();
    expect(banner.className).toBe('lesson-hero');
    expect(banner.querySelector('.learn-eyebrow')?.textContent).toBe(hero.eyebrow);
    const h1 = banner.querySelector('h1')!;
    expect(h1.childNodes).toHaveLength(3);
    expect(h1.childNodes[0].textContent).toBe(hero.headline[0]);
    expect((h1.childNodes[1] as Element).tagName).toBe('BR');
    expect(h1.childNodes[2].textContent).toBe(hero.headline[1]);
    expect(h1.textContent).not.toBe(LESSONS[key].title);
    expect(banner.querySelector(':scope > div > p')?.textContent).toBe(hero.lead);
    const art = banner.querySelector<HTMLImageElement>(':scope > img')!;
    expect(art.getAttribute('src')).toBe(hero.art.src);
    expect(art.getAttribute('alt')).toBe(hero.art.alt);
    expect(art.getAttribute('width')).toBe(String(hero.art.width));
    expect(art.getAttribute('height')).toBe(String(hero.art.height));
    expect(host.textContent).not.toContain('Your optional phase guide');
    expect(host.querySelector('.lesson-path figcaption')?.textContent).toBe(hero.path);
  });

  it.each(PHASE_ORDER)('%s draws the phase brief heading and the chapter cards over the full-width chapter', (key) => {
    const host = render(<LessonReader phaseKey={key} />);
    const heading = host.querySelector('.lesson-learning-heading')!;
    expect(heading.querySelector('.learn-eyebrow')?.textContent).toBe('Your phase brief');
    expect(heading.querySelector('h2')?.textContent).toBe('Understand it. Then put it to work.');
    const layout = host.querySelector('.lesson-layout')!;
    expect(layout.className).toBe('lesson-layout');
    expect(host.querySelector('.lesson-hero')!.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const cards = layout.querySelectorAll(':scope > nav.lesson-chapters > button');
    expect(cards).toHaveLength(LESSONS[key].chapters.length);
    expect(cards[0].getAttribute('aria-current')).toBe('step');
    expect(layout.querySelector(':scope > article.lesson-article')).not.toBeNull();
  });

  it('draws the Requirements guide with a lead that is true of the phase', () => {
    expect(GUIDE_HERO.requirements).toEqual({
      eyebrow: 'Start with understanding',
      headline: ['Great software starts', 'with a better question.'],
      // The lead's second sentence said "Create an epic, write user stories":
      // in the default project the learner writes one story, US-4, and its
      // criteria, and an epic is optional (01-requirements phase.json:
      // "Complete your story, US-4", "An epic relationship is optional; if
      // you add one, link it to an epic you have defined"). The phase map's
      // "You make" line says the same.
      lead: 'Find the problem worth solving, then turn it into work a team can act on. Write a user story, define its acceptance criteria, and link it to an epic if you add one, in a guided Jira-style backlog.',
      art: { src: '/artwork/requirements-lesson-compact.webp', alt: 'A learner gathering ideas around a glass and paper pinboard', width: 365, height: 274 },
      path: 'The learning and evidence path',
    });
  });

  it('says in the Requirements lead only what the phase asks: one story, its criteria, an epic if added', () => {
    const brief = readFileSync(resolve(WEB, '../../content/tasktrackr/phases/01-requirements/phase.json'), 'utf8');
    expect(brief).toContain('Complete your story, US-4');
    expect(brief).toContain('An epic relationship is optional; if you add one, link it to an epic you have defined.');
    expect(GUIDE_HERO.requirements.lead).toContain('Write a user story, define its acceptance criteria, and link it to an epic if you add one');
    expect(GUIDE_HERO.requirements.lead).not.toMatch(/Create an epic|user stories/);
  });

  /* One caption for all six, "The learning and evidence path", true of
   * Design's too: its path, user action to database, is the
   * request the Design brief has the learner trace "from the browser to the
   * database and back" in the Sequence diagram, the evidence it submits. */
  it('captions every guide’s path the same way, true of Design’s', () => {
    for (const key of PHASE_ORDER) expect(GUIDE_HERO[key].path, key).toBe('The learning and evidence path');
    const brief = readFileSync(resolve(WEB, '../../content/tasktrackr/phases/02-design/phase.json'), 'utf8');
    expect(brief).toContain('trace the overdue request from the browser to the database and back');
    expect(LESSONS.design.flow[0]).toBe('User action');
    expect(LESSONS.design.flow.at(-1)).toBe('Database');
  });

  /* The five square pictures, contained in Requirements' 4:3 box, would read
   * at about 60 percent of its weight. Each draws at the box's
   * height times its scale (hero.ts, ART_WEIGHT), at its own shape, inside
   * the box, and the banner keeps one height. */
  it('gives every banner picture Requirements’ weight: a scale per square picture, drawn at its own shape', () => {
    expect(GUIDE_HERO.requirements.art.scale).toBeUndefined();
    expect(Object.fromEntries(PHASE_ORDER.map((key) => [key, GUIDE_HERO[key].art.scale ?? 1]))).toEqual({
      requirements: 1, design: 1.24, implementation: 1.15, testing: 1.31, deployment: 1.1, maintenance: 1.27,
    });
    for (const key of PHASE_ORDER) {
      const { art } = GUIDE_HERO[key];
      // Never shrunk below the contained size, and never past the box's width (a square at 4/3 of its height).
      expect(art.scale ?? 1, key).toBeGreaterThanOrEqual(1);
      expect((art.scale ?? 1) * (art.width / art.height) * 0.75, key).toBeLessThanOrEqual(1);
    }
  });

  it.each(PHASE_ORDER)('%s draws its picture with its scale and its own ratio', (key) => {
    shell.enrollment = READER_ENROLMENT;
    const hero = GUIDE_HERO[key];
    const host = render(<LessonReader phaseKey={key} />);
    const art = host.querySelector<HTMLImageElement>('header.lesson-hero > img')!;
    expect(art.style.getPropertyValue('--hero-art-scale')).toBe(String(hero.art.scale ?? 1));
    expect(Number(art.style.getPropertyValue('--hero-art-ratio'))).toBeCloseTo(hero.art.width / hero.art.height, 3);
  });

  /* Implementation's workbench reaches its file's top and bottom, so at a
   * scale of 1 the 4:3 box would draw it smallest (273.8 px at 1440 against
   * 339 to 359). It is 1.15 and marked `fillsHeight`; on a
   * phone, where the banner stacks, it keeps the unscaled top edge under the
   * buttons and grows downward. Measured (hero.ts ART_WEIGHT): the drawing
   * spans rows 6 to 505 of 512, so at 1440 it keeps about 12 px of the
   * banner clear above and 18 px below. */
  it('raises Implementation’s picture to 1.15 without cropping, growing downward where the banner stacks', () => {
    const art = GUIDE_HERO.implementation.art;
    expect(art.scale).toBe(1.15);
    expect(art.fillsHeight).toBe(true);
    expect(PHASE_ORDER.filter((key) => GUIDE_HERO[key].art.fillsHeight)).toEqual(['implementation']);
    // Drawn sizes: the box's height (0.75 of 365, 170 and 239.5 px) times the scale.
    expect([365, 170, 239.5].map((box) => Math.round(box * 0.75 * art.scale! * 10) / 10)).toEqual([314.8, 146.6, 206.6]);
    // At 1440 the banner is 338 px with a 31 px top and 28 px bottom padding:
    // the picture's border box starts at 166 - H/2 and the drawing spans 6/512 to 506/512 of it.
    const H = 365 * 0.75 * art.scale!;
    const top = 166 - H / 2;
    expect(top + (6 / 512) * H).toBeGreaterThanOrEqual(10);
    expect(338 - 1 - (top + (506 / 512) * H)).toBeGreaterThanOrEqual(10);
    // On a phone the bottom grows by (scale - 1) / 2 of the drawn box plus the 5 px margin, inside the 24 px padding.
    const phone = 239.5 * 0.75;
    expect(phone * (art.scale! - 1) / 2 + 5 - (6 / 512) * phone * art.scale!).toBeLessThanOrEqual(24 - 6);
    const css = readFileSync(resolve(WEB, 'components/learn/lessons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const phoneCss = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(phoneCss).toMatch(/\.lesson-hero > img\[data-fills-height="true"\] \{\s*margin-top: -14px;\s*\}/);
    shell.enrollment = READER_ENROLMENT;
    const host = render(<LessonReader phaseKey="implementation" />);
    expect(host.querySelector('header.lesson-hero > img')!.getAttribute('data-fills-height')).toBe('true');
    cleanup?.();
    const other = render(<LessonReader phaseKey="testing" />);
    expect(other.querySelector('header.lesson-hero > img')!.hasAttribute('data-fills-height')).toBe(false);
  });

  it('sizes the banner picture from one 4:3 box at every width, and lets no picture take a press', () => {
    const css = readFileSync(resolve(WEB, 'components/learn/lessons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/\.lesson-hero > img \{([^}]*)\}/g)].map((m) => m[1]);
    const base = rules.find((body) => body.includes('--hero-art-grow'))!;
    expect(base).toMatch(/--hero-art-box: min\(100%, 365px\);/);
    expect(base).toMatch(/width: calc\(var\(--hero-art-box\) \* 0\.75 \* var\(--hero-art-scale, 1\) \* var\(--hero-art-ratio, 1\.3333\)\);/);
    expect(base).toMatch(/margin: calc\(-14px - var\(--hero-art-grow\)\) auto calc\(-5px - var\(--hero-art-grow\)\);/);
    expect(base).toMatch(/pointer-events: none;/);
    expect(base).not.toMatch(/aspect-ratio/);
    // The narrower layouts change only the box, never to a square box.
    expect(rules.filter((body) => body !== base).map((body) => body.trim()).filter((body) => body !== 'z-index: 1;')).toEqual(['--hero-art-box: 170px;', '--hero-art-box: min(100%, 260px);\n    justify-self: center;']);
  });

  it('gives each guide its own words, an existing picture, and no jargon marks', () => {
    for (const field of ['eyebrow', 'lead'] as const) expect(new Set(PHASE_ORDER.map((key) => GUIDE_HERO[key][field])).size).toBe(6);
    expect(new Set(PHASE_ORDER.map((key) => GUIDE_HERO[key].art.src)).size).toBe(6);
    expect(new Set(PHASE_ORDER.map((key) => GUIDE_HERO[key].headline.join(' '))).size).toBe(6);
    for (const key of PHASE_ORDER) {
      const hero = GUIDE_HERO[key];
      expect(existsSync(resolve(WEB, 'public', hero.art.src.slice(1))), hero.art.src).toBe(true);
      expect(hero.art.alt.length).toBeGreaterThan(10);
      for (const text of [hero.eyebrow, ...hero.headline, hero.lead, hero.art.alt, hero.path]) {
        expect(text.trim(), key).toBe(text);
        expect(text, key).not.toMatch(/[—!·|]/);
      }
    }
  });
});

describe('the reader’s sources', () => {
  it('holds no per-phase branch for looks and no Requirements-only class', () => {
    // The reader's own module; a stylesheet import is not in any render.
    const reader = moduleText('LessonReader');
    expect(reader).not.toMatch(/phaseKey\s*[!=]==?\s*["'`]/);
    expect(reader).not.toMatch(/-requirements\b/);
    expect(reader).not.toMatch(/PhaseArtwork/);
    expect(reader).toMatch(/import "\.\/lesson-hero\.css";/);
    const css = readFileSync(resolve(WEB, 'components/learn/lessons.css'), 'utf8');
    expect(css).not.toMatch(/lesson-(hero|layout)-requirements/);
  });

  it('scopes every rule in lesson-hero.css to the learn pages', () => {
    const css = readFileSync(resolve(WEB, 'components/learn/lesson-hero.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}@]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',')).map((s) => s.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, selector).toMatch(/^\.(lesson-reader-shell|learn-library)\b/);
  });
});

const summary = (key: PhaseSummary['key'], order: number, status: PhaseSummary['status']): PhaseSummary =>
  ({ id: `${key}-phase`, key, order, title: PHASE_NAMES[key], status, attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'reference' }) as PhaseSummary;
const cardsOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-testid="learn-catalogue"] ol.learn-phase-list > li.learn-feature')];
const shape = (card: HTMLElement) => [...card.children].map((child) => `${child.tagName}.${child.className}`);

describe('the catalogue: one rich card for each guide', () => {
  beforeEach(() => { shell.enrollment = null; });

  it('draws six cards of one structure, in phase order, under one "Explore a guide"', () => {
    const host = render(<LearnPage />);
    const cards = cardsOf(host);
    expect(cards.map((card) => card.dataset.phase)).toEqual(PHASE_ORDER);
    const first = shape(cards[0]);
    expect(first).toEqual(['DIV.learn-feature-top', 'P.learn-feature-promise', 'P.learn-makes', 'DIV.learn-guide-meta', 'DIV.learn-topics', 'A.exp-button exp-primary']);
    for (const card of cards) expect(shape(card)).toEqual(first);
    const headings = [...host.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings.filter((text) => text === 'Explore a guide')).toHaveLength(1);
    expect(headings).not.toContain('Keep exploring');
    expect(host.querySelectorAll('.learn-feature')).toHaveLength(6);
  });

  it.each(PHASE_ORDER)('the %s card draws its artwork, number, title, promise, You make, topics and link', (key) => {
    const host = render(<LearnPage />);
    const card = cardsOf(host).find((one) => one.dataset.phase === key)!;
    const card_ = GUIDE_CARD[key];
    expect(card.querySelector('.learn-feature-top > img')?.getAttribute('src')).toMatch(/^\/artwork\/.+\.webp$/);
    expect(card.querySelector('.learn-eyebrow')?.textContent).toBe(`Phase 0${PHASE_ORDER.indexOf(key) + 1} / ${LESSONS[key].chapters.length} chapters`);
    const title = card.querySelector('h3')!;
    expect(title.textContent).toBe(PHASE_NAMES[key]);
    expect(title.querySelector('svg')).not.toBeNull();
    expect(card.querySelector('.learn-feature-promise')?.textContent).toBe(card_.promise);
    expect(card.querySelector('.learn-makes')?.textContent).toBe(`You make: ${PHASE_MAKES[key][0]}`);
    const topics = [...card.querySelectorAll('.learn-topics > span')].map((span) => span.textContent);
    expect(topics).toEqual(card_.topics);
    expect(topics.length).toBeGreaterThanOrEqual(3);
    expect(topics.length).toBeLessThanOrEqual(4);
    const meta = [...card.querySelectorAll('.learn-guide-meta > span')].map((span) => span.textContent);
    expect(meta).toEqual([`${LESSONS[key].chapters.length} chapters`, 'Interactive examples', ...(key === 'requirements' ? ['Jira field guide'] : [])]);
    const link = card.querySelector<HTMLAnchorElement>(':scope > a')!;
    expect(link.getAttribute('href')).toBe(`/learn/${key}`);
    // One case form for all six: "Open Design guide", not "Open design guide".
    expect(link.getAttribute('aria-label')).toBe(`Open ${PHASE_NAMES[key]} guide`);
    expect(link.getAttribute('aria-label')).toMatch(/^Open [A-Z][a-z]+ guide$/);
    expect(link.textContent).toBe('Open guide');
  });

  it('keeps the Requirements card’s words, and gives every guide its own promise', () => {
    expect(GUIDE_CARD.requirements.promise).toBe('Turn a real need into work your team can understand.');
    expect(GUIDE_CARD.requirements.topics).toEqual(['Stakeholder questions', 'Epics and user stories', 'Acceptance criteria', 'Jira’s Parent field']);
    expect(new Set(PHASE_ORDER.map((key) => GUIDE_CARD[key].promise)).size).toBe(6);
    for (const key of PHASE_ORDER) for (const text of [GUIDE_CARD[key].promise, ...GUIDE_CARD[key].topics]) expect(text, key).not.toMatch(/[—!·|]/);
  });

  it('points the Learn tour’s "Choose a guide" mark at the first card’s link', () => {
    const host = render(<LearnPage />);
    const mark = marksFor('learn').find((one) => one.target === 'learn-guides')!;
    expect(host.querySelector(mark.selector!)).toBe(cardsOf(host)[0].querySelector(':scope > a'));
  });

  it('lists only the offered guides, and none when no guide is offered', () => {
    const subset = { phases: [summary('design', 1, 'in_progress'), summary('testing', 2, 'locked')] };
    const offered = PHASE_ORDER.filter((key) => lessonsOfferedOn(subset as never, key));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThan(6);
    shell.enrollment = subset;
    let host = render(<LearnPage />);
    expect(cardsOf(host).map((card) => card.dataset.phase)).toEqual(offered);
    cleanup?.(); cleanup = null;
    shell.enrollment = { phases: [], projectIsDefault: false };
    host = render(<LearnPage />);
    expect(cardsOf(host)).toHaveLength(0);
    expect(host.querySelector('[data-testid="learn-none"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Explore a guide');
  });

  it('scopes the catalogue’s columns to the library in lesson-hero.css, and leaves no old list rule', () => {
    const page = moduleText('app/(app)/learn/page.tsx');
    expect(page).toMatch(/import "@\/components\/learn\/lesson-hero\.css";/);
    expect(page).not.toMatch(/learn-phase-number|learn-feature-bottom|learn-guide-label/);
    const css = readFileSync(resolve(WEB, 'components/learn/lessons.css'), 'utf8');
    expect(css).not.toMatch(/\.learn-phase-number|\.learn-feature-bottom|\.learn-guide-label|\.learn-phase-list > li > (img|div)/);
    const hero = readFileSync(resolve(WEB, 'components/learn/lesson-hero.css'), 'utf8');
    expect(hero).toMatch(/@container learning \(max-width: 900px\)\s*\{\s*\.learn-library \.learn-phase-list \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(hero).toMatch(/@container learning \(max-width: 560px\)\s*\{\s*\.learn-library \.learn-phase-list \{\s*grid-template-columns: 1fr;/);
  });
});
