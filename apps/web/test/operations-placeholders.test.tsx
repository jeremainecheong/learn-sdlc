// @vitest-environment jsdom
/**
 * Design's Operations card showed "404 when no book has that id" in grey under the
 * Deadline badge's isOverdue, whose optional Errors box is left blank: at a glance the operation failed with a 404 about a book.
 * Every placeholder of the card is now an example that belongs to no project, and the Errors box says it is optional.
 * Placeholders only: the labels, the test ids, the values and what a typed line writes are as they were.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Design, DesignOperation } from '@learnsdlc/shared';
import { EMPTY_DESIGN } from '@learnsdlc/shared';
import { OperationsCard } from '@/components/workspace/panels/design/OperationsCard';
import type { DesignState } from '@/components/workspace/panels/design/useDesign';

/** The Deadline badge operation after an Apply: everything filled but Errors. */
const IS_OVERDUE: DesignOperation = {
  id: 'O1', name: 'isOverdue', inputs: ['task: Task', 'today: date'], returns: 'boolean (true if task is overdue, otherwise false)', errors: [],
  satisfies: ['US-1'], note: 'Compare task.dueDate with today; a task due today is not overdue. Example: dueDate before today returns true.',
};
const BLANK: DesignOperation = { id: 'O2', name: '', inputs: [], returns: '', errors: [], satisfies: [] };

let host: HTMLDivElement, root: Root;
const write = vi.fn();
const draw = (operations: DesignOperation[]) => {
  const doc: Design = { ...EMPTY_DESIGN, operations };
  const design = { doc, write, stories: [{ id: 'US-1', title: 'Overdue badge' }], busy: false, assisted: () => [] } as unknown as DesignState;
  act(() => root.render(<OperationsCard design={design} />));
};
const field = (i: number, name: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="design-operation-${i}-${name}"]`)!;
beforeEach(() => { write.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Operations card\'s grey words are neutral examples', () => {
  it('each placeholder, word for word', () => {
    draw([BLANK]);
    expect(['name', 'inputs', 'returns', 'errors', 'note'].map((name) => field(0, name).getAttribute('placeholder'))).toEqual([
      'e.g. operationName(input)',
      'e.g. input: type',
      'e.g. what comes back, and when',
      'Optional: how it can fail',
      'the order it returns, a boundary case, or one call and what it gives back',
    ]);
  });

  it('none names a book, an id of another domain or a status code', () => {
    draw([BLANK]);
    for (const name of ['name', 'inputs', 'returns', 'errors', 'note']) {
      const words = field(0, name).getAttribute('placeholder')!;
      expect(words, name).not.toMatch(/book|\bids?\b|\b\d{3}\b/i);
    }
  });

  it('the demo\'s isOverdue: the only grey words under it are "Optional: how it can fail", in its empty Errors box', () => {
    draw([IS_OVERDUE]);
    const errors = field(0, 'errors') as HTMLTextAreaElement;
    expect(errors.value).toBe('');
    expect(errors.getAttribute('placeholder')).toBe('Optional: how it can fail');
    for (const name of ['name', 'inputs', 'returns', 'note']) expect((field(0, name) as HTMLInputElement).value, name).not.toBe('');
  });

  it('the labels, ids and values of each operation\'s fields (what a typed line writes: design-room.test.tsx)', () => {
    draw([IS_OVERDUE]);
    const labels = [...host.querySelectorAll('label')].map((label) => [label.textContent, label.getAttribute('for')]);
    expect(labels).toEqual([
      ['Name', 'design-operation-0-name'],
      ['Inputs, one per line', 'design-operation-0-inputs'],
      ['Returns', 'design-operation-0-returns'],
      ['Errors, one per line', 'design-operation-0-errors'],
      ['Note: ordering, boundary or an example', 'design-operation-0-note'],
    ]);
    expect((field(0, 'name') as HTMLInputElement).value).toBe('isOverdue');
    expect((field(0, 'inputs') as HTMLTextAreaElement).value).toBe('task: Task\ntoday: date');
  });
});
