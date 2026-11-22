import { describe, expect, test } from 'vitest';
import { CHANGE_REQUEST_JSON, type FieldChange } from '@learnsdlc/shared';
import {
  askedPaths, asksForPathNotHeld, inventoryCount, inventoryNoun, missingAsked, proposalInventory, proposalKind,
} from '@/components/workspace/mentor/proposalInventory';

/*
 * Which written-out paths a request to the mentor asks for, over 47 realistic
 * request, re-ask and revision texts written for the reference project.
 *
 * A path counts as asked for only inside an explicit "return only <path ...>"
 * list, or else in the request's opening sentence, and never as a pointer
 * ("as api/routes/tasks.py does", "Leave ... as it is"). Some texts write
 * the four impact files and both contracts as record content; read as asked
 * for, those would draw false "asked for, not in this proposal" lines on the
 * expected card. A false line is worse than no line: when in doubt, the rule
 * says nothing.
 */

/** Each phase's editable files in TaskTrackr (content/tasktrackr/phases/<phase>/files, with the room's own documents). */
const EDITABLE: Record<string, string[]> = {"requirements": ["requirements/story.json"], "design": ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"], "implementation": ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/hooks/useTasks.ts", "web/src/lib/overdue.ts"], "testing": ["tests/test_acceptance.py", "web/src/acceptance.test.tsx"], "deployment": [".github/workflows/ci.yml", "api/Dockerfile", "deployment/runbook.json", "docker-compose.yml"], "maintenance": ["api/repository/comments.py", "api/repository/tasks.py", "api/routes/comments.py", "design/contracts.json", "maintenance/change-request.json", "shared/contract/api.json", "web/src/components/TaskRow.tsx"]};

interface DemoText {
  name: string;
  phase: string;
  text: string;
  /** Exactly the paths the text asks for, in the order it names them. */
  asked: string[];
  /** The files of the card the script expects for this text. */
  card: string[];
}

const TEXTS: DemoText[] = [
  {
    name: "L.1", phase: "requirements",
    asked: [],
    card: ["requirements/story.json"],
    text: "Please propose my whole story US-4 in the story form with exactly these fields, and leave the notes empty. Title: \"Overdue report\". Persona: \"busy learner\". Capability: \"a page listing every task whose due date has already passed\". Benefit: \"I can see what I have missed before I plan the day\". Criteria: AC-1 (happy): given a list holding a task due before today; when I open the overdue page; then that task is on it with its title, how many whole days late it is, and the list it came from. AC-2 (boundary): given a task due today; when I open the overdue page; then it is not on it, because the day is not over yet. AC-3 (boundary): given a task I completed a week after its due date; when I open the overdue page; then it is not on it. Out of scope: reminders and emails; any notification at all. In your summary, name only the files this proposal changes. Keep the story's id US-4.",
  },
  {
    name: "L.2", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose my design record and both contracts, keeping what is already there. entities E1 Task (class), for US-1, US-2, US-3, US-4, US-5. E2 List (class), for US-1, US-4. E3 Tag (class), for US-3. E4 TaskTag (class), for US-3. Relations: R1 E2 composition E1 (holds). R2 E1 association E4 (is tagged through). R3 E3 association E4 (tags through). Operations: O1 completeTask(id), input POST /api/tasks/{id}/complete, returns 200 with the stored, done task, errors task_not_found, for US-2; O2 listTasks(listId, filters), input GET /api/lists/{id}/tasks with status, q and tag combined with AND, returns 200 with Task[], errors list_not_found invalid_status, for US-3; O3 getOverdue(today), input GET /api/tasks/overdue with a required today, returns 200 with Task[], errors invalid_date, for US-4. The record is to hold exactly these two decisions, each with its title exactly as quoted, replacing any decision already recorded: D1, title \"Filter and order on the API\", choice \"Filter and order on the API; render the returned order in the browser\", rather than downloading every task and filtering independently in the React hook, because the API can apply every filter to the complete set and one documented order prevents the…; trade-off: instant local refiltering without a request; the client must retain f…; satisfies [\"US-3\", \"US-4\"]. D2, title \"Require today explicitly for the overdue endpoint\", rather than reading the server clock inside the repository, because a caller and its tests can reproduce exactly the same due-date boundary and days-overdue…; trade-off: one validated calendar-date parameter that every caller must supply; satisfies [\"US-4\", \"US-5\"]. The API contract declares the error catalogue invalid_name 400, duplicate_list 409, list_not_found 404, invalid_status 400, task_not_found 404, invalid_date 400. The screen contract: #/overdue (Overdue), empty state: Nothing is overdue. You are all caught up.. In your summary, name only the files this proposal changes.",
  },
  {
    name: "L.3", phase: "implementation",
    asked: ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    card: ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    text: "Please propose code for api/repository/tasks.py, api/routes/tasks.py, web/src/lib/overdue.ts and web/src/hooks/useTasks.ts: fill every gap marked TODO(learner). The gaps marked in the files: api/repository/tasks.py: implement to the US-3 contract. Build the WHERE clause from the filters that were actually given, and let SQL do the ordering — the CASE expression in PRIORITY_ORDER is already written for you. | api/repository/tasks.py: implement to the US-4 contract from your design. One SELECT, three conditions and one ORDER BY. | api/routes/tasks.py: implement to the US-2 contract. repository.tasks has a helper that already raises for an unknown id, and errors.py has the one function that builds the 404 envelope. | web/src/lib/overdue.ts: implement to the same boundary rule your API uses (US-4). Both arguments are ISO dates (\"2026-03-14\"), and ISO dates compare correctly as strings: \"2026-03-01\" < \"2026-03-02\" is true. | web/src/hooks/useTasks.ts: implement to the US-3 contract. Ask the API for the tasks in this list, send only the filters that are set — queryFor above does that part — and hand back { tasks, loading, error, reload }. What it must do: Implement list_tasks with the status, keyword and tag filters and the priority order (US-3); Implement overdue_tasks with the exact boundary rule from your design (US-4); Wire the complete route to the repository and to the error envelope (US-2); Write the same boundary rule again as isOverdue, in TypeScript, so the badge on a row agrees with the report (US-4, US-5); Implement the useTasks hook so the filters reach the API and a failed request reaches the screen (US-3). The hook must refetch whenever the list or any filter value (status, q or tag) changes, not only when the filters object itself is replaced, so its effect depends on listId, status, q and tag, the values themselves. In your summary, name only the files this proposal changes. Keep every other function, name and docstring as it is, and change no other file.",
  },
  {
    name: "L.4", phase: "testing",
    asked: ["tests/test_acceptance.py", "web/src/acceptance.test.tsx"],
    card: ["tests/test_acceptance.py", "web/src/acceptance.test.tsx"],
    text: "Please propose acceptance tests in tests/test_acceptance.py and front-end tests in web/src/acceptance.test.tsx, and return only these two files: replace each TODO(learner) comment with tests. In tests/test_acceptance.py keep the worked example and the helpers home, add and day as they are. Through client: POST /api/tasks/<id>/complete answers 200 with status \"done\" and completed_at set, and a later GET /api/tasks/<id> still reads done; POST /api/tasks/99999/complete answers 404 with error.code \"task_not_found\"; GET /api/lists/<id>/tasks with status=open leaves out a completed task; q=rent returns \"Pay Rent\" and not \"Review notes\"; tasks added with priority low, high, medium and medium come back high, medium, medium, low, ties by id; GET /api/tasks/overdue with today=day(0) lists only the open task due day(-3), and leaves out tasks due day(0) and day(2), one with no due date and one due day(-3) that was completed. In web/src/acceptance.test.tsx keep the worked example and the imports as they are. With node's assert (there is no expect), one test(...) per case: TaskRow for aTask({ due_date: daysAgo(3) }) with today={today()} shows getByTestId('overdue-badge') reading \"3 days late\"; three separate tests render a task due daysAgo(0), one with due_date null, and a done task due daysAgo(9), and each finds no badge (queryByTestId('overdue-badge') is null); and an async test runs const urls = answerWith({ body: [] }); const { result } = renderHook(() => useTasks(2, { status: 'open', q: 'rent', tag: '' })); await waitFor(() => assert.strictEqual(result.current.loading, false)); then assert.strictEqual(urls.length, 1), assert.ok(urls[0].includes('q=rent')) and assert.ok(urls[0].includes('status=open')), so the one URL keeps q=rent and status=open. In your summary, name only the files this proposal changes. Change no other file.",
  },
  {
    name: "L.5", phase: "deployment",
    asked: ["api/Dockerfile", "docker-compose.yml"],
    card: ["api/Dockerfile", "docker-compose.yml"],
    text: "Please propose my two configuration files api/Dockerfile and docker-compose.yml, and return only these two files: delete each TODO(learner) comment, with the comment lines that continue it, and write the lines below in its place, so no TODO(learner) line is left; keep every other line as it is. In api/Dockerfile: WORKDIR /app after the FROM line; then, before the RUN pip install line, COPY requirements.txt ./, COPY api/ ./api/, COPY ops/ ./ops/ and COPY docker-compose.yml ./; and last ENTRYPOINT [\"python3\", \"api/main.py\"]. In docker-compose.yml: under the api service a healthcheck with test: [\"CMD\", \"python3\", \"-c\", \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')\"], interval 5s, timeout 3s, retries 10 and start_period 5s; and in the web service API_URL: http://api:8000 in place of the empty value. In your summary, name only the files this proposal changes. Change no other file.",
  },
  {
    name: "L.6", phase: "deployment",
    asked: [],
    card: ["deployment/runbook.json"],
    text: "Please propose a change to my runbook in the Runbook tab: fill its rollback steps and its data, and keep its environment and health checks as they are. Write each entry for an operator who was not on the call: the rollback steps restore the last known-good images by their tags, never a checkout and a rebuild, each with its check, and say what a rollback does not undo; the data entry names the database volume and how to back it up and put a backup back. Rollback, in order: R1 Restore the last known-good images (each tagged :known-good before a release goes out): docker tag tasktrackr-api:known-good tasktrackr-api:latest and docker tag tasktrackr-web:known-good tasktrackr-web:latest. No checkout, no rebuild. Check: docker image ls shows each latest tag on its known-good image ID. R2 docker compose up -d --no-build --force-recreate: api and web are recreated from those images, nothing is built. Check: H1 prints 0, and docker compose ps lists api as healthy and web as running. R3 Run docker compose exec api python3 api/main.py --selfcheck. A rollback does not undo the data: the tasktrackr-data volume keeps every write made by the newer release. Check: The selfcheck prints its success line, and docker volume ls still lists tasktrackr-data. Data: D1 The SQLite database file /data/tasktrackr.db: Back it up with the Python already in the api image: docker compose exec api python3 -c \"import sqlite3; s=sqlite3.connect('/data/tasktrackr.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)\", then docker compose cp api:/data/backup.db ./backups/. To restore, stop the api (docker compose stop api), docker compose cp ./backups/backup.db api:/data/tasktrackr.db, then docker compose start api and run the selfcheck. Where: The tasktrackr-data volume on the host, and copies in ./backups off the host; docker compose down -v deletes the volume. Retention: Keep the last 14 nightly copies. In your summary, name only the files you change. Leave the incident empty: the drill writes it.",
  },
  {
    name: "L.7", phase: "maintenance",
    asked: ["api/repository/tasks.py", "api/repository/comments.py", "api/routes/comments.py", "design/contracts.json"],
    card: ["api/repository/tasks.py", "api/repository/comments.py", "api/routes/comments.py", "design/contracts.json"],
    text: "Please propose code for CR-2's API side in api/repository/tasks.py, api/repository/comments.py, api/routes/comments.py and design/contracts.json, and return only these four files, keeping every other function, name and docstring, and leave no TODO(learner) line. In api/repository/tasks.py, replace the comment_count TODO in the task query with (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count, a subquery like tag_names so the query still returns one row per task, and in the row reader use record[\"comment_count\"] instead of 0. In api/repository/comments.py, list_comments first calls tasks.get_task(conn, task_id), which raises KeyError for an unknown task, then returns _to_comment of each row of COMMENT_SELECT + \" WHERE task_id = ? ORDER BY created_at DESC, id DESC\"; add_comment also calls get_task first, strips author and body, raises ValueError when either is empty, inserts (task_id, author, body, now()), commits and returns _to_comment of the row read back by its lastrowid. In api/routes/comments.py add GET /api/tasks/<int:task_id>/comments, 200 with the list, and POST on the same path reading request.get_json(silent=True) or {}, 201 with the comment; both answer 404 task_not_found \"No task has id {task_id}.\" on KeyError and the POST answers 400 invalid_comment \"A comment needs an author and a body.\" on ValueError, returned by fail(code, message, status); both pass connect() straight to the repository, as api/routes/tasks.py does, and never close the connection. Give each function you write a one-line docstring, the two route functions in api/routes/comments.py included. In design/contracts.json list two operations for CR-2: listComments(taskId), GET /api/tasks/{id}/comments returning Comment[] newest first, 404 task_not_found; and addComment(taskId, author, body), POST /api/tasks/{id}/comments returning the 201 Comment, 400 invalid_comment, 404 task_not_found. In your summary, name only the files this proposal changes.",
  },
  {
    name: "L.8", phase: "maintenance",
    asked: ["web/src/components/TaskRow.tsx", "shared/contract/api.json"],
    card: ["web/src/components/TaskRow.tsx", "shared/contract/api.json"],
    text: "Please propose web/src/components/TaskRow.tsx and shared/contract/api.json for CR-2, and return only these two files. In web/src/components/TaskRow.tsx replace the CR-2 TODO comment with a span with className \"badge badge-comments\" and data-testid \"comment-count\" reading \"1 comment\" or \"<n> comments\", drawn only when task.comment_count is above 0, and change nothing else on the row. In shared/contract/api.json remove the \"$todo\" entry, set the top-level version to 2.1.0, and add two operations in the shape of their neighbours: listComments, GET /api/tasks/{id}/comments, satisfies CR-2, success 200 Comment[], errors task_not_found; and addComment, POST /api/tasks/{id}/comments, satisfies CR-2, body author and body as non-empty strings, success 201 Comment, errors invalid_comment and task_not_found; then add invalid_comment to errors with status 400, meaning a comment needs a non-empty author and body. In your summary, name only the files this proposal changes. Keep every other entry as it is.",
  },
  {
    name: "L.9", phase: "maintenance",
    asked: ["maintenance/change-request.json"],
    card: ["maintenance/change-request.json"],
    text: "Please propose my change request for CR-2. Impact: operations listComments, addComment; screens #/lists/{id}; files api/repository/comments.py, api/routes/comments.py, api/repository/tasks.py, web/src/components/TaskRow.tsx. Contract: C1 added GET /api/tasks/{id}/comments: CR-2 reads a task's comments, newest first. C2 added POST /api/tasks/{id}/comments: CR-2 adds a comment and answers invalid_comment for a blank author or body. Tests: T1 tests/test_comments_api.py covers AC-1, AC-2, AC-3, AC-4, AC-7, result pass; T2 web/src/components/TaskRow.test.tsx covers AC-5, AC-6, result pass. Release 2.1.0, summary Comments on a task; change lines: L1 A task takes comments, and lists them newest first. (covers AC-1, AC-2, AC-3, AC-4) L2 Every task carries comment_count, and the row shows it. (covers AC-5, AC-6) L3 listComments and addComment are published in the API contract. (covers AC-7) Risks: No schema change is needed: the comments table is already in api/schema.sql. The only new risk is the per-task comment count subquery on every task list read, which may slow very long lists. Rollback: Redeploy 2.0.0: no schema change is needed, because the comments table was already in the schema. In the record's tests list put exactly these two entries and no other, each with result pass: no entry marked not-run; this request writes no test file. List exactly these four impact files and no other file. In your proposal's summary, name only the files this proposal changes. Keep exactly this one risk, and leave the notes empty. Return only maintenance/change-request.json, whole, with the record's JSON as one text string, and no other file.",
  },
  {
    name: "L.d1", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose the model of my design record and the operations of my design record, keeping what is already there. entities E1 Task (class), for US-1, US-2, US-3, US-4, US-5. E2 List (class), for US-1, US-4. E3 Tag (class), for US-3. E4 TaskTag (class), for US-3. Relations: R1 E2 composition E1 (holds). R2 E1 association E4 (is tagged through). R3 E3 association E4 (tags through). Operations: O1 completeTask(id)(POST /api/tasks/{id}/complete with an integer task id in the path and no request body.) returns 200 with the complete Task DTO after persisting status done…, errors 404 task_not_found when no task has the supplied id; the error response is {\"error\":{\"code\":\"task_not_found\",\"message\":\"No task has that id.\"}} and no task is changed., for US-2. O2 listTasks(listId, filters)(GET /api/lists/{id}/tasks. status is optional and defaults to all; accepted values are all, open and done. q is an optional case-insensitive substring of the title; missing or empty q adds no keyword filter. tag is an optional exact tag name; a missing tag adds no tag filter. All supplied filters are combined with AND. The client preserves q when changing status or tag.) returns 200 with Task[] belonging only to the named list and satisf…, errors 404 list_not_found for an unknown list; 400 invalid_status if status is outside all, open and done. Each is returned in the shared {error:{code,message}} envelope., for US-3. O3 getOverdue(today)(GET /api/tasks/overdue?today=YYYY-MM-DD. today is a required valid ISO calendar date chosen by the caller so tests and later replays use the same boundary.) returns 200 with Task[] across all lists where status is open, due_…, errors 400 invalid_date when today is missing or is not a valid ISO YYYY-MM-DD calendar date, using the shared {error:{code,message}} envelope., for US-4. In your summary, name only the files this proposal changes. Leave the decisions as they are: my next request fills them.",
  },
  {
    name: "L.d2", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose the decisions of my design record and the contracts, keeping the model and the operations as they are. The record is to hold exactly these two decisions, each with its title exactly as quoted, replacing any decision already recorded: D1, title \"Filter and order on the API\", choice \"Filter and order on the API; render the returned order in the browser\", rather than downloading every task and filtering independently in the React hook, because the API can apply every filter to the complete set and one documented order prevents the list and overdue report from contradicting each other; trade-off: instant local refiltering without a request; the client must retain filters and handle loading or network failure; satisfies [\"US-3\", \"US-4\"]. D2, title \"Require today explicitly for the overdue endpoint\", rather than reading the server clock inside the repository, because a caller and its tests can reproduce exactly the same due-date boundary and days-overdue display; trade-off: one validated calendar-date parameter that every caller must supply; satisfies [\"US-4\", \"US-5\"]. The API contract: operations GET /api/lists (listLists, US-1); POST /api/lists (createList, US-1, errors invalid_name duplicate_list); GET /api/lists/{id}/tasks (listTasks, US-3, errors list_not_found invalid_status); POST /api/tasks/{id}/complete (completeTask, US-2, errors task_not_found); GET /api/tasks/overdue (getOverdue, US-4, errors invalid_date); error catalogue invalid_name 400, duplicate_list 409, list_not_found 404, invalid_status 400, task_not_found 404, invalid_date 400. The screen contract: #/ (Your lists), empty state: No lists yet. Make the first one.; #/lists/:listId (Tasks), empty state: This list is empty. Add the first task.; #/overdue (Overdue), empty state: Nothing is overdue. You are all caught up.. In your summary, name only the files this proposal changes.",
  },
  {
    name: "L.i1", phase: "implementation",
    asked: ["api/repository/tasks.py", "api/routes/tasks.py"],
    card: ["api/repository/tasks.py", "api/routes/tasks.py"],
    text: "Please propose code for api/repository/tasks.py and api/routes/tasks.py: fill every gap marked TODO(learner). The gaps marked in the files: api/repository/tasks.py: implement to the US-3 contract. Build the WHERE clause from the filters that were actually given, and let SQL do the ordering — the CASE expression in PRIORITY_ORDER is already written for you. | api/repository/tasks.py: implement to the US-4 contract from your design. One SELECT, three conditions and one ORDER BY — the docstring above names all four, and TASK_SELECT and PRIORITY_ORDER are already written. | api/routes/tasks.py: implement to the US-2 contract. repository.tasks has a helper that already raises for an unknown id, and errors.py has the one function that builds the 404 envelope.. What it must do: Implement list_tasks with the status, keyword and tag filters and the priority order (US-3); Implement overdue_tasks with the exact boundary rule from your design (US-4); Wire the complete route to the repository and to the error envelope (US-2). In your summary, name only the files this proposal changes. Keep every other function, name and docstring as it is, and change no other file.",
  },
  {
    name: "L.i2", phase: "implementation",
    asked: ["web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    card: ["web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    text: "Please propose code for web/src/lib/overdue.ts and web/src/hooks/useTasks.ts: fill every gap marked TODO(learner). The gaps marked in the files: web/src/lib/overdue.ts: implement to the same boundary rule your API uses (US-4). Both arguments are ISO dates (\"2026-03-14\"), and ISO dates compare correctly as strings: \"2026-03-01\" < \"2026-03-02\" is true. Three of the | web/src/hooks/useTasks.ts: implement to the US-3 contract. Ask the API for the tasks in this list, send only the filters that are set — queryFor above does that part — and hand back { tasks, loading, error, reload }. getJson is in. What it must do: Write the same boundary rule again as isOverdue, in TypeScript, so the badge on a row agrees with the report (US-4, US-5); Implement the useTasks hook so the filters reach the API and a failed request reaches the screen (US-3). The hook must refetch whenever the list or any filter value (status, q or tag) changes, not only when the filters object itself is replaced, so its effect depends on listId, status, q and tag, the values themselves. In your summary, name only the files this proposal changes. Keep every other function, name and docstring as it is, and change no other file.",
  },
  {
    name: "L.t1", phase: "testing",
    asked: ["tests/test_acceptance.py"],
    card: ["tests/test_acceptance.py"],
    text: "Please propose acceptance tests in tests/test_acceptance.py, and return only this file: replace each TODO(learner) comment with tests and keep the worked example and the helpers home, add and day as they are. Through client: POST /api/tasks/<id>/complete answers 200 with status \"done\" and completed_at set, and a later GET /api/tasks/<id> still reads done; POST /api/tasks/99999/complete answers 404 with error.code \"task_not_found\"; GET /api/lists/<id>/tasks with status=open leaves out a completed task; q=rent returns \"Pay Rent\" and not \"Review notes\"; tasks added with priority low, high, medium and medium come back high, medium, medium, low, ties by id; GET /api/tasks/overdue with today=day(0) lists only the open task due day(-3), and leaves out tasks due day(0) and day(2), one with no due date and one due day(-3) that was completed. In your summary, name only the files this proposal changes. Change no other file.",
  },
  {
    name: "L.t2", phase: "testing",
    asked: ["web/src/acceptance.test.tsx"],
    card: ["web/src/acceptance.test.tsx"],
    text: "Please propose front-end tests in web/src/acceptance.test.tsx, and return only this file: replace each TODO(learner) comment with tests and keep the worked example and the imports as they are. With node's assert (there is no expect), one test(...) per case: TaskRow for aTask({ due_date: daysAgo(3) }) with today={today()} shows getByTestId('overdue-badge') reading \"3 days late\"; three separate tests render a task due daysAgo(0), one with due_date null, and a done task due daysAgo(9), and each finds no badge (queryByTestId('overdue-badge') is null); and an async test runs const urls = answerWith({ body: [] }); const { result } = renderHook(() => useTasks(2, { status: 'open', q: 'rent', tag: '' })); await waitFor(() => assert.strictEqual(result.current.loading, false)); then assert.strictEqual(urls.length, 1), assert.ok(urls[0].includes('q=rent')) and assert.ok(urls[0].includes('status=open')), so the one URL keeps q=rent and status=open. In your summary, name only the files this proposal changes. Change no other file.",
  },
  {
    name: "W.1", phase: "design",
    asked: ["shared/contract/screens.json"],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please add the screen contract in shared/contract/screens.json to the proposal above: my request asked for it, and that proposal does not hold it. The screen contract: #/ (Your lists), empty state: No lists yet. Make the first one.; #/lists/:listId (Tasks), empty state: This list is empty. Add the first task.; #/overdue (Overdue), empty state: Nothing is overdue. You are all caught up.. In the screen contract, the overdue screen #/overdue names its component OverduePage, the stories US-4 and US-5, the operation it reads, getOverdue, the components it renders, OverduePage, TaskRow and OverdueBadge, and the sentence it shows when nothing is overdue: \"Nothing is overdue. You are all caught up.\" Keep design/design.json as it stands in that proposal and change no other file.",
  },
  {
    name: "W.1b", phase: "design",
    asked: ["shared/contract/screens.json"],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please add the screen contract in shared/contract/screens.json to the proposal above: my request asked for it, and that proposal does not hold it. The screen contract: #/ (Your lists), empty state: No lists yet. Make the first one.; #/lists/:listId (Tasks), empty state: This list is empty. Add the first task.; #/overdue (Overdue), empty state: Nothing is overdue. You are all caught up.. In the screen contract, the overdue screen #/overdue names its component OverduePage, the stories US-4 and US-5, the operation it reads, getOverdue, the components it renders, OverduePage, TaskRow and OverdueBadge, and the sentence it shows when nothing is overdue: \"Nothing is overdue. You are all caught up.\" Keep design/design.json and shared/contract/api.json as they stand in that proposal and change no other file.",
  },
  {
    name: "W.2", phase: "design",
    asked: ["shared/contract/api.json", "shared/contract/screens.json"],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please add the API contract in shared/contract/api.json and the screen contract in shared/contract/screens.json to the proposal above: my request asked for them, and that proposal does not hold them. The API contract: operations GET /api/lists (listLists, US-1); POST /api/lists (createList, US-1, errors invalid_name duplicate_list); GET /api/lists/{id}/tasks (listTasks, US-3, errors list_not_found invalid_status); POST /api/tasks/{id}/complete (completeTask, US-2, errors task_not_found); GET /api/tasks/overdue (getOverdue, US-4, errors invalid_date); error catalogue invalid_name 400, duplicate_list 409, list_not_found 404, invalid_status 400, task_not_found 404, invalid_date 400. The screen contract: #/ (Your lists), empty state: No lists yet. Make the first one.; #/lists/:listId (Tasks), empty state: This list is empty. Add the first task.; #/overdue (Overdue), empty state: Nothing is overdue. You are all caught up.. In the screen contract, the overdue screen #/overdue names its component OverduePage, the stories US-4 and US-5, the operation it reads, getOverdue, the components it renders, OverduePage, TaskRow and OverdueBadge, and the sentence it shows when nothing is overdue: \"Nothing is overdue. You are all caught up.\" Keep design/design.json as it stands in that proposal and change no other file.",
  },
  {
    name: "W.2b", phase: "design",
    asked: ["shared/contract/api.json"],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please add the API contract in shared/contract/api.json to the proposal above: my request asked for it, and that proposal does not hold it. The API contract: operations GET /api/lists (listLists, US-1); POST /api/lists (createList, US-1, errors invalid_name duplicate_list); GET /api/lists/{id}/tasks (listTasks, US-3, errors list_not_found invalid_status); POST /api/tasks/{id}/complete (completeTask, US-2, errors task_not_found); GET /api/tasks/overdue (getOverdue, US-4, errors invalid_date); error catalogue invalid_name 400, duplicate_list 409, list_not_found 404, invalid_status 400, task_not_found 404, invalid_date 400. Keep design/design.json and shared/contract/screens.json as they stand in that proposal and change no other file.",
  },
  {
    name: "W.3", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the screen contract of my design: Check the design still lists \"Every screen is complete\" as not met. In the screen contract, the overdue screen #/overdue names its component OverduePage, the stories US-4 and US-5, the operation it reads, getOverdue, the components it renders, OverduePage, TaskRow and OverdueBadge, and the sentence it shows when nothing is overdue: \"Nothing is overdue. You are all caught up.\" Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "W.3b", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the API contract of my design: Check the design still lists \"An error catalogue\" as not met. In the API contract, write completeTask, listTasks and getOverdue so each says what it answers with and what it refuses: completeTask, POST /api/tasks/{id}/complete: the summary \"Mark a task done. Completing a task that is already done changes nothing and returns it.\", success 200 with Task, errors task_not_found; listTasks, GET /api/lists/{id}/tasks: the summary \"The tasks in one list, filtered and ordered by the API. Highest priority first, ties by ascending id.\", query status (all, open, done; default all), q, tag, success 200 with Task[], errors list_not_found and invalid_status; getOverdue, GET /api/tasks/overdue: the summary \"Open tasks whose due date is strictly before today, most overdue first, then higher priority, then id.\", query today (required), success 200 with Task[], errors invalid_date. In the error catalogue declare every code an operation names with its status and its meaning: invalid_name 400 \"A list needs a name.\", duplicate_list 409 \"A list with that name already exists.\", list_not_found 404 \"No list has that id.\", invalid_status 400 \"status must be all, open or done.\", task_not_found 404 \"No task has that id.\", invalid_date 400 \"today must be an ISO date.\" Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "W.3c", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the API contract of my design: Check the design still lists the minimum number of endpoints as not met. In the API contract, write completeTask, listTasks and getOverdue so each says what it answers with and what it refuses: completeTask, POST /api/tasks/{id}/complete: the summary \"Mark a task done. Completing a task that is already done changes nothing and returns it.\", success 200 with Task, errors task_not_found; listTasks, GET /api/lists/{id}/tasks: the summary \"The tasks in one list, filtered and ordered by the API. Highest priority first, ties by ascending id.\", query status (all, open, done; default all), q, tag, success 200 with Task[], errors list_not_found and invalid_status; getOverdue, GET /api/tasks/overdue: the summary \"Open tasks whose due date is strictly before today, most overdue first, then higher priority, then id.\", query today (required), success 200 with Task[], errors invalid_date. In the error catalogue declare every code an operation names with its status and its meaning: invalid_name 400 \"A list needs a name.\", duplicate_list 409 \"A list with that name already exists.\", list_not_found 404 \"No list has that id.\", invalid_status 400 \"status must be all, open or done.\", task_not_found 404 \"No task has that id.\", invalid_date 400 \"today must be an ISO date.\" Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "W.3d", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the decisions of my design: Check the design still lists the minimum number of decisions as not met. In Decisions, each decision says what it chose, the alternative it beat, why, and the trade-off weighed: D1 chose Filter and order on the API; render the returned order in the browser rather than downloading every task and filtering independently in the React hook, because the API can apply every filter to the complete set and one documented order prevents the list and overdue report from contradicting each other; trade-off: instant local refiltering without a request; the client must retain filters and handle loading or network failure. D2 chose Require today explicitly for the overdue endpoint rather than reading the server clock inside the repository, because a caller and its tests can reproduce exactly the same due-date boundary and days-overdue display; trade-off: one validated calendar-date parameter that every caller must supply. Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "W.3e", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the operations' stories of my design: Check the design still lists \"Every story is traced\" as not met. Every operation names the story it satisfies: listLists US-1, createList US-1, listTasks US-3, completeTask US-2, getOverdue US-4; every entity and operation of the model keeps its stories in satisfies. Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "W.6a", phase: "implementation",
    asked: ["web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    card: ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    text: "Please add web/src/lib/overdue.ts and web/src/hooks/useTasks.ts to the proposal above: my request asked for them, and that proposal does not hold them. In web/src/lib/overdue.ts and web/src/hooks/useTasks.ts fill every gap marked TODO(learner): web/src/lib/overdue.ts: implement to the same boundary rule your API uses (US-4). Both arguments are ISO dates (\"2026-03-14\"), and ISO dates compare correctly as strings: \"2026-03-01\" < \"2026-03-02\" is true. | web/src/hooks/useTasks.ts: implement to the US-3 contract. Ask the API for the tasks in this list, send only the filters that are set — queryFor above does that part — and hand back { tasks, loading, error, reload }. What it must do: Write the same boundary rule again as isOverdue, in TypeScript, so the badge on a row agrees with the report (US-4, US-5); Implement the useTasks hook so the filters reach the API and a failed request reaches the screen (US-3). The hook must refetch whenever the list or any filter value (status, q or tag) changes, not only when the filters object itself is replaced, so its effect depends on listId, status, q and tag, the values themselves. Keep api/repository/tasks.py and api/routes/tasks.py as they stand in that proposal and change no other file.",
  },
  {
    name: "W.6b", phase: "implementation",
    asked: ["api/repository/tasks.py", "api/routes/tasks.py"],
    card: ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/lib/overdue.ts", "web/src/hooks/useTasks.ts"],
    text: "Please add api/repository/tasks.py and api/routes/tasks.py to the proposal above: my request asked for them, and that proposal does not hold them. In api/repository/tasks.py and api/routes/tasks.py fill every gap marked TODO(learner): api/repository/tasks.py: implement to the US-3 contract. Build the WHERE clause from the filters that were actually given, and let SQL do the ordering — the CASE expression in PRIORITY_ORDER is already written for you. | api/repository/tasks.py: implement to the US-4 contract from your design. One SELECT, three conditions and one ORDER BY. | api/routes/tasks.py: implement to the US-2 contract. repository.tasks has a helper that already raises for an unknown id, and errors.py has the one function that builds the 404 envelope.. What it must do: Implement list_tasks with the status, keyword and tag filters and the priority order (US-3); Implement overdue_tasks with the exact boundary rule from your design (US-4); Wire the complete route to the repository and to the error envelope (US-2). Keep web/src/lib/overdue.ts and web/src/hooks/useTasks.ts as they stand in that proposal and change no other file.",
  },
  {
    name: "W.6c", phase: "testing",
    asked: ["web/src/acceptance.test.tsx"],
    card: ["tests/test_acceptance.py", "web/src/acceptance.test.tsx"],
    text: "Please add web/src/acceptance.test.tsx to the proposal above: my request asked for it, and that proposal does not hold it. In web/src/acceptance.test.tsx keep the worked example and the imports as they are. With node's assert (there is no expect), one test(...) per case: TaskRow for aTask({ due_date: daysAgo(3) }) with today={today()} shows getByTestId('overdue-badge') reading \"3 days late\"; three separate tests render a task due daysAgo(0), one with due_date null, and a done task due daysAgo(9), and each finds no badge (queryByTestId('overdue-badge') is null); and an async test runs const urls = answerWith({ body: [] }); const { result } = renderHook(() => useTasks(2, { status: 'open', q: 'rent', tag: '' })); await waitFor(() => assert.strictEqual(result.current.loading, false)); then assert.strictEqual(urls.length, 1), assert.ok(urls[0].includes('q=rent')) and assert.ok(urls[0].includes('status=open')), so the one URL keeps q=rent and status=open. Keep tests/test_acceptance.py as it stands in that proposal and change no other file.",
  },
  {
    name: "W.6d", phase: "testing",
    asked: ["tests/test_acceptance.py"],
    card: ["tests/test_acceptance.py", "web/src/acceptance.test.tsx"],
    text: "Please add tests/test_acceptance.py to the proposal above: my request asked for it, and that proposal does not hold it. In tests/test_acceptance.py keep the worked example and the helpers home, add and day as they are. Through client: POST /api/tasks/<id>/complete answers 200 with status \"done\" and completed_at set, and a later GET /api/tasks/<id> still reads done; POST /api/tasks/99999/complete answers 404 with error.code \"task_not_found\"; GET /api/lists/<id>/tasks with status=open leaves out a completed task; q=rent returns \"Pay Rent\" and not \"Review notes\"; tasks added with priority low, high, medium and medium come back high, medium, medium, low, ties by id; GET /api/tasks/overdue with today=day(0) lists only the open task due day(-3), and leaves out tasks due day(0) and day(2), one with no due date and one due day(-3) that was completed. Keep web/src/acceptance.test.tsx as it stands in that proposal and change no other file.",
  },
  {
    name: "W.7", phase: "maintenance",
    asked: ["design/contracts.json"],
    card: ["maintenance/change-request.json", "api/repository/tasks.py", "api/repository/comments.py", "api/routes/comments.py", "design/contracts.json"],
    text: "Please add design/contracts.json to the proposal above: my request asked for it, and that proposal does not hold it. In design/contracts.json list two operations for CR-2: listComments(taskId), GET /api/tasks/{id}/comments returning Comment[] newest first, 404 task_not_found; and addComment(taskId, author, body), POST /api/tasks/{id}/comments returning the 201 Comment, 400 invalid_comment, 404 task_not_found. Add both to the operations the file already lists, and keep every other operation as it is. Keep api/repository/tasks.py, api/repository/comments.py, api/routes/comments.py and maintenance/change-request.json as they stand in that proposal and change no other file.",
  },
  {
    name: "B: The generic revision request", phase: "maintenance",
    asked: [],
    card: [],
    text: "Please propose a revision of this phase's work that answers each point the review raised, and keep everything else exactly as it is.",
  },
  {
    name: "B: Design, cause `unmet: api_contract`", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the API contract of my design: the review asks for a more precise API contract. In the API contract, write completeTask, listTasks and getOverdue so each says what it answers with and what it refuses: completeTask, POST /api/tasks/{id}/complete: the summary \"Mark a task done. Completing a task that is already done changes nothing and returns it.\", success 200 with Task, errors task_not_found; listTasks, GET /api/lists/{id}/tasks: the summary \"The tasks in one list, filtered and ordered by the API. Highest priority first, ties by ascending id.\", query status (all, open, done; default all), q, tag, success 200 with Task[], errors list_not_found and invalid_status; getOverdue, GET /api/tasks/overdue: the summary \"Open tasks whose due date is strictly before today, most overdue first, then higher priority, then id.\", query today (required), success 200 with Task[], errors invalid_date. In the error catalogue declare every code an operation names with its status and its meaning: invalid_name 400 \"A list needs a name.\", duplicate_list 409 \"A list with that name already exists.\", list_not_found 404 \"No list has that id.\", invalid_status 400 \"status must be all, open or done.\", task_not_found 404 \"No task has that id.\", invalid_date 400 \"today must be an ISO date.\" Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "B: Design, cause `unmet: screen_contract`", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the screen contract of my design: the review asks for a more precise screen contract. In the screen contract, the overdue screen #/overdue names its component OverduePage, the stories US-4 and US-5, the operation it reads, getOverdue, the components it renders, OverduePage, TaskRow and OverdueBadge, and the sentence it shows when nothing is overdue: \"Nothing is overdue. You are all caught up.\" Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "B: Design, cause `unmet: data_model`", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the model of my design: the review asks for a complete data model. In the model and in the API contract's entities, the tasks entity carries due_date (a date, or null) and status (open or done, default open), its list_id references lists.id so a task belongs to exactly one list, and tags are joined to tasks through the task_tags table (task_id references tasks.id, tag_id references tags.id) rather than stored on the task. Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "B: Design, cause `unmet: traceability`", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the operations' stories of my design: the review asks for every operation traced to its story. Every operation names the story it satisfies: listLists US-1, createList US-1, listTasks US-3, completeTask US-2, getOverdue US-4; every entity and operation of the model keeps its stories in satisfies. Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "B: Design, cause `unmet: decision_justification`", phase: "design",
    asked: [],
    card: ["design/design.json", "shared/contract/api.json", "shared/contract/screens.json"],
    text: "Please propose a revision of the decisions of my design: the review asks for justified decisions. In Decisions, each decision says what it chose, the alternative it beat, why, and the trade-off weighed: D1 chose Filter and order on the API; render the returned order in the browser rather than downloading every task and filtering independently in the React hook, because the API can apply every filter to the complete set and one documented order prevents the list and overdue report from contradicting each other; trade-off: instant local refiltering without a request; the client must retain filters and handle loading or network failure. D2 chose Require today explicitly for the overdue endpoint rather than reading the server clock inside the repository, because a caller and its tests can reproduce exactly the same due-date boundary and days-overdue display; trade-off: one validated calendar-date parameter that every caller must supply. Keep every other section, entity, operation, decision and id exactly as it is.",
  },
  {
    name: "B: Implementation, cause `checks not passed: hidden-tests-api failed`", phase: "implementation",
    asked: ["api/repository/tasks.py", "api/routes/tasks.py"],
    card: ["api/repository/tasks.py", "api/routes/tasks.py"],
    text: "Please propose a revision of api/repository/tasks.py and api/routes/tasks.py, and return only these files: the review found the API's hidden tests failing. In api/repository/tasks.py and api/routes/tasks.py, check each rule the brief gives against the code: list_tasks adds a condition only for the filters it is given (status open or done narrows by status, all adds none, any other value raises ValueError; q matches anywhere in the title whatever the case; tag keeps the tasks with that tag), ordered by PRIORITY_ORDER and then id; overdue_tasks returns the open tasks whose due date is set and strictly earlier than the given day, most overdue first, then priority, then id; and the complete route answers 404 with task_not_found for an id no task has and returns a task that is already done unchanged. Keep every other function, name and docstring as they are. Change no other file.",
  },
  {
    name: "B: Implementation, cause `checks not passed: hidden-tests-web failed`", phase: "implementation",
    asked: ["web/src/hooks/useTasks.ts"],
    card: ["web/src/hooks/useTasks.ts"],
    text: "Please propose a revision of web/src/hooks/useTasks.ts, and return only this file: the review found the front end's hidden tests failing. In web/src/hooks/useTasks.ts, make useTasks send one request each time the list or a filter value changes: its effect depends on listId, status, q and tag, the values themselves, and not on the filters object, which is a new object on every render; it asks for the list's tasks through queryFor, so only the filters that are set reach the request; it keeps loading true while the request is out; and a failed request puts its message into error and keeps it there, never an empty list in its place, until the next request starts. Keep queryFor, reload and every other line of web/src/hooks/useTasks.ts and web/src/lib/overdue.ts as they are. Change no other file.",
  },
  {
    name: "B: Implementation, cause `checks not passed: hidden-tests failed` (both halves)", phase: "implementation",
    asked: ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/hooks/useTasks.ts"],
    card: ["api/repository/tasks.py", "api/routes/tasks.py", "web/src/hooks/useTasks.ts"],
    text: "Please propose a revision of api/repository/tasks.py, api/routes/tasks.py and web/src/hooks/useTasks.ts, and return only these files: the review found the API's and the front end's hidden tests failing. In api/repository/tasks.py and api/routes/tasks.py, check each rule the brief gives against the code: list_tasks adds a condition only for the filters it is given (status open or done narrows by status, all adds none, any other value raises ValueError; q matches anywhere in the title whatever the case; tag keeps the tasks with that tag), ordered by PRIORITY_ORDER and then id; overdue_tasks returns the open tasks whose due date is set and strictly earlier than the given day, most overdue first, then priority, then id; and the complete route answers 404 with task_not_found for an id no task has and returns a task that is already done unchanged. Keep every other function, name and docstring as they are. In web/src/hooks/useTasks.ts, make useTasks send one request each time the list or a filter value changes: its effect depends on listId, status, q and tag, the values themselves, and not on the filters object, which is a new object on every render; it asks for the list's tasks through queryFor, so only the filters that are set reach the request; it keeps loading true while the request is out; and a failed request puts its message into error and keeps it there, never an empty list in its place, until the next request starts. Keep queryFor, reload and every other line of web/src/hooks/useTasks.ts and web/src/lib/overdue.ts as they are. Change no other file.",
  },
  {
    name: "B: Maintenance, cause `unmet: change_request`", phase: "maintenance",
    asked: ["maintenance/change-request.json"],
    card: ["maintenance/change-request.json"],
    text: "Please propose a revision for the points the review raised: in maintenance/change-request.json set the release summary to \"2.1.0 adds comments on a task: listComments and addComment, and a comment count on every task row; no schema change is needed, because the comments table is already in api/schema.sql.\", so the release itself tells an upgrader what 2.1.0 adds and that it needs no schema change; set the why of C1 to \"listComments: CR-2 reads a task's comments, newest first, and answers 404 task_not_found for an unknown task, as design/contracts.json and shared/contract/api.json declare it.\" and the why of C2 to \"addComment: CR-2 adds a comment and answers 201 with it, 400 invalid_comment for a blank author or body, and 404 task_not_found for an unknown task, as design/contracts.json and shared/contract/api.json declare it.\", so each contract amendment names the operation design/contracts.json and shared/contract/api.json declare; and keep exactly two tests, T1 tests/test_comments_api.py and T2 web/src/components/TaskRow.test.tsx, each with result pass, and no test marked not-run, exactly the four impact files api/repository/comments.py, api/routes/comments.py, api/repository/tasks.py, web/src/components/TaskRow.tsx, exactly one risk, and the notes empty. Return only maintenance/change-request.json, whole, with the record's JSON as one text string, and no other file. Keep everything else exactly as it is.",
  },
  {
    name: "B: Maintenance, cause `checks static-analysis warning`", phase: "maintenance",
    asked: [],
    card: [],
    text: "Please propose a revision for the points the review raised: the review's static analysis has a finding: give each public function in the three Python files a one-line docstring and leave no TODO(learner) line. Keep everything else exactly as it is.",
  },
  {
    name: "B: The run fix, Implementation", phase: "implementation",
    asked: [],
    card: [],
    text: "Please propose a fix for what the last run shows (<n>/<t> tests passed): every visible test must pass, so fill the code the failing tests exercise as the brief and the docstrings say. Keep every test that passes exactly as it is, and change no file the failing tests do not point at.",
  },
  {
    name: "B: The run fix, Testing", phase: "testing",
    asked: [],
    card: [],
    text: "Please propose a fix for what the last run shows (<n>/<t> tests passed): every test in my suite must pass against the working application, and the suite needs at least <the phase minimum> tests; a test that fails on the working application is the test to fix, never the application. Keep every test that passes exactly as it is, and change no file the failing tests do not point at.",
  },
  {
    name: "B: The run fix, Maintenance", phase: "maintenance",
    asked: [],
    card: [],
    text: "Please propose a fix for what the last run shows (<n>/<t> tests passed): every regression test must pass, so the behaviour the earlier phases shipped stays as it was; the routes pass connect() to the repository as api/routes/tasks.py does and never close the connection. Keep every test that passes exactly as it is, and change no file the failing tests do not point at.",
  },
  {
    name: "B: The runbook check still failing", phase: "deployment",
    asked: [],
    card: ["deployment/runbook.json"],
    text: "Please propose a change to my runbook in the Runbook tab so that Check the runbook finds nothing missing: it still lists \"<the rule as Check the runbook lists it>\" (<its detail>). Write each entry for an operator who was not on the call, and keep every other section exactly as it is.",
  },
  {
    name: "B: The change-request check still failing", phase: "maintenance",
    asked: [],
    card: ["maintenance/change-request.json"],
    text: "Please propose a change to my change request so that Check the change request finds nothing missing: it still lists \"<the rule as Check the change request lists it>\" (<its detail>). Keep every other section exactly as it is.",
  },
  {
    name: "B: The config rules still failing (one message only)", phase: "deployment",
    asked: [],
    card: [],
    text: "Please propose <the file the rule targets> again, and return only this file: the room's rules still fail on \"<the rule as the room lists it>\": <its detail> Keep every other line exactly as it is, and change no other file.",
  },
  {
    name: "L.7 new (R1)", phase: "maintenance",
    asked: ["api/repository/tasks.py", "api/repository/comments.py", "api/routes/comments.py", "design/contracts.json"],
    card: ["api/repository/tasks.py", "api/repository/comments.py", "api/routes/comments.py", "design/contracts.json"],
    text: "Please propose code for CR-2's API side in api/repository/tasks.py, api/repository/comments.py, api/routes/comments.py and design/contracts.json, and return only these four files, keeping every other function, name and docstring, and leave no TODO(learner) line. Leave maintenance/change-request.json as it is: my third request fills it. In api/repository/tasks.py, replace the comment_count TODO in the task query with (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count, a subquery like tag_names so the query still returns one row per task, and in the row reader use record[\"comment_count\"] instead of 0. In api/repository/comments.py, list_comments first calls tasks.get_task(conn, task_id), which raises KeyError for an unknown task, then returns _to_comment of each row of COMMENT_SELECT + \" WHERE task_id = ? ORDER BY created_at DESC, id DESC\"; add_comment also calls get_task first, strips author and body, raises ValueError when either is empty, inserts (task_id, author, body, now()), commits and returns _to_comment of the row read back by its lastrowid. In api/routes/comments.py add GET /api/tasks/<int:task_id>/comments, 200 with the list, and POST on the same path reading request.get_json(silent=True) or {}, 201 with the comment; both answer 404 task_not_found \"No task has id {task_id}.\" on KeyError and the POST answers 400 invalid_comment \"A comment needs an author and a body.\" on ValueError, returned by fail(code, message, status); both pass connect() straight to the repository and never close the connection. Give each function you write a one-line docstring, the two route functions included. In design/contracts.json list two operations for CR-2: listComments(taskId), GET /api/tasks/{id}/comments returning Comment[] newest first, 404 task_not_found; and addComment(taskId, author, body), POST /api/tasks/{id}/comments returning the 201 Comment, 400 invalid_comment, 404 task_not_found. In your summary, name only the files this proposal changes.",
  },
]

const text = (name: string) => TEXTS.find(one => one.name === name)!.text;
const filesOf = (paths: readonly string[]) => Object.fromEntries(paths.map(path => [path, `${path}\n`]));
/** A field change, so a card holding a room document reads as that room's structured card. */
const someChange: FieldChange[] = [{ path: 'change/release/summary', before: '', after: 'Adds task comments.' }];

describe('the demo texts: exactly the paths each asks for', () => {
  test('the fixtures hold the 47 texts, each under its own name', () => {
    expect(TEXTS).toHaveLength(47);
    expect(new Set(TEXTS.map(one => one.name)).size).toBe(TEXTS.length);
  });

  test.each(TEXTS.map(one => [one.name, one] as const))('%s', (_name, one) => {
    expect(askedPaths(one.text, EDITABLE[one.phase])).toEqual(one.asked);
    // The card the script expects shows no "asked for, not in this proposal" line, and reads no file list.
    const files = filesOf(one.card);
    expect(missingAsked(files, one.text, EDITABLE[one.phase])).toEqual([]);
    expect(asksForPathNotHeld(one.text, one.card)).toBe(false);
    if (proposalKind(files, someChange) !== 'files') {
      const inventory = proposalInventory({ files, changes: someChange, request: one.text, workspace: EDITABLE[one.phase] });
      expect(inventory.filter(line => line.status === 'missing').map(line => line.path)).toEqual([]);
    }
  });
});

describe('the cards the review named', () => {
  test('the change-request revision on its change-request card: no missing line; the count is "1 document"', () => {
    const files = filesOf([CHANGE_REQUEST_JSON]);
    const inventory = proposalInventory({ files, changes: someChange, request: text('L.9'), workspace: EDITABLE.maintenance });
    expect(inventory.map(line => line.status)).toEqual(['changed']);
    expect(inventoryCount(inventory, inventoryNoun(inventory))).toBe('1 document');
  });

  test('the change_request revision on its change-request card: no missing line, not even the API contract it only cites', () => {
    const files = filesOf([CHANGE_REQUEST_JSON]);
    const inventory = proposalInventory({ files, changes: someChange, request: text('B: Maintenance, cause `unmet: change_request`'), workspace: EDITABLE.maintenance });
    expect(inventory.map(line => line.status)).toEqual(['changed']);
    expect(inventoryCount(inventory, inventoryNoun(inventory))).toBe('1 document');
  });

  test.each(['L.7', 'L.7 new (R1)'])('%s on the T6.6.2 card (the record and three code files): design/contracts.json is flagged, "4 files, 1 missing"', (name) => {
    const files = filesOf([CHANGE_REQUEST_JSON, 'api/repository/tasks.py', 'api/repository/comments.py', 'api/routes/comments.py']);
    expect(asksForPathNotHeld(text(name), Object.keys(files))).toBe(true);
    const inventory = proposalInventory({ files, changes: someChange, request: text(name), workspace: EDITABLE.maintenance });
    expect(inventory.filter(line => line.status === 'missing').map(line => line.path)).toEqual(['design/contracts.json']);
    expect(inventoryCount(inventory, inventoryNoun(inventory))).toBe('4 files, 1 missing');
  });

  test('W.7 on a card without the contract flags it; on the five-file card it brings, nothing is missing ("5 files")', () => {
    const four = filesOf([CHANGE_REQUEST_JSON, 'api/repository/tasks.py', 'api/repository/comments.py', 'api/routes/comments.py']);
    expect(missingAsked(four, text('W.7'), EDITABLE.maintenance).map(line => line.path)).toEqual(['design/contracts.json']);
    const five = { ...four, 'design/contracts.json': '{}' };
    expect(asksForPathNotHeld(text('W.7'), Object.keys(five))).toBe(false);
    const inventory = proposalInventory({ files: five, changes: someChange, request: text('W.7'), workspace: EDITABLE.maintenance });
    expect(inventory.some(line => line.status === 'missing')).toBe(false);
    expect(inventoryCount(inventory, inventoryNoun(inventory))).toBe('5 files');
  });

  test('a design-only card keeps "documents"; a card holding no code keeps its own noun', () => {
    const inventory = proposalInventory({ files: filesOf(['design/design.json', 'shared/contract/api.json']), changes: [], request: 'Please propose my design.', workspace: EDITABLE.design });
    expect(inventoryNoun(inventory)).toBe('document');
  });
});

describe('the file a change is to follow is not asked for', () => {
  const routes = 'api/routes/comments.py';
  const card = filesOf([routes]);
  // Each line on a card holding only api/routes/comments.py drew "design/contracts.json: asked for, not in this proposal" before.
  test.each([
    ['based on', `Please propose ${routes} based on design/contracts.json.`],
    ['according to', `Please fix ${routes} according to design/contracts.json, and nothing else.`],
    ['so it matches', `Please write ${routes} so it matches design/contracts.json.`],
    ['match', `Please write ${routes} to match design/contracts.json.`],
    ['in line with', `Please write ${routes} in line with design/contracts.json.`],
    ['consistent with', `Please write ${routes} consistent with the design/contracts.json file.`],
    ['per', `Please write ${routes} per design/contracts.json.`],
    ['against', `Please check ${routes} against design/contracts.json.`],
    ['following', `Please write ${routes} following design/contracts.json.`],
    ['using', `Please write ${routes} using design/contracts.json.`],
    ['using … from', `Please update ${routes} using the operations from design/contracts.json.`],
    ['a list after the pointer', `Please write ${routes} based on design/contracts.json and shared/contract/api.json.`],
  ])('%s', (_phrase, request) => {
    expect(askedPaths(request, EDITABLE.maintenance)).toEqual([routes]);
    expect(missingAsked(card, request, EDITABLE.maintenance)).toEqual([]);
    expect(asksForPathNotHeld(request, [routes])).toBe(false);
  });

  test('instead of: the path it replaces is not asked for', () => {
    const request = 'Please update design/contracts.json instead of shared/contract/api.json.';
    expect(askedPaths(request, EDITABLE.maintenance)).toEqual(['design/contracts.json']);
    expect(missingAsked(filesOf(['design/contracts.json']), request, EDITABLE.maintenance)).toEqual([]);
  });

  test('a bare "from" stays asked for: "remove X from Y" asks for Y', () => {
    const request = 'Please remove the comment_count TODO from api/repository/tasks.py.';
    expect(askedPaths(request, EDITABLE.maintenance)).toEqual(['api/repository/tasks.py']);
    expect(missingAsked(card, request, EDITABLE.maintenance).map(line => line.path)).toEqual(['api/repository/tasks.py']);
  });
});

describe('a reference word points only where it really points', () => {
  const routes = 'api/routes/comments.py';
  const repository = 'api/repository/comments.py';
  // Each of these asks for a file the card does not hold; before the change the card said nothing.
  test.each([
    ['the following file X', 'Please update the following file api/routes/comments.py.', [routes], [repository], [routes]],
    ['the following X and Y', 'Please update the following api/routes/comments.py and api/repository/comments.py.', [routes, repository], ['design/contracts.json'], [routes, repository]],
    ['the matching X change', 'Please propose the matching api/repository/comments.py change.', [repository], [routes], [repository]],
    ['a matching X', 'Please propose a matching api/repository/comments.py change.', [repository], [routes], [repository]],
    ['the tests against X', 'Please write the tests against api/routes/comments.py.', [routes], [repository], [routes]],
    ['a test against X', 'Please add a test against api/routes/comments.py.', [routes], [repository], [routes]],
    ['X per Y and Z too', `Please propose ${routes} per design/contracts.json and ${repository} too.`, [routes, repository], [routes], [repository]],
    ['X per Y, and Z as well', `Please propose ${routes} per design/contracts.json, and ${repository} as well.`, [routes, repository], [routes], [repository]],
  ] as const)('%s is asked for', (_phrase, request, asked, card, missing) => {
    expect(askedPaths(request, EDITABLE.maintenance)).toEqual(asked);
    expect(missingAsked(filesOf(card), request, EDITABLE.maintenance).map(line => line.path)).toEqual(missing);
    expect(asksForPathNotHeld(request, card)).toBe(true);
  });

  // Each of these only points at the file to follow; a card holding only api/routes/comments.py says nothing.
  test.each([
    ['following X', `Please write ${routes} following design/contracts.json.`],
    ['following the pattern in X', `Please write ${routes} following the pattern in design/contracts.json.`],
    ['using the same structure used in X', `Please write ${routes} using the same structure used in design/contracts.json.`],
    ['matching X', `Please write ${routes} matching design/contracts.json.`],
    ['checked against X', `Please propose ${routes}, checked against design/contracts.json.`],
    ['check X against Y', `Please check ${routes} against design/contracts.json.`],
    ['test X against Y', `Please test ${routes} against design/contracts.json.`],
    ['as per X', `Please write ${routes} as per design/contracts.json.`],
    ['per X', `Please write ${routes} per design/contracts.json.`],
    ['per Y and Z, in doubt', `Please write ${routes} per design/contracts.json and shared/contract/api.json.`],
    ['based on Y and Z, in doubt', `Please write ${routes} based on design/contracts.json and shared/contract/api.json.`],
  ])('%s stays a pointer', (_phrase, request) => {
    expect(askedPaths(request, EDITABLE.maintenance)).toEqual([routes]);
    expect(missingAsked(filesOf([routes]), request, EDITABLE.maintenance)).toEqual([]);
    expect(asksForPathNotHeld(request, [routes])).toBe(false);
  });

  test('"too" ends only a reference word\'s list: "do not change a and b too" asks for neither', () => {
    const request = `Please propose ${routes} and do not change design/contracts.json and ${repository} too.`;
    expect(askedPaths(request, EDITABLE.maintenance)).toEqual([routes]);
    expect(missingAsked(filesOf([routes]), request, EDITABLE.maintenance)).toEqual([]);
  });
});
