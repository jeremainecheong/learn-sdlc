// @vitest-environment jsdom
/**
 * The reviewer's column, with a DOM under it: the feed's scroll.
 *
 * The thread must open at the newest turn when its tab is opened, stay there
 * after "Explain this failure", and never stop a paragraph short of a reply
 * that has just landed.
 *
 * jsdom lays nothing out, so the scroller's sizes are set by hand and the
 * `ResizeObserver` is a stub the test fires itself. What is asserted is the
 * rule, not the pixels: pinned on mount, pinned on a new turn, pinned while the
 * content grows, and left alone once the learner has scrolled up to read.
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageView } from '@learnsdlc/shared';

// The markdown engine is a dynamic import the feed never waits on; here a reply
// is its text and nothing else.
vi.mock('next/dynamic', () => ({
  default: () => (props: { children?: string }) => <div>{props.children}</div>,
}));

/** Every observer made since the last reset, so a test can fire them by hand. */
const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
class FakeResizeObserver {
  private entry: { cb: ResizeObserverCallback; targets: Element[] };
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.entry.targets = [];
  }
}
const grow = () => {
  for (const o of observers) if (o.targets.length) o.cb([], o as unknown as ResizeObserver);
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
};

beforeEach(() => {
  observers.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
function thread(n: number): AssistantMessageView[] {
  const out: AssistantMessageView[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: `u${i}`, role: 'user', content: `question ${i + 1}`, createdAt: at(i * 2) });
    out.push({ id: `a${i}`, role: 'assistant', content: `answer ${i + 1}`, createdAt: at(i * 2 + 1) });
  }
  return out;
}

describe('the feed stays at the newest turn', () => {
  /** A scroller jsdom can measure: sizes by hand, scrollTop that sticks. */
  function measurable(el: HTMLElement, sizes: { content: number; box: number }) {
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { get: () => sizes.content, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => sizes.box, configurable: true });
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, sizes.content - sizes.box));
        el.dispatchEvent(new Event('scroll'));
      },
      configurable: true,
    });
  }

  it('pins on mount, on a new turn and while a reply grows, and not over a learner reading', async () => {
    const { PersonaFeed } = await import('@/components/shell/PersonaPanel');
    const { PHASE_REVIEWER } = await import('@/lib/phase');
    const { questionOrdinals } = await import('@/lib/hints');
    const scrollRef = createRef<HTMLDivElement>();
    const draw = (messages: AssistantMessageView[], busy = false) => ({
      phaseKey: 'implementation' as const,
      phaseStateId: 'ps-1',
      reviewer: PHASE_REVIEWER.implementation,
      name: 'Senior engineer',
      ask: 'Ask the senior engineer',
      messages,
      ordinals: questionOrdinals(messages),
      asked: messages.length / 2,
      busy,
      usage: null,
      send: async () => null,
      explain: async () => null,
      failure: null,
      clearFailure: () => {},
      scrollRef,
    });

    // The tab was just opened: a fresh scroller, already taller than its box.
    const sizes = { content: 2000, box: 400 };
    mount(<PersonaFeed thread={draw(thread(11))} />);
    const el = scrollRef.current!;
    measurable(el, sizes);
    // Mount ran against jsdom's zero heights; the frame the hook queues pins
    // against the real ones, the way a browser's first layout does.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop).toBe(1600);

    // Markdown, badges and a memory line land after the first paint and make
    // the thread taller: the observer keeps the newest turn in view.
    sizes.content = 2400;
    act(() => grow());
    expect(el.scrollTop).toBe(2000);

    // The learner scrolls up to read question 3. Nothing new has arrived, so
    // growth under them (a late-parsed reply) must not yank them back.
    act(() => {
      el.scrollTop = 300;
    });
    sizes.content = 2500;
    act(() => grow());
    expect(el.scrollTop).toBe(300);

    // They ask again: their bubble is a new turn, and the feed goes to it.
    const twelve = [
      ...thread(11),
      { id: 'u11', role: 'user' as const, content: 'question 12', createdAt: at(30) },
    ];
    sizes.content = 2600;
    act(() => root!.render(<PersonaFeed thread={draw(twelve, true)} />));
    expect(el.scrollTop).toBe(2200);

    // The reply lands and then grows as it parses: still at the bottom.
    const answered = [
      ...twelve,
      { id: 'a11', role: 'assistant' as const, content: 'answer 12', createdAt: at(31) },
    ];
    sizes.content = 2900;
    act(() => root!.render(<PersonaFeed thread={draw(answered, false)} />));
    expect(el.scrollTop).toBe(2500);
    sizes.content = 3300;
    act(() => grow());
    expect(el.scrollTop).toBe(2900);

    // Back near the bottom by hand counts as reading the newest turn again.
    act(() => {
      el.scrollTop = 100;
      el.scrollTop = 2850;
    });
    sizes.content = 3500;
    act(() => grow());
    expect(el.scrollTop).toBe(3100);
  });
});
