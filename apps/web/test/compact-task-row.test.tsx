// @vitest-environment jsdom
/**
 * The task list folded to one row in the one-board rooms
 * (Requirements, Design). The full list's markup is unchanged; the compact
 * one says which task the room is, where it stands and the totals on its
 * summary, and holds every row behind one press. A phase with one task still
 * draws nothing, and a credited task reads as credit on the row as in the list.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { TaskPanel } from '@/components/workspace/TaskPanel';
import { CREDIT_AWARDED } from '@/components/workspace/signoff-status';
import { taskView } from './fixtures';

const task = taskView;

const TASKS = [
  task({ key: 'story', order: 1, title: 'Requirements (class edit)', status: 'passed', attempts: 1, bestScore: 100 }),
  task({ key: 'concepts', order: 2, title: 'Story concepts', required: false, artefactType: 'quiz' }),
];
const COUNTS = { total: 2, required: 1, passed: 1, passedRequired: 1 };
const phase = (over: Record<string, unknown> = {}) => ({ id: 'p1', key: 'requirements' as const, status: 'passed' as const, ...over });
const html = (props: Partial<Parameters<typeof TaskPanel>[0]> = {}) =>
  renderToStaticMarkup(<TaskPanel tasks={TASKS} selected="story" counts={COUNTS} phase={phase()} {...props} />);
const dom = (markup: string) => { const host = document.createElement('div'); host.innerHTML = markup; return host; };

describe('the compact task row', () => {
  it('a closed disclosure whose summary names the room\'s task, its state and the totals', () => {
    const host = dom(html({ compact: true }));
    const section = host.querySelector('[data-testid="task-switcher"]')!;
    expect(section.getAttribute('aria-label')).toBe('Tasks in this phase');
    expect(section.getAttribute('data-compact')).toBe('true');
    const details = section.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.querySelector('[data-testid="task-switcher-current"]')?.textContent).toContain('Requirements (class edit)');
    expect(summary.querySelector('[data-testid="task-switcher-current"]')?.textContent).toContain('Review passed');
    expect(summary.querySelector('[data-testid="task-counts"]')?.textContent).toBe('1 of 1 required done. Optional: 0 of 1 done');
  });

  it('every row of the full list is inside it, with its doors, and the live region outside the fold', () => {
    const host = dom(html({ compact: true }));
    const details = host.querySelector('details')!;
    expect(details.querySelectorAll('li').length).toBe(2);
    expect(details.querySelector('[data-testid="task-open-concepts"]')).not.toBeNull();
    expect(details.textContent).toContain('Questions are counted for the whole phase, not for each task.');
    const live = host.querySelector('[data-testid="task-leave-error"]')!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.closest('details')).toBeNull();
  });

  it('credit on the board reads as credit on the summary too', () => {
    const host = dom(html({ compact: true, phase: phase({ evidenceNeeded: [{ key: 'story', title: 'Requirements (class edit)' }] }) }));
    expect(host.querySelector('[data-testid="task-switcher-current"]')?.textContent).toContain(CREDIT_AWARDED);
  });

  it('a phase with one task still draws nothing', () => {
    expect(renderToStaticMarkup(<TaskPanel compact tasks={[TASKS[0]]} selected="story" />)).toBe('');
  });

  it('without `compact` the list is drawn open', () => {
    const host = dom(html());
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('[data-testid="task-switcher"]')?.getAttribute('data-compact')).toBeNull();
    expect(host.querySelectorAll('li').length).toBe(2);
  });
});
