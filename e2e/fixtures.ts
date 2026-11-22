import * as fs from 'fs';
import * as path from 'path';
import { CHANGE_REQUEST_RECORD, RUNBOOK_RECORD } from './record-fixtures.mjs';

/**
 * Learner artefacts that satisfy every phase's rubric: the "golden path".
 *
 * Anything the pack itself ships a worked copy of is read off disk so it cannot
 * drift from what the graders run: phase 3's and phase 6's solutions, phase 4's
 * reference suites, and the canonical `api/Dockerfile` and `docker-compose.yml`.
 * Only the four artefacts the pack has no answer for are written out here.
 *
 * `scripts/golden-artefacts.mjs` is the same set for the journey and the
 * seeder. It is a separate copy on purpose: a Playwright spec must not reach
 * into `scripts/`. The Deployment and Maintenance records are the exception:
 * one module, `e2e/record-fixtures.mjs`, holds them for both sides.
 */

const packFile = (...rel: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', 'content', 'tasktrackr', ...rel), 'utf-8');
const phaseFile = (phase: string, ...rel: string[]) => packFile('phases', phase, ...rel);

/* --------------------------- phase 1, requirements ------------------------ */
// Phase 1 is the story record, `requirements/story.json`, and nothing else:
// e2e/golden-records.ts REQUIREMENTS_ARTEFACT, and e2e/passing-work.ts
// PASSING_REQUIREMENTS for the same record carrying the stub's pass mark.

/* ------------------------------ phase 2, design --------------------------- */
// Phase 2 is the design record and the two contracts, written in the Design
// room's forms: e2e/golden-records.ts DESIGN_RECORD and DESIGN_ARTEFACT,
// e2e/passing-work.ts PASSING_DESIGN, and e2e/design-forms.ts for the forms.

export const MY_API_CONTRACT = `{
  "$comment": "The HTTP contract.",
  "version": "2.0.0",
  "base": "/api",

  "entities": {
    "lists": {
      "table": "lists",
      "description": "A named list. Deleting one takes its tasks with it.",
      "fields": [
        { "name": "id", "type": "integer", "required": true, "primaryKey": true },
        { "name": "name", "type": "string", "required": true, "unique": true },
        { "name": "created_at", "type": "timestamp", "required": true }
      ]
    },
    "tasks": {
      "table": "tasks",
      "description": "One thing to do, in exactly one list.",
      "fields": [
        { "name": "id", "type": "integer", "required": true, "primaryKey": true },
        { "name": "list_id", "type": "integer", "required": true, "references": "lists.id" },
        { "name": "title", "type": "string", "required": true },
        { "name": "priority", "type": "string", "required": true, "default": "medium", "enum": ["low", "medium", "high"] },
        { "name": "due_date", "type": "date", "required": false, "description": "ISO date, or null. A task with no due date is never overdue." },
        { "name": "status", "type": "string", "required": true, "default": "open", "enum": ["open", "done"] },
        { "name": "created_at", "type": "timestamp", "required": true },
        { "name": "completed_at", "type": "timestamp", "required": false }
      ]
    },
    "tags": {
      "table": "tags",
      "description": "A label, named once and attached to many tasks.",
      "fields": [
        { "name": "id", "type": "integer", "required": true, "primaryKey": true },
        { "name": "name", "type": "string", "required": true, "unique": true }
      ]
    },
    "task_tags": {
      "table": "task_tags",
      "description": "Which tags are on which task. The join with no identity of its own.",
      "fields": [
        { "name": "task_id", "type": "integer", "required": true, "references": "tasks.id" },
        { "name": "tag_id", "type": "integer", "required": true, "references": "tags.id" }
      ]
    }
  },

  "operations": [
    {
      "id": "listLists",
      "method": "GET",
      "path": "/api/lists",
      "summary": "Every list, oldest first, each with how many of its tasks are still open.",
      "satisfies": "US-1",
      "success": { "status": 200, "body": "TaskList[]" },
      "errors": []
    },
    {
      "id": "createList",
      "method": "POST",
      "path": "/api/lists",
      "summary": "Make a list. A name that is already taken is refused rather than merged.",
      "satisfies": "US-1",
      "body": { "name": "string" },
      "success": { "status": 201, "body": "TaskList" },
      "errors": ["invalid_name", "duplicate_list"]
    },
    {
      "id": "listTasks",
      "method": "GET",
      "path": "/api/lists/{id}/tasks",
      "summary": "The tasks in one list, filtered and ordered by the API. Highest priority first, ties by ascending id.",
      "satisfies": "US-3",
      "query": [
        { "name": "status", "type": "string", "enum": ["all", "open", "done"], "default": "all" },
        { "name": "q", "type": "string", "description": "Matches part of the title, case-insensitively." },
        { "name": "tag", "type": "string", "description": "One tag name." }
      ],
      "success": { "status": 200, "body": "Task[]" },
      "errors": ["list_not_found", "invalid_status"]
    },
    {
      "id": "completeTask",
      "method": "POST",
      "path": "/api/tasks/{id}/complete",
      "summary": "Mark a task done. Completing a task that is already done changes nothing and returns it.",
      "satisfies": "US-2",
      "success": { "status": 200, "body": "Task" },
      "errors": ["task_not_found"]
    },
    {
      "id": "getOverdue",
      "method": "GET",
      "path": "/api/tasks/overdue",
      "summary": "Open tasks whose due date is strictly before today, most overdue first, then higher priority, then id.",
      "satisfies": "US-4",
      "query": [
        { "name": "today", "type": "date", "required": true, "description": "The day to report on. Required, so the report is the same report tomorrow." }
      ],
      "success": { "status": 200, "body": "Task[]" },
      "errors": ["invalid_date"]
    }
  ],

  "errors": {
    "invalid_name": { "status": 400, "meaning": "A list needs a name." },
    "duplicate_list": { "status": 409, "meaning": "A list with that name already exists." },
    "list_not_found": { "status": 404, "meaning": "No list has that id." },
    "invalid_status": { "status": 400, "meaning": "status must be all, open or done." },
    "task_not_found": { "status": 404, "meaning": "No task has that id." },
    "invalid_date": { "status": 400, "meaning": "today must be an ISO date." }
  }
}
`;

export const MY_SCREEN_CONTRACT = `{
  "$comment": "The screen contract.",
  "version": "2.0.0",
  "router": "hash",

  "screens": [
    {
      "route": "#/",
      "component": "ListsPage",
      "title": "Your lists",
      "shows": "Every list with how many of its tasks are still open, and a form that makes a new one.",
      "satisfies": ["US-1"],
      "reads": ["listLists"],
      "writes": ["createList"],
      "components": ["ListsPage"],
      "empty": "No lists yet. Make the first one."
    },
    {
      "route": "#/lists/:listId",
      "component": "TasksPage",
      "title": "Tasks",
      "shows": "The tasks in one list, a filter bar over status, search and tag, and a form that adds a task.",
      "satisfies": ["US-1", "US-2", "US-3", "US-5"],
      "reads": ["listTasks"],
      "writes": ["createTask", "completeTask"],
      "components": ["TasksPage", "TaskFilters", "NewTaskForm", "TaskRow", "OverdueBadge"],
      "empty": "This list is empty. Add the first task."
    },
    {
      "route": "#/overdue",
      "component": "OverduePage",
      "title": "Overdue",
      "shows": "Every open task across every list whose due date is strictly before today, most overdue first, with how many days late each one is and the list it came from.",
      "satisfies": ["US-4", "US-5"],
      "reads": ["getOverdue"],
      "writes": [],
      "components": ["OverduePage", "TaskRow", "OverdueBadge"],
      "empty": "Nothing is overdue. You are all caught up."
    }
  ]
}
`;

// Phase 2's work is the design record and these two contracts, with no
// markdown: e2e/golden-records.ts builds it (DESIGN_ARTEFACT) from them.

/* -------------------------- phase 3, implementation ----------------------- */
// Five gaps over two languages, so four files rather than one manager.py. The
// two scaffolds are here because a spec that wants a half-written workspace
// splices one of them.

export const SOLUTION_REPOSITORY = phaseFile('03-implementation', 'solution', 'api', 'repository', 'tasks.py');
export const SOLUTION_ROUTES = phaseFile('03-implementation', 'solution', 'api', 'routes', 'tasks.py');
export const SOLUTION_OVERDUE = phaseFile('03-implementation', 'solution', 'web', 'src', 'lib', 'overdue.ts');
export const SOLUTION_USE_TASKS = phaseFile('03-implementation', 'solution', 'web', 'src', 'hooks', 'useTasks.ts');

export const SCAFFOLD_REPOSITORY = phaseFile('03-implementation', 'files', 'api', 'repository', 'tasks.py');
export const SCAFFOLD_ROUTES = phaseFile('03-implementation', 'files', 'api', 'routes', 'tasks.py');

export const IMPLEMENTATION_ARTEFACT: Record<string, string> = {
  'api/repository/tasks.py': SOLUTION_REPOSITORY,
  'api/routes/tasks.py': SOLUTION_ROUTES,
  'web/src/lib/overdue.ts': SOLUTION_OVERDUE,
  'web/src/hooks/useTasks.ts': SOLUTION_USE_TASKS,
};

/* ----------------------------- phase 4, testing --------------------------- */
/**
 * The acceptance suites the pack itself ships, at
 * `content/tasktrackr/phases/04-testing/reference/`. They live with the pack so
 * one artefact proves the kill matrix (the loader runs them against every
 * mutant in `content.spec.ts`) instead of a copy here drifting away from the
 * suites the packs are graded by. The directory nests by workspace path, so the
 * API suite is under `reference/tests/` and the front-end one under
 * `reference/web/src/`.
 */
export const MY_TESTS = phaseFile('04-testing', 'reference', 'tests', 'test_acceptance.py');
export const MY_WEB_TESTS = phaseFile('04-testing', 'reference', 'web', 'src', 'acceptance.test.tsx');

export const TESTING_ARTEFACT: Record<string, string> = {
  'tests/test_acceptance.py': MY_TESTS,
  'web/src/acceptance.test.tsx': MY_WEB_TESTS,
};

/* --------------------------- phase 5, deployment -------------------------- */
// Two of the four are the canonical deployment: the learner fills the markers
// back in and lands where the application already is. Both markers have to go
// or the build check stays red and the drill has nothing to reproduce.

export const MY_DOCKERFILE = packFile('canonical', 'api', 'Dockerfile');
export const MY_COMPOSE = packFile('canonical', 'docker-compose.yml');

export const MY_CI = `name: tasktrackr-ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    name: API tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Install the API dependencies
        run: pip install --no-cache-dir -r requirements.txt pytest
      - name: Run the API suite
        run: python3 -m pytest tests -q

  web:
    name: Front-end tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Install the front-end dependencies
        run: npm install --no-audit --no-fund
      - name: Run the front-end suite
        run: node web/run-tests.js

  build:
    name: Images
    needs: [test, web]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build the api image
        run: docker build -f api/Dockerfile -t tasktrackr-api .
      - name: Build the web image
        run: docker build -f web/Dockerfile -t tasktrackr-web .
`;

// The runbook record, RUNBOOK_RECORD (e2e/record-fixtures.mjs), with its
// incident empty: the drill's resolve writes it.
export { RUNBOOK_RECORD };

export const DEPLOYMENT_ARTEFACT: Record<string, string> = {
  'api/Dockerfile': MY_DOCKERFILE,
  'docker-compose.yml': MY_COMPOSE,
  '.github/workflows/ci.yml': MY_CI,
  'deployment/runbook.json': RUNBOOK_RECORD,
};

/* -------------------------- phase 6, maintenance -------------------------- */
// CR-2: comments on a task, and a count on the row. Four files, and two of them
// end in `comments.py`, so a helper that addresses a Monaco model by basename
// needs the workspace path. The change request is the record,
// CHANGE_REQUEST_RECORD (e2e/record-fixtures.mjs).

export { CHANGE_REQUEST_RECORD };

export const CR2_REPOSITORY_TASKS = phaseFile('06-maintenance', 'solution', 'api', 'repository', 'tasks.py');
export const CR2_REPOSITORY_COMMENTS = phaseFile('06-maintenance', 'solution', 'api', 'repository', 'comments.py');
export const CR2_ROUTES_COMMENTS = phaseFile('06-maintenance', 'solution', 'api', 'routes', 'comments.py');
export const CR2_TASK_ROW = phaseFile('06-maintenance', 'solution', 'web', 'src', 'components', 'TaskRow.tsx');

export const MAINTENANCE_ARTEFACT: Record<string, string> = {
  'api/repository/tasks.py': CR2_REPOSITORY_TASKS,
  'api/repository/comments.py': CR2_REPOSITORY_COMMENTS,
  'api/routes/comments.py': CR2_ROUTES_COMMENTS,
  'web/src/components/TaskRow.tsx': CR2_TASK_ROW,
  'maintenance/change-request.json': CHANGE_REQUEST_RECORD,
};
