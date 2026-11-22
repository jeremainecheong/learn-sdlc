// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AccountPage from '@/app/(app)/account/page';

const calls = vi.hoisted(() => ({ providers: vi.fn(), password: vi.fn(), replace: vi.fn() }));
const router = { replace: calls.replace };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/components/experience/shared', () => ({ ExperiencePage: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/app/verify/VerifyBanner', () => ({ VerifyBanner: () => null }));
vi.mock('@/lib/api', () => ({ api: { providers: calls.providers, changePassword: calls.password }, getToken: () => 'current-session', clearAuth: vi.fn(), signInHref: () => '/login' }));
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: 'current-owner', role: 'LEARNER', email: 'learner@example.test', displayName: 'Learner' }), onSessionEnd: () => () => undefined }));
let host: HTMLDivElement, root: Root;
const render = () => act(async () => root.render(<AccountPage />));
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('shows managed deletion guidance instead of a destructive control while retaining export and native password change', async () => {
  calls.providers.mockResolvedValue({ google: true, authProvider: 'cognito', accountDeletion: false, passwordChange: true });
  await render();
  expect(host.querySelector('[data-testid="delete-account"]')).toBeNull();
  expect(host.querySelector('[data-testid="confirm-delete"]')).toBeNull();
  expect(host.querySelector('[data-testid="managed-account-deletion"]')?.textContent).toContain('Contact the LearnSDLC operator');
  expect(host.querySelector('[data-testid="export-data"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="password-save"]')).not.toBeNull();
  expect(host.textContent).toContain('If you use Google or an institution account');
});

it('offers delete and password change when the optional capabilities are absent', async () => {
  calls.providers.mockResolvedValue({ google: false }); await render();
  expect(host.querySelector('[data-testid="delete-account"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="password-save"]')).not.toBeNull();
});

it('does not guess destructive capabilities after a failed read and offers a read-only retry', async () => {
  calls.providers.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ google: false, accountDeletion: false, passwordChange: false });
  await render(); expect(host.querySelector('[data-testid="delete-account"]')).toBeNull();
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry account actions')!;
  await act(async () => { fireEvent.click(retry); });
  expect(calls.providers).toHaveBeenCalledTimes(2); expect(calls.password).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="password-save"]')).toBeNull();
  expect(host.textContent).toContain('Your sign-in provider manages this password');
});

it('underlines the privacy link at rest, so it is told apart from its sentence without colour', async () => {
  calls.providers.mockResolvedValue({ google: false }); await render();
  const link = host.querySelector('a[href="/privacy"]');
  expect(link?.textContent).toBe('privacy policy');
  expect(link!.className.split(/\s+/)).toContain('underline');
});
