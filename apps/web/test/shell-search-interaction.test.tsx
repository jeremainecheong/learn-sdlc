// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Palette } from '@/components/shell/Palette';
import type { PaletteGroup } from '@/components/shell/types';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/useProject', () => ({ useProjectMaybe: () => null }));
vi.mock('@/lib/project-map', () => ({ ensureFullMap: vi.fn() }));
let host: HTMLDivElement, root: Root;
const q = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const click = (node: Element) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const key = (name: string) => act(() => q('input').dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const scroll = vi.fn();
const groups: PaletteGroup[] = [{ label: 'Pages', items: [
  { label: 'Feedback', href: '/feedback' },
  { label: 'Locked Design', disabled: true, href: '/must-not-open', onSelect: push },
  ...Array.from({ length: 8 }, (_, i) => ({ label: `File ${i}`, href: `/file/${i}` })),
] }];
const draw = () => act(() => root.render(<Palette groups={groups} trigger={<button data-opener><svg><path /></svg></button>} />));
const open = () => { const button = q<HTMLButtonElement>('[data-opener]'); button.focus(); click(q('path')); };

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  // Native focus/top-layer geometry is verified in Playwright. These shims
  // exercise our lifecycle, command ownership and event handling only.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('search is a complete keyboard and pointer interaction', () => {
  it('keeps keyboard selection in view and never runs a locked action', () => {
    draw(); open();
    key('ArrowDown');
    expect(q('[aria-selected="true"]').textContent).toContain('Locked Design');
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    key('Enter');
    expect(push).not.toHaveBeenCalled();
    expect(q<HTMLDialogElement>('dialog').open).toBe(true);
    for (let i = 0; i < 8; i++) key('ArrowDown');
    expect(q('[aria-selected="true"]').textContent).toContain('File 7');
    key('Enter');
    expect(push).toHaveBeenCalledWith('/file/7');
    expect(host.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(q('[data-opener]'));
  });

  it('restores the button rather than its SVG, and close remains a normal button', () => {
    draw(); open();
    const close = q<HTMLButtonElement>('[aria-label="Close search"]');
    close.focus();
    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(push).not.toHaveBeenCalled();
    click(close);
    expect(document.activeElement).toBe(q('[data-opener]'));
  });

  it('can recover from an empty result without a negative active selection', () => {
    draw(); open();
    act(() => { fireEvent.change(q<HTMLInputElement>('input'), { target: { value: 'no matching text' } }); });
    key('ArrowDown'); key('Enter');
    expect(push).not.toHaveBeenCalled();
    expect(q('input').hasAttribute('aria-activedescendant')).toBe(false);
    act(() => { fireEvent.change(q<HTMLInputElement>('input'), { target: { value: 'Feedback' } }); });
    key('Enter');
    expect(push).toHaveBeenCalledWith('/feedback');
  });

  it('does not open search over a different modal or consume its shortcut', () => {
    draw();
    const modal = document.createElement('dialog'); modal.open = true; document.body.append(modal);
    try {
      const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      act(() => window.dispatchEvent(event));
      expect(host.querySelector('dialog')).toBeNull();
      expect(event.defaultPrevented).toBe(false);
    } finally { modal.remove(); }
  });
});
