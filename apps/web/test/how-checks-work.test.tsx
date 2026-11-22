// @vitest-environment jsdom
/**
 * "How LearnSDLC checks your work": a five-step walk through
 * propose, explain, apply on the Deployment drill. No AI call; every word the
 * room or the API says is read here from its source file, so the guide cannot
 * drift from the product.
 */
import { repoFile } from './support/paths';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { closureText, webSource } from './support/source-text';
import { DIMENSION_LABEL, DIMENSION_ORDER, MISSING_WITH_QUOTE } from '@/components/workspace/mentor/ExplanationFindings';
import HowChecksWorkDefault, {
  ACCEPTED_HEADLINE, APPLY_LABEL, APPLY_LOCKED, APPLY_OPEN, DRILL_FAULT, EFFECTS_QUESTION, EFFECTS_REFUSAL, FINDING_WORDS, HowChecksWork, PROPER_EXPLANATION, REVIEW_HEADLINE, WEAK_EXPLANATIONS,
} from '@/components/learn/HowChecksWork';

const web = (path: string) => webSource(path);
const straight = (s: string) => s.replace(/’/g, "'");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<HowChecksWork />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const press = (words: string) => {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === words);
  if (!button) throw new Error(`No button "${words}"`);
  act(() => button.click());
};
const next = (times = 1) => { for (let i = 0; i < times; i += 1) press('Next'); };
const rows = () => Array.from(host.querySelectorAll('[data-dimension]'));

it('uses the product’s own words, read from the room, the API and the drill', () => {
  // The room's words, read from the components that draw them and what they draw from, wherever they live.
  const findings = closureText('ExplanationFindings');
  expect(findings).toContain(`supported: '${FINDING_WORDS.supported}'`);
  expect(findings).toContain(`missing: '${FINDING_WORDS.missing}'`);
  const panel = closureText('AgenticPanel');
  expect(panel).toContain(`'${ACCEPTED_HEADLINE}'`);
  expect(panel).toContain(`'${REVIEW_HEADLINE}'`);
  expect(panel).toContain(`>${APPLY_LABEL}<`);
  const assessment = repoFile('apps/api/src/assistant/explanation-assessment.ts');
  expect(assessment).toContain(`feedback: '${EFFECTS_REFUSAL}'`);
  expect(assessment).toContain(`question: '${EFFECTS_QUESTION}'`);
  const phase = JSON.parse(repoFile('content/tasktrackr/phases/05-deployment/phase.json')) as { checks: { drill: { description: string } } };
  expect(straight(DRILL_FAULT)).toBe(phase.checks.drill.description);
  expect(repoFile('content/tasktrackr/phases/05-deployment/drill/docker-compose.yml')).toContain('API_URL: http://localhost:8000');
  expect(repoFile('content/tasktrackr/phases/05-deployment/smoke/docker-compose.yml')).toContain('API_URL: http://api:8000');
});

it('needs no props, opens on the drill’s request and leaves the section heading to the catalogue’s slot', () => {
  expect(HowChecksWorkDefault).toBe(HowChecksWork);
  expect(host.querySelector('h1, h2')).toBeNull();
  expect(host.querySelector('[data-testid="how-checks-work"]')).toBeNull();
  expect(host.querySelector('.fig-caption, figcaption')?.textContent).toContain('Propose, explain, apply');
  expect(host.textContent).toContain('Step 1 of 5');
  expect(host.textContent).toContain('API_URL: http://localhost:8000');
  expect(host.querySelector('.fig-model-tag')?.textContent).toContain('Nothing here calls the mentor');
});

it('shows the proposal as a diff, not yet applied', () => {
  next();
  expect(host.querySelector('[data-line="removed"]')?.textContent).toContain('http://localhost:8000');
  expect(host.querySelector('[data-line="added"]')?.textContent).toContain('http://api:8000');
  expect(host.textContent).toContain('Proposed, not applied');
  expect(host.textContent).toContain('Nothing is applied yet.');
});

it('refuses “It fixes the bug.” check by check, in the room’s order and words, and keeps Apply closed', () => {
  next(2);
  expect(host.textContent).toContain('“It fixes the bug.”');
  expect(host.querySelector('[data-testid="review-headline"]')?.textContent).toBe(REVIEW_HEADLINE);
  expect(host.textContent).toContain(EFFECTS_REFUSAL);
  expect(rows().map((r) => r.getAttribute('data-dimension'))).toEqual([...DIMENSION_ORDER]);
  expect(rows().map((r) => r.querySelector('span')?.textContent)).toEqual(DIMENSION_ORDER.map((k) => DIMENSION_LABEL[k]));
  for (const row of rows()) expect(row.querySelector('.fig-status-word')?.textContent).toBe(FINDING_WORDS.missing);
  const apply = host.querySelector('[data-testid="apply-mark"]')!;
  expect(apply.getAttribute('data-state')).toBe('locked');
  expect(apply.textContent).toContain(APPLY_LABEL);
  expect(apply.textContent).toContain(APPLY_LOCKED);
  press(WEAK_EXPLANATIONS[2].label);
  expect(host.textContent).toContain('“Changed the URL.”');
  expect(rows()[0].querySelector('.fig-status-word')?.textContent).toBe(MISSING_WITH_QUOTE);
  press(WEAK_EXPLANATIONS[1].label);
  expect(host.textContent).toContain('“I asked the mentor.”');
  expect(host.textContent).toContain('Step 3 of 5');
});

it('accepts the proper explanation with every check Supported and its sentence quoted, then applies', () => {
  next(3);
  expect(host.querySelector('[data-testid="review-headline"]')?.textContent).toBe(ACCEPTED_HEADLINE);
  for (const row of rows()) {
    expect(row.querySelector('.fig-status-word')?.textContent).toBe(FINDING_WORDS.supported);
    expect(row.querySelector('blockquote')?.textContent).toBe(PROPER_EXPLANATION[row.getAttribute('data-dimension') as keyof typeof PROPER_EXPLANATION]);
  }
  const apply = host.querySelector('[data-testid="apply-mark"]')!;
  expect(apply.getAttribute('data-state')).toBe('open');
  expect(apply.textContent).toContain(APPLY_LABEL);
  expect(apply.textContent).toContain(APPLY_OPEN);
  next();
  expect(host.textContent).toContain('Step 5 of 5');
  expect(host.textContent).toContain('Applied');
  expect(host.querySelector('[data-line="removed"]')).toBeNull();
  expect(host.textContent).toContain('not the mentor');
});

it('moves with the arrow keys, and the weak-explanation toggles keep theirs', () => {
  const group = host.querySelector('.fig-steps')!;
  const key = (target: Element, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  key(group, 'ArrowRight');
  key(group, 'ArrowRight');
  expect(host.textContent).toContain('Step 3 of 5');
  const toggle = host.querySelector<HTMLButtonElement>('[role="group"][aria-label="Weak explanation"] button')!;
  toggle.focus();
  key(toggle, 'ArrowRight');
  expect(host.textContent).toContain('Step 3 of 5');
  expect(document.activeElement?.textContent).toContain(WEAK_EXPLANATIONS[1].label);
});

it('draws the room’s Apply as a mark, never a control that does nothing', () => {
  for (let step = 0; step < 5; step += 1) {
    expect(Array.from(host.querySelectorAll('button, [role="button"], a')).some((b) => b.textContent?.includes(APPLY_LABEL)), `step ${step + 1}`).toBe(false);
    const mark = host.querySelector('[data-testid="apply-mark"]');
    if (mark) expect(mark.querySelector('button, a, [tabindex]')).toBeNull();
    if (step < 4) next();
  }
});

/* The Apply mark is words, a lock while locked and a tick once open, with no
 * outline, so it does not read as a button to press; the room's own words are
 * kept. */
it('draws Apply as words with a lock or a tick, never an outlined pill', () => {
  const marks: Record<string, Element> = {};
  for (let step = 0; step < 5; step += 1) {
    const mark = host.querySelector('[data-testid="apply-mark"]');
    if (mark) marks[mark.getAttribute('data-state')!] = mark.cloneNode(true) as Element;
    if (step < 4) next();
  }
  expect(Object.keys(marks).sort()).toEqual(['locked', 'open']);
  const locked = marks.locked;
  const open = marks.open;
  expect(locked.textContent).toBe(`${APPLY_LABEL}: Locked.${APPLY_LOCKED}`);
  expect(open.textContent).toBe(`${APPLY_LABEL}: Open.${APPLY_OPEN}`);
  // A padlock (body and shackle) while locked; a tick once open.
  expect(locked.querySelector('svg.fig-apply-glyph rect')).not.toBeNull();
  expect(locked.querySelector('svg.fig-apply-glyph path')!.getAttribute('d')).toMatch(/^M5\.5 7V5a2\.5/);
  expect(open.querySelector('svg.fig-apply-glyph rect')).toBeNull();
  expect(open.querySelector('svg.fig-apply-glyph path')!.getAttribute('d')).toBe('M3.5 8.5l3 3 6-7');
  for (const mark of [locked, open]) expect(mark.querySelector('.fig-status')).toBeNull();
  // No outline, no padding, no pill: the label is a run of words.
  const css = web('components/learn/HowChecksWork.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const label = /\.how-checks \.fig-apply \.fig-apply-label \{([^}]*)\}/.exec(css)![1];
  for (const declaration of ['display: inline;', 'min-height: 0;', 'padding: 0;', 'border: 0;', 'border-radius: 0;']) expect(label).toContain(declaration);
});

/* The phase map and this section wear one frame, so they read as the same
 * kind of section, and the walk's figure draws no second frame inside it. */
it('sits in the same section frame as the phase map, with no frame inside it', () => {
  const css = web('components/learn/lessons.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };
  for (const declaration of ['padding: 22px;', 'border: 1.5px solid var(--guide-rule);', 'border-radius: 8px;', 'background: #ffffff;', 'color: var(--guide-ink);']) {
    expect(body('.phase-map'), declaration).toContain(declaration);
    expect(body('.learn-how-checks'), declaration).toContain(declaration);
  }
  expect(body('.learn-how-checks .fig')).toMatch(/padding: 0; border: 0;/);
  expect(css).toMatch(/\[data-theme="graphite"\] :is\(\.lesson-path, \.phase-map, \.learn-how-checks\) \{ background: #ffffff;/);
});
