// @vitest-environment jsdom
/**
 * Maintenance, the IDE's Change tab, on a change request that asks for no
 * contract (the teacher's switch off, `change.contract: false`, as on Deadline
 * badge). The Contract v2 card says "This change request asks for no
 * contract, so there is no contract to write here.", so the acceptance list
 * above it must not hold the row "The contract comes first: Write <op> in
 * design/contracts.json before the code, or the code is unclaimed." With the
 * switch off that row is not drawn; with it on the row is drawn. "No
 * operations were seeded" is not drawn with the switch off either
 * (unread-files.test.tsx) and is re-checked here.
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

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

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

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const FIRST = 'The contract comes first';

describe("the IDE Change tab's acceptance list", () => {
  it('no contract asked for: no "contract comes first" row and no unclaimed code, and no seeded-operations message', () => {
    renderTab({ report: verdict(), contract: false });
    const words = text(host.innerHTML);
    expect(words).not.toContain(FIRST);
    expect(words).not.toContain('or the code is unclaimed');
    expect(words).not.toContain('No operations were seeded');
    expect(words).toContain('This change request asks for no contract, so there is no contract to write here.');
  });

  it('with the contract switch on the row reads the contract sentence', () => {
    renderTab({ report: null, contract: true });
    const words = text(host.innerHTML);
    expect(words).toContain(FIRST);
    expect(words).toMatch(/before the code, or the code is unclaimed\./);
  });
});
