// @vitest-environment jsdom
/**
 * Maintenance's assembled release record.
 *
 * The "What changed" line counts functions from the verdict's impact reading,
 * and the API writes none when the analyzer read no function on either side
 * (apps/api/src/feedback/impact.ts, `buildImpactReport`). Deadline badge's
 * files are TypeScript, which the analyzer does not read, so the card said
 * "Added: nothing. Changed: nothing." and "One line is still blank." although
 * the learner changed the code. With a verdict and no impact reading the line
 * now says there is no function-level reading and points at the pull
 * request's Files changed tab, and it is not counted as blank. With a reading,
 * a change to an existing function is not a blank line either.
 *
 * After the merge, a learner who wrote no merge message read "Written when
 * PR-6 merges." on both release cards. They now read that the pull request
 * merged and no merge message was written.
 *
 * TaskTrackr's reading (an impact report with an added function) renders as
 * recorded, held by a file snapshot of each card's HTML.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest,
  type ChangeRequest, type EnrollmentView, type FeedbackReport, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { blanksSentence, buildRelease, type ReleaseInput } from '@/components/workspace/panels/maintenance/release';
import { markupLines } from './support/markup-snapshot';
import { ReleaseRecordCard } from '@/components/workspace/panels/maintenance/ChangeCards';
import { MaintenanceTools } from '@/components/workspace/panels/maintenance/Tools';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const NO_READING =
  "No function-level reading of the changed files was made, so this line names no function. The pull request's Files changed tab shows what changed.";
const MERGED_NO_MESSAGE = 'PR-6 merged. No merge message was written.';

const RECORD: ChangeRequest = {
  ...EMPTY_CHANGE_REQUEST,
  impact: { operations: ['isOverdue'], screens: [], files: ['web/src/lib/overdue.ts'] },
  tests: [{ id: 'T1', suite: 'overdue regression tests', covers: ['AC-1'], result: 'pass' }],
  release: {
    version: '1.0.1',
    summary: 'Completed tasks no longer show overdue status',
    changes: [{ id: 'L1', line: 'isOverdue returns false for a completed task', covers: ['AC-1'] }],
    rollback: 'Revert the overdue.ts and overdue.test.ts changes.',
  },
} as ChangeRequest;

/** A verdict with eight passing cases; `impact` as given (Deadline badge has none). */
const verdict = (impact?: FeedbackReport['impact']): FeedbackReport =>
  ({
    passed: true,
    tests: { passed: 8, failed: 0, errored: 0, total: 8, cases: Array.from({ length: 8 }, (_, i) => ({ name: `case_${i + 1}`, status: 'passed' })) },
    ...(impact ? { impact } : {}),
  }) as unknown as FeedbackReport;

const input = (over: Partial<ReleaseInput>): ReleaseInput => ({
  projectTitle: 'Deadline badge',
  ticket: { id: 'CR-1', title: 'Completed tasks are not overdue', summary: 'A completed task showed as overdue.' },
  change: null,
  signature: 'isOverdue',
  contractTab: false,
  report: verdict(),
  impactRead: false,
  marks: [],
  added: [],
  record: RECORD,
  enrollment: null,
  phaseOrder: 6,
  ...over,
});
const whatChanged = (i: ReleaseInput) => buildRelease(i).lines.find((l) => l.label === 'What changed')!;

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the What changed line', () => {
  it('a verdict with no impact reading: never "nothing", points at Files changed, not blank', () => {
    const line = whatChanged(input({}));
    expect(line.text).toBe(NO_READING);
    expect(line.text).not.toContain('nothing');
    expect(line.state).not.toBe('todo');
    expect(line.todo).toBeUndefined();
    expect(blanksSentence(buildRelease(input({})))).toBe('Every line is written.');
  });

  it('a reading with one changed function and none added is not blank', () => {
    const line = whatChanged(input({ impactRead: true, marks: [{ mark: 'changed', n: 1 }, { mark: 'unchanged', n: 3 }] }));
    expect(line.text).toBe('Added: nothing. Changed: 1 function.');
    expect(line.state).toBe('pass');
    expect(line.todo).toBeUndefined();
  });

  it('a reading with a function added names it under Added', () => {
    const line = whatChanged(input({ impactRead: true, marks: [{ mark: 'added', n: 1 }], added: ['add_comment'], ticket: { id: 'CR-2', title: 'Comments', summary: 'Comments on a task' } }));
    expect(line).toEqual({ label: 'What changed', text: 'Added: add_comment (CR-2). Changed: nothing.', state: 'pass', todo: undefined });
  });

  it('a reading where nothing moved says nothing was added or changed', () => {
    const moved = whatChanged(input({ impactRead: true, marks: [{ mark: 'unchanged', n: 4 }] }));
    expect(moved).toEqual({ label: 'What changed', text: 'Added: nothing. Changed: nothing.', state: 'todo', todo: 'No new function yet. Write isOverdue in the code.' });
  });

  // Before any verdict the line read "Added: nothing. Changed: nothing.", which the card printed as a
  // change with nothing in it beside the learner's release text. It is now blank, and says it has not been read yet.
  it('no verdict at all: blank, never "nothing", and says it has not been read yet', () => {
    const none = whatChanged(input({ report: null }));
    expect(none).toEqual({ label: 'What changed', text: '', state: 'todo', todo: 'Not read yet. The review of your pull request reads which functions the change adds and changes.' });
  });
});

/** The change request page's card, given the record the model would hold. */
function renderCard(release: ReturnType<typeof buildRelease>) {
  const m = { ticket: { id: 'CR-1', title: 't', summary: '', acceptance: [] }, release } as unknown as MaintenanceModel;
  act(() => root.render(<ReleaseRecordCard m={m} pr="PR-6" />));
  return host.querySelector('[data-testid="phase-maintenance-release"]')!.textContent ?? '';
}
const mine = (notes: string | null) =>
  ({ projectTitle: 'Deadline badge', releases: [{ id: 'r6', enrollmentId: 'e', phaseKey: 'maintenance', phaseOrder: 6, version: '1.0.1', score: 100, notes, createdAt: '2026-11-12T10:00:00Z' }] }) as unknown as EnrollmentView;

describe('the change request page\'s Release record card', () => {
  it('Deadline badge before the merge: no "nothing", no blank line, the merge still to come', () => {
    const text = renderCard(buildRelease(input({})));
    expect(text).toContain(`What changed: ${NO_READING}`);
    expect(text).not.toContain('Added: nothing');
    // The merge publishes the record; it does not write its lines.
    expect(text).toContain('Every line is written. The record is published when PR-6 merges.');
  });

  it('merged with no merge message says so, never "Written when"', () => {
    const text = renderCard(buildRelease(input({ enrollment: mine(null) })));
    expect(text).toContain(MERGED_NO_MESSAGE);
    expect(text).not.toContain('Written when');
  });

  it('merged with a merge message quotes it', () => {
    const text = renderCard(buildRelease(input({ enrollment: mine('Shipped the fix.') })));
    expect(text).toContain('Merge message: Shipped the fix.');
  });

  it('TaskTrackr\'s reading matches its snapshot byte for byte', async () => {
    const record = { ...RECORD, release: { ...RECORD.release, version: '2.1.0', summary: 'Comments on a task' } } as ChangeRequest;
    renderCard(buildRelease(input({ impactRead: true, marks: [{ mark: 'added', n: 2 }, { mark: 'unchanged', n: 9 }], added: ['add_comment', 'list_comments'], record, projectTitle: 'TaskTrackr', ticket: { id: 'CR-2', title: 'Comments', summary: 'Learners asked for comments.' } })));
    const html = host.innerHTML;
    expect(html).toContain('2.1.0');
    expect(html).toContain('Comments on a task');
    await expect(markupLines(html)).toMatchFileSnapshot('__snapshots__/tasktrackr-release-record-card.html');
  });
});

/** The IDE's Change tab, drawn from the same model. */
function renderTab(report: FeedbackReport, enrollment: EnrollmentView | null, record: ChangeRequest = RECORD) {
  const detail = {
    id: 'p-m', key: 'maintenance', title: 'Maintenance', order: 6, place: 6, count: 6, projectSlug: 'deadline-badge', attempts: 0,
    change: { ticket: { id: 'CR-1', title: 'Completed tasks are not overdue', summary: 'A completed task showed as overdue.', acceptance: [{ id: 'AC-1', line: 'A completed task is never overdue.' }] }, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } },
    files: [
      { path: 'web/src/lib/overdue.ts', content: 'export const isOverdue = () => false;\n', editable: true, language: 'typescript' },
      { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(record), editable: true, language: 'json' },
    ],
  } as unknown as PhaseDetail;
  const submission = { id: 'rev-1', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: '2026-11-10T13:32:00Z', report } as unknown as SubmissionView;
  const props = {
    detail, files: {}, submission, submissions: [submission], enrollment, setFile: vi.fn(),
    helpers: { openFile: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), fileText: () => '', submitNow: vi.fn(), setNotice: vi.fn(), busy: false },
  } as unknown as PhasePanelProps;
  act(() => root.render(<MaintenanceTools {...props} />));
  return host.querySelector('[data-testid="phase-maintenance-release"]') as HTMLElement;
}

describe('the IDE Change tab\'s release record', () => {
  it('Deadline badge (no impact reading): the What changed row says so, not "nothing"', () => {
    const text = renderTab(verdict(), null).textContent ?? '';
    expect(text).toContain(NO_READING);
    expect(text).not.toContain('Added: nothing');
    expect(text).toContain('Written when PR-6 merges. You will not type this.');
  });

  it('merged with no merge message says so, never "Written when"', () => {
    const text = renderTab(verdict(), mine(null)).textContent ?? '';
    expect(text).toContain(MERGED_NO_MESSAGE);
    expect(text).not.toContain('Written when');
  });

  it('merged with a merge message quotes it', () => {
    expect(renderTab(verdict(), mine('Shipped the fix.')).textContent).toContain('Merge message: Shipped the fix.');
  });

  it('a reading with an added function matches its snapshot byte for byte', async () => {
    const impact = {
      baseline: 'scaffold',
      functions: [
        { name: 'add_comment', path: 'api/repository/comments.py', line: 1, endLine: 9, complexity: 1, change: 'added', reachedBy: ['case_1'] },
        { name: 'list_tasks', path: 'api/repository/tasks.py', line: 1, endLine: 9, complexity: 1, change: 'unchanged', reachedBy: [] },
      ],
      changeTests: [], regressionTests: [],
    } as unknown as FeedbackReport['impact'];
    const record = { ...RECORD, release: { ...RECORD.release, version: '2.1.0', summary: 'Comments on a task' } } as ChangeRequest;
    const section = renderTab(verdict(impact), null, record);
    expect(section.textContent).toContain('Added: add_comment (CR-1). Changed: nothing.');
    await expect(markupLines(section.outerHTML)).toMatchFileSnapshot('__snapshots__/change-tab-release-record-added-function.html');
  });
});

/*
 * After the merge both release cards still said the record is assembled "when PR-6 merges" over
 * their own "PR-6 merged." line. Once merged the line under the heading says the merge happened; before it, that the record is assembled when PR-6 merges.
 */
describe('the line under the release record\'s heading', () => {
  const MERGED = 'Assembled from CR-1 and your change request, published when PR-6 merged.';
  const MERGED_WITH_MESSAGE = 'Assembled from CR-1, your change request and the merge message, published when PR-6 merged.';
  const BEFORE = 'Assembled from CR-1, your change request and the merge message when PR-6 merges.';
  it('the change request page\'s card: past tense once merged, naming the merge message only where one was written', () => {
    expect(renderCard(buildRelease(input({ enrollment: mine(null) })))).toContain(MERGED);
    expect(renderCard(buildRelease(input({ enrollment: mine('Shipped the fix.') })))).toContain(MERGED_WITH_MESSAGE);
    expect(renderCard(buildRelease(input({ enrollment: mine(null) })))).not.toContain('when PR-6 merges');
  });
  it('the IDE\'s Change tab: the same', () => {
    expect(renderTab(verdict(), mine(null)).textContent).toContain(MERGED);
    expect(renderTab(verdict(), mine(null)).textContent).not.toContain('when PR-6 merges');
  });
  it('before the merge both say what they said', () => {
    expect(renderCard(buildRelease(input({})))).toContain(BEFORE);
    expect(renderTab(verdict(), null).textContent).toContain(BEFORE);
  });
});
