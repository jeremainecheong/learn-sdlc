// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RegisterPage from '@/app/register/page';
import ForgotPage from '@/app/forgot/page';
import ResetPage from '@/app/reset/page';
import { SignInPanel } from '@/components/landing/SignInPanel';
import { GoogleSignIn } from '@/components/landing/GoogleSignIn';
import { ConfirmationForm } from '@/components/landing/ConfirmationForm';
import { clearPendingClass, rememberRegistrationEmail, takeRegistrationEmail } from '@/lib/auth-flow';

const calls = vi.hoisted(() => ({ push: vi.fn(), register: vi.fn(), login: vi.fn(), providers: vi.fn(), confirm: vi.fn(), resend: vi.fn(), store: vi.fn(), clear: vi.fn(), forgot: vi.fn(), reset: vi.fn(), resetCode: vi.fn(), mark: vi.fn() }));
const router = { push: calls.push };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/lib/useHydrated', () => ({ useHydrated: () => true }));
vi.mock('@/components/landing/AuthLayout', () => ({ AuthLayout: ({ children }: any) => <div>{children}</div>, AuthNotice: ({ children, tone, testId }: any) => <p role={tone === 'fail' ? 'alert' : 'status'} data-testid={testId}>{children}</p>, AuthRule: () => <hr /> }));
vi.mock('@/lib/api', () => ({ api: { register: calls.register, login: calls.login, providers: calls.providers, confirmRegistration: calls.confirm, resendConfirmation: calls.resend }, describeError: (e: Error) => e.message, getToken: () => null, probeSiteData: () => true, storeAuth: calls.store, clearAuth: calls.clear, googleSignInUrl: (next = '') => `/legacy-google?next=${encodeURIComponent(next)}`, ssoSignInUrl: (provider: string, next = '') => `/sso?provider=${provider}&next=${encodeURIComponent(next)}`, markGoogleSignInStarted: calls.mark }));
vi.mock('@/lib/api-recovery', () => ({ recoveryApi: { forgot: calls.forgot, reset: calls.reset, resetWithCode: calls.resetCode }, tokenFromLocation: () => { const query = new URLSearchParams(location.search); const value = query.get('token') || ''; query.delete('token'); history.replaceState(null, '', `${location.pathname}?${query}`); return value; } }));
let host: HTMLDivElement, root: Root;
const node = <T extends HTMLElement = HTMLInputElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const change = (id: string, value: string) => act(() => { fireEvent.change(node(id), { target: { value } }); });
const click = async (id: string) => act(async () => { fireEvent.click(node(id)); });
const submit = async () => act(async () => { fireEvent.submit(host.querySelector('form')!); });
const render = async (view: React.ReactNode) => act(async () => { root.render(view); });
beforeEach(() => {
  vi.clearAllMocks(); calls.providers.mockResolvedValue({ google: false, authProvider: 'cognito', ssoProviders: [] });
  sessionStorage.clear(); localStorage.clear(); clearPendingClass(); takeRegistrationEmail(); history.replaceState(null, '', '/login');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('routes Cognito registration to confirmation without creating a session and preserves class/return context', async () => {
  history.replaceState(null, '', '/register?code=CLASS&next=%2Fprogress%3Fphase%3Dx');
  calls.register.mockResolvedValue({ confirmationRequired: true, email: 'learner@example.test' });
  await render(<RegisterPage />);
  change('displayName', 'Learner'); change('email', 'learner@example.test'); change('password', 'correct-horse-lantern');
  await submit();
  expect(calls.push).toHaveBeenCalledWith('/confirm?code=CLASS&next=%2Fprogress%3Fphase%3Dx');
  expect(calls.store).not.toHaveBeenCalled(); expect(node('password').value).toBe('');
  expect(takeRegistrationEmail()).toBe('learner@example.test');
});

it('turns a structured confirmation refusal into confirmation then explicit password sign-in', async () => {
  history.replaceState(null, '', '/login?code=CLASS&next=%2Fprogress');
  calls.login.mockRejectedValueOnce(Object.assign(new Error('Confirm email'), { body: { code: 'CONFIRMATION_REQUIRED', email: 'old@example.test' } }));
  calls.confirm.mockResolvedValue({ confirmed: true });
  await render(<SignInPanel />); change('email', 'old@example.test'); change('password', 'correct-horse-lantern'); await submit();
  expect(node('confirmation-form')).not.toBeNull(); expect(calls.store).not.toHaveBeenCalled();
  change('confirmation-email', 'correct@example.test'); change('confirmation-code', '123456'); await submit();
  expect(calls.confirm).toHaveBeenCalledWith('correct@example.test', '123456');
  expect(node('email').value).toBe('correct@example.test'); expect(node('password').value).toBe('');
  expect(host.textContent).toContain('Your email is confirmed');
  calls.login.mockResolvedValue({ token: 'token', user: { role: 'LEARNER', onboardingCompleted: true } });
  change('password', 'correct-horse-lantern'); await submit();
  expect(calls.push).toHaveBeenLastCalledWith('/progress'); expect(calls.store).toHaveBeenCalledTimes(1);
});

it('keeps an expired code for correction, focuses its error and allows a successful explicit resend', async () => {
  calls.confirm.mockRejectedValue(new Error('This code has expired. Request another.'));
  calls.resend.mockRejectedValueOnce(new Error('Try again later.')).mockResolvedValueOnce({ sent: true });
  const confirmed = vi.fn(); await render(<ConfirmationForm initialEmail="learner@example.test" onConfirmed={confirmed} />);
  change('confirmation-code', '123456'); await submit();
  expect(node('confirmation-code').value).toBe('123456'); expect(document.activeElement).toBe(node('confirmation-error'));
  expect(node('confirmation-code').getAttribute('autocomplete')).toBe('one-time-code');
  await click('confirmation-resend'); expect(host.textContent).toContain('Try again later.');
  await click('confirmation-resend'); expect(node('confirmation-resent').textContent).toContain('new code');
  expect(confirmed).not.toHaveBeenCalled(); expect(calls.resend).toHaveBeenCalledTimes(2);
});

it('blocks duplicate confirmation and resend requests while the first confirmation is pending', async () => {
  let resolve!: (value: { confirmed: true }) => void;
  calls.confirm.mockImplementation(() => new Promise(done => { resolve = done; }));
  const confirmed = vi.fn(); await render(<ConfirmationForm initialEmail="learner@example.test" onConfirmed={confirmed} />);
  change('confirmation-code', '654321'); await submit(); await submit(); await click('confirmation-resend');
  expect(calls.confirm).toHaveBeenCalledTimes(1); expect(calls.resend).not.toHaveBeenCalled(); expect(node<HTMLButtonElement>('confirmation-submit').disabled).toBe(true);
  await act(async () => resolve({ confirmed: true }));
  expect(confirmed).toHaveBeenCalledWith('learner@example.test');
});

it('offers the reset-code route from generic delivery copy and keeps invitation/next', async () => {
  history.replaceState(null, '', '/forgot?code=CLASS&next=%2Fprogress');
  calls.forgot.mockResolvedValue({ sent: true, delivery: 'code', message: 'If an account exists, check your email.' });
  await render(<ForgotPage />); change('forgot-email', 'learner@example.test'); await submit();
  expect(node('enter-reset-code').getAttribute('href')).toBe('/reset?delivery=code&code=CLASS&next=%2Fprogress');
  expect(host.textContent).toContain('If an account exists'); expect(host.textContent).not.toContain('local test inbox');
});

it('retains code and passwords after a rejected code, then completes an explicit reset retry', async () => {
  history.replaceState(null, '', '/reset?delivery=code&code=CLASS&next=%2Fprogress'); rememberRegistrationEmail('learner@example.test');
  calls.resetCode.mockRejectedValueOnce(new Error('The reset code is invalid.')).mockResolvedValueOnce({ changed: true });
  await render(<ResetPage />); change('reset-code', '123456'); change('reset-password', 'correct-horse-lantern'); change('reset-confirm', 'correct-horse-lantern');
  await submit();
  expect(node('reset-code').value).toBe('123456'); expect(node('reset-password').value).toBe('correct-horse-lantern'); expect(calls.clear).not.toHaveBeenCalled();
  change('reset-code', '654321'); await submit();
  expect(calls.resetCode).toHaveBeenLastCalledWith('learner@example.test', '654321', 'correct-horse-lantern');
  expect(calls.reset).not.toHaveBeenCalled(); expect(calls.clear).toHaveBeenCalledTimes(1);
  expect(node('to-login').getAttribute('href')).toBe('/login?code=CLASS&next=%2Fprogress');
  expect(takeRegistrationEmail()).toBe('learner@example.test');
});

it('keeps the existing local token reset path and removes its token from the address bar', async () => {
  history.replaceState(null, '', '/reset?token=private-reset-link'); calls.reset.mockResolvedValue({ changed: true });
  await render(<ResetPage />); expect(location.search).not.toContain('private-reset-link');
  change('reset-password', 'correct-horse-lantern'); change('reset-confirm', 'correct-horse-lantern'); await submit();
  expect(calls.reset).toHaveBeenCalledWith('private-reset-link', 'correct-horse-lantern'); expect(calls.resetCode).not.toHaveBeenCalled();
});

it('treats a committed password change with failed session recovery as explicit sign-in recovery, never a reset retry', async () => {
  history.replaceState(null, '', '/reset?delivery=code&code=CLASS&next=%2Fprogress');
  calls.resetCode.mockRejectedValueOnce(Object.assign(new Error('Application session recovery unavailable'), {
    status: 503, body: { code: 'PASSWORD_CHANGED_SIGN_IN_REQUIRED' },
  }));
  await render(<ResetPage />);
  change('reset-email', 'learner@example.test'); change('reset-code', '123456');
  change('reset-password', 'correct-horse-lantern'); change('reset-confirm', 'correct-horse-lantern');
  await submit();
  expect(node('reset-done')).not.toBeNull();
  expect(host.textContent).toContain('Your password has been changed');
  expect(host.textContent).toContain('Sign in with your new password');
  expect(host.textContent).not.toContain('Every device');
  expect(host.querySelector('form')).toBeNull();
  expect(node('reset-resend')).toBeNull();
  expect(node('reset-password')).toBeNull();
  expect(node('to-login').getAttribute('href')).toBe('/login?code=CLASS&next=%2Fprogress');
  expect(document.activeElement).toBe(node('reset-done'));
  expect(calls.resetCode).toHaveBeenCalledTimes(1); expect(calls.reset).not.toHaveBeenCalled();
  expect(calls.login).not.toHaveBeenCalled(); expect(calls.forgot).not.toHaveBeenCalled();
  expect(calls.clear).toHaveBeenCalledTimes(1);
  expect(takeRegistrationEmail()).toBe('learner@example.test');
});

it('retains a reset draft on an ordinary provider failure without pretending the password changed', async () => {
  history.replaceState(null, '', '/reset?delivery=code');
  calls.resetCode.mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503, body: { code: 'SERVICE_UNAVAILABLE' } }));
  await render(<ResetPage />);
  change('reset-email', 'learner@example.test'); change('reset-code', '123456');
  change('reset-password', 'correct-horse-lantern'); change('reset-confirm', 'correct-horse-lantern'); await submit();
  expect(node('reset-done')).toBeNull(); expect(node('reset-password').value).toBe('correct-horse-lantern');
  expect(node('reset-code').value).toBe('123456'); expect(calls.clear).not.toHaveBeenCalled();
});

it('focuses only the mismatched password and sends no reset request', async () => {
  history.replaceState(null, '', '/reset?delivery=code'); await render(<ResetPage />);
  change('reset-email', 'learner@example.test'); change('reset-code', '123456'); change('reset-password', 'correct-horse-lantern'); change('reset-confirm', 'different-password'); await submit();
  expect(document.activeElement).toBe(node('reset-confirm')); expect(calls.resetCode).not.toHaveBeenCalled();
  expect(node('reset-code').value).toBe('123456');
});

it('renders only configured federation providers and preserves the same-browser start marker', async () => {
  history.replaceState(null, '', '/login?next=%2Fprogress');
  calls.providers.mockResolvedValue({ google: true, authProvider: 'cognito', ssoProviders: [{ id: 'Google', label: 'Google' }] });
  await render(<GoogleSignIn />);
  expect(node('login-google').getAttribute('href')).toBe('/sso?provider=Google&next=%2Fprogress');
  expect(host.textContent).toContain('Continue with Google'); expect(host.textContent).not.toContain('SMU');
  await click('login-google'); expect(calls.mark).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Allow site data');
});

it('preserves the legacy Google endpoint on a local deployment and hides unavailable SSO', async () => {
  calls.providers.mockResolvedValue({ google: true }); await render(<GoogleSignIn />);
  expect(node('login-google').getAttribute('href')).toBe('/legacy-google?next=');
  await render(<div />); calls.providers.mockRejectedValue(new Error('unavailable')); await render(<GoogleSignIn />);
  expect(host.querySelector('a')).toBeNull();
});

it('shows actionable identity-link failure copy without reflecting arbitrary query text', async () => {
  history.replaceState(null, '', '/login?error=identity_link_required'); await render(<SignInPanel />);
  expect(host.textContent).toContain('Sign in with its existing password to migrate it');
  expect(node('login-submit')).not.toBeNull();
  await render(<div />); history.replaceState(null, '', '/login?error=untrusted-message'); await render(<SignInPanel />);
  expect(host.textContent).not.toContain('untrusted-message');
});
