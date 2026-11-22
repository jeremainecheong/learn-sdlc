// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());

it('carries an invitation and consumes the registration email without storing credentials', async () => {
  const flow = await import('@/lib/auth-flow');
  flow.rememberClassCode(' class / invite ');
  flow.rememberRegistrationEmail(' learner@example.test ');
  expect(flow.invitationHref('/login', flow.pendingClassCode())).toBe('/login?code=class%20%2F%20invite');
  expect(flow.takeRegistrationEmail()).toBe('learner@example.test');
  expect(flow.takeRegistrationEmail()).toBe('');
  expect(flow.pendingClassCode()).toBe('class / invite');
  flow.clearPendingClass();
  expect(flow.pendingClassCode()).toBe('');
});

it('finishes the current-tab handoff when browser storage is blocked', async () => {
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  }
  const flow = await import('@/lib/auth-flow');
  flow.rememberClassCode('INVITE');
  flow.rememberRegistrationEmail('learner@example.test');
  expect(flow.pendingClassCode()).toBe('INVITE');
  expect(flow.takeRegistrationEmail()).toBe('learner@example.test');
  const { clearSession } = await import('@/lib/session');
  expect(clearSession).not.toThrow();
  expect(flow.pendingClassCode()).toBe('');
  expect(flow.takeRegistrationEmail()).toBe('');
});

it('removes page-owned drafts even when their components were never loaded', async () => {
  const session = await import('@/lib/session');
  const keys = [
    'lsdlc_profile_draft', 'lsdlc_class_code', 'lsdlc_class_code_for', 'lsdlc_registration_email',
    // The dotted spelling a browser may still hold is removed too.
    'learnsdlc.profile-draft.v1', 'learnsdlc.pendingClass', 'learnsdlc.pendingClass.for', 'learnsdlc.registration-email',
  ];
  for (const key of keys) sessionStorage.setItem(key, 'private current-tab data');
  session.clearSession();
  for (const key of keys) expect(sessionStorage.getItem(key)).toBeNull();
});

it('clears the local profile draft when another tab ends a remembered session', async () => {
  const session = await import('@/lib/session');
  session.subscribe(() => undefined);
  sessionStorage.setItem('lsdlc_profile_draft', 'previous learner');
  sessionStorage.setItem('learnsdlc.profile-draft.v1', 'previous learner');
  window.dispatchEvent(new StorageEvent('storage', { key: session.TOKEN_KEY, newValue: null, storageArea: localStorage }));
  expect(sessionStorage.getItem('lsdlc_profile_draft')).toBeNull();
  expect(sessionStorage.getItem('learnsdlc.profile-draft.v1')).toBeNull();
});

it('keeps a validated return destination through confirmation without putting a one-time code in handoff storage', async () => {
  const flow = await import('@/lib/auth-flow');
  flow.rememberRegistrationEmail('learner@example.test');
  expect(flow.registrationEmail()).toBe('learner@example.test');
  expect(flow.registrationEmail()).toBe('learner@example.test');
  expect(flow.invitationHref('/login?confirmed=1', 'CLASS', '/progress?phase=x')).toBe('/login?confirmed=1&code=CLASS&next=%2Fprogress%3Fphase%3Dx');
  expect(flow.invitationHref('/confirm', 'CLASS', '//other.example')).toBe('/confirm?code=CLASS');
  expect(flow.confirmationEmail({ body: { code: 'CONFIRMATION_REQUIRED', email: 'learner@example.test' } })).toBe('learner@example.test');
  expect(flow.confirmationEmail(new Error('CONFIRMATION_REQUIRED'))).toBeNull();
  expect(sessionStorage.getItem('lsdlc_registration_email')).toBe('learner@example.test');
});

it('reads a waiting class code and registration address stored under the dotted keys, and moves them to the lsdlc_ keys', async () => {
  sessionStorage.setItem('learnsdlc.pendingClass', 'CARRIED');
  sessionStorage.setItem('learnsdlc.registration-email', 'learner@example.test');
  const flow = await import('@/lib/auth-flow');
  expect(flow.pendingClassCode()).toBe('CARRIED');
  expect(flow.registrationEmail()).toBe('learner@example.test');
  expect(sessionStorage.getItem('lsdlc_class_code')).toBe('CARRIED');
  expect(sessionStorage.getItem('lsdlc_registration_email')).toBe('learner@example.test');
  expect(sessionStorage.getItem('learnsdlc.pendingClass')).toBeNull();
  expect(sessionStorage.getItem('learnsdlc.registration-email')).toBeNull();
  // A code cleared after the move is not carried back from the dotted key.
  flow.clearPendingClass();
  expect(flow.pendingClassCode()).toBe('');
});

it('never brings back a dotted class code that was cleared before it was read', async () => {
  sessionStorage.setItem('learnsdlc.pendingClass', 'STALE');
  const flow = await import('@/lib/auth-flow');
  flow.clearPendingClass();
  expect(flow.pendingClassCode()).toBe('');
  expect(sessionStorage.getItem('learnsdlc.pendingClass')).toBeNull();
});

/**
 * A class code waiting in the tab belongs to the account that signs in after
 * it, and to no other.
 *
 * The code is stashed while signed out (an invitation link read on the
 * register or sign-in page) and read at setup. Signing out clears it, and so
 * does registering over a live session; but another tab signing a different
 * account in writes a new profile into this tab without ending anything, and
 * setup would then have offered the first account's class to the second, the
 * same way the tab once offered the first account's project.
 */
it('keeps an invitation for the account that signs in after it, and never hands it to the next one', async () => {
  const session = await import('@/lib/session');
  const flow = await import('@/lib/auth-flow');
  session.subscribe(() => undefined);
  const person = (id: string) => ({ id, email: `${id}@lab.test`, displayName: id, role: 'LEARNER', cohort: 'default', profileVersion: 1, createdAt: '2026-09-20T00:00:00.000Z' }) as never;

  // Read while signed out: waiting for whoever signs in, so the invitation
  // flow still works.
  flow.rememberClassCode('CLASSONE');
  expect(flow.pendingClassCode()).toBe('CLASSONE');
  session.setAuthSession('token-one', person('one'));
  // Claimed by the account that signed in after it.
  expect(flow.pendingClassCode()).toBe('CLASSONE');
  expect(flow.pendingClassCode()).toBe('CLASSONE');

  // Another tab signs a different account in: this tab's profile changes and
  // no session ends here.
  localStorage.setItem(session.TOKEN_KEY, 'token-two');
  window.dispatchEvent(new StorageEvent('storage', { key: session.USER_KEY, newValue: JSON.stringify(person('two')), storageArea: localStorage }));
  expect(session.getSession()?.id).toBe('two');
  expect(flow.pendingClassCode()).toBe('');
  // And it stays gone rather than coming back for the first account.
  expect(sessionStorage.getItem('lsdlc_class_code')).toBeNull();
});

it('clears the claim with the code, so the next invitation is anybody’s', async () => {
  const session = await import('@/lib/session');
  const flow = await import('@/lib/auth-flow');
  const person = (id: string) => ({ id, email: `${id}@lab.test`, displayName: id, role: 'LEARNER', cohort: 'default', profileVersion: 1, createdAt: '2026-09-20T00:00:00.000Z' }) as never;
  session.setAuthSession('token-one', person('one'));
  flow.rememberClassCode('CLASSONE');
  expect(flow.pendingClassCode()).toBe('CLASSONE');
  session.clearSession();
  expect(flow.pendingClassCode()).toBe('');

  flow.rememberClassCode('CLASSTWO');
  session.setAuthSession('token-two', person('two'));
  expect(flow.pendingClassCode()).toBe('CLASSTWO');
});

it('reads a waiting class code under the dotted key while a full storage refuses the move', async () => {
  sessionStorage.setItem('learnsdlc.pendingClass', 'HELD');
  const flow = await import('@/lib/auth-flow');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); });
  expect(flow.pendingClassCode()).toBe('HELD');
  expect(sessionStorage.getItem('learnsdlc.pendingClass')).toBe('HELD');
});
