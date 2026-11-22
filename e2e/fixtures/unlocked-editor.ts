import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CONFIGURED_ADMIN } from '../passing-work';
import { dismissPhaseTutorial, signInAs } from '../pw-fixtures';
import { API } from '../support/env';
import { UI_READY } from '../support/timeouts';

export const fixtureApi = API;
export type EditorFixture = { email: string; password: string; userId: string; token: string; phaseId: string; phases: Array<{ id: string; key: string; order: number; title: string }> };

/** Test administrator only; credentials never enter diagnostics or screenshots. */
export async function fixtureAdminHeaders(request: APIRequestContext): Promise<{ authorization: string }> {
  const response = await request.post(`${fixtureApi}/auth/login`, { data: CONFIGURED_ADMIN });
  expect(response.ok(), 'Isolated editor setup requires the configured test administrator').toBe(true);
  return { authorization: `Bearer ${(await response.json()).token}` };
}

/**
 * Opens only a fresh fixture's Implementation phase for generic editor tests.
 * This is explicit test setup, not a learned Pass or normal gate advancement.
 * Never accepts an existing learner ID or touches the real course-run fixture.
 */
export async function createUnlockedEditor(request: APIRequestContext, namespace: string): Promise<EditorFixture> {
  // A local part over 64 characters is not an address (class-validator IsEmail), so the id is cut to 12.
  const email = `e2e-editor-${namespace}-${randomUUID().replace(/-/g, '').slice(0, 12)}@example.test`;
  const password = `Editor-${randomUUID()}!`;
  const response = await request.post(`${fixtureApi}/auth/register`, { data: { email, password, displayName: 'Isolated Editor Learner' } });
  expect(response.ok(), 'Isolated editor learner registers').toBe(true);
  const auth = await response.json();
  const headers = { authorization: `Bearer ${auth.token}` };
  const profile = await request.patch(`${fixtureApi}/account/profile`, { headers, data: { displayName: 'Isolated Editor Learner', onboardingCompleted: true } });
  expect(profile.ok()).toBe(true);
  const enrolled = await request.post(`${fixtureApi}/enrollments`, { headers, data: { projectSlug: 'tasktrackr' } });
  expect(enrolled.ok()).toBe(true);
  const enrollment = await enrolled.json();
  const phase = enrollment.phases.find((item: { key: string }) => item.key === 'implementation');
  expect(phase?.id).toBeTruthy();
  const opened = await request.post(`${fixtureApi}/instructor/learners/${auth.user.id}/phases/${phase.id}/override`, { headers: await fixtureAdminHeaders(request), data: { action: 'reopen', reason: `Isolated ${namespace} editor test setup; no grading or phase Pass is being asserted.` } });
  expect(opened.ok(), 'Administrator opens only the isolated Implementation editor fixture').toBe(true);
  return { email, password, userId: auth.user.id, token: auth.token, phaseId: phase.id, phases: enrollment.phases };
}

export async function signInEditorFixture(page: Page, fixture: EditorFixture): Promise<void> {
  // The per-phase tutorial is not what an editor test measures.
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, fixture.email, fixture.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}
