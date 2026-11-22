'use client';

/**
 * The shell every step of the Requirements builder is drawn in, and the save
 * each card runs.
 *
 * A card is a numbered section with a title, one sentence on what the step
 * is for, a chip saying where the step stands (done, being worked on, not
 * yet), and a body. The chip is progress, never a grade: it reads what the
 * server holds, so a step is done once its work is saved.
 *
 * A card saves on its own button at once, or 600 ms after a field in it is
 * left. Either way it checks first what the door would refuse, and says so in
 * the card; what the door still refuses is printed word for word. A card
 * never has two saves out at once: a save asked for while one is in flight
 * runs once more after it, with what the card holds then.
 *
 * A card that goes away (the teacher opens another phase's tab) does not
 * take its work with it: a save still waiting out its 600 ms runs at once,
 * and a reply that lands after the card has gone still reaches the editor,
 * which outlives the card. Only the card's own status line is skipped.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { TaskMutationResult } from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { stepValue } from './builder-model';
import { useEditorSaveReport } from '../save-status';

/** How long a card waits after a field is left before it saves. */
export const SAVE_DELAY_MS = 600;

export type CardState = 'done' | 'current' | 'todo';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

interface CardSave {
  status: SaveStatus;
  /** The card's own refusal, or the server's sentence, or ''. */
  message: string;
  /** Record an edit: clears a stale message and arms the save on blur. */
  changed: () => void;
  /** Save now, after the card's own checks. */
  saveNow: () => Promise<void>;
  /** Save 600 ms from now, if anything changed since the last save. */
  saveSoon: () => void;
  /**
   * Send what changed since the last save now, after the card's own checks,
   * and resolve once it is answered, together with a save already in flight
   * and the run that follows it. Nothing changed and nothing out: resolves at once.
   */
  flush: () => Promise<void>;
  /** Nothing changed since the last save went out, and no save is out: the card holds what the server answered. */
  clean: () => boolean;
}

/**
 * One card's save.
 *
 * `validate` answers with the sentence that stops the save, or ''. `send` is
 * the door. The latest of both is read when the save runs, so a save that
 * fires after the delay sends what the card holds then, not what it held when
 * the field was left.
 */
export function useCardSave({
  validate,
  send,
  onSaved,
  label,
  saveButton,
}: {
  validate: () => string;
  /** The save itself; null when the run found nothing left to send (its edit went out with the run before it). */
  send: () => Promise<TaskMutationResult | null>;
  /** The answer of a save that sent something. */
  onSaved: (result: TaskMutationResult) => void;
  /** The card's title, for the editor's one save status. */
  label?: string;
  /** The card's own Save button, named in that status while a change waits. */
  saveButton?: string;
}): CardSave {
  const latest = useRef({ validate, send, onSaved });
  latest.current = { validate, send, onSaved };
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [message, setMessage] = useState('');
  // A change typed and not sent yet, for the editor's status line (the ref below is the save's own).
  const [waiting, setWaiting] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);

  // Set below; the save on unmount calls it.
  const saveOnUnmount = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        // A save on blur was waiting out its delay: run it now, or the edit is lost.
        if (dirty.current) void saveOnUnmount.current();
      }
    };
  }, []);

  // The run in flight, with the run it asked for after it, for `flush` to wait on.
  const running = useRef<Promise<void> | null>(null);
  const saveNow = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) {
      // One more run after the save in flight, with what the card holds then.
      again.current = true;
      return;
    }
    const problem = latest.current.validate();
    if (problem) {
      if (alive.current) {
        setStatus('failed');
        setMessage(problem);
      }
      return;
    }
    dirty.current = false;
    inFlight.current = true;
    if (alive.current) {
      setStatus('saving');
      setMessage('');
      setWaiting(false);
    }
    const run = (async () => {
      try {
        const result = await latest.current.send();
        // The editor outlives the card, so the answer always reaches it.
        if (result) latest.current.onSaved(result);
        if (alive.current) setStatus('saved');
      } catch (err) {
        dirty.current = true;
        if (alive.current) {
          setStatus('failed');
          setMessage(describeError(err, 'That change could not be saved. Try again in a moment.'));
        }
      } finally {
        inFlight.current = false;
      }
      if (again.current) {
        again.current = false;
        if (dirty.current) await saveNow();
      }
    })();
    running.current = run;
    await run;
  }, []);
  saveOnUnmount.current = saveNow;

  const changed = useCallback(() => {
    dirty.current = true;
    setStatus((was) => (was === 'saving' ? was : 'idle'));
    setMessage('');
    setWaiting(true);
  }, []);

  const saveSoon = useCallback(() => {
    if (!dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void saveNow();
    }, SAVE_DELAY_MS);
  }, [saveNow]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) {
      // What changed meanwhile goes in the run after it, which the run in flight waits for.
      if (dirty.current) again.current = true;
      await running.current;
      return;
    }
    if (dirty.current) await saveNow();
  }, [saveNow]);

  const clean = useCallback(() => !dirty.current && !inFlight.current, []);

  // What the editor's one status line says of this card.
  const report = useEditorSaveReport();
  const reportId = useId();
  const named = label ?? 'A step';
  useEffect(() => {
    report(reportId, {
      label: named,
      saveButton,
      state: status === 'saving' ? 'saving' : status === 'failed' ? 'failed' : waiting ? 'changed' : status === 'saved' ? 'saved' : 'idle',
      message,
    });
  }, [report, reportId, named, saveButton, status, message, waiting]);
  useEffect(() => () => report(reportId, null), [report, reportId]);

  return { status, message, changed, saveNow, saveSoon, flush, clean };
}

/**
 * Redraw a card's fields from each new answer it is drawn from (`server`, by
 * identity: the phase or the task a save answered with, this card's save or
 * another step's), while the card is `clean`: nothing typed since its last
 * save went out and no save of it out. The server stores a teacher's text
 * plain, so the card then shows what is stored, not what was
 * typed; a card typed in since keeps what was typed until its own save.
 */
export function useServerRedraw<T>(server: T, clean: () => boolean, redraw: (server: T) => void): void {
  const seen = useRef(server);
  const latest = useRef({ clean, redraw });
  latest.current = { clean, redraw };
  useEffect(() => {
    if (seen.current === server) return;
    seen.current = server;
    if (latest.current.clean()) latest.current.redraw(server);
  }, [server]);
}

/** What a card says about its save: "Saving…", "Saved", or the sentence that stopped it. */
export function SaveLine({ save, idle, testId }: { save: CardSave; idle?: ReactNode; testId?: string }) {
  if (save.status === 'failed' && save.message) {
    return (
      <p role="alert" className="label-sm wrap text-fail" data-testid={testId}>
        {save.message}
      </p>
    );
  }
  return (
    <p role="status" className="tre-inline-note wrap" data-testid={testId}>
      {save.status === 'saving' ? 'Saving…' : save.status === 'saved' ? 'Saved' : idle}
    </p>
  );
}

const CHIP: Record<CardState, { label: string; className: string }> = {
  done: { label: 'Done', className: 'chip tre-chip-done' },
  current: { label: 'You are here', className: 'chip chip-accent' },
  todo: { label: 'Not yet', className: 'chip' },
};

export function BuilderCard({
  n,
  title,
  purpose,
  state,
  art,
  testId,
  whose,
  onFocusCard,
  onLeave,
  children,
}: {
  n: number;
  title: string;
  purpose: string;
  /** Where the step stands; `done` wins over `current` on the chip. */
  state: CardState;
  /** One of the app's own illustrations, decorative. */
  art?: string;
  testId: string;
  /** Whose the step's element is, on a copied project: the editor's provenance chip. */
  whose?: ReactNode;
  /** The card took focus: it is the step being worked on. */
  onFocusCard?: () => void;
  /** Focus left the card, for the save on blur. */
  onLeave?: () => void;
  children: ReactNode;
}) {
  const chip = CHIP[state];
  return (
    <section
      id={`tre-step-${n}`}
      className={`tre-card tre-card-${state}`}
      aria-labelledby={`tre-step-${n}-title`}
      data-testid={testId}
      onFocus={onFocusCard}
      onBlur={(event) => {
        if (!onLeave) return;
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        onLeave();
      }}
    >
      <header className="tre-card-head">
        <span className="tre-card-n" aria-hidden="true">
          {n}
        </span>
        <div className="tre-card-titles">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={`tre-step-${n}-title`} className="text-[14px] font-semibold text-ink">
              {title}
            </h3>
            {whose}
          </div>
          <p className="purpose wrap">{purpose}</p>
        </div>
        <span className={chip.className} data-testid={`${testId}-state`}>
          {chip.label}
        </span>
        {art && <img src={art} alt="" width={84} height={66} className="tre-card-art" />}
      </header>
      <div className="tre-card-body">{children}</div>
    </section>
  );
}

/** A number with a − and a + beside it, held between two bounds. */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  label,
  less,
  more,
  onChange,
  inputText,
  onText,
  testId,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** The input's accessible name. */
  label: string;
  /** The − button's accessible name. */
  less: string;
  /** The + button's accessible name. */
  more: string;
  onChange: (next: number) => void;
  /** What the field shows, where it is typed as text (a weight). */
  inputText?: string;
  onText?: (text: string) => void;
  /** The input's test id, where a caller's tests reach the field itself. */
  testId?: string;
  /** Off as a whole: the field and both buttons. */
  disabled?: boolean;
}) {
  const clamp = (n: number) => stepValue(n, min, max, step);
  const finite = Number.isFinite(value);
  return (
    <span className="tre-stepper">
      <button
        type="button"
        aria-label={less}
        disabled={disabled || (finite && value <= min)}
        onClick={() => onChange(clamp((finite ? value : min) - step))}
      >
        −
      </button>
      <input
        className="field tre-num"
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        data-testid={testId}
        value={inputText ?? (finite ? String(value) : '')}
        onChange={(event) => {
          if (onText) onText(event.target.value);
          else {
            const next = Number(event.target.value);
            if (event.target.value.trim() !== '' && Number.isFinite(next)) onChange(clamp(next));
          }
        }}
      />
      <button
        type="button"
        aria-label={more}
        disabled={disabled || (finite && value >= max)}
        onClick={() => onChange(clamp((finite ? value : min) + step))}
      >
        +
      </button>
    </span>
  );
}
