// @vitest-environment jsdom
/*
 * The teacher's validation list drew every `passed` row with the passed
 * marker and the spoken name "Passed", the advisory ones too: a stakeholder
 * warning, a note of a fact, and "Deep validation is current for this phase"
 * over a sentence saying it has no current deep validation. Each state now
 * reads as what it is in its word, its marker and its spoken name; what blocks
 * publish (the report's failed rows) is unchanged for the same inputs.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moduleText } from './support/source-text';
import type { DeepValidationView, ValidationCheck, ValidationReport } from '@learnsdlc/shared';
import { summariseValidation } from '@learnsdlc/shared';
import {
  CHECK_WORD,
  DEEP_RECEIPT_CHECK_ID,
  ValidationReportPanel,
  checkState,
  deepRunFailed,
  deepRunOutOfDate,
  deepRunPassed,
} from '@/components/staff/projects/ValidationReportPanel';
import { PublishPanel } from '@/components/staff/projects/PublishPanel';

const check = (over: Partial<ValidationCheck>): ValidationCheck => ({
  id: 'phase-holds-one-task',
  label: 'A phase holds one task',
  status: 'passed',
  sentence: 'Every phase holds one task.',
  phaseKey: null,
  taskKey: null,
  files: [],
  ...over,
});

const NOT_RUN_SENTENCE =
  "Testing is not the reference project's application as it shipped, and it has no current deep validation. Run deep validation on this draft and publish once it passes.";

const passed = check({ id: 'interview-well-formed', label: 'The stakeholder interview is one the room can hold', phaseKey: 'requirements' });
const warning = check({
  id: 'interview-stakeholder-named',
  label: 'A task that needs the interview names the stakeholder',
  sentence: 'The brief does not name the stakeholder in full.',
  phaseKey: 'requirements',
  taskKey: 'main',
  advisory: 'warning',
});
const note = check({ id: 'application-phases', label: "The last four phases run the reference's application", sentence: 'The last four phases run the reference.', advisory: 'note' });
const notRun = check({
  id: DEEP_RECEIPT_CHECK_ID,
  label: 'Deep validation is current for this phase',
  sentence: NOT_RUN_SENTENCE,
  phaseKey: 'testing',
  advisory: 'warning',
});
const deepPassed = check({
  id: DEEP_RECEIPT_CHECK_ID,
  label: 'Deep validation is current for this phase',
  sentence: "Design's deep validation passed against these exact bytes.",
  phaseKey: 'design',
});
// The same receipt at the publish door: the server makes it `failed`, no advisory.
const notRunAtPublish = { ...notRun, status: 'failed' as const, advisory: undefined };

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const drawList = async (report: ValidationReport) => {
  await act(async () => root.render(<ValidationReportPanel report={report} running={false} onRun={() => {}} />));
};
const rowOf = (rowId: string) => host.querySelector<HTMLElement>(`[data-testid="project-check-${rowId}"]`)!;
const markerOf = (rowId: string) => rowOf(rowId).querySelector<HTMLElement>('[role="img"]')!;
const wordOf = (rowId: string) => host.querySelector(`[data-testid="project-state-word-${rowId}"]`)?.textContent ?? '';

const report = (checks: ValidationCheck[]) => summariseValidation('fast', '2026-11-09T00:00:00.000Z', checks);

describe('the validation list names each state', () => {
  it('passed: the passed marker, spoken "Passed", on a row marked passed', async () => {
    await drawList(report([passed, deepPassed]));
    for (const rowId of ['interview-well-formed-requirements', `${DEEP_RECEIPT_CHECK_ID}-design`]) {
      expect(rowOf(rowId).dataset.state).toBe('passed');
      expect(markerOf(rowId).dataset.state).toBe('pass');
      expect(markerOf(rowId).getAttribute('aria-label')).toBe('Passed');
      expect(wordOf(rowId)).toBe('');
    }
  });

  it('a warning: the warning marker and word, spoken as not blocking, never "Passed"', async () => {
    await drawList(report([warning]));
    const rowId = 'interview-stakeholder-named-requirements-main';
    expect(rowOf(rowId).dataset.state).toBe('warning');
    expect(markerOf(rowId).dataset.state).toBe('warn');
    expect(markerOf(rowId).getAttribute('aria-label')).toBe('Warning, does not block publishing');
    expect(wordOf(rowId)).toBe('Warning');
    expect(rowOf(rowId).textContent).toContain(warning.sentence);
  });

  it('a note: the neutral marker and word, never the passed marker', async () => {
    await drawList(report([note]));
    const rowId = 'application-phases-1';
    expect(rowOf(rowId).dataset.state).toBe('note');
    expect(markerOf(rowId).dataset.state).toBe('todo');
    expect(markerOf(rowId).getAttribute('aria-label')).toBe('Note, does not block publishing');
    expect(wordOf(rowId)).toBe('Note');
  });

  it('deep validation not run yet: the neutral marker, "Not run yet" beside the rule, never "Passed"', async () => {
    await drawList(report([notRun]));
    const rowId = `${DEEP_RECEIPT_CHECK_ID}-testing`;
    expect(rowOf(rowId).dataset.state).toBe('not-run');
    expect(markerOf(rowId).dataset.state).toBe('todo');
    expect(markerOf(rowId).getAttribute('aria-label')).toBe('Not run yet, run deep validation before you publish');
    expect(wordOf(rowId)).toBe('Not run yet');
    expect(rowOf(rowId).textContent).toContain(NOT_RUN_SENTENCE);
  });

  it('no row that does not hold is spoken as "Passed", and the count says what each is', async () => {
    await drawList(report([passed, warning, note, notRun]));
    const spoken = [...host.querySelectorAll('[role="img"]')].map((one) => one.getAttribute('aria-label'));
    expect(spoken.filter((one) => one === 'Passed')).toHaveLength(1);
    expect(host.querySelector('[data-testid="project-validation-counts"]')!.textContent).toBe(
      '1 passed, 1 warning, 1 note, 1 not run yet, 0 failed.',
    );
  });

  it('a failed row is unchanged: the failed marker, spoken "Failed"', async () => {
    await drawList(report([notRunAtPublish]));
    const rowId = `${DEEP_RECEIPT_CHECK_ID}-testing`;
    expect(markerOf(rowId).dataset.state).toBe('fail');
    expect(markerOf(rowId).getAttribute('aria-label')).toBe(CHECK_WORD.failed);
    expect(wordOf(rowId)).toBe('Failed');
  });

  it('checkState names only; a status other than passed is never relabelled', () => {
    expect(checkState(passed)).toBe('passed');
    expect(checkState(warning)).toBe('warning');
    expect(checkState(note)).toBe('note');
    expect(checkState(notRun)).toBe('not-run');
    expect(checkState(notRunAtPublish)).toBe('failed');
    expect(checkState(check({ status: 'not-applicable', advisory: 'warning' }))).toBe('not-applicable');
  });
});

describe('what blocks publish is unchanged for the same inputs', () => {
  const drawPublish = async (value: ValidationReport) => {
    await act(async () =>
      root.render(
        <PublishPanel
          draftVersion="1.0.0"
          report={value}
          editable
          readOnlyReason={null}
          publishing={false}
          error=""
          published={null}
          onPublish={() => {}}
        />,
      ),
    );
  };

  it('advisory rows only: publishable, Publish on, nothing listed as blocking', async () => {
    const value = report([passed, warning, note, notRun]);
    expect(value.publishable).toBe(true);
    expect(value.failed).toBe(0);
    expect(value.passed).toBe(4);
    await drawPublish(value);
    expect((host.querySelector('[data-testid="project-publish"]') as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelector('[data-testid="project-publish-blocking"]')).toBeNull();
  });

  it('the receipt failed at the door: not publishable, Publish off, its sentence listed', async () => {
    const value = report([passed, warning, notRunAtPublish]);
    expect(value.publishable).toBe(false);
    await drawPublish(value);
    expect((host.querySelector('[data-testid="project-publish"]') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-testid="project-publish-blocking"]')!.textContent).toContain(NOT_RUN_SENTENCE);
  });
});

describe("the receipt's id is the API's", () => {
  // The web cannot import the API, so it reads the file the id is declared in.
  // A rename there fails here instead of turning "Not run yet" into "Warning".
  const API_VALIDATION = repoPath('apps/api/src/authoring/validation.ts');
  const source = readFileSync(API_VALIDATION, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('the constant equals the API constant of the same name', () => {
    const declared = /export const DEEP_RECEIPT_CHECK_ID\s*=\s*'([^']+)'/.exec(source)?.[1];
    expect(declared).toBe(DEEP_RECEIPT_CHECK_ID);
  });

  it('the API builds the receipt row with that constant, as an advisory on a draft', () => {
    expect(source).toMatch(/row\(DEEP_RECEIPT_CHECK_ID,\s*'Deep validation is current for this phase'/);
    expect(source).toMatch(/advisory:\s*'warning'/);
  });
});

describe('a row heading on a phone', () => {
  it('wraps below `sm` beside its state word, keeps one line from `sm` up, and its title holds the whole rule', async () => {
    await drawList(report([passed, warning, notRun]));
    for (const { row, rowId } of [
      { row: passed, rowId: 'interview-well-formed-requirements' },
      { row: warning, rowId: 'interview-stakeholder-named-requirements-main' },
      { row: notRun, rowId: `${DEEP_RECEIPT_CHECK_ID}-testing` },
    ]) {
      const heading = host.querySelector<HTMLElement>(`[data-testid="project-rule-${rowId}"]`)!;
      const classes = heading.className.split(/\s+/);
      expect(heading.textContent).toBe(row.label);
      expect(heading.title).toBe(row.label);
      // No bare `truncate`: under the phone breakpoint nothing cuts the rule off.
      expect(classes).not.toContain('truncate');
      expect(classes).toEqual(expect.arrayContaining(['wrap', 'min-w-0', 'flex-1', 'sm:truncate']));
    }
  });
});

describe('the count bar', () => {
  const segments = () =>
    Object.fromEntries(
      [...host.querySelectorAll<HTMLElement>('[data-testid="project-validation-bar"] > span')].map(
        (one): [string, { grow: number; colour: string }] => [
          one.dataset.state ?? '',
          { grow: Number(one.style.flexGrow), colour: one.className },
        ],
      ),
    );

  it('has a segment for every state the count line names, in its marker colour, and says each count', async () => {
    await drawList(report([passed, warning, note, notRun, { ...notRunAtPublish, phaseKey: 'implementation' }]));
    expect(segments()).toEqual({
      passed: { grow: 1, colour: 'bg-pass' },
      warning: { grow: 1, colour: 'bg-warn' },
      note: { grow: 1, colour: 'bg-edge2' },
      'not-run': { grow: 1, colour: 'bg-edge2' },
      'out-of-date': { grow: 0, colour: 'bg-warn' },
      failed: { grow: 1, colour: 'bg-fail' },
    });
    const bar = host.querySelector('[data-testid="project-validation-bar"]')!;
    expect(bar.getAttribute('role')).toBe('img');
    expect(bar.getAttribute('aria-label')).toBe('Check results: 1 passed, 1 warning, 1 note, 1 not run yet, 1 failed');
  });

  it('a draft of only notes and receipts not run yet is not drawn empty', async () => {
    await drawList(report([note, notRun]));
    const drawn = Object.values(segments()).reduce((sum, one) => sum + one.grow, 0);
    expect(drawn).toBe(2);
    expect(segments().passed.grow).toBe(0);
    expect(host.querySelector('[data-testid="project-validation-bar"]')!.getAttribute('aria-label')).toBe(
      'Check results: 0 passed, 1 note, 1 not run yet, 0 failed',
    );
  });
});

describe('a receipt run on older bytes reads "Out of date"', () => {
  // The receipt row's sentence is the same for never and for stale; the deep
  // validation read the editor already holds tells them apart.
  const deep = (over: Partial<DeepValidationView>): DeepValidationView => ({
    versionId: 'v1',
    status: 'passed',
    current: false,
    contentDigest: 'earlier',
    checks: [],
    costWarning: { microVMs: 2, sentence: '2 microVMs' },
    startedAt: null,
    finishedAt: null,
    ...over,
  } as DeepValidationView);
  const drawWith = async (value: ValidationReport, view: DeepValidationView | null) => {
    await act(async () => root.render(<ValidationReportPanel report={value} running={false} onRun={() => {}} deep={view} />));
  };
  const rowId = `${DEEP_RECEIPT_CHECK_ID}-testing`;

  it("the rail's rule: a finished run, passed or failed, that is not current; nothing else", () => {
    expect(deepRunOutOfDate(deep({ status: 'passed' }))).toBe(true);
    expect(deepRunOutOfDate(deep({ status: 'failed' }))).toBe(true);
    expect(deepRunOutOfDate(deep({ status: 'passed', current: true }))).toBe(false);
    expect(deepRunOutOfDate(deep({ status: 'not-run', contentDigest: null }))).toBe(false);
    expect(deepRunOutOfDate(deep({ status: 'running' }))).toBe(false);
    expect(deepRunOutOfDate(deep({ status: 'queued' }))).toBe(false);
    expect(deepRunOutOfDate(null)).toBe(false);
    expect(deepRunOutOfDate(undefined)).toBe(false);
  });

  it('out of date: the warning marker, the word "Out of date", spoken as run again, counted as such', async () => {
    await drawWith(report([passed, notRun]), deep({ status: 'passed' }));
    expect(rowOf(rowId).dataset.state).toBe('out-of-date');
    expect(markerOf(rowId).dataset.state).toBe('warn');
    expect(markerOf(rowId).getAttribute('aria-label')).toBe('Out of date, run deep validation again before you publish');
    expect(wordOf(rowId)).toBe('Out of date');
    expect(rowOf(rowId).textContent).toContain(NOT_RUN_SENTENCE);
    expect(host.querySelector('[data-testid="project-validation-counts"]')!.textContent).toBe(
      '1 passed, 1 out of date, 0 failed.',
    );
    const bar = host.querySelector('[data-testid="project-validation-bar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Check results: 1 passed, 1 out of date, 0 failed');
    const segment = bar.querySelector<HTMLElement>('[data-state="out-of-date"]')!;
    expect([segment.className, Number(segment.style.flexGrow)]).toEqual(['bg-warn', 1]);
  });

  it('never run stays "Not run yet": no read, a not-run read, or a run in flight', async () => {
    for (const view of [null, deep({ status: 'not-run', contentDigest: null }), deep({ status: 'running' })]) {
      await drawWith(report([notRun]), view);
      expect(rowOf(rowId).dataset.state).toBe('not-run');
      expect(wordOf(rowId)).toBe('Not run yet');
    }
  });

  it('only the advisory receipt changes word: other rows and the receipt failed at the door keep their states', async () => {
    await drawWith(report([warning, note, { ...notRunAtPublish, phaseKey: 'implementation' }]), deep({ status: 'failed' }));
    expect(rowOf('interview-stakeholder-named-requirements-main').dataset.state).toBe('warning');
    expect(rowOf('application-phases-2').dataset.state).toBe('note');
    expect(rowOf(`${DEEP_RECEIPT_CHECK_ID}-implementation`).dataset.state).toBe('failed');
    expect(checkState(notRunAtPublish, true)).toBe('failed');
  });

  it('what publish decides does not read the deep view: the same report is publishable either way', () => {
    const value = report([passed, notRun]);
    expect(value.publishable).toBe(true);
    expect(value.blocking).toEqual([]);
  });

  // That the editor hands the panel the deep view the rail reads, and sends no
  // run of the checks on reading it, is asserted on the rendered editor in
  // `project-sections.test.tsx`.
});

describe('a deep validation that failed on these bytes reads "Failed" on its receipt row', () => {
  // The panel above the list says "Failed"; the receipt row read "Not run yet".
  // The row now reads the same deep view the editor already hands the list.
  const deep = (over: Partial<DeepValidationView>): DeepValidationView => ({
    versionId: 'v1',
    status: 'failed',
    current: true,
    contentDigest: 'now',
    checks: [],
    costWarning: { microVMs: 2, sentence: '2 microVMs' },
    startedAt: null,
    finishedAt: null,
    ...over,
  } as DeepValidationView);
  const drawWith = async (value: ValidationReport, view: DeepValidationView | null) => {
    await act(async () => root.render(<ValidationReportPanel report={value} running={false} onRun={() => {}} deep={view} />));
  };
  const rowId = `${DEEP_RECEIPT_CHECK_ID}-testing`;
  const counts = () => host.querySelector('[data-testid="project-validation-counts"]')!.textContent;
  // The receipt row as the API sends it on a draft whose deep validation is
  // passed and current: a plain pass, no advisory.
  const currentReceipt = { ...deepPassed, phaseKey: 'testing' as const };

  it('the rule: a run on these bytes that failed; nothing else', () => {
    expect(deepRunFailed(deep({}))).toBe(true);
    expect(deepRunFailed(deep({ current: false }))).toBe(false);
    expect(deepRunFailed(deep({ status: 'passed' }))).toBe(false);
    expect(deepRunFailed(deep({ status: 'running', current: false }))).toBe(false);
    expect(deepRunFailed(deep({ status: 'not-run', current: false, contentDigest: null }))).toBe(false);
    expect(deepRunFailed(null)).toBe(false);
    expect(deepRunFailed(undefined)).toBe(false);
  });

  const cases: Array<{
    name: string;
    row: ValidationCheck;
    view: DeepValidationView | null;
    state: string;
    marker: string;
    spoken: string;
    word: string;
    count: string;
  }> = [
    { name: 'never run', row: notRun, view: null, state: 'not-run', marker: 'todo', spoken: CHECK_WORD['not-run'], word: 'Not run yet', count: '0 passed, 1 not run yet, 0 failed.' },
    { name: 'never run (a not-run read)', row: notRun, view: deep({ status: 'not-run', current: false, contentDigest: null }), state: 'not-run', marker: 'todo', spoken: CHECK_WORD['not-run'], word: 'Not run yet', count: '0 passed, 1 not run yet, 0 failed.' },
    { name: 'running', row: notRun, view: deep({ status: 'running', current: false }), state: 'not-run', marker: 'todo', spoken: CHECK_WORD['not-run'], word: 'Not run yet', count: '0 passed, 1 not run yet, 0 failed.' },
    { name: 'passed and current', row: currentReceipt, view: deep({ status: 'passed' }), state: 'passed', marker: 'pass', spoken: 'Passed', word: '', count: '1 passed, 0 failed.' },
    { name: 'failed and current', row: notRun, view: deep({}), state: 'failed', marker: 'fail', spoken: 'Failed', word: 'Failed', count: '0 passed, 1 failed.' },
    { name: 'out of date', row: notRun, view: deep({ current: false }), state: 'out-of-date', marker: 'warn', spoken: CHECK_WORD['out-of-date'], word: 'Out of date', count: '0 passed, 1 out of date, 0 failed.' },
  ];
  for (const one of cases) {
    it(`${one.name}: the row reads "${one.word || 'Passed'}"`, async () => {
      await drawWith(report([one.row]), one.view);
      expect(rowOf(rowId).dataset.state).toBe(one.state);
      expect(markerOf(rowId).dataset.state).toBe(one.marker);
      expect(markerOf(rowId).getAttribute('aria-label')).toBe(one.spoken);
      expect(wordOf(rowId)).toBe(one.word);
      expect(rowOf(rowId).textContent).toContain(one.row.sentence);
      expect(counts()).toBe(one.count);
    });
  }

  it('failed and current: the same marker, word and spoken name as a row failed at the door, and the bar counts it as failed', async () => {
    await drawWith(report([passed, notRun]), deep({}));
    expect(markerOf(rowId).getAttribute('aria-label')).toBe(CHECK_WORD.failed);
    expect(host.querySelector(`[data-testid="project-state-word-${rowId}"]`)!.className).toContain('text-fail');
    const bar = host.querySelector('[data-testid="project-validation-bar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Check results: 1 passed, 1 failed');
    const segment = bar.querySelector<HTMLElement>('[data-state="failed"]')!;
    expect([segment.className, Number(segment.style.flexGrow)]).toEqual(['bg-fail', 1]);
    // Words only: no "Go to" for a row the report does not hold as failed.
    expect(host.querySelector(`[data-testid="project-goto-${rowId}"]`)).toBeNull();
  });

  it('a row failed at the door is counted once, whatever the deep view says', async () => {
    await drawWith(report([notRunAtPublish]), deep({}));
    expect(rowOf(rowId).dataset.state).toBe('failed');
    expect(counts()).toBe('0 passed, 1 failed.');
  });

  it('only the advisory receipt changes word: warnings and notes keep their states', async () => {
    await drawWith(report([warning, note, notRun]), deep({}));
    expect(rowOf('interview-stakeholder-named-requirements-main').dataset.state).toBe('warning');
    expect(rowOf('application-phases-2').dataset.state).toBe('note');
    expect(checkState(warning, false, true)).toBe('warning');
    expect(checkState(note, false, true)).toBe('note');
  });

  it('what publish decides does not read the deep view: the same report, the same decision', async () => {
    const value = report([passed, warning, notRun]);
    expect(value.publishable).toBe(true);
    expect(value.failed).toBe(0);
    expect(value.blocking).toEqual([]);
    await act(async () =>
      root.render(
        <PublishPanel
          draftVersion="1.0.0"
          report={value}
          editable
          readOnlyReason={null}
          publishing={false}
          error=""
          published={null}
          onPublish={() => {}}
        />,
      ),
    );
    expect((host.querySelector('[data-testid="project-publish"]') as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelector('[data-testid="project-publish-blocking"]')).toBeNull();
    // PublishPanel takes no deep view at all.
    const source = moduleText('PublishPanel');
    expect(source).not.toMatch(/DeepValidationView|deepRun/);
  });
});

describe('the receipt row agrees with a finished deep run on these bytes, whatever the saved list says', () => {
  // A deep run never refreshes the saved checks: read from them alone, the list
  // would hold "Not run yet" after a pass, and "Passed" after a failing re-run
  // over a saved pass, until "Run the checks". The row reads the deep view the editor
  // already hands the list; no request is sent and what publish decides is
  // the same function of the same report.
  const deep = (over: Partial<DeepValidationView>): DeepValidationView => ({
    versionId: 'v1',
    status: 'passed',
    current: true,
    contentDigest: 'now',
    checks: [],
    costWarning: { microVMs: 2, sentence: '2 microVMs' },
    startedAt: null,
    finishedAt: null,
    ...over,
  } as DeepValidationView);
  const rowId = `${DEEP_RECEIPT_CHECK_ID}-testing`;
  const PASS_SENTENCE = "Testing's deep validation passed against these exact bytes.";
  const LATER_PASS =
    'Deep validation passed against these exact bytes after these checks last ran. Run the checks to bring this list up to date.';
  const LATER_FAIL =
    'Deep validation failed against these exact bytes after these checks last ran, and publishing needs a passing run. Run the checks to bring this list up to date.';
  const STALE =
    'The last deep validation was made against an earlier state of the draft. Run deep validation again before you publish.';

  const saved = {
    // A draft whose deep validation was not current when the checks ran.
    'advisory, not run': notRun,
    // A draft whose deep validation had passed on these bytes when the checks ran.
    passed: check({ id: DEEP_RECEIPT_CHECK_ID, label: 'Deep validation is current for this phase', sentence: PASS_SENTENCE, phaseKey: 'testing' }),
    // The publish report: the receipt failed at the door.
    'failed at the door': notRunAtPublish,
  } as const;
  const views = {
    none: null,
    running: deep({ status: 'running', current: false }),
    'passed, current': deep({}),
    'failed, current': deep({ status: 'failed' }),
    'out of date': deep({ current: false, contentDigest: 'earlier' }),
  } as const;

  type Row = { state: string; marker: string; spoken: string; word: string; count: string; sentence: string; goTo: boolean };
  const NOT_RUN: Omit<Row, 'sentence' | 'goTo'> = { state: 'not-run', marker: 'todo', spoken: CHECK_WORD['not-run'], word: 'Not run yet', count: '0 passed, 1 not run yet, 0 failed.' };
  const PASSED: Omit<Row, 'sentence' | 'goTo'> = { state: 'passed', marker: 'pass', spoken: 'Passed', word: '', count: '1 passed, 0 failed.' };
  const FAILED: Omit<Row, 'sentence' | 'goTo'> = { state: 'failed', marker: 'fail', spoken: 'Failed', word: 'Failed', count: '0 passed, 1 failed.' };
  const OUT_OF_DATE: Omit<Row, 'sentence' | 'goTo'> = { state: 'out-of-date', marker: 'warn', spoken: CHECK_WORD['out-of-date'], word: 'Out of date', count: '0 passed, 1 out of date, 0 failed.' };

  const table: Record<keyof typeof saved, Record<keyof typeof views, Row>> = {
    'advisory, not run': {
      none: { ...NOT_RUN, sentence: NOT_RUN_SENTENCE, goTo: false },
      running: { ...NOT_RUN, sentence: NOT_RUN_SENTENCE, goTo: false },
      'passed, current': { ...PASSED, sentence: LATER_PASS, goTo: false },
      'failed, current': { ...FAILED, sentence: NOT_RUN_SENTENCE, goTo: false },
      'out of date': { ...OUT_OF_DATE, sentence: NOT_RUN_SENTENCE, goTo: false },
    },
    passed: {
      none: { ...PASSED, sentence: PASS_SENTENCE, goTo: false },
      running: { ...PASSED, sentence: PASS_SENTENCE, goTo: false },
      'passed, current': { ...PASSED, sentence: PASS_SENTENCE, goTo: false },
      'failed, current': { ...FAILED, sentence: LATER_FAIL, goTo: false },
      'out of date': { ...OUT_OF_DATE, sentence: STALE, goTo: false },
    },
    'failed at the door': {
      none: { ...FAILED, sentence: NOT_RUN_SENTENCE, goTo: true },
      running: { ...FAILED, sentence: NOT_RUN_SENTENCE, goTo: true },
      'passed, current': { ...PASSED, sentence: LATER_PASS, goTo: false },
      'failed, current': { ...FAILED, sentence: NOT_RUN_SENTENCE, goTo: true },
      'out of date': { ...FAILED, sentence: NOT_RUN_SENTENCE, goTo: true },
    },
  };

  it('the rule: a run on these bytes that passed; nothing else', () => {
    expect(deepRunPassed(deep({}))).toBe(true);
    expect(deepRunPassed(deep({ current: false }))).toBe(false);
    expect(deepRunPassed(deep({ status: 'failed' }))).toBe(false);
    expect(deepRunPassed(deep({ status: 'running', current: false }))).toBe(false);
    expect(deepRunPassed(deep({ status: 'not-run', current: false, contentDigest: null }))).toBe(false);
    expect(deepRunPassed(null)).toBe(false);
    expect(deepRunPassed(undefined)).toBe(false);
  });

  for (const [savedName, row] of Object.entries(saved) as Array<[keyof typeof saved, ValidationCheck]>) {
    for (const [viewName, view] of Object.entries(views) as Array<[keyof typeof views, DeepValidationView | null]>) {
      const want = table[savedName][viewName];
      it(`saved ${savedName}, deep ${viewName}: reads "${want.spoken}"`, async () => {
        await act(async () =>
          root.render(<ValidationReportPanel report={report([row])} running={false} onRun={() => {}} onGoTo={() => {}} deep={view} />),
        );
        expect(rowOf(rowId).dataset.state).toBe(want.state);
        expect(markerOf(rowId).dataset.state).toBe(want.marker);
        expect(markerOf(rowId).getAttribute('aria-label')).toBe(want.spoken);
        expect(wordOf(rowId)).toBe(want.word);
        expect(rowOf(rowId).querySelector('p.purpose')!.textContent).toBe(want.sentence);
        expect(host.querySelector('[data-testid="project-validation-counts"]')!.textContent).toBe(want.count);
        expect(host.querySelector('[data-testid="project-validation-bar"]')!.getAttribute('aria-label')).toBe(
          `Check results: ${want.count.slice(0, -1)}`,
        );
        expect(Boolean(host.querySelector(`[data-testid="project-goto-${rowId}"]`))).toBe(want.goTo);
      });
    }
  }

  it('other rows never read the deep view: a warning, a note and a plain pass are the same under every view', async () => {
    for (const view of Object.values(views)) {
      await act(async () => root.render(<ValidationReportPanel report={report([passed, warning, note])} running={false} onRun={() => {}} deep={view} />));
      expect(rowOf('interview-well-formed-requirements').dataset.state).toBe('passed');
      expect(rowOf('interview-stakeholder-named-requirements-main').dataset.state).toBe('warning');
      expect(rowOf('application-phases-3').dataset.state).toBe('note');
      expect(rowOf('interview-stakeholder-named-requirements-main').textContent).toContain(warning.sentence);
    }
    expect(checkState(warning, true, true, true)).toBe('warning');
    expect(checkState(note, true, true, true)).toBe('note');
    expect(checkState(passed, true, true, false)).toBe('passed');
  });

  describe('what publish decides is unchanged: the same report, the same decision, under every deep view', () => {
    const drawPublish = async (value: ValidationReport) => {
      await act(async () =>
        root.render(
          <PublishPanel draftVersion="1.0.0" report={value} editable readOnlyReason={null} publishing={false} error="" published={null} onPublish={() => {}} />,
        ),
      );
    };

    for (const [savedName, row] of Object.entries(saved) as Array<[keyof typeof saved, ValidationCheck]>) {
      it(`saved ${savedName}: publishable exactly as the report says`, async () => {
        const value = report([passed, row]);
        const atDoor = row.status === 'failed';
        expect(value.publishable).toBe(!atDoor);
        expect(value.failed).toBe(atDoor ? 1 : 0);
        expect(value.blocking).toEqual(atDoor ? [NOT_RUN_SENTENCE] : []);
        // The list reads the deep view; the report it is handed is not changed by it.
        const before = JSON.stringify(value);
        for (const view of Object.values(views)) {
          await act(async () => root.render(<ValidationReportPanel report={value} running={false} onRun={() => {}} deep={view} />));
        }
        expect(JSON.stringify(value)).toBe(before);
        await drawPublish(value);
        expect((host.querySelector('[data-testid="project-publish"]') as HTMLButtonElement).disabled).toBe(atDoor);
        const blocking = host.querySelector('[data-testid="project-publish-blocking"]');
        if (atDoor) expect(blocking!.textContent).toContain(NOT_RUN_SENTENCE);
        else expect(blocking).toBeNull();
      });
    }
  });
});
