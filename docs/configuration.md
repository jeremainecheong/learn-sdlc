# Configuration reference

Every environment variable that LearnSDLC's API, web app, code runner, Compose files and scripts read, with its default in the code and what it changes. The tables were built from the code that reads each variable: `apps/api/src/config.ts` and `apps/api/src/config/*.ts` for the API, `apps/web/next.config.js` and `apps/web/lib` for the web app, `apps/api/runner/*.py` for the runner, the `docker-compose*.yml` files and the scripts under `scripts/`.

[`.env.example`](../.env.example) is the companion file: copy it to `.env` and it holds every setting below that a person is expected to change, with its default.

Read next: [running it on your own machine](local-run.md), the [production runbook](production-runbook.md) for running it for a class, and [troubleshooting](troubleshooting.md) for the messages a wrong setting produces.

## Where settings come from

| How you start it | Where its settings come from |
|---|---|
| `npm run demo`, `bash scripts/start.sh`, root `npm run dev` and `npm start` | The environment, then the root `.env` (read by `scripts/run-with-env.mjs`). A variable you exported wins over the same name in `.env`. The scripts also export a few values of their own (below). |
| `npm run demo -- --docker`, `npm run stack`, `npm run prove` | `.env.verify` at the repository root, which `scripts/stack.sh` writes on its first start with secrets generated for your machine, plus the AI settings from `.env` at every start. |
| `npm run host` | The environment and `.env`; a generated `JWT_SECRET` is kept in `data/host.env`. |
| `docker compose up` with `docker-compose.yml` | The environment and `.env` fill the `${...}` references in the Compose file. A container sees only the variables its service lists under `environment:`, whatever `.env` holds. |
| The web app | `NEXT_PUBLIC_*` values are read when the web app is **built** and inlined into the bundle. Changing one needs a rebuild, not a restart. |

What the local scripts set for you:

- `npm run demo` and `scripts/start.sh` export `API_PORT` (4000), `PORT` (the web port, 3000), `WEB_ORIGIN` and `NEXT_PUBLIC_API_URL` built from the two ports, an absolute `DB_PATH` (`<repository>/data/learnsdlc.sqlite`), `RUN_MIGRATIONS=true`, `SEED_DEMO_ACCOUNTS=true`, `MAIL_CAPTURE_FILE=data/mail.log`, `RUNNER_MODE=socket` with a `RUNNER_SOCKET` per API port under your temporary folder, and `NODE_BIN` when they find a Node 22. `npm run demo` also exports `PYTHON_BIN`, the Python 3.11 it found. A value you exported yourself is kept, except that `npm run demo` always sets `RUN_MIGRATIONS=true`. Because these are exported, the same names in `.env` are not read; `start.sh` on its own does read `DB_PATH` from `.env`, taking a relative path from the repository root.
- `scripts/setup.sh` copies `.env.example` to `.env` when there is none and writes a generated `JWT_SECRET` into it (96 hexadecimal characters, file mode 0600). It never replaces a real secret once it is there.
- `scripts/stack.sh` writes `.env.verify` once: the three ports, a generated `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD` and `STACK_INSTRUCTOR_PASSWORD`, and a small machine profile (`JOB_CONCURRENCY=1`, `RUNNER_SLOTS=2`, `PREVIEW_SESSIONS=1`, `PREVIEW_MEMORY_MB=256`, `RUN_MEMORY_MB=256`). It prints the file's path, never a password.

## How values are read

- A number the API reads through its whole-number resolvers (`apps/api/src/config.ts` and `src/config/*.ts`), or the code runner through its own (`positive_int` in `apps/api/runner/app_session.py`), loads as its default when it is missing or malformed (`abc`, `15s`, `-3`, `2.5`). Most ports, counts, seconds and sizes follow this rule. Four do not:
  - `OPENAI_TIMEOUT_MS` reads a leading whole number, so `15s` is 15 milliseconds and `2.5` is 2. Only a value that is not a number at all, or that is 0 or below, falls back to 20000.
  - `SMTP_PORT` is not checked: give a plain port number.
  - `AI_CACHE_TTL_HOURS` accepts a decimal number of hours; a value that is not a number, or is 0 or below, falls back to 24.
  - `SANDBOX_NPROC` must be a whole number, or the code runner does not start.
- A few settings refuse to start the API instead, with a sentence that names the variable, because a wrong value would change behaviour silently: `AI_MAX_CONCURRENCY`, `AI_AGENTIC_EDIT_LIST`, `AI_AGENTIC_PAYLOAD`, `GRADING_RUN_FANOUT`, `GRADING_SPECULATIVE_MUTANTS`, `RUNNER_TRANSPORT_ALLOWANCE_SECONDS`, the three `PASSWORD_WORK_*` values, `AUTH_PROVIDER` and the `COGNITO_*` set. The tables say which values each accepts.
- A switch is on only for its exact word. `SEED_DEMO_ACCOUNTS`, `DEMO_CLOCK` and `JOURNEY_REQUIRE_PREVIEW` need exactly `true`; `PREVIEW_ENABLED` and `RUN_MIGRATIONS` are turned off only by exactly `false`; `SANDBOX_LANDLOCK` only by exactly `0`.

## What a deployment must set

| Variable | Why |
|---|---|
| `JWT_SECRET` | Every session is signed with it. The API refuses to start without one, anywhere. In production, or on an address other machines can reach, it must also be at least 32 bytes and not one of the placeholders this repository ships. `openssl rand -base64 48`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator. Required with `NODE_ENV=production`, and by `docker-compose.yml`. |
| `POSTGRES_PASSWORD` | Required by `docker-compose.yml`, which has no default for it. Use hexadecimal (`openssl rand -hex 24`), because it is written into `DATABASE_URL`. |
| `SITE_HOST`, `API_HOST` | Required by `docker-compose.yml`: the public hostnames Caddy obtains certificates for. |
| `OPENAI_API_KEY` | The AI features ([below](#the-ai-provider)). The API starts without it; the local scripts do not. |
| `NEXT_PUBLIC_OPERATOR_NAME`, `NEXT_PUBLIC_OPERATOR_EMAIL` | Who runs the installation, shown on the privacy and terms pages. Without them the pages name a generic operator and give no contact address. |
| `ALLOWED_EMAIL_DOMAINS` | Only if you turn on Google sign-in: empty lets any Google account create a learner account. |
| `METRICS_TOKEN` | Only if you scrape `/metrics`: without it the endpoint is off in production. |

## Addresses and ports

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `API_PORT` | API, scripts | `4000` | The port the API listens on. `npm run demo`, `start.sh` and `npm run host` also use it to build `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL` and the runner socket's name. |
| `API_BIND` | API | `127.0.0.1` | The address the API listens on. Loopback means only this machine can reach it. Any other address makes the API refuse `RUNNER_MODE=local` and a missing, short or placeholder `JWT_SECRET`, refuses the demo accounts, and refuses the published demo passwords at sign-in. `docker-compose.yml` sets `0.0.0.0` inside the container. `npm run demo` and `start.sh` refuse a non-loopback value. |
| `WEB_ORIGIN` | API | `http://localhost:3000` | The web origins allowed to call the API with credentials, comma-separated. Also the origin the class console's join link uses when it names a real host. |
| `SITE_URL` | API | the first `WEB_ORIGIN` | The public origin that password-reset and verification links point at. |
| `TRUSTED_PROXIES` | API | `0` | How many proxy hops sit in front of the API. `1` behind one reverse proxy (Caddy in `docker-compose.yml`). The rate limits key on the client address this produces, so never set it higher than the proxies you have. |
| `API_PUBLIC_URL` | API | unset | The API's public origin, used only to build the default `GOOGLE_REDIRECT_URL`. |
| `WEB_PORT` | scripts | `3000` | The web port for `npm run demo`, `start.sh` and `npm run host`. With `--dev` the web app stays on 3000, because its dev server is `next dev -p 3000`. |
| `PORT` | web server | `3000` | The port the web app's server listens on (the standalone `server.js`, run by `npm run start -w @learnsdlc/web` and by the image). The scripts set it from `WEB_PORT`. |
| `LAB_HOST` | `npm run host` | the machine's first network address | The address learners are given for a hosted class. |
| `SITE_HOST`, `API_HOST` | `docker-compose.yml` (Caddy, web build, API) | none: required | Public hostnames of the web app and the API, without a scheme. For a trial without DNS: `localhost` and `api.localhost`. |
| `ACME_EMAIL` | `docker-compose.yml` (Caddy) | `admin@$SITE_HOST` | The contact the certificate authority writes to about expiring certificates. |
| `STACK_WEB_PORT`, `STACK_API_PORT`, `STACK_MAIL_PORT` | `scripts/stack.sh`, `docker-compose.verify.yml` | `3080`, `4080`, `5085` | The local Docker stack's ports, published on `127.0.0.1` only. Read before its first start; after that `.env.verify` keeps them. |
| `LEARNSDLC_STACK_PROJECT` | `scripts/stack.sh` | `learnsdlc` | The Compose project name of the local Docker stack. Give it on every command to run a second stack beside the first. |

## Database and job queue

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | API | unset | A PostgreSQL connection string. Unset, the API uses the SQLite file at `DB_PATH`. |
| `DB_PATH` | API, `scripts/sqlite-backup.mjs` | `data/learnsdlc.sqlite`, relative to the API's working directory | The SQLite file. The API runs with `apps/api` as its working directory, so the local scripts pass an absolute path (`<repository>/data/learnsdlc.sqlite`). The API image sets `/data/learnsdlc.sqlite`. |
| `POSTGRES_PASSWORD` | `docker-compose.yml` (postgres, api, backup) | none: required there | The database password. Set it before the first start: changing it later means changing it inside PostgreSQL too. |
| `RUN_MIGRATIONS` | API | on with `NODE_ENV=production`, off elsewhere | `true` applies versioned migrations at boot; `false` leaves them to a one-shot step (replicas). Whenever migrations run, schema auto-sync is off. The local scripts set `true`. |
| `REDIS_URL` | API | unset | Turns on the durable job queue, the shared rate-limit counters and the Socket.IO fan-out between API processes. Unset, the queue is in-process and the API must run as a single process. |
| `JOB_CONCURRENCY` | API, runner | one below the host's CPU count, at least 2 | Grading and run jobs one API process works on at once. The runner uses it only to derive its default `RUNNER_SLOTS`. |
| `JOB_ATTEMPTS` | API | `3` | Attempts per queued job before it is marked failed. |

## Sessions and sign-in

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `JWT_SECRET` | API | none: required | Signs every session token. The API will not start without it. See [What a deployment must set](#what-a-deployment-must-set). Changing it signs everyone out. |
| `JWT_EXPIRES_IN` | API | `7d` | Session lifetime, in the `jsonwebtoken` duration form (`7d`, `12h`). |
| `QUIZ_SEED_SECRET` | API | `JWT_SECRET` | The key quiz papers are drawn and option tokens minted with. Setting it lets `JWT_SECRET` change later without redrawing open papers; setting or changing it redraws every open paper once. `docker-compose.yml` passes it to the API container; left unset or empty, `JWT_SECRET` keys the papers. A set value follows the `JWT_SECRET` rule: under 32 bytes or a placeholder this repository ships refuses the boot off loopback and in production, and a value of only spaces counts as unset. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | API | unset | The first administrator, created once on the first boot that finds no administrator; afterwards a `bootstrap.admin` settings row makes them inert. The address must be one nobody has registered. The password must meet the registration rules (8 to 100 characters, not on the list of passwords found in public breaches); a refused one creates no account and the API logs why. `npm run host` asks for both and checks the password before it builds anything. |
| `SIGNIN_MAX_PER_ADDRESS` | API | `200` | Sign-in attempts one network address may make per minute across every account. A class shares one address behind a venue's router, so this is room-sized; one account from one address is still held to 30 a minute. |
| `PASSWORD_WORK_QUEUE_LIMIT` | API | `64` | Password hashes that may wait at once. 1 to 128; anything else refuses the boot. |
| `PASSWORD_WORK_TIMEOUT_MS` | API | `30000` | Longest one hash may wait and run. 1000 to 60000; anything else refuses the boot. |
| `PASSWORD_WORK_IDLE_MS` | API | `30000` | Idle time before the hashing worker stops. 1000 to 60000; anything else refuses the boot. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | API | unset | Sign in with Google. Both are needed; with either missing the sign-in page draws no button and `/auth/google` refuses. |
| `GOOGLE_REDIRECT_URL` | API | `API_PUBLIC_URL` (else `http://localhost:<API_PORT>`) followed by `/api/v1/auth/google/callback` | Where Google sends the browser back. It must match a redirect URI on the OAuth client character for character. |
| `ALLOWED_EMAIL_DOMAINS` | API | empty: any address Google vouches for | Comma-separated domains Google sign-in accepts, without the `@`. |
| `AUTH_PROVIDER` | API | `local` | `local` keeps accounts in this database; `cognito` hands sign-in to an Amazon Cognito user pool ([Cognito sign-in](deployment/cognito-sso.md)). Anything else refuses the boot. |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `COGNITO_REDIRECT_URL`, `COGNITO_PROVIDERS`, `COGNITO_MIGRATION_SECRET` | API | empty | Read with `AUTH_PROVIDER=cognito` and checked at boot: the pool id must name a pool, the domain must be an HTTPS origin, the redirect must be exactly the API's `/api/v1/auth/sso/callback` (HTTP only on localhost), the providers comma-separated names, and the migration secret, when set, 64 lowercase hexadecimal characters. An incomplete set refuses the boot. |

## The AI provider

The mentor, the stakeholder interview, the Agentic assistant, the explanation check and the review of every submission all call one OpenAI-compatible endpoint. Without a key the API still starts and every page works; the mentor and the Agentic assistant answer that the AI is not configured, and a submission's review is recorded as unavailable, which never becomes a pass. `npm run demo`, `scripts/start.sh`, `npm run host` and the local Docker stack refuse to start without a key. `npm run demo` and the Docker stack take `--ai-stub` instead, which points the API at the test mentor (`e2e/ai-stub.cjs`); it passes only work carrying the test suite's marker.

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `OPENAI_API_KEY` | API | empty | The provider's key. Read only by the API; the web app never sees it. |
| `OPENAI_BASE_URL` | API | `https://api.openai.com/v1` | Any OpenAI-compatible Chat Completions endpoint. |
| `OPENAI_MODEL` | API | `gpt-5.6-luna` | The model every call uses. |
| `OPENAI_REASONING_EFFORT` | API | `none` | Sent as `reasoning_effort` when the model's name starts with `gpt-5`; other models are sent a temperature instead. |
| `OPENAI_TIMEOUT_MS` | API | `20000` | Longest one model call may take. A timeout is reported as an error, never as a passing assessment. |
| `AI_MAX_CONCURRENCY` | API | `4` | Model calls one API process may have open at once. A whole number from 1 to 32; anything else refuses the boot. One learner's calls always run one at a time. |
| `AI_CACHE_TTL_HOURS` | API | `24` | How long a cached mentor reply may be served again. |
| `AI_USAGE_TIMEZONE` | API | `Asia/Singapore` | The time zone whose midnight ends a day in the daily AI usage summaries. It limits nothing. An unknown zone falls back to the default. |
| `AI_AGENTIC_EDIT_LIST` | API | `off` | `off`, `on` or `strict`. `on` and `strict` behave alike: the Agentic proposal asks the model for an edit list instead of whole files, and a list that does not apply fails the turn. Anything else refuses the boot. |
| `AI_AGENTIC_PAYLOAD` | API | `full` | `full` or `trim`. `trim` sends the proposal call no file twice and, when the request names files, only those and what they import. Anything else refuses the boot. |

## The code runner and grading

Learner code runs only where the kernel can isolate it: Linux with Landlock (kernel 5.13 or later), or Docker on macOS and Windows, where the runner container runs inside a Linux virtual machine whose kernel has Landlock. Elsewhere the runner starts and refuses every Run, Submit and Preview. No setting changes that.

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `RUNNER_MODE` | API | `socket` | `socket`: the runner (`apps/api/runner/serve.py`) behind a UNIX socket. `lambda`: an AWS Lambda function. `local`: a child process of the API, refused in production and on any non-loopback bind. Any other value means `socket`. |
| `RUNNER_SOCKET` | API, runner | `/run/learnsdlc/runner.sock` | The socket the API and the runner share. The local scripts use `<temporary folder>/learnsdlc/runner-<API_PORT>.sock`. |
| `RUNNER_SLOTS` | API, runner | `JOB_CONCURRENCY` + 2 | Sandbox runs that may exist at once, for grading and for the request-path runs of the incident drill alike. Each side enforces it. Size the runner's memory for this times `RUN_MEMORY_MB`. |
| `RUN_TIMEOUT_SECONDS` | API | `15` | Wall-clock limit of one learner run. |
| `RUN_MEMORY_MB` | API | `256` | Memory limit of one learner run. |
| `RUNNER_MAX_WAIT_MS` | API, runner | `120000` | How long a caller waits for a free slot before it is told the runner is busy (503). The learner's work is saved and no attempt is spent. `docker-compose.yml` passes it to the runner only; the API container keeps the default. |
| `RUNNER_MAX_WAITING` | API | `200` | Callers that may wait for a slot at once; past it the busy answer comes at once. |
| `RUNNER_QUEUE_DEPTH` | runner | four per slot, at least 8 | Jobs that may wait inside the runner. Each waiter is a thread, counted against the runner container's process limit. |
| `RUNNER_TRANSPORT_ALLOWANCE_SECONDS` | API | `0` | Extra seconds the API waits for a runner reached over a slow transport (a MicroVM's boot). A whole number from 0 to 120; anything else refuses the boot. Never extends the learner's own time limit. |
| `RUNNER_STARTUP_OWNER_ID` | API | a fresh id at each boot | The owner id the boot-time runner check runs as; a lowercase UUID. |
| `RUNNER_RUNTIME_DIR` | runner | the `runtime` folder beside the runner's source | Where the sandbox's pre-baked dependencies are ([production runbook §3b](production-runbook.md#3b--the-sandboxs-pre-baked-dependency-layer)). The runner image sets `/runner/runtime`. |
| `GRADING_RUN_FANOUT` | API | unset: one run after another | The most sandbox runs one submission's review may hold at once, a whole number no larger than `RUNNER_SLOTS`. The runs and the report stay the same; only the wait changes. Anything else refuses the boot. |
| `GRADING_SPECULATIVE_MUTANTS` | API | `off` | `on` starts a Testing review's mutant runs beside its reference runs. Needs `GRADING_RUN_FANOUT`. Anything but `on` or `off` refuses the boot. |
| `SUBMIT_IN_FLIGHT_PER_LEARNER` | API | `2` | Queued or running submissions one learner may hold at once, across every phase. An advisory count, so two submits arriving together may both be admitted. |
| `PYTHON_BIN` | API, scripts | `python3` | The Python that starts the runner and builds the sandbox's dependencies on a laptop. It must be Python 3.11. `npm run demo` finds one and sets it. |
| `NODE_BIN` | runner, scripts | `node` | The Node that runs learner JavaScript: Node 22, apart from the application's own Node 24. `npm run demo` finds one through nvm and sets it. |
| `SANDBOX_NPROC` | runner | `64` | Processes one learner run may add. |
| `SANDBOX_LANDLOCK` | runner | unset | `0` turns the kernel fence off, for a test; the runner then refuses all learner code. Leave it unset. |
| `RUNNER_LAMBDA_FUNCTION` | API | `learnsdlc-code-runner` | The function `RUNNER_MODE=lambda` invokes. |
| `AWS_REGION` | API | `us-east-1` | The Lambda transport's region. |
| `AWS_ENDPOINT_URL` | API | unset | Points the Lambda client at a local emulator (LocalStack, `docker-compose.localstack.yml`). Only then are `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` read, with `test` for either one unset. |

## Live preview

"Run app" starts the learner's own application inside the runner. Each value is read by both the API and the runner, and the two must agree; `docker-compose.yml` passes the same value to both.

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `PREVIEW_ENABLED` | API | on | `false` turns the feature off. Always off with `RUNNER_MODE=lambda`. |
| `PREVIEW_SESSIONS` | API, runner | `2`, and `1` with `RUNNER_MODE=local` | Live sessions at once. The next learner is told the runner is busy. |
| `PREVIEW_MEMORY_MB` | API, runner | `512` | Memory per session. |
| `PREVIEW_IDLE_SECONDS` | API, runner | `300` | A session with no request and no status poll for this long is stopped. |
| `PREVIEW_MAX_SECONDS` | API, runner | `600` | A session is stopped after this long, whatever happens. |
| `PREVIEW_BOOT_SECONDS` | API, runner | `45` | How long the learner's application has to answer its health route. `docker-compose.yml` passes it to the runner only; the API container keeps the default. |
| `PREVIEW_BUILD_SECONDS` | API, runner | `30` | How long the front end's bundle may take to build. `docker-compose.yml` passes it to the runner only; the API container keeps the default. |
| `PREVIEW_MAX_BYTES` | API, runner | `33554432` (32 MB) | Bytes one session may serve before it is stopped. `docker-compose.yml` passes it to the runner only; the API container keeps the default. |
| `PREVIEW_REQUEST_TIMEOUT_MS` | API, runner | `20000` | One proxied request's limit. `docker-compose.yml` passes it to the runner only; the API container keeps the default. |
| `PREVIEW_SOCKET` | API | `preview.sock` beside `DB_PATH` | With `RUNNER_MODE=local` only: the socket the API's own preview runner listens on. |

## Content and classes

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `CONTENT_DIR` | API | the repository's `content/` folder | Where the built-in project packs are. The API image sets `/app/content`. |
| `DEFAULT_PROJECT` | API | unset | The project slug a learner with no enrolment and no class assignment is given, for a deployment that ships more than one pack. Unset, the project the import marked as the default. |
| `IMPORT_MAX_BYTES` | API | `32mb` | The largest class import (`POST /api/v1/instructor/cohorts/import`), as `32mb`, `512kb` or a byte count. The body is held in memory and parsed, about three times its size in all, so raise the API's memory with it. A teacher's project upload is bounded by the same value. |

## Mail

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `SMTP_HOST` | API | unset | The mail server for password recovery and address verification. Unset, nothing is sent and the API warns at boot. |
| `SMTP_PORT` | API | `587` | The server's port. |
| `SMTP_SECURE` | API | true only on port 465 | Implicit TLS. When the variable is set at all, only exactly `true` turns it on. `docker-compose.yml` passes it as an empty value, so under Compose set `SMTP_SECURE=true` yourself for port 465. |
| `SMTP_USER`, `SMTP_PASS` | API | unset, empty | Credentials. The API authenticates only when `SMTP_USER` is set. |
| `SMTP_FROM` | API | `LearnSDLC <no-reply@localhost>` | The sender. |
| `MAIL_CAPTURE_FILE` | API | unset | With `SMTP_HOST` unset, each message, its live one-hour link included, is appended here as one JSON line. Guard it like a mailbox. The local scripts set `data/mail.log`. |
| `MAIL_PREVIEW_URL` | API | unset | A loopback mail inbox the web app may link to (the local Docker stack's Mailpit). Any other address is ignored. |

## Retention and backups

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `RETENTION_FIRST_SWEEP_DELAY_MS` | API | `7200000` (two hours) | How long after a start the first daily clean-up waits ([production runbook §7b](production-runbook.md#7b--what-the-api-prunes-on-its-own)). `0` runs it at once. |
| `BACKUP_KEEP_DAYS` | `docker-compose.yml` backup service, `scripts/sqlite-backup.mjs` | `14` | Days of backups kept. |
| `BACKUP_INTERVAL_SECONDS` | backup service | `86400` | Time between database dumps. |
| `BACKUP_ONCE` | backup service | unset | Set to anything to take one dump and stop. |
| `BACKUP_DIR` | backup service, `scripts/sqlite-backup.mjs` | `/backups` in the service, `data/backups` for the script | Where backups go. |
| `BACKUP_KEEP_MIN` | `scripts/sqlite-backup.mjs` | `3` | The SQLite backup never prunes below this many backups, however old. |

## Demo accounts and the local scripts

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `SEED_DEMO_ACCOUNTS` | API | unset | Exactly `true` creates the demo instructor and administrator (`instructor@learnsdlc.test`, `admin@learnsdlc.test`), whose passwords are published. Refused, with a log line, under `NODE_ENV=production` and on any non-loopback bind. `npm run demo` and `start.sh` set it; `npm run host` refuses it. |
| `SEED_PASSWORD` | API, scripts | unset: the published demo passwords | One password for both demo accounts. It must meet the registration rules, or neither account is created. |
| `DEMO_CLOCK` | API | unset | Exactly `true` lets an administrator move the API's clock (`POST /api/v1/demo/clock`), outside production and on loopback only. `npm run demo -- --class` sets it. |
| `HOST_DRY_RUN` | `npm run host` | `0` | `1` prints the lab card and stops, building and starting nothing. |
| `AI_STUB_PORT` | `npm run demo`, `npm run demo:check` | `4199` | The test mentor's port with `--ai-stub`. |
| `DEMO_LOG` | `npm run demo` | `data/demo.log` | Where the servers' output goes. |
| `DEMO_CHECK_TIMEOUT` | `npm run demo:check` | `600` | Seconds the self-test waits for the demo to answer. |
| `NVM_DIR` | `npm run demo` | `~/.nvm` | Where the scripts look for nvm's Node 24 and Node 22. |
| `API_URL` | `scripts/journey.mjs`, `scripts/durability-check.mjs`, `scripts/seed-class.mjs`, `scripts/stack-seed.mjs` | the native demo's or the local stack's API | The API the script talks to, ending in `/api/v1`. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_INSTRUCTOR_EMAIL`, `SEED_INSTRUCTOR_PASSWORD` | `scripts/seed-class.mjs` | the demo accounts | The staff accounts `npm run seed:class` signs in as. |
| `STACK_ENV_FILE` | `scripts/stack-seed.mjs` | `.env.verify` | The file the stack's seed reads its generated passwords from. |
| `JOURNEY_REQUIRE_PREVIEW` | `scripts/journey.mjs` | unset | Exactly `true` makes a skipped live preview a failure. |
| `JOURNEY_WEB_UNAVAILABLE` | `scripts/journey.mjs` | unset | Exactly `true` says the runner cannot run the front-end half (the Lambda transport), and the journey checks that it says so. |
| `E2E_AI_STUB` | the scripts that submit work (`passing-work.mjs`) | unset | `true` marks submitted work for the test mentor; unset, the work goes in as written, for a real provider. |
| `DURABILITY_QUEUE`, `DURABILITY_KILL_CMD`, `DURABILITY_START_CMD` | `scripts/durability-check.mjs` | from `REDIS_URL`, empty, empty | Whether the queue is durable, and how the check stops and restarts the worker. |

## Observability

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `NODE_ENV` | API, web | `development` | `production` turns on the start-up checks for secrets and the administrator, JSON logs, migrations at boot, and the closed `/metrics`. The images set it. |
| `LOG_FORMAT` | API | `json` in production, `pretty` elsewhere | The API's log format. |
| `APP_VERSION` | API | unset | The build being run; reported by `/health/ready` and used as the error reporter's release. |
| `SENTRY_DSN` | API | unset | Report every 5xx and every failed job to Sentry. Unset, errors go to the log only. |
| `METRICS_TOKEN` | API | unset | The bearer token `GET /metrics` requires. Unset, the endpoint is open outside production and off in production. With it, `/health/ready` also names the projects and the runner's socket or function. |
| `NODE_OPTIONS` | Node | unset | `docker-compose.yml` sets `--max-old-space-size=768` on the API, below its memory limit. |

## The web app, at build time

| Variable | Default | What it does |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | The API's address, inlined into the browser bundle and the content security policy. A bundle built for one address calls that address from every browser. |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | The site's own origin, for canonical links, the sitemap and `robots.txt`. |
| `NEXT_PUBLIC_OPERATOR_NAME` | `LearnSDLC installation operator` | Who runs this installation, on the privacy and terms pages. |
| `NEXT_PUBLIC_OPERATOR_EMAIL` | unset: no contact address shown | Where privacy requests go. |

Under `docker-compose.yml` these are build arguments of the web image, and the first two default to `https://$API_HOST` and `https://$SITE_HOST`. Change one with `docker compose up -d --build web`.

## What the Compose files set

`docker-compose.yml` passes some API settings with values of its own, sized for a 2 vCPU, 4 GB host:

| Variable | API default | `docker-compose.yml` | Local Docker stack |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` |
| `API_BIND` | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| `TRUSTED_PROXIES` | `0` | `1` | `0` |
| `RUNNER_MODE` | `socket` | `socket` | `socket` |
| `RUN_MIGRATIONS` | on in production | `true` | `true` |
| `JOB_CONCURRENCY` | CPU count less one, at least 2 | `2` | `1` |
| `RUNNER_SLOTS` | `JOB_CONCURRENCY` + 2 | `4` | `2` |
| `AI_MAX_CONCURRENCY` | `4` | `1` | `1` |
| `OPENAI_TIMEOUT_MS` | `20000` | `20000` | `60000` |
| `PREVIEW_SESSIONS` | `2` | `2` | `1` |
| `PREVIEW_MEMORY_MB` | `512` | `512` | `256` |
| `WEB_ORIGIN` | `http://localhost:3000` | `https://$SITE_HOST` | `http://localhost:3080` |
| `SMTP_HOST` | unset | from the environment | `mailpit`, port 1025, no TLS |

The local Docker stack is `docker-compose.yml` with `docker-compose.verify.yml` laid over it and `.env.verify` as its environment file. The Compose file passes only the variables its services list; to set another one (`PREVIEW_ENABLED`, `AUTH_PROVIDER`, `IMPORT_MAX_BYTES` and others), add it to the service's `environment:` block first.

## Tests only

These are read by the test suites and are described in the [testing guide](testing.md): `PW_WEB_PORT`, `PW_API_PORT`, `PW_AI_PORT`, `PW_AI_HOST`, `PW_AI_STUB_LOG`, `PW_CHROMIUM_PATH`, `PW_VIDEO`, `PW_BUDGET`, `E2E_API_URL`, `E2E_WEB_URL`, `E2E_RUN_ID`, `E2E_GOOGLE_TOKEN_URL`, `E2E_GOOGLE_JWKS_URL`, `E2E_DEADLINE_PACK_DIR`, `E2E_DEADLINE_PACK_ZIP`, `E2E_JOURNEY_BODIES_DIR`, `E2E_JOURNEY_SHOTS`, `E2E_PAGE_PREVIEW_SHOTS`, `SCREENSHOTS`, `SHOTS_DIR`, `CI`, `POSTGRES_TEST_CONFIG`, `GAP_SECURITY_CONFIG`, `REDIS_TEST`, `GAP_SECURITY_REDIS`, `CONTRACT_BODIES_RECORD`, `CONTRACT_EXCHANGES_RECORD`, `PREBAKE_PROBE` (runs the runner's start-up check under `NODE_ENV=test`), `PREBAKE_CONTENT_DIR`, `TEST_WORKER_INDEX`, `HOST_DATA_DIR` and `HOST_API_DIST` (where `scripts/host.sh` keeps its data and finds the API build, moved by its spec), and a few that single specs read for their own output folders (`JOURNEY_OUT`, `JOURNEY_STRICT`, `JOURNEY_WRITTEN`, `MIGRATION_EVIDENCE_DIR`, `LSDLC_TREE_MIGRATIONS`, `SEALED_ROLES_RECORD_OUT`).

## Names that are not settings

- `LSDLC_PYLIB`, `NODE_PATH` and `ESBUILD_BIN` are computed by the runner from `RUNNER_RUNTIME_DIR` and refused when a job tries to set them.
- `RUNNER_ISOLATION` is set only by the single-job MicroVM supervisor of the [reference AWS deployment](deployment/microvm-controller.md), in its own fixed environment.
- `LSDLC_FS_ROOTS`, `LSDLC_PREVIEW_SECONDS`, `TASKTRACKR_DB` and `RUNNER_IDLE_EXIT_SECONDS` pass between the API's and the runner's own processes.
- `TZ`: the API sets it to `UTC` itself, so stored times are UTC whatever the machine says.
- The Compose files give some services fixed values that are part of the file, not settings: `POSTGRES_DB` and `POSTGRES_USER` (`learnsdlc`), the backup service's `PGHOST`, `PGUSER`, `PGDATABASE` and `PGPASSWORD`, Mailpit's `MP_MAX_MESSAGES` and LocalStack's `SERVICES`.

## Rules that are code, not settings

Some numbers that shape a class are constants, changed in code and reviewed, not set per deployment:

- **What a mentor question costs.** `HINT_FREE_ALLOWANCE` (10), `HINT_MARK_STEP` (3) and `HINT_MARK_CAP` (30) in `packages/shared/src/contract/mentor.ts`: the first ten questions in a phase are free, each one after that takes three marks off the `process` criterion, and the loss stops at thirty. Only phases whose rubric has a `process` criterion are charged. The grader and the learner's page both read these constants, so one edit changes the grade and the sentence together.
- **The login lock.** Ten failed sign-ins on one account in fifteen minutes lock it for the rest of the window (`apps/api/src/auth/auth.service.ts`).
- **Per-route rate limits** are written on each route ([API overview](api.md#rate-limits)).
