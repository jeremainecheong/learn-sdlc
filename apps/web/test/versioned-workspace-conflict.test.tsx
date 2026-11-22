// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, getByRole } from '@testing-library/dom';
import type { PhaseDetail } from '@learnsdlc/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VersionedWorkspaceConflict } from '@/components/workspace/VersionedWorkspaceConflict';

let host: HTMLDivElement, root: Root;
// jsdom has no native modal implementation; browser retakes cover focus trapping.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const path = 'design/api.json', version = '2026-09-15T18:00:00.000Z';
function mount(server: string, local: string) {
  const resolve = vi.fn(), close = vi.fn();
  const conflict = { workspaceUpdatedAt: version, files: [{ path, content: server, editable: true }] } as PhaseDetail;
  act(() => root.render(<VersionedWorkspaceConflict title="Design" conflict={conflict} files={{ [path]: local }} saving={false} onResolve={resolve} onClose={close} />));
  return { resolve, close };
}
it('opens on every changed line with context, including changes deep in a large file, and preserves complete copies', () => {
  const lines = Array.from({ length: 260 }, (_, i) => `unchanged contract line ${i + 1}`);
  lines[210] = 'saved response contract';
  const server = lines.join('\n') + '\n', local = server.replace('saved response contract', 'draft response contract');
  mount(server, local);
  const summary = getByRole(host, 'region', { name: `Changed lines: ${path}` });
  expect(summary.textContent).toContain('saved response contract');
  expect(summary.textContent).toContain('draft response contract');
  expect(summary.textContent).toContain('Removed'); expect(summary.textContent).toContain('Added');
  expect(summary.textContent).toContain('unchanged contract line 210');
  expect(summary.textContent).not.toContain('unchanged contract line 260');
  expect(summary.querySelector('code')?.closest('[tabindex]')).not.toBeNull();
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('[aria-label="Server source: design/api.json"]')?.textContent).toBe(server);
  expect(host.querySelector('[aria-label="Local source: design/api.json"]')?.textContent).toBe(local);
});
it('makes normalized newline-only differences explicit and binds choices to the exact compared version', () => {
  const { resolve, close } = mount('first\r\nsecond\r\n', 'first\nsecond');
  expect(host.textContent).toContain('line endings or the final newline differ');
  act(() => fireEvent.click(getByRole(host, 'button', { name: 'Keep comparing later' })));
  expect(close).toHaveBeenCalledOnce(); expect(resolve).not.toHaveBeenCalled();
  act(() => fireEvent.click(getByRole(host, 'button', { name: 'Save my draft' })));
  expect(resolve).toHaveBeenCalledExactlyOnceWith('draft', version);
});
