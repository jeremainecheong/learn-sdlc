// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '@/components/pr/DiffView';
import type { FileDiff } from '@/components/pr/diff';
import type { PrThread } from '@/components/pr/threads';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const longLine = '    return "<retained evidence> ' + 'a_long_identifier_'.repeat(60) + '"';
const diff: FileDiff = {
  path: 'api/repository/comments.py', adds: 2, dels: 1, lines: 51, added: false,
  hunks: [
    { skipped: 8, lines: [
      { kind: ' ', oldNo: 9, newNo: 9, text: 'def list_comments(task_id):' },
      { kind: '-', oldNo: 10, newNo: null, text: '    raise NotImplementedError()' },
      { kind: '+', oldNo: null, newNo: 10, text: longLine },
      { kind: '+', oldNo: null, newNo: 11, text: '' },
    ] },
    { skipped: 39, lines: [{ kind: ' ', oldNo: 50, newNo: 51, text: '    return result' }] },
  ],
};

const thread = (key: string, side: 'old' | 'new', line: number): PrThread => ({
  key, side, line, path: diff.path, kind: 'test', source: `case_${key}`,
  message: `Review ${key}`, ask: 'Which observed result supports this change?',
  who: 'Sage', initials: 'S', state: 'open', resolvedIn: null, claim: null, severity: 'error',
});

describe('pull-request diff shared columns', () => {
  it('preserves exact long and blank source lines in one table across hunks with correct old/new numbers', () => {
    act(() => root.render(<DiffView diff={diff} phaseKey="maintenance" threads={[]} />));
    const table = host.querySelector('table')!;
    expect(host.querySelectorAll('table')).toHaveLength(1);
    expect(table.getAttribute('aria-label')).toBe(`Changes in ${diff.path}`);
    expect([...table.querySelectorAll('thead th')].map(cell => cell.textContent)).toEqual(['Old line', 'New line', 'Change', 'Code']);
    const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody > tr')];
    expect(rows.map(row => row.dataset.diffKind)).toEqual(['gap', 'context', 'removed', 'added', 'added', 'gap', 'context']);
    expect(rows.every(row => row.cells.length === 4)).toBe(true);
    expect([...rows[2].cells].map(cell => cell.textContent)).toEqual(['10', '', '-', '    raise NotImplementedError()']);
    expect([...rows[3].cells].map(cell => cell.textContent)).toEqual(['', '10', '+', longLine]);
    expect(rows[3].querySelector('retained')).toBeNull(); // Source stays escaped text.
    expect([...rows[4].cells].map(cell => cell.textContent)).toEqual(['', '11', '+', '']);
    expect(rows[5].cells[3].textContent).toBe('39 unchanged lines');
    expect([...rows[6].cells].map(cell => cell.textContent)).toEqual(['50', '51', '', '    return result']);
    expect(table.closest('[data-diff-scroll]')).not.toBeNull();
    // Native table columns share one intrinsic width; browser geometry checks
    // separately verify equal cell edges and full-width change backgrounds.
    expect([...table.querySelectorAll('col')].slice(0, 3).map(col => col.style.width)).toEqual(['44px', '44px', '18px']);
  });

  it('keeps old/new review anchors and unmatched threads exactly once without adding a fifth column', () => {
    const threads = [thread('base', 'old', 10), thread('head', 'new', 10), thread('unmatched', 'new', 99)];
    act(() => root.render(<DiffView diff={diff} phaseKey="maintenance" threads={threads} firstThreadIndex={4} />));
    const removed = host.querySelector('tr[data-diff-kind="removed"]')!;
    const added = host.querySelector('tr[data-diff-kind="added"]')!;
    expect(removed.nextElementSibling?.textContent).toContain('Review base');
    expect(added.nextElementSibling?.textContent).toContain('Review head');
    const threadRows = host.querySelectorAll<HTMLTableRowElement>('tr[data-diff-kind="thread"]');
    expect(threadRows).toHaveLength(3);
    for (const row of threadRows) {
      expect(row.cells).toHaveLength(1);
      expect(row.cells[0].colSpan).toBe(4);
    }
    expect(host.querySelector('tbody')?.lastElementChild?.textContent).toContain('Review unmatched');
    for (const index of [4, 5, 6]) expect(host.querySelectorAll(`[data-testid="phase-implementation-thread-${index}"]`)).toHaveLength(1);
  });
});

describe('the diff scroller can be reached from the keyboard', () => {
  /* A long line overflows the scroller at 390 (axe `scrollable-region-focusable`):
     while it scrolls it joins the tab order, and it is named after its file. */
  it('joins the tab order while a long line overflows it, and is a named region', () => {
    const style = document.createElement('style');
    style.textContent = '.overflow-x-auto{overflow-x:auto}';
    document.head.append(style);
    const wide = (el: Element) => el.hasAttribute('data-diff-scroll');
    const spies = [
      vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return wide(this) ? 900 : 0; }),
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return wide(this) ? 358 : 0; }),
    ];
    try {
      act(() => root.render(<DiffView diff={diff} phaseKey="design" threads={[]} />));
      const scroller = host.querySelector<HTMLElement>('[data-diff-scroll]')!;
      expect(scroller.getAttribute('tabindex')).toBe('0');
      expect(scroller.getAttribute('role')).toBe('region');
      expect(scroller.getAttribute('aria-label')).toBe(`Diff: ${diff.path}`);
    } finally {
      spies.forEach((s) => s.mockRestore());
      style.remove();
    }
  });
});
