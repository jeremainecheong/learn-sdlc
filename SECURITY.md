# Security

LearnSDLC from SMU SCIS runs code that learners write, holds their work and grades, and talks to an AI provider with the operator's key. This page says how to report a vulnerability, what is in scope, and the security properties someone running LearnSDLC should know.

## Reporting a vulnerability

Report it privately. Do not open a public issue, pull request or discussion about it.

- Use GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**.
- If that is not available, open an issue that asks the maintainers for a private way to reach them, and put no detail of the problem in it.

Please include what an attacker can do, the steps or a small proof that shows it, the commit you tested, and how the product was running (for example `npm run demo`, the Docker stack, the production Compose file or the reference AWS deployment). Leave out any real learner's data.

The maintainers will acknowledge the report, keep you told of progress, and agree with you when the problem can be made public. Fixes are made on the `main` branch; there are no older maintained releases.

## In scope

- Running learner code outside its sandbox: reading or writing another learner's files, the host's files, or the API's environment; reaching the network; or outliving the limits on time, memory and processes.
- Grading integrity: a learner reading sealed files (hidden tests, the reference implementation, the planted bugs), or changing their own score or a phase gate.
- Authentication and authorisation in the API and the web app: acting as another user, a learner reaching staff routes, a teacher reaching another teacher's class.
- Secrets: the AI key, the JWT secret or a database password reaching a browser, a log or a learner.
- The scripts, the Compose files and the reference deployment's code under `infra/`, where they leave an installation weaker than its documents say.

Out of scope: the published demo accounts on a local demo run, which are refused anywhere else (see below); attacks that need an operator's machine or cloud account to be compromised already; and the AI provider's own service.

## What a user should know

Each statement below is what the code does; the file named is where to check it.

### Learner code runs only under kernel isolation

- The code runner (`apps/api/runner/sandbox_runner.py`) runs learner code only where the kernel can confine it: Linux with Landlock (kernel 5.13 or newer), after a self-test proves the interpreters start under the fence. Inside the fence each child also gets CPU, memory, process-count, file-size and file-descriptor limits and a scrubbed environment.
- Where Landlock is absent (macOS, an older kernel, a seccomp profile that hides it), where the self-test fails, or where `SANDBOX_LANDLOCK=0` turns it off, the runner reports isolation as unsupported and **refuses every run and preview**, answering: "The code runner cannot provide kernel isolation on this host. Your saved work is unchanged." The product still starts and every page works; running, testing and grading learner code does not.
- The one other way the runner accepts is the single-job MicroVM of the reference AWS deployment, which its supervisor declares. A job cannot declare it for itself: the runner owns that variable.
- On macOS and Windows, learner code runs through Docker, whose Linux virtual machine provides the kernel, as long as that kernel has Landlock. On a Mac that means Colima: Docker Desktop's virtual machine kernel is built without Landlock, and the local stack stops at its health check with the runner's own sentence. [docs/local-run.md](docs/local-run.md) says how.
- In `docker-compose.yml` the runner is a container of its own: no network, no secrets in its environment, user 65534, a read-only root file system, every capability dropped and a process limit. The API reaches it only over a UNIX socket on a shared volume.
- `RUNNER_MODE=local` runs the runner as a child of the API process. The API refuses to start with it under `NODE_ENV=production` or on any address other machines can reach (`apps/api/src/config/safety.ts`). An unset or unknown `RUNNER_MODE` means the socket runner, which fails closed.

### Demo accounts work only on a local demo

The repository publishes a demo instructor and a demo administrator with their passwords, so that `npm run demo` can sign them in. It publishes no session secret. The code keeps the demo accounts to that case:

- The demo staff accounts are created only when `SEED_DEMO_ACCOUNTS=true`, the API is bound to a loopback address, and `NODE_ENV` is not `production`. When the flag is set but the bind or `NODE_ENV` does not allow it, none is created and the API logs that `SEED_DEMO_ACCOUNTS=true was ignored` (`apps/api/src/seed/seed.service.ts`).
- The API refuses to start without `JWT_SECRET` in every environment and on every bind; there is no fallback secret. `bash scripts/setup.sh` generates one into `.env` (file mode 0600), which `npm run demo`, `scripts/start.sh` and the root `npm run dev` and `npm start` read. On any bind other than loopback the secret must also be at least 32 bytes long and not one of the placeholders the repository ships. Under `NODE_ENV=production` the API also refuses to start without `ADMIN_EMAIL` and `ADMIN_PASSWORD` (`apps/api/src/config/safety.ts`, `apps/api/src/config/auth.ts`).
- The browser tests and the CI jobs pass a published test-only `JWT_SECRET`. It is on the placeholder list, so the API refuses it wherever a real secret is required.
- Wherever the API is reachable from the network (a bind other than loopback, such as the Docker stack's container or `npm run host`), sign-in treats the published demo passwords as wrong: it answers 401 `invalid email or password`, counts the attempt towards the account's lock and logs a warning that names the account's kind and id (`apps/api/src/auth/auth.service.ts`). Sign-in on a loopback bind is unchanged.
- `ADMIN_PASSWORD`, and `SEED_PASSWORD` when it is set, must meet the rules registration uses (8 to 100 characters, and not on the list of passwords found in public breaches). A refused one creates no account and the API logs why.
- The API binds `127.0.0.1` unless `API_BIND` says otherwise.
- The local Docker stack (`npm run demo -- --docker`) registers its instructor with `STACK_INSTRUCTOR_PASSWORD`, which `scripts/stack.sh` generates for this machine into `.env.verify` together with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The stack prints where that file is, never a password. It publishes its ports on `127.0.0.1` only. Do not expose it to a network.

### Secrets come from the environment

- No secret for a real installation is in the repository. `.env.example` holds only placeholders and defaults; `.env`, its local variants and the `data/` folder are ignored by git.
- `docker-compose.yml` will not start without `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `POSTGRES_PASSWORD` set.
- The AI key is read only by the API. The web app never receives it.
- Passwords are stored as bcrypt hashes. Registration and sign-in are rate-limited.
- The continuous integration workflow checks the dependency tree for published advisories (`npm run audit:gate`).

### What the reference deployment adds

The reference AWS deployment ([docs/deployment/preview.md](docs/deployment/preview.md)) is one way to host LearnSDLC. Beyond the properties above, it:

- runs every piece of learner code in an AWS Lambda MicroVM of its own, on a network with no routes and a DNS firewall that blocks every name;
- puts an invitation gate in front of the site, and opens HTTPS only to the networks you list;
- requires IMDSv2 on the host, disables SSH and administers the host through AWS Systems Manager Session Manager;
- encrypts the host's volumes and the backup bucket, and keeps application settings in AWS Secrets Manager, whose value Terraform never sets or reads;
- can use Amazon Cognito for sign-in, and can turn on alarms and an audit trail.

For running any installation, [docs/production-runbook.md](docs/production-runbook.md) is the operator's reference.
