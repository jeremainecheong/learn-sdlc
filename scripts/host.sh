#!/usr/bin/env bash
# Host LearnSDLC for a room: one command, the address printed, a QR code to point a phone at.
#
#   npm run host                 # host this laptop on the room's network
#   HOST_DRY_RUN=1 npm run host  # print the lab card and stop, building and starting nothing
#
# This is start.sh's sibling. start.sh is the loopback demo, safe because
# nobody else can open a socket to it; this is the other side of that door, so
# it refuses everything assertBindSafety refuses, and it refuses it here rather
# than three minutes later inside the API.
#
# LAB_HOST overrides the address. WEB_PORT and API_PORT move the two servers.
# The AI key comes from .env, as it does for npm run demo. It asks for the
# first administrator's address and password (or takes ADMIN_EMAIL and
# ADMIN_PASSWORD), and refuses a password the API would refuse.
#
# Learner code runs only where the kernel can confine it: a Linux machine with
# Landlock (5.13 or newer). On a Mac, or a kernel without it, this refuses to
# host and says what to use instead.
#
# Plain HTTP on the room's network, for an afternoon. Run the compose stack
# behind TLS for anything longer.
#
# Run scripts/setup.sh once before this.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/ai-key.sh
. "$ROOT/scripts/ai-key.sh"

DRY_RUN="${HOST_DRY_RUN:-0}"
# Overridable so the spec can run the refusals without writing a credential
# file into the repository it is testing.
DATA_DIR="${HOST_DATA_DIR:-$ROOT/data}"
# The API's build, which the administrator password is checked against.
# Overridable for the same reason.
API_DIST="${HOST_API_DIST:-$ROOT/apps/api/dist}"

for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) print_usage "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# The three refusals, before anything is built, written or started.
# ---------------------------------------------------------------------------

if [ "${SEED_DEMO_ACCOUNTS:-}" = "true" ]; then
  echo "SEED_DEMO_ACCOUNTS=true cannot be used to host a class: $DEMO_ADMIN_EMAIL and its"
  echo "published password are printed in the README. Unset it, then sign in as ADMIN_EMAIL."
  exit 1
fi

if [ "${RUNNER_MODE:-}" = "local" ]; then
  echo "RUNNER_MODE=local cannot be used to host a class. The local runner executes learner code"
  echo "as a child of this process, with this uid, this network and /proc access to this"
  echo "environment (JWT_SECRET, DATABASE_URL), so every learner who can reach this address has"
  echo "a shell on this machine. Unset RUNNER_MODE and this script starts the socket runner for"
  echo "you, the way scripts/start.sh does."
  exit 1
fi

# The secret survives a restart or every learner is signed out by one Ctrl-C.
# An unset one is generated and kept; a bad one is refused in the API's own
# words, so the two messages cannot drift apart.
HOST_ENV="$DATA_DIR/host.env"
if [ -z "${JWT_SECRET:-}" ] && [ -f "$HOST_ENV" ]; then
  # shellcheck disable=SC1090
  . "$HOST_ENV"
fi

secret_problem() {
  if [ -f "$ROOT/apps/api/dist/config.js" ]; then
    JWT_SECRET="${1:-}" node -e '
      const { jwtSecretProblem } = require(process.argv[1]);
      const problem = jwtSecretProblem(process.env.JWT_SECRET);
      if (problem) process.stdout.write(problem);
    ' "$ROOT/apps/api/dist/config.js"
    return
  fi
  # No build yet: the same two rules, in the same words, over the same list
  # (published_jwt_secret in scripts/lib/common.sh, which mirrors
  # PLACEHOLDER_JWT_SECRETS in apps/api/src/config/auth.ts). The value is
  # trimmed and its length counted in bytes, as the API does.
  local value
  value="$(printf '%s' "${1:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if published_jwt_secret "$value"; then
    printf 'JWT_SECRET is one of the placeholders this repository ships'
  elif [ "$(printf '%s' "$value" | wc -c)" -lt 32 ]; then
    printf 'JWT_SECRET is shorter than 32 bytes'
  fi
}

if [ -z "${JWT_SECRET:-}" ]; then
  mkdir -p "$DATA_DIR"
  JWT_SECRET="$(new_secret || true)"
  [ -n "$JWT_SECRET" ] || {
    echo "JWT_SECRET is not set and node could not generate one."
    echo "Set JWT_SECRET yourself - see \"Hosting a class\" in the README."; exit 1; }
  ( umask 077; printf 'JWT_SECRET=%s\n' "$JWT_SECRET" > "$HOST_ENV" )
  chmod 600 "$HOST_ENV"
  echo "A signing secret was generated and kept in $HOST_ENV, so sessions survive a restart."
  echo "Treat that file as a password."
else
  PROBLEM="$(secret_problem "$JWT_SECRET")"
  if [ -n "$PROBLEM" ]; then
    echo "$PROBLEM, so this class cannot be hosted: anyone who can reach this address could then"
    echo "mint an admin token. Set JWT_SECRET=\$(openssl rand -base64 48), or unset it and this"
    echo "script generates one for you. See \"Hosting a class\" in the README."
    exit 1
  fi
fi
export JWT_SECRET

# ---------------------------------------------------------------------------
# The first administrator, asked for once.
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" != 1 ]; then
  if [ -z "${ADMIN_EMAIL:-}" ]; then
    printf 'Your email address (this becomes the first administrator): '
    read -r ADMIN_EMAIL
    [ -n "$ADMIN_EMAIL" ] || { echo "No address given, so there would be nobody who can reset a password."; exit 1; }
  fi
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    printf 'A password for it: '
    read -rs ADMIN_PASSWORD; echo
    [ -n "$ADMIN_PASSWORD" ] || { echo "No password given, so that account could not be signed in to."; exit 1; }
  fi
  export ADMIN_EMAIL ADMIN_PASSWORD
fi

# The API creates the first administrator only from a password registration
# would accept, and otherwise starts with no administrator at all. So the
# password is checked here, before anything is built or started, by the API's
# own rules and in its own words (apps/api/src/auth/password-rules.ts in the
# build). Without a build, the length rule alone, its numbers read from where
# the API reads them (packages/shared/src/limits.ts). The password reaches
# node on its standard input, never on a command line.
admin_password_problem() { # password: prints the API's refusal sentence, or nothing
  if [ -f "$API_DIST/auth/password-rules.js" ]; then
    printf '%s' "$1" | node -e '
      const { passwordRuleProblem, adminPasswordRefusal } = require(process.argv[1]);
      const problem = passwordRuleProblem(require("fs").readFileSync(0, "utf8"));
      if (problem) process.stdout.write(adminPasswordRefusal(problem));
    ' "$API_DIST/auth/password-rules.js"
    return
  fi
  printf '%s' "$1" | node -e '
    const fs = require("fs");
    const limits = fs.readFileSync(process.argv[1], "utf8");
    const limit = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(limits)[1]);
    const [min, max] = [limit("PASSWORD_MIN_LENGTH"), limit("PASSWORD_MAX_LENGTH")];
    const length = fs.readFileSync(0, "utf8").length;
    if (length < min || length > max) {
      process.stdout.write(`ADMIN_PASSWORD was refused, so no admin was created: it must be ${min} to ${max} characters. Set one the registration form accepts`);
    }
  ' "$ROOT/packages/shared/src/limits.ts"
}

if [ -n "${ADMIN_PASSWORD:-}" ]; then
  PROBLEM="$(admin_password_problem "$ADMIN_PASSWORD")"
  if [ -n "$PROBLEM" ]; then
    echo "$PROBLEM."
    echo "Nothing was built or started. Run this again with another password."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# The address the room opens.
# ---------------------------------------------------------------------------

lan_address() {
  if [ -n "${LAB_HOST:-}" ]; then printf '%s' "$LAB_HOST"; return; fi
  case "$(uname -s)" in
    Darwin)
      local iface
      iface="$(route -n get default 2>/dev/null | awk '/interface/{print $2}' | head -1)"
      [ -n "$iface" ] && ipconfig getifaddr "$iface" 2>/dev/null || true ;;
    *)
      hostname -I 2>/dev/null | awk '{print $1}' ;;
  esac
}

# Under WSL, hostname -I names the WSL virtual machine's own address, which the
# room cannot reach unless Windows forwards the ports to it.
on_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

LAB_HOST_GIVEN="${LAB_HOST:-}"
LAB_HOST="$(lan_address || true)"
if [ -z "$LAB_HOST" ]; then
  echo "This machine has no network address, so a class has nothing to connect to."
  echo "Join the room's wifi and run this again."
  exit 1
fi

WEB_PORT="${WEB_PORT:-3000}"
export API_PORT="${API_PORT:-4000}"
export PORT="${PORT:-$WEB_PORT}"
LEARNER_URL="http://$LAB_HOST:$WEB_PORT"
API_URL="http://$LAB_HOST:$API_PORT"
if [ -z "$LAB_HOST_GIVEN" ] && on_wsl; then
  echo "WSL: $LAB_HOST is this Linux VM's own address, which the room may not reach. Set LAB_HOST"
  echo "to the Windows machine's address and forward ports $WEB_PORT and $API_PORT to this VM"
  echo "(netsh interface portproxy), or turn on WSL's mirrored networking."
fi

export API_BIND=0.0.0.0
export WEB_ORIGIN="$LEARNER_URL"
export NEXT_PUBLIC_API_URL="$API_URL"
export SEED_DEMO_ACCOUNTS=false
export NODE_ENV=production
export RUN_MIGRATIONS=true
export MAIL_CAPTURE_FILE="${MAIL_CAPTURE_FILE:-$DATA_DIR/mail.log}"

print_card() {
  echo
  echo "Lab is up."
  echo
  echo "  Learners open    $LEARNER_URL"
  echo "  You open         $LEARNER_URL/instructor"
  echo "  Mail             not sent, captured in $MAIL_CAPTURE_FILE"
  echo
  if [ -d "$ROOT/node_modules/qrcode" ]; then
    node -e '
      require("qrcode").toString(process.argv[1], { type: "terminal", small: true })
        .then((art) => process.stdout.write(art))
        .catch(() => {});
    ' "$LEARNER_URL" | sed 's/^/  /'
  else
    echo "  (run scripts/setup.sh to draw the QR code here)"
  fi
  echo
  echo "  Your class code is on the console under Your classes. The console shows the"
  echo "  join link and a QR code for each class."
  echo
  echo "Plain HTTP on the room's network. Stop with Ctrl-C."
}

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: nothing was built and nothing was started."
  print_card
  exit 0
fi

# ---------------------------------------------------------------------------
# This machine: the toolchain npm run demo checks, the AI key, and whether the
# kernel can confine learner code. All of it before anything is built.
# ---------------------------------------------------------------------------

[ -d node_modules ] || { echo "node_modules missing - run: bash scripts/setup.sh"; exit 1; }
node_supported || {
  echo "node $(node -v 2>/dev/null || echo missing) is unsupported. Use Node 24.9+ LTS: nvm install (it reads .nvmrc)."; exit 1; }

# The servers read .env through scripts/run-with-env.mjs below, so the key can
# live there, as it does for npm run demo.
require_ai_key "$ROOT"

PYTHON="$(find_python exact || true)"
[ -n "$PYTHON" ] || {
  echo "Python 3.11 was not found (python3 is $(python3 -V 2>&1 || echo missing)). The sandbox runner and"
  echo "its pre-baked layer need 3.11 exactly: install it, or set PYTHON_BIN to one."; exit 1; }
export PYTHON_BIN="$PYTHON"

NODE_BIN="$(find_node22 || true)"
[ -n "$NODE_BIN" ] || {
  echo "Learner code runs on Node 22, and none was found. Install it beside Node 24 (nvm install 22),"
  echo "or set NODE_BIN to a Node 22 binary."; exit 1; }
export NODE_BIN

# A class whose every Run, Submit and Preview is refused is not a class, and
# no weaker runner stands in for the isolation, so this stops here.
ISOLATION="$("$PYTHON_BIN" -B scripts/runner-status.py --local || true)"
case "$ISOLATION" in
  ok*) ;;
  *)
    echo "This machine cannot isolate learner code (the runner says: ${ISOLATION#unsupported }), so it"
    echo "cannot host a class: every learner's Run, Submit and Preview would be refused."
    echo "Host from a Linux machine whose kernel has Landlock (5.13 or newer), or run the production"
    echo "stack on a Linux server (\"Running in production\" in the README). npm run demo still shows"
    echo "the product on this machine, to you alone."
    exit 1 ;;
esac

for p in "$WEB_PORT" "$API_PORT"; do
  if port_listening "$p"; then
    echo "port $p is already in use - stop the other process first"; exit 1
  fi
done

# ---------------------------------------------------------------------------
# The web bundle. NEXT_PUBLIC_API_URL is inlined at build time (apps/web/lib/
# api.ts), so a bundle built for localhost sends every learner's browser to
# their own laptop and looks like "the app is broken". The stamp is what makes
# the rebuild happen exactly when the address has moved.
# ---------------------------------------------------------------------------

mkdir -p "$DATA_DIR"
STAMP="$DATA_DIR/host-built-api-url"
BUILT="$( [ -f "$STAMP" ] && cat "$STAMP" || true )"
if [ ! -d apps/web/.next ] || [ "$BUILT" != "$NEXT_PUBLIC_API_URL" ]; then
  echo "Rebuilding the web app for $NEXT_PUBLIC_API_URL - about a minute."
  npm run build -w @learnsdlc/shared
  npm run build -w @learnsdlc/api
  npm run build -w @learnsdlc/web
  printf '%s\n' "$NEXT_PUBLIC_API_URL" > "$STAMP"
fi

# The sandbox's pre-baked layer (Flask, pytest, React, jsdom, esbuild): checked,
# and rebuilt only when it does not match what the packs pin.
if ! node scripts/prebake.mjs verify >/dev/null 2>&1; then
  echo "The sandbox's dependencies are out of date; rebuilding them now."
  node scripts/prebake.mjs build || {
    echo "the sandbox's dependencies could not be built; the message above says which one."; exit 1; }
fi

# ---------------------------------------------------------------------------
# The runner, started the way start.sh starts it (scripts/lib/common.sh).
# ---------------------------------------------------------------------------

RUNNER_STARTED=0; RUNNER_PID=""; SERVER_PID=""
export RUNNER_SOCKET="${RUNNER_SOCKET:-${TMPDIR:-/tmp}/learnsdlc/runner.sock}"
RUNNER_LOG="$DATA_DIR/runner.log"
RUNNER_STARTED=1
if ! start_socket_runner "$PYTHON_BIN" "$RUNNER_LOG"; then
  case "$RUNNER_STATUS" in
    "down the runner exited") echo "the sandbox runner exited - see $RUNNER_LOG" ;;
    *) echo "the sandbox runner never answered on $RUNNER_SOCKET (${RUNNER_STATUS#down }) - see $RUNNER_LOG" ;;
  esac
  kill "$RUNNER_PID" 2>/dev/null || true; exit 1
fi
case "$RUNNER_STATUS" in
  ok*) ;;
  *)
    echo "the sandbox runner cannot confine learner code here (${RUNNER_STATUS#unsupported }), so this"
    echo "class is not hosted. See $RUNNER_LOG."
    kill "$RUNNER_PID" 2>/dev/null || true; exit 1 ;;
esac
export RUNNER_MODE=socket
echo "runner: socket on $RUNNER_SOCKET, confining learner code (pid $RUNNER_PID, log $RUNNER_LOG)"

# Nothing outlives this script: stop the runner and the servers, however it ends.
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ "$RUNNER_STARTED" = 1 ] && kill "$RUNNER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "bind: $API_BIND   web: $LEARNER_URL   api: $API_URL"
# Through run-with-env.mjs, which loads .env (the AI key, SMTP) and never
# overrides a variable exported above, so the bind, the secret and the
# addresses stay this script's.
node scripts/run-with-env.mjs npm start &
SERVER_PID=$!

for _ in $(seq 1 180); do
  curl -sf "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "the api exited before it answered."; exit 1; }
  sleep 1
done
curl -sf "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 || {
  echo "the api never answered on $API_PORT."; exit 1; }

print_card
wait "$SERVER_PID"
