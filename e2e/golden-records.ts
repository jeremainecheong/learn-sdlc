/**
 * The golden records: a learner's complete Requirements, Design and
 * Maintenance work, as the rooms save it. They are submitted normally and do
 * not seed or force a verdict.
 * Each structured record is written with the same pure serialiser the real
 * authoring UI uses; the Requirements story is its record and nothing else,
 * and the Design is its record and the two contracts, with no markdown.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGE_REQUEST_RECORD, MY_API_CONTRACT, MY_SCREEN_CONTRACT, MAINTENANCE_ARTEFACT as MAINTENANCE_CODE } from './fixtures';
import { STORY_JSON, serialiseStory, type Story } from '../apps/web/components/workspace/panels/requirements/story';
import { serialiseDesign, type Design } from '@learnsdlc/shared';

export const REQUIREMENTS_STORY: Story = {
  id: 'US-4',
  title: 'Read overdue work before planning the day',
  persona: 'busy learner juggling study and work',
  capability: 'to open a dedicated overdue report page covering tasks across all my lists',
  benefit: 'I can identify work I have already missed before I plan the day',
  epics: [{ id: 'EP-1', title: 'Plan outstanding work across lists', outcome: 'Learners can identify and prioritize unfinished overdue tasks before choosing their next work.' }],
  parentEpicId: 'EP-1',
  criteria: [
    { id: 'AC-1', tag: 'happy', given: 'today is 2026-09-10 and an open task titled Write report in list 7 is due on 2026-09-08', when: 'I open the dedicated overdue report page', then: 'Write report appears with its title, 2 whole days overdue, and its source list 7, without requiring me to open another page to identify the list' },
    { id: 'AC-2', tag: 'boundary', given: 'today is 2026-09-10 and an open task is due on 2026-09-10', when: 'I open the overdue report', then: 'that task is absent because due today is not overdue; it becomes eligible on 2026-09-11 if still open' },
    { id: 'AC-3', tag: 'boundary', given: 'today is 2026-09-10 and a task due on 2026-09-01 was completed on 2026-09-09', when: 'I open the overdue report', then: 'the completed task is absent even though it was finished after its due date' },
    { id: 'AC-4', tag: 'boundary', given: 'an open task has no due date', when: 'I open the overdue report for any day', then: 'that task is absent because an undated task is never overdue' },
    { id: 'AC-5', tag: 'happy', given: 'today is 2026-09-10 and overdue open tasks are A due September 6 with low priority, B due September 8 with high priority, C due September 8 with low priority, and D due September 8 with high priority where B has a smaller id than D', when: 'I open the report', then: 'the order is A, B, D, C: earliest due date first, then high before medium before low for equal due dates, then ascending id for an equal date and priority' },
    { id: 'AC-6', tag: 'boundary', given: 'there are no open tasks with a non-null due date strictly before today', when: 'the report finishes loading successfully', then: 'it displays the sentence Nothing is overdue. You are all caught up. instead of an unexplained empty list' },
    { id: 'AC-7', tag: 'happy', given: 'overdue open tasks exist in two different lists', when: 'I open the dedicated report page rather than a filter on one list', then: 'eligible tasks from both lists are shown, and each row identifies its title, whole days overdue, and the list it came from' },
  ],
  scopeExclusions: ['reminders', 'emails', 'notifications', 'accounts or cross-device synchronization in this release'],
  notes: 'No open requirement questions remain. The report is read when the learner opens its own page; phase 2 decides the endpoint and component structure.',
};
/** Phase 1's story as the learner's room writes it: the record alone. */
export const REQUIREMENTS_ARTEFACT: Record<string, string> = {
  [STORY_JSON]: serialiseStory(REQUIREMENTS_STORY),
};

/** The TaskTrackr worked design, as the Design room saves it: the record in the schema, every entity a class. */
// Modelled by hand from the board's older fields (Task, List, Tag and TaskTag),
// not folded: the schema has no required flag, so none is written. A fold of
// the older fields would keep each one as "required, " in front of its note.
export const DESIGN_RECORD: Design = {
  entities: [
    {
      id: 'E1', name: 'Task', kind: 'class',
      attributes: [
        { name: 'id', type: 'integer', note: 'Primary key assigned by SQLite. Stable tie-breaker when priority and due date are equal.' },
        { name: 'list_id', type: 'integer', note: 'Foreign key to lists.id. Each task belongs to exactly one list. The overdue row identifies this source list.' },
        { name: 'title', type: 'string', note: 'Non-empty task title. The q filter matches a case-insensitive substring of this field.' },
        { name: 'priority', type: 'string', note: 'Only low, medium and high. Default medium. Sort high before medium before low.' },
        { name: 'due_date', type: 'date', note: 'Nullable ISO YYYY-MM-DD calendar date. Null is never overdue; a non-null date is overdue only when strictly before the supplied today.' },
        { name: 'status', type: 'string', note: 'Persisted values open or done; default open. The all query value means no status restriction and is not stored on a task.' },
        { name: 'created_at', type: 'timestamp', note: 'UTC creation time assigned when the task is stored.' },
        { name: 'completed_at', type: 'timestamp', note: 'Null while open. Completing a task persists its UTC completion time. Repeating completion does not replace the original time.' },
      ],
      responsibilities: [],
      satisfies: ['US-1', 'US-2', 'US-3', 'US-4', 'US-5'],
    },
    {
      id: 'E2', name: 'List', kind: 'class',
      attributes: [
        { name: 'id', type: 'integer', note: 'Primary key. tasks.list_id references lists.id; deleting a list cascades to its tasks.' },
        { name: 'name', type: 'string', note: 'Unique and non-empty.' },
        { name: 'created_at', type: 'timestamp', note: 'Creation time of the list.' },
      ],
      responsibilities: [],
      satisfies: ['US-1', 'US-4'],
    },
    {
      id: 'E3', name: 'Tag', kind: 'class',
      attributes: [
        { name: 'id', type: 'integer', note: 'Primary key.' },
        { name: 'name', type: 'string', note: 'Unique tag name. A task can have zero or more tags and one tag can belong to many tasks. Tags are not stored as a delimited task column.' },
      ],
      responsibilities: [],
      satisfies: ['US-3'],
    },
    {
      id: 'E4', name: 'TaskTag', kind: 'class',
      attributes: [
        { name: 'task_id', type: 'integer', note: 'References tasks.id; task deletion removes its join rows.' },
        { name: 'tag_id', type: 'integer', note: 'References tags.id. The pair is unique, preventing duplicate attachment. The HTTP Task DTO includes sorted tag names.' },
      ],
      responsibilities: [],
      satisfies: ['US-3'],
    },
  ],
  relations: [
    { id: 'R1', from: 'E2', to: 'E1', kind: 'composition', fromCard: '1', toCard: '*', label: 'holds' },
    { id: 'R2', from: 'E1', to: 'E4', kind: 'association', fromCard: '1', toCard: '*', label: 'is tagged through' },
    { id: 'R3', from: 'E3', to: 'E4', kind: 'association', fromCard: '1', toCard: '*', label: 'tags through' },
  ],
  operations: [
    { id: 'O1', name: 'completeTask(id)', inputs: ['POST /api/tasks/{id}/complete with an integer task id in the path and no request body.'], returns: '200 with the complete Task DTO after persisting status done and completed_at. Repeating the request for an already done task returns the same task without changing its existing completion time.', errors: ['404 task_not_found when no task has the supplied id; the error response is {"error":{"code":"task_not_found","message":"No task has that id."}} and no task is changed.'], satisfies: ['US-2'], note: 'example: Completing an existing open task makes the next read report done; completing unknown id 999999 returns 404.' },
    { id: 'O2', name: 'listTasks(listId, filters)', inputs: ['GET /api/lists/{id}/tasks. status is optional and defaults to all; accepted values are all, open and done. q is an optional case-insensitive substring of the title; missing or empty q adds no keyword filter. tag is an optional exact tag name; a missing tag adds no tag filter. All supplied filters are combined with AND. The client preserves q when changing status or tag.'], returns: '200 with Task[] belonging only to the named list and satisfying every supplied filter. A valid list with no matching tasks returns an empty array.', errors: ['404 list_not_found for an unknown list; 400 invalid_status if status is outside all, open and done. Each is returned in the shared {error:{code,message}} envelope.'], satisfies: ['US-3'], note: 'ordering: High priority before medium before low, then ascending integer task id for equal priority. The API orders the full result before the browser renders it.; example: With titles Pay rent and Review notes, q=RENT returns only Pay rent; adding status=open retains q=RENT in the request.' },
    { id: 'O3', name: 'getOverdue(today)', inputs: ['GET /api/tasks/overdue?today=YYYY-MM-DD. today is a required valid ISO calendar date chosen by the caller so tests and later replays use the same boundary.'], returns: '200 with Task[] across all lists where status is open, due_date is not null and due_date is strictly before today. Order earliest due_date first, then high, medium, low priority, then ascending id. Each Task carries title, due_date and list_id; the report computes whole days overdue from that same today and displays the source list id.', errors: ['400 invalid_date when today is missing or is not a valid ISO YYYY-MM-DD calendar date, using the shared {error:{code,message}} envelope.'], satisfies: ['US-4'], note: 'boundary: Due today is excluded, as are future dates, null dates and every completed task even if completed late. No eligible tasks produces [] and the report renders Nothing is overdue. You are all caught up.; example: For today 2026-09-10, an open task due 2026-09-08 is 2 whole days overdue; a task due 2026-09-10 is absent.' },
  ],
  decisions: [
    { id: 'D1', title: 'Filter and order on the API; render the returned order in the browser', choice: 'Filter and order on the API; render the returned order in the browser', alternative: 'downloading every task and filtering independently in the React hook', rationale: 'the API can apply every filter to the complete set and one documented order prevents the list and overdue report from contradicting each other', tradeOff: 'instant local refiltering without a request; the client must retain filters and handle loading or network failure', context: 'US-3 combines status, tag and keyword and US-4 spans all lists. The supplied architecture already separates routes, repositories, and React rendering.', consequences: ['All filters compose with AND in the repository query.', 'The client keeps q when status or tag changes.', 'Responses expose deterministic ordering that can be asserted in tests.'], status: 'accepted', satisfies: ['US-3', 'US-4'], decidedAt: '2026-09-10T00:00:00Z' },
    { id: 'D2', title: 'Require today explicitly for the overdue endpoint', choice: 'Require today explicitly for the overdue endpoint', alternative: 'reading the server clock inside the repository', rationale: 'a caller and its tests can reproduce exactly the same due-date boundary and days-overdue display', tradeOff: 'one validated calendar-date parameter that every caller must supply', context: 'US-4/AC-2 excludes tasks due today; the user-visible report and API must use the same day.', consequences: ['Invalid or absent today is a 400 invalid_date.', 'The report uses the same today when requesting tasks and computing whole days late.'], status: 'accepted', satisfies: ['US-4', 'US-5'], decidedAt: '2026-09-10T00:00:00Z' },
  ],
  // the second line names getOverdue: TaskTrackr 4.0.0 switches the sequence rule on, and it asks for an operation by its name
  sequence: 'Browser -> OverduePage: open dedicated report\nOverduePage -> ApiRoute: getOverdue(today) as GET /api/tasks/overdue\nApiRoute -> Repository: validated today\nRepository -> SQLite: open tasks with due_date before today\nSQLite --> Repository: rows in due-date priority id order\nRepository --> ApiRoute: Task DTO array\nApiRoute --> OverduePage: 200 JSON\nOverduePage --> Browser: title days late source list or explicit empty message',
  notes: 'No open design questions remain.',
};

/**
 * The three operations of the Maintenance phase's seeded
 * `design/contracts.json`, frozen in that file's own form (name, inputs,
 * returns, errors): the file is outside the Design sub-project and keeps its
 * bytes.
 */
const SEEDED_DESIGN_OPERATIONS = [
  { name: 'completeTask(id)', satisfies: 'US-2', inputs: 'POST /api/tasks/{id}/complete with an integer task id in the path and no request body.', returns: '200 with the complete Task DTO after persisting status done and completed_at. Repeating the request for an already done task returns the same task without changing its existing completion time.', errors: '404 task_not_found when no task has the supplied id; the error response is {"error":{"code":"task_not_found","message":"No task has that id."}} and no task is changed.', example: 'Completing an existing open task makes the next read report done; completing unknown id 999999 returns 404.' },
  { name: 'listTasks(listId, filters)', satisfies: 'US-3', inputs: 'GET /api/lists/{id}/tasks. status is optional and defaults to all; accepted values are all, open and done. q is an optional case-insensitive substring of the title; missing or empty q adds no keyword filter. tag is an optional exact tag name; a missing tag adds no tag filter. All supplied filters are combined with AND. The client preserves q when changing status or tag.', returns: '200 with Task[] belonging only to the named list and satisfying every supplied filter. A valid list with no matching tasks returns an empty array.', ordering: 'High priority before medium before low, then ascending integer task id for equal priority. The API orders the full result before the browser renders it.', errors: '404 list_not_found for an unknown list; 400 invalid_status if status is outside all, open and done. Each is returned in the shared {error:{code,message}} envelope.', example: 'With titles Pay rent and Review notes, q=RENT returns only Pay rent; adding status=open retains q=RENT in the request.' },
  { name: 'getOverdue(today)', satisfies: 'US-4', inputs: 'GET /api/tasks/overdue?today=YYYY-MM-DD. today is a required valid ISO calendar date chosen by the caller so tests and later replays use the same boundary.', returns: '200 with Task[] across all lists where status is open, due_date is not null and due_date is strictly before today. Order earliest due_date first, then high, medium, low priority, then ascending id. Each Task carries title, due_date and list_id; the report computes whole days overdue from that same today and displays the source list id.', boundary: 'Due today is excluded, as are future dates, null dates and every completed task even if completed late. No eligible tasks produces [] and the report renders Nothing is overdue. You are all caught up.', errors: '400 invalid_date when today is missing or is not a valid ISO YYYY-MM-DD calendar date, using the shared {error:{code,message}} envelope.', example: 'For today 2026-09-10, an open task due 2026-09-08 is 2 whole days overdue; a task due 2026-09-10 is absent.' },
];

const httpContract = JSON.parse(MY_API_CONTRACT);
httpContract.entities.task_tags.primaryKey = ['task_id', 'tag_id'];
httpContract.entities.task_tags.fields.forEach((field: Record<string, unknown>) => { field.onDelete = 'CASCADE'; });
httpContract.dtos = { Task: { from: 'tasks', adds: [{ name: 'tags', type: 'string[]', description: 'Sorted tag names joined through task_tags.' }] }, TaskList: { from: 'lists', adds: [{ name: 'task_count', type: 'integer' }, { name: 'open_count', type: 'integer' }] } };
httpContract.errorEnvelope = { error: { code: 'string', message: 'string' } };
httpContract.operations.find((operation: { id: string }) => operation.id === 'listTasks').query = [
  { name: 'status', type: 'string', enum: ['all', 'open', 'done'], default: 'all', description: 'all adds no status restriction; otherwise require the stored status. Compose with q and tag using AND.' },
  { name: 'q', type: 'string', description: 'Case-insensitive substring match on title. Missing or empty adds no keyword restriction; retain this query when another filter changes.' },
  { name: 'tag', type: 'string', description: 'Exact tag name through task_tags and tags. Missing adds no tag restriction; combine with other filters using AND.' },
];
httpContract.operations.find((operation: { id: string }) => operation.id === 'getOverdue').summary = 'Open tasks across all lists with a non-null due_date strictly before the required today. Exclude completed, undated, due-today and future tasks. Sort due_date ascending, priority high-medium-low, then id ascending. Return [] when none match. The browser computes whole days late using due_date and the same today and displays list_id.';
httpContract.operations.push({ id: 'createTask', method: 'POST', path: '/api/lists/{id}/tasks', summary: 'Add a task to an existing list with a non-empty title, default priority medium, status open and no completed_at. Store optional ISO due_date and tag names.', satisfies: 'US-1', body: { title: 'string', priority: 'low|medium|high (optional; defaults medium)', due_date: 'ISO date or null (optional)', tags: 'string[] (optional)' }, success: { status: 201, body: 'Task' }, errors: ['invalid_title', 'invalid_priority', 'invalid_due_date', 'invalid_tags', 'list_not_found'] });
Object.assign(httpContract.errors, { invalid_title: { status: 400, meaning: 'A task title must be non-empty.' }, invalid_priority: { status: 400, meaning: 'priority must be low, medium or high.' }, invalid_due_date: { status: 400, meaning: 'due_date must be a valid ISO date or null.' }, invalid_tags: { status: 400, meaning: 'tags must be an array of strings.' }, invalid_date: { status: 400, meaning: 'today is required and must be a valid ISO YYYY-MM-DD calendar date.' } });
const screens = JSON.parse(MY_SCREEN_CONTRACT);
const overdue = screens.screens.find((screen: { route: string }) => screen.route === '#/overdue');
overdue.shows = 'A dedicated report across all lists. Show each returned Task title, whole days overdue computed from due_date and the same today sent to getOverdue, and its source list id without a separate navigation. Keep API ordering: most overdue first, then higher priority, then ascending task id.';
overdue.satisfies = ['US-4'];
overdue.empty = 'Nothing is overdue. You are all caught up.';
export const DESIGN_ARTEFACT: Record<string, string> = {
  'design/design.json': serialiseDesign(DESIGN_RECORD),
  'shared/contract/api.json': JSON.stringify(httpContract, null, 2) + '\n',
  'shared/contract/screens.json': JSON.stringify(screens, null, 2) + '\n',
};

// CR-2 is a published change: passing implementation tests alone is insufficient.
// The contracts carry the two new operations, and the change request record
// (CHANGE_REQUEST_RECORD) carries the impact, amendments, tests and release.
const maintenanceFile = (name: string) => readFileSync(join(__dirname, '../content/tasktrackr/phases/06-maintenance/files', name), 'utf8');
const maintenanceContract = JSON.parse(maintenanceFile('shared/contract/api.json'));
delete maintenanceContract.$todo;
maintenanceContract.version = '2.1.0';
maintenanceContract.operations.push(
  { id: 'listComments', method: 'GET', path: '/api/tasks/{id}/comments', satisfies: 'CR-2', summary: 'Read comments for one existing task, ordered by created_at descending then id descending. An existing task without comments returns [].', pathParameters: { id: 'integer task id' }, success: { status: 200, body: 'Comment[]' }, errors: ['task_not_found'] },
  { id: 'addComment', method: 'POST', path: '/api/tasks/{id}/comments', satisfies: 'CR-2', summary: 'Store a comment after trimming author and body; both must remain non-empty. Task existence is checked first. The task comment_count increases without duplicating task rows.', pathParameters: { id: 'integer task id' }, body: { author: 'non-empty string', body: 'non-empty string' }, success: { status: 201, body: 'Comment' }, errors: ['invalid_comment', 'task_not_found'] },
);
maintenanceContract.errors.invalid_comment = { status: 400, meaning: 'A comment needs a non-empty author and body after whitespace trimming.' };
export const MAINTENANCE_ARTEFACT: Record<string, string> = {
  ...MAINTENANCE_CODE,
  'shared/contract/api.json': JSON.stringify(maintenanceContract, null, 2) + '\n',
  'design/contracts.json': JSON.stringify({ operations: [
    ...SEEDED_DESIGN_OPERATIONS,
    { name: 'listComments(taskId)', satisfies: 'CR-2', inputs: 'GET /api/tasks/{id}/comments with integer task id; no request body.', returns: '200 Comment[] with id, task_id, author, body, created_at, ordered created_at descending then id descending. Existing task with no comments returns [].', errors: '404 task_not_found for an unknown task in the shared {error:{code,message}} envelope.' },
    { name: 'addComment(taskId, author, body)', satisfies: 'CR-2', inputs: 'POST /api/tasks/{id}/comments with integer task id and JSON author/body strings. Trim both and require non-empty values; check task existence first.', returns: '201 persisted Comment with id, task_id, trimmed author/body and created_at. Later reads include the comment, and every Task DTO exposes the updated comment_count without changing task query cardinality.', errors: '404 task_not_found for unknown task; 400 invalid_comment for missing, empty or whitespace-only author/body on an existing task. Shared {error:{code,message}} envelope.' },
  ] }, null, 2) + '\n',
  'maintenance/change-request.json': CHANGE_REQUEST_RECORD,
};
