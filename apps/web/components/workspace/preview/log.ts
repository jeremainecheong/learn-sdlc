/**
 * What a console line means, rather than which pipe it came down.
 *
 * Colouring by stream (`stderr` red, everything else plain) would be wrong. A
 * Flask app writes its whole startup banner and every access log line to
 * stderr, so a run in which nothing failed would read as four failures, and the
 * Console tab would wear a red badge counting them. Which pipe a line arrived on is
 * a fact about the framework, not about the learner's app.
 *
 * So the pane reads the line. Three severities, in the product's own colours:
 *  - `error`: a traceback and its frames, an exception line, a compiler error,
 *    a 5xx in an access log, the lines a learner should look at;
 *  - `warn`: a warning, a 4xx, worth seeing, not a failure;
 *  - `info`: everything else, including a 2xx access log line on stderr.
 *
 * Pure and exported so the rules are a unit test rather than a class name in a
 * component, and applied over the whole tail at once because a traceback is a
 * block: the frames under "Traceback (most recent call last):" are indented
 * continuations that say nothing on their own.
 *
 * The runner strips ANSI where it captures a line (app_session.py).
 * `stripAnsi` is here for lines captured without that step, and because a
 * pane that prints an escape as "[31m"
 * is the kind of thing that comes back.
 */
import type { PreviewLogLine } from '@learnsdlc/shared';

export type LogSeverity = 'error' | 'warn' | 'info';

/** Colour, cursor moves and OSC titles: the same set the runner strips. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * `127.0.0.1 - - [06/Sep/2026 12:32:58] "GET /api/health HTTP/1.1" 200 -`, the
 * common log format Werkzeug, Vite's preview and every static server write.
 * The status code is the only part that says whether anything went wrong.
 */
const ACCESS_LOG = /"[A-Z]+ [^"]*"\s+(\d{3})\b/;

/** The first line of a Python traceback, which owns the frames under it. */
const TRACEBACK = /^\s*Traceback \(most recent call last\)/;

/** `ValueError: ...`, `werkzeug.exceptions.NotFound: ...`; a block's last line. */
const EXCEPTION_LINE = /^\s*[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit)\b\s*(?::|$)/;

const ERROR_WORDS =
  /(^|\s)(error|errors|exception|traceback|fatal|critical|failed|failure|npm ERR!|panic)\b/i;

/** TypeScript and esbuild both name the file, then the word. */
const COMPILER_ERROR = /\berror\s+TS\d+\b|\b\d+ errors?\b/i;

const WARN_WORDS = /(^|\s)(warning|warn|deprecated|deprecation)\b/i;

function lineSeverity(text: string): LogSeverity {
  const line = stripAnsi(text);
  const access = ACCESS_LOG.exec(line);
  if (access) {
    const code = Number(access[1]);
    if (code >= 500) return 'error';
    if (code >= 400) return 'warn';
    return 'info';
  }
  if (TRACEBACK.test(line) || EXCEPTION_LINE.test(line)) return 'error';
  if (COMPILER_ERROR.test(line) || ERROR_WORDS.test(line)) return 'error';
  if (WARN_WORDS.test(line)) return 'warn';
  return 'info';
}

/**
 * The severity of every line in the tail, in order.
 *
 * A traceback's frames, `  File "app.py", line 12, in create` and the source
 * line under it, carry no word of their own, so the block is carried: once a
 * traceback has opened, every indented line belongs to it, and the exception
 * line that closes it is the last one.
 */
export function severities(lines: PreviewLogLine[]): LogSeverity[] {
  let inTraceback = false;
  return lines.map((l) => {
    const text = stripAnsi(l.text);
    if (TRACEBACK.test(text)) {
      inTraceback = true;
      return 'error';
    }
    if (inTraceback) {
      if (/^\s+\S/.test(text)) return 'error';
      inTraceback = false;
      if (EXCEPTION_LINE.test(text)) return 'error';
    }
    return lineSeverity(text);
  });
}

/** How many lines a learner should actually look at. The tab's badge. */
export function problemCount(lines: PreviewLogLine[]): number {
  return severities(lines).filter((s) => s === 'error').length;
}
