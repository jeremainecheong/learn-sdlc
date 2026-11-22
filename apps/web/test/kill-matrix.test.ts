import { describe, expect, it } from 'vitest';
import type { MutantRow } from '@learnsdlc/shared';
import { caseKey, matrixView, type TestFn } from '../components/workspace/panels/testing/lib';

/*
 * Phase 4 plants eight bugs across two layers. A mutant is run against the
 * suite of the run it belongs to and no other, so an API test never meets a
 * front-end bug, and drawing those 24 cells as "the test still passes with
 * the bug in" would get wrong the one sentence a learner reads the grid to
 * answer.
 */
const fn = (name: string, path: string): TestFn => ({ name, path, line: 1 });

const row = (
  mutant: string,
  cases: { name: string; status: 'passed' | 'failed' }[],
): MutantRow => ({ mutant, description: mutant, killed: cases.some((c) => c.status !== 'passed'), cases });

const API = ['catches a completion', 'catches a filter', 'catches the overdue rule'];
const WEB = ['a late task wears the badge', 'the search reaches the request'];

const api = (killed: string) =>
  row(`api_${killed}`, API.map((n) => ({ name: n, status: n === killed ? 'failed' : 'passed' })));
const web = (killed: string) =>
  row(`web_${killed}`, WEB.map((n) => ({ name: n, status: n === killed ? 'failed' : 'passed' })));

const tests = [...API, ...WEB].map((n, i) => fn(n, i < API.length ? 'tests/t.py' : 'web/src/a.test.tsx'));

describe('the kill matrix across two layers', () => {
  const view = matrixView(
    [api(API[0]), api(API[1]), api(API[2]), api(API[0]), web(WEB[0]), web(WEB[1]), web(WEB[0]), web(WEB[1])],
    tests,
  );

  it('draws eight bugs against five tests', () => {
    expect(view.rows).toHaveLength(8);
    expect(view.columns).toHaveLength(5);
  });

  it('says which tests actually ran against each bug, rather than calling the other layer a miss', () => {
    const apiRow = view.rows[0];
    expect(apiRow.ran).toEqual(API);
    expect(apiRow.ran).not.toContain(WEB[0]);

    const webRow = view.rows[4];
    expect(webRow.ran).toEqual(WEB);
    expect(webRow.ran).not.toContain(API[0]);
  });

  it('leaves exactly the cells that ran and did not catch it to be read as a miss', () => {
    // 8 rows × 5 columns = 40 cells, and 20 of them never ran at all:
    // 4 API bugs × the 2 front-end tests, plus 4 front-end bugs × the 3 API
    // tests. Half the grid was being drawn as a miss.
    const unrun = view.rows.reduce((n, r) => n + view.columns.filter((c) => !r.ran.includes(c.key)).length, 0);
    const missed = view.rows.reduce(
      (n, r) => n + view.columns.filter((c) => r.ran.includes(c.key) && !r.killers.includes(c.key)).length,
      0,
    );
    expect(unrun).toBe(20);
    expect(missed + unrun + view.rows.reduce((n, r) => n + r.killers.length, 0)).toBe(40);
  });

  it('still counts every bug as killed by the suite that met it', () => {
    expect(view.killed).toBe(8);
    expect(view.total).toBe(8);
  });
});

describe('caseKey', () => {
  it('strips a unittest class prefix, which is what it is for', () => {
    expect(caseKey('GradedFilesTest.test_reads_impl')).toBe('test_reads_impl');
  });

  it('leaves a sentence the learner wrote alone, full stop and all', () => {
    expect(caseKey('a late task wears the badge.')).toBe('a late task wears the badge.');
    expect(caseKey('the API answers v1.2 of the contract')).toBe('the API answers v1.2 of the contract');
    expect(caseKey('a late task wears the badge')).toBe('a late task wears the badge');
  });
});
