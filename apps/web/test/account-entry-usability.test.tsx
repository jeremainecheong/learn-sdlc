// @vitest-environment jsdom
import { act, StrictMode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RegisterPage from '@/app/register/page';
import { SignInPanel } from '@/components/landing/SignInPanel';
import { rememberRegistrationEmail, takeRegistrationEmail, clearPendingClass } from '@/lib/auth-flow';

const mocks = vi.hoisted(() => ({ push: vi.fn(), register: vi.fn(), login: vi.fn(), storeAuth: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/lib/useHydrated', () => ({ useHydrated: () => true }));
vi.mock('@/components/landing/GoogleSignIn', () => ({ GoogleSignIn: () => null }));
vi.mock('@/components/landing/AuthLayout', () => ({ AuthLayout: ({children}: any) => <div>{children}</div>, AuthNotice: ({children}: any) => <p role="alert">{children}</p> }));
vi.mock('@/lib/api', () => ({ api: { register: mocks.register, login: mocks.login }, describeError: (e: Error) => e.message, getToken: () => null, probeSiteData: () => true, storeAuth: mocks.storeAuth }));
let host: HTMLDivElement; let root: Root;
const field = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;
const change = (id: string, value: string) => act(() => { fireEvent.change(field(id), { target: { value: value } }); });
const submit = () => act(async () => { fireEvent.submit(host.querySelector('form')!); });
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearPendingClass(); takeRegistrationEmail();
  history.replaceState(null, '', '/register');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('focuses the missing name on every attempt and identifies only that invalid field', async () => {
  act(() => root.render(<RegisterPage/>));
  await submit();
  expect(document.activeElement).toBe(field('displayName'));
  expect(field('displayName').getAttribute('aria-invalid')).toBe('true');
  expect(field('email').getAttribute('aria-invalid')).not.toBe('true');
  expect(field('password').getAttribute('aria-invalid')).not.toBe('true');
  expect(field('displayName').getAttribute('aria-describedby')).toContain('displayName-error');
  host.querySelector<HTMLButtonElement>('[data-testid="register-submit"]')!.focus();
  await submit();
  expect(document.activeElement).toBe(field('displayName'));
  expect(mocks.register).not.toHaveBeenCalled();
});

it('gives a usable email correction before making a request', async () => {
  act(() => root.render(<RegisterPage/>));
  change('displayName', 'Learner'); change('email', 'bad-address'); change('password', 'correct-horse-lantern');
  await submit();
  expect(document.activeElement).toBe(field('email'));
  expect(host.textContent).toContain('you@example.com');
  expect(mocks.register).not.toHaveBeenCalled();
  change('email', 'learner@example.test'); change('password', 'short');
  await submit();
  expect(document.activeElement).toBe(field('password'));
  expect(field('password').getAttribute('aria-describedby')).toBe('password-error');
  expect(host.querySelector('#password-hint')).toBeNull();
  expect(host.querySelector('#password-error')?.textContent).toContain('Three unrelated words');
});

it('retains the form after service failure and carries the email and invitation on retry', async () => {
  history.replaceState(null, '', '/register?code=INVITE');
  mocks.register.mockRejectedValueOnce(new Error('Temporarily unavailable')).mockResolvedValueOnce({});
  act(() => root.render(<RegisterPage/>));
  change('displayName', ' Learner '); change('email', 'learner@example.test'); change('password', 'correct-horse-lantern');
  await submit();
  expect(document.activeElement?.id).toBe('registration-error');
  expect(field('password').value).toBe('correct-horse-lantern');
  expect(mocks.push).not.toHaveBeenCalled();
  await submit();
  expect(mocks.register).toHaveBeenLastCalledWith('learner@example.test', 'correct-horse-lantern', 'Learner');
  expect(mocks.push).toHaveBeenLastCalledWith('/login?registered=1&code=INVITE');
  expect(takeRegistrationEmail()).toBe('learner@example.test');
});

it('retains the handed-off email in StrictMode and keeps the invitation on the alternate route', () => {
  rememberRegistrationEmail('learner@example.test');
  history.replaceState(null, '', '/login?registered=1&code=INVITE');
  act(() => root.render(<StrictMode><SignInPanel/></StrictMode>));
  expect(field('email').value).toBe('learner@example.test');
  expect(host.querySelector('[data-testid="to-register"]')?.getAttribute('href')).toBe('/register?code=INVITE');
});

it('puts the password-change receipt beside a prefilled sign-in action', () => {
  rememberRegistrationEmail('learner@example.test');
  history.replaceState(null, '', '/login?passwordChanged=1');
  act(() => root.render(<StrictMode><SignInPanel/></StrictMode>));
  expect(field('email').value).toBe('learner@example.test');
  expect(host.textContent).toContain('Your password has changed and all sessions have ended.');
  expect(host.textContent).not.toContain('Your account is ready.');
});
