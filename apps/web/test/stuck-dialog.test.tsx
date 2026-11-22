// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StuckFlag as Flag } from '@learnsdlc/shared';
import { StuckFlag } from '@/components/workspace/mentor/StuckFlag';

const calls = vi.hoisted(() => ({ stuck: vi.fn(), raiseStuck: vi.fn(), clearStuck: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: calls }));
let root: Root;
let host: HTMLDivElement;
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const dialog = () => q<HTMLDialogElement>('stuck-dialog');
const input = () => q<HTMLTextAreaElement>('stuck-question');
const click = async (id: string) => { await act(async () => q<HTMLButtonElement>(id).click()); };
const type = (id: string, value: string) => { act(() => { const node = q<HTMLTextAreaElement>(id); fireEvent.change(node, { target: { value: value } }); }); };
const render = async (phaseStateId?: string) => { await act(async () => root.render(<StuckFlag phaseStateId={phaseStateId} />)); };
const pending: Flag = { raisedAt: '2026-09-11T00:00:00Z', question: 'Which observation distinguishes these cases?', tried: 'I compared the two responses.', answeredAt: null, answeredBy: null, answeredByName: null, answer: null, clearedAt: null };
const answered: Flag = { ...pending, answeredAt: '2026-09-11T00:01:00Z', answeredBy: 'teacher', answeredByName: 'Fixture instructor', answer: 'Compare the stored state with the returned value. '.repeat(18) };
beforeEach(() => {
  vi.clearAllMocks();
  calls.stuck.mockResolvedValue(null);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  // jsdom has no native modal implementation. These stubs cover lifecycle;
  // actual top-layer geometry and focus trapping require the browser audit.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { const wasOpen = this.open; this.open = false; if (wasOpen) this.dispatchEvent(new Event('close')); }) });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('bounded instructor help dialog', () => {
  it('retains both unsent fields and their DOM nodes across close/reopen, returning focus', async () => {
    await render('phase-a');
    expect(dialog().open).toBe(false);
    await click('stuck-open');
    const original = input();
    expect(dialog().open).toBe(true);
    expect(document.activeElement).toBe(original);
    type('stuck-question', pending.question); type('stuck-tried', pending.tried);
    await click('stuck-cancel');
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(q('stuck-open'));
    await click('stuck-open');
    expect(input()).toBe(original);
    expect(input().value).toBe(pending.question);
    expect(q<HTMLTextAreaElement>('stuck-tried').value).toBe(pending.tried);
    expect(calls.raiseStuck).not.toHaveBeenCalled();
    expect(calls.clearStuck).not.toHaveBeenCalled();
  });
  it('Escape closes only the help dialog and preserves the question', async () => {
    await render('phase-a'); await click('stuck-open'); type('stuck-question', pending.question);
    const cancel = new Event('cancel', { cancelable: true });
    act(() => dialog().dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(q('stuck-open'));
    await click('stuck-open'); expect(input().value).toBe(pending.question);
  });
  it('cycles Tab and Shift+Tab between the visible help controls', async () => {
    await render('phase-a'); await click('stuck-open');
    const first = dialog().querySelector<HTMLButtonElement>('header button')!;
    const last = q<HTMLButtonElement>('stuck-cancel');
    for (const element of dialog().querySelectorAll<HTMLElement>('button, textarea')) {
      vi.spyOn(element, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 40, 40)] as unknown as DOMRectList);
    }
    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => last.dispatchEvent(forward));
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => first.dispatchEvent(back));
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });
  it('keeps failed request text in the dialog and retries the same real API arguments', async () => {
    calls.raiseStuck.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(pending);
    await render('phase-a'); await click('stuck-open');
    type('stuck-question', pending.question); type('stuck-tried', pending.tried);
    await click('stuck-send');
    expect(dialog().open).toBe(true);
    expect(input().value).toBe(pending.question);
    expect(q('stuck-error').closest('dialog')).toBe(dialog());
    await click('stuck-send');
    expect(calls.raiseStuck.mock.calls).toEqual([['phase-a', pending.question, pending.tried], ['phase-a', pending.question, pending.tried]]);
    expect(q('stuck-raised').closest('dialog')).toBe(dialog());
    expect(q('stuck-open').textContent).toBe('View help request');
  });
  it('keeps the full instructor reply inside the bounded dialog, with explicit acknowledgment', async () => {
    calls.stuck.mockResolvedValue(answered); calls.clearStuck.mockResolvedValue({ ...answered, clearedAt: '2026-09-11T00:02:00Z' });
    await render('phase-a');
    expect(q('stuck-open').textContent).toBe('Read instructor reply');
    expect(dialog().open).toBe(false);
    expect(q('stuck-answer').closest('dialog')).toBe(dialog());
    expect(q('stuck-answer').textContent).toContain(answered.answer);
    expect(q('stuck-flag').children).toHaveLength(2);
    await click('stuck-open'); await click('stuck-clear');
    expect(calls.clearStuck).toHaveBeenCalledExactlyOnceWith('phase-a');
    expect(dialog().open).toBe(false);
    expect(q('stuck-open').textContent).toBe("I'm stuck");
    expect(document.activeElement).toBe(q('stuck-open'));
  });
  it('does not show an earlier phase poll reply after changing phases', async () => {
    let resolve!: (value: Flag | null) => void;
    calls.stuck.mockImplementationOnce(() => new Promise<Flag | null>(yes => { resolve = yes; })).mockResolvedValueOnce(null);
    await render('phase-a'); await render('phase-b');
    await act(async () => resolve(answered));
    expect(q('stuck-open').textContent).toBe("I'm stuck");
    expect(host.textContent).not.toContain(answered.answer);
  });
  it('discards another phase draft and ignores its late submitted request result', async () => {
    let resolve!: (value: Flag) => void;
    calls.raiseStuck.mockImplementationOnce(() => new Promise<Flag>(yes => { resolve = yes; }));
    await render('phase-a'); await click('stuck-open'); type('stuck-question', pending.question);
    act(() => q<HTMLButtonElement>('stuck-send').click());
    await render('phase-b');
    expect(dialog().open).toBe(false);
    expect(input().value).toBe('');
    await act(async () => resolve(pending));
    expect(q('stuck-open').textContent).toBe("I'm stuck");
    expect(q('stuck-raised')).toBeNull();
  });
  it('has no help dialog or request without a real owned phase', async () => {
    await render();
    expect(host.children).toHaveLength(0);
    expect(calls.stuck).not.toHaveBeenCalled();
  });
});
