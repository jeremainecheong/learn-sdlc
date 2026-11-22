// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webSource } from './support/source-text';

/**
 * Phone-width accessibility rules, measured by the clip probe that does not
 * count a control's own borders (e2e/a11y-reflow.ts). Asserted where each fix
 * is written; the browser proof is e2e/a11y-axe.spec.ts.
 *
 * - Monaco's touch keyboard control (`textarea.iPadShowKeyboard`, drawn only
 *   on a touch screen) needs a name (axe `label`, critical, in every code
 *   room).
 * - /teacher's class select must not sit in a Section header's unshrinkable
 *   right slot (it is clipped at 390), and /teacher/settings' export button
 *   must wrap the class name in its label.
 * - The change page with the column pressed at 360: the phase title and the
 *   guide link must not be nowrap rows that cannot shrink.
 * - The view switcher holds a status word beside its controls, so on a phone
 *   it wraps instead of scrolling sideways.
 */

const rig = vi.hoisted(() => {
  const disposable = () => ({ dispose: () => {} });
  const dom = { current: null as HTMLElement | null };
  const disposed: (() => void)[] = [];
  const model = {
    uri: { path: '/fixture.py' }, dispose: () => {}, getLineCount: () => 1, getLineMaxColumn: () => 1,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
  };
  const editor = {
    getValue: () => '', getModel: () => model, getOption: () => false, updateOptions: () => {}, setValue: () => {},
    executeEdits: () => {}, pushUndoStop: () => {}, saveViewState: () => null, restoreViewState: () => {}, dispose: () => {},
    onDidChangeCursorPosition: disposable, onDidScrollChange: disposable, onDidLayoutChange: disposable,
    onDidChangeModelContent: disposable, changeViewZones: () => {},
    getDomNode: () => dom.current,
    onDidDispose: (listener: () => void) => { disposed.push(listener); return { dispose: () => {} }; },
  };
  const monaco = {
    Uri: { parse: (path: string) => ({ path }) }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: {
      EditorOption: { readOnly: 91 }, getModel: () => null, createModel: () => model,
      create: (container: HTMLElement) => {
        // What Monaco draws on an iPad-like touch screen: the corner control.
        const node = document.createElement('div');
        node.className = 'monaco-editor';
        node.innerHTML = '<div class="overlayWidgets"><textarea class="iPadShowKeyboard"></textarea></div>';
        container.appendChild(node);
        dom.current = node;
        return editor;
      },
      setTheme: () => {}, setModelMarkers: () => {}, setModelLanguage: () => {}, onDidChangeMarkers: disposable,
    },
  };
  return { monaco, dom, disposed };
});

vi.mock('@/components/workspace/monaco-setup', () => ({ monaco: rig.monaco, EDITOR_THEMES: { paper: 'paper', graphite: 'graphite' } }));
vi.mock('@/components/shell', () => ({ InlineNote: () => null }));
vi.mock('@/lib/theme', () => ({ getTheme: () => 'paper', THEME_EVENT: 'lsdlc-theme' }));
import { CodeEditor } from '@/components/workspace/CodeEditor';
import { nameTouchKeyboard, TOUCH_KEYBOARD_LABEL } from '@/components/workspace/monaco-touch';
import { Section } from '@/components/ui';

const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
/** The declarations of `selector` inside the first `@media (max-width: <px>px)` block that has it. */
function mediaRule(css: string, px: number, selector: string): string {
  const text = flat(css);
  const re = new RegExp(`@media ?\\(max-width: ?${px}px\\) ?\\{`, 'g');
  for (const m of text.matchAll(re)) {
    let depth = 0;
    let end = m.index! + m[0].length;
    for (let i = end - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}' && --depth === 0) { end = i; break; }
    }
    const block = text.slice(m.index! + m[0].length, end);
    const at = block.indexOf(`${selector} {`) >= 0 ? block.indexOf(`${selector} {`) : block.indexOf(`${selector}{`);
    if (at >= 0) return block.slice(at, block.indexOf('}', at));
  }
  return '';
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Monaco's touch keyboard control has a name", () => {
  it('names the control that is there, and one Monaco adds later', async () => {
    const editorNode = document.createElement('div');
    editorNode.innerHTML = '<textarea class="iPadShowKeyboard"></textarea>';
    const stop = nameTouchKeyboard(editorNode);
    expect(editorNode.querySelector('textarea')!.getAttribute('aria-label')).toBe(TOUCH_KEYBOARD_LABEL);
    const later = document.createElement('textarea');
    later.className = 'iPadShowKeyboard';
    editorNode.appendChild(later);
    await new Promise((r) => setTimeout(r, 0));
    expect(later.getAttribute('aria-label')).toBe(TOUCH_KEYBOARD_LABEL);
    stop();
    const afterStop = document.createElement('textarea');
    afterStop.className = 'iPadShowKeyboard';
    editorNode.appendChild(afterStop);
    await new Promise((r) => setTimeout(r, 0));
    expect(afterStop.hasAttribute('aria-label')).toBe(false);
  });

  it("leaves a name somebody else gave it, and touches no other text area", () => {
    const editorNode = document.createElement('div');
    editorNode.innerHTML = '<textarea class="iPadShowKeyboard" aria-label="Kept"></textarea><textarea class="inputarea"></textarea>';
    nameTouchKeyboard(editorNode)();
    expect(editorNode.querySelector('.iPadShowKeyboard')!.getAttribute('aria-label')).toBe('Kept');
    expect(editorNode.querySelector('.inputarea')!.hasAttribute('aria-label')).toBe(false);
  });

  it('the code editor names it as it mounts, and stops watching when the editor goes', async () => {
    Object.defineProperty(window, 'monaco', { configurable: true, value: rig.monaco });
    await act(async () => {
      root.render(<CodeEditor path="fixture.py" value="x = 1" language="python" readOnly={false} onChange={() => {}} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const control = host.querySelector('textarea.iPadShowKeyboard');
    expect(control, 'the stubbed editor drew its touch control').not.toBeNull();
    expect(control!.getAttribute('aria-label')).toBe(TOUCH_KEYBOARD_LABEL);
    expect(rig.disposed.length).toBeGreaterThan(0);
  });
});

describe('a Section header wraps its right slot under the title on a phone', () => {
  it('the header wraps, the title keeps a floor, the right slot never exceeds the panel', () => {
    act(() => {
      root.render(<Section title="Dates for this class" right={<label><select><option>A very long class name</option></select></label>} testId="s" />);
    });
    const header = host.querySelector('[data-testid="s"] > header')!;
    expect(header.className.split(/\s+/)).toContain('flex-wrap');
    const title = header.querySelector('h2')!.parentElement!;
    expect(title.className).toContain('min-w-[min(100%,12rem)]');
    const right = header.querySelector('[data-section-right]')!;
    for (const c of ['min-w-0', 'max-w-full', 'flex-wrap']) expect(right.className.split(/\s+/)).toContain(c);
  });

  // The schedule's class select and its label, and the export button's label, are rendered with the classes that
  // let them shrink and wrap in `schedule-panel.test.tsx` and `portability-panel.test.tsx`.
});

describe('the phase strip on a phone, with the column pressed', () => {
  const css = webSource('components/shell/shell-fidelity.css');
  it('the title row shrinks to the strip and the title wraps its words', () => {
    const row = mediaRule(css, 700, '.phase-strip-identity');
    expect(row).toMatch(/flex-shrink: ?1/);
    expect(row).toMatch(/min-width: ?0/);
    const title = mediaRule(css, 700, '.phase-strip-identity h1,.phase-strip-identity [data-testid="phase-title"]');
    expect(title).toMatch(/white-space: ?normal/);
    expect(title).toMatch(/overflow-wrap: ?anywhere/);
  });
  it('the guide link shrinks too', () => {
    const guide = mediaRule(css, 700, '.phase-strip-guide');
    expect(guide).toMatch(/flex-shrink: ?1/);
    expect(guide).toMatch(/min-width: ?0/);
  });
});

describe('the view switcher wraps on a phone', () => {
  it('.implementation-view-tabs wraps below 768px', () => {
    const rule = mediaRule(webSource('components/workspace/phase-experience.css'), 767, '.implementation-view-tabs');
    expect(rule).toMatch(/flex-wrap: ?wrap/);
  });
});
