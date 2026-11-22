// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, getByRole } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExecutionRunView, PhaseDetail } from '@learnsdlc/shared';

const state = vi.hoisted(() => ({ owner: 'owner-a', token: 'test-session-a', phaseId: 'testing-a', runId: 'old-failed-run', phase: vi.fn(), run: vi.fn(), recent: vi.fn(), endings: new Set<() => void>() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: state.phaseId, runId: state.runId }) }));
vi.mock('@/lib/session', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/session')>(), getSession: () => ({ id: state.owner }), useSession: () => ({ id: state.owner }), onSessionEnd: (fn: () => void) => { state.endings.add(fn); return () => state.endings.delete(fn); } }));
vi.mock('@/lib/api', async importOriginal => {
  class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { ...await importOriginal<typeof import('@/lib/api')>(), ApiError, getToken: () => state.token, api: { phase: state.phase, getRun: state.run, runs: state.recent }, describeError: (cause: unknown, fallback: string) => cause instanceof ApiError ? cause.message : fallback };
});
vi.mock('@/lib/poll', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/poll')>(), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/shell/DocPage', () => ({ DocPage: ({ children, title }: { children: ReactNode; title: ReactNode }) => <main><h1>{title}</h1>{children}</main> }));

import RecordedRunPage from '@/app/(app)/workspace/[phaseId]/runs/[runId]/page';
import { ApiError } from '@/lib/api';
import { buildJournal } from '@/components/journal/derive';
import { sample } from './fixtures';
let host: HTMLDivElement, root: Root;
const phase = (id = 'testing-a') => ({ id, key: 'testing', title: 'Testing', status: 'in_progress' }) as PhaseDetail;
const recorded = (id = 'old-failed-run', phaseStateId = 'testing-a'): ExecutionRunView => ({ id, phaseStateId, kind: 'run', status: 'completed', createdAt: '2026-09-15T12:00:00.000Z', inputHash: '1234567890abcdef'.repeat(4), runClock: '2026-09-15', result: { ok: false, exitKind: 'error', stdout: 'recorded old output', stderr: '', durationMs: 42,
  tests: { total: 1, passed: 0, failed: 1, errored: 0, cases: [{ name: 'old_overdue_boundary', status: 'failed', message: 'Expected: false\nActual: true' }] } } });
const render = () => act(async () => root.render(<RecordedRunPage />));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); state.owner = 'owner-a'; state.token = 'test-session-a'; state.phaseId = 'testing-a'; state.runId = 'old-failed-run'; state.endings.clear();
  state.phase.mockImplementation(async (id: string) => phase(id)); state.run.mockResolvedValue(recorded()); state.recent.mockResolvedValue([]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('opens the exact old run independently of capped recent history, with Testing evidence, provenance and no execution control', async () => {
  await render();
  expect(state.phase).toHaveBeenCalledExactlyOnceWith('testing-a'); expect(state.run).toHaveBeenCalledExactlyOnceWith('old-failed-run'); expect(state.recent).not.toHaveBeenCalled();
  expect(host.textContent).toContain('old_overdue_boundary'); expect(host.textContent).toContain('0/1 tests passed');
  expect(host.querySelector('[data-testid="run-input-provenance"]')?.getAttribute('title')).toBe(`Recorded inputs ${recorded().inputHash}`);
  expect(host.querySelector('[aria-label="Recorded test run"]')).not.toBeNull(); expect(host.querySelector('[data-testid="run-button"]')).toBeNull();
  act(() => fireEvent.click(getByRole(host, 'tab', { name: 'Run output' })));
  expect(host.textContent).toContain('recorded old output');
});
it.each([['same-owner-other-phase', { phaseStateId: 'different-phase' }], ['missing-provenance', { phaseStateId: undefined }], ['wrong-id', { id: 'new-latest-run' }]])('rejects %s without falling back to another run', async (_, mismatch) => {
  state.run.mockResolvedValue({ ...recorded(), ...mismatch }); await render();
  expect(host.textContent).toContain('This run is not available in this phase'); expect(host.querySelector('[data-testid="run-panel"]')).toBeNull(); expect(state.recent).not.toHaveBeenCalled();
});
it('does not request run evidence when the phase is locked or forbidden', async () => {
  state.phase.mockResolvedValue({ ...phase(), status: 'locked' }); await render(); expect(state.run).not.toHaveBeenCalled();
  state.phase.mockRejectedValue(new ApiError(403, 'This phase is not available.'));
  await act(async () => fireEvent.click(getByRole(host, 'button', { name: 'Try again' })));
  expect(state.run).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('old_overdue_boundary');
});
it('offers a retry for an interrupted exact lookup and renders only the requested evidence after recovery', async () => {
  state.run.mockRejectedValueOnce(new Error('network interrupted')); await render();
  expect(host.textContent).toContain('This recorded run could not be loaded');
  await act(async () => fireEvent.click(getByRole(host, 'button', { name: 'Try again' })));
  expect(host.textContent).toContain('old_overdue_boundary'); expect(state.run.mock.calls.map(call => call[0])).toEqual(['old-failed-run', 'old-failed-run']);
});
it('discards held results after a route change and after session rotation', async () => {
  const old = deferred<ExecutionRunView>(); state.run.mockReturnValueOnce(old.promise); await render();
  state.runId = 'selected-second-run'; state.run.mockResolvedValue(recorded(state.runId)); await render();
  await act(async () => old.resolve(recorded()));
  expect(host.querySelector('[data-testid="recorded-run-id"]')?.textContent).toBe('Run selected-second-run');
  act(() => { state.token = 'rotated-session'; state.endings.forEach(fn => fn()); });
  expect(host.querySelector('[data-testid="run-panel"]')).toBeNull(); expect(host.textContent).toContain('Your session changed');
});
it('does not expose a held response to a newly signed-in owner', async () => {
  const old = deferred<ExecutionRunView>(); state.run.mockReturnValueOnce(old.promise); await render();
  state.owner = 'owner-b'; state.token = 'test-session-b'; state.phase.mockRejectedValue(new ApiError(403, 'Not available')); await render();
  await act(async () => old.resolve(recorded()));
  expect(host.textContent).not.toContain('old_overdue_boundary'); expect(host.querySelector('[data-testid="run-panel"]')).toBeNull();
});
it('journal links retain each underlying run ID, including two runs in the same phase', () => {
  const project = sample().enrollment, target = project.phases.find(item => item.key === 'testing')!;
  const events = buildJournal(project, {}, { [target.id]: { runs: [recorded('first', target.id), recorded('second', target.id)], submissions: [], chat: [] } }).filter(event => event.kind === 'run');
  expect(events.map(event => event.href).sort()).toEqual([`/workspace/${target.id}/runs/first`, `/workspace/${target.id}/runs/second`]);
});
