// The golden path: one worked answer per phase, good enough to score 100.
//
// Read by scripts/journey.mjs (the end-to-end run) and by
// scripts/seed-class/artefacts.mjs (which starts from these and takes pieces
// away, so a seeded class shows more than one shape). e2e/fixtures.ts keeps its
// own copy on purpose: a Playwright spec must not reach into scripts/. The
// Deployment and Maintenance records are not copied: both sides read them from
// e2e/record-fixtures.mjs, as the design record is read from
// e2e/golden-records.ts below.
//
// Anything the pack itself ships a worked copy of is read off disk, so it
// cannot drift: phase 3's and phase 6's solutions, phase 4's reference suites,
// and the canonical api/Dockerfile and docker-compose.yml. Only the four
// artefacts the pack has no answer for are written out here.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

// The worked runbook and change request: one module for this file and
// e2e/fixtures.ts (plain ESM, so it needs no register).
import { CHANGE_REQUEST_RECORD, RUNBOOK_RECORD } from '../e2e/record-fixtures.mjs';

export { CHANGE_REQUEST_RECORD, RUNBOOK_RECORD };

// The story and design records are written by the product's own serialisers
// (needs packages/shared built, as every script that drives the API does).
const require = createRequire(import.meta.url);
const { DESIGN_JSON, STORY_JSON, serialiseDesign, serialiseStory } = require('@learnsdlc/shared');
// The worked design record is the one the Playwright suite keeps in
// e2e/golden-records.ts; it is loaded from there rather than copied, through
// the same ts-node register scripts/passing-work.mjs uses (registered once).
if (!process[Symbol.for('ts-node.register.instance')]) {
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: { module: 'commonjs', target: 'es2022', esModuleInterop: true },
  });
}
// Its Maintenance set (named PUBLISHED_CR2 here) is the journey's: the CR-2 code
// with the two contracts that publish listComments and addComment at 2.1.0.
const { DESIGN_RECORD, MAINTENANCE_ARTEFACT: PUBLISHED_CR2 } = require('../e2e/golden-records.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packFile = (...rel) =>
  fs.readFileSync(path.join(ROOT, 'content', 'tasktrackr', ...rel), 'utf-8');
const phaseFile = (phase, ...rel) => packFile('phases', phase, ...rel);

/* --------------------------- phase 1, requirements ------------------------ */

/** US-4 as a learner's story record: three criteria, two out-of-scope lines. */
export const MY_STORY = {
  id: 'US-4',
  title: 'Overdue report',
  persona: 'busy learner',
  capability: 'a page listing every task whose due date has already passed',
  benefit: 'I can see what I have missed before I plan the day',
  criteria: [
    { id: 'AC-1', given: 'a list holding a task due before today', when: 'I open the overdue page', then: 'that task is on it with its title, how many whole days late it is, and the list it came from', tag: 'happy' },
    { id: 'AC-2', given: 'a task due today', when: 'I open the overdue page', then: 'it is not on it, because the day is not over yet', tag: 'boundary' },
    { id: 'AC-3', given: 'a task I completed a week after its due date', when: 'I open the overdue page', then: 'it is not on it', tag: 'boundary' },
  ],
  scopeExclusions: ['reminders and emails', 'any notification at all'],
  notes: 'The report is read when a person opens it.',
};

export const REQUIREMENTS_ARTEFACT = { [STORY_JSON]: serialiseStory(MY_STORY) };

/* ------------------------------ phase 2, design --------------------------- */

/** The worked design record, serialised: four classes, three operations, two decisions and the sequence. */
export const MY_DESIGN_RECORD = serialiseDesign(DESIGN_RECORD);

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

export const DESIGN_ARTEFACT = {
  [DESIGN_JSON]: MY_DESIGN_RECORD,
  'shared/contract/api.json': MY_API_CONTRACT,
  'shared/contract/screens.json': MY_SCREEN_CONTRACT,
};

/* -------------------------- phase 3, implementation ----------------------- */
// Five gaps over two languages. The pack ships the answer; read it.

export const SOLUTION_REPOSITORY = phaseFile('03-implementation', 'solution', 'api', 'repository', 'tasks.py');
export const SOLUTION_ROUTES = phaseFile('03-implementation', 'solution', 'api', 'routes', 'tasks.py');
export const SOLUTION_OVERDUE = phaseFile('03-implementation', 'solution', 'web', 'src', 'lib', 'overdue.ts');
export const SOLUTION_USE_TASKS = phaseFile('03-implementation', 'solution', 'web', 'src', 'hooks', 'useTasks.ts');

export const SCAFFOLD_REPOSITORY = phaseFile('03-implementation', 'files', 'api', 'repository', 'tasks.py');
export const SCAFFOLD_ROUTES = phaseFile('03-implementation', 'files', 'api', 'routes', 'tasks.py');

export const IMPLEMENTATION_ARTEFACT = {
  'api/repository/tasks.py': SOLUTION_REPOSITORY,
  'api/routes/tasks.py': SOLUTION_ROUTES,
  'web/src/lib/overdue.ts': SOLUTION_OVERDUE,
  'web/src/hooks/useTasks.ts': SOLUTION_USE_TASKS,
};

/* ----------------------------- phase 4, testing --------------------------- */
// The suites the pack is graded by, one per run. They live with the pack so one
// artefact proves the kill matrix instead of a copy here drifting away from it.

export const MY_TESTS = phaseFile('04-testing', 'reference', 'tests', 'test_acceptance.py');
export const MY_WEB_TESTS = phaseFile('04-testing', 'reference', 'web', 'src', 'acceptance.test.tsx');

export const TESTING_ARTEFACT = {
  'tests/test_acceptance.py': MY_TESTS,
  'web/src/acceptance.test.tsx': MY_WEB_TESTS,
};

/* --------------------------- phase 5, deployment -------------------------- */
// Two of the three config files are the canonical deployment: the learner fills
// the markers back in and lands where the application already is. The runbook
// is the record, RUNBOOK_RECORD, with its incident empty: the drill writes it
// (scripts/passing-work.mjs closeDrill).

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

export const DEPLOYMENT_ARTEFACT = {
  'api/Dockerfile': MY_DOCKERFILE,
  'docker-compose.yml': MY_COMPOSE,
  '.github/workflows/ci.yml': MY_CI,
  'deployment/runbook.json': RUNBOOK_RECORD,
};

/* -------------------------- phase 6, maintenance -------------------------- */
// CR-2: comments on a task, and a count on the row, with its change request
// record, CHANGE_REQUEST_RECORD. The record claims release 2.1.0 and two added
// operations (C1 and C2), so the set carries the two contracts that publish
// them, taken from e2e/golden-records.ts (the set the journey submits)
// rather than copied: the pack's scaffold contracts are 2.0.0 with no comment
// operation, and a reviewer checks each amendment against these files.

export const CR2_REPOSITORY_TASKS = phaseFile('06-maintenance', 'solution', 'api', 'repository', 'tasks.py');
export const CR2_REPOSITORY_COMMENTS = phaseFile('06-maintenance', 'solution', 'api', 'repository', 'comments.py');
export const CR2_ROUTES_COMMENTS = phaseFile('06-maintenance', 'solution', 'api', 'routes', 'comments.py');
export const CR2_TASK_ROW = phaseFile('06-maintenance', 'solution', 'web', 'src', 'components', 'TaskRow.tsx');

export const MAINTENANCE_ARTEFACT = {
  'api/repository/tasks.py': CR2_REPOSITORY_TASKS,
  'api/repository/comments.py': CR2_REPOSITORY_COMMENTS,
  'api/routes/comments.py': CR2_ROUTES_COMMENTS,
  'web/src/components/TaskRow.tsx': CR2_TASK_ROW,
  'shared/contract/api.json': PUBLISHED_CR2['shared/contract/api.json'],
  'design/contracts.json': PUBLISHED_CR2['design/contracts.json'],
  'maintenance/change-request.json': CHANGE_REQUEST_RECORD,
};
