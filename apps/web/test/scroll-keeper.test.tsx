// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreScroll, useScrollKeeper } from '@/components/workspace/useScrollKeeper';

/**
 * Scroll positions across the Code / Results switch. The switch hides one
 * side by display:none, and Chromium keeps no scroll offset for a box it does
 * not render, so without the keeper a results tab scrolled to its third
 * failure would come back at the top. jsdom lays nothing out, so this test plays the
 * browser's part: an element under display:none has no client rects, and
 * hiding a scroll container sets its scrollTop to 0, as Chromium does.
 */

const tops = new WeakMap<Element, number>();
const hiddenByStyle = (node: Element | null): boolean => {
  for (let at = node; at; at = at.parentElement) if ((at as HTMLElement).style?.display === 'none') return true;
  return false;
};

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (hiddenByStyle(this) ? [] : [{}]) as unknown as DOMRectList;
  });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return hiddenByStyle(this) ? 0 : tops.get(this) ?? 0; },
    set(this: Element, value: number) { tops.set(this, value); },
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run: FrameRequestCallback) => { run(0); return 1; });
});

let host: HTMLDivElement;
let root: Root;
let show: (view: 'code' | 'results') => void;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (Element.prototype as { scrollTop?: number }).scrollTop; });

function Column() {
  const ref = useRef<HTMLElement>(null);
  const [view, setView] = useState<'code' | 'results'>('code');
  show = setView;
  useScrollKeeper(ref, view);
  return <section ref={ref}>
    <div data-testid="code" style={{ display: view === 'code' ? 'block' : 'none' }}><div data-testid="code-scroller" /><div className="monaco-editor"><div data-testid="monaco-inner" /></div></div>
    <div data-testid="results" style={{ display: view === 'results' ? 'block' : 'none' }}><div data-testid="results-scroller" /></div>
    <div data-testid="shared" />
  </section>;
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
/** The learner scrolls a container: the browser moves it and says so. */
const scroll = (id: string, top: number) => act(() => { el(id).scrollTop = top; el(id).dispatchEvent(new Event('scroll')); });
/** What the browser does to the offset of a box it stops rendering. */
const forget = (id: string) => tops.set(el(id), 0);

describe('the Code / Results switch keeps where the learner was', () => {
  it('puts the results back where the learner left them, and the code too', () => {
    act(() => root.render(<Column />));
    scroll('code-scroller', 420);
    act(() => show('results'));
    forget('code-scroller');
    scroll('results-scroller', 300);
    act(() => show('code'));
    forget('results-scroller');
    expect(el('code-scroller').scrollTop, 'the code where it was').toBe(420);
    act(() => show('results'));
    expect(el('results-scroller').scrollTop, 'the results where they were').toBe(300);
  });

  it('leaves alone a container the switch did not move, and one never scrolled', () => {
    act(() => root.render(<Column />));
    scroll('shared', 80);
    act(() => show('results'));
    expect(el('shared').scrollTop).toBe(80);
    expect(el('results-scroller').scrollTop).toBe(0);
  });

  it('leaves the editor\'s own view to Monaco', () => {
    act(() => root.render(<Column />));
    scroll('monaco-inner', 200);
    act(() => show('results'));
    forget('monaco-inner');
    act(() => show('code'));
    expect(el('monaco-inner').scrollTop).toBe(0);
  });

  it('puts back only containers that are drawn and still in the page', () => {
    const kept = new Map<Element, number>();
    const visible = document.createElement('div');
    document.body.append(visible);
    visible.scrollTop = 0;
    kept.set(visible, 120);
    expect(restoreScroll(kept)).toBe(1);
    expect(visible.scrollTop).toBe(120);
    expect(restoreScroll(kept), 'nothing to move twice').toBe(0);
    visible.remove();
    expect(restoreScroll(kept), 'a removed container is dropped').toBe(0);
    expect(kept.size).toBe(0);
  });
});
