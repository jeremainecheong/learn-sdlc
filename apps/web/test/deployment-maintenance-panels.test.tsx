// @vitest-environment jsdom
/**
 * The workspace's results and the Deployment
 * and Maintenance panels.
 *
 * - The change request's Checks card submits, so it says "Submit PR-6".
 * - Before a verdict the regression card says what the learner's own last
 *   run showed; its strip and the acceptance card's are neutral.
 * - The Checks and Release forms name their items ("Test 1"), the record's
 *   key in a title; the assistant's mark is a chip, not a bar; Remove says what
 *   it removes; the floor is said as what is needed to pass; the check's rows are
 *   ticked and brought into view. The runbook's forms and check alike.
 * - The runbook's incident line is true whichever page resolved the drill.
 * - A run says what it ran on and when in words, the hash a title.
 * - A run that finishes opens the pane on its headline.
 * - The terminal prints counts, no score out of 100.
 * - The drill said once for the workspace and the
 *   drill page; no full-width notice on resolve; nothing struck through; no
 *   repeated rows.
 * - The room opens on the file to change, not its test.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, serialiseChangeRequest, serialiseRunbook,
  type ChangeRequest, type DrillState, type ExecutionRunView, type PhaseDetail,
} from '@learnsdlc/shared';
import { ChangeFloorCheck, ReleaseForm, TestsForm, AmendmentsForm } from '@/components/workspace/panels/maintenance/ChangeForms';
import { AcceptanceChecks, RegressionTable, lastRunLine } from '@/components/workspace/panels/maintenance/ChangeCards';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';
import { RunbookTab, RUNBOOK_INCIDENT_WRITTEN } from '@/components/workspace/panels/deployment/RunbookTab';
import { RunPanel, runProvenance } from '@/components/workspace/RunPanel';
import { terminalLines } from '@/components/workspace/ide/derive';
import deploymentPanel from '@/components/workspace/panels/deployment';
import { FaultedDeployment, ResolveChecklist } from '@/components/workspace/panels/deployment/DrillDoc';
import { DRILL_NOT_STARTED, drillNotStartedBody, faultedRow, healthRow, pagedChip, resolveSteps } from '@/components/workspace/panels/deployment/drill';
import { changeFirst, isTestFile } from '@/components/workspace/opening-file';
import { TestingTools } from '@/components/workspace/panels/testing/Tools';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a>,
}));

let host: HTMLDivElement, root: Root;
let scrolled: Element[] = [];
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  scrolled = [];
  // jsdom draws no layout and has no scrollIntoView: record who asked to be brought into view.
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: function (this: Element) { scrolled.push(this); } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
const render = (node: ReactNode) => act(() => root.render(node));
const q = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const TICKET = { id: 'CR-1', title: 'Completed tasks are not overdue', summary: 'A done task is never overdue.', acceptance: [{ id: 'AC-1', line: 'A completed task is never overdue.' }, { id: 'AC-2', line: 'An open task keeps the date rule.' }] };
const record = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({ ...EMPTY_CHANGE_REQUEST, ...over }) as ChangeRequest;
const RUN_AT = '2026-11-17T03:17:00.000Z';
const localClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const run = (over: Partial<ExecutionRunView> = {}): ExecutionRunView => ({
  id: 'run-1', status: 'completed', kind: 'run', createdAt: RUN_AT, inputHash: 'ab'.repeat(32), runClock: null,
  result: { ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 333, tests: { total: 3, passed: 3, failed: 0, errored: 0, cases: [] } },
  ...over,
});

/* ----------------------------- the regression card ------------------------------ */

const model = (awaitingVerdict = true, reviewRunning = false) => ({ suites: [], mutation: null, lines: [], ticket: { id: 'CR-1', title: 'The change', acceptance: [] }, awaitingVerdict, reviewRunning }) as unknown as MaintenanceModel;
const regression = () => q('phase-maintenance-regression')!;
const stripOf = (section: HTMLElement) => section.querySelector('header')!.getAttribute('style') ?? '';

describe('the regression card on the Checks tab', () => {
  it('its control submits and says so, and "again" once there is a submission', () => {
    const onSubmit = vi.fn();
    render(<RegressionTable m={model(true)} pr="PR-6" onSubmit={onSubmit} busy={false} />);
    const button = regression().querySelector('button')!;
    expect(text(button)).toBe('Submit PR-6');
    expect(button.className).toContain('btn-secondary');
    act(() => button.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    render(<RegressionTable m={model(false)} pr="PR-6" onSubmit={onSubmit} busy={false} />);
    expect(text(regression().querySelector('button'))).toBe('Submit PR-6 again');
    expect(text(regression())).not.toMatch(/Open PR|Update PR/);
  });

  it('handed the header\'s test, the name follows it, not whether a verdict is held', () => {
    render(<RegressionTable m={model(true)} pr="PR-6" onSubmit={() => undefined} busy={false} hasPr />);
    expect(text(regression().querySelector('button'))).toBe('Submit PR-6 again');
    render(<RegressionTable m={model(false)} pr="PR-6" onSubmit={() => undefined} busy={false} hasPr={false} />);
    expect(text(regression().querySelector('button'))).toBe('Submit PR-6');
  });

  it('before a verdict it says what the learner\'s last run showed, and when', () => {
    render(<RegressionTable m={model()} pr="PR-6" onSubmit={() => undefined} busy={false} lastRun={run()} />);
    expect(text(q('phase-maintenance-regression-empty'))).toContain('No verdict yet');
    expect(text(q('phase-maintenance-regression-empty'))).toContain(
      `Your last run: 3 of 3 passed at ${localClock(RUN_AT)}. The review runs these tests again, with the hidden change tests, when you submit PR-6.`,
    );
    // no run that counted tests: the sentence it always said
    render(<RegressionTable m={model()} pr="PR-6" onSubmit={() => undefined} busy={false} lastRun={null} />);
    expect(text(q('phase-maintenance-regression-empty'))).toContain('The change tests and the regression suite run when you submit PR-6.');
    expect(text(q('phase-maintenance-regression-empty'))).not.toContain('Your last run');
    expect(lastRunLine(run({ result: { ok: false, exitKind: 'error', stdout: '', stderr: 'boom', durationMs: 1 } }))).toBeNull();
    expect(lastRunLine(run({ result: { ok: false, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: 3, passed: 2, failed: 1, errored: 0, cases: [] } } }))).toBe(`Your last run: 2 of 3 passed at ${localClock(RUN_AT)}.`);
  });

  it('while the review runs it says so after the learner\'s last run, and offers no Submit (the learner has just submitted)', () => {
    render(<RegressionTable m={model(true, true)} pr="PR-6" onSubmit={() => undefined} busy={false} lastRun={run()} />);
    const empty = q('phase-maintenance-regression-empty')!;
    expect(text(empty)).toContain(`Your last run: 3 of 3 passed at ${localClock(RUN_AT)}. The review is running these tests now, with the hidden change tests.`);
    expect(text(empty)).not.toContain('when you submit');
    expect(regression().querySelector('button')).toBeNull();
    // no run that counted tests: the running sentence alone
    render(<RegressionTable m={model(true, true)} pr="PR-6" onSubmit={() => undefined} busy={false} lastRun={null} />);
    expect(text(q('phase-maintenance-regression-empty'))).toMatch(/No verdict yet ?The review is running these tests now, with the hidden change tests\.$/);
    expect(regression().querySelector('button')).toBeNull();
  });

  it('says the review is running by the page\'s own in-flight hold where the page passes it, not the submission\'s raw status', () => {
    // a queued submission the page does not hold (aged out, or another task's): the card offers Submit
    render(<RegressionTable m={model(true, true)} pr="PR-6" onSubmit={() => undefined} busy={false} lastRun={run()} running={false} />);
    expect(text(q('phase-maintenance-regression-empty'))).toContain('when you submit PR-6.');
    expect(text(q('phase-maintenance-regression-empty'))).not.toContain('The review is running');
    expect(text(regression().querySelector('button'))).toBe('Submit PR-6');
    // the page holds one in flight: the running sentence and no card control
    render(<RegressionTable m={model(true, false)} pr="PR-6" onSubmit={() => undefined} busy={false} lastRun={run()} running />);
    expect(text(q('phase-maintenance-regression-empty'))).toContain('The review is running these tests now, with the hidden change tests.');
    expect(regression().querySelector('button')).toBeNull();
  });

  it('the regression and acceptance strips are neutral, not the testing phase\'s green or Maintenance\'s pink', () => {
    render(<RegressionTable m={model()} pr="PR-6" onSubmit={() => undefined} busy={false} />);
    expect(stripOf(regression())).toContain('rgb(var(--c-tint))');
    const withLine = { ...model(), lines: [{ text: 'A completed task is never overdue.', state: 'todo', evidence: [] }], ticket: { id: 'CR-1', title: 'x', acceptance: [{ id: 'AC-1', line: 'x' }] } } as unknown as MaintenanceModel;
    render(<AcceptanceChecks m={withLine} pr="PR-6" />);
    expect(stripOf(q('phase-maintenance-acceptance')!)).toContain('rgb(var(--c-tint))');
  });
});

/* ------------------------ the Checks and Release forms ------------------------- */

describe('the Checks and Release forms', () => {
  const filled = record({
    tests: [{ id: 'T1', suite: 'web/src/lib/overdue.test.ts', covers: ['AC-1'], result: 'pass' }],
    contract: [{ id: 'C1', method: 'GET', path: '/x', change: 'added', why: 'because' }],
    release: { ...EMPTY_CHANGE_REQUEST.release, version: '1.1.0', changes: [{ id: 'L1', line: 'Done tasks are not overdue.', covers: ['AC-1'] }] },
  } as Partial<ChangeRequest>);

  it('names each item by its place, the record\'s key only as the name\'s title, and Remove says what it removes', () => {
    render(<><TestsForm ticket={TICKET} change={filled} editable onChange={() => undefined} /><ReleaseForm ticket={TICKET} change={filled} editable onChange={() => undefined} /><AmendmentsForm change={filled} editable onChange={() => undefined} /></>);
    const test1 = q('change-test-0')!;
    expect(text(test1)).toMatch(/^Test 1/);
    expect(test1.querySelector('[title="T1"]')?.textContent).toBe('Test 1');
    expect([...test1.querySelectorAll('button')].map((b) => text(b))).toContain('Remove test 1');
    const line1 = q('change-line-0')!;
    expect(line1.querySelector('[title="L1"]')?.textContent).toBe('Change line 1');
    expect(line1.querySelector('textarea')!.getAttribute('aria-label')).toBe('Change line 1');
    expect([...line1.querySelectorAll('button')].map((b) => text(b))).toContain('Remove change line 1');
    const amendment = q('change-amendment-0')!;
    expect(amendment.querySelector('[title="C1"]')?.textContent).toBe('Amendment 1');
    expect([...amendment.querySelectorAll('button')].map((b) => text(b))).toContain('Remove amendment 1');
    // no bare key and no bare "Remove" left on the forms
    for (const el of host.querySelectorAll('span, button')) {
      expect(['T1', 'L1', 'C1', 'Remove']).not.toContain(el.textContent);
    }
  });

  it('the assistant\'s mark is a chip the width of its words, not a bar across the form', () => {
    render(<TestsForm ticket={TICKET} change={filled} editable onChange={() => undefined} assisted={new Set(['tests:T1:suite'])} />);
    const mark = q('change-assisted-tests:T1:suite')!;
    expect(mark.className).toContain('self-start');
  });

  it('says what is needed to pass, and the check\'s rows are ticked and brought into view on each press', () => {
    const spec = { contract: true, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true }, ticket: TICKET };
    render(<ChangeFloorCheck text={serialiseChangeRequest(record())} spec={spec} />);
    expect(text(q('change-floor-sentence'))).toMatch(/^To pass, the change request needs /);
    expect(text(q('change-floor'))).not.toContain('The floor asks');
    expect(q('change-checks')).toBeNull();
    act(() => q('change-check')!.click());
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid^="change-check-"]')];
    expect(rows.length).toBeGreaterThan(1);
    // a script reads each row's words: "Passed: …" or "Not yet: …", nothing before them
    for (const row of rows) {
      expect(text(row)).toMatch(/^(Passed|Not yet): /);
      expect(row.getAttribute('data-passed')).toBe(text(row).startsWith('Passed') ? 'true' : 'false');
      expect(row.querySelector('svg')).not.toBeNull();
    }
    expect(scrolled).toEqual([q('change-checks')]);
    act(() => q('change-check')!.click());
    expect(scrolled).toHaveLength(2);
  });
});

/* -------------------------------------- the runbook --------------------------------------- */

describe('the runbook\'s forms and check, and its incident line', () => {
  const detail = { key: 'deployment', artifactKind: 'config', runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true } } as unknown as PhaseDetail;
  const one = { ...EMPTY_RUNBOOK, health: [{ id: 'H1', name: 'selfcheck', how: 'python3 ops/selfcheck.py', expected: 'ok' }] };

  it('names entries by their place, says what is needed to pass, and its check\'s rows are ticked and in view', () => {
    render(<RunbookTab detail={detail} text={serialiseRunbook(one)} onChange={() => undefined} editable drillHref="/workspace/p/drill" />);
    const h1 = q('runbook-health-0')!;
    expect(h1.querySelector('[title="H1"]')?.textContent).toBe('Health check 1');
    expect(text(q('runbook-health-0-remove'))).toBe('Remove health check 1');
    expect(text(q('runbook-floor-sentence'))).toMatch(/^To pass, the runbook needs /);
    act(() => q('runbook-check')!.click());
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid^="runbook-check-runbook."]')];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(text(row)).toMatch(/^(Passed|Not yet): /);
    expect(scrolled).toEqual([q('runbook-checks')]);
  });

  it('the incident line is true whichever page resolved the drill, and its link looks like one', () => {
    render(<RunbookTab detail={detail} text={serialiseRunbook(one)} onChange={() => undefined} editable drillHref="/workspace/p/drill" />);
    expect(text(q('runbook-incident-from-drill'))).toBe(`${RUNBOOK_INCIDENT_WRITTEN} Open the incident drill`);
    expect(text(q('runbook-incident-from-drill'))).not.toContain('drill page');
    expect(q('runbook-open-drill')!.className).toContain('text-accent');
  });
});

/* ------------------------------------- the run's results -------------------------------------- */

describe('the run\'s results', () => {
  it('says what the run ran on and when in words, the recorded inputs\' hash only as the line\'s title', () => {
    expect(runProvenance(run())).toEqual({ text: `Ran on your saved files at ${localClock(RUN_AT)}. Edits since then are not in this result.`, title: `Recorded inputs ${'ab'.repeat(32)}` });
    expect(runProvenance(run({ runClock: '2026-11-13' })).text).toBe(`Ran on your saved files at ${localClock(RUN_AT)}, with the date set to 13 November 2026. Edits since then are not in this result.`);
    expect(runProvenance(run({ inputHash: null })).text).toBe('An older run: the files it ran on were not kept.');
    render(<RunPanel run={run()} canRun runLabel="Run tests" busy={false} onRun={() => undefined} />);
    const line = q('run-input-provenance')!;
    expect(line.getAttribute('title')).toBe(`Recorded inputs ${'ab'.repeat(32)}`);
    expect(text(line)).not.toMatch(/abab|sandbox clock|Clock:/);
  });

  it('a run that finishes while the pane is open opens the pane on its headline; one already there moves nothing', () => {
    render(<RunPanel run={run()} canRun runLabel="Run tests" busy={false} onRun={() => undefined} />);
    expect(scrolled).toEqual([]);
    render(<RunPanel run={null} canRun runLabel="Run tests" busy onRun={() => undefined} />);
    render(<RunPanel run={run({ id: 'run-2', status: 'running', result: null })} canRun runLabel="Run tests" busy onRun={() => undefined} />);
    expect(scrolled).toEqual([]);
    render(<RunPanel run={run({ id: 'run-2' })} canRun runLabel="Run tests" busy={false} onRun={() => undefined} />);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].contains(q('run-summary'))).toBe(true);
    // the same run drawn again is not a new arrival
    render(<RunPanel run={run({ id: 'run-2' })} canRun runLabel="Run tests" busy={false} onRun={() => undefined} />);
    expect(scrolled).toHaveLength(1);
  });

  it('Testing\'s "Failing first" runs the tests by the header\'s word, not the pack\'s label', () => {
    const runNow = vi.fn();
    const testing = { id: 'p-4', key: 'testing', title: 'Testing', runLabel: 'Run my tests', intro: '', taskPanel: '', objectives: [], rubric: { criteria: [] }, provenance: { application: null }, lastSubmission: null,
      files: [{ path: 'tests/test_tasks.py', content: '', editable: true, language: 'python' }] } as unknown as PhaseDetail;
    render(<TestingTools {...({ detail: testing, files: {}, links: [], setLinks: vi.fn(), runs: [], submission: null, submissions: [], runClock: null, setRunClock: vi.fn(),
      helpers: { runNow, submitNow: vi.fn(), openFile: vi.fn(), setNotice: vi.fn(), setError: vi.fn(), setTab: vi.fn(), busy: false } } as unknown as PhasePanelProps)} />);
    const first = q('phase-testing-failing-first')!;
    const button = [...first.querySelectorAll('button')].find((b) => text(b) === 'Run tests')!;
    expect(button).toBeDefined();
    expect(text(first)).not.toContain('Run my tests');
    act(() => button.click());
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  it('the terminal prints the counts of the last verdict and no score out of 100', () => {
    const report = { overall: 100, tests: { cases: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'passed' }] } } as never;
    const lines = terminalLines(null, report, 1, 'Run tests').map((l) => l.text);
    expect(lines).toContain('2 passed, 0 failed.');
    expect(lines.join('\n')).not.toMatch(/Score|of 100/);
  });
});

/* ----------------------------------------- the drill ------------------------------------------ */

const PAGED = '2026-11-17T03:11:30.000Z';
const drill = (over: Partial<DrillState> = {}): DrillState => ({
  fault: 'api-url', pagedAt: PAGED, runbookBefore: null, pagedExit: 1, healthRanAt: null, healthExit: null,
  fixAppliedAt: null, resolvedAt: null, incident: null, ...over,
});
// A teacher's own application (`application: null`): the words name no Compose configuration.
const deployment = { id: 'p-5', key: 'deployment', title: 'Deployment', artifactKind: 'config', projectSlug: 'deadline-badge', files: [], provenance: { application: null }, lastSubmission: null, runbook: { floor: { minEnvironment: 0, minHealth: 1, minRollback: 0, minData: 0, requireIncident: true }, drill: true } } as unknown as PhaseDetail;
const toolsProps = (state: DrillState | null, over: { setNotice?: () => void; resolve?: () => Promise<unknown> } = {}) => ({
  detail: deployment,
  files: {}, setFile: vi.fn(), activePath: '', submission: null, run: null, enrollment: null, theme: 'paper', links: [], setLinks: vi.fn(),
  runClock: null, setRunClock: vi.fn(), submissions: [], runs: [], drill: state,
  drillApi: { start: vi.fn(), health: vi.fn(), resolve: over.resolve ?? vi.fn(async () => ({})) }, reloadPhase: vi.fn(),
  helpers: { runNow: vi.fn(), submitNow: vi.fn(), flushSave: vi.fn(async () => {}), openFile: vi.fn(), fileText: () => '', loadSubmission: vi.fn(), setPane: vi.fn(), setTab: vi.fn(), setNotice: over.setNotice ?? vi.fn(), setError: vi.fn(), busy: false, saving: 'idle' },
}) as unknown as PhasePanelProps;
const Tools = deploymentPanel.Tools!;

describe('the drill is said once, in the workspace and on the drill page', () => {
  it('the same rows, chips and colours in both places, and the image tag only as a title', async () => {
    const state = drill();
    render(<Tools {...toolsProps(state)} />);
    await act(async () => {});
    const workspace = text(host);
    act(() => root.unmount()); root = createRoot(host);
    render(<FaultedDeployment detail={deployment} drill={state} report={null} runbook={serialiseRunbook(EMPTY_RUNBOOK)} beforeStderr="" health={null} />);
    const page = text(host);
    for (const words of ['The faulted configuration', 'Fault detected', 'The project selfcheck on your files', `Not run since you were paged at ${localClock(PAGED)}.`]) {
      expect(workspace, words).toContain(words);
      expect(page, words).toContain(words);
    }
    expect(page).not.toContain('deadline-badge:faulted');
    expect(host.querySelector('[title="deadline-badge:faulted"]')?.textContent).toBe('The faulted configuration');
    expect(page).not.toMatch(/Exit 1|Passes on your files|Project selfcheckYour/);
    expect(faultedRow(state)).toMatchObject({ chip: 'Fault detected', tone: 'fail', chipTitle: 'Exit 1' });
    expect(healthRow(state)).toMatchObject({ chip: 'Not run', tone: 'neutral', state: 'todo' });
    expect(healthRow(drill({ healthRanAt: PAGED, healthExit: 0 }))).toMatchObject({ chip: 'Passed', tone: 'pass' });
    expect(pagedChip(state)).toEqual({ label: 'Paged', tone: 'warn' });
    expect(resolveSteps(state).map((s) => s.title)).toEqual(['The selfcheck fails on the faulted copy', 'The selfcheck passes on your files', 'INCIDENT-1 has a root cause in your words']);
  });

  it('before the drill the workspace says the card the drill page says (the page, mounted, in drill-page)', async () => {
    render(<Tools {...toolsProps(null)} />);
    await act(async () => {});
    expect(text(host)).toContain(`INCIDENT-1`);
    expect(text(host)).toContain('Not started');
    expect(text(host)).toContain(`${DRILL_NOT_STARTED}${drillNotStartedBody(false)}`);
  });

  it('the selfcheck\'s output on the learner\'s files is not given a second verdict', async () => {
    render(<FaultedDeployment detail={deployment} drill={drill({ healthRanAt: PAGED, healthExit: 0 })} report={null} runbook="" beforeStderr="" health={{ exit: 0, stdout: 'web reaches api', stderr: '' } as never} />);
    const block = q('phase-deployment-drill-health-result')!;
    expect(text(block)).toContain('What the selfcheck on your files printed: exit 0');
    expect(text(block)).not.toContain('Passed');
    // one "Passed" on the page: the row's chip
    expect(text(host).match(/Passed/g)).toHaveLength(1);
  });
});

describe('resolving in the workspace, and the steps', () => {
  it('resolving sets no notice over the room: the card says it where the learner is looking', async () => {
    const setNotice = vi.fn();
    const resolveDrill = vi.fn(async () => ({}));
    render(<Tools {...toolsProps(drill({ healthRanAt: PAGED, healthExit: 0, fixAppliedAt: PAGED }), { setNotice, resolve: resolveDrill })} />);
    await act(async () => {});
    for (const id of ['phase-deployment-incident-root-cause', 'phase-deployment-incident-fix', 'phase-deployment-incident-action']) {
      act(() => { fireEvent.change(q(id)!, { target: { value: 'An explanation long enough to be accepted here.' } }); });
    }
    await act(async () => { q('phase-deployment-drill-resolve')!.click(); });
    expect(resolveDrill).toHaveBeenCalledTimes(1);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it('a done step is ticked, and the strike-through the step list draws is undone for the drill', async () => {
    render(<ResolveChecklist drill={drill()} />);
    const list = host.querySelector('ol')!;
    expect(list.className).toContain('drill-steps');
    const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf-8');
    expect(css).toContain('.drill-steps .line-through{text-decoration-line:none}');
    render(<Tools {...toolsProps(drill())} />);
    await act(async () => {});
    expect(host.querySelector('ol')!.className).toContain('drill-steps');
  });
});

/* ---------------------- the file a code room opens on ---------------------- */

describe('the file a code room opens on', () => {
  it('is the first editable file that is not a test, then the tests', () => {
    const files = [
      { path: 'web/src/lib/overdue.test.ts', editable: true },
      { path: 'web/src/lib/overdue.ts', editable: true },
      { path: 'web/src/lib/types.ts', editable: false },
    ];
    expect(changeFirst(files).map((f) => f.path)).toEqual(['web/src/lib/overdue.ts', 'web/src/lib/overdue.test.ts']);
    // Testing edits only tests: the first of them
    expect(changeFirst([{ path: 'tests/test_tasks.py', editable: true }, { path: 'web/a.spec.tsx', editable: true }]).map((f) => f.path)).toEqual(['tests/test_tasks.py', 'web/a.spec.tsx']);
    // the shared map's rule, in any language and case, and the test directories
    for (const path of ['a.test.ts', 'x/a.spec.tsx', 'test_api.py', 'api_test.py', 'tests/conftest.py', 'overdue_test.ts', 'pkg/foo_test.go', 'src/__tests__/a.ts', 'web/A.Test.TS']) expect(isTestFile(path), path).toBe(true);
    for (const path of ['overdue.ts', 'api/routes/tasks.py', 'deploy/services.json', 'latest.py', 'contest.ts', 'src/testing/a.ts']) expect(isTestFile(path), path).toBe(false);
  });
});

/* ----------------------- a run's results, read whole ----------------------- */

describe('a run\'s results are read whole in every code room', () => {
  it('Implementation\'s 320 px for a run\'s results and the review, in every room once there is a run to read', async () => {
    const { roomResultsHeight } = await import('@/components/workspace/useResultsSplit');
    for (const implementation of [true, false]) {
      expect(roomResultsHeight({ implementation, bottom: 'tests', hasRun: true, avail: 600 })).toBe(320);
      expect(roomResultsHeight({ implementation, bottom: 'feedback', hasRun: false, avail: 600 })).toBe(320);
    }
    // before any run the other rooms keep the editor's room
    expect(roomResultsHeight({ implementation: false, bottom: 'tests', hasRun: false, avail: 600 })).toBe(180);
    expect(roomResultsHeight({ implementation: false, bottom: 'terminal', hasRun: true, avail: 600 })).toBe(180);
    expect(roomResultsHeight({ implementation: true, bottom: 'terminal', hasRun: true, avail: 600 })).toBe(160);
  });
});

/* ------------------------------------- the stylesheet -------------------------------------- */

// The Split order (code, preview, results) is held by the page's own order, mounted in work-room-header.
describe('the stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf-8');
  it('the Pipeline view\'s light page fills the panel', () => {
    expect(css).toContain('.phase-code-surface .deployment-tool-evidence{min-height:100%}');
  });
});
