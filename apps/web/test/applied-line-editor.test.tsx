// @vitest-environment jsdom
/**
 * After an Apply in a code room, the editor
 * shows the lines the Apply changed in the open file, from the first to the last, by Monaco's own range reveal
 * (`revealRangeNearTopIfOutsideViewport`, which works in pixels and so counts the inline notes between them): nothing
 * moves when the change is all in view already; a change that fits is brought in whole, with five lines above it,
 * fewer when those would push its last line out of view; a change taller than the view starts at the top. Once per
 * Apply, at the moment the applied text is in the editor, and kept in view while the applied text's notes are drawn
 * (they come a render later and grow when measured); never again for a later edit, reload, save or switch of view.
 * The caret and the focus are left alone.
 *
 * Two halves: which lines changed (`applied-reveal.ts`, pure), and the editor's one call that shows them
 * (`CodeEditor`'s `revealOnce`), over the installed React wrapper with Monaco's engine stood in for, as
 * code-editor-model-events.test.tsx does. The editor has no layout in jsdom, so the call and its arguments are
 * pinned, and where the view then lands is worked out by a copy of the rule Monaco 0.52.2 applies to that call
 * (`ViewLines._computeScrollTopToRevealRange`, NearTopIfOutsideViewport, with this editor's options: no sticky scroll,
 * no cursor surrounding lines; then the stop at the file's end), over the room's 21 px lines and 14 px paddings.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appliedReveal, changedLines } from '@/components/workspace/applied-reveal';

/** The 1-based first line where `after` differs from `before`, or null when the two are the same text. */
const firstChangedLine = (before: string, after: string): number | null => changedLines(before, after)?.first ?? null;

/** The Deadline badge helper before and after an Apply (pack v5, web/src/lib/overdue.ts). */
const OVERDUE_BEFORE = [
  "import type { Task } from './task';", '', '/**', ' * True when the task is overdue on `today`.', ' */',
  'export function isOverdue(task: Task, today: string): boolean {', '  // A task with no due date is never overdue.',
  '  if (task.dueDate === null) {', '    return false;', '  }', '  // A task is overdue when its due date is before today.',
  '  return false; // TODO(learner): replace this line with the rule above.', '}', '',
].join('\n');
const OVERDUE_AFTER = OVERDUE_BEFORE.replace('  return false; // TODO(learner): replace this line with the rule above.', '  return task.dueDate < today;');
/** Testing's starter (the Deadline badge pack, apps/api/test/fixtures/upload-packs/deadline-badge), 22 lines with its last empty one. */
const TESTS_BEFORE = [
  '/**', ' * Tests for the overdue badge. `test` and `assert` are globals the runner', " * provides; `assert` is Node's own.", ' */',
  "import { isOverdue } from './overdue';", "import type { Task } from './types';", '',
  'declare const test: (name: string, fn: () => void | Promise<void>) => void;', "declare const assert: typeof import('node:assert');", '',
  "const TODAY = '2026-11-13';", '', 'function task(dueDate: string | null): Task {', "  return { title: 'Send the report', dueDate, done: false };", '}', '',
  "test('a task due yesterday is overdue', () => {", "  assert.strictEqual(isOverdue(task('2026-11-12'), TODAY), true);", '});', '',
  '// Add your test below.', '',
].join('\n');
/** A test-file Apply ("1 removed, 3 added"): line 21's comment replaced by the second test. */
const TESTS_AFTER = TESTS_BEFORE.replace('// Add your test below.',
  "test('a task due today is not overdue', () => {\n  assert.strictEqual(isOverdue(task(TODAY), TODAY), false);\n});");

describe('the lines an Apply changed', () => {
  it('line 12 of overdue.ts alone; Te3: lines 21 to 23 of overdue.test.ts', () => {
    expect(changedLines(OVERDUE_BEFORE, OVERDUE_AFTER)).toEqual({ first: 12, last: 12 });
    expect(changedLines(TESTS_BEFORE, TESTS_AFTER)).toEqual({ first: 21, last: 23 });
    expect(firstChangedLine(OVERDUE_BEFORE, OVERDUE_AFTER)).toBe(12);
    expect(firstChangedLine(TESTS_BEFORE, TESTS_AFTER)).toBe(21);
  });
  it('lines only added at the end, only taken off it, or taken out of the middle', () => {
    expect(changedLines('a\nb', 'a\nb\nc')).toEqual({ first: 3, last: 3 });
    expect(changedLines('a\nb\nc', 'a\nb')).toEqual({ first: 2, last: 2 });
    expect(changedLines('a\nb\nc\nd', 'a\nd')).toEqual({ first: 2, last: 2 });
    expect(changedLines('a\nb\nb\nc', 'a\nb\nX\nb\nb\nc')).toEqual({ first: 3, last: 4 });
  });
  it('the same text has no changed line', () => {
    expect(changedLines(OVERDUE_AFTER, OVERDUE_AFTER)).toBeNull();
    expect(firstChangedLine(OVERDUE_AFTER, OVERDUE_AFTER)).toBeNull();
  });
  it('the open file, its applied text and the lines', () => {
    const after = [{ path: 'web/src/lib/task.ts', content: 'x' }, { path: 'web/src/lib/overdue.ts', content: OVERDUE_AFTER }];
    expect(appliedReveal({ path: 'web/src/lib/overdue.ts', text: OVERDUE_BEFORE }, after, {})).toEqual({ path: 'web/src/lib/overdue.ts', line: 12, last: 12, text: OVERDUE_AFTER });
    expect(appliedReveal({ path: 'web/src/lib/overdue.test.ts', text: TESTS_BEFORE }, [{ path: 'web/src/lib/overdue.test.ts', content: TESTS_AFTER }], {}))
      .toEqual({ path: 'web/src/lib/overdue.test.ts', line: 21, last: 23, text: TESTS_AFTER });
  });
  it('nothing when the open file did not change (no other file is opened), nothing open, or keystrokes still held', () => {
    const after = [{ path: 'web/src/lib/overdue.ts', content: OVERDUE_AFTER }, { path: 'web/src/lib/other.ts', content: 'changed' }];
    expect(appliedReveal({ path: 'web/src/lib/overdue.ts', text: OVERDUE_AFTER }, after, {})).toBeNull();
    expect(appliedReveal(null, after, {})).toBeNull();
    expect(appliedReveal({ path: 'web/src/lib/overdue.ts', text: OVERDUE_BEFORE }, after, { 'web/src/lib/overdue.ts': 'typed' })).toBeNull();
    expect(appliedReveal({ path: 'web/src/lib/gone.ts', text: 'x' }, after, {})).toBeNull();
  });
});

const rig = vi.hoisted(() => {
  let value = '';
  /**
   * The editor's view as measured in a browser at 1440 by 900: 265 px of code before the Apply, 236 px once
   * the applied notice is drawn above it (the box Monaco measures when asked); the file shown from its top. `zones`
   * are the inline notes, each drawn under its line (`after`) and `h` px high.
   */
  const view = { scrollTop: 0, height: 265, box: 236, zones: [] as { after: number; h: number }[] };
  const LINE = 21;
  const PAD = 14;
  const lineCount = () => value.split('\n').length;
  /** Monaco's top of line n: the padding, the lines above it and the notes under them. */
  const top = (line: number) => PAD + (line - 1) * LINE + view.zones.filter((z) => z.after < line).reduce((sum, z) => sum + z.h, 0);
  const contentHeight = () => PAD + lineCount() * LINE + view.zones.reduce((sum, z) => sum + z.h, 0) + PAD;
  /**
   * Monaco 0.52.2's rule for `revealRangeNearTopIfOutsideViewport` (viewLines.js, `_computeScrollTopToRevealRange`,
   * vertical type 6, no padding above or below with this editor's options), then `validateScrollPosition`'s stop at
   * the file's end (`scrollBeyondLastLine: false`).
   */
  const nearTopIfOutside = (range: { startLineNumber: number; endLineNumber: number }) => {
    const start = view.scrollTop;
    const height = view.height;
    const boxStart = top(range.startLineNumber);
    const boxEnd = top(range.endLineNumber) + LINE;
    let next: number;
    if (boxEnd - boxStart > height) next = boxStart;
    else if (start <= boxStart && boxEnd <= start + height) next = start;
    else next = Math.max(boxEnd - height, boxStart - Math.max(5 * LINE, height * 0.2));
    view.scrollTop = Math.max(0, Math.min(next, contentHeight() - height));
  };
  /** The container Monaco is given to draw in, as `getContainerDomNode` hands it back: its height is `view.box`. */
  let container: HTMLDivElement | null = null;
  const containerNode = () => {
    if (!container) {
      container = document.createElement('div');
      Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => view.box });
      const bar = document.createElement('div'); bar.className = 'scrollbar vertical';
      const code = document.createElement('div'); code.className = 'view-lines';
      container.append(bar, code);
    }
    return container;
  };
  const listeners = new Set<(event: { isFlush: boolean; isUndoing: boolean; isRedoing: boolean }) => void>();
  const sizeListeners = new Set<() => void>();
  const disposable = () => ({ dispose: vi.fn() });
  const emit = (text: string, flags = { isFlush: false, isUndoing: false, isRedoing: false }) => {
    value = text;
    for (const listener of listeners) listener(flags);
  };
  const model = {
    uri: { path: '/overdue.ts' }, dispose: vi.fn(), getLineCount: lineCount,
    getLineMaxColumn: (line: number) => (value.split('\n')[line - 1] ?? '').length + 1,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
  };
  let shownModel: typeof model | null = model;
  const editor = {
    getValue: () => value, getModel: () => shownModel, getOption: () => false,
    updateOptions: vi.fn(),
    setValue: vi.fn((text: string) => emit(text, { isFlush: true, isUndoing: false, isRedoing: false })),
    executeEdits: vi.fn((_source: string, edits: { text: string }[]) => emit(edits[0].text)),
    pushUndoStop: vi.fn(), saveViewState: vi.fn(), restoreViewState: vi.fn(), dispose: vi.fn(),
    onDidChangeCursorPosition: disposable, onDidScrollChange: disposable, onDidLayoutChange: disposable,
    getTopForLineNumber: vi.fn(top),
    getScrollTop: () => view.scrollTop, getLayoutInfo: () => ({ height: view.height, contentWidth: 600 }),
    getContainerDomNode: () => containerNode(),
    layout: vi.fn(() => { view.height = view.box; }),
    setScrollTop: vi.fn((next: number) => { view.scrollTop = next; }), setPosition: vi.fn(), focus: vi.fn(), revealLineInCenter: vi.fn(),
    revealRangeNearTopIfOutsideViewport: vi.fn(nearTopIfOutside),
    onDidContentSizeChange: (listener: () => void) => { sizeListeners.add(listener); return { dispose: () => sizeListeners.delete(listener) }; },
    onDidChangeModelContent: (listener: (event: { isFlush: boolean; isUndoing: boolean; isRedoing: boolean }) => void) => {
      listeners.add(listener); return { dispose: () => listeners.delete(listener) };
    },
    changeViewZones: (callback: (accessor: { removeZone: () => void }) => void) => callback({ removeZone: () => {} }),
  };
  /** The notes change after the reveal (added a render later, then measured): Monaco tells of the new height. */
  const notesSettle = (zones: { after: number; h: number }[]) => {
    view.zones = zones;
    for (const listener of [...sizeListeners]) listener();
  };
  /** What the person sees: the first and last lines wholly in view. */
  const shown = () => {
    let first = 1;
    while (first <= lineCount() && top(first) < view.scrollTop) first += 1;
    let last = first;
    while (last + 1 <= lineCount() && top(last + 1) + LINE <= view.scrollTop + view.height) last += 1;
    return { first, last };
  };
  const monaco = {
    Uri: { parse: (path: string) => ({ path }) }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      EditorOption: { readOnly: 91 }, getModel: () => null,
      createModel: vi.fn((text: string) => { value = text; return model; }),
      create: vi.fn(() => editor),
      setTheme: vi.fn(), setModelMarkers: vi.fn(), setModelLanguage: vi.fn(), onDidChangeMarkers: disposable,
    },
  };
  return {
    editor, monaco, view, top, shown, notesSettle, containerNode, sizeListeners,
    otherModel: () => { shownModel = { ...model }; },
    reset: () => {
      value = ''; listeners.clear(); sizeListeners.clear(); container = null; shownModel = model;
      Object.assign(view, { scrollTop: 0, height: 265, box: 236, zones: [] });
    },
  };
});
vi.mock('@/components/workspace/monaco-setup', () => ({ monaco: rig.monaco, EDITOR_THEMES: { paper: 'paper', graphite: 'graphite' } }));
vi.mock('@/components/shell', () => ({ InlineNote: () => null }));
vi.mock('@/lib/theme', () => ({ getTheme: () => 'paper', THEME_EVENT: 'lsdlc-theme' }));
import { CodeEditor } from '@/components/workspace/CodeEditor';

let host: HTMLDivElement;
let root: Root;
const onRevealed = vi.fn();
type Reveal = { line: number; last?: number; text: string; nonce: number; since?: number } | null;
const render = async (value: string, revealOnce: Reveal = null, path = 'web/src/lib/overdue.ts') => {
  await act(async () => {
    root.render(<CodeEditor path={path} value={value} language="typescript" readOnly={false} onChange={vi.fn()} revealOnce={revealOnce} onRevealed={onRevealed} />);
  });
};
beforeEach(() => {
  Object.defineProperty(window, 'monaco', { configurable: true, value: rig.monaco });
  rig.reset(); vi.clearAllMocks();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'monaco'); });

const range = (first: number, last: number, endColumn: number) => ({ startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn });
const TESTS = 'web/src/lib/overdue.test.ts';
/** The test file at 1440 by 900: about 394 px of editor under the applied notice; the two "Not linked" notes about 64 px each. */
const te3View = (zones: { after: number; h: number }[]) => Object.assign(rig.view, { height: 394, box: 394, zones });
/** A file of `n` numbered lines, and the same with lines `from` to `to` rewritten. */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const rewritten = (n: number, from: number, to: number) =>
  Array.from({ length: n }, (_, i) => (i + 1 >= from && i + 1 <= to ? `changed ${i + 1}` : `line ${i + 1}`)).join('\n');

describe('the editor shows an applied change once', () => {
  it('one line out of view: Monaco\'s range reveal on line 12, immediate; the code then runs to the file\'s end (lines 5 to 14 whole, as the confirm look saw); caret and focus untouched', async () => {
    await render(OVERDUE_BEFORE);
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 1 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledTimes(1);
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledWith(range(12, 12, 31), 1);
    expect(rig.view.scrollTop).toBe(322 - 236);
    expect(rig.shown()).toEqual({ first: 5, last: 14 });
    expect(onRevealed).toHaveBeenCalledTimes(1);
    expect(rig.editor.setScrollTop).not.toHaveBeenCalled();
    expect(rig.editor.setPosition).not.toHaveBeenCalled();
    expect(rig.editor.focus).not.toHaveBeenCalled();
  });

  it('one line already in view: the reveal moves nothing, and the line is dropped as shown', async () => {
    await render(OVERDUE_BEFORE);
    await render(OVERDUE_AFTER, { line: 9, last: 9, text: OVERDUE_AFTER, nonce: 6 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledWith(range(9, 9, 18), 1);
    expect(rig.view.scrollTop).toBe(0);
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it('the change (lines 21 to 23) fits: all of it in view with the two notes counted, the first test whole above it', async () => {
    te3View([{ after: 17, h: 64 }, { after: 21, h: 64 }]);
    await render(TESTS_BEFORE, null, TESTS);
    await render(TESTS_AFTER, { line: 21, last: 23, text: TESTS_AFTER, nonce: 12 }, TESTS);
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledWith(range(21, 23, 4), 1);
    expect(rig.view.scrollTop).toBe(266);
    // 13 to 24: "function task(" down to the end, so both tests, each with its note, are whole.
    expect(rig.shown()).toEqual({ first: 13, last: 24 });
  });

  it('a change that fits, in the middle of a long file: brought in whole, five lines above it, fewer when those would push its last line out of view', async () => {
    rig.view.box = 394;
    await render(numbered(80));
    await render(rewritten(80, 30, 32), { line: 30, last: 32, text: rewritten(80, 30, 32), nonce: 13 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenLastCalledWith(range(30, 32, 11), 1);
    expect(rig.view.scrollTop).toBe(rig.top(30) - 105);
    expect(rig.shown().first).toBe(25);
    await render(numbered(80));
    rig.view.scrollTop = 0;
    await render(rewritten(80, 30, 45), { line: 30, last: 45, text: rewritten(80, 30, 45), nonce: 14 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenLastCalledWith(range(30, 45, 11), 1);
    // The five lines would push line 45 under the foot: its foot is the view's foot instead.
    expect(rig.view.scrollTop).toBe(rig.top(45) + 21 - 394);
    expect(rig.shown().last).toBe(45);
    expect(rig.shown().first).toBeLessThanOrEqual(30);
  });

  it('a change taller than the view: its first line at the top of the view', async () => {
    rig.view.box = 394;
    await render(numbered(80));
    await render(rewritten(80, 10, 40), { line: 10, last: 40, text: rewritten(80, 10, 40), nonce: 15 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledWith(range(10, 40, 11), 1);
    expect(rig.view.scrollTop).toBe(rig.top(10));
    expect(rig.shown().first).toBe(10);
  });

  it('the applied text\'s notes come a render later and grow when measured: the same reveal is asked again and the change stays whole in view', async () => {
    // At the reveal only the first test's note is drawn, at its 46 px guess (as a browser shows it).
    te3View([{ after: 17, h: 46 }]);
    await render(TESTS_BEFORE, null, TESTS);
    await render(TESTS_AFTER, { line: 21, last: 23, text: TESTS_AFTER, nonce: 16 }, TESTS);
    rig.notesSettle([{ after: 17, h: 46 }, { after: 21, h: 46 }]);
    rig.notesSettle([{ after: 17, h: 64 }, { after: 21, h: 64 }]);
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledTimes(3);
    expect(rig.shown()).toEqual({ first: 13, last: 24 });
    // Once the change is whole in view, a later settle moves nothing.
    rig.notesSettle([{ after: 17, h: 64 }, { after: 21, h: 66 }]);
    expect(rig.view.scrollTop).toBe(266);
    expect(rig.shown().last).toBe(24);
  });

  it('after the reveal, a scroll of the person\'s, a keystroke, another file, or the settling time gone: a new height moves nothing', async () => {
    const now = vi.spyOn(Date, 'now');
    // Each case at its own time, after the last one's wheel, so only its own step can end the settling.
    const apply = async (nonce: number, at: number) => {
      rig.reset(); te3View([{ after: 17, h: 64 }]);
      now.mockReturnValue(at);
      await render(TESTS_BEFORE, null, TESTS);
      await render(TESTS_AFTER, { line: 21, last: 23, text: TESTS_AFTER, nonce }, TESTS);
      return rig.view.scrollTop;
    };
    const settled = async () => {
      vi.mocked(rig.editor.revealRangeNearTopIfOutsideViewport).mockClear();
      rig.notesSettle([{ after: 17, h: 64 }, { after: 21, h: 64 }]);
      expect(rig.editor.revealRangeNearTopIfOutsideViewport).not.toHaveBeenCalled();
    };
    await apply(20, 10_000);
    now.mockReturnValue(10_200);
    rig.containerNode().querySelector('.view-lines')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    await settled();
    await apply(21, 20_000);
    await render(`${TESTS_AFTER}x`, null, TESTS);
    await settled();
    await apply(22, 30_000);
    rig.otherModel();
    await settled();
    await apply(23, 40_000);
    now.mockReturnValue(41_001);
    await settled();
    expect(rig.sizeListeners.size).toBe(0);
    now.mockRestore();
  });

  it('the change asked for before its text is in the editor waits for it, then shows it once', async () => {
    await render(OVERDUE_BEFORE, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 2 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).not.toHaveBeenCalled();
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 2 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledTimes(1);
  });

  it('a change near the top, out of view (the code scrolled down): the code from its first line', async () => {
    rig.view.scrollTop = 300;
    await render('a\nb\nc');
    await render('a\nB\nc', { line: 2, text: 'a\nB\nc', nonce: 3 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledWith(range(2, 2, 2), 1);
    expect(rig.view.scrollTop).toBe(0);
  });

  it('the editor is measured first, so a line the applied notice pushes under the editor\'s foot is still brought in', async () => {
    // Line 11 (y 224 to 245) is in the 265 px the editor had before the notice, and out of the 236 px it has after it.
    await render(OVERDUE_BEFORE);
    await render(OVERDUE_AFTER, { line: 11, last: 11, text: OVERDUE_AFTER, nonce: 5 });
    expect(rig.editor.layout).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rig.editor.layout).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(rig.editor.revealRangeNearTopIfOutsideViewport).mock.invocationCallOrder[0]);
    expect(rig.view.scrollTop).toBe(322 - 236);
  });

  it('an editor hidden behind another view is not measured; Monaco places the change\'s first line at the top of a view with no height', async () => {
    Object.assign(rig.view, { height: 0, box: 0 });
    await render(OVERDUE_BEFORE);
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 7 });
    expect(rig.editor.layout).not.toHaveBeenCalled();
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledWith(range(12, 12, 31), 1);
    expect(rig.view.scrollTop).toBe(rig.top(12));
  });

  it('never again for the same Apply: a later edit, or the same text handed back, moves nothing', async () => {
    await render(OVERDUE_BEFORE);
    const reveal = { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 4 };
    await render(OVERDUE_AFTER, reveal);
    await render(`${OVERDUE_AFTER}// typed`, reveal);
    await render(OVERDUE_AFTER, reveal);
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledTimes(1);
  });

  it('with no Apply to show (a reload, a save, a switch of file), a new text moves nothing', async () => {
    await render(OVERDUE_BEFORE);
    await render(OVERDUE_AFTER);
    await render(TESTS_AFTER, null, TESTS);
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).not.toHaveBeenCalled();
    expect(rig.editor.setScrollTop).not.toHaveBeenCalled();
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it('the person wheels the code after pressing Apply, before the applied text arrives: the editor stays where they put it', async () => {
    const now = vi.spyOn(Date, 'now');
    await render(OVERDUE_BEFORE);
    now.mockReturnValue(5_000);
    rig.containerNode().querySelector('.view-lines')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 8, since: 4_000 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).not.toHaveBeenCalled();
    expect(onRevealed).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('so does a drag on the scroll bar, or a paging key, after the press', async () => {
    const now = vi.spyOn(Date, 'now');
    await render(OVERDUE_BEFORE);
    now.mockReturnValue(5_000);
    rig.containerNode().querySelector('.scrollbar')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 9, since: 4_000 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).not.toHaveBeenCalled();
    await render(OVERDUE_BEFORE);
    now.mockReturnValue(7_000);
    rig.containerNode().querySelector('.view-lines')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 10, since: 6_000 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('a wheel before the press, or a click in the code after it (not a scroll), leaves the reveal as it was', async () => {
    const now = vi.spyOn(Date, 'now');
    await render(OVERDUE_BEFORE);
    now.mockReturnValue(3_000);
    rig.containerNode().querySelector('.view-lines')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    now.mockReturnValue(5_000);
    rig.containerNode().querySelector('.view-lines')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await render(OVERDUE_AFTER, { line: 12, last: 12, text: OVERDUE_AFTER, nonce: 11, since: 4_000 });
    expect(rig.editor.revealRangeNearTopIfOutsideViewport).toHaveBeenCalledTimes(1);
    expect(rig.view.scrollTop).toBe(322 - 236);
    now.mockRestore();
  });
});
