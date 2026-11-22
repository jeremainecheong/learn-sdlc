# Testing LearnSDLC

This guide lists every test suite in the repository: what it proves, the command that runs it, what it needs, and what a failure on a Mac means. Commands run from the repository root unless they say otherwise. The [development guide](development.md) covers the everyday loop and the [architecture](architecture.md) the parts under test.

## Read this first: tests that run learner code need Linux

LearnSDLC runs learner code only where the kernel can isolate it: Linux with Landlock (kernel 5.13 or later), or the Docker stack, whose containers run in a Linux virtual machine on macOS and Windows. Elsewhere the code runner refuses every run, by design.

So on a Mac (or Windows, or a Linux kernel without Landlock) every test that runs learner code through the sandbox fails: the API specs that grade, run or preview code, the runner's own tests of the fence and of running applications, the content check's sandbox proofs and the browser tests that press Run, Submit or Run app. That is the platform refusing, not a fault in the code. Everything else in this guide passes on a Mac. Run the whole set on Linux before you rely on a change to grading, the runner or the preview.

The tests that run learner code also need, on any machine:

- Python 3.11, as `python3` on the path or named by `PYTHON_BIN`;
- the pre-baked layer of libraries learner code may import: `npm run prebake` (part of `bash scripts/setup.sh`);
- Node 22 for learner JavaScript, named by `NODE_BIN` (otherwise `node` on the path is used).

No test calls a real AI provider. The API specs replace the provider with a test double or a recording, and the browser tests and the journey scripts talk to the canned endpoint `e2e/ai-stub.cjs`.

## The suites at a glance

| Suite | Command | Runs on a Mac |
|---|---|---|
| Type-check | `npm run typecheck` | Yes |
| Shared and API specs (Jest) | `npm run test -w @learnsdlc/api` | Yes, except the cases that run learner code |
| PostgreSQL-only specs | the API specs with `DATABASE_URL` or `POSTGRES_TEST_CONFIG` | Yes, with a PostgreSQL server |
| Web tests (Vitest) | `npm run test:web` | Yes |
| Copy rules | `npm run lint:copy -w @learnsdlc/web` | Yes |
| Script tests (`node:test`) | `npm run test:scripts` | Yes |
| Runner tests (pytest) | `npm run test:runner` | Partly: the tests that start learner code fail |
| Infrastructure unit tests | `npm run test:infra` | Yes |
| Infrastructure Terraform tests | `terraform -chdir=infra/preview/terraform test` | Yes, with Terraform |
| Content check | `npm run content:check` | `--quick` only |
| Browser tests (Playwright) | `npm run e2e` | Partly: the specs that run learner code fail |
| Full local proof | `bash scripts/prove-local.sh` | Only through a Docker whose Linux virtual machine has Landlock |

`npm test` runs the API specs, the web tests and the runner tests one after another.

## Type-check

```bash
npm run typecheck
```

Builds `packages/shared`, type-checks every workspace (the API with its tests, the shared package with its specs, the web app with its tests) and then the browser tests (`npm run typecheck:e2e`). It needs nothing but `npm ci`.

## Shared and API specs (Jest)

```bash
npm run test -w @learnsdlc/api                                # every spec, in band
npm run test -w @learnsdlc/api -- src/route-table.spec.ts     # one file
npm run test -w @learnsdlc/api -- src/feedback/strict-evidence.spec.ts -t 'rubric'   # matching cases only
```

What it runs: every `*.spec.ts` and `*.e2e-spec.ts` under `apps/api/src`, `apps/api/test` and `packages/shared/src` (`apps/api/jest.config.js`). The shared package's specs run here because the API is what that contract is with. Unit specs sit beside their source; the `*.e2e-spec.ts` files under `apps/api/test` boot the whole application with `bootApi()` (`test/support/app.ts`) and call it over HTTP with supertest.

How it runs: in one process, one file after another (`--runInBand`), under Node's `--experimental-vm-modules` because NestJS is an ES module. `test/environment.js` keeps the heap flat from file to file, and `test/setup-env.js` gives every spec the same environment: an in-memory SQLite database, a fixed JWT secret, `RUNNER_MODE=local`, the demo staff accounts, and no `SEED_PASSWORD` from your shell. Each case may take up to 60 seconds. One small file took about ten seconds when this guide was checked, most of it start-up.

What it needs:

- for the cases that run learner code: Linux with Landlock and the three things in [Read this first](#read-this-first-tests-that-run-learner-code-need-linux);
- `redis-server` on the path for the two cases in `src/jobs/bull.queue.spec.ts` that drive BullMQ against a real Redis; the spec starts it itself on a free port.

What a failure on a Mac means: the cases that run learner code fail because the runner refuses to run it there; any other failure is real.

Optional switches:

- `REDIS_TEST=1` runs `src/events/events.redis.integration.spec.ts`, which needs a Redis server on 127.0.0.1:6379. `GAP_SECURITY_REDIS=1` is read as the same switch.
- `CONTRACT_BODIES_RECORD=1` and `CONTRACT_EXCHANGES_RECORD=1` make the recording specs record their fixtures again instead of checking them. The [fixtures README](../apps/api/test/fixtures/README.md) says which spec records which.

### The PostgreSQL-only specs

The suite runs on SQLite. The specs that only mean something on PostgreSQL skip themselves unless one of two switches is set (`apps/api/test/support/postgres.ts`). The two mean different things:

- **`DATABASE_URL`** is what the application itself reads. When it is set, every spec that boots the application runs on that database, and the end-to-end specs that exist only for PostgreSQL run too (`describeIfPostgres`: `test/postgres-console.e2e-spec.ts`, `test/postgres-timezone.e2e-spec.ts`, `test/agentic-pagination-postgres.e2e-spec.ts`). Point it at a scratch database, migrated to the latest migration, and run those files alone:

  ```bash
  cd apps/api
  DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/<scratch database> \
    npx typeorm-ts-node-commonjs migration:run -d src/db/data-source.ts
  DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/<scratch database> \
    npm run test -- test/postgres-console.e2e-spec.ts
  ```

  This is what CI's production-stack job does.

- **`POSTGRES_TEST_CONFIG`** names a JSON file of the shape `{ "databaseUrl": "postgres://..." }` for the `*.postgres.spec.ts` files and a few specs beside them (`describePostgres`, `isolatedPostgresUrl`). These build scratch schemas of their own and run migrations into them, so they never touch the database the application uses. They refuse any target that is not a PostgreSQL server on 127.0.0.1 port 5494, and most also refuse any database but `lsdlc_numbers` or `lsdlc_pgspecs`. Some check that the `uuid-ossp` extension is already installed. `GAP_SECURITY_CONFIG` is read as the same switch.

  ```bash
  echo '{ "databaseUrl": "postgres://<user>:<password>@127.0.0.1:5494/lsdlc_pgspecs" }' > /tmp/postgres-test.json
  POSTGRES_TEST_CONFIG=/tmp/postgres-test.json npm run test -w @learnsdlc/api -- postgres.spec
  ```

## Web tests (Vitest)

```bash
npm run test:web                                      # every test
npm run test -w @learnsdlc/web -- test/term.test.tsx  # one file
```

What it runs: every `apps/web/test/**/*.test.ts(x)` (`apps/web/vitest.config.ts`), in Node with no server and no browser. A file that renders components asks for a DOM with `// @vitest-environment jsdom` on its first line. `@learnsdlc/shared` is read from its source. Each case may take up to ten seconds. One small file took about a second when this guide was checked.

**File snapshots, and why `CI=1` matters.** Several tests hold a whole render still by comparing it with a file under `apps/web/test/__snapshots__/` (`toMatchFileSnapshot`). Vitest treats a missing snapshot file differently depending on where it runs: on your machine it writes the file and the test passes, while with `CI` set (GitHub Actions sets it) a missing file fails the test. A snapshot that differs fails everywhere. So before you push, run the suite the way CI does:

```bash
CI=1 npm run test:web
```

When a change to a render is intended, read the diff, then accept it for that file:

```bash
cd apps/web && npx vitest run -u test/<file>.test.tsx
```

and commit the snapshot with the change. Snapshot files are byte-exact and end without a newline; `.editorconfig` tells your editor to leave them alone.

What it needs: nothing but `npm ci`. Nothing in this suite depends on the platform.

## Copy rules

```bash
npm run lint:copy -w @learnsdlc/web
```

Parses the `.tsx` and `.ts` files under `apps/web/app` and `apps/web/components` and fails on a middle dot or a pipe in text a user reads, and on a message given to `setError` that does not start as a sentence. It takes about a second and needs nothing but `npm ci`. CI runs it in the web job, beside the web tests.

## Script tests (`node:test`)

```bash
npm run test:scripts
node --test scripts/prebake.test.mjs        # one file
```

Builds the shared package, then runs every `scripts/*.test.mjs` and `scripts/seed-class/*.test.mjs`: the local-run scripts, the pre-bake, the audit gate, the pack archive, the export round trip, the teacher-authoring journey scripts and the seeded class's design variants. They start no server. The whole run took a few seconds and passed on a Mac when this guide was checked.

`e2e/ai-stub.test.mjs` is a test of the same kind for the canned AI endpoint. It is not in `test:scripts`, because it feeds the stub's answers through the API's own client and so needs the built API first:

```bash
npm run build
node --test e2e/ai-stub.test.mjs
```

## Runner tests (pytest)

```bash
npm run test:runner                                        # every test, with PYTHON_BIN or python3
python3.11 -m pytest apps/api/runner/test_analyzer.py -q   # one file
```

What it runs: every `apps/api/runner/test_*.py`: the sandbox and its fence, the job contract, the socket server and its slot pool, the live application sessions, the static analyser, the pre-baked runtime and the Lambda handler.

What it needs: Python 3.11 with `pytest` installed for it (`python3.11 -m pip install pytest`). Some tests skip themselves with a sentence when the pre-baked layer is missing (`npm run prebake`), when there is no `node` on the path, or when the kernel has no Landlock.

What a failure on a Mac means: the tests that start learner code under the fence (in `test_runner.py`, `test_app_session.py`, `test_serve.py`'s application routes and a few others) fail there, because the runner refuses to run learner code without isolation. The analyser and runtime manifest tests pass anywhere; `test_analyzer.py` took about two seconds when this guide was checked.

## Infrastructure tests

```bash
npm run test:infra
PYTHON_BIN=python3.11 npm run test:infra
```

`scripts/test-infra.sh` runs Python's `unittest` in four folders, `infra/microvm/controller`, `infra/microvm/guest`, `infra/preview/cognito` and `infra/preview/gateway`, and then `test_static_assets` in `infra/preview`, each in its own interpreter. They need no Docker, no cloud account and no network. They do need `apps/api/runner/runtime/manifest.json`, which `npm run prebake` writes (or `node scripts/prebake.mjs manifest` alone); without it the script stops at once and says so. Every folder runs even after one fails, and the script fails at the end if any did.

Not part of `test:infra`:

- The Terraform tests of the reference AWS deployment need the Terraform CLI:

  ```bash
  terraform -chdir=infra/preview/terraform init -backend=false -input=false
  terraform -chdir=infra/preview/terraform test
  ```

- `infra/preview/gateway/test_caddy.py` and `test_native_form.cjs` drive Docker and are run by hand; [the gateway's README](../infra/preview/gateway/README.md) says how.

## Content check

```bash
npm run content:check -- --quick                    # the loader and the static rules only
RUNNER_MODE=local npm run content:check             # every proof, through a local runner
npm run content:check -- --help                     # every option
```

Loads every pack under `content/` and proves what a pack promises: among other checks, the reference answer passes its hidden suites, the starting files fail them, the reference tests catch every planted bug, the incident drill breaks the smoke check, and the preview starts. The full check runs code in the sandbox, so it needs a runner (`RUNNER_MODE=local`, or a socket runner started by `bash scripts/start.sh`), the pre-baked layer, and a machine that can isolate learner code. `--quick` skips every sandbox proof and runs anywhere.

Exit codes: 0 clean, 1 a pack is wrong, 2 the checker could not tell (a pack would not load, or the runner never answered), 3 bad usage, 70 an unexpected failure. On a Mac the full check ends with 2, which says nothing about the packs. `--json` and `--markdown` write the report to a file; give an absolute path, because the checker runs inside `apps/api`. The [authoring format](authoring-format.md) describes each check.

## Browser tests (Playwright)

```bash
npm run e2e                                              # every project the config defines
npx playwright test e2e/account.spec.ts                  # one spec
PREVIEW_ENABLED=false npx playwright test --project=preview-off
```

What it proves: the product as a learner, a teacher and an administrator use it, in Chromium, against a real API and web server.

What a first run needs:

1. `npm run build`: the suite starts the built API (`apps/api/dist/main.js`) and the built web app (`npm run start -w @learnsdlc/web`), not the dev servers.
2. `npm run prebake`, Python 3.11 and Node 22 (as `NODE_BIN`), because the specs run learner code.
3. A browser: `npx playwright install chromium`. A Chromium already installed at `/opt/pw-browsers/chromium`, or at the path in `PW_CHROMIUM_PATH`, is used instead.
4. `pdftotext` (from poppler) on the path, for `e2e/dossier.spec.ts`, which reads an exported PDF back.
5. Ports 3000, 4000 and 4199 free. The suite never reuses a server that is already running.

`playwright.config.ts` then starts three servers: the canned AI endpoint (`node e2e/ai-stub.cjs`, port 4199), the API on a fresh SQLite file under `apps/api/.e2e-data` with `RUNNER_MODE=local` and the demo staff accounts, and the web app. Tests run one at a time. Failures keep a trace and a video, and the HTML report is written to `playwright-report/`.

The projects in `playwright.config.ts`:

| Project | What it runs |
|---|---|
| `app` | Every spec except the ones below. |
| `preview-off` | `e2e/preview-unsupported.spec.ts` alone. It needs an API started with the live preview switched off, so against the default servers it skips itself with a sentence; run it with `PREVIEW_ENABLED=false` as above. |
| `opt-in` | `e2e/screenshots.spec.ts`, with `SCREENSHOTS=1`. The project exists only when that switch or `PW_BUDGET` is set. |
| `budget` | The render-cost cases of `e2e/workspace-shell.spec.ts` tagged `@budget`, with `PW_BUDGET=1 npx playwright test -g @budget`. Advisory. |

Other variables the config reads:

- `PW_WEB_PORT` and `PW_API_PORT` move the web app and the API, so the suite can run beside a stack that holds 3000 and 4000. The web app inlines the API's address when it is built, so build it for the same port first: `PW_WEB_PORT=3100 PW_API_PORT=4100 NEXT_PUBLIC_API_URL=http://localhost:4100 npm run build -w @learnsdlc/web`.
- `PW_AI_PORT` moves the canned AI endpoint; `E2E_API_URL` names an API somewhere else entirely.
- `PW_VIDEO=1` records a video of every test, not only the failures.
- With `CI` set, a failed test is retried once.

What a failure on a Mac means: the specs that run learner code fail there, because the runner refuses to. Run the suite on Linux. In CI the browser job is reported but does not fail the workflow, because its timing is not reliable on the hosted runners.

## The full local proof

```bash
bash scripts/prove-local.sh                     # the whole proof (also: npm run prove)
bash scripts/prove-local.sh --reuse             # against a stack already running with --ai-stub
bash scripts/prove-local.sh --skip-durability   # without the queue durability check
bash scripts/prove-local.sh --ai-check          # only the AI round trips, against a running stack's own AI
```

Starts the local Docker stack with the canned AI (`scripts/stack.sh up --ai-stub --detach`) and checks, in order: health, sign-in, the AI round trips (a mentor reply, a rubric review, and an Agentic propose, explain and apply), the six-phase journey with Run, Submit and the live preview through the runner container, a teacher's upload with deep validation, a teacher authoring a Requirements, a Design, a Deployment and a Maintenance task that a learner then passes, a three-phase upload a learner finishes, an export uploaded again, and a grading job surviving the API being killed. It writes `tmp/prove-local-<UTC time>.json` with every step and its timing, and the logs beside it, and exits non-zero if any step fails.

It needs Docker with Compose and everything [Running it on your own machine](local-run.md) lists for the Docker run. Because the runner runs inside the Docker virtual machine, it proves learner code on a Mac too, provided that virtual machine's kernel has Landlock; the local-run guide says which Docker setups do.

## What else CI runs

`.github/workflows/ci.yml` also runs the journey scripts against a booted API (in-process runner, socket runner, and PostgreSQL with Redis in production mode), the stress batteries described in [`scripts/stress/README.md`](../scripts/stress/README.md), the dependency audit gate (`npm run audit`, and `npm run audit:gate:test` for its own tests) and a check that the entities and the migrations agree. Each job's comments say what it needs.
