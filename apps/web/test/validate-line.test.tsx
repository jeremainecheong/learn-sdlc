// @vitest-environment jsdom
/**
 * The Validate tab's line under
 * its heading. A deep run never refreshes the saved checks, so once one on
 * these bytes finishes after them, four receipt rows read that run, and a line
 * naming only the checks' earlier time would mislead. The line says which rows
 * read the deep run, and when, so "20 passed, 0 failed." is not read as twenty
 * checks run at the earlier time. The sentences are pinned word for word:
 * before deep validation, "16 passed, 4 not run
 * yet, 0 failed." under "These checks ran on ... and touch no sandbox. Deep
 * validation runs the sandbox proofs."; after it, "20 passed, 0 failed.".
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeepValidationView, PhaseKey, ValidationCheck } from '@learnsdlc/shared';
import { summariseValidation } from '@learnsdlc/shared';

import { DEEP_RECEIPT_CHECK_ID, ValidationReportPanel, tierLine } from '@/components/staff/projects/ValidationReportPanel';
import { describeInstant } from '@/lib/schedule';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const RAN = '2026-11-18T12:05:00.000Z';
const DONE = '2026-11-18T12:06:58.000Z';
const PHASES: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const RECEIPT_PHASES: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];

const check = (over: Partial<ValidationCheck>): ValidationCheck => ({
  id: 'phase-holds-one-task',
  label: 'A phase holds tasks a learner can work on',
  status: 'passed',
  sentence: 'It holds 1 task.',
  phaseKey: null,
  taskKey: null,
  files: [],
  ...over,
});
/** Sixteen fast checks that pass, and the four deep validation receipts not run yet: the Deadline badge draft. */
const SIXTEEN = [
  ...PHASES.map((phaseKey) => check({ phaseKey })),
  ...PHASES.map((phaseKey) => check({ id: 'phase-gating-valid', label: 'The gate is valid', phaseKey })),
  ...['manifest-valid', 'rubric-weights', 'interview-well-formed', 'design-floor'].map((id) => check({ id, label: id })),
];
const receipt = (phaseKey: PhaseKey, over: Partial<ValidationCheck> = {}) =>
  check({
    id: DEEP_RECEIPT_CHECK_ID,
    label: 'Deep validation is current for this phase',
    sentence: `${phaseKey} has no current deep validation. Run deep validation on this draft and publish once it passes.`,
    phaseKey,
    advisory: 'warning',
    ...over,
  });
const T2_REPORT = summariseValidation('fast', RAN, [...SIXTEEN, ...RECEIPT_PHASES.map((key) => receipt(key))]);

const deep = (over: Partial<DeepValidationView>): DeepValidationView =>
  ({
    versionId: 'v',
    status: 'passed',
    current: true,
    contentDigest: 'now',
    checks: [],
    costWarning: { microVMs: 8, sentence: '' },
    startedAt: '2026-11-18T12:06:32.000Z',
    finishedAt: DONE,
    ...over,
  }) as DeepValidationView;

const FAST_LINE = `These checks ran on ${describeInstant(RAN)} and touch no sandbox. Deep validation runs the sandbox proofs.`;
const DAY_AND_TIME = '1[789] November at \\d{2}:\\d{2}';

async function drawPanel(report = T2_REPORT, view: DeepValidationView | null = null) {
  await act(async () => root.render(<ValidationReportPanel report={report} running={false} onRun={() => {}} deep={view} />));
  return { line: byId('project-validation-tier')!.textContent, counts: byId('project-validation-counts')!.textContent };
}

describe('the Validate tab line beside the counts', () => {
  it('the fixture is the Deadline badge draft: sixteen fast checks and four receipts', () => {
    expect(SIXTEEN).toHaveLength(16);
    expect(T2_REPORT.checks).toHaveLength(20);
  });

  it('before deep validation, the two sentences word for word', async () => {
    for (const view of [
      null,
      deep({ status: 'not-run', current: false, contentDigest: null, startedAt: null, finishedAt: null }),
      deep({ status: 'running', finishedAt: null }),
      deep({ status: 'queued', finishedAt: null, startedAt: null }),
      // A run on these bytes that finished after the checks
      // but neither passed nor failed (cancelled, a status this web does not
      // name) gives the rows no verdict, so the line is the fast checks' own line.
      deep({ status: 'cancelled' as unknown as DeepValidationView['status'] }),
    ]) {
      const { line, counts } = await drawPanel(T2_REPORT, view);
      expect(counts).toBe('16 passed, 4 not run yet, 0 failed.');
      expect(line).toBe(FAST_LINE);
      expect(line).toMatch(new RegExp(`^These checks ran on ${DAY_AND_TIME} and touch no sandbox\\. Deep validation runs the sandbox proofs\\.$`));
    }
  });

  it('after deep validation passes, "20 passed, 0 failed." under a line that names both runs and their times', async () => {
    const { line, counts } = await drawPanel(T2_REPORT, deep({}));
    expect(counts).toBe('20 passed, 0 failed.');
    expect(line).toBe(
      `These checks ran on ${describeInstant(RAN)} and touch no sandbox, except the 4 rows on deep validation, which read its run that passed on ${describeInstant(DONE)}.`,
    );
    expect(line).toMatch(
      new RegExp(`^These checks ran on ${DAY_AND_TIME} and touch no sandbox, except the 4 rows on deep validation, which read its run that passed on ${DAY_AND_TIME}\\.$`),
    );
    expect(line).not.toContain('—');
  });

  it('a deep run on these bytes that failed after the checks is named the same way', async () => {
    const { line, counts } = await drawPanel(T2_REPORT, deep({ status: 'failed' }));
    expect(counts).toBe('16 passed, 4 failed.');
    expect(line).toBe(
      `These checks ran on ${describeInstant(RAN)} and touch no sandbox, except the 4 rows on deep validation, which read its run that failed on ${describeInstant(DONE)}.`,
    );
  });

  it('once the checks run again after the deep run, the line is the fast one again', async () => {
    const later = summariseValidation('fast', '2026-11-18T12:08:00.000Z', [...SIXTEEN, ...RECEIPT_PHASES.map((key) => receipt(key, { advisory: undefined, sentence: 'passed against these exact bytes.' }))]);
    const { line, counts } = await drawPanel(later, deep({}));
    expect(counts).toBe('20 passed, 0 failed.');
    expect(line).toBe(`These checks ran on ${describeInstant('2026-11-18T12:08:00.000Z')} and touch no sandbox. Deep validation runs the sandbox proofs.`);
  });

  it('a deep run on earlier bytes, or one the report holds no receipt for, leaves the line as it was', async () => {
    expect((await drawPanel(T2_REPORT, deep({ current: false, contentDigest: 'earlier' }))).line).toBe(FAST_LINE);
    const noReceipts = summariseValidation('fast', RAN, SIXTEEN);
    expect((await drawPanel(noReceipts, deep({}))).line).toBe(FAST_LINE);
    const notApplicable = summariseValidation('fast', RAN, [...SIXTEEN, receipt('testing', { status: 'not-applicable', advisory: undefined })]);
    expect((await drawPanel(notApplicable, deep({}))).line).toBe(FAST_LINE);
  });

  it('one receipt reads in the singular', () => {
    const one = summariseValidation('fast', RAN, [...SIXTEEN, receipt('implementation')]);
    expect(tierLine(one, deep({}))).toBe(
      `These checks ran on ${describeInstant(RAN)} and touch no sandbox, except the row on deep validation, which reads its run that passed on ${describeInstant(DONE)}.`,
    );
  });

  it('a deep tier report keeps its own line', () => {
    const report = summariseValidation('deep', RAN, SIXTEEN);
    expect(tierLine(report, deep({}))).toBe(`The deep tier ran on ${describeInstant(RAN)}, sandbox proofs included.`);
  });
});
