'use client';

/**
 * The five steps of the Requirements builder, in a row above the cards.
 *
 * A step is marked done from what the server holds, never from what a card
 * holds unsaved, so the bar and the learner's room never disagree. The step
 * being worked on is marked as the current one. There is no count of steps
 * done and no score: the bar says where the work is, not how good it is.
 *
 * Every builder draws this row (Requirements, Design, Implementation,
 * Testing, Deployment, Maintenance). Each step is a link to its card's head;
 * the card's scroll margin (`.tre-card`) is the sticky tab bar's measured
 * height and a gap, so the head lands below the bar.
 *
 * Where the tab's task card draws its "Needs your sign-off" box, the row is
 * followed by one more entry, "Sign-off": the box sits at the end of a
 * long card, several screens down, and the step link reaches only the card's
 * head. The entry brings the box into view, below the bar, with the keyboard
 * focus on it, and marks the box's row for a moment; it never ticks it. On a version that cannot change no box is
 * drawn, so neither is the entry.
 */
import { Icon } from '@/components/Icon';
import { signOffBoxId } from '../TaskEditor';

export interface BuilderStep {
  n: number;
  label: string;
  done: boolean;
}

/**
 * Bring a task's sign-off box into view and put the focus on it, without
 * changing it: the one rule every builder's Sign-off entry runs. The box's
 * row (box and label) is scrolled to the middle of the view at once (no
 * animation), so it is wholly visible and well below the sticky bar however
 * tall the bar has wrapped; the focus then goes to the checkbox without a
 * second scroll. Answers false when the box is not on the page.
 */
export function revealSignOff(taskKey: string): boolean {
  if (typeof document === 'undefined') return false;
  const box = document.getElementById(signOffBoxId(taskKey));
  if (!(box instanceof HTMLInputElement)) return false;
  const row = box.closest<HTMLElement>('[data-testid^="task-signoff-box-"]') ?? box;
  if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  box.focus({ preventScroll: true });
  markLanded(row);
  return true;
}

/** The attribute that marks the row a Sign-off press landed on; its rule in requirements-builder.css draws it. */
export const SIGN_OFF_LANDED_ATTR = 'data-signoff-landed';
/** How long the mark stays, unless the next press anywhere takes it off first. */
export const SIGN_OFF_LANDED_MS = 2000;

/** The one row marked now, and how its mark comes off. */
let landed: { row: HTMLElement; clear: () => void } | null = null;

/**
 * Mark the row a Sign-off press landed on, for a moment. The browser
 * draws no focus ring after a pointer press, so without a mark nothing on the
 * screen says where the press landed. The mark is an attribute the stylesheet
 * draws as a plain outline and tint, with no animation; it comes off after
 * `SIGN_OFF_LANDED_MS` or at the next press anywhere (a pointer or a key),
 * whichever is first. Taking it off only removes the attribute: it never moves
 * the focus or the scroll, ticks nothing and sends nothing.
 */
function markLanded(row: HTMLElement): void {
  landed?.clear();
  row.setAttribute(SIGN_OFF_LANDED_ATTR, '');
  const options = { capture: true } as const;
  const clear = () => {
    window.clearTimeout(timer);
    document.removeEventListener('pointerdown', clear, options);
    document.removeEventListener('keydown', clear, options);
    row.removeAttribute(SIGN_OFF_LANDED_ATTR);
    if (landed?.row === row) landed = null;
  };
  const timer = window.setTimeout(clear, SIGN_OFF_LANDED_MS);
  document.addEventListener('pointerdown', clear, options);
  document.addEventListener('keydown', clear, options);
  landed = { row, clear };
}

export function StepBar({
  steps,
  current,
  label = 'The five steps',
  signOff = null,
}: {
  steps: BuilderStep[];
  current: number | null;
  /** The list's accessible name: the Design builder has six steps. */
  label?: string;
  /** The key of the task whose sign-off box this tab draws, or null where it draws none. */
  signOff?: string | null;
}) {
  return (
    <>
      <ol className="tre-steps" aria-label={label} data-testid="tre-steps">
        {steps.map((step) => {
          const here = current === step.n;
          const cls = ['tre-step', step.done ? 'tre-step-done' : 'tre-step-todo', here ? 'tre-step-current' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={step.n}
              className={cls}
              aria-label={`Step ${step.n}, ${step.label}, ${step.done ? 'done' : 'not yet'}`}
              aria-current={here ? 'step' : undefined}
              data-testid={`tre-step-${step.n}`}
            >
              <a className="tre-step-link" href={`#tre-step-${step.n}`}>
                <span className="tre-step-n" aria-hidden="true">
                  {step.done ? <Icon name="check" size={12} /> : step.n}
                </span>
                <span className="tre-step-l">{step.label}</span>
              </a>
            </li>
          );
        })}
      </ol>
      {signOff !== null && (
        // Not a step, so not in the list of steps: the entry after it.
        <p className="tre-step-jump" data-testid="tre-signoff-jump-row">
          <a
            className="tre-step-jump-link"
            href={`#${signOffBoxId(signOff)}`}
            data-testid="tre-signoff-jump"
            onClick={(event) => {
              // A press that opens a new tab or window is the browser's.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (revealSignOff(signOff)) event.preventDefault();
            }}
          >
            <Icon name="arrow-down" size={12} />
            Sign-off
          </a>
        </p>
      )}
    </>
  );
}
