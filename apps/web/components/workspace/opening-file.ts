/**
 * Which file a code room opens on.
 *
 * A phase lists its files in the pack's order, and in Maintenance both the
 * helper and its test are editable with the test first, so "the first
 * editable file" opened the test while the brief's first step asks to change
 * the helper. Implementation opened on the helper only because its test was
 * read-only. The room now opens on the first editable file that is not a test,
 * and on the first editable file where every one is a test (Testing).
 */

/**
 * A test file: the shared map's rule on the lower-cased base name (`test_x`, `x_test.`, `x.test.`, `x.spec.`, any
 * language), or a file under `test/`, `tests/` or `__tests__/`.
 */
export function isTestFile(path: string): boolean {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  return /^test_|_test\.|\.test\.|\.spec\./.test(name) || /(^|\/)(tests?|__tests__)\//.test(path);
}

/** The editable files in the phase's order, the ones that are not tests first (the order is kept within each group). */
export function changeFirst<T extends { path: string; editable: boolean }>(files: readonly T[]): T[] {
  const editable = files.filter((f) => f.editable);
  return [...editable.filter((f) => !isTestFile(f.path)), ...editable.filter((f) => isTestFile(f.path))];
}
