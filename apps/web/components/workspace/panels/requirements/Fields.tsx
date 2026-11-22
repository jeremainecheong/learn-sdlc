'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { STORY_CAPS } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';

/**
 * The longest text one field of the story record may hold, as the workspace
 * save validates it. Typing stops there and a paste is cut to it, so the form
 * never builds a record the save refuses.
 */
export const FIELD_CAP = STORY_CAPS.fieldChars;
const capped = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/**
 * The typing surfaces the issue is written on, shared by the issue page and by
 * the narrow editor in the IDE rail. Nothing here derives anything: they take a
 * value and give back the next one.
 */

/** Grow a textarea to its content, so a criterion is never clipped mid-word. */
function useAutoHeight(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    // A retained dialog or workspace panel has no geometry while hidden.
    // Keep its last useful height until opening gives it a measurable width.
    if (!el || el.clientWidth === 0) return;
    el.style.height = 'auto';
    const style = getComputedStyle(el);
    const adjustment = style.boxSizing === 'border-box'
      ? (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      : -(parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    el.style.height = `${el.scrollHeight + adjustment}px`;
  }, []);
  useEffect(fit, [fit, value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let previousWidth = 0;
    let frame: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      // Only width changes matter. Defer the height write so it cannot create
      // a skipped resize observation in the current delivery cycle.
      if (width === previousWidth) return;
      previousWidth = width;
      if (width > 0 && frame === null) frame = requestAnimationFrame(() => {
        frame = null;
        fit();
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fit]);
  return ref;
}

/** A labelled box. The label stays put, so nothing depends on a placeholder. */
export function Box({
  id,
  label,
  value,
  onChange,
  placeholder,
  testId,
  rows = 2,
  minHeight,
  maxLength = FIELD_CAP,
  note,
}: {
  id: string;
  label: string;
  /** Drawn beside the label: a mark about this field, such as who last changed it. */
  note?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
  rows?: number;
  /** The mockup's 36px single line and 64px paragraph. */
  minHeight?: number;
  maxLength?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {note ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
          <label htmlFor={id} className="label-sm font-medium">
            {label}
          </label>
          {note}
        </div>
      ) : (
        <label htmlFor={id} className="label-sm font-medium">
          {label}
        </label>
      )}
      {rows === 1 ? (
        <input
          id={id}
          data-testid={testId}
          className="field text-[13.5px]"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(e) => onChange(capped(e.target.value, maxLength))}
        />
      ) : (
        <textarea
          id={id}
          data-testid={testId}
          className="field resize-y text-[13.5px] leading-[1.45]"
          rows={rows}
          style={minHeight ? { minHeight } : undefined}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(e) => onChange(capped(e.target.value, maxLength))}
        />
      )}
    </div>
  );
}

/**
 * One clause of a criterion: the word is the label and the sentence sits next
 * to it, unboxed until you touch it. A criterion reads as prose on the page and
 * turns into a field under the cursor.
 */
export function Clause({
  id,
  word,
  value,
  onChange,
  placeholder,
  testId,
  boxed = false,
  maxLength = FIELD_CAP,
}: {
  id: string;
  word: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
  /** The rail's older look: a bordered field on every line. */
  boxed?: boolean;
  maxLength?: number;
}) {
  const ref = useAutoHeight(value);
  return (
    // A textarea, not an input: a criterion is a sentence, and in the rail a
    // single line clipped it mid-word with no way to read the rest back.
    <div className="grid min-w-0 grid-cols-[44px_1fr] items-start gap-x-2.5">
      <label htmlFor={id} className={`label-sm font-semibold text-muted ${boxed ? 'pt-1.5' : 'pt-0.5'}`}>
        {word}
      </label>
      <textarea
        id={id}
        ref={ref}
        data-testid={testId}
        rows={1}
        className={
          boxed
            ? 'field min-w-0 resize-y py-1.5 text-[13px] leading-[1.45]'
            : // A ring, not a border: a border on every clause would add three lines
              // of chrome to a card the design draws as three sentences.
              'min-w-0 resize-none overflow-hidden rounded-[6px] bg-transparent px-1.5 py-0 text-[13px] leading-[1.45] text-ink outline-none transition-shadow placeholder:text-muted hover:ring-[1.5px] hover:ring-edge focus:bg-ground focus:ring-[1.5px] focus:ring-accent'
        }
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(capped(e.target.value, maxLength))}
      />
    </div>
  );
}

/**
 * A line that grows into a paragraph. An exclusion is a sentence like a clause
 * is, and an `input` clipped it mid-word with no way to read the rest back.
 */
export function GrowRow({
  id,
  value,
  onChange,
  placeholder,
  testId,
  variant = 'body',
  className = '',
  maxLength = FIELD_CAP,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
  variant?: 'body' | 'title';
  className?: string;
  maxLength?: number;
}) {
  const ref = useAutoHeight(value);
  return (
    <textarea
      id={id}
      ref={ref}
      data-testid={testId}
      rows={1}
      className={`min-w-0 flex-1 resize-none overflow-hidden rounded-[6px] bg-transparent px-1.5 py-0.5 ${variant === 'title' ? 'h2 leading-[1.3]' : 'text-[13px] leading-[1.45]'} text-ink outline-none transition-shadow placeholder:text-muted hover:ring-[1.5px] hover:ring-edge focus:bg-ground focus:ring-[1.5px] focus:ring-accent ${className}`}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(capped(e.target.value, maxLength))}
    />
  );
}

export function IconButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: 'arrow-up' | 'arrow-down' | 'trash';
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn-ghost requirement-icon-action h-6 w-6 px-0"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}

/** The dashed row that ends a list: one more criterion, one more exclusion. */
export function AddRow({
  label,
  onClick,
  testId,
  disabled = false,
  title,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  /** The list is full. */
  disabled?: boolean;
  /** Why it is disabled. */
  title?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex w-full items-center gap-2.5 rounded-ctl border-1.5 border-dashed border-edge2 px-3 py-2.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-edge2 disabled:hover:text-muted"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <Icon name="arrow-right" size={14} />
      {label}
    </button>
  );
}
