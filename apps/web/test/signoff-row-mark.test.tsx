// @vitest-environment jsdom
/**
 * A pointer press on the editor's Sign-off entry draws no focus ring,
 * so the box's row is marked for a moment: the mark comes off after two
 * seconds or at the next press anywhere, and its going moves nothing (no
 * focus, no scroll, nothing ticked, nothing sent).
 *
 * jsdom has no layout: a scroll is the `scrollIntoView` call the page makes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SIGN_OFF_LANDED_ATTR, SIGN_OFF_LANDED_MS, StepBar, revealSignOff } from '@/components/staff/projects/requirements/StepBar';
import { SignOffToggle, signOffBoxId } from '@/components/staff/projects/TaskEditor';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrolls: { on: Element; options: unknown }[] = [];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  scrolls = [];
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = function (this: Element, options?: unknown) {
    scrolls.push({ on: this, options });
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  // Take off any mark a test left, so the next test starts with none.
  fireEvent.pointerDown(document.body);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('the row a Sign-off press lands on is marked for a moment', () => {
  const STEPS = [{ n: 1, label: 'Background', done: true }];

  function RowAndBox({ onChange, keys = ['main'] }: { onChange: () => void; keys?: string[] }) {
    return (
      <div>
        <StepBar steps={STEPS} current={null} signOff={keys[0]} />
        {keys.map((key) => (
          <section key={key} data-testid={`card-${key}`}>
            <SignOffToggle task={{ taskKey: key, title: 'T', signOff: false }} off={false} describedBy="help" busy={false} onChange={onChange} />
          </section>
        ))}
      </div>
    );
  }

  const row = (key = 'main') => byId(`task-signoff-box-${key}`)!;
  const marked = (key = 'main') => row(key).hasAttribute(SIGN_OFF_LANDED_ATTR);

  it('a press marks the row; two seconds later the mark goes, and the focus, the scroll and the box stay as they were', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onChange = vi.fn();
    await act(async () => root!.render(<RowAndBox onChange={onChange} />));
    const box = document.getElementById(signOffBoxId('main')) as HTMLInputElement;
    expect(marked()).toBe(false);
    await act(async () => {
      fireEvent.click(byId('tre-signoff-jump')!);
    });
    expect(marked()).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(scrolls).toHaveLength(1);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await act(async () => {
      vi.advanceTimersByTime(SIGN_OFF_LANDED_MS - 1);
    });
    expect(marked()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(marked()).toBe(false);
    expect(SIGN_OFF_LANDED_MS).toBe(2000);
    // Taking the mark off moved nothing and sent nothing.
    expect(focus).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(1);
    expect(document.activeElement).toBe(box);
    expect(box.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the next press anywhere takes it off at once, a pointer or a key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onChange = vi.fn();
    await act(async () => root!.render(<RowAndBox onChange={onChange} />));
    for (const next of [() => fireEvent.pointerDown(document.body), () => fireEvent.keyDown(document.body, { key: 'Tab' })]) {
      await act(async () => {
        fireEvent.click(byId('tre-signoff-jump')!);
      });
      expect(marked()).toBe(true);
      await act(async () => {
        next();
      });
      expect(marked()).toBe(false);
    }
    expect((document.getElementById(signOffBoxId('main')) as HTMLInputElement).checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // Nothing is left listening: a later timer has nothing to take off.
    await act(async () => {
      vi.advanceTimersByTime(SIGN_OFF_LANDED_MS);
    });
    expect(marked()).toBe(false);
  });

  it('one row is marked at a time: a second reveal moves the mark', async () => {
    const onChange = vi.fn();
    await act(async () => root!.render(<RowAndBox onChange={onChange} keys={['main', 'other']} />));
    act(() => {
      revealSignOff('main');
    });
    expect(marked('main')).toBe(true);
    act(() => {
      revealSignOff('other');
    });
    expect(marked('main')).toBe(false);
    expect(marked('other')).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(marked('other')).toBe(false);
  });

  it("the stylesheet draws the mark in the editor's own colours, with no animation", () => {
    const css = readFileSync(resolve(__dirname, '../components/staff/projects/requirements/requirements-builder.css'), 'utf8');
    const rule = css.match(/\[data-signoff-landed\]\{[^}]*\}/)?.[0] ?? '';
    expect(SIGN_OFF_LANDED_ATTR).toBe('data-signoff-landed');
    expect(rule).toContain('outline:2px solid rgb(var(--c-accent))');
    expect(rule).toContain('background:rgb(var(--c-tint))');
    expect(rule).not.toMatch(/transition|animation/);
    expect(css).not.toMatch(/data-signoff-landed[^{]*\{[^}]*(transition|animation)/);
  });
});
