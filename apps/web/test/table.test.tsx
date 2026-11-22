// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CellTitle, Chip, Table } from '@/components/ui';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('shared table with unequal content lengths', () => {
  it('keeps a wrapped review and its short verdict in the same semantic row, including after a revision changes', () => {
    const open = vi.fn();
    const render = (detail: string) => act(() => root.render(
      <Table minWidth={280} cols={[{ label: 'Check' }, { label: 'Result', width: 'auto', align: 'right' }]}
        rows={[
          [<CellTitle key="check" state="fail" title="Preserve existing task membership" detail={detail} />,
            <Chip key="result" tone="fail">Needs revision</Chip>],
          [<button key="history" onClick={open}>Inspect original submission</button>, <Chip key="pass" tone="pass">Pass</Chip>],
        ]} />,
    ));
    render('A task with several comments must still occur once. Verify the zero-comment boundary and the existing ordering independently.');
    const table = host.querySelector<HTMLElement>('[role="table"]')!;
    const rows = table.querySelectorAll('[role="row"]');
    expect(rows).toHaveLength(3);
    expect([...rows[1].querySelectorAll('[role="cell"]')].map(cell => cell.textContent)).toEqual([
      expect.stringContaining('Verify the zero-comment boundary'), 'Needs revision',
    ]);
    expect(rows[2].querySelectorAll('[role="cell"]')).toHaveLength(2);
    act(() => host.querySelector('button')!.click());
    expect(open).toHaveBeenCalledOnce();
    render('The revised check preserves membership.');
    expect(rows[1].querySelectorAll('[role="cell"]')[0].textContent).toContain('The revised check');
    expect(rows[1].querySelectorAll('[role="cell"]')[1].textContent).toBe('Needs revision');

    // jsdom verifies the sizing contract, not pixel layout. Browser regression
    // checks must compare each row's cell top/bottom and shared column edges.
    expect(getComputedStyle(table).alignItems).toBe('stretch');
    expect(table.style.gridTemplateColumns).toBe('minmax(0,1fr) auto');
    expect(table.style.minWidth).toBe('280px');
  });

  it('preserves fixed and explicitly bounded tracks alongside fractional columns and a long heading', () => {
    act(() => root.render(<Table minWidth={360} cols={[
      { label: 'When', width: '60px' },
      { label: 'The complete historical revision and its retained evidence', width: '1.6fr' },
      { label: 'Verdict', width: 'minmax(90px,140px)' },
    ]} rows={[[null, 'api/repository/a_very_long_unbroken_identifier.py', 'Needs revision']]} />));
    const table = host.querySelector<HTMLElement>('[role="table"]')!;
    expect(table.style.gridTemplateColumns).toBe('60px minmax(0,1.6fr) minmax(90px,140px)');
    expect(table.getAttribute('aria-colcount')).toBe('3');
    expect(table.querySelectorAll('[role="columnheader"]')).toHaveLength(3);
    const cells = table.querySelectorAll('[role="cell"]');
    expect(cells).toHaveLength(3);
    expect(cells[0].textContent).toBe('');
    expect(cells[1].textContent).toContain('a_very_long_unbroken_identifier');
    expect(cells[2].textContent).toBe('Needs revision');
  });
});
