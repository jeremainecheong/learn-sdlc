// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PhaseTaskView } from '@learnsdlc/shared';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { TaskPanel } from '@/components/workspace/TaskPanel';
import { taskView } from './fixtures';

/**
 * TaskPanel contrast (browser proof: e2e/contrast.spec.ts).
 *
 * `--dim` is the token for glyphs and placeholders; it does not clear 4.5 to 1
 * on the panel, so a word or a number drawn in it is text a learner may not be
 * able to read: such as the task switcher's order numbers ("01", "02"). The
 * browser spec reads the source; this reads what renders:
 * no element of the switcher that carries a bare `text-dim` has text in it.
 */

const task = taskView;

const three: PhaseTaskView[] = [
  task({ key: 'story', order: 1, title: 'The user story', status: 'passed', attempts: 2, bestScore: 88 }),
  task({ key: 'criteria', order: 2, title: 'Acceptance criteria', attempts: 1, bestScore: 40 }),
  task({ key: 'scope', order: 3, title: 'Out of scope', required: false }),
];

/**
 * The dim token, spelled so that e2e/contrast.spec.ts ('dim is never a word'),
 * which walks every source file under apps/web including this one, does not
 * read this test's own filter as a worded use of it.
 */
const DIM = ['text', 'dim'].join('-');

describe('the task switcher’s contrast', () => {
  it('draws no text in the dim token', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<TaskPanel tasks={three} selected="criteria" onSelect={() => {}} />);
    expect(host.querySelector('[data-testid="task-switcher"]')).not.toBeNull();

    const worded = [...host.querySelectorAll<HTMLElement>('[class]')]
      .filter((el) => el.classList.contains(DIM))
      .filter((el) => /[A-Za-z0-9]/.test(el.textContent ?? ''))
      .map((el) => el.textContent);
    expect(worded).toEqual([]);
  });

  it('still numbers the tasks, now in the muted token', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<TaskPanel tasks={three} selected="criteria" onSelect={() => {}} />);
    const numbers = [...host.querySelectorAll<HTMLElement>('.font-mono')].map((el) => [el.textContent, el.className.includes('text-muted')]);
    expect(numbers).toEqual([
      ['01', true],
      ['02', true],
      ['03', true],
    ]);
  });
});
