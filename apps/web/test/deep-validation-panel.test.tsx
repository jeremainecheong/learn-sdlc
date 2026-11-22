// @vitest-environment jsdom
/**
 * Deep validation, from the editor.
 *
 * Deep validation boots microVMs. So the start control is **off until the
 * warning has been read back and drawn**, the warning is the contract's
 * `deepValidationCostWarning` (microVMs, never money) and the start
 * sends the count the teacher was shown, so the API can refuse a run that
 * would boot more than that. The result is the four checks a to d, each with
 * its own sentence.
 *
 * Accessibility: the start lives in a dialog that holds focus, closes on Escape, and
 * hands focus back to the control that opened it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepValidationView } from '@learnsdlc/shared';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';

const deepValidation = vi.fn();
const startDeepValidation = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    deepValidation: (...args: unknown[]) => deepValidation(...args),
    startDeepValidation: (...args: unknown[]) => startDeepValidation(...args),
  },
}));

import { DEEP_VALIDATION_POLL_MS, DeepValidationPanel } from '@/components/staff/projects/DeepValidationPanel';
import { settle } from './support/dom';

function view(over: Partial<DeepValidationView> = {}): DeepValidationView {
  return {
    versionId: 'v-1',
    status: 'not-run',
    current: false,
    contentDigest: null,
    checks: DEEP_VALIDATION_CHECK_IDS.map((id) => ({
      id,
      status: 'pending' as const,
      sentence: `${id} has not run.`,
      phaseKey: null,
      taskKey: null,
    })),
    costWarning: { microVMs: 7, sentence: deepValidationCostWarning(7) },
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;


async function mount(editable = true) {
  await act(async () => {
    root?.render(<DeepValidationPanel projectId="p-1" versionId="v-1" editable={editable} />);
  });
  await settle(6);
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
}

function key(target: Element, k: string, shift = false) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  });
}

describe('deep validation', () => {
  it('the start control is disabled until the cost warning is shown', async () => {
    deepValidation.mockResolvedValueOnce(view());
    await mount();
    // The dialog asks again, and that answer is held back.
    let release: (v: DeepValidationView) => void = () => undefined;
    deepValidation.mockReturnValueOnce(new Promise<DeepValidationView>((resolve) => (release = resolve)));
    await click('deep-validation-open');
    expect(byId('deep-validation-warning')).toBeNull();
    expect((byId('deep-validation-start') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release(view());
    });
    await settle(6);
    expect(byId('deep-validation-warning')?.textContent).toBe(deepValidationCostWarning(7));
    const start = byId('deep-validation-start') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect((start.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(byId('deep-validation-warning')?.id);
  });

  it('the warning names microVMs, not money', async () => {
    deepValidation.mockResolvedValue(view({ costWarning: { microVMs: 1, sentence: 'It costs $3.' } }));
    await mount();
    await click('deep-validation-open');
    await settle(6);
    const dialog = byId('deep-validation-dialog');
    expect(byId('deep-validation-warning')?.textContent).toBe(deepValidationCostWarning(1));
    expect(dialog?.textContent).toMatch(/microVM/);
    expect(dialog?.textContent ?? '').not.toMatch(/\$|money|dollar|price|cost|SGD|USD|credit|bill|charge|fee/i);
  });

  it('starts with the count the teacher was shown, and draws the run as it goes', async () => {
    deepValidation.mockResolvedValue(view());
    startDeepValidation.mockResolvedValue(view({ status: 'queued', startedAt: '2026-10-01T08:00:00.000Z' }));
    await mount();
    await click('deep-validation-open');
    await settle(6);
    await click('deep-validation-start');
    await settle(6);
    expect(startDeepValidation).toHaveBeenCalledWith('p-1', 'v-1', { acknowledgedMicroVMs: 7 });
    expect(byId('deep-validation-dialog')).toBeNull();
    expect(byId('deep-validation-status')?.textContent).toMatch(/queued|waiting/i);
  });

  // One failed read of a run in flight does not end
  // the polling, because the view it left behind has not changed.
  it('keeps reading a run in flight after one read fails', async () => {
    vi.useFakeTimers();
    try {
      deepValidation
        .mockResolvedValueOnce(view({ status: 'running' }))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(view({ status: 'passed', finishedAt: '2026-10-01T08:05:00.000Z' }));
      await mount();
      expect(deepValidation).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEP_VALIDATION_POLL_MS + 10);
      });
      await settle(6);
      expect(deepValidation).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEP_VALIDATION_POLL_MS + 10);
      });
      await settle(6);
      expect(deepValidation).toHaveBeenCalledTimes(3);
      expect(byId('deep-validation-status')?.textContent).toMatch(/^Passed\./);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the four checks a to d, each in its own sentence', async () => {
    deepValidation.mockResolvedValue(
      view({
        status: 'failed',
        current: true,
        contentDigest: '9'.repeat(64),
        finishedAt: '2026-10-01T08:05:00.000Z',
        checks: [
          { id: 'solution-passes-hidden', status: 'passed', sentence: 'The reference solution passes its hidden suite.', phaseKey: 'implementation', taskKey: 'main' },
          { id: 'starter-fails-hidden', status: 'failed', sentence: 'The starter already passes the hidden suite in Implementation.', phaseKey: 'implementation', taskKey: 'main' },
          { id: 'mutants-killed', status: 'passed', sentence: 'Every mutant is killed.', phaseKey: 'testing', taskKey: 'main' },
          { id: 'smoke-passes', status: 'not-applicable', sentence: 'There is no deployment smoke check to run.', phaseKey: null, taskKey: null },
        ],
      }),
    );
    await mount();
    const rows = document.querySelectorAll('[data-testid^="deep-validation-check-"]');
    expect(rows.length).toBe(4);
    expect(byId('deep-validation-check-solution-passes-hidden')?.textContent).toContain('a');
    expect(byId('deep-validation-check-starter-fails-hidden')?.textContent).toContain(
      'The starter already passes the hidden suite in Implementation.',
    );
    expect(byId('deep-validation-check-smoke-passes')?.textContent).toContain('There is no deployment smoke check to run.');
  });

  it('says when the stored run no longer matches the draft', async () => {
    deepValidation.mockResolvedValue(
      view({ status: 'passed', current: false, contentDigest: '9'.repeat(64), finishedAt: '2026-10-01T08:05:00.000Z' }),
    );
    await mount();
    expect(byId('deep-validation-stale')).not.toBeNull();
  });

  it('prints a refused start in the API words', async () => {
    deepValidation.mockResolvedValue(view());
    startDeepValidation.mockRejectedValue(new Error('You already have a deep validation running. It runs one at a time.'));
    await mount();
    await click('deep-validation-open');
    await settle(6);
    await click('deep-validation-start');
    await settle(6);
    expect(byId('deep-validation-error')?.textContent).toBe('You already have a deep validation running. It runs one at a time.');
  });

  it('offers no start on a version that is not editable', async () => {
    deepValidation.mockResolvedValue(view({ status: 'passed', current: true }));
    await mount(false);
    expect(byId('deep-validation-open')).toBeNull();
  });
});

describe('deep validation: focus in the dialog', () => {
  it('traps focus in the dialog, closes on Escape and hands focus back', async () => {
    deepValidation.mockResolvedValue(view());
    await mount();
    const opener = byId('deep-validation-open') as HTMLButtonElement;
    opener.focus();
    await click('deep-validation-open');
    await settle(6);
    const dialog = byId('deep-validation-dialog') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') as string)).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    expect(focusable.length).toBeGreaterThan(1);
    focusable[focusable.length - 1].focus();
    key(focusable[focusable.length - 1], 'Tab');
    expect(document.activeElement).toBe(focusable[0]);
    key(focusable[0], 'Tab', true);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);

    key(document.activeElement as Element, 'Escape');
    await settle(6);
    expect(byId('deep-validation-dialog')).toBeNull();
    expect(document.activeElement).toBe(byId('deep-validation-open'));
    expect(startDeepValidation).not.toHaveBeenCalled();
  });
});
