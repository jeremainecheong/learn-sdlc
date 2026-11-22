#!/usr/bin/env bash
# LearnSDLC in one command: check the machine, install, build, migrate, start.
#
#   npm run demo               # the whole product on http://localhost:3000
#   npm run demo -- --class --ai-stub  # and a seeded class to look at (the seed needs the test mentor)
#   npm run demo -- --ai-stub  # the canned test mentor instead of a provider (CI)
#   npm run demo -- --docker   # every feature, in containers (scripts/stack.sh)
#   npm run demo -- --docker --ai-stub | --fresh | --detach | --down
#   npm run demo -- --dev      # live reload instead of the built bundles
#   npm run demo -- --rebuild  # reinstall and rebuild first
#   npm run demo -- --help
#
# WEB_PORT and API_PORT move both servers (3000 and 4000 by default); with
# --dev the web app stays on 3000, because its dev server is next dev -p 3000.
# An AI key is required: without OPENAI_API_KEY in .env (or the environment)
# this refuses to start, unless --ai-stub asks for the test mentor by name
# (scripts/ai-key.sh says why). This SQLite path needs no Redis
# or Docker. Learner code runs only where the kernel can confine it (Linux
# with Landlock); elsewhere the demo starts and says Run, Submit and Preview
# are refused.
#
# This does not replace scripts/setup.sh or scripts/start.sh; it runs them.
# The prerequisite checks and the idempotent install are setup.sh's, and the
# sandbox runner, the loopback refusal, the demo accounts and the mail capture
# file are start.sh's. What is added here is the parts a one-command demo needs
# that neither has: a build that is skipped when it is current, the migration
# step run before anything binds a port, and one block at the end that says
# what is running and how to sign in.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"

REBUILD=0; WITH_CLASS=0; MODE=start; AI_STUB=0; USE_DOCKER=0
FRESH=0; DETACH=0; DOWN=0
for a in "$@"; do
  case "$a" in
    --rebuild) REBUILD=1 ;;
    --class)   WITH_CLASS=1 ;;
    --dev)     MODE=dev ;;
    # Accepted and ignored, so a command written with them still runs: the AI
    # is always the one .env configures, and nothing here opens a browser.
    --ai|--no-open) ;;
    --ai-stub) AI_STUB=1 ;;
    --docker)  USE_DOCKER=1 ;;
    # The Compose stack's own options, passed to scripts/stack.sh.
    --fresh)   FRESH=1 ;;
    --detach)  DETACH=1 ;;
    --down)    DOWN=1 ;;
    -h|--help) print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 1 ;;
  esac
done

# --------------------------------------------------------- the container path

# --docker hands over to the Compose stack (scripts/stack.sh): the runner in
# its own container, PostgreSQL, Redis, Caddy and Mailpit, on 3080, 4080 and
# 5085. It runs learner code on any host whose Docker kernel gives the runner
# Landlock: Linux, and Colima's Ubuntu VM on macOS, but not Docker Desktop's VM
# on macOS. Where it does not, the runner's health check fails and the stack
# says so. The AI is the key in .env, or --ai-stub (the test mentor, inside
# the stack).
#
# Neither path starts without a key, and --down needs none.
if [ "$AI_STUB" = 0 ] && [ "$DOWN" = 0 ]; then
  # shellcheck source=scripts/ai-key.sh
  . "$ROOT/scripts/ai-key.sh"
  require_ai_key "$ROOT"
fi

if [ "$USE_DOCKER" = 1 ]; then
  STACK_ARGS=(up)
  [ "$DOWN" = 1 ] && STACK_ARGS=(down)
  [ "$AI_STUB" = 1 ] && STACK_ARGS+=(--ai-stub)
  [ "$FRESH" = 1 ] && STACK_ARGS+=(--fresh)
  [ "$DETACH" = 1 ] && STACK_ARGS+=(--detach)
  if [ "$REBUILD" = 1 ] || [ "$WITH_CLASS" = 1 ] || [ "$MODE" = dev ]; then
    die "--rebuild, --class and --dev belong to the native demo, not --docker (the stack rebuilds what changed by itself)."
  fi
  exec bash scripts/stack.sh "${STACK_ARGS[@]}"
fi
if [ "$FRESH" = 1 ] || [ "$DETACH" = 1 ] || [ "$DOWN" = 1 ]; then
  die "--fresh, --detach and --down go with --docker (npm run demo -- --docker ...)."
fi

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-4000}"
WEB_URL="http://localhost:$WEB_PORT"
API_URL="http://localhost:$API_PORT"
# Where the two servers' output goes while this script watches for them to
# answer. DEMO_LOG moves it, which is what scripts/demo-selftest.sh does so a
# check never writes over the log of a demo someone is running.
LOG="${DEMO_LOG:-$ROOT/data/demo.log}"

# The API reads API_PORT; next's standalone server reads PORT; the API's CORS
# allow-list is WEB_ORIGIN and the browser bundle's API address is baked in at
# build time. All four are the same two numbers, so they are set here once.
export API_PORT
export PORT="$WEB_PORT"
export WEB_ORIGIN="${WEB_ORIGIN:-$WEB_URL}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-$API_URL}"

# Absolute: the API runs with apps/api as its working directory, so a relative
# DB_PATH would put the file under apps/api rather than where this says it is.
export DB_PATH="${DB_PATH:-$ROOT/data/learnsdlc.sqlite}"

# The local-first store is migrated, never auto-synced. This is the
# variable resolveRunMigrations (apps/api/src/config.ts) reads, and setting it
# also turns schema auto-sync off (resolveSchemaSync), which is the point.
export RUN_MIGRATIONS=true

# One socket per API port, so a second demo on other ports does not meet the
# first one's runner (serve.py refuses to share a live socket, by design).
export RUNNER_SOCKET="${RUNNER_SOCKET:-${TMPDIR:-/tmp}/learnsdlc/runner-$API_PORT.sock}"

# --class replays five weeks of a class in ten minutes, which needs the demo
# clock: POST /api/v1/demo/clock, admin only, loopback only, and off unless
# this variable asks for it by name. Nothing else here turns it on.
if [ "$WITH_CLASS" = 1 ]; then
  export DEMO_CLOCK="${DEMO_CLOCK:-true}"
fi

# Read, never set: start.sh refuses a non-loopback bind too, but this is the
# message with the section to read in it.
if [ -n "${API_BIND:-}" ]; then
  case "$API_BIND" in
    127.*|localhost|::1) ;;
    *) die "API_BIND=$API_BIND is not the demo path. Hosting a class needs a real JWT_SECRET and no demo accounts: read \"Hosting a class\" in the README." ;;
  esac
fi

# Paths in the closing block are read by a person sitting in this directory.
relative_to_root() {
  case "$1" in
    "$ROOT"/*) printf '%s' "${1#"$ROOT"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The free-port check below is only the early, friendlier message: something
# can still take a port between it and the start. Once a server answers, its
# listener has to be the process this script started or one of its children,
# or the answer came from someone else's process. The port helpers are in
# scripts/lib/common.sh.
listener_is_ours() { # port, pid this script started
  pids="$(listener_pids "$1")"
  [ -n "$pids" ] && listeners_all_visible "$1" || return 1
  for pid in $pids; do descends_from "$pid" "$2" || return 1; done
}
not_ours() { # port, what it is
  fail_with_log "$2 answered on port $1, but not from the process this started: another process holds the port ($(port_holder "$1")). Stop it and run this again."
}

# ---------------------------------------------------------------- the machine

step "Checking this machine"
# setup.sh checks the same things before it installs anything. They are
# checked here first because this script has to decide whether to call it at
# all, and because this is where a missing version can still be found: the
# .nvmrc version (24.21.0, also Docker's and CI's) through nvm, and Python
# 3.11 under its versioned name when the plain python3 is another version.
if ! node_supported; then
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  # shellcheck disable=SC1090
  if [ -s "$NVM_SH" ] && . "$NVM_SH" >/dev/null 2>&1 && nvm use >/dev/null 2>&1 && node_supported; then
    ok "switched to node $(node -v) from .nvmrc with nvm"
  elif command -v node >/dev/null; then
    die "node $(node -v) is unsupported. Use Node 24.9+ LTS: nvm install (it reads .nvmrc), then run this again."
  else
    die "node was not found. Install nvm, then run: nvm install (it reads .nvmrc)."
  fi
fi
command -v npm >/dev/null || die "npm was not found, and it ships with Node. Reinstall the version in .nvmrc."

# Learner JavaScript runs on Node 22 (the TaskTrackr pack's runtime), apart
# from the application's own Node 24: NODE_BIN names it for the pre-baked
# layer and for the runner. Kept when set; otherwise the newest Node 22 that
# nvm has, or a node22 on PATH.
NODE_BIN="$(find_node22 || true)"
[ -n "$NODE_BIN" ] \
  || die "learner code runs on Node 22, and none was found. Install it beside Node 24 (nvm install 22), or set NODE_BIN to a Node 22 binary."
export NODE_BIN

# The sandbox's pre-baked layer is built for Python 3.11 exactly, so a newer
# python3 cannot stand in for it.
PYTHON="$(find_python exact || true)"
[ -n "$PYTHON" ] || die "Python 3.11 was not found (python3 is $(python3 -V 2>&1 || echo missing)). The sandbox runner and its pre-baked layer need 3.11 exactly. Install Python 3.11 (brew install python@3.11, or apt install python3.11), or set PYTHON_BIN to one."
# Named by its absolute path, never by a directory put on PATH: setup.sh,
# start.sh (which starts the runner with it), prebake.mjs and the self-test
# all read PYTHON_BIN, and default to python3 only when it is unset.
export PYTHON_BIN="$PYTHON"
PY_VERSION="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
command -v ss >/dev/null || command -v lsof >/dev/null \
  || die "neither ss nor lsof was found; one of them names whatever holds a port this needs. Install lsof."
command -v curl >/dev/null || die "curl was not found; it is how this asks the servers whether they answer. Install it."
ok "node $(node -v), npm $(npm -v), learner node $("$NODE_BIN" -v), python3 $PY_VERSION, $(command -v ss >/dev/null && echo ss || echo lsof), curl"

# One variable moves the stub: AI_STUB_PORT, or the PW_AI_PORT the stub itself
# reads (e2e/ai-stub.cjs).
AI_STUB_PORT="${AI_STUB_PORT:-${PW_AI_PORT:-4199}}"
PORTS="$WEB_PORT $API_PORT"
if [ "$AI_STUB" = 1 ]; then PORTS="$PORTS $AI_STUB_PORT"; fi
for p in $PORTS; do
  HOLDER="$(port_holder "$p")"
  if [ -n "$HOLDER" ]; then
    die "port $p is already in use ($HOLDER). Stop that process, then run this again."
  fi
done
ok "ports $(echo "$PORTS" | sed 's/ /, /g') are free"

# The runner's own answer, asked before anything is installed: the same
# isolation_status() its GET /health reports. Where it is "unsupported" the
# runner refuses learner code by design; everything else still starts.
ISOLATION="$("$PYTHON_BIN" -B scripts/runner-status.py --local || true)"
case "$ISOLATION" in
  ok*)
    ok "learner code is confined here (${ISOLATION#ok })" ;;
  *)
    warn "this machine cannot isolate learner code (the runner says: ${ISOLATION#unsupported })."
    warn "The demo still starts, but Run, Submit and Preview of learner code are refused here."
    warn "For those, use npm run demo -- --docker (Colima on a Mac, Docker Engine on Linux)." ;;
esac

# ------------------------------------------------- dependencies and the build

# What next build baked into the browser bundle as the API's address. It is
# read back out of the header next.config.js derives from the same variable,
# because a bundle built for another port calls that port from the browser and
# every request fails CORS.
baked_api_url() {
  node -e '
    const fs = require("fs");
    try {
      const manifest = JSON.parse(fs.readFileSync("apps/web/.next/routes-manifest.json", "utf8"));
      const headers = (manifest.headers || []).reduce((all, entry) => all.concat(entry.headers || []), []);
      const csp = headers.find((header) => header.key === "Content-Security-Policy");
      const found = csp && /connect-src [^;]*?(http:\/\/[^\s;]+)/.exec(csp.value);
      process.stdout.write(found ? found[1] : "");
    } catch (error) {
      process.stdout.write("");
    }
  '
}

# A heuristic, and it says so: a change outside these directories (a config
# file, a content pack) does not show up here. --rebuild is the way past it.
sources_newer_than() {
  [ -f "$1" ] || return 0
  [ -n "$(find apps/api/src apps/web/app apps/web/components apps/web/lib packages/shared/src \
      -newer "$1" -type f -print -quit 2>/dev/null)" ]
}

if [ "$REBUILD" = 1 ]; then
  step "Reinstalling"
  npm ci
  rm -rf apps/api/dist apps/web/.next packages/shared/dist
  ok "node_modules reinstalled, and the previous build removed"
fi

NEED_SETUP=0
BAKED=""
if [ ! -d node_modules ] || [ ! -f .env ]; then NEED_SETUP=1; fi
if [ "$MODE" = start ]; then
  if [ ! -f apps/api/dist/main.js ] || [ ! -f apps/web/.next/BUILD_ID ]; then
    NEED_SETUP=1
  elif sources_newer_than apps/api/dist/main.js || sources_newer_than apps/web/.next/BUILD_ID; then
    NEED_SETUP=1
  else
    BAKED="$(baked_api_url)"
    if [ "$BAKED" != "$API_URL" ]; then
      warn "apps/web/.next was built for ${BAKED:-an API this script cannot read}. Rebuilding it for $API_URL."
      NEED_SETUP=1
    fi
  fi
fi

if [ "$NEED_SETUP" = 1 ]; then
  # Two parts of setup.sh's output are dropped and the rest streams through as
  # setup.sh writes it: its prerequisite block, which is the three things this
  # script has just said in one line, and its closing block, which tells the
  # reader to run start.sh next; here that is the next step of this script.
  bash scripts/setup.sh | awk '
    /^==> Setup complete/ { done = 1 }
    /^==> Checking prerequisites/ { checking = 1; next }
    checking && /^==> / { checking = 0 }
    !done && !checking { print; fflush() }'
else
  step "Installing dependencies"
  ok "node_modules is current (npm run demo -- --rebuild forces a reinstall and a rebuild)"
  step "Building"
  ok "the build is newer than every source file, and is built for $API_URL"
  step "Configuration"
  # setup.sh generates .env's JWT_SECRET; an .env made before that, or by
  # hand, gets one here, once (scripts/lib/common.sh, ensure_env_secret).
  case "$(ensure_env_secret .env JWT_SECRET || true)" in
    kept) ok ".env is in place" ;;
    written|replaced) ok ".env is in place, and a JWT_SECRET was generated into it for this machine" ;;
    *) die "a JWT_SECRET could not be generated into .env (node writes it); set JWT_SECRET in .env yourself and run this again." ;;
  esac
fi

# --------------------------------------------------------- the sandbox's deps

step "Sandbox dependencies"
# Flask, pytest, React, jsdom and esbuild, on disk before the first learner run.
# Verified rather than rebuilt, because a rebuild is a minute of network on
# every demo start; if what is here does not match what the packs pin, that is
# the minute to spend and the message above says why.
if node scripts/prebake.mjs verify >/dev/null 2>&1; then
  ok "the sandbox's pre-baked layer matches the packs"
else
  warn "the sandbox's dependencies are out of date; rebuilding them now."
  if node scripts/prebake.mjs build; then
    ok "the sandbox's pre-baked layer is ready"
  else
    die "the sandbox's dependencies could not be built; the message above says which one."
  fi
fi

# ------------------------------------------------------------------- the store

step "Database"
# Before anything binds a port: a file that needs a person is then a message on
# this terminal rather than a half-started stack and a log nobody is watching.
MIGRATE_ERR="$ROOT/data/.demo-migrate.err"
mkdir -p "$ROOT/data"
if [ "$MODE" = dev ]; then
  MIGRATE_SCRIPT=db:migrate:dev
else
  MIGRATE_SCRIPT=db:migrate
fi
if MIGRATED="$(npm run --silent "$MIGRATE_SCRIPT" -w @learnsdlc/api 2>"$MIGRATE_ERR")"; then
  if [ -s "$MIGRATE_ERR" ]; then cat "$MIGRATE_ERR" >&2; fi
  rm -f "$MIGRATE_ERR"
  ok "$MIGRATED"
else
  cat "$MIGRATE_ERR" >&2
  rm -f "$MIGRATE_ERR"
  exit 1
fi

# ----------------------------------------------------------------- the servers

if [ "$AI_STUB" = 1 ]; then
  # The Playwright suite's canned endpoint (e2e/ai-stub.cjs), on loopback, with
  # the literal key that file publishes (its KEY export), the one
  # playwright.config.ts also gives the API. It is a test
  # harness, not a model: it passes only work marked for the harness.
  # Exported here, these win over .env (scripts/run-with-env.mjs never
  # overrides a variable that is already set).
  export OPENAI_BASE_URL="http://127.0.0.1:$AI_STUB_PORT/v1"
  export OPENAI_API_KEY="e2e-stub-not-a-secret"
fi

step "Starting"
START_FLAGS=""
if [ "$MODE" = dev ]; then START_FLAGS="--dev"; fi

: > "$LOG"
STUB_PID=""
if [ "$AI_STUB" = 1 ]; then
  PW_AI_PORT="$AI_STUB_PORT" node e2e/ai-stub.cjs </dev/null >>"$LOG" 2>&1 &
  STUB_PID=$!
fi
# set -m puts start.sh in its own process group, so ctrl+c here can stop the
# whole tree it owns (npm, concurrently, the API, the web server and the
# runner) rather than the one process this script knows the pid of.
set -m
# START_FLAGS is deliberately unquoted: it is a list of flags, not one word.
# shellcheck disable=SC2086
bash scripts/start.sh $START_FLAGS </dev/null >>"$LOG" 2>&1 &
START_PID=$!
set +m
TAIL_PID=""
STOPPING=0

servers_gone() {
  ! kill -0 "$START_PID" 2>/dev/null
}

fail_with_log() {
  echo
  printf '  \033[31mfail\033[0m  %s\n' "$1"
  echo
  tail -n 25 "$LOG" || true
  exit 1
}

# Whatever ends this script once start.sh is running (a failed step, set -e,
# a signal this does not handle) takes the servers with it. Without this a
# step that exited after the servers came up would leave the API, the web
# server and the runner behind, holding two ports and a socket with nothing
# watching them.
cleanup_on_exit() {
  if [ "$STOPPING" = 1 ]; then return 0; fi
  if [ -n "$TAIL_PID" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null || true; fi
  kill -TERM -"$START_PID" 2>/dev/null || kill -TERM "$START_PID" 2>/dev/null || true
  # Long enough for the ports to be free by the time this shell is gone, so
  # whatever runs next does not meet the tail of this one.
  i=0
  while [ "$i" -lt 20 ] && ! servers_gone; do
    sleep 0.5
    i=$((i + 1))
  done
}
trap cleanup_on_exit EXIT

stop() {
  if [ "$STOPPING" = 1 ]; then return 0; fi
  STOPPING=1
  trap - INT TERM
  echo
  echo "Stopping."
  if [ -n "$TAIL_PID" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null || true; fi
  kill -TERM -"$START_PID" 2>/dev/null || kill -TERM "$START_PID" 2>/dev/null || true
  i=0
  while [ "$i" -lt 40 ]; do
    if [ -z "$(port_holder "$API_PORT")" ] && [ -z "$(port_holder "$WEB_PORT")" ] && servers_gone; then
      break
    fi
    sleep 0.5
    i=$((i + 1))
  done
  if servers_gone; then :; else
    kill -KILL -"$START_PID" 2>/dev/null || kill -KILL "$START_PID" 2>/dev/null || true
    sleep 1
  fi
  ok "sandbox runner stopped"
  ok "api stopped"
  ok "web stopped"
  if [ -n "$STUB_PID" ]; then ok "test mentor stub stopped"; fi
  exit 0
}
trap stop INT TERM

# The runner first, because start.sh waits for it and exits if it never
# answers; RUNNER_MODE set in the environment means someone else started one.
# runner-status.py tells "not answering yet" from "answering, and refusing
# learner code on this machine", and the second is not a failure.
RUNNER_STATUS="external"
if [ -z "${RUNNER_MODE:-}" ]; then
  i=0
  RUNNER_STATUS="down"
  while [ "$i" -lt 60 ]; do
    RUNNER_STATUS="$("$PYTHON_BIN" -B scripts/runner-status.py || true)"
    case "$RUNNER_STATUS" in ok*|unsupported*) break ;; esac
    if servers_gone; then
      fail_with_log "The sandbox runner did not answer on $RUNNER_SOCKET (${RUNNER_STATUS#down }). Its log is data/runner.log."
    fi
    sleep 0.5
    i=$((i + 1))
  done
  case "$RUNNER_STATUS" in
    ok*) ok "sandbox runner on $RUNNER_SOCKET, confining learner code (${RUNNER_STATUS#ok })" ;;
    unsupported*) warn "sandbox runner on $RUNNER_SOCKET answers, and refuses learner code here (${RUNNER_STATUS#unsupported }): Run, Submit and Preview are refused" ;;
    *) fail_with_log "The sandbox runner did not answer on $RUNNER_SOCKET (${RUNNER_STATUS#down }). Its log is data/runner.log." ;;
  esac
fi

if [ "$AI_STUB" = 1 ]; then
  i=0
  while [ "$i" -lt 30 ] && ! curl -sf -o /dev/null "http://127.0.0.1:$AI_STUB_PORT/__stub/counts"; do
    if ! kill -0 "$STUB_PID" 2>/dev/null; then fail_with_log "The test mentor stub stopped before it answered on port $AI_STUB_PORT."; fi
    sleep 1
    i=$((i + 1))
  done
  curl -sf -o /dev/null "http://127.0.0.1:$AI_STUB_PORT/__stub/counts" \
    || fail_with_log "The test mentor stub did not answer on port $AI_STUB_PORT."
  listener_is_ours "$AI_STUB_PORT" "$STUB_PID" || not_ours "$AI_STUB_PORT" "the test mentor stub"
  ok "test mentor stub on 127.0.0.1:$AI_STUB_PORT"
fi

wait_for() { # url, seconds, what it is
  i=0
  while [ "$i" -lt "$2" ]; do
    if curl -sf -o /dev/null "$1"; then return 0; fi
    if servers_gone; then fail_with_log "$3 stopped before it answered."; fi
    sleep 1
    i=$((i + 1))
  done
  fail_with_log "$3 did not answer $1 within $2 seconds."
}

wait_for "$API_URL/api/v1/health" 120 "the api"
listener_is_ours "$API_PORT" "$START_PID" || not_ours "$API_PORT" "the api"
ok "api answering on $API_URL"
wait_for "$WEB_URL/login" 120 "the web app"
listener_is_ours "$WEB_PORT" "$START_PID" || not_ours "$WEB_PORT" "the web app"
ok "web answering on $WEB_URL"

if [ "$WITH_CLASS" = 1 ]; then
  # The seeder's default is 4000; it goes wherever this demo actually is.
  # A seed that stops half way is a warning, not the end of the demo: the
  # product is up, and the class can be taken out and seeded again while it
  # runs (npm run seed:class -- --remove).
  if ! API_URL="$API_URL/api/v1" npm run --silent seed:class; then
    warn "The class seed stopped before it finished. The demo is running; if it created learners, take them out with npm run seed:class -- --remove, then try again."
  fi
fi

# --------------------------------------------------------------- what is running

# Asked rather than assumed: the mentor a learner will meet is the
# one the API says it resolved, not the one this script hoped to configure.
AI_PROVIDER="$(curl -sf "$API_URL/api/v1/health" \
  | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { process.stdout.write(JSON.parse(s).aiProvider || ""); } catch (e) { process.stdout.write(""); } })' \
  || true)"
# The API names its provider by where it points: "openai" for api.openai.com,
# "local-ai:<model>" for a loopback endpoint (the stub is one),
# "compatible-ai:<model>" for any other, and "unavailable" without a key.
if [ "$AI_STUB" = 1 ] && [ "${AI_PROVIDER#local-ai:}" != "$AI_PROVIDER" ]; then
  MENTOR_LINE="test stub on 127.0.0.1:$AI_STUB_PORT (e2e/ai-stub.cjs), not a model: it passes only work marked for the test harness"
elif [ -n "$AI_PROVIDER" ] && [ "$AI_PROVIDER" != "unavailable" ]; then
  MENTOR_LINE="configured provider, $AI_PROVIDER"
else
  MENTOR_LINE="AI unavailable: configure OPENAI_API_KEY in the private .env, or start with --ai-stub for the test mentor"
fi
case "$RUNNER_STATUS" in
  ok*) RUNNER_LINE="socket, apps/api/runner/serve.py, confining learner code (${RUNNER_STATUS#ok }), log data/runner.log" ;;
  unsupported*) RUNNER_LINE="socket, apps/api/runner/serve.py, log data/runner.log
             this machine cannot isolate learner code (${RUNNER_STATUS#unsupported }):
             Run, Submit and Preview are refused. Use --docker for them
             (Colima on a Mac, Docker Engine on Linux)." ;;
  *) RUNNER_LINE="$RUNNER_MODE, set in the environment" ;;
esac
if [ -n "${REDIS_URL:-}" ]; then QUEUE_LINE="redis, $REDIS_URL"; else QUEUE_LINE="in process, no Redis needed"; fi
MAIL_LINE="$(relative_to_root "${MAIL_CAPTURE_FILE:-$ROOT/data/mail.log}")"
LOG_LINE="$(relative_to_root "$LOG")"
STAFF_PASSWORD_INSTRUCTOR="$(staff_password_shown "$DEMO_INSTRUCTOR_DEFAULT_PASSWORD")"
STAFF_PASSWORD_ADMIN="$(staff_password_shown "$DEMO_ADMIN_DEFAULT_PASSWORD")"

cat <<BLOCK

==> LearnSDLC is running

  Web        $WEB_URL
  API        $API_URL

  Learner    register at $WEB_URL/register
  Instructor $DEMO_INSTRUCTOR_EMAIL, password $STAFF_PASSWORD_INSTRUCTOR
  Admin      $DEMO_ADMIN_EMAIL, password $STAFF_PASSWORD_ADMIN

  Runner     $RUNNER_LINE
  Queue      $QUEUE_LINE
  AI         $MENTOR_LINE
  Database   $MIGRATED
  Mail       not sent, captured in $MAIL_LINE
  Logs       $LOG_LINE, and everything below this line

  The API binds 127.0.0.1, so only this machine can use it. Model requests go
  to the AI named above. Stop with ctrl+c.

BLOCK

# Everything the two servers write from here on, under the block above rather
# than scrolling it away before anyone has read it.
tail -n 0 -f "$LOG" &
TAIL_PID=$!
# Off the jobs table, so stopping it at the end is not announced over the last
# thing this script has to say.
disown "$TAIL_PID" 2>/dev/null || true

set +e
wait "$START_PID"
STATUS=$?
set -e
if [ -n "$TAIL_PID" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
echo
echo "The servers stopped on their own (exit $STATUS). Their output is $LOG_LINE."
exit "$STATUS"
