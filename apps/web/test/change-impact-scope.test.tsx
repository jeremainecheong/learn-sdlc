/**
 * The change request's Change impact "After" graph marked all 14
 * functions of TaskTrackr's `api/routes/tasks.py` as removed on a finished
 * project, while the app runs those routes.
 *
 * The cause is upstream of the web. The API compares the analyzer's reading at
 * the end of Implementation with the reading of the Maintenance review
 * (`apps/api/src/feedback/impact.ts`, `buildImpactReport`), and each review reads
 * only its own phase's editable targets (`feedback.service.ts`,
 * `sandbox.analyze(files, checks.editableTargets, ...)`). TaskTrackr's
 * Implementation edits `api/repository/tasks.py` and `api/routes/tasks.py`; its
 * Maintenance edits `api/repository/tasks.py`, `api/repository/comments.py`,
 * `api/routes/comments.py` and mounts `api/routes/tasks.py` read-only. So the
 * second reading never holds `api/routes/tasks.py`, and every function of it
 * comes back `removed`.
 *
 * The web now marks a function removed only where this review read its file
 * (`readScope`); the others are left out of the graph after the change and
 * named under it. The shape below is the finished learner's (file bands, function names, which file holds
 * which); test counts are trimmed to what the boxes read.
 *
 * Also pinned: two files holding a function of the same name are two boxes
 * (`fnKey`), and a box no test is named for reads "no test by name" (the API
 * counts a test by its name, never by a call), with the legend saying the same.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnalyzerFunction, ImpactFunction, ImpactReport } from '@learnsdlc/shared';
import {
  buildImpactGraph,
  impactNodes,
  markCounts,
  nodeSub,
  readScope,
  unreadLine,
  withoutAdded,
} from '@/components/workspace/panels/maintenance/impact';
import { ChangeImpact } from '@/components/workspace/panels/maintenance/ChangeImpact';
import { GraphCanvas, ImpactGraph, nodeLabel } from '@/components/workspace/panels/maintenance/ImpactGraph';

const REPO_TASKS = ['_to_task', 'get_task', 'list_tasks', 'overdue_tasks', 'set_tags', 'create_task', 'update_task', 'complete_task', 'reopen_task', 'delete_task'];
const REPO_COMMENTS = ['_to_comment', 'list_comments', 'add_comment', 'count_for_task'];
const ROUTES_COMMENTS = ['list_task_comments', 'create_task_comment'];
const ROUTES_TASKS = ['__init__', '_title', '_priority', '_due_date', '_status', '_tags', 'get_list_tasks', 'post_list_task', 'get_overdue_tasks', 'get_task', 'patch_task', 'complete_task', 'reopen_task', 'delete_task'];

const fn = (path: string, name: string, i: number, calls: string[] = []): AnalyzerFunction =>
  ({ name, qualname: name, path, line: 10 + i * 8, endLine: 16 + i * 8, complexity: 2, calls, bodyHash: `${path}:${name}` }) as AnalyzerFunction;

/** What the Maintenance review read: its own editable targets only. */
const current: AnalyzerFunction[] = [
  ...REPO_TASKS.map((n, i) => fn('api/repository/tasks.py', n, i, n === 'list_tasks' ? ['_to_task', 'count_for_task'] : [])),
  ...REPO_COMMENTS.map((n, i) => fn('api/repository/comments.py', n, i, n === 'add_comment' ? ['get_task', '_to_comment'] : [])),
  ...ROUTES_COMMENTS.map((n, i) => fn('api/routes/comments.py', n, i, n === 'create_task_comment' ? ['add_comment'] : ['list_comments'])),
];

const row = (f: AnalyzerFunction, change: ImpactFunction['change'], tests = 2): ImpactFunction => ({
  name: f.name, path: f.path, line: f.line, endLine: f.endLine, complexity: f.complexity, change,
  reachedBy: Array.from({ length: tests }, (_, i) => `test_${f.name}_${i}`),
});

/** The API's report on the finished project: the current rows, then every earlier function it did not find again. */
const IMPACT: ImpactReport = {
  baseline: 'scaffold',
  functions: [
    ...current.map((f) =>
      row(
        f,
        f.path === 'api/repository/tasks.py' ? (f.name === 'list_tasks' || f.name === 'overdue_tasks' ? 'changed' : 'unchanged') : 'added',
        f.name === 'add_comment' || f.name === 'create_task_comment' ? 0 : 2,
      ),
    ),
    ...ROUTES_TASKS.map((n, i) => row(fn('api/routes/tasks.py', n, i), 'removed')),
  ],
  changeTests: [],
  regressionTests: [],
};

/** The Maintenance phase's editable files, as the room's detail lists them. */
const EDITABLE = [
  'design/contracts.json',
  'maintenance/change-request.json',
  'shared/contract/api.json',
  'api/repository/tasks.py',
  'api/repository/comments.py',
  'api/routes/comments.py',
  'web/src/components/TaskRow.tsx',
];

const afterSvg = (html: string) => {
  const at = html.indexOf('data-testid="phase-maintenance-impact-after"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf('</svg>', at));
};
const beforeSvg = (html: string) => html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));

describe('a file this review did not read is not "removed"', () => {
  it('readScope leaves api/routes/tasks.py out and names it, with its 14 functions', () => {
    const scope = readScope(IMPACT, current, EDITABLE);
    expect(scope.unread).toEqual([{ path: 'api/routes/tasks.py', count: 14 }]);
    expect(scope.impact!.functions.filter((f) => f.change === 'removed')).toEqual([]);
    expect(scope.impact!.functions).toHaveLength(current.length);
    expect(markCounts(impactNodes(scope.impact, current))).toEqual([
      { mark: 'added', n: 6 },
      { mark: 'changed', n: 2 },
      { mark: 'unchanged', n: 8 },
    ]);
  });

  it('the change page: After draws no removed box and no api/routes/tasks.py; the line under it says why; Before keeps the earlier code', () => {
    const html = renderToStaticMarkup(<ChangeImpact impact={IMPACT} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />);
    const after = afterSvg(html);
    expect(after).not.toContain(', removed,');
    expect(after).not.toContain('api/routes/tasks.py');
    expect(after).toContain('api/routes/comments.py');
    expect(beforeSvg(html)).toContain('api/routes/tasks.py');
    expect(beforeSvg(html)).toContain('get_overdue_tasks');
    expect(html).toContain(
      'api/routes/tasks.py (14 functions) is not a file you edit in this phase, so this review did not read it again: it is left out of the graph after the change, not removed.',
    );
  });

  it("the IDE's Change tab graph does the same", () => {
    const html = renderToStaticMarkup(<ImpactGraph impact={IMPACT} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />);
    const svg = beforeSvg(html);
    expect(svg).not.toContain(', removed,');
    expect(svg).not.toContain('api/routes/tasks.py');
    expect(html).toContain('data-testid="phase-maintenance-impact-unread"');
  });

  it('a function really removed from a file this review read stays removed', () => {
    const gone = row(fn('api/repository/tasks.py', 'old_helper', 20), 'removed');
    const emptied = row(fn('api/routes/comments_old.py', 'legacy', 1), 'removed');
    const impact = { ...IMPACT, functions: [...IMPACT.functions, gone, emptied] };
    const scope = readScope(impact, current, [...EDITABLE, 'api/routes/comments_old.py']);
    expect(scope.impact!.functions.filter((f) => f.change === 'removed').map((f) => f.name)).toEqual(['old_helper', 'legacy']);
    expect(scope.unread).toEqual([{ path: 'api/routes/tasks.py', count: 14 }]);
    const html = renderToStaticMarkup(<ChangeImpact impact={impact} functions={current} editablePaths={[...EDITABLE, 'api/routes/comments_old.py']} onOpen={() => {}} />);
    expect(afterSvg(html)).toContain('old_helper, removed,');
  });

  it('two unread files are named in one line', () => {
    expect(unreadLine([{ path: 'a.py', count: 1 }, { path: 'b.py', count: 3 }])).toBe(
      'a.py (1 function) and b.py (3 functions) are not files you edit in this phase, so this review did not read them again: they are left out of the graph after the change, not removed.',
    );
  });

  it('a reading with no unread file comes back as it was, and nothing is said under the graph', () => {
    const plain: ImpactReport = { ...IMPACT, functions: IMPACT.functions.filter((f) => f.change !== 'removed') };
    const scope = readScope(plain, current, EDITABLE);
    expect(scope.impact).toBe(plain);
    expect(scope.unread).toEqual([]);
    expect(readScope(undefined, current, EDITABLE)).toEqual({ impact: undefined, unread: [] });
    const html = renderToStaticMarkup(<ChangeImpact impact={plain} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />);
    expect(html).not.toContain('phase-maintenance-impact-unread');
    expect(html).not.toContain('not removed');
  });
});

describe('two files with a function of the same name are two boxes', () => {
  it('Before draws get_task, complete_task, reopen_task and delete_task once in each file', () => {
    const before = withoutAdded(IMPACT, current);
    const graph = buildImpactGraph(before.impact, before.analyzed, 700);
    for (const name of ['get_task', 'complete_task', 'reopen_task', 'delete_task']) {
      expect(graph.nodes.filter((n) => n.name === name).map((n) => n.path).sort()).toEqual(['api/repository/tasks.py', 'api/routes/tasks.py']);
    }
    // Each box keeps its own mark: the repository's get_task is unchanged, the route's is the earlier reading's.
    const marks = Object.fromEntries(graph.nodes.filter((n) => n.name === 'get_task').map((n) => [n.path, n.change]));
    expect(marks).toEqual({ 'api/repository/tasks.py': 'unchanged', 'api/routes/tasks.py': 'removed' });
  });

  it("a call by name goes to the function in the caller's file, else the first one drawn, never the last", () => {
    const graph = buildImpactGraph(IMPACT, current, 700);
    const box = (path: string, name: string) => graph.nodes.find((n) => n.path === path && n.name === name)!;
    const edge = graph.edges.find((e) => e.key.startsWith('api/repository/comments.py::add_comment->'))!;
    expect(edge.key).toBe('api/repository/comments.py::add_comment->api/repository/tasks.py::get_task');
    const target = box('api/repository/tasks.py', 'get_task');
    expect(edge.d.endsWith(`${target.x + target.w / 2} ${target.y}`) || edge.d.includes(`${target.x + target.w}`)).toBe(true);
  });

  it('no React key is drawn twice (renders without a duplicate-key warning)', () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      renderToStaticMarkup(<ChangeImpact impact={IMPACT} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />);
    } finally {
      console.error = original;
    }
    expect(errors.filter((e) => String(e).includes('same key'))).toEqual([]);
  });
});

describe('"no test" beside a change suite that passed', () => {
  it('a box no test is named for says so, and the legend says what the count is', () => {
    expect(nodeSub({ complexity: 5, reachedBy: [] })).toBe('no test by name, cx 5');
    expect(nodeSub({ complexity: 3, reachedBy: ['a'] })).toBe('1 test, cx 3');
    expect(nodeSub({ complexity: 1, reachedBy: ['a', 'b'] })).toBe('2 tests, cx 1');
    const html = renderToStaticMarkup(<ChangeImpact impact={IMPACT} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />);
    expect(html).toContain('add_comment, added, no test by name, cx 2');
    expect(html).toContain('No test named for it');
    expect(html).toContain('Tests named for it, against the busiest function');
    expect(html).not.toContain('No test reaches it');
  });
});

describe('the Before graph says nothing of removal for a file this review did not read', () => {
  /** Every box's accessible name in the Before drawing, and its tooltip, which must be the same words. */
  const beforeLabels = (html: string) => {
    const svg = beforeSvg(html);
    const names = [...svg.matchAll(/<g class="mi-node"[^>]*aria-label="([^"]*)"[^>]*><title>([^<]*)<\/title>/g)];
    for (const [, name, title] of names) expect(title).toBe(name);
    return names.map(([, name]) => name);
  };
  const html = () => renderToStaticMarkup(<ChangeImpact impact={IMPACT} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />);

  it("api/routes/tasks.py's 14 boxes are named as the earlier code: name, tests, file and line, no mark's word", () => {
    const labels = beforeLabels(html());
    const routes = labels.filter((l) => l.includes('api/routes/tasks.py'));
    expect(routes).toHaveLength(14);
    expect(routes).toContain('get_task, 2 tests, cx 2, api/routes/tasks.py line 82');
    expect(routes).toContain('__init__, 2 tests, cx 2, api/routes/tasks.py line 10');
    for (const label of routes) expect(label).not.toMatch(/removed|unchanged|changed|added/i);
    expect(beforeSvg(html())).not.toContain('removed');
  });

  it('every other Before box keeps the words it had before this pass (9eaa0fc4: name, mark, tests, file and line)', () => {
    const labels = beforeLabels(html());
    expect(labels).toContain('get_task, unchanged, 2 tests, cx 2, api/repository/tasks.py line 18');
    expect(labels).toContain('list_tasks, changed, 2 tests, cx 2, api/repository/tasks.py line 26');
    expect(labels.filter((l) => l.includes('api/repository/tasks.py'))).toHaveLength(REPO_TASKS.length);
    for (const label of labels.filter((l) => !l.includes('api/routes/tasks.py'))) expect(label).toMatch(/, (unchanged|changed), /);
  });

  it('a function this review read and that really is removed is named "removed" in Before', () => {
    const gone = row(fn('api/repository/tasks.py', 'old_helper', 20), 'removed');
    const impact = { ...IMPACT, functions: [...IMPACT.functions, gone] };
    const labels = beforeLabels(renderToStaticMarkup(<ChangeImpact impact={impact} functions={current} editablePaths={EDITABLE} onOpen={() => {}} />));
    expect(labels).toContain('old_helper, removed, 2 tests, cx 2, api/repository/tasks.py line 170');
    expect(labels.filter((l) => l.includes(', removed,'))).toEqual(['old_helper, removed, 2 tests, cx 2, api/repository/tasks.py line 170']);
  });

  it("a drawing told of no unread file names every box as 9eaa0fc4's did, the After graph included", () => {
    const before = withoutAdded(IMPACT, current);
    const graph = buildImpactGraph(before.impact, before.analyzed, 700);
    const plain = renderToStaticMarkup(<GraphCanvas graph={graph} badges={false} onOpen={() => {}} />);
    const old = (n: (typeof graph.nodes)[number]) => `${n.label}, ${n.change}, ${nodeSub(n)}, ${n.path} line ${n.line}`;
    for (const n of graph.nodes) {
      expect(nodeLabel(n)).toBe(old(n));
      expect(plain).toContain(`aria-label="${old(n)}"`);
    }
    const after = afterSvg(html());
    expect(after).toContain('add_comment, added, no test by name, cx 2, api/repository/comments.py line 26');
    expect(after).toContain('list_tasks, changed, 2 tests, cx 2, api/repository/tasks.py line 26');
  });
});
