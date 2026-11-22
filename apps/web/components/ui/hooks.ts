'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

/* ---------------------------------------------------------------------------
   useTabs: the keyboard half of a tablist.

   `role="tablist"` is a promise about the keyboard, not a decoration: one tab
   stop for the whole row, arrows to move between tabs, Home and End to the
   ends, and every tab pointing at the panel it controls. The behaviour lives
   here once and every tablist reaches for it.

   Selection follows focus, which is the right choice when switching a tab is
   free: every panel in this product is already rendered or is one cheap
   derivation away.
--------------------------------------------------------------------------- */
export interface TabsKeyboard {
  /** `id` of the tab for a key, for a panel that wants `aria-labelledby`. */
  tabId: (key: string) => string;
  /** `id` of the panel for a key, for a caller rendering its own panels. */
  panelId: (key: string) => string;
  tablistProps: {
    role: 'tablist';
    'aria-label'?: string;
    'aria-orientation'?: 'vertical';
    onKeyDown: (event: React.KeyboardEvent) => void;
  };
  tabProps: (key: string) => {
    role: 'tab';
    id: string;
    'aria-controls'?: string;
    'aria-selected': boolean;
    tabIndex: 0 | -1;
    ref: (el: HTMLElement | null) => void;
    onClick: () => void;
  };
  panelProps: (key: string) => {
    role: 'tabpanel';
    id: string;
    'aria-labelledby': string;
    tabIndex: 0;
  };
}

export function useTabs({
  keys,
  value,
  onChange,
  orientation = 'horizontal',
  /** Prefix for the generated ids. Left out, a stable generated one is used. */
  idBase,
  /** One panel for the whole tablist, when the caller renders a single panel. */
  controls,
  label,
}: {
  keys: string[];
  value: string;
  onChange: (key: string) => void;
  orientation?: 'horizontal' | 'vertical';
  idBase?: string;
  controls?: string;
  label?: string;
}): TabsKeyboard {
  const auto = useId();
  const base = idBase ?? `tabs${auto.replace(/[^\w-]/g, '')}`;
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const wantFocus = useRef(false);

  // Focus moves only after a keyboard move, never on the first paint or when
  // the selection changes from outside: stealing focus on load is rude.
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    refs.current[value]?.focus();
  }, [value]);

  const move = useCallback(
    (delta: number, absolute?: number) => {
      const n = keys.length;
      if (n === 0) return;
      const i = keys.indexOf(value);
      const next = absolute !== undefined ? absolute : ((((i < 0 ? 0 : i) + delta) % n) + n) % n;
      wantFocus.current = true;
      onChange(keys[next]);
    },
    [keys, value, onChange],
  );

  // Both axes move, whatever the orientation: the arrow that matches what the
  // eye sees is never the wrong one to press.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'Home':
          event.preventDefault();
          move(0, 0);
          break;
        case 'End':
          event.preventDefault();
          move(0, keys.length - 1);
          break;
        default:
      }
    },
    [move, keys.length],
  );

  const tabId = (key: string) => `${base}-tab-${key}`;
  const panelId = (key: string) => controls ?? `${base}-panel-${key}`;
  // A tab points at its panel only when the caller has said there is one to
  // point at: either one panel by name, or per-key panels drawn from the same
  // `idBase`. An `aria-controls` naming an element that is not on the page is
  // worse than none, and three call sites switch columns rather than a panel.
  const named = Boolean(controls || idBase);

  return {
    tabId,
    panelId,
    tablistProps: {
      role: 'tablist',
      ...(label ? { 'aria-label': label } : null),
      ...(orientation === 'vertical' ? { 'aria-orientation': 'vertical' as const } : null),
      onKeyDown,
    },
    tabProps: (key: string) => ({
      role: 'tab',
      id: tabId(key),
      ...(named ? { 'aria-controls': panelId(key) } : null),
      'aria-selected': key === value,
      tabIndex: key === value ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        refs.current[key] = el;
      },
      onClick: () => onChange(key),
    }),
    panelProps: (key: string) => ({
      role: 'tabpanel',
      id: panelId(key),
      'aria-labelledby': tabId(key),
      tabIndex: 0,
    }),
  };
}

/* ---------------------------------------------------------------------------
   useDialogFocus: the three things a dialog owes the keyboard.

   A dialog that does not hold focus is a trap of a different kind (Tab walks
   out into the page behind it, which is still there and still clickable) and
   one that unmounts without putting focus back strands the keyboard at the top
   of the document. The palette, the bell and the other dialogs keep the
   promise their `role="dialog"` makes through this one loop.

   Escape stays the caller's, because only the caller knows whether it is safe
   to close mid-save.
--------------------------------------------------------------------------- */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]',
]
  // A row the arrows drive is not a stop Tab visits: an option carrying
  // tabindex="-1" is reachable, not tabbable, and counting it as tabbable
  // would put the trap's boundary in the wrong place.
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(', ');

/* ---------------------------------------------------------------------------
   useEdgeFade: does this strip have more behind its edges?

   A row that scrolls sideways with a hard edge reads as a word cut in half,
   a tab label clipped against the border with nothing on screen to say the
   strip scrolls. The fade says it: the
   edge that has more behind it dissolves, and the edge that is at the end does
   not. Returns the class the strip wears; `edge-fade-*` are in globals.css.
--------------------------------------------------------------------------- */
export function useEdgeFade(
  ref: React.RefObject<HTMLElement | null>,
  deps: unknown[] = [],
  axis: 'x' | 'y' = 'x',
): string {
  const [fade, setFade] = useState('');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const names =
      axis === 'x'
        ? (['edge-fade-left', 'edge-fade-right', 'edge-fade-both'] as const)
        : (['edge-fade-top', 'edge-fade-bottom', 'edge-fade-y'] as const);
    const measure = () => {
      const more = axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
      const at = axis === 'x' ? el.scrollLeft : el.scrollTop;
      // 2px of slack: sub-pixel sizes report a scroll extent a hair over the
      // client size on rows that do not actually scroll.
      if (more <= 2) return setFade('');
      const before = at > 2;
      const after = at < more - 2;
      setFade(before && after ? names[2] : before ? names[0] : names[1]);
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
    // The caller's own dependencies are spread in, so the effect runs again when they change.
  }, [ref, axis, ...deps]);

  return fade;
}

export function useDialogFocus(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
): { onKeyDown: (event: React.KeyboardEvent) => void } {
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Tab' || !open) return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable) return;
      // A dialog with nothing to tab to still holds the keyboard: Tab has
      // nowhere to go inside, so it goes nowhere at all.
      if (focusable.length === 0) {
        event.preventDefault();
        ref.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // One focusable element is the common case for the palette: Tab has
      // nowhere to go, so it stays where it is rather than leaving.
      if (focusable.length === 1) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && (active === first || !ref.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [ref, open],
  );
  return { onKeyDown };
}
