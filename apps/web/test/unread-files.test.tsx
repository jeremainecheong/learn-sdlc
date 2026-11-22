// @vitest-environment jsdom
/**
 * Files the analyzer does not read are not a clean result.
 *
 * The analyzer reads Python (.py) and JavaScript (.js, .jsx) and skips every
 * other file (apps/api/runner/analyzer.py, `analyzer_for`), so a phase whose
 * files are TypeScript (Deadline badge) comes back with `metrics.files === 0`
 * and no issue (`analysisNotMeasured`, components/pr/analysisReach.ts).
 *
 * - The IDE's Health panel drew that as "Code quality 100", "Docstrings 100%"
 *   and "Nothing to fix. The analyzer found no findings in your files." Now
 *   the Code quality readout says "Not measured" with the reason, and draws no
 *   figure, finding line or trend measured on nothing. Its intro said the
 *   analyzer reads "the Python files you can edit"; it reads JavaScript too.
 * - Maintenance's Change impact card said "No call graph yet ... Submit PR-6
 *   to get one." after PR-6 was reviewed, when the review held no impact
 *   reading. After a review it now says no function was read; before one, the
 *   words are as they were.
 * - The IDE Change tab's Contract v2 card said "The three above do not
 *   change." whatever the count above it. The number now comes from the
 *   operations listed. On a change request with no contract (the teacher's
 *   contract switch off, as on Deadline badge, whose Design has no API
 *   contract), the card says there is no contract to write rather than
 *   "No operations were seeded" and "has no contract yet".
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest,
  type AnalyzerReport, type ChangeRequest, type FeedbackReport, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { HealthPanel } from '@/components/workspace/HealthPanel';
import { ChangeImpactCard } from '@/components/workspace/panels/maintenance/ChangeCards';
import { MaintenanceTools } from '@/components/workspace/panels/maintenance/Tools';
import { CONTRACTS_JSON, amendmentPurpose, serializeContracts, type ContractOperation } from '@/components/workspace/panels/maintenance/contracts';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';
import type { PhasePanelProps } from '@/components/workspace/panels/types';
import { namedMarkup } from './support/markup-snapshot';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

/* ------------------------------------------------------- 7: Health panel */

const OLD_INTRO = 'The analyzer reads the Python files you can edit.';
const NEW_INTRO = 'The analyzer reads the Python and JavaScript files you can edit.';
const REASON = "The analyzer reads Python and JavaScript, and none of this phase's files is one it reads.";

const nothingRead: AnalyzerReport = { issues: [], metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 1 }, functions: [] };
const measured: AnalyzerReport = {
  issues: [{ path: 'api/tasks.py', line: 12, severity: 'warning', rule: 'todo-left', message: 'A TODO is still in the code.' }],
  metrics: { files: 2, functions: 5, todosRemaining: 1, maxComplexity: 4, docstringCoverage: 0.6 },
};
const clean: AnalyzerReport = { issues: [], metrics: { files: 2, functions: 5, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 1 } };
const health = (analysis: AnalyzerReport) =>
  renderToStaticMarkup(<HealthPanel analysis={analysis} submissions={[]} attempt={2} stale={false} onOpen={() => {}} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('the Health panel', () => {
  it('nothing read: Code quality is not measured, with the reason, and no figure measured on nothing', () => {
    const html = health(nothingRead);
    const words = text(html);
    expect(words).toContain('Not measured');
    expect(words).toContain(REASON);
    expect(html).not.toMatch(/>100</);
    expect(words).not.toContain('100%');
    expect(words).not.toContain('Nothing to fix');
    expect(html).not.toContain('data-testid="health-docstrings"');
    expect(html).not.toContain('data-testid="health-trend-sentence"');
    expect(/data-testid="health-quality"[\s\S]*?Code quality/.exec(html)?.[0]).toContain('Not measured');
  });

  it('the intro names both languages the analyzer reads', () => {
    expect(text(health(nothingRead))).toContain(`From submission 2. ${NEW_INTRO}`);
    expect(text(health(measured))).toContain(`From submission 2. ${NEW_INTRO}`);
    expect(text(health(measured))).not.toContain(OLD_INTRO);
  });

  it('a report that read files matches its snapshot', async () => {
    await expect(namedMarkup([['one finding', health(measured)], ['clean', health(clean)]]))
      .toMatchFileSnapshot('__snapshots__/health-panel-files-read.html');
    expect(text(health(clean))).toContain('Nothing to fix. The analyzer found no findings in your files.');
  });
});

/* ----------------------------------------------- 8: Change impact, empty */

const BEFORE = { title: 'No call graph yet', body: 'The graph is drawn from the static analysis in the verdict. Submit PR-6 to get one.' };
const AFTER = { title: 'No call graph', body: 'The review of PR-6 read no function in your files, so there is no call graph to draw.' };

describe("the change request page's Change impact card", () => {
  const card = (awaitingVerdict: boolean) =>
    text(renderToStaticMarkup(<ChangeImpactCard m={{ impactCount: 0, awaitingVerdict } as unknown as MaintenanceModel} impact={undefined} functions={[]} onOpen={() => {}} pr="PR-6" />));
  it('after a review with no impact reading: says no function was read', () => {
    expect(card(false)).toContain(`${AFTER.title} ${AFTER.body}`);
    expect(card(false)).not.toContain('Submit PR-6');
  });
  it('before any review the card reads its before-review words', () => {
    expect(card(true)).toContain(`${BEFORE.title} ${BEFORE.body}`);
  });
});

/* ------------------------------------------------ the IDE's Change tab */

const RECORD: ChangeRequest = {
  ...EMPTY_CHANGE_REQUEST,
  impact: { operations: ['isOverdue'], screens: [], files: ['web/src/lib/overdue.ts'] },
} as ChangeRequest;
const verdict = (impact?: FeedbackReport['impact']): FeedbackReport =>
  ({
    passed: true,
    tests: { passed: 1, failed: 0, errored: 0, total: 1, cases: [{ name: 'case_1', status: 'passed' }] },
    ...(impact ? { impact } : {}),
  }) as unknown as FeedbackReport;
const op = (name: string, satisfies = 'US-1'): ContractOperation => ({ name, satisfies, inputs: 'a task', returns: 'the task', errors: 'none' });

function renderTab({ report, contract = false, operations }: { report: FeedbackReport | null; contract?: boolean; operations?: ContractOperation[] }) {
  const files = [
    { path: 'web/src/lib/overdue.ts', content: 'export const isOverdue = () => false;\n', editable: true, language: 'typescript' },
    { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(RECORD), editable: true, language: 'json' },
    ...(operations ? [{ path: CONTRACTS_JSON, content: serializeContracts({ operations }), editable: true, language: 'json' }] : []),
  ];
  const detail = {
    id: 'p-m', key: 'maintenance', title: 'Maintenance', order: 6, place: 6, count: 6, projectSlug: 'deadline-badge', attempts: report ? 1 : 0,
    change: { ticket: { id: 'CR-1', title: 'Completed tasks are not overdue', summary: '', acceptance: [{ id: 'AC-1', line: 'A completed task is never overdue.' }] }, contract, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } },
    files,
  } as unknown as PhaseDetail;
  const submission = report
    ? ({ id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: '2026-11-10T13:32:00Z', report } as unknown as SubmissionView)
    : null;
  const props = {
    detail, files: {}, submission, submissions: submission ? [submission] : [], enrollment: null, setFile: vi.fn(),
    helpers: { openFile: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), fileText: () => '', submitNow: vi.fn(), setNotice: vi.fn(), busy: false },
  } as unknown as PhasePanelProps;
  act(() => root.render(<MaintenanceTools {...props} />));
}

describe("the IDE Change tab's Change impact section", () => {
  it('after a review with no impact reading (Deadline badge): says no function was read', () => {
    renderTab({ report: verdict() });
    const words = byTestId('phase-maintenance-impact')!.textContent ?? '';
    expect(words).toContain(`${AFTER.title}${AFTER.body}`);
    expect(words).not.toContain('Submit PR-6');
  });
  it('before any review the card reads its before-review words', () => {
    renderTab({ report: null });
    expect(byTestId('phase-maintenance-impact')!.textContent).toContain(`${BEFORE.title}${BEFORE.body}`);
  });
  it('a review with a reading draws the graph, not an empty state', () => {
    const impact = {
      baseline: 'scaffold',
      functions: [{ name: 'isOverdue', path: 'web/src/lib/overdue.js', line: 1, endLine: 3, complexity: 1, change: 'changed', reachedBy: ['case_1'] }],
      changeTests: [], regressionTests: [],
    } as unknown as FeedbackReport['impact'];
    renderTab({ report: verdict(impact) });
    const words = byTestId('phase-maintenance-impact')!.textContent ?? '';
    expect(words).not.toContain('No call graph');
  });
});

/* -------------------------------------------------------- 9: Contract v2 */

describe("the IDE Change tab's Contract v2 card", () => {
  const purpose = () => {
    const section = byTestId('phase-maintenance-contracts-v2')!;
    return section.textContent ?? '';
  };

  it('the count above comes from the operations listed', () => {
    expect(amendmentPurpose('CR-2', 0)).toBe('CR-2 asks for one new operation.');
    expect(amendmentPurpose('CR-2', 1)).toBe('CR-2 asks for one new operation. The one above does not change.');
    expect(amendmentPurpose('CR-2', 2)).toBe('CR-2 asks for one new operation. The two above do not change.');
    expect(amendmentPurpose('CR-2', 14)).toBe('CR-2 asks for one new operation. The 14 above do not change.');
    renderTab({ report: null, contract: true, operations: [op('list_tasks()'), op('add_task(title)')] });
    expect(purpose()).toContain('CR-1 asks for one new operation. The two above do not change.');
    expect(purpose()).not.toContain('three');
  });

  it('three operations above say they do not change', () => {
    expect(amendmentPurpose('CR-2', 3)).toBe('CR-2 asks for one new operation. The three above do not change.');
    renderTab({ report: null, contract: true, operations: [op('list_tasks()'), op('add_task(title)'), op('complete_task(task_id)')] });
    expect(purpose()).toContain('CR-1 asks for one new operation. The three above do not change.');
  });

  it('a contract switch that is on with no operation seeded names no count', () => {
    renderTab({ report: null, contract: true });
    expect(purpose()).toContain('No operations were seeded');
    expect(purpose()).toContain('CR-1 asks for one new operation.');
    expect(purpose()).not.toContain('above do');
  });

  it('a change request with no contract (Deadline badge): the card says so, and nothing it does not hold', () => {
    renderTab({ report: verdict(), contract: false });
    const words = purpose();
    expect(words).toContain('Contract v2');
    expect(words).toContain('This change request asks for no contract, so there is no contract to write here.');
    expect(words).not.toContain('No operations were seeded');
    expect(words).not.toContain('has no contract yet');
    expect(words).not.toContain('asks for one new operation');
    expect(words).not.toContain('the ledger reads the code as unclaimed');
  });
});
