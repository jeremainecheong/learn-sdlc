'use client';

/**
 * Self-contained Monaco: bundle the editor locally (no CDN) and expose the
 * instance on window for Playwright-driven editing in E2E tests.
 *
 * Two editor themes, one per app theme. Paper keeps the code surface white so
 * it belongs to the same page as the brief beside it; Graphite is the same
 * palette inverted. The colours are the design tokens' editor values, written
 * out because Monaco cannot read CSS variables.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import type { Theme } from '@/lib/theme';

declare global {
  interface Window {
    /** The bundled editor's API, set once the editor is configured. */
    monaco?: typeof monaco;
  }
}

/** Monaco theme name for each app theme. */
export const EDITOR_THEMES: Record<Theme, string> = {
  paper: 'paper',
  graphite: 'graphite',
};

interface Palette {
  base: 'vs' | 'vs-dark';
  bg: string;
  text: string;
  keyword: string;
  string: string;
  comment: string;
  fn: string;
  number: string;
  type: string;
  delimiter: string;
  line: string;
  gutter: string;
  gutterActive: string;
  accent: string;
  selection: string;
  guide: string;
  guideActive: string;
  widgetBg: string;
  widgetEdge: string;
  scrollbar: string;
  error: string;
  warning: string;
  /**
   * The third marker severity, and the rail beside the scrollbar.
   * The analyzer's notes are drawn in the accent, which is the colour this
   * product already uses for "worth knowing, nothing is broken".
   */
  info: string;
}

const PAPER: Palette = {
  base: 'vs',
  bg: '#FFFFFF',
  text: '#15171B',
  keyword: '#7C3AED',
  string: '#15803D',
  comment: '#6E7480',
  fn: '#1D4ED8',
  number: '#0E7490',
  type: '#854D0E',
  delimiter: '#3F4653',
  line: '#F0F2F6',
  gutter: '#666D7A',
  gutterActive: '#3F4653',
  accent: '#1D4ED8',
  selection: '#1D4ED8',
  guide: '#E3E6EB',
  guideActive: '#CBD0D8',
  widgetBg: '#FFFFFF',
  widgetEdge: '#E3E6EB',
  scrollbar: '#111827',
  error: '#B91C1C',
  // The product's warn colour is a rust, for contrast on its own tint, and the
  // editor uses it too.
  warning: '#9A3412',
  info: '#1D4ED8',
};

const GRAPHITE: Palette = {
  base: 'vs-dark',
  bg: '#16181C',
  text: '#E6E8EC',
  keyword: '#C792EA',
  string: '#8FD9A8',
  comment: '#7C8290',
  fn: '#82AAFF',
  number: '#3EC5D9',
  type: '#E6C77A',
  delimiter: '#C7CBD1',
  line: '#1F2228',
  gutter: '#848B95',
  gutterActive: '#C7CBD1',
  accent: '#4C8DFF',
  selection: '#4C8DFF',
  guide: '#30343A',
  guideActive: '#434850',
  widgetBg: '#1B1D21',
  widgetEdge: '#30343A',
  scrollbar: '#F3F4F6',
  error: '#F25C5C',
  warning: '#FB923C',
  info: '#4C8DFF',
};

const hex = (c: string) => c.replace('#', '');

function defineTheme(name: string, p: Palette) {
  monaco.editor.defineTheme(name, {
    base: p.base,
    inherit: true,
    rules: [
      { token: '', foreground: hex(p.text) },
      { token: 'comment', foreground: hex(p.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: hex(p.keyword) },
      { token: 'keyword.flow', foreground: hex(p.keyword) },
      { token: 'keyword.json', foreground: hex(p.keyword) },
      { token: 'string', foreground: hex(p.string) },
      { token: 'string.key.json', foreground: hex(p.fn) },
      { token: 'string.value.json', foreground: hex(p.string) },
      { token: 'string.yaml', foreground: hex(p.string) },
      { token: 'number', foreground: hex(p.number) },
      { token: 'number.yaml', foreground: hex(p.number) },
      { token: 'type', foreground: hex(p.type) },
      { token: 'type.identifier', foreground: hex(p.type) },
      { token: 'type.yaml', foreground: hex(p.fn) },
      { token: 'identifier', foreground: hex(p.text) },
      { token: 'function', foreground: hex(p.fn) },
      { token: 'entity.name.function', foreground: hex(p.fn) },
      { token: 'variable', foreground: hex(p.text) },
      { token: 'variable.predefined', foreground: hex(p.fn) },
      { token: 'delimiter', foreground: hex(p.delimiter) },
      { token: 'operator', foreground: hex(p.delimiter) },
      { token: 'tag', foreground: hex(p.keyword) },
      { token: 'attribute.name', foreground: hex(p.fn) },
      { token: 'attribute.value', foreground: hex(p.string) },
      { token: 'key', foreground: hex(p.fn) },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': p.bg,
      'editor.foreground': p.text,
      'editorLineNumber.foreground': p.gutter,
      'editorLineNumber.activeForeground': p.gutterActive,
      'editor.lineHighlightBackground': p.line,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': p.accent,
      'editor.selectionBackground': `${p.selection}33`,
      'editor.inactiveSelectionBackground': `${p.selection}1A`,
      'editor.selectionHighlightBackground': `${p.selection}22`,
      'editor.wordHighlightBackground': `${p.selection}22`,
      'editorIndentGuide.background1': p.guide,
      'editorIndentGuide.activeBackground1': p.guideActive,
      'editorGutter.background': p.bg,
      'editorWhitespace.foreground': p.guide,
      'scrollbarSlider.background': `${p.scrollbar}22`,
      'scrollbarSlider.hoverBackground': `${p.scrollbar}33`,
      'scrollbarSlider.activeBackground': `${p.scrollbar}44`,
      'editorWidget.background': p.widgetBg,
      'editorWidget.border': p.widgetEdge,
      'editorSuggestWidget.background': p.widgetBg,
      'editorSuggestWidget.border': p.widgetEdge,
      'editorSuggestWidget.selectedBackground': p.line,
      'editorHoverWidget.background': p.widgetBg,
      'editorHoverWidget.border': p.widgetEdge,
      'editorError.foreground': p.error,
      'editorWarning.foreground': p.warning,
      'editorInfo.foreground': p.info,
      // The rail draws the analyzer's findings, which are markers.
      'editorOverviewRuler.errorForeground': p.error,
      'editorOverviewRuler.warningForeground': p.warning,
      'editorOverviewRuler.infoForeground': p.info,
      'editorBracketMatch.background': `${p.selection}22`,
      'editorBracketMatch.border': p.guideActive,
      'focusBorder': '#00000000',
    },
  });
}

if (typeof window !== 'undefined') {
  /**
   * Monaco's own cancellations, kept out of the console.
   *
   * Swapping the model under the editor, every file tab, every phase, and
   * tearing the editor down cancel whatever the language service had in
   * flight, and Monaco signals that by rejecting with an error named
   * `Canceled`. Nothing is wrong when it happens and nothing handles it, so it
   * would reach `window.onerror` as an uncaught error on the busiest route in the
   * product. Only that exact error is swallowed; anything else Monaco throws
   * still reaches the console.
   */
  const isCancellation = (value: unknown): boolean => {
    if (!value) return false;
    if (typeof value === 'string') return value === 'Canceled' || value === 'Canceled: Canceled';
    const named = value as { name?: unknown; message?: unknown };
    return named.name === 'Canceled' || named.message === 'Canceled';
  };
  window.addEventListener('unhandledrejection', (event) => {
    if (isCancellation(event.reason)) event.preventDefault();
  });
  window.addEventListener(
    'error',
    (event) => {
      if (!isCancellation(event.error ?? event.message)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  /**
   * One worker per language service, not one worker for everything.
   *
   * The generic editor worker answers every message except the ones a language
   * service sends, so a `.ts` or `.tsx` model would make Monaco ask it to load
   * the TypeScript foreign module and fail with "Cannot read properties of
   * undefined (reading 'toUrl')": four times per file, in the browser console
   * of a workspace that otherwise looks fine. The pack's front end is
   * TypeScript, so that is every previewable phase.
   */
  self.MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      if (label === 'typescript' || label === 'javascript') {
        return new Worker(
          new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
        );
      }
      if (label === 'json') {
        return new Worker(
          new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        );
      }
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      );
    },
  };

  defineTheme(EDITOR_THEMES.paper, PAPER);
  defineTheme(EDITOR_THEMES.graphite, GRAPHITE);

  /**
   * TypeScript, without the diagnostics the platform did not produce.
   *
   * The pack's front end imports `react`, `react-router-dom` and its own
   * modules, and Monaco has the types for none of them: every import in every
   * `.tsx` would come up as a red squiggle, and the Problems block, which is this
   * product's word for "a criterion your code does not meet", would fill with a
   * compiler's opinion about a module that resolves perfectly well in the
   * sandbox. So semantic validation is off and syntax validation stays on: a
   * missing brace is a real problem and the learner should see it.
   *
   * The compiler options are the other half. Without `jsx` every `.tsx` is a
   * parse error rather than a component, which would have turned the very
   * squiggles this is removing into ones that are worse.
   */
  const ts = monaco.languages.typescript;
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  ts.typescriptDefaults.setCompilerOptions({
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.ES2020,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  });

  loader.config({ monaco });
  // Read by the browser tests, which type into the editor.
  window.monaco = monaco;
}

export { monaco };
