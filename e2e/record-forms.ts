// The two records filled the way a learner fills them: through the Runbook tab's forms and the change
// room's tabs, never through a file. Each helper waits for the room's own save line after the last field.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ChangeRequest, Runbook } from '@learnsdlc/shared';
import { type ApiLearner } from './passing-work';
import { PASSING_INCIDENT } from './record-fixtures.mjs';
import { API } from './support/env';
import { UI_READY } from './support/timeouts';

/** The drill's write-up the suite closes the incident with, shared with scripts/passing-work.mjs. */
export { PASSING_INCIDENT };

/**
 * The item fields of each runbook list other than `id` and `kind`, which the Runbook tab draws as
 * `runbook-${list}-${at}-${key}` (RunbookTab.tsx's FIELDS; the rollback's `verify` is labelled "How to verify").
 */
const LIST_FIELDS = {
  environment: ['name', 'purpose', 'example'],
  health: ['name', 'how', 'expected'],
  rollback: ['step', 'verify'],
  data: ['what', 'how', 'where', 'retention'],
} as const;

/**
 * Fill the IDE's Runbook tab with `runbook`, row by row: a row the record has and the tab does not is
 * added with the list's Add, and a field the record leaves out is left as it is. The tab lives in the
 * Pipeline view's tools; from the Configuration view the learner presses Pipeline first, and so does this.
 */
export async function fillRunbookForms(page: Page, runbook: Pick<Runbook, 'environment' | 'health' | 'rollback' | 'data'> & { notes?: string }) {
  const tab = page.getByTestId('phase-deployment-tab-runbook');
  if (!(await tab.isVisible())) {
    await page.locator('nav[aria-label="Phase working area"]').getByRole('button', { name: 'Pipeline', exact: true }).click();
  }
  await tab.click();
  await expect(page.getByTestId('runbook-tab')).toBeVisible({ timeout: UI_READY });
  for (const list of ['environment', 'health', 'rollback', 'data'] as const) {
    for (const [at, item] of (runbook[list] as unknown as Record<string, string>[]).entries()) {
      if (!(await page.getByTestId(`runbook-${list}-${at}`).count())) await page.getByTestId(`runbook-add-${list}`).click();
      for (const key of LIST_FIELDS[list]) {
        if (item[key] !== undefined) await page.getByTestId(`runbook-${list}-${at}-${key}`).fill(item[key]);
      }
      if (list === 'environment' && item.kind) await page.getByTestId(`runbook-${list}-${at}-kind`).selectOption(item.kind);
    }
  }
  if (runbook.notes) await page.getByTestId('runbook-notes').fill(runbook.notes);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
}

/**
 * Fill the change room's four tabs with `change`: the impact on Request, the amendments on Contract, the
 * tests on Checks, and the release and notes on Release. The lists are added to from empty, as the
 * starting record holds them; an impact entry already there (the assistant's) stays beside the record's.
 */
export async function fillChangeForms(page: Page, change: ChangeRequest) {
  const tab = (name: 'Request' | 'Contract' | 'Checks' | 'Release') =>
    page.locator('nav[aria-label="Change request sections"]').getByRole('button', { name, exact: true }).first();
  await tab('Request').click();
  for (const list of ['operations', 'screens', 'files'] as const) {
    for (const entry of change.impact[list]) {
      await page.getByTestId(`change-impact-${list}-input`).fill(entry);
      await page.getByTestId(`change-impact-${list}-add`).click();
      await expect(page.getByTestId(`change-impact-${list}`)).toContainText(entry);
    }
  }
  if (change.contract.length) {
    await tab('Contract').click();
    for (const [at, amendment] of change.contract.entries()) {
      await page.getByTestId('change-amendment-add').click();
      // Method is a text input with no test id (ChangeForms.tsx), found by its label's id
      await page.locator(`#change-amendment-${at}-method`).fill(amendment.method);
      await page.getByTestId(`change-amendment-${at}-path`).fill(amendment.path);
      await page.locator(`#change-amendment-${at}-change`).selectOption(amendment.change);
      await page.locator(`#change-amendment-${at}-why`).fill(amendment.why);
    }
  }
  await tab('Checks').click();
  for (const [at, one] of change.tests.entries()) {
    await page.getByTestId('change-test-add').click();
    await page.getByTestId(`change-test-${at}-suite`).fill(one.suite);
    for (const id of one.covers) await page.getByTestId(`change-test-${at}-covers`).getByLabel(`Covers ${id}`, { exact: true }).check();
    await page.locator(`#change-test-${at}-result`).selectOption(one.result);
  }
  await tab('Release').click();
  await page.getByTestId('change-release-version').fill(change.release.version);
  await page.getByTestId('change-release-summary').fill(change.release.summary);
  for (const [at, line] of change.release.changes.entries()) {
    await page.getByTestId('change-line-add').click();
    await page.getByTestId(`change-line-${at}-line`).fill(line.line);
    for (const id of line.covers) await page.getByTestId(`change-line-${at}-covers`).getByLabel(`Covers ${id}`, { exact: true }).check();
  }
  await page.getByTestId('change-release-rollback').fill(change.release.rollback);
  if (change.notes) await page.getByTestId('change-notes').fill(change.notes);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
}

/**
 * Page, check and close the drill through the API, as scripts/passing-work.mjs's closeDrill does: the
 * resolve takes the write-up as `{ incident }` (DrillResolveDto). For a walk about the room, not the drill.
 */
export async function closeDrillByApi(request: APIRequestContext, learner: Pick<ApiLearner, 'headers'>, phaseId: string) {
  for (const [step, data] of [['start', {}], ['health', {}], ['resolve', { incident: PASSING_INCIDENT }]] as const) {
    const res = await request.post(`${API}/phases/${phaseId}/drill/${step}`, { headers: learner.headers, data });
    expect(res.ok(), `drill ${step}: ${await res.text()}`).toBeTruthy();
  }
}
