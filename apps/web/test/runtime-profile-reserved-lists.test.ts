/**
 * The upload form holds the runtime profile line's place with an invisible
 * copy of the runner's allow-lists (`RESERVED_LISTS`). The lists exist once,
 * in the runner's Python (`apps/api/runner/runtime_manifest.py`), which the
 * web cannot import, so this test reads the runner's file and fails when the
 * web's copy differs from it.
 */
import { describe, expect, it } from 'vitest';
import { RESERVED_LISTS } from '@/components/staff/projects/RuntimeProfileLine';
import { repoFile } from './support/paths';

const MANIFEST = repoFile('apps/api/runner/runtime_manifest.py');

/** The string members of `NAME = frozenset({ ... })` in the runner's manifest, sorted. */
function runnerList(name: string): string[] {
  const found = new RegExp(`^${name} = frozenset\\(\\{([^}]*)\\}\\)`, 'm').exec(MANIFEST);
  if (!found) throw new Error(`runtime_manifest.py has no ${name} = frozenset({...})`);
  const members = [...found[1].replace(/#[^\n]*/g, '').matchAll(/"([^"\n]+)"/g)].map((one) => one[1]);
  return members.sort();
}

describe("the upload form's reserved runtime line matches the runner's allow-lists", () => {
  it.each([
    ['python', 'ALLOWED_PYTHON'],
    ['node', 'ALLOWED_NODE'],
    ['tools', 'ALLOWED_TOOLS'],
  ] as const)('%s is the runner\'s %s', (list, name) => {
    const runner = runnerList(name);
    expect(runner.length).toBeGreaterThan(0);
    expect([...RESERVED_LISTS[list]].sort()).toEqual(runner);
  });

  it('fails on a copy that differs from the runner (the comparison is not vacuous)', () => {
    const runner = runnerList('ALLOWED_PYTHON');
    expect([...runner, 'requests'].sort()).not.toEqual(runner);
    expect(RESERVED_LISTS.python).not.toContain('requests');
  });
});
