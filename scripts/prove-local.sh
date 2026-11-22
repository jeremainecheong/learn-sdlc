#!/usr/bin/env bash
# Prove, on this machine, that LearnSDLC runs with every feature.
#
#   bash scripts/prove-local.sh                    # the full proof
#   bash scripts/prove-local.sh --reuse            # against the stack already running with --ai-stub
#   bash scripts/prove-local.sh --skip-durability  # leave out the 10-minute queue check
#   bash scripts/prove-local.sh --ai-check         # does my model work? the AI round trips only
#
# The full proof starts the Compose stack with the test mentor, asked for by
# name (scripts/stack.sh up --ai-stub --detach) and then checks, in order: health;
# sign-in; the AI round trips (mentor reply, rubric review, Agentic propose ->
# explain -> apply, and that each reached the stub); the six-phase journey
# with Run, Submit and Preview of learner code through the runner container
# (scripts/journey.mjs, as CI's journey and socket-runner jobs run it); that
# the runner container really executed the jobs; a teacher's upload of the
# Shelf pack with deep validation; a teacher authoring each of four phases
# that a learner then passes: a Requirements story task with an Agentic
# boundary criterion (scripts/author-requirements.mjs), a Design task
# (scripts/author-design.mjs), a Deployment runbook task with its drill
# (scripts/author-deployment.mjs) and a Maintenance change request
# (scripts/author-maintenance.mjs); a teacher's three-phase upload
# (Requirements, Design and Implementation) that a learner finishes
# (scripts/author-subset.mjs); a teacher's export uploaded again, whose two
# published versions hold the same tasks (scripts/export-roundtrip.mjs); and
# a grading job surviving the API being SIGKILLed
# (scripts/durability-check.mjs, as CI's production-stack job runs it, here
# against the container).
#
# --ai-check runs only the AI round trips against whatever the running stack
# is configured with (the key in .env, or the stub), prints pass
# or fail for each and the p95 latency, and exits non-zero on a failure. It
# needs a running stack: npm run demo -- --docker (API on 4080), or --api
# http://localhost:4000/api/v1 for the native demo.
#
# Writes tmp/prove-local-<UTC time>.json (each step, its result and timing)
# and the logs beside it in tmp/prove-local-<UTC time>/. Both are ignored by
# git and hold no secret. Exits non-zero if any step fails.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"

# The stack's ports, by scripts/stack.sh's rule: the ones .env.verify keeps,
# else STACK_API_PORT and STACK_WEB_PORT, else 4080 and 3080. Exported for the
# Node checks (scripts/lib/endpoints.mjs).
STACK_API_PORT_KEPT="$(env_value .env.verify STACK_API_PORT)"
STACK_WEB_PORT_KEPT="$(env_value .env.verify STACK_WEB_PORT)"
export STACK_API_PORT="${STACK_API_PORT_KEPT:-${STACK_API_PORT:-4080}}"
export STACK_WEB_PORT="${STACK_WEB_PORT_KEPT:-${STACK_WEB_PORT:-3080}}"
STACK_API_URL="http://localhost:$STACK_API_PORT/api/v1"
MODE=full; REUSE=0; SKIP_DURABILITY=0; API_URL_ARG="$STACK_API_URL"
while [ $# -gt 0 ]; do
  case "$1" in
    --reuse) REUSE=1 ;;
    --skip-durability) SKIP_DURABILITY=1 ;;
    --ai-check) MODE=ai-check ;;
    --api) shift; API_URL_ARG="${1:-}" ;;
    -h|--help) print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p tmp
RECEIPT="tmp/prove-local-$STAMP.json"
LOGS="tmp/prove-local-$STAMP"
mkdir -p "$LOGS"

# ------------------------------------------------------ what the checks need

# The checks are Node scripts that build the passing work from the web app's
# own fixtures (scripts/passing-work.mjs), so they need this checkout's
# node_modules and the shared package built: once, and quickly after that.
step "Preparing the checks (Node $(node -v 2>/dev/null || echo missing))"
command -v node >/dev/null 2>&1 || die "node was not found. Install Node 24 (nvm install, which reads .nvmrc)."
# package.json's engines field: npm ci refuses any other Node, and the checks
# load the API's ES-module dependencies, which older Node cannot require.
node_supported \
  || die "node $(node -v) does not match this repository's engines (^24.9.0 || >=26.0.0); run nvm install (it reads .nvmrc, 24.21.0) and nvm use."
if [ ! -d node_modules/ts-node ]; then
  echo "  installing this checkout's dependencies (npm ci, a few minutes the first time)"
  npm ci --no-audit --no-fund > "$LOGS/npm-ci.log" 2>&1 || die "npm ci failed; see $LOGS/npm-ci.log"
fi
if [ ! -f packages/shared/dist/index.js ]; then
  npm run build -w @learnsdlc/shared > "$LOGS/build-shared.log" 2>&1 || die "building packages/shared failed; see $LOGS/build-shared.log"
fi
echo "  ok    dependencies and packages/shared are in place"

on_failure_logs() {
  bash scripts/stack.sh compose logs --no-color --tail 400 > "$LOGS/stack.log" 2>&1 || true
  echo "  The stack's last log lines are in $LOGS/stack.log"
}

stack_seconds=0
bring_up() { # stack.sh up arguments
  local started=$SECONDS
  bash scripts/stack.sh up --detach "$@" 2>&1 | tee "$LOGS/stack-up.log"
  local code=${PIPESTATUS[0]}
  stack_seconds=$((SECONDS - started))
  return "$code"
}

# The stack's start is a step of the proof too: written into the receipt the
# Node checks write, so the one file says how long all of it took.
add_stack_step() { # ok(true|false), detail
  node -e '
    const fs = require("fs");
    const [file, ok, ms, detail] = process.argv.slice(1);
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    receipt.steps.unshift({ name: "Stack: build and start (scripts/stack.sh up --detach)", ok: ok === "true", ms: Number(ms), detail });
    receipt.ok = receipt.ok && ok === "true";
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  ' "$1" "$2" "$3" "$4"
}

# Platform facts for the receipt: no host name, no user, no address.
add_platform() { # receipt
  node -e '
    const fs = require("fs");
    const { execSync } = require("child_process");
    const sh = (c) => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
    const file = process.argv[1];
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    receipt.platform = {
      os: process.platform, arch: process.arch, release: require("os").release(),
      node: process.version,
      docker: sh("docker version --format {{.Server.Version}}"),
      compose: sh("docker compose version --short"),
      dockerKernel: sh("docker info --format {{.KernelVersion}}"),
      dockerMemoryGb: (() => { const b = Number(sh("docker info --format {{.MemTotal}}")); return b ? Math.round(b / 1073741824) : null; })(),
    };
    receipt.commit = sh("git rev-parse --short HEAD");
    // true when the tree held uncommitted changes, so the commit alone does not name what ran
    receipt.dirty = (() => { const out = sh("git status --porcelain --untracked-files=no"); return out === null ? null : out.length > 0; })();
    // the dirty flag leaves untracked files out (a checkout holds many that ship nothing); the untracked files under the
    // code that runs are counted beside it, so a new file the proof ran with is never hidden
    receipt.untrackedCode = (() => { const out = sh("git status --porcelain --untracked-files=all -- apps packages content scripts e2e"); return out === null ? null : out.split("\n").filter((line) => line.startsWith("??")).length; })();
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  ' "$1"
}

# ------------------------------------------------------------------ the modes

case "$MODE" in
  full)
    if [ "$REUSE" = 1 ]; then
      [ "$(tr -dc 'a-z-' < .env.verify-ai 2>/dev/null || true)" = stub ] \
        || die "--reuse needs the stack running with the test mentor: npm run demo -- --docker --ai-stub --detach"
      step "Reusing the running stack (test mentor)"
      STACK_OK=true; stack_seconds=0
    else
      step "Starting the stack with the test mentor"
      if bring_up --ai-stub; then STACK_OK=true; else STACK_OK=false; fi
    fi
    if [ "$STACK_OK" != true ]; then
      printf '{"kind":"learnsdlc-local-proof","mode":"full","ok":false,"steps":[]}\n' > "$RECEIPT"
      add_stack_step "$RECEIPT" false "$((stack_seconds * 1000))" "the stack did not start; see $LOGS/stack-up.log"
      add_platform "$RECEIPT"
      on_failure_logs
      die "the stack did not start. Receipt: $RECEIPT"
    fi
    EXTRA=()
    [ "$SKIP_DURABILITY" = 1 ] && EXTRA+=(--skip-durability)
    set +e
    node scripts/prove-local.mjs --mode full --stub-marker --receipt "$RECEIPT" --logs "$LOGS" ${EXTRA[@]+"${EXTRA[@]}"}
    CODE=$?
    set -e
    [ "$REUSE" = 1 ] || add_stack_step "$RECEIPT" true "$((stack_seconds * 1000))" "every service healthy"
    add_platform "$RECEIPT"
    [ "$CODE" = 0 ] || on_failure_logs
    exit "$CODE"
    ;;

  ai-check)
    step "Checking the AI the running stack is configured with"
    curl -fsS -o /dev/null "$API_URL_ARG/health/ready" 2>/dev/null \
      || die "nothing answers $API_URL_ARG. Start the stack first (npm run demo -- --docker), or name the native demo's API with --api http://localhost:4000/api/v1."
    MARK=()
    if [ "$API_URL_ARG" = "$STACK_API_URL" ] && [ "$(tr -dc 'a-z-' < .env.verify-ai 2>/dev/null || true)" = stub ]; then MARK=(--stub-marker); fi
    set +e
    node scripts/prove-local.mjs --mode ai --api "$API_URL_ARG" --receipt "$RECEIPT" --logs "$LOGS" --label ai-check ${MARK[@]+"${MARK[@]}"}
    CODE=$?
    set -e
    add_platform "$RECEIPT"
    exit "$CODE"
    ;;

esac
