/**
 * A traceback, sorted into the learner's own frames and the platform's.
 *
 * Its own module rather than a corner of `RunPanel.tsx` because the terminal
 * pane needs the same answer and must not pull a React component in to get it.
 * `RunPanel` re-exports `splitTrace` so the panel's own
 * suite keeps importing it from where it lives.
 */
/* -------------------------------------------------------------------------- */
/*  The traceback, as the learner's own problem                               */
/* -------------------------------------------------------------------------- */

/** A frame the sandbox produced rather than the learner: pytest, flask, werkzeug. */
export const LIBRARY_FRAME = /(^|[\\/])(sandbox[\\/]python|site-packages|_pytest|pluggy)[\\/]/;

/** `  File "tests/test_tasks_api.py", line 17, in test_overdue` */
const FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?\s*$/;

/**
 * pytest's own short style: `sandbox/python/flask/testing.py:235: in open`.
 *
 * The long `File "…", line N` form is what a raised traceback prints; the
 * short form is what pytest's failure block prints, and it is the one a real
 * failing run in this product actually produces: so handling only the long
 * form would leave nine framework frames on screen.
 */
const SHORT_FRAME = /^\s*([\w./\\-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs)):(\d+): in (.+?)\s*$/;

/** One frame, whichever of the two styles it is written in. */
export function frameOf(line: string): { path: string; line: string; fn?: string } | null {
  const long = FRAME.exec(line);
  if (long) return { path: long[1], line: long[2], fn: long[3] };
  const short = SHORT_FRAME.exec(line);
  if (short) return { path: short[1], line: short[2], fn: short[3] };
  return null;
}

export interface Trace {
  /** The exception line: what actually went wrong. */
  headline: string;
  /** The learner's own frames, in the product's reference style. */
  own: string[];
  /** Everything the sandbox contributed, kept for the disclosure. */
  library: string[];
}

/**
 * Split a Python traceback into the learner's part and the platform's.
 *
 * A failing first run of phase 3 answers with nine frames under
 * sandbox/python/werkzeug, sandbox/python/flask and sandbox/python/flask/app.py
 * before `tests/test_tasks_api.py:17`, so unsplit the one line the learner can
 * act on would be lost among eight they cannot; and the sandbox path would
 * publish the platform's own layout into the room. Returns `null` when the message is not a
 * traceback at all, and then nothing about the panel changes.
 */
export function splitTrace(message: string): Trace | null {
  const lines = message.replace(/\r/g, '').split('\n');
  const own: string[] = [];
  const library: string[] = [];
  let headline = '';
  let sawFrame = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const frame = frameOf(line);
    if (frame) {
      sawFrame = true;
      const { path, line: lineNo, fn } = frame;
      // The source line pytest prints under a frame belongs to that frame.
      const source = (lines[i + 1] ?? '').trim();
      const consumesNext = Boolean(source) && !frameOf(lines[i + 1] ?? '');
      if (LIBRARY_FRAME.test(path)) {
        library.push(line.trim());
        if (consumesNext) library.push(source);
      } else {
        const file = path.split(/[\\/]/).pop() || path;
        own.push(`${file}, line ${lineNo}${fn ? `, in ${fn}` : ''}${source ? ` — ${source}` : ''}`);
      }
      if (consumesNext) i += 1;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || /^Traceback \(most recent call last\)/.test(trimmed)) continue;
    // The exception is the last thing a traceback says, so the last plain line
    // wins over any banner above the frames.
    if (sawFrame || !headline) headline = trimmed;
  }

  if (!sawFrame) return null;
  return { headline: headline || message.trim().split('\n')[0], own, library };
}
