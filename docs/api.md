# HTTP API

LearnSDLC's web app talks to its API over HTTP and JSON, and nothing else does anything the API does not allow. This page is for someone writing a client, or reading the code behind a screen: how a session works, the main resources, the refusals a client must handle, the rate limits and the health endpoints. It ends with a table of every route.

The routes are defined by the controllers in `apps/api/src/<area>/*.controller.ts`, and the response types by `packages/shared/src/contract/`, which the web app imports too. The [architecture page](architecture.md) shows how a request travels from the browser to the database.

## The basics

- **Base address.** Every route is under `/api/v1` on the API's origin: `http://localhost:4000/api/v1` for `npm run demo`, `http://localhost:4080/api/v1` for the local Docker stack, and `https://$API_HOST/api/v1` behind `docker-compose.yml`. The one exception is `GET /metrics`, at the origin's root.
- **JSON.** Requests and answers are JSON (`content-type: application/json`), except the files a few routes hand out (CSV, `.zip`). A request body may be up to 4 MB; a class import and a project upload have larger limits of their own ([configuration](configuration.md#content-and-classes)).
- **Unknown fields are dropped.** The API validates every body against a declared shape and removes any field the shape does not name before the handler sees it.
- **Browsers.** Only the origins in `WEB_ORIGIN` may call the API with credentials. Browser scripts can read three response headers: `x-request-id`, `x-cohort-import-max-bytes` (the largest class import this installation takes) and `x-export-withheld` (how many files a repository export left out).
- **Request ids.** Every answer carries an `x-request-id` header. The API's log line for that request carries the same id (`rid=`), so quote it when you report a failure.

## How a session works

1. `POST /api/v1/auth/register` (a learner account) or `POST /api/v1/auth/login` answers `{ token, user }`. `user` is the profile; `token` is a JSON Web Token signed with the installation's `JWT_SECRET`.
2. Send the token on every other request as `Authorization: Bearer <token>`. It lasts `JWT_EXPIRES_IN` (seven days by default).
3. Every request checks the token against the account as it is now, not as it was when the token was signed. Changing the password, a suspension, a role change, deleting the account and `POST /api/v1/auth/logout` each end every session of that account from its next request, on every API process.
4. A `401` means the session is over: send the person to sign in again. The web app does this, and keeps where they were.

Sign-in answers `401 invalid email or password` for a wrong password, for an account locked after ten failed attempts in fifteen minutes, and, on an installation that other machines can reach, for a demo account still using a password this repository publishes. The three are told apart only in the API's log, on purpose.

Other ways in, when the installation turns them on (`GET /api/v1/auth/providers` says which):

- **Google.** The browser navigates (not a `fetch`) to `/api/v1/auth/google?next=<path>`; Google returns it to `/api/v1/auth/google/callback`, which hands the web app a session.
- **Amazon Cognito** (`AUTH_PROVIDER=cognito`). The browser navigates to `/api/v1/auth/sso/start`. These sessions last three hours, so a client asks `POST /api/v1/auth/renew` for a fresh token while the person is working; the web app does this when less than two hours are left.

There are three roles: `LEARNER`, `INSTRUCTOR` and `ADMIN`. A route is public, open to any signed-in account, or limited to some roles; the table below says which. A learner's own routes still check that the record is the caller's.

## Live updates

The API also serves Socket.IO on its origin. Connect with the token in the handshake (`auth: { token }`); a socket without a valid token is closed, and it is closed again when the session ends or the token expires. Two events reach the account's own sockets:

- `job.update`: a run or a submission moved on (queued, running, completed, failed).
- `notification.new`: a new row in the account's notification bell.

Polling the REST routes is always correct; the socket only makes the answer arrive sooner.

## The main resources

- **Projects and enrolments.** A project is a pack of six phases (`GET /projects`, `GET /projects/:slug`). A learner is enrolled in one project version (`POST /enrollments`, `GET /enrollments/mine`), usually the one their class is assigned.
- **Phase states.** In every `/phases/:id/...` route, `:id` is the id of the learner's own *phase state*: their copy of one phase, with its workspace, its tasks and its gate. `GET /phases/:id` answers the phase as the learner sees it; `GET /phases/summaries` and `GET /phases/records` answer every open phase in one request.
- **The workspace.** `PUT /phases/:id/workspace` saves files, `{ files, baseVersion }`. Send back the `version` the last save or read answered as `baseVersion`; if the stored copy has moved on since, the save is refused with `409` (below) and nothing is overwritten. A save without `baseVersion` is written unconditionally.
- **Runs and submissions.** `POST /phases/:id/run` runs the visible checks. `POST /phases/:id/submit` (or `/tasks/:taskKey/submit` for one task) answers at once with a submission whose `status` is `queued`; grading happens on the job queue. Follow it with `GET /submissions/:id` or the `job.update` event until it is `completed` or `failed`. Learner code runs only where the server can isolate it; where it cannot, a run comes back with the outcome `unavailable` and a sentence saying so, and no attempt is spent.
- **The assistant.** The mentor (`POST /assistant/chat`), the stakeholder interview, and the Agentic assistant, which proposes a change (`/agent/propose`), takes the learner's explanation of it (`/explain`) and applies it only once the explanation is accepted (`/apply`). Each answer is checked before it is returned; nothing is streamed.
- **Classes.** An instructor creates a class (`POST /instructor/cohorts`) and hands out its join code; a learner joins with `POST /enrollments/join`. The console's routes are under `/instructor`, and the "view as learner" reads mirror the learner's own under `/instructor/learners/:userId/...`.
- **Authoring.** A teacher's own projects, drafts, versions, tasks and sealed files are under `/instructor/projects`; `POST /instructor/projects/upload` takes a whole project as a `.zip`. The [teacher upload guide](teacher-project-upload.md) and the [authoring format](authoring-format.md) describe the content.
- **Administration.** Accounts and class ownership, under `/admin`.

## Refusals a client must handle

A refusal has the same shape as every NestJS error:

```json
{ "statusCode": 409, "message": "a sentence for the person", "error": "Conflict" }
```

`message` is written to be shown as it is. After a failed validation it is an array of sentences; the web app joins them with `"; "`. Some refusals add fields of their own, named below. Read the status and those fields, not the wording, which may change.

| Status | When | What the client does |
|---|---|---|
| `400` | The body or a query failed validation, or an id is malformed. A project upload's refusal also carries `code`, `sentence` and `findings`. | Show `message`. Do not retry unchanged. |
| `401` | No token, an expired or ended session, or a failed sign-in. | Sign in again. |
| `403` | The role cannot use this route, or the record is not the caller's (`not your phase`), or an instructor's read-only view tried to write. | Show `message`. |
| `404` | No such record, or one the caller may not know exists (another class's learner, another learner's notification). | Treat as gone. |
| `409` | A conflict with the stored state. The workspace save answers `{ error: "workspace_changed", message, version, files }`: `version` is the stored version and `files` the stored copy of the paths you tried to save, so the client can show what it would have overwritten and retry against `version`. | Reconcile, then retry. |
| `413` | A class import or project upload over its limit, with a sentence giving both sizes. | Show `message`. |
| `429` | A rate limit (below). | Wait and retry. No `Retry-After` header is sent; the windows are a minute or a few minutes long. |
| `503` | Capacity, not a fault: the code runner is busy with the rest of the class, or the AI is (`code: "AI_BUSY"`), or the AI is not configured or did not answer. The learner's work is saved and no attempt is spent. | Show `message`; retry later. |
| `5xx` | An unexpected failure. The body adds `requestId`, the same as the `x-request-id` header. | Show the reference to the person. |

Without an AI key, the mentor and the Agentic assistant answer `503` saying the AI is not configured, and a submission's AI review is recorded as unavailable, which never turns into a pass.

## Rate limits

Routes that cost something carry a limit, written on the route (`@RateLimit` in `apps/api/src/auth/rate-limit.guard.ts`) and shown in the table. A limit counts requests per signed-in account, or per network address when there is no session, in a window of a minute or more; the teacher console's routes share a rule of 60 a minute per teacher. Sign-in and registration count per account typed and per network address together: a class behind one router shares an address, so the address limit (`SIGNIN_MAX_PER_ADDRESS`, 200 a minute) is room-sized and the account limit is what stops a password being guessed. With `REDIS_URL` set, every API process shares one count; without it each process counts on its own. Past a limit the answer is `429`.

The network address is the one `TRUSTED_PROXIES` produces, so set that to the number of proxies in front of the API ([configuration](configuration.md#addresses-and-ports)).

## Health endpoints

| Route | Answers |
|---|---|
| `GET /api/v1/health` | `200` while the process runs: `{ status: "ok", aiProvider, time }`. `aiProvider` is `openai`, `local-ai:<model>` (a server on this machine, the test mentor among them), `compatible-ai:<model>` or `unavailable` (no key). |
| `GET /api/v1/health/live` | `200` while the process is not wedged; touches nothing. Point a liveness probe here. |
| `GET /api/v1/health/ready` | `200` when every check passes, `503` otherwise, with one entry per check: `database`, `queue`, `runner`, `prebake`, `content`, `content-compiler` and `isolation`. `status` is `ok`, `degraded` (only checks that are not required failed) or `down`. Point a readiness probe here. With `Authorization: Bearer $METRICS_TOKEN` it also names the projects and the runner's socket or function; without it, counts only. |
| `GET /metrics` | Prometheus text. Needs `Authorization: Bearer $METRICS_TOKEN` when the token is set; without one it is open outside production and off in production. |

The [production runbook](production-runbook.md#4--verify-a-deployment) explains each check and the metrics.

## Every route

The table below lists all 192 routes the API mounts. It was generated from the decorators of the controllers that `apps/api/src/app.module.ts` mounts (`apps/api/src/**/*.controller.ts`): the method and path (`@Controller`, `@Get` and the rest), who may call it (`@Public`, `@Roles`) and the rate limit (`@RateLimit`, `@ConsoleRateLimit`). The purposes were written from each handler. When you add or change a route, change its row; `apps/api/src/route-table.spec.ts` shows how to read the mounted routes from the same decorators.

"Signed in" means any role. A limit counts per signed-in account, or per network address on a public route; "per account" means per address typed into the form. `ALL` answers every method.

### Health and metrics

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/health` | public |  | Up, the AI provider in use, and the server's time. |
| GET | `/api/v1/health/live` | public |  | Liveness: the process answers. Touches nothing. |
| GET | `/api/v1/health/ready` | public |  | Readiness: every dependency check; 200 when all pass, 503 otherwise. |
| GET | `/metrics` | public |  | Prometheus metrics, at the root rather than under `/api/v1`; needs `METRICS_TOKEN` when one is set, and is off in production without one. |

### Sign-in and your account

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| DELETE | `/api/v1/account` | signed in | 5 per 5 min | Delete your own account; the body repeats the account's address. |
| GET | `/api/v1/account/export` | signed in | 5 per minute | Everything stored about you, as one JSON document. |
| POST | `/api/v1/account/password` | signed in | 5 per 5 min | Change your own password. |
| PATCH | `/api/v1/account/profile` | signed in |  | Change your display name, avatar and profile. |
| POST | `/api/v1/auth/cognito/migrate` | public | 10 per minute per account, 120 per minute per network address | Called by the Cognito trigger to migrate an existing account; signed by the trigger, not by a session. |
| POST | `/api/v1/auth/confirm` | public | 10 per 15 min per account, 200 per minute per network address | Confirm a managed (Cognito) registration with its code. |
| POST | `/api/v1/auth/confirm/resend` | public | 5 per 15 min per account, 200 per minute per network address | Send the managed registration code again. |
| POST | `/api/v1/auth/forgot` | public | 10 per 15 min | Send a password reset link; answers the same whether or not the address exists. |
| GET | `/api/v1/auth/google` | public | 200 per minute | Start a Google sign-in (a browser navigation). |
| GET | `/api/v1/auth/google/callback` | public | 200 per minute | Where Google returns the browser. |
| POST | `/api/v1/auth/login` | public | 30 per minute per account, 200 per minute per network address | Sign in with address and password; answers a token and the profile. |
| POST | `/api/v1/auth/logout` | signed in | 30 per minute | Sign out every session of this account. |
| GET | `/api/v1/auth/me` | signed in |  | The signed-in account's profile. |
| GET | `/api/v1/auth/providers` | public |  | Which sign-in methods this installation offers. |
| POST | `/api/v1/auth/register` | public | 10 per minute per account, 200 per minute per network address | Create a learner account. |
| POST | `/api/v1/auth/renew` | signed in | 30 per minute | A fresh token for the current session. |
| POST | `/api/v1/auth/reset` | public | 10 per 15 min | Set a new password with a reset link's token. |
| GET | `/api/v1/auth/sso/callback` | public | 200 per minute | Where the Cognito hosted sign-in returns the browser. |
| GET | `/api/v1/auth/sso/signout` | public | 200 per minute | The last step of a Cognito sign-out. |
| GET | `/api/v1/auth/sso/start` | public | 200 per minute | Start a Cognito hosted sign-in (a browser navigation). |
| POST | `/api/v1/auth/verify` | public | 20 per 15 min | Confirm your address with a verification link's token. |
| POST | `/api/v1/auth/verify/request` | signed in | 5 per hour | Send a new verification mail. |
| GET | `/api/v1/auth/verify/status` | signed in |  | Whether your address is confirmed. |

### Administration

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/admin/cohorts` | admin | 60 per minute | Every class with its size, code and owner. |
| PATCH | `/api/v1/admin/cohorts/:id/owner` | admin | 60 per minute | Move a class to another instructor. |
| GET | `/api/v1/admin/users` | admin | 60 per minute | Look an account up by exact address. |
| PATCH | `/api/v1/admin/users/:id` | admin | 60 per minute | Change an account's role or class, or suspend or restore it. |
| POST | `/api/v1/admin/users/:id/password` | admin | 5 per 5 min | Set another account's password. |
| GET | `/api/v1/demo/clock` | signed in | 120 per minute | The demo clock's state; administrators only, and only with `DEMO_CLOCK=true` outside production. |
| POST | `/api/v1/demo/clock` | signed in | 120 per minute | Move or reset the demo clock; the same conditions. |

### The assistant

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/assistant/chat` | signed in | 20 per minute | Ask the phase mentor a question. |
| GET | `/api/v1/assistant/history/:phaseStateId` | signed in |  | Your mentor conversation in one phase. |
| POST | `/api/v1/phases/:id/agent/chat` | signed in | 8 per minute | Ask the Agentic assistant a question about the phase. |
| GET | `/api/v1/phases/:id/agent/proposals` | signed in |  | Your Agentic proposals in this phase. |
| GET | `/api/v1/phases/:id/agent/proposals/:proposalId` | signed in |  | One proposal. |
| POST | `/api/v1/phases/:id/agent/proposals/:proposalId/apply` | signed in | 10 per minute | Apply an approved proposal to your workspace. |
| POST | `/api/v1/phases/:id/agent/proposals/:proposalId/edit` | signed in | 20 per minute | Edit a proposal before explaining it; clears its approval. |
| POST | `/api/v1/phases/:id/agent/proposals/:proposalId/explain` | signed in | 10 per minute | Explain a proposal in your own words; approved only if the explanation shows understanding. |
| POST | `/api/v1/phases/:id/agent/propose` | signed in | 8 per minute | Ask the Agentic assistant to propose a change. |
| GET | `/api/v1/phases/:id/agent/turns` | signed in |  | The Agentic conversation in this phase. |
| GET | `/api/v1/phases/:id/agent/turns/:requestId` | signed in |  | One Agentic turn, for a client polling a slow one. |
| POST | `/api/v1/phases/:id/explain-test` | signed in | 10 per minute | Ask the mentor to explain a failing test. |
| GET | `/api/v1/phases/:id/interview` | signed in |  | The stakeholder interview's state. |
| POST | `/api/v1/phases/:id/interview/ask` | signed in | 20 per minute | Ask the stakeholder a question. |
| GET | `/api/v1/phases/:id/lesson/mentor` | signed in |  | The lesson mentor conversation. |
| POST | `/api/v1/phases/:id/lesson/mentor` | signed in | 20 per minute | Ask the lesson mentor a question. |
| GET | `/api/v1/phases/:id/stuck` | signed in |  | Your stuck flag in this phase. |
| POST | `/api/v1/phases/:id/stuck` | signed in | 5 per 5 min | Tell your instructor you are stuck. |
| POST | `/api/v1/phases/:id/stuck/clear` | signed in | 10 per minute | Clear your stuck flag. |

### Live preview

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| DELETE | `/api/v1/phases/:id/preview` | signed in | 20 per minute | Stop your live preview. |
| GET | `/api/v1/phases/:id/preview` | signed in | 60 per minute | Your live preview's state. |
| POST | `/api/v1/phases/:id/preview` | signed in | 6 per minute | Start your application in a live preview. |
| ALL | `/api/v1/preview/:capability` | public |  | The live preview door: your application, behind an unguessable capability instead of a session. |
| ALL | `/api/v1/preview/:capability/*previewPath` | public |  | The same door, for any path under it. |

### Authoring projects

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/instructor/projects` | instructor, admin | 60 per minute | The projects you can see and author. |
| POST | `/api/v1/instructor/projects` | instructor, admin | 30 per minute | Create a project of your own as a copy of a published version. |
| GET | `/api/v1/instructor/projects/:projectId` | instructor, admin | 60 per minute | One project with its versions. |
| PATCH | `/api/v1/instructor/projects/:projectId` | instructor, admin | 30 per minute | Change a project's title, tagline and description. |
| POST | `/api/v1/instructor/projects/:projectId/archive` | instructor, admin | 10 per minute | Archive a project. |
| POST | `/api/v1/instructor/projects/:projectId/versions` | instructor, admin | 10 per minute | Open the next draft from the published version. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId` | instructor, admin | 60 per minute | One version or draft. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/deep-validation` | instructor, admin | 60 per minute | The state of a draft's deep validation. |
| POST | `/api/v1/instructor/projects/:projectId/versions/:versionId/deep-validation` | instructor, admin | 10 per minute | Start deep validation: the reference answer and hidden suites run through the runner. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/export` | instructor, admin | 10 per minute | One version as an archive, for its owner. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/files` | instructor, admin | 60 per minute | A version's files. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/learner-preview` | instructor, admin | 20 per minute | The version as a learner would first see it. |
| DELETE | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey` | instructor, admin | 30 per minute | Remove a phase from a draft. |
| PATCH | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey` | instructor, admin | 30 per minute | Change a phase's introduction. |
| POST | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey` | instructor, admin | 30 per minute | Add an empty phase to a draft. |
| PUT | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/files` | instructor, admin | 30 per minute | Replace one file of a written phase in a draft. |
| POST | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/restore` | instructor, admin | 30 per minute | Put a removed phase back from the version the draft was opened from. |
| PUT | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/task-order` | instructor, admin | 30 per minute | Reorder a phase's tasks. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks` | instructor, admin | 60 per minute | A phase's tasks. |
| POST | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks` | instructor, admin | 30 per minute | Add a task to a phase. |
| DELETE | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey` | instructor, admin | 30 per minute | Remove a task. |
| PATCH | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey` | instructor, admin | 30 per minute | Change a task. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/quiz/key` | instructor, admin | 20 per minute | A quiz's answer key, for the owner; every read writes an audit row. |
| PUT | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/required` | instructor, admin | 30 per minute | Mark a task required or optional. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/sealed` | instructor, admin | 20 per minute | A sealed file (hidden tests, reference answer), for the owner; every read writes an audit row. |
| PUT | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/sealed` | instructor, admin | 30 per minute | Write a sealed file of an executable task. |
| DELETE | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/requirements/interview` | instructor, admin | 30 per minute | Remove the stakeholder interview from a draft. |
| GET | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/requirements/interview` | instructor, admin | 20 per minute | The stakeholder interview with its answers, for the owner; every read writes an audit row. |
| PUT | `/api/v1/instructor/projects/:projectId/versions/:versionId/phases/requirements/interview` | instructor, admin | 30 per minute | Write the stakeholder interview. |
| POST | `/api/v1/instructor/projects/:projectId/versions/:versionId/publish` | instructor, admin | 10 per minute | Publish a draft as a version. |
| POST | `/api/v1/instructor/projects/:projectId/versions/:versionId/validate` | instructor, admin | 30 per minute | Check a draft and list what would stop it publishing. |
| POST | `/api/v1/instructor/projects/upload` | instructor, admin | 5 per minute | Upload a project archive (`.zip`, base64 in JSON) as a new draft. |
| GET | `/api/v1/instructor/runtime-profile` | instructor, admin | 60 per minute | The language runtime this installation runs learner code with. |
| GET | `/api/v1/instructor/starter/:name` | instructor, admin | 20 per minute | The starter project or the example project as a `.zip`. |

### Classes and the teacher console

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/enrollments/classroom` | learner |  | The class you belong to. |
| POST | `/api/v1/enrollments/join` | learner | 10 per minute | Join a class with its join code. |
| POST | `/api/v1/enrollments/leave` | learner |  | Leave your class. |
| GET | `/api/v1/instructor/audit` | instructor, admin | 60 per minute | The audit trail of your class, newest first. |
| GET | `/api/v1/instructor/class-map` | instructor, admin | 60 per minute | The class as its artefacts, phase by phase. |
| GET | `/api/v1/instructor/cohorts` | instructor, admin |  | The classes you own. |
| POST | `/api/v1/instructor/cohorts` | instructor, admin | 60 per minute | Create a class and its join code. |
| GET | `/api/v1/instructor/cohorts/:cohortId/export.json` | instructor, admin | 3 per minute | A whole class as one file, to move it to another machine. |
| GET | `/api/v1/instructor/cohorts/:cohortId/project` | instructor, admin | 60 per minute | The project a class is assigned. |
| PUT | `/api/v1/instructor/cohorts/:cohortId/project` | instructor, admin | 60 per minute | Assign a project to a class. |
| GET | `/api/v1/instructor/cohorts/:cohortId/project/assignable` | instructor, admin | 60 per minute | The projects this class could be assigned. |
| GET | `/api/v1/instructor/cohorts/:cohortId/schedule` | instructor, admin | 60 per minute | The class's release and due dates. |
| PUT | `/api/v1/instructor/cohorts/:cohortId/schedule` | instructor, admin | 20 per minute | Set the class's release and due dates. |
| POST | `/api/v1/instructor/cohorts/:cohortId/signoff` | instructor, admin | 10 per minute | Sign off one task for many learners at once, with one reason. |
| GET | `/api/v1/instructor/cohorts/:cohortId/signoff-queue` | instructor, admin | 60 per minute | The submissions waiting for your sign-off. |
| POST | `/api/v1/instructor/cohorts/import` | instructor, admin | 10 per minute | Bring a class in from an export file, or check what that would do (`?dryRun=true`). |
| GET | `/api/v1/instructor/export.csv` | instructor, admin | 5 per minute | The whole class as a CSV. |
| GET | `/api/v1/instructor/gradebook.csv` | instructor, admin | 5 per minute | The grade book: one row per learner, one column per phase. |
| GET | `/api/v1/instructor/lab` | instructor, admin | 30 per minute | The join link and QR code for each class you own. |
| GET | `/api/v1/instructor/learners` | instructor, admin | 60 per minute | A page of your class, one learner per row. |
| GET | `/api/v1/instructor/learners/:userId` | instructor, admin | 60 per minute | One learner's detail. |
| GET | `/api/v1/instructor/learners/:userId/analytics` | instructor, admin | 60 per minute | View as learner: their progress figures. |
| GET | `/api/v1/instructor/learners/:userId/assistant/:phaseStateId` | instructor, admin | 60 per minute | View as learner: their mentor conversation in one phase. |
| GET | `/api/v1/instructor/learners/:userId/dossier` | instructor, admin | 10 per minute | A learner's whole project as one document; every read writes an audit row. |
| GET | `/api/v1/instructor/learners/:userId/enrollment` | instructor, admin | 60 per minute | View as learner: their enrolment. |
| POST | `/api/v1/instructor/learners/:userId/note` | instructor, admin | 30 per minute | Send a learner in your class a note in their bell. |
| GET | `/api/v1/instructor/learners/:userId/phases/:phaseStateId` | instructor, admin | 60 per minute | View as learner: one phase. |
| POST | `/api/v1/instructor/learners/:userId/phases/:phaseStateId/override` | instructor, admin | 60 per minute | Override a phase's gate, reopen it, or reset its work, with a reason. |
| GET | `/api/v1/instructor/learners/:userId/phases/:phaseStateId/runs` | instructor, admin | 60 per minute | View as learner: a phase's runs. |
| GET | `/api/v1/instructor/learners/:userId/phases/:phaseStateId/submissions` | instructor, admin | 60 per minute | View as learner: a phase's submissions. |
| GET | `/api/v1/instructor/learners/:userId/phases/:phaseStateId/tasks/:taskKey/submissions` | instructor, admin | 60 per minute | View as learner: one task's submissions. |
| GET | `/api/v1/instructor/learners/:userId/phases/records` | instructor, admin | 60 per minute | View as learner: every open phase's records, without their mentor thread. |
| GET | `/api/v1/instructor/learners/:userId/phases/summaries` | instructor, admin | 60 per minute | View as learner: every open phase in summary. |
| GET | `/api/v1/instructor/learners/:userId/projects/:slug/map` | instructor, admin | 30 per minute | View as learner: their project map. |
| POST | `/api/v1/instructor/learners/:userId/view` | instructor, admin | 20 per minute | Start viewing as a learner; writes one audit row. |
| GET | `/api/v1/instructor/notes` | instructor, admin | 60 per minute | Your class notes. |
| POST | `/api/v1/instructor/notes` | instructor, admin | 30 per minute | Write a class note. |
| DELETE | `/api/v1/instructor/notes/:id` | instructor, admin | 30 per minute | Delete a class note. |
| PATCH | `/api/v1/instructor/notes/:id` | instructor, admin | 30 per minute | Change a class note. |
| GET | `/api/v1/instructor/overview` | instructor, admin | 60 per minute | The class overview; `?project=` narrows it to one project. |
| GET | `/api/v1/instructor/quiz-results/attempts.csv` | instructor, admin | 5 per minute | Quiz results: every attempt, as CSV. |
| GET | `/api/v1/instructor/quiz-results/class.csv` | instructor, admin | 5 per minute | Quiz results: the class summary, as CSV. |
| GET | `/api/v1/instructor/quiz-results/learners.csv` | instructor, admin | 5 per minute | Quiz results: one row per learner, as CSV. |
| GET | `/api/v1/instructor/quiz-results/learning-gain` | instructor, admin | 20 per minute | Before and after learning gain per phase. |
| GET | `/api/v1/instructor/quiz-results/learning-gain.csv` | instructor, admin | 5 per minute | The learning gain, as CSV. |
| GET | `/api/v1/instructor/quiz-results/questions.csv` | instructor, admin | 5 per minute | Quiz results: one row per question, as CSV. |
| GET | `/api/v1/instructor/quiz-results/summary` | instructor, admin | 20 per minute | One class's quiz results for the dashboard. |
| POST | `/api/v1/instructor/regrades` | instructor, admin | 3 per 5 min | Start a regrade of one phase for a class. |
| GET | `/api/v1/instructor/regrades/:id` | instructor, admin | 60 per minute | A regrade's progress. |
| POST | `/api/v1/instructor/regrades/preview` | instructor, admin | 10 per minute | What a regrade would do, without doing it. |
| GET | `/api/v1/instructor/rubrics/:slug` | instructor, admin | 60 per minute | A project's rubrics. |
| GET | `/api/v1/instructor/stuck` | instructor, admin | 60 per minute | The learners in your class who are stuck. |
| POST | `/api/v1/instructor/stuck/:phaseStateId/answer` | instructor, admin | 60 per minute | Answer a learner's stuck flag. |
| GET | `/api/v1/submissions/:id/sign-off` | signed in |  | The teacher's sign-off of a submission and its reason. |
| GET | `/api/v1/submissions/:id/teacher-evidence` | instructor, admin |  | The evidence a teacher reviews for a submission. |
| GET | `/api/v1/submissions/:id/teacher-feedback` | signed in |  | The teacher's comments on a submission. |
| POST | `/api/v1/submissions/:id/teacher-feedback` | instructor, admin | 30 per minute | Comment on a learner's submission. |
| GET | `/api/v1/submissions/learner-history/:userId` | instructor, admin |  | A learner's review history, page by page. |
| GET | `/api/v1/submissions/review-history/pages` | learner |  | Your own review history, page by page. |

### Projects, phases and your work

| Method | Path | Who | Limit | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/analytics/me` | signed in |  | Your own progress figures, optionally for one project. |
| POST | `/api/v1/enrollments` | signed in |  | Start the project you have been given. |
| GET | `/api/v1/enrollments/mine` | signed in |  | Your enrolments. |
| GET | `/api/v1/notifications` | signed in | 120 per minute | Your unread notifications, newest first, and the unread count. |
| POST | `/api/v1/notifications/:id/read` | signed in | 120 per minute | Mark one notification read. |
| POST | `/api/v1/notifications/read-all` | signed in | 30 per minute | Mark every notification read. |
| GET | `/api/v1/phases/:id` | signed in |  | One phase: its brief, files, tasks and state. `?view=summary` leaves out the file bodies. |
| POST | `/api/v1/phases/:id/advance` | signed in |  | Move on from a passed phase to the next. |
| PUT | `/api/v1/phases/:id/clock` | signed in | 30 per minute | Pin the date this phase's runs see, or clear it. |
| GET | `/api/v1/phases/:id/concept-quizzes` | signed in |  | The phase's before and after concept checks. |
| POST | `/api/v1/phases/:id/drill/health` | signed in | 10 per minute | Deployment drill: run the health check against your saved work. |
| POST | `/api/v1/phases/:id/drill/resolve` | signed in | 6 per minute | Deployment drill: close the incident with your write-up. |
| POST | `/api/v1/phases/:id/drill/start` | signed in | 6 per minute | Deployment drill: start the incident. |
| PUT | `/api/v1/phases/:id/links` | signed in |  | Replace the phase's links (the whole set). |
| POST | `/api/v1/phases/:id/reflect` | signed in |  | Save the merge reflection. |
| GET | `/api/v1/phases/:id/reset` | signed in | 60 per minute | What retrying this phase would do. |
| POST | `/api/v1/phases/:id/reset` | signed in | 20 per minute | Retry the phase's only task. |
| POST | `/api/v1/phases/:id/run` | signed in | 30 per minute | Run your code against the visible checks. |
| GET | `/api/v1/phases/:id/runs` | signed in |  | Every run in this phase, oldest first. |
| GET | `/api/v1/phases/:id/solution` | signed in | 20 per minute | The reference solution beside your work, once the phase has passed. |
| GET | `/api/v1/phases/:id/submissions` | signed in |  | Every submission in this phase, oldest first, without file snapshots. |
| POST | `/api/v1/phases/:id/submit` | signed in | 20 per minute | Submit the phase for grading; answers at once and grades on the queue. |
| GET | `/api/v1/phases/:id/tasks/:taskKey/quiz` | signed in |  | A quiz task as the learner sees it. |
| POST | `/api/v1/phases/:id/tasks/:taskKey/quiz/attempts` | signed in | 30 per minute | Draw a quiz paper, or get the one already open. |
| POST | `/api/v1/phases/:id/tasks/:taskKey/quiz/attempts/:attemptId` | signed in | 20 per minute | Hand a quiz paper in. |
| GET | `/api/v1/phases/:id/tasks/:taskKey/reset` | signed in | 60 per minute | What starting this task over would do. |
| POST | `/api/v1/phases/:id/tasks/:taskKey/reset` | signed in | 20 per minute | Start one task over. |
| GET | `/api/v1/phases/:id/tasks/:taskKey/solution` | signed in | 20 per minute | One task's reference solution, once it has passed. |
| GET | `/api/v1/phases/:id/tasks/:taskKey/submissions` | signed in |  | Every submission of one task, oldest first. |
| POST | `/api/v1/phases/:id/tasks/:taskKey/submit` | signed in | 20 per minute | Submit one task for grading. |
| PUT | `/api/v1/phases/:id/workspace` | signed in |  | Save your files; a stale version is refused with 409. |
| GET | `/api/v1/phases/records` | signed in | 60 per minute | Every open phase's submissions, runs and reviews, in one request. |
| GET | `/api/v1/phases/summaries` | signed in | 60 per minute | Every open phase in summary, in one request. |
| GET | `/api/v1/projects` | signed in |  | The projects you may be shown. |
| GET | `/api/v1/projects/:slug` | signed in |  | One project's details. |
| GET | `/api/v1/projects/:slug/map` | signed in | 30 per minute | Your project map. |
| GET | `/api/v1/queue/position` | signed in | 120 per minute | Where your submission is in the grading queue. |
| GET | `/api/v1/repo/:slug/export.zip` | signed in | 3 per minute | Your project as a git repository in a `.zip`: one commit per submission. |
| GET | `/api/v1/repo/:slug/summary` | signed in | 30 per minute | The counts the repository card shows. |
| GET | `/api/v1/runs/:id` | signed in |  | One run and its result. |
| GET | `/api/v1/submissions/:id` | signed in |  | One submission and its verdict; `?include=snapshot` adds your files. |
