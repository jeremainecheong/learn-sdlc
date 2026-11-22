'use client';

/**
 * The project editor's section tabs.
 *
 * A sticky bar under the project's header: Overview, each phase, Validate and
 * Publish, and the editor's one save status beside them, so whether the work
 * is saved is visible wherever the teacher has scrolled. Each entry is a tab
 * that opens its section. Overview, Validate, Publish and the open phase stay
 * mounted (hidden when another tab is open), so what is typed, uploaded or
 * running in them outlives a look at another tab. Only the open phase's
 * builder is mounted: opening another phase unmounts it and closes its open
 * forms (the task form, the remove confirm, the executable editor). The phase entries are the one control for which
 * phase is open: there is no second row of phase tabs below.
 *
 * Drawn with the product's own tablist (`useTabs`, the hook `Tabs` is built
 * on) and `Tabs`' own classes. `Tabs` points every tab at one panel, and the
 * sections are separate panels, so the row is drawn here with the hook.
 *
 * Manual activation (the WAI-ARIA Authoring Practices "tabs with manual
 * activation" pattern): the arrow keys, Home and End move FOCUS along the
 * tabs and open nothing; Enter or Space (the button's own click) opens the
 * focused tab. Opening a tab here has side effects (another phase closes the
 * open phase's forms), so walking the row must not open every tab it passes.
 * `useTabs` has no manual mode, and `components/ui` is not changed: the row
 * handles those keys itself (the four arrows, Home and End), beside the hook, and never hands them on.
 *
 * The bar reports its drawn height (`onHeight`) whenever it changes, for the
 * scroll margin that keeps a scrolled-to place below it.
 */
import { useLayoutEffect, useRef } from 'react';
import { useTabs } from '@/components/ui';
import { SAVES_AS_YOU_GO, useEditorSaveSummary } from './save-status';
import { PHASE_PANEL_ID, SECTION_TABS_ID, isPhaseSection, type EditorSection } from './editor-sections';

interface EditorPhaseTab {
  key: EditorSection;
  /** The phase's own label, as the editor draws it (its title and task count). */
  label: React.ReactNode;
}

/** What the Validate tab says about the checks while the teacher is elsewhere. */
export interface ValidateMark {
  state: 'running' | 'failed';
  /** The words, visible and read with the tab's name. */
  text: string;
}

export function EditorNav({
  phases,
  value,
  onChange,
  validateMark = null,
  onHeight,
  readOnly = false,
}: {
  phases: readonly EditorPhaseTab[];
  /** The section that is open. */
  value: EditorSection;
  /** A tab was opened: by a press, Enter or Space. */
  onChange: (key: EditorSection) => void;
  validateMark?: ValidateMark | null;
  /** The bar's drawn height in px, on mount and whenever it changes (a wrap, a resize). */
  onHeight?: (px: number) => void;
  /**
   * The version on screen cannot be changed (published, or not this teacher's
   * to edit). "Every change saves as you make it." is then not true, so the
   * line is left empty until something does save (a run's report, say).
   */
  readOnly?: boolean;
}) {
  const said = useEditorSaveSummary();
  const summary = readOnly && said === SAVES_AS_YOU_GO ? '' : said;
  const keys: EditorSection[] = ['overview', ...phases.map((one) => one.key), 'validate', 'publish'];
  const tabs = useTabs({
    keys,
    value,
    onChange: (key) => onChange(key as EditorSection),
    idBase: SECTION_TABS_ID,
    label: 'Sections of this draft',
  });

  const bar = useRef<HTMLDivElement>(null);
  const reportHeight = useRef(onHeight);
  reportHeight.current = onHeight;
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const measure = () => reportHeight.current?.(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  /** Manual activation: the arrow keys, Home and End move focus only (see the header). */
  const moveFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    const row = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    if (row.length === 0) return;
    const from = row.findIndex((one) => one === document.activeElement || one.contains(document.activeElement));
    const at = from < 0 ? Math.max(0, keys.indexOf(value)) : from;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (at + 1) % row.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (at - 1 + row.length) % row.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = row.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    row[next].focus();
  };

  const tab = (key: EditorSection, label: React.ReactNode) => {
    const on = key === value;
    return (
      <button
        key={key}
        type="button"
        {...tabs.tabProps(key)}
        // Every phase tab controls the one phase panel; the others their own.
        aria-controls={isPhaseSection(key) ? PHASE_PANEL_ID : tabs.panelId(key)}
        data-testid={`project-section-${key}`}
        className={`-mb-[1.5px] inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
          on ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div ref={bar} className="panel sticky top-0 z-20 flex min-w-0 flex-col gap-1.5 px-3 pt-1 pb-2" data-testid="editor-nav">
      <div
        {...tabs.tablistProps}
        // The hook's own handler opens each tab it passes; this row moves focus only.
        onKeyDown={moveFocus}
        className="flex min-w-0 flex-wrap gap-1 border-b-1.5 border-edge"
      >
        {tab('overview', <span data-testid="editor-nav-overview">Overview</span>)}
        {phases.map((one) => tab(one.key, <span data-testid={`editor-nav-phase-${one.key}`}>{one.label}</span>))}
        {tab(
          'validate',
          <span className="inline-flex items-center gap-1.5" data-testid="editor-nav-validate">
            Validate
            {validateMark && (
              <span
                className={`label-sm font-semibold${validateMark.state === 'failed' ? ' text-fail' : ''}`}
                data-testid="project-section-validate-mark"
                data-state={validateMark.state}
              >
                {/* Read with the tab's name: "Validate, running". */}
                <span className="sr-only">, </span>
                {validateMark.text}
              </span>
            )}
          </span>,
        )}
        {tab('publish', <span data-testid="editor-nav-publish">Publish</span>)}
      </div>
      {/* Never hidden: a live region unhidden in the same moment its words arrive may not be
          announced. While empty it is only taken out of the bar's flow, so the bar keeps no gap for it. */}
      <p role="status" className={summary ? 'label-sm wrap m-0' : 'sr-only'} data-testid="editor-save-status">
        {summary}
      </p>
    </div>
  );
}
