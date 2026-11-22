'use client';

/**
 * A place in the line.
 *
 * Forty people press Run at the same time and three sandboxes answer them, so
 * the honest thing to draw is not a spinner but a position. This component
 * asks the queue where the caller's own job sits, every two seconds, and stops
 * the moment it is no longer queued.
 *
 * It is self-polling on purpose. The workspace page and `lib/poll.ts` already
 * poll the job itself for its verdict; a second consumer of that loop would
 * have made both harder to read, and the line is a decoration on a wait that
 * the page is managing perfectly well without it.
 *
 * Three rules it never breaks:
 *  - it renders nothing at all before the first answer. No skeleton, no
 *    placeholder: the panel above it already says what is happening, and a
 *    line that appears and then corrects itself is worse than a line that
 *    arrives a second late;
 *  - a rejected request is swallowed and the last known line is kept. A queue
 *    line that flickers into an error is worse than one that is a second old;
 *  - it never counts down. An estimate is a range in words, because a
 *    countdown that is wrong is worse than a range.
 */
import { useEffect, useRef, useState } from 'react';
import type { QueuePositionView } from '@learnsdlc/shared';
import { queueApi } from '@/lib/api-queue';

/** How often the line asks again. Sixty requests over two minutes of waiting. */
const POLL_MS = 2_000;

/** How long `ahead` may sit still before the line says the class is busy. */
const STALL_MS = 90_000;

export const STALL_LINE = 'The class is busy. Your place is kept.';

/**
 * The line and its estimate, as words. Exported and pure so the copy can be
 * asserted without a browser.
 *
 * `about 90 seconds` reads as `about 2 minutes` past ninety; below ten it is
 * `about 10 seconds`, because the API floors the estimate there and "about 0
 * seconds" is not a thing to say to somebody who is waiting.
 */
export function queueWords(view: QueuePositionView): { line: string; estimate: string | null } {
  const line =
    view.ahead == null
      ? 'Queued'
      : view.ahead === 0
        ? 'Queued, next in line'
        : `Queued, ${view.ahead} ahead of you`;

  const seconds = view.estimateSeconds;
  if (seconds == null) return { line, estimate: null };
  if (seconds > 90) {
    const minutes = Math.round(seconds / 60);
    return { line, estimate: `about ${minutes} minute${minutes === 1 ? '' : 's'}` };
  }
  return { line, estimate: `about ${Math.max(10, seconds)} seconds` };
}

export function QueueLine({
  kind,
  id,
  /** Drawn only while the job is not finished; the caller already knows its status. */
  active,
  testId = 'queue-line',
  onLeftTheQueue,
}: {
  kind: 'run' | 'submission';
  id: string | null;
  active: boolean;
  testId?: string;
  /**
   * Called once, when the queue says this job is no longer waiting. The page
   * that owns the job polls the job itself, and that poll is deliberately slow:
   * so this is the first thing in the product to know the job started, and
   * the panel above uses it to stop saying the job is waiting.
   */
  onLeftTheQueue?: () => void;
}) {
  const [view, setView] = useState<QueuePositionView | null>(null);
  const [stalled, setStalled] = useState(false);
  // Kept in a ref so a caller that hands a fresh closure every render does not
  // restart the poll.
  const left = useRef(onLeftTheQueue);
  left.current = onLeftTheQueue;
  // The last `ahead` and when it last moved, so the stall notice is about the
  // line not moving rather than about the wait being long.
  const held = useRef<{ ahead: number | null; since: number }>({ ahead: null, since: 0 });

  useEffect(() => {
    if (!active || !id) {
      setView(null);
      setStalled(false);
      return;
    }

    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    held.current = { ahead: null, since: Date.now() };
    setStalled(false);

    const ask = async (): Promise<void> => {
      try {
        const next = await queueApi.position(kind, id);
        if (!live) return;
        setView(next);
        if (next.state !== 'queued') {
          left.current?.();
          return; // stop: there is no line any more
        }
        if (next.ahead !== held.current.ahead) {
          held.current = { ahead: next.ahead, since: Date.now() };
          setStalled(false);
        } else if (Date.now() - held.current.since >= STALL_MS) {
          setStalled(true);
        }
      } catch {
        // Swallowed on purpose: keep the last line rather than replacing it
        // with an error about a decoration.
        if (!live) return;
      }
      if (live) timer = setTimeout(() => void ask(), POLL_MS);
    };

    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [kind, id, active]);

  if (!active || !id || !view || view.state !== 'queued') return null;

  const { line, estimate } = queueWords(view);
  return (
    <p className="label-sm mt-1" data-testid={testId}>
      <span className="text-ink2">{estimate ? `${line}, ${estimate}` : line}</span>
      {stalled && (
        <>
          <br />
          <span data-testid={`${testId}-stalled`}>{STALL_LINE}</span>
        </>
      )}
    </p>
  );
}
