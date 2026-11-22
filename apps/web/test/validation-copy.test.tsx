// @vitest-environment jsdom
/*
 * The validation list's tier line and the deep validation status line, as
 * a teacher reads them on a shared screen. The tier line said the sandbox proofs
 * were "the command line's in this release", while deep validation has run from
 * the editor for several releases; and both lines printed the browser locale's
 * numeric date ("11/10/2026, 12:56:27 am" for 10 November), which reads as
 * another day in half the world. Both now name the month, as the class page does.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepValidationView } from '@learnsdlc/shared';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning, summariseValidation } from '@learnsdlc/shared';

const deepValidation = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    deepValidation: (...args: unknown[]) => deepValidation(...args),
    startDeepValidation: vi.fn(),
  },
}));

import { ValidationReportPanel } from '@/components/staff/projects/ValidationReportPanel';
import { DeepValidationPanel } from '@/components/staff/projects/DeepValidationPanel';
import { libraryRowLine } from '@/components/staff/projects/ProjectsLibrary';

// Midday UTC, so the day is 10 November in every zone from UTC-11 to UTC+11.
const AT = '2026-11-10T12:00:00.000Z';
const DAY_AND_TIME = '1[01] November at \\d{2}:\\d{2}';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); deepValidation.mockReset(); });
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('the tier line', () => {
  it('says the checks touch no sandbox and deep validation runs the proofs, with the month named', async () => {
    const report = summariseValidation('fast', AT, []);
    await act(async () => root.render(<ValidationReportPanel report={report} running={false} onRun={() => {}} />));
    const line = byId('project-validation-tier')?.textContent ?? '';
    expect(line).toMatch(new RegExp(`^These checks ran on ${DAY_AND_TIME} and touch no sandbox\\. Deep validation runs the sandbox proofs\\.$`));
    expect(line).not.toMatch(/command line|\d\/\d/);
  });

  it('before any run, says these checks touch no sandbox and cost nothing to run', async () => {
    await act(async () => root.render(<ValidationReportPanel report={null} running={false} onRun={() => {}} />));
    const line = (byId('project-validation-empty')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(line).toBe('Validation has not run on this draft. These checks touch no sandbox, so they cost nothing to run now.');
    expect(line).not.toMatch(/fast tier/);
  });
});

describe('the deep validation status line', () => {
  it('keeps "Passed. Finished " and names the month', async () => {
    const view: DeepValidationView = {
      versionId: 'v-1',
      status: 'passed',
      current: true,
      contentDigest: null,
      checks: DEEP_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'passed' as const, sentence: `${id} passed.`, phaseKey: null, taskKey: null })),
      costWarning: { microVMs: 7, sentence: deepValidationCostWarning(7) },
      startedAt: AT,
      finishedAt: AT,
    };
    deepValidation.mockResolvedValue(view);
    await act(async () => root.render(<DeepValidationPanel projectId="p-1" versionId="v-1" editable />));
    await act(async () => { await Promise.resolve(); });
    const line = byId('deep-validation-status')?.textContent ?? '';
    expect(line).toMatch(new RegExp(`^Passed\\. Finished on ${DAY_AND_TIME}\\.$`));
    expect(line).not.toMatch(/\d\/\d/);
  });
});

describe('the projects library card', () => {
  it('prints "Last validated on" with the month named, as the validation list does, never the numeric date', () => {
    const line = libraryRowLine({ cohortsUsing: 0, lastValidatedAt: AT });
    expect(line).toMatch(new RegExp(`^No class is on it yet\\. Last validated on ${DAY_AND_TIME}\\.$`));
    expect(line).not.toMatch(/\d\/\d/);
  });
});
