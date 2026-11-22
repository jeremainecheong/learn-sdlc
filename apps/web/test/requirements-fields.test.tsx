// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clause, GrowRow } from '@/components/workspace/panels/requirements/Fields';
import { AutoText } from '@/components/workspace/panels/design/cells';
let host: HTMLDivElement, sheet: HTMLStyleElement, root: Root, width: number, contentHeight: number;
let notify: ResizeObserverCallback;
const disconnect = vi.fn();
const onChange = vi.fn();
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function flushFrame() {
  const work = [...frames.values()]; frames.clear();
  act(() => work.forEach(callback => callback(0)));
}
function resize(nextWidth: number, flush = true) {
  width = nextWidth;
  act(() => notify([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
  if (flush) flushFrame();
}
function render(value = 'an unfinished task due yesterday', exclusion = false) {
  act(() => root.render(exclusion
    ? <GrowRow id="scope" testId="scope" value={value} onChange={onChange}/>
    : <Clause id="given" testId="given" word="Given" value={value} placeholder="Describe the starting state" onChange={onChange}/>));
  return host.querySelector('textarea')!;
}
beforeEach(() => {
  width = 0; contentHeight = 0; disconnect.mockReset(); onChange.mockReset();
  frames.clear(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { notify = callback; } observe() {} disconnect = disconnect; });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  // Tailwind's reset is not loaded in jsdom; make this geometry fixture explicit.
  sheet = document.createElement('style'); sheet.textContent = 'textarea { padding: 0; border: 0; box-sizing: content-box; }'; document.head.append(sheet);
});

describe.each(['Design cell', 'Requirements criterion', 'Requirements exclusion'])('%s resize delivery', kind => {
  function field() {
    if (kind === 'Design cell') {
      act(() => root.render(<AutoText value="An existing saved sentence" onChange={onChange} />));
      return host.querySelector('textarea')!;
    }
    return render('An existing saved sentence', kind === 'Requirements exclusion');
  }
  it('measures revealed text outside the observer delivery and coalesces changing widths', () => {
    const textarea = field();
    contentHeight = 57; resize(380, false);
    expect(textarea.style.height).toBe('');
    contentHeight = 76; resize(180, false);
    expect(textarea.style.height).toBe(''); expect(frames.size).toBe(1);
    flushFrame();
    expect(textarea.style.height).toBe('76px'); expect(textarea.value).toBe('An existing saved sentence');
    contentHeight = 100; resize(180, false);
    expect(frames.size).toBe(0); expect(textarea.style.height).toBe('76px');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('keeps the last visible height if hidden before the scheduled fit and cancels work on removal', () => {
    const textarea = field(); contentHeight = 40; resize(220);
    expect(textarea.style.height).toBe('40px');
    contentHeight = 80; resize(120, false);
    contentHeight = 0; resize(0, false); flushFrame();
    expect(textarea.style.height).toBe('40px');
    contentHeight = 80; resize(120, false); expect(frames.size).toBe(1);
    act(() => root.render(null)); expect(frames.size).toBe(0); expect(disconnect).toHaveBeenCalledOnce();
    flushFrame(); expect(textarea.style.height).toBe('40px');
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); sheet.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Requirements sentences retained inside closed dialogs', () => {
  it('keeps native row sizing while hidden, then measures saved text when the dialog opens', () => {
    const field = render(); expect(field.style.height).toBe('');
    contentHeight = 57; resize(380);
    expect(field.style.height).toBe('57px'); expect(field.value).toContain('due yesterday');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('preserves the same input, selected text and last height across close/reopen, then adapts to narrower width', () => {
    const field = render(); contentHeight = 38; resize(380);
    field.focus(); field.setSelectionRange(4, 14);
    contentHeight = 0; resize(0); expect(field.style.height).toBe('38px');
    contentHeight = 76; resize(180);
    expect(host.querySelector('textarea')).toBe(field); expect(field.style.height).toBe('76px');
    expect(field.selectionStart).toBe(4); expect(field.selectionEnd).toBe(14);
    expect(document.activeElement).toBe(field); expect(onChange).not.toHaveBeenCalled();
  });
  it('ignores observer height-only deliveries and refits actual received value changes', () => {
    const field = render(); contentHeight = 38; resize(380);
    contentHeight = 200; resize(380); expect(field.style.height).toBe('38px');
    render('Longer criterion received from the saved record'); expect(field.style.height).toBe('200px');
  });
  it('recovers a saved exclusion and disconnects its observer when removed', () => {
    const field = render('Calendar integration is outside this release', true);
    contentHeight = 40; resize(220); expect(field.style.height).toBe('40px');
    act(() => root.render(null)); expect(disconnect).toHaveBeenCalledOnce();
  });
});
