// @vitest-environment jsdom
/**
 * At 1280 px with the brief and the mentor open, the Implementation room's row of tabs under the code
 * (Terminal, Console, Tests, Problems, Ledger, Health, Commit, Review) asked for about 29 px more than its 578 px
 * column, so it scrolled sideways and showed its first tab as "rminal". Where the tabs do not fit
 * at their usual 14 px side padding, the row now draws them at 10 px (64 px less for eight tabs), so every tab is whole;
 * where they fit, the row and its markup are what they were. The decision reads the tabs' widths at the usual padding
 * whatever padding they are drawn at, so it cannot flip back and forth.
 *
 * jsdom lays nothing out: each tab's width is given here from its label and its padding, the row's width by hand.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOTTOM_TAB_PAD, BOTTOM_TAB_PAD_TIGHT, BottomPanel, type BottomTab } from '@/components/shell/ide';

let host: HTMLDivElement, root: Root;
let rowWidth = 0;
const realRect = Element.prototype.getBoundingClientRect;
const realClient = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
/** A tab's label width at 12 px semibold, about 7 px a character, as Chrome draws the row. */
const labelWidth = (el: Element) => (el.textContent ?? '').length * 7;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const pad = this.getAttribute('role') === 'tab' ? (this.className.includes('px-2.5') ? BOTTOM_TAB_PAD_TIGHT : BOTTOM_TAB_PAD) : 0;
    const width = this.getAttribute('role') === 'tab' ? labelWidth(this) + 2 * pad : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 30, width, height: 30, toJSON() {} } as DOMRect;
  };
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return this.getAttribute('role') === 'tablist' ? rowWidth : 0; } });
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  Element.prototype.getBoundingClientRect = realRect;
  if (realClient) Object.defineProperty(Element.prototype, 'clientWidth', realClient); else delete (Element.prototype as { clientWidth?: number }).clientWidth;
});

/** Implementation's eight tabs. */
const TABS: BottomTab[] = [
  ['terminal', 'Terminal'], ['console', 'Console'], ['tests', 'Tests'], ['problems', 'Problems', 0], ['ledger', 'Ledger'],
  ['health', 'Health', 0], ['commit', 'Commit', 0], ['review', 'Review'],
].map(([key, label, count]) => ({ key: key as string, label, count: count as number | undefined, testId: `bottom-tab-${key}`, content: <p>{label}</p> }));
const render = (width: number, value = 'review') => {
  rowWidth = width;
  act(() => root.render(<BottomPanel tabs={TABS} value={value} onChange={() => {}} />));
};
const row = () => host.querySelector('[role="tablist"]') as HTMLElement;
const tabs = () => [...host.querySelectorAll('[role="tab"]')] as HTMLElement[];
const natural = () => TABS.reduce((sum, t) => sum + (String(t.label) + (t.count !== undefined ? String(t.count) : '')).length * 7 + 2 * BOTTOM_TAB_PAD, 0);

describe('the tabs under the code fit their row at 1280 px', () => {
  it("the eight tabs ask for more than the 578 px column at the usual padding, and fit at the narrower one", () => {
    expect(natural()).toBeGreaterThan(578);
    expect(natural() - TABS.length * 2 * (BOTTOM_TAB_PAD - BOTTOM_TAB_PAD_TIGHT)).toBeLessThanOrEqual(578);
  });

  it('in a 578 px row, every tab is drawn at the narrower padding, so the row does not scroll and Terminal is whole', () => {
    render(578);
    expect(row().dataset.tight).toBe('true');
    for (const tab of tabs()) expect(tab.className).toContain('px-2.5');
    const drawn = tabs().reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0);
    expect(drawn).toBeLessThanOrEqual(578);
    expect(tabs()[0].textContent).toBe('Terminal');
  });

  it('stays narrow once narrow: the tabs at 10 px fit, and the row does not go back to 14 px and overflow again', () => {
    render(578);
    for (let i = 0; i < 3; i += 1) {
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(row().dataset.tight, `after re-measure ${i + 1}`).toBe('true');
    }
  });

  it('where the tabs fit at the usual padding (1440 px, 738 px of column), the row is not tight and the tabs keep their usual padding', () => {
    render(738);
    expect(row().hasAttribute('data-tight')).toBe(false);
    for (const tab of tabs()) {
      expect(tab.className).toContain('px-3.5');
      expect(tab.className).not.toContain('px-2.5');
    }
    // and a row that fits is drawn as one that was never measured (on the server, or before layout)
    // (the generated ids, which count renders, written as one)
    const markup = () => row().outerHTML.replace(/_r_\d+_/g, 'ID');
    const measured = markup();
    act(() => root.unmount()); root = createRoot(host);
    render(0);
    expect(markup()).toBe(measured);
  });

  it('every tab keeps its test id, role, name, selection and order', () => {
    render(578, 'review');
    expect(tabs().map((t) => [t.dataset.testid, t.getAttribute('role'), t.textContent, t.getAttribute('aria-selected')])).toEqual(
      TABS.map((t) => [t.testId, 'tab', String(t.label) + (t.count !== undefined ? String(t.count) : ''), String(t.key === 'review')]),
    );
  });
});
