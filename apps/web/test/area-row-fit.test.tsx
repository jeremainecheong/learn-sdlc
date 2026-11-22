// @vitest-environment jsdom
/**
 * From 1024 px the working-area row is one line of one height in every
 * code phase, on the workspace and on its document pages, and never wraps.
 *
 * The row measures what it holds (area-row-fit.ts): where its entries and the
 * brief and mentor switches do not fit with the switches' words, the switches
 * drop their words from view. They stay the row's last child, keep their icon,
 * their accessible names ("Hide brief", "Hide mentor") and gain a title; they
 * take their words back as soon as the row can hold them. Under 1024 px
 * nothing is compacted (the row wraps there). The CSS that makes
 * the row one line, pins the switches at its right end where its entries
 * scroll, hides the words without removing them, and evens the Code / Results
 * switch and the ready band is read by string. jsdom lays nothing out, so the
 * widths are given here.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, webSource } from './support/source-text';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));

import { PhaseAreaNav } from '@/components/workspace/AreaNav';
import { WorkspacePanelControls } from '@/components/workspace/WorkspacePanels';

const layout = vi.hoisted(() => ({ width: 1000, wide: true, entry: 100, observers: [] as (() => void)[], fonts: [] as (() => void)[] }));
const SWITCHES = 200, SWITCHES_COMPACT = 80;
const realRect = Element.prototype.getBoundingClientRect;
const realRects = Element.prototype.getClientRects;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  layout.width = 1000; layout.wide = true; layout.entry = 100; layout.observers = []; layout.fonts = [];
  // Web fonts: the row listens for their loading; `loadingdone` is fired by the test.
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise(() => {}), addEventListener: (_: string, listener: () => void) => layout.fonts.push(listener), removeEventListener() {} } });
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return query === '(min-width: 1024px)' ? layout.wide : false; }, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { layout.observers.push(cb); } observe() {} disconnect() {} unobserve() {} });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.tagName === 'NAV' ? layout.width : 0; } });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const width = this.classList.contains('workspace-panel-controls-strip') ? (this.hasAttribute('data-compact') ? SWITCHES_COMPACT : SWITCHES) : this.parentElement?.tagName === 'NAV' ? layout.entry : 0;
    return { width, height: 32, top: 0, left: 0, right: width, bottom: 32, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (document as { fonts?: unknown }).fonts;
  Element.prototype.getBoundingClientRect = realRect; Element.prototype.getClientRects = realRects;
});

const panels = { briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' };
/** Testing's planted bugs page: four entries, then the switches. Needs 8 + 4 x 100 + 200 = 608 px with the words. */
const draw = () => act(() => root.render(<PhaseAreaNav phase={{ id: 'p-4', key: 'testing' }} current="matrix" tools={<WorkspacePanelControls panels={panels} placement="strip" />} />));
const resize = (width: number) => act(() => { layout.width = width; layout.observers.forEach((observer) => observer()); });
const nav = () => host.querySelector<HTMLElement>('nav[aria-label="Phase working area"]')!;
const group = () => host.querySelector<HTMLElement>('[role="group"][aria-label="Workspace panels"]')!;
const switches = () => [...group().querySelectorAll('button')];

describe('the row\'s switches drop their words where the row cannot hold them', () => {
  it('too narrow: the switches are the row\'s last child, with their icon, their names and a title', () => {
    layout.width = 600;
    draw();
    expect(group().getAttribute('data-compact')).toBe('true');
    expect(nav().lastElementChild).toBe(group());
    expect(switches().map((b) => b.textContent)).toEqual(['Hide brief', 'Hide mentor']);
    expect(switches().map((b) => b.getAttribute('title'))).toEqual(['Hide brief', 'Hide mentor']);
    expect(switches().map((b) => b.querySelector('svg') !== null)).toEqual([true, true]);
    // the words are still in the button (its accessible name), only hidden from view by the compact rule
    expect(switches().map((b) => b.querySelector('.workspace-panel-word')?.textContent)).toEqual(['Hide brief', 'Hide mentor']);
    expect(switches().map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
  });
  it('wide enough: the words, and no title', () => {
    layout.width = 700;
    draw();
    expect(group().hasAttribute('data-compact')).toBe(false);
    expect(switches().map((b) => b.getAttribute('title'))).toEqual([null, null]);
    expect(switches().map((b) => b.textContent)).toEqual(['Hide brief', 'Hide mentor']);
  });
  it('the words come back as soon as the row can hold them, counted at their full width while hidden', () => {
    layout.width = 600;
    draw();
    expect(group().getAttribute('data-compact')).toBe('true');
    // 608 px are needed with the words: 607 is still too narrow, 608 holds them
    resize(607);
    expect(group().getAttribute('data-compact')).toBe('true');
    resize(608);
    expect(group().hasAttribute('data-compact')).toBe(false);
    resize(590);
    expect(group().getAttribute('data-compact')).toBe('true');
  });
  it('under 1024 px nothing is compacted (the row wraps there)', () => {
    layout.wide = false; layout.width = 300;
    draw();
    expect(group().hasAttribute('data-compact')).toBe(false);
    expect(switches().map((b) => b.getAttribute('title'))).toEqual([null, null]);
  });
  it('the switches drawn on a row of their own never take the row\'s word wrapper', () => {
    act(() => root.render(<WorkspacePanelControls panels={panels} />));
    expect(host.querySelector('.workspace-panel-word')).toBeNull();
    expect(switches().map((b) => b.textContent)).toEqual(['Hide brief', 'Hide mentor']);
  });
});

/*
 * The row measures again when web fonts finish loading (they change the entries' widths and
 * nothing else would say so), and its scroll padding is the switches' real width, so an entry Tab reaches is never left
 * under them. Implementation's "Saved workspace" is a status word, not a control: where the row has no room for it
 * whole, it leaves the view (data-quiet) before the switches drop their words, and stays in the page.
 */
describe('web fonts, the scroll padding and the status word', () => {
  /** Implementation's pull request page: Code, Split, Pull request, "Saved workspace", the switches (no Files entry, so three entries). */
  const drawImplementation = () => act(() => root.render(<PhaseAreaNav phase={{ id: 'p-3', key: 'implementation' }} current="pr" tools={<WorkspacePanelControls panels={panels} placement="strip" />} />));
  const implementationNav = () => host.querySelector<HTMLElement>('nav[aria-label="Implementation working area"]')!;
  const status = () => implementationNav().querySelector<HTMLElement>(':scope > .area-row-status')!;
  it('a web font that loads and widens the entries is measured: the switches drop their words', () => {
    layout.width = 650;
    draw();
    expect(group().hasAttribute('data-compact')).toBe(false);
    act(() => { layout.entry = 120; layout.fonts.forEach((listener) => listener()); });
    expect(group().getAttribute('data-compact')).toBe('true');
    act(() => { layout.entry = 100; layout.fonts.forEach((listener) => listener()); });
    expect(group().hasAttribute('data-compact')).toBe(false);
  });
  it('the row keeps an entry Tab reaches clear of the switches by their real width, words or none', () => {
    layout.width = 700;
    draw();
    expect(nav().style.getPropertyValue('--area-row-end')).toBe(`${SWITCHES + 8}px`);
    resize(600);
    expect(nav().style.getPropertyValue('--area-row-end')).toBe(`${SWITCHES_COMPACT + 8}px`);
  });
  it('"Saved workspace" leaves the view first, whole, and stays in the page; then the switches drop their words', () => {
    // 8 + 3 entries x 100 + the switches' 200 + the word's 100 = 608 px with everything
    layout.width = 620;
    drawImplementation();
    expect(status().textContent).toBe('Saved workspace');
    expect(implementationNav().hasAttribute('data-quiet')).toBe(false);
    resize(607);
    expect(implementationNav().hasAttribute('data-quiet')).toBe(true);
    expect(group().hasAttribute('data-compact')).toBe(false);
    expect(status().textContent).toBe('Saved workspace');
    resize(507);
    expect(implementationNav().hasAttribute('data-quiet')).toBe(true);
    expect(group().getAttribute('data-compact')).toBe('true');
    // each comes back as soon as the row holds it, counted at its full width while hidden
    resize(508);
    expect(group().hasAttribute('data-compact')).toBe(false);
    expect(implementationNav().hasAttribute('data-quiet')).toBe(true);
    resize(608);
    expect(implementationNav().hasAttribute('data-quiet')).toBe(false);
  });
  it('a status word the row has squeezed is counted at its whole width, so it leaves instead of reading cut', () => {
    // its box is squeezed to the harness's 100 px, but the word needs 160: 8 + 300 + 200 + 160 = 668 px with everything
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('area-row-status') ? 160 : 0; } });
    try {
      layout.width = 620;
      drawImplementation();
      expect(implementationNav().hasAttribute('data-quiet')).toBe(true);
      expect(group().hasAttribute('data-compact')).toBe(false);
      resize(668);
      expect(implementationNav().hasAttribute('data-quiet')).toBe(false);
    } finally {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });
  it('the status word cannot be shrunk by the row', () => {
    const css = webSource('components/workspace/phase-experience.css');
    expect(css).toContain('.implementation-view-tabs>.area-row-status{flex:none}');
  });
  it('a row with no status word has nothing quiet', () => {
    layout.width = 600;
    draw();
    expect(nav().querySelector('.area-row-status')).toBeNull();
    expect(nav().hasAttribute('data-quiet')).toBe(false);
  });
});

/*
 * The change request page's switches were icon-only at 1440 px. So were those of every
 * other Maintenance page and of Testing's: five entries and the worded switches need
 * more than the row's 738 px there. The rule is the row's, not the page's: every page of a phase holds the same
 * entries, so at one width they all keep their words or all drop them.
 */
describe('the pages of one phase compact alike', () => {
  const maintenance = { id: 'p-6', key: 'maintenance' as const, change: {} as never };
  const drawAt = (current: 'change' | 'pr') =>
    act(() => root.render(<PhaseAreaNav phase={maintenance} current={current} tools={<WorkspacePanelControls panels={panels} placement="strip" />} />));
  it.each([[600, 'true'], [700, null]] as const)('at %i px the change request and the pull request pages agree', (width, compact) => {
    layout.width = width;
    const seen: (string | null)[] = [];
    for (const current of ['change', 'pr'] as const) {
      drawAt(current);
      expect([...nav().querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Change request', 'Edit files', 'Execution evidence', 'Pull request']);
      seen.push(group().getAttribute('data-compact'));
    }
    expect(seen).toEqual([compact, compact]);
  });
});

describe('the styles that make the row one line', () => {
  const css = webSource('components/workspace/phase-experience.css');
  // The room's two rows are measured where they are drawn, wherever the room is split to.
  const page = closureText('app/(app)/workspace/[phaseId]/page.tsx');
  it('from 1024 px the row does not wrap, and the switches stay pinned at its right end on its own background', () => {
    expect(css).toContain('@media(min-width:1024px){\n .implementation-view-tabs{flex-wrap:nowrap;scroll-padding-inline-end:var(--area-row-end,88px)}\n .implementation-view-tabs>.workspace-panel-controls.workspace-panel-controls-strip{position:sticky;right:0;z-index:1;align-self:stretch;align-items:center;margin-block:-7px;padding-block:7px;background:linear-gradient(180deg,var(--tool-surface),var(--tool-raised))}\n}');
    // the row scrolls sideways where even that is too wide (its own overflow), and the one-line rule comes after the wrap it overrides
    expect(css).toMatch(/\.implementation-view-tabs\{display:flex;[^}]*overflow:auto\}/);
    expect(css.indexOf('.implementation-view-tabs{flex-wrap:nowrap;')).toBeGreaterThan(css.indexOf('.deployment-tool-evidence [role=tablist],.implementation-view-tabs{flex-wrap:wrap}'));
    // the pinned switches' vertical bleed equals the row's own padding, so they cover it exactly
    expect(css).toMatch(/\.implementation-view-tabs\{display:flex;gap:5px;align-items:center;padding:7px 10px;/);
  });
  it('the status word leaves the view whole, never display:none, and the switches keep the row\'s right end', () => {
    expect(css).toContain('.implementation-view-tabs[data-quiet]>.area-row-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
    expect(css).toContain('.implementation-view-tabs[data-quiet]>.area-row-status+.workspace-panel-controls-strip{margin-left:auto}');
    // The workspace's own row marks the same word: asserted on the rendered room in `work-room-header.test.tsx`.
  });
  it('the ready band\'s rule reaches the band of a phase split into tasks, which sits beside the room\'s scroll box', () => {
    // RoomStack wraps a split phase's room in this box, so the band's sibling is the box, not .phase-lab-workspace
    // (the box and its class are asserted on the rendered room in `split-phase-room-reads.test.tsx`).
    expect(css.match(/:has\(>\.phase-lab-workspace,>\.workspace-room-scroll,>\.phase-document-room--work\)>\.phase-gate-banner/g)).toHaveLength(3);
  });
  it('compact, a switch\'s word is hidden from view only: never display:none, so the name stays', () => {
    const rule = css.match(/\.workspace-panel-controls-strip\[data-compact\] \.workspace-panel-word\{([^}]*)\}/)![1];
    expect(rule).toBe('position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap');
    expect(css).toContain('.workspace-panel-controls-strip[data-compact] button{gap:0;padding-inline:8px}');
  });
  it('the Code / Results switch is the entries\' 32 px on the row, and the ready band is one line from 1024 to 1279 px', () => {
    expect(css).toContain('@media(min-width:768px){.implementation-view-tabs>.focus-switch{padding:1px}.implementation-view-tabs>.focus-switch button{min-height:28px}}');
    // 1 px border + 1 px padding on each side of a 28 px button is the entries' 32 px
    expect(css).toMatch(/\.focus-switch\{display:inline-flex;[^}]*border:1px solid/);
    expect(css).toMatch(/\.implementation-view-tabs>button,\.runtime-view-tabs>a\{[^}]*min-height:32px/);
    // on a code phase's pages only (the band beside the workspace's columns or the document frame's room), never Requirements' or Design's
    const room = ':has(>.phase-lab-workspace,>.workspace-room-scroll,>.phase-document-room--work)>';
    expect(css).toContain(`@media(min-width:1024px) and (max-width:1279px){${room}.phase-gate-banner:has(>.phase-gate-sentence){flex-wrap:nowrap}${room}.phase-gate-banner>.phase-gate-sentence{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}${room}.phase-gate-banner:has(>.phase-gate-sentence)>span{flex:none;flex-wrap:nowrap}}`);
  });
  it('Implementation\'s links take its view buttons\' box, and its current page reads as its pressed view', () => {
    expect(css).toContain(':where(.implementation-view-tabs:not(.runtime-view-tabs))>a{display:flex;align-items:center;gap:6px;white-space:nowrap;border:1px solid transparent;border-radius:7px;padding:6px 10px;flex:none;min-height:32px;font-weight:550}');
    const pressed = css.match(/\.implementation-view-tabs>button\[aria-pressed=true\]\{([^}]*)\}/g)!.at(-1)!.replace(/^[^{]*\{/, '{');
    const current = css.match(/\.implementation-view-tabs:not\(\.runtime-view-tabs\)>a\[aria-current=page\]\{[^}]*\}/)![0].replace(/^[^{]*\{/, '{');
    expect(current).toBe(pressed);
  });
  it('the workspace\'s two rows measure themselves and hand the switches the answer', () => {
    expect(page).toContain('<AreaRowCompact.Provider value={areaRow.compact}>');
    expect(page.match(/<nav ref=\{areaRow\.ref\} className="implementation-view-tabs( runtime-view-tabs)?" aria-label="(Implementation|Phase) working area">/g)).toHaveLength(2);
  });
});

/*
 * Testing's row at 1280 px with the brief and the mentor open. Even with the switches' words dropped,
 * the five entries did not fit, and the row scrolled them under the pinned switches: "App previe" and "Pull reque" were
 * cut with nothing to say there was more. Where the entries and the wordless switches still do not fit, the row now
 * wraps onto a second line, every entry whole; as soon as one line holds them again it is one line.
 */
describe('a row too narrow even for the wordless switches wraps, never cuts an entry', () => {
  const wrap = () => nav().hasAttribute('data-wrap');
  it('the planted bugs page: 8 + 4 x 100 + the wordless 80 = 488 px; at 450 it wraps, at 488 it is one line', () => {
    layout.width = 450;
    draw();
    expect(group().getAttribute('data-compact')).toBe('true');
    expect(wrap()).toBe(true);
    // the switches are still the row's last child, with their names
    expect(nav().lastElementChild).toBe(group());
    expect(switches().map((b) => b.textContent)).toEqual(['Hide brief', 'Hide mentor']);
    resize(488);
    expect(wrap()).toBe(false);
    expect(group().getAttribute('data-compact')).toBe('true');
    resize(487);
    expect(wrap()).toBe(true);
    resize(700);
    expect(wrap()).toBe(false);
    expect(group().hasAttribute('data-compact')).toBe(false);
  });
  it('where the wordless switches fit, nothing wraps', () => {
    layout.width = 600;
    draw();
    expect(group().getAttribute('data-compact')).toBe('true');
    expect(wrap()).toBe(false);
  });
  it('under 1024 px the attribute is never set (the row wraps there by its own rule)', () => {
    layout.wide = false; layout.width = 300;
    draw();
    expect(wrap()).toBe(false);
  });
  it('the wrapped row\'s styles: it wraps, and the switches end its last line in its flow, not pinned over it', () => {
    const css = webSource('components/workspace/phase-experience.css');
    expect(css).toContain('@media(min-width:1024px){\n .implementation-view-tabs[data-wrap]{flex-wrap:wrap;row-gap:4px}\n .implementation-view-tabs[data-wrap]>.workspace-panel-controls.workspace-panel-controls-strip{position:static;align-self:center;margin-block:0;padding-block:0;background:none}\n}');
    // after the one-line rule it overrides
    expect(css.indexOf('.implementation-view-tabs[data-wrap]{flex-wrap:wrap')).toBeGreaterThan(css.indexOf('.implementation-view-tabs{flex-wrap:nowrap;'));
  });
});
