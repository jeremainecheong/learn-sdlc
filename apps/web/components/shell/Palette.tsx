'use client';

/**
 * ⌘K, the one search across everything the learner has: their criteria,
 * their code, the tests that hold it, the artefacts, and the few verbs
 * (run, submit, sign out). The rail's links are the slow way to say the same
 * thing; typing three letters of a criterion is the fast one.
 *
 * Rows are grouped by what they are, and each carries the outcome on the
 * right ("passing", "open file", "explain") so the list answers the
 * question before you press Enter.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { capitalise } from '@/lib/capitalise';
import { shortcutWord } from '@/lib/keys';
// The project rows are the unfolded project map, and it is
// fetched when the palette is opened rather than on every landing.
import { ensureFullMap } from '@/lib/project-map';
import { useProjectMaybe } from '@/lib/useProject';
import { Icon } from '@/components/Icon';
import { Kbd, PhaseMark, useEdgeFade } from '@/components/ui';
import { ShellDialog } from './ShellDialog';
import type { PaletteGroup, PaletteItem } from './types';

function matches(item: PaletteItem, q: string): boolean {
  return `${item.label} ${item.detail ?? ''} ${item.hint ?? ''} ${item.keywords ?? ''}`
    .toLowerCase()
    .includes(q);
}

/**
 * The outcome word at the right of a row, written the way the rest of the
 * product writes it.
 *
 * The sources hand over "open", "passing", "open file" and "you are here";
 * everywhere else a state is a capitalised word (`STATUS_WORD` on /dossier
 * and /complete), with no pipes, middle dots or lower-case fragments as
 * labels. Capitalising here rather than in each
 * source means one rule for every row, whichever room built it. A hint that is
 * already a shortcut (⌘B, ⌃B) is left alone.
 */
export function outcomeWord(hint: string): string {
  if (!hint || !/^[a-z]/.test(hint)) return hint;
  return capitalise(hint);
}

/** Rows one group may show. The list stays readable; the search still sees all of it. */
export const PALETTE_GROUP_CAP = 12;

/**
 * The groups a query leaves, each capped for the eye.
 *
 * The cap is applied **after** the filter, and that is the whole point: the
 * sources hand over the whole list. A pre-truncated list would, with a
 * five-story backlog, hold only US-1 and US-2 among its first twelve criteria,
 * and typing "overdue", the example in `lib/palette.ts`'s own doc comment,
 * would answer with nothing at all.
 * A palette that searches only what it would have shown anyway is a list, not
 * a search.
 */
export function visibleGroups(
  groups: PaletteGroup[],
  query: string,
  cap = PALETTE_GROUP_CAP,
): { kept: PaletteGroup[]; flat: PaletteItem[] } {
  const q = query.trim().toLowerCase();
  const kept = groups
    .map((g) => ({
      label: g.label,
      items: (q ? g.items.filter((it) => matches(it, q)) : g.items).slice(0, cap),
    }))
    .filter((g) => g.items.length > 0);
  const flat: PaletteItem[] = [];
  for (const g of kept) flat.push(...g.items);
  return { kept, flat };
}

export function Palette({
  groups,
  /** Rendered instead of the standard trigger. Pass null for no trigger at all. */
  trigger,
  placeholder = 'Search pages and your project',
}: {
  groups: PaletteGroup[];
  trigger?: React.ReactNode | null;
  placeholder?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [word, setWord] = useState('⌘K');
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const keyboardSelection = useRef(true);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const rowId = (i: number) => `${listId}-row-${i}`;

  useEffect(() => setWord(shortcutWord('K')), []);

  /**
   * What ⌘K finds beyond the phases and the verbs (the learner's criteria,
   * code, tests and artefacts) is the unfolded project map, 26 KB of it. The
   * landing has no business paying for that (e2e/render-cost.spec.ts, "landing
   * on Home does not prefetch the journal"), and nobody presses ⌘K in the first
   * seconds of one, so it is asked for here, the first time the palette opens,
   * and held for the session. Outside the signed-in shell there is no project
   * and this does nothing.
   */
  const project = useProjectMaybe();
  const slug = project?.slug;
  useEffect(() => {
    if (open) ensureFullMap(slug);
  }, [open, slug]);

  // The visible groups, and the same rows flattened once so the arrow keys and
  // Enter address exactly what the eye sees.
  const shown = useMemo(() => visibleGroups(groups, query), [groups, query]);
  /* The list is taller than its box on every real query, and at rest the row
     at the bottom edge would be sliced through its second line by the footer's
     rule. The edge that has more behind it fades, so a part row reads as more
     list. */
  const listFade = useEdgeFade(listRef as React.RefObject<HTMLElement | null>, [shown.flat.length, query], 'y');

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setAt(0);
  }, []);

  const run = useCallback(
    (item: PaletteItem) => {
      if (item.disabled) return;
      close();
      if (item.onSelect) item.onSelect();
      else if (item.href) router.push(item.href);
    },
    [close, router],
  );

  // ⌘K both ways. Closing goes through `close()` like every other exit, or
  // the query survives into the next opening and focus never goes home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!open && document.querySelector('dialog[open]:not(.chat-surface), .chat-surface[aria-modal="true"], [role="dialog"][aria-modal="true"]')) return;
        e.preventDefault();
        if (open) {
          close();
          return;
        }
        opener.current = document.activeElement as HTMLElement;
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !keyboardSelection.current) return;
    listRef.current?.querySelector<HTMLElement>(`[data-testid="palette-row-${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, at, shown.flat.length, query]);

  let index = -1;

  return (
    <>
      {trigger === undefined ? (
        <button
          type="button"
          onClick={(e) => {
            opener.current = e.currentTarget;
            setOpen(true);
          }}
          data-testid="jump-to"
          aria-haspopup="dialog"
          title="Jump to anything"
          className="hidden h-[30px] shrink-0 items-center gap-2 rounded-ctl border-1.5 border-edge2 bg-surface px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:text-ink md:inline-flex"
        >
          <Icon name="search" size={14} className="text-muted" />
          Jump to
          <Kbd>{word}</Kbd>
        </button>
      ) : (
        trigger !== null && (
          <span
            onClickCapture={(e) => {
              opener.current = (e.target as Element).closest<HTMLElement>('button, a[href], [tabindex]');
              setOpen(true);
            }}
          >
            {trigger}
          </span>
        )
      )}

      <ShellDialog open={open} onClose={close} returnFocus={opener} label="Jump to" testId="palette" className="shell-search-dialog">
          <div className="shell-search-content"
            onKeyDown={(e) => {
              if (e.target !== inputRef.current) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                keyboardSelection.current = true;
                setAt((i) => Math.max(0, Math.min(shown.flat.length - 1, i + 1)));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                keyboardSelection.current = true;
                setAt((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter' && shown.flat[at]) {
                e.preventDefault();
                run(shown.flat[at]);
              }
            }}
          >
            <div className="shell-search-head">
              <Icon name="search" size={18} className="text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  keyboardSelection.current = true;
                  setAt(0);
                }}
                placeholder={placeholder}
                aria-label={placeholder}
                data-testid="palette-input"
                /* The rows are the listbox and this is the box that drives it:
                   focus stays here while the arrows move a highlight, which is
                   what `aria-activedescendant` is for. */
                role="combobox"
                aria-expanded={shown.flat.length > 0}
                aria-autocomplete="list"
                aria-controls={shown.flat.length > 0 ? listId : undefined}
                aria-activedescendant={shown.flat[at] ? rowId(at) : undefined}
                /* The query is plain text with a caret, as the design draws
                   it: the dialog is already the focus context, so the global
                   ring would only draw a field around something that is not
                   one. */
                className="w-full min-w-0 border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted focus-visible:outline-none"
              />
              <button type="button" className="shell-icon-button" aria-label="Close search" title="Close search" onClick={close}><Icon name="cross" size={18} /></button>
            </div>

            <div
              id={listId}
              /* Nothing matching is not an empty list, it is no list: the role
                 goes away with the rows rather than announcing a listbox whose
                 only child is a sentence. */
              role={shown.flat.length > 0 ? 'listbox' : undefined}
              aria-label={shown.flat.length > 0 ? 'Results' : undefined}
              /* `scroll-py-2` keeps a whole row clear of the two rules the
                 list sits between, so a half-scrolled list never ends
                 with a row sliced through its second line by the footer's
                 top edge. */
              ref={listRef}
              className={`shell-search-results scroll-py-2 px-1.5 pb-2 pt-1 ${listFade}`}
            >
              {shown.kept.length === 0 ? (
                <p className="px-3 py-6 text-[13px] text-muted" role="status">No matches. Try a page, phase, file or requirement.</p>
              ) : (
                shown.kept.map((g) => (
                  <div key={g.label} role="group" aria-label={g.label}>
                    <p aria-hidden className="label-sm block px-3 pb-1 pt-2.5">
                      {g.label}
                    </p>
                    {g.items.map((it) => {
                      index += 1;
                      const i = index;
                      const on = i === at;
                      return (
                        <button
                          key={`${g.label}-${it.label}-${i}`}
                          type="button"
                          /* An option is pointed at, not tabbed to: the rows
                             were 40 tab stops that walked straight out of the
                             dialog. Mouse and Enter still open them. */
                          role="option"
                          id={rowId(i)}
                          tabIndex={-1}
                          onMouseEnter={() => { keyboardSelection.current = false; setAt(i); }}
                          onClick={() => run(it)}
                          data-testid={`palette-row-${i}`}
                          aria-selected={on}
                          aria-disabled={it.disabled || undefined}
                          className={`shell-search-row grid w-full grid-cols-[24px_1fr_auto] items-center gap-2 rounded-ctl px-3 py-2 text-left transition-colors ${
                            on ? 'bg-tint' : 'hover:bg-raised'
                          }`}
                        >
                          {it.phaseKey ? (
                            <PhaseMark phaseKey={it.phaseKey} size={20} numeral={it.place} />
                          ) : (
                            <Icon name={it.icon ?? 'arrow-right'} size={16} className={on ? 'text-accent' : 'text-muted'} />
                          )}
                          <span className="flex min-w-0 flex-col gap-px">
                            <span className="truncate text-[13.5px] font-medium text-ink">{it.label}</span>
                            {it.detail && <span className="label-sm truncate">{it.detail}</span>}
                          </span>
                          {it.hint && (
                            <span className="shell-search-hint mono shrink-0 text-[11px] text-muted">
                              {it.disabled && <Icon name="lock" size={12} />}
                              {outcomeWord(it.hint)}
                            </span>
                          )}
                        </button>
                      );
                    })
                  }
                  </div>
                ))
              )}
            </div>

            <div className="shell-search-footer">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↑↓</Kbd> Move
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↵</Kbd> Open
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>esc</Kbd> Close
              </span>
            </div>
          </div>
      </ShellDialog>
    </>
  );
}
