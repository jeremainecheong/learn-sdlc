// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatExpansionContext, ChatSurface } from '@/components/chat/ChatSurface';

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const panel = () => q<HTMLDialogElement>('.chat-surface');
const expand = () => q<HTMLButtonElement>('[data-testid="chat-expand"]');
const click = (button: HTMLButtonElement) => act(() => button.click());

function Draft() {
  const [value, setValue] = useState('');
  return <textarea aria-label="Unsent question" value={value} onChange={event => setValue(event.currentTarget.value)} />;
}

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  // jsdom stubs only test our lifecycle and ownership. Real browser coverage
  // verifies the native top layer, keyboard trapping, and measured geometry.
  for (const method of ['show', 'showModal', 'close'] as const) {
    Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = method !== 'close'; }) });
  }
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('a conversation can expand without losing its working state', () => {
  it('informs the surrounding workspace synchronously only when explicitly expanded', () => {
    const retain = vi.fn(() => { expect(panel().showModal).not.toHaveBeenCalled(); });
    act(() => root.render(<ChatExpansionContext.Provider value={retain}><ChatSurface name="Nova" identity="Nova" details="Context"><Draft /></ChatSurface></ChatExpansionContext.Provider>));
    expect(retain).not.toHaveBeenCalled();
    click(q('[data-testid="chat-details-toggle"]'));
    expect(retain).not.toHaveBeenCalled();
    click(expand());
    expect(retain).toHaveBeenCalledOnce();
    click(expand());
    expect(retain).toHaveBeenCalledOnce();
  });
  it('keeps the composer and an arriving reply mounted across native modality changes', () => {
    const draw = (reply: string) => <ChatSurface name="Mira" identity={<strong>Mira</strong>}><div role="log">{reply}</div><Draft /></ChatSurface>;
    act(() => root.render(draw('Earlier reply')));
    const originalPanel = panel(), originalInput = q<HTMLTextAreaElement>('textarea');
    act(() => { fireEvent.change(originalInput, { target: { value: 'My unfinished question' } }); });
    click(expand());
    expect(panel()).toBe(originalPanel);
    expect(originalPanel.showModal).toHaveBeenCalledOnce();
    expect(originalPanel.getAttribute('aria-modal')).toBe('true');
    act(() => root.render(draw('A real reply arrived while expanded')));
    expect(q('textarea')).toBe(originalInput);
    expect(originalInput.value).toBe('My unfinished question');
    expect(q('[role="log"]').textContent).toContain('arrived while expanded');
    click(expand());
    expect(originalPanel.show).toHaveBeenCalledOnce();
    expect(panel().hasAttribute('aria-modal')).toBe(false);
    expect(originalInput.value).toBe('My unfinished question');
    expect(document.activeElement).toBe(expand());
  });

  it('uses Escape to restore the chat without closing its surrounding lesson', () => {
    const outerKey = vi.fn(), closeLesson = vi.fn();
    act(() => root.render(<div onKeyDown={outerKey}><ChatSurface name="Quinn" identity="Quinn" onClose={closeLesson}><Draft /></ChatSurface></div>));
    click(expand());
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    act(() => panel().dispatchEvent(key));
    expect(outerKey).not.toHaveBeenCalled();
    const cancel = new Event('cancel', { cancelable: true });
    act(() => panel().dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(panel().open).toBe(true);
    expect(panel().getAttribute('data-chat-expanded')).toBe('false');
    expect(closeLesson).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(expand());
  });

  it('does not treat a nested instructor dialog cancellation as its own', () => {
    act(() => root.render(<ChatSurface name="Atlas" identity="Atlas"><dialog data-help="true" /></ChatSurface>));
    click(expand());
    act(() => q('dialog[data-help]').dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true })));
    expect(panel().getAttribute('data-chat-expanded')).toBe('true');
    expect(panel().show).not.toHaveBeenCalled();
  });

  it('keeps explanatory chrome out of the transcript until explicitly opened', () => {
    act(() => root.render(<ChatSurface name="Arlo" identity="Arlo" details={<p>Contract and mode context</p>}><Draft /></ChatSurface>));
    const toggle = q<HTMLButtonElement>('[data-testid="chat-details-toggle"]');
    const original = q('textarea');
    expect(host.textContent).not.toContain('Contract and mode context');
    click(toggle);
    expect(q('[data-testid="chat-details"]').id).toBe(toggle.getAttribute('aria-controls'));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    click(toggle);
    expect(host.querySelector('[data-testid="chat-details"]')).toBeNull();
    expect(q('textarea')).toBe(original);
  });

  it('restores an older reading position when the expanded view temporarily fits all messages', () => {
    act(() => root.render(<ChatSurface name="Sage" identity="Sage"><div role="log"><p>First</p><p>Older reply being read</p><p>Last</p></div></ChatSurface>));
    const log = q<HTMLElement>('[role="log"]');
    let top = 150;
    const expanded = () => panel().getAttribute('data-chat-expanded') === 'true';
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => expanded() ? 600 : 200 });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => expanded() ? 300 : 1000 });
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, log.scrollHeight - log.clientHeight)); } });
    log.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    Array.from(log.children).forEach((child, index) => { child.getBoundingClientRect = () => ({ top: index * 200 - top, bottom: (index + 1) * 200 - top } as DOMRect); });
    click(expand());
    expect(log.scrollTop).toBe(0);
    click(expand());
    expect(log.scrollTop).toBe(150);
    expect(q('[role="log"]')).toBe(log);
  });
});
