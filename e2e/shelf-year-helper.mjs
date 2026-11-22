// Shelf's `add()` with its year check in a helper, as the shipped starter has it: one module for the proof
// (scripts/author-subset.mjs, which re-exports it and whose node tests pin the grader's limit) and the browser
// journey (e2e/phase-subset.spec.ts), so both hand in the same Implementation work. Plain ESM with no
// `import.meta`, so Playwright's loader reads it from TypeScript as it reads e2e/record-fixtures.mjs.

/**
 * The year check of Shelf's `add()` as the upload fixtures' reference
 * solutions still write it inline. With it, `add()` scores complexity 9 in
 * the grader's analyser (apps/api/runner/analyzer.py, limit 8), so the
 * static-analysis check is a warning and the strict gate refuses the
 * reference solution as it stands. The shipped starter pack keeps the check
 * in `_year_is_valid` (apps/api/src/authoring/starter-pack-properties.spec.ts);
 * the learner here hands in the solution with that same move.
 */
const INLINE_YEAR_CHECK = '        if year is not None and (isinstance(year, bool) or not isinstance(year, int) or not 1000 <= year <= 2999):\n';
const HELPER_YEAR_CHECK = '        if not _year_is_valid(year):\n';
const YEAR_HELPER = [
  'def _year_is_valid(year):',
  '    """A year is optional; when one is given it is a four-digit whole number."""',
  '    if year is None:',
  '        return True',
  '    if isinstance(year, bool) or not isinstance(year, int):',
  '        return False',
  '    return 1000 <= year <= 2999',
].join('\n');

/** One Shelf `api/shelf.py` with the year check moved into `_year_is_valid`, the starter's shape; a text without the inline check comes back unchanged. */
export function withYearHelper(text) {
  if (!text.includes(INLINE_YEAR_CHECK)) return text;
  if (!text.includes('\n\n\nclass Shelf:\n')) throw new Error('api/shelf.py holds the inline year check but no class Shelf after two blank lines');
  return text.replace(INLINE_YEAR_CHECK, HELPER_YEAR_CHECK).replace('\n\n\nclass Shelf:\n', `\n\n${YEAR_HELPER}\n\n\nclass Shelf:\n`);
}
