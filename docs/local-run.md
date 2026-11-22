# Running LearnSDLC on your own machine

LearnSDLC from SMU SCIS runs on one machine in two ways. This page covers both: what each needs, the commands and what they print, the AI key, the ports, where the data lives, how to stop and reset, hosting a class from one laptop, and the script that proves everything works. Every command runs from the repository root, the folder that holds the root `package.json`.

| | Docker mode (`npm run demo -- --docker`) | Native mode (`npm run demo`) |
|---|---|---|
| What runs | Containers: PostgreSQL, Redis, the code runner, the API, the web app, Caddy, Mailpit and a daily backup (and the test mentor with `--ai-stub`) | The API and the web app as Node processes, a SQLite file, an in-process job queue and the code runner as a local process |
| Learner code (Run, Submit, Run app) | Wherever Docker's Linux kernel has Landlock: Linux, and Colima on macOS | Only on Linux with Landlock |
| Everything else | Yes | Yes |
| Addresses | web http://localhost:3080, API http://localhost:4080/api/v1, mail http://localhost:5085 | web http://localhost:3000, API http://localhost:4000/api/v1 |
| Mail | Caught by Mailpit and shown on its page | Written to `data/mail.log` |
| AI | Your key in `.env`, or `--ai-stub` | Your key in `.env`, or `--ai-stub` |

Docker mode runs every feature on any machine whose Docker has Landlock. Native mode is for working on the code.

## What your machine can do

Learner code runs only where the kernel can isolate it. The code runner (`apps/api/runner`) fences each run with Landlock, which needs Linux 5.13 or newer with Landlock enabled (`cat /sys/kernel/security/lsm` lists `landlock`). On macOS and Windows, Docker runs its containers in a Linux virtual machine, so learner code runs there as long as that virtual machine's kernel has Landlock.

Where the kernel cannot fence learner code, the runner refuses every run, submission and preview of it. Nothing falls back to running it unconfined. The rest of the product still works: on a Mac without Docker, `npm run demo` starts and every page works, but Run, Submit and Run app are refused.

## Prerequisites

| Need | Native mode | Docker mode |
|---|---|---|
| An AI key | `OPENAI_API_KEY` in `.env` (or `--ai-stub`) | The same |
| Node | 24.9 or a later 24, or 26 and later (the `engines` field; `.nvmrc` names 24.21.0) | Any Node that runs the scripts; `nvm install` installs the one in `.nvmrc` |
| Node 22 | Required: learner JavaScript runs on it | Not needed on the host |
| Python | 3.11 exactly | 3.11 or newer, to write the sandbox manifest |
| Docker | Not needed | Docker with Compose 2.24 or newer, about 10 GB of free disk, and about 6 GB of memory for Docker |
| Other | `curl`, and `lsof` or `ss` | `curl` |

How the scripts find them:

- **Node.** `npm run demo` switches to the `.nvmrc` version with nvm when the Node on your path does not match the `engines` field. `npm ci` refuses any other Node, because `.npmrc` sets `engine-strict`.
- **Node 22.** `NODE_BIN` when it is set; otherwise the newest Node 22 that nvm has installed, or a `node22` on the path. `nvm install 22` is enough. Native mode stops without one, even on a Mac where learner code is refused anyway.
- **Python 3.11.** `PYTHON_BIN` when it is set, then `python3.11`, then `python3`. The sandbox's pre-baked libraries are built for 3.11 exactly, so native mode needs that version even when a newer `python3` is installed.

### macOS

1. Node through nvm: install nvm, then run `nvm install` in the repository, and `nvm install 22` for native mode.
2. Python 3.11: `brew install python@3.11`, or the installer from python.org.
3. For Docker mode, Colima, which runs Docker in a small Linux virtual machine whose kernel has Landlock:

   ```bash
   brew install colima
   colima start --cpu 4 --memory 8 --disk 60 --vm-type vz
   ```

   Colima needs the `docker` command with its Compose plugin, 2.24 or newer. If Docker Desktop is installed, its command and plugin work with Colima: quit Docker Desktop first, and `colima start` switches the `docker` context to Colima. Without Docker Desktop, `brew install docker docker-compose`, then follow the note brew prints about linking the Compose plugin.

   Colima shares only your home folder with its virtual machine, so keep the clone under your home folder. The stack checks that Docker can read the checkout and stops if it cannot.

   **Docker Desktop on its own is not enough on a Mac.** Its virtual machine's kernel has no Landlock, so the runner refuses learner code, and the stack stops at its health check with the runner's own line: `The runner reports: confinement: kernel isolation unsupported; ...`.

### Linux

1. Node through nvm, as on macOS.
2. Python 3.11 (`sudo apt install python3.11` where your distribution has it).
3. For Docker mode, Docker Engine with the Compose plugin (`docker-compose-plugin`), and your user in the `docker` group. Most current distribution kernels have Landlock; `cat /sys/kernel/security/lsm` shows whether yours lists it.

On Linux with Landlock both modes run learner code.

### Windows

The scripts are bash scripts, so use WSL 2 with a Linux distribution such as Ubuntu, and follow the Linux steps inside it. Keep the clone in the Linux file system (for example `~/learnsdlc`), not under `/mnt/c`. For Docker mode, Docker Desktop with its WSL 2 integration turned on for that distribution, or Docker Engine installed inside it.

Whether learner code runs depends on whether the kernel WSL 2 runs has Landlock, and this has not been checked on Windows. The scripts check it for you: native mode prints whether learner code is confined, and the Docker stack stops at its health check if the runner reports `kernel isolation unsupported`.

## Get the code and put in your key

```bash
git clone <repository URL> learnsdlc
cd learnsdlc
cp .env.example .env
```

Open `.env` and set your key:

```dotenv
OPENAI_API_KEY=<your key>
```

`.env` is ignored by git; never commit it. Its other active lines equal the defaults in the code, so a local run needs nothing else. Its `JWT_SECRET=` line is empty on purpose: the first native run generates a secret into it for this machine and never prints or replaces it.

## Your AI key

The mentor, the stakeholder interview, the Agentic mode and its explanation check, and the AI review in every graded submission call a model. So `npm run demo`, `npm run demo -- --docker` and `npm run host` refuse to start without `OPENAI_API_KEY`, in `.env` or in the environment. They exit with this message:

```text
  LearnSDLC needs an AI key to start, and none was found.

  Put your key in .env at the repository root (cp .env.example .env first):

      OPENAI_API_KEY=<your key>

  That uses OpenAI's default model (OPENAI_MODEL in .env.example names it).
  Any OpenAI-compatible hosted endpoint works too:
  set OPENAI_BASE_URL, OPENAI_MODEL and OPENAI_API_KEY in the same file.
  docs/local-run.md, "Your AI key", has the details.
```

The key goes only to the API. It is never written to `.env.verify` and never printed.

### Bring your own hosted model

The API calls a model in one way: an OpenAI-style Chat Completions request, `POST <OPENAI_BASE_URL>/chat/completions`, with the header `Authorization: Bearer <OPENAI_API_KEY>` (`apps/api/src/assistant/openai.provider.ts`). Any service that accepts that request can be used.

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | none | Sent as the bearer token |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | The API appends `/chat/completions` |
| `OPENAI_MODEL` | `gpt-5.6-luna` | The `model` of every request |
| `OPENAI_REASONING_EFFORT` | `none` | Sent as `reasoning_effort` only to models whose name starts with `gpt-5`. Other models are sent `temperature` 0.4 and `max_tokens` instead |
| `OPENAI_TIMEOUT_MS` | 20000 in the API and in `docker-compose.yml`; 60000 in the local Docker stack | How long one request may take before it counts as failed |
| `AI_MAX_CONCURRENCY` | 4 in the API; 1 in `docker-compose.yml`; always 1 in the local Docker stack | How many model requests one API process keeps open at once |

Native mode reads all of `.env`. The local Docker stack reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT` and `OPENAI_TIMEOUT_MS` from `.env` at every start. The [configuration reference](configuration.md) lists every other setting.

```dotenv
# .env: an OpenAI-compatible service other than OpenAI
OPENAI_API_KEY=<your provider's key>
OPENAI_BASE_URL=https://<your provider>/v1
OPENAI_MODEL=<your model id>
```

What the model has to do:

- **Return structured JSON.** Reviews, the stakeholder review and the explanation check send a JSON schema (`response_format` of type `json_schema`, `strict: true`); the Agentic intent check, the Agentic proposal and the mentor's self-review ask for a JSON object (`json_object`). The API checks every answer with its own parser, and an answer that fails is refused and shown as a failure to try again. It is never treated as a pass.
- **Hold a long prompt**: a request carries the phase brief, the rubric and the learner's files.
- **Answer in time**: `OPENAI_TIMEOUT_MS` per request, and 55 seconds for a whole Agentic or interview request.

A service whose only form is an Azure-style URL with an `api-version` query and an `api-key` header does not fit, because the API sends only the bearer header to `<base>/chat/completions`. The API reads no cloud credentials for its AI; to use a model that does not speak this request, put an OpenAI-compatible gateway in front of it.

### Does my model work?

With the product running on your configuration:

```bash
bash scripts/prove-local.sh --ai-check                                      # the Docker stack
bash scripts/prove-local.sh --ai-check --api http://localhost:4000/api/v1   # the native demo
```

It signs up throwaway learners and runs five steps against the model: a mentor reply, a rubric review the API's parser accepts, an Agentic proposal, an explanation check of a correct explanation, and the apply of the approved proposal. It prints pass or fail for each and the latency of the model-backed calls, writes a receipt to `tmp/prove-local-<UTC time>.json`, and exits non-zero if a step fails.

### Without a key: the test mentor

`--ai-stub` starts a canned, OpenAI-compatible test endpoint (`e2e/ai-stub.cjs`) and points the API at it. It is what the tests and the proof use, and it is the only way to start the local scripts without a key. It is not a model: it builds each answer from the request, it passes a review only when the work carries the marker `E2E-PASS`, and it accepts an Agentic explanation only with the same marker. Nothing leaves your machine, and the key in `.env` is ignored while it is on.

```bash
npm run demo -- --ai-stub            # native, the stub on 127.0.0.1:4199
npm run demo -- --docker --ai-stub   # Docker, the stub in its own container
```

## Docker mode

```bash
npm run demo -- --docker
```

`npm run demo -- --docker` hands over to `scripts/stack.sh up`. In order, it:

1. checks the AI key (unless `--ai-stub`);
2. checks Docker, Compose 2.24 or newer, that the ports are free, the free disk (it stops below 10 GB), that Docker can read the checkout, and Docker's memory (it warns below 6 GB);
3. on the first run, writes `.env.verify`: this machine's generated session secret, database password, administrator and instructor passwords, and the ports (mode 0600, ignored by git);
4. writes the sandbox manifest the runner image is built from, then builds the runner, API and web images one at a time;
5. starts the stack and waits for every health check (the API applies the database migrations and imports TaskTrackr as it boots);
6. creates the demo instructor through the API (`scripts/stack-seed.mjs`);
7. prints where everything is, then follows the API and runner logs.

When it works the end looks like this (the AI lines depend on your configuration):

```text
==> LearnSDLC is running (Compose project learnsdlc)

  Web          http://localhost:3080
  API          http://localhost:4080/api/v1
  Mail         http://localhost:5085 (every message the stack sends lands here)

  Learner      register at http://localhost:3080/register
  Instructor   instructor@learnsdlc.test, password STACK_INSTRUCTOR_PASSWORD in .env.verify
  Admin        ADMIN_EMAIL and ADMIN_PASSWORD in .env.verify
               Both passwords were generated for this machine: open .env.verify to sign in.

  AI           your provider from .env: model gpt-5.6-luna at OpenAI
               The API reports: openai
  Runner       its own container: no network, read-only, every learner run confined

  Stop         ctrl+c here, or: bash scripts/stack.sh stop
  Remove       bash scripts/stack.sh down        (add --fresh to delete the data too)
  Prove it     bash scripts/prove-local.sh --reuse
```

**Accounts.** Register learners at `/register`. The instructor is `instructor@learnsdlc.test`; the administrator is `ADMIN_EMAIL` in `.env.verify`. Both passwords are in `.env.verify`, and no script prints them. Every port is bound to 127.0.0.1, so nobody else on your network can reach the stack.

**Mail.** Registration confirmations and password resets go to Mailpit; open http://localhost:5085 to read them.

**Options.** `npm run demo -- --docker` takes these, and passes them to `scripts/stack.sh`:

| Option | What it does |
|---|---|
| `--ai-stub` | The test mentor in place of your key |
| `--detach` | Return to the prompt once the stack is up, leaving it running |
| `--fresh` | Delete this stack's data (database, queue, backups, certificates) first, then start clean |
| `--down` | Remove the containers instead of starting; the data is kept |

`scripts/stack.sh` takes the same options directly, and has more commands (`npm run stack -- <command>` is the same):

```bash
bash scripts/stack.sh up [--ai-stub] [--fresh] [--detach] [--no-build]   # --no-build reuses the images that are there
bash scripts/stack.sh stop               # stop the containers; data and images kept
bash scripts/stack.sh down [--fresh]     # remove the containers (with --fresh, the data too)
bash scripts/stack.sh status             # what is running
bash scripts/stack.sh logs               # follow every container's log
bash scripts/stack.sh compose <args>     # docker compose with this stack's files and project
```

`stop`, `down`, `status` and `logs` need no key, and use the AI the stack was last started with.

## Native mode

```bash
npm run demo
```

`npm run demo` runs `scripts/demo.sh`, which:

1. checks the AI key (unless `--ai-stub`);
2. checks Node (switching with nvm if it can), Node 22, Python 3.11, `ss` or `lsof`, `curl`, and that ports 3000 and 4000 are free;
3. asks the runner whether this kernel can fence learner code, and says so;
4. when `node_modules` or `.env` is missing, or the build is missing, older than the sources or made for another API address, runs `scripts/setup.sh`: `npm ci`, `npm run build`, the sandbox's pre-baked libraries (`node scripts/prebake.mjs build`), and `.env` with a generated `JWT_SECRET`;
5. checks the pre-baked libraries and rebuilds them if they do not match the project's pins;
6. migrates the database (`data/learnsdlc.sqlite`);
7. starts `scripts/start.sh`: the code runner on a UNIX socket, the API and the web app, with the demo staff accounts and mail written to `data/mail.log`;
8. waits for each to answer, prints a closing block, then shows the servers' output.

On Linux with Landlock the runner line reads `ok    sandbox runner on <socket>, confining learner code (landlock)`. On a Mac, or on a kernel without Landlock, the demo warns and carries on:

```text
  warn  this machine cannot isolate learner code (the runner says: kernel-isolation-unavailable).
  warn  The demo still starts, but Run, Submit and Preview of learner code are refused here.
  warn  For those, use npm run demo -- --docker (Colima on a Mac, Docker Engine on Linux).
```

The closing block:

```text
==> LearnSDLC is running

  Web        http://localhost:3000
  API        http://localhost:4000

  Learner    register at http://localhost:3000/register
  Instructor instructor@learnsdlc.test, password Instructor123!
  Admin      admin@learnsdlc.test, password Admin123!

  Runner     socket, apps/api/runner/serve.py, ...
  Queue      in process, no Redis needed
  AI         configured provider, openai
  Database   ...
  Mail       not sent, captured in data/mail.log
  Logs       data/demo.log, and everything below this line

  The API binds 127.0.0.1, so only this machine can use it. Model requests go
  to the AI named above. Stop with ctrl+c.
```

**Accounts.** Register learners at `/register`. The two demo staff accounts are `instructor@learnsdlc.test` (password `Instructor123!`) and `admin@learnsdlc.test` (password `Admin123!`); `SEED_PASSWORD` set in the environment replaces both passwords. They are demo-only. The API creates them only when `SEED_DEMO_ACCOUNTS=true` (which `scripts/start.sh` sets), the API is bound to a loopback address and `NODE_ENV` is not `production`. Wherever the API is reachable from the network, sign-in refuses these published passwords.

**Mail.** Without `SMTP_HOST` nothing is sent: each message, including live one-hour password reset links, is appended to `data/mail.log`. Treat that file as a mailbox.

**Options:**

| Option | What it does |
|---|---|
| `--ai-stub` | The test mentor on 127.0.0.1:4199 in place of your key |
| `--class` | After start, seed a class of 25 learners owned by the demo instructor, with five weeks of work, through the API (`scripts/seed-class.mjs`). It prints the class's join code and the learners' shared password |
| `--dev` | Live reload: the dev servers instead of the built bundles |
| `--rebuild` | `npm ci` and a full rebuild first |
| `--docker` | Docker mode, above |

The class seed wants reproducible hints, so it runs only while the test mentor answers: use `npm run demo -- --class --ai-stub`. With a real model it stops before creating anything and says so, and the demo keeps running; to seed the class anyway, run `npm run seed:class -- --any-mentor` in a second terminal while that demo runs. `npm run seed:class -- --remove` takes the seeded class out again.

**The two halves.** `npm run demo` runs `scripts/setup.sh` and `scripts/start.sh`, which also run on their own:

```bash
bash scripts/setup.sh           # check Node and Python 3.11, npm ci, build, pre-bake, .env with a generated JWT_SECRET
bash scripts/start.sh           # start the runner, the API and the web app from the built bundles
bash scripts/start.sh --dev     # the same with the dev servers
```

`scripts/setup.sh` is safe to run again: it keeps an existing `.env` and never replaces a real `JWT_SECRET`. `scripts/start.sh` uses the same database, settings and demo accounts as `npm run demo`, and refuses to start with no `.env` and no `JWT_SECRET` in the environment. The root `npm run dev` and `npm start` read `.env` too, but start no runner; see the [development guide](development.md).

**Check the demo itself.** `npm run demo:check` (add `-- --ai-stub` without a key) starts the demo against a scratch database, checks that the closing block and the API agree about the AI and the runner, signs in, interrupts it, and checks that both ports are free and the runner is gone. Without a key or `--ai-stub` it checks the opposite: that the demo refuses to start and holds no port. `-- --expect-fast` also checks that a second run reinstalled and rebuilt nothing.

## Ports

| What | Default | Change it with |
|---|---|---|
| Native web app | 3000 | `WEB_PORT` |
| Native API | 4000 | `API_PORT` |
| Native test mentor (`--ai-stub`) | 4199 | `AI_STUB_PORT` |
| Docker web app | 3080 | `STACK_WEB_PORT` |
| Docker API | 4080 | `STACK_API_PORT` |
| Docker mail page | 5085 | `STACK_MAIL_PORT` |

Native mode:

```bash
WEB_PORT=3100 API_PORT=4100 npm run demo
```

The web bundle carries the API's address, so when `API_PORT` changes, `npm run demo` rebuilds the web app for the new address before it starts.

Docker mode takes `STACK_*` before its first start, and `.env.verify` keeps them after that, because the web image is built for that API address:

```bash
STACK_WEB_PORT=3180 STACK_API_PORT=4180 STACK_MAIL_PORT=5185 npm run demo -- --docker
```

To move a stack that has already started, start it clean on the new ports. This deletes its data:

```bash
bash scripts/stack.sh down --fresh
rm .env.verify
STACK_WEB_PORT=3180 STACK_API_PORT=4180 STACK_MAIL_PORT=5185 npm run demo -- --docker
```

**A second checkout on the same machine.** Each checkout has its own `.env.verify`, but the stack's Compose project, and so its containers, volumes and images, is `learnsdlc` unless `LEARNSDLC_STACK_PROJECT` names another. Give the second checkout its own name on every `stack.sh`, `npm run demo -- --docker` and `prove-local.sh` command, and its own ports before its first start, to run both at once.

## Where the data lives

Native mode, all under the repository root and ignored by git:

| Path | What it is |
|---|---|
| `.env` | Your settings, the AI key and this machine's `JWT_SECRET` |
| `data/learnsdlc.sqlite` | The database, with its `-wal` and `-shm` files beside it. `npm run demo` uses this path unless `DB_PATH` is set in the environment; `scripts/start.sh` on its own also reads `DB_PATH` from `.env`, and takes a relative path from the repository root |
| `data/demo.log` | The servers' output |
| `data/runner.log` | The code runner's log |
| `data/mail.log` | Every message the API would have sent |
| `data/backups/` | Backups made with `npm run backup` |
| `apps/api/runner/runtime/` | The sandbox's pre-baked libraries |

The runner's socket is `runner-<API_PORT>.sock` in a `learnsdlc` folder under `$TMPDIR` (or `/tmp`).

Docker mode keeps its data in named volumes of the Compose project (`learnsdlc_` followed by `pgdata`, `redisdata`, `pgbackups`, `runnersock`, `caddydata` and `caddyconfig`), and in two files at the repository root: `.env.verify` (this machine's generated secrets, passwords and ports) and `.env.verify-ai` (which AI the stack was last started with). The database password in `.env.verify` is what opens the database volume, so keep the two together.

### Backups of the native database

```bash
npm run backup                                              # one backup into data/backups/
npm run backup:list                                         # the backups there, newest first
npm run restore -- data/backups/<file>.sqlite.gz --dry-run  # what a restore would do
npm run restore -- data/backups/<file>.sqlite.gz --force    # restore over data/learnsdlc.sqlite: stop the demo first
```

The [production runbook](production-runbook.md#7a--the-sqlite-store-3as-shape) covers the backup and restore drill in full, and the Docker stack's backups.

## Stop, restart and reset

| To | Native mode | Docker mode |
|---|---|---|
| Stop | ctrl+c (it stops the runner, the API and the web app) | ctrl+c, or `bash scripts/stack.sh stop` |
| Start again with the same data | `npm run demo` | `npm run demo -- --docker` |
| Remove the containers, keep the data | | `npm run demo -- --docker --down` |
| Start again with no data | Stop, delete `data/learnsdlc.sqlite` and its `-wal` and `-shm` files, then `npm run demo` | `npm run demo -- --docker --fresh` |
| Delete the data without starting | Delete the database files | `bash scripts/stack.sh down --fresh` |

A fresh database gets its migrations, the demo accounts and TaskTrackr again at the next start. Native mode keeps `.env` and its `JWT_SECRET`; Docker mode keeps `.env.verify`, so the same passwords sign in again.

If you delete `.env.verify` while the stack's database volume still exists, the next start refuses, because the database was created with the password in that file. `bash scripts/stack.sh down --fresh` removes the stack's containers and data by their Compose label, and the next start begins clean.

## Hosting a class from one laptop

`npm run host` (`scripts/host.sh`) serves native mode to a room on the local network: one command, the address printed, and a QR code for phones. It needs a Linux machine whose kernel has Landlock, because learners' code must run there. On a Mac, or a kernel without Landlock, it refuses before building anything:

```text
This machine cannot isolate learner code (the runner says: kernel-isolation-unavailable), so it
cannot host a class: every learner's Run, Submit and Preview would be refused.
Host from a Linux machine whose kernel has Landlock (5.13 or newer), or run the production
stack on a Linux server ("Running in production" in the README). npm run demo still shows
the product on this machine, to you alone.
```

Before the first time, run `bash scripts/setup.sh` and put your AI key in `.env`. Then:

```bash
npm run host
```

What it does:

1. Refuses `SEED_DEMO_ACCOUNTS=true` and `RUNNER_MODE=local` if they are set, and a `JWT_SECRET` that is a published placeholder or shorter than 32 bytes.
2. Without a `JWT_SECRET`, generates one and keeps it in `data/host.env` (mode 0600), so a restart does not sign the room out. Treat that file as a password.
3. Asks for the first administrator's address and password, unless `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, and refuses a password that registration would refuse (8 to 100 characters, and not a known breached password) before it builds or starts anything.
4. Checks Node, the AI key, Python 3.11, Node 22 and the kernel's isolation.
5. Rebuilds the web app when the machine's address has changed since the last build (`data/host-built-api-url`), because the browser bundle carries the API's address.
6. Starts the code runner and both servers with `API_BIND=0.0.0.0`, `NODE_ENV=production`, `SEED_DEMO_ACCOUNTS=false`, `RUNNER_MODE=socket` and `RUN_MIGRATIONS=true`, reading the rest of `.env`.
7. Prints the lab card:

```text
Lab is up.

  Learners open    http://<this machine's address>:3000
  You open         http://<this machine's address>:3000/instructor
  Mail             not sent, captured in data/mail.log
```

Sign in as the administrator, create a class from the console, and project its join code or QR code. Learners register and join with the code. Press ctrl+c to stop.

- `LAB_HOST` names the address when the script picks the wrong one. `WEB_PORT` and `API_PORT` move the two servers.
- `HOST_DRY_RUN=1 npm run host` (or `npm run host -- --dry-run`) prints the card without building or starting anything. It still generates `data/host.env` if there is no secret yet.
- Under WSL, the address the script finds is the Linux virtual machine's own, which the room may not reach. It says so: set `LAB_HOST` to the Windows machine's address and forward the two ports to the virtual machine, or turn on WSL's mirrored networking.
- The hosted API reads `DB_PATH` from `.env` with `apps/api` as its working folder, so with the `.env.example` value its database is `apps/api/data/learnsdlc.sqlite`, not the demo's `data/learnsdlc.sqlite`.
- Without SMTP settings in `.env`, mail is captured in `data/mail.log`, reset links included.

This is plain HTTP on the room's network, for an afternoon. For anything longer, run the Compose stack behind TLS: see the [production runbook](production-runbook.md).

## Prove that everything works

```bash
bash scripts/prove-local.sh                     # the whole proof (npm run prove is the same)
bash scripts/prove-local.sh --skip-durability   # leave out the queue durability check, the longest step
bash scripts/prove-local.sh --reuse             # against a stack already running with --ai-stub
bash scripts/prove-local.sh --ai-check          # only the AI steps, against a running stack's own AI
```

It needs Docker mode's prerequisites and Node 24.9 or newer, and no key. It installs this checkout's npm dependencies and builds `packages/shared` if they are missing, starts the Docker stack with the test mentor (`scripts/stack.sh up --ai-stub --detach`), and then runs eighteen checks in this order:

1. Health: the API is ready and the web app answers.
2. Sign-in of the generated administrator and the demo instructor.
3. The mentor answers a question.
4. A rubric review comes back and the API's parser accepts it.
5. An Agentic proposal.
6. The explanation check accepts a correct explanation (and, against the stub, Apply stays shut before it does).
7. Apply writes the approved files to the workspace.
8. Every kind of AI call the steps above make reached the stub's container.
9. The six-phase journey (`scripts/journey.mjs`), with Run and Submit of learner code through the runner and a live preview.
10. The runner container's own log shows the jobs and the preview.
11. A teacher uploads the Shelf project and its deep validation passes.
12. A teacher authors a Requirements task and a learner passes it.
13. The same for Design.
14. The same for Deployment.
15. The same for Maintenance.
16. A teacher uploads a three-phase project and a learner finishes it.
17. A teacher exports a project and uploads it again, and the two versions hold the same tasks.
18. A grading job survives the API container being killed (`scripts/durability-check.mjs`), which waits out the killed worker's lease.

Each check continues after a failure, so one run reports them all. The proof writes `tmp/prove-local-<UTC time>.json` (each step with its result and timing, the platform and the commit, and no secret) and the logs in the folder of the same name, prints a summary, and exits non-zero if any check failed. It leaves the stack running with the test mentor and the test accounts and projects it made; `npm run demo -- --docker` starts it again with your key, and `bash scripts/stack.sh down --fresh` clears the data.

`--ai-check` runs checks 3 to 7 only, against whatever the running stack is configured with; see [Does my model work?](#does-my-model-work).

## When something goes wrong

Each script stops with a sentence that names the problem and what to do. The [troubleshooting guide](troubleshooting.md) collects the ones people meet, with their causes and fixes. `bash scripts/stack.sh logs` shows the Docker stack's side, and `data/demo.log` and `data/runner.log` the native mode's.
