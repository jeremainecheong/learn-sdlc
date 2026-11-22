// @vitest-environment jsdom
/**
 * The IDE's Change tab: the same reading as the change request page
 * (change-impact-scope.test.tsx). A file the Maintenance review did not read
 * again is not counted "removed" in the section's chip nor drawn removed in the
 * graph, and a line under the graph names it; a function no test is named for
 * reads so in the touched list. With every earlier file read again, the chip
 * and the graph count every missing function as removed.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest,
  type AnalyzerFunction, type ChangeRequest, type FeedbackReport, type ImpactFunction, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { MaintenanceTools } from '@/components/workspace/panels/maintenance/Tools';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

const fn = (path: string, name: string, line: number): AnalyzerFunction =>
  ({ name, qualname: name, path, line, endLine: line + 5, complexity: 2, calls: [], bodyHash: `${path}:${name}` }) as AnalyzerFunction;
const row = (f: AnalyzerFunction, change: ImpactFunction['change'], reachedBy: string[]): ImpactFunction =>
  ({ name: f.name, path: f.path, line: f.line, endLine: f.endLine, complexity: f.complexity, change, reachedBy });

const current = [fn('api/repository/comments.py', 'add_comment', 10), fn('api/repository/tasks.py', 'list_tasks', 20)];
const routes = ['get_task', 'patch_task', 'complete_task'].map((n, i) => fn('api/routes/tasks.py', n, 10 + i * 8));
const IMPACT_FUNCTIONS: ImpactFunction[] = [
  row(current[0], 'added', []),
  row(current[1], 'changed', ['test_list_tasks_counts_comments']),
  ...routes.map((f) => row(f, 'removed', ['test_tasks_api'])),
];

function renderTab(functions: ImpactFunction[]) {
  const record = { ...EMPTY_CHANGE_REQUEST, impact: { operations: ['addComment'], screens: [], files: ['api/repository/comments.py'] } } as ChangeRequest;
  const report = {
    passed: true,
    tests: { passed: 8, failed: 0, errored: 0, total: 8, cases: [{ name: 'test_comment_added', status: 'passed' }] },
    staticAnalysis: { issues: [], metrics: { files: 2, functions: 2, todosRemaining: 0, maxComplexity: 2, docstringCoverage: 1 }, functions: current },
    impact: { baseline: 'scaffold', functions, changeTests: [], regressionTests: [] },
  } as unknown as FeedbackReport;
  const detail = {
    id: 'p-m', key: 'maintenance', title: 'Maintenance', order: 6, place: 6, count: 6, projectSlug: 'tasktrackr', attempts: 1,
    change: { ticket: { id: 'CR-2', title: 'Comments on a task', summary: '', acceptance: [{ id: 'AC-1', line: 'A task takes comments.' }] }, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } },
    files: [
      { path: 'api/repository/comments.py', content: 'def add_comment():\n    pass\n', editable: true, language: 'python' },
      { path: 'api/repository/tasks.py', content: 'def list_tasks():\n    pass\n', editable: true, language: 'python' },
      { path: 'api/routes/tasks.py', content: 'def get_task():\n    pass\n', editable: false, language: 'python' },
      { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(record), editable: true, language: 'json' },
    ],
  } as unknown as PhaseDetail;
  const submission = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: '2026-11-10T13:32:00Z', report } as unknown as SubmissionView;
  const props = {
    detail, files: {}, submission, submissions: [submission], enrollment: null, setFile: vi.fn(),
    helpers: { openFile: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), fileText: () => '', submitNow: vi.fn(), setNotice: vi.fn(), busy: false },
  } as unknown as PhasePanelProps;
  act(() => root.render(<MaintenanceTools {...props} />));
}

const section = () => byTestId('phase-maintenance-impact')!;

describe("the IDE's Change tab", () => {
  it('a read-only file the review did not read again: no "removed" in the chip or the graph, one line naming it', () => {
    renderTab(IMPACT_FUNCTIONS);
    const words = section().textContent ?? '';
    expect(words).toContain('1 added, 1 changed');
    expect(words).not.toMatch(/removed,|\d removed/);
    expect(section().querySelector('svg')!.innerHTML).not.toContain(', removed,');
    expect(byTestId('phase-maintenance-impact-unread')!.textContent).toBe(
      'api/routes/tasks.py (3 functions) is not a file you edit in this phase, so this review did not read it again: it is left out of the graph after the change, not removed.',
    );
  });

  it('the touched list says a function no test is named for, in those words', () => {
    renderTab(IMPACT_FUNCTIONS);
    const words = section().textContent ?? '';
    expect(words).toContain('No test in this verdict is named for it.');
    expect(words).toContain('No test by name');
    expect(words).not.toContain('No test in this verdict reaches it.');
  });

  it('with no unread file the chip reads the added and changed counts, and no unread line is added', () => {
    renderTab(IMPACT_FUNCTIONS.slice(0, 2));
    const words = section().textContent ?? '';
    expect(words).toContain('1 added, 1 changed');
    expect(byTestId('phase-maintenance-impact-unread')).toBeNull();
  });
});
