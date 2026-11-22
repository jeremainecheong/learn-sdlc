// @vitest-environment jsdom
/**
 * The token a reset or confirmation link carries, and how long it stays in
 * the address bar: not at all. A reset link is good for an hour, and left in
 * the URL it sat in this tab and in the browser's history for the next person
 * at a shared machine to reopen.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/landing/AuthLayout', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AuthNotice: ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
    <p data-testid={testId}>{children}</p>
  ),
}));
vi.mock('@/components/Field', () => ({
  Field: (props: { id: string; value: string }) => <input id={props.id} value={props.value} readOnly />,
}));

type Recovery = typeof import('@/lib/api-recovery');
let recovery: Recovery;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  vi.resetModules();
  recovery = await import('@/lib/api-recovery');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  window.history.replaceState(null, '', '/');
});

describe('tokenFromLocation', () => {
  it('reads the token and takes it out of the address bar in the same breath', () => {
    window.history.replaceState(null, '', '/reset?token=fresh-for-an-hour');
    expect(recovery.tokenFromLocation()).toBe('fresh-for-an-hour');
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/reset');
    // Gone for good: a second read, or a reopen from history, has nothing.
    expect(recovery.tokenFromLocation()).toBe('');
  });

  it('leaves the rest of the query alone, and a page with no token untouched', () => {
    window.history.replaceState(null, '', '/verify?token=t1&from=email');
    expect(recovery.tokenFromLocation()).toBe('t1');
    expect(window.location.search).toBe('?from=email');

    window.history.replaceState(null, '', '/reset?next=%2Fmap');
    expect(recovery.tokenFromLocation()).toBe('');
    expect(window.location.search).toBe('?next=%2Fmap');
  });
});

describe('the reset page', () => {
  it('has the token in state and out of the URL once it has mounted', async () => {
    window.history.replaceState(null, '', '/reset?token=fresh-for-an-hour');
    const Page = (await import('@/app/reset/page')).default;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<StrictMode><Page /></StrictMode>);
    });

    // The form is drawn (the page still has the token) and the bar does not.
    expect(host.querySelector('[data-testid="reset-submit"]')).not.toBeNull();
    expect(window.location.search).toBe('');
  });
});
