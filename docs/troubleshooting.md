# Troubleshooting

The failures a newcomer meets when starting LearnSDLC, each with the message the scripts or the API print, what it means and what to do. Messages are quoted as the code writes them; `<...>` stands for a value from your machine. Lines from the local-run scripts start with `ok`, `warn` or `fail` (green, yellow and red in a terminal).

If your problem is not here: [running it on your own machine](local-run.md) describes a run that works, the [configuration reference](configuration.md) lists every setting, and the [production runbook](production-runbook.md#9--failure-modes) has the failures of a deployed installation.

## Two facts that explain most surprises

1. **Learner code runs only where the kernel can isolate it**: Linux with Landlock (kernel 5.13 or later), or Docker whose Linux virtual machine has Landlock (Colima on a Mac). Anywhere else the product starts and every page works, but every Run, Submit and Preview of learner code is refused, and nothing falls back to running it unconfined.
2. **The local scripts need an AI key** for an OpenAI-compatible provider, in `.env` or the environment. `--ai-stub` swaps in the test mentor, which passes only work that carries the test suite's marker.

## Learner code

### Run, Submit and Preview are refused on a Mac

`npm run demo` warns before it installs anything:

```
warn  this machine cannot isolate learner code (the runner says: kernel-isolation-unavailable).
warn  The demo still starts, but Run, Submit and Preview of learner code are refused here.
warn  For those, use npm run demo -- --docker (Colima on a Mac, Docker Engine on Linux).
```

and, once it is up, `warn  sandbox runner on <socket> answers, and refuses learner code here (kernel-isolation-unavailable): Run, Submit and Preview are refused`. `bash scripts/start.sh` prints `runner: this machine cannot isolate learner code (kernel-isolation-unavailable); Run, Submit and Preview are refused`. In the product, the learner reads "The code runner cannot provide kernel isolation on this host. Your saved work is unchanged.", and no attempt is spent.

**Means:** macOS has no Landlock, so the runner refuses learner code by design. The same happens on Windows outside a Linux virtual machine, and on a Linux kernel older than 5.13 or built without Landlock. The runner's own log line is `confinement: kernel isolation unsupported; learner execution and previews are refused`.

**Do:** run the Docker stack, `npm run demo -- --docker`, in Colima on a Mac or Docker Engine on Linux ([running it on your own machine](local-run.md)). On Linux, check that the kernel has Landlock: the runner's log says `confinement: Landlock ABI <n> plus the in-process file policy` when it does. Do not set `SANDBOX_LANDLOCK=0`: it turns the fence off and the runner then refuses everything.

### The Docker stack stops at the health check on a Mac

```
  The runner reports: confinement: kernel isolation unsupported; learner execution and previews are refused
  Its kernel has no Landlock, so it refuses to run learner code and the stack stops here.
  Docker Desktop's VM kernel is built without Landlock (checked on Docker Desktop with
  Docker 27.4 on macOS). On a Mac, run the stack in Colima instead: ...
  fail  the stack did not become healthy (each service has five minutes; one that fails its health check stops it sooner).
```

**Means:** the runner container's health check fails because the virtual machine's kernel has no Landlock.

**Do:** use Colima on a Mac. Quit Docker Desktop, start Colima, and run `npm run demo -- --docker` again.

### `npm run host` refuses on a Mac

```
This machine cannot isolate learner code (the runner says: kernel-isolation-unavailable), so it
cannot host a class: every learner's Run, Submit and Preview would be refused.
```

**Means:** hosting a class needs the runner to confine learner code, so it refuses before it builds anything.

**Do:** host from a Linux machine whose kernel has Landlock, or run the Compose deployment on a Linux server ([production runbook](production-runbook.md)). `HOST_DRY_RUN=1 npm run host` still prints the lab card anywhere.

### A run says to run `npm run prebake`

**Means:** the sandbox's pre-baked dependencies (Flask, pytest, React, jsdom, esbuild) are missing or do not match the packs. `/health/ready` reports the `prebake` check as failed.

**Do:** `npm run prebake`, then `npm run prebake:verify` (exit 0, or one sentence per problem). `npm run demo` checks this itself and rebuilds when it must; if it prints `fail  the sandbox's dependencies could not be built; the message above says which one.`, the message above it names the package. The build needs the network and Python 3.11.

## The toolchain

### Node is missing or the wrong version

```
fail  node v<x> is unsupported. Use Node 24.9+ LTS: nvm install (it reads .nvmrc), then run this again.
fail  node was not found. Install nvm, then run: nvm install (it reads .nvmrc).
```

(`bash scripts/setup.sh` says `node v<x> is unsupported; use Node 24.9+ LTS (run 'nvm install').`) `npm ci` itself refuses another Node with `EBADENGINE`, because `.npmrc` sets `engine-strict`.

**Means:** the application needs Node 24.9 or later in the 24 line, or 26 and later (`package.json`'s `engines`). `.nvmrc` names the exact version CI and the images use.

**Do:** `nvm install` in the repository folder, then run the command again. `npm run demo` switches to the `.nvmrc` version by itself when nvm has it.

### No Node 22 for learner JavaScript

```
fail  learner code runs on Node 22, and none was found. Install it beside Node 24 (nvm install 22), or set NODE_BIN to a Node 22 binary.
```

`bash scripts/start.sh` only warns (`warning: no Node 22 was found ...`) and runs learner JavaScript on the application's Node.

**Means:** learner JavaScript runs on Node 22, the project pack's runtime, apart from the application's own Node 24.

**Do:** `nvm install 22` (the scripts find the newest Node 22 nvm has), or set `NODE_BIN` to a Node 22 binary. The Docker stack needs no Node 22 on the host.

### Python 3.11 is missing

```
fail  Python 3.11 was not found (python3 is Python 3.<x>). The sandbox runner and its pre-baked layer need 3.11 exactly. Install Python 3.11 (brew install python@3.11, or apt install python3.11), or set PYTHON_BIN to one.
```

**Means:** the native runner and the pre-baked dependencies are built for Python 3.11 exactly; a newer `python3` cannot stand in. The scripts look for `PYTHON_BIN`, then `python3.11`, then `python3`.

**Do:** install Python 3.11 beside the one you have, or set `PYTHON_BIN` to it. The Docker stack needs only Python 3.11 or newer on the host, to write the sandbox manifest (`fail  Python 3.11 or newer was not found; it writes the sandbox manifest the runner image is built from.`).

### `ss`, `lsof` or `curl` is missing

```
fail  neither ss nor lsof was found; one of them names whatever holds a port this needs. Install lsof.
fail  curl was not found; it is how this asks the servers whether they answer. Install it.
```

**Do:** install them with your package manager.

## Configuration

### No AI key

```
  LearnSDLC needs an AI key to start, and none was found.

  Put your key in .env at the repository root (cp .env.example .env first):

      OPENAI_API_KEY=<your key>
```

**Means:** `npm run demo`, `scripts/start.sh`, `npm run host` and the Docker stack refuse to start without `OPENAI_API_KEY` in the environment or in `.env`. Nothing was installed or started.

**Do:** put the key in `.env`. For another OpenAI-compatible provider, set `OPENAI_BASE_URL`, `OPENAI_MODEL` and `OPENAI_API_KEY` together. To try the product without a key, `npm run demo -- --ai-stub` uses the test mentor; it passes only work marked for the tests, so a learner's real work will not pass with it.

If the API was started another way (root `npm run dev`, say) without a key, it starts, and the mentor answers that the AI is not configured: "AI mentor is not configured. Your work is saved; configure the provider to continue."

### The API refuses to start without `JWT_SECRET`

```
BOOT FAILED: refusing to start: JWT_SECRET is not set, and every session is signed with it; run bash scripts/setup.sh, which generates one into .env for npm run demo, scripts/start.sh, npm run dev and npm start, or set JWT_SECRET=$(openssl rand -base64 48) in the environment
```

`bash scripts/start.sh` with no `.env` says `no .env, so there is no JWT_SECRET to sign sessions with - run: bash scripts/setup.sh`.

**Means:** there is no secret to sign sessions with, and the API has no default.

**Do:** `bash scripts/setup.sh` writes a generated one into `.env` (and `npm run demo` runs it on a fresh clone). Root `npm run dev` and `npm start` read `.env`; `node apps/api/dist/main.js` started by hand does not, so export `JWT_SECRET` first.

### The API refuses a short or published secret

```
BOOT FAILED: refusing to bind 0.0.0.0: JWT_SECRET is shorter than 32 bytes. Anyone who can reach this address can then mint an admin token. ...
BOOT FAILED: refusing to start in production with development defaults: set JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD (...)
```

**Means:** on an address other machines can reach, or with `NODE_ENV=production`, the secret must be at least 32 bytes and not one of the placeholders this repository ships; production also needs the first administrator's address and password.

**Do:** `export JWT_SECRET=$(openssl rand -base64 48)`, and set `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

### The API refuses `RUNNER_MODE=local`

```
BOOT FAILED: refusing to bind <address> with RUNNER_MODE=local: the local runner executes learner code as a child of this process ...
```

**Means:** the in-process runner gives learner code this process's user, network and environment, so it is allowed only on loopback outside production.

**Do:** unset `RUNNER_MODE`; the scripts start the socket runner, and `docker-compose.yml` uses the runner container.

### `npm run demo` refuses `API_BIND`

```
fail  API_BIND=<address> is not the demo path. Hosting a class needs a real JWT_SECRET and no demo accounts: ...
```

**Means:** the demo binds loopback so that its published demo passwords are safe.

**Do:** unset `API_BIND`. To serve a room, use `npm run host` (Linux with Landlock).

### Compose stops on a missing variable

```
required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD (the database password) before starting the stack
```

and the same for `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SITE_HOST` and `API_HOST`.

**Means:** `docker-compose.yml` has no defaults for secrets or hostnames.

**Do:** set them in `.env` or the environment ([production runbook §2](production-runbook.md#2--configuration)). `POSTGRES_PASSWORD` in hexadecimal: `openssl rand -hex 24`. The local Docker stack (`npm run demo -- --docker`) never meets this: it writes its own `.env.verify`.

### `npm run host` refuses the administrator's password

```
ADMIN_PASSWORD was refused, so no admin was created: it must be 8 to 100 characters. Set one the registration form accepts.
Nothing was built or started. Run this again with another password.
```

**Means:** the first administrator's password must meet the registration rules: 8 to 100 characters, and not on the list of passwords found in public breaches (`...: it appears in public breach lists.`). The API applies the same rule at boot and logs `ADMIN_PASSWORD was refused, so no admin was created: ...` instead of creating the account.

**Do:** choose another password.

## Ports

### A port is already in use

```
fail  port 3000 is already in use (<program> <pid>). Stop that process, then run this again.
```

`bash scripts/start.sh` says `port 3000 is already in use - stop the other process first`, and the Docker stack says `fail  port 3080 is already in use on this machine. Stop whatever holds it (lsof -iTCP:3080 -sTCP:LISTEN names it), then run this again. ...`.

**Means:** another program, often an earlier run you did not stop, holds the port. The native demo uses 3000 and 4000 (and 4199 with `--ai-stub`); the Docker stack 3080, 4080 and 5085.

**Do:** stop that program (`lsof -iTCP:<port> -sTCP:LISTEN` names it), or move LearnSDLC: `WEB_PORT=3100 API_PORT=4100 npm run demo`, or for the Docker stack `STACK_WEB_PORT`, `STACK_API_PORT` and `STACK_MAIL_PORT` before its first start (or after `bash scripts/stack.sh down --fresh`).

### A server answered, but not the one the demo started

```
fail  the api answered on port 4000, but not from the process this started: another process holds the port (<program> <pid>). Stop it and run this again.
```

**Means:** something took the port between the free-port check and the start, so the answer came from someone else's program.

**Do:** stop that program and run the demo again.

## The Docker stack

### A stack under another project name holds the ports

The stack is the Compose project `learnsdlc` unless `LEARNSDLC_STACK_PROJECT` names another. A stack started under another name keeps its containers, volumes and data under that name. While it runs it holds the stack's ports (3080, 4080 and 5085 by default), so a new start stops at `port 3080 is already in use`, and a stack under a new name starts with empty data and builds its images again.

**Do:** stop the other one with `LEARNSDLC_STACK_PROJECT=<its name> bash scripts/stack.sh stop`. To keep using its data, give `LEARNSDLC_STACK_PROJECT=<its name>` on every command instead. To delete it, `LEARNSDLC_STACK_PROJECT=<its name> bash scripts/stack.sh down --fresh`. `docker compose ls` lists the projects that are running.

### `.env.verify` is missing but the data is still there

```
fail  .env.verify is missing but this stack's database volume is still here, and its password was in that file. Run: bash scripts/stack.sh down --fresh (deletes the old data), then this again.
```

**Means:** the database password lived in `.env.verify`, so the old database cannot be opened.

**Do:** `bash scripts/stack.sh down --fresh` removes the stack's containers and data by their Compose label, then start again.

### Docker is missing, stopped or too old

```
fail  docker was not found. Install Colima (macOS), Docker Engine with the compose plugin (Linux) or Docker Desktop with WSL2 (Windows): docs/local-run.md, Prerequisites.
fail  the Docker daemon is not running. Start it (colima start on a Mac, sudo systemctl start docker on Linux), then run this again.
fail  docker compose <version> is too old; this needs 2.24 or newer. Update the compose plugin.
```

**Do:** what each line says.

### An image build stops with `DeadlineExceeded` on a Mac

```
#2 [runner internal] load metadata for docker.io/library/node:22.23.2-slim
#2 ERROR: DeadlineExceeded: context deadline exceeded
failed to solve: DeadlineExceeded: DeadlineExceeded: context deadline exceeded
```

**Means:** on a Mac that has Docker Desktop installed but not running (Colima is the daemon), `~/.docker/config.json` can still name Docker Desktop's credential helper (`"credsStore": "desktop"`). The `docker` command asks that helper before every pull, the helper waits for Docker Desktop, and the build gives up before it reaches the registry. The network and the registry are fine.

**Do:** one of these, then run the command again:

- remove the `"credsStore"` line from `~/.docker/config.json`; or
- give this shell a configuration folder without it. The folder needs the Compose plugin and, because it has no saved context, the address of Colima's daemon:

  ```bash
  mkdir -p ~/.docker-colima
  echo '{}' > ~/.docker-colima/config.json
  ln -s ~/.docker/cli-plugins ~/.docker-colima/cli-plugins
  export DOCKER_CONFIG=~/.docker-colima
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  ```

### Not enough disk or memory for Docker

```
fail  only <n> GB is free where Docker keeps its data; this needs about 10 GB (the images and room to build). ...
warn  Docker may use <n> GB of memory; this stack wants about 6 GB. Raise it (colima start --memory 8; Docker Desktop: Settings, Resources), or expect slow builds and out-of-memory restarts.
```

**Means:** the stack checks both before it builds. Too little disk stops it; too little memory is a warning, and builds or services may then be killed.

**Do:** free space (`docker builder prune`, `docker image prune`) or give the virtual machine a bigger disk; give Docker at least 6 GB of memory.

### Docker cannot see the checkout

```
fail  Docker cannot see this checkout (<path>): its VM does not share this folder. Clone under your home folder, or share the folder with the VM (Colima: colima start --mount <folder>), then run this again.
```

**Means:** Colima shares only your home folder by default, so files the stack mounts from the checkout would be empty.

**Do:** clone under your home folder, or share the folder with the virtual machine.

### Where are the sign-in details for the Docker stack?

The stack prints where they are, never the passwords: in `.env.verify` at the repository root, `STACK_INSTRUCTOR_PASSWORD` for `instructor@learnsdlc.test`, and `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the administrator. The published demo passwords do not work there ([below](#a-demo-password-is-refused)).

## Signing in

### A demo password is refused

The page says `invalid email or password`, and the API logs:

```
login refused: an instructor account <id> still has a password this repository publishes, and this API is reachable from the network (API_BIND=0.0.0.0); give it another with npm run user:set-password -w @learnsdlc/api
```

**Means:** wherever other machines can reach the API (the Docker stack's container, `npm run host`, a server), the demo accounts' published passwords are refused on purpose. The native `npm run demo` binds loopback and accepts them.

**Do:** on the local Docker stack, sign in with the passwords it generated into `.env.verify`. To give an account a new password, an administrator can set one from `/admin`, or an operator can use the command line ([production runbook §11](production-runbook.md#11--accounts-classes-and-recovery)); on the local Docker stack that is `bash scripts/stack.sh compose exec api sh -c 'cd apps/api && npm run user:set-password -- <email> <new password>'`.

### The demo accounts are not there

The API logs `SEED_DEMO_ACCOUNTS=true was ignored: ...`.

**Means:** the demo accounts are created only on a loopback bind and never with `NODE_ENV=production`, and not at all when `SEED_PASSWORD` fails the registration rules (`SEED_PASSWORD was refused, so the demo accounts were not created: ...`).

**Do:** use `npm run demo` for the demo accounts; anywhere else, sign in as the first administrator (`ADMIN_EMAIL`).

### A database holds staff accounts under another address

The demo accounts are `instructor@learnsdlc.test` and `admin@learnsdlc.test`, and the seed only ever adds them. It never renames or removes an account, so a database that already holds staff accounts under another address keeps them beside the demo ones, and the classes those accounts made stay with them.

**Do:** sign in with the address that owns the class you want. To give one of the other accounts a password you know, use `npm run user:set-password -w @learnsdlc/api`.

### An account is locked

Ten failed sign-ins on one account in fifteen minutes lock it until the window ends, and the answer is the same `invalid email or password`. Wait, or have an administrator set a new password from `/admin`.

## The database

### Migrations refuse an older SQLite file

```
refusing to run migrations against data/learnsdlc.sqlite: it holds <n> table(s) written by schema sync and no "learnsdlc_migrations" table, and its schema no longer matches the entities ...
```

**Means:** the file was built by schema auto-sync from an older build, so the migrations cannot take it over. Nothing was written to it.

**Do:** follow [production runbook §3a, "Adopting a file written before migrations"](production-runbook.md#adopting-a-file-written-before-migrations). For a database you do not need, move `data/learnsdlc.sqlite` aside and start again.

### Schema auto-sync refuses a file with rows

```
refusing to auto-sync the schema of <file>: it holds <n> row(s), and TypeORM's synchronize would run <n> statement(s) against them ...
```

**Means:** the API was started without `RUN_MIGRATIONS=true` (root `npm run dev`, say) against a file with data, and the schema differs from the code. Auto-sync would drop or retype columns, so it refuses.

**Do:** start with `RUN_MIGRATIONS=true`, as `npm run demo` and `scripts/start.sh` do.

### A restore refuses a newer backup

```
this backup is from a newer build. It carries 1 migration this build does not have: ...
```

**Means:** the backup was taken by a newer checkout than this one.

**Do:** update the checkout first ([production runbook §7a](production-runbook.md#7a--the-sqlite-store-3as-shape)).

### The project tables are not there

```
the project tables are not there, so <content folder> could not be imported: this instance needs RUN_MIGRATIONS=true, or a database another instance has already migrated, ...
```

**Do:** start with `RUN_MIGRATIONS=true`, or run the migrations once first.

### A content change is refused

```
<slug> is at <version>, which is already published from different bytes. A published version is immutable ...
```

**Means:** someone changed a pack under `content/` without changing its version, and the database already holds that version with the old bytes.

**Do:** raise the `version` in the pack's `project.json` ([authoring format](authoring-format.md)), or, for a development database you do not need, start a new one.

### The database is not in WAL mode

```
<file> is in "delete" journal mode rather than WAL. ...
```

**Means:** the SQLite file is on a network share or a synced folder that cannot hold WAL's shared memory, and every save then blocks every reader.

**Do:** move the database to a local disk.

## The web app

### "Can't reach the server"

**Means:** the browser could not reach the API at all: it is not running, or the web app was built for another API address. `NEXT_PUBLIC_API_URL` is baked in when the web app is built.

**Do:** check that the API answers (`curl http://localhost:4000/api/v1/health`). If you changed `API_PORT`, rebuild the web app for it; `npm run demo` notices this and rebuilds by itself (`warn  apps/web/.next was built for <address>. Rebuilding it for <address>.`).

### `node_modules` or the build is missing

```
node_modules missing - run: bash scripts/setup.sh
no build found - run: bash scripts/setup.sh   (or use --dev)
```

**Do:** `bash scripts/setup.sh`, or `npm run demo`, which runs it when needed.

## Tests

### `npm run test:infra` stops at once

```
fail  apps/api/runner/runtime/manifest.json is missing; infra/microvm/guest/test_package.py packages it. Run npm run prebake (or node scripts/prebake.mjs manifest), then this again.
```

**Do:** what it says. The [testing guide](testing.md) lists what every suite needs.
