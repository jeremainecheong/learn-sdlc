'use client';
import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import { codeFragments } from './CodeText';

export interface ToggleOption<V extends string> {
  value: V;
  /** The button's words; also used in the spoken summary. */
  label: string;
  /** Draw the words in code type: `true` for the whole label (a typed
   * payload), or the fragments of it that are code. A word holding `--`,
   * `<=` and the like is code type anyway (CodeText.tsx). */
  code?: true | readonly string[];
}

interface ToggleSetBase<V extends string> {
  /** The group's name, read out and used to start the summary line. */
  label: string;
  options: readonly ToggleOption<V>[];
  /** The summary line is always in the page for screen readers; `visible` also draws it. */
  summary?: 'hidden' | 'visible';
  className?: string;
}
export interface SingleToggleSetProps<V extends string> extends ToggleSetBase<V> {
  multiple?: false;
  value: V;
  onChange: (value: V) => void;
}
export interface MultiToggleSetProps<V extends string> extends ToggleSetBase<V> {
  multiple: true;
  value: readonly V[];
  onChange: (value: V[]) => void;
}
export type ToggleSetProps<V extends string> = SingleToggleSetProps<V> | MultiToggleSetProps<V>;

/** The sentence a ToggleSet says about its state (exported for tests and for
 * figures that want to repeat it). */
export function toggleSummary<V extends string>(props: ToggleSetProps<V>): string {
  if (props.multiple) {
    const on = props.options.filter((option) => props.value.includes(option.value));
    return `${props.label}: ${on.length} of ${props.options.length} on.`;
  }
  const chosen = props.options.find((option) => option.value === props.value);
  const words = chosen ? chosen.label : 'none chosen';
  // A label that is a sentence keeps its own stop: "Looks good to me." is
  // not read with two.
  return `${props.label}: ${words}${/[.?!]$/.test(words) ? '' : '.'}`;
}

/** A row of `aria-pressed` buttons that drives a figure's state, single or
 * multiple choice. Tab reaches each button, Space or Enter presses it, and the
 * arrow keys, Home and End move between buttons inside the group. A pressed
 * button also draws a tick, and a polite summary line says the state in words. */
export function ToggleSet<V extends string>(props: MultiToggleSetProps<V>): ReactElement;
export function ToggleSet<V extends string>(props: SingleToggleSetProps<V>): ReactElement;
export function ToggleSet<V extends string>(props: ToggleSetProps<V>): ReactElement {
  const { label, options, summary = 'hidden', className } = props;
  const group = useRef<HTMLDivElement>(null);
  const pressed = (value: V) => (props.multiple ? props.value.includes(value) : props.value === value);
  const press = (value: V) => {
    if (props.multiple) {
      const next = props.value.includes(value) ? props.value.filter((item) => item !== value) : [...props.value, value];
      // Keep the options' order, whatever order they were pressed in.
      props.onChange(options.map((option) => option.value).filter((item) => next.includes(item)));
    } else if (props.value !== value) props.onChange(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(group.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % buttons.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : null;
    if (to === null) return;
    event.preventDefault();
    // A ToggleSet inside a StepThrough keeps its arrows to itself.
    event.stopPropagation();
    buttons[to].focus();
  };
  return (
    <div className={className}>
      <div ref={group} role="group" aria-label={label} className="fig-toggles" onKeyDown={onKeyDown}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="fig-button"
            aria-pressed={pressed(option.value)}
            onClick={() => press(option.value)}
          >
            {pressed(option.value) && (
              <svg className="fig-toggle-tick" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {option.code === true ? <code className="code-fragment">{option.label}</code> : codeFragments(option.label, option.code)}
          </button>
        ))}
      </div>
      <p className={summary === 'visible' ? 'fig-toggles-summary' : 'sr-only'} aria-live="polite">
        {toggleSummary(props)}
      </p>
    </div>
  );
}
