// @vitest-environment jsdom
/**
 * Three scrollable boxes that axe's scrollable-region-focusable rule checks
 * and that need their own wiring.
 *
 * - /dossier and /instructor/learners/:learner/dossier at 390px,
 *   `table:nth-child(3)`: the fields table in design.md, drawn by
 *   `components/Markdown.tsx`. `.prose-docs table{display:block;overflow-x:auto}`
 *   (globals.css) makes the table itself the scroller, so it is the table that
 *   has to take focus, not a wrapper.
 * - /workspace/:deployment (IDE) at 390px,
 *   `.panel:nth-child(3) > .pb-4.pt-3.gap-4 > .overflow-x-auto.w-full`: the
 *   table wrapper in `panels/deployment/index.tsx` (the drill's faulted
 *   configuration table). The Runbook tab, which replaced the runbook ledger,
 *   is forms and draws no scrolling table.
 *
 * Each box joins the tab order while it scrolls, through `lib/scroll-focus.ts`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '@/components/Markdown';
import deployment from '@/components/workspace/panels/deployment';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

let style: HTMLStyleElement;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  style = document.createElement('style');
  style.textContent = '.prose-docs table{display:block;overflow-x:auto}.overflow-x-auto{overflow-x:auto}';
  document.head.appendChild(style);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  style.remove();
  root = null;
  host = null;
  while (spies.length) spies.pop()!.mockRestore();
});

const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
};

/** Lay out the boxes `wide` picks as a 640px table in a 300px phone column. */
function phoneWidth(wide: (el: Element) => boolean) {
  spies.push(
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return wide(this) ? 640 : 0;
    }),
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return wide(this) ? 300 : 0;
    }),
  );
}

describe('a Markdown table that scrolls at phone width (dossier design.md)', () => {
  it('can be reached by the keyboard', () => {
    phoneWidth((el) => el.tagName === 'TABLE');
    mount(<Markdown>{'# Model\n\nFields:\n\n| Field | Type | Rule |\n|---|---|---|\n| id | string | required |\n'}</Markdown>);
    const table = host!.querySelector<HTMLElement>('.prose-docs table');
    expect(table, 'the markdown table').not.toBeNull();
    expect(table!.getAttribute('tabindex')).toBe('0');
  });

  it('adds no tab stop to a table that fits', () => {
    phoneWidth(() => false);
    mount(<Markdown>{'| a | b |\n|---|---|\n| 1 | 2 |\n'}</Markdown>);
    expect(host!.querySelector('.prose-docs table')!.hasAttribute('tabindex')).toBe(false);
  });
});

describe('the deployment panel tables that scroll at phone width', () => {
  // The table wrappers: `w-full overflow-x-auto`, no min-w-0.
  const isTableWrap = (el: Element) => el.tagName === 'DIV' && el.getAttribute('class') === 'w-full overflow-x-auto';

  const props = (drill: PhasePanelProps['drill'], runbook = false) =>
    ({
      detail: {
        id: 'p-deployment', key: 'deployment', files: [], lastSubmission: null,
        ...(runbook ? { runbook: { floor: { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true }, drill: true } } : {}),
      },
      setFile: vi.fn(),
      files: {},
      submission: null,
      drill,
      drillApi: { start: vi.fn(), health: vi.fn(), resolve: vi.fn() },
      helpers: {
        fileText: () => '',
        busy: false,
        openFile: vi.fn(),
        flushSave: vi.fn(),
        setTab: vi.fn(),
        setPane: vi.fn(),
        setNotice: vi.fn(),
        setError: vi.fn(),
      },
    }) as unknown as PhasePanelProps;

  it('the Runbook tab draws no scrolling table: its sections are forms the keyboard reaches by itself', () => {
    phoneWidth(isTableWrap);
    const Tools = deployment.Tools!;
    mount(<Tools {...props(null, true)} initialView="runbook" />);
    const tab = host!.querySelector('[data-testid="runbook-tab"]');
    expect(tab, 'the Runbook tab').not.toBeNull();
    expect(Array.from(tab!.querySelectorAll('div')).filter(isTableWrap)).toEqual([]);
    expect(tab!.querySelectorAll('input, textarea, select, button').length).toBeGreaterThan(0);
  });

  it('the drill’s faulted-configuration table can be reached by the keyboard', () => {
    phoneWidth(isTableWrap);
    const Tools = deployment.Tools!;
    mount(
      <Tools
        {...props({
          fault: 'compose-port',
          pagedAt: '2026-10-01T01:00:00.000Z',
          runbookBefore: null,
          pagedExit: 1,
          healthRanAt: null,
          healthExit: null,
          fixAppliedAt: null,
          resolvedAt: null,
          incident: null,
        })}
      />,
    );
    const wraps = Array.from(host!.querySelectorAll<HTMLElement>('div')).filter(isTableWrap);
    // The faulted-configuration table (the runbook ledger is gone: the runbook is the record).
    expect(wraps.length).toBe(1);
    for (const wrap of wraps) expect(wrap.getAttribute('tabindex')).toBe('0');
  });
});
