'use client';

/**
 * What the learner's own application printed.
 *
 * A tab of the panel under the code, beside Terminal and Tests, because that
 * is where a developer already looks for a process's output: a drawer inside
 * a 560px pane would have eaten the app it is about.
 *
 * Newest last, as a terminal reads, and it follows the tail unless the learner
 * has scrolled up: scrolling back to read a traceback and being yanked to the
 * bottom by the next heartbeat is the one thing a log pane must not do.
 *
 * Every line here was redacted, stripped of its terminal colour and truncated
 * by the runner before it was stored: the workspace's own path never reaches
 * this component, so nothing in it needs to hide anything.
 *
 * The colour is the line's own severity, not the pipe it came down. Flask
 * writes its banner and every access log line to stderr, so colouring by
 * stream would paint a working app as a run of failures.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { PreviewLogLine } from '@learnsdlc/shared';
import { CONSOLE_EMPTY } from './preview/copy';
import { severities, stripAnsi, type LogSeverity } from './preview/log';

/** Within this many pixels of the bottom counts as "still following". */
const NEAR_BOTTOM = 24;

const TONE: Record<LogSeverity, string> = {
  error: 'font-semibold text-fail',
  warn: 'text-warn',
  info: '',
};

export function ConsolePane({ lines }: { lines: PreviewLogLine[] }) {
  const box = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  // One pass over the tail: a traceback's frames are read as part of the block
  // that opened them, so the classification cannot be done line by line.
  const tone = useMemo(() => severities(lines), [lines]);

  useEffect(() => {
    const el = box.current;
    if (!el || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={box}
      data-testid="console-pane"
      className="h-full overflow-y-auto px-3.5 py-2"
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
      }}
    >
      {lines.length === 0 ? (
        <p className="label">{CONSOLE_EMPTY}</p>
      ) : (
        <pre className="mono whitespace-pre-wrap break-words text-[12px] leading-[1.6] text-ink2">
          {lines.map((l, i) => (
            <span
              key={`${l.at}-${i}`}
              data-stream={l.stream}
              data-severity={tone[i]}
              className={`block ${TONE[tone[i]]}`}
            >
              {stripAnsi(l.text)}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
