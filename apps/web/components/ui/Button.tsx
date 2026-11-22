'use client';

import Link from 'next/link';
import { useId } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { prefetchable } from './navigation';

/* ---------------------------------------------------------------------------
   Button: the one control, in three weights, optionally carrying its key.

   The design draws the shortcut inside the button ("Run tests ⌘⇧↵") rather
   than in a tooltip, so the key is learned by the people who use the button.
--------------------------------------------------------------------------- */
export function Button({
  children,
  variant = 'primary',
  keys,
  href,
  onClick,
  type = 'button',
  disabled,
  busy = false,
  busyLabel,
  size = 'md',
  icon,
  className = '',
  testId,
  title,
  ariaLabel,
  reason,
}: {
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** The shortcut drawn inside the button, e.g. "⌘⇧↵". */
  keys?: string;
  /** Renders a link instead of a button. */
  href?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  /** Working. The button says what it is doing instead of what it will do. */
  busy?: boolean;
  /** What to say while busy: "Running 4 tests". Defaults to the label. */
  busyLabel?: React.ReactNode;
  /** md is the 42px control; sm the 34px one for phase strips and tables. */
  size?: 'md' | 'sm';
  icon?: IconName;
  className?: string;
  testId?: string;
  title?: string;
  ariaLabel?: string;
  /**
   * Why the button is off, in one sentence: "Write a story first", "Nothing
   * to export yet". A disabled control that says nothing is a dead end, so
   * this rides as the button's tooltip and as its description, and pages that
   * can show it beside the control should do that as well.
   */
  reason?: string;
}) {
  const describedBy = useId();
  const base =
    variant === 'secondary'
      ? 'btn-secondary'
      : variant === 'ghost'
        ? 'btn-ghost'
        : variant === 'danger'
          ? 'btn-danger'
          : 'btn';
  // Busy is its own look, not a dimmed primary: a disabled control says "you
  // may not", and a running one says "I am already doing it".
  const cls = `${base} ${size === 'sm' ? 'btn-sm' : ''} ${busy ? '!border-transparent !bg-tint !text-accent' : ''} ${className}`;
  const body = busy ? (
    <>
      <Icon name="refresh" size={size === 'sm' ? 14 : 15} className="shrink-0 animate-spin-slow" />
      {busyLabel ?? children}
    </>
  ) : (
    <>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 15} className="shrink-0" />}
      {children}
      {keys && <kbd className="kbd btn-kbd">{keys}</kbd>}
    </>
  );
  if (href && !disabled && !busy) {
    return (
      <Link
        href={href}
        prefetch={prefetchable(href) ? undefined : false}
        className={cls}
        data-testid={testId}
        title={title}
        aria-label={ariaLabel}
      >
        {body}
      </Link>
    );
  }
  // The reason is only true while the button is actually off, and a disabled
  // control is not in the tab order, so the description has to be attached to
  // the element rather than left for focus to find.
  const off = Boolean(disabled) && !busy;
  const explained = off && Boolean(reason);
  return (
    <>
      <button
        type={type}
        onClick={onClick}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={explained ? describedBy : undefined}
        className={cls}
        data-testid={testId}
        title={explained ? (title ? `${title} — ${reason}` : reason) : title}
        aria-label={ariaLabel}
      >
        {body}
      </button>
      {explained && (
        <span id={describedBy} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}
