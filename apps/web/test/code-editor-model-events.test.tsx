// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => {
  let value = '';
  let readOnly = false;
  const listeners = new Set<(event: { isFlush: boolean; isUndoing: boolean; isRedoing: boolean }) => void>();
  const disposable = () => ({ dispose: vi.fn() });
  const emit = (text: string, flags = { isFlush: false, isUndoing: false, isRedoing: false }) => {
    value = text;
    for (const listener of listeners) listener(flags);
  };
  const model = {
    uri: { path: '/fixture.py' }, dispose: vi.fn(), getLineCount: () => value.split('\n').length,
    getLineMaxColumn: () => 1, getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
  };
  const editor = {
    getValue: () => value, getModel: () => model, getOption: () => readOnly,
    updateOptions: vi.fn((options: { readOnly: boolean }) => { readOnly = options.readOnly; }),
    setValue: vi.fn((text: string) => emit(text, { isFlush: true, isUndoing: false, isRedoing: false })),
    executeEdits: vi.fn((_source: string, edits: { text: string }[]) => emit(edits[0].text)),
    pushUndoStop: vi.fn(), saveViewState: vi.fn(), restoreViewState: vi.fn(), dispose: vi.fn(),
    onDidChangeCursorPosition: disposable,
    // The view's scroll and layout, as Monaco reports them.
    scrollTop: 0, scrollListeners: [] as ((event: { scrollTop: number }) => void)[], layoutListeners: [] as ((layout: { height: number }) => void)[],
    getScrollTop(): number { return this.scrollTop; },
    setScrollTop: vi.fn(function (this: { scrollTop: number }, top: number) { this.scrollTop = top; }),
    onDidScrollChange(listener: (event: { scrollTop: number }) => void) { this.scrollListeners.push(listener); return disposable(); },
    onDidLayoutChange(listener: (layout: { height: number }) => void) { this.layoutListeners.push(listener); return disposable(); },
    onDidChangeModelContent: (listener: (event: { isFlush: boolean; isUndoing: boolean; isRedoing: boolean }) => void) => {
      listeners.add(listener); return { dispose: () => listeners.delete(listener) };
    },
    changeViewZones: (callback: (accessor: { removeZone: () => void }) => void) => callback({ removeZone: () => {} }),
  };
  const monaco = {
    Uri: { parse: (path: string) => ({ path }) }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      EditorOption: { readOnly: 91 }, getModel: () => null,
      createModel: vi.fn((text: string) => { value = text; return model; }),
      create: vi.fn((_container: HTMLElement, options: { readOnly: boolean }) => { readOnly = options.readOnly; return editor; }),
      setTheme: vi.fn(), setModelMarkers: vi.fn(), setModelLanguage: vi.fn(), onDidChangeMarkers: disposable,
    },
  };
  const scrollTo = (top: number) => { editor.scrollTop = top; for (const listener of editor.scrollListeners) listener({ scrollTop: top }); };
  const layout = (height: number) => { for (const listener of editor.layoutListeners) listener({ height }); };
  return { editor, monaco, emit, scrollTo, layout, reset: () => { value = ''; readOnly = false; listeners.clear(); editor.scrollTop = 0; editor.scrollListeners.length = 0; editor.layoutListeners.length = 0; editor.setScrollTop.mockClear(); } };
});

// Exercise the installed React wrapper's real controlled-value effects. Only
// Monaco's rendering service is stubbed; native browser proof covers the engine.
vi.mock('@/components/workspace/monaco-setup', () => ({ monaco: rig.monaco, EDITOR_THEMES: { paper: 'paper', graphite: 'graphite' } }));
vi.mock('@/components/shell', () => ({ InlineNote: () => null }));
vi.mock('@/lib/theme', () => ({ getTheme: () => 'paper', THEME_EVENT: 'lsdlc-theme' }));
import { CodeEditor } from '@/components/workspace/CodeEditor';

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const render = async (value: string, readOnly: boolean) => {
  await act(async () => { root.render(<CodeEditor path="fixture.py" value={value} language="python" readOnly={readOnly} onChange={onChange} />); });
};
beforeEach(() => { Object.defineProperty(window, 'monaco', { configurable: true, value: rig.monaco }); rig.reset(); onChange.mockClear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'monaco');
});

describe('CodeEditor controlled model refresh versus learner edits', () => {
  it('loads an applied active file while read-only without reporting a learner edit', async () => {
    await render('original saved code', false);
    await render('original saved code', true);
    await render('acknowledged applied code', true);
    expect(rig.editor.setValue).toHaveBeenCalledWith('acknowledged applied code');
    expect(rig.editor.getValue()).toBe('acknowledged applied code');
    expect(rig.monaco.editor.create).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('retains the wrapper suppression for a writable controlled refresh', async () => {
    await render('old saved code', false);
    await render('new saved code', false);
    expect(rig.editor.executeEdits).toHaveBeenCalled();
    expect(rig.editor.getValue()).toBe('new saved code');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still reports learner edits, undo back to the supplied value, and redo', async () => {
    await render('saved code', false);
    act(() => rig.emit('learner draft'));
    act(() => rig.emit('saved code', { isFlush: false, isUndoing: true, isRedoing: false }));
    act(() => rig.emit('learner draft', { isFlush: false, isUndoing: false, isRedoing: true }));
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['learner draft', 'saved code', 'learner draft']);
  });
});

describe('the editor inside a room that scrolls', () => {
  it('hands the wheel to the page at its own edges, so a split room can be scrolled over the editor', async () => {
    // A split phase's IDE row sits in a scroll region under the task list and
    // statement. Monaco's default consumes every wheel event, so wheeling over
    // the editor never moved the region and the bottom panel stayed out of
    // reach. At the editor's edge the event now reaches the region.
    await render('saved code', false);
    const options = rig.monaco.editor.create.mock.calls[0][1] as { scrollbar?: { alwaysConsumeMouseWheel?: boolean } };
    expect(options.scrollbar?.alwaysConsumeMouseWheel).toBe(false);
  });
});

describe('CodeEditor across a hide: a jump made while hidden is kept', () => {
  // The Code / Results switch hides the editor's host (display:none), which
  // lays Monaco out at 0 px. A reveal from the results (a problem row, the
  // Health panel, the map, a contract item) or a file opened from them moves
  // the view while it is hidden; showing the editor again must keep that move,
  // never put back where the view was before the hide.
  it('a reveal while hidden survives the editor being shown again', async () => {
    await render('line\n'.repeat(200), false);
    rig.scrollTo(640);
    rig.layout(0);
    rig.scrollTo(1500); // openAt's reveal, from the results
    rig.layout(480);
    expect(rig.editor.getScrollTop()).toBe(1500);
    expect(rig.editor.setScrollTop).not.toHaveBeenCalled();
  });

  it('a file opened while hidden opens at its own place, not the previous file\'s', async () => {
    await render('line\n'.repeat(200), false);
    rig.scrollTo(640);
    rig.layout(0);
    await act(async () => { root.render(<CodeEditor path="other.py" value={'other\n'.repeat(50)} language="python" readOnly={false} onChange={onChange} />); });
    rig.scrollTo(0); // the new file's view, at its top
    rig.layout(480);
    expect(rig.editor.getScrollTop()).toBe(0);
    expect(rig.editor.setScrollTop).not.toHaveBeenCalledWith(640);
  });
});
