// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DeferredMarkdown } from '@/components/DeferredMarkdown';

const parser = vi.hoisted(() => ({ release: undefined as undefined | ((module: { Markdown: ({ children }: { children: string }) => ReactElement }) => void) }));
vi.mock('@/components/Markdown', () => new Promise(resolve => { parser.release = resolve; }));

it('keeps the actual received reply readable until the delayed parser becomes available', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const reply = 'Inspect **the boundary** first.\nWhich case would distinguish the two rules?';
  try {
    await act(async () => root.render(<DeferredMarkdown>{reply}</DeferredMarkdown>));
    expect(host.textContent).toBe(reply);
    expect(host.querySelector('[data-parsed]')).toBeNull();
    await vi.waitFor(() => expect(parser.release).toBeTypeOf('function'));
    await act(async () => parser.release!({ Markdown: ({ children }) => <div data-parsed>{children}</div> }));
    expect(host.querySelector('[data-parsed]')?.textContent).toBe(reply);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
