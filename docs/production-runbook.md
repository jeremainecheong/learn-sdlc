# Production runbook

The supported way to run LearnSDLC in production is **`docker compose` from the
repository root, on a single host**. This document is that deploy path, end to
end: what the stack is, what to configure, how to start, verify, upgrade,
scale, back up and recover it.

There is one other supported shape, for an instructor hosting a single section
on their own machine: the same API with its store in one sqlite file, no
Postgres, no Redis, no containers. Everything here applies to it except where
a section names a container; §3a is what is different, and §7a is how you back
it up.

Two other things in the repository look like deployments:

- `infra/preview/` and `infra/microvm/` are a **reference deployment on AWS**:
  Terraform for one host, a MicroVM controller that runs each learner job in a
  fresh virtual machine, and a gateway in front of the application.
  `infra/preview/README.md` says what it builds and what it needs. This
  runbook does not depend on it.
- `docker-compose.localstack.yml` is the development and CI harness for the
  Lambda runner transport, not a way to run the product.

## 0 · What you are deploying

`docker compose up -d --build` starts seven services. Only `caddy` publishes
ports; everything else is reachable solely on the Compose network.

| Service | Built from | Role |
|---|---|---|
| `caddy` | `caddy:2-alpine` + `infra/Caddyfile` | TLS edge. Obtains and renews certificates for `SITE_HOST` and `API_HOST`, redirects HTTP to HTTPS, sets HSTS, proxies to `web` and `api` (WebSocket upgrades included). Ports **80 and 443, the only ones published.** |
| `web` | `apps/web/Dockerfile` | The Next.js client. `NEXT_PUBLIC_*` values are baked in at image build. |
| `api` | `apps/api/Dockerfile` | The NestJS API and queue worker in one process. Runs migrations at boot, drains grading jobs on `SIGTERM`, serves `/metrics`. Runs as the image's `node` user. |
| `runner` | `infra/runner.Dockerfile` | **Where learner code executes.** `network_mode: none`, read-only root filesystem, uid 65534, all capabilities dropped, `pids_limit: 128`, a 3 GB / 2 CPU cap, no curl. The API reaches it only over a UNIX socket on the shared `runnersock` volume (`RUNNER_MODE=socket`). |
| `postgres` | `postgres:16-alpine` | Every durable record: accounts, progress, submissions, feedback. Volume `pgdata`. |
| `redis` | `redis:7-alpine`, append-only | The durable job queue (BullMQ) and Socket.IO fan-out between API replicas. Volume `redisdata`. |
| `backup` | `postgres:16-alpine` | One `pg_dump` every `BACKUP_INTERVAL_SECONDS` (a day) into volume `pgbackups`, pruned after `BACKUP_KEEP_DAYS`. |

The API **refuses to start** with `NODE_ENV=production` and
`RUNNER_MODE=local`: the local runner would execute learner code as a child of
the API process, with its uid, network and environment. Compose sets
`RUNNER_MODE=socket`; leave it.

## 1 · Prerequisites

- A Linux host with Docker Engine and Compose v2. `docker-compose.yml` is sized
  for a 2 vCPU / 4 GB host. Every service is capped, so no one of them can
  take the host, and PostgreSQL with it, down:

  | Service | `mem_limit` | `cpus` | Note |
  |---|---|---|---|
  | `runner` | 3g | 2 | `RUNNER_SLOTS` runs × `RUN_MEMORY_MB`, plus `PREVIEW_SESSIONS` live previews × `PREVIEW_MEMORY_MB`, plus the server: 4 × 256 + 2 × 512 + 512 MB, about 2.5 GB at the Compose defaults. Also `pids_limit: 128`: a phase that spans two languages runs two children in sequence, esbuild runs its own service process, and a live preview holds a long-lived child plus two reader threads. The API gates every sandbox call at `RUNNER_SLOTS`, queued grading and the drill's health check alike, so this stays the ceiling however the runs arrive (§3c, and `RUNNER_SLOTS` in the [configuration reference](configuration.md#the-code-runner-and-grading)). Raise the limit and `RUNNER_SLOTS` together or neither. |
  | `api` | 1g | 1.5 | `NODE_OPTIONS=--max-old-space-size=768` sits below the cap, so a runaway heap is a Node error in the logs and in Sentry rather than exit 137. |
  | `postgres` | 768m | 1 | |
  | `web` | 512m | 1 | |
  | `redis` | 256m | 0.5 | No `maxmemory` and no eviction policy: an evicted key here is a submission that is never graded. |
  | `caddy` | 128m | 0.5 | |
  | `backup` | 256m | 0.5 | |

  They are ceilings, not reservations, so they deliberately sum to more than
  the host's memory. Raise them together with the host. The laptop profile in
  §3c is what to set instead when the whole stack has 8 GB to share.
- **The runner needs Landlock.** Learner code runs only where the kernel can
  confine it: Linux 5.13 or newer with Landlock enabled (Ubuntu 22.04 or
  Debian 12 and later have it). On a host without it the runner refuses every
  Run, Submit and Preview (§3c).
- **Node 24 and Python 3.11 or newer on the host**, for one step before each
  build: `node scripts/prebake.mjs manifest` writes the manifest the runner
  image is built from (§3b). Nothing else runs on the host outside Docker.
- **DNS first.** `SITE_HOST` and `API_HOST` must both resolve to the host's
  public address *before* the first `up`, and ports 80 and 443 must be
  reachable from the internet: Caddy issues certificates on boot and the stack
  is not usable until it has.
- Local trial without DNS: `SITE_HOST=localhost API_HOST=api.localhost`.
  Caddy serves both from its internal CA; the browser will warn once.

## 2 · Configuration

Compose reads `.env` in the repository root. Copy `.env.example` there and
fill in the values below. `.env` entries reach a container only because
`docker-compose.yml` names them in that service's `environment:` block, so a
variable that is not there is not seen by the container, whatever `.env` says.
A deployment that wants to set such a variable adds it to the service's
`environment:` block first.

**Every variable, its default, what reads it and what `docker-compose.yml`
passes is in the [configuration reference](configuration.md).** This section
names what a deployment must decide before the first start.

### Required: the stack will not start, or will not be safe, without these

| Variable | Read by | Purpose |
|---|---|---|
| `SITE_HOST` | caddy, web build, api | Public hostname of the web app, e.g. `learn.example.edu`. |
| `API_HOST` | caddy, web build, api | Public hostname of the API, e.g. `api.example.edu`. |
| `ACME_EMAIL` | caddy | Contact for the certificate authority (expiry warnings). Defaults to `admin@$SITE_HOST`; set a real mailbox. |
| `JWT_SECRET` | api | Signs session tokens. `openssl rand -base64 48`, unique per environment. The API refuses to start without one, and in production refuses a value under 32 bytes or one of the placeholders this repository ships, because a known value lets anyone mint an admin token. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | api | The first administrator. Required by the same start-up check. Created **once**, on the first boot that finds no `ADMIN` account; a settings row `bootstrap.admin` then makes them inert (§11). Choose an address nobody has registered with. The password must meet the registration rules (8 to 100 characters, not on the list of passwords found in public breaches); a refused one creates no account and the log says `ADMIN_PASSWORD was refused, so no admin was created`. Without an administrator a production deployment has nobody who can suspend an account or reset a password. |
| `POSTGRES_PASSWORD` | postgres, api, backup | Database password. There is no default: Compose refuses to start without it. Use hexadecimal (`openssl rand -hex 24`), because it is written into `DATABASE_URL`, and set it before the first start, because changing it later means changing it inside PostgreSQL too. |
| `OPENAI_API_KEY` | api | The AI provider's key, with `OPENAI_BASE_URL` and `OPENAI_MODEL` for a provider other than OpenAI. Without it the API starts, but the mentor and the Agentic assistant say the AI is not configured and every review is recorded as unavailable, so no AI-reviewed task can pass. |
| `NEXT_PUBLIC_OPERATOR_NAME`, `NEXT_PUBLIC_OPERATOR_EMAIL` | web build | Who runs this installation and where privacy requests go, on the privacy and terms pages. Without them the pages name a generic operator and give no contact. |

Set as well, when they apply: `ALLOWED_EMAIL_DOMAINS` with Google sign-in
(§11), `METRICS_TOKEN` to scrape `/metrics` (§8), `SMTP_*` for password
recovery mail (§11), `SENTRY_DSN` and `APP_VERSION` (§8).

The demo staff accounts (`instructor@learnsdlc.test` and
`admin@learnsdlc.test`) exist only when `SEED_DEMO_ACCOUNTS=true`, the API is
bound to loopback and `NODE_ENV` is not `production`. Compose sets none of
these, so a production deployment never has them, and `SEED_PASSWORD` means
nothing there. Their passwords are published, so wherever the API is reachable
from the network it refuses them at sign-in with the ordinary `401`, even on a
database the demo once created them in.

`docker-compose.yml` also fixes the deployment's shape: `NODE_ENV=production`,
`RUNNER_MODE=socket`, `API_BIND=0.0.0.0` inside the container (private to the
Compose network; only `caddy` publishes ports), `TRUSTED_PROXIES=1` for Caddy,
`DATABASE_URL` and `REDIS_URL` pointing at its own services, and
`RUN_MIGRATIONS=true`. It sizes the job and runner settings for a 2 vCPU /
4 GB host (`JOB_CONCURRENCY=2`, `RUNNER_SLOTS=4`, `AI_MAX_CONCURRENCY=1`). The
[configuration reference](configuration.md#what-the-compose-files-set) lists
every value it passes.

### The database role the migrations need

Every table's id default is `uuid_generate_v4()`, from the `uuid-ossp`
extension. `InitialSchema` runs `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
and a later migration runs it again for a database that applied
`InitialSchema` before that statement was part of it, because a recorded
migration does not run twice. The statement needs `CREATE` on the database.
The Compose stack's `POSTGRES_USER` owns its database and has it, but a
least-privilege application role on RDS, Cloud SQL or Neon usually does not.
On a managed PostgreSQL, either grant the role `CREATE` on the database, or run
this once as a superuser (`rds_superuser` on RDS) before the first boot:

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

Skipping it fails the first migration with `permission denied to create
extension "uuid-ossp"`; the api container then never becomes healthy, and web
and caddy never start behind their `depends_on` conditions.

### The locks a migration takes, and for how long

`database.module.ts` sets no `migrationsTransactionMode`, so TypeORM's default,
`all`, runs **the whole batch in one transaction**. Every lock any statement in
it takes is therefore held until the batch commits, not until that statement
finishes. That is the safety argument, and `SET lock_timeout` is not:
`lock_timeout` bounds how long a statement **waits to acquire** a lock, and
bounds nothing about how long one is **held**.

`H3-TaskStates` shows the shape to expect from any migration that widens a hot
table:

| Statement | Lock on `submissions` | Held until |
|---|---|---|
| `ALTER TABLE ADD "taskKey" … DEFAULT ''` | ACCESS EXCLUSIVE | commit of the whole migration |
| `CREATE INDEX IDX_submissions_task_created` | SHARE | commit |
| `DROP INDEX UQ_submissions_in_flight` | ACCESS EXCLUSIVE | commit |
| `CREATE UNIQUE INDEX UQ_submissions_in_flight` | SHARE | commit |

So a class is locked out of the table **for the duration of both index
builds**, not for the three seconds the timeout names. `CREATE INDEX
CONCURRENTLY` is unavailable for exactly the same reason: it cannot run inside
a transaction block, and one is open.

**Run a migration like this in a quiet window. If it aborts on `lock_timeout`,
nothing was applied** (one transaction, one rollback, the deployment exactly
where it was) **and it may simply be run again.** `down()` takes the same locks
in the same transaction and carries the same timeout; for `H3` the revert also
writes off any in-flight submission with *"This submission was interrupted by
a release rollback. Submit again."*, which is expected and is what lets the
one-column in-flight index be restored on a populated database.

Applied migrations are frozen by name and by body: TypeORM records each by
its class name in `learnsdlc_migrations`, so a migration file is never renamed
or edited once it has shipped. A change is always a new migration.

## 3 · First deploy

```bash
git clone <this repository> && cd learnsdlc
cp .env.example .env
$EDITOR .env                        # §2: hosts, secrets, admin, database password, the AI key
# or, without a .env file:
# export JWT_SECRET=$(openssl rand -base64 48) ADMIN_EMAIL=you@example.edu ADMIN_PASSWORD='…' \
#        POSTGRES_PASSWORD=$(openssl rand -hex 24) \
#        SITE_HOST=learn.example.edu API_HOST=api.example.edu ACME_EMAIL=ops@example.edu

node scripts/prebake.mjs manifest   # §3b: the runner image is built from runtime/manifest.json
docker compose up -d --build        # caddy (80/443, the only published ports) web api runner postgres redis backup
docker compose logs -f api          # wait for "LearnSDLC API listening on 0.0.0.0:4000"
```

`api` and `web` publish no host ports: everything goes through Caddy, so the
checks below use the public hostnames. For a local trial use
`SITE_HOST=localhost API_HOST=api.localhost`; Caddy signs those with its
internal CA, so either trust its root certificate or pass `curl -k`.

The boot line tells you what the process decided:
`(env=production, db=postgres, queue=redis, runner=socket, jobs=…, runnerSlots=…, fanout=…, speculativeMutants=…, errors=sentry+log, metrics=token)`.
`errors=log` means no `SENTRY_DSN`; `metrics=disabled` means no
`METRICS_TOKEN`.

Then:

1. `curl -fsS https://$API_HOST/api/v1/health/ready` must answer `200` with
   `"status":"ok"` (§4).
2. Open `https://$SITE_HOST`, sign in as `ADMIN_EMAIL`, open **Accounts**
   (`/admin`). Look up the instructors' accounts and promote them; they then
   create classes from the console's "Your classes" card and hand out the
   8-character join codes (§11).
3. Register a throwaway learner account and run the first code phase's "Run"
   action once. That proves the socket to the runner works, which nothing
   before this step exercises.

## 3a · One laptop, one class: the sqlite store

An instructor hosting a single section does not need Postgres, Redis or Caddy.
The API keeps every durable record in one sqlite file and runs the same
versioned migrations against it that the Compose stack runs against Postgres.
This is a supported shape, and it is the only supported one that is not
`docker compose`. Everything in §§4 to 11 applies to it except where a section
names Postgres, Redis or a container.

**The store's configuration.**

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | unset | an empty value is what selects the sqlite driver |
| `DB_PATH` | `data/learnsdlc.sqlite` | one file. Put it on the machine's own disk, not a network share and not inside a folder something syncs to the cloud: two writers on one sqlite file is how a term of coursework is lost |
| `RUN_MIGRATIONS` | `true` | migrations build the schema on a fresh file and are the only thing allowed to change it afterwards |

Schema auto-sync is off whenever migrations run: `resolveSchemaSync`
(`apps/api/src/config/database.ts`) returns false in production and false
whenever migrations run. It has to be. `synchronize` infers DDL from the entity
classes and will drop or retype a column to make a file match a model, which
is a convenience on an empty development database and a data-loss bug against
a class's work. Where auto-sync is on (development, without migrations) it
refuses a sqlite file that holds rows and names the statement it would have
run, rather than running it.

**The one-command demo takes the same path.** `npm run demo` (`scripts/demo.sh`)
exports `RUN_MIGRATIONS=true` and runs the migrations as a step of its own,
`npm run db:migrate -w @learnsdlc/api` (`apps/api/src/cli/migrate.ts`), before
anything binds a port. It prints one line (the file created and how many
migrations were applied, or that it was already at the latest one, or the
adoption described below), and on a file that has drifted the migration step
exits with the refusal in full and the demo starts nothing, so the message is
read on a terminal by the person who can act on it rather than found later in
a log. demo.sh also exports an absolute `DB_PATH` of
`<repo>/data/learnsdlc.sqlite`: the API runs with `apps/api` as its working
directory, and a relative value would put the file under `apps/api` rather than
where this section says it is.

The boot line names what the process decided (`db=sqlite`), and the line above
it says what happened to the schema: either

```
[Database] applied N migration(s): InitialSchema1787500326487, …
[Bootstrap] LearnSDLC API listening on 127.0.0.1:4000 (env=…, db=sqlite, …)
```

or, on a file that was already current, nothing between them at all.

**The journal.** The file is opened with `journal_mode = WAL` and
`synchronous = NORMAL` (`apps/api/src/db/database.module.ts`). better-sqlite3 is
synchronous, so every autosave is time this process spends serving nobody, and
in the rollback-journal default a commit takes an exclusive lock: one learner's
save and another's dashboard poll wait on each other. Under WAL a reader and
the writer do not wait on each other at all. What `NORMAL` gives up is narrow:
killing the process, or the whole machine crashing, cannot corrupt the file; a
power cut or kernel panic can lose the last few transactions.

WAL is a request, not a guarantee: sqlite silently stays in rollback-journal
mode on a filesystem that cannot give it shared memory, which is most network
shares and some synced folders. The boot says so when that happens:
`data/learnsdlc.sqlite is in "delete" journal mode rather than WAL`. Move the
file to a local disk.

You will see two more files appear beside the database, `…-wal` and `…-shm`.
They are part of it. Copying `learnsdlc.sqlite` on its own while the API is
running gives you a database missing everything typed recently. Use
`scripts/sqlite-backup.mjs` (§7a), which takes a consistent snapshot without
stopping anything.

**One writer, one process.** Exactly one API process may hold the file. §6's
replicas are for the Postgres shape; a second process against one sqlite file
is not a supported configuration.

### Adopting a file written before migrations

A sqlite file written by schema auto-sync has every table and no
`learnsdlc_migrations` table, and the first migration would meet a `users`
table that already exists. The API handles that itself: if the file's schema
already matches the entities exactly, then it is the schema the migrations
describe, so they are recorded as applied without being run and the boot
carries on.

```
[Database] data/learnsdlc.sqlite was written by schema sync and its schema matches
           the entities exactly, so its N migration(s) were recorded as applied
           without being run: InitialSchema1787500326487, …
```

If the schema does **not** match (the file is from an older build, or someone
has been in there with a sqlite shell) the boot stops instead, names the first
statement that differs, and writes nothing:

```
refusing to run migrations against data/learnsdlc.sqlite: it holds 11 table(s)
written by schema sync and no "learnsdlc_migrations" table, and its schema no
longer matches the entities … 6 statement(s) differ, the first being: …
```

Take a backup, bring the file up to the current entities once with the schema
tool that wrote it, and start again:

```bash
node scripts/sqlite-backup.mjs --db data/learnsdlc.sqlite      # first. Always first
cd apps/api
DB_PATH=../../data/learnsdlc.sqlite RUN_MIGRATIONS=false \
  npx typeorm-ts-node-commonjs schema:sync -d src/db/data-source.ts
```

It prints every statement it runs; read them before you accept them, because
this is the one command in this document that will drop a column to make a file
match a model. Then boot normally: the next start finds a matching schema,
adopts the file, and it is under migrations from then on. If the statements
are ones you are not willing to run, the other way out is to keep the old
build running, export the accounts you need from the admin console, and start
a new file.

**Upgrading.** Same as §5 without the containers: take a backup, `git pull`,
rebuild, restart. Migrations run at boot.

### Hosting for a room

`npm run host` (`scripts/host.sh`) is the demo's sibling for the afternoon a
class is in the room. It needs a Linux machine with Landlock, because learner
code runs only where the kernel can confine it; on a Mac, or a kernel without
Landlock, it refuses to host and says what to use instead. It also refuses what
`assertBindSafety` refuses, before anything starts: `SEED_DEMO_ACCOUNTS=true`,
`RUNNER_MODE=local`, a short or placeholder `JWT_SECRET`. It asks for the first
administrator's address and password (or takes `ADMIN_EMAIL` and
`ADMIN_PASSWORD`) and refuses a password the API would refuse, before it builds
or starts anything. With no `JWT_SECRET` set, a generated one is written to
`data/host.env` with mode 0600 so sessions survive a restart; that file is a
credential, not a log, and `.gitignore` covers it with the rest of `data/`.
The API runs with `NODE_ENV=production` on a bind the room can reach, so the
published demo passwords are refused at sign-in. The AI key comes from `.env`,
as it does for `npm run demo`. The script rebuilds the web app whenever the LAN address
differs from the one stamped in `data/host-built-api-url`, because
`NEXT_PUBLIC_API_URL` is inlined into the browser bundle at build time and a
bundle built for localhost sends every learner's browser to their own laptop.
`LAB_HOST` overrides the address.

This is plain HTTP on the room's network, for an afternoon. Run the Compose
stack behind TLS for anything longer. The QR code the console draws is
regenerated on every load from the address the API is reachable on now, so a
code printed on a slide last week points at last week's network: project the
console, not a screenshot.

## 3b · The sandbox's pre-baked dependency layer

TaskTrackr is a Flask API and a React front end, so a learner's run needs Flask
and pytest on the Python side and jsdom, React, Testing Library and the esbuild
binary on the front-end side. None of it is installed at run time: a sandboxed
child has no network and no `pip`, and installing on the request path would put
a package manager inside the isolation boundary. It is built once, ahead of
time, into `apps/api/runner/runtime/`.

```bash
npm run prebake          # build it
npm run prebake:verify   # exit 0, or one sentence per problem
node scripts/prebake.mjs print   # the digest alone, for a cache key
```

- **What may be in it is a code change, not a content edit.** The names allowed
  are the three lists in `apps/api/runner/runtime_manifest.py`
  (`ALLOWED_PYTHON`, `ALLOWED_NODE`, `ALLOWED_TOOLS`), and the versions are the
  pack's, from `project.json`'s `runtime` block. A pack that asks for something
  off the list is refused at build. Adding a dependency to the sandbox goes
  through review.
- **esbuild is pinned by checksum** over `package/bin/esbuild` inside
  `@esbuild/<platform>`, per version and platform, in
  `apps/api/runner/runtime_manifest.py`.
- **It is gitignored and rebuilt per machine.**
- **`RUNNER_RUNTIME_DIR` is the only knob.** `LSDLC_PYLIB`, `NODE_PATH` and
  `ESBUILD_BIN` are computed by the runner from it and are refused when a job
  tries to set them.
- **The image builds its own.** esbuild is a native binary and some wheels are
  platform-specific, so `infra/runner.Dockerfile` builds the layer for its own
  architecture rather than copying the host's. The build context needs
  `runtime/manifest.json` to know what to build, so write it **before**
  `docker build -f infra/runner.Dockerfile` or `docker compose build`:
  `node scripts/prebake.mjs manifest` writes the manifest alone (Node and
  Python 3.11 or newer, no network), and `npm run prebake` writes it with the
  whole layer.
- **When it is missing or stale**, a learner's run comes back with one sentence
  naming `npm run prebake` rather than a raw `ModuleNotFoundError`, the API's
  boot probe logs the same, and `/health/ready` reports the `prebake` check as
  failed. The front-end half needs two parts of it (`node/node_modules` and
  `bin/esbuild`) and a run that finds either missing gives the same sentence,
  so "Run npm run prebake." is the whole of the fix on a machine that runs
  learner code itself; in Compose, rebuild the runner image (§5).
- **Lambda**: `scripts/localstack-lambda.sh` packages the Python half into the
  function zip and sets `RUNNER_RUNTIME_DIR=/var/task/runtime`. The Node half
  and the esbuild binary are left out, because the python3.11 runtime has no
  Node, so the front-end half of a phase needs `RUNNER_MODE=socket` on that
  transport.
- **CI** caches `apps/api/runner/runtime` on `node scripts/prebake.mjs print`,
  so the key moves when a pinned version does and stays put when nothing did.

## 3c · Live preview

"Run app" starts the learner's own application inside the runner and shows it in an iframe.
The runner supervises one child per session (the pack's Python API on a loopback port the
kernel chooses) and serves the built front end itself out of `web/dist`, so the whole preview
comes back through the UNIX socket the runner already listens on. Nothing new is exposed: the
port is never returned to anyone, and the browser reaches the app through the API's own door at
`/api/v1/preview/<capability>/`. The capability is an unguessable id, redacted from the access
log and from error reports, revoked by Stop and dead with the session.

The learner's app runs under `PREVIEW_BOOTSTRAP`, which relaxes the sandbox's total socket block
to loopback and nothing else: `connect`, `bind`, `sendto` and `sendmsg` are refused unless the
address is 127.0.0.1, ::1 or a path inside the session's own workspace, and the resolver answers
for `localhost` and refuses every other name. Every `exec`, `spawn`, `system`, `popen` and
`ctypes` is refused exactly as it is in a graded run. **This is a second line of defence and can
be unwound by code in the same interpreter.** What actually holds is where it runs: the runner
container is `network_mode: none`, so the namespace has a loopback device and nothing else.

**The kernel fence.** Every child the runner starts (a graded run, a smoke check, a live preview)
is fenced to its own workspace by a Landlock ruleset, which is unprivileged and so works with
`cap_drop: ALL` and `read_only: true`: the child's workspace and that run's sealed graded
directory read-write, the interpreter, the baked library and the system directories read-only,
and nothing else, so a sibling `/tmp/lsdlc-*` workspace is refused by the kernel whatever the
program unwinds. Inside the interpreter every Python bootstrap also refuses `open`, `listdir`,
`scandir`, `chdir`, `mkdir`, `rename`, `remove` and `sqlite3.connect` outside those same paths,
and `TMPDIR` points inside the workspace so `tempfile` keeps working with `/tmp` closed. Node
children have no in-process file guard of their own. `docker-compose.yml` needs no change for
any of this: Docker's default seccomp profile allows the `landlock_*` calls.

**Without the fence, nothing runs.** On a kernel with Landlock the runner proves once, before
the first job, that python3, node and esbuild still start under the ruleset. Where Landlock is
absent (macOS, a kernel older than 5.13 or built without it, a seccomp profile that hides the
calls), where that self-test fails, or where `SANDBOX_LANDLOCK=0` switches the kernel layer off,
the runner logs

    confinement: kernel isolation unsupported; learner execution and previews are refused

and answers every job and every preview `unavailable`: the learner is told the code runner
cannot provide kernel isolation on this host and that their saved work is unchanged, and no
attempt is spent. `/health/ready` reports the `isolation` check as failed. On a host where the
fence holds the line reads `confinement: Landlock ABI n plus the in-process file policy`. Read it
with `docker compose logs runner | grep confinement`. The one exception is the single-job MicroVM
supervisor of the reference deployment, where each job gets a fresh virtual machine and the log
says so.

What bounds a session: five idle minutes, ten minutes whatever happens, 32 MB served, 512 MB of
memory, and `PREVIEW_SESSIONS` live sessions per runner. A session that passes any of them is
stopped and says which.

The status poll counts as a touch, so idle means the tab is closed or hidden. The panel counts
down from the ten-minute cap once less than two minutes are left. A session stopped for its bytes
says `budget`. Each limit is a `PREVIEW_*` setting, read by both the API and the runner
([configuration reference](configuration.md#live-preview)).

`docker-compose.yml` passes every one of them except `PREVIEW_ENABLED` and `PREVIEW_SOCKET`
to both services with the same defaults, because the API's session cap and deadlines are per
API process and have to agree with the runner's.

**The budget arithmetic, in one place.** `RUNNER_SLOTS × RUN_MEMORY_MB + PREVIEW_SESSIONS ×
PREVIEW_MEMORY_MB + the server` is `4 × 256 + 2 × 512 + 512` MB at the Compose defaults, inside the
runner service's 3g `mem_limit`. `apps/api/src/config/runner-budget.ts` holds the same arithmetic,
and `config.spec.ts` refuses a container profile that does not fit. A container over its limit is
killed and takes every in-flight learner's run with it, so raise the limit before raising either
count.

**The laptop profile.** On an 8 GB machine running the whole stack, 3 GB for the runner is
tight:

    RUNNER_SLOTS=2  PREVIEW_SESSIONS=1  RUN_MEMORY_MB=256  PREVIEW_MEMORY_MB=256

To turn previews off: `PREVIEW_ENABLED=false` (add it to the `api` service's environment under
Compose). The Preview tab then says so and everything else in the phase works as normal. On the
Lambda transport it is off and cannot be switched on, because a Lambda invoke has nowhere to keep
a process running, and the runner answers a preview job with "preview is not available on this
transport".

**What stops a session when nobody is left to stop it.** The idle sweep, the hard cap and the
byte budget are all enforced by a sweep thread inside the runner process, which ticks every five
seconds. Kill the runner rather than shut it down and none of them is enforced any more: the
child is reparented to init, blocks in `accept()` spending no CPU so `RLIMIT_CPU` never fires
either, and outlives everything. So the child is armed with the same deadline, plus 30 seconds,
inside `PREVIEW_BOOTSTRAP`. The grace keeps the ordinary case unchanged: the sweep still stops a
supervised session first and still reports `expired`; the child's own deadline only fires when
there is nobody left to do it, and it writes one line to the console before it goes.

**The learner's own front end must not use browser storage.** The frame runs
`sandbox="allow-scripts allow-forms allow-modals"` with no `allow-same-origin`, so it is an
opaque origin: `localStorage` and `sessionStorage` **throw** on every access, `document.cookie`
is silently dropped and `history.pushState` is unreliable. The symptom of using one is a blank
page the learner blames themselves for. The canonical application uses hash routing and keeps
its state in its own API, and the content checker's `no-browser-storage` rule makes a violation
fail the author rather than the learner.

## 3d · Upgrading a database written for an older TaskTrackr

A fresh install needs nothing in this section. It is for a database that has
served an older version of the TaskTrackr pack (the version this repository
ships is the `version` in `content/tasktrackr/project.json`). Older versions
kept some phases as markdown files, where the current pack keeps every phase's
written work as a record: the story (`requirements/story.json`), the design
(`design/design.json`), the runbook (`deployment/runbook.json`) and the change
request (`maintenance/change-request.json`). The API converts what it can on
its own, at migrate time and at boot, and keeps a receipt of what it did.

**Take a backup first** (§7, or §7a for the sqlite store). Then deploy as §5
says, with one difference below.

**What runs, in order.**

1. **Data migrations** convert each learner workspace whose version already
   grades the record. A workspace whose words would not fit, or whose files
   cannot be read, is refused: left exactly as it was, never trimmed, and
   listed with its reason. Submissions keep the snapshots they were graded on.
   Each writes a receipt to the `settings` table: `story-migration.receipt`,
   `design-migration.receipt`, `runbook-migration.receipt` and
   `change-migration.receipt`.
2. **The null-pin pass**, before the import, pins each enrolment stored with no
   version to its project's newest published version, and prints
   `null pin: pinned N enrolment(s) … ` on every boot. Its receipt is
   `null-pin.receipt`.
3. **The import** publishes the pack this checkout ships. If a platform pack's
   slug is held by a project that is not the platform's own (a teacher's upload
   or copy), the import skips that pack and prints
   `"<slug>": skipped; a teacher's project holds this slug, so the platform pack was not imported`.
   That line is an alarm, not a count: stop and find out why a platform row is
   marked as a teacher's before going on.
4. **The structured re-pin**, after the import and once an admin account
   exists, moves each enrolment whose version holds a phase in an older format
   to its project's newest published version, converting that phase in the
   same savepoint, but only when the version's other phases compile to the
   same digests as the head's. It writes one `enrolment.repin` audit row per
   learner it moves, moves class assignments with a `cohort.project.repin` row,
   and prints one line beginning `structured re-pin:` with its counts: moved,
   converted per phase, left with a submission in flight, refused, stranded
   (because another phase, or the set of phases, differs from the head), waiting
   for an admin account, and on an archived version. A learner stranded because
   the head holds a different set of phases gets an `enrolment.repin.stranded`
   audit row naming the first phase that differs.
5. **The reference twins** read: `reference twins: read N published reference version(s) for their plain-text twins`,
   on every boot. If it reports `not read at boot`, restart the API and check
   that the line reads a count.
6. **The draft passes** convert teachers' unpublished drafts once each, and
   print `story drafts:`, `design drafts:`, `runbook drafts:`, `change drafts:`
   and `plain-text drafts:` lines. A draft that cannot be converted is left as
   it was; the builder converts it on its teacher's first save.

**Run that boot on one API instance.** The re-pin's check for a submission in
flight is a plain read with no lock, so a second instance serving learners
while it runs could accept or grade a submission the re-pin then moves, and two
first boots side by side would both try to insert the null-pin receipt. On a
replica set (§6), stop the replicas, start one `api` container with
`RUN_MIGRATIONS=true`, wait for the `plain-text drafts:` line, then scale back
up. A single-instance deployment needs nothing more.

**When the re-pin reports learners in flight.** A submission on the durable
queue survives the restart, so the learner it holds stays where they are until
the queue drains. Watch the queue until no such submission is queued or
running, then restart the API once more; that boot's `structured re-pin:` line
should report 0 in flight. While any pin stays stranded or refused, the re-pin
runs on every boot and prints the same line: that is expected and changes
nothing.

**Learners left behind.** A refused or stranded learner stays on their version
with their work untouched. In a phase still in the older format their room
says the task "is in an older format; its owner needs to re-save it", with
Check and Submit disabled. A teacher's project moves its learners once the
teacher converts the project, publishes it and the API restarts. For a refused
conversion the way out is to fix the row by hand (for example, by shortening
the words that would not fit) or to move the learner with an audited override;
the next boot converts it.

**Read the receipts by count only.** Never select a receipt's `value` whole: it
lists state and draft ids. On PostgreSQL:

```bash
docker compose exec -T postgres psql -U learnsdlc -c "
SELECT key, length(value) FROM settings WHERE key LIKE '%.receipt'"
docker compose exec -T postgres psql -U learnsdlc -c "
SELECT key, jsonb_build_object('counts', value::jsonb->'counts',
         'refused', jsonb_array_length(coalesce(value::jsonb->'refused', '[]')),
         'skipped', jsonb_array_length(coalesce(value::jsonb->'skipped', '[]')))
FROM settings WHERE key LIKE '%.receipt'"
```

On the sqlite store, use `json_extract(value, '$.counts')` and
`json_array_length(value, '$.refused')` in the same places.

The local demo (`npm run demo`) takes the same path: it opens the database it
finds and migrates it as it is, and the boot steps above run there too.

## 4 · Verify a deployment

```bash
API=https://$API_HOST
curl -fsS $API/api/v1/health/live       # process alive; touches nothing
curl -fsS $API/api/v1/health/ready      # 200 when every check passes, 503 otherwise
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" $API/metrics | head   # Prometheus text
curl -si  $API/metrics | head -1        # 401 without the token
curl -si  $API/api/v1/health/live | grep -i x-request-id   # every response carries one
```

`/health/ready` probes the database and the queue with a 2 s bound and names
every check:

```json
{"status":"down","dependencies":[
  {"name":"database","ok":true,"detail":"postgres","required":true},
  {"name":"queue","ok":false,"detail":"timed out after 2000ms","required":true}, …],
 "queue":{"backend":"redis-bullmq","durable":true},"aiProvider":"…","version":"a1b2c3d","uptimeSeconds":…}
```

| Check | Required | Reports |
|---|---|---|
| `database` | yes | PostgreSQL (or the sqlite file) answers `SELECT 1`. |
| `queue` | yes | Redis answers; without `REDIS_URL` it reads "not durable". |
| `runner` | no | The runner socket answers (socket transport), or the Lambda function name and region are set (Lambda transport). |
| `prebake` | no | The pre-baked layer is present and current (§3b). |
| `content` | yes | Whether any project version is registered. An instance that registered none answers `unknown project` to every learner while database, queue and runner all read green. |
| `content-compiler` | no | Whether every registered version was compiled by *this* build and can be graded by it. A published version keeps the snapshot it was published with, so drift alone means only a version bump is owed. |
| `isolation` | no | Whether the runner can confine learner code (§3c). |

`status` is `ok` when every check passes, `down` when a required one fails and
`degraded` when only others fail. Anything but `ok` answers 503, so a load
balancer stops routing to the instance.

The *detail* on the two content checks (the project slugs, their versions, and
which build compiled them) and on the `runner` check (the socket path, or the
Lambda function and region) is behind the same credential as `/metrics`:
present `Authorization: Bearer $METRICS_TOKEN` and you get the names, otherwise
you get counts only (`3 projects registered`) and `socket runner` or
`lambda runner`, with failure sentences that leave the path out. `/health/ready` is public, and a
load balancer needs the counts, not the catalogue. On a machine with no
`METRICS_TOKEN` set outside production the names are open, as `/metrics` is.
The boot log always carries both in full for an operator reading the process
rather than probing it.

The image declares an equivalent `HEALTHCHECK`; an orchestrator should point
its **liveness** probe at `/health/live` and its **readiness** probe at
`/health/ready`.

Full functional verification against the running deployment (needs a shell
with Node on any machine that can reach the API):

```bash
# The journey's console checks sign in as ADMIN_EMAIL when both ADMIN_* are
# exported (production has no instructor@ demo account), so export them first.
API_URL=https://$API_HOST/api/v1 node scripts/journey.mjs     # every phase, both layers
node scripts/durability-check.mjs                             # kills a worker mid-job; run on the host
```

The journey asserts every code phase's run comes back with **both** groups by
their labels ("API tests" and "Front end"), so a deployment that has lost one
language fails here rather than scoring what is left. It also starts a preview
and looks at the learner's own app through the door; where preview is off or
unavailable it says so and does not fail, and `JOURNEY_REQUIRE_PREVIEW=true`
makes a skipped preview a failure for a deployment that is supposed to have one.
Against a real AI provider the journey's submissions are reviewed like any
learner's, so the provider decides whether each phase passes; CI runs it
against the test mentor (`e2e/ai-stub.cjs`) with `E2E_AI_STUB=true`, which
marks the work for it.

The Playwright suite (`npx playwright test`) runs `apps/api/dist/main.js`
against a fresh SQLite file, with a fixed test-only `JWT_SECRET` that the API
refuses wherever a real secret is needed, so `npm run build -w @learnsdlc/shared && npm run
build -w @learnsdlc/api` must precede it for API changes to be exercised, and
`apps/web/.next` must be a successful build (`rm -rf apps/web/.next && npm run
build -w @learnsdlc/web` after a failed one).

The suite serves the web app with `npm run start -w @learnsdlc/web`, which
copies the static files into `.next/standalone` and runs
`node .next/standalone/apps/web/server.js`, the same standalone server the image
runs. It takes ports 3000 and 4000 by default; to run it beside anything already
holding them, set both, and build the web bundle with the matching API port,
because `next build` inlines it:

```bash
PW_WEB_PORT=3100 PW_API_PORT=4100 NEXT_PUBLIC_API_URL=http://localhost:4100 \
  npm run build -w @learnsdlc/web
PW_WEB_PORT=3100 PW_API_PORT=4100 npx playwright test
```

`E2E_API_URL` overrides the derived API origin when the API is somewhere else
entirely; `playwright.config.ts` puts the resolved value back in the
environment, so the specs that call the API directly follow it.

### Trying the whole stack on one machine, beside something else

Ports 80, 443, 3000 and 4000 are often taken on a workstation, and a local
trial does not need Caddy. Two scratch files put the whole stack somewhere
else. Neither belongs in the repository, and `.gitignore` covers `.env.*`:

```yaml
# docker-compose.trial.yml
services:
  api:
    ports: ['4200:4000']
  web:
    ports: ['3200:3000']
```

```bash
# .env.trial: SITE_HOST/API_HOST still satisfy Compose's required variables
cat > .env.trial <<'EOF'
SITE_HOST=localhost
API_HOST=api.localhost
JWT_SECRET=<openssl rand -base64 48>
ADMIN_EMAIL=ops@example.test
ADMIN_PASSWORD=<a strong password>
POSTGRES_PASSWORD=<openssl rand -hex 24>
OPENAI_API_KEY=<your key>
WEB_ORIGIN=http://localhost:3200
NEXT_PUBLIC_API_URL=http://localhost:4200
NEXT_PUBLIC_SITE_URL=http://localhost:3200
EOF

node scripts/prebake.mjs manifest
docker compose -p learnsdlc-trial --env-file .env.trial \
  -f docker-compose.yml -f docker-compose.trial.yml \
  up -d --build postgres redis runner api web backup
```

`caddy` is left out of that service list on purpose: it wants 80 and 443, and
there is nothing for it to terminate TLS for once `api` and `web` publish their
own ports. Everything else behaves as it does in production: migrations at
boot, no demo accounts, `RUNNER_MODE=socket`. Verify with
`API_URL=http://localhost:4200/api/v1 node scripts/journey.mjs`, then
`docker compose -p learnsdlc-trial ... down -v` to remove the containers and
their volumes. For a local stack with its own generated secrets, a demo
instructor and a mail catcher, `npm run stack` (`scripts/stack.sh`) is the
supported command.

## 5 · Upgrading

```bash
git pull
export APP_VERSION=$(git rev-parse --short HEAD)   # or put it in .env
node scripts/prebake.mjs manifest                   # §3b
docker compose build
docker compose up -d
```

`up -d` recreates only the services whose image or configuration changed.
The old `api` container gets `SIGTERM`, stops taking new jobs, finishes the
grading jobs it holds, then exits; Compose sets `stop_grace_period: 60s` on the
api service because its default of 10 s would `SIGKILL` in-flight grading. The
new container applies any pending migration before it listens. A job that was
still in Redis is picked up by the new worker.

The drain is bounded. The queue gets 50 s to close gracefully; if Redis is
unreachable at that moment the API does not wait for a reconnect that may
never come. It cuts its queue connections at once and logs a line containing
`cutting connections`, saying that any in-flight job is re-delivered to the
next worker. Either way an interrupted job is re-run by whichever worker comes next, which
is what `SIGKILL` would have produced, only sooner and on record.

Confirm what is applied:

```bash
docker compose exec api node node_modules/typeorm/cli.js \
  migration:show -d apps/api/dist/db/data-source.js     # one [X] row per applied migration
```

A database that served an older TaskTrackr has more to read at the first boot:
§3d.

### When a migration stops on duplicate enrolments

`A3-UniqueEnrolmentAndInFlightIndexes` adds a unique index on `enrollments
(userId, projectSlug)`, and an old database may hold two rows for one learner
and one project. The migration repairs what it can on its own: submissions
still marked queued or running are written off as failed, and a duplicate
enrolment holding no phase states, submissions, runs, messages or releases is
deleted. What is left is a real choice, so it stops with the learner named:

```
A3 cannot add the unique index on enrollments (userId, projectSlug): 1 duplicate
enrolment(s) hold learner work … See docs/production-runbook.md before re-running.
```

Nothing has been written when that message appears: the whole migration runs
in one transaction. Look at the two enrolments and decide which one is the
learner's real board:

```bash
docker compose exec postgres psql -U learnsdlc -c \
  "select id, \"startedAt\", \"currentPhaseOrder\", completed from enrollments
     where \"userId\" = '<userId>' and \"projectSlug\" = '<slug>' order by \"startedAt\";"
docker compose exec postgres psql -U learnsdlc -c \
  "select \"phaseKey\", status, \"bestScore\", attempts from phase_states
     where \"enrollmentId\" = '<enrolmentId>' order by \"phaseOrder\";"
```

Also count `submissions`, `execution_runs`, `assistant_messages` and `releases`
for each `enrollmentId`. Keep the one with the work in it. Then, **after a
backup** (§7, or §7a on sqlite), delete the other's children before the
enrolment itself (`phase_states`, `submissions`, `execution_runs`,
`assistant_messages`, `releases`, then `enrollments`) and run the upgrade
again. A learner whose board you delete loses that copy for good, so read both
before you choose.

### Rolling back

Rollback is the same procedure at the previous commit. If the commit you are
leaving added a migration that must be undone, revert it first:

```bash
docker compose run --rm --no-deps api \
  node node_modules/typeorm/cli.js migration:revert -d apps/api/dist/db/data-source.js
```

One revert refuses on purpose. `B9-AuditTombstones` lets an audit row keep its
event after the account it was about is deleted, by nulling its
`subjectUserId`. Reverting it would put `NOT NULL` back on that column, so on a
database that holds such rows it stops with their count and "See
docs/production-runbook.md before re-running." Restoring the constraint would
either invent an id or destroy the record of a deletion, so the answer is to
leave that migration applied and roll back only what came after it.

Never enable `synchronize` against a database holding learner data: it infers
DDL from entities and will drop or rewrite columns. Production never does; do
not set `RUN_MIGRATIONS=false` outside the procedure in §6.

## 6 · Replicas

The API is stateless: run several `api` containers behind Caddy and they share
the Redis queue (grading work is distributed automatically) and the Redis
Socket.IO adapter (a learner's live updates reach whichever replica holds
their socket).

Two rules make that safe:

1. **Migrate once, as a one-shot step, before the replicas start.** Several
   replicas applying the same migration at once race on the DDL; the loser's
   transaction fails and its container restarts. Harmless but noisy, and the
   wrong place to find out a migration is slow.
2. **`RUN_MIGRATIONS=false` on every replica.** Replicas only serve.

```bash
docker compose build api
# one-shot migration with the api image and the api service's environment
docker compose run --rm --no-deps -e RUN_MIGRATIONS=true api \
  node node_modules/typeorm/cli.js migration:run -d apps/api/dist/db/data-source.js
# then the replicas
RUN_MIGRATIONS=false docker compose up -d --scale api=3 api
```

Caddy's `reverse_proxy api:4000` resolves the service name to every replica
and round-robins between them. `JOB_CONCURRENCY` and `RUNNER_SLOTS` are per
replica, so size the `runner` service for the total.

`RUN_MIGRATIONS=false` is honoured in production and never turns schema
auto-sync on (`resolveRunMigrations` and `resolveSchemaSync` in
`apps/api/src/config/database.ts`, covered by `config.spec.ts`).

The **per-route rate limits are shared** across replicas: with `REDIS_URL`
set, which a replica set already requires for the queue, `RateLimitGuard`
counts each window in Redis, so `@RateLimit(30, 60)` is 30 requests a minute
for the whole deployment, not 30 per container. If Redis stops answering
within `COUNTER_TIMEOUT_MS` (250 ms) the guard falls back to counting in that
process and logs `rate limit counters fell back to this process only`: the
limit still holds, it just holds N × max across N replicas until Redis returns
(a second line records the recovery). A Redis outage never turns a sign-in into
a 500.

The login throttle (10 failures per account in 15 minutes) is counted in each
process, so on a replica set each replica allows its own ten. Session
revocation is not per process: every request reads the account's current
token version, so a suspension, role change or password change takes effect on
the next request on every replica, and the socket disconnect for that user
propagates everywhere through the Redis adapter.

## 7 · Backup and restore drill

PostgreSQL holds everything that matters. Redis holds only in-flight jobs and
can be rebuilt by resubmitting; Caddy re-issues certificates on its own. On the
one-laptop shape the same sentence is true of the sqlite file, and §7a is the
backup, prune and restore for it.

**What the `backup` service does.** Every `BACKUP_INTERVAL_SECONDS` (a day) it
writes `$BACKUP_DIR/learnsdlc-<UTC timestamp>.sql.gz` (a plain-SQL
`pg_dump --no-owner`) into the `pgbackups` volume, and **only then** deletes
files older than `BACKUP_KEEP_DAYS`. `docker compose logs backup` shows
`backup: wrote …` per run, or `backup: pg_dump FAILED`; alert on the latter.

The prune runs only inside the dump's success branch, and only while a dump
inside the retention window would survive it. A prune that ran whether or not
the dump worked would let a fortnight of failing dumps delete the last good
backup on the fourteenth night with nothing said; this way a long outage keeps
backups too long rather than deleting the ones that remain.

**Alert on the sidecar, not only on its log.** Each run rewrites
`$BACKUP_DIR/metrics.prom`, a Prometheus textfile carrying
`learnsdlc_backup_consecutive_failures` and
`learnsdlc_backup_last_success_seconds`. Both survive a restart (they are read
back out of the file at boot), so a container that is restarted nightly cannot
hide a run of failures. Alert on either: failures above zero for two days, or a
last success older than two intervals.

**Prove it without waiting a day.** `BACKUP_ONCE` takes one dump and stops:

```bash
docker compose run --rm -e BACKUP_ONCE=1 backup
```

**A backup on the same disk is not a backup.** Copy the volume off the host
on a schedule (cron, an object-store sync, whatever you already run):

```bash
docker compose cp backup:/backups ./offsite/$(date +%F)      # then ship ./offsite elsewhere
# or straight off the named volume (<project> is the Compose project name, by
# default the folder's name), without the backup container:
docker run --rm -v <project>_pgbackups:/b -v "$PWD/offsite":/out alpine cp -r /b /out
```

**Take one now** (before an upgrade, before a restore):

```bash
docker compose exec backup sh -c \
  'pg_dump --no-owner | gzip > /backups/manual-$(date -u +%Y%m%dT%H%M%SZ).sql.gz'
```

**Restore drill: do it before you need it, and again every quarter.** It
restores the latest dump into a scratch database next to the live one, checks
it, and drops it. Nothing touches `learnsdlc`.

```bash
LATEST=$(docker compose exec backup sh -c 'ls -t /backups/*.sql.gz | head -1' | tr -d '\r')
docker compose exec -T postgres psql -U learnsdlc -c 'CREATE DATABASE learnsdlc_drill'
docker compose exec -T backup gunzip -c "$LATEST" \
  | docker compose exec -T postgres psql -U learnsdlc -d learnsdlc_drill -q
docker compose exec -T postgres psql -U learnsdlc -d learnsdlc_drill -c \
  'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM phase_states) AS phase_states'
docker compose exec -T postgres psql -U learnsdlc -c 'DROP DATABASE learnsdlc_drill'
```

The counts must be what you expect from yesterday; if the restore errors or
the tables are empty, the backups are not usable and that is the finding.

**Real restore** (data loss, corruption, or moving to a new host; on a new
host, `docker compose up -d postgres` first so the volume exists):

```bash
docker compose stop api web                        # nothing writes during the restore
docker compose exec -T postgres psql -U learnsdlc -d postgres -c \
  'DROP DATABASE learnsdlc; CREATE DATABASE learnsdlc'
gunzip -c learnsdlc-<timestamp>.sql.gz | docker compose exec -T postgres psql -U learnsdlc -d learnsdlc -q
docker compose start api web
curl -fsS https://$API_HOST/api/v1/health/ready
```

Migrations are idempotent: the API finds the restored schema current and
applies nothing. Jobs that were mid-flight at the time of the dump show as
`failed` with a message asking the learner to resubmit; that is the intended
outcome.

### 7a · The sqlite store (§3a's shape)

The `backup` service above knows only how to `pg_dump` the Postgres container.
A laptop hosting a class has no Postgres and no container; its whole term is one
file. `scripts/sqlite-backup.mjs` is that half.

| Command | What it does |
|---|---|
| `npm run backup` | one verified backup, then prune |
| `npm run backup:list` | what is in `data/backups`, newest first |
| `npm run backup:drill` | back up, restore into a scratch file, compare, clean up |
| `npm run restore -- <file.gz>` | put a backup back, over `$DB_PATH` unless `--to` says otherwise |

**Take one now** (before an upgrade, before a restore, before anything):

```bash
npm run backup                                        # --db $DB_PATH, --out data/backups
# backup: wrote data/backups/learnsdlc-<timestamp>.sqlite.gz (<size>, <rows> rows across <tables> tables, head <migration>)
```

Each archive gets a small `….sqlite.gz.json` manifest beside it holding what is
in it (the schema it was taken on, the per-table counts, the size and a
sha256), so `npm run backup:list` can answer without opening every archive. The
manifest is optional on read: for an archive without one, the listing opens the
file.

It uses sqlite's online backup API, so the API can keep serving while it runs:
the copy is a consistent snapshot taken page by page, and it includes what is
still in the write-ahead log, which a `cp` of the database file does not. Before
the copy counts as a backup the script reads it back, runs sqlite's
`integrity_check` against it and counts every table; only then is it compressed
and renamed into place. An interrupted run leaves nothing a restore could pick
up.

**On a schedule.** Either a timer of its own, in a terminal you leave open:

```bash
npm run backup -- --every 360                         # every six hours, until interrupted
```

or the machine's scheduler, which survives a reboot:

```cron
0 * * * *  cd /path/to/learnsdlc && /usr/bin/node scripts/sqlite-backup.mjs >> /var/log/learnsdlc-backup.log 2>&1
```

**Retention.** `--keep-days` (default `$BACKUP_KEEP_DAYS`, else 14) deletes
older backups, and `--keep-min` (default `$BACKUP_KEEP_MIN`, else 3) is the
floor it will not prune below, so a laptop that spent a month shut still has
its last few.

**A backup on the same disk is not a backup.** `data/backups` is on the disk
that is going to fail. Copy it somewhere else on a schedule you actually keep;
a USB stick in a drawer counts, a synced folder counts:

```bash
rsync -a data/backups/ /Volumes/BACKUP/learnsdlc/          # or a cloud-synced folder
```

**Restore drill: do it before you need it, and again every quarter.** Same
shape as the Postgres one above: take a backup, restore it into a scratch file,
compare the row counts, delete the scratch file. Nothing touches the live
database, and it exits non-zero if any table did not come back whole, so it can
be the thing your cron line alerts on.

```bash
npm run backup:drill
```

```
drill: restored learnsdlc-<timestamp>.sqlite.gz into a scratch file
table                     live   backup  restored
…
drill passed: every table restored with the row count the backup holds
```

`live` is the database as it is right now and `backup` is the snapshot; on a
running system `live` may legitimately be ahead. What has to match is `backup`
against `restored`. If the counts are zero, or the drill errors, the backups
are not usable and that is the finding.

**Look before you leap.** A restore cannot be undone, so ask what one would do
first. `--dry-run` reads the archive, checks it against this build and prints
both sets of row counts, and it returns before anything is renamed; there is no
path through it that writes:

```bash
npm run backup:list
npm run restore -- data/backups/learnsdlc-<timestamp>.sqlite.gz --dry-run
```

```
restore: the backup is intact and its schema matches this build (head <migration>).
restore: it would replace data/learnsdlc.sqlite

table                       now   backup
…
restore: nothing was written. Re-run without --dry-run to do it.
```

**Real restore** (data loss, corruption, or moving to a new laptop):

```bash
# stop the API first: nothing may be writing during a restore
npm run backup:list
npm run restore -- data/backups/learnsdlc-<timestamp>.sqlite.gz --to data/learnsdlc.sqlite --force
# start the API
curl -fsS http://127.0.0.1:4000/api/v1/health/ready
```

Four things happen before a byte is written.

- **Is anything holding the target open.** A restore into a file the API still
  has open is how a good backup becomes a corrupt database, so the script asks
  the database for an exclusive lock and refuses if it cannot have one:

  ```
  data/learnsdlc.sqlite is still being written to. Stop the API and run this again.
  ```

- **Does the backup fit this build.** Integrity and row counts say a file is a
  database; they say nothing about whether its columns are the ones this build
  declares. The script compares the migrations the archive has applied with the
  ones this checkout carries. **Behind** is fine and is named rather than
  guessed at:

  ```
  restore: the backup is 2 migrations behind this build:
    <migration>
    <migration>
  restore: they will be applied on the next boot with RUN_MIGRATIONS=true. Continuing.
  ```

  **Ahead** is refused, because `synchronize` is off and the API would boot and
  then fail on the first read of a column its entities do not know about:

  ```
  this backup is from a newer build. It carries 1 migration this build does not have:
    <migration>
  upgrade this checkout first, or pass --force-schema to restore anyway and accept that
  the API will read columns it does not declare. Nothing was written.
  ```

  Upgrade the checkout; `--force-schema` is the override for when you know
  better and it is not the usual answer.

- **Was this asked for.** `--force` is what lets a restore replace a file that
  already exists; without it the script refuses, because the common mistake is
  restoring over a database that was fine.

- **The stale write-ahead log goes with the target.** A `…-wal` left next to
  restored pages is the one reliable way to turn a good backup into a corrupt
  database, so the restore removes the `-wal`, `-shm` and `-journal` files
  beside the target.

**Copy `content/` with the database.** The database records the pack version a
verdict was graded against; it does not carry the pack. A term restored onto a
machine whose `content/` is older or newer will grade the rest of the term
against different rules, and nothing will say so. Move the two together, or
compare `content/<project>/project.json`'s `version` on both machines first.
This is the most likely real-world failure of a restore and the only one the
script cannot check for you.

Migrations are idempotent here too: the API finds the restored schema current
and applies nothing. Grading jobs come back in whatever state the snapshot
caught them in, and the queue that was going to finish them is gone, so
anything the learner sees still running is theirs to submit again.

### 7b · What the API prunes on its own

The API keeps every submission, its files, its report, its score and its
verdict for good. Its daily retention sweep (`apps/api/src/retention/retention.service.ts`)
touches only what can be rebuilt or is never read back:

- **Cached mentor replies.** `ai_cache` rows older than 30 days are deleted.
  Separately, a reply older than `AI_CACHE_TTL_HOURS` (24) is not served at all,
  so a content or guardrail change is never answered from before it.
- **Reset copies.** When a learner resets a task, the files they had are kept
  in `task_resets`. Only the newest three copies per task keep their files;
  older copies keep their row and lose their bytes. No screen restores from a
  copy.

The first sweep runs `RETENTION_FIRST_SWEEP_DELAY_MS` (two hours) after a start,
then every 24 hours, so a deployment step that compares every table before and
after a start sees no housekeeping writes. The cost is that a process that
lives less than two hours never sweeps. A sweep that removed anything logs one
`retention sweep:` line. A failed sweep is logged and swallowed, and the next
one tries again: housekeeping must not be able to fail a boot.

Several things the mentor and the console write are kept rather than swept,
and this is why.

- **Customer interviews** (`phase_states.interview`) are kept for the life of
  the enrolment, like the learner's links and drill. It is the learner's own
  record and is what an appeal about the story reads.
- **Stuck flags** (`phase_states.stuck`) hold one flag per phase, overwritten
  when the learner raises another after clearing the last. The durable record of
  who answered what is the `stuck.answer` audit row, which carries the answer as
  its reason.
- **The mentor's memory** (`enrollments.mentorMemory`) is rebuilt from the
  learner's own artefacts, never appended to, and is capped at eight items and
  1600 characters; 600 characters of it reach a prompt
  (`apps/api/src/assistant/memory.ts`).
- **`phase_states.estimate` and `phase_states.retro`** are kept with the
  enrolment and travel in the learner's export. Nothing in the product writes
  or reads them.
- **Class notes** (`instructor_notes`) are kept until an instructor deletes
  them. They are keyed by `authorUserId`, not `userId`, on purpose: they are
  staff writing about a class, kept like `audit_events` rather than like
  coursework, so a learner's export and erasure do not touch them.
- **`cohort_imports`** holds one row per class ever carried onto this machine
  as a file: where it came from, what that file was allowed to carry, and the
  source machine's audit trail verbatim, which is the only copy of that trail
  this machine will ever have. Deleting one loses the provenance of a class
  that may still be being taught (§7c).

**Notifications** (`notifications`) are swept on their own clock: at boot and
then every fifteen minutes, because the bell also uses that sweep to notice a
drill left paged and a phase due this week. Three rules, and a row that breaks
any of them goes: **a read row after 7 days**, **any row after 30 days**, and
**past 200 rows per account** the oldest first (`NOTIFICATION_READ_MAX_AGE_DAYS`,
`NOTIFICATION_MAX_AGE_DAYS`, `NOTIFICATIONS_KEPT_PER_USER` in
`apps/api/src/notifications/notifications.service.ts`). Deleting one loses
nothing: a notification is a pointer, never a record, and every fact it names
(the submission, the report, the audit row, the class schedule) is stored
somewhere that is kept. A partial unique index, `UQ_notifications_unread_subject`,
means one *unread* row per account, kind and subject, so a drill open for three
days is one row rather than one every quarter of an hour. A migration must never
use `queryRunner.addColumn` on this table on sqlite: the driver rebuilds the
table and recreates its indexes without their `WHERE`, which would silently drop
that predicate. Use raw `ALTER TABLE "notifications" ADD COLUMN`.

### 7c · Moving a class between machines

A restore moves a whole *machine*. Moving one **class** (to a colleague's
laptop, to a replacement machine mid-term, to a marking machine) is a
different operation and is done from the console, not the terminal: **Class →
Move this class to another machine**.

**Out.** The export is one JSON file holding the roster, every learner's work,
their verdicts and their mentor use. Two things are left out unless they are
ticked, and each for its own reason:

- **the files behind every revision**: a verdict is readable without them, and
  they are most of the file's size;
- **what the learners typed to the mentor**: the message *counts* always
  travel, because the reliance index is built from them, but the text is the
  most personal thing in the file. Exporting it is recorded in the audit trail
  as part of the `cohort.export` row.

Never in the file, whatever is ticked: password hashes, token versions,
suspensions, verification stamps, the join code, the AI cache and execution
runs. The other machine's audit trail *is* in the file, and stays there.

**In.** `Choose a file`, then **Check what this would do** before **Import**.
The dry run writes nothing at all and lists every learner in the file with what
would happen to each: an account already on this machine moves into the new
class; one that is not here is created; a staff address is skipped. An import
**always makes a new class**, never merges into an existing one, and a learner
who already has an enrolment on a project keeps the one they have; their
imported copy of that project is skipped, and the dry run says so by name.

Afterwards:

- The new class has a **fresh join code**. Two machines must never share one.
- Accounts the import created have **no usable password**. The result lists
  every address; send those people "Forgot your password?" (§11).
  `ALLOWED_EMAIL_DOMAINS` is deliberately *not* applied here: the allowlist
  governs a door people walk through, and an instructor importing their own
  roster is the authority it exists to protect.
- The import writes its own audit rows (one `cohort.create`, one `cohort.join`
  per learner moved in, one `account.import` per account created, one
  `cohort.import`) and keeps the *source* machine's trail verbatim on the
  import record rather than replaying it as rows here. A replayed row would be a
  claim about who did something on this machine, naming actor ids that do not
  exist on it.
- Importing the same file twice is refused with what it was imported as and
  when. It is refusable rather than impossible: making a second copy of a class
  is a real thing to want, and `Import anyway` does it.
- The whole import is one transaction. If anything fails part-way, nothing is
  written.

**Size.** `IMPORT_MAX_BYTES` ([configuration](configuration.md#content-and-classes), default 32 MB) is the ceiling, and it is
applied to this one route. The panel warns when an export is larger than the
importing machine will take, and the answer is almost always to export it again
without the revision files. If you do raise it, raise the `api` service's
`mem_limit` with it: the body is buffered and parsed, which costs about three
times the file's size in process memory.

**And the same content warning as a restore.** A class carries the pack version
its verdicts were graded against, not the pack. Copy `content/` to the other
machine too, or check `project.json`'s `version` on both first.

### 7d · What a learner can take away

A learner can download their whole project as a real git repository, from the
artefacts page or from the completion page. `GET /api/v1/repo/:slug/export.zip`
answers with a zip that unzips into a folder real `git` reads: one commit per
submission, in the learner's own name, with the message they wrote on it, and
an annotated tag at every gate they passed carrying their merge message.
`GET /api/v1/repo/:slug/summary` is the cheap version the card shows: counts
only, no file content read at all.

**The archive is loose objects, not a packfile.** The API writes git objects by
hand with `node:zlib` and `node:crypto` and has no git binary and no git
library. A term of work is therefore a few hundred loose object files rather
than one pack; `git gc` in the unzipped folder packs it. Content addressing keeps
the archive small: sixty revisions of the same ten files are sixty trees and a
few distinct blobs, because a blob is keyed by its content. Every export logs
`repo export slug=… commits=… objects=… bytes=…`.

**A revision without its files is an empty commit, never a skip.** A
submission stored without its workspace still gets a commit; its tree is its
parent's, so `git show` prints the message and no diff, and the message says
the files were not kept. A repository that quietly dropped such revisions would
disagree with the pull request about how many times the learner submitted, and
that count is what an appeal is about.

**Limits.** Three archives a minute per learner, matching the class export and
for the same reason: it reads every row the caller owns. The summary is thirty a
minute. The archive's ceiling is 32 MB (`REPO_EXPORT_MAX_BYTES`); over it the
route answers 413 with "Your repository is larger than a download can carry. Ask
your instructor for help." and it refuses **before** the first byte of the
body, so a learner never receives a truncated repository.

**On the record.** One `repo.export` audit row per archive, actor and subject
both the learner, `targetId` the enrolment and `detail` carrying the commit,
tag and byte counts. It is the one route that hands the whole of a learner's
work out as a file, which is why it leaves a row. The summary writes none: it
computes counts and hands out nothing.

**What is not in it.** Only the learner's own work: `submissions.workspaceSnapshot`
and nothing else. The pack's reference solution is never written into the
archive: it is not the learner's work, and a repository is a thing people pass
around.

## 8 · Logs, errors and metrics

**Logs.** Every container logs to Docker's `json-file` driver, capped at
5 × 50 MB per service (`x-logging` in `docker-compose.yml`). That cap is the
retention: older lines are gone. For longer retention or search, ship them
(`docker compose logs -f --no-color api` into your collector), or switch the
logging driver (`journald`, `awslogs`, `gelf`, Loki's plugin) in the
`x-logging` anchor. Do not raise the cap indefinitely on a small disk.

In production the API writes one JSON object per line. Every request produces a
line `GET /api/v1/phases/… 200 12.3ms rid=<id>`, except a successful probe of
the three health routes (`/api/v1/health`, `/health/live`, `/health/ready`),
which is dropped because an orchestrator hits them every few seconds; a health
probe that *fails* is logged. That test is on those exact paths, so a learner
action such as `POST /api/v1/phases/:id/drill/health` is logged like any other
route. The query string is never logged, and the preview door's capability is
replaced by `…`. `rid` is the same value the client received in the
`x-request-id` response header (the browser is allowed to read it) and, for a
500, in the response body's `requestId`. A learner who reports "reference
`abc-123`" hands you the exact line and stack trace:

```bash
docker compose logs api | grep 'rid=abc-123'
```

**Audit.** Every override, role change, password set, class change, dossier
read and class export is also written to the `audit_events` table, read back by
`GET /instructor/audit` and shown on each learner's page in the console, so the
record outlives log rotation. The log lines are kept as well.

Instructor overrides are logged as single JSON objects under context
`InstructorService`: event `phase.override` (fields `action`, `actorId`,
`learnerId`, `phaseStateId`, `projectSlug`, `phaseKey`, `reason`). Admin actions
log as `admin <actorId> updated <userId>: …` under `AdminService`. Search with,
e.g.,
`docker compose logs --no-color api | jq -R 'fromjson? | select(.message | test("phase.override"))'`.

**Mail.** With `SMTP_HOST` unset, nothing is sent. The log records a digest of
the recipient and the subject under `[MailService]`, never the body, and the
message itself, with its live link, is appended to `MAIL_CAPTURE_FILE` when that
is set.

**Errors.** Every 5xx and every failed queue job is captured with its request
or job id: always into the log, and into Sentry when `SENTRY_DSN` is set
(release = `APP_VERSION`, environment = `production`). Tracing is off; only
captured exceptions are sent. Sentry retention is Sentry's setting.

**Metrics.** `GET /metrics` (root path, outside `/api/v1`) serves Prometheus
text when the request carries `Authorization: Bearer $METRICS_TOKEN`.

```yaml
scrape_configs:
  - job_name: learnsdlc
    scheme: https
    metrics_path: /metrics
    authorization: { credentials: <METRICS_TOKEN> }
    static_configs: [{ targets: ['api.example.edu'] }]
```

| Metric | Labels | Watch for |
|---|---|---|
| `http_request_duration_seconds` (histogram) | `method`, `route` (matched pattern, e.g. `/api/v1/phases/:id`; `unmatched` for 404 noise), `status` | 5xx rate > 0; p95 on `/api/v1/phases/:id/submit` climbing |
| `ai_operations_active` (gauge) | `kind` (`guided`, `interview`, `agentic`, `grading`, `serialised`) | Unsettled AI work right now, including a disconnected learner's retained timeout tail |
| `ai_operation_oldest_seconds` (gauge) | `kind` (as above) | The oldest unsettled operation's age; zero when idle. A number that climbs and never returns to zero is work that is not settling |
| `jobs_processed_total` (counter) | `kind` (`run`, `submission`, `regrade`), `status` (`completed`, `failed`; every failed attempt counts, retried or not) | `failed` rate rising |
| `queue_depth` (gauge) | `state` (`waiting`, `active`, `delayed`, `failed`) | `waiting` growing while `active` sits at `JOB_CONCURRENCY × replicas`: add a replica or raise concurrency |
| `process_*`, `nodejs_*` | | RSS creeping, event-loop lag |

`http_request_duration_seconds` buckets run
`0.005 · 0.01 · 0.025 · 0.05 · 0.1 · 0.25 · 0.5 · 1 · 2.5 · 5 · 10 · 20 · 30 · 45 · 60`
seconds. A submit waiting on a model call or a sandbox job is a request that
can legitimately run for half a minute, and the buckets from 20 s up are what
keep those routes out of `+Inf` and make their p95 readable.

**Where a learner's wait goes.** Six families measure the AI and sandbox path.
Every label value comes from a set fixed in code (call sites, operation kinds
and outcomes), so no prompt, completion, learner, account or request identifier
can reach a series, however many phases or projects an instance serves.

| Metric | Labels | What it answers |
|---|---|---|
| `ai_model_call_duration_seconds` (histogram) | `call` (one of ten call sites: `guided.draft`, `guided.review`, `interview.answer`, `interview.review`, `grading.review`, `agentic.classify`, `agentic.generate`, `agentic.generate.edits` (only while `AI_AGENTIC_EDIT_LIST` is not `off`), `agentic.explanation`, `structured.other`), `operation` (`guided`, `interview`, `agentic`, `grading`, `serialised`, `none`), `outcome` (`ok`, `http_error`, `rate_limited`, `timeout`, `aborted`, `invalid`, `error`) | How long one model call took end to end, and which surface the wait belongs to. Buckets 0.5 s to 120 s. Split by `outcome` before reading a p95: a timeout is a bucket at the ceiling, not a slow answer |
| `ai_model_call_headers_seconds` (histogram) | `call`, `operation` | Request sent to response headers received, so a slow start is told apart from a long reply. Same buckets |
| `ai_gate_wait_seconds` (histogram) | `call`, `operation` | How long a caller queued for a provider slot before its call began. Near zero for one learner alone; a rising p95 with `ai_model_call_duration_seconds` flat means the concurrency gate, not the upstream. Buckets 0.005 s to 120 s |
| `ai_model_call_output_tokens` (histogram) | `call` | How much a call site actually generates. A count of tokens, never their text: this is the series that tells a classification apart from a whole-file rewrite |
| `ai_review_rejections_total` (counter) | `surface` (`interview`, `guided`), `attempt` (`1`, `2`), `check` (`limited_step`, `grounded`, `learner_reasoning`, `relevant`, `no_artifact`, `other`) | Model answers a reviewer refused. `attempt="2"` is a repaired turn, where the learner still got an answer; a rising `1`/`2` ratio is the reviewer working harder for the same result. One count per refused answer, labelled by the first check it failed, so a sum over `check` is the number of refused answers |
| `sandbox_execution_duration_seconds` (histogram) | `purpose` (`run`, `grading`, `probe`, `validation`), `outcome` (`ok`, `timeout`, `memory`, `error`, `unavailable`) | The wall clock a caller waited on the runner, including the queue behind `RUNNER_SLOTS` and the fresh machine every job gets. Buckets 0.5 s to 120 s |

Four caveats, before any of these goes on a dashboard:

- **`ai_gate_wait_seconds` does not count model calls.** A wait the gate
  *refused* (past its deadline, cancelled while queued, or turned away because
  the line was already full) is observed into the same series as a served one,
  and the labels do not say which is which. Leaving refusals out would truncate
  the histogram at exactly the waits worth seeing, so they are in. Two
  consequences: a refusal because the line was already at its ceiling never
  queued at all and lands as a near-zero sample, pulling the low buckets down;
  and a call the gate *admitted* that fails before its request goes out records
  no wait at all, because the wait rides on an attempt that never started. The
  metric's own `# HELP` text says all three.
- **Headers time is close to total here.** These completions do not stream, so
  the upstream holds the response until the whole reply exists.
  `ai_model_call_headers_seconds` separates network, queueing and upstream
  admission from body transfer. It is **not** a time to first token and a
  dashboard must not label it as one.
- **`purpose` is read off the caller's trace owner, not off the route.** A
  caller that sends no owner is counted as `grading`, and inside the API that is
  the graded submission jobs alone. `run` is a learner pressing Run; `probe` is
  the start-up pre-bake probe; `validation` is a teacher project's deep
  validation. Any new caller of the sandbox that sends no owner lands in
  `grading` too (`executionPurpose` in `execution/sandbox.service.ts`).
- **A 429 retry adds no second wait, and unreported usage adds nothing.** Only
  the first attempt observes `ai_gate_wait_seconds`, since the retry waited out
  `Retry-After` rather than the gate. A call whose upstream reported no usage
  contributes no `ai_model_call_output_tokens` sample rather than a zero.

**The `ai_call` log line.** Every attempt that reached the wire also writes one
line under context `OpenAiProvider`, in a shape that greps and parses the same
way every time:

```
ai_call call=guided.draft operation=guided attempt=1 gateWaitMs=0 headersMs=4012 totalMs=4101 tokensIn=812 tokensOut=143 status=200 outcome=ok cachedTokens=none
```

Every numeric field is an integer, or the fixed token `none` for a number that
attempt never produced (`headersMs=none` on a timeout, `status=none` when
nothing answered). `call`, `operation` and `outcome` come from the same fixed
sets as the labels above, and `attempt` is `1` or `2`. `cachedTokens` is the
count of prompt tokens the provider reported serving from its prefix cache
(`usage.prompt_tokens_details.cached_tokens`), or `none` when it reported none.
The line carries no prompt and no completion. An attempt that failed *before*
its request was sent writes no line: there was no model call to describe. To
read one learner's slow turn out of a host:

```bash
docker compose logs --no-color api \
  | jq -r 'fromjson? | select(.message | startswith("ai_call ")) | .message' \
  | grep outcome=timeout
```

**Sizing `AI_MAX_CONCURRENCY`.** Read the provider's limits from the API log
before raising it: every provider response that carries them writes
`ai_rate_limits status=S limitRequests=N remainingRequests=N limitTokens=N remainingTokens=N`
(counts only). Reviews take at most `JOB_CONCURRENCY` of the slots, one model
call per grading job, and the boot writes once whether that stays within a
third of them: `ai_review_share jobs=J aiSlots=N bound=B within`, or a warning
ending in `over: ...` when it does not.

Queue depth is sampled on scrape, one Redis round trip bounded at 1 s; a dead
Redis leaves the previous sample and `/health/ready` is where the outage
shows. `queue_depth` does not account for every sandbox run: the incident
drill's three routes run the sandbox from the request path and hold a slot on
the same `RUNNER_SLOTS` gate without entering the queue. With a class working
through the deployment phase together, grading can wait while the queue itself
looks idle; the `http_request_duration_seconds` p95 on
`/api/v1/phases/:id/drill/health` is where that shows.

## 9 · Failure modes

The messages a newcomer meets while setting up are in [troubleshooting](troubleshooting.md). These are the ones a running deployment shows.

| Symptom | Cause | Action |
|---|---|---|
| Caddy logs certificate errors; site unreachable | DNS not pointing at the host, or 80/443 blocked | Fix DNS or the firewall; Caddy retries on its own. For a trial use `localhost`/`api.localhost`. |
| `/health/ready` 503, `queue` not ok | Redis unreachable | Restore Redis. The API keeps serving reads; jobs already enqueued are safe in the append-only file. |
| `/health/ready` 503, `database` not ok | PostgreSQL unreachable | Restore the database. Caddy still routes to the API; it answers 503 until the database is back. |
| Every "Run" fails immediately; log says `socket runner (…): ENOENT` or `ECONNREFUSED` | `runner` not healthy, or the `runnersock` volume was recreated | `docker compose ps runner`, `docker compose logs runner`; `docker compose up -d runner`. The API does not need a restart. |
| Every Run, Submit and Preview says the code runner cannot provide kernel isolation; `isolation` not ok | The host has no Landlock, its self-test failed, or `SANDBOX_LANDLOCK=0` | §3c: run on Linux 5.13 or newer with Landlock enabled, and unset `SANDBOX_LANDLOCK`. Nothing was graded and no attempt was spent. |
| Refuses to start: "refusing to start in production with development defaults" | `JWT_SECRET` missing, short or a placeholder, a set `QUIZ_SEED_SECRET` short or a placeholder, or `ADMIN_EMAIL` or `ADMIN_PASSWORD` missing | Set them. Deliberate. |
| `docker compose up` stops: "required variable POSTGRES_PASSWORD is missing a value" (or `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SITE_HOST`, `API_HOST`) | The variable is unset or empty; Compose has no default for it | Set it in `.env` (§2). |
| Refuses to start: "refusing to start: JWT_SECRET is not set" | No session secret in the API's environment | Set `JWT_SECRET` (§2). There is no default anywhere. |
| Log: "ADMIN_PASSWORD was refused, so no admin was created" | The password breaks the registration rules: 8 to 100 characters, not on the breach list | Set another and restart; nothing was marked done. |
| Log: "no ADMIN account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set" | Bootstrap variables missing on a database with no admin | Set both and restart. |
| Log: "ADMIN_EMAIL names an existing non-admin account" | The address is already registered | Choose an unused address; an existing account is never promoted from the environment. |
| Log: "ADMIN_EMAIL is not a valid email address, so no admin was created" | The value would fail the sign-in form's own check | Set a real address and restart; nothing was marked done. |
| Log: "the first admin was created at … and no ADMIN account remains" | The only admin was deleted; the `bootstrap.admin` marker blocks a re-run | `delete from settings where key='bootstrap.admin'` and restart (§11). |
| Refuses to start: "… RUNNER_MODE=local" | Someone overrode `RUNNER_MODE` | Remove the override; Compose sets `socket`. |
| Refuses to start: "refusing to run migrations against …" | One-laptop shape: a sqlite file written by schema auto-sync whose schema no longer matches this build | Nothing was written to it. §3a, "Adopting a file written before migrations". |
| One-laptop shape: the database file will not open, or a restore looks empty | A stale `…-wal` beside a database file that was replaced by hand | Restore through `npm run restore`, which removes it (§7a). Never copy a `.sqlite` on its own. |
| Submissions stuck at "running" after a crash | Queue not durable (`REDIS_URL` unset) | Never the case under Compose. Elsewhere: set `REDIS_URL`; on boot the app reconciles stranded jobs to a clear failure. |
| The mentor answers "AI mentor is not configured" or "could not respond"; reviews say the assessment is unavailable | `OPENAI_API_KEY` unset, the upstream failing, or timing out (`OPENAI_TIMEOUT_MS`) | Check the key and the `ai_call` lines' `outcome`. Nothing answers in the provider's place, and the learner's work is saved. |
| Prometheus gets 401 from `/metrics` | No or wrong `METRICS_TOKEN` | Set the same token on both sides. The boot line says `metrics=disabled` when it is unset in production. |
| A demo account cannot sign in; log: "login refused: … still has a password this repository publishes" | The API is reachable from the network, where the published demo passwords are refused | Give the account another password (§11), or stop using it. |
| A learner cannot sign in; the password is right | 10 failed attempts on that account inside 15 minutes | Wait for the window to expire (the response is the same 401 as a wrong password, by design), or set a new password from `/admin`. |
| Every learner is signed out after a deploy | `JWT_SECRET` changed | Expected once; nothing to do. |
| Nobody can sign in as admin | Password lost | `docker compose exec api sh -c 'cd apps/api && npm run user:set-password -- <email> <newPassword>'`; works for the last admin, which the console cannot reset (§11). |
| Second admin bootstrap does nothing | First admin already created (marker row in `settings`) | Intended. Promote further admins from `/admin`; to re-run the bootstrap, delete the marker row (§11). |
| The Health tab under the code says "Static analysis could not run for this revision" | The runner could not start Python for the analyser pass; the report carries one issue with the rule `analyzer-unavailable` | Check `docker compose logs runner` and `/health/ready`'s `prebake` check. It costs the learner nothing (the code-quality criterion ignores that rule) and the next submission fixes it. |
| A learner asks why a phase has no Health tab | Static analysis runs only on code phases (implementation and maintenance), and inside those only over `.py` targets: esbuild strips TypeScript types, so `.ts` and `.tsx` are skipped | Working as intended. |

## 10 · Security posture

- Learner code runs in the `runner` container (`infra/runner.Dockerfile`):
  `network_mode: none`, no secrets in its environment, uid 65534, its own pid
  namespace, read-only root filesystem, `cap_drop: ALL`, `pids_limit: 128`, no
  curl, no content bundle, and a Landlock fence per child (§3c). The API
  reaches it only over a UNIX socket on the `runnersock` volume
  (`RUNNER_MODE=socket`) and never executes learner code itself:
  `RUNNER_MODE=local` is refused in production and on any non-loopback bind.
  The Lambda transport (`RUNNER_MODE=lambda`) remains available.
- All containers run with `no-new-privileges`; the API and runner are non-root.
- Sessions are revocable: a password change, account deletion, admin
  suspension, role change or password set bumps the account's token version,
  and every request checks the token against the account's current row, so
  every session of that account is refused from its next request on every
  replica; open sockets for that user are disconnected. Rotate `JWT_SECRET` to
  invalidate every session of every account.
- Sign-in is throttled per account at 10 failures per 15 minutes
  (`LOGIN_FAILURE_LIMIT` / `LOGIN_FAILURE_WINDOW_MS` in `auth.service.ts`) on
  top of the route limits (30 attempts a minute per account from one address,
  and `SIGNIN_MAX_PER_ADDRESS` per address); a locked account gets the same 401
  as a wrong password and unlocks when the window expires. The failure counter
  is per process; the route limits are not (§6).
- Production creates one admin from `ADMIN_*` and no other accounts; the demo
  staff accounts exist only on a loopback API outside production that asks for
  them. Their passwords are published, so an API that other machines can reach
  refuses those passwords at sign-in, whatever database it serves.
- TLS everywhere at the edge with HSTS; `helmet` on the API; CORS restricted
  to `WEB_ORIGIN`; browser scripts can read three response headers:
  `x-request-id`, `x-cohort-import-max-bytes` and `x-export-withheld`
  ([HTTP API](api.md#the-basics)).
- Per-route rate limits keyed on the signed-in account, or the real client IP
  when there is none (`TRUSTED_PROXIES=1`), shared across replicas through
  Redis. The admin and instructor consoles are covered too (60 a minute per
  admin route, 60 a minute per teacher on the console, class creation
  included, 5 per 5 minutes for `POST /admin/users/:id/password`, 5 a minute
  for the full-class `GET /instructor/export.csv`; [every route's limit](api.md#every-route)), because they are the
  expensive, privilege-adjacent end of the API. Plus DTO validation,
  prompt-injection neutralisation, and role-guarded instructor and admin
  endpoints.
- `/metrics` is disabled in production unless `METRICS_TOKEN` is set;
  `/health/*` is public and reveals only dependency status, counts and
  `APP_VERSION`.

## 11 · Accounts, classes and recovery

**Bootstrap.** The first admin is created from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` on the first boot with no `ADMIN` account; a settings row
`bootstrap.admin` then makes the variables inert. Deleting that admin does
**not** recreate it; to bootstrap again, delete the row and restart:

```bash
docker compose exec -T postgres psql -U learnsdlc -c "delete from settings where key='bootstrap.admin'"
docker compose restart api
```

`ADMIN_EMAIL` must be an unused address; an existing non-admin account is
never promoted from the environment. `ADMIN_PASSWORD` must meet the
registration rules, or no account is created and the log says why. Further admins and instructors are
promoted from `/admin` (Accounts): look an account up by email, change its
role or class, suspend or restore it, or set a password for someone locked
out. Suspending an account from `/admin` revokes every one of its sessions
at once.

**Sign in with Google**, when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
are set. It creates accounts, so treat `ALLOWED_EMAIL_DOMAINS` as a required
variable rather than a recommended one: unset, anyone with a Google account
can enrol themselves. Addresses are matched, never duplicated: someone you
promoted to `INSTRUCTOR` keeps that role when they first use the button, and a
suspended account is refused with the same sentence password sign-in uses. An
account created this way holds a password nobody knows, so `/admin` → set a
password, or the learner's own "Forgot your password?", is how it gains one.

Two failures look alike from the outside and are told apart in the API log
under `[GoogleService]`. `redirect_uri_mismatch` on Google's own screen means
`GOOGLE_REDIRECT_URL` and the console entry disagree: compare them character
for character, scheme and port included. A `google token exchange failed`
warning with `invalid_client` means the secret is wrong or was rotated. To
turn the feature off, unset the two variables and restart the API; nobody
loses their account, only that way in.

**The record of staff changes.** `audit_events` holds one row per phase
override, admin account update, admin password set, class made, class joined
or left, class moved to another instructor, password changed, password reset
and account deleted, among others: who acted, on whom, and the reason they
typed. It is what an appeal is answered from weeks later, when the log stream
has rotated. It is also personal data about the learner named as the subject,
so `GET /account/export` returns every row naming the account at either end.

`DELETE /account` does not delete the rows where the account was the
*subject*: it **tombstones** them. `subjectUserId` is nulled and the event, the
actor, the action and the reason stay, and the deletion itself is written as an
`account.delete` row that is tombstoned in the same pass, so the trail keeps a
dated, nameless record that an account was deleted, which is what an appeal
against the actor needs. An instructor's scoped view does not match a
tombstone: a class view should not show a row about somebody who no longer
exists. The admin's whole-trail view still shows it, with a nameless subject. A
tombstone keeps the actor's `reason` text, which an instructor typed; say so in
your privacy notice.

Rows where a deleted account was only the actor stay (those are their subjects'
record) and the console renders the vanished id without a name.

**Classes.** An instructor creates a class from the "Your classes" card on
the console and reads its 8-character join code there; learners enter the
code at `/join` (the "Join a class" link). An instructor sees every class
they created plus the one they belong to. There is no route that deletes a
class.

**Deleting an instructor who still owns a class is refused**, naming the class
and how many learners are in it, so a class cannot be orphaned by an account
deletion (an empty class is closed with the account instead, since a live join
code pointing at a room with no instructor is worse than no room). Move it
first: the "Classes" panel on `/admin` lists every class with its size, code
and owner and has a **Move here** button per class, which is
`PATCH /api/v1/admin/cohorts/:id/owner {ownerUserId}`: admin only, refused for
a learner or a suspended account, and written to the audit trail as
`admin.cohort.owner`.

**Password recovery**, from the least privileged path up:

1. *Self-service.* The sign-in page's "Forgot your password?" (`/forgot`)
   emails a reset link valid for one hour and single-use: it dies once the
   password changes or any other token-version bump happens (an admin reset,
   say). Opening it also confirms the address. Needs `SMTP_HOST`; without it
   the link is only in `MAIL_CAPTURE_FILE`, when that is set (§8).
2. *Admin.* `/admin` → look the account up → **Set password**. Works for any
   account but the admin's own.
3. *Operator with a shell*, for the last admin or an account whose mailbox is
   gone:

   ```bash
    docker compose exec api sh -c 'cd apps/api && npm run user:set-password -- <email> <newPassword>'
   # outside Compose, after npm run build -w @learnsdlc/api:
   #  npm run user:set-password -w @learnsdlc/api -- <email> <newPassword>
   ```

   It opens the database the `DATABASE_URL` or `DB_PATH` in its own
   environment names, and signs out every session for that account. Outside
   Compose it does not read `.env` and runs in `apps/api`, so export the API's
   `DATABASE_URL`, or an absolute `DB_PATH` such as
   `DB_PATH=$PWD/data/learnsdlc.sqlite` for the laptop shape, first. Exit 1
   means an unknown email, 2 a usage error or a weak password, and 70 an
   unexpected failure. The password is on the command line, so prefix the
   command with a space (`HISTCONTROL=ignorespace`) or clear the shell history
   afterwards.

**Recovery and verification routes** (all under `/api/v1/auth`): `POST
/forgot` (10 per 15 minutes; always `200 {sent:true, message}` whether or not
the address exists), `POST /reset {token,password}` (10 per 15 minutes), `POST
/verify/request` (signed in, 5 an hour), `POST /verify {token}` (20 per 15
minutes), `GET /verify/status` (signed in). Registration sends a verification
mail; nothing is gated on verification: a dismissible banner on the dashboard
and account pages asks until the address is confirmed.

### The four instructor levers

Four things an instructor can do to a learner's record, all of them recorded
in `audit_events` with a reason of at least ten characters.

- **Override the gate** (`pass`, `reopen`, `reset-workspace`, through
  `POST /instructor/learners/:userId/phases/:phaseStateId/override`).
- **Reset a phase** (`reset-phase`, the same route). Clears the phase's files,
  links, drill write-up, merge message, best score and pass, and deletes the
  release record for that phase, copying its version, score and notes into the
  audit row's `detail`. It keeps every submission, does not move
  `enrollment.currentPhaseOrder` and does not touch later phases or `attempts`.
  Reversing it is not possible; the trail is the record.
- **Regrade a phase** (`POST /instructor/regrades`, with `/preview` for the dry
  run and `GET /instructor/regrades/:id` for progress). Re-runs each learner's
  newest revision against the content pack as it is on disk now and writes the
  result as a *new* revision beside the old one. A score can only go up, a pass
  is never withdrawn, and `attempts` never moves. One batch at a time per class,
  enforced by a partial unique index; a batch keeps running when the tab is
  closed. If the code runner cannot be reached the whole batch stops at the
  first job and nothing is changed. A batch runs one queued job per learner
  through the same `RUNNER_SLOTS` gate ordinary submissions use, so a large
  class at a small `RUNNER_SLOTS` takes minutes, not seconds.
- **View as learner** (`POST /instructor/learners/:userId/view`, then read-only
  routes under `/instructor/learners/:userId/...`). There is no impersonation
  token: the instructor's own credential makes ordinary instructor reads, and
  every learner write route still refuses them. The session lives in the
  console's memory and is gone on reload or sign-out. The start is audited
  (`instructor.view-as`); the reads are not, because a console page load is not
  an event.

### The dossier

A learner can print their whole project from `/dossier`: the issue, the
contract, the code, the pull request, the kill matrix, the drill, the change
record, their reflections and the journal, as one document. There is no PDF
service and no library: the browser's own print engine is the pipeline, so
the file is made on the learner's machine and nothing is sent anywhere. Nothing
is stored: a generated dossier is the browser's, it lands in Downloads, and
keeping a copy here would be a second copy of coursework with its own retention
and deletion obligations.

An instructor can print the same document for anyone in their class, from the
learner's page in the console (`GET /instructor/learners/:userId/dossier`).
That route is the only one that hands staff a learner's own files as a
document, so **every read of it writes an audit row**, `dossier.read`, naming
the instructor, the learner and the project; it shows on the class trail and on
the learner's Log tab as "Read the dossier". The two copies differ in exactly
one way and the server decides it: an instructor's carries the count of a
learner's mentor questions and never the questions. If a learner asks who has
read their work, that trail is the answer.

### The reference solution

Once a phase's gate passes, the learner can open the pack's own answer to that
phase at `/workspace/:phaseId/solution`: the reference files beside their own
merged ones, per file, diffed in the browser. It is automatic on a pass and has
**no instructor switch**: the gate is the only key, and
`GET /phases/:id/solution` refuses with "the reference opens when this phase
passes its gate" until the phase has passed. Turning it off for a class
therefore means not shipping the phase's `checks.solutionDir` (or
`checks.referenceDir` for the testing phase) in the pack that class is graded
against; there is no runtime flag, and a flag that only hid the door would
leave the route open.

The phases whose work is the learner's own writing or configuration have no
answer to show and say so: they answer 200 with `available: false` rather than
404, so the page can explain rather than break.

**The first reading of each phase's answer writes an audit row**,
`solution.read`, naming the learner as both actor and subject, with the phase
key and the phase title and file count in `detail`; it shows on the class trail
and on the learner's Log tab as "Read the reference solution", and on the
learner's own dossier as a dated line. A reload is the same reading and writes
nothing more: the stamp is `phase_states.solutionReadAt` and it never moves once
set. If a class needs to know who has seen the answer, that column and that
trail are the answer.

The learner's side of the comparison is the `workspaceSnapshot` of the newest
submission that passed. When a submission holds no snapshot, the file comes back
with `yours: null` and the page says the copy was not kept rather than showing
an empty file as the learner's work.

### The bell

`GET /notifications` is the panel's list (unread rows only, newest first, at
most fifty) and `POST /notifications/:id/read` and `/notifications/read-all`
clear them. Both are scoped to the caller and answer 404 for a row that is not
theirs, so guessing an id tells nobody anything. `POST
/instructor/learners/:userId/note` is the one notification a person composes
rather than the API noticing: it reaches only learners in the caller's class,
it is capped at 400 characters and 30 a minute, and it writes an
`instructor.note` audit row carrying the note's own words, so an appeal reads
what was said. Everything else in the bell is written by the API itself (a
gate passed, a review posted, a class deadline near, a drill still open, a
stuck flag raised or answered, a learner stuck or flagged) and none of it can
fail the thing it is about. Retention is in §7b.

**Class dates** (`GET`/`PUT /instructor/cohorts/:cohortId/schedule`) are per
class, project and phase. A release date holds a phase shut until it arrives:
the learner's card reads locked and the route refuses with the date in the
sentence. A due date blocks nothing; lateness is derived by comparing a
submission's `createdAt` with the class's `dueAt`, so moving a date moves what
is late at once and a class with no dates has no lateness at all. Dates are
stored as UTC instants and printed in the machine's timezone, which in the
one-laptop shape is the instructor's own.
