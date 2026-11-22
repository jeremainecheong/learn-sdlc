# Developing LearnSDLC

This guide is for working on the code: what to install, where things live, the commands you will run every day, the conventions the code follows, and how to add the common kinds of change. Read the [architecture](architecture.md) first for how the parts fit together, and the [testing guide](testing.md) for every test suite. Running the product for a class is covered in [Running it on your own machine](local-run.md) and the [production runbook](production-runbook.md).

Every command here runs from the repository root, the folder that holds the root `package.json`, unless it says otherwise.

## What your machine can do

Learner code runs only where the kernel can isolate it: Linux with Landlock (kernel 5.13 or later), or inside the Docker stack, which on macOS and Windows runs in a Linux virtual machine. On a Mac or Windows machine without Docker, the dev servers start and every page works, but Run, Submit and the live preview of learner code are refused, and the tests that run learner code fail. That is a property of the machine, not a fault in your change. The [testing guide](testing.md) says which suites are affected.

## Prerequisites

| Need | Why | Notes |
|---|---|---|
| Node 24.9 or newer within 24, or Node 26 and later | The application itself | `.nvmrc` names the version CI uses, so `nvm install` picks it. `.npmrc` sets `engine-strict`, so npm refuses any other Node. |
| Python 3.11, exactly | The code runner and the libraries pre-baked for learner code | `scripts/setup.sh` stops without it. `PYTHON_BIN` names one that is not on the path as `python3.11` or `python3`. |
| Node 22 | Learner JavaScript runs on Node 22, apart from the application's own Node | Found under `~/.nvm/versions/node/v22.*`, as `node22` on the path, or named by `NODE_BIN`. |
| An OpenAI-compatible API key | The mentor, the interview, the Agentic mode and grading | `OPENAI_API_KEY` in `.env`. See [Running it on your own machine](local-run.md). Tests use a canned endpoint instead. |
| `pytest` for Python 3.11 | The runner's tests | `python3.11 -m pip install pytest` |
| `redis-server` on the path | Two API test cases that drive BullMQ against a real Redis | Optional; without it those cases fail. |
| Docker with Compose | The local Docker stack and the full local proof | On a Mac, Colima. See [Running it on your own machine](local-run.md). |
| Terraform | Only for the reference AWS deployment's tests | See the [testing guide](testing.md). |

## The first run

```bash
git clone <repository URL> learnsdlc
cd learnsdlc
bash scripts/setup.sh
```

`scripts/setup.sh` checks Node and Python 3.11, runs `npm ci`, builds every workspace (`npm run build`), builds the sandbox's pre-baked layer (`node scripts/prebake.mjs build`), copies `.env.example` to `.env` if there is no `.env` yet, and generates a `JWT_SECRET` for this machine into `.env` when the value there is empty or is a placeholder the repository publishes (it never replaces a real one). It is safe to run again. Then put your key in `.env`:

```bash
OPENAI_API_KEY=<your key>
```

and start the dev servers:

```bash
bash scripts/start.sh --dev
```

`scripts/start.sh --dev` refuses to start without a key, starts the code runner on a UNIX socket (`apps/api/runner/serve.py`), applies the database migrations to `data/learnsdlc.sqlite`, creates the demo instructor and administrator accounts (the API binds 127.0.0.1 only), sends mail to `data/mail.log` instead of a mail server, loads `.env` through `scripts/run-with-env.mjs`, and runs `npm run dev`: the API on http://localhost:4000 and the web app on http://localhost:3000. `API_PORT` moves the API. The dev web server always listens on 3000 (`next dev -p 3000`), so `WEB_PORT` moves only the built web server (`bash scripts/start.sh` without `--dev`, `npm run demo`). On a machine that cannot isolate learner code it says so in one line and starts anyway. `npm run demo` does all of this in one command with the built bundles instead of the dev servers; see [Running it on your own machine](local-run.md).

`npm run dev` on its own builds the shared package and starts the two dev servers with the root `.env` loaded through `scripts/run-with-env.mjs` (a variable you have already exported wins over the same name in `.env`). It starts no code runner, applies no migrations and sets none of the values `scripts/start.sh` exports (`RUN_MIGRATIONS`, `RUNNER_MODE` and `RUNNER_SOCKET`, an absolute `DB_PATH`, `SEED_DEMO_ACCOUNTS`, `MAIL_CAPTURE_FILE`), so Run, Submit and Preview need a runner you start yourself. Use it only when `.env` or your environment sets those. `npm start` does the same with the built bundles.

## Layout

### `apps/api`

| Path | What is there |
|---|---|
| `src/main.ts` | The boot: the safety checks, then `configureApp`, the HTTP layer every request passes through. |
| `src/app.module.ts` | The one application module: every controller, every provider and the two global guards. |
| `src/config.ts`, `src/config/*.ts` | Every environment variable the API reads, resolved in one place. Each file under `config/` holds the `resolveX(env = process.env)` functions of one area (`ai.ts`, `auth.ts`, `database.ts`, `runner.ts`, `preview.ts` and so on); `config.ts` re-exports them and builds the `config` object once, at load. A setting that must be read at call time is exported as a resolver instead. |
| `src/<area>/` | One folder per area (`auth`, `workflow`, `feedback`, `assistant`, `authoring` and the rest; the [architecture](architecture.md) lists them). A folder holds its controller (`*.controller.ts`), its service (`*.service.ts`), its DTOs (`*.dto.ts`, or classes beside the controller), its entities and its unit specs (`*.spec.ts`) side by side. |
| `src/dto.ts` | DTOs shared by more than one area. |
| `src/db/` | The data source (`database.module.ts`, `data-source.ts` for the TypeORM command line), most entities (`entities.ts`) and the migration specs. |
| `src/migrations/` | The versioned migrations, one file each. |
| `src/cli/` | The command-line tools the package scripts run: `migrate.ts`, `content-check.ts`, `set-password.ts`, `import-pack.ts`. `run.ts` gives each one the same exit code (70) for a failure it did not expect. |
| `test/` | The end-to-end specs (`*.e2e-spec.ts`), which boot the whole application, and the specs that need test fixtures. |
| `test/support/` | What the specs share: `app.ts` (`bootApi`, which boots `AppModule` with the real HTTP layer), `http.ts` (supertest helpers such as `bearer` and `waitForSubmission`), `memory-db.ts` (an in-memory SQLite data source with every table) and `postgres.ts` (the PostgreSQL switches). |
| `test/fixtures/` | Test data, with a [README](../apps/api/test/fixtures/README.md) that says what each folder is and what writes it. Frozen copies are never refreshed. |
| `test/cli/` | The generators that record the golden files (below). They live under `test/` because `src/` must never import from `test/`: the production build compiles `src/` alone, and `src/build-boundary.spec.ts` holds that line. |
| `test/jest.cjs`, `test/environment.js`, `test/setup-env.js` | How Jest starts, the test environment, and the variables every spec runs with. |
| `runner/` | The Python code runner and its tests (`test_*.py`). |
| `eval/` | A harness for evaluating models. The test suite does not run it. |

### `apps/web`

| Path | What is there |
|---|---|
| `app/` | The routes, one folder per URL, each with a `page.tsx`. The public and sign-in pages sit directly under `app/` (`login`, `register`, `forgot`, `reset`, `verify`, `confirm`, `how-it-works`, `what-you-learn`, `privacy`, `terms`). |
| `app/(app)/` | Every signed-in page. The group's name is not part of the URL. `app/(app)/layout.tsx` turns away a visitor without a session, loads the learner's project once, and draws the shell around every page. |
| `app/(app)/workspace/[phaseId]/` | The phase room: `page.tsx` and its sub-routes (`brief`, `change`, `concept`, `design`, `drill`, `interview`, `issue`, `matrix`, `pr`, `quiz`, `runs/[runId]`, `solution`), with the modules the room is built from beside them: `WorkspaceFrame.tsx`, `WorkspaceBody.tsx`, `view-cache.ts` and `workspace-helpers.ts`. |
| `app/(app)/teacher/`, `app/(app)/instructor/`, `app/(app)/admin/` | The teacher console, the instructor's views of a learner, and the administrator's accounts page. |
| `components/` | Components by area: `shell` (the frame, sidebar, top bar, palette), `workspace` (the editor, panels and rooms), `staff` (the teacher console), `learn` (lessons), `ui` (the shared primitives) and others. `components/shell/README.md` and `components/learn/README.md` describe their folders. |
| `lib/` | Everything that is not drawn: the API clients (`api.ts` and one `api-<area>.ts` per area), the session, the theme, storage keys and small pure helpers. |
| `public/` | Static files: fonts, brand marks, artwork, lesson images, walkthroughs and the live preview's React runtime. |
| `scripts/` | `copy-lint.mjs` and `gen-teacher-guide.mjs`. |
| `test/` | The Vitest tests, `support/` with their helpers, and `__snapshots__/` with the file snapshots. |

### `packages/shared`

`src/index.ts` re-exports every module. The ones you will meet first:

| Module | What it holds |
|---|---|
| `src/contract/*.ts` | The shapes of the HTTP API's requests and responses, one file per area, which the API returns and the web app reads. |
| `src/limits.ts` | Length limits that a web form and an API DTO both enforce. |
| `src/phases.ts`, `src/phase-subset.ts`, `src/status.ts` | The six phases, their order, and the statuses a phase and a task can have. |
| `src/projects.ts`, `src/pack-layout.ts`, `src/upload-contract.ts`, `src/authoring.ts` | The project pack format and the rules for an uploaded project. |
| `src/requirements-story.ts`, `src/design-record.ts`, `src/runbook-record.ts`, `src/change-record.ts` | The structured records the four written phases produce, with their floors and checks. |
| `src/words.ts`, `src/percentages.ts`, `src/plain-text.ts` | Small helpers for numbers in words, percentages and plain text. |

The specs beside these files (`*.spec.ts`) are run by the API's Jest suite.

## How the shared package is built

`npm run build -w @learnsdlc/shared` compiles `packages/shared/src` into `packages/shared/dist`. The package's `main` and `types` point at `dist`, so the API's compiler, the API at run time and the web app's build all read the built output. The two test runners do not: Jest (`apps/api/jest.config.js`) and Vitest (`apps/web/vitest.config.ts`) map `@learnsdlc/shared` to its TypeScript source, so a test never runs against a stale build.

That is why `npm run typecheck`, `npm run dev`, `npm run build` and `npm run test:scripts` all build the shared package first: on a fresh clone there is no `dist` yet, and after a change to `packages/shared` an old `dist` would hide it. When you change the shared package while the dev servers are running, build it again and restart them.

## The everyday loop

| Task | Command |
|---|---|
| Start the dev servers | `bash scripts/start.sh --dev`. The web app reloads on a change; the API does not, so restart it after a change to `apps/api` or `packages/shared`. |
| Type-check everything | `npm run typecheck`: builds the shared package, type-checks every workspace (the web app's tests included) and then the browser tests (`npm run typecheck:e2e`). |
| Run one API spec | `npm run test -w @learnsdlc/api -- src/route-table.spec.ts` |
| Run one web test | `npm run test -w @learnsdlc/web -- test/term.test.tsx` |
| Run one runner test file | `python3.11 -m pytest apps/api/runner/test_analyzer.py -q` |
| Check the product's copy | `npm run lint:copy -w @learnsdlc/web` |
| Check a content pack | `npm run content:check -- --quick` |

The [testing guide](testing.md) has every suite and what each needs.

## Conventions

- **Formatting.** `.editorconfig` is the house style: UTF-8, LF line endings, a final newline, two-space indents (four in Python). No formatter or linter is enforced by a tool; keep a new file like its neighbours. The web tests' snapshot files are byte-exact and end without a newline.
- **TypeScript.** Every workspace compiles with `strict` (`tsconfig.base.json`). The shared package also refuses unused locals and parameters, implicit returns and switch fall-through, because it ships to the browser and both apps.
- **Configuration.** The API reads environment variables only through `src/config.ts` and `src/config/*.ts`. Most numbers that are missing or malformed load as their default (the [configuration reference](configuration.md#how-values-are-read) names the exceptions); a value that would be unsafe refuses the boot with a sentence. Every variable is listed in the [configuration reference](configuration.md).
- **One limit, two enforcers.** A length a form and a DTO both enforce is one constant in `packages/shared/src/limits.ts`, or beside the record it belongs to, so the form never accepts what the API refuses.
- **The product's copy.** Text a learner reads is in sentence case, and no middle dot or pipe stands in for a word. `npm run lint:copy -w @learnsdlc/web` checks the JSX text and exported string constants under `apps/web/app` and `apps/web/components`, and that every message given to `setError` starts as a sentence.
- **Comments.** A comment says what the code does and why it must be so, in full sentences, for a reader who has never seen the project before. Exported functions and classes carry a doc comment. A comment names the file or function it depends on by path. It never narrates how the code came to be.
- **Documents and comments** are written in plain British English.
- **Tests are named for what they prove.** A file is named for the behaviour it covers (`finished-project-pages.test.tsx`, `route-table.spec.ts`), a `describe` names the rule, and each case is a sentence about behaviour: `it('the task’s rubric is what its evidence is counted against')`, `test_the_extra_job_is_refused_with_503_once_the_wait_is_spent`.
- **`src/` never imports from `test/`** in the API. A tool that needs test support code goes under `test/`.

## Adding a database migration

Applied migrations are never edited and never renamed. TypeORM records each migration's class name in the `learnsdlc_migrations` table and loads every file in `apps/api/src/migrations` by a glob, so a renamed migration runs again on a database that already has it, and an edited one does something different on a fresh database than it did on the databases that already ran it. A change to the schema is always a new migration.

1. Change the entity (`apps/api/src/db/entities.ts`, or the `*.entity.ts` file of its area).
2. Write the migration as `apps/api/src/migrations/<timestamp>-<Name>.ts`, where the timestamp is milliseconds since the epoch and sorts after every existing file. The class is named `<Name><timestamp>` and sets `name` to the same string. Follow the existing files: a header comment that says what changes and why, and `up` and `down` written for both dialects the product supports, PostgreSQL and SQLite (`better-sqlite3`), with any other dialect refused by name.
3. `npm run migration:generate -w @learnsdlc/api -- src/migrations/<Name>` writes a draft from the difference between the entities and a database that is already at the latest migration (`npm run migration:run -w @learnsdlc/api` brings it there). The data source reads the same configuration as the API, so set `DATABASE_URL` to a scratch PostgreSQL database first. Use the draft as a starting point for step 2, not as the migration.
4. Add a spec under `apps/api/src/db/` that runs every migration on an empty SQLite file and checks the result (`proposal-feedback-migration.spec.ts` is a small example), and a `*.postgres.spec.ts` beside it when the change behaves differently on PostgreSQL. The [testing guide](testing.md) says how to run those.

CI applies every migration to a clean PostgreSQL database and then asks TypeORM to generate one more; any statement it would emit means the entities and the migrations disagree, and the job fails.

## Adding an API route

1. Put the handler on the controller of its area, or on a new controller added to `controllers` in `apps/api/src/app.module.ts`. Every route needs a valid session unless it is marked `@Public()`; staff routes add `@Roles('INSTRUCTOR', 'ADMIN')`; `@CurrentUser()` gives the caller. A route that can be abused gets `@RateLimit(count, seconds)` with `@UseGuards(RateLimitGuard)`.
2. Describe the body with a DTO class and `class-validator` decorators. The global validation pipe strips every field the DTO does not declare. Take lengths from `packages/shared/src/limits.ts` when the web app enforces the same one.
3. Do the work in the service. A service that touches a learner's work starts from `WorkflowService.loadOwnedState`, which refuses a phase that is not the caller's.
4. Declare the response shape in `packages/shared/src/contract/` and return that type, so the web app reads the same type.
5. Test it: a unit spec beside the service, and an end-to-end spec `apps/api/test/<name>.e2e-spec.ts` that boots the app with `bootApi()` from `test/support/app.ts` and calls the route with supertest and `bearer(token)` from `test/support/http.ts`.
6. Add the client function to `apps/web/lib/api-<area>.ts`.

`src/route-table.spec.ts` reads the mounted routes from the controllers' decorators; it holds a few routes that must not exist, so a new route needs no entry there. The [HTTP API overview](api.md) has the route table.

## Adding a page

1. Create `apps/web/app/(app)/<name>/page.tsx` for a signed-in page (it is drawn inside the shell, and a visitor without a session is turned away), or `apps/web/app/<name>/page.tsx` for a public one.
2. Fetch data through the clients in `apps/web/lib/api*.ts` and draw it with the primitives in `components/ui`. The [design system](design-system.md) describes the tokens, the button contract and the layout rules.
3. Add a test `apps/web/test/<name>.test.tsx`. A file that renders components starts with the line `// @vitest-environment jsdom`; the others run in Node. Mock the API client module with `vi.mock` and render with `createRoot` inside `act`; `test/finished-project-pages.test.tsx` is a worked example.
4. Run the test, `npm run typecheck` and `npm run lint:copy -w @learnsdlc/web`.

## Adding a shared limit

1. Add the constant to `packages/shared/src/limits.ts` with a doc comment saying what it bounds, or beside the record it belongs to. It is exported through `src/index.ts`.
2. Use it in the DTO (`@MaxLength(NAME_MAX)`) and in the form (`maxLength`, the character count).
3. Build the shared package (`npm run build -w @learnsdlc/shared`) or run `npm run typecheck`, which does.

## Generators

Some files in the repository are written by a tool, and a test fails when they are out of date. Run a generator when its input changes, read the difference, and commit both. A generator is never the fix for a test you do not understand.

| What it writes | Command | When to run it |
|---|---|---|
| `apps/web/lib/teacher-guide-doc.generated.ts`, from `docs/teacher-project-upload.md` | `npm run gen:teacher-guide -w @learnsdlc/web`; `npm run check:teacher-guide -w @learnsdlc/web` only checks | After any change to `docs/teacher-project-upload.md`, which the app shows as its teacher guide. |
| `apps/api/src/authoring/starter-archive.generated.ts`, the starter and example downloads | `npm run starter-archive:write -w @learnsdlc/api`; `starter-archive:check` only checks | After a change under `apps/api/test/fixtures/upload-packs/starter` or `shelf`. |
| `apps/web/public/preview-runtime/react-runtime.js` | `npm run build:preview-runtime -w @learnsdlc/web` | After a React upgrade. |
| `apps/api/test/fixtures/<slug>-content-digests.json` | `npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/content-digests.ts` | When a pack's content changes and its version is bumped. |
| `apps/api/test/fixtures/<slug>-verdict-digests.json` | `npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/verdict-digests.ts` | When what the grader produces for a pack changes on purpose. It runs learner code, so it needs a machine that can. |
| `apps/api/test/fixtures/tasktrackr-ai-request-digests*.json` | `npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/ai-request-digests.ts` | When a change to a prompt is meant to change what is sent to the model. |
| `apps/api/src/assistant/reference-anchors.ts` and `reference-exec-anchors.ts` | `npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/reference-anchors.ts` (add `--exec` for the second) | When the reference pack's version changes. |
| `apps/api/src/content/reference-scenarios.ts` | `npx ts-node --project apps/api/tsconfig.json apps/api/test/cli/reference-scenarios.ts` | When the reference pack's version changes. |
| The recorded API bodies and exchanges under `apps/api/test/fixtures/contract-bodies` and `contract-exchanges` | The recording specs, with `CONTRACT_BODIES_RECORD=1` or `CONTRACT_EXCHANGES_RECORD=1` | When a response shape changes on purpose. The fixtures README says which spec records which. |
| `apps/api/runner/runtime/`, the libraries learner code may import (not committed) | `npm run prebake`; `npm run prebake:verify` checks it | On a fresh clone (setup does it), and after a pack's runtime block changes. |

Most of the `apps/api/test/cli` tools take `--check`, which writes nothing and fails when the file differs. Each tool's header comment gives its options and exit codes.

## Before you open a pull request

- `npm run typecheck`
- the test files that cover your change, and the suites in the [testing guide](testing.md) that your change could reach
- `npm run lint:copy -w @learnsdlc/web` when you changed anything a user reads
- the generators above whose inputs you changed

How to propose a change is in [CONTRIBUTING.md](../CONTRIBUTING.md).
