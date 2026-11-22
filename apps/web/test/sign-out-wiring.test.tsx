// @vitest-environment jsdom
/**
 * The one payload sign-out reads, as the API answered it.
 *
 * `useSignOut` decides between `/login` and the managed provider's sign-out
 * on `GET /auth/providers` (the API's `sso-signout.e2e-spec.ts` proves both
 * modes on the server). The local-mode answer is recorded by
 * `apps/api/test/enrollment-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/enrollment.json`); read through the real
 * `request` with `fetch` the only seam, it is not managed, so a local sign-out
 * ends on /login and never leaves for `/auth/sso/signout`. The request goes
 * out unsigned: the session has been cleared by the time it is asked.
 *
 * The managed answer is not recorded here (the recorder runs the local mode);
 * `authProvider: 'cognito'` is the shared type's other member and is checked
 * as such, hand-built.
 *
 * **Independent of the managed sign-out.** This file reads only
 * `managedSignIn`, never `ssoSignOutUrl`/`leaveForSsoSignOut`, so removing
 * the managed provider's sign-out leaves this file compiling and passing
 * with no edit.
 */
import { repoFile } from './support/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthProviders } from '@learnsdlc/shared';

vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getToken: () => null,
}));

import { managedSignIn } from '@/lib/auth-signout';

const providers = JSON.parse(
  repoFile('apps/api/test/fixtures/contract-bodies/enrollment.json'),
).bodies.providers as AuthProviders;

const seen: { url: string; headers: Record<string, string> }[] = [];
let answer: unknown = providers;

beforeEach(() => {
  seen.length = 0;
  answer = providers;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the sign-out seam, from the API recording (WIRE)', () => {
  it('reads the recorded local-mode providers answer as not managed, asked unsigned', async () => {
    expect(providers.authProvider).toBe('local');
    expect(await managedSignIn()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/api\/v1\/auth\/providers$/);
    expect(Object.keys(seen[0].headers).map((one) => one.toLowerCase())).not.toContain('authorization');
  });

  it("reads the type's other member as managed (hand-built)", async () => {
    answer = { ...providers, authProvider: 'cognito' };
    expect(await managedSignIn()).toBe(true);
  });
});
