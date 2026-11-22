// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getByRole, queryByRole } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyProject } from '@/components/experience/shared';

// `slug` is what the provider resolved for this learner, which is what the
// panel starts. It is deliberately a fixture slug and not the shipped pack's,
// because a test written against "tasktrackr" would pass just as happily
// against a literal in the component.
const state = vi.hoisted(() => ({
  error: '', enrolling: '', loading: false, revalidating: false, slug: 'ledger',
  start: vi.fn(), reload: vi.fn(),
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => state }));
vi.mock('@/components/AppShell', () => ({ AppShell: () => null }));

let host: HTMLDivElement;
let root: Root;
const render = () => act(() => root.render(<EmptyProject />));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { error: '', enrolling: '', loading: false, revalidating: false });
  state.start.mockResolvedValue(undefined);
  state.reload.mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('unavailable project recovery', () => {
  it('does not invite an enrolled learner to create a project when loading failed', () => {
    state.error = 'Your project could not be loaded. Reference 11111111-1111-4111-8111-111111111111.';
    render();
    expect(queryByRole(host, 'button', { name: 'Start Requirements' })).toBeNull();
    expect(host.textContent).not.toContain('Your next chapter starts here.');
    expect(getByRole(host, 'alert').textContent).toContain(state.error);
    expect(getByRole(host, 'button', { name: 'Retry project' })).toBeTruthy();
  });

  it('rechecks saved project state without sending a create action', async () => {
    state.error = 'Your project could not be loaded. Try again in a moment.';
    render();
    await act(async () => getByRole(host, 'button', { name: 'Retry project' }).click());
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('disables retry during a pending read while keeping the error available', () => {
    state.error = 'The project service is unavailable.'; state.revalidating = true;
    render();
    const button = getByRole(host, 'button', { name: 'Loading your project…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(state.reload).not.toHaveBeenCalled();
    expect(getByRole(host, 'alert').textContent).toBe(state.error);
  });

  it('still offers normal enrollment after the project read confirms no enrollment', async () => {
    render();
    expect(queryByRole(host, 'button', { name: 'Retry project' })).toBeNull();
    await act(async () => getByRole(host, 'button', { name: 'Start Requirements' }).click());
    // Start names no project: the server starts the one it resolves, so the
    // slug the page holds is never sent.
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledWith();
    expect(state.reload).not.toHaveBeenCalled();
  });
});
