#!/usr/bin/env bash
# Start LearnSDLC (API on :4000, web on :3000), on the configuration npm run
# demo uses: the same database file, migrations rather than schema auto-sync,
# the AI key from .env, and the sandbox runner.
#
#   bash scripts/start.sh            # the built bundles
#   bash scripts/start.sh --dev      # live reload instead of the built bundles
#
# WEB_PORT and API_PORT move both servers (3000 and 4000 by default); with
# --dev the web app stays on 3000, because its dev server is next dev -p 3000.
#
# The API binds 127.0.0.1, so it is reachable from this machine and nowhere
# else. That is what makes the demo staff accounts and their published
# passwords safe here. To host a class, read "Hosting a class" in the README:
# it is API_BIND=0.0.0.0 plus a real JWT_SECRET, and no demo accounts.
#
# Run scripts/setup.sh once before this. npm run demo runs both.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/ai-key.sh
. "$ROOT/scripts/ai-key.sh"

MODE=start
for a in "$@"; do
  case "$a" in
    # Accepted and ignored, so a command written with it still runs: the AI
    # is always the one .env configures.
    --ai) ;;
    --dev) MODE=dev ;;
    -h|--help) print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 1 ;;
  esac
done

[ -d node_modules ] || { echo "node_modules missing - run: bash scripts/setup.sh"; exit 1; }
if [ "$MODE" = start ] && [ ! -d apps/api/dist ]; then
  echo "no build found - run: bash scripts/setup.sh   (or use --dev)"; exit 1
fi

# Loopback only. Everything below - the demo accounts, the mail capture file -
# is safe because of this line, so refuse to keep going if someone has widened
# it here rather than reading the README section that explains the rest.
export API_BIND="${API_BIND:-127.0.0.1}"
case "$API_BIND" in
  127.*|localhost|::1) ;;
  *) echo "API_BIND=$API_BIND: start.sh is the loopback demo path. Hosting a class needs a real"
     echo "JWT_SECRET and no demo accounts - see \"Hosting a class\" in the README, then run"
     echo "the API directly (npm run start) with the variables that section lists."; exit 1 ;;
esac

# The AI key is required, from the environment or .env. npm run demo --ai-stub
# exports the test mentor's literal key before it calls this, so that path
# passes here too.
require_ai_key "$ROOT"

# The session secret: JWT_SECRET from the environment, else from .env, where
# setup.sh generates it. An .env without one gets one here, once, and a real
# one is never replaced: a new secret signs everyone out and redraws every
# quiz paper in progress (scripts/lib/common.sh, ensure_env_secret).
if [ -z "${JWT_SECRET:-}" ]; then
  [ -f .env ] || { echo "no .env, so there is no JWT_SECRET to sign sessions with - run: bash scripts/setup.sh"; exit 1; }
  case "$(ensure_env_secret .env JWT_SECRET || true)" in
    kept) ;;
    written|replaced) echo "secret: a JWT_SECRET was generated into .env for this machine" ;;
    *) echo "a JWT_SECRET could not be generated into .env (node writes it); set JWT_SECRET in .env yourself"; exit 1 ;;
  esac
fi

# The two ports, named once. They are 3000 and 4000 unless something asked
# for others: scripts/demo.sh sets them when it is run on other ports, and the
# API reads API_PORT while next's standalone server reads PORT, so the check
# below and the servers themselves always agree about which two to expect.
WEB_PORT="${WEB_PORT:-3000}"
export API_PORT="${API_PORT:-4000}"
export PORT="${PORT:-$WEB_PORT}"

# The API's CORS allow-list and the browser's API address follow the ports.
# Exported here, these win over .env (scripts/run-with-env.mjs never
# overrides a variable that is already set), as they do under npm run demo.
export WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:$WEB_PORT}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:$API_PORT}"

# One database for npm run demo and this script: DB_PATH from the environment, else from
# .env, else data/learnsdlc.sqlite, and a relative path is taken from the
# repository root. Absolute, because the API runs with apps/api as its working
# directory and would otherwise put the file under apps/api.
DB_PATH="${DB_PATH:-$(env_value .env DB_PATH)}"
DB_PATH="${DB_PATH:-data/learnsdlc.sqlite}"
case "$DB_PATH" in /*) ;; *) DB_PATH="$ROOT/$DB_PATH" ;; esac
export DB_PATH
UNUSED_DB="$ROOT/apps/api/data/learnsdlc.sqlite"
if [ -f "$UNUSED_DB" ] && [ "$UNUSED_DB" != "$DB_PATH" ]; then
  echo "note: apps/api/data/learnsdlc.sqlite is left untouched; this run uses $DB_PATH."
  echo "      npm run host, npm run dev and npm start open the file under apps/api instead."
fi

# The store is migrated, never auto-synced (resolveRunMigrations and
# resolveSchemaSync in apps/api/src/config.ts).
export RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"

# The demo staff accounts ship passwords printed in the README, so they are
# created only when asked for. Loopback is what makes asking reasonable.
export SEED_DEMO_ACCOUNTS="${SEED_DEMO_ACCOUNTS:-true}"

# Without SMTP the API sends nothing and logs no link. This is where the reset
# and verification messages land instead, one JSON line each - so "Forgot your
# password?" still works on a laptop. Live credentials: treat it as a mailbox.
export MAIL_CAPTURE_FILE="${MAIL_CAPTURE_FILE:-$ROOT/data/mail.log}"

# Learner JavaScript runs on Node 22, the pack's runtime. npm run demo refuses
# to start without one; here it is a warning, because the rest of the product
# still runs.
if NODE22="$(find_node22)"; then
  export NODE_BIN="$NODE22"
else
  echo "warning: no Node 22 was found (nvm install 22, or set NODE_BIN), so learner JavaScript runs on $(node -v)."
fi

# Learner code runs in runner/serve.py behind a UNIX socket: a separate
# process, its own process group, and the API never spawns it per job.
# RUNNER_MODE=local - the same code as a child of the API, sharing its uid,
# its network and its environment - is left for someone to ask for by name.
RUNNER_STARTED=0; RUNNER_PID=""
if [ -n "${RUNNER_MODE:-}" ]; then
  echo "runner: $RUNNER_MODE (set in the environment; start.sh started nothing)"
else
  # PYTHON_BIN, when set (scripts/demo.sh sets it to an absolute path), is the
  # interpreter the runner and its probe run under; otherwise Python 3.11,
  # which the pre-baked layer is built for, and any newer one after it.
  PYTHON_BIN="${PYTHON_BIN:-$(find_python exact || find_python atleast || echo python3)}"
  command -v "$PYTHON_BIN" >/dev/null || {
    echo "$PYTHON_BIN not found - the sandbox runner needs Python 3.11."; exit 1; }
  # One socket per API port, so a second start on other ports does not meet
  # the first one's runner (serve.py refuses to share a live socket).
  export RUNNER_SOCKET="${RUNNER_SOCKET:-${TMPDIR:-/tmp}/learnsdlc/runner-$API_PORT.sock}"
  RUNNER_LOG="$ROOT/data/runner.log"
  RUNNER_STARTED=1
  if ! start_socket_runner "$PYTHON_BIN" "$RUNNER_LOG"; then
    case "$RUNNER_STATUS" in
      "down the runner exited") echo "the sandbox runner exited - see $RUNNER_LOG" ;;
      *) echo "the sandbox runner never answered on $RUNNER_SOCKET (${RUNNER_STATUS#down }) - see $RUNNER_LOG" ;;
    esac
    kill "$RUNNER_PID" 2>/dev/null || true; exit 1
  fi
  # A runner that answers but cannot confine learner code (any Mac, Windows,
  # a Linux kernel without Landlock) refuses every Run, Submit and Preview by
  # itself, so the API and the web app still start and say why.
  case "$RUNNER_STATUS" in
    unsupported*)
      echo "runner: this machine cannot isolate learner code (${RUNNER_STATUS#unsupported }); Run, Submit and Preview are refused" ;;
  esac
  export RUNNER_MODE=socket
  echo "runner: socket on $RUNNER_SOCKET (pid $RUNNER_PID, log $RUNNER_LOG)"
fi

# The runner outlives nothing: stop it when this script stops, however it does.
cleanup() {
  [ "$RUNNER_STARTED" = 1 ] && kill "$RUNNER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "AI: configured from .env (OPENAI_API_KEY, and OPENAI_MODEL and OPENAI_BASE_URL when set)."
echo 'A missing key or provider failure leaves AI unavailable; it never produces a fallback Pass.'

for p in "$WEB_PORT" "$API_PORT"; do
  if port_listening "$p"; then
    echo "port $p is already in use - stop the other process first"; exit 1
  fi
done

echo "mail: not sent, captured in $MAIL_CAPTURE_FILE"
echo "bind: $API_BIND   web: http://localhost:$WEB_PORT   api: http://localhost:$API_PORT"
# Not exec: the trap above is what stops the runner, and exec would replace the
# shell that holds it.
node scripts/run-with-env.mjs npm run "$MODE"
