// @vitest-environment jsdom
/**
 * Reflow (WCAG 1.4.10): in the Requirements and Design rooms at 360 and 390 px
 * with the sidebar pinned the room is 128 to 158 px wide, and the folded
 * "Tasks in this phase" row must not cut its state chip ("Ready to s…") by
 * letting the current task's span shrink the chip below its words.
 *
 * jsdom lays nothing out, so this holds the hooks the summary draws and the
 * room sheet's phone rule that wraps the row instead of cutting it; the
 * browser e2e (a11y-axe) measures the boxes. Measured in Chromium on static
 * markup: at 360, 390 and 460 px (sidebar pinned or
 * not), "Ready to start" and "Credit awarded, review still needed" sit wholly
 * inside their chip and nothing runs past the row; from 701 px the phone rule
 * does not apply.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { TaskPanel } from '@/components/workspace/TaskPanel';
import { CREDIT_AWARDED } from '@/components/workspace/signoff-status';
import { taskView } from './fixtures';

const task = taskView;
const TASKS = [
  task({ key: 'story', order: 1, title: 'Requirements', status: 'passed', attempts: 1, bestScore: 100 }),
  task({ key: 'concepts', order: 2, title: 'Story concepts', required: false, artefactType: 'quiz' }),
];
const COUNTS = { total: 2, required: 1, passed: 1, passedRequired: 1 };
const dom = (markup: string) => { const host = document.createElement('div'); host.innerHTML = markup; return host; };
const summary = (credited = false) => dom(renderToStaticMarkup(
  <TaskPanel compact tasks={TASKS} selected="story" counts={COUNTS}
    phase={{ id: 'p1', key: 'requirements', status: 'passed', ...(credited ? { evidenceNeeded: [{ key: 'story', title: 'Requirements' }] } : {}) }} />,
)).querySelector('summary')!;

const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
const PHONE = '@media(max-width:700px){.task-switcher-compact .task-switcher-current{';
/** The body of the one media block that opens with `head`. */
const block = (head: string): string => {
  const at = css.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unclosed ${head}`);
};
/** The declarations of `selector` inside `body`. */
const rule = (body: string, selector: string): string => {
  const at = body.indexOf(`${selector}{`);
  expect(at, selector).toBeGreaterThan(-1);
  return body.slice(at + selector.length + 1, body.indexOf('}', at));
};

describe('the folded task row on a phone', () => {
  it('the summary names its parts: the task, its name and its state chip (the real Chip, its words unchanged)', () => {
    for (const credited of [false, true]) {
      const current = summary(credited).querySelector('[data-testid="task-switcher-current"]')!;
      expect(current.classList.contains('task-switcher-current')).toBe(true);
      expect(current.querySelector('.task-switcher-title')?.textContent).toBe('Requirements');
      const chip = current.querySelector('.task-switcher-chip')!;
      expect(chip.classList.contains('chip')).toBe(true);
      expect(chip.textContent).toBe(credited ? CREDIT_AWARDED : 'Review passed');
    }
  });

  const phone = block(PHONE);
  it('the task and its chip wrap onto lines of their own instead of squeezing', () => {
    expect(rule(phone, '.task-switcher-compact .task-switcher-current')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(phone, '.task-switcher-compact .task-switcher-current')).toMatch(/max-width:\s*100%/);
  });
  it('the chip never shrinks below its words: it does not shrink, and its words wrap inside it', () => {
    const chip = rule(phone, '.task-switcher-compact .task-switcher-chip');
    expect(chip).toMatch(/flex:\s*none/);
    expect(chip).toMatch(/max-width:\s*100%/);
    expect(chip).toMatch(/white-space:\s*normal/);
    expect(chip).toMatch(/height:\s*auto/);
  });
  it('the task\'s name wraps rather than ending in an ellipsis, and the chevron keeps its size', () => {
    const title = rule(phone, '.task-switcher-compact .task-switcher-title');
    expect(title).toMatch(/white-space:\s*normal/);
    expect(title).toMatch(/text-overflow:\s*clip/);
    expect(rule(phone, '.task-switcher-compact .task-switcher-chevron')).toMatch(/flex:\s*none/);
  });
  it('from 701 px nothing changes: no rule outside the phone block names the new hooks', () => {
    const rest = css.replace(phone, '');
    expect(rest).not.toMatch(/\.task-switcher-(current|title|chip)\b/);
    expect(rest).not.toMatch(/\.task-switcher-compact \.task-switcher-chevron\{flex/);
  });
});
