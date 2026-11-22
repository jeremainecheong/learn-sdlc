/**
 * The finished TaskTrackr learner's Maintenance impact report, as a module so
 * the change-impact tests and the teacher's dossier tests read the same data.
 * The API's report marks the 14 functions of `api/routes/tasks.py`, a file the
 * Maintenance review does not read (read-only in that phase), as removed.
 */
import type { AnalyzerFunction, ImpactFunction, ImpactReport } from '@learnsdlc/shared';

export const REPO_TASKS = ['_to_task', 'get_task', 'list_tasks', 'overdue_tasks', 'set_tags', 'create_task', 'update_task', 'complete_task', 'reopen_task', 'delete_task'];
export const REPO_COMMENTS = ['_to_comment', 'list_comments', 'add_comment', 'count_for_task'];
export const ROUTES_COMMENTS = ['list_task_comments', 'create_task_comment'];
export const ROUTES_TASKS = ['__init__', '_title', '_priority', '_due_date', '_status', '_tags', 'get_list_tasks', 'post_list_task', 'get_overdue_tasks', 'get_task', 'patch_task', 'complete_task', 'reopen_task', 'delete_task'];

const fn = (path: string, name: string, i: number, calls: string[] = []): AnalyzerFunction =>
  ({ name, qualname: name, path, line: 10 + i * 8, endLine: 16 + i * 8, complexity: 2, calls, bodyHash: `${path}:${name}` }) as AnalyzerFunction;

/** What the Maintenance review read: its own editable targets only. */
export const current: AnalyzerFunction[] = [
  ...REPO_TASKS.map((n, i) => fn('api/repository/tasks.py', n, i, n === 'list_tasks' ? ['_to_task', 'count_for_task'] : [])),
  ...REPO_COMMENTS.map((n, i) => fn('api/repository/comments.py', n, i, n === 'add_comment' ? ['get_task', '_to_comment'] : [])),
  ...ROUTES_COMMENTS.map((n, i) => fn('api/routes/comments.py', n, i, n === 'create_task_comment' ? ['add_comment'] : ['list_comments'])),
];

const row = (f: AnalyzerFunction, change: ImpactFunction['change'], tests = 2): ImpactFunction => ({
  name: f.name, path: f.path, line: f.line, endLine: f.endLine, complexity: f.complexity, change,
  reachedBy: Array.from({ length: tests }, (_, i) => `test_${f.name}_${i}`),
});

/** The API's report on the finished project: the current rows, then every earlier function it did not find again. */
export const IMPACT: ImpactReport = {
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
export const EDITABLE = [
  'design/contracts.json',
  'maintenance/change-request.json',
  'shared/contract/api.json',
  'api/repository/tasks.py',
  'api/repository/comments.py',
  'api/routes/comments.py',
  'web/src/components/TaskRow.tsx',
];
