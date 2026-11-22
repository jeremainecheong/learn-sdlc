// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignInPanel } from '@/components/landing/SignInPanel';
import { clearPendingClass, takeRegistrationEmail } from '@/lib/auth-flow';

const calls = vi.hoisted(() => ({ login: vi.fn(), providers: vi.fn(), store: vi.fn(), push: vi.fn(), mark: vi.fn() }));
const router = { push: calls.push };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock('@/lib/useHydrated', () => ({ useHydrated: () => true }));
vi.mock('@/lib/api', () => ({
  api: { login: calls.login, providers: calls.providers },
  describeError: (error: Error) => error.message,
  getToken: () => null, probeSiteData: () => true, storeAuth: calls.store,
  googleSignInUrl: () => '/api/v1/auth/google',
  ssoSignInUrl: (provider: string, next: string) => `/api/v1/auth/sso/start?provider=${provider}&next=${encodeURIComponent(next)}`,
  markGoogleSignInStarted: calls.mark,
}));

const reference = 'f83aa2bb-ed5e-4d8b-940a-34a4629790d1';
let host: HTMLDivElement;
let root: Root;
const node = <T extends HTMLElement = HTMLElement>(testId: string) => host.querySelector<T>(`[data-testid="${testId}"]`);
const render = async (query: string) => {
  history.replaceState(null, '', `/login?${query}`);
  await act(async () => root.render(<StrictMode><SignInPanel /></StrictMode>));
};
const expectUntouchedPasswordForm = () => {
  expect(node('email')?.hasAttribute('aria-invalid')).toBe(false);
  expect(node('password')?.hasAttribute('aria-invalid')).toBe(false);
  expect(node('auth-error')).toBeNull();
  expect(calls.login).not.toHaveBeenCalled();
  expect(calls.store).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); clearPendingClass(); takeRegistrationEmail();
  calls.providers.mockResolvedValue({ google: true, authProvider: 'cognito', ssoProviders: [{ id: 'Google', label: 'Google' }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('announces expired SSO beside its provider action with a safe reference and leaves password fields valid', async () => {
  await render(`error=sso_expired&reference=${reference}&next=%2Fonboarding`);
  const notice = node('sso-error')!;
  expect(notice.textContent).toContain('This sign-in request expired after ten minutes. Choose your sign-in provider again to start a fresh attempt.');
  expect(notice.querySelector('[role="alert"]')).not.toBeNull();
  expect(node('sso-reference')?.textContent).toBe(`Reference: ${reference}`);
  expect(notice.closest('form')).toBeNull();
  expect(notice.compareDocumentPosition(node('login-google')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(node('login-google')?.getAttribute('href')).toBe('/api/v1/auth/sso/start?provider=Google&next=%2Fonboarding');
  expectUntouchedPasswordForm();
});

it.each([
  ['sso_failed', 'That provider sign-in could not be completed. Try again or sign in with email and password.'],
  ['identity_link_required', 'An existing LearnSDLC account uses this address. Sign in with its existing password to migrate it, or contact the host.'],
])('keeps %s guidance separate from password validation', async (code, message) => {
  await render(`error=${code}&reference=${reference}`);
  expect(node('sso-error')?.textContent).toContain(message);
  expect(node('sso-reference')?.textContent).toBe(`Reference: ${reference}`);
  expectUntouchedPasswordForm();
});

it.each([
  '<script>untrusted-reference</script>',
  `${reference}\n`,
  `prefix-${reference}`,
  `${reference}-suffix`,
  'f83aa2bb-ed5e-4d8b-940a-34a4629790dZ',
])('does not render an incomplete or hostile reference: %s', async value => {
  await render(`error=sso_expired&reference=${encodeURIComponent(value)}&error_description=untrusted-provider-detail`);
  expect(node('sso-error')).not.toBeNull();
  expect(node('sso-reference')).toBeNull();
  expect(host.textContent).not.toContain(value);
  expect(host.textContent).not.toContain('untrusted-provider-detail');
  expectUntouchedPasswordForm();
});

it('ignores arbitrary error text and a reference without a recognized failure', async () => {
  await render(`error=${encodeURIComponent('<img src=x onerror=untrusted>')}&reference=${reference}`);
  expect(node('sso-error')).toBeNull();
  expect(host.textContent).not.toContain('untrusted');
  expect(host.textContent).not.toContain(reference);
  expectUntouchedPasswordForm();
});

it('still reports a real password refusal after an expired provider attempt, retaining the entered draft', async () => {
  calls.login.mockRejectedValueOnce(new Error('That email and password were not accepted.'));
  await render('error=sso_expired');
  act(() => {
    fireEvent.change(node('email')!, { target: { value: 'learner@example.test' } });
    fireEvent.change(node('password')!, { target: { value: 'typed-private-password' } });
  });
  await act(async () => { fireEvent.submit(host.querySelector('form')!); });
  expect(calls.login).toHaveBeenCalledExactlyOnceWith('learner@example.test', 'typed-private-password');
  expect(node('auth-error')?.textContent).toContain('That email and password were not accepted.');
  expect(node('email')?.getAttribute('aria-invalid')).toBe('true');
  expect(node('password')?.getAttribute('aria-invalid')).toBe('true');
  expect(node<HTMLInputElement>('password')?.value).toBe('typed-private-password');
  expect(node('sso-error')?.textContent).toContain('expired after ten minutes');
  expect(calls.store).not.toHaveBeenCalled();
  expect(calls.push).not.toHaveBeenCalled();
});
