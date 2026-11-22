'use client';

/**
 * A confirm dialog for the staff surfaces (deep
 * validation's start, the bulk sign-off).
 *
 * It keeps the three promises `useDialogFocus` describes, and the two it
 * leaves to the caller:
 *
 * - **Focus goes in.** On open, to the first control that can take it, or to
 *   the dialog itself while every control is still off.
 * - **Focus stays in.** Tab and Shift+Tab wrap at the edges (`useDialogFocus`).
 *   A press on the backdrop is cancelled, so it cannot drop focus to `<body>`
 *   (from there Tab would walk the page behind and Escape would not reach the
 *   dialog), and the page behind is `inert` while the dialog is open:
 *   everything beside the dialog, up to `<body>`, is marked on open and
 *   given back exactly as it was on close.
 * - **Focus comes back.** On close, to the control that opened it, after the
 *   page behind is given back (a browser will not focus an inert element).
 * - **Escape closes**, unless the caller says the dialog is mid-save.
 * - **It is labelled and described**: `aria-labelledby` its title and, where
 *   the caller names one, `aria-describedby` the sentence it asks about.
 *
 * It is drawn in the page rather than in the top layer, so it renders under
 * jsdom as it does in a browser; the backdrop covers the page behind it. The
 * backdrop never closes the dialog, at any time: only Escape or the caller's
 * own buttons do.
 */
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { useDialogFocus } from '@/components/ui';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';


const FIRST_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

export function StaffDialog({
  title,
  describedBy,
  onClose,
  closable = true,
  returnFocus,
  testId,
  children,
}: {
  title: string;
  /** The id of the sentence the dialog asks about, when there is one. */
  describedBy?: string;
  onClose: () => void;
  /** False while the dialog is mid-save: Escape does nothing. (The backdrop never closes it.) */
  closable?: boolean;
  /** Where focus goes back to; by default, whatever had it when the dialog opened. */
  returnFocus?: RefObject<HTMLElement | null>;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const trap = useDialogFocus(ref, true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** The elements this dialog made inert, and nothing else. */
  const markedRef = useRef<Element[]>([]);
  /** Where focus goes back to on close. */
  const previousRef = useRef<HTMLElement | null>(null);
  const giveBack = () => {
    for (const one of markedRef.current.splice(0)) one.removeAttribute('inert');
  };

  // The page behind is out of reach while the dialog is open.
  // Each element beside the path from the backdrop to <body> is made inert,
  // unless it already was (elements added later are marked too); on close only
  // the ones marked here are given back.
  // This effect is declared before the focus one so its cleanup
  // runs first (React runs them in order), and the focus cleanup gives the
  // page back too: a browser will not focus an inert opener.
  useIsoLayoutEffect(() => {
    // Who had focus is taken before anything is marked, so a browser's own
    // fix-up of an inert focused element can never be what is remembered.
    previousRef.current =
      returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const marked = markedRef.current;
    const path: Element[] = [];
    const mark = (one: Element) => {
      if (path.includes(one) || one.hasAttribute('inert')) return;
      one.setAttribute('inert', '');
      marked.push(one);
    };
    for (let at: Element | null = backdropRef.current; at && at !== document.body; at = at.parentElement) {
      path.push(at);
    }
    for (const at of path) for (const sibling of at.parentElement?.children ?? []) mark(sibling);
    // What is added beside the path while the dialog is
    // open (a toast, a portal, a control a poll draws) is marked too, and given back.
    const watch =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            for (const record of records) {
              for (const added of record.addedNodes) if (added instanceof Element) mark(added);
            }
          });
    for (const at of path) if (at.parentElement) watch?.observe(at.parentElement, { childList: true });
    return () => {
      watch?.disconnect();
      giveBack();
    };
    // Opening is the one moment this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useIsoLayoutEffect(() => {
    const previous = previousRef.current;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>(FIRST_FOCUSABLE);
    (first ?? node)?.focus();
    return () => {
      giveBack();
      if (previous?.isConnected) previous.focus();
    };
    // Opening is the one moment this runs; a re-render inside must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      // A press on the backdrop itself keeps focus where it is.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        data-testid={testId}
        className="panel flex max-h-[90vh] w-full max-w-[520px] min-w-0 flex-col gap-3 overflow-auto bg-surface p-4 outline-none sm:p-5"
        onKeyDown={(event) => {
          trap.onKeyDown(event);
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (closable) closeRef.current();
          }
        }}
      >
        <h2 id={titleId} className="m-0 text-[15px] font-semibold text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
