import { expect, type Page } from '@playwright/test';
import { E2E_PASS } from './pw-fixtures';
import { UI_READY } from './support/timeouts';

/**
 * TaskTrackr's Design written the way a learner writes it: through the Design
 * room's forms only, tab by tab, never in a file. Shared by the specs that walk
 * the room (e2e/slices.spec.ts, e2e/screenshots.spec.ts).
 *
 * TaskTrackr 4.0.0's Design starts from a record with one entity (`Model`, its
 * `id` attribute), the three operations named and empty, and one empty
 * decision; the API contract with `completeTask` and `getOverdue` empty and no
 * error catalogue; the screen contract with an empty `#/overdue` row (the
 * third); both contracts and the sequence diagram are on, and the stories to
 * design for are US-2, US-3 and US-4.
 *
 * Playwright only: nothing under apps/ imports this file.
 */

export type DesignTab = 'model' | 'api' | 'screens' | 'sequence' | 'decisions' | 'review';

/** Open one tab of the room by its test id, and wait until it is the one pressed. */
export async function designTab(page: Page, tab: DesignTab): Promise<void> {
  const button = page.getByTestId(`design-tab-${tab}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** The three entities: Task (the starting `Model`, renamed) with `due_date` and `status`, List and TaskTag. */
export const ENTITIES: { name: string; attributes: [string, string][]; stories: string[] }[] = [
  {
    name: 'Task',
    attributes: [['list_id', 'integer'], ['title', 'string'], ['priority', 'string'], ['due_date', 'date'], ['status', 'string']],
    stories: ['US-2', 'US-3', 'US-4'],
  },
  { name: 'List', attributes: [['name', 'string']], stories: ['US-3'] },
  { name: 'TaskTag', attributes: [['task_id', 'integer'], ['tag_id', 'integer']], stories: ['US-3'] },
];

/** The two relations: a list holds its tasks, and a task carries its tags through the join table. */
export const RELATIONS: { from: string; to: string; kind: string; fromCard: string; toCard: string; label: string }[] = [
  { from: 'List', to: 'Task', kind: 'composition', fromCard: '1', toCard: '*', label: 'holds' },
  { from: 'Task', to: 'TaskTag', kind: 'association', fromCard: '1', toCard: '*', label: 'is tagged through' },
];

/** The three operations, in the starting record's order. `note` is where getOverdue's boundary clause lives (D10). */
export const OPERATIONS: { inputs: string; returns: string; errors: string; story: string; note?: string }[] = [
  { inputs: 'id', returns: 'the whole task, with status done', errors: 'task_not_found, 404, when no task has that id', story: 'US-2' },
  {
    inputs: 'listId\nstatus\nq\ntag',
    returns: 'the tasks of that list, filtered by every parameter given, high priority first',
    errors: 'list_not_found, 404, for an unknown list\ninvalid_status, 400, for a status the contract does not name',
    story: 'US-3',
  },
  {
    inputs: 'today',
    returns: 'every open task whose due date is strictly before today, most overdue first',
    errors: 'invalid_date, 400, when today is missing or is not an ISO date',
    story: 'US-4',
    note: 'tasks due strictly before today; a task due today is not overdue, and a task with no due date is never overdue',
  },
];

/** The contract rows the API contract tab fills: what each answers, its story, its success and its refusals. */
export const CONTRACT_ROWS: { id: string; summary: string; story: string; status: string; body: string; errors: string[] }[] = [
  { id: 'completeTask', summary: 'Close one task. Completing a task twice changes nothing.', story: 'US-2', status: '200', body: 'Task', errors: ['task_not_found'] },
  {
    id: 'listTasks',
    summary: 'The tasks of one list, filtered by status, tag and keyword, high priority first, then by ascending id.',
    story: 'US-3',
    status: '200',
    body: 'Task[]',
    errors: ['list_not_found', 'invalid_status'],
  },
  {
    id: 'getOverdue',
    summary: 'Every open task due strictly before today; a task due today is not overdue.',
    story: 'US-4',
    status: '200',
    body: 'Task[]',
    errors: ['invalid_date'],
  },
];

/** The shared error catalogue: every code an operation names, with its status and meaning. */
export const ERROR_CATALOGUE: Record<string, { status: number; meaning: string }> = {
  task_not_found: { status: 404, meaning: 'No task has that id.' },
  list_not_found: { status: 404, meaning: 'No list has that id.' },
  invalid_status: { status: 400, meaning: 'The status asked for is not one the contract names.' },
  invalid_date: { status: 400, meaning: 'today is missing or is not an ISO date.' },
  invalid_name: { status: 400, meaning: 'A list name is blank.' },
  duplicate_list: { status: 409, meaning: 'A list with that name already exists.' },
};

/** The `#/overdue` row of the screen contract (the third). */
export const OVERDUE_SCREEN = {
  index: 2,
  title: 'Overdue',
  component: 'OverduePage',
  reads: 'getOverdue',
  shows: 'Every open task due before today, most overdue first, each with its list.',
  components: 'OverduePage, TaskRow, OverdueBadge',
  empty: 'Nothing is overdue. Every open task is on time today.',
};

/** The request path of the overdue report, naming the learner's operation. */
export const SEQUENCE_SOURCE = [
  'Browser -> OverduePage: open #/overdue',
  'OverduePage -> Api: getOverdue(today)',
  'Api -> Database: open tasks due before today',
  'Api --> OverduePage: Task[]',
].join('\n');

/** One decision, with its rationale and the trade-off weighed. */
export const DECISION = {
  title: 'The API filters and orders',
  choice: 'the API filters and orders, the browser only renders',
  alternative: 'filtering the array in the hook',
  rationale: 'a filter has to be right about the rows that were never downloaded',
  tradeoff: 'the instant re-filter a client-side list would have had',
};

/** The UML model tab: the three entities with their story chips, the two relations and the three operations. */
export async function fillModel(page: Page): Promise<void> {
  await designTab(page, 'model');
  for (const [i, entity] of ENTITIES.entries()) {
    if (i > 0) await page.getByTestId('design-board-entity-add').click();
    await page.getByTestId(`design-board-entity-${i}-name`).fill(entity.name);
    // The starting entity keeps its `id` attribute in row 0.
    const first = i === 0 ? 1 : 0;
    for (const [j, [name, type]] of entity.attributes.entries()) {
      await page.getByTestId(`design-board-entity-${i}-attr-add`).click();
      await page.getByTestId(`design-board-entity-${i}-attr-${first + j}-name`).fill(name);
      await page.getByTestId(`design-board-entity-${i}-attr-${first + j}-type`).fill(type);
    }
    for (const story of entity.stories) {
      const chip = page.getByTestId(`design-board-entity-${i}-story-${story}`);
      if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
  }
  for (const [i, relation] of RELATIONS.entries()) {
    await page.getByTestId('design-board-relation-add').click();
    await page.getByTestId(`design-board-relation-${i}-from`).selectOption({ label: relation.from });
    await page.getByTestId(`design-board-relation-${i}-to`).selectOption({ label: relation.to });
    await page.getByTestId(`design-board-relation-${i}-kind`).selectOption(relation.kind);
    await page.getByTestId(`design-board-relation-${i}-from-card`).selectOption(relation.fromCard);
    await page.getByTestId(`design-board-relation-${i}-to-card`).selectOption(relation.toCard);
    await page.getByTestId(`design-board-relation-${i}-label`).fill(relation.label);
  }
  for (const [i, operation] of OPERATIONS.entries()) {
    await page.getByTestId(`design-operation-${i}-inputs`).fill(operation.inputs);
    await page.getByTestId(`design-operation-${i}-returns`).fill(operation.returns);
    await page.getByTestId(`design-operation-${i}-errors`).fill(operation.errors);
    if (operation.note) await page.getByTestId(`design-operation-${i}-note`).fill(operation.note);
    const chip = page.getByTestId(`design-operation-${i}-story-${operation.story}`);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  }
}

/** A JSON field of the contract workbench: typed, then left, so the draft is parsed and written. */
async function fillJson(page: Page, label: string, value: unknown): Promise<void> {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(JSON.stringify(value));
  await field.blur();
}

/** The API contract tab, through the workbench: the three rows' contract and errors sections, and the catalogue. */
export async function fillApiContract(page: Page): Promise<void> {
  await designTab(page, 'api');
  const workbench = page.getByRole('region', { name: 'API contract workbench' });
  for (const row of CONTRACT_ROWS) {
    await workbench.getByRole('navigation', { name: 'API operations' }).getByRole('button', { name: new RegExp(`${row.id}$`) }).click();
    const sections = workbench.getByLabel('Contract sections');
    await sections.getByRole('button', { name: 'Contract', exact: true }).click();
    await workbench.getByLabel('Behavior and boundaries', { exact: true }).fill(row.summary);
    await workbench.getByLabel('Stories satisfied', { exact: true }).fill(row.story);
    const status = workbench.getByLabel('Success status', { exact: true });
    await status.fill(row.status);
    await status.blur();
    await workbench.getByLabel('Success body shape', { exact: true }).fill(row.body);
    await sections.getByRole('button', { name: 'Errors', exact: true }).click();
    await fillJson(page, 'Error codes this operation can return (JSON array)', row.errors);
  }
  await fillJson(page, 'Shared error catalogue (JSON object, code → status and meaning)', ERROR_CATALOGUE);
}

/** The Screens tab: the empty `#/overdue` row, filled. */
export async function fillScreens(page: Page): Promise<void> {
  await designTab(page, 'screens');
  const id = (field: string) => `design-screen-${OVERDUE_SCREEN.index}-${field}`;
  await expect(page.getByTestId(id('route'))).toHaveValue('#/overdue');
  await page.getByTestId(id('title')).fill(OVERDUE_SCREEN.title);
  await page.getByTestId(id('component')).fill(OVERDUE_SCREEN.component);
  await page.getByTestId(id('reads')).fill(OVERDUE_SCREEN.reads);
  await page.getByTestId(id('shows')).fill(OVERDUE_SCREEN.shows);
  await page.getByTestId(id('components')).fill(OVERDUE_SCREEN.components);
  await page.getByTestId(id('empty')).fill(OVERDUE_SCREEN.empty);
}

/** The Sequence diagram tab: the request path, naming getOverdue(today). */
export async function fillSequence(page: Page): Promise<void> {
  await designTab(page, 'sequence');
  await page.getByTestId('design-sequence-source').fill(SEQUENCE_SOURCE);
}

/** The Decisions tab: the one decision, and the stub's pass mark in the notes. */
export async function fillDecision(page: Page): Promise<void> {
  await designTab(page, 'decisions');
  await page.getByTestId('design-decision-0-title').fill(DECISION.title);
  await page.getByTestId('design-decision-0-choice').fill(DECISION.choice);
  await page.getByTestId('design-decision-0-alternative').fill(DECISION.alternative);
  await page.getByTestId('design-decision-0-rationale').fill(DECISION.rationale);
  await page.getByTestId('design-decision-0-tradeoff').fill(DECISION.tradeoff);
  await page.getByTestId('design-board-notes').fill(`The API owns filtering and ordering. ${E2E_PASS}`);
}

/** "Check the design": the floor in words, every rule Passed, the sequence rule among them. */
export async function expectFloorPassed(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
  await page.getByTestId('phase-design-render').click();
  const checks = page.getByTestId('phase-design-checks');
  await expect(checks).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('phase-design-check-design.sequence')).toBeVisible();
  const rows = checks.locator('[data-testid^="phase-design-check-design."]');
  expect(await rows.count(), 'every floor rule is listed').toBeGreaterThanOrEqual(13);
  for (const row of await rows.all()) await expect(row).toContainText('Passed');
}
