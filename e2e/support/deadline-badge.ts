import { readFileSync } from 'fs';
import * as path from 'path';
import { expect, type Page } from '@playwright/test';
import { zipDirectory } from '../../apps/api/test/fixtures/upload-packs/archive';
import { REPO_ROOT } from './paths';
import { NAVIGATION, UI_READY } from './timeouts';

/**
 * The Deadline badge pack and what its page preview draws, for the two specs
 * that upload it (page-preview-deadline-badge.spec.ts, page-preview-tab.spec.ts).
 *
 * The pack is the tracked upload fixture apps/api/test/fixtures/upload-packs/deadline-badge,
 * zipped in memory. The learner's finished helper for each room is the
 * `learner` half of apps/web/test/fixtures/deadline-badge-web.json, which the
 * web unit test of the same page reads. E2E_DEADLINE_PACK_ZIP names another
 * archive of the pack and E2E_DEADLINE_PACK_DIR a folder holding its
 * `reference-work/`.
 */

const PACK_DIR = path.join(REPO_ROOT, 'apps/api/test/fixtures/upload-packs/deadline-badge');
const LEARNER_WORK = path.join(REPO_ROOT, 'apps/web/test/fixtures/deadline-badge-web.json');
const PACK_ZIP_OVERRIDE = process.env.E2E_DEADLINE_PACK_ZIP;
const PACK_DIR_OVERRIDE = process.env.E2E_DEADLINE_PACK_DIR;

/** The pack as the archive a teacher uploads. */
export function deadlineBadgeArchive(): Buffer {
  return PACK_ZIP_OVERRIDE ? readFileSync(PACK_ZIP_OVERRIDE) : zipDirectory(PACK_DIR);
}

/** The room's file the learner's rule goes into. */
export const OVERDUE_HELPER = 'web/src/lib/overdue.ts';

/** The learner's finished `overdue.ts` for Implementation (the rule) or Maintenance (the rule with its guard). */
export function learnerOverdueHelper(room: 'implementation' | 'maintenance'): string {
  if (PACK_DIR_OVERRIDE) return readFileSync(path.join(PACK_DIR_OVERRIDE, 'reference-work', `${room}-overdue.ts`), 'utf8');
  const work = JSON.parse(readFileSync(LEARNER_WORK, 'utf8')) as { learner: Record<string, Record<string, string>> };
  const phase = room === 'implementation' ? '03-implementation' : '06-maintenance';
  return work.learner[phase][OVERDUE_HELPER];
}

/** The line over every page preview of this pack: it ships sample data, and the learner's API does not run. */
export const PAGE_PREVIEW_LABEL = 'Page preview: your code running in the browser with sample data. Your API is not running here.';

/** The sandboxed frame the learner's page runs in, inline or in its own tab. */
export const PAGE_FRAME = '[data-testid="page-preview-frame"]';

/** Checks which of the pack's three sample tasks show the Overdue badge, read inside the frame. */
export async function expectBadges(page: Page, titles: string[]): Promise<void> {
  const app = page.frameLocator(PAGE_FRAME);
  await expect(app.getByTestId('preview-task-row')).toHaveCount(3, { timeout: UI_READY });
  await expect(app.getByTestId('preview-overdue-badge')).toHaveCount(titles.length, { timeout: 15_000 });
  for (const title of ['Yesterday', 'Today', 'No due date']) {
    await expect(app.locator(`[data-testid="preview-task-row"][data-title="${title}"] [data-testid="preview-overdue-badge"]`)).toHaveCount(
      titles.includes(title) ? 1 : 0,
    );
  }
}

/** The Done box of one sample task, inside the frame. */
export const doneBox = (page: Page, title: string) =>
  page.frameLocator(PAGE_FRAME).locator(`[data-testid="preview-task-row"][data-title="${title}"] [data-testid="preview-done"]`);

/** The workspace's inline page preview has drawn the pack's page, isolated and without errors. */
export async function expectPagePreview(page: Page): Promise<void> {
  await expect(page.getByTestId('client-page-preview')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('page-preview-label')).toContainText(PAGE_PREVIEW_LABEL);
  await expect(page.getByTestId('page-preview-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.getByTestId('page-preview-frame')).toHaveAttribute('title', 'Your page, running in the browser');
  await expect(page.frameLocator(PAGE_FRAME).getByTestId('preview-demo-date')).toHaveText(
    'Demo date: 13 November 2026 (fixed, the same day the tests use)',
    { timeout: UI_READY },
  );
  await expect(page.getByTestId('page-preview-errors')).toHaveCount(0);
  await expect(page.getByTestId('page-preview-timeout')).toHaveCount(0);
  // An uploaded project has no sandbox App preview.
  await expect(page.getByTestId('preview-pane')).toHaveCount(0);
}
