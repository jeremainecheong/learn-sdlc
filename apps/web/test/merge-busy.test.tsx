// @vitest-environment jsdom
/**
 * MergePanel's button on the project's last phase reads "Complete the
 * project", but while it ran the label read "Continuing…", the word of the
 * other action. It now reads "Completing the project…" there; on every phase
 * with one after it, "Continue to next phase" still reads "Continuing…".
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergePanel } from '@/components/workspace/MergePanel';

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function pressed(isLast: boolean): Promise<[string, string]> {
  // A submit that never settles, so the busy label stays drawn.
  await act(async () => root.render(<MergePanel phaseTitle="Maintenance" score={100} isLast={isLast} onSubmit={() => new Promise(() => {})} onClose={() => {}} />));
  const button = document.querySelector('[data-testid="reflection-submit"]') as HTMLButtonElement;
  const before = button.textContent ?? '';
  await act(async () => button.click());
  return [before, button.textContent ?? ''];
}

describe('the merge button while it runs', () => {
  it('on the last phase reads Completing the project…', async () => {
    expect(await pressed(true)).toEqual(['Complete the project', 'Completing the project…']);
  });
  it('on a phase with one after it still reads Continuing…', async () => {
    expect(await pressed(false)).toEqual(['Continue to next phase', 'Continuing…']);
  });
});
