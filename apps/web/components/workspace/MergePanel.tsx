'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';

/**
 * The shortest reflection the API stores (`ReflectDto`: "a reflection needs at
 * least 20 characters of real thought"), counted the way this sheet counts:
 * trimmed.
 *
 * A reflection is **optional**: advancing never reads
 * it, and an empty box is no reflection, so nothing is posted for it. What the
 * floor governs is a reflection the learner did start: one to nineteen
 * characters is neither nothing nor a reflection the route will keep, so
 * Continue waits until it is one or the other.
 */
export const REFLECTION_MIN = 20;

/**
 * A reflection's length as the API measures it, so the sheet and the route
 * agree on the twentieth character.
 *
 * `ReflectDto`'s `@MinLength` is class-validator's `isLength`, which does not
 * count UTF-16 units: a surrogate pair (an emoji, most CJK extension
 * characters) is one character, and so is a character followed by a
 * presentation selector (U+FE0E / U+FE0F). `String.length` would count ten
 * emoji as twenty, light Continue, and the route would refuse the post.
 * The two subtractions are validator's own, pattern for pattern.
 */
export function reflectionLength(text: string): number {
  const presentation = text.match(/[^️︎][️︎]/g)?.length ?? 0;
  const surrogates = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  return text.length - presentation - surrogates;
}

/**
 * Where a reflection stands: nothing written, too short to keep, or kept.
 * Exported for the banner's own guard and for the sheet's tests.
 */
export function reflectionState(text: string): { ok: boolean; line: string } {
  const length = reflectionLength(text.trim());
  if (length === 0) return { ok: true, line: 'Reflection is optional' };
  if (length < REFLECTION_MIN) {
    const more = REFLECTION_MIN - length;
    return {
      ok: false,
      line: `${more} more ${more === 1 ? 'character' : 'characters'}, or clear it to continue without one`,
    };
  }
  return { ok: true, line: 'Your reflection is saved with the merge' };
}

/**
 * The merge sheet. Passing the gate opens the pull request for merging, and
 * the learner may leave a message with the merge: one paragraph on what the
 * feedback changed in how they work. It is optional. A written one is kept
 * with the merge; the next phase opens either way.
 */
export function MergePanel({
  phaseTitle,
  score,
  isLast,
  onSubmit,
  onClose,
}: {
  phaseTitle: string;
  score: number | null;
  isLast: boolean;
  onSubmit: (reflection: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * Where focus came from, read during the first render rather than in an
   * effect.
   *
   * The textarea below carries `autoFocus`, and React applies that during the
   * same commit that mounts this sheet: before any effect runs. An effect
   * that read `document.activeElement` would therefore store the textarea, and
   * restoring it on unmount would focus an element that is being removed, which
   * lands the keyboard user on BODY at the top of the document. Render runs
   * before the commit, so this reads the button that opened the sheet.
   */
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  const restoreFocusTo = useRef<HTMLElement | null>(opener);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit(text);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  /**
   * A sheet that does not trap focus is a trap of a different kind: Tab walks
   * out into the page behind it, which is still there and still clickable to a
   * screen reader, so a keyboard user can silently end up editing the workspace
   * they think is covered.
   *
   * This cycles Tab within the panel, closes on Escape, and puts focus back
   * where it came from on unmount.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [busy, onClose],
  );

  useEffect(() => {
    // The page behind must not scroll while the sheet is up.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      const back = restoreFocusTo.current;
      // An opener that has itself gone (the merge that unlocks the next phase
      // replaces the whole panel) is no place to send focus, so the heading
      // of the page takes it instead of the top of the document.
      if (back && back.isConnected && !panelRef.current?.contains(back)) back.focus?.();
      else document.getElementById('main')?.focus?.();
    };
  }, []);

  const reflection = reflectionState(text);

  /*
   * The sheet is drawn on the document's body, not where the band
   * that opens it sits. Drawn in place, its `fixed inset-0 z-50` would count
   * only inside the stacking context of some ancestor of the band, and the
   * shell's top bar (`.shell-topbar`, z-index 40 in shell-fidelity.css) would
   * paint over its first 65 px: the heading, the icon and the close button. A
   * sheet on the body is above the bar whichever ancestor makes that context.
   * The focus trap and Escape are React handlers on the overlay itself, and a
   * portal keeps React's event tree, so they work there too.
   */
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink/30"
      data-testid="reflection-modal"
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
        aria-describedby="merge-purpose"
        className="flex h-full w-full max-w-[460px] flex-col border-l-1.5 border-edge bg-surface"
      >
        <div className="flex shrink-0 items-start gap-3 border-b-1.5 border-edge px-5 py-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl bg-passtint text-pass">
            <Icon name="merge" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="merge-title" className="h2">
              Continue from this phase
            </h2>
            <p id="merge-purpose" className="purpose mt-0.5">
              Optionally record what you learned before continuing. Your phase evidence is already saved.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="btn-ghost btn-sm shrink-0 !px-2"
          >
            <Icon name="cross" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[13px] leading-relaxed text-ink2">
            You passed {phaseTitle}. Continuing closes
            this phase{isLast ? ' and finishes the project' : ' and opens the next one'}. Say what
            the review changed about how you would do this again, and where the mentor helped or
            where you deliberately did not use it.
          </p>

          <label htmlFor="reflection" className="label mt-5 block text-ink2">
            Continue from this phase
          </label>
          <textarea
            id="reflection"
            autoFocus
            className="field mt-1.5 min-h-[160px] resize-y text-[14px] leading-relaxed"
            placeholder="Optional: what changed in your understanding?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby="reflection-count"
            data-testid="reflection-input"
          />
          <div className="mt-2 flex items-start justify-between gap-3">
            <p id="reflection-count" className="label-sm" aria-live="polite" data-testid="reflection-count">
              {reflection.line}
            </p>
            {error && (
              <p role="alert" className="text-right text-[12.5px] text-fail">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t-1.5 border-edge px-5 py-4">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">
            Not yet
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !reflection.ok}
            data-testid="reflection-submit"
            className="btn"
          >
            <Icon name="merge" size={14} />
            {busy ? (isLast ? 'Completing the project…' : 'Continuing…') : isLast ? 'Complete the project' : 'Continue to next phase'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
