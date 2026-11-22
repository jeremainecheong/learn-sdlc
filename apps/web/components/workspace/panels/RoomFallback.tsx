'use client';

/**
 * What a workspace room draws before its phase has landed, and what it draws
 * when the phase never lands at all.
 *
 * A bare `{error || 'Loading the issue…'}` in each room would show whatever
 * `fetch` rejected with, so with the API unreachable five rooms would render
 * one grey sentence, "Failed to fetch", with no heading, no retry and no way
 * out. This is the one place that
 * answer is written, so the five rooms say the same thing in the same voice.
 */

import { Button, Notice } from '@/components/ui';

export function RoomFallback({
  room,
  error,
  onRetry,
  backHref = '/dashboard',
  backLabel = 'Back to home',
  testId = 'room-fallback',
}: {
  /** The room, lower case, for "Loading the kill matrix…". */
  room: string;
  /** The sentence the load failed with, already in the product's voice. */
  error?: string;
  /** Fetch the phase again. Omit for a room with nothing to retry. */
  onRetry?: () => void;
  backHref?: string;
  backLabel?: string;
  testId?: string;
}) {
  if (!error) {
    return (
      <p className="label p-6" data-testid={`${testId}-loading`}>
        Loading the {room}…
      </p>
    );
  }
  return (
    <div className="flex max-w-[540px] flex-col items-start gap-3 p-6" data-testid={testId}>
      <Notice tone="fail" testId="room-error">
        {error}
      </Notice>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && (
          <Button testId="room-retry" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button variant="ghost" href={backHref} testId="room-back">
          {backLabel}
        </Button>
      </div>
    </div>
  );
}
