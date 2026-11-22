/**
 * The rules every door into a project shares, as a leaf.
 *
 * This file imports nothing (not from the app, not from a package) so any
 * door (the upload's `upload-limits.ts`, the sealed-role door in
 * `sealed-roles.ts`, `draft.ts`'s collector, the export's read-back) can ask
 * it without making a cycle (`upload-limits` → importer → draft would be one).
 *
 * **The hidden-test name.** A hidden suite is files the runner
 * executes under its own fixed command, so a hidden file is a test file by
 * its name: `test_*.py`, or `*.test.ts` / `*.test.tsx`, by basename. That is
 * the one rule; there are no hidden helper files, so a
 * name this rule refuses is refused at every door that writes a hidden file,
 * and a draft can never hold a hidden name publish would refuse.
 *
 * **Strict text.** A file a door stores is text: it decodes as
 * UTF-8 with a fatal decoder (no byte is replaced by U+FFFD) and holds no
 * U+0000 (PostgreSQL `text` cannot hold one). The sealed-role door's rule, as one
 * helper. A refusal says why, never a byte of the file.
 */

/** The Python spelling: a basename `test_<name>.py`. */
const PYTHON_TEST_NAME = /(^|\/)test_[A-Za-z0-9_]+\.py$/;
/** The TypeScript spelling: a basename ending `.test.ts` or `.test.tsx`. */
const TYPESCRIPT_TEST_NAME = /\.test\.tsx?$/;

/** The hidden-test name, either spelling, as one RegExp (no `g`/`y` flag: `.test` keeps no state). */
export const HIDDEN_TEST_NAME = /(^|\/)test_[A-Za-z0-9_]+\.py$|\.test\.tsx?$/;

/**
 * Whether `path` (pack- or phase-relative, `/`-separated) names a hidden test
 * file under the hidden-test name rule. With a run's `language`, only that language's spelling
 * counts (`python` → `test_*.py`, `typescript` → `*.test.ts[x]`, any other
 * language → none), which is how the upload pairs a run with its suite.
 */
export function isHiddenTestName(path: string, language?: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (language === undefined) return HIDDEN_TEST_NAME.test(path);
  if (language === 'python') return PYTHON_TEST_NAME.test(path);
  if (language === 'typescript') return TYPESCRIPT_TEST_NAME.test(path);
  return false;
}

/** Why bytes are not text a door may store. */
export type StrictTextRefusal = 'not-utf8' | 'nul';

/**
 * The bytes as text, or why they are not: fatal UTF-8 (`TextDecoder` with
 * `fatal: true`, so an invalid, overlong, surrogate or cut-off sequence is
 * refused rather than replaced), then no U+0000. A leading byte-order mark
 * is accepted (and dropped from `text`, as the decoder drops it).
 */
export function strictText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; why: StrictTextRefusal } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, why: 'not-utf8' };
  }
  if (text.includes('\u0000')) return { ok: false, why: 'nul' };
  return { ok: true, text };
}

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why a string a door *parsed* (a
 * JSON value or key, whose file bytes passed `strictText` as plain ASCII)
 * cannot be stored, or null when it can. `\u0000` decodes to U+0000, which
 * PostgreSQL `text` refuses (driver error 22021, a 500); a lone `\ud800`
 * decodes to half a surrogate pair, which the driver's UTF-8 encoding stores
 * as U+FFFD (mangled). Other control characters are stored as written.
 */
export function storableText(value: string): 'nul' | 'surrogate' | null {
  if (value.includes('\u0000')) return 'nul';
  if (LONE_SURROGATE.test(value)) return 'surrogate';
  return null;
}
