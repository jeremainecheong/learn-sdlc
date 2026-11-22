# Stress harnesses

Adversarial and load tests for each subsystem. In CI the two service-free
harnesses run in the `stress` job, and `api.mjs` runs in the `stress-api` job
against an API it starts, with the canned AI stub the browser tests use
(`e2e/ai-stub.cjs`). `ai.mjs` needs a live model and is run by hand.

| Script | What it hammers | Needs |
|---|---|---|
| `sandbox.mjs` | The sandbox runner under adversarial code: infinite loop, CPU spin, 2GB memory bomb, fork bomb, network attempt, 50MB output flood, path traversal, deep recursion, syntax error, disk-fill bomb, 24 concurrent mixed jobs; then the escape probes: runner secrets absent from the job environment, no sibling `/proc/<pid>/environ` readable (runner is non-dumpable), `_socket`/`SocketType`/re-import bypasses, `subprocess`/`os.system`/`exec`/`posix_spawn` of curl, `ctypes`, and JS `child_process`/`process.binding`/`net` | `python3` + `node`, on Linux with Landlock |
| `lambda.mjs` | The Lambda transport under load: 30 concurrent invokes (no cross-talk), 24 mixed adversarial jobs, malformed job, 60 invokes across 3 waves, via a mock Lambda endpoint delegating to the real `lambda_handler.py` | built `apps/api/dist` + `python3` |
| `api.mjs` | Auth/JWT forgery, alg:none downgrade, RBAC, cross-user isolation, gating integrity, input validation, rate limits, 12 concurrent full submissions, concurrent double-submit | a running API (`API_URL`, default `http://localhost:4000/api/v1`) with the demo staff accounts and an AI provider |
| `ai.mjs` | Jailbreak battery on the **live model**: requirements artefact-leak attempts, prompt injection, role attacks, implementation code-leak attempts, off-phase, plus honest questions still answered | running API + an OpenAI-compatible model |

Each script exits non-zero if any probe fails.

## Run

```bash
# Service-free:
npm run build -w @learnsdlc/shared -w @learnsdlc/api
node scripts/stress/sandbox.mjs
node scripts/stress/lambda.mjs

# With a running API, as the stress-api job starts it. The API refuses to
# start without JWT_SECRET, and a node started by hand does not read .env, so
# the command gives it one (any random value works). The demo staff accounts
# are seeded only on a loopback bind, which this is:
JWT_SECRET=$(openssl rand -base64 48) DB_PATH=data/stress.sqlite RUNNER_MODE=local SEED_DEMO_ACCOUNTS=true \
  OPENAI_API_KEY=<your key> node apps/api/dist/main.js &
node scripts/stress/api.mjs

# The AI battery needs a hosted model (your key; any OpenAI-compatible
# endpoint through OPENAI_BASE_URL and OPENAI_MODEL):
JWT_SECRET=$(openssl rand -base64 48) OPENAI_API_KEY=<your key> DB_PATH=data/stress.sqlite \
  node apps/api/dist/main.js &
node scripts/stress/ai.mjs
```

## What `sandbox.mjs` does and does not prove

It drives `sandbox_runner.py` as a plain process (as uid 65534 when run as
root, so the `/proc` probe is not trivially satisfied by root's read-all), so
it proves the Landlock fence the runner arms per child and the **in-process**
hardening: rlimits, the scrubbed environment, the non-dumpable harness, and the
Python and Node monkey patches. The in-process layer is a second line of
defence: code running in the same interpreter can, with enough effort, unwind
a monkey patch. On a machine without Landlock the runner refuses every job, so
run it on Linux.

The real boundary is the `runner` service in `docker-compose.yml`
(`infra/runner.Dockerfile`): `network_mode: none`, no secrets in its
environment, uid 65534, its own pid namespace, `read_only` root filesystem,
`cap_drop: [ALL]`, the `pids_limit` set there, and no curl or content bundle
in the image. None of that is exercised by this script; `docker compose config`
and the Dockerfile are the evidence, and `RUNNER_MODE=local` is refused in
production so the in-process layer is never the only one.
