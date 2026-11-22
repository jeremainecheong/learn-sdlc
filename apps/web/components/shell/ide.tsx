'use client';

/**
 * The chrome around the editor: the explorer, the panel under the code, the
 * status bar, and the note that sits inline in the source.
 *
 * These are the parts of an IDE a learner already knows the shape of, drawn
 * in this product's tokens and carrying this product's facts: the explorer's
 * 'Your changes' block shows the submission and the hidden-suite result, the
 * problems list is criteria that are not met, and an inline note names the
 * contract or the criterion a line disagrees with.
 */
import { useId, useRef, useState } from 'react';
import { pluralWord } from '@learnsdlc/shared';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/Icon';
import { TechMark, techForPath } from '@/components/TechMark';
import { Chip, StatusSquare, useTabs } from '@/components/ui';
import type { StatusState } from '@/lib/phase';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

/* ---------------------------------------------------------------------------
   Shared: the small heading each explorer block wears, in sentence case like
   every other label in the product.
--------------------------------------------------------------------------- */
function BlockHead({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="block-head">
      {children}
      {right}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   ActivityBar, the 48px strip of modes down the left of the editor.
--------------------------------------------------------------------------- */
export interface ActivityItem {
  key: string;
  icon: IconName;
  label: string;
  onSelect?: () => void;
}

export function ActivityBar({ items, active, className = '' }: { items: ActivityItem[]; active?: string; className?: string }) {
  return (
    <nav
      aria-label="Editor modes"
      data-testid="activity-bar"
      className={`flex w-12 shrink-0 flex-col items-center gap-1 border-r-1.5 border-edge bg-surface py-2 ${className}`}
    >
      {items.map((it) => {
        const on = it.key === active;
        return (
          <button
            key={it.key}
            type="button"
            onClick={it.onSelect}
            title={it.label}
            aria-label={it.label}
            aria-pressed={on}
            data-testid={`activity-${it.key}`}
            className={`inline-flex h-9 w-9 items-center justify-center rounded-ctl transition-colors ${
              on ? 'bg-raised text-accent' : 'text-muted hover:bg-raised hover:text-ink'
            }`}
          >
            <Icon name={it.icon} size={18} />
          </button>
        );
      })}
    </nav>
  );
}

/* ---------------------------------------------------------------------------
   Explorer: files, what has changed, and what is wrong.
--------------------------------------------------------------------------- */
export interface ExplorerNode {
  /** The file or folder's own name, not its path. */
  name: string;
  /** 1 for a top-level entry, 2 for one inside a folder, and so on. */
  depth?: number;
  kind?: 'file' | 'folder';
  /** Folders only: whether the chevron points down. */
  open?: boolean;
  /**
   * Folders only: open or close this one. A two-directory
   * application is a wall with every folder open at once, so the chevron has
   * to do something.
   */
  onToggle?: () => void;
  /** The file the editor is showing. */
  active?: boolean;
  /** Draw the unsaved dot. */
  modified?: boolean;
  onSelect?: () => void;
  testId?: string;
}

export interface ExplorerChange {
  name: string;
  adds?: number;
  dels?: number;
  state?: StatusState;
}

export interface ExplorerLine {
  state: StatusState;
  text: string;
}

export interface ExplorerProblem {
  state: StatusState;
  /** "Line 69", the place. */
  where: string;
  /** "Contract contradicted": what is wrong there. */
  what: string;
  onSelect?: () => void;
}

export function Explorer({
  tree,
  sourceControl,
  problems,
  className = '',
}: {
  tree: ExplorerNode[];
  /** The change set: which pull request, what changed, how the last run went. */
  sourceControl?: { pr?: string; changes?: ExplorerChange[]; lines?: ExplorerLine[] };
  problems?: ExplorerProblem[];
  className?: string;
}) {
  const openProblems = problems?.length ?? 0;
  return (
    <aside
      data-testid="explorer"
      aria-label="Explorer"
      className={`flex w-[232px] shrink-0 flex-col overflow-hidden border-r-1.5 border-edge bg-surface ${className}`}
    >
      <BlockHead>Explorer</BlockHead>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1.5">
        {tree.map((n, i) => {
          const depth = n.depth ?? 1;
          const folder = n.kind === 'folder';
          const body = (
            <>
              {folder ? (
                <Icon name={n.open ? 'chevron-down' : 'chevron-right'} size={12} className="shrink-0 text-muted" />
              ) : (
                <span className="w-3 shrink-0" aria-hidden />
              )}
              <TechMark name={folder ? 'text' : techForPath(n.name)} size={14} className="shrink-0" />
              <span className="mono truncate text-[12px]">{n.name}</span>
              {n.modified && (
                <>
                  <span className="flex-1" aria-hidden />
                  {/* An edited file is being worked on, not failing: `now` is
                      the state lib/phase.ts keeps for exactly this. */}
                  <StatusSquare state="now" size={8} className="mr-1 shrink-0" label="Changed, not submitted" />
                </>
              )}
            </>
          );
          const pad = { paddingLeft: (n.active ? 2 : 8) + (depth - 1) * 16 };
          const cls = `flex h-6 w-full items-center gap-[7px] text-left text-[12.5px] ${
            n.active ? 'mx-1.5 rounded-chip bg-tint font-semibold text-ink' : 'text-ink2 hover:bg-raised'
          }`;
          // A folder opens and closes; a file opens in the editor. Either way
          // the row is a button, so the keyboard reaches it.
          const act = n.onSelect ?? n.onToggle;
          return act ? (
            <button
              key={`${n.name}-${i}`}
              type="button"
              onClick={act}
              aria-expanded={folder && n.onToggle ? Boolean(n.open) : undefined}
              data-testid={n.testId}
              className={cls}
              style={pad}
            >
              {body}
            </button>
          ) : (
            <div key={`${n.name}-${i}`} data-testid={n.testId} className={cls} style={pad}>
              {body}
            </div>
          );
        })}
      </div>

      {sourceControl && (
        <>
          <div className="h-[1.5px] shrink-0 bg-edge" aria-hidden />
          <BlockHead right={sourceControl.pr ? <Chip tone="accent">{sourceControl.pr}</Chip> : undefined}>Your changes</BlockHead>
          <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-2.5 text-[12px] text-ink2">
            {(sourceControl.changes ?? []).map((c) => (
              <span key={c.name} className="flex items-center gap-2">
                <StatusSquare state={c.state ?? 'now'} size={10} />
                <span className="mono truncate">{c.name}</span>
                <span className="flex-1" aria-hidden />
                {(c.adds !== undefined || c.dels !== undefined) && (
                  <span className="mono shrink-0 text-[11.5px] text-muted">
                    +{c.adds ?? 0} −{c.dels ?? 0}
                  </span>
                )}
              </span>
            ))}
            {(sourceControl.lines ?? []).map((l, i) => (
              <span key={`${l.text}-${i}`} className="flex items-start gap-2">
                <StatusSquare state={l.state} size={10} className="mt-0.5" />
                <span className="wrap">{l.text}</span>
              </span>
            ))}
          </div>
        </>
      )}

      {problems && (
        <>
          <div className="h-[1.5px] shrink-0 bg-edge" aria-hidden />
          <BlockHead right={<span className="mono text-[11.5px] font-medium text-fail">{openProblems} open</span>}>
            Problems
          </BlockHead>
          <div className="flex max-h-[132px] shrink-0 flex-col gap-1.5 overflow-y-auto px-3 pb-3 text-[12px]">
            {problems.map((p, i) => {
              const body = (
                <>
                  <StatusSquare state={p.state} size={10} className="mt-0.5" />
                  <span className="wrap text-left text-ink2">
                    {p.where} <span className="text-muted">{p.what}</span>
                  </span>
                </>
              );
              return p.onSelect ? (
                <button key={i} type="button" onClick={p.onSelect} className="flex w-full items-start gap-2 rounded-sm hover:text-ink">
                  {body}
                </button>
              ) : (
                <span key={i} className="flex items-start gap-2">
                  {body}
                </span>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}

/* ---------------------------------------------------------------------------
   BottomPanel: Terminal / Tests / Problems / Ledger under the code.
--------------------------------------------------------------------------- */
export interface BottomTab {
  key: string;
  label: React.ReactNode;
  /** Appended after the label in the tab, e.g. Problems 3. */
  count?: number;
  testId?: string;
  content: React.ReactNode;
}

/** A tab's side padding in the panel's row, and the narrower one the row takes when the usual one does not fit. */
export const BOTTOM_TAB_PAD = 14;
export const BOTTOM_TAB_PAD_TIGHT = 10;

/**
 * Whether the row of tabs under the code needs the narrower padding to fit its box. At 1280 px with the brief and
 * the mentor open, Implementation's eight tabs ask for about 29 px more than the 578 px column, so at the usual padding
 * the row would scroll sideways and, with Review selected, show its first tab as "rminal". The tabs' own widths are summed at the
 * usual padding (whichever padding they are drawn at now, so the answer never depends on itself and cannot flicker),
 * and where that sum is wider than the row the padding narrows by 4 px a side: 64 px for eight tabs. A row that fits
 * keeps the usual padding and its markup; one that does not fit even so still scrolls.
 */
export function useTabRowFit(count: number): { ref: React.RefObject<HTMLDivElement | null>; tight: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [tight, setTight] = useState(false);
  useIsoLayoutEffect(() => {
    const row = ref.current;
    if (!row || typeof window === 'undefined') return;
    const measure = () => {
      const tabs = Array.from(row.children) as HTMLElement[];
      const drawn = tabs.reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0);
      const natural = drawn + (row.dataset.tight === 'true' ? tabs.length * 2 * (BOTTOM_TAB_PAD - BOTTOM_TAB_PAD_TIGHT) : 0);
      const next = row.clientWidth > 0 && natural > row.clientWidth + 1;
      setTight((prev) => (prev === next ? prev : next));
    };
    measure();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    resize?.observe(row);
    for (const tab of Array.from(row.children)) resize?.observe(tab);
    window.addEventListener('resize', measure);
    return () => {
      resize?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [count]);
  return { ref, tight };
}

export function BottomPanel({
  tabs,
  value,
  onChange,
  height = 150,
  className = '',
}: {
  tabs: BottomTab[];
  /** Controlled selection. Leave out and the panel keeps its own. */
  value?: string;
  onChange?: (key: string) => void;
  /** Panel height in px. Grows with the pane when `height` is 0. */
  height?: number;
  className?: string;
}) {
  const current = value ?? tabs[0]?.key;
  const shown = tabs.find((t) => t.key === current) ?? tabs[0];
  // One tab stop for the row, arrows between the tabs, and every tab naming
  // the panel under it. There is one panel whose contents swap, not four, so
  // every tab names the same one.
  const panelId = `bottom-panel-${useId().replace(/[^\w-]/g, '')}`;
  const keyboard = useTabs({
    keys: tabs.map((t) => t.key),
    value: current ?? '',
    onChange: (key) => onChange?.(key),
    controls: panelId,
    label: 'Panel under the code',
  });
  const fit = useTabRowFit(tabs.length);
  return (
    <div
      data-testid="bottom-panel"
      className={`flex shrink-0 flex-col overflow-hidden border-t-1.5 border-edge bg-surface ${className}`}
      style={height ? { height } : undefined}
    >
      <div
        {...keyboard.tablistProps}
        ref={fit.ref}
        {...(fit.tight ? { 'data-tight': 'true' } : null)}
        className="flex shrink-0 overflow-x-auto border-b-1.5 border-edge text-[12px] font-semibold"
      >
        {tabs.map((t) => {
          const on = t.key === current;
          return (
            <button
              key={t.key}
              type="button"
              {...keyboard.tabProps(t.key)}
              data-testid={t.testId}
              className={`-mb-[1.5px] whitespace-nowrap border-b-2 ${fit.tight ? 'px-2.5' : 'px-3.5'} py-[7px] transition-colors ${
                on ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.label}
              {t.count !== undefined && <span className="mono ml-1.5 text-[11.5px]">{t.count}</span>}
            </button>
          );
        })}
      </div>
      {shown && (
        <div {...keyboard.panelProps(shown.key)} className="min-h-0 flex-1 overflow-auto">
          {shown.content}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   StatusBar, the 26px line of facts under everything.
--------------------------------------------------------------------------- */
export function StatusBar({
  branch = 'main',
  /**
   * False when live updates are not arriving: the socket is away. Polling
   * still is, so this is a pip beside the branch rather than an error.
   */
  live = true,
  language,
  line,
  col,
  problems,
  hidden,
  clock,
  /** "Saved", "Saving…", "Unsaved". The word alone; the time is separate. */
  saveState = 'Saved',
  savedAt,
  className = '',
}: {
  branch?: string;
  live?: boolean;
  language?: string;
  line?: number;
  col?: number;
  problems?: number;
  /** "Hidden 5 of 10": how the hidden suite stood at the last submission. */
  hidden?: string;
  /**
   * "clock 2026-03-01" or "clock machine", which day the sandbox will call
   * today in this phase. A learner reading a surprising result
   * can see the clock that produced it without opening a pane.
   */
  clock?: string;
  saveState?: string;
  savedAt?: string;
  className?: string;
}) {
  // Save feedback stays visible while optional facts scroll independently.
  // Keep the metadata region focusable so its full contents are reachable with
  // native horizontal-scroll keys as well as a pointer or touch gesture.
  const seg = 'shrink-0';
  return (
    <div
      data-testid="status-bar"
      className={`mono flex h-[26px] shrink-0 items-center overflow-hidden whitespace-nowrap border-t-1.5 border-edge bg-surface px-3.5 text-[11.5px] text-muted ${className}`}
    >
      <div
        data-testid="status-metadata"
        role="region"
        aria-label="Workspace status details"
        tabIndex={0}
        className="flex h-full min-w-0 flex-1 items-center gap-4 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className={`${seg} inline-flex items-center gap-1.5`}>
          <StatusSquare state="now" size={9} />
          {branch}
        </span>
        {!live && (
          <span
            data-testid="live-paused"
            title="Live updates are paused. Results still arrive, a little later."
            className={`${seg} inline-flex items-center gap-1.5 text-warn`}
          >
            <StatusSquare state="warn" size={9} />
            Live updates paused
          </span>
        )}
        {language && <span className={seg}>{language}</span>}
        {line !== undefined && (
          <span className={seg}>
            Ln {line}
            {col !== undefined ? `, Col ${col}` : ''}
          </span>
        )}
        {/* The spacer may shrink to nothing; the words either side of it may
            not. */}
        <span className="min-w-0 flex-1" aria-hidden />
        {/* Always drawn, "0 problems" included: a segment that appears only when
            there is bad news reads as an error rather than as a standing. */}
        {problems !== undefined && (
          <span className={`${seg} ${problems > 0 ? 'text-fail' : ''}`}>
            {`${problems} ${pluralWord(problems, 'problem')}`}
          </span>
        )}
        {hidden && <span className={seg}>{hidden}</span>}
        {clock && (
          <span className={seg} data-testid="status-clock">
            {clock}
          </span>
        )}
      </div>
      {(saveState || savedAt) && (
        <div data-testid="status-save-group" className="flex h-full shrink-0 items-center gap-3 pl-3">
          {saveState && <span className={seg} data-testid="save-state">{saveState}</span>}
          {savedAt && <span className={seg} data-testid="save-time">{savedAt}</span>}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   InlineNote, the card Monaco draws between two lines of code.
--------------------------------------------------------------------------- */
export interface NoteChoice {
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}

export function InlineNote({
  tone = 'warn',
  label,
  text,
  test,
  onExplain,
  explainHref,
  choices,
  className = '',
  testId,
}: {
  /** warn for a contradicted contract, fail for a criterion not met, neutral for an unlinked line. */
  tone?: 'warn' | 'fail' | 'neutral';
  /** The chip: "Contract", "US-3.3", "Not linked". */
  label: string;
  /** What is wrong, in one or two sentences. */
  text: React.ReactNode;
  /** The test that says so, in mono. */
  test?: string;
  onExplain?: () => void;
  explainHref?: string;
  /** Criterion chips to pick from, when the line is not linked to one yet. */
  choices?: NoteChoice[];
  className?: string;
  testId?: string;
}) {
  const border = tone === 'fail' ? 'border-fail' : tone === 'warn' ? 'border-warn' : 'border-edge2';
  return (
    <div
      data-testid={testId ?? 'inline-note'}
      className={`mx-3 my-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-chip border-1.5 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink ${border} ${className}`}
    >
      <Chip tone={tone === 'neutral' ? 'outline' : tone}>{label}</Chip>
      <span className="wrap min-w-0 flex-1">{text}</span>
      {choices && choices.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          {choices.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.onSelect}
              aria-pressed={c.selected}
              className={`chip transition-colors ${c.selected ? 'chip-accent' : 'chip-outline hover:bg-raised'}`}
            >
              {c.label}
            </button>
          ))}
        </span>
      )}
      {test && <span className="mono shrink-0 text-[11.5px] text-muted">{test}</span>}
      {(onExplain || explainHref) &&
        (explainHref ? (
          <Link href={explainHref} className="shrink-0 text-[12.5px] font-semibold text-accent hover:underline">
            Explain
          </Link>
        ) : (
          <button type="button" onClick={onExplain} className="shrink-0 text-[12.5px] font-semibold text-accent hover:underline">
            Explain
          </button>
        ))}
    </div>
  );
}
