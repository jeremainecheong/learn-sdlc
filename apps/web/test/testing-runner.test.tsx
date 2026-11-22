// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionRunView, RunResult } from '@learnsdlc/shared';
import { TestingRunEvidence } from '@/components/workspace/TestingRunEvidence';
import { RunPanel } from '@/components/workspace/RunPanel';

let host: HTMLDivElement;
let root: Root;
const result: RunResult = {
  ok: false, exitKind: 'ok', durationMs: 42, stdout: 'API suite ran\nWeb suite ran', stderr: 'Captured diagnostic',
  tests: { total: 3, passed: 1, failed: 2, errored: 0, cases: [
    { name: 'complete task', step: 'api', status: 'passed' },
    { name: 'overdue boundary', step: 'api', status: 'failed', message: 'assert task.due_date < today', frames: [{ path: 'tests/test_tasks.py', line: 19, snippet: 'assert rows == []' }] },
    { name: 'shows overdue label', step: 'web', status: 'failed', message: 'Expected: "Overdue"\nReceived: "On time"' },
  ] },
  steps: [
    { id: 'api', label: 'Python API', ok: false, exitKind: 'ok', durationMs: 20, total: 2, passed: 1, failed: 1, errored: 0 },
    { id: 'web', label: 'Frontend DOM', ok: false, exitKind: 'ok', durationMs: 22, total: 1, passed: 0, failed: 1, errored: 0 },
  ],
};
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function click(selector: string) { const element = host.querySelector<HTMLButtonElement>(selector); expect(element).not.toBeNull(); act(() => element!.click()); }
function clickTab(label: string) {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(item => item.textContent === label)!;
  act(() => tab.click());
}

describe('the recorded Testing suite inspector', () => {
  it('opens the first failure and switches the correct case, comparison and run-wide console', () => {
    act(() => root.render(<TestingRunEvidence result={result}/>));
    expect(host.querySelector('.testing-selected-case')?.textContent).toContain('overdue boundary');
    expect(host.querySelector('[role=tabpanel]')?.textContent).toContain('tests/test_tasks.py:19');
    expect(host.querySelectorAll('.testing-suite-tree details')).toHaveLength(2);
    click('button[title="shows overdue label"]');
    expect(host.querySelector('.testing-selected-case')?.textContent).toContain('shows overdue label');
    expect(host.querySelector('[role=tabpanel]')?.textContent).not.toContain('tests/test_tasks.py');
    clickTab('Expected / actual');
    expect(host.querySelector('.testing-diff-expected pre')?.textContent).toBe('"Overdue"');
    expect(host.querySelector('.testing-diff-actual pre')?.textContent).toBe('"On time"');
    // The run's own output is "Run output", so "Console" names only the app's console in the room.
    clickTab('Run output');
    expect(host.querySelector('[role=tabpanel]')?.textContent).toContain('What the whole run printed, every suite included.');
    expect(host.querySelector('[role=tabpanel]')?.textContent).toContain('API suite ran\nWeb suite ran');
    expect(host.querySelector('[role=tabpanel]')?.textContent).toContain('Captured diagnostic');
  });

  it('does not fabricate expected or actual values from an unlabelled assertion', () => {
    act(() => root.render(<TestingRunEvidence result={result}/>));
    clickTab('Expected / actual');
    expect(host.textContent).toContain('did not report separate expected and actual values');
    expect(host.querySelector('[role=tabpanel] pre')?.textContent).toBe('assert task.due_date < today');
    expect(host.querySelector('.testing-diff-block')).toBeNull();
    click('button[title="complete task"]');
    expect(host.querySelector('[role=tabpanel]')?.textContent).toContain('This case passed');
    expect(host.querySelector('[role=tabpanel]')?.textContent).not.toContain('assert task.due_date');
  });

  it('keeps multiline expected and actual values intact instead of clipping them', () => {
    const message = 'Expected: [\n  "overdue"\n]\nReceived: [\n  "today"\n]';
    const multiline = { ...result, tests: { ...result.tests!, cases: [{ name: 'multiline failure', status: 'failed' as const, message }] } };
    act(() => root.render(<TestingRunEvidence result={multiline}/>));
    clickTab('Expected / actual');
    expect(host.querySelector('.testing-diff-block')).toBeNull();
    expect(host.querySelector('[role=tabpanel] pre')?.textContent).toBe(message);
  });

  it('keeps unmatched cases visible and supports keyboard tab selection', () => {
    const withOrphan = { ...result, tests: { ...result.tests!, cases: [...result.tests!.cases, { name: 'setup failed', step: 'unknown', status: 'errored' as const, message: 'ImportError: fixture missing' }] } };
    act(() => root.render(<TestingRunEvidence result={withOrphan}/>));
    expect(host.textContent).toContain('Other recorded cases');
    click('button[title="setup failed"]');
    expect(host.querySelector('[role=tabpanel]')?.textContent).toContain('ImportError: fixture missing');
    const firstTab = host.querySelector<HTMLButtonElement>('[role=tab]')!;
    act(() => { firstTab.focus(); firstTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(host.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Expected / actual');
    expect(document.activeElement?.textContent).toBe('Expected / actual');
  });

  it('preserves the RunPanel busy and unavailable states without exposing an old success', () => {
    const run: ExecutionRunView = { id: 'recorded-run', status: 'completed', kind: 'run', createdAt: '2026-09-11T00:00:00Z', result };
    const props = { run, appearance: 'testing' as const, canRun: true, runLabel: 'Run tests', onRun: () => {} };
    act(() => root.render(<RunPanel {...props} busy/>));
    expect(host.querySelector('[data-testid=run-pending]')?.textContent).toContain('Waiting for a sandbox');
    expect(host.querySelector('.testing-runner')).toBeNull();
    act(() => root.render(<RunPanel {...props} busy={false} run={{ ...run, status: 'failed', result: { ok: false, exitKind: 'unavailable', stdout: '', stderr: 'Runner is unavailable.', durationMs: 0 } }}/>));
    expect(host.querySelector('[data-testid=run-unavailable]')?.textContent).toContain('Runner is unavailable.');
    expect(host.querySelector('[data-testid=run-summary]')).toBeNull();
  });
});
