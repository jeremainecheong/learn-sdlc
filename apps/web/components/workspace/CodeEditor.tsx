'use client';

import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InlineNote, type NoteChoice } from '@/components/shell';
import { THEME_EVENT, getTheme, type Theme } from '@/lib/theme';
import { EDITOR_THEMES, monaco } from './monaco-setup';
import { nameTouchKeyboard } from './monaco-touch';

const isTheme = (v: unknown): v is Theme => v === 'paper' || v === 'graphite';

/**
 * A card the editor draws under a line of code: what the line disagrees with,
 * and the test that says so. Everything the platform knows about a line is said
 * at the line rather than in a list somewhere else.
 */
export interface EditorNote {
  /** Stable across renders, so a note is not torn down while it is being read. */
  key: string;
  /** 1-based; the note is drawn under this line. */
  line: number;
  tone: 'warn' | 'fail' | 'neutral';
  /** The chip: "Contract", "US-3.3", "Not linked". */
  label: string;
  text: string;
  /** The test that says so, in mono. */
  test?: string;
  onExplain?: () => void;
  /** Criterion chips, for a line that is not linked to one yet. */
  choices?: NoteChoice[];
}

/**
 * One analyzer finding, drawn on the code as a Monaco marker: a
 * squiggle under the whole line, a tick in the scrollbar rail, and the
 * analyzer's sentence in the hover.
 */
export interface EditorMarker {
  /** 1-based. */
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** The analyzer rule, shown after the message in the hover. */
  rule: string;
}

/**
 * Markers are keyed by owner, so setting an empty list under ours removes
 * exactly our own and never the language service's syntax diagnostics.
 */
const MARKER_OWNER = 'learnsdlc-health';

type MonacoEditor = Parameters<OnMount>[0];
type ZoneAccessor = Parameters<Parameters<MonacoEditor['changeViewZones']>[0]>[0];
type ViewZone = Parameters<ZoneAccessor['addZone']>[0];
type Zone = { id: string; dom: HTMLDivElement; note: EditorNote; zone: ViewZone };

/** The code surface before Monaco has drawn on it: ragged lines, no words. */
function EditorLines() {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-4" data-testid="editor-lines" aria-hidden>
      {['w-[52%]', 'w-[36%]', 'w-[44%]', 'w-[28%]', 'w-[48%]', 'w-[32%]', 'w-[40%]', 'w-[24%]'].map(
        (w, i) => (
          <span key={i} className={`skeleton block h-3 ${w}`} />
        ),
      )}
    </div>
  );
}

/** One shared empty list, so a caller that passes no markers is a stable dep. */
const NO_MARKERS: EditorMarker[] = [];

/** Rough first height; the real one is measured once the note has rendered. */
const GUESS_H = 46;
/** How many times one note may re-ask for a height before we let it be. */
const MAX_RELAYOUTS = 8;
/**
 * How long after an Apply's reveal the editor keeps the change in view while the room finishes drawing around it, in
 * ms: the inline notes of the applied text are added a render later and measured a frame after that, and each makes
 * the code under it taller.
 */
const SETTLE_MS = 1000;
/** One line of code, in px (the editor's `lineHeight`). */
const LINE_PX = 21;
/** The keys that move the code's view when pressed in the editor. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Monaco, following the app theme, with the platform's own notes drawn between
 * the lines. The theme is read after mount (the server has no localStorage) and
 * again whenever the toggle fires `THEME_EVENT` on window, so the code surface
 * never disagrees with the page around it.
 */
export function CodeEditor({
  path,
  value,
  language,
  readOnly,
  onChange,
  notes = [],
  markers = NO_MARKERS,
  onCursor,
  focusLine,
  restore,
  onScroll,
  appearance,
  revealOnce,
  onRevealed,
}: {
  appearance?: 'paper' | 'graphite';
  path: string;
  value: string;
  language: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  /** Inline notes for this file, drawn as view zones under their lines. */
  notes?: EditorNote[];
  /**
   * Findings from the last verdict, drawn on the code. Empty while
   * the buffer has moved on from the revision they describe: a marker whose
   * line number is one edit stale points at the wrong code, which is worse
   * than pointing at nothing.
   */
  markers?: EditorMarker[];
  /** Where the caret is, for the status bar. */
  onCursor?: (line: number, col: number) => void;
  /** Reveal a line: bump the nonce to scroll there again for the same line. */
  focusLine?: { line: number; nonce: number; quiet?: boolean } | null;
  /**
   * Where this file was when the learner last left it. Applied once, as the
   * editor becomes ready, so coming back to a phase is coming back to the
   * line you were reading rather than to the top of the file.
   */
  restore?: { line: number; col: number; scrollTop: number } | null;
  /** The code's scroll position, so the caller can hand it back next time. */
  onScroll?: (scrollTop: number) => void;
  /**
   * After an Apply: the first and last lines it changed in this file (`last` left out: the one line), and the
   * applied text. Once that text is in the editor, those lines are brought into view, then `onRevealed` is called so
   * the caller drops them: once per Apply, never again for a later edit, save, reload or switch of view. `since` is
   * when the Apply was pressed: if the person has scrolled the code since then, the view is theirs and nothing moves.
   */
  revealOnce?: { line: number; last?: number; text: string; nonce: number; since?: number } | null;
  onRevealed?: () => void;
}) {
  const [theme, setTheme] = useState<Theme>('paper');
  const editorRef = useRef<MonacoEditor | null>(null);
  // Read by Monaco's own listeners, which are bound once and outlive any
  // particular render's callbacks.
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onRevealedRef = useRef(onRevealed);
  onRevealedRef.current = onRevealed;
  /** The Apply this editor has already shown, so one Apply is revealed once. */
  const revealedRef = useRef<number | null>(null);
  /** When the person last scrolled the code themselves (a wheel, a touch, the scroll bar, a paging key), in ms. */
  const personScrolledAt = useRef(0);
  /** Stops keeping the last Apply's change in view (see `SETTLE_MS`). */
  const settleRef = useRef<(() => void) | null>(null);
  useEffect(() => () => settleRef.current?.(), []);
  /** The file this editor has already put back where the learner left it. */
  const restoredRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [zones, setZones] = useState<Zone[]>([]);
  const zonesRef = useRef<Zone[]>([]);

  useEffect(() => {
    setTheme(getTheme());
    const onTheme = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setTheme(isTheme(detail) ? detail : getTheme());
    };
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  // A note is torn down and rebuilt only when something about it changed;
  // rebuilding on every keystroke would blink the card away as it is read.
  const signature = useMemo(
    () =>
      notes
        .map(
          (n) =>
            `${n.key}:${n.line}:${n.tone}:${n.label}:${n.text}:${n.test ?? ''}:${(n.choices ?? [])
              .map((c) => `${c.label}${c.selected ? '*' : ''}`)
              .join(',')}`,
        )
        .join('|'),
    [notes],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready) return;
    const next: Zone[] = [];
    editor.changeViewZones((accessor) => {
      for (const z of zonesRef.current) accessor.removeZone(z.id);
      for (const note of notes) {
        const dom = document.createElement('div');
        dom.style.width = `${editor.getLayoutInfo().contentWidth}px`;
        // Monaco paints .view-lines after .view-zones, so without this the code
        // layer sits on top of the note and swallows every click meant for a
        // criterion chip. Monaco positions the node itself; the z-index is all
        // that is missing.
        dom.style.zIndex = '10';
        dom.style.pointerEvents = 'auto';
        // Monaco listens for the press on the editor node above this one and
        // re-aims it at the nearest text position, so a chip inside a view
        // zone is hit-testable but never actually clicked. Stopping the press
        // and the release here, nearer the target than Monaco's listener,
        // leaves the click itself to bubble to React, which is what the chip
        // is waiting for.
        for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
          dom.addEventListener(type, (e) => e.stopPropagation());
        }
        // Monaco keeps this object; the observer below writes the measured
        // height onto it and asks for a relayout. `suppressMouseDown` keeps the
        // editor from claiming the click meant for a criterion chip.
        const zone: ViewZone = {
          afterLineNumber: note.line,
          heightInPx: GUESS_H,
          domNode: dom,
          suppressMouseDown: true,
        };
        next.push({ id: accessor.addZone(zone), dom, note, zone });
      }
    });
    zonesRef.current = next;
    setZones(next);
    return () => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.changeViewZones((accessor) => {
        for (const z of next) accessor.removeZone(z.id);
      });
      zonesRef.current = [];
    };
    // `signature` stands in for `notes`: same content, same zones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ready, path]);

  // The card's real height is only knowable once it has drawn, and it changes
  // when the pane narrows and the sentence wraps onto another line.
  //
  // Two things make this a loop rather than a measurement: the zone's own node
  // is sized by Monaco from the height we write, and a taller zone can bring
  // the editor's scrollbar in, which narrows the content, which rewraps the
  // card taller again. So watch the card rather than the zone, ignore
  // differences too small to see, and stop asking after a few rounds: a note
  // a couple of pixels short overlaps nothing, while a note that never settles
  // cannot be clicked.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || zones.length === 0 || typeof ResizeObserver === 'undefined') return;
    const asked = new Map<string, number>();
    const rounds = new Map<string, number>();
    const ro = new ResizeObserver(() => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.changeViewZones((accessor) => {
        for (const z of zones) {
          const card = z.dom.firstElementChild as HTMLElement | null;
          const measured = card?.getBoundingClientRect().height ?? 0;
          const h = Math.max(GUESS_H, Math.ceil(measured) + 8);
          const last = asked.get(z.id) ?? z.zone.heightInPx ?? 0;
          if (Math.abs(h - last) <= 2) continue;
          const round = (rounds.get(z.id) ?? 0) + 1;
          if (round > MAX_RELAYOUTS) continue;
          rounds.set(z.id, round);
          asked.set(z.id, h);
          z.zone.heightInPx = h;
          accessor.layoutZone(z.id);
        }
      });
    });
    for (const z of zones) ro.observe(z.dom.firstElementChild ?? z.dom);
    return () => ro.disconnect();
  }, [zones]);

  // A note is drawn in the layer that scrolls with the code, so it takes the
  // width of the longest line unless every layout change says otherwise.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || zones.length === 0) return;
    const apply = () => {
      const w = editor.getLayoutInfo().contentWidth;
      for (const z of zones) z.dom.style.width = `${w}px`;
    };
    apply();
    const sub = editor.onDidLayoutChange(apply);
    return () => sub.dispose();
  }, [zones]);

  // `ready` is in the deps because a line can be asked for before Monaco has
  // mounted: the page reveals the first problem as the verdict arrives, which
  // is often before the editor's own chunk has loaded. Without it that first
  // reveal is dropped and the file opens at line 1.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready || !focusLine) return;
    editor.revealLineInCenter(focusLine.line);
    editor.setPosition({ lineNumber: focusLine.line, column: 1 });
    // Jumping to a problem you clicked puts the caret in your hands; the page's
    // own reveal as a phase opens does not take the keyboard off you.
    if (focusLine.quiet !== true) editor.focus();
  }, [focusLine, ready]);

  // Markers belong to the model, not to the editor, so they go on whichever
  // model the active path is showing, and the list is cleared when it empties.
  // The analyzer reports a line and never a column, so the whole line is
  // underlined: a one-character squiggle at column 1 would read as a syntax
  // error in the indent.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready) return;
    const model = editor.getModel();
    if (!model) return;
    const lines = model.getLineCount();
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      markers
        .filter((m) => m.line >= 1 && m.line <= lines)
        .map((m) => ({
          startLineNumber: m.line,
          endLineNumber: m.line,
          startColumn: 1,
          endColumn: model.getLineMaxColumn(m.line),
          message: m.message,
          source: 'Code health',
          code: m.rule,
          severity:
            m.severity === 'error'
              ? monaco.MarkerSeverity.Error
              : m.severity === 'warning'
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info,
        })),
    );
    return () => {
      const m = editorRef.current?.getModel();
      if (m) monaco.editor.setModelMarkers(m, MARKER_OWNER, []);
    };
  }, [markers, ready, path, value]);

  // Where the learner left this file, put back once the editor is up. The
  // reveal above and this never argue over the same viewport: the page asks
  // for a reveal only on a phase it has nothing remembered about.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready || !restore || restoredRef.current === path) return;
    restoredRef.current = path;
    editor.setPosition({ lineNumber: restore.line, column: restore.col });
    editor.setScrollTop(restore.scrollTop);
  }, [ready, path, restore]);

  // The applied change, once its text is in the editor. `value` is the text the wrapper has just put in the model:
  // the wrapper is a child, so its effect has run before this one in the same commit.
  //
  // The applied notice above the editor is drawn in this same commit and makes it shorter; Monaco's automatic layout
  // only notices a frame later. So the editor is measured first (when it is shown at all). Then the
  // changed lines, first to last, go to Monaco's own reveal (`revealRangeNearTopIfOutsideViewport`), which works in
  // pixels and so counts the inline notes drawn between them (in Testing, two "Not linked" notes would leave the new
  // assertion under the fold if only the first changed line were revealed). What it does:
  // - the whole change already in view: nothing moves;
  // - the change fits the view: all of it is brought in, with five lines (or a fifth of the view, if more) above it,
  //   fewer when those would push its last line out of view (a short file stops at its end, as Implementation's
  //   helper does);
  // - the change is taller than the view: its first line at the top.
  // The notes of the applied text are added a render later and measured a frame after that, each making the code
  // taller; so for `SETTLE_MS` the same reveal is asked again whenever the code's height changes, which moves
  // nothing while the change is still in view. A scroll, a keystroke or another file ends that at once. The caret and
  // the focus are left alone.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready || !revealOnce || revealedRef.current === revealOnce.nonce) return;
    if (value !== revealOnce.text) return;
    revealedRef.current = revealOnce.nonce;
    settleRef.current?.();
    // Scrolled by the person after the press, while the applied text was read back: left as they put it.
    if (revealOnce.since !== undefined && personScrolledAt.current >= revealOnce.since) {
      onRevealedRef.current?.();
      return;
    }
    if ((editor.getContainerDomNode()?.clientHeight ?? 0) > 0) editor.layout();
    const model = editor.getModel();
    const first = revealOnce.line;
    const last = Math.max(first, Math.min(revealOnce.last ?? first, model?.getLineCount() ?? first));
    const range = {
      startLineNumber: first,
      startColumn: 1,
      endLineNumber: last,
      endColumn: model ? model.getLineMaxColumn(last) : 1,
    };
    const show = () => editor.revealRangeNearTopIfOutsideViewport(range, 1 /* ScrollType.Immediate */);
    show();
    onRevealedRef.current?.();
    if (typeof editor.onDidContentSizeChange !== 'function') return;
    const text = revealOnce.text;
    const shownAt = Date.now();
    let sub: { dispose: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      sub?.dispose();
      sub = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (settleRef.current === stop) settleRef.current = null;
    };
    sub = editor.onDidContentSizeChange(() => {
      const theirs = personScrolledAt.current >= shownAt;
      if (theirs || Date.now() - shownAt > SETTLE_MS || editor.getModel() !== model || editor.getValue() !== text) {
        stop();
        return;
      }
      show();
    });
    timer = setTimeout(stop, SETTLE_MS);
    settleRef.current = stop;
  }, [revealOnce, ready, value]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((e) =>
      onCursorRef.current?.(e.position.lineNumber, e.position.column),
    );
    editor.onDidScrollChange((e) => onScrollRef.current?.(e.scrollTop));
    // The person's own scrolls, told apart from the editor's (a new text, a reveal, a restore): what they do to move the
    // view. Heard on the way down, before Monaco takes the wheel for itself.
    const box = typeof editor.getContainerDomNode === 'function' ? editor.getContainerDomNode() : null;
    if (box) {
      const mark = () => { personScrolledAt.current = Date.now(); };
      const onPointer = (e: Event) => { if (e.target instanceof Element && e.target.closest('.scrollbar')) mark(); };
      const onKey = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key)) mark(); };
      box.addEventListener('wheel', mark, { capture: true, passive: true });
      box.addEventListener('touchmove', mark, { capture: true, passive: true });
      box.addEventListener('pointerdown', onPointer, true);
      box.addEventListener('keydown', onKey, true);
      if (typeof editor.onDidDispose === 'function') {
        editor.onDidDispose(() => {
          box.removeEventListener('wheel', mark, { capture: true });
          box.removeEventListener('touchmove', mark, { capture: true });
          box.removeEventListener('pointerdown', onPointer, true);
          box.removeEventListener('keydown', onKey, true);
        });
      }
    }
    // Another file's tab swaps the model, and a model with no remembered view
    // state moves the caret without a cursor event: the status bar and the
    // breadcrumb kept the last file's "Ln 158". The new model's
    // caret is reported as it arrives; a remembered one follows as its own event.
    if (typeof editor.onDidChangeModel === 'function') {
      editor.onDidChangeModel(() => {
        const at = editor.getPosition();
        onCursorRef.current?.(at?.lineNumber ?? 1, at?.column ?? 1);
      });
    }
    onCursorRef.current?.(1, 1);
    setReady(true);
    // Monaco's touch keyboard control has no name of its own (monaco-touch.ts).
    const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
    if (dom) {
      const stop = nameTouchKeyboard(dom);
      if (typeof editor.onDidDispose === 'function') editor.onDidDispose(stop);
    }
    // Monaco focuses its own hidden textarea while it measures and then lets
    // it go, which leaves the browser's sequential focus navigation starting
    // point inside the editor: the first Tab on a workspace room would put the
    // learner into the code rather than on the skip link, and Tab inside an
    // editor inserts a tab, so the chrome would be unreachable by keyboard from
    // a fresh page. Nobody asked for the editor, so the starting point
    // goes back to the top of the document: unless something has genuinely
    // taken focus in the meantime, which is somebody's own doing.
    if (typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const top = document.getElementById('focus-top');
    if (!top) return;
    top.focus({ preventScroll: true });
    top.blur();
  };

  return (
    <>
      <Editor
        path={path}
        value={value}
        language={language}
        theme={EDITOR_THEMES[appearance ?? theme]}
        onMount={onMount}
        onChange={(v, event) => {
          // The React wrapper uses setValue for a read-only prop refresh.
          // Its model flush is a saved copy, not a learner edit to autosave.
          if (!event.isFlush) onChange(v ?? '');
        }}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: LINE_PX,
          fontFamily: 'var(--font-geist-mono), "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          fontLigatures: false,
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          // On for every language, not only prose. The editor column is 420px
          // at its floor, and instructions in a comment block at the top of a
          // file would otherwise run off the right edge and stop mid-sentence. A line the
          // learner cannot read is worse than a line that wraps, and the
          // wrapped continuation is drawn without a line number, so the
          // reference in a verdict ("overdue.ts, line 42") still lands.
          wordWrap: 'on',
          padding: { top: 14, bottom: 14 },
          renderLineHighlight: 'line',
          // The breadcrumb over the editor already names the enclosing class and
          // function; a second copy pinned inside the code says it twice.
          stickyScroll: { enabled: false },
          tabSize: 4,
          overviewRulerBorder: false,
          // The rail beside the scrollbar draws a tick per marker, which is how
          // a learner finds the finding that is off screen.
          overviewRulerLanes: 2,
          // At the editor's own top or bottom the wheel goes on to whatever
          // scrolls around it. A split phase puts this editor in a scroll
          // region under its task list, and Monaco's default swallows every
          // wheel event, so wheeling over the code would never reach the
          // region and the bottom panel would stay out of reach.
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
          guides: { indentation: true },
          cursorSmoothCaretAnimation: 'off',
          smoothScrolling: false,
        }}
        // Monaco always commits one frame before it is up, so that frame is
        // the shape of what is coming rather than a sentence about waiting.
        loading={<EditorLines />}
      />
      {zones.map((z) =>
        createPortal(
          <InlineNote
            tone={z.note.tone}
            label={z.note.label}
            text={z.note.text}
            test={z.note.test}
            onExplain={z.note.onExplain}
            choices={z.note.choices}
            testId={`inline-note-${z.note.key}`}
          />,
          z.dom,
          z.note.key,
        ),
      )}
    </>
  );
}
