'use client';

/**
 * What a wait is allowed to say.
 *
 * Two answers in this product arrive on a single blocking POST with no pending
 * row behind it to ask about: the customer's answer in the interview
 * (`useInterview.ask`) and the reviewer's reply in the Guided thread
 * (`PersonaPanel`'s `send`, and its `explain`: one `busy` for both, which is
 * why the Guided table promises nothing about a question that fails: `explain`
 * keeps none). Both are two model calls on the server, four when a
 * draft is rejected and repaired, and both draw one static line for the whole
 * of it. That line is honest and it is also all there is, for nine to eighteen
 * seconds at a time.
 *
 * So this says more as the wait grows, under the rule `QueueLine` already sets
 * for a wait in this product: it never counts down, an estimate is a range in
 * words, and it never names a step. A browser cannot know which server call is
 * running, so a timed switch to "checking the answer" would be a sentence that
 * is false whenever the first call is the slow one. Every line here is true at
 * every instant of the wait instead: that each answer is reviewed before it is
 * shown is a fact about the pipeline, not a claim about this millisecond.
 *
 * Nothing here moves. No spinner, no pulse, no transition and no number on
 * screen, so there is nothing for `prefers-reduced-motion` to switch off and
 * nothing that re-renders between two sentences.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';

/**
 * Which wait this is. The lead sentence stays the call site's own words, and it
 * stays there as JSX text rather than arriving as a prop: `copy-lint.mjs` reads
 * JSX text and a fixed list of prose props (`:47-58`, `:86-110`), so a sentence
 * handed over as `lead={…}` would have left the product's voice lint for the
 * sake of a prop name. The table below is outside that lint by construction
 * (it is a module-level object), so its copy is asserted in `wait-stage.test.tsx`
 * instead, separators and all.
 */
export type WaitKind = 'interview' | 'guided';

/** One sentence, and the point in a wait at which it becomes worth saying. */
export interface WaitLine {
  /** Milliseconds since the request left, ascending. */
  atMs: number;
  line: string;
}

/**
 * The table, pure and exported so the copy can be asserted without a browser;
 * `QueueLine`'s `STALL_LINE` is exported for the same reason.
 *
 * Six seconds is past every answer that arrives quickly, so a learner whose
 * reply is already on the way never reads a word about waiting. Twenty-five is
 * where the wait has stopped resembling the usual one and is still far short of
 * the sixty seconds the request gives up at (`REVIEWED_AI_TIMEOUT_MS`), so the
 * last thing said is never about to be contradicted. Both numbers come from a
 * sample of document turns rather than a measured curve, and they are two
 * numbers in one table precisely so they are cheap to retune.
 */
export const WAIT_STAGES: Record<WaitKind, WaitLine[]> = {
  interview: [
    { atMs: 6_000, line: 'Every answer is checked before it reaches you.' },
    // The interview keeps a question that failed: the outgoing row stays with
    // its words and a Retry beside it, and the draft goes back in the composer
    // (the interview Room's `interview-retry-question` button, and
    // useInterview's draft restore). The promise is the one the failure itself
    // makes, in the same words.
    { atMs: 25_000, line: 'This is taking longer than usual. Your question is kept.' },
  ],
  guided: [
    { atMs: 6_000, line: 'Every reply is checked before you see it.' },
    // Not the interview's promise, because this block is mounted by one `busy`
    // that "Explain this failure" sets as well as the composer, and that path
    // keeps nothing: the question was written for the learner rather than typed
    // by them, so there is no draft to hand back, and its own failure sentence
    // says so (`askFailureSentence(name, err, false)`). What is true on both
    // paths is that the request is still the one they made.
    { atMs: 25_000, line: 'This is taking longer than usual. You do not need to ask again.' },
  ],
};

/** Every line worth saying by `elapsedMs`, in the order they are earned. */
export function waitLines(kind: WaitKind, elapsedMs: number): string[] {
  return WAIT_STAGES[kind].filter(stage => stage.atMs <= elapsedMs).map(stage => stage.line);
}

/**
 * The wait, drawn.
 *
 * The markup is deliberate. The lead is a single `<p>` with the clock, the
 * call site's classes and the call site's words as its children, so the box
 * the e2e specs measure around it stays the same; the later sentences are its
 * siblings in one plain block, never a paragraph nested in a paragraph.
 *
 * The block itself carries no live region: it renders inside the transcript's
 * and the feed's `role="log"`, which is `aria-busy` for exactly as long as this
 * block is mounted, and a live region inside a busy container is presented only
 * once the busy state clears, by which time the answer has replaced the block.
 *
 * So the wait is heard from outside the log: one polite, visually hidden status, portalled
 * to the document body so no busy ancestor holds it, mounted empty with the wait
 * and given the newest stage's sentence when that stage is reached. It announces
 * stage changes only (never the lead, never the block again, nothing that
 * counts), and it leaves with the block.
 */
export function WaitStage({ kind, children }: { kind: WaitKind; children: React.ReactNode }) {
  /**
   * The request's own start. Both call sites render this under their `busy` and
   * drop it in their `finally`, so a mount is a request and the next request
   * gets a new clock rather than the tail of the last one.
   */
  const [startedAt] = useState(() => Date.now());
  /** The largest threshold this wait has reached. It only ever grows. */
  const [reachedMs, setReachedMs] = useState(0);

  useEffect(() => {
    // One timeout per threshold rather than an interval: nothing on screen
    // counts, so there is nothing to re-render between two sentences. Every
    // timer is cleared when the answer lands and the block is dropped.
    const timers = WAIT_STAGES[kind].map(stage =>
      setTimeout(
        () => setReachedMs(current => Math.max(current, stage.atMs)),
        Math.max(0, stage.atMs - (Date.now() - startedAt)),
      ),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [kind, startedAt]);

  // The status is portalled, so it waits for a document: this block is only
  // ever mounted by a request, after hydration, but the server never draws it.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  const lines = waitLines(kind, reachedMs);
  const newest = lines.length > 0 ? lines[lines.length - 1] : '';

  return (
    <div className="flex flex-col gap-1" data-testid="wait-stage">
      <p className="flex items-center gap-2 text-[12.5px] text-muted">
        <Icon name="clock" size={13} className="text-accent" />
        {children}
      </p>
      {lines.map(line => (
        // Set under the lead's own words rather than under its clock: 13px of
        // icon and the row's 8px gap.
        <p key={line} className="pl-[21px] text-[12.5px] leading-relaxed text-muted">
          {line}
        </p>
      ))}
      {portalReady &&
        createPortal(
          <div role="status" aria-live="polite" className="sr-only" data-testid="wait-stage-status">
            {newest}
          </div>,
          document.body,
        )}
    </div>
  );
}
