// @vitest-environment jsdom
/**
 * The Implementation code room.
 *
 * The room opens on `def complete_task` (line 158) and the status bar reads
 * "Ln 158, Col 1"; another file's tab swaps Monaco's model, and a model with
 * no remembered view state moves the caret without a cursor event, so the
 * status bar and the breadcrumb could keep 158 over line 1 of the next file.
 * The editor reports the caret of the model it switches to.
 * The Ledger and the Problems list open at Health's 300 px in Implementation,
 * not 160 px (two ledger rows at 1440 x 900). The terminal and the console
 * keep 160, and the other rooms keep their own heights.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roomResultsHeight } from '@/components/workspace/useResultsSplit';

const rig = vi.hoisted(() => {
  const disposable = () => ({ dispose: vi.fn() });
  const model = {
    uri: { path: '/fixture.py' }, dispose: vi.fn(), getLineCount: () => 200,
    getLineMaxColumn: () => 1, getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
  };
  const modelListeners: (() => void)[] = [];
  const editor = {
    position: { lineNumber: 1, column: 1 } as { lineNumber: number; column: number } | null,
    getValue: () => '', getModel: () => model, getOption: () => false, updateOptions: vi.fn(), setValue: vi.fn(),
    executeEdits: vi.fn(), pushUndoStop: vi.fn(), saveViewState: vi.fn(), restoreViewState: vi.fn(), dispose: vi.fn(),
    onDidChangeCursorPosition: disposable, onDidScrollChange: disposable, onDidLayoutChange: disposable,
    onDidChangeModelContent: disposable, changeViewZones: () => {},
    getPosition(): { lineNumber: number; column: number } | null { return this.position; },
    onDidChangeModel: vi.fn((listener: () => void) => { modelListeners.push(listener); return disposable(); }),
  };
  const monaco = {
    Uri: { parse: (path: string) => ({ path }) }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      EditorOption: { readOnly: 91 }, getModel: () => null, createModel: vi.fn(() => model),
      create: vi.fn(() => editor),
      setTheme: vi.fn(), setModelMarkers: vi.fn(), setModelLanguage: vi.fn(), onDidChangeMarkers: disposable,
    },
  };
  /** What Monaco does when a tab hands it another file: the model changes, the caret is wherever that model's is. */
  const swapModel = (at: { lineNumber: number; column: number } | null) => {
    editor.position = at;
    for (const listener of modelListeners) listener();
  };
  return { editor, monaco, swapModel, reset: () => { modelListeners.length = 0; editor.position = { lineNumber: 1, column: 1 }; } };
});

vi.mock('@/components/workspace/monaco-setup', () => ({ monaco: rig.monaco, EDITOR_THEMES: { paper: 'paper', graphite: 'graphite' } }));
vi.mock('@/components/shell', () => ({ InlineNote: () => null }));
vi.mock('@/lib/theme', () => ({ getTheme: () => 'paper', THEME_EVENT: 'lsdlc-theme' }));
import { CodeEditor } from '@/components/workspace/CodeEditor';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { Object.defineProperty(window, 'monaco', { configurable: true, value: rig.monaco }); rig.reset(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'monaco'); });

describe('the caret reported is the file on screen\'s', () => {
  it('another file\'s model reports its own caret, not the last file\'s line 158', async () => {
    const onCursor = vi.fn();
    await act(async () => { root.render(<CodeEditor path="api/routes/tasks.py" value={'x\n'.repeat(200)} language="python" readOnly={false} onChange={() => {}} onCursor={onCursor} />); });
    expect(rig.editor.onDidChangeModel).toHaveBeenCalledTimes(1);
    onCursor.mockClear();
    // the room's reveal put the caret on 158 of routes/tasks.py; the learner opens repository/tasks.py
    act(() => rig.swapModel({ lineNumber: 1, column: 1 }));
    expect(onCursor).toHaveBeenLastCalledWith(1, 1);
    // a file the learner left on line 12, column 5 reports that
    act(() => rig.swapModel({ lineNumber: 12, column: 5 }));
    expect(onCursor).toHaveBeenLastCalledWith(12, 5);
    // no position at all (no model yet) reads as the top of the file
    act(() => rig.swapModel(null));
    expect(onCursor).toHaveBeenLastCalledWith(1, 1);
  });
});

describe('the results under the code in Implementation', () => {
  it('the Ledger and the Problems list open 300 px tall, as Health does', () => {
    for (const bottom of ['ledger', 'problems', 'health']) {
      expect(roomResultsHeight({ implementation: true, bottom, hasRun: true, avail: 540 })).toBe(300);
      expect(roomResultsHeight({ implementation: true, bottom, hasRun: false, avail: 540 })).toBe(300);
    }
  });

  it('every other bottom panel, and the other code rooms, keep their own heights', () => {
    for (const bottom of ['terminal', 'console', 'commit']) expect(roomResultsHeight({ implementation: true, bottom, hasRun: true, avail: 540 })).toBe(160);
    for (const bottom of ['tests', 'feedback']) expect(roomResultsHeight({ implementation: true, bottom, hasRun: true, avail: 540 })).toBe(320);
    // the other code rooms keep their own rule
    expect(roomResultsHeight({ implementation: false, bottom: 'ledger', hasRun: true, avail: 600 })).toBe(180);
    expect(roomResultsHeight({ implementation: false, bottom: 'problems', hasRun: false, avail: 400 })).toBe(160);
  });
});
