import type { AnalyzerFunction, AnalyzerReport, TestCaseResult } from '@learnsdlc/shared';
import { buildImpactReport } from './impact';

const fn = (over: Partial<AnalyzerFunction> & { name: string }): AnalyzerFunction => ({
  path: 'tasktrackr/manager.py',
  line: 10,
  endLine: 20,
  complexity: 2,
  calls: [],
  bodyHash: `h-${over.name}`,
  ...over,
});

const report = (functions: AnalyzerFunction[]): AnalyzerReport => ({
  issues: [],
  metrics: {
    files: 1,
    functions: functions.length,
    todosRemaining: 0,
    maxComplexity: 3,
    docstringCoverage: 1,
  },
  functions,
});

const passed = (name: string): TestCaseResult => ({ name, status: 'passed' });

const maintenanceCases: TestCaseResult[] = [
  passed('ReopenChange.test_reopen_uncompletes_a_done_task'),
  passed('ReopenChange.test_reopen_unknown_id_raises'),
  passed('ReopenChange.test_reopen_open_task_is_noop'),
  passed('ReopenChange.test_reopened_task_returns_to_open_filter'),
  passed('Regression.test_complete_still_works'),
  passed('Regression.test_complete_unknown_still_raises'),
  passed('Regression.test_filter_order_unchanged'),
  passed('Regression.test_filter_keyword_unchanged'),
  passed('Regression.test_overdue_unchanged'),
];

const jsCases: TestCaseResult[] = [
  passed('reopen un-completes a done task in stored state'),
  passed('reopen unknown id throws'),
  passed('reopen of an open task is a no-op'),
  passed('reopened task returns to the open filter'),
  passed('complete still works'),
  passed('complete unknown id still throws'),
  passed('filter order unchanged'),
  passed('filter keyword unchanged'),
  passed('overdue unchanged'),
];

describe('buildImpactReport', () => {
  it('returns undefined without function facts on either side', () => {
    const withFns = report([fn({ name: 'complete_task' })]);
    expect(buildImpactReport(undefined, undefined, [])).toBeUndefined();
    expect(buildImpactReport(withFns, undefined, [])).toBeUndefined();
    expect(buildImpactReport(undefined, withFns, [])).toBeUndefined();
    expect(buildImpactReport(report([]), withFns, [])).toBeUndefined();
    expect(buildImpactReport(withFns, report([]), [])).toBeUndefined();
  });

  it('returns undefined when the analyzer report carries no functions field at all', () => {
    const bare = {
      issues: [],
      metrics: { files: 1, functions: 3, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 },
    } as AnalyzerReport;
    expect(buildImpactReport(bare, bare, [])).toBeUndefined();
  });

  it('classifies unchanged, changed, added and removed by body hash', () => {
    const baseline = report([
      fn({ name: 'complete_task', bodyHash: 'a' }),
      fn({ name: 'filter_tasks', bodyHash: 'b' }),
      fn({ name: 'overdue_tasks', bodyHash: 'c' }),
    ]);
    const current = report([
      fn({ name: 'complete_task', bodyHash: 'a2' }),
      fn({ name: 'filter_tasks', bodyHash: 'b' }),
      fn({ name: 'reopen_task', bodyHash: 'd' }),
    ]);
    const impact = buildImpactReport(baseline, current, []);
    expect(impact?.baseline).toBe('scaffold');
    expect(impact?.functions.map((f) => [f.name, f.change])).toEqual([
      ['complete_task', 'changed'],
      ['filter_tasks', 'unchanged'],
      ['reopen_task', 'added'],
      ['overdue_tasks', 'removed'],
    ]);
  });

  it('reads a function moved to another file as changed, not added plus removed', () => {
    const baseline = report([fn({ name: 'overdue_tasks', path: 'tasktrackr/manager.py', bodyHash: 'c' })]);
    const current = report([fn({ name: 'overdue_tasks', path: 'tasktrackr/queries.py', bodyHash: 'c' })]);
    const impact = buildImpactReport(baseline, current, []);
    expect(impact?.functions).toHaveLength(1);
    expect(impact?.functions[0]).toMatchObject({
      name: 'overdue_tasks',
      path: 'tasktrackr/queries.py',
      change: 'unchanged',
    });
  });

  it('keeps two same-named functions in different files apart', () => {
    const baseline = report([
      fn({ name: '__init__', path: 'tasktrackr/models.py', bodyHash: 'm' }),
      fn({ name: '__init__', path: 'tasktrackr/storage.py', bodyHash: 's' }),
    ]);
    const current = report([
      fn({ name: '__init__', path: 'tasktrackr/models.py', bodyHash: 'm2' }),
      fn({ name: '__init__', path: 'tasktrackr/storage.py', bodyHash: 's' }),
    ]);
    const impact = buildImpactReport(baseline, current, []);
    expect(impact?.functions.map((f) => [f.path, f.change])).toEqual([
      ['tasktrackr/models.py', 'changed'],
      ['tasktrackr/storage.py', 'unchanged'],
    ]);
  });

  it('does not guess a move when the name is ambiguous', () => {
    const baseline = report([
      fn({ name: 'save', path: 'a.py', bodyHash: '1' }),
      fn({ name: 'save', path: 'b.py', bodyHash: '2' }),
    ]);
    const current = report([fn({ name: 'save', path: 'c.py', bodyHash: '1' })]);
    const impact = buildImpactReport(baseline, current, []);
    expect(impact?.functions.map((f) => [f.path, f.change])).toEqual([
      ['c.py', 'added'],
      ['a.py', 'removed'],
      ['b.py', 'removed'],
    ]);
  });

  it('treats a missing baseline hash as a change rather than a match', () => {
    const baseline = report([fn({ name: 'complete_task', bodyHash: '' })]);
    const current = report([fn({ name: 'complete_task', bodyHash: '' })]);
    expect(buildImpactReport(baseline, current, [])?.functions[0].change).toBe('changed');
  });

  it('carries the analyzer position and complexity through', () => {
    const baseline = report([fn({ name: 'complete_task', bodyHash: 'a' })]);
    const current = report([
      fn({ name: 'complete_task', bodyHash: 'b', line: 63, endLine: 74, complexity: 4 }),
    ]);
    expect(buildImpactReport(baseline, current, [])?.functions[0]).toEqual({
      name: 'complete_task',
      path: 'tasktrackr/manager.py',
      line: 63,
      endLine: 74,
      complexity: 4,
      change: 'changed',
      reachedBy: [],
    });
  });

  describe('reachedBy', () => {
    it('links python hidden tests to the function they are named after', () => {
      const baseline = report([
        fn({ name: 'complete_task', bodyHash: 'a' }),
        fn({ name: 'filter_tasks', bodyHash: 'b' }),
        fn({ name: 'overdue_tasks', bodyHash: 'c' }),
      ]);
      const current = report([
        fn({ name: 'complete_task', bodyHash: 'a2' }),
        fn({ name: 'filter_tasks', bodyHash: 'b' }),
        fn({ name: 'overdue_tasks', bodyHash: 'c' }),
        fn({ name: 'reopen_task', bodyHash: 'd' }),
      ]);
      const impact = buildImpactReport(baseline, current, maintenanceCases);
      const byName = Object.fromEntries(
        (impact?.functions ?? []).map((f) => [f.name, f.reachedBy]),
      );
      // The python class name carries the subject too, so every ReopenChange case
      // reaches reopen_task, including the one whose method says "reopened".
      expect(byName['reopen_task']).toEqual([
        'ReopenChange.test_reopen_uncompletes_a_done_task',
        'ReopenChange.test_reopen_unknown_id_raises',
        'ReopenChange.test_reopen_open_task_is_noop',
        'ReopenChange.test_reopened_task_returns_to_open_filter',
      ]);
      expect(byName['complete_task']).toEqual([
        'Regression.test_complete_still_works',
        'Regression.test_complete_unknown_still_raises',
      ]);
      expect(byName['filter_tasks']).toEqual([
        'ReopenChange.test_reopened_task_returns_to_open_filter',
        'Regression.test_filter_order_unchanged',
        'Regression.test_filter_keyword_unchanged',
      ]);
      expect(byName['overdue_tasks']).toEqual(['Regression.test_overdue_unchanged']);
    });

    it('links javascript case strings and camelCase function names', () => {
      const baseline = report([
        fn({ name: 'completeTask', path: 'manager.js', bodyHash: 'a' }),
        fn({ name: 'overdueTasks', path: 'manager.js', bodyHash: 'c' }),
      ]);
      const current = report([
        fn({ name: 'completeTask', path: 'manager.js', bodyHash: 'a2' }),
        fn({ name: 'overdueTasks', path: 'manager.js', bodyHash: 'c' }),
        fn({ name: 'reopenTask', path: 'manager.js', bodyHash: 'd' }),
      ]);
      const impact = buildImpactReport(baseline, current, jsCases);
      const byName = Object.fromEntries(
        (impact?.functions ?? []).map((f) => [f.name, f.reachedBy]),
      );
      expect(byName['reopenTask']).toEqual([
        'reopen un-completes a done task in stored state',
        'reopen unknown id throws',
        'reopen of an open task is a no-op',
      ]);
      expect(byName['completeTask']).toEqual(['complete still works', 'complete unknown id still throws']);
      expect(byName['overdueTasks']).toEqual(['overdue unchanged']);
    });

    it('does not link on a generic word shared by every test name', () => {
      const baseline = report([fn({ name: 'get_task', bodyHash: 'g' })]);
      const current = report([fn({ name: 'get_task', bodyHash: 'g2' })]);
      const impact = buildImpactReport(baseline, current, maintenanceCases);
      expect(impact?.functions[0].reachedBy).toEqual([]);
    });

    it('links a test that spells the whole function name out', () => {
      const baseline = report([fn({ name: 'get_task', bodyHash: 'g' })]);
      const current = report([fn({ name: 'get_task', bodyHash: 'g2' })]);
      const impact = buildImpactReport(baseline, current, [passed('test_get_task_raises_on_unknown_id')]);
      expect(impact?.functions[0].reachedBy).toEqual(['test_get_task_raises_on_unknown_id']);
    });

    it('caps the linked test names', () => {
      const many = Array.from({ length: 40 }, (_, i) => passed(`test_reopen_case_${i}`));
      const baseline = report([fn({ name: 'reopen_task', bodyHash: 'r' })]);
      const current = report([fn({ name: 'reopen_task', bodyHash: 'r2' })]);
      expect(buildImpactReport(baseline, current, many)?.functions[0].reachedBy).toHaveLength(20);
    });
  });

  describe('change and regression split', () => {
    it('splits python case names on the class prefix', () => {
      const baseline = report([fn({ name: 'complete_task', bodyHash: 'a' })]);
      const current = report([fn({ name: 'complete_task', bodyHash: 'b' })]);
      const impact = buildImpactReport(baseline, current, maintenanceCases);
      expect(impact?.changeTests).toEqual([
        'ReopenChange.test_reopen_uncompletes_a_done_task',
        'ReopenChange.test_reopen_unknown_id_raises',
        'ReopenChange.test_reopen_open_task_is_noop',
        'ReopenChange.test_reopened_task_returns_to_open_filter',
      ]);
      expect(impact?.regressionTests).toEqual([
        'Regression.test_complete_still_works',
        'Regression.test_complete_unknown_still_raises',
        'Regression.test_filter_order_unchanged',
        'Regression.test_filter_keyword_unchanged',
        'Regression.test_overdue_unchanged',
      ]);
    });

    it('splits javascript case names on still and unchanged', () => {
      const baseline = report([fn({ name: 'completeTask', bodyHash: 'a' })]);
      const current = report([fn({ name: 'completeTask', bodyHash: 'b' })]);
      const impact = buildImpactReport(baseline, current, jsCases);
      expect(impact?.changeTests).toEqual([
        'reopen un-completes a done task in stored state',
        'reopen unknown id throws',
        'reopen of an open task is a no-op',
        'reopened task returns to the open filter',
      ]);
      expect(impact?.regressionTests).toEqual([
        'complete still works',
        'complete unknown id still throws',
        'filter order unchanged',
        'filter keyword unchanged',
        'overdue unchanged',
      ]);
    });

    it('reads the visible reopen suite as change work and its untouched case as a regression', () => {
      const baseline = report([fn({ name: 'complete_task', bodyHash: 'a' })]);
      const current = report([fn({ name: 'complete_task', bodyHash: 'b' })]);
      const impact = buildImpactReport(baseline, current, [
        passed('ReopenVisible.test_reopen_uncompletes'),
        passed('ReopenVisible.test_existing_complete_untouched'),
      ]);
      expect(impact?.changeTests).toEqual(['ReopenVisible.test_reopen_uncompletes']);
      expect(impact?.regressionTests).toEqual(['ReopenVisible.test_existing_complete_untouched']);
    });

    it('counts failing and errored cases too, and de-duplicates names', () => {
      const baseline = report([fn({ name: 'complete_task', bodyHash: 'a' })]);
      const current = report([fn({ name: 'complete_task', bodyHash: 'b' })]);
      const impact = buildImpactReport(baseline, current, [
        { name: 'ReopenChange.test_reopen_unknown_id_raises', status: 'failed' },
        { name: 'ReopenChange.test_reopen_unknown_id_raises', status: 'failed' },
        { name: 'Regression.test_overdue_unchanged', status: 'errored' },
      ]);
      expect(impact?.changeTests).toEqual(['ReopenChange.test_reopen_unknown_id_raises']);
      expect(impact?.regressionTests).toEqual(['Regression.test_overdue_unchanged']);
    });

    it('tolerates a missing or malformed case list', () => {
      const baseline = report([fn({ name: 'complete_task', bodyHash: 'a' })]);
      const current = report([fn({ name: 'complete_task', bodyHash: 'b' })]);
      const impact = buildImpactReport(baseline, current, undefined as unknown as TestCaseResult[]);
      expect(impact?.changeTests).toEqual([]);
      expect(impact?.regressionTests).toEqual([]);
      const blank = buildImpactReport(baseline, current, [
        { name: '', status: 'passed' },
      ] as TestCaseResult[]);
      expect(blank?.changeTests).toEqual([]);
    });
  });

  it('caps the function rows', () => {
    const baseFns = Array.from({ length: 260 }, (_, i) => fn({ name: `f${i}`, bodyHash: `x${i}` }));
    const currentFns = Array.from({ length: 260 }, (_, i) => fn({ name: `f${i}`, bodyHash: `y${i}` }));
    const impact = buildImpactReport(report(baseFns), report(currentFns), []);
    expect(impact?.functions).toHaveLength(200);
  });

  it('is pure: the same input yields the same report', () => {
    const baseline = report([fn({ name: 'complete_task', bodyHash: 'a' })]);
    const current = report([fn({ name: 'complete_task', bodyHash: 'b' })]);
    expect(buildImpactReport(baseline, current, maintenanceCases)).toEqual(
      buildImpactReport(baseline, current, maintenanceCases),
    );
  });
});
